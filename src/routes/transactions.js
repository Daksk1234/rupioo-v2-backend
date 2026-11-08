import express from "express";
import mongoose from "mongoose";
import PDFDocument from "pdfkit";
import XLSX from "xlsx";
import { createHash } from "node:crypto";
import { parseStrictVoucherDate } from "../utils/strictVoucherDate.js";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import {
  Product,
  CustomerLink,
  User,
  CompanyLedger,
  CustomerGrade,
  GlobalCustomer,
  CompanyProfile,
  CompanyUnit,
  Unit,
  GenericRecord,
  Transporter,
  GlobalTransporterStation,
  BankAccount,
  Branding,
  OtpChallenge,
} from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import {
  costBaseOf,
  gradeBasicFromMrp,
  historicalAverageRates,
  purchaseRateOf,
} from "../services/oldDmsPricingService.js";
import {
  financialModels,
  financialCollectionExists,
  postBalancedEntries,
  customerReceivableBalance,
  reversePostedTransaction,
} from "../services/accountingService.js";
import {
  readRows,
  resolveColumns,
  valueFor,
  cleanText,
} from "../utils/bulkSpreadsheet.js";
import { requireAnyPermission } from "../middleware/permission.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { canPageAction } from "../config/permissionPageMap.js";
import { env } from "../config/env.js";
import { sendBusinessEmail } from "../services/mailService.js";
import { sendCompanyMail } from "../services/mail/mail.service.js";
import { buildMasterSalesInvoicePdf } from "../services/masterInvoicePdfService.js";
import { readFile, saveUploadedFile } from "../services/storageService.js";
import {
  resolveCustomerDeliveryMode,
  resolveFirmDeliveryLocation,
  gstTypeFromLocations,
} from "../services/deliveryLocalityService.js";
import {
  enrichTransactionRows,
  resolvePartyDisplayMap,
} from "../services/transactionDisplayService.js";
import {
  financialYearFromDate,
  resolveFinancialYear,
  transactionDate,
} from "../utils/financialYear.js";
import personalFinanceRoutes from "./personalFinance.js";
import { recalculateBankRunningBalancesForVoucher } from "./banks.js";
import { companyCashOpening } from "../services/companyCashOpeningService.js";
import { buildCompanyCashbook } from "../services/companyCashbookEngine.js";
import { loadCompanyCashbookSources } from "../services/companyCashbookSources.js";
import { indexCashierReceipts, projectCashierHandover } from "../services/cashierReceiptProjection.js";
import { companyCashbookYearOpening } from "../services/companyCashbookRolloverService.js";
import { discoverFinancialYears, fiscalYearCandidates } from "../services/financialYearDiscoveryService.js";
import { cashbookPeriodSnapshot } from "../services/cashbookPeriodService.js";
import { buildBookMonthSummary } from "../services/bookMonthSummary.js";
import { readCashbookRows, balancePreview } from "../services/cashbookImport.js";
import {detectCashBulkParty,cashBulkMode,cashBulkAmount} from "../services/cashBulkPartyMatcher.js";
import {isSuperadmin, cashKey, validateBookCorrection, applyCashCorrections, reclassifiedJournal} from "../services/superadminBookCorrectionRules.js";
import {resolveSuperadminBookSource, originalBookJournal} from "../services/superadminBookSource.js";
import { normalizeCashbookBulkVoidSelection } from "../services/cashbookBulkVoidSelection.js";
import {
  allocateCashInvoiceNumber,
  cashInvoiceNumberFromSerial,
  isSystemCashParty,
  isRegisteredParty,
  suffixForFinancialYear,
  nextCashInvoiceNumber,
  nextDocumentNoteNumber,
} from "../services/documentNumberService.js";
import { enrichSalesInvoicesWithCreditState } from "../services/creditNoteRulesService.js";
import { createOtp, verifyOtp } from "../services/otpService.js";
import { matchCustomerTransporters } from "../services/customerTransporterMatchingService.js";
import {validateCashierLedgerConfirmation} from "../services/cashierLedgerConfirmRules.js";
import {postCustodyApprovedReceipt} from "../services/salespersonReceiptWorkflowService.js";

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.auth?.role === "MASTER" || (req.auth?.apps || []).includes("dms"))
    return next();
  return fail(res, "DMS access required", 403);
});
router.use("/personal-finance", personalFinanceRoutes);

// Compatibility aliases for statutory document-number previews.
// These routes intentionally live in the always-mounted transactions router as
// well as documentNotes.js, so older deployments that have not yet mounted the
// document-note router still get CN/DN/DLN auto numbering instead of an HTML 404.
const DOCUMENT_NOTE_NUMBER_TYPES = {
  "credit-notes": "CREDIT_NOTE",
  "debit-notes": "DEBIT_NOTE",
  "delivery-notes": "DELIVERY_NOTE",
};

for (const [pathKey, documentType] of Object.entries(
  DOCUMENT_NOTE_NUMBER_TYPES,
)) {
  router.get(`/${pathKey}/next-number`, async (req, res) => {
    try {
      const financialYear = await resolveFinancialYear({
        tenantKey: req.auth.tenantKey,
        requested: req.query.financialYear,
      });
      const partyGlobalId = cleanText(req.query.partyGlobalId || "");
      const party = partyGlobalId ? await CustomerLink.findOne({
        tenantKey: req.auth.tenantKey, globalCustomerId: partyGlobalId, status: "ACTIVE",
      }).lean() : null;
      if (partyGlobalId && !party) return fail(res, "Selected party not found", 404);
      const documentNo = await nextDocumentNoteNumber({
        tenantKey: req.auth.tenantKey,
        financialYear,
        type: documentType,
        registered: party ? isRegisteredParty(party) : true,
      });
      return ok(res, { documentNo, financialYear });
    } catch (error) {
      return fail(
        res,
        error.message || "Could not generate document number",
        error.statusCode || error.status || 400,
      );
    }
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

const upper = (v) => cleanText(v).toUpperCase();
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const money2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const cashierDenominations = new Set([500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5]);
const parseCashDenominations = (value) => {
  let rows = value;
  if (!Array.isArray(rows)) { try { rows = JSON.parse(value || "[]"); } catch { rows = []; } }
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const denomination = num(row?.denomination); const count = Math.max(0, Math.floor(num(row?.count)));
    return { denomination, count, amount: money2(denomination * count) };
  }).filter((row) => row.count > 0 && cashierDenominations.has(row.denomination));
};
const denominationTotal2 = (rows = []) => money2((rows || []).reduce((sum, row) => sum + num(row.amount || num(row.denomination) * num(row.count)), 0));
const isObjectIdText = (value) => /^[0-9a-fA-F]{24}$/.test(cleanText(value));
const requireObjectIdParam = (req, res, next) =>
  isObjectIdText(req.params.id) ? next() : next("route");

const salesInvoiceForAuth = (invoice, auth) => {
  if (!invoice || isAdminAuth(auth)) return invoice;
  const row =
    typeof invoice?.toObject === "function"
      ? invoice.toObject()
      : { ...invoice };
  delete row.grossProfit;
  delete row.grossMarginPct;
  row.items = (row.items || []).map((item) => {
    const next = { ...item };
    delete next.profitPct;
    delete next.marginColor;
    return next;
  });
  return row;
};

async function customerAssignedTransporterOptions({ tenantKey, customer, billing = {} }) {
  const stored = Array.isArray(customer?.assignedTransporters)
    ? customer.assignedTransporters.filter(Boolean)
    : [];

  // Keep compatibility with older customers where only the single legacy
  // assignedTransport field was saved.
  const legacyId = cleanText(customer?.assignedTransport);
  if (legacyId && !stored.some((row) => cleanText(row?.transporterId) === legacyId)) {
    stored.unshift({
      transporterId: legacyId,
      globalTransporterId: cleanText(customer?.assignedTransportGlobalId),
      stationId: cleanText(customer?.assignedTransportBookingStationId),
      transporterName: "",
      matchType: "ASSIGNED",
    });
  }

  if (!stored.length) return [];

  const localIds = stored
    .map((row) => cleanText(row?.transporterId))
    .filter((value) => /^[0-9a-fA-F]{24}$/.test(value));
  const globalIds = stored.map((row) => cleanText(row?.globalTransporterId)).filter(Boolean);
  const names = stored.map((row) => cleanText(row?.transporterName)).filter(Boolean);
  const clauses = [];
  if (localIds.length) clauses.push({ _id: { $in: localIds } });
  if (globalIds.length) clauses.push({ globalTransporterId: { $in: globalIds } });
  if (names.length) clauses.push({ name: { $in: names } });
  if (!clauses.length) return [];

  const active = await Transporter.find({
    tenantKey,
    status: { $ne: "INACTIVE" },
    $or: clauses,
  })
    .select("_id globalTransporterId name gstin status stations")
    .lean();

  const byId = new Map(active.map((row) => [String(row._id), row]));
  const byGlobalId = new Map(
    active.filter((row) => cleanText(row.globalTransporterId)).map((row) => [cleanText(row.globalTransporterId), row]),
  );
  const byName = new Map(active.map((row) => [cleanText(row.name).toLowerCase(), row]));
  const seen = new Set();
  const items = [];

  for (const assigned of stored) {
    const local =
      byId.get(cleanText(assigned?.transporterId)) ||
      byGlobalId.get(cleanText(assigned?.globalTransporterId)) ||
      byName.get(cleanText(assigned?.transporterName).toLowerCase());
    if (!local) continue;
    const transporterId = String(local._id);
    if (seen.has(transporterId)) continue;
    seen.add(transporterId);
    const base = (local.stations || [])[0] || {};
    items.push({
      transporterId,
      localTransporterId: transporterId,
      globalTransporterId: cleanText(local.globalTransporterId),
      name: cleanText(local.name || assigned?.transporterName),
      gstin: cleanText(local.gstin),
      matchType: cleanText(assigned?.matchType || customer?.transporterMatchType || "ASSIGNED"),
      stationId: cleanText(assigned?.stationId || customer?.assignedTransportBookingStationId),
      baseStationName: cleanText(assigned?.baseStationName || base.name || base.city),
      baseStationPincode: cleanText(assigned?.baseStationPincode || base.pincode),
      baseStationCity: cleanText(assigned?.baseStationCity || base.city),
      servicePincode: cleanText(assigned?.matchedPincode || billing?.pincode),
      serviceCity: cleanText(assigned?.matchedCity || billing?.city),
      assignedToCustomer: true,
    });
  }
  return items;
}

function mergeTransporterOptions(primary = [], secondary = []) {
  const seen = new Set();
  return [...primary, ...secondary].filter((row) => {
    const id = cleanText(row?.transporterId || row?.localTransporterId);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function customerTransportSnapshot({
  tenantKey,
  customer,
  selectedTransporterId = "",
}) {
  const locality = await resolveCustomerDeliveryMode({ tenantKey, customer });
  const billing =
    (customer?.addresses || []).find(
      (x) => upper(x?.type || "BILLING") === "BILLING",
    ) ||
    (customer?.addresses || [])[0] ||
    {};

  // The Customer Master assignment is authoritative for Sales Invoice. Live
  // pincode/city matching is used as a fallback and to add newly eligible
  // transporters, but it must never hide a transporter already assigned to the
  // selected customer.
  const assignedOptions = await customerAssignedTransporterOptions({
    tenantKey,
    customer,
    billing,
  });
  const matched = await matchCustomerTransporters({
    tenantKey,
    pincode: billing.pincode,
    city: billing.city,
  });
  const options = mergeTransporterOptions(assignedOptions, matched.items || []);

  if (!options.length) {
    if (!locality.requiresTransport) {
      return {
        mode: "LOCAL",
        firmCitySnapshot: locality.firmCity,
        customerCitySnapshot: locality.customerCity,
        serviceAreaSnapshot: cleanText(
          customer?.serviceArea || locality.customerCity || "",
        ),
      };
    }
    throw Object.assign(
      new Error(
        `${customer?.localName || "Customer"} has no transporter serving ${billing.pincode || locality.customerCity || "the delivery location"}. Add the pincode/city in Transporter List first.`,
      ),
      { statusCode: 409 },
    );
  }

  const wanted = cleanText(selectedTransporterId);
  let selected = null;
  if (wanted) {
    selected = options.find(
      (row) =>
        cleanText(row.transporterId) === wanted ||
        cleanText(row.localTransporterId) === wanted,
    );
    if (!selected) {
      throw Object.assign(
        new Error(
          "Selected transporter is not mapped to this customer pincode/city. Refresh the invoice and select an available transporter.",
        ),
        { statusCode: 400 },
      );
    }
  } else if (options.length === 1) {
    selected = options[0];
  } else {
    throw Object.assign(
      new Error(
        `${customer?.localName || "Customer"} has ${options.length} mapped transporters. Select one transporter in the Sales Invoice.`,
      ),
      { statusCode: 400 },
    );
  }

  const transporter = await Transporter.findOne({
    _id: selected.transporterId,
    tenantKey,
    status: { $ne: "INACTIVE" },
  }).lean();
  if (!transporter) {
    throw Object.assign(
      new Error("Selected transporter is no longer active in Transporter List"),
      { statusCode: 409 },
    );
  }

  const baseStation = selected.stationId
    ? await GlobalTransporterStation.findOne({
        stationId: selected.stationId,
        globalTransporterId: selected.globalTransporterId,
        status: "ACTIVE",
      }).lean()
    : null;

  return {
    mode: locality.requiresTransport ? "OUTSIDE" : "LOCAL",
    firmCitySnapshot: locality.firmCity,
    customerCitySnapshot: locality.customerCity,
    transporterId: String(transporter._id),
    matchType: cleanText(selected.matchType || matched.matchType || "CITY"),
    globalTransporterId: cleanText(transporter.globalTransporterId),
    transporterNameSnapshot: cleanText(transporter.name),
    bookingStationId: baseStation?.stationId || selected.stationId || "",
    bookingStationNameSnapshot:
      baseStation?.name || selected.baseStationName || "",
    bookingStationAddressSnapshot: baseStation?.address || "",
    bookingStationCitySnapshot:
      baseStation?.city || selected.baseStationCity || "",
    bookingStationPincodeSnapshot:
      baseStation?.pincode || selected.baseStationPincode || "",
    deliveryStationId: "",
    deliveryStationNameSnapshot: cleanText(
      billing.area || billing.city || "Customer Delivery",
    ),
    deliveryStationAddressSnapshot: cleanText(billing.address),
    deliveryStationCitySnapshot: cleanText(
      billing.city || selected.serviceCity,
    ),
    deliveryStationPincodeSnapshot: cleanText(
      billing.pincode || selected.servicePincode,
    ),
    serviceAreaSnapshot: cleanText(
      billing.city || selected.serviceCity || billing.pincode,
    ),
    matchType: matched.matchType || selected.matchType || "NONE",
  };
}

function billLevelTaxSummary(items = [], billDiscount = 0, otherCharges = 0) {
  const groups = new Map();
  let subtotal = 0,
    maxGst = 0;
  for (const item of items || []) {
    const taxable = Math.max(0, Number(item?.taxable || 0)),
      rate = Math.max(0, Number(item?.gstRateSnapshot || 0)),
      hsn = String(item?.hsnSnapshot || "NA"),
      key = `${hsn}|${rate}`;
    const group = groups.get(key) || { taxable: 0, rate };
    group.taxable += taxable;
    groups.set(key, group);
    subtotal += taxable;
    maxGst = Math.max(maxGst, rate);
  }
  subtotal = round2(subtotal);
  const discount = Math.min(subtotal, Math.max(0, Number(billDiscount || 0))),
    discountedBase = round2(Math.max(0, subtotal - discount)),
    charges = Math.max(0, Number(otherCharges || 0));
  let itemTaxTotal = 0;
  for (const group of groups.values()) {
    const share = subtotal > 0 ? group.taxable / subtotal : 0;
    const adjustedTaxable = round2(
      Math.max(0, group.taxable - discount * share),
    );
    itemTaxTotal += round2((adjustedTaxable * group.rate) / 100);
  }
  itemTaxTotal = round2(itemTaxTotal);
  const chargesTax = round2((charges * maxGst) / 100),
    taxableTotal = round2(discountedBase + charges),
    taxTotal = round2(itemTaxTotal + chargesTax);
  return {
    subtotal,
    discount,
    charges,
    discountedBase,
    maxGst,
    itemTaxTotal,
    chargesTax,
    taxableTotal,
    taxTotal,
  };
}

async function resolveReceiptCustomer(tenantKey, value) {
  const key = cleanText(value);
  if (!key) return null;
  return CustomerLink.findOne({
    tenantKey,
    $or: [{ globalCustomerId: key }, { displayIdentifier: upper(key) }],
    status: "ACTIVE",
  }).lean();
}

async function resolvePostingParty(tenantKey, globalCustomerId) {
  const id = cleanText(globalCustomerId);
  if (!id) return null;
  return CustomerLink.findOne({
    tenantKey,
    globalCustomerId: id,
    status: "ACTIVE",
  }).lean();
}

function partyAccountCodeOf(party) {
  const configured = cleanText(party?.accountingProfile?.systemAccountCode);
  if (configured) return configured;
  return ["CREDITOR", "SUPPLIER"].includes(upper(party?.partyType))
    ? "SYS_SUNDRY_CREDITORS"
    : "SYS_SUNDRY_DEBTORS";
}

async function resolveTransactionBank(tenantKey, mode, bankAccountId) {
  if (upper(mode) === "CASH")
    return {
      accountCode: "SYS_CASH",
      ledgerId: "",
      bankAccountId: "",
      bankName: "Cash",
    };
  let bank = null;
  if (cleanText(bankAccountId)) {
    const key = cleanText(bankAccountId);
    bank = await BankAccount.findOne({
      tenantKey,
      $or: [
        ...(/^[a-f0-9]{24}$/i.test(key) ? [{ _id: key }] : []),
        { bankAccountId: key },
      ],
      status: "ACTIVE",
    }).lean();
    if (!bank) throw Object.assign(new Error("Selected Bank Account not found or inactive"), {statusCode:400});
  }
  if (!bank)
    bank = await BankAccount.findOne({
      tenantKey,
      status: "ACTIVE",
      isPrimary: true,
    }).lean();
  if (!bank) {
    const count = await BankAccount.countDocuments({
      tenantKey,
      status: "ACTIVE",
    });
    if (count === 1)
      bank = await BankAccount.findOne({ tenantKey, status: "ACTIVE" }).lean();
  }
  if (!bank)
    throw Object.assign(
      new Error("Select an active Bank Account for non-cash transaction"),
      { statusCode: 400 },
    );
  return {
    accountCode: ["OD", "CC"].includes(upper(bank.accountType))
      ? "SYS_BANK_OD"
      : "SYS_BANK_ACCOUNT",
    ledgerId: bank.ledgerId || "",
    bankAccountId: bank.bankAccountId,
    bankName: bank.bankName,
  };
}

// Direct DMS vouchers can be linked to a customer/supplier, an office user,
// a transporter or an explicitly chosen miscellaneous name. Names are matched
// exactly (case-insensitive); ambiguous names MUST be disambiguated by type/ID.
const voucherNameRx = (text) => new RegExp(`^${String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
const VOUCHER_TYPES = new Set(["CUSTOMER", "USER", "TRANSPORTER", "OTHER"]);
const voucherType = (raw) => {
  const val = upper(raw);
  if (["PARTY", "SUPPLIER", "BUYER", "CREDITOR", "DEBITOR"].includes(val)) return "CUSTOMER";
  return val;
};
const voucherPartyId = (type, rawId) => type === "CUSTOMER" ? String(rawId) : `${type}:${String(rawId)}`;

// Directory is tenant-scoped and returns only fields needed by receipt/payment entry.
router.get("/voucher-party-options", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey;
    const [customers, users, transporters] = await Promise.all([
      CustomerLink.find({tenantKey,status:"ACTIVE",systemKey:{$ne:"CASH"},"accountingProfile.systemAccountCode":{$ne:"SYS_CASH"}}).select("globalCustomerId localName displayIdentifier partyType").lean(),
      User.find({tenantKey,status:"ACTIVE",systemManaged:{$ne:true}}).select("_id name employeeId role ledgerNodeKind parentLedgerAccountId tallyAccountTypeName tallyAccountTypeCode").lean(),
      Transporter.find({tenantKey,status:"ACTIVE"}).select("_id name gstin pan").lean(),
    ]);
    const userById = new Map(users.map(x=>[String(x._id),x]));
    const items = [
      ...customers.map(x=>({type:"CUSTOMER",id:x.globalCustomerId,name:x.localName||x.displayIdentifier||"",identifier:x.displayIdentifier||"",subtype:x.partyType||""})),
      ...users.filter(x=>x.ledgerNodeKind!=="GROUP").map(x=>{
        const labels=[],seen=new Set();let parent=userById.get(String(x.parentLedgerAccountId||""));
        while(parent&&!seen.has(String(parent._id))){seen.add(String(parent._id));labels.unshift(parent.name);parent=userById.get(String(parent.parentLedgerAccountId||""));}
        const accountPath=[x.tallyAccountTypeName||x.tallyAccountTypeCode,...labels].filter(Boolean).join(" > ");
        return {type:"USER",id:voucherPartyId("USER",x._id),name:x.name||"",identifier:x.employeeId||String(x._id),subtype:accountPath||x.role||"",accountPath};
      }),
      ...transporters.map(x=>({type:"TRANSPORTER",id:voucherPartyId("TRANSPORTER",x._id),name:x.name||"",identifier:x.gstin||x.pan||String(x._id),subtype:""})),
    ].filter(x=>x.id&&x.name).sort((a,b)=>a.name.localeCompare(b.name,"en",{sensitivity:"base"}));
    return ok(res,items);
  } catch (e) { return fail(res,e.message||"Unable to load voucher party directory",500); }
});

async function resolveVoucherPostingParty(tenantKey, rawReference, rawType = "") {
  const reference = cleanText(rawReference);
  const type = voucherType(rawType);
  if (!reference) throw Object.assign(new Error("Party name or ID is required"),{statusCode:400});
  if (type && !VOUCHER_TYPES.has(type)) throw Object.assign(new Error("Party Type must be CUSTOMER, USER, TRANSPORTER or OTHER"),{statusCode:400});
  if (type === "OTHER") {
    if (reference.length > 150) throw new Error("Other party name cannot exceed 150 characters");
    const stable = createHash("sha256").update(reference.toLocaleUpperCase("en-IN")).digest("hex").slice(0,24);
    return {type:"OTHER",id:`OTHER:${stable}`,name:reference,accountCode:"SYS_SUSPENSE",ledgerId:""};
  }
  const strippedUser = reference.replace(/^USER:/i,"");
  const strippedTransporter = reference.replace(/^TRANSPORTER:/i,"");
  const allowed = (which) => !type || type===which;
  const candidates=[];
  if (allowed("CUSTOMER")) {
    const rows=await CustomerLink.find({tenantKey,status:"ACTIVE",$or:[
      {globalCustomerId:reference},{displayIdentifier:voucherNameRx(reference)},
      {localName:voucherNameRx(reference)},
    ]}).limit(3).lean();
    candidates.push(...rows.map(x=>({type:"CUSTOMER",id:x.globalCustomerId,name:x.localName||x.displayIdentifier||"",accountCode:partyAccountCodeOf(x),ledgerId:""})));
  }
  if (allowed("USER")) {
    const filter={tenantKey,status:"ACTIVE",systemManaged:{$ne:true},ledgerNodeKind:{$ne:"GROUP"},$or:[{name:voucherNameRx(reference)}]};
    if (isObjectIdText(strippedUser))filter.$or.push({_id:strippedUser});
    const rows=await User.find(filter).limit(3).lean();
    for (const x of rows) {
      const ledger=await CompanyLedger.findOne({tenantKey,ownerType:"USER",ownerId:String(x._id),status:"ACTIVE"}).sort({updatedAt:-1}).lean();
      const mapping=(x.accountingMappings||[]).find(m=>upper(m.status||"ACTIVE")==="ACTIVE"&&m.systemAccountCode);
      candidates.push({type:"USER",id:voucherPartyId("USER",x._id),name:x.name,accountCode:ledger?.systemAccountCode||mapping?.systemAccountCode||"SYS_SUSPENSE",ledgerId:ledger?.ledgerId||""});
    }
  }
  if (allowed("TRANSPORTER")) {
    const filter={tenantKey,status:"ACTIVE",$or:[{name:voucherNameRx(reference)},{gstin:voucherNameRx(reference)},{pan:voucherNameRx(reference)}]};
    if (isObjectIdText(strippedTransporter))filter.$or.push({_id:strippedTransporter});
    const rows=await Transporter.find(filter).limit(3).lean();
    candidates.push(...rows.map(x=>({type:"TRANSPORTER",id:voucherPartyId("TRANSPORTER",x._id),name:x.name,accountCode:"SYS_SUNDRY_CREDITORS",ledgerId:""})));
  }
  const unique=[...new Map(candidates.map(x=>[x.id,x])).values()];
  if (unique.length>1) throw Object.assign(new Error(`Party name "${reference}" matches multiple records. Select the specific party from the directory or provide Party Type and ID.`),{statusCode:400});
  if (!unique.length) throw Object.assign(new Error(`Party "${reference}" not found/active. Select a Customer, User or Transporter, or choose Party Type OTHER for an unmapped name.`),{statusCode:400});
  // System-managed CASH exists in User and Customer masters for reporting,
  // but can NEVER be the payee/payer on a normal receipt or payment.
  // A Cash->Bank movement must use the Contra workflow instead.
  if (unique[0].accountCode === "SYS_CASH") {
    throw Object.assign(new Error("CASH / Cash-in-Hand cannot be selected as a Receipt or Payment party. Choose the actual person/supplier, or use Cash / Bank Contra for an internal transfer."),{statusCode:422});
  }
  return unique[0];
}

router.post(
  "/:type/bulk-upload",
  upload.single("file"),
  async (req, res, next) => {
    try {
      const type = req.params.type;
      if (!["receipts", "payments", "expenses"].includes(type)) return next();
      if (!req.file?.buffer)
        return fail(res, "Excel/CSV file is required", 400);
      let rows;
      try {
        rows = ["receipts", "payments"].includes(type)
          ? readRows(req.file.buffer, { preserveText: true, formattedDates: true })
          : readRows(req.file.buffer);
      } catch {
        return fail(res, "Unable to read Excel/CSV file", 400);
      }
      if (!rows.length) return fail(res, "Uploaded file has no rows", 400);
      const requestedFy = req.body.financialYear || "";
      const common = [
        { key: "date", label: "Date", aliases: ["Date (DD-MM-YYYY or YYYY-MM-DD)", "Voucher Date"], required: ["receipts", "payments"].includes(type) },
        { key: "amount", label: "Amount", type: "number", required: true },
        { key: "reference", label: "Reference" },
      ];
      const fields =
        type === "receipts"
          ? [
              {
                key: "receiptNo",
                label: "Receipt No.",
                aliases: ["voucher no", "voucher"],
              },
              {
                key: "customer",
                label: "Party Name / ID",
                aliases: ["Customer ID / GSTIN / PAN", "customer", "party", "gstin", "pan", "Party / Supplier ID", "party name"],
                required: true,
              },
              { key: "partyType", label: "Party Type", aliases: ["category", "party category"] },
              ...common,
              { key: "mode", label: "Mode" },
              { key: "bankAccountId", label: "Bank Account ID", aliases: ["bank id", "bank account"] },
              { key: "remarks", label: "Remarks", aliases: ["narration", "description"] },
              { key: "bounceStatus", label: "Bounce Status" },
            ]
          : type === "payments"
            ? [
                {
                  key: "paymentNo",
                  label: "Payment No.",
                  aliases: ["voucher no", "voucher"],
                },
                {
                  key: "partyGlobalId",
                  label: "Party Name / ID",
                  aliases: ["Party / Supplier ID", "party", "supplier", "party name", "customer"],
                  required: true,
                },
                { key: "partyType", label: "Party Type", aliases: ["category", "party category"] },
                ...common,
                { key: "mode", label: "Mode" },
                { key: "bankAccountId", label: "Bank Account ID", aliases: ["bank id", "bank account"] },
                { key: "remarks", label: "Remarks", aliases: ["narration", "description"] },
              ]
            : [
                {
                  key: "expenseNo",
                  label: "Expense No.",
                  aliases: ["voucher no", "voucher"],
                },
                {
                  key: "accountCode",
                  label: "Expense Account",
                  aliases: ["account", "account code"],
                  required: true,
                },
                ...common,
                { key: "paymentMode", label: "Payment Mode" },
                { key: "nature", label: "Nature" },
                {
                  key: "allocationMethod",
                  label: "Allocation Method",
                  aliases: ["allocation"],
                },
                { key: "narration", label: "Narration" },
              ];
      const cols = resolveColumns(rows[0], fields);
      const missing = fields
        .filter((f) => f.required && !cols[f.key])
        .map((f) => f.label);
      if (missing.length)
        return fail(res, `Missing column(s): ${missing.join(", ")}`, 400);
      const errors = [];
      let inserted = 0,
        duplicates = 0;
      const affectedBankFys = new Map();
      for (let i = 0; i < rows.length; i++) {
        const body = { financialYear: requestedFy };
        for (const f of fields) {
          const v = valueFor(rows[i], cols[f.key], f.type);
          if (v !== undefined && v !== "") body[f.key] = v;
        }
        const amount = Number(body.amount || 0);
        if (amount <= 0) {
          if (errors.length < 100)
            errors.push({
              row: i + 2,
              error: "Amount must be greater than zero",
            });
          continue;
        }
        let createdVoucher = null;
        try {
          const date = ["receipts", "payments"].includes(type)
            ? parseStrictVoucherDate(body.date)
            : transactionDate(body.date);
          const fy =
            financialYearFromDate(date) ||
            financialYearFromDate(date) ||
            (await resolveFinancialYear({
              tenantKey: req.auth.tenantKey,
              requested: requestedFy,
            }));
          const models = financialModels(req.auth.tenantKey, fy);
          if (["receipts", "payments"].includes(type)) {
            const mode = upper(body.mode || "BANK");
            if (!["BANK", "NEFT", "RTGS", "UPI", "CHEQUE", "CASH"].includes(mode))
              throw new Error(`Invalid payment mode: ${mode}`);
            const party = await resolveVoucherPostingParty(
              req.auth.tenantKey,
              type === "receipts" ? body.customer : body.partyGlobalId,
              body.partyType,
            );
            const numberField = type === "receipts" ? "receiptNo" : "paymentNo";
            const voucherNo = cleanText(body[numberField]) || makeId(type === "receipts" ? "RCT" : "PAY");
            const Model = type === "receipts" ? models.Receipt : models.Payment;
            if (await Model.exists({tenantKey:req.auth.tenantKey,financialYear:fy,[numberField]:voucherNo})) {
              duplicates++;
              continue;
            }
            const chosenBankId = cleanText(body.bankAccountId || req.body.bankAccountId);
            if (mode !== "CASH" && !chosenBankId)
              throw new Error("Bank Account is required for a non-cash bulk voucher");
            const bank = await resolveTransactionBank(req.auth.tenantKey,mode,chosenBankId);
            const commonVoucher = {
              tenantKey:req.auth.tenantKey,financialYear:fy,[numberField]:voucherNo,
              sourceKey:voucherNo,date,partyType:party.type,partyNameSnapshot:party.name,
              amount,mode,reference:body.reference||"",remarks:body.remarks||"",
              bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,
              status:"POSTED",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||"",
            };
            createdVoucher = await Model.create(type === "receipts" ? {
              ...commonVoucher,customerGlobalId:party.id,
              bounceStatus:upper(body.bounceStatus||"CLEAR"),
              receiptWorkflowStatus:"DMS_DIRECT",customerOtpStatus:"NOT_REQUIRED",
              cashierOtpStatus:"NOT_REQUIRED",ledgerPostedAt:new Date(),
            } : {...commonVoucher,partyGlobalId:party.id});
            const bankEntry = {accountCode:bank.accountCode,ledgerId:bank.ledgerId,
              bankAccountId:bank.bankAccountId};
            await postBalancedEntries({
              tenantKey:req.auth.tenantKey,financialYear:fy,transactionId:voucherNo,
              transactionType:type === "receipts" ? "RECEIPT" : "PAYMENT",
              date,partyGlobalId:party.id,
              narration:body.remarks||`${type === "receipts" ? "Receipt" : "Payment"} ${voucherNo}`,
              entries:type === "receipts"
                ? [{...bankEntry,debit:amount},{accountCode:party.accountCode,ledgerId:party.ledgerId,credit:amount}]
                : [{accountCode:party.accountCode,ledgerId:party.ledgerId,debit:amount},{...bankEntry,credit:amount}],
            });
            if (bank.bankAccountId) affectedBankFys.set(`${fy}::${bank.bankAccountId}`,{financialYear:fy,bankAccountId:bank.bankAccountId});
          } else {
            const expenseNo = cleanText(body.expenseNo) || makeId("EXP");
            if (
              await models.Expense.exists({
                tenantKey: req.auth.tenantKey,
                financialYear: fy,
                expenseNo,
              })
            ) {
              duplicates++;
              continue;
            }
            const paymentMode = upper(body.paymentMode || "BANK");
            await models.Expense.create({
              tenantKey: req.auth.tenantKey,
              financialYear: fy,
              expenseNo,
              date,
              accountCode: body.accountCode,
              amount,
              nature: upper(body.nature || "FIXED"),
              allocationMethod: upper(body.allocationMethod || "TURNOVER"),
              status: "POSTED",
            });
            await postBalancedEntries({
              tenantKey: req.auth.tenantKey,
              financialYear: fy,
              transactionId: expenseNo,
              transactionType: "EXPENSE",
              date,
              narration: body.narration || `Expense ${expenseNo}`,
              entries: [
                { accountCode: body.accountCode, debit: amount },
                {
                  accountCode:
                    paymentMode === "BANK" ? "SYS_BANK_ACCOUNT" : "SYS_CASH",
                  credit: amount,
                },
              ],
            });
          }
          inserted++;
        } catch (e) {
          if (createdVoucher && ["receipts", "payments"].includes(type)) {
            await createdVoucher.deleteOne(); // never leave a voucher without its journal
          }
          if (errors.length < 100)
            errors.push({ row: i + 2, error: e.message });
        }
      }
      const balanceWarnings=[];
      for (const affected of affectedBankFys.values()) {
        try { await recalculateBankRunningBalancesForVoucher({tenantKey:req.auth.tenantKey,...affected}); }
        catch (error) { balanceWarnings.push(`FY ${affected.financialYear}, bank ${affected.bankAccountId}: ${error.message}`); }
      }
      return ok(
        res,
        {
          received: rows.length,
          inserted,
          duplicates,
          invalid: errors.length,
          errors,
          balanceWarnings,
        },
        `${inserted} ${type} imported${balanceWarnings.length ? "; bank balance refresh needs attention" : ""}`,
      );
    } catch (e) {
      next(e);
    }
  },
);

router.post("/:type/bulk-edit", async (req, res, next) => {
  const type = req.params.type;
  if (!["receipts", "payments", "expenses"].includes(type)) return next();
  const ids = (req.body.selection?.ids || []).filter(Boolean);
  if (!ids.length) return fail(res, "Select at least one record", 400);
  const fy = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.body.financialYear,
    }),
    models = financialModels(req.auth.tenantKey, fy),
    raw = req.body.changes || {};
  const Model =
    type === "receipts"
      ? models.Receipt
      : type === "payments"
        ? models.Payment
        : models.Expense;
  const allowed =
    type === "receipts"
      ? ["reference", "bounceStatus"]
      : type === "payments"
        ? ["reference"]
        : ["nature", "allocationMethod"];
  const changes = {};
  for (const k of allowed)
    if (raw[k] !== undefined && raw[k] !== "")
      changes[k] = k === "reference" ? cleanText(raw[k]) : upper(raw[k]);
  if (!Object.keys(changes).length)
    return fail(
      res,
      `For posted ${type}, bulk edit is limited to ${allowed.join(", ")}. Amount/account/mode changes must be cancelled and reposted.`,
      400,
    );
  const result = await Model.updateMany(
    {
      _id: { $in: ids },
      tenantKey: req.auth.tenantKey,
      financialYear: fy,
      status: "POSTED",
    },
    { $set: changes },
  );
  return ok(
    res,
    { matched: result.matchedCount, updated: result.modifiedCount },
    `${result.modifiedCount} ${type} updated`,
  );
});

router.post("/:type/bulk-delete", async (req, res, next) => {
  const type = req.params.type;
  if (!["receipts", "payments", "expenses"].includes(type)) return next();
  const ids = (req.body.selection?.ids || []).filter(Boolean);
  if (!ids.length) return fail(res, "Select at least one record", 400);
  const fy = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.body.financialYear,
    }),
    models = financialModels(req.auth.tenantKey, fy),
    Model =
      type === "receipts"
        ? models.Receipt
        : type === "payments"
          ? models.Payment
          : models.Expense;
  const docs = await Model.find({
    _id: { $in: ids },
    tenantKey: req.auth.tenantKey,
    financialYear: fy,
    status: "POSTED",
  });
  let cancelled = 0;
  for (const doc of docs) {
    const transactionId =
      type === "receipts"
        ? doc.receiptNo
        : type === "payments"
          ? doc.paymentNo
          : doc.expenseNo;
    if (!transactionId) continue;
    await reversePostedTransaction({
      tenantKey: req.auth.tenantKey,
      financialYear: fy,
      transactionId,
      reason: `Bulk cancelled ${type.slice(0, -1)}`,
    });
    doc.status = "CANCELLED";
    await doc.save();
    cancelled++;
  }
  return ok(
    res,
    { deleted: cancelled, reversed: true },
    `${cancelled} ${type} cancelled and reversed`,
  );
});

const floor2 = (n) => Math.floor((Number(n) || 0) * 100) / 100;
const ceil2 = (n) => Math.ceil((Number(n) || 0) * 100) / 100;
const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const basicFromSaleGst = (sale, gstPct) =>
  ceil2(Number(sale || 0) / (1 + Number(gstPct || 0) / 100));
const saleFromBasicGst = (basic, gstPct) =>
  round2(Number(basic || 0) * (1 + Number(gstPct || 0) / 100));
const basicAfterGradeDiscount = (basic, gradePct) => {
  const base = Math.max(0, Number(basic || 0));
  const pct = Math.min(100, Math.max(0, Number(gradePct || 0)));
  return floor2(base * (1 - pct / 100));
};

async function resolvedProductRate({ customer, product, row }) {
  // Never trust row.gradeDiscountPct from the browser. The selected customer's
  // current grade percentage is resolved from CUSTOMER GRADES before pricing.
  const gradePct = Number(customer.gradeDiscountPct || 0);
  let saleRate = Number(row.saleRate ?? 0);
  if (!saleRate) {
    const gstRate = Number(row.gstRate ?? product.gstRate ?? 0);
    // MRP is authoritative for default grade pricing. Remove GST from MRP,
    // then apply the selected customer's grade discount. This matches the
    // grade-wise Price List and prevents Product.salePrice drift from changing
    // invoice defaults. Older products without MRP keep the salePrice fallback.
    const customerBasic = Number(product.mrp || 0) > 0
      ? gradeBasicFromMrp(product.mrp, gstRate, gradePct)
      : basicAfterGradeDiscount(Number(product.salePrice || 0), gradePct);
    saleRate = saleFromBasicGst(customerBasic, gstRate);
  }
  return { saleRate, gradeDiscountPct: gradePct };
}

function formatSalesInvoiceNumber(prefix, serial, suffix) {
  return [cleanText(prefix), String(serial), cleanText(suffix)]
    .filter(Boolean)
    .join("-");
}

function salesInvoiceSerialText(serial, paddingWidth = 0) {
  const value = String(Math.max(1, Math.trunc(Number(serial) || 1)));
  return Number(paddingWidth || 0) > 0
    ? value.padStart(Number(paddingWidth), "0")
    : value;
}

async function latestSalesInvoicePadding(tenantKey, prefix, suffix) {
  const years = await salesInvoiceSeriesFinancialYears(tenantKey, "");
  let latest = null;
  const before = `${prefix}-`;
  const after = `-${suffix}`;
  for (const fy of years) {
    try {
      const { SalesInvoice } = financialModels(tenantKey, fy);
      // A small recent window is enough to recover the user's latest numbering style.
      const rows = await SalesInvoice.find({
        tenantKey,
        invoiceNo: { $nin: [null, ""] },
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .select("invoiceNo createdAt")
        .lean();
      for (const row of rows) {
        const text = cleanText(row.invoiceNo);
        if (!text.toLowerCase().startsWith(before.toLowerCase())) continue;
        if (!text.toLowerCase().endsWith(after.toLowerCase())) continue;
        const serialText = text.slice(before.length, text.length - after.length);
        if (!/^\d+$/.test(serialText)) continue;
        const createdAt = new Date(row.createdAt || 0).getTime();
        if (!latest || createdAt > latest.createdAt) {
          latest = { serialText, createdAt };
        }
        break;
      }
    } catch {
      // An older FY DB may not exist. It should not block invoice numbering.
    }
  }
  if (!latest?.serialText) return 0;
  return /^0\d+$/.test(latest.serialText) ? latest.serialText.length : 0;
}

async function configuredSalesInvoiceNumberFromSerial(tenantKey, serialText, financialYear) {
  const raw = cleanText(serialText);
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw Object.assign(
      new Error("Invoice Number must contain digits only and be 1 or more"),
      { statusCode: 400 },
    );
  }
  const company = await CompanyProfile.findOne({ tenantKey })
    .select("salesInvoicePrefix salesInvoiceSuffix")
    .lean();
  if (!company)
    throw Object.assign(new Error("Company profile not found"), {
      statusCode: 404,
    });
  const prefix = cleanText(company.salesInvoicePrefix);
  const suffix = suffixForFinancialYear(company.salesInvoiceSuffix, financialYear);
  if (!prefix || !suffix) {
    throw Object.assign(
      new Error(
        "Complete Sales Invoice Prefix, Starting Number and Suffix in Super Admin Profile before creating invoices",
      ),
      { statusCode: 409 },
    );
  }
  return {
    invoiceNo: formatSalesInvoiceNumber(prefix, raw, suffix),
    serial: Number(raw),
    serialText: raw,
    prefix,
    suffix,
  };
}

function invoiceSerialForInput(invoiceNo, prefix, suffix) {
  const text = cleanText(invoiceNo);
  if (!text) return "";
  const regularBefore = `${cleanText(prefix)}-`;
  const regularAfter = `-${cleanText(suffix)}`;
  if (
    text.toLowerCase().startsWith(regularBefore.toLowerCase()) &&
    text.toLowerCase().endsWith(regularAfter.toLowerCase())
  ) {
    const middle = text.slice(
      regularBefore.length,
      text.length - regularAfter.length,
    );
    if (/^\d+$/.test(middle)) return middle;
  }

  // Unregistered invoices use PREFIX + C + NUMBER + SUFFIX.
  const compactPrefix = cleanText(prefix).replace(/\s+/g, "");
  const compactSuffix = cleanText(suffix).replace(/[^0-9A-Za-z]/g, "");
  if (
    compactPrefix &&
    compactSuffix &&
    text.toLowerCase().startsWith(`${compactPrefix}C`.toLowerCase()) &&
    text.toLowerCase().endsWith(compactSuffix.toLowerCase())
  ) {
    const middle = text.slice(
      compactPrefix.length + 1,
      text.length - compactSuffix.length,
    );
    if (/^\d+$/.test(middle)) return middle;
  }
  return /^\d+$/.test(text) ? text : "";
}

async function registeredInvoiceRows(tenantKey, rows, prefix) {
  const partyIds = [...new Set(rows.map((row) => cleanText(row.customerGlobalId)).filter(Boolean))];
  const parties = partyIds.length ? await CustomerLink.find({
    tenantKey, globalCustomerId: { $in: partyIds },
  }).select("globalCustomerId gstin gstNumber displayIdentifier").lean() : [];
  const partyById = new Map(parties.map((party) => [String(party.globalCustomerId), party]));
  return rows.filter((row) => {
    const number = cleanText(row.invoiceNo);
    // The C marker always identifies the unregistered series, even if the
    // party's GSTIN was edited after the original invoice was posted.
    if (number.toLowerCase().startsWith(`${prefix}C`.toLowerCase()) &&
        /^\d/.test(number.slice(prefix.length + 1))) return false;
    if (isRegisteredParty({ gstin: row.gstinSnapshot })) return true;
    const party = partyById.get(String(row.customerGlobalId || ""));
    if (party) return isRegisteredParty(party);
    // Preserve historical registered invoices whose party master was archived.
    return number.toLowerCase().startsWith(`${prefix}-`.toLowerCase());
  });
}

async function salesInvoiceSeries(
  tenantKey,
  financialYear,
  { consume = false } = {},
) {
  const fy = cleanText(financialYear);
  if (!/^\d{4}-\d{2}$/.test(fy)) {
    throw Object.assign(new Error("A valid Financial Year is required for Sales Invoice numbering"), {
      statusCode: 400,
    });
  }

  const company = await CompanyProfile.findOne({ tenantKey })
    .select("salesInvoicePrefix salesInvoiceSuffix salesInvoiceStartingNumber")
    .lean();
  if (!company) {
    throw Object.assign(new Error("Company profile not found"), {
      statusCode: 404,
    });
  }

  const prefix = cleanText(company.salesInvoicePrefix);
  const suffix = suffixForFinancialYear(company.salesInvoiceSuffix, fy);
  const start = Math.max(
    1,
    Math.trunc(Number(company.salesInvoiceStartingNumber || 1)),
  );
  if (!prefix || !suffix) {
    throw Object.assign(
      new Error(
        "Complete Sales Invoice Prefix, Starting Number and Suffix in Super Admin Profile before creating invoices",
      ),
      { statusCode: 409 },
    );
  }

  // IMPORTANT: Sales Invoice numbering is FINANCIAL-YEAR WISE and the source
  // of truth is every EXISTING, NON-DELETED invoice number in the FY selected by
  // the invoice date. Workflow state must NEVER control numbering: invoice 040
  // may later become RELEASED_TO_WAREHOUSE / READY_FOR_DISPATCH / DELIVERED, but
  // it still permanently occupies serial 040. Otherwise a new invoice could be
  // offered 040 again. A soft-deleted test invoice is excluded so an eligible
  // deleted number can be released by releaseDeletedTestSalesNumber() on save.
  // Never use CompanyProfile.salesInvoiceNextNumber and never inspect another FY.
  const { SalesInvoice } = financialModels(tenantKey, fy);
  const rows = await SalesInvoice.find({
    tenantKey,
    status: { $ne: "DELETED" },
    invoiceNo: { $nin: [null, ""] },
  })
    .select("invoiceNo date createdAt status workflowStatus financialYear customerGlobalId gstinSnapshot")
    .lean();
  const registeredRows = await registeredInvoiceRows(tenantKey, rows, prefix);

  const parsed = registeredRows
    .map((row) => ({
      row,
      info: salesInvoiceSerialInfo(row.invoiceNo, prefix, suffix, fy),
    }))
    .filter(
      (entry) =>
        entry.info &&
        Number.isFinite(Number(entry.info.serial)) &&
        Number(entry.info.serial) >= start,
    );

  // Continue after the HIGHEST active serial in this FY/registered series.
  // This is deliberately not a row-count calculation: manually entered numbers,
  // imported history, and workflow transitions must not make an existing number
  // available again. Example: if PE-040-26-27 exists (even DELIVERED), next is 041.
  // If the only test invoice 001 was deleted, no active serial remains and the
  // series can correctly offer 001 again.
  const usedSerials = new Set(parsed.map((entry) => Number(entry.info.serial)));
  const highestSerial = parsed.reduce(
    (max, entry) => Math.max(max, Number(entry.info.serial) || 0),
    0,
  );
  let serial = highestSerial >= start ? highestSerial + 1 : start;
  while (usedSerials.has(serial)) serial += 1;

  // Preserve the numeric style most recently used INSIDE THIS FY only.
  // The parser understands both PREFIX-039-SUFFIX and compact legacy values
  // such as PREFIX0392627, so FY digits can no longer become part of the serial.
  const latest = [...parsed].sort((a, b) => {
    const aTime = new Date(a.row.createdAt || a.row.date || 0).getTime();
    const bTime = new Date(b.row.createdAt || b.row.date || 0).getTime();
    return bTime - aTime;
  })[0];
  const latestSerialText = cleanText(latest?.info?.serialText || "");
  const paddingWidth = /^0\d+$/.test(latestSerialText)
    ? latestSerialText.length
    : 0;
  const serialText = salesInvoiceSerialText(serial, paddingWidth);

  // `consume` is intentionally accepted for backward compatibility with the
  // create route. We do not increment a global counter: the saved invoice in
  // this FY advances the next value naturally.
  void consume;

  return {
    invoiceNo: formatSalesInvoiceNumber(prefix, serialText, suffix),
    serial,
    serialText,
    paddingWidth,
    prefix,
    suffix,
    startingNumber: start,
    financialYear: fy,
  };
}

function salesInvoiceSerialInfo(
  invoiceNo,
  prefix,
  suffix,
  financialYear = "",
) {
  const text = cleanText(invoiceNo);
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    return {
      invoiceNo: text,
      serial: Number(text),
      serialText: text,
      serialStart: 0,
      serialEnd: text.length,
    };
  }

  const configuredPrefix = cleanText(prefix);
  const configuredSuffix = cleanText(suffix);
  const fy = cleanText(financialYear);
  const startsWithPrefix =
    configuredPrefix &&
    text.toLowerCase().startsWith(configuredPrefix.toLowerCase());

  // Build all known suffix spellings for this FY. This is important for old
  // compact invoice numbers where the suffix is numeric and there are no
  // separators, e.g. EKO0392627. Without stripping 2627 first, the old parser
  // incorrectly read 0392627 as the serial and suggested 0392628.
  const suffixCandidates = [];
  const addSuffix = (value) => {
    const v = cleanText(value);
    if (v && !suffixCandidates.some((x) => x.toLowerCase() === v.toLowerCase()))
      suffixCandidates.push(v);
  };
  addSuffix(configuredSuffix);
  if (/^\d{4}-\d{2}$/.test(fy)) {
    const startYear = fy.slice(0, 4);
    const shortStart = startYear.slice(2);
    const shortEnd = fy.slice(-2);
    addSuffix(fy); // 2025-26
    addSuffix(fy.replace(/-/g, "")); // 202526
    addSuffix(`${shortStart}-${shortEnd}`); // 25-26
    addSuffix(`${shortStart}${shortEnd}`); // 2526
  }
  suffixCandidates.sort((a, b) => b.length - a.length);

  if (startsWithPrefix) {
    for (const candidateSuffix of suffixCandidates) {
      if (!text.toLowerCase().endsWith(candidateSuffix.toLowerCase())) continue;
      const bodyStart = configuredPrefix.length;
      const bodyEnd = text.length - candidateSuffix.length;
      if (bodyEnd <= bodyStart) continue;
      const body = text.slice(bodyStart, bodyEnd);
      const match = body.match(/^[\s\-_/.:]*(\d+)[\s\-_/.:]*$/);
      if (!match) continue;
      const serialText = match[1];
      const relative = body.indexOf(serialText);
      const serialStart = bodyStart + relative;
      return {
        invoiceNo: text,
        serial: Number(serialText),
        serialText,
        serialStart,
        serialEnd: serialStart + serialText.length,
      };
    }

    // Separator-based historical numbers remain safe even when their suffix is
    // completely custom: PREFIX-039-OLD-SUFFIX -> 039.
    const afterPrefix = text.slice(configuredPrefix.length);
    const separated = afterPrefix.match(/^[\s\-_/.:]+(\d+)(?=[\s\-_/.:]|$)/);
    if (separated) {
      const serialText = separated[1];
      const serialStart = configuredPrefix.length + separated.index + separated[0].indexOf(serialText);
      return {
        invoiceNo: text,
        serial: Number(serialText),
        serialText,
        serialStart,
        serialEnd: serialStart + serialText.length,
      };
    }
  }

  // Last-resort parsing for genuinely old/custom formats. Prefer a standalone
  // numeric token; do not concatenate every digit in the invoice number.
  const token = text.match(/(?:^|[^0-9])(\d+)(?=$|[^0-9])/);
  if (token) {
    const serialText = token[1];
    const offset = token[0].lastIndexOf(serialText);
    const serialStart = (token.index || 0) + offset;
    return {
      invoiceNo: text,
      serial: Number(serialText),
      serialText,
      serialStart,
      serialEnd: serialStart + serialText.length,
    };
  }
  return null;
}

function formatObservedSalesInvoiceNumber({
  serial,
  sample,
  paddingWidth,
  prefix,
  suffix,
}) {
  const serialText =
    paddingWidth > 0
      ? String(serial).padStart(paddingWidth, "0")
      : String(serial);
  if (
    sample &&
    Number.isInteger(sample.serialStart) &&
    Number.isInteger(sample.serialEnd)
  ) {
    return `${sample.invoiceNo.slice(0, sample.serialStart)}${serialText}${sample.invoiceNo.slice(sample.serialEnd)}`;
  }
  return formatSalesInvoiceNumber(prefix, serialText, suffix);
}

async function salesInvoiceSeriesFinancialYears(
  tenantKey,
  requestedFinancialYear = "",
) {
  const company = await CompanyProfile.findOne({ tenantKey })
    .select("financialYear financialYears")
    .lean();
  const years = [];
  const add = (value) => {
    const fy = cleanText(value);
    if (/^\d{4}-\d{2}$/.test(fy) && !years.includes(fy)) years.push(fy);
  };
  add(requestedFinancialYear);
  for (const fy of Array.isArray(company?.financialYears)
    ? company.financialYears
    : [])
    add(fy);
  add(company?.financialYear);
  return years;
}

const PERFORMA_INVOICE_PREFIX = "Performa Invoice-";

function normalizedSalesInvoiceType(value) {
  return upper(value) === "PERFORMA" ? "PERFORMA" : "INVOICE";
}

function performaInvoiceSerialInfo(value) {
  const match = cleanText(value).match(/^Performa\s+Invoice-(\d+)$/i);
  if (!match) return null;
  const serial = Number(match[1]);
  return Number.isFinite(serial) && serial >= 1
    ? { serial, serialText: match[1] }
    : null;
}

async function maxKnownPerformaSerial(tenantKey, requestedFinancialYear = "") {
  const years = await salesInvoiceSeriesFinancialYears(
    tenantKey,
    requestedFinancialYear,
  );
  let maxSerial = 0;
  for (const financialYear of years) {
    try {
      const { SalesInvoice } = financialModels(tenantKey, financialYear);
      const rows = await SalesInvoice.find({
        tenantKey,
        $or: [
          { invoiceType: "PERFORMA" },
          { invoiceNo: /^Performa\s+Invoice-\d+$/i },
          { sourcePerformaNo: /^Performa\s+Invoice-\d+$/i },
        ],
      })
        .select("invoiceNo sourcePerformaNo performaSerial")
        .lean();
      for (const row of rows) {
        maxSerial = Math.max(
          maxSerial,
          Number(row.performaSerial || 0),
          Number(performaInvoiceSerialInfo(row.invoiceNo)?.serial || 0),
          Number(performaInvoiceSerialInfo(row.sourcePerformaNo)?.serial || 0),
        );
      }
    } catch {
      // A configured historical FY may not have been created yet.
    }
  }
  return maxSerial;
}

async function performaInvoiceSeries(
  tenantKey,
  requestedFinancialYear = "",
  { consume = false } = {},
) {
  const observedMax = await maxKnownPerformaSerial(
    tenantKey,
    requestedFinancialYear,
  );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const company = await CompanyProfile.findOne({ tenantKey })
      .select("performaInvoiceNextNumber")
      .lean();
    if (!company)
      throw Object.assign(new Error("Company profile not found"), {
        statusCode: 404,
      });

    const storedValue = Number(company.performaInvoiceNextNumber || 0);
    const serial = Math.max(1, observedMax + 1, storedValue || 1);
    if (!consume) {
      return {
        invoiceNo: `${PERFORMA_INVOICE_PREFIX}${serial}`,
        serial,
        serialText: String(serial),
        prefix: PERFORMA_INVOICE_PREFIX,
        suffix: "",
        financialYear: cleanText(requestedFinancialYear),
        performaInvoice: true,
        invoiceType: "PERFORMA",
      };
    }

    const counterFilter = storedValue >= 1
      ? { tenantKey, performaInvoiceNextNumber: storedValue }
      : {
          tenantKey,
          $or: [
            { performaInvoiceNextNumber: { $exists: false } },
            { performaInvoiceNextNumber: null },
            { performaInvoiceNextNumber: 0 },
          ],
        };
    const updated = await CompanyProfile.findOneAndUpdate(
      counterFilter,
      { $set: { performaInvoiceNextNumber: serial + 1 } },
      { new: true },
    ).lean();
    if (updated) {
      return {
        invoiceNo: `${PERFORMA_INVOICE_PREFIX}${serial}`,
        serial,
        serialText: String(serial),
        prefix: PERFORMA_INVOICE_PREFIX,
        suffix: "",
        financialYear: cleanText(requestedFinancialYear),
        performaInvoice: true,
        invoiceType: "PERFORMA",
      };
    }
  }

  throw Object.assign(
    new Error("Could not allocate the next Performa Invoice number. Retry once."),
    { statusCode: 409 },
  );
}

async function salesInvoiceNumberExistsAcrossSeries({
  tenantKey,
  financialYear,
  invoiceNo,
}) {
  const wanted = cleanText(invoiceNo);
  if (!wanted) return false;
  const years = await salesInvoiceSeriesFinancialYears(
    tenantKey,
    financialYear,
  );
  for (const fy of years) {
    try {
      const { SalesInvoice } = financialModels(tenantKey, fy);
      if (await SalesInvoice.exists({ tenantKey, invoiceNo: wanted }))
        return true;
    } catch {
      // Ignore unavailable historical FY databases and continue checking the rest.
    }
  }
  return false;
}

async function salesInvoiceNumberAnalysis({ tenantKey, financialYear }) {
  const series = await salesInvoiceSeries(tenantKey, financialYear);
  const prefix = cleanText(series.prefix),
    suffix = cleanText(series.suffix);

  // Number ranges/missing numbers are also FY-specific. An invoice number used
  // in 2025-26 must have no effect on the sequence for 2026-27.
  const scannedFinancialYears = [financialYear];
  const observed = [];
  try {
    const { SalesInvoice } = financialModels(tenantKey, financialYear);
    const rows = await SalesInvoice.find({
      tenantKey, status: "POSTED", invoiceNo: { $nin: [null, ""] },
    }).select("invoiceNo customerGlobalId gstinSnapshot").lean();
    const invoiceNos = (await registeredInvoiceRows(tenantKey, rows, prefix))
      .map((row) => row.invoiceNo);
    for (const invoiceNo of invoiceNos) {
      observed.push({
        invoiceNo: cleanText(invoiceNo),
        financialYear,
      });
    }
  } catch {
    // A new FY may not have a database/collection yet. Treat it as an empty
    // invoice series and start from the configured starting number.
  }

  const uniqueInvoiceNos = [
    ...new Set(observed.map((row) => row.invoiceNo).filter(Boolean)),
  ];
  const matched = uniqueInvoiceNos
    .map((invoiceNo) =>
      salesInvoiceSerialInfo(invoiceNo, prefix, suffix, financialYear),
    )
    .filter((row) => row && Number.isFinite(row.serial) && row.serial >= 0)
    .sort((a, b) => a.serial - b.serial);

  let firstInvoiceNo = "",
    lastInvoiceNo = "";
  if (matched.length) {
    firstInvoiceNo = matched[0].invoiceNo;
    lastInvoiceNo = matched[matched.length - 1].invoiceNo;
  } else if (uniqueInvoiceNos.length) {
    firstInvoiceNo = uniqueInvoiceNos[0];
    lastInvoiceNo = uniqueInvoiceNos[uniqueInvoiceNos.length - 1];
  }

  const rangeText =
    firstInvoiceNo && lastInvoiceNo
      ? firstInvoiceNo === lastInvoiceNo
        ? firstInvoiceNo
        : `${firstInvoiceNo} → ${lastInvoiceNo}`
      : "No sales invoices created yet";

  const configuredStart = Math.max(
    1,
    Math.trunc(Number(series.startingNumber || 1)),
  );
  const startSerial = configuredStart;

  // Missing numbers belong only to this FY's current invoice pattern.
  const currentPatternSample = salesInvoiceSerialInfo(
    series.invoiceNo,
    prefix,
    suffix,
    financialYear,
  );
  const patternBefore = currentPatternSample
    ? currentPatternSample.invoiceNo.slice(0, currentPatternSample.serialStart)
    : "";
  const patternAfter = currentPatternSample
    ? currentPatternSample.invoiceNo.slice(currentPatternSample.serialEnd)
    : "";
  const sameCurrentPattern = (invoiceNo) => {
    const text = cleanText(invoiceNo);
    if (!text) return null;
    if (
      patternBefore &&
      !text.toLowerCase().startsWith(patternBefore.toLowerCase())
    )
      return null;
    if (
      patternAfter &&
      !text.toLowerCase().endsWith(patternAfter.toLowerCase())
    )
      return null;
    const start = patternBefore.length;
    const end = patternAfter ? text.length - patternAfter.length : text.length;
    if (end <= start) return null;
    const serialText = text.slice(start, end);
    if (!/^\d+$/.test(serialText)) return null;
    return {
      invoiceNo: text,
      serial: Number(serialText),
      serialText,
      serialStart: start,
      serialEnd: end,
    };
  };
  const currentSeriesMatched = uniqueInvoiceNos
    .map(sameCurrentPattern)
    .filter(
      (row) => row && Number.isFinite(row.serial) && row.serial >= startSerial,
    )
    .sort((a, b) => a.serial - b.serial);

  const highestUsedSerial = currentSeriesMatched.length
    ? currentSeriesMatched[currentSeriesMatched.length - 1].serial
    : startSerial - 1;
  // The FY database is the source of truth; there is no cross-FY/global counter.
  const endSerial = Math.max(
    highestUsedSerial,
    Math.max(startSerial - 1, Number(series.serial || startSerial) - 1),
  );
  const used = new Set(currentSeriesMatched.map((row) => row.serial));
  const earliest = currentSeriesMatched[0] || null;
  // Use the latest user-selected numeric style for missing-number display too.
  // This keeps 001/002 or 01/02 consistent everywhere after the user changes it.
  const paddingWidth = Number(series.paddingWidth || 0) ||
    (earliest && /^0\d+$/.test(earliest.serialText)
      ? earliest.serialText.length
      : 0);
  const sample = earliest || currentPatternSample;
  const missingInvoiceNumbers = [];
  for (let serial = startSerial; serial <= endSerial; serial += 1) {
    if (used.has(serial)) continue;
    const displaySerial =
      paddingWidth > 0
        ? String(serial).padStart(paddingWidth, "0")
        : String(serial);
    missingInvoiceNumbers.push({
      serial,
      displaySerial,
      invoiceNo: formatObservedSalesInvoiceNumber({
        serial,
        sample,
        paddingWidth,
        prefix,
        suffix,
      }),
    });
  }

  return {
    financialYear,
    scannedFinancialYears,
    firstInvoiceNo,
    lastInvoiceNo,
    rangeText,
    count: uniqueInvoiceNos.length,
    prefix,
    suffix,
    startSerial,
    endSerial,
    paddingWidth,
    missingInvoiceNumbers,
  };
}

function applySalesInvoiceScope(filter, auth) {
  if (auth?.role === "MASTER" || auth?.role === "SUPERADMIN") return filter;
  if (auth?.dataScope === "WAREHOUSE") {
    if (!auth?.warehouseId) {
      filter._id = "__NO_ACCESS__";
      return filter;
    }
    filter.warehouseId = auth.warehouseId;
    filter.workflowStatus = {
      $in: ["RELEASED_TO_WAREHOUSE", "PICKING", "PACKED", "READY_FOR_DISPATCH"],
    };
  } else if (auth?.dataScope === "ASSIGNED") {
    filter.$or = [{ assignedTo: auth.sub }, { createdBy: auth.sub }];
  } else if (auth?.dataScope === "SELF") {
    filter.createdBy = auth.sub;
  } else if (auth?.dataScope === "BRANCH" && auth?.branch) {
    filter.branchId = auth.branch;
  }
  return filter;
}

function applySalesInvoiceTypeFilter(filter, invoiceType = "INVOICE") {
  const type = normalizedSalesInvoiceType(invoiceType);
  if (type === "PERFORMA") {
    filter.invoiceType = "PERFORMA";
    return filter;
  }

  const legacyInvoiceType = {
    $or: [
      { invoiceType: "INVOICE" },
      { invoiceType: { $exists: false } },
      { invoiceType: "" },
      { invoiceType: null },
    ],
  };
  filter.$and = [...(Array.isArray(filter.$and) ? filter.$and : []), legacyInvoiceType];
  return filter;
}

export async function calculateSalesInvoice({
  auth,
  body,
  existingInvoice = null,
}) {
  const tenantKey = auth.tenantKey,
    date = transactionDate(body.date),
    financialYear =
      financialYearFromDate(body.date) ||
      financialYearFromDate(date) ||
      (await resolveFinancialYear({
        tenantKey,
        requested: body.financialYear || existingInvoice?.financialYear,
      }));
  const customer = await CustomerLink.findOne({
    tenantKey,
    globalCustomerId: body.customerGlobalId,
    status: "ACTIVE",
  }).lean();
  if (!customer)
    throw Object.assign(new Error("Active approved customer is required"), {
      statusCode: 400,
    });
  // CUSTOMER GRADES is the authoritative source for the discount percentage.
  // CustomerLink.gradeDiscountPct is only a cache and may be stale if a grade
  // was edited after the customer was assigned to it.
  const liveGrade = customer.gradeCode
    ? await CustomerGrade.findOne({
        tenantKey,
        code: upper(customer.gradeCode),
        status: "ACTIVE",
      })
        .select("code name discountPct")
        .lean()
    : null;
  customer.gradeDiscountPct = liveGrade ? Number(liveGrade.discountPct || 0) : 0;
  customer.gradeName = liveGrade?.name || "";
  // Historical/bulk Sales-with-Product imports may be posted before transporter
  // masters are completed. This bypass is explicit and is NOT enabled for normal
  // sales invoice creation. Transporter can be assigned/cleaned up afterwards.
  const isQuickEntryImport = upper(body.importSource || "") === "QUICK_ENTRY";
  const isCashCustomer = isSystemCashParty(customer);
  // Transporter validation is skipped only for historical QUICK_ENTRY imports
  // and the permanent system-managed CASH customer. Normal customers keep the
  // existing locality/transporter validation unchanged.
  const skipTransporterValidation = isQuickEntryImport || isCashCustomer;
  const transportAssignment = skipTransporterValidation
    ? {
        mode: isCashCustomer ? "LOCAL" : "UNASSIGNED",
        firmCitySnapshot: "",
        customerCitySnapshot: "",
        serviceAreaSnapshot: cleanText(customer?.serviceArea || ""),
        pendingAssignment: !isCashCustomer,
      }
    : await customerTransportSnapshot({
        tenantKey,
        customer,
        selectedTransporterId: body.transporterId || body.selectedTransporterId || "",
      });
  const firm = await resolveFirmDeliveryLocation(tenantKey);
  const customerGstin =
    customer.displayIdentifier?.length === 15 ? customer.displayIdentifier : "";
  const customerAddress =
    (customer.addresses || []).find(
      (x) => upper(x.type || "BILLING") === "BILLING",
    ) || {};
  // Tax locality and delivery locality are intentionally separate:
  // GSTIN/state decides CGST+SGST vs IGST; city decides Local vs Transport.
  const gstType = gstTypeFromLocations({
    companyGstin: firm.company?.gstin,
    customerGstin,
    companyState: firm.state,
    customerState: customerAddress.state,
    requested: body.gstType,
  });

  // A multi-warehouse order is legally billed as one invoice. Dispatch and
  // custody belong to the Main Warehouse; this ID is derived from the order
  // rather than asked again on the invoice form. Direct invoices stay unchanged.
  const orderBillingId = cleanText(body.sourceOrderId);
  const sourceOrderForWarehouse = orderBillingId
    ? await financialModels(tenantKey, financialYear).SalesOrder.findOne({
        _id:orderBillingId, tenantKey, financialYear,
      }).select("mainWarehouseId warehouseId items").lean()
    : null;
  if (orderBillingId && !sourceOrderForWarehouse)
    throw Object.assign(new Error("Order not found for warehouse auto-assignment"),{statusCode:404});
  const warehouseId = orderBillingId
    ? cleanText(sourceOrderForWarehouse.mainWarehouseId || sourceOrderForWarehouse.warehouseId)
    : cleanText(body.warehouseId || existingInvoice?.warehouseId);
  if (!warehouseId)
    throw Object.assign(new Error("Warehouse is mandatory for Sales Invoice"), {
      statusCode: 400,
    });
  const warehouse = await GenericRecord.findOne({
    _id: warehouseId,
    tenantKey,
    app: "dms",
    resource: "warehouses",
    status: "ACTIVE",
  }).lean();
  if (!warehouse)
    throw Object.assign(new Error("Select a valid active warehouse"), {
      statusCode: 400,
    });

  const requested = Array.isArray(body.items) ? body.items : [];
  if (!requested.length)
    throw Object.assign(new Error("At least one product row is required"), {
      statusCode: 400,
    });
  const ids = Array.from(
    new Set(requested.map((x) => String(x.productId || "")).filter(Boolean)),
  );
  const products = await Product.find({
    tenantKey,
    _id: { $in: ids },
    status: "ACTIVE",
  });
  const pm = new Map(products.map((p) => [String(p._id), p]));
  const packingCodes = Array.from(
    new Set(products.map((p) => upper(p.packingUnit)).filter(Boolean)),
  );
  const companyUnits = packingCodes.length
    ? await CompanyUnit.find({ tenantKey, code: { $in: packingCodes } })
        .select("code name")
        .lean()
    : [];
  const packingNames = new Map(
    companyUnits.map((u) => [upper(u.code), cleanText(u.name) || u.code]),
  );
  const missingPacking = packingCodes.filter((code) => !packingNames.has(code));
  if (missingPacking.length) {
    const masterUnits = await Unit.find({ code: { $in: missingPacking } })
      .select("code name")
      .lean();
    for (const u of masterUnits)
      packingNames.set(upper(u.code), cleanText(u.name) || u.code);
  }
  let averages = { sales: new Map(), purchases: new Map() };
  try {
    averages = await historicalAverageRates({
      tenantKey,
      financialYear,
      productIds: ids,
    });
  } catch (e) {
    console.error(
      "sales invoice average purchase lookup failed",
      e?.message || e,
    );
  }
  const oldQty = new Map();
  for (const item of existingInvoice?.items || [])
    oldQty.set(
      String(item.productId),
      Number(oldQty.get(String(item.productId)) || 0) + Number(item.qty || 0),
    );

  const items = [];
  let lineSubtotal = 0,
    taxTotal = 0,
    grossProfit = 0;
  for (const row of requested) {
    const p = pm.get(String(row.productId));
    if (!p)
      throw Object.assign(new Error(`Product not found: ${row.productId}`), {
        statusCode: 400,
      });
    const qty = Number(row.qty || 0);
    if (qty <= 0)
      throw Object.assign(new Error(`Invalid quantity for ${p.name}`), {
        statusCode: 400,
      });
    const available =
      Number(p.currentStock || 0) + Number(oldQty.get(String(p._id)) || 0);
    if (
      available < qty &&
      !orderBillingId &&
      !(body.allowNegativeStock === true || isQuickEntryImport)
    )
      throw Object.assign(
        new Error(
          `${p.name}: only ${available} ${p.basicUnit || p.unit || "PCS"} available`,
        ),
        { statusCode: 409 },
      );
    const { saleRate, gradeDiscountPct: liveGradeDiscountPct } = await resolvedProductRate({
      customer,
      product: p,
      row,
    });
    // Order-linked invoices must keep the grade captured when the order was
    // placed, not silently replace it with today's customer grade. Grade is
    // derived from the persisted order, not an editable browser payload.
    const savedOrderItem = orderBillingId
      ? (sourceOrderForWarehouse?.items || []).find((x) => String(x.productId) === String(p._id))
      : null;
    const gradeDiscountPct = savedOrderItem
      ? Math.max(0, Math.min(100, Number(savedOrderItem.gradeDiscountPct ?? savedOrderItem.discountPct ?? 0)))
      : liveGradeDiscountPct;
    const gstRate = Number(row.gstRate ?? p.gstRate ?? 0),
      basicRate = Number(row.basicRate || basicFromSaleGst(saleRate, gstRate)),
      itemDiscountPct = Number(row.discountPct || 0);
    const effectiveRate = round2(basicRate * (1 - itemDiscountPct / 100));
    const avgPurchase = Number(
      averages.purchases.get(String(p._id))?.averageRate || 0,
    );
    const purchaseCost = avgPurchase > 0 ? avgPurchase : purchaseRateOf(p);
    const taxable = round2(effectiveRate * qty),
      tax = round2((taxable * gstRate) / 100),
      cgst = gstType === "IGST" ? 0 : round2(tax / 2),
      sgst = gstType === "IGST" ? 0 : round2(tax / 2),
      igst = gstType === "IGST" ? tax : 0;
    lineSubtotal += taxable;
    taxTotal += tax;
    grossProfit += round2((effectiveRate - purchaseCost) * qty);
    items.push({
      productId: String(p._id),
      sku: p.sku,
      nameSnapshot: p.name,
      hsnSnapshot: p.hsnCode,
      qty,
      unit: p.basicUnit || p.unit,
      packingUnit: p.packingUnit
        ? packingNames.get(upper(p.packingUnit)) || p.packingUnit
        : "",
      qtyInBag: Number(p.qtyInBag || 1),
      grossQty:
        Number(p.qtyInBag || 0) > 0
          ? round2(qty / Number(p.qtyInBag || 1))
          : qty,
      mrpSnapshot: Number(row.mrp || p.mrp || 0),
      gradeDiscountPct,
      landedCostSnapshot: Number(purchaseCost || 0),
      averagePurchasePriceSnapshot: Number(
        avgPurchase || p.averagePurchasePrice || 0,
      ),
      rate: saleRate,
      discountPct: itemDiscountPct,
      effectiveRate,
      taxable,
      gstRateSnapshot: gstRate,
      cgst,
      sgst,
      igst,
      tax,
      lineTotal: round2(taxable + tax),
      profitPct:
        purchaseCost > 0
          ? round2(((effectiveRate - purchaseCost) / purchaseCost) * 100)
          : 0,
      marginColor: effectiveRate < purchaseCost ? "RED" : "GREEN",
    });
  }
  const billDiscount = Number(body.billDiscount || 0),
    otherCharges = Number(body.otherCharges || 0);
  const billTax = billLevelTaxSummary(items, billDiscount, otherCharges);

  // Billing must never go below purchase cost. The item stays selectable/editable;
  // only posting is rejected. Bill-level discounts are proportionately applied
  // before the final comparison so a discount cannot silently push a line below cost.
  const discountFactor =
    billTax.subtotal > 0
      ? Math.max(0, (billTax.subtotal - billTax.discount) / billTax.subtotal)
      : 1;
  const belowPurchase = [];
  for (const item of items) {
    const finalBillingRate = round2(
      Number(item.effectiveRate || 0) * discountFactor,
    );
    const purchaseCost = Number(item.landedCostSnapshot || 0);
    if (purchaseCost > 0 && finalBillingRate + 0.005 < purchaseCost) {
      belowPurchase.push({
        productId: item.productId,
        product: item.nameSnapshot,
        billingRate: finalBillingRate,
        purchaseRate: round2(purchaseCost),
      });
    }
  }
  // Historical QUICK_ENTRY imports are reconstruction data. Do not block them
  // because the current purchase history has not been imported yet. Once the
  // historical purchases are loaded, costing/profit reports can be recalculated.
  if (belowPurchase.length && !isQuickEntryImport) {
    const first = belowPurchase[0];
    throw Object.assign(
      new Error(
        `${first.product}: billing price ₹${first.billingRate.toFixed(2)} is below purchase price ₹${first.purchaseRate.toFixed(2)}. Increase the billing rate or reduce discount.`,
      ),
      { statusCode: 409, details: { belowPurchase } },
    );
  }

  const taxableTotal = billTax.taxableTotal;
  taxTotal = billTax.taxTotal;
  const beforeRound = round2(taxableTotal + taxTotal),
    grandTotal =
      body.roundGrandTotal === false ? beforeRound : Math.round(beforeRound),
    roundOff = round2(grandTotal - beforeRound);
  // Never evaluate current receivable/ledger balance or credit limit while
  // reconstructing historical sales. Receipts/payments/openings may not exist yet.
  if (
    !isQuickEntryImport &&
    customer.paymentType === "CREDIT" &&
    customer.creditLimit > 0 &&
    !body.creditOverrideApproved
  ) {
    const balance = await customerReceivableBalance({
      tenantKey,
      financialYear,
      customerGlobalId: customer.globalCustomerId,
    });
    const adjustedBalance = balance - Number(existingInvoice?.grandTotal || 0);
    if (adjustedBalance + grandTotal > customer.creditLimit)
      throw Object.assign(
        new Error("Customer credit limit would be exceeded"),
        {
          statusCode: 409,
          details: {
            currentOutstanding: adjustedBalance,
            newOrder: grandTotal,
            creditLimit: customer.creditLimit,
          },
        },
      );
  }
  return {
    tenantKey,
    financialYear,
    customer,
    customerAddress,
    transportAssignment,
    gstType,
    warehouse,
    warehouseId,
    items,
    lineSubtotal,
    taxTotal,
    grossProfit,
    taxableTotal,
    grandTotal,
    roundOff,
    date,
  };
}

export async function postSalesAccounting({
  tenantKey,
  financialYear,
  invoiceNo,
  date,
  customer,
  grandTotal,
  taxableTotal,
  taxTotal,
  roundOff,
}) {
  const partyAccountCode = partyAccountCodeOf(customer);
  await postBalancedEntries({
    tenantKey,
    financialYear,
    transactionId: invoiceNo,
    transactionType: "SALES_INVOICE",
    date,
    partyGlobalId: customer.globalCustomerId,
    narration: `Sales Invoice ${invoiceNo}`,
    entries: [
      { accountCode: partyAccountCode, debit: grandTotal },
      { accountCode: "SYS_SALES", credit: taxableTotal },
      { accountCode: "SYS_DUTIES_TAXES", credit: taxTotal },
      {
        accountCode:
          roundOff >= 0 ? "SYS_INDIRECT_INCOME" : "SYS_INDIRECT_EXPENSE",
        credit: roundOff > 0 ? roundOff : 0,
        debit: roundOff < 0 ? Math.abs(roundOff) : 0,
      },
    ].filter((x) => Number(x.debit || 0) || Number(x.credit || 0)),
  });
}

export function normalizedEInvoice(body = {}, existing = {}) {
  const source =
    body?.eInvoice && typeof body.eInvoice === "object" ? body.eInvoice : {};
  const previous = existing && typeof existing === "object" ? existing : {};
  const rawStatus = upper(source.status ?? previous.status ?? "NOT_GENERATED");
  const allowed = new Set([
    "NOT_GENERATED",
    "PENDING",
    "GENERATED",
    "CANCELLED",
  ]);
  const status = allowed.has(rawStatus) ? rawStatus : "NOT_GENERATED";
  const ackDateRaw = cleanText(source.ackDate ?? previous.ackDate ?? "");
  let ackDate;
  if (ackDateRaw) {
    const parsed = new Date(ackDateRaw);
    if (!Number.isNaN(parsed.getTime())) ackDate = parsed;
  }
  return {
    status,
    irn: cleanText(source.irn ?? previous.irn ?? ""),
    ackNo: cleanText(source.ackNo ?? previous.ackNo ?? ""),
    ackDate,
    signedQrPayload: cleanText(
      source.signedQrPayload ?? previous.signedQrPayload ?? "",
    ),
  };
}


async function lastUsedEligibleTransporter({
  tenantKey,
  customerGlobalId,
  eligibleIds = [],
  requestedFinancialYear = "",
}) {
  if (!customerGlobalId || !eligibleIds.length) return "";
  const eligible = new Set(eligibleIds.map((id) => cleanText(id)).filter(Boolean));
  const profile = await CompanyProfile.findOne({ tenantKey })
    .select("financialYear financialYears")
    .lean();
  const financialYears = [
    requestedFinancialYear,
    profile?.financialYear,
    ...(Array.isArray(profile?.financialYears) ? profile.financialYears : []),
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);

  const latestRows = await Promise.all(
    financialYears.map(async (financialYear) => {
      try {
        const { SalesInvoice } = financialModels(tenantKey, financialYear);
        return await SalesInvoice.findOne({
          tenantKey,
          customerGlobalId,
          status: "POSTED",
          "transportAssignment.transporterId": { $in: [...eligible] },
        })
          .sort({ date: -1, createdAt: -1 })
          .select("date createdAt transportAssignment.transporterId transportAssignment.transporterNameSnapshot")
          .lean();
      } catch {
        return null;
      }
    }),
  );

  latestRows.sort((a, b) => {
    const ad = new Date(a?.date || a?.createdAt || 0).getTime();
    const bd = new Date(b?.date || b?.createdAt || 0).getTime();
    return bd - ad;
  });

  for (const row of latestRows) {
    const transporterId = cleanText(row?.transportAssignment?.transporterId);
    if (eligible.has(transporterId)) return transporterId;
  }
  return "";
}

router.get("/sales-invoices/transporter-options", async (req, res) => {
  try {
    const customerGlobalId = cleanText(req.query.customerGlobalId);
    if (!customerGlobalId) return fail(res, "Customer is required", 400);

    const customer = await CustomerLink.findOne({
      tenantKey: req.auth.tenantKey,
      globalCustomerId: customerGlobalId,
      status: "ACTIVE",
    }).lean();
    if (!customer) return fail(res, "Active customer not found", 404);
    if (isSystemCashParty(customer)) {
      return ok(res, {
        matchType: "NONE",
        rule: "CASH_NO_TRANSPORTER",
        items: [],
        defaultTransporterId: "",
        lastUsedTransporterId: "",
      });
    }

    const billing =
      (customer.addresses || []).find(
        (row) => upper(row?.type || "BILLING") === "BILLING",
      ) ||
      (customer.addresses || [])[0] ||
      {};

    const assignedItems = await customerAssignedTransporterOptions({
      tenantKey: req.auth.tenantKey,
      customer,
      billing,
    });
    const matched = await matchCustomerTransporters({
      tenantKey: req.auth.tenantKey,
      pincode: billing.pincode,
      city: billing.city,
    });
    const items = mergeTransporterOptions(assignedItems, Array.isArray(matched.items) ? matched.items : []);
    const eligibleIds = items.map((item) => cleanText(item.transporterId)).filter(Boolean);
    const lastUsedTransporterId = await lastUsedEligibleTransporter({
      tenantKey: req.auth.tenantKey,
      customerGlobalId,
      eligibleIds,
      requestedFinancialYear: cleanText(req.query.financialYear),
    });
    const storedAssignedId = cleanText(customer.assignedTransport);
    const assignedDefaultId = eligibleIds.includes(storedAssignedId)
      ? storedAssignedId
      : assignedItems.length === 1
        ? cleanText(assignedItems[0].transporterId)
        : "";
    const defaultTransporterId =
      assignedDefaultId || lastUsedTransporterId || (items.length === 1 ? cleanText(items[0].transporterId) : "");

    return ok(res, {
      ...matched,
      matchType: assignedItems.length ? (customer.transporterMatchType || matched.matchType || "ASSIGNED") : matched.matchType,
      rule: assignedItems.length ? "CUSTOMER_ASSIGNED_FIRST" : "PINCODE_THEN_CITY",
      items,
      lastUsedTransporterId,
      defaultTransporterId,
    });
  } catch (error) {
    return fail(
      res,
      error.message || "Unable to load transporter options",
      error.statusCode || error.status || 400,
    );
  }
});

router.get("/sales-invoices/next-number", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.query.financialYear,
    });
    const invoiceType = normalizedSalesInvoiceType(req.query.invoiceType);
    if (invoiceType === "PERFORMA") {
      return ok(
        res,
        await performaInvoiceSeries(req.auth.tenantKey, financialYear),
      );
    }
    const customerGlobalId = cleanText(req.query.customerGlobalId || "");
    if (customerGlobalId) {
      const customer = await CustomerLink.findOne({
        tenantKey: req.auth.tenantKey,
        globalCustomerId: customerGlobalId,
        status: "ACTIVE",
      }).lean();
      if (!customer) return fail(res, "Selected party not found or inactive", 404);
      if (!isRegisteredParty(customer)) {
        const invoiceNo = await nextCashInvoiceNumber({
          tenantKey: req.auth.tenantKey,
          financialYear,
          customerGlobalId: customer.globalCustomerId,
        });
        const configured = await salesInvoiceSeries(
          req.auth.tenantKey,
          financialYear,
        );
        return ok(res, {
          invoiceNo,
          serialText: invoiceSerialForInput(
            invoiceNo,
            configured.prefix,
            configured.suffix,
          ),
          financialYear,
          prefix: configured.prefix.replace(/\s+/g, ""),
          suffix: configured.suffix.replace(/[^0-9A-Za-z]/g, ""),
          cashInvoice: true,
          registrationSeries: "UNREGISTERED",
        });
      }
    }
    return ok(
      res,
      await salesInvoiceSeries(req.auth.tenantKey, financialYear),
    );
  } catch (e) {
    return fail(res, e.message, e.statusCode || 400);
  }
});

router.get("/sales-invoices/number-range", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey;
    const financialYear = await resolveFinancialYear({
      tenantKey,
      requested: req.query.financialYear,
    });
    return ok(
      res,
      await salesInvoiceNumberAnalysis({ tenantKey, financialYear }),
    );
  } catch (e) {
    return fail(res, e.message, e.statusCode || 400);
  }
});

router.get("/sales-invoices", async (req, res) => {
  const financialYear = await resolveFinancialYear({
    tenantKey: req.auth.tenantKey,
    requested: req.query.financialYear,
  });
  const models = financialModels(req.auth.tenantKey, financialYear);
  const { SalesInvoice } = models;
  const page = Number(req.query.page || 1),
    limit = Math.min(100, Number(req.query.limit || 25));
  const invoiceType = normalizedSalesInvoiceType(req.query.invoiceType);
  const filter = applySalesInvoiceTypeFilter(applySalesInvoiceScope(
    { tenantKey: req.auth.tenantKey, financialYear },
    req.auth,
  ), invoiceType);
  if (req.query.customerGlobalId)
    filter.customerGlobalId = cleanText(req.query.customerGlobalId);
  if (req.query.includeDeleted !== "true")
    filter.status = { $nin: ["DELETED", "CANCELLED"] };
  const salesListRange = transactionQueryDateRange(req);
  if (salesListRange) filter.date = salesListRange;
  let [items, total] = await Promise.all([
    SalesInvoice.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    SalesInvoice.countDocuments(filter),
  ]);
  if (req.auth?.dataScope === "WAREHOUSE") {
    items = items.map((invoice) => ({
      ...invoice,
      items: (invoice.items || []).map((item) => ({
        ...item,
        landedCostSnapshot: undefined,
        averagePurchasePriceSnapshot: undefined,
      })),
    }));
  }
  if (invoiceType === "INVOICE") {
    items = await enrichSalesInvoicesWithCreditState({
      models,
      tenantKey: req.auth.tenantKey,
      financialYear,
      invoices: items,
    });
  }
  items = await enrichTransactionRows({
    tenantKey: req.auth.tenantKey,
    rows: items,
    partyIdKey: "customerGlobalId",
    partySnapshotKey: "customerNameSnapshot",
  });
  items = items.map((invoice) => salesInvoiceForAuth(invoice, req.auth));
  ok(res, { items, meta: pageMeta(page, limit, total) });
});

router.get("/sales-invoices/:id", requireObjectIdParam, async (req, res) => {
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.query.financialYear,
    }),
    models = financialModels(req.auth.tenantKey, financialYear),
    { SalesInvoice } = models;
  const invoiceType = normalizedSalesInvoiceType(req.query.invoiceType);
  const filter = applySalesInvoiceTypeFilter(applySalesInvoiceScope(
    { _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear },
    req.auth,
  ), invoiceType);
  const invoice = await SalesInvoice.findOne(filter).lean();
  if (!invoice) return fail(res, "Sales invoice not found", 404);
  const withCredit = invoiceType === "INVOICE"
    ? (await enrichSalesInvoicesWithCreditState({
        models,
        tenantKey: req.auth.tenantKey,
        financialYear,
        invoices: [invoice],
      }))[0]
    : invoice;
  const [enriched] = await enrichTransactionRows({
    tenantKey: req.auth.tenantKey,
    rows: [withCredit],
    partyIdKey: "customerGlobalId",
    partySnapshotKey: "customerNameSnapshot",
  });
  return ok(res, salesInvoiceForAuth(enriched, req.auth));
});

router.put(
  "/sales-invoices/:id/cn-data",
  requireObjectIdParam,
  upload.single("cnImage"),
  async (req, res) => {
    try {
      const financialYear = await resolveFinancialYear({
        tenantKey: req.auth.tenantKey,
        requested: req.body.financialYear || req.query.financialYear,
      });
      const { SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
      const invoice = await SalesInvoice.findOne({
        _id: req.params.id,
        tenantKey: req.auth.tenantKey,
        financialYear,
        status: { $nin: ["DELETED", "CANCELLED"] },
      });
      if (!invoice) return fail(res, "Sales invoice not found", 404);

      if (req.auth.role !== "MASTER" && req.auth.role !== "SUPERADMIN") {
        if (
          req.auth.dataScope === "WAREHOUSE" &&
          (!req.auth.warehouseId || invoice.warehouseId !== req.auth.warehouseId)
        )
          return fail(res, "Invoice is outside your assigned warehouse", 403);
        if (
          req.auth.dataScope === "ASSIGNED" &&
          invoice.assignedTo !== req.auth.sub &&
          invoice.createdBy !== req.auth.sub
        )
          return fail(res, "Invoice is outside your assigned work", 403);
      }

      const cnNumber = cleanText(req.body.cnNumber);
      const cnQty = Number(req.body.cnQty);
      const cnDate = req.body.cnDate ? new Date(req.body.cnDate) : null;
      if (!cnNumber) return fail(res, "CN Number is required", 400);
      if (!Number.isFinite(cnQty) || cnQty <= 0)
        return fail(res, "CN Qty must be greater than zero", 400);
      if (!cnDate || Number.isNaN(cnDate.getTime()))
        return fail(res, "Valid CN Date is required", 400);

      const incomingImage = req.file || null;
      const existingImageFileId = cleanText(invoice.consignmentNote?.imageFileId || "");
      if (!incomingImage && !existingImageFileId)
        return fail(res, "CN Image is required", 400);
      if (
        incomingImage &&
        !String(incomingImage.mimetype || "").startsWith("image/") &&
        String(incomingImage.mimetype || "") !== "application/pdf"
      )
        return fail(res, "CN Image must be an image or PDF file", 400);

      let imageFileId = existingImageFileId;
      let imageName = cleanText(invoice.consignmentNote?.imageName || "");
      let imageMimeType = cleanText(invoice.consignmentNote?.imageMimeType || "");
      if (incomingImage) {
        const meta = await saveUploadedFile({
          file: incomingImage,
          tenantKey: req.auth.tenantKey,
          module: "DMS",
          entityType: "SALES_INVOICE_CN",
          entityId: String(invoice._id),
          uploadedBy: req.auth.sub,
          access: "PRIVATE",
        });
        imageFileId = meta.fileId;
        imageName = meta.originalName || incomingImage.originalname || "CN Image";
        imageMimeType = meta.mimeType || incomingImage.mimetype || "application/octet-stream";
      }

      invoice.consignmentNote = {
        cnDate,
        cnQty,
        cnNumber,
        imageFileId,
        imageName,
        imageMimeType,
        savedAt: new Date(),
        savedBy: req.auth.sub,
        savedByNameSnapshot: req.auth.name || req.auth.fullName || req.auth.email || "",
      };
      await invoice.save();
      return ok(
        res,
        salesInvoiceForAuth(invoice, req.auth),
        `CN data saved for invoice ${invoice.invoiceNo}`,
      );
    } catch (error) {
      return fail(res, error.message || "Unable to save CN data", error.statusCode || 400);
    }
  },
);

router.get(
  "/sales-invoices/:id/pdf",
  requireObjectIdParam,
  async (req, res) => {
    try {
      const financialYear = await resolveFinancialYear({
        tenantKey: req.auth.tenantKey,
        requested: req.query.financialYear,
      });
      const { SalesInvoice } = financialModels(
        req.auth.tenantKey,
        financialYear,
      );
      const invoiceType = normalizedSalesInvoiceType(req.query.invoiceType);
      const filter = applySalesInvoiceTypeFilter(applySalesInvoiceScope(
        { _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear },
        req.auth,
      ), invoiceType);
      const invoice = await SalesInvoice.findOne(filter).lean();
      if (!invoice) return fail(res, "Sales invoice not found", 404);
      const pdf = await buildInvoicePdfBuffer({
        tenantKey: req.auth.tenantKey,
        financialYear,
        invoice,
      });
      const fileName = invoicePdfFileName(invoice, req.params.id);
      res.setHeader("Content-Type", "application/pdf");
      const asciiFileName = safeFilePart(fileName);
      res.setHeader(
        "Content-Disposition",
        `${req.query.download === "1" ? "attachment" : "inline"}; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      return res.send(pdf);
    } catch (error) {
      return fail(res, error.message || "Could not generate invoice PDF", 500);
    }
  },
);

const escapeSalesRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A soft-deleted test invoice still occupies its number because invoiceNo has a
// unique index. Only an unissued, fully reversed DIRECT test invoice can release
// that slot. Preserve the deleted document and historical journal/stock rows under
// a unique audit reference; never erase accounting history or recycle issued IDs.
async function releaseDeletedTestSalesNumber({ tenantKey, financialYear, invoiceNo }) {
  const { SalesInvoice, LedgerEntry, StockMovement, CreditNote, SalesOrder } = financialModels(tenantKey, financialYear);
  const deleted = await SalesInvoice.findOne({ tenantKey, financialYear, invoiceNo, status: "DELETED" });
  if (!deleted) return false;
  if (deleted.voidedInvoiceNo || deleted.sourceOrderId || deleted.billingMode === "ORDER"
      || deleted.eInvoice?.irn || deleted.eInvoice?.ackNo || deleted.eInvoice?.status === "GENERATED"
      || deleted.delivery?.deliveredAt || deleted.delivery?.emailedAt
      || deleted.delivery?.emailStatus === "SENT"
      || deleted.delivery?.proofFiles?.length || deleted.delivery?.proofFileIds?.length
      || Number(deleted.creditNoteAmount || 0) !== 0) {
    throw Object.assign(new Error(`Deleted invoice ${invoiceNo} is linked to issued or external documents and cannot be reused.`), { statusCode: 409 });
  }
  const hasNotes = await CreditNote.exists({ tenantKey, financialYear,
    $or: [{ invoiceId: String(deleted._id) }, { referenceDocumentId: String(deleted._id) }, { invoiceNo }] });
  const hasOrder = await SalesOrder.exists({ tenantKey, financialYear,
    $or: [{ "invoice.invoiceId": String(deleted._id) }, { "invoice.invoiceNo": invoiceNo }] });
  if (hasNotes || hasOrder) throw Object.assign(new Error(`Invoice ${invoiceNo} is linked to an order or note and cannot be reused.`), { statusCode: 409 });
  const oldJournal = await LedgerEntry.find({ tenantKey, financialYear, transactionId: invoiceNo })
    .select("status").lean();
  if (oldJournal.some((entry) => entry.status !== "REVERSED"))
    throw Object.assign(new Error(`Invoice ${invoiceNo} has unresolved journal entries. Reconcile it before reusing the number.`), { statusCode: 409 });
  // Changing transactionId on reversed journal rows and unsetting their old
  // deterministic postingKey ensures the strict ledger de-duplication rule still
  // works for the new voucher when its printed number is reused.
  const archiveNo = `VOID-${String(deleted._id)}`;
  const archived = await SalesInvoice.updateOne({ _id: deleted._id, tenantKey, financialYear, invoiceNo, status: "DELETED" }, {
    $set: { invoiceNo: archiveNo, voidedInvoiceNo: invoiceNo, voidedAt: new Date() },
  });
  if (archived.modifiedCount !== 1) throw Object.assign(new Error("Invoice number changed during reuse. Retry."), { statusCode: 409 });
  await LedgerEntry.updateMany({ tenantKey, financialYear, transactionId: invoiceNo, status: "REVERSED" },
    { $set: { transactionId: archiveNo }, $unset: { postingKey: "" } });
  await StockMovement.updateMany({ tenantKey, financialYear, referenceId: invoiceNo,
    type: { $in: ["SALE", "SALE_EDIT_REVERSAL", "SALE_DELETE_REVERSAL"] } },
    { $set: { referenceId: archiveNo } });
  return true;
}

router.post("/sales-invoices", async (req, res) => {
  try {
    const invoiceType = normalizedSalesInvoiceType(req.body.invoiceType);
    const requestedSourceOrderId = cleanText(req.body.sourceOrderId || "");
    if (invoiceType === "PERFORMA" && requestedSourceOrderId) {
      return fail(
        res,
        "A Sales Order can only generate an actual Invoice. Create a Performa as a direct document instead.",
        409,
      );
    }
    const calc = await calculateSalesInvoice({
      auth: req.auth,
      // A Performa is non-posting and must not consume the customer's credit
      // limit. Credit is checked again when it is converted to an actual invoice.
      body:
        invoiceType === "PERFORMA"
          ? { ...req.body, creditOverrideApproved: true }
          : req.body,
    });
    const importSource = upper(req.body.importSource || "");
    const preserveRequestedInvoiceNo = new Set([
      "SCAN_FILL",
      "QUICK_ENTRY",
    ]).has(importSource);
    const requestedInvoiceNo = cleanText(req.body.invoiceNo || "");
    const manualInvoiceNo =
      req.body.manualInvoiceNo === true ||
      String(req.body.manualInvoiceNo || "").toLowerCase() === "true";
    let series;
    if (invoiceType === "PERFORMA") {
      series = await performaInvoiceSeries(
        req.auth.tenantKey,
        calc.financialYear,
        { consume: true },
      );
    } else if (preserveRequestedInvoiceNo && requestedInvoiceNo) {
      // Import/scan flows already supply the complete printed invoice number.
      series = { invoiceNo: requestedInvoiceNo, manualInvoiceNo: true };
    } else if (manualInvoiceNo) {
      if (!requestedInvoiceNo)
        return fail(res, "Invoice Number is required", 400);

      if (!isRegisteredParty(calc.customer)) {
        // A normal unregistered sale must ALWAYS be PREFIX+C+SERIAL+SUFFIX.
        // Only explicit historical import flows may preserve printed legacy IDs.
        if (!/^\d+$/.test(requestedInvoiceNo))
          return fail(res, "Enter only the numeric serial. The C prefix and FY suffix are automatic for unregistered sales.", 400);
        const numericInput = true;
        const requestedFull = numericInput
          ? await cashInvoiceNumberFromSerial({
              tenantKey: calc.tenantKey,
              financialYear: calc.financialYear,
              serialText: requestedInvoiceNo,
            })
          : requestedInvoiceNo;
        const preview = await nextCashInvoiceNumber({
          tenantKey: calc.tenantKey,
          financialYear: calc.financialYear,
          customerGlobalId: calc.customer.globalCustomerId,
        });
        series =
          cleanText(preview) === cleanText(requestedFull)
            ? {
                invoiceNo: await allocateCashInvoiceNumber({
                  tenantKey: calc.tenantKey,
                  financialYear: calc.financialYear,
                  customerGlobalId: calc.customer.globalCustomerId,
                }),
                cashInvoice: true,
              }
            : {
                invoiceNo: requestedFull,
                manualInvoiceNo: true,
                manualSerial: numericInput ? Number(requestedInvoiceNo) : null,
                serialText: numericInput ? requestedInvoiceNo : "",
                cashInvoice: true,
              };
      } else {
        const requested = /^\d+$/.test(requestedInvoiceNo)
          ? await configuredSalesInvoiceNumberFromSerial(
              req.auth.tenantKey,
              requestedInvoiceNo,
              calc.financialYear,
            )
          : { invoiceNo: requestedInvoiceNo };
        const preview = await salesInvoiceSeries(req.auth.tenantKey, calc.financialYear);
        series =
          cleanText(preview.invoiceNo) === cleanText(requested.invoiceNo)
            ? await salesInvoiceSeries(req.auth.tenantKey, calc.financialYear, { consume: true })
            : {
                ...requested,
                manualInvoiceNo: true,
                manualSerial: Number.isFinite(requested.serial)
                  ? requested.serial
                  : null,
              };
      }
    } else if (!isRegisteredParty(calc.customer)) {
      series = {
        invoiceNo: await allocateCashInvoiceNumber({
          tenantKey: calc.tenantKey,
          financialYear: calc.financialYear,
          customerGlobalId: calc.customer.globalCustomerId,
        }),
        cashInvoice: true,
      };
    } else {
      series = await salesInvoiceSeries(req.auth.tenantKey, calc.financialYear, { consume: true });
    }
    const models = financialModels(calc.tenantKey, calc.financialYear);
    const { SalesInvoice, StockMovement, SalesOrder, OrderEvent } = models;
    // One last source-of-truth check: never save an unregistered actual invoice
    // under the registered series. Performa numbering is independent of GST type.
    const registeredSale = isRegisteredParty(calc.customer);
    const company = await CompanyProfile.findOne({ tenantKey: calc.tenantKey })
      .select("salesInvoicePrefix salesInvoiceSuffix").lean();
    const expectedPrefix = cleanText(company?.salesInvoicePrefix).replace(/\s+/g, "");
    const expectedSuffix = suffixForFinancialYear(company?.salesInvoiceSuffix, calc.financialYear)
      .replace(/[^0-9A-Za-z]/g, "");
    if (invoiceType === "INVOICE" && !registeredSale) {
      const expected = new RegExp(`^${escapeSalesRegex(expectedPrefix)}C\\d+${escapeSalesRegex(expectedSuffix)}$`, "i");
      if (!expected.test(series.invoiceNo))
        return fail(res, "An unregistered sale must have Prefix + C + Serial + FY suffix. Invoice was not saved.", 409);
    }
    // A deleted TEST invoice is archived (not erased), so its number can be
    // reused without colliding with the unique index or strict journal keys.
    if (invoiceType === "INVOICE" && !preserveRequestedInvoiceNo) {
      await releaseDeletedTestSalesNumber({
        tenantKey: calc.tenantKey,
        financialYear: calc.financialYear,
        invoiceNo: series.invoiceNo,
      });
    }
    if (
      await SalesInvoice.exists({
        tenantKey: calc.tenantKey,
        financialYear: calc.financialYear,
        invoiceNo: series.invoiceNo,
      })
    )
      return fail(
        res,
        invoiceType === "PERFORMA"
          ? `Performa invoice ${series.invoiceNo} already exists. Retry once to allocate the next number.`
          : preserveRequestedInvoiceNo || manualInvoiceNo
          ? `Sales invoice ${series.invoiceNo} already exists in FY ${calc.financialYear}`
          : "Generated invoice number already exists. Update the series in Super Admin Profile.",
        409,
      );

    // DIRECT billing remains independent. Only a sourceOrderId explicitly supplied by
    // the Order Desk enables order-linked stock reservation and lifecycle updates.
    if (requestedSourceOrderId && invoiceType !== "INVOICE") return fail(res,"Order billing supports Tax Invoice only",400);
    const sourceOrderId = requestedSourceOrderId;
    let sourceOrder = null;
    let sourceOrderItemMap = new Map();
    if (sourceOrderId) {
      sourceOrder = await SalesOrder.findOne({
        _id: sourceOrderId,
        tenantKey: calc.tenantKey,
        financialYear: calc.financialYear,
      });
      if (!sourceOrder)
        return fail(
          res,
          "Source sales order not found in this financial year",
          404,
        );
      if (
        String(sourceOrder.customerGlobalId) !==
        String(calc.customer.globalCustomerId)
      )
        return fail(
          res,
          "Invoice customer does not match the sales order customer",
          409,
        );
      if (
        !["PACKED", "SENT_TO_ORDER_DESK", "INVOICED_PARTIAL"].includes(
          upper(sourceOrder.workflowStatus),
        )
      )
        return fail(
          res,
          `Order ${sourceOrder.orderNo} is not ready for invoicing`,
          409,
        );
      sourceOrderItemMap = new Map(
        (sourceOrder.items || []).map((x) => [String(x.productId), x]),
      );
      // Order Desk produces one complete invoice, not a partial or duplicate bill.
      if(new Set(calc.items.map(x=>String(x.productId))).size!==calc.items.length)
        return fail(res,"Order invoice cannot contain duplicate product lines",409);
      if(calc.items.length!==sourceOrderItemMap.size)
        return fail(res,"Invoice must contain every packed product in the Sales Order",409);
      if((sourceOrder.items||[]).some(x=>Number(x.invoicedQty||0)>0))
        return fail(res,"This order is already invoiced; duplicate invoicing is not allowed",409);
      for (const it of calc.items) {
        const oi = sourceOrderItemMap.get(String(it.productId));
        if (!oi)
          return fail(
            res,
            `${it.nameSnapshot || it.sku || "Product"} is not part of order ${sourceOrder.orderNo}`,
            409,
          );
        const available = Math.max(
          0,
          Number(oi.packedQty || 0) - Number(oi.invoicedQty || 0),
        );
        if(Math.abs(Number(it.qty||0)-Number(oi.packedQty||0))>0.000001 || Math.abs(available-Number(oi.packedQty||0))>0.000001)
          return fail(res,`${it.nameSnapshot||it.sku||"Product"}: invoice must include all ${oi.packedQty} packed units. Shortage/damage remains on the order.`,409);
        if (Number(it.qty || 0) > available + 0.000001)
          return fail(
            res,
            `${it.nameSnapshot || it.sku || "Product"}: invoice quantity ${it.qty} exceeds newly packed quantity ${available}`,
            409,
          );
      }
    }

    const invoice = await SalesInvoice.create({
      tenantKey: calc.tenantKey,
      financialYear: calc.financialYear,
      invoiceNo: series.invoiceNo,
      invoiceType,
      performaSerial:
        invoiceType === "PERFORMA" ? Number(series.serial || 0) : undefined,
      date: calc.date,
      customerGlobalId: calc.customer.globalCustomerId,
      customerNameSnapshot:
        calc.customer.localName ||
        calc.customer.displayIdentifier ||
        "Customer",
      gstinSnapshot:
        isRegisteredParty(calc.customer) && calc.customer.displayIdentifier?.length === 15
          ? calc.customer.displayIdentifier
          : "",
      addressSnapshot: calc.customerAddress?.address || "",
      items: calc.items,
      subtotal: calc.lineSubtotal,
      billDiscount: Number(req.body.billDiscount || 0),
      otherCharges: Number(req.body.otherCharges || 0),
      taxableTotal: calc.taxableTotal,
      taxTotal: calc.taxTotal,
      roundOff: calc.roundOff,
      grandTotal: calc.grandTotal,
      grossProfit: calc.grossProfit,
      grossMarginPct: calc.taxableTotal
        ? (calc.grossProfit / calc.taxableTotal) * 100
        : 0,
      creditNoteAmount: 0,
      netInvoiceAmount: calc.grandTotal,
      creditNoteStatus: "NONE",
      billingMode: sourceOrder ? "ORDER" : "DIRECT",
      sourceOrderId: sourceOrder ? String(sourceOrder._id) : "",
      orderNo: sourceOrder?.orderNo || req.body.orderNo,
      arn: req.body.arn,
      noOfPackages: Number(
        req.body.noOfPackages || sourceOrder?.packing?.packageCount || 0,
      ),
      deliveryBoy: req.body.deliveryBoy,
      gstType: calc.gstType,
      remarks: req.body.remarks,
      eInvoice:
        invoiceType === "PERFORMA"
          ? normalizedEInvoice({ eInvoice: { status: "NOT_GENERATED" } })
          : normalizedEInvoice(req.body),
      transportAssignment: calc.transportAssignment,
      branchId: req.body.branchId || req.auth.branch || "",
      warehouseId: calc.warehouseId,
      warehouseNameSnapshot:
        calc.warehouse.title || calc.warehouse.reference || "",
      assignedTo: req.body.assignedTo || "",
      // Order Desk posting creates a normal POSTED sales invoice. The linked
      // Sales Order separately moves to INVOICED; delivery is completed later
      // from the existing Mark Delivered action on the Sales Invoice page.
      workflowStatus:
        invoiceType === "PERFORMA"
          ? "PERFORMA"
          : req.body.workflowStatus || "POSTED",
      releasedToWarehouseAt:
        invoiceType === "INVOICE" && req.body.workflowStatus === "RELEASED_TO_WAREHOUSE"
          ? new Date()
          : undefined,
      status: invoiceType === "PERFORMA" ? "PERFORMA" : "POSTED",
      createdBy: req.auth.sub,
      createdByNameSnapshot: req.auth.name || "",
    });

    // Performa invoices are intentionally non-posting documents: no stock
    // movement, no ledger/customer receivable, no order lifecycle movement.
    if (invoiceType === "PERFORMA") {
      return ok(
        res,
        salesInvoiceForAuth(invoice, req.auth),
        `Performa invoice ${invoice.invoiceNo} created`,
        201,
      );
    }

    // Regular Sales Invoice sequencing is derived from invoices already saved in
    // calc.financialYear. Do not update the legacy global CompanyProfile counter;
    // otherwise an old FY could leak its sequence into a new FY.

    for (const it of calc.items) {
      // Order invoices are ledger debits but remain PHYSICALLY PENDING.
      // Do not decrement Product.currentStock, Product.reservedStock or create
      // outward movement until the Delivery Boy confirms delivery.
      if (!sourceOrder) {
        await Product.updateOne({ _id: it.productId, tenantKey: calc.tenantKey }, { $inc: { currentStock: -it.qty } });
        await StockMovement.create({
          tenantKey: calc.tenantKey, financialYear: calc.financialYear, date: calc.date,
          productId: it.productId, warehouseId: calc.warehouseId, type: "SALE",
          qtyIn: 0, qtyOut: it.qty, landedCost: it.landedCostSnapshot,
          referenceId: series.invoiceNo,
        });
      }
    }
    await postSalesAccounting({ ...calc, invoiceNo: series.invoiceNo });

    if (sourceOrder) {
      const invMap = new Map(
        calc.items.map((x) => [String(x.productId), Number(x.qty || 0)]),
      );
      for (const oi of sourceOrder.items || []) {
        const used = Number(invMap.get(String(oi.productId)) || 0);
        if (used) {
          oi.invoicedQty = Number(oi.invoicedQty || 0) + used;
          // Remain reserved until verified delivery (not while merely invoiced).
        }
      }
      sourceOrder.invoice = {
        invoiceId: String(invoice._id),
        invoiceNo: invoice.invoiceNo,
        invoiceDate: invoice.date,
      };
      sourceOrder.invoices = [
        ...(sourceOrder.invoices || []),
        {
          invoiceId: String(invoice._id),
          invoiceNo: invoice.invoiceNo,
          invoiceDate: invoice.date,
          grandTotal: invoice.grandTotal,
        },
      ];
      // A single full invoice covers the entire physically packed quantity.
      // Reported shortages stay recorded rather than being falsely invoiced.
      const complete = (sourceOrder.items || []).every(
        (x) => Number(x.invoicedQty || 0) >= Number(x.packedQty || 0) - 0.000001,
      );
      const packedConsumed = (sourceOrder.items || []).every(
        (x) =>
          Number(x.invoicedQty || 0) >= Number(x.packedQty || 0) - 0.000001,
      );
      sourceOrder.workflowStatus = complete ? "INVOICED" : "INVOICED_PARTIAL";
      sourceOrder.status = "PROCESSING";
      sourceOrder.lastWorkflowAt = new Date();
      sourceOrder.nextAction = complete
        ? "Assign Delivery Boy in Main Warehouse"
        : packedConsumed
          ? "Pack / invoice remaining quantity"
          : "Invoice remaining packed quantity";
      await sourceOrder.save();
      if (OrderEvent) {
        await OrderEvent.create({
          tenantKey: calc.tenantKey,
          financialYear: calc.financialYear,
          eventNo: makeId("EVT"),
          orderId: String(sourceOrder._id),
          orderNo: sourceOrder.orderNo,
          invoiceId: String(invoice._id),
          invoiceNo: invoice.invoiceNo,
          type: "INVOICE_GENERATED",
          fromStatus: "SENT_TO_ORDER_DESK",
          toStatus: sourceOrder.workflowStatus,
          note: `Invoice ${invoice.invoiceNo} generated from actual packed quantity`,
          meta: { grandTotal: invoice.grandTotal },
          audience: ["DMS", "CUSTOMER", "SALESPERSON"],
          actorId: req.auth.sub,
          actorNameSnapshot: req.auth.name || "",
          actorRole: req.auth.role || "",
          occurredAt: new Date(),
        });
      }
    }
    return ok(
      res,
      salesInvoiceForAuth(invoice, req.auth),
      sourceOrder
        ? `Sales invoice ${invoice.invoiceNo} generated from order ${sourceOrder.orderNo}`
        : "Sales invoice posted",
      201,
    );
  } catch (e) {
    return fail(res, e.message, e.statusCode || 400, e.details);
  }
});

router.put("/sales-invoices/:id", requireObjectIdParam, async (req, res) => {
  const requestedInvoiceType = normalizedSalesInvoiceType(
    req.body.invoiceType || req.query.invoiceType,
  );
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested:
        req.body.sourceFinancialYear ||
        req.query.financialYear ||
        req.body.financialYear,
    }),
    models = financialModels(req.auth.tenantKey, financialYear);

  const existingFilter = {
    _id: req.params.id,
    tenantKey: req.auth.tenantKey,
    financialYear,
    status: requestedInvoiceType === "PERFORMA" ? "PERFORMA" : "POSTED",
  };
  applySalesInvoiceTypeFilter(existingFilter, requestedInvoiceType);
  const existing = await models.SalesInvoice.findOne(existingFilter);
  if (!existing)
    return fail(
      res,
      requestedInvoiceType === "PERFORMA"
        ? "Active Performa invoice not found"
        : "Posted sales invoice not found",
      404,
    );

  // A Performa is editable but deliberately non-posting. Do not reverse or
  // re-post stock/accounting while its commercial details are being changed.
  if (requestedInvoiceType === "PERFORMA") {
    try {
      const calc = await calculateSalesInvoice({
        auth: req.auth,
        body: { ...req.body, invoiceType: "PERFORMA", creditOverrideApproved: true },
      });
      if (calc.financialYear !== financialYear)
        return fail(
          res,
          `The selected date belongs to FY ${calc.financialYear}. An existing Performa cannot be moved across financial-year databases. Delete/recreate it with the new date.`,
          409,
        );

      existing.invoiceType = "PERFORMA";
      existing.date = calc.date;
      existing.customerGlobalId = calc.customer.globalCustomerId;
      existing.customerNameSnapshot =
        calc.customer.localName || calc.customer.displayIdentifier || "Customer";
      existing.gstinSnapshot =
        isRegisteredParty(calc.customer) && calc.customer.displayIdentifier?.length === 15
          ? calc.customer.displayIdentifier
          : "";
      existing.addressSnapshot =
        req.body.addressSnapshot || calc.customerAddress?.address || "";
      existing.items = calc.items;
      existing.subtotal = calc.lineSubtotal;
      existing.billDiscount = Number(req.body.billDiscount || 0);
      existing.otherCharges = Number(req.body.otherCharges || 0);
      existing.taxableTotal = calc.taxableTotal;
      existing.taxTotal = calc.taxTotal;
      existing.roundOff = calc.roundOff;
      existing.grandTotal = calc.grandTotal;
      existing.creditNoteAmount = 0;
      existing.netInvoiceAmount = calc.grandTotal;
      existing.creditNoteStatus = "NONE";
      existing.grossProfit = calc.grossProfit;
      existing.grossMarginPct = calc.taxableTotal
        ? (calc.grossProfit / calc.taxableTotal) * 100
        : 0;
      existing.orderNo = req.body.orderNo;
      existing.arn = req.body.arn;
      existing.noOfPackages = Number(req.body.noOfPackages || 0);
      existing.deliveryBoy = req.body.deliveryBoy;
      existing.gstType = calc.gstType;
      existing.remarks = req.body.remarks;
      existing.eInvoice = normalizedEInvoice({ eInvoice: { status: "NOT_GENERATED" } });
      existing.transportAssignment = calc.transportAssignment;
      existing.branchId =
        req.body.branchId || existing.branchId || req.auth.branch || "";
      existing.warehouseId = calc.warehouseId;
      existing.warehouseNameSnapshot =
        calc.warehouse.title || calc.warehouse.reference || "";
      existing.assignedTo = req.body.assignedTo || existing.assignedTo || "";
      existing.workflowStatus = "PERFORMA";
      existing.status = "PERFORMA";
      await existing.save();
      return ok(
        res,
        salesInvoiceForAuth(existing, req.auth),
        `Performa invoice ${existing.invoiceNo} updated`,
      );
    } catch (e) {
      return fail(res, e.message, e.statusCode || 400, e.details);
    }
  }

  const issuedCreditNote = await models.CreditNote.findOne({
    tenantKey: req.auth.tenantKey,
    financialYear,
    status: "ISSUED",
    $and: [
      {
        $or: [
          { documentType: "CREDIT_NOTE" },
          { documentType: { $exists: false } },
        ],
      },
      {
        $or: [
          { invoiceId: String(existing._id) },
          { referenceDocumentId: String(existing._id) },
        ],
      },
    ],
  })
    .select("creditNoteNo")
    .lean();
  if (issuedCreditNote)
    return fail(
      res,
      `Sales Invoice has issued Credit Note ${issuedCreditNote.creditNoteNo}. Cancel the Credit Note before editing the original invoice.`,
      409,
      {
        code: "INVOICE_HAS_CREDIT_NOTE",
        creditNoteNo: issuedCreditNote.creditNoteNo,
      },
    );
  try {
    const calc = await calculateSalesInvoice({
      auth: req.auth,
      body: req.body,
      existingInvoice: existing.toObject(),
    });
    if (calc.financialYear !== financialYear)
      return fail(
        res,
        `The selected date belongs to FY ${calc.financialYear}. An existing invoice cannot be moved across financial-year databases. Delete/recreate it with the new date.`,
        409,
      );
    const originalInvoiceNo = cleanText(existing.invoiceNo || "");
    const requestedInvoiceNo = cleanText(
      req.body.invoiceNo || originalInvoiceNo,
    );
    if (!requestedInvoiceNo)
      return fail(res, "Invoice Number is required", 400);
    if (requestedInvoiceNo !== originalInvoiceNo) {
      const duplicate = await models.SalesInvoice.exists({
        _id: { $ne: existing._id },
        tenantKey: req.auth.tenantKey,
        financialYear,
        invoiceNo: requestedInvoiceNo,
      });
      if (duplicate)
        return fail(
          res,
          `Sales invoice ${requestedInvoiceNo} already exists in FY ${financialYear}`,
          409,
        );
    }
    await reversePostedTransaction({
      tenantKey: req.auth.tenantKey,
      financialYear,
      transactionId: originalInvoiceNo,
      reason: "Sales invoice edited",
    });
    for (const it of existing.items || []) {
      await Product.updateOne(
        { _id: it.productId, tenantKey: req.auth.tenantKey },
        { $inc: { currentStock: Number(it.qty || 0) } },
      );
      await models.StockMovement.create({
        tenantKey: req.auth.tenantKey,
        financialYear,
        date: new Date(),
        productId: String(it.productId),
        warehouseId: existing.warehouseId || "",
        type: "SALE_EDIT_REVERSAL",
        qtyIn: Number(it.qty || 0),
        qtyOut: 0,
        landedCost: Number(it.landedCostSnapshot || 0),
        referenceId: originalInvoiceNo,
      });
    }
    existing.invoiceType = "INVOICE";
    existing.invoiceNo = requestedInvoiceNo;
    existing.date = calc.date;
    existing.customerGlobalId = calc.customer.globalCustomerId;
    existing.customerNameSnapshot = calc.customer.localName;
    existing.gstinSnapshot =
      isRegisteredParty(calc.customer) && calc.customer.displayIdentifier?.length === 15
        ? calc.customer.displayIdentifier
        : "";
    existing.addressSnapshot =
      req.body.addressSnapshot || calc.customer.addresses?.[0]?.address || "";
    existing.items = calc.items;
    existing.subtotal = calc.lineSubtotal;
    existing.billDiscount = Number(req.body.billDiscount || 0);
    existing.otherCharges = Number(req.body.otherCharges || 0);
    existing.taxableTotal = calc.taxableTotal;
    existing.taxTotal = calc.taxTotal;
    existing.roundOff = calc.roundOff;
    existing.grandTotal = calc.grandTotal;
    existing.creditNoteAmount = 0;
    existing.netInvoiceAmount = calc.grandTotal;
    existing.creditNoteStatus = "NONE";
    existing.grossProfit = calc.grossProfit;
    existing.grossMarginPct = calc.taxableTotal
      ? (calc.grossProfit / calc.taxableTotal) * 100
      : 0;
    existing.orderNo = req.body.orderNo;
    existing.arn = req.body.arn;
    existing.noOfPackages = Number(req.body.noOfPackages || 0);
    existing.deliveryBoy = req.body.deliveryBoy;
    existing.gstType = calc.gstType;
    existing.remarks = req.body.remarks;
    existing.eInvoice = normalizedEInvoice(req.body, existing.eInvoice || {});
    existing.transportAssignment = calc.transportAssignment;
    existing.branchId =
      req.body.branchId || existing.branchId || req.auth.branch || "";
    existing.warehouseId = calc.warehouseId;
    existing.warehouseNameSnapshot =
      calc.warehouse.title || calc.warehouse.reference || "";
    existing.assignedTo = req.body.assignedTo || existing.assignedTo || "";
    existing.workflowStatus =
      req.body.workflowStatus || existing.workflowStatus || "POSTED";
    existing.status = "POSTED";
    await existing.save();
    for (const it of calc.items) {
      await Product.updateOne(
        { _id: it.productId, tenantKey: req.auth.tenantKey },
        { $inc: { currentStock: -it.qty } },
      );
      await models.StockMovement.create({
        tenantKey: req.auth.tenantKey,
        financialYear,
        date: calc.date,
        productId: it.productId,
        warehouseId: calc.warehouseId,
        type: "SALE",
        qtyIn: 0,
        qtyOut: it.qty,
        landedCost: it.landedCostSnapshot,
        referenceId: existing.invoiceNo,
      });
    }
    await postSalesAccounting({ ...calc, invoiceNo: existing.invoiceNo });
    return ok(
      res,
      salesInvoiceForAuth(existing, req.auth),
      "Sales invoice updated",
    );
  } catch (e) {
    return fail(res, e.message, e.statusCode || 400, e.details);
  }
});

router.post(
  "/sales-invoices/:id/convert-to-invoice",
  requireObjectIdParam,
  async (req, res) => {
    const sourceFinancialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested:
        req.body.sourceFinancialYear ||
        req.query.financialYear ||
        req.body.financialYear,
    });
    const sourceModels = financialModels(req.auth.tenantKey, sourceFinancialYear);

    let performa = null;
    let createdInvoice = null;
    let targetModels = null;
    const stockApplied = [];

    try {
      // Claim the Performa before doing any posting work so a double click cannot
      // generate two actual invoices from the same source document.
      performa = await sourceModels.SalesInvoice.findOneAndUpdate(
        {
          _id: req.params.id,
          tenantKey: req.auth.tenantKey,
          financialYear: sourceFinancialYear,
          invoiceType: "PERFORMA",
          status: "PERFORMA",
        },
        {
          $set: {
            status: "CONVERTING",
            workflowStatus: "CONVERTING",
          },
        },
        { new: true },
      );
      if (!performa) {
        const previous = await sourceModels.SalesInvoice.findOne({
          _id: req.params.id,
          tenantKey: req.auth.tenantKey,
          financialYear: sourceFinancialYear,
          invoiceType: "PERFORMA",
        })
          .select("status convertedInvoiceNo")
          .lean();
        if (previous?.status === "CONVERTED")
          return fail(
            res,
            `This Performa is already converted to Invoice ${previous.convertedInvoiceNo || ""}`.trim(),
            409,
          );
        return fail(res, "Active Performa invoice not found", 404);
      }

      const invoiceDate =
        req.body.invoiceDate || req.body.date || new Date().toISOString();
      const items = (performa.items || []).map((it) => {
        const discountPct = Number(it.discountPct || 0);
        const divisor = 1 - discountPct / 100;
        const basicRate =
          divisor > 0.000001
            ? Number(it.effectiveRate || 0) / divisor
            : basicFromSaleGst(it.rate, it.gstRateSnapshot);
        return {
          productId: String(it.productId || ""),
          qty: Number(it.qty || 0),
          mrp: Number(it.mrpSnapshot || 0),
          saleRate: Number(it.rate || 0),
          basicRate,
          discountPct,
          gstRate: Number(it.gstRateSnapshot || 0),
        };
      });
      const calcBody = {
        date: invoiceDate,
        customerGlobalId: performa.customerGlobalId,
        warehouseId: performa.warehouseId,
        transporterId: performa.transportAssignment?.transporterId || "",
        gstType: performa.gstType,
        billDiscount: Number(performa.billDiscount || 0),
        otherCharges: Number(performa.otherCharges || 0),
        orderNo: performa.orderNo,
        arn: performa.arn,
        noOfPackages: Number(performa.noOfPackages || 0),
        deliveryBoy: performa.deliveryBoy,
        remarks: performa.remarks,
        branchId: performa.branchId,
        assignedTo: performa.assignedTo,
        items,
      };
      // This is the point at which a quote becomes a real sale. Re-check stock,
      // live customer grade pricing and credit rules using the normal invoice engine.
      const calc = await calculateSalesInvoice({ auth: req.auth, body: calcBody });
      let series;
      if (!isRegisteredParty(calc.customer)) {
        series = {
          invoiceNo: await allocateCashInvoiceNumber({
            tenantKey: calc.tenantKey,
            financialYear: calc.financialYear,
            customerGlobalId: calc.customer.globalCustomerId,
          }),
          cashInvoice: true,
        };
      } else {
        series = await salesInvoiceSeries(
          req.auth.tenantKey,
          calc.financialYear,
          { consume: true },
        );
      }

      targetModels = financialModels(calc.tenantKey, calc.financialYear);
      if (
        await targetModels.SalesInvoice.exists({
          tenantKey: calc.tenantKey,
          financialYear: calc.financialYear,
          invoiceNo: series.invoiceNo,
        })
      )
        throw Object.assign(
          new Error(
            `Generated sales invoice ${series.invoiceNo} already exists. Retry conversion once.`,
          ),
          { statusCode: 409 },
        );

      createdInvoice = await targetModels.SalesInvoice.create({
        tenantKey: calc.tenantKey,
        financialYear: calc.financialYear,
        invoiceNo: series.invoiceNo,
        invoiceType: "INVOICE",
        sourcePerformaId: String(performa._id),
        sourcePerformaNo: performa.invoiceNo,
        date: calc.date,
        customerGlobalId: calc.customer.globalCustomerId,
        customerNameSnapshot:
          calc.customer.localName || calc.customer.displayIdentifier || "Customer",
        gstinSnapshot:
          isRegisteredParty(calc.customer) && calc.customer.displayIdentifier?.length === 15
            ? calc.customer.displayIdentifier
            : "",
        addressSnapshot: calc.customerAddress?.address || performa.addressSnapshot || "",
        items: calc.items,
        subtotal: calc.lineSubtotal,
        billDiscount: Number(performa.billDiscount || 0),
        otherCharges: Number(performa.otherCharges || 0),
        taxableTotal: calc.taxableTotal,
        taxTotal: calc.taxTotal,
        roundOff: calc.roundOff,
        grandTotal: calc.grandTotal,
        grossProfit: calc.grossProfit,
        grossMarginPct: calc.taxableTotal
          ? (calc.grossProfit / calc.taxableTotal) * 100
          : 0,
        creditNoteAmount: 0,
        netInvoiceAmount: calc.grandTotal,
        creditNoteStatus: "NONE",
        billingMode: "DIRECT",
        sourceOrderId: "",
        orderNo: performa.orderNo,
        arn: performa.arn,
        noOfPackages: Number(performa.noOfPackages || 0),
        deliveryBoy: performa.deliveryBoy,
        gstType: calc.gstType,
        remarks: performa.remarks,
        eInvoice: normalizedEInvoice({ eInvoice: { status: "NOT_GENERATED" } }),
        transportAssignment: calc.transportAssignment,
        branchId: performa.branchId || req.auth.branch || "",
        warehouseId: calc.warehouseId,
        warehouseNameSnapshot:
          calc.warehouse.title || calc.warehouse.reference || "",
        assignedTo: performa.assignedTo || "",
        workflowStatus: "POSTED",
        status: "POSTED",
        createdBy: req.auth.sub,
        createdByNameSnapshot: req.auth.name || "",
      });

      for (const it of calc.items) {
        await Product.updateOne(
          { _id: it.productId, tenantKey: calc.tenantKey },
          { $inc: { currentStock: -Number(it.qty || 0) } },
        );
        stockApplied.push({ productId: it.productId, qty: Number(it.qty || 0) });
        await targetModels.StockMovement.create({
          tenantKey: calc.tenantKey,
          financialYear: calc.financialYear,
          date: calc.date,
          productId: it.productId,
          warehouseId: calc.warehouseId,
          type: "SALE",
          qtyIn: 0,
          qtyOut: Number(it.qty || 0),
          landedCost: Number(it.landedCostSnapshot || 0),
          referenceId: createdInvoice.invoiceNo,
        });
      }
      await postSalesAccounting({ ...calc, invoiceNo: createdInvoice.invoiceNo });

      performa.status = "CONVERTED";
      performa.workflowStatus = "CONVERTED";
      performa.convertedInvoiceId = String(createdInvoice._id);
      performa.convertedInvoiceNo = createdInvoice.invoiceNo;
      performa.convertedAt = new Date();
      performa.convertedBy = req.auth.sub;
      performa.convertedByNameSnapshot = req.auth.name || "";
      await performa.save();

      return ok(
        res,
        salesInvoiceForAuth(createdInvoice, req.auth),
        `${performa.invoiceNo} converted to Sales Invoice ${createdInvoice.invoiceNo}`,
        201,
      );
    } catch (e) {
      // Roll back anything applied after the source Performa was claimed. This
      // keeps a failed conversion retryable and prevents stock from drifting.
      if (createdInvoice && targetModels) {
        try {
          await reversePostedTransaction({
            tenantKey: req.auth.tenantKey,
            financialYear: createdInvoice.financialYear,
            transactionId: createdInvoice.invoiceNo,
            reason: "Performa conversion rolled back",
          });
        } catch {}
        try {
          await targetModels.StockMovement.deleteMany({
            tenantKey: req.auth.tenantKey,
            financialYear: createdInvoice.financialYear,
            referenceId: createdInvoice.invoiceNo,
            type: "SALE",
          });
        } catch {}
        for (const row of stockApplied) {
          try {
            await Product.updateOne(
              { _id: row.productId, tenantKey: req.auth.tenantKey },
              { $inc: { currentStock: Number(row.qty || 0) } },
            );
          } catch {}
        }
        try {
          await targetModels.SalesInvoice.deleteOne({
            _id: createdInvoice._id,
            tenantKey: req.auth.tenantKey,
          });
        } catch {}
      }
      if (performa) {
        try {
          await sourceModels.SalesInvoice.updateOne(
            {
              _id: performa._id,
              tenantKey: req.auth.tenantKey,
              status: "CONVERTING",
            },
            { $set: { status: "PERFORMA", workflowStatus: "PERFORMA" } },
          );
        } catch {}
      }
      return fail(res, e.message, e.statusCode || 400, e.details);
    }
  },
);

router.delete("/sales-invoices/:id", requireObjectIdParam, async (req, res) => {
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.body?.financialYear || req.query.financialYear,
    }),
    models = financialModels(req.auth.tenantKey, financialYear);
  const invoice = await models.SalesInvoice.findOne({
    _id: req.params.id,
    tenantKey: req.auth.tenantKey,
    financialYear,
  });
  if (!invoice) return fail(res, "Sales invoice not found", 404);

  // Performa rows never post stock or accounting, so a hard delete only needs
  // to remove the source document. A converted actual Invoice is a separate row.
  if (normalizedSalesInvoiceType(invoice.invoiceType) === "PERFORMA") {
    const invoiceNo = invoice.invoiceNo;
    const id = String(invoice._id);
    await models.SalesInvoice.deleteOne({
      _id: invoice._id,
      tenantKey: req.auth.tenantKey,
      financialYear,
    });
    return ok(
      res,
      { _id: id, invoiceNo, deleted: true, hardDeleted: true },
      `Performa invoice ${invoiceNo} permanently deleted from database`,
    );
  }

  // Old builds used soft delete. If one of those legacy DELETED/CANCELLED rows is
  // deleted again, physically remove it without running stock/account reversal twice.
  if (invoice.status === "DELETED" || invoice.status === "CANCELLED") {
    const invoiceNo = invoice.invoiceNo;
    const id = String(invoice._id);
    await models.SalesInvoice.deleteOne({ _id: invoice._id, tenantKey: req.auth.tenantKey, financialYear });
    return ok(res, { _id: id, invoiceNo, deleted: true, hardDeleted: true }, "Sales invoice permanently deleted from database");
  }

  const issuedCreditNote = await models.CreditNote.findOne({
    tenantKey: req.auth.tenantKey,
    financialYear,
    status: "ISSUED",
    $and: [
      {
        $or: [
          { documentType: "CREDIT_NOTE" },
          { documentType: { $exists: false } },
        ],
      },
      {
        $or: [
          { invoiceId: String(invoice._id) },
          { referenceDocumentId: String(invoice._id) },
        ],
      },
    ],
  })
    .select("creditNoteNo")
    .lean();
  if (issuedCreditNote)
    return fail(
      res,
      `Sales Invoice has issued Credit Note ${issuedCreditNote.creditNoteNo}. Cancel the Credit Note before deleting the original invoice.`,
      409,
      {
        code: "INVOICE_HAS_CREDIT_NOTE",
        creditNoteNo: issuedCreditNote.creditNoteNo,
      },
    );

  await reversePostedTransaction({
    tenantKey: req.auth.tenantKey,
    financialYear,
    transactionId: invoice.invoiceNo,
    reason: "Sales invoice permanently deleted",
  });
  for (const it of invoice.items || []) {
    await Product.updateOne(
      { _id: it.productId, tenantKey: req.auth.tenantKey },
      { $inc: { currentStock: Number(it.qty || 0) } },
    );
    await models.StockMovement.create({
      tenantKey: req.auth.tenantKey,
      financialYear,
      date: new Date(),
      productId: String(it.productId),
      warehouseId: invoice.warehouseId || "",
      type: "SALE_DELETE_REVERSAL",
      qtyIn: Number(it.qty || 0),
      qtyOut: 0,
      landedCost: Number(it.landedCostSnapshot || 0),
      referenceId: invoice.invoiceNo,
    });
  }

  const deletedPayload = {
    _id: String(invoice._id),
    invoiceNo: invoice.invoiceNo,
    deleted: true,
    hardDeleted: true,
  };
  await models.SalesInvoice.deleteOne({
    _id: invoice._id,
    tenantKey: req.auth.tenantKey,
    financialYear,
  });
  return ok(
    res,
    deletedPayload,
    "Sales invoice permanently deleted; stock restored and accounting reversed",
  );
});

const safeFilePart = (value) =>
  String(value || "file")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .slice(0, 90);
const safeDownloadFilePart = (value, fallback = "file") => {
  const cleaned = String(value || fallback)
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim();
  return (cleaned || fallback).slice(0, 90);
};
const invoicePdfFileName = (invoice = {}, fallbackId = "Invoice") =>
  `${safeDownloadFilePart(invoice.customerNameSnapshot || "Customer", "Customer")}-${safeDownloadFilePart(invoice.invoiceNo || fallbackId, "Invoice")}.pdf`;
const escapeEmailHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");
const emailMoney = (value) => Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const customerEmailOf = (customer) => {
  const contacts = Array.isArray(customer?.contacts) ? customer.contacts : [];
  return String(
    contacts.find((row) => row.primary && row.email)?.email ||
      contacts.find((row) => row.email)?.email ||
      "",
  ).trim();
};

async function storeDeliveryFiles({ tenantKey, invoiceNo, files = [] }) {
  if (!files.length) return [];
  const root = path.resolve(
    env.storageRoot || "../storage",
    safeFilePart(tenantKey),
    "delivery-proofs",
    safeFilePart(invoiceNo),
  );
  await fs.mkdir(root, { recursive: true });
  const saved = [];
  for (const entry of files) {
    if (!entry?.file?.buffer) continue;
    const ext =
      path.extname(entry.file.originalname || "") ||
      (entry.file.mimetype === "application/pdf" ? ".pdf" : "");
    const storedName = `${entry.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`;
    const absolute = path.join(root, storedName);
    await fs.writeFile(absolute, entry.file.buffer);
    saved.push({
      kind: entry.kind,
      fileName: entry.file.originalname || storedName,
      storedName,
      path: absolute,
      mimeType: entry.file.mimetype || "application/octet-stream",
      size: Number(entry.file.size || entry.file.buffer.length || 0),
    });
  }
  return saved;
}

async function invoicePrintContext({
  tenantKey,
  financialYear,
  invoice,
  customer = null,
}) {
  const resolvedCustomer =
    customer ||
    (await CustomerLink.findOne({
      tenantKey,
      globalCustomerId: invoice.customerGlobalId,
    }).lean());
  const [company, bank, ledgerSigned, lastPayment, branding] =
    await Promise.all([
      CompanyProfile.findOne({ tenantKey }).lean(),
      BankAccount.findOne({ tenantKey, status: "ACTIVE", isPrimary: true })
        .lean()
        .then(async (row) => {
          if (row) return row;
          const activeCount = await BankAccount.countDocuments({
            tenantKey,
            status: "ACTIVE",
          });
          return activeCount === 1
            ? BankAccount.findOne({ tenantKey, status: "ACTIVE" }).lean()
            : null;
        }),
      customerReceivableBalance({
        tenantKey,
        financialYear,
        customerGlobalId: invoice.customerGlobalId,
      }).catch(() => null),
      financialModels(tenantKey, financialYear)
        .Receipt.findOne({
          tenantKey,
          financialYear,
          customerGlobalId: invoice.customerGlobalId,
          status: "POSTED",
        })
        .sort({ date: -1, createdAt: -1 })
        .select("date amount")
        .lean()
        .catch(() => null),
      Branding.findOne({ key: "GLOBAL" })
        .lean()
        .catch(() => null),
    ]);

  const readOptional = async (fileId) => {
    if (!fileId) return null;
    try {
      return (await readFile(fileId))?.buffer || null;
    } catch {
      return null;
    }
  };
  const [companyLogo, signature, appLogo] = await Promise.all([
    readOptional(company?.logoFileId),
    readOptional(company?.signatureFileId),
    readOptional(branding?.masterLogoFileId),
  ]);

  return {
    company,
    customer: resolvedCustomer,
    bank,
    ledgerSigned,
    lastPayment,
    companyLogo,
    signature,
    appLogo,
  };
}

async function buildInvoicePdfBuffer({
  tenantKey,
  financialYear,
  invoice,
  customer = null,
}) {
  const context = await invoicePrintContext({
    tenantKey,
    financialYear,
    invoice,
    customer,
  });
  return buildMasterSalesInvoicePdf({ invoice, ...context });
}

async function sendInvoiceThroughConfiguredMailbox({ tenantKey, to, subject, text, html, attachments = [] }) {
  const smartAttachments = attachments.map((item) => ({
    filename: item.filename,
    content: item.content,
    mimeType: item.mimeType || item.contentType || "application/octet-stream",
  }));
  try {
    await sendCompanyMail({
      database: tenantKey,
      to: [to],
      subject,
      text,
      html,
      attachments: smartAttachments,
    });
    return { provider: "COMPANY_MAIL" };
  } catch (error) {
    // Backward compatibility: companies that have not yet connected their own
    // mailbox may still use the existing environment SMTP configuration.
    if (error?.code !== "MAIL_NOT_CONNECTED") throw error;
    try {
      await sendBusinessEmail({
        to,
        subject,
        text,
        html,
        attachments: smartAttachments.map((item) => ({
          filename: item.filename,
          content: item.content,
          contentType: item.mimeType,
        })),
      });
      return { provider: "LEGACY_SMTP" };
    } catch (legacyError) {
      const wrapped = new Error(
        `Company email is not connected. Add the Superadmin App Password in Profile or connect Email & Communication. ${legacyError?.message || ""}`.trim(),
      );
      wrapped.code = "MAIL_NOT_CONNECTED";
      throw wrapped;
    }
  }
}

async function emailSalesInvoice({
  tenantKey,
  financialYear,
  invoice,
  customer,
  uploadedFiles = [],
  delivered = false,
}) {
  const to = customerEmailOf(customer);
  if (!to)
    return {
      status: "NO_EMAIL",
      to: "",
      error: "Customer email is not available",
    };

  const pdf = await buildInvoicePdfBuffer({
    tenantKey,
    financialYear,
    invoice,
    customer,
  });
  const attachments = [
    {
      filename: invoicePdfFileName(invoice),
      content: pdf,
      mimeType: "application/pdf",
    },
    ...uploadedFiles
      .filter((entry) => entry?.file?.buffer)
      .map((entry) => ({
        filename: entry.file.originalname || `${entry.kind}.bin`,
        content: entry.file.buffer,
        mimeType: entry.file.mimetype || "application/octet-stream",
      })),
  ];

  const transporterName = cleanText(
    invoice.delivery?.transporterName ||
      invoice.transportAssignment?.transporterNameSnapshot ||
      "",
  );
  const noOfPackages = Number(
    invoice.delivery?.noOfPackages ?? invoice.noOfPackages ?? 0,
  );
  const cnNumber = cleanText(
    invoice.delivery?.cnNumber || invoice.consignmentNote?.cnNumber || "",
  );
  const cnQty = Number(invoice.consignmentNote?.cnQty || 0);
  const cnDate = invoice.consignmentNote?.cnDate
    ? new Date(invoice.consignmentNote.cnDate).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "";
  const biltyNo = cleanText(invoice.delivery?.biltyNo || "");
  const vehicleNo = cleanText(invoice.delivery?.vehicleNo || "");
  const remarks = cleanText(invoice.delivery?.remarks || "");
  const invoiceDate = invoice.date
    ? new Date(invoice.date).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "";
  const deliveredAt = invoice.delivery?.deliveredAt
    ? new Date(invoice.delivery.deliveredAt).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  const dispatchLines = [
    transporterName ? `Transporter: ${transporterName}` : "",
    Number.isFinite(noOfPackages) && noOfPackages > 0
      ? `No. of Packages: ${noOfPackages}`
      : "",
    cnNumber ? `CN Number: ${cnNumber}` : "",
    cnDate ? `CN Date: ${cnDate}` : "",
    Number.isFinite(cnQty) && cnQty > 0 ? `CN Qty: ${cnQty}` : "",
    biltyNo ? `Bilty/LR Number: ${biltyNo}` : "",
    vehicleNo ? `Vehicle Number: ${vehicleNo}` : "",
    deliveredAt ? `Delivered At: ${deliveredAt}` : "",
    remarks ? `Remarks: ${remarks}` : "",
  ].filter(Boolean);

  const subject = delivered
    ? `Dispatch Update - Invoice ${invoice.invoiceNo}`
    : `Invoice ${invoice.invoiceNo} - ${invoice.customerNameSnapshot || "Customer"}`;

  const text = [
    `Dear ${invoice.customerNameSnapshot || "Customer"},`,
    "",
    delivered
      ? `Your invoice ${invoice.invoiceNo} has been marked delivered.`
      : `Please find attached invoice ${invoice.invoiceNo}.`,
    invoiceDate ? `Invoice Date: ${invoiceDate}` : "",
    `Invoice Amount: INR ${emailMoney(invoice.grandTotal)}`,
    ...(dispatchLines.length ? ["", "Dispatch Details", ...dispatchLines] : []),
    "",
    uploadedFiles.length
      ? "The invoice PDF and available Bilty/LR document are attached."
      : "The invoice PDF is attached.",
    "",
    "Thank you for your business.",
  ]
    .filter(Boolean)
    .join("\n");

  const dispatchRows = [
    ["Transporter", transporterName],
    ["No. of Packages", Number.isFinite(noOfPackages) && noOfPackages > 0 ? String(noOfPackages) : ""],
    ["CN Number", cnNumber],
    ["CN Date", cnDate],
    ["CN Qty", Number.isFinite(cnQty) && cnQty > 0 ? String(cnQty) : ""],
    ["Bilty / LR Number", biltyNo],
    ["Vehicle Number", vehicleNo],
    ["Delivered At", deliveredAt],
    ["Remarks", remarks],
  ].filter(([, value]) => value);

  const dispatchHtml = dispatchRows.length
    ? `<div style="margin:22px 0 0;border:1px solid #dbe4ee;border-radius:12px;overflow:hidden">
        <div style="background:#f3f7fb;padding:11px 16px;font-size:13px;font-weight:700;color:#334155;text-transform:uppercase;letter-spacing:.04em">Dispatch Details</div>
        <table role="presentation" style="width:100%;border-collapse:collapse">${dispatchRows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:10px 16px;border-top:1px solid #edf2f7;width:42%;color:#64748b;font-size:13px">${escapeEmailHtml(label)}</td><td style="padding:10px 16px;border-top:1px solid #edf2f7;color:#0f172a;font-size:14px;font-weight:600">${escapeEmailHtml(value)}</td></tr>`,
          )
          .join("")}</table>
      </div>`
    : "";

  const html = `<!doctype html>
<html><body style="margin:0;background:#f4f7fb;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#1e293b">
  <table role="presentation" style="width:100%;border-collapse:collapse"><tr><td align="center">
    <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(15,23,42,.06)">
      <div style="background:#0f3d68;padding:24px 28px;color:#ffffff">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.12em;opacity:.8">${delivered ? "Dispatch & Delivery Update" : "Invoice"}</div>
        <div style="margin-top:6px;font-size:24px;font-weight:700">${escapeEmailHtml(invoice.invoiceNo || "Invoice")}</div>
      </div>
      <div style="padding:28px">
        <p style="margin:0 0 14px;font-size:15px">Dear <strong>${escapeEmailHtml(invoice.customerNameSnapshot || "Customer")}</strong>,</p>
        <p style="margin:0 0 22px;line-height:1.6;color:#475569">${delivered ? "Your invoice has been marked delivered. The invoice PDF is attached for your records." : "Please find your invoice PDF attached. The important invoice and dispatch details are summarized below."}</p>

        <div style="display:block;border:1px solid #dbe4ee;border-radius:12px;overflow:hidden">
          <table role="presentation" style="width:100%;border-collapse:collapse">
            <tr><td style="padding:12px 16px;background:#f8fafc;color:#64748b;font-size:13px">Invoice Number</td><td style="padding:12px 16px;background:#f8fafc;text-align:right;font-weight:700;color:#0f172a">${escapeEmailHtml(invoice.invoiceNo || "")}</td></tr>
            ${invoiceDate ? `<tr><td style="padding:12px 16px;border-top:1px solid #edf2f7;color:#64748b;font-size:13px">Invoice Date</td><td style="padding:12px 16px;border-top:1px solid #edf2f7;text-align:right;font-weight:600">${escapeEmailHtml(invoiceDate)}</td></tr>` : ""}
            <tr><td style="padding:12px 16px;border-top:1px solid #edf2f7;color:#64748b;font-size:13px">Invoice Amount</td><td style="padding:12px 16px;border-top:1px solid #edf2f7;text-align:right;font-size:18px;font-weight:700;color:#0f3d68">₹${escapeEmailHtml(emailMoney(invoice.grandTotal))}</td></tr>
          </table>
        </div>

        ${dispatchHtml}

        <div style="margin-top:24px;padding:14px 16px;background:#f8fafc;border-radius:10px;color:#64748b;font-size:13px;line-height:1.55">
          ${uploadedFiles.length ? "The invoice PDF and the available Bilty/LR document are attached to this email." : "The invoice PDF is attached to this email."}
        </div>
        <p style="margin:24px 0 0;color:#475569;font-size:14px">Thank you for your business.</p>
      </div>
    </div>
  </td></tr></table>
</body></html>`;

  const sent = await sendInvoiceThroughConfiguredMailbox({
    tenantKey,
    to,
    subject,
    text,
    html,
    attachments,
  });
  return { status: "SENT", to, error: "", provider: sent.provider };
}

async function emailDeliveredInvoice(args) {
  return emailSalesInvoice({ ...args, delivered: true });
}

router.post(
  "/sales-invoices/:id/email",
  requireObjectIdParam,
  requireAnyPermission(
    "dms.sales.sales_invoice.download",
    "dms.sales.sales_invoice.edit",
    "dms.sales.dispatch_details.edit",
  ),
  async (req, res) => {
    try {
      const financialYear = await resolveFinancialYear({
        tenantKey: req.auth.tenantKey,
        requested: req.body.financialYear || req.query.financialYear,
      });
      const { SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
      const invoice = await SalesInvoice.findOne({
        _id: req.params.id,
        tenantKey: req.auth.tenantKey,
        financialYear,
        status: { $ne: "DELETED" },
      });
      if (!invoice) return fail(res, "Sales invoice not found", 404);
      const customer = await CustomerLink.findOne({
        tenantKey: req.auth.tenantKey,
        globalCustomerId: invoice.customerGlobalId,
      }).lean();
      if (!customer) return fail(res, "Customer record not found", 404);
      const result = await emailSalesInvoice({
        tenantKey: req.auth.tenantKey,
        financialYear,
        invoice,
        customer,
      });
      return ok(
        res,
        { invoiceId: String(invoice._id), invoiceNo: invoice.invoiceNo, ...result },
        result.status === "SENT"
          ? `Invoice emailed to ${result.to}`
          : `Invoice email not sent: ${result.error}`,
      );
    } catch (error) {
      return fail(res, error.message || "Unable to email invoice", error?.code === "MAIL_NOT_CONNECTED" ? 409 : 500);
    }
  },
);

router.post(
  "/sales-invoices/:id/process",
  requireObjectIdParam,
  requireAnyPermission(
    "dms.sales.sales_invoice.edit",
    "dms.sales.dispatch_details.edit",
  ),
  upload.fields([
    { name: "biltyCopy", maxCount: 1 },
    { name: "cnImage", maxCount: 1 },
  ]),
  async (req, res) => {
    const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.body.financialYear || req.query.financialYear,
    });
    const { SalesInvoice, SalesOrder, OrderEvent } = financialModels(req.auth.tenantKey, financialYear);
    const invoice = await SalesInvoice.findOne({
      _id: req.params.id,
      tenantKey: req.auth.tenantKey,
      financialYear,
    });
    if (!invoice) return fail(res, "Sales invoice not found", 404);
    if (req.auth.role !== "MASTER" && req.auth.role !== "SUPERADMIN") {
      if (
        req.auth.dataScope === "WAREHOUSE" &&
        (!req.auth.warehouseId || invoice.warehouseId !== req.auth.warehouseId)
      )
        return fail(res, "Invoice is outside your assigned warehouse", 403);
      if (
        req.auth.dataScope === "ASSIGNED" &&
        invoice.assignedTo !== req.auth.sub &&
        invoice.createdBy !== req.auth.sub
      )
        return fail(res, "Invoice is outside your assigned work", 403);
    }
    const from = String(invoice.workflowStatus || "POSTED").toUpperCase(),
      to = String(req.body.toStatus || "").toUpperCase();
    if (!to) return fail(res, "toStatus is required", 400);
    // All order-linked deliveries/cancellations must follow the Delivery Boy + Order Desk workflow.
    // Direct invoices continue to use this endpoint.
    if (invoice.sourceOrderId && ["DELIVERED", "HANDED_TO_TRANSPORTER", "CANCELLED"].includes(to)) {
      return fail(res, "Order invoice delivery/cancellation must use Phase 2 delivery/cancellation verification", 409);
    }
    const transition = `${from}>${to}`;
    if (req.auth.role !== "MASTER" && req.auth.role !== "SUPERADMIN") {
      const allowed = req.auth.workflowTransitions?.salesInvoice || [];
      if (!allowed.includes(transition))
        return fail(res, `Your designation cannot perform ${transition}`, 403);
    }

    let deliveryMessage = "";
    if (to === "DELIVERED") {
      const customer = await CustomerLink.findOne({
        tenantKey: req.auth.tenantKey,
        globalCustomerId: invoice.customerGlobalId,
      }).lean();
      if (!customer)
        return fail(res, "Customer record not found for delivery", 404);
      const bilty = req.files?.biltyCopy?.[0] || null;
      const nonLocal =
        upper(
          invoice.transportAssignment?.mode || customer.regionType || "LOCAL",
        ) !== "LOCAL";
      const transporterName = cleanText(
        req.body.transporterName || invoice.transportAssignment?.transporterNameSnapshot || "",
      );
      const noOfPackages = Number(req.body.noOfPackages ?? invoice.noOfPackages ?? 0);
      const cnNumber = cleanText(req.body.cnNumber || "");
      const cnQtyRaw = req.body.cnQty;
      const cnQty = cnQtyRaw === undefined || cnQtyRaw === null || String(cnQtyRaw).trim() === "" ? null : Number(cnQtyRaw);
      const cnDate = req.body.cnDate ? new Date(req.body.cnDate) : null;
      const cnImage = req.files?.cnImage?.[0] || null;
      const existingCnImageFileId = cleanText(invoice.consignmentNote?.imageFileId || "");
      const cnTouched = Boolean(
        cnNumber ||
        req.body.cnDate ||
        (cnQtyRaw !== undefined && String(cnQtyRaw).trim() !== "") ||
        cnImage ||
        existingCnImageFileId
      );
      const biltyNo = cleanText(req.body.biltyNo || "");
      if (!Number.isFinite(noOfPackages) || noOfPackages < 0)
        return fail(res, "No. of Packages must be zero or more", 400);
      if (cnTouched) {
        if (!cnNumber) return fail(res, "CN Number is required when CN details are added", 400);
        if (!Number.isFinite(cnQty) || cnQty <= 0) return fail(res, "CN Qty must be greater than zero", 400);
        if (!cnDate || Number.isNaN(cnDate.getTime())) return fail(res, "Valid CN Date is required", 400);
        if (!cnImage && !existingCnImageFileId) return fail(res, "CN Image/PDF is required when CN details are added", 400);
        if (cnImage && !String(cnImage.mimetype || "").startsWith("image/") && String(cnImage.mimetype || "") !== "application/pdf")
          return fail(res, "CN Image must be an image or PDF file", 400);
      }
      if (nonLocal && !biltyNo)
        return fail(res, "Bilty/LR Number is mandatory for a non-local customer", 400);
      if (nonLocal && !bilty)
        return fail(
          res,
          "Bilty/LR copy is mandatory for a non-local customer",
          400,
        );

      const uploaded = bilty ? [{ kind: "BILTY_COPY", file: bilty }] : [];
      let stored = [];
      if (uploaded.length) {
        try {
          stored = await storeDeliveryFiles({
            tenantKey: req.auth.tenantKey,
            invoiceNo: invoice.invoiceNo,
            files: uploaded,
          });
        } catch (error) {
          return fail(
            res,
            `Unable to save Bilty/LR copy: ${error.message}`,
            500,
          );
        }
      }

      invoice.noOfPackages = noOfPackages;
      if (transporterName)
        invoice.set("transportAssignment.transporterNameSnapshot", transporterName);

      if (cnTouched) {
        let imageFileId = existingCnImageFileId;
        let imageName = cleanText(invoice.consignmentNote?.imageName || "");
        let imageMimeType = cleanText(invoice.consignmentNote?.imageMimeType || "");
        if (cnImage) {
          const meta = await saveUploadedFile({
            file: cnImage,
            tenantKey: req.auth.tenantKey,
            module: "DMS",
            entityType: "SALES_INVOICE_CN",
            entityId: String(invoice._id),
            uploadedBy: req.auth.sub,
            access: "PRIVATE",
          });
          imageFileId = meta.fileId;
          imageName = meta.originalName || cnImage.originalname || "CN Image";
          imageMimeType = meta.mimeType || cnImage.mimetype || "application/octet-stream";
        }
        invoice.consignmentNote = {
          cnDate,
          cnQty,
          cnNumber,
          imageFileId,
          imageName,
          imageMimeType,
          savedAt: new Date(),
          savedBy: req.auth.sub,
          savedByNameSnapshot: req.auth.name || req.auth.fullName || req.auth.email || "",
        };
      }

      invoice.delivery = {
        deliveredAt: req.body.deliveredAt
          ? new Date(req.body.deliveredAt)
          : new Date(),
        transporterName,
        noOfPackages,
        cnNumber,
        vehicleNo: cleanText(req.body.vehicleNo),
        biltyNo,
        remarks: cleanText(req.body.deliveryRemarks),
        proofFiles: stored,
        emailStatus: "PENDING",
      };
      invoice.workflowStatus = to;
      invoice.warehouseProcessedBy = req.auth.sub;
      await invoice.save();
      try {
        const result = await emailDeliveredInvoice({
          tenantKey: req.auth.tenantKey,
          financialYear,
          invoice,
          customer,
          uploadedFiles: [
            ...uploaded,
            ...(cnImage ? [{ kind: "CN_IMAGE", file: cnImage }] : []),
          ],
        });
        invoice.delivery.emailStatus = result.status;
        invoice.delivery.emailTo = result.to;
        invoice.delivery.emailError = result.error || "";
        if (result.status === "SENT") invoice.delivery.emailedAt = new Date();
        deliveryMessage =
          result.status === "SENT"
            ? ` Invoice emailed automatically to ${result.to}.`
            : ` Invoice email not sent: ${result.error}.`;
      } catch (error) {
        invoice.delivery.emailStatus = "FAILED";
        invoice.delivery.emailError = String(error.message || error);
        deliveryMessage = ` Invoice delivered, but email failed: ${error.message}.`;
      }
      await invoice.save();

      // Keep the source Sales Order lifecycle in sync with the existing Sales
      // Invoice delivery action. Delivered is the successful terminal state for
      // an order; after this point the order cannot be cancelled or deleted.
      if (invoice.sourceOrderId) {
        const sourceOrder = await SalesOrder.findOne({
          _id: invoice.sourceOrderId,
          tenantKey: req.auth.tenantKey,
          financialYear,
        });
        if (sourceOrder && !["CANCELLED", "REJECTED", "CLOSED"].includes(upper(sourceOrder.workflowStatus))) {
          if (upper(sourceOrder.workflowStatus) === "DELIVERED") return fail(res,"This order was already delivered",409);
          // One-way transfer from pending to outward on confirmed delivery.
          for (const line of invoice.items || []) {
            const qty=Number(line.qty || 0);
            if (!(qty>0)) continue;
            await Product.updateOne({_id:line.productId,tenantKey:req.auth.tenantKey},{$inc:{currentStock:-qty,reservedStock:-qty}});
            await Product.updateOne({_id:line.productId,tenantKey:req.auth.tenantKey,reservedStock:{$lt:0}},{$set:{reservedStock:0}});
            await StockMovement.create({tenantKey:req.auth.tenantKey,financialYear,date:new Date(),productId:line.productId,warehouseId:sourceOrder.mainWarehouseId||sourceOrder.warehouseId||invoice.warehouseId,type:"DELIVERY_SALE",qtyIn:0,qtyOut:qty,referenceId:invoice.invoiceNo});
          }
          for(const item of sourceOrder.items || []) item.reservedQty=0;
          const fromStatus = upper(sourceOrder.workflowStatus || "INVOICED");
          sourceOrder.workflowStatus = "DELIVERED";
          sourceOrder.status = "CONVERTED";
          sourceOrder.lastWorkflowAt = new Date();
          sourceOrder.nextAction = "Completed";
          await sourceOrder.save();
          await OrderEvent.create({
            tenantKey: req.auth.tenantKey,
            financialYear,
            eventNo: makeId("EVT"),
            orderId: String(sourceOrder._id),
            orderNo: sourceOrder.orderNo,
            invoiceId: String(invoice._id),
            invoiceNo: invoice.invoiceNo,
            type: "DELIVERED",
            fromStatus,
            toStatus: "DELIVERED",
            note: `Invoice ${invoice.invoiceNo} marked delivered; order completed successfully`,
            meta: { invoiceId: String(invoice._id), invoiceNo: invoice.invoiceNo, deliveredAt: invoice.delivery?.deliveredAt || new Date() },
            audience: ["DMS", "CUSTOMER", "SALESPERSON"],
            actorId: req.auth.sub,
            actorNameSnapshot: req.auth.name || req.auth.fullName || req.auth.email || "",
            actorRole: req.auth.role || "",
            occurredAt: new Date(),
          });
        }
      }

      return ok(
        res,
        salesInvoiceForAuth(invoice, req.auth),
        `Invoice moved to DELIVERED.${deliveryMessage}`,
      );
    }

    invoice.workflowStatus = to;
    invoice.warehouseProcessedBy = req.auth.sub;
    await invoice.save();
    return ok(
      res,
      salesInvoiceForAuth(invoice, req.auth),
      `Invoice moved to ${to}`,
    );
  },
);

function normalizedPurchaseAdjustments(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const rawType = cleanText(row?.type || "");
      const type = /discount/i.test(rawType)
        ? "Discount"
        : /charge/i.test(rawType)
          ? "Charges"
          : "";
      if (!type) return null;
      const method = /percent/i.test(cleanText(row?.method || ""))
        ? "Percentage"
        : "Amount";
      return {
        id: cleanText(row?.id || `purchase-adjustment-${index + 1}`),
        masterId: cleanText(row?.masterId || ""),
        type,
        title: cleanText(row?.title || type),
        method,
        value: Math.max(0, Number(row?.value || 0)),
        applied: Math.max(0, round2(Number(row?.applied || 0))),
      };
    })
    .filter(Boolean);
}

async function calculatePurchaseInvoice({ auth, body }) {
  const tenantKey = auth.tenantKey,
    date = transactionDate(body.date),
    financialYear =
      financialYearFromDate(body.date) ||
      financialYearFromDate(date) ||
      (await resolveFinancialYear({
        tenantKey,
        requested: body.financialYear,
      })),
    requested = Array.isArray(body.items) ? body.items : [];
  if (!requested.length)
    throw Object.assign(new Error("At least one product row is required"), {
      statusCode: 400,
    });
  const ids = Array.from(
    new Set(requested.map((x) => String(x.productId || "")).filter(Boolean)),
  );
  const products = await Product.find({
    tenantKey,
    _id: { $in: ids },
    status: "ACTIVE",
  });
  const pm = new Map(products.map((p) => [String(p._id), p]));
  let subtotal = 0;
  const items = [];
  for (const row of requested) {
    const p = pm.get(String(row.productId));
    if (!p)
      throw Object.assign(new Error(`Product not found: ${row.productId}`), {
        statusCode: 400,
      });
    const qty = Number(row.qty || 0),
      rate = Number(row.rate || 0),
      discountPct = Number(row.discountPct || 0);
    if (qty <= 0 || rate < 0)
      throw Object.assign(new Error(`Invalid quantity/rate for ${p.name}`), {
        statusCode: 400,
      });

    // IMPORTANT: keep purchase-rate precision until AFTER quantity multiplication.
    // The Purchase Invoice UI allows Basic Total to drive a 6-decimal unit rate
    // (for example 100 / 3 = 33.333333). Rounding the rate to 2 decimals here
    // changed the saved taxable amount, GST and grand total even though the form
    // displayed the correct amount.
    const rawEffectiveRate = rate * (1 - discountPct / 100),
      effectiveRate = Number(rawEffectiveRate.toFixed(6)),
      taxable = round2(rawEffectiveRate * qty),
      gstRate = Number(row.gstRate ?? p.gstRate ?? 0),
      tax = round2((taxable * gstRate) / 100);

    // On edit, preserve the exact invoice snapshots shown to the user instead of
    // silently replacing them with today's Product master values. New invoices
    // send the same snapshot fields from the selected Product, so create behavior
    // stays unchanged.
    const qtyInBagCandidate = Number(row.qtyInBag),
      qtyInBag = Number.isFinite(qtyInBagCandidate) && qtyInBagCandidate > 0
        ? qtyInBagCandidate
        : Number(p.qtyInBag || 1) || 1,
      requestedGrossQty = Number(row.grossQty),
      grossQty = Number.isFinite(requestedGrossQty) && requestedGrossQty >= 0
        ? round2(requestedGrossQty)
        : round2(qty / qtyInBag);

    subtotal += taxable;
    items.push({
      productId: String(p._id),
      sku: cleanText(row.sku || p.sku || ""),
      nameSnapshot: cleanText(row.productName || row.nameSnapshot || p.name || "") || p.name,
      hsnSnapshot: cleanText(row.hsnCode || row.hsnSnapshot || p.hsnCode || ""),
      qty,
      unit: cleanText(row.netUnit || row.unit || p.basicUnit || p.unit || ""),
      packingUnit: cleanText(row.grossUnit || row.packingUnit || p.packingUnit || ""),
      qtyInBag,
      grossQty,
      mrpSnapshot: Number(row.mrpSnapshot ?? row.mrp ?? p.mrp ?? 0),
      landedCostSnapshot: Number(p.landedCost || 0),
      averagePurchasePriceSnapshot: Number(p.averagePurchasePrice || 0),
      rate,
      discountPct,
      effectiveRate,
      taxable,
      gstRateSnapshot: gstRate,
      tax,
      lineTotal: round2(taxable + tax),
    });
  }

  const billDiscount = Math.max(0, Number(body.billDiscount || 0)),
    otherCharges = Math.max(0, Number(body.otherCharges || 0));
  const billTax = billLevelTaxSummary(items, billDiscount, otherCharges);
  const taxableTotal = billTax.taxableTotal,
    taxTotal = billTax.taxTotal;

  // Allocate the invoice-level Discount + Charges back to each purchase item for
  // stock valuation/average purchase price.  `item.taxable` remains the entered
  // Basic Total (pre bill adjustment), while `netTaxable` is the real taxable
  // purchase value represented by that product.  The final row receives any
  // paise rounding residual so item net values always add up EXACTLY to the
  // invoice taxableTotal.
  let allocatedDiscount = 0;
  let allocatedCharges = 0;
  let allocatedNetTaxable = 0;
  items.forEach((it, index) => {
    const isLast = index === items.length - 1;
    const rawTaxable = Math.max(0, Number(it.taxable || 0));
    const share = billTax.subtotal > 0 ? rawTaxable / billTax.subtotal : 0;
    const discountShare = isLast
      ? round2(billTax.discount - allocatedDiscount)
      : round2(billTax.discount * share);
    const chargeShare = isLast
      ? round2(billTax.charges - allocatedCharges)
      : round2(billTax.charges * share);
    const netTaxable = isLast
      ? round2(taxableTotal - allocatedNetTaxable)
      : round2(Math.max(0, rawTaxable - discountShare + chargeShare));
    const netRate = Number(it.qty || 0) > 0
      ? Number((netTaxable / Number(it.qty)).toFixed(6))
      : 0;

    it.billDiscountShare = discountShare;
    it.billChargeShare = chargeShare;
    it.netTaxable = netTaxable;
    it.netRate = netRate;

    allocatedDiscount = round2(allocatedDiscount + discountShare);
    allocatedCharges = round2(allocatedCharges + chargeShare);
    allocatedNetTaxable = round2(allocatedNetTaxable + netTaxable);
  });

  const transportationCost = Math.max(0, Number(body.transportationCost || 0));
  const labourCost = Math.max(0, Number(body.labourCost || 0));
  const localFreight = Math.max(0, Number(body.localFreight || 0));
  const miscellaneousCost = Math.max(0, Number(body.miscellaneousCost || 0));
  const landedCharges = round2(
    transportationCost + labourCost + localFreight + miscellaneousCost,
  );
  const basicPurchaseTotalAfterAdjustments = round2(
    Math.max(0, billTax.taxableTotal),
  );
  const landedExpensePercentageRaw =
    basicPurchaseTotalAfterAdjustments > 0
      ? (landedCharges / basicPurchaseTotalAfterAdjustments) * 100
      : 0;
  const landedExpensePercentage = round2(landedExpensePercentageRaw);
  const landedTax = 0;

  for (const it of items) {
    // Landed price must start from the NET purchase rate after bill discount/
    // charges, not from the pre-discount Basic Total rate.
    const basicPurchasePrice = Math.max(
      0,
      Number(it.netRate ?? it.effectiveRate ?? it.rate ?? 0),
    );
    it.landedCostSnapshot = round2(
      basicPurchasePrice + (basicPurchasePrice * landedExpensePercentageRaw) / 100,
    );
  }

  const beforeRound = round2(taxableTotal + taxTotal),
    grandTotal =
      body.roundGrandTotal === false ? beforeRound : Math.round(beforeRound),
    roundOff = round2(grandTotal - beforeRound);
  return {
    tenantKey,
    financialYear,
    items,
    adjustments: normalizedPurchaseAdjustments(body.adjustments),
    subtotal: round2(subtotal),
    billTax,
    taxableTotal,
    taxTotal,
    transportationCost,
    labourCost,
    localFreight,
    miscellaneousCost,
    landedCharges,
    landedTax,
    landedExpensePercentage,
    beforeRound,
    grandTotal,
    roundOff,
    date,
  };
}

function assertPurchaseClientTotals(body, calc) {
  const checks = [
    ["Basic Total", body.expectedSubtotal, calc.subtotal],
    ["Taxable Value", body.expectedTaxableTotal, calc.taxableTotal],
    ["GST", body.expectedTaxTotal, calc.taxTotal],
    ["Grand Total", body.expectedGrandTotal, calc.grandTotal],
  ];
  const mismatches = checks
    .filter(([, expected]) => expected !== undefined && expected !== null && expected !== "")
    .map(([label, expected, saved]) => ({
      label,
      shown: round2(Number(expected || 0)),
      calculated: round2(Number(saved || 0)),
    }))
    .filter((row) => Math.abs(row.shown - row.calculated) > 0.011);

  if (mismatches.length) {
    const message = mismatches
      .map((row) => `${row.label}: screen ${row.shown.toFixed(2)} / save ${row.calculated.toFixed(2)}`)
      .join(", ");
    throw Object.assign(
      new Error(`Purchase Invoice calculation mismatch. Nothing was saved. ${message}`),
      { statusCode: 409, details: { calculationMismatch: mismatches } },
    );
  }
}

function summarizePurchaseItems(items = []) {
  const out = new Map();
  for (const it of items || []) {
    const id = String(it.productId || "");
    if (!id) continue;
    const row = out.get(id) || { qty: 0, value: 0, lastRate: 0, lastLanded: 0 };
    const qty = Number(it.qty || 0),
      // New purchase invoices store the bill-adjusted rate explicitly.  Old
      // invoices do not, so they continue to subtract the historical raw rate
      // that was originally accumulated; the next edit therefore repairs the
      // product average instead of corrupting it.
      rate = Number(it.netRate ?? it.effectiveRate ?? it.rate ?? 0),
      netTaxable = Number(it.netTaxable),
      landed = Number(it.landedCostSnapshot ?? rate);
    row.qty += qty;
    row.value += Number.isFinite(netTaxable) ? netTaxable : qty * rate;
    row.lastRate = rate;
    row.lastLanded = landed;
    out.set(id, row);
  }
  return out;
}

async function applyPurchaseProductChanges({
  tenantKey,
  financialYear,
  invoiceNo,
  date,
  oldItems = [],
  newItems = [],
  reason = "EDIT",
}) {
  const oldMap = summarizePurchaseItems(oldItems),
    newMap = summarizePurchaseItems(newItems),
    ids = Array.from(new Set([...oldMap.keys(), ...newMap.keys()]));
  if (!ids.length) return;
  const products = await Product.find({ tenantKey, _id: { $in: ids } }),
    pm = new Map(products.map((p) => [String(p._id), p]));
  const models = financialModels(tenantKey, financialYear);

  // Validate all stock changes before writing anything.
  for (const id of ids) {
    const p = pm.get(id);
    if (!p)
      throw Object.assign(
        new Error(`Product not found while adjusting purchase: ${id}`),
        { statusCode: 409 },
      );
    const oldRow = oldMap.get(id) || { qty: 0, value: 0 },
      newRow = newMap.get(id) || { qty: 0, value: 0 };
    const nextStock =
      Number(p.currentStock || 0) -
      Number(oldRow.qty || 0) +
      Number(newRow.qty || 0);
    if (nextStock < -0.0001)
      throw Object.assign(
        new Error(
          `${p.name}: Purchase Invoice cannot be ${reason === "DELETE" ? "deleted" : "edited"} because ${round2(Number(oldRow.qty || 0) - Number(newRow.qty || 0))} units from this purchase are already consumed. Current stock is ${round2(Number(p.currentStock || 0))}.`,
        ),
        { statusCode: 409 },
      );
  }

  for (const id of ids) {
    const p = pm.get(id),
      oldRow = oldMap.get(id) || {
        qty: 0,
        value: 0,
        lastRate: 0,
        lastLanded: 0,
      },
      newRow = newMap.get(id) || {
        qty: 0,
        value: 0,
        lastRate: 0,
        lastLanded: 0,
      };
    const nextQty = Math.max(
      0,
      Number(p.purchaseQtyAccumulated || 0) -
        Number(oldRow.qty || 0) +
        Number(newRow.qty || 0),
    );
    const nextVal = Math.max(
      0,
      Number(p.purchaseValueAccumulated || 0) -
        Number(oldRow.value || 0) +
        Number(newRow.value || 0),
    );
    const nextAvg =
      nextQty > 0 ? round2(nextVal / nextQty) : Number(p.openingRate || 0);
    const nextStock = round2(
      Number(p.currentStock || 0) -
        Number(oldRow.qty || 0) +
        Number(newRow.qty || 0),
    );
    const oldWasCurrent =
      Math.abs(
        Number(p.lastPurchasePrice || 0) - Number(oldRow.lastRate || 0),
      ) < 0.005;
    const oldLandedWasCurrent =
      Math.abs(Number(p.landedCost || 0) - Number(oldRow.lastLanded || 0)) <
      0.005;
    const lastPurchasePrice =
      Number(newRow.qty || 0) > 0
        ? oldWasCurrent || !Number(oldRow.qty || 0)
          ? Number(newRow.lastRate || 0)
          : Number(p.lastPurchasePrice || 0)
        : oldWasCurrent
          ? nextAvg
          : Number(p.lastPurchasePrice || nextAvg);
    const landedCost =
      Number(newRow.qty || 0) > 0
        ? oldLandedWasCurrent || !Number(oldRow.qty || 0)
          ? Number(newRow.lastLanded || newRow.lastRate || 0)
          : Number(p.landedCost || 0)
        : oldLandedWasCurrent
          ? nextAvg
          : Number(p.landedCost || nextAvg);
    await Product.updateOne(
      { _id: p._id, tenantKey },
      {
        $set: {
          currentStock: nextStock,
          purchaseQtyAccumulated: round2(nextQty),
          purchaseValueAccumulated: round2(nextVal),
          averagePurchasePrice: round2(nextAvg),
          lastPurchasePrice: round2(lastPurchasePrice),
          landedCost: round2(landedCost),
        },
      },
    );
  }

  for (const it of oldItems || []) {
    await models.StockMovement.create({
      tenantKey,
      financialYear,
      date: new Date(),
      productId: String(it.productId),
      type:
        reason === "DELETE"
          ? "PURCHASE_DELETE_REVERSAL"
          : "PURCHASE_EDIT_REVERSAL",
      qtyIn: 0,
      qtyOut: Number(it.qty || 0),
      landedCost: Number(it.landedCostSnapshot || it.effectiveRate || 0),
      referenceId: invoiceNo,
    });
  }
  for (const it of newItems || []) {
    await models.StockMovement.create({
      tenantKey,
      financialYear,
      date,
      productId: String(it.productId),
      type: "PURCHASE",
      qtyIn: Number(it.qty || 0),
      qtyOut: 0,
      landedCost: Number(it.landedCostSnapshot || it.effectiveRate || 0),
      referenceId: invoiceNo,
    });
  }
}

async function postPurchaseAccounting({
  tenantKey,
  financialYear,
  invoiceNo,
  date,
  supplierGlobalId,
  taxableTotal,
  taxTotal,
  roundOff,
  grandTotal,
}) {
  const supplier = supplierGlobalId
    ? await resolvePostingParty(tenantKey, supplierGlobalId)
    : null;
  const partyAccountCode = supplier
    ? partyAccountCodeOf(supplier)
    : "SYS_SUNDRY_CREDITORS";
  await postBalancedEntries({
    tenantKey,
    financialYear,
    transactionId: invoiceNo,
    transactionType: "PURCHASE_INVOICE",
    date,
    partyGlobalId: supplierGlobalId || "",
    narration: `Purchase Invoice ${invoiceNo}`,
    entries: [
      { accountCode: "SYS_PURCHASE", debit: taxableTotal },
      { accountCode: "SYS_DUTIES_TAXES", debit: taxTotal },
      { accountCode: partyAccountCode, credit: grandTotal },
      {
        accountCode:
          roundOff >= 0 ? "SYS_INDIRECT_EXPENSE" : "SYS_INDIRECT_INCOME",
        debit: roundOff > 0 ? roundOff : 0,
        credit: roundOff < 0 ? Math.abs(roundOff) : 0,
      },
    ].filter((x) => Number(x.debit || 0) || Number(x.credit || 0)),
  });
}

router.get("/purchase-invoices", async (req, res) => {
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.query.financialYear,
    }),
    page = Math.max(1, Number(req.query.page || 1)),
    limit = Math.min(100, Math.max(10, Number(req.query.limit || 25)));
  const { PurchaseInvoice } = financialModels(
    req.auth.tenantKey,
    financialYear,
  );
  const f = { tenantKey: req.auth.tenantKey, financialYear };
  if (req.query.supplierGlobalId)
    f.supplierGlobalId = cleanText(req.query.supplierGlobalId);
  if (req.query.includeDeleted !== "true") f.status = { $ne: "DELETED" };
  const purchaseListRange = transactionQueryDateRange(req);
  if (purchaseListRange) f.date = purchaseListRange;
  let [items, total] = await Promise.all([
    PurchaseInvoice.find(f)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PurchaseInvoice.countDocuments(f),
  ]);
  items = await enrichTransactionRows({
    tenantKey: req.auth.tenantKey,
    rows: items,
    partyIdKey: "supplierGlobalId",
    partySnapshotKey: "supplierNameSnapshot",
  });
  ok(res, { items, meta: pageMeta(page, limit, total) });
});

router.get("/purchase-invoices/:id", async (req, res) => {
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.query.financialYear,
    }),
    { PurchaseInvoice } = financialModels(req.auth.tenantKey, financialYear);
  const invoice = await PurchaseInvoice.findOne({
    _id: req.params.id,
    tenantKey: req.auth.tenantKey,
    financialYear,
  }).lean();
  if (!invoice) return fail(res, "Purchase invoice not found", 404);
  const [enriched] = await enrichTransactionRows({
    tenantKey: req.auth.tenantKey,
    rows: [invoice],
    partyIdKey: "supplierGlobalId",
    partySnapshotKey: "supplierNameSnapshot",
  });
  return ok(res, enriched);
});

router.post("/purchase-invoices", async (req, res) => {
  try {
    const calc = await calculatePurchaseInvoice({
      auth: req.auth,
      body: req.body,
    });
    assertPurchaseClientTotals(req.body, calc);
    const invoiceNo = cleanText(req.body.invoiceNo) || makeId("PINV"),
      { PurchaseInvoice } = financialModels(calc.tenantKey, calc.financialYear);
    if (
      await PurchaseInvoice.exists({
        tenantKey: calc.tenantKey,
        financialYear: calc.financialYear,
        invoiceNo,
      })
    )
      return fail(res, "Purchase invoice number already exists", 409);
    const supplierRef = cleanText(req.body.supplierGlobalId || "");
    const supplierMap = await resolvePartyDisplayMap(calc.tenantKey, [
      supplierRef,
    ]);
    const supplierName =
      supplierMap.get(supplierRef)?.name ||
      cleanText(req.body.supplierName) ||
      "Supplier";
    const invoice = await PurchaseInvoice.create({
      tenantKey: calc.tenantKey,
      financialYear: calc.financialYear,
      invoiceNo,
      date: calc.date,
      supplierGlobalId: supplierRef,
      supplierNameSnapshot: supplierName,
      supplierGstinSnapshot: upper(req.body.supplierGstin),
      purchaseType: upper(req.body.purchaseType || "GST"),
      items: calc.items,
      adjustments: calc.adjustments,
      subtotal: calc.subtotal,
      billDiscount: calc.billTax.discount,
      otherCharges: calc.billTax.charges,
      taxableTotal: calc.taxableTotal,
      taxTotal: calc.taxTotal,
      roundOff: calc.roundOff,
      grandTotal: calc.grandTotal,
      landedCharges: calc.landedCharges,
      transportationCost: calc.transportationCost,
      labourCost: calc.labourCost,
      localFreight: calc.localFreight,
      miscellaneousCost: calc.miscellaneousCost,
      landedTax: calc.landedTax,
      landedExpensePercentage: calc.landedExpensePercentage,
      maxGstPercentage: 0,
      remarks: req.body.remarks,
      createdBy: req.auth.sub,
      createdByNameSnapshot: req.auth.name || "",
      status: "POSTED",
    });
    await applyPurchaseProductChanges({
      tenantKey: calc.tenantKey,
      financialYear: calc.financialYear,
      invoiceNo,
      date: calc.date,
      oldItems: [],
      newItems: calc.items,
      reason: "CREATE",
    });
    await postPurchaseAccounting({
      ...calc,
      invoiceNo,
      supplierGlobalId: req.body.supplierGlobalId || "",
    });
    return ok(
      res,
      invoice,
      "Purchase invoice posted and landed costs updated",
      201,
    );
  } catch (e) {
    return fail(res, e.message, e.statusCode || 400, e.details);
  }
});

router.put("/purchase-invoices/:id", async (req, res) => {
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested:
        req.body.sourceFinancialYear ||
        req.query.financialYear ||
        req.body.financialYear,
    }),
    models = financialModels(req.auth.tenantKey, financialYear);
  const existing = await models.PurchaseInvoice.findOne({
    _id: req.params.id,
    tenantKey: req.auth.tenantKey,
    financialYear,
    status: "POSTED",
  });
  if (!existing) return fail(res, "Posted purchase invoice not found", 404);
  try {
    const calc = await calculatePurchaseInvoice({
      auth: req.auth,
      body: req.body,
    });
    if (calc.financialYear !== financialYear)
      return fail(
        res,
        `The selected date belongs to FY ${calc.financialYear}. An existing invoice cannot be moved across financial-year databases. Delete/recreate it with the new date.`,
        409,
      );
    assertPurchaseClientTotals(req.body, calc);
    await applyPurchaseProductChanges({
      tenantKey: req.auth.tenantKey,
      financialYear,
      invoiceNo: existing.invoiceNo,
      date: calc.date,
      oldItems: existing.items || [],
      newItems: calc.items,
      reason: "EDIT",
    });
    await reversePostedTransaction({
      tenantKey: req.auth.tenantKey,
      financialYear,
      transactionId: existing.invoiceNo,
      reason: "Purchase invoice edited",
    });
    existing.date = calc.date;
    existing.supplierGlobalId = cleanText(req.body.supplierGlobalId || "");
    const supplierMap = await resolvePartyDisplayMap(req.auth.tenantKey, [
      existing.supplierGlobalId,
    ]);
    existing.supplierNameSnapshot =
      supplierMap.get(existing.supplierGlobalId)?.name ||
      cleanText(req.body.supplierName) ||
      existing.supplierNameSnapshot ||
      "Supplier";
    existing.supplierGstinSnapshot = upper(req.body.supplierGstin);
    existing.purchaseType = upper(req.body.purchaseType || "GST");
    existing.items = calc.items;
    existing.adjustments = calc.adjustments;
    existing.subtotal = calc.subtotal;
    existing.billDiscount = calc.billTax.discount;
    existing.otherCharges = calc.billTax.charges;
    existing.taxableTotal = calc.taxableTotal;
    existing.taxTotal = calc.taxTotal;
    existing.roundOff = calc.roundOff;
    existing.grandTotal = calc.grandTotal;
    existing.landedCharges = calc.landedCharges;
    existing.transportationCost = calc.transportationCost;
    existing.labourCost = calc.labourCost;
    existing.localFreight = calc.localFreight;
    existing.miscellaneousCost = calc.miscellaneousCost;
    existing.landedTax = calc.landedTax;
    existing.landedExpensePercentage = calc.landedExpensePercentage;
    existing.maxGstPercentage = 0;
    existing.remarks = req.body.remarks;
    existing.status = "POSTED";
    await existing.save();
    await postPurchaseAccounting({
      ...calc,
      invoiceNo: existing.invoiceNo,
      supplierGlobalId: req.body.supplierGlobalId || "",
    });
    return ok(
      res,
      existing,
      "Purchase invoice updated; stock, accounting and landed cost recalculated",
    );
  } catch (e) {
    return fail(res, e.message, e.statusCode || 400, e.details);
  }
});

router.delete("/purchase-invoices/:id", async (req, res) => {
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.body?.financialYear || req.query.financialYear,
    }),
    models = financialModels(req.auth.tenantKey, financialYear);
  const invoice = await models.PurchaseInvoice.findOne({
    _id: req.params.id,
    tenantKey: req.auth.tenantKey,
    financialYear,
  });
  if (!invoice) return fail(res, "Purchase invoice not found", 404);

  // Permanently remove legacy soft-deleted rows without reversing stock/accounting twice.
  if (invoice.status === "DELETED") {
    const payload = { _id: String(invoice._id), invoiceNo: invoice.invoiceNo, deleted: true, hardDeleted: true };
    await models.PurchaseInvoice.deleteOne({ _id: invoice._id, tenantKey: req.auth.tenantKey, financialYear });
    return ok(res, payload, "Purchase invoice permanently deleted from database");
  }

  try {
    await applyPurchaseProductChanges({
      tenantKey: req.auth.tenantKey,
      financialYear,
      invoiceNo: invoice.invoiceNo,
      date: new Date(),
      oldItems: invoice.items || [],
      newItems: [],
      reason: "DELETE",
    });
    await reversePostedTransaction({
      tenantKey: req.auth.tenantKey,
      financialYear,
      transactionId: invoice.invoiceNo,
      reason: "Purchase invoice permanently deleted",
    });
    const payload = { _id: String(invoice._id), invoiceNo: invoice.invoiceNo, deleted: true, hardDeleted: true };
    await models.PurchaseInvoice.deleteOne({
      _id: invoice._id,
      tenantKey: req.auth.tenantKey,
      financialYear,
    });
    return ok(
      res,
      payload,
      "Purchase invoice permanently deleted; stock and accounting reversed",
    );
  } catch (e) {
    return fail(res, e.message, e.statusCode || 400, e.details);
  }
});

function transactionQueryDateRange(req) {
  const fromDate = String(req.query.fromDate || "").trim();
  const toDate = String(req.query.toDate || "").trim();
  if (!fromDate && !toDate) return null;
  if ((fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) || (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate))) {
    const error = new Error("Invalid date filter; use YYYY-MM-DD");
    error.statusCode = 400;
    throw error;
  }
  const range = {};
  if (fromDate) {
    const from = new Date(`${fromDate}T00:00:00.000Z`);
    if (!Number.isNaN(from.getTime())) range.$gte = from;
  }
  if (toDate) {
    const to = new Date(`${toDate}T23:59:59.999Z`);
    if (!Number.isNaN(to.getTime())) range.$lte = to;
  }
  return Object.keys(range).length ? range : null;
}


// Keep route authorization consistent with plan/role PAGE_PERMISSION_MAP: the
// JWT carries action-specific permission keys (screen.view / screen.create).
const canManualVoucherAction=(auth,channel,transactionType,action="create")=>{
  if(auth?.role==="MASTER")return true;
  const granted=new Set(auth?.permissions||[]);
  if(granted.has("*"))return true;
  const byType=upper(transactionType)==="PAYMENT"?"dms.transaction.payment":"dms.transaction.receipt";
  const shared=channel==="cash"
    ? ["dms.transaction.cashbook","dms.transaction.cashaccount"]
    : ["dms.finance_reports.bank_statement"];
  return [byType,...shared].some(p=>granted.has(`${p}.${action}`));
};
const canViewCompanyCashbook=auth=>{
  if(auth?.role==="MASTER")return true;
  const granted=new Set(auth?.permissions||[]);
  return granted.has("*")||["dms.transaction.cashbook","dms.transaction.cashaccount","dms.transaction.receipt","dms.transaction.payment"].some(p=>granted.has(`${p}.view`));
};


// SUPERADMIN BOOK CORRECTION — direct from BANK/CASH table. No separate
// approval workflow. The original invoice/OTP/import evidence remains intact;
// a balanced correction journal changes account/party balances, and the book
// projection shows the effective amount. Every edit/delete is audited.
router.post('/book-corrections',async(req,res)=>{
 if(!isSuperadmin(req.auth))return fail(res,'Superadmin permission required',403);
 const book=upper(req.body?.book),sourceKey=cleanText(req.body?.sourceKey);
 if(!['BANK','CASH'].includes(book)||!sourceKey||sourceKey.length>160)
   return fail(res,'Choose an actual BANK or CASH transaction row',400);
 const reason=cleanText(req.body?.reason);
 if(reason.length<5)return fail(res,'A correction reason of at least five characters is required for audit',400);
 let session;
 try{
   const tenantKey=req.auth.tenantKey;
   const financialYear=await resolveFinancialYear({tenantKey,requested:req.body.financialYear});
   const source=await resolveSuperadminBookSource({tenantKey,financialYear,book,sourceKey});
   const current=await originalBookJournal({tenantKey,financialYear,source});
   const correction=validateBookCorrection({
     date:req.body.deleted?new Date(source.originalDate).toISOString().slice(0,10):req.body.date,
     debit:req.body.debit,credit:req.body.credit,remarks:req.body.remarks,
     partyName:req.body.partyName,deleted:req.body.deleted,
   },financialYear);
   const {LedgerEntry,BookCorrection,BookCorrectionAudit}=financialModels(tenantKey,financialYear);
   await Promise.all([BookCorrection.init(),BookCorrectionAudit.init()]);
   const previous=await BookCorrection.findOne({tenantKey,financialYear,book,sourceKey}).lean();
   if(req.body.version && previous && new Date(previous.updatedAt).getTime()!==new Date(req.body.version).getTime())
     return fail(res,'Another Superadmin changed this row. Refresh before editing.',409);
   const idPart=sourceKey.replace(/[^a-zA-Z0-9]/g,'-').slice(0,50);
   const bookAccount={accountCode:source.accountCode,ledgerId:source.ledgerId||'',
     bankAccountId:source.bankAccountId||'',partyGlobalId:''};
   const originalNet=Number(current.net||0);
   const targetNet=Number(correction.credit||0)-Number(correction.debit||0);
   const oldDay=new Date(source.originalDate).toISOString().slice(0,10),newDay=correction.date.toISOString().slice(0,10);
   const newId=()=>`ADMIN-${idPart}-${new mongoose.Types.ObjectId().toString()}`;
   const requestedPartyId=cleanText(req.body.partyGlobalId);
   const requestedPartyType=upper(req.body.partyType);
   let newCounter=current.counter;
   let partyName=correction.partyName;
   if(requestedPartyId&&requestedPartyType){
     const party=await resolveVoucherPostingParty(tenantKey,requestedPartyId,requestedPartyType);
     if(party.accountCode==='SYS_CASH'||(book==='BANK'&&party.accountCode===source.accountCode))
       return fail(res,'Choose an actual customer/supplier ledger, not the same Cash/Bank account',400);
     newCounter={accountCode:party.accountCode,ledgerId:party.ledgerId||'',partyGlobalId:party.id,bankAccountId:''};
     partyName=party.name;
   }
   const groups=reclassifiedJournal({oldNet:originalNet,targetNet,oldDate:source.originalDate,newDate:correction.date,
     bookAccount,oldCounter:current.counter,newCounter,tenantKey,financialYear,reason,makeId:newId});
   // Source records may remain statutory/OTP evidence, so corrections are
   // balanced journal adjustments rather than orphaning invoice/cashier data.
   session=await LedgerEntry.db.startSession();
   await session.withTransaction(async()=>{
     const currentCorrection=await BookCorrection.findOne({tenantKey,financialYear,book,sourceKey}).session(session);
     if(String(currentCorrection?.updatedAt||'')!==String(previous?.updatedAt||''))
       throw Object.assign(new Error('This row was corrected by another user; reload first'),{statusCode:409});
     const oldIds=Array.isArray(currentCorrection?.activeJournalTransactionIds)?currentCorrection.activeJournalTransactionIds:[];
     if(oldIds.length){
       const old=await LedgerEntry.find({tenantKey,financialYear,transactionId:{$in:oldIds},status:'POSTED'}).session(session);
       const broken=oldIds.some(id=>{
         const group=old.filter(x=>x.transactionId===id);
         return group.length<2||Math.abs(group.reduce((n,x)=>n+Number(x.debit||0)-Number(x.credit||0),0))>0.005;
       });
       if(broken)throw Object.assign(new Error('Prior correction journal is incomplete or unbalanced; no changes saved'),{statusCode:409});
       for(const line of old){
         const changed=await LedgerEntry.updateOne({_id:line._id,tenantKey,financialYear,status:'POSTED'},
           {$set:{status:'VOIDED',archivedPostingKey:line.archivedPostingKey||line.postingKey||''},$unset:{postingKey:''}},{session});
         if(changed.modifiedCount!==1)throw Object.assign(new Error('Correction journal changed; retry'),{statusCode:409});
       }
     }
     for(const group of groups){
       await LedgerEntry.insertMany(group.lines,{session,ordered:true});
     }
     const next={tenantKey,financialYear,book,sourceKey,bankAccountId:source.bankAccountId,
       ...correction,partyName,partyGlobalId:requestedPartyId||'',partyType:requestedPartyType||'',originalJournalNet:originalNet,
       originalSnapshot:{date:source.originalDate,credit:source.originalCredit,debit:source.originalDebit,
         remarks:source.originalRemarks,partyName:source.originalPartyName,transactionId:source.transactionId,
         transactionType:source.transactionType},
       activeJournalTransactionIds:groups.map(x=>x.id),reason,editedBy:req.auth.sub,
       editedByNameSnapshot:req.auth.name||''};
     if(currentCorrection){
       const update=await BookCorrection.updateOne({_id:currentCorrection._id,updatedAt:currentCorrection.updatedAt},{$set:next},{session});
       if(update.matchedCount!==1)throw Object.assign(new Error('Correction changed; retry'),{statusCode:409});
     }else await BookCorrection.create([next],{session});
     await BookCorrectionAudit.create([{tenantKey,financialYear,book,sourceKey,
       action:correction.deleted?'DELETE':'EDIT',previous:currentCorrection?.toObject()||null,next,
       reason,correctionJournalId:groups.map(x=>x.id).join(','),editedBy:req.auth.sub,
       editedByNameSnapshot:req.auth.name||''}],{session});
   });
   let rebuildWarning='';
   if(book==='BANK'){
     try{await recalculateBankRunningBalancesForVoucher({tenantKey,financialYear,bankAccountId:source.bankAccountId});}
     catch(e){rebuildWarning=`Bank running-balance rebuild needs retry: ${e.message}`;}
   }
   return ok(res,{book,sourceKey,deleted:correction.deleted,adjusted:true,rebuildWarning},
     correction.deleted?'Superadmin removed entry from active book; audit and balanced correction retained':'Book entry and accounting adjustment saved');
 }catch(e){return fail(res,e.message||'Unable to save Superadmin book correction',e.statusCode||400);}
 finally{if(session)await session.endSession();}
});

// Native Excel export (XLSX), authorized with the same ceilings as PDF.
router.post("/export-table-xlsx",async(req,res)=>{
 try{
  const granted=new Set(req.auth?.permissions||[]);
  const authorized=req.auth?.role==="MASTER"||isAdminAuth(req.auth)||granted.has("*")||
    ["dms.finance_reports.bank_statement.view","dms.transaction.cashbook.view","dms.transaction.cashaccount.view"].some(p=>granted.has(p));
  if(!authorized)return fail(res,"Transaction export permission required",403);
  const headers=Array.isArray(req.body.headers)?req.body.headers:[];
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];
  if(!headers.length||headers.length>14||rows.length>5000||!rows.every(r=>Array.isArray(r)&&r.length===headers.length))return fail(res,"Invalid export table or too many rows",400);
  const asText=x=>String(x??"").replace(/[\u0000-\u001f]/g," ").slice(0,350);
  const sheet=XLSX.utils.aoa_to_sheet([headers.map(asText),...rows.map(row=>row.map(asText))]);
  sheet["!cols"]=headers.map((h,i)=>({wch:Math.min(50,Math.max(12,asText(h).length,...rows.slice(0,250).map(row=>asText(row[i]).length)))}));
  const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,sheet,"Transactions");
  const file=XLSX.write(workbook,{type:"buffer",bookType:"xlsx"});
  const name=cleanText(req.body.kind).toLowerCase().replace(/[^a-z0-9-]/g,"-")||"transactions";
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="${name}.xlsx"`);
  return res.send(file);
 }catch(e){return fail(res,e.message||"Excel export failed",400);}
});

// Shared export: the user downloads the filtered table they are viewing.
// PDFKit is already a backend dependency; no additional frontend packages.
router.post("/export-table-pdf",async(req,res)=>{
 try{
  const authorized=req.auth?.role==="MASTER"||isAdminAuth(req.auth)||new Set(req.auth?.permissions||[]).has("*")||
   ["dms.finance_reports.bank_statement.view","dms.transaction.cashbook.view","dms.transaction.cashaccount.view"]
    .some(p=>(req.auth?.permissions||[]).includes(p));
  if(!authorized)return fail(res,"Transaction export permission required",403);
  const kind=cleanText(req.body.kind).slice(0,70),scope=cleanText(req.body.scope).slice(0,110);
  const headers=Array.isArray(req.body.headers)?req.body.headers.slice(0,14).map(x=>cleanText(x).slice(0,100)):[];
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];
  if(!headers.length||headers.length>14||rows.length>5000||!rows.every(r=>Array.isArray(r)&&r.length===headers.length))return fail(res,"Invalid export table or too many rows",400);
  const printable=x=>String(x??"").replace(/₹/g,"Rs. ").replace(/[\u0000-\u001f]/g," ").slice(0,350);
  const doc=new PDFDocument({size:"A4",layout:"landscape",margin:30,bufferPages:true});
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`attachment; filename="${kind.toLowerCase().replace(/[^a-z0-9-]/g,"-")||"transactions"}.pdf"`);
  doc.pipe(res);
  const left=30,w=(doc.page.width-60)/headers.length,rowHeight=24;
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#101827").text(`${printable(kind)} | ${printable(scope)}`);
  doc.moveDown(0.5);
  let y=doc.y;
  const drawHeading=()=>{
   doc.font("Helvetica-Bold").fontSize(8);
   headers.forEach((h,i)=>{doc.rect(left+i*w,y,w,rowHeight).fillAndStroke("#e8eef5","#cbd5e1");doc.fillColor("#111827").text(printable(h),left+i*w+3,y+5,{width:w-6,height:rowHeight-8,align:"center",ellipsis:true});});
   y+=rowHeight;
  };
  drawHeading();
  for(const [index,row] of rows.entries()){
   if(y+rowHeight>doc.page.height-37){doc.addPage();y=35;drawHeading();}
   doc.font("Helvetica").fontSize(7).fillColor("#111827");
   for(let i=0;i<headers.length;i++){
    doc.rect(left+i*w,y,w,rowHeight).fillAndStroke(index%2?"#f8fafc":"#ffffff","#e2e8f0");
    doc.fillColor("#111827").text(printable(row[i]),left+i*w+3,y+4,{width:w-6,height:rowHeight-7,align:"center",ellipsis:true});
   }
   y+=rowHeight;
  }
  doc.end();
 }catch(e){if(!res.headersSent)return fail(res,e.message||"PDF export failed",400);res.end();}
});

// Company CASH book: source-voucher cash movement projection, never BANK.
// FY closing rolls to the next year; date filters return their own opening
// and closing after the complete FY movements have been projected.
router.get("/cashbook/latest-month",async(req,res)=>{
  if(!canViewCompanyCashbook(req.auth))return fail(res,"Missing cashbook view permission",403);
  try{
    const financialYear=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.query.financialYear});
    if(!await financialCollectionExists(req.auth.tenantKey,financialYear,"ledgerentries"))
      return ok(res,{financialYear,month:null});
    const {LedgerEntry}=financialModels(req.auth.tenantKey,financialYear);
    const row=await LedgerEntry.findOne({tenantKey:req.auth.tenantKey,financialYear,status:"POSTED",accountCode:"SYS_CASH"}).sort({date:-1,_id:-1}).select("date").lean();
    return ok(res,{financialYear,month:row?.date?new Date(row.date).getUTCMonth()+1:null});
  }catch(e){return fail(res,e.message||"Could not determine cash month",400);}
});


router.get('/cashbook/financial-years',async(req,res)=>{
  if(!canViewCompanyCashbook(req.auth))return fail(res,'Missing cashbook view permission',403);
  try{
    const tenantKey=req.auth.tenantKey;
    const profile=await CompanyProfile.findOne({tenantKey})
      .select('financialYears financialYear firstCashFinancialYear').lean();
    const discovery=await discoverFinancialYears({tenantKey,configured:profile?.financialYears||[]});
    return ok(res,{years:fiscalYearCandidates({
      configured:[...(profile?.financialYears||[]),profile?.financialYear],
      discovered:discovery.discovered,opening:profile?.firstCashFinancialYear,
    }),firstDataFinancialYear:discovery.firstDataFinancialYear});
  }catch(e){return fail(res,e.message||'Unable to load financial years',500);}
});

router.get("/cashbook", async (req, res) => {
 if(!canViewCompanyCashbook(req.auth))return fail(res,"Missing cashbook view permission",403);
 try{
  const tenantKey=req.auth.tenantKey;
  const financialYear=await resolveFinancialYear({tenantKey,requested:req.query.financialYear});
  // Year opening comes from the preceding Cashbook closing, not merely the
  // posted journal sum (some legacy cash vouchers cancelled themselves).
  const carry=await companyCashbookYearOpening({tenantKey,financialYear});
  const openingBalance=carry.openingBalance;
  const from=String(req.query.fromDate||""),to=String(req.query.toDate||"");
  const hasLedger=await financialCollectionExists(tenantKey,financialYear,"ledgerentries");
  const fy=financialModels(tenantKey,financialYear),{LedgerEntry}=fy;
  const lines=hasLedger?await LedgerEntry.find({tenantKey,financialYear,status:"POSTED",accountCode:"SYS_CASH",transactionType:{$ne:"SUPERADMIN_BOOK_ADJUSTMENT"}})
   .select("_id transactionId transactionType date createdAt partyGlobalId debit credit narration")
   .sort({date:1,createdAt:1,_id:1}).lean():[];
  const sources=await loadCompanyCashbookSources({tenantKey,financialYear,lines});
  const book=buildCompanyCashbook({lines,...sources,openingBalance,enforceSourceDocuments:true});
  const corrections=await fy.BookCorrection.find({tenantKey,financialYear,book:'CASH'}).lean();
  const adjusted=applyCashCorrections(book.rows,corrections,openingBalance);
  const period=cashbookPeriodSnapshot({rows:adjusted.rows,openingBalance,fromDate:from,toDate:to});
  const type=upper(req.query.type),category=upper(req.query.category),q=cleanText(req.query.q).toLowerCase();
  // Month date filtering happens BEFORE type/search filtering; that way
  // period opening/closing always includes every real cash movement.
  const filtered=period.periodRows.filter(x=>{
   if(category && category!=="ALL" && upper(x.category)!==category)return false;
   if(type==="REVIEW"&&!x.needsCorrection)return false;
   if(["RECEIPT","PAYMENT"].includes(type)&&x.type!==type)return false;
   if(q&&!`${x.particular} ${x.transactionId} ${x.remarks} ${x.partyName}`.toLowerCase().includes(q))return false;
   return true;
  }).reverse();
  const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(200,Math.max(1,Number(req.query.limit)||50));
  const adminJournalLines=hasLedger?await LedgerEntry.find({tenantKey,financialYear,status:'POSTED',accountCode:'SYS_CASH',transactionType:'SUPERADMIN_BOOK_ADJUSTMENT'}).select('debit credit').lean():[];
  const sumJournalMovement=[...lines,...adminJournalLines].reduce((n,x)=>n+Number(x.debit||0)-Number(x.credit||0),0);
  return ok(res,{items:filtered.slice((page-1)*limit,page*limit),meta:pageMeta(page,limit,filtered.length),
   financialYear,openingBalance,...Object.fromEntries(Object.entries(period).filter(([key])=>key!=="periodRows")),
   monthlySummaries:req.query.groupByMonth==="1"?buildBookMonthSummary({financialYear,openingBalance,rows:adjusted.rows}):undefined,
   closingBalance:adjusted.closingBalance,categoryTotals:adjusted.categoryTotals,
   openingSource:carry.openingSource,openingNeedsSetup:carry.openingNeedsSetup,
   journalOpeningBalance:carry.journalOpeningBalance,
   journalClosingBalance:Math.round((carry.journalOpeningBalance+sumJournalMovement)*100)/100,
   provisional:book.provisional||carry.provisional,
   invalidCashVoucherCount:book.issues.length+carry.priorYearIssues,
   invalidCashVouchers:book.issues.slice(0,30),rolloverIssues:carry.priorYearIssues,
   manualOpeningConflicts:carry.mismatchedManualOpenings,
   rolloverFromFY:carry.rolloverFromFY
  });
 }catch(e){return fail(res,e.message||"Unable to load cashbook",e.statusCode||400);}
});

// Channel-scoped direct vouchers. We enforce CASH/BANK on the server rather
// than trusting form fields or spreadsheet modes. Existing receipt/payment
// creation and bank-statement upload endpoints are deliberately untouched.
async function postManualTransactionVoucher({auth,channel,input,recalculate=true}){
  const tenantKey=auth.tenantKey;
  const mode=channel==="cash"?"CASH":"BANK";
  const transactionType=upper(input.transactionType||input.type);
  if(!["RECEIPT","PAYMENT"].includes(transactionType))throw Object.assign(new Error("Transaction Mode must be Receipt or Payment"),{statusCode:400});
  if(!canManualVoucherAction(auth,channel,transactionType))throw Object.assign(new Error("Missing permission to create this receipt/payment"),{statusCode:403});
  if(input.mode&&upper(input.mode)!==mode)throw Object.assign(new Error(`This page accepts ${mode} entries only`),{statusCode:400});
  const date=parseStrictVoucherDate(input.date);
  const financialYear=financialYearFromDate(date);
  const amount=Number(input.amount);
  if(!Number.isFinite(amount)||amount<=0)throw Object.assign(new Error("Amount must be greater than zero"),{statusCode:400});
  let party;
  const rawParty=input.partyGlobalId||input.party||input.partyName;
  try{party=await resolveVoucherPostingParty(tenantKey,rawParty,input.partyType);}
  catch(error){
    // Superadmin bulk uploads must post immediately. If a legitimate party
    // cannot be identified uniquely, preserve the name and post the OTHER
    // counter-entry to SYS_SUSPENSE rather than discarding a cash/bank row.
    // Direct form entry and non-Superadmin uploads keep strict validation.
    const canSuspend=auth.role==='SUPERADMIN'&&input.source==='SUPERADMIN_BULK'
      && !input.partyGlobalId && cleanText(rawParty)&&upper(rawParty)!=='CASH'
      && /not found|matches multiple/i.test(String(error.message||''));
    if(!canSuspend)throw error;
    party=await resolveVoucherPostingParty(tenantKey,rawParty,'OTHER');
  }
  const bank=await resolveTransactionBank(tenantKey,mode,channel==="bank"?input.bankAccountId:"");
  if(channel==="bank"&&!bank.bankAccountId)throw Object.assign(new Error("Select an active Bank Account"),{statusCode:400});
  const {Receipt,Payment}=financialModels(tenantKey,financialYear);
  const isReceipt=transactionType==="RECEIPT";
  const Model=isReceipt?Receipt:Payment;
  const noField=isReceipt?"receiptNo":"paymentNo";
  const voucherNo=cleanText(input[noField])||makeId(isReceipt?"RCT":"PAY");
  if(await Model.exists({tenantKey,financialYear,[noField]:voucherNo}))throw Object.assign(new Error("Voucher number already exists in this FY"),{statusCode:409});
  const entry={tenantKey,financialYear,[noField]:voucherNo,sourceKey:voucherNo,date,
    partyType:party.type,partyNameSnapshot:party.name,amount,mode,remarks:cleanText(input.remarks),
    bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,status:"POSTED",
    createdBy:auth.sub,createdByNameSnapshot:auth.name||"",reference:""};
  const record=await Model.create(isReceipt?{
    ...entry,customerGlobalId:party.id,bounceStatus:"CLEAR",receiptWorkflowStatus:"DMS_DIRECT",
    customerOtpStatus:"NOT_REQUIRED",cashierOtpStatus:"NOT_REQUIRED",ledgerPostedAt:new Date(),
  }:{...entry,partyGlobalId:party.id});
  const cashBankLine={accountCode:bank.accountCode,ledgerId:bank.ledgerId,bankAccountId:bank.bankAccountId};
  const partyLine={accountCode:party.accountCode,ledgerId:party.ledgerId};
  try{
    await postBalancedEntries({tenantKey,financialYear,transactionId:voucherNo,transactionType,date,
      partyGlobalId:party.id,narration:entry.remarks||`${transactionType} ${voucherNo}`,
      entries:isReceipt?[{...cashBankLine,debit:amount},{...partyLine,credit:amount}]
                       :[{...partyLine,debit:amount},{...cashBankLine,credit:amount}],
    });
  }catch(e){await record.deleteOne();throw e;}
  let balanceWarning="";
  if(recalculate&&channel==="bank"){
    try{await recalculateBankRunningBalancesForVoucher({tenantKey,financialYear,bankAccountId:bank.bankAccountId});}
    catch(e){balanceWarning=e.message;}
  }
  return {record:record.toObject(),financialYear,bankAccountId:bank.bankAccountId,balanceWarning};
}

router.post("/manual-entry/:channel",async(req,res)=>{
  try{
    const channel=String(req.params.channel||"").toLowerCase();
    if(!["cash","bank"].includes(channel))return fail(res,"Invalid transaction channel",400);
    const result=await postManualTransactionVoucher({auth:req.auth,channel,input:{...req.body,source:undefined}});
    return ok(res,result,"Transaction posted",201);
  }catch(e){return fail(res,e.message||"Could not post transaction",e.statusCode||400);}
});

// Edit DMS DIRECT vouchers in-place atomically with their two posted journal
// lines. Import rows, OTP-controlled collections and contra are not direct
// vouchers and MUST NOT be silently reclassified from these screens.
const voucherKindInfo=(name)=>({receipts:{number:"receiptNo",party:"customerGlobalId",type:"RECEIPT"},payments:{number:"paymentNo",party:"partyGlobalId",type:"PAYMENT"}})[String(name||"").toLowerCase()];
const voucherDirectEditable=(record,kind)=>Boolean(record&&record.status==="POSTED"&&!record.statementImportId&&record.sourceKey&&
  (kind==="payments"||(record.receiptWorkflowStatus==="DMS_DIRECT"&&!record.collectedBySalespersonId&&!record.cashCustodyMovementId)));
const canViewVoucherEditor=(auth)=>{
  const granted=new Set(auth?.permissions||[]);
  if(auth?.role==="MASTER"||granted.has("*"))return true;
  return granted.has("dms.transaction.voucher_edit.view") &&
    granted.has("dms.transaction.voucher_edit.edit");
};
const canEditDirectVoucher=(auth,kind,mode)=>{
  if(!canViewVoucherEditor(auth))return false;
  const channel=mode==="CASH"?"cash":"bank";
  // Require type/book-specific Edit, not generic admin status or unrelated View.
  return canManualVoucherAction(auth,channel,kind==="receipts"?"RECEIPT":"PAYMENT","edit");
};
const voucherEditReject=(record,kind)=>{
  if(!record)return "Voucher not found";
  if(!voucherDirectEditable(record,kind))return "This voucher is imported, OTP-controlled, externally linked, or not a posted direct voucher. Reconcile it through its original workflow.";
  return "";
};

// Delete in the books means VOID a DIRECT DMS voucher, retaining the source
// document and its balanced journal for audit. An already-posted voucher must
// never be removed on one side only. Imported statements, salesperson/OTP
// receipts and internal contras must use their source workflows.
// CASH BOOK: delete a checkbox selection in one MongoDB transaction. This is
// deliberately a VOID (not a hard delete): financial reports, source vouchers
// and journal history must not be orphaned. Nothing is changed if any selected
// row is ineligible or changes concurrently.
router.post("/cashbook/bulk-void",async(req,res)=>{
  if(!canViewCompanyCashbook(req.auth))return fail(res,"Missing Cashbook view permission",403);
  const reason=cleanText(req.body?.reason);
  if(reason.length<5)return fail(res,"Provide a deletion reason of at least 5 characters",400);
  let selected;
  try{selected=normalizeCashbookBulkVoidSelection(req.body?.items);}
  catch(e){return fail(res,e.message,e.statusCode||400);}
  let session;
  try{
    const tenantKey=req.auth.tenantKey;
    const financialYear=await resolveFinancialYear({tenantKey,requested:req.body.financialYear});
    const {Receipt,Payment,LedgerEntry}=financialModels(tenantKey,financialYear);
    const verified=[];
    // Preflight every selection before the first write (no partial success).
    for(const item of selected){
      const info=voucherKindInfo(item.kind);
      const Model=item.kind==="receipts"?Receipt:Payment;
      const record=await Model.findOne({_id:item.id,tenantKey,financialYear}).lean();
      const rejection=voucherEditReject(record,item.kind);
      if(rejection)return fail(res,`${item.kind}/${item.id}: ${rejection}`,record?409:404);
      if(upper(record.mode)!=="CASH")return fail(res,`Voucher ${record[info.number]} is not a CASH transaction`,409);
      if(!canManualVoucherAction(req.auth,"cash",info.type,"delete"))
        return fail(res,`Missing delete permission for ${info.type}`,403);
      if((record.againstInvoices||[]).length||record.cashDepositBatchId||record.cashCustodyMovementId)
        return fail(res,`Voucher ${record[info.number]} has invoice or cash handover dependencies`,409);
      const journal=await LedgerEntry.find({tenantKey,financialYear,transactionId:record[info.number],status:"POSTED"}).lean();
      if(journal.length!==2||journal.some(line=>upper(line.transactionType)!==info.type)||
        !journal.some(line=>line.accountCode==="SYS_CASH"))
        return fail(res,`Voucher ${record[info.number]} must have two normal journal lines including Cash-in-Hand; reconcile it before deletion`,409);
      verified.push({Model,info,record,journal});
    }
    session=await mongoose.startSession();
    await session.withTransaction(async()=>{
      for(const {Model,record,journal,info} of verified){
        const changed=await Model.updateOne({_id:record._id,tenantKey,financialYear,status:"POSTED"},
          {$set:{status:"VOIDED",voidReason:reason,voidedAt:new Date(),voidedBy:req.auth.sub,
            voidedByNameSnapshot:req.auth.name||""}},{session});
        if(changed.modifiedCount!==1)throw Object.assign(new Error(`Voucher ${record[info.number]} changed during deletion; none were voided`),{statusCode:409});
        const result=await LedgerEntry.bulkWrite(journal.map(line=>({updateOne:{
          filter:{_id:line._id,tenantKey,financialYear,status:"POSTED"},
          update:{$set:{status:"VOIDED",archivedPostingKey:line.archivedPostingKey||line.postingKey||""},$unset:{postingKey:""}},
        }})),{session,ordered:true});
        if(result.modifiedCount!==journal.length)throw Object.assign(new Error(`Journal for ${record[info.number]} changed; none were voided`),{statusCode:409});
      }
    });
    return ok(res,{voided:verified.length,deleted:verified.length,financialYear},`${verified.length} Cashbook voucher(s) voided; audit history retained`);
  }catch(e){return fail(res,e.message||"Unable to bulk delete Cashbook vouchers",e.statusCode||400);}
  finally{if(session)await session.endSession();}
});

router.post("/vouchers/:kind/:id/void",async(req,res)=>{
  const kind=String(req.params.kind||"").toLowerCase(),info=voucherKindInfo(kind);
  if(!info)return fail(res,"Unknown voucher type",400);
  const reason=cleanText(req.body.reason);
  if(reason.length<5)return fail(res,"Enter a deletion reason (at least 5 characters)",400);
  let session;
  try{
    const tenantKey=req.auth.tenantKey;
    const financialYear=await resolveFinancialYear({tenantKey,requested:req.body.financialYear});
    const {Receipt,Payment,LedgerEntry}=financialModels(tenantKey,financialYear);
    const Model=kind==="receipts"?Receipt:Payment;
    const record=await Model.findOne({_id:req.params.id,tenantKey,financialYear}).lean();
    const rejection=voucherEditReject(record,kind);
    if(rejection)return fail(res,rejection,record?409:404);
    const channel=upper(record.mode)==="CASH"?"cash":"bank";
    if(!canManualVoucherAction(req.auth,channel,info.type,"delete"))return fail(res,"Missing delete permission for this transaction",403);
    if((record.againstInvoices||[]).length || record.cashDepositBatchId || record.cashCustodyMovementId)
      return fail(res,"Voucher has invoice allocation or cash handover dependencies. Reconcile through original workflow.",409);
    const journal=await LedgerEntry.find({tenantKey,financialYear,transactionId:record[info.number],status:"POSTED"}).lean();
    if(journal.length!==2||journal.some(line=>line.transactionType!==info.type))
      return fail(res,"Voucher journal must contain exactly two normal posted lines. Reconcile before deletion.",409);
    session=await mongoose.startSession();
    await session.withTransaction(async()=>{
      const changed=await Model.updateOne({_id:record._id,tenantKey,financialYear,status:"POSTED"},{$set:{
        status:"VOIDED",voidReason:reason,voidedAt:new Date(),voidedBy:req.auth.sub,
        voidedByNameSnapshot:req.auth.name||"",
      }},{session});
      if(changed.modifiedCount!==1)throw Object.assign(new Error("Voucher was already changed. Refresh and retry."),{statusCode:409});
      const operations=journal.map(line=>({updateOne:{
        filter:{_id:line._id,tenantKey,financialYear,status:"POSTED"},
        update:{$set:{status:"VOIDED",archivedPostingKey:line.archivedPostingKey||line.postingKey||""},$unset:{postingKey:""}},
      }}));
      const updated=await LedgerEntry.bulkWrite(operations,{session,ordered:true});
      if(updated.modifiedCount!==journal.length)throw Object.assign(new Error("Journal changed during deletion. Retry."),{statusCode:409});
    });
    if(channel==="bank"&&record.bankAccountId)
      await recalculateBankRunningBalancesForVoucher({tenantKey,financialYear,bankAccountId:record.bankAccountId});
    return ok(res,{voucherNo:record[info.number],voided:true},"Transaction voided and removed from active Bank/Cash books; audit retained");
  }catch(e){return fail(res,e.message||"Unable to delete voucher safely",e.statusCode||400);}
  finally{if(session)await session.endSession();}
});

router.get("/vouchers/:kind/:id/edit",async(req,res)=>{
  try{
    const kind=String(req.params.kind||"").toLowerCase(),info=voucherKindInfo(kind);
    if(!info)return fail(res,"Unknown voucher type",400);
    if(!canViewVoucherEditor(req.auth))return fail(res,"Edit Posted Voucher permission required",403);
    const financialYear=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.query.financialYear});
    const {Receipt,Payment,LedgerEntry}=financialModels(req.auth.tenantKey,financialYear);
    const Model=kind==="receipts"?Receipt:Payment;
    const record=await Model.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear}).lean();
    const reason=voucherEditReject(record,kind);
    if(reason)return fail(res,reason,record?409:404);
    if(!canEditDirectVoucher(req.auth,kind,upper(record.mode)==="CASH"?"CASH":"BANK"))return fail(res,"Missing edit permission",403);
    const journal=await LedgerEntry.find({tenantKey:req.auth.tenantKey,financialYear,transactionId:record[info.number],status:"POSTED"}).lean();
    if(journal.length!==2||journal.some(line=>line.transactionType!==info.type))return fail(res,"Voucher journal is not a normal two-line DMS posting. Contact accounts administrator.",409);
    return ok(res,{voucher:record,kind,financialYear});
  }catch(e){return fail(res,e.message||"Unable to fetch voucher",e.statusCode||400);}
});

// Editing a voucher's calendar date is also allowed across financial years.
// Every FY lives in a separate database. Therefore the voucher, both journal
// lines and the immutable audit must move together in ONE MongoDB transaction.
// Do not use a delete/recreate pair outside the transaction: it can leave an
// orphaned payment or unbalanced cash/bank ledger if the server crashes.
router.put("/vouchers/:kind/:id/edit",async(req,res)=>{
  const kind=String(req.params.kind||"").toLowerCase(),info=voucherKindInfo(kind);
  if(!info)return fail(res,"Unknown voucher type",400);
  if(!canViewVoucherEditor(req.auth))return fail(res,"Edit Posted Voucher permission required",403);
  const reason=cleanText(req.body.reason);
  if(reason.length<5)return fail(res,"Enter a reason for this accounting correction (minimum 5 characters)",400);
  let session;
  try{
    const tenantKey=req.auth.tenantKey;
    // The source FY is only used to locate the existing voucher; it is not an
    // editable field. The NEW financial year comes exclusively from its date.
    const sourceFy=await resolveFinancialYear({tenantKey,requested:req.body.financialYear});
    const date=parseStrictVoucherDate(req.body.date);
    const destinationFy=financialYearFromDate(date);
    const amount=Number(req.body.amount);
    if(!Number.isFinite(amount)||amount<=0||Math.abs(Math.round(amount*100)-amount*100)>1e-7)
      return fail(res,"Enter an amount greater than zero with at most 2 decimal places",400);

    const source=financialModels(tenantKey,sourceFy);
    const destination=destinationFy===sourceFy?source:financialModels(tenantKey,destinationFy);
    const SourceModel=kind==="receipts"?source.Receipt:source.Payment;
    const DestinationModel=kind==="receipts"?destination.Receipt:destination.Payment;
    const original=await SourceModel.findOne({_id:req.params.id,tenantKey,financialYear:sourceFy}).lean();
    const reject=voucherEditReject(original,kind);
    if(reject)return fail(res,reject,original?409:404);
    if(!canEditDirectVoucher(req.auth,kind,upper(original.mode)==="CASH"?"CASH":"BANK"))return fail(res,"Missing edit permission",403);

    const nextMode=upper(req.body.mode||original.mode);
    if(!["CASH","BANK","NEFT","RTGS","UPI","CHEQUE"].includes(nextMode))return fail(res,"Invalid payment mode",400);
    if(!canEditDirectVoucher(req.auth,kind,nextMode==="CASH"?"CASH":"BANK"))return fail(res,"Missing edit permission for destination book",403);
    const nextNumber=cleanText(req.body.voucherNo??original[info.number]);
    if(!/^[a-z0-9][a-z0-9\/_-]{0,79}$/i.test(nextNumber))return fail(res,"Voucher Number must contain 1-80 letters, digits, /, _ or -",400);

    const party=await resolveVoucherPostingParty(tenantKey,req.body.partyGlobalId||req.body.partyName,req.body.partyType||original.partyType);
    const bank=await resolveTransactionBank(tenantKey,nextMode,req.body.bankAccountId);
    const nextData={date,amount,mode:nextMode,partyType:party.type,partyNameSnapshot:party.name,
      [info.number]:nextNumber,sourceKey:nextNumber,[info.party]:party.id,
      bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,
      remarks:cleanText(req.body.remarks),reference:cleanText(req.body.reference),
      runningBalance:null};
    const newLines=kind==="receipts"
      ?[{accountCode:bank.accountCode,ledgerId:bank.ledgerId,bankAccountId:bank.bankAccountId,debit:amount,credit:0},
        {accountCode:party.accountCode,ledgerId:party.ledgerId,bankAccountId:"",debit:0,credit:amount}]
      :[{accountCode:party.accountCode,ledgerId:party.ledgerId,bankAccountId:"",debit:amount,credit:0},
        {accountCode:bank.accountCode,ledgerId:bank.ledgerId,bankAccountId:bank.bankAccountId,debit:0,credit:amount}];
    if(newLines[0].accountCode===newLines[1].accountCode&&String(newLines[0].ledgerId||"")===String(newLines[1].ledgerId||""))
      return fail(res,"Counterparty cannot be the same Cash/Bank account; choose the actual party",400);

    // Ensure indexes are present *before* entering the MongoDB transaction.
    if(sourceFy!==destinationFy){
      await Promise.all([DestinationModel.init(),destination.LedgerEntry.init(),destination.VoucherEditAudit.init()]);
    }
    session=await SourceModel.db.startSession();
    await session.withTransaction(async()=>{
      const record=await SourceModel.findOne({_id:req.params.id,tenantKey,financialYear:sourceFy}).session(session);
      if(voucherEditReject(record,kind))throw Object.assign(new Error("Voucher status changed; reload and retry"),{statusCode:409});
      if(!req.body.version||new Date(record.updatedAt).getTime()!==new Date(req.body.version).getTime())
        throw Object.assign(new Error("Voucher changed since you opened it. Reload before saving"),{statusCode:409});
      const oldLines=await source.LedgerEntry.find({tenantKey,financialYear:sourceFy,transactionId:record[info.number],status:"POSTED"}).sort({_id:1}).session(session);
      if(oldLines.length!==2||oldLines.some(x=>x.transactionType!==info.type))
        throw Object.assign(new Error("Non-standard or previously altered journal; editing blocked"),{statusCode:409});
      const debitLine=oldLines.find(x=>Number(x.debit)>0),creditLine=oldLines.find(x=>Number(x.credit)>0);
      if(!debitLine||!creditLine||Math.abs(Number(debitLine.debit)-Number(creditLine.credit))>0.005||
        Math.abs(Number(debitLine.debit)-Number(record.amount))>0.005)
        throw Object.assign(new Error("Voucher and journal do not reconcile; edit blocked"),{statusCode:409});

      // A new FY or voucher number must not reuse another active voucher or
      // journal's transactionId. The old record is excluded for same-FY edits.
      if(destinationFy!==sourceFy||nextNumber!==record[info.number]){
        const found=await DestinationModel.findOne({tenantKey,financialYear:destinationFy,[info.number]:nextNumber}).session(session).lean();
        if(found&&String(found._id)!==String(record._id))
          throw Object.assign(new Error("Voucher Number already exists for the selected date's financial year"),{statusCode:409});
        const existingJournal=await destination.LedgerEntry.findOne({tenantKey,financialYear:destinationFy,transactionId:nextNumber,status:"POSTED"}).session(session).lean();
        if(existingJournal && !(destinationFy===sourceFy && oldLines.some(x=>String(x._id)===String(existingJournal._id)))){
          throw Object.assign(new Error("Voucher Number is already used by another posted journal in the selected financial year"),{statusCode:409});
        }
      }
      const posting=[debitLine,creditLine];
      const narration=nextData.remarks||`${info.type} ${nextNumber}`;
      const newAuditLines=newLines.map((line,i)=>({
        ...line,tenantKey,financialYear:destinationFy,transactionId:nextNumber,
        partyGlobalId:party.id,date,narration,transactionType:info.type,status:"POSTED",
      }));
      // Keep deterministic journal posting keys consistent with the new FY/No.
      const journalUpdates=newAuditLines.map((line,i)=>({
        ...line,postingKey:createHash("sha256").update(
          JSON.stringify([tenantKey,destinationFy,nextNumber,info.type,i]),
        ).digest("hex"),
      }));
      const nextVersion={...record.toObject(),...nextData,financialYear:destinationFy};

      if(destinationFy===sourceFy){
        for(let i=0;i<posting.length;i++){
          const line=journalUpdates[i];
          await source.LedgerEntry.updateOne({_id:posting[i]._id,tenantKey,financialYear:sourceFy,status:"POSTED"},{$set:line},{session});
        }
        const result=await SourceModel.updateOne({_id:record._id,tenantKey,financialYear:sourceFy,updatedAt:record.updatedAt},{$set:nextData},{session,timestamps:true});
        if(result.matchedCount!==1)throw Object.assign(new Error("Voucher changed; reload before saving"),{statusCode:409});
      }else{
        // Cross-database atomic move, preserving the voucher ID for any
        // external references and preserving its original creation details.
        await DestinationModel.create([{...nextVersion,updatedAt:new Date()}],{session});
        await destination.LedgerEntry.insertMany(posting.map((old,i)=>({
          ...old.toObject(),...journalUpdates[i],_id:old._id,
        })),{session,ordered:true});
        const removed=await SourceModel.deleteOne({_id:record._id,tenantKey,financialYear:sourceFy,updatedAt:record.updatedAt},{session});
        if(removed.deletedCount!==1)throw Object.assign(new Error("Voucher changed; reload before saving"),{statusCode:409});
        const removedJournal=await source.LedgerEntry.deleteMany({_id:{$in:posting.map(x=>x._id)},tenantKey,financialYear:sourceFy,status:"POSTED"},{session});
        if(removedJournal.deletedCount!==2)throw Object.assign(new Error("Journal changed; edit aborted"),{statusCode:409});
      }
      const audit={tenantKey,financialYear:sourceFy,voucherKind:kind,voucherId:String(record._id),
        voucherNo:record[info.number],previous:record.toObject(),next:nextVersion,
        previousJournal:posting.map(x=>x.toObject()),nextJournal:newAuditLines,
        reason,editedBy:req.auth.sub,editedByNameSnapshot:req.auth.name||"",editedAt:new Date()};
      await source.VoucherEditAudit.create([audit],{session});
      if(destinationFy!==sourceFy)await destination.VoucherEditAudit.create([{
        ...audit,financialYear:destinationFy,voucherNo:nextNumber,
      }],{session});
    });

    let balanceWarning="";
    const affected=new Set([
      [sourceFy,original.bankAccountId].join("|"),
      [destinationFy,bank.bankAccountId].join("|"),
    ]);
    for(const item of affected){
      const [fy,accountId]=item.split("|");
      if(!accountId)continue;
      try{await recalculateBankRunningBalancesForVoucher({tenantKey,financialYear:fy,bankAccountId:accountId});}
      catch(e){balanceWarning+=`${balanceWarning ? "; " : ""}Bank ${accountId} FY ${fy}: ${e.message}`;}
    }
    return ok(res,{financialYear:destinationFy,previousFinancialYear:sourceFy,
      number:nextNumber,movedToDifferentYear:destinationFy!==sourceFy,balanceWarning},
      "Posted voucher and accounting journal corrected");
  }catch(e){
    const unsupported=/Transaction numbers are only allowed on a replica set|replica set|mongos|does not support retryable writes|Transaction is not supported/i.test(e.message||"");
    return fail(res,unsupported?"Safe editing requires MongoDB transactions (replica set or Atlas). No accounting changes were saved.":e.message||"Unable to update voucher",unsupported?503:e.statusCode||400);
  }finally{if(session)await session.endSession();}
});

// Inter-bank transfer is ONE internal contra with a debit to the destination
// bank ASSET ledger and a credit to the source bank ASSET ledger. Bank-book
// display uses the opposite movement column convention (source=Debit/out,
// destination=Credit/in). Never create customer receipts or payments here.
router.post("/bank-transfer", async(req,res)=>{
  try{
    if(!isAdminAuth(req.auth) && !(canManualVoucherAction(req.auth,"bank","RECEIPT") && canManualVoucherAction(req.auth,"bank","PAYMENT")))
      return fail(res,"Bank receipt and payment permissions are required for internal transfer",403);
    const tenantKey=req.auth.tenantKey;
    const date=parseStrictVoucherDate(req.body.date);
    const financialYear=financialYearFromDate(date);
    const amount=money2(req.body.amount);
    if(!Number.isFinite(Number(req.body.amount))||amount<=0)return fail(res,"Transfer amount must be greater than zero",400);
    if(Math.abs(Number(req.body.amount)-amount)>0.000001)return fail(res,"Amount cannot have more than two decimal places",400);
    const fromInput=cleanText(req.body.fromBankAccountId),toInput=cleanText(req.body.toBankAccountId);
    if(!fromInput||!toInput)return fail(res,"Select both source and destination bank accounts",400);
    const [fromBank,toBank]=await Promise.all([
      resolveTransactionBank(tenantKey,"BANK",fromInput),
      resolveTransactionBank(tenantKey,"BANK",toInput),
    ]);
    if(fromBank.bankAccountId===toBank.bankAccountId)return fail(res,"Source and destination must be different bank accounts",400);
    const transferNo=cleanText(req.body.transferNo)||makeId("BTR");
    if(!/^[A-Za-z0-9_-]{4,80}$/.test(transferNo))return fail(res,"Invalid transfer reference",400);
    const reference=cleanText(req.body.reference),remarks=cleanText(req.body.remarks)||"Transfer between company bank accounts";
    const {BankTransfer,LedgerEntry}=financialModels(tenantKey,financialYear);
    let record=await BankTransfer.findOne({tenantKey,financialYear,transferNo});
    // Different transactions MAY share a bank, date and amount. For example,
    // a returned cheque, its reversal and a subsequent fresh payment are three
    // legitimate movements. Date+amount is not a transaction identity.
    // Duplicate prevention is instead enforced by transferNo (unique for FY)
    // and the immutable posted journal idempotency in postBalancedEntries().
    if(record){
      const equal=String(record.fromBankAccountId)===fromBank.bankAccountId && String(record.toBankAccountId)===toBank.bankAccountId &&
        Math.abs(Number(record.amount)-amount)<0.005 &&
        new Date(record.date).getTime()===date.getTime() &&
        cleanText(record.reference)===reference && cleanText(record.remarks)===remarks;
      if(!equal)return fail(res,"Transfer reference already exists with different details; no duplicate posted",409);
      if(record.status==="POSTED")return ok(res,{transferNo,financialYear,alreadyPosted:true},"Transfer already posted; duplicate prevented");
    }else{
      try{
        record=await BankTransfer.create({tenantKey,financialYear,transferNo,date,
          fromBankAccountId:fromBank.bankAccountId,toBankAccountId:toBank.bankAccountId,
          fromBankNameSnapshot:fromBank.bankName,toBankNameSnapshot:toBank.bankName,
          amount,reference,remarks,status:"PENDING_POST",
          createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
      }catch(e){if(e.code===11000)return fail(res,"Transfer reference already exists. Reload before retrying",409);throw e;}
    }
    try{
      await postBalancedEntries({tenantKey,financialYear,transactionId:transferNo,
        transactionType:"BANK_TRANSFER",date,partyGlobalId:"BANK:INTERNAL",narration:remarks,
        entries:[
          {accountCode:toBank.accountCode,ledgerId:toBank.ledgerId,bankAccountId:toBank.bankAccountId,debit:amount,credit:0},
          {accountCode:fromBank.accountCode,ledgerId:fromBank.ledgerId,bankAccountId:fromBank.bankAccountId,debit:0,credit:amount},
        ],
      });
      record.status="POSTED";
      await record.save();
    }catch(e){
      const hasPosted=await LedgerEntry.exists({tenantKey,financialYear,transactionId:transferNo,status:"POSTED"});
      if(!hasPosted && record?.status==="PENDING_POST")await BankTransfer.deleteOne({_id:record._id,status:"PENDING_POST"});
      throw e;
    }
    const warnings=[];
    for(const bankAccountId of [fromBank.bankAccountId,toBank.bankAccountId]){
      try{await recalculateBankRunningBalancesForVoucher({tenantKey,financialYear,bankAccountId});}
      catch(e){warnings.push(`${bankAccountId}: ${e.message}`);}
    }
    return ok(res,{transferNo,financialYear,amount,
      fromBankAccountId:fromBank.bankAccountId,toBankAccountId:toBank.bankAccountId,
      balanceWarning:warnings.join("; ")},"Internal bank transfer posted once in both bank books",201);
  }catch(e){return fail(res,e.message||"Could not transfer between bank accounts",e.statusCode||400);}
});

// Transfers between Cash-in-Hand and the company's own bank are CONTRA
// entries, not sales income, expenses, customer receipts or supplier payments.
// One immutable balanced journal is the ONLY accounting movement. A matching
// BANK receipt/payment document is a bank-book DISPLAY record, not another post.
router.post("/contra", async (req, res) => {
  try {
    if (!isAdminAuth(req.auth) && !(canManualVoucherAction(req.auth,"cash","PAYMENT") && canManualVoucherAction(req.auth,"bank","RECEIPT")))
      return fail(res,"Both Bank and Cash posting permissions are required for contra",403);
    const direction=upper(req.body.direction);
    if(!["DEPOSIT","WITHDRAWAL"].includes(direction))return fail(res,"Direction must be DEPOSIT or WITHDRAWAL",400);
    const date=parseStrictVoucherDate(req.body.date);
    const financialYear=financialYearFromDate(date);
    const amount=money2(req.body.amount);
    if(!Number.isFinite(Number(req.body.amount))||amount<=0)return fail(res,"Amount must be greater than zero",400);
    if(!cleanText(req.body.bankAccountId))return fail(res,"Select one bank account",400);
    const bank=await resolveTransactionBank(req.auth.tenantKey,"BANK",req.body.bankAccountId);
    const {ContraVoucher,LedgerEntry}=financialModels(req.auth.tenantKey,financialYear);
    const contraNo=cleanText(req.body.contraNo)||makeId("CTR");
    if(!/^[A-Za-z0-9_-]{4,80}$/.test(contraNo))return fail(res,"Invalid contra reference",400);
    const previous=await ContraVoucher.findOne({tenantKey:req.auth.tenantKey,financialYear,contraNo});
    if(previous){
      const existingLines=await LedgerEntry.find({tenantKey:req.auth.tenantKey,financialYear,transactionId:contraNo,transactionType:"CONTRA",status:"POSTED"}).lean();
      // Crash-safe retry: once journal posting succeeded, recover the voucher
      // status instead of posting the same cash movement a second time.
      if(previous.status==="PENDING_POST"&&existingLines.length===2 &&
         Math.abs(existingLines.reduce((n,l)=>n+Number(l.debit||0)-Number(l.credit||0),0))<0.005){
        previous.status="POSTED";await previous.save();
        try{await recalculateBankRunningBalancesForVoucher({tenantKey:req.auth.tenantKey,financialYear,bankAccountId:previous.bankAccountId});}catch{}
        return ok(res,{contraNo,financialYear,alreadyPosted:true},"Existing contra posting recovered without duplication");
      }
      return fail(res,"This contra reference already exists; duplicate posting prevented",409);
    }
    if(await LedgerEntry.exists({tenantKey:req.auth.tenantKey,financialYear,transactionId:contraNo,status:"POSTED"}))
      return fail(res,"This contra reference already has a posted journal",409);
    const deposit=direction==="DEPOSIT";
    // Same-date equal cash deposits/withdrawals may be separate real movements.
    // Do not infer duplicate identity from amount and day. The contraNo and
    // immutable journal ID enforce idempotency and protect genuine retries.
    const remarks=cleanText(req.body.remarks)||(deposit?"Cash deposited into bank":"Cash withdrawn from bank");
    const record=await ContraVoucher.create({tenantKey:req.auth.tenantKey,financialYear,contraNo,
      date,direction,bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,
      amount,reference:cleanText(req.body.reference)||contraNo,remarks,
      status:"PENDING_POST",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
    const bankLine={accountCode:bank.accountCode,ledgerId:bank.ledgerId,bankAccountId:bank.bankAccountId};
    try{
      await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear,transactionId:contraNo,
        transactionType:"CONTRA",date,partyGlobalId:"CASH:COMPANY",narration:remarks,
        entries:deposit?[{...bankLine,debit:amount},{accountCode:"SYS_CASH",credit:amount}]
          :[{accountCode:"SYS_CASH",debit:amount},{...bankLine,credit:amount}],
      });
      record.status="POSTED";await record.save();
    }catch(e){
      // A crash after journal posting but before status update is reconciled by
      // the pending-voucher audit; never blindly delete an existing journal.
      if(!(await LedgerEntry.exists({tenantKey:req.auth.tenantKey,financialYear,transactionId:contraNo,status:"POSTED"})))
        await record.deleteOne();
      throw e;
    }
    let balanceWarning="";
    try{await recalculateBankRunningBalancesForVoucher({tenantKey:req.auth.tenantKey,financialYear,bankAccountId:bank.bankAccountId});}
    catch(e){balanceWarning=e.message;}
    return ok(res,{contraNo,direction,amount,financialYear,bankAccountId:bank.bankAccountId,balanceWarning},
      "Contra posted in Cashbook and Bank Book",201);
  }catch(e){return fail(res,e.message||"Could not post contra",e.statusCode||400);}
});

// Read-only finance audit: never changes balances or classifies a cash sale
// as collected merely because its customer is named CASH.
router.get("/cash-unification-audit",async(req,res)=>{
  try{
    if(!isAdminAuth(req.auth))return fail(res,"Administrator permission required",403);
    const tenantKey=req.auth.tenantKey;
    const financialYear=await resolveFinancialYear({tenantKey,requested:req.query.financialYear});
    const {LedgerEntry,Receipt,Payment,SalesInvoice,PurchaseInvoice,ContraVoucher}=financialModels(tenantKey,financialYear);
    const [opening,cashTotals,cashReceipts,cashPayments,cashMasters,contras,contraJournal,cashCustomers]=await Promise.all([
      companyCashOpening({tenantKey,financialYear}),
      LedgerEntry.aggregate([{$match:{tenantKey,financialYear,status:"POSTED",accountCode:"SYS_CASH"}},
        {$group:{_id:null,debit:{$sum:"$debit"},credit:{$sum:"$credit"},count:{$sum:1}}}]),
      Receipt.find({tenantKey,financialYear,status:"POSTED",mode:"CASH"}).select("receiptNo amount date").lean(),
      Payment.find({tenantKey,financialYear,status:"POSTED",mode:"CASH"}).select("paymentNo amount date").lean(),
      CompanyLedger.find({tenantKey,systemAccountCode:"SYS_CASH",status:{$ne:"INACTIVE"}}).select("_id ownerType ownerId openingBalances").lean(),
      ContraVoucher.find({tenantKey,financialYear,status:"POSTED"}).select("contraNo amount direction date bankAccountId").lean(),
      LedgerEntry.find({tenantKey,financialYear,status:"POSTED",transactionType:"CONTRA"}).select("transactionId accountCode debit credit bankAccountId").lean(),
      CustomerLink.find({tenantKey,systemKey:"CASH"}).select("globalCustomerId").lean(),
    ]);
    const cashIds=cashCustomers.map(x=>x.globalCustomerId).filter(Boolean);
    const [cashSales,unspecifiedPurchases]=await Promise.all([
      cashIds.length?SalesInvoice.find({tenantKey,financialYear,customerGlobalId:{$in:cashIds},status:{$in:["POSTED","COMPLETED"]}})
        .select("invoiceNo grandTotal date customerGlobalId").lean():[],
      PurchaseInvoice.countDocuments({tenantKey,financialYear,status:{$in:["POSTED","COMPLETED"]}}),
    ]);
    const invoiceJournalIds=new Set((await LedgerEntry.find({tenantKey,financialYear,status:"POSTED",transactionType:"SALES_INVOICE",accountCode:"SYS_CASH"}).distinct("transactionId"))||[]);
    const journalIds=new Set(contraJournal.map(x=>String(x.transactionId)));
    const orphanContras=contras.filter(x=>!journalIds.has(String(x.contraNo))).map(x=>x.contraNo);
    const receiptIds=cashReceipts.map(x=>x.receiptNo).filter(Boolean);
    const paymentIds=cashPayments.map(x=>x.paymentNo).filter(Boolean);
    const postedCashVoucherIds=new Set(await LedgerEntry.distinct("transactionId",{
      tenantKey,financialYear,status:"POSTED",accountCode:"SYS_CASH",
      transactionId:{$in:[...receiptIds,...paymentIds]},
    }));
    const missingCashReceipt=receiptIds.filter(x=>!postedCashVoucherIds.has(x));
    const missingCashPayment=paymentIds.filter(x=>!postedCashVoucherIds.has(x));
    const suspiciousCash=await LedgerEntry.aggregate([
      {$match:{tenantKey,financialYear,status:"POSTED",accountCode:"SYS_CASH"}},
      {$group:{_id:"$transactionId",debit:{$sum:"$debit"},credit:{$sum:"$credit"},date:{$min:"$date"},lineCount:{$sum:1}}},
      {$match:{debit:{$gt:0},credit:{$gt:0}}},
      {$sort:{date:1,_id:1}},
    ]);
    const totals=cashTotals[0]||{};
    const cashClosing=money2(opening+num(totals.debit)-num(totals.credit));
    const unverifiedCashSales=cashSales.filter(x=>!invoiceJournalIds.has(x.invoiceNo));
    return ok(res,{
      financialYear,accountCode:"SYS_CASH",openingBalance:opening,
      debit:num(totals.debit),credit:num(totals.credit),closingBalance:cashClosing,
      totalCashJournalLines:num(totals.count),
      selfOffsettingCashVoucherCount:suspiciousCash.length,
      selfOffsettingCashVouchers:suspiciousCash.slice(0,100).map(x=>({
        transactionId:x._id,date:x.date,cashDebit:money2(x.debit),cashCredit:money2(x.credit),lineCount:x.lineCount,
      })),
      companyCashMasterCount:cashMasters.filter(x=>x.ownerType==="COMPANY").length,
      linkedCashUserMasters:cashMasters.filter(x=>x.ownerType==="USER").length,
      contraVouchers:contras.length,orphanContras,
      missingCashReceiptJournal:missingCashReceipt,
      missingCashPaymentJournal:missingCashPayment,
      cashInvoicesRequiringSettlementReview:unverifiedCashSales.slice(0,100).map(x=>({invoiceNo:x.invoiceNo,amount:x.grandTotal,date:x.date})),
      reviewedCashInvoiceCount:cashSales.length,
      purchaseInvoicesWithoutExplicitCashPaymentFlag:unspecifiedPurchases,
      warnings:[
        ...(suspiciousCash.length?["One or more vouchers debit AND credit Cash-in-Hand. These self-offsetting cash entries require accountant review and correction; no historical data was changed."]:[]),
        ...(orphanContras.length?["One or more contra documents have no posted balanced journal"]:[]),
        ...(missingCashReceipt.length||missingCashPayment.length?["Posted cash vouchers are missing SYS_CASH journal entries"]:[]),
        ...(unverifiedCashSales.length?["CASH customer invoices do not by themselves prove cash settlement; verify corresponding cash receipts before closing"]:[]),
        "Purchase invoices do not carry a reliable paid-in-cash flag; settle cash purchases with a Cash PAYMENT voucher rather than assuming all purchases are paid",
      ],
    });
  }catch(e){return fail(res,e.message||"Cash audit failed",e.statusCode||400);}
});

// New Cashbook bulk path. Review first; never blindly infer a cash counterparty.
// Imported rows use stable voucher IDs so a retried file cannot post twice.
router.post("/cashbook/bulk-preview",upload.single("file"),async(req,res)=>{
 try{
  if(!canViewCompanyCashbook(req.auth))return fail(res,"Missing Cashbook view permission",403);
  if(!req.file?.buffer)return fail(res,"Choose a CSV/Excel file",400);
  const raw=readRows(req.file.buffer,{preserveText:true,formattedDates:true});
  if(raw.length>2000)return fail(res,"Maximum 2,000 Cashbook rows",400);
  const parsed=readCashbookRows(raw);
  const tenantKey=req.auth.tenantKey;
  // Exact party matching is allowed; ambiguous parties must be reviewed.
  const [customers,users,transporters]=await Promise.all([
    CustomerLink.find({tenantKey,status:"ACTIVE",systemKey:{$ne:"CASH"}}).select("globalCustomerId localName").lean(),
    User.find({tenantKey,status:"ACTIVE",systemManaged:{$ne:true},ledgerNodeKind:{$ne:"GROUP"}}).select("_id name").lean(),
    Transporter.find({tenantKey,status:"ACTIVE"}).select("_id name").lean(),
  ]);
  const directory=[...customers.map(x=>({name:x.localName,id:x.globalCustomerId,type:"CUSTOMER"})),
   ...users.map(x=>({name:x.name,id:`USER:${x._id}`,type:"USER"})),
   ...transporters.map(x=>({name:x.name,id:`TRANSPORTER:${x._id}`,type:"TRANSPORTER"}))].filter(x=>x.name&&upper(x.name)!=="CASH");
  const options=directory.map(x=>({...x,lc:x.name.toLowerCase()}));
  const preview=parsed.map(x=>{
   if(x.error)return x;
   const given=(x.partyName||x.particulars).toLowerCase();
   const matches=options.filter(p=>p.lc===given);
   // Never post a partial-text guess into somebody else's party ledger.
   // A missing/ambiguous party is posted to SYS_SUSPENSE; the Superadmin can
   // correct it with the existing audited voucher editor later.
   const matched=matches.length===1?matches[0]:null;
   const unmapped=!matched;
   return {...x,partyName:x.partyName||matched?.name||'Unidentified cash counterparty',
    partyType:matched?.type||'OTHER',partyId:matched?.id||'',
    confidence:matched?'EXACT':'SUSPENSE',
    warning:x.bankWarning||(unmapped?'Party not uniquely identified. This entry will post to Suspense until reassigned.':'')};
  });
  return ok(res,{importId:createHash("sha256").update(req.file.buffer).digest("hex"),
   items:preview,invalid:preview.filter(x=>x.error).length,
   warnings:preview.filter(x=>x.warning).length,
   message:"Review party mapping and Cash/Bank classification before posting. Running Balance is calculated after posting."});
 }catch(e){return fail(res,e.message||"Cashbook preview failed",400);}
});

router.post("/cashbook/bulk-post",async(req,res)=>{
 try{
  const importId=String(req.body.importId||"");
  if(!/^[a-f0-9]{64}$/.test(importId))return fail(res,"Preview the Cashbook file before posting",400);
  const items=req.body.rows;
  if(!Array.isArray(items)||!items.length||items.length>2000)return fail(res,"Select 1 to 2,000 reviewed rows",400);
  // Validate the entire submitted batch before posting any rows.
  const errors=[],ready=[];
  for(const x of items){
   try{
    if(!Number.isSafeInteger(x.rowNo)||x.rowNo<2)throw new Error("Invalid source row number");
    const date=parseStrictVoucherDate(x.date),debit=Number(x.debit||0),credit=Number(x.credit||0);
    if(!Number.isFinite(debit)||!Number.isFinite(credit)||debit<0||credit<0||(debit>0)===(credit>0))throw new Error("Exactly one Debit or Credit amount is required");
    const kind=debit>0?"PAYMENT":"RECEIPT";
    if(!canManualVoucherAction(req.auth,"cash",kind))throw new Error("Missing create permission");
    if(!cleanText(x.particulars))throw new Error("Particulars required");
    // A Superadmin-uploaded cash movement is always posted immediately.
    // Unidentified counterparties use SYS_SUSPENSE, never an invented party.
    if(!cleanText(x.partyName) && !cleanText(x.particulars))throw new Error("Particulars or party name required");
    const mappedType=cleanText(x.partyType)||'OTHER';
    if(upper(x.partyName)==="CASH")throw new Error("CASH cannot be its own counterparty");
    // Internal company Cash/Bank movements must be ONE contra voucher.
    if(/\b(cash\s+(deposited|deposit)\s+(in|into|to)\s+(the\s+)?bank|bank\s+deposit|cash\s+withdrawn\s+from\s+bank|cash\s+withdrawal\s+from\s+bank)\b/i.test(String(x.particulars)))
      throw new Error('Company Cash/Bank transfer must use the Contra page; ordinary Cash bulk posting is not permitted');
    // Explicit acknowledgement is needed for bank-looking narration.
    if(/\b(NEFT|RTGS|IMPS|UPI)\b/i.test(String(x.particulars))&&!x.confirmCash)throw new Error("Narration mentions a bank transfer. Confirm physical cash movement first");
    const serial=createHash("sha256").update(`${req.auth.tenantKey}:${importId}:${x.rowNo}`).digest("hex").slice(0,20).toUpperCase();
    const voucherNo=`CB-${kind==="PAYMENT"?"P":"R"}-${serial}`;
    ready.push({row:x.rowNo,kind,input:{date:x.date,transactionType:kind,
      partyName:x.partyId||x.partyName||'Unidentified cash counterparty',partyType:mappedType,amount:debit||credit,
      remarks:cleanText(x.particulars),[kind==="PAYMENT"?"paymentNo":"receiptNo"]:voucherNo}});
   }catch(e){errors.push({row:x.rowNo||"?",error:e.message});}
  }
  if(new Set(ready.map(x=>x.row)).size!==ready.length)errors.push({row:"?",error:"Duplicate row numbers in upload"});
  if(errors.length)return fail(res,"Review rejected rows before posting",400,{errors});
  let inserted=0;const failures=[];
  for(const entry of ready){
   try{await postManualTransactionVoucher({auth:req.auth,channel:"cash",input:entry.input,recalculate:false});inserted++;}
   catch(e){failures.push({row:entry.row,error:e.statusCode===409?"Already posted (safe duplicate prevention)":e.message});}
  }
  return ok(res,{inserted,received:ready.length,errors:failures,partial:failures.length>0},
   failures.length?"Some rows were not posted":"Cashbook uploaded successfully",201);
 }catch(e){return fail(res,e.message||"Cashbook import failed",e.statusCode||400);}
});

router.post("/manual-bulk/:channel",upload.single("file"),async(req,res)=>{
  try{
    const channel=String(req.params.channel||"").toLowerCase();
    if(!["cash","bank"].includes(channel))return fail(res,"Invalid transaction channel",400);
    if(!req.file?.buffer)return fail(res,"Excel or CSV file is required",400);
    let rows;
    try{rows=readRows(req.file.buffer,{preserveText:true,formattedDates:true});}
    catch{return fail(res,"Could not read Excel/CSV file",400);}
    if(!rows.length)return fail(res,"Uploaded file has no records",400);
    if(rows.length>2000)return fail(res,"Maximum 2,000 rows per upload",400);
    const fields=channel==="cash"?[
      {key:"date",label:"Date",required:true},
      {key:"partyName",label:"Party Name",aliases:["party","party name / id"],required:true},
      {key:"remarks",label:"Remarks",aliases:["remark","narration","description"],required:true},
      {key:"mode",label:"Mode",required:true},
      {key:"debit",label:"Debit",required:true},
      {key:"credit",label:"Credit",required:true},
    ]:[
      {key:"transactionType",label:"Transaction Mode",aliases:["transaction type","type","receipt/payment"],required:true},
      {key:"date",label:"Date",aliases:["transaction date"],required:true},
      {key:"partyName",label:"Party Name / ID",aliases:["party name","party","customer","customer id"],required:true},
      {key:"partyType",label:"Party Type",aliases:["category"]},
      {key:"amount",label:"Amount",required:true},
      {key:"remarks",label:"Remarks",aliases:["remark","narration","description"]},
      {key:"bankAccountId",label:"Bank Account ID",aliases:["bank account","bank id"]},
    ];
    const cols=resolveColumns(rows[0],fields);
    const missing=fields.filter(x=>x.required&&!cols[x.key]).map(x=>x.label);
    if(missing.length)return fail(res,`Missing column(s): ${missing.join(", ")}`,400);
    const records=rows.map((row,index)=>{
      const input={};for(const f of fields){const value=valueFor(row,cols[f.key]);if(value!==undefined&&value!=="")input[f.key]=value;}
      input.bankAccountId=channel==="bank"?(input.bankAccountId||req.body.bankAccountId||""):"";
      return {row:index+2,input};
    });
    let inferredFromRemarks=0,postedToSuspense=0;
    if(channel==="cash"){
      const importHash=createHash('sha256').update(req.file.buffer).digest('hex');
      const tenantKey=req.auth.tenantKey;
      const [customers,users,transporters]=await Promise.all([
        CustomerLink.find({tenantKey,status:{$nin:["INACTIVE","DEACTIVATED"]},systemKey:{$ne:"CASH"}}).select("globalCustomerId localName displayIdentifier").lean(),
        User.find({tenantKey,status:"ACTIVE",systemManaged:{$ne:true},ledgerNodeKind:{$ne:"GROUP"}}).select("_id name").lean(),
        Transporter.find({tenantKey,status:"ACTIVE"}).select("_id name").lean(),
      ]);
      const globalIds=[...new Set(customers.map(x=>String(x.globalCustomerId||'')).filter(Boolean))];
      const globals=globalIds.length?await GlobalCustomer.find({$or:[
        {hiddenId:{$in:globalIds}},
        ...(globalIds.some(x=>/^[a-f0-9]{24}$/i.test(x))?[{_id:{$in:globalIds.filter(x=>/^[a-f0-9]{24}$/i.test(x))}}]:[])
      ]}).select('_id hiddenId legalName tradeName').lean():[];
      const globalById=new Map();for(const g of globals){if(g.hiddenId)globalById.set(String(g.hiddenId),g);if(g._id)globalById.set(String(g._id),g);}
      const directory=[...customers.map(x=>({name:x.localName||globalById.get(String(x.globalCustomerId))?.tradeName||globalById.get(String(x.globalCustomerId))?.legalName,
        aliases:[x.displayIdentifier,globalById.get(String(x.globalCustomerId))?.tradeName,globalById.get(String(x.globalCustomerId))?.legalName],id:x.globalCustomerId,type:"CUSTOMER"})),
       ...users.map(x=>({name:x.name,id:`USER:${x._id}`,type:"USER"})),
       ...transporters.map(x=>({name:x.name,id:`TRANSPORTER:${x._id}`,type:"TRANSPORTER"}))]
       .filter(x=>x.name&&upper(x.name)!=="CASH"&&x.id);
      for(const {row,input} of records){
        // Debit/Credit, not the text in Mode, defines the direction.
        try{
          cashBulkMode(input.mode);
          const debit=cashBulkAmount(input.debit),credit=cashBulkAmount(input.credit);
          if((debit>0)===(credit>0))throw new Error("Enter an amount in exactly one of Debit or Credit");
          if(upper(input.mode)==="PAYMENT"&&credit>0||upper(input.mode)==="RECEIPT"&&debit>0)
            throw new Error('Mode and Debit/Credit direction disagree');
          input.transactionType=debit>0?"PAYMENT":"RECEIPT";
          input.amount=debit||credit;
          input.mode="CASH";
          if(/\b(cash\s+(deposited|deposit)\s+(in|into|to)\s+(the\s+)?bank|bank\s+deposit|cash\s+withdrawn\s+from\s+bank|cash\s+withdrawal\s+from\s+bank)\b/i.test(String(input.remarks||'')))
            throw new Error('Company Cash/Bank movements must use the Contra page');
          const match=detectCashBulkParty(input,directory);
          if(match){input.partyName=match.id;input.partyType=match.type;input.cashMatchSource=match.confidence;}
          else{input.partyName=cleanText(input.partyName)||"Unidentified cash counterparty";input.partyType="OTHER";input.cashMatchSource="SUSPENSE";}
          // A retry of the SAME file and row must not create a second voucher.
          // A different file (even with an equal amount/date) remains a separate entry.
          const rowFingerprint=createHash('sha256').update(`${tenantKey}:${importHash}:${row}`).digest('hex').slice(0,20).toUpperCase();
          input[input.transactionType==='PAYMENT'?'paymentNo':'receiptNo']=`CM-${input.transactionType==='PAYMENT'?'P':'R'}-${rowFingerprint}`;
        }catch(e){input.bulkError=e.message;}
      }
    }
    // Whole-file shape validation before any posting; invalid dates are never guessed.
    const errors=[];
    for(const {row,input} of records){
      try{
        parseStrictVoucherDate(input.date);
        if(input.bulkError)throw new Error(input.bulkError);
        if(!["RECEIPT","PAYMENT"].includes(upper(input.transactionType)))throw new Error("Transaction Mode must be Receipt or Payment");
        if(!canManualVoucherAction(req.auth,channel,input.transactionType))throw new Error("Not permitted to create this receipt/payment");
        if(!cleanText(input.partyName))throw new Error("Party Name / ID is mandatory");
        if(!(Number(input.amount)>0))throw new Error("Amount must be greater than zero");
        if(channel==="bank"&&!input.bankAccountId)throw new Error("Bank Account required");
      }catch(e){errors.push({row,error:e.message});}
    }
    if(errors.length)return fail(res,"Bulk upload rejected: correct the invalid rows",400,{errors:errors.slice(0,100)});
    if(req.auth.role==='SUPERADMIN')for(const record of records)record.input.source='SUPERADMIN_BULK';
    let inserted=0,receiptInserted=0,paymentInserted=0;const bankYears=new Map();
    for(const {row,input} of records){
      try{
        const out=await postManualTransactionVoucher({auth:req.auth,channel,input,recalculate:false});
        inserted++;
        if(channel==="cash"){
          if(input.cashMatchSource==="REMARKS_NAME")inferredFromRemarks++;
          if(input.cashMatchSource==="SUSPENSE")postedToSuspense++;
        }
        if(upper(input.transactionType)==="RECEIPT")receiptInserted++;else paymentInserted++;
        if(channel==="bank")bankYears.set(`${out.financialYear}::${out.bankAccountId}`,out);
      }catch(e){errors.push({row,error:e.message});}
    }
    const warnings=[];
    for(const {financialYear,bankAccountId} of bankYears.values()){
      try{await recalculateBankRunningBalancesForVoucher({tenantKey:req.auth.tenantKey,financialYear,bankAccountId});}
      catch(e){warnings.push(e.message);}
    }
    return ok(res,{received:records.length,inserted,receiptInserted,paymentInserted,invalid:errors.length,errors:errors.slice(0,100),warnings,
      inferredFromRemarks,postedToSuspense,
      partial:errors.length>0},errors.length?"Some rows were rejected; accepted rows posted":"Transactions posted",201);
  }catch(e){return fail(res,e.message||"Bulk upload failed",e.statusCode||400);}
});

router.get("/receipts", async (req, res) => {
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.query.financialYear,
    }),
    page = Math.max(1, Number(req.query.page || 1)),
    limit = Math.min(200, Math.max(10, Number(req.query.limit || 50))),
    q = String(req.query.q || "").trim();
  const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
  const filter = { tenantKey: req.auth.tenantKey, financialYear };
  const statusFilter = upper(req.query.status);
  const modeFilter = upper(req.query.mode);
  const sourceFilter = upper(req.query.collectionSource);
  const workflowFilter = upper(req.query.workflowStatus);
  if (statusFilter && statusFilter !== "ALL") filter.status = statusFilter;
  if (modeFilter && modeFilter !== "ALL") filter.mode = modeFilter;
  if (sourceFilter && sourceFilter !== "ALL") filter.collectionSource = sourceFilter;
  if (workflowFilter && workflowFilter !== "ALL") filter.receiptWorkflowStatus = workflowFilter;
  const dateRange = transactionQueryDateRange(req);
  if (dateRange) filter.date = dateRange;
  if (q)
    filter.$or = [
      { receiptNo: new RegExp(q, "i") },
      { customerGlobalId: new RegExp(q, "i") },
      { partyNameSnapshot: new RegExp(q, "i") },
      { reference: new RegExp(q, "i") },
      { remarks: new RegExp(q, "i") },
      { bankNameSnapshot: new RegExp(q, "i") },
      { mode: new RegExp(q, "i") },
    ];
  const [items, total] = await Promise.all([
    Receipt.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Receipt.countDocuments(filter),
  ]);
  ok(res, { items, meta: pageMeta(page, limit, total) });
});


router.get("/receipts/salesperson-pending", async (req, res) => {
  try {
    if (!isAdminAuth(req.auth)) return fail(res, "Superadmin access required", 403);
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const kind = upper(req.query.kind || req.query.mode || "GENERAL");
    const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const filter = {
      tenantKey: req.auth.tenantKey,
      financialYear,
      collectionSource: "SALESPERSON_APP",
      customerOtpStatus: "VERIFIED",
      cashierOtpStatus: "PENDING",
      receiptWorkflowStatus: "PENDING_CASHIER_OTP",
      status: { $ne: "POSTED" },
    };
    let items = await Receipt.find(filter).sort({ date: -1, createdAt: -1 }).limit(500).lean();
    const isCheque = (r) => upper(r.receiptType) === "CHEQUE" || /CHEQUE|CHECK|CHQ/.test(upper(r.mode));
    if (kind === "CHEQUE") items = items.filter(isCheque);
    else if (["GENERAL", "CASH_UPI", "NON_CHEQUE"].includes(kind)) items = items.filter((r) => !isCheque(r));
    else if (kind !== "ALL") items = items.filter((r) => upper(r.mode) === kind || upper(r.receiptType) === kind);
    return ok(res, { financialYear, kind, items });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/receipts/:receiptId/cashier-otp", async (req, res) => {
  try {
    if (!isAdminAuth(req.auth)) return fail(res, "Superadmin access required", 403);
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const key = cleanText(req.params.receiptId);
    let receipt = await Receipt.findOne({ tenantKey: req.auth.tenantKey, financialYear, receiptNo: key }).select("+cashierOtpCode");
    if (!receipt && /^[a-fA-F0-9]{24}$/.test(key)) receipt = await Receipt.findOne({ tenantKey: req.auth.tenantKey, financialYear, _id: key }).select("+cashierOtpCode");
    if (!receipt) return fail(res, "Receipt not found", 404);
    if (receipt.collectionSource !== "SALESPERSON_APP") return fail(res, "This receipt does not use cashier OTP", 409);
    if (receipt.customerOtpStatus !== "VERIFIED") return fail(res, "Customer OTP is not verified yet", 409);
    if (receipt.cashierOtpStatus !== "PENDING") return fail(res, receipt.cashierOtpStatus === "VERIFIED" ? "Cashier OTP is already verified" : "Cashier OTP is not available", 409);
    return ok(res, {
      receiptId: String(receipt._id),
      receiptNo: receipt.receiptNo,
      partyName: receipt.partyNameSnapshot || "",
      amount: Number(receipt.amount || 0),
      mode: receipt.mode || "",
      receiptType: receipt.receiptType || "",
      allocationType: receipt.allocationType || "",
      againstInvoices: receipt.againstInvoices || [],
      otp: receipt.cashierOtpCode || "",
      expiresAt: receipt.cashierOtpExpiresAt || null,
      madeBy: receipt.collectedBySalespersonNameSnapshot || receipt.createdByNameSnapshot || "",
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});


// Superadmin can correct unposted collector entries without changing verified
// customer identity or amount. Delete is an audited VOID, never silent removal.
router.patch('/cashier/receipts/:id/superadmin-correct',async(req,res)=>{
  try{
    if(upper(req.auth.role||req.auth.roleCode)!=='SUPERADMIN')return fail(res,'Superadmin only',403);
    const financialYear=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body?.financialYear});
    const {Receipt}=financialModels(req.auth.tenantKey,financialYear);
    const reason=cleanText(req.body?.reason).trim(),remarks=cleanText(req.body?.remarks).trim();
    if(reason.length<5||reason.length>500)return fail(res,'Correction reason (5–500 characters) required',422);
    if(remarks.length>1000)return fail(res,'Remarks maximum 1000 characters',422);
    const original=await Receipt.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear,
      collectionSource:'SALESPERSON_APP',status:'POSTED'});
    if(!original)return fail(res,'Collector receipt not found',404);
    if(original.ledgerPostedAt)return fail(res,'Posted receipt must be reversed through accounting correction',409);
    // Verification amount, original party, and payment instrument cannot be edited.
    original.remarks=remarks;
    original.disputeHistory.push({status:'SUPERADMIN_EDIT',remark:reason,at:new Date(),by:req.auth.sub,byName:req.auth.name||''});
    await original.save();
    return ok(res,{id:String(original._id),remarks},'Receipt remarks corrected; original verified amount and party preserved');
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});
router.delete('/cashier/receipts/:id/superadmin-void',async(req,res)=>{
  try{
    if(upper(req.auth.role||req.auth.roleCode)!=='SUPERADMIN')return fail(res,'Superadmin only',403);
    const financialYear=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body?.financialYear});
    const {Receipt,SalespersonCashMovement}=financialModels(req.auth.tenantKey,financialYear);
    const reason=cleanText(req.body?.reason).trim();
    if(reason.length<5||reason.length>500)return fail(res,'Void reason (5–500 characters) required',422);
    const r=await Receipt.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear,
      collectionSource:'SALESPERSON_APP',status:'POSTED'}).lean();
    if(!r)return fail(res,'Collector receipt not found',404);
    if(r.ledgerPostedAt||!['','PENDING_TO_DEPOSIT','NOT_APPLICABLE'].includes(cleanText(r.cashDepositStatus)))
      return fail(res,'Receipt is posted or already in a handover; reverse/cancel that workflow before voiding',409);
    const hasBatch=await SalespersonCashMovement.exists({tenantKey:req.auth.tenantKey,financialYear,type:'HANDOVER',
      status:{$in:['PENDING','APPROVED']},'receiptBreakdown.receiptId':String(r._id)});
    if(hasBatch)return fail(res,'Receipt belongs to a handover. Reconcile the handover before voiding',409);
    const changed=await Receipt.findOneAndUpdate({_id:r._id,tenantKey:req.auth.tenantKey,financialYear,status:'POSTED',
      ledgerPostedAt:{$exists:false},cashDepositStatus:{$in:['',null,'PENDING_TO_DEPOSIT','NOT_APPLICABLE']}},
      {$set:{status:'VOID',receiptWorkflowStatus:'VOIDED_BY_SUPERADMIN',remarks:`${r.remarks||''} [VOID: ${reason}]`.trim()},
        $push:{disputeHistory:{status:'SUPERADMIN_VOID',remark:reason,at:new Date(),by:req.auth.sub,byName:req.auth.name||''}}},{new:true});
    if(!changed)return fail(res,'Receipt status changed; refresh and retry',409);
    if(upper(r.receiptType)==='CHEQUE'||upper(r.mode)==='CHEQUE')await GenericRecord.updateMany({tenantKey:req.auth.tenantKey,
      app:'dms',resource:'cheque-control-received','data.linkedReceiptNo':r.receiptNo,'data.linkedReceiptFy':financialYear,
      'data.status':{$in:['PENDING_WITH_COLLECTOR','PENDING_WITH_SALESPERSON']}},
      {$set:{'data.status':'CANCELLED','data.custodyStatus':'CANCELLED','data.remarks':`VOID: ${reason}`}});
    return ok(res,{id:String(changed._id),status:'VOID'},'Receipt voided with audit history; no ledger journal deleted');
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

// Receipt disputes are separate from physical handover. The collector
// initiates handover and enters the OTP displayed on the DMS Cashier page.
const cashierWorkflowAllowed=req=>isAdminAuth(req.auth)||upper(req.auth.role)==='CASHIER'||canPageAction(req.auth.permissions||[],'/dms/cashier','edit');
router.post('/cashier/receipts/:id/dispute',async(req,res)=>{
  try{
    if(!cashierWorkflowAllowed(req))return fail(res,'Cashier Edit permission required',403);
    const fy=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body?.financialYear});
    const {Receipt}=financialModels(req.auth.tenantKey,fy),remark=cleanText(req.body?.remark).trim();
    if(remark.length<5||remark.length>500)return fail(res,'Dispute remark must contain 5–500 characters',422);
    const id=req.params.id;if(!mongoose.isValidObjectId(id))return fail(res,'Valid receipt ID required',422);
    const r=await Receipt.findOneAndUpdate({_id:id,tenantKey:req.auth.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',customerOtpStatus:'VERIFIED',disputeStatus:{$ne:'HOLD'},ledgerPostedAt:{$exists:false}},
      {$set:{disputeStatus:'HOLD',disputeRemark:remark,disputeRaisedAt:new Date()},$push:{disputeHistory:{status:'HOLD',remark,at:new Date(),by:req.auth.sub,byName:req.auth.name||''}}},{new:true});
    if(!r)return fail(res,'Receipt cannot be put on hold: already disputed or posted to ledger',409);
    return ok(res,{receiptId:String(r._id),disputeStatus:'HOLD'},'Receipt placed on dispute HOLD');
  }catch(e){return fail(res,e.message,e.statusCode||500);}
});
router.post('/cashier/receipts/:id/dispute/resolve',async(req,res)=>{
  try{
    if(!cashierWorkflowAllowed(req))return fail(res,'Cashier Edit permission required',403);
    const fy=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body?.financialYear});
    const {Receipt}=financialModels(req.auth.tenantKey,fy),remark=cleanText(req.body?.remark).trim();
    if(remark.length<5||remark.length>500)return fail(res,'Resolution remark must contain 5–500 characters',422);
    if(!mongoose.isValidObjectId(req.params.id))return fail(res,'Valid receipt ID required',422);
    const r=await Receipt.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear:fy,disputeStatus:'HOLD',ledgerPostedAt:{$exists:false}},
      {$set:{disputeStatus:'RESOLVED',disputeResolvedAt:new Date()},$push:{disputeHistory:{status:'RESOLVED',remark,at:new Date(),by:req.auth.sub,byName:req.auth.name||''}}},{new:true});
    if(!r)return fail(res,'Receipt is not on HOLD or not found',409);
    return ok(res,{receiptId:String(r._id),disputeStatus:'RESOLVED'},'Receipt dispute resolved; can be selected again');
  }catch(e){return fail(res,e.message,e.statusCode||500);}
});
router.post('/cashier/collect-cash',async(req,res)=>{
  return fail(res,'This action was retired. Collector initiates the handover; Cashier Close posts ledger entries.',410);

  try{
    if(!cashierWorkflowAllowed(req))return fail(res,'Cashier Edit permission required',403);
    const fy=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body?.financialYear});
    const {Receipt,SalespersonCashMovement}=financialModels(req.auth.tenantKey,fy);
    const ids=[...new Set((Array.isArray(req.body?.receiptIds)?req.body.receiptIds:[]).map(cleanText).filter(Boolean))];
    if(!ids.length||ids.length>100||ids.some(x=>!mongoose.isValidObjectId(x)))return fail(res,'Select 1–100 valid cash receipts',422);
    const collectorId=cleanText(req.body?.collectorId);
    if(!collectorId)return fail(res,'Select a single collector',422);
    const receipts=await Receipt.find({_id:{$in:ids},tenantKey:req.auth.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',mode:'CASH',customerOtpStatus:'VERIFIED',status:'POSTED',collectedBySalespersonId:collectorId,
      disputeStatus:{$ne:'HOLD'},cashDepositBatchId:{$in:['',null]},cashDepositStatus:{$in:['PENDING_TO_DEPOSIT','NOT_APPLICABLE','']}}).lean();
    if(receipts.length!==ids.length)return fail(res,'A selected receipt is already reserved, disputed, or belongs to another collector',409);
    const amount=money2(receipts.reduce((n,r)=>n+Number(r.amount||0),0));
    const movement=await SalespersonCashMovement.create({tenantKey:req.auth.tenantKey,financialYear:fy,movementNo:makeId('HND'),salespersonId:collectorId,
      salespersonNameSnapshot:receipts[0].collectedBySalespersonNameSnapshot||'',recipientUserId:cleanText(req.auth.sub),recipientName:req.auth.name||'Cashier',
      type:'HANDOVER',direction:'OUT',date:new Date(),amount,cashAmount:amount,bankAmount:0,
      receiptBreakdown:receipts.map(r=>({receiptId:String(r._id),receiptNo:r.receiptNo,customerGlobalId:r.customerGlobalId,
        customerNameSnapshot:r.partyNameSnapshot,amount:r.amount,mode:'CASH',receiptType:r.receiptType||'CASH',receiptDenominations:r.cashDenominations||[],collectedAt:r.customerOtpVerifiedAt||r.createdAt||r.date})),
      handoverWorkflowStatus:'CASHIER_REQUESTED',handoverOtpStatus:'PENDING',status:'PENDING',createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||''});
    const claimed=[];
    try{
      for(const r of receipts){const x=await Receipt.updateOne({_id:r._id,tenantKey:req.auth.tenantKey,financialYear:fy,
        disputeStatus:{$ne:'HOLD'},cashDepositBatchId:{$in:['',null]},cashDepositStatus:{$in:['PENDING_TO_DEPOSIT','NOT_APPLICABLE','']}},
        {$set:{cashDepositStatus:'HANDOVER_PENDING',cashDepositBatchId:String(movement._id)}});
        if(x.modifiedCount!==1)throw Object.assign(new Error('Another handover reserved this receipt. Refresh and retry.'),{statusCode:409});claimed.push(r._id);}
      const otp=await createOtp({tenantKey:req.auth.tenantKey,transactionId:String(movement._id),actionType:'CASHIER_COLLECT_CASH_FROM_COLLECTOR',recipientId:collectorId,
        context:{movementNo:movement.movementNo,receiptCount:ids.length,amount,cashierId:cleanText(req.auth.sub)},ttlSeconds:900});
      movement.handoverOtpId=otp.otpId;movement.handoverOtpCode=otp.code;movement.handoverOtpExpiresAt=otp.expiresAt;await movement.save();
      return ok(res,{batchId:String(movement._id),movementNo:movement.movementNo,amount,receiptCount:ids.length,expiresAt:otp.expiresAt},'OTP is now visible to the collector in their app. Cashier must enter it to collect the selected cash.');
    }catch(e){await Receipt.updateMany({_id:{$in:claimed},tenantKey:req.auth.tenantKey,financialYear:fy,cashDepositBatchId:String(movement._id)},{$set:{cashDepositStatus:'PENDING_TO_DEPOSIT',cashDepositBatchId:''}});await SalespersonCashMovement.updateOne({_id:movement._id,status:'PENDING'},{$set:{status:'CANCELLED',handoverWorkflowStatus:'CANCELLED'}});throw e;}
  }catch(e){return fail(res,e.message,e.statusCode||500);}
});
router.post('/cashier/collect-cash/:id/verify',async(req,res)=>{
  return fail(res,'Cashier-requested pickups were retired; use Collector Deposit to Cashier.',410);
  try{
    if(!cashierWorkflowAllowed(req))return fail(res,'Cashier Edit permission required',403);
    const fy=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body?.financialYear});
    const {Receipt,SalespersonCashMovement}=financialModels(req.auth.tenantKey,fy);
    const movement=await SalespersonCashMovement.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear:fy,type:'HANDOVER',
      handoverWorkflowStatus:'CASHIER_REQUESTED',status:'PENDING',recipientUserId:cleanText(req.auth.sub)});
    if(!movement)return fail(res,'Pending cashier pickup not found or already collected',409);
    const ids=(movement.receiptBreakdown||[]).map(r=>r.receiptId);
    const reservedReceipts=await Receipt.find({_id:{$in:ids},tenantKey:req.auth.tenantKey,financialYear:fy,
      collectionSource:'SALESPERSON_APP',mode:'CASH',customerOtpStatus:'VERIFIED',
      disputeStatus:{$ne:'HOLD'},cashDepositBatchId:String(movement._id),cashDepositStatus:'HANDOVER_PENDING',
      ledgerPostedAt:{$exists:false}}).select('_id').lean();
    if(ids.length===0||reservedReceipts.length!==ids.length)return fail(res,'A selected receipt is disputed, already posted, missing, or no longer reserved for this cash pickup',409);
    const result=await verifyOtp({otpId:movement.handoverOtpId,code:cleanText(req.body?.otp)});
    if(!result.ok)return fail(res,result.reason,400);
    if(result.challenge.tenantKey!==req.auth.tenantKey||String(result.challenge.transactionId)!==String(movement._id)||result.challenge.actionType!=='CASHIER_COLLECT_CASH_FROM_COLLECTOR'||String(result.challenge.recipientId)!==String(movement.salespersonId))return fail(res,'OTP does not belong to this collector',403);
    const at=new Date();const done=await SalespersonCashMovement.findOneAndUpdate({_id:movement._id,status:'PENDING',handoverWorkflowStatus:'CASHIER_REQUESTED'},
      {$set:{status:'APPROVED',handoverWorkflowStatus:'RECEIVED',handoverOtpStatus:'VERIFIED',handoverOtpVerifiedAt:at,cashierReceivedAt:at,cashierReceivedBy:req.auth.sub,cashierReceivedByNameSnapshot:req.auth.name||''}}, {new:true});
    if(!done)return fail(res,'Pickup was concurrently completed; refresh',409);
    const accepted=await Receipt.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey,financialYear:fy,
      cashDepositBatchId:String(movement._id),cashDepositStatus:'HANDOVER_PENDING',disputeStatus:{$ne:'HOLD'}},
      {$set:{cashDepositStatus:'DEPOSITED_TO_CASHIER',cashDepositedAt:at,cashDepositedBy:req.auth.sub,cashDepositedByNameSnapshot:req.auth.name||'',receiptWorkflowStatus:'READY_TO_POST_LEDGER'}});
    if(accepted.modifiedCount!==ids.length)return fail(res,'Cash custody received, but one receipt changed during confirmation. Accounts review required before ledger posting.',409);
    return ok(res,{batchId:String(movement._id),receiptCount:ids.length,amount:movement.amount},'Collector OTP verified; cash received. Select Post to Ledger next.');
  }catch(e){return fail(res,e.message,e.statusCode||500);}
});
router.post('/cashier/collect-cash/:id/refresh-otp',async(req,res)=>{
  try{
    if(!cashierWorkflowAllowed(req))return fail(res,'Cashier Edit permission required',403);
    const fy=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body?.financialYear});
    const {SalespersonCashMovement}=financialModels(req.auth.tenantKey,fy);
    const movement=await SalespersonCashMovement.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear:fy,
      type:'HANDOVER',status:'PENDING',handoverWorkflowStatus:'CASHIER_REQUESTED',...cashierMovementScope(req)});
    if(!movement)return fail(res,'Pending cashier cash pickup not found',409);
    const otp=await createOtp({tenantKey:req.auth.tenantKey,transactionId:String(movement._id),actionType:'CASHIER_COLLECT_CASH_FROM_COLLECTOR',
      recipientId:movement.salespersonId,context:{movementNo:movement.movementNo,receiptCount:movement.receiptBreakdown?.length||0,
        amount:movement.amount,cashierId:cleanText(req.auth.sub)},ttlSeconds:900});
    const changed=await SalespersonCashMovement.updateOne({_id:movement._id,status:'PENDING',handoverWorkflowStatus:'CASHIER_REQUESTED'},
      {$set:{handoverOtpId:otp.otpId,handoverOtpCode:otp.code,handoverOtpExpiresAt:otp.expiresAt,handoverOtpStatus:'PENDING'}});
    if(changed.modifiedCount!==1)return fail(res,'Pickup has already been completed. Refresh.',409);
    return ok(res,{batchId:String(movement._id),expiresAt:otp.expiresAt},'New OTP is now visible to the selected collector.');
  }catch(e){return fail(res,e.message,e.statusCode||500);}
});
router.get('/cashier/collect-cash/pending',async(req,res)=>{
  try{if(!cashierWorkflowAllowed(req))return fail(res,'Cashier Edit permission required',403);
    const fy=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.query.financialYear});
    const {SalespersonCashMovement}=financialModels(req.auth.tenantKey,fy);
    const rows=await SalespersonCashMovement.find({tenantKey:req.auth.tenantKey,financialYear:fy,type:'HANDOVER',handoverWorkflowStatus:'CASHIER_REQUESTED',status:'PENDING',...cashierMovementScope(req)}).lean();
    return ok(res,{items:rows.map(x=>({id:String(x._id),collectorId:x.salespersonId,collectorName:x.salespersonNameSnapshot,amount:x.amount,receiptCount:x.receiptBreakdown.length,expiresAt:x.handoverOtpExpiresAt}))});
  }catch(e){return fail(res,e.message,e.statusCode||500);}
});
// ---------------------------
// DMS Cashier: salesperson cash handover / issues / cashbook / closing
// ---------------------------
const cashierMovementScope = (req) => isAdminAuth(req.auth) ? {} : { recipientUserId: cleanText(req.auth.sub) };
const openCashIssue = (issue) => !["RESOLVED", "CANCELLED"].includes(upper(issue?.status));

router.get("/cashier/handovers", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { SalespersonCashMovement,Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const filter = {
      tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", "receiptBreakdown.0": { $exists: true },
      ...cashierMovementScope(req),
    };
    const status = upper(req.query.status || "PENDING");
    if (status === "PENDING") filter.status = "PENDING";
    else if (status === "RECEIVED") filter.status = "APPROVED";
    else if (status === "LEDGER_UNCONFIRMED") {
      // Query receipt custody first, so older unconfirmed cash is not hidden
      // behind hundreds of already-confirmed (newer) handover batches.
      const unconfirmed=await Receipt.find({tenantKey:req.auth.tenantKey,financialYear,
        mode:"CASH",collectionSource:"SALESPERSON_APP",status:"POSTED",
        cashDepositStatus:"DEPOSITED_TO_CASHIER",cashierLedgerConfirmedAt:{$exists:false},
        cashDepositBatchId:{$nin:[null,""]}}).select("cashDepositBatchId").limit(3000).lean();
      const ids=[...new Set(unconfirmed.map(x=>String(x.cashDepositBatchId)).filter(isObjectIdText))];
      filter.status="APPROVED";filter._id={$in:ids};
    }
    else if (status && status !== "ALL") filter.handoverWorkflowStatus = status;
    const rows = await SalespersonCashMovement.find(filter)
      .select("+handoverOtpCode")
      .sort({ date: -1, createdAt: -1 }).limit(500).lean();
    const receiptIds=rows.flatMap(m=>(m.receiptBreakdown||[]).map(r=>r.receiptId)).filter(isObjectIdText);
    const receiptData=receiptIds.length?await Receipt.find({_id:{$in:receiptIds},tenantKey:req.auth.tenantKey,financialYear})
      .select('_id receiptNo customerGlobalId amount mode receiptType status customerOtpStatus collectionSource customerOtpVerifiedAt createdAt cashierLedgerConfirmedAt cashDenominations disputeStatus disputeRemark ledgerPostedAt').lean():[];
    const detailById=new Map(receiptData.map(r=>[String(r._id),r]));
    const receiptIndex=indexCashierReceipts(receiptData);
    const projected=rows.map(m=>({movement:m,live:projectCashierHandover(m,receiptIndex)}));
    const integrityWarningCount=projected.reduce((n,x)=>n+x.live.missingReceiptCount,0);
    const items = projected.filter(x=>x.live.rows.length>0).map(({movement:m,live}) => ({
      _id: String(m._id), movementNo: m.movementNo, date: m.date, amount: live.amount, cashAmount: live.cashAmount, bankAmount: live.chequeAmount, missingReceiptCount: live.missingReceiptCount, needsReconciliation: live.missingReceiptCount>0,
      salespersonId: m.salespersonId, salespersonName: m.salespersonNameSnapshot || "",
      cashierId: m.recipientUserId || "", cashierName: m.recipientName || "",
      status: m.status, handoverWorkflowStatus: m.handoverWorkflowStatus || "LEGACY",
      handoverOtpStatus: m.handoverOtpStatus || "NOT_REQUIRED",
      // Cashier-requested pickup OTP must be visible to its collector only.
      handoverOtp: m.handoverWorkflowStatus!=="CASHIER_REQUESTED"&&m.handoverOtpStatus === "PENDING" ? (m.handoverOtpCode || "") : "",
      handoverOtpExpiresAt: m.handoverOtpExpiresAt || null,
      denominations: m.denominations || [], receiptBreakdown: live.rows.filter(r=>["CASH","CHEQUE"].includes(upper(r.mode)))
        .map(r=>({...r,collectedAt:r.collectedAt||detailById.get(String(r.receiptId))?.customerOtpVerifiedAt||detailById.get(String(r.receiptId))?.createdAt||m.date,
          receiptDenominations:r.receiptDenominations?.length?r.receiptDenominations:detailById.get(String(r.receiptId))?.cashDenominations||[],
          cashierLedgerConfirmedAt:detailById.get(String(r.receiptId))?.cashierLedgerConfirmedAt||null,
          ledgerPostedAt:detailById.get(String(r.receiptId))?.ledgerPostedAt||null,disputeStatus:detailById.get(String(r.receiptId))?.disputeStatus||'NONE',disputeRemark:detailById.get(String(r.receiptId))?.disputeRemark||''})),
      partyIssues: (m.partyIssues || []).map((x) => ({
        issueId: x.issueId, receiptId: x.receiptId, receiptNo: x.receiptNo,
        customerGlobalId: x.customerGlobalId, partyName: x.partyNameSnapshot,
        amount: money2(x.amount), reason: x.reason, status: x.status,
        raisedAt: x.raisedAt, acknowledgedAt: x.acknowledgedAt, resolvedAt: x.resolvedAt,
        resolutionRemark: x.resolutionRemark || "",
      })),
      remarks: m.remarks || "", cashierReceivedAt: m.cashierReceivedAt || null,
      ledgerConfirmation: m.ledgerConfirmation || null,
    }));
    return ok(res, { financialYear, items, integrityWarningCount, notice: integrityWarningCount ? "Some handover snapshots point to missing, voided or altered receipts. They are excluded from active lists; Superadmin must reconcile incomplete batches before acceptance or day close." : "" });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

// Edit the non-financial cashier handover remark only. Receipt value,
// denomination, OTP and batch composition are immutable from DMS Cashier.
router.patch('/cashier/handovers/:id', async(req,res)=>{
  try{
    if(upper(req.auth.role||req.auth.roleCode)!=='SUPERADMIN')return fail(res,'Only Superadmin may edit a cashier handover',403);
    const financialYear=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body.financialYear});
    const {SalespersonCashMovement}=financialModels(req.auth.tenantKey,financialYear);
    const movement=await SalespersonCashMovement.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear,
      type:'HANDOVER',status:'PENDING',...cashierMovementScope(req)});
    if(!movement)return fail(res,'Only pending cashier handovers may be edited',409);
    const remarks=cleanText(req.body.remarks);
    if(remarks.length>500)return fail(res,'Remarks limited to 500 characters',422);
    movement.remarks=remarks;
    await movement.save();return ok(res,{id:String(movement._id),remarks},'Handover remarks edited; amounts and OTP unchanged');
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});
// Delete for an unverified handover means cancel/release the temporary request,
// NOT delete any posted customer receipts or physical-accounting evidence.
router.delete('/cashier/handovers/:id', async(req,res)=>{
  try{
    if(upper(req.auth.role||req.auth.roleCode)!=='SUPERADMIN')return fail(res,'Only Superadmin may cancel a cashier handover',403);
    const financialYear=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body?.financialYear||req.query.financialYear});
    const {SalespersonCashMovement,Receipt}=financialModels(req.auth.tenantKey,financialYear);
    const filter={_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear,type:'HANDOVER',status:'PENDING',
      handoverOtpStatus:'PENDING',handoverWorkflowStatus:'PENDING_SALESPERSON_OTP',...cashierMovementScope(req)};
    const cancelled=await SalespersonCashMovement.findOneAndUpdate(filter,{$set:{status:'CANCELLED',handoverWorkflowStatus:'CANCELLED',handoverOtpStatus:'CANCELLED'},$unset:{handoverOtpCode:''}},{new:false});
    if(!cancelled)return fail(res,'Only a cashier handover awaiting sender OTP may be cancelled. Verified or received handovers require a formal correction.',409);
    const receiptIds=(cancelled.receiptBreakdown||[]).map(x=>x.receiptId).filter(x=>mongoose.isValidObjectId(x));
    if(receiptIds.length)await Receipt.updateMany({tenantKey:req.auth.tenantKey,financialYear,_id:{$in:receiptIds},
      cashDepositBatchId:String(cancelled._id),cashDepositStatus:'HANDOVER_PENDING'},
      {$set:{cashDepositStatus:'PENDING_TO_DEPOSIT',cashDepositBatchId:''}});
    // Cancelling a mixed handover must release cheque custody as well as cash,
    // otherwise its cheque is permanently stuck in HANDOVER_REQUESTED.
    await GenericRecord.updateMany({tenantKey:req.auth.tenantKey,app:'dms',resource:'cheque-control-received',
      'data.cashierHandoverId':String(cancelled._id),'data.status':'HANDOVER_REQUESTED'},
      {$set:{'data.status':'PENDING_WITH_COLLECTOR','data.custodyStatus':'PENDING_WITH_COLLECTOR'},
       $unset:{'data.cashierHandoverId':''}});
    if(cancelled.handoverOtpId)await OtpChallenge.updateOne({tenantKey:req.auth.tenantKey,otpId:cancelled.handoverOtpId,
      transactionId:String(cancelled._id),status:'PENDING'},{$set:{status:'CANCELLED'}});
    return ok(res,{cancelled:true,movementNo:cancelled.movementNo},'Unverified handover cancelled and receipts released for resubmission; audit history kept');
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

// Cashier can issue a replacement OTP for an expired handover WITHOUT creating
// another receipt or splitting the one-OTP-per-bundle contract.
router.post("/cashier/handovers/:id/otp/refresh", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.body.financialYear || req.query.financialYear,
    });
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({
      _id: req.params.id,
      tenantKey: req.auth.tenantKey,
      financialYear,
      type: "HANDOVER",
      status: "PENDING",
      "receiptBreakdown.0": { $exists: true },
      ...cashierMovementScope(req),
    }).select("+handoverOtpCode");
    if (!movement) return fail(res, "Pending handover not found", 404);
    if (movement.handoverOtpStatus !== "PENDING") return fail(res, "This handover OTP has already been verified", 409);
    if (movement.handoverOtpCode && movement.handoverOtpExpiresAt && new Date(movement.handoverOtpExpiresAt) > new Date()) {
      return fail(res, "Current cashier OTP is still valid. Refresh the Pending Receipts page to view it.", 409);
    }
    const oldOtpId = movement.handoverOtpId;
    const otp = await createOtp({
      tenantKey: req.auth.tenantKey,
      transactionId: String(movement._id),
      actionType: "CASH_HANDOVER_CASHIER_TO_SALESPERSON",
      recipientId: movement.salespersonId,
      context: { movementNo: movement.movementNo, amount: movement.amount, cashierId: movement.recipientUserId, cashierName: movement.recipientName },
    });
    movement.handoverOtpId = otp.otpId;
    movement.handoverOtpCode = otp.code;
    movement.handoverOtpExpiresAt = otp.expiresAt;
    await movement.save();
    if (oldOtpId) await OtpChallenge.updateOne({ otpId: oldOtpId, status: "PENDING" }, { $set: { status: "EXPIRED" } });
    return ok(res, { movementId: String(movement._id), movementNo: movement.movementNo, handoverOtp: otp.code, handoverOtpExpiresAt: otp.expiresAt }, "New OTP generated for the existing cashier handover");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cashier/handovers/:id/issues", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.body.financialYear || req.query.financialYear });
    const { SalespersonCashMovement, OrderNotification } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({
      _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", status: "PENDING", "receiptBreakdown.0": { $exists: true },
      ...cashierMovementScope(req),
    });
    if (!movement) return fail(res, "Pending cash handover not found", 404);
    if (movement.handoverOtpStatus !== "VERIFIED") return fail(res, "Salesperson must first verify the handover OTP before the cashier can count the cash", 409);
    const receiptId = cleanText(req.body.receiptId);
    const row = (movement.receiptBreakdown || []).find((x) => String(x.receiptId) === receiptId || String(x.receiptNo) === receiptId);
    if (!row) return fail(res, "Select a party receipt from this handover", 400);
    const reason = cleanText(req.body.reason);
    if (!reason) return fail(res, "Enter the issue found while counting the party cash", 400);
    const duplicate = (movement.partyIssues || []).find((x) => (String(x.receiptId) === String(row.receiptId) || String(x.receiptNo) === String(row.receiptNo)) && openCashIssue(x));
    if (duplicate) return fail(res, `An open issue already exists for ${row.customerNameSnapshot || row.receiptNo}`, 409);

    const issueId = makeId("ISS");
    const otp = await createOtp({
      tenantKey: req.auth.tenantKey, transactionId: String(movement._id),
      actionType: "CASH_HANDOVER_ISSUE_SALESPERSON_ACK", recipientId: movement.salespersonId,
      context: { issueId, movementNo: movement.movementNo, receiptNo: row.receiptNo, customerGlobalId: row.customerGlobalId, amount: money2(row.amount) },
    });
    movement.partyIssues.push({
      issueId, receiptId: row.receiptId, receiptNo: row.receiptNo, customerGlobalId: row.customerGlobalId,
      partyNameSnapshot: row.customerNameSnapshot, amount: money2(row.amount), reason,
      status: "PENDING_SALESPERSON_ACK", acknowledgementOtpId: otp.otpId,
      acknowledgementOtpCode: otp.code, acknowledgementOtpExpiresAt: otp.expiresAt,
      raisedAt: new Date(), raisedBy: req.auth.sub, raisedByNameSnapshot: req.auth.name || "",
    });
    movement.handoverWorkflowStatus = "ISSUE_OPEN";
    await movement.save();

    if (row.customerGlobalId) await OrderNotification.create({
      tenantKey: req.auth.tenantKey, financialYear, notificationNo: makeId("NTF"),
      recipientType: "CUSTOMER", recipientId: row.customerGlobalId, channel: "IN_APP",
      title: `Cash collection issue • ${row.receiptNo || "Receipt"}`,
      body: `The cashier found an issue while checking the cash collected against ${row.receiptNo || "your receipt"}: ${reason}`,
      data: { notificationType: "CASH_COLLECTION_ISSUE", issueId, movementNo: movement.movementNo, receiptNo: row.receiptNo, amount: money2(row.amount), status: "OPEN", reason },
      status: "PENDING",
    });
    return ok(res, { issueId, movementNo: movement.movementNo, partyName: row.customerNameSnapshot, status: "PENDING_SALESPERSON_ACK" }, "Issue raised; ask the salesperson for the acknowledgement OTP shown in the Sales Person app", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cashier/handovers/:id/issues/:issueId/acknowledge", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.body.financialYear || req.query.financialYear });
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({
      _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", status: "PENDING", "receiptBreakdown.0": { $exists: true },
      ...cashierMovementScope(req),
    });
    if (!movement) return fail(res, "Pending cash handover not found", 404);
    const issue = (movement.partyIssues || []).find((x) => cleanText(x.issueId) === cleanText(req.params.issueId));
    if (!issue) return fail(res, "Cash issue not found", 404);
    if (issue.status === "ACKNOWLEDGED" || issue.status === "RESOLVED") return ok(res, { issueId: issue.issueId, status: issue.status }, "Issue is already acknowledged");
    const code = cleanText(req.body.code);
    if (!code) return fail(res, "Enter the OTP shown in the salesperson app", 400);
    const result = await verifyOtp({ otpId: issue.acknowledgementOtpId, code });
    if (!result.ok) return fail(res, result.reason, 400);
    if (String(result.challenge.transactionId) !== String(movement._id) || String(result.challenge.recipientId) !== String(movement.salespersonId)) return fail(res, "OTP does not belong to this salesperson handover", 409);
    issue.status = "ACKNOWLEDGED"; issue.acknowledgedAt = new Date(); issue.acknowledgedBy = req.auth.sub; issue.acknowledgementOtpCode = "";
    await movement.save();
    return ok(res, { issueId: issue.issueId, status: issue.status }, "Salesperson acknowledged the cash issue");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cashier/handovers/:id/receive", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.body.financialYear || req.query.financialYear });
    const { SalespersonCashMovement, Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({
      _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", "receiptBreakdown.0": { $exists: true },
      ...cashierMovementScope(req),
    });
    if (!movement) return fail(res, "Cash handover not found", 404);
    if (movement.status === "APPROVED") return ok(res, movement, "Cash handover is already received");
    if (movement.status !== "PENDING") return fail(res, `Cash handover is ${movement.status}`, 409);
    if (movement.handoverOtpStatus !== "VERIFIED") return fail(res, "Salesperson has not yet confirmed the cashier handover OTP", 409);
    if ((movement.receiptBreakdown||[]).some(r=>!["CASH","CHEQUE"].includes(upper(r.mode))))
      return fail(res,"Online/bank payments cannot enter physical cashier custody",409);
    const receiptIdsToCheck=(movement.receiptBreakdown||[]).map(r=>r.receiptId).filter(isObjectIdText);
    const live=await Receipt.find({_id:{$in:receiptIdsToCheck},tenantKey:req.auth.tenantKey,financialYear,
      cashDepositBatchId:String(movement._id),cashDepositStatus:'HANDOVER_PENDING',customerOtpStatus:'VERIFIED',
      disputeStatus:{$ne:'HOLD'},status:'POSTED'}).lean();
    if(live.length!==receiptIdsToCheck.length)return fail(res,'One or more receipts changed, are disputed, or do not belong to this handover',409);
    for(const row of movement.receiptBreakdown||[]){
      if(upper(row.mode)!=='CHEQUE')continue;
      const original=live.find(r=>String(r._id)===String(row.receiptId));
      if(!original||upper(original.receiptType)!=='CHEQUE'&&upper(original.mode)!=='CHEQUE')return fail(res,'Cheque is not linked to its original customer receipt',409);
      const exists=await GenericRecord.exists({tenantKey:req.auth.tenantKey,app:'dms',resource:'cheque-control-received',
        'data.linkedReceiptNo':row.receiptNo,'data.linkedReceiptFy':financialYear,'data.cashierHandoverId':String(movement._id),
        'data.status':{$in:['HANDOVER_REQUESTED','WITH_CASHIER']}});
      if(!exists)return fail(res,`Cheque ${row.receiptNo} was changed or is not registered`,409);
    }
    const openIssues = (movement.partyIssues || []).filter(openCashIssue);
    if (openIssues.length) return fail(res, `Resolve ${openIssues.length} cash issue(s) before receiving this handover`, 409, { issues: openIssues.map((x) => ({ issueId: x.issueId, partyName: x.partyNameSnapshot, status: x.status })) });

    // This confirms physical custody ONLY. Company Received visibility waits until day closing.
    for(const row of movement.receiptBreakdown||[]){if(upper(row.mode)!=='CHEQUE')continue;
      const result=await GenericRecord.updateOne({tenantKey:req.auth.tenantKey,app:'dms',resource:'cheque-control-received',
        'data.linkedReceiptNo':row.receiptNo,'data.linkedReceiptFy':financialYear,
        'data.cashierHandoverId':String(movement._id),'data.status':{$in:['HANDOVER_REQUESTED','WITH_CASHIER']}},
        {$set:{'data.status':'WITH_CASHIER','data.custodyStatus':'WITH_CASHIER','data.cashierUserId':cleanText(req.auth.sub),
          'data.cashierReceivedAt':new Date().toISOString()}});
      if(result.matchedCount!==1)return fail(res,'Cheque custody changed during cashier receipt. Please refresh.',409);
    }
    movement.status = "APPROVED";
    movement.handoverWorkflowStatus = "RECEIVED";
    // Bank-only handovers do not need to participate in cashier cash closing.
    // Cheque-only bundles also remain open until cashier closes the day.
    movement.cashierReceivedAt = new Date();
    movement.cashierReceivedBy = req.auth.sub;
    movement.cashierReceivedByNameSnapshot = req.auth.name || "";
    movement.verifiedBy = req.auth.sub;
    movement.verifiedByNameSnapshot = req.auth.name || "";
    movement.verifiedAt = movement.cashierReceivedAt;
    await movement.save();

    const receiptIds = (movement.receiptBreakdown || []).map((x) => x.receiptId).filter(isObjectIdText);
    if (receiptIds.length) await Receipt.updateMany(
      { _id: { $in: receiptIds }, tenantKey: req.auth.tenantKey, financialYear, cashDepositBatchId: String(movement._id) },
      { $set: {
        cashDepositStatus: "DEPOSITED_TO_CASHIER", cashDepositedAt: movement.cashierReceivedAt,
        cashDepositedBy: req.auth.sub, cashDepositedByNameSnapshot: req.auth.name || "",
        cashierOtpStatus: "VERIFIED", cashierOtpVerifiedAt: movement.handoverOtpVerifiedAt || movement.cashierReceivedAt,
        receiptWorkflowStatus: "COMPLETED",
      } },
    );
    const chequeIds=(movement.receiptBreakdown||[]).filter(r=>upper(r.mode)==='CHEQUE').map(r=>r.receiptId).filter(isObjectIdText);
    if(chequeIds.length)await Receipt.updateMany({_id:{$in:chequeIds},tenantKey:req.auth.tenantKey,financialYear,
      cashDepositBatchId:String(movement._id)},{$set:{chequeApprovalStatus:'AWAITING_CASHIER_CLOSE'}});
    return ok(res,{movementNo:movement.movementNo,amount:money2(movement.amount),cashAmount:money2(movement.cashAmount||0),
      chequeAmount:money2(movement.bankAmount||0),receivedAt:movement.cashierReceivedAt},
      'Cash and cheques accepted into cashier custody; ledger posting and Company Received transfer wait for day close');
  } catch (error) { return fail(res, error.message, error.statusCode || 500, error.details); }
});

// Customer OTP only verifies the collection. This action posts the party ledger
// AFTER physical cash custody is accepted by cashier; journal posting is
// idempotent and rejects duplicate/mismatched receipts.
router.post("/cashier/ledger-confirm", (req,res) => fail(res,
  'This action was retired. Collector handover is physical custody only. Cashier Close posts customer ledgers.',410));

router.get("/cashier/cashbook", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { SalespersonCashMovement, Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const movements = await SalespersonCashMovement.find({
      tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", status: "APPROVED", "receiptBreakdown.0": { $exists: true },
      ...cashierMovementScope(req),
    }).sort({ cashierReceivedAt: -1, date: -1 }).limit(1000).lean();
    const closureIds=[...new Set(movements.map(m=>cleanText(m.cashierCloseId)).filter(isObjectIdText))];
    const closures=closureIds.length?await SalespersonCashMovement.find({tenantKey:req.auth.tenantKey,financialYear,
      type:'CASHIER_CLOSE',_id:{$in:closureIds}}).select('_id status').lean():[];
    const closeStates=new Map(closures.map(m=>[String(m._id),upper(m.status)]));
    // Never resurrect a deleted receipt from the immutable handover snapshot.
    const sourceIds=[...new Set(movements.flatMap(m=>(m.receiptBreakdown||[]).map(r=>r.receiptId)).filter(isObjectIdText))];
    const sourceNos=[...new Set(movements.flatMap(m=>(m.receiptBreakdown||[]).filter(r=>!isObjectIdText(r.receiptId)).map(r=>cleanText(r.receiptNo)).filter(Boolean)))];
    const originalReceipts=sourceIds.length||sourceNos.length ? await Receipt.find({tenantKey:req.auth.tenantKey,financialYear,
      $or:[...sourceIds.length?[{_id:{$in:sourceIds}}]:[],...sourceNos.length?[{receiptNo:{$in:sourceNos}}]:[]]})
      .select('_id receiptNo customerGlobalId amount mode receiptType status customerOtpStatus collectionSource').lean() : [];
    const receiptIndex=indexCashierReceipts(originalReceipts);
    const projected=movements.map(m=>({movement:m,live:projectCashierHandover(m,receiptIndex)}));
    const integrityWarningCount=projected.reduce((n,x)=>n+x.live.missingReceiptCount,0);
    const items = [];
    for (const {movement:m,live} of projected) for (const r of live.rows) if(["CASH","CHEQUE"].includes(upper(r.mode))) items.push({
      id: `${m._id}:${r.receiptId || r.receiptNo}`, batchId: String(m._id), movementNo: m.movementNo,
      receivedAt: m.cashierReceivedAt || m.verifiedAt || m.date, salespersonName: m.salespersonNameSnapshot || "",
      receiptId: r.receiptId, receiptNo: r.receiptNo, customerGlobalId: r.customerGlobalId,
      partyName: r.customerNameSnapshot || "", mode: r.mode || "CASH", receiptType: r.receiptType || "", amount: money2(r.amount),
      cashierCloseId: m.cashierCloseId || "", cashierCloseStatus:m.cashierCloseId?(closeStates.get(String(m.cashierCloseId))||'REVIEW'):'NOT_CLOSED',
      collectedAt:r.collectedAt||m.date,denominations:r.receiptDenominations||[],
    });
    const total = money2(items.reduce((sum, x) => sum + num(x.amount), 0));
    const unclosedTotal = money2(items.filter((x) => x.mode === "CASH" && x.cashierCloseStatus!=="POSTED").reduce((sum, x) => sum + num(x.amount), 0));
    return ok(res, { financialYear, items, total, unclosedTotal, integrityWarningCount });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cashier/close-preview", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { SalespersonCashMovement, Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const unfinished=await SalespersonCashMovement.findOne({tenantKey:req.auth.tenantKey,financialYear,
      type:'CASHIER_CLOSE',status:'PENDING',recipientUserId:cleanText(req.auth.sub)}).sort({createdAt:1}).lean();
    const batches=await SalespersonCashMovement.find(unfinished?{
      tenantKey:req.auth.tenantKey,financialYear,type:'HANDOVER',status:'APPROVED',cashierCloseId:String(unfinished._id),
      cashierReceivedBy:cleanText(req.auth.sub)}:{
      tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", status: "APPROVED", "receiptBreakdown.0": { $exists: true },
      $or: [{ cashierCloseId: { $exists: false } }, { cashierCloseId: "" }, { cashierCloseId: null }],
      cashierReceivedBy:cleanText(req.auth.sub),
    }).sort({ cashierReceivedAt: 1, date: 1 }).lean();
    const receiptIds=[...new Set(batches.flatMap(b=>(b.receiptBreakdown||[]).map(r=>r.receiptId)).filter(isObjectIdText))];
    const receiptNos=[...new Set(batches.flatMap(b=>(b.receiptBreakdown||[]).filter(r=>!isObjectIdText(r.receiptId)).map(r=>cleanText(r.receiptNo)).filter(Boolean)))];
    const originals=receiptIds.length||receiptNos.length?await Receipt.find({tenantKey:req.auth.tenantKey,financialYear,
      $or:[...receiptIds.length?[{_id:{$in:receiptIds}}]:[],...receiptNos.length?[{receiptNo:{$in:receiptNos}}]:[]]})
      .select('_id receiptNo customerGlobalId amount mode receiptType status customerOtpStatus collectionSource').lean():[];
    const receiptIndex=indexCashierReceipts(originals);
    const checked=batches.map(b=>({batch:b,live:projectCashierHandover(b,receiptIndex)}));
    const integrityWarningCount=checked.reduce((n,x)=>n+x.live.missingReceiptCount,0);
    const expectedAmount=money2(checked.reduce((sum,x)=>sum+x.live.cashAmount,0));
    const chequeAmount=money2(checked.reduce((sum,x)=>sum+x.live.chequeAmount,0));
    return ok(res, {
      financialYear, expectedAmount, chequeAmount,pendingClosing:!!unfinished,integrityWarningCount,needsReconciliation:integrityWarningCount>0,
      savedDenominations:unfinished?.denominations||[],
      cashReceiptCount:checked.flatMap(x=>x.live.rows).filter(r=>upper(r.mode)==='CASH').length,
      chequeReceiptCount:checked.flatMap(x=>x.live.rows).filter(r=>upper(r.mode)==='CHEQUE').length,
      batchCount: batches.length,
      salespersonCount: new Set(batches.map((x) => x.salespersonId).filter(Boolean)).size,
      batches: checked.filter(x=>x.live.rows.length).map(({batch:x,live}) => ({ _id: String(x._id), movementNo: x.movementNo, salespersonName: x.salespersonNameSnapshot || "", amount: live.cashAmount, receivedAt: x.cashierReceivedAt || x.verifiedAt, needsReconciliation:live.missingReceiptCount>0 })),
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

// Day close is the ONLY DMS point that posts received physical CASH to party
// ledgers and moves accepted CHEQUES into Company Received. The in-progress
// closing is persisted for safe retry after transient failures (idempotent journals).
router.post("/cashier/close", async (req, res) => {
  try {
    if(!cashierWorkflowAllowed(req))return fail(res,'Cashier edit permission required',403);
    const tenantKey=req.auth.tenantKey;
    const financialYear=await resolveFinancialYear({tenantKey,requested:req.body?.financialYear||req.query.financialYear});
    const {SalespersonCashMovement,Receipt}=financialModels(tenantKey,financialYear);
    const actorScope={cashierReceivedBy:cleanText(req.auth.sub)};
    // Complete any interrupted closing rather than creating a second close.
    let closing=await SalespersonCashMovement.findOne({tenantKey,financialYear,type:'CASHIER_CLOSE',status:'PENDING',
      recipientUserId:cleanText(req.auth.sub)}).sort({createdAt:1});
    let batches=[];
    if(closing){
      batches=await SalespersonCashMovement.find({tenantKey,financialYear,type:'HANDOVER',status:'APPROVED',
        cashierCloseId:String(closing._id),...actorScope});
      if(!batches.length)return fail(res,'Incomplete cashier close has no linked batches. Contact Superadmin for reconciliation.',409);
    }else{
      batches=await SalespersonCashMovement.find({tenantKey,financialYear,type:'HANDOVER',status:'APPROVED',
        'receiptBreakdown.0':{$exists:true},$or:[{cashierCloseId:{$exists:false}},{cashierCloseId:''},{cashierCloseId:null}],...actorScope});
      if(!batches.length)return fail(res,'There are no cashier-received collections awaiting closing',409);
    }
    const rows=batches.flatMap(b=>(b.receiptBreakdown||[]).map(row=>({...row,batchId:String(b._id)})));
    if(rows.some(row=>!['CASH','CHEQUE'].includes(upper(row.mode))))return fail(res,'Legacy online/mixed receipt found; Superadmin must reconcile it',409);
    const cashRows=rows.filter(x=>upper(x.mode)==='CASH'),chequeRows=rows.filter(x=>upper(x.mode)==='CHEQUE');
    const cashAmount=money2(cashRows.reduce((sum,r)=>sum+num(r.amount),0)),chequeAmount=money2(chequeRows.reduce((sum,r)=>sum+num(r.amount),0));
    const receiptIds=rows.map(r=>r.receiptId);
    if(receiptIds.some(id=>!isObjectIdText(id))||new Set(receiptIds).size!==receiptIds.length)
      return fail(res,'Duplicated or invalid receipt references in handover; review before closing',409);
    const live=await Receipt.find({_id:{$in:receiptIds},tenantKey,financialYear,
      collectionSource:'SALESPERSON_APP',customerOtpStatus:'VERIFIED',status:'POSTED',disputeStatus:{$ne:'HOLD'},
      cashDepositStatus:'DEPOSITED_TO_CASHIER'}).lean();
    if(live.length!==receiptIds.length)return fail(res,'A cashier receipt is disputed, not verified, or not physically accepted',409);
    const byId=new Map(live.map(r=>[String(r._id),r]));
    for(const row of rows){const r=byId.get(String(row.receiptId));
      if(!r||r.receiptNo!==row.receiptNo||String(r.customerGlobalId)!==String(row.customerGlobalId)||Math.abs(num(r.amount)-num(row.amount))>0.009||
        upper(row.mode)!==(upper(r.receiptType)==='CHEQUE'||upper(r.mode)==='CHEQUE'?'CHEQUE':'CASH'))
        return fail(res,`Original customer/amount mismatch for ${row.receiptNo}`,409);
      if(String(r.cashDepositBatchId)!==row.batchId)return fail(res,'Receipt belongs to another handover',409);
    }
    const denominations=parseCashDenominations(closing?.denominations||req.body?.denominations||[]);
    const declaredAmount=denominationTotal2(denominations);
    if(cashAmount>0&&!denominations.length)return fail(res,'Enter physical cash denominations before closing',422);
    if(Math.abs(cashAmount-declaredAmount)>0.009)return fail(res,`Cash denomination total ₹${declaredAmount} must equal cash in custody ₹${cashAmount}`,409);
    // Validate cheque custody before any cash journals are posted.
    const registered=[];
    for(const row of chequeRows){
      const cheque=await GenericRecord.findOne({tenantKey,app:'dms',resource:'cheque-control-received',
        'data.linkedReceiptNo':row.receiptNo,'data.linkedReceiptFy':financialYear,
        'data.cashierHandoverId':row.batchId});
      if(!cheque||!['WITH_CASHIER','RECEIVED'].includes(upper(cheque.data?.status))||
        (cleanText(cheque.data?.customerGlobalId)&&cleanText(cheque.data?.customerGlobalId)!==cleanText(byId.get(String(row.receiptId))?.customerGlobalId))||
        Math.abs(num(cheque.data?.amount)-num(row.amount))>0.009)
        return fail(res,`Cheque ${row.receiptNo} is not physically held by cashier or its party/amount differs`,409);
      registered.push(cheque);
    }
    if(!closing){
      let movementNo=makeId('CSH-CLOSE');
      while(await SalespersonCashMovement.exists({tenantKey,financialYear,movementNo}))movementNo=makeId('CSH-CLOSE');
      closing=await SalespersonCashMovement.create({tenantKey,financialYear,movementNo,
        salespersonId:`CASHIER:${req.auth.sub}`,salespersonNameSnapshot:req.auth.name||'Cashier',
        recipientUserId:cleanText(req.auth.sub),recipientName:req.auth.name||'Cashier',
        date:new Date(),dayKey:new Date().toISOString().slice(0,10),type:'CASHIER_CLOSE',direction:'OUT',
        amount:cashAmount,bankAmount:chequeAmount,denominations,closeExpectedAmount:cashAmount,
        closeDeclaredAmount:declaredAmount,closeVariance:0,closeDate:new Date(),status:'PENDING',
        remarks:cleanText(req.body?.remarks),createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||''});
      const claimed=[];
      for(const batch of batches){
        const result=await SalespersonCashMovement.updateOne({_id:batch._id,tenantKey,financialYear,status:'APPROVED',
          $or:[{cashierCloseId:{$exists:false}},{cashierCloseId:''},{cashierCloseId:null}]},
          {$set:{cashierCloseId:String(closing._id)}});
        if(result.modifiedCount!==1){
          await SalespersonCashMovement.updateMany({_id:{$in:claimed}},{$set:{cashierCloseId:''}});
          await SalespersonCashMovement.updateOne({_id:closing._id},{$set:{status:'CANCELLED'}});
          return fail(res,'Another cashier close reserved a batch. Refresh and retry.',409);
        }
        claimed.push(batch._id);
      }
    }
    // Idempotent customer journals; a retry continues from the same closing.
    const results=[];
    for(const row of cashRows){results.push(await postCustodyApprovedReceipt({tenantKey,financialYear,
      receiptId:row.receiptId,channel:'CASH',actorId:req.auth.sub,actorName:req.auth.name||''}));}
    // Company Received cheque records are released AFTER the closing request.
    if(registered.length){
      const approval=await GenericRecord.findOneAndUpdate({tenantKey,app:'dms',resource:'cheque-control-approval-bundles',
        reference:`CASHIER-CLOSE:${closing._id}`},{$setOnInsert:{tenantKey,app:'dms',resource:'cheque-control-approval-bundles',
          reference:`CASHIER-CLOSE:${closing._id}`,title:`Cashier close ${closing.movementNo}`,status:'ACTIVE',
          createdBy:cleanText(req.auth.sub),data:{financialYear,status:'APPROVED',cashierId:cleanText(req.auth.sub),
            collectorId:'MULTIPLE',chequeIds:registered.map(c=>String(c._id)),receiptNos:chequeRows.map(r=>r.receiptNo),
            count:chequeRows.length,amount:chequeAmount,approvedAt:new Date(),approvedBy:cleanText(req.auth.sub),
            approvedByName:cleanText(req.auth.name),source:'CASHIER_DAY_CLOSE'}}},{upsert:true,new:true});
      for(let i=0;i<chequeRows.length;i++){
        const row=chequeRows[i],ch=registered[i];
        await GenericRecord.updateOne({_id:ch._id,tenantKey,app:'dms',resource:'cheque-control-received',
          'data.status':{$in:['WITH_CASHIER','RECEIVED']}},{$set:{'data.status':'RECEIVED','data.custodyStatus':'COMPANY_RECEIVED',
            'data.approvalBundleId':String(approval._id),'data.statusDate':new Date().toISOString().slice(0,10)}});
        await Receipt.updateOne({_id:row.receiptId,tenantKey,financialYear},
          {$set:{chequeApprovalStatus:'APPROVED',chequeApprovalBatchId:String(approval._id),receiptWorkflowStatus:'READY_TO_POST_LEDGER'}});
      }
    }
    await SalespersonCashMovement.updateOne({_id:closing._id,tenantKey,financialYear,status:'PENDING'},{$set:{status:'POSTED'}});
    return ok(res,{closingNo:closing.movementNo,amount:cashAmount,chequeAmount,
      cashPosted:results.filter(r=>!r.alreadyPosted).length,chequesTransferred:chequeRows.length,batchCount:batches.length},
      'Cashier closed: cash posted to parties; cheques transferred to Company Received. No duplicate postings.',201);
  }catch(error){return fail(res,error.message,error.statusCode||500,error.details);}
});

router.get("/payments", async (req, res) => {
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.query.financialYear,
    }),
    page = Math.max(1, Number(req.query.page || 1)),
    limit = Math.min(200, Math.max(10, Number(req.query.limit || 50))),
    q = String(req.query.q || "").trim();
  const { Payment } = financialModels(req.auth.tenantKey, financialYear);
  const filter = { tenantKey: req.auth.tenantKey, financialYear };
  const dateRange = transactionQueryDateRange(req);
  if (dateRange) filter.date = dateRange;
  if (q)
    filter.$or = [
      { paymentNo: new RegExp(q, "i") },
      { partyGlobalId: new RegExp(q, "i") },
      { partyNameSnapshot: new RegExp(q, "i") },
      { reference: new RegExp(q, "i") },
      { remarks: new RegExp(q, "i") },
      { bankNameSnapshot: new RegExp(q, "i") },
      { mode: new RegExp(q, "i") },
    ];
  const [items, total] = await Promise.all([
    Payment.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Payment.countDocuments(filter),
  ]);
  ok(res, { items, meta: pageMeta(page, limit, total) });
});
router.post("/payments", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey,
      date = parseStrictVoucherDate(req.body.date),
      financialYear =
        financialYearFromDate(date) ||
        (await resolveFinancialYear({
          tenantKey,
          requested: req.body.financialYear,
        })),
      amount = Number(req.body.amount || 0);
    if (amount <= 0)
      return fail(res, "Payment amount must be greater than zero");
    const partyId = req.body.partyGlobalId || req.body.party || "";
    const party = await resolveVoucherPostingParty(tenantKey, partyId, req.body.partyType);
    const mode = upper(req.body.mode || "BANK"),
      bank = await resolveTransactionBank(
        tenantKey,
        mode,
        req.body.bankAccountId,
      );
    const { Payment } = financialModels(tenantKey, financialYear);
    const paymentNo = req.body.paymentNo || makeId("PAY");
    if (await Payment.exists({tenantKey,financialYear,paymentNo})) return fail(res,"Payment number already exists in this FY",409);
    const payment = await Payment.create({
      tenantKey,
      financialYear,
      paymentNo,
      sourceKey:paymentNo,
      date,
      partyGlobalId: party.id,
      partyType: party.type,
      partyNameSnapshot: party.name,
      amount,
      mode,
      reference: req.body.reference || "",
      remarks: req.body.remarks || req.body.narration || "",
      bankAccountId: bank.bankAccountId,
      bankNameSnapshot: bank.bankName,
      status: "POSTED",
      createdBy: req.auth.sub,
      createdByNameSnapshot: req.auth.name || "",
    });
    try {
      await postBalancedEntries({
      tenantKey,
      financialYear,
      transactionId: paymentNo,
      transactionType: "PAYMENT",
      date,
      partyGlobalId: party.id,
      narration:
        req.body.remarks || req.body.narration || `Payment ${paymentNo}`,
      entries: [
        { accountCode: party.accountCode, ledgerId: party.ledgerId, debit: amount },
        {
          accountCode: bank.accountCode,
          ledgerId: bank.ledgerId,
          bankAccountId: bank.bankAccountId,
          credit: amount,
        },
      ],
    });
    } catch (error) { await payment.deleteOne(); throw error; }
    let balanceWarning="";
    if (bank.bankAccountId) {
      try { await recalculateBankRunningBalancesForVoucher({tenantKey,financialYear,bankAccountId:bank.bankAccountId}); }
      catch (e) { balanceWarning=e.message; }
    }
    return ok(res, {...payment.toObject(),balanceWarning}, "Payment posted", 201);
  } catch (error) {
    return fail(res, error.message, error.statusCode || 400);
  }
});

router.get("/expenses", async (req, res) => {
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested: req.query.financialYear,
    }),
    page = Math.max(1, Number(req.query.page || 1)),
    limit = Math.min(200, Math.max(10, Number(req.query.limit || 50))),
    q = String(req.query.q || "").trim();
  const { Expense } = financialModels(req.auth.tenantKey, financialYear);
  const filter = { tenantKey: req.auth.tenantKey, financialYear };
  const dateRange = transactionQueryDateRange(req);
  if (dateRange) filter.date = dateRange;
  if (q)
    filter.$or = [
      { expenseNo: new RegExp(q, "i") },
      { accountCode: new RegExp(q, "i") },
      { nature: new RegExp(q, "i") },
      { allocationMethod: new RegExp(q, "i") },
    ];
  const [items, total] = await Promise.all([
    Expense.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Expense.countDocuments(filter),
  ]);
  ok(res, { items, meta: pageMeta(page, limit, total) });
});

router.post("/receipts", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey,
      date = parseStrictVoucherDate(req.body.date),
      financialYear =
        financialYearFromDate(date) ||
        (await resolveFinancialYear({
          tenantKey,
          requested: req.body.financialYear,
        }));
    const amount = Number(req.body.amount || 0);
    if (amount <= 0)
      return fail(res, "Receipt amount must be greater than zero");
    const party = await resolveVoucherPostingParty(tenantKey,
      req.body.customerGlobalId || req.body.party || req.body.partyName,
      req.body.partyType,
    );
    const mode = upper(req.body.mode || "BANK"),
      bank = await resolveTransactionBank(
        tenantKey,
        mode,
        req.body.bankAccountId,
      );
    const { Receipt } = financialModels(tenantKey, financialYear);
    const receiptNo = req.body.receiptNo || makeId("RCT");
    if (await Receipt.exists({tenantKey,financialYear,receiptNo})) return fail(res,"Receipt number already exists in this FY",409);
    const receipt = await Receipt.create({
      tenantKey,
      financialYear,
      receiptNo,
      sourceKey:receiptNo,
      date,
      customerGlobalId: party.id,
      partyType: party.type,
      partyNameSnapshot: party.name,
      amount,
      mode,
      reference: req.body.reference || "",
      remarks: req.body.remarks || "",
      bankAccountId: bank.bankAccountId,
      bankNameSnapshot: bank.bankName,
      bounceStatus: "CLEAR",
      receiptWorkflowStatus: "DMS_DIRECT",
      customerOtpStatus: "NOT_REQUIRED",
      cashierOtpStatus: "NOT_REQUIRED",
      ledgerPostedAt: new Date(),
      status: "POSTED",
      createdBy: req.auth.sub,
      createdByNameSnapshot: req.auth.name || "",
    });
    try {
      await postBalancedEntries({
      tenantKey,
      financialYear,
      transactionId: receiptNo,
      transactionType: "RECEIPT",
      date,
      partyGlobalId: party.id,
      narration: req.body.remarks || `Receipt ${receiptNo}`,
      entries: [
        {
          accountCode: bank.accountCode,
          ledgerId: bank.ledgerId,
          bankAccountId: bank.bankAccountId,
          debit: amount,
        },
        { accountCode: party.accountCode, ledgerId: party.ledgerId, credit: amount },
      ],
    });
    } catch (error) { await receipt.deleteOne(); throw error; }
    let balanceWarning="";
    if (bank.bankAccountId) {
      try { await recalculateBankRunningBalancesForVoucher({tenantKey,financialYear,bankAccountId:bank.bankAccountId}); }
      catch (e) { balanceWarning=e.message; }
    }
    return ok(res, {...receipt.toObject(),balanceWarning}, "Receipt posted", 201);
  } catch (error) {
    return fail(res, error.message, error.statusCode || 400);
  }
});

router.post("/expenses", async (req, res) => {
  const tenantKey = req.auth.tenantKey,
    date = transactionDate(req.body.date),
    financialYear =
      financialYearFromDate(req.body.date) ||
      financialYearFromDate(date) ||
      (await resolveFinancialYear({
        tenantKey,
        requested: req.body.financialYear,
      }));
  const amount = Number(req.body.amount || 0);
  if (amount <= 0) return fail(res, "Expense amount must be greater than zero");
  const { Expense } = financialModels(tenantKey, financialYear);
  const transactionId = req.body.expenseNo || makeId("EXP");
  const expense = await Expense.create({
    tenantKey,
    financialYear,
    expenseNo: transactionId,
    date,
    accountCode: req.body.accountCode || "SYS_INDIRECT_EXPENSE",
    amount,
    nature: req.body.nature || "FIXED",
    allocationMethod: req.body.allocationMethod || "TURNOVER",
    branchId: req.body.branchId,
    productId: req.body.productId,
    customerGlobalId: req.body.customerGlobalId,
    status: "POSTED",
  });
  await postBalancedEntries({
    tenantKey,
    financialYear,
    transactionId,
    transactionType: "EXPENSE",
    date,
    partyGlobalId: req.body.customerGlobalId,
    narration: req.body.narration || "Expense",
    entries: [
      {
        accountCode: req.body.accountCode || "SYS_INDIRECT_EXPENSE",
        debit: amount,
      },
      {
        accountCode:
          req.body.paymentMode === "BANK" ? "SYS_BANK_ACCOUNT" : "SYS_CASH",
        credit: amount,
      },
    ],
  });
  ok(res, expense, "Expense posted", 201);
});

export default router;
