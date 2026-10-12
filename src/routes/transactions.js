import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import {
  Product,
  CustomerLink,
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
import {
  matchCustomerTransporters,
  matchInvoiceCityTransporters,
} from "../services/customerTransporterMatchingService.js";

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

async function customerTransportSnapshot({
  tenantKey,
  customer,
  selectedTransporterId = "",
  invoiceCityOnly = false,
}) {
  const locality = await resolveCustomerDeliveryMode({ tenantKey, customer });
  const billing =
    (customer?.addresses || []).find(
      (x) => upper(x?.type || "BILLING") === "BILLING",
    ) ||
    (customer?.addresses || [])[0] ||
    {};

  const matched = invoiceCityOnly
    ? await matchInvoiceCityTransporters({
        tenantKey,
        pincode: billing.pincode,
        city: billing.city,
      })
    : await matchCustomerTransporters({
        tenantKey,
        pincode: billing.pincode,
        city: billing.city,
      });
  const options = matched.items || [];

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
  if (cleanText(bankAccountId))
    bank = await BankAccount.findOne({
      tenantKey,
      $or: [
        { _id: bankAccountId },
        { bankAccountId: cleanText(bankAccountId) },
      ],
      status: "ACTIVE",
    }).lean();
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
        rows = readRows(req.file.buffer);
      } catch {
        return fail(res, "Unable to read Excel/CSV file", 400);
      }
      if (!rows.length) return fail(res, "Uploaded file has no rows", 400);
      const requestedFy = req.body.financialYear || "";
      const common = [
        { key: "date", label: "Date", type: "date" },
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
                label: "Customer ID / GSTIN / PAN",
                aliases: ["customer", "party", "gstin", "pan"],
                required: true,
              },
              ...common,
              { key: "mode", label: "Mode" },
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
                  label: "Party / Supplier ID",
                  aliases: ["party", "supplier"],
                  required: true,
                },
                ...common,
                { key: "mode", label: "Mode" },
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
          const date = transactionDate(body.date);
          const fy =
            financialYearFromDate(body.date) ||
            financialYearFromDate(date) ||
            (await resolveFinancialYear({
              tenantKey: req.auth.tenantKey,
              requested: requestedFy,
            }));
          const models = financialModels(req.auth.tenantKey, fy);
          if (type === "receipts") {
            const customer = await resolveReceiptCustomer(
              req.auth.tenantKey,
              body.customer,
            );
            if (!customer) {
              if (errors.length < 100)
                errors.push({
                  row: i + 2,
                  error: `Customer not found: ${body.customer || ""}`,
                });
              continue;
            }
            const receiptNo = cleanText(body.receiptNo) || makeId("RCT");
            if (
              await models.Receipt.exists({
                tenantKey: req.auth.tenantKey,
                financialYear: fy,
                receiptNo,
              })
            ) {
              duplicates++;
              continue;
            }
            const mode = upper(body.mode || "BANK");
            createdVoucher = await models.Receipt.create({
              tenantKey: req.auth.tenantKey,
              financialYear: fy,
              receiptNo,
              sourceKey: receiptNo,
              date,
              customerGlobalId: customer.globalCustomerId,
              partyNameSnapshot:
                customer.localName ||
                customer.displayIdentifier ||
                body.customer ||
                "Customer",
              amount,
              mode,
              reference: body.reference || "",
              bounceStatus: upper(body.bounceStatus || "CLEAR"),
              createdBy: req.auth.sub,
              createdByNameSnapshot: req.auth.name || "",
              status: "POSTED",
            });
            await postBalancedEntries({
              tenantKey: req.auth.tenantKey,
              financialYear: fy,
              transactionId: receiptNo,
              transactionType: "RECEIPT",
              date,
              partyGlobalId: customer.globalCustomerId,
              narration: `Receipt ${receiptNo}`,
              entries: [
                {
                  accountCode:
                    mode === "CASH" ? "SYS_CASH" : "SYS_BANK_ACCOUNT",
                  debit: amount,
                },
                { accountCode: "SYS_SUNDRY_DEBTORS", credit: amount },
              ],
            });
          } else if (type === "payments") {
            const paymentNo = cleanText(body.paymentNo) || makeId("PAY");
            if (
              await models.Payment.exists({
                tenantKey: req.auth.tenantKey,
                financialYear: fy,
                paymentNo,
              })
            ) {
              duplicates++;
              continue;
            }
            const mode = upper(body.mode || "BANK"),
              party = cleanText(body.partyGlobalId);
            const partyMap = await resolvePartyDisplayMap(req.auth.tenantKey, [
              party,
            ]);
            const partyName = partyMap.get(party)?.name || party || "Party";
            createdVoucher = await models.Payment.create({
              tenantKey: req.auth.tenantKey,
              financialYear: fy,
              paymentNo,
              sourceKey: paymentNo,
              date,
              partyGlobalId: party,
              partyNameSnapshot: partyName,
              amount,
              mode,
              reference: body.reference || "",
              createdBy: req.auth.sub,
              createdByNameSnapshot: req.auth.name || "",
              status: "POSTED",
            });
            await postBalancedEntries({
              tenantKey: req.auth.tenantKey,
              financialYear: fy,
              transactionId: paymentNo,
              transactionType: "PAYMENT",
              date,
              partyGlobalId: party,
              narration: `Payment ${paymentNo}`,
              entries: [
                { accountCode: "SYS_SUNDRY_CREDITORS", debit: amount },
                {
                  accountCode:
                    mode === "CASH" ? "SYS_CASH" : "SYS_BANK_ACCOUNT",
                  credit: amount,
                },
              ],
            });
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
      return ok(
        res,
        {
          received: rows.length,
          inserted,
          duplicates,
          invalid: errors.length,
          errors,
        },
        `${inserted} ${type} imported`,
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
        // New invoices use the city-only transporter list with exact-pincode
        // transporters excluded. Existing invoices keep the previous matcher so
        // historical edits do not become invalid merely because this rule changed.
        invoiceCityOnly: !existingInvoice,
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

  const warehouseId = cleanText(
    body.warehouseId || existingInvoice?.warehouseId,
  );
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
      !(body.allowNegativeStock === true || isQuickEntryImport)
    )
      throw Object.assign(
        new Error(
          `${p.name}: only ${available} ${p.basicUnit || p.unit || "PCS"} available`,
        ),
        { statusCode: 409 },
      );
    const { saleRate, gradeDiscountPct } = await resolvedProductRate({
      customer,
      product: p,
      row,
    });
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

    const matched = await matchInvoiceCityTransporters({
      tenantKey: req.auth.tenantKey,
      pincode: billing.pincode,
      city: billing.city,
    });
    const items = Array.isArray(matched.items) ? matched.items : [];
    const eligibleIds = items.map((item) => cleanText(item.transporterId)).filter(Boolean);
    const lastUsedTransporterId = await lastUsedEligibleTransporter({
      tenantKey: req.auth.tenantKey,
      customerGlobalId,
      eligibleIds,
      requestedFinancialYear: cleanText(req.query.financialYear),
    });
    const defaultTransporterId =
      lastUsedTransporterId || (items.length === 1 ? cleanText(items[0].transporterId) : "");

    return ok(res, {
      ...matched,
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
  const filter = applySalesInvoiceScope(
    { tenantKey: req.auth.tenantKey, financialYear },
    req.auth,
  );
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
  items = await enrichSalesInvoicesWithCreditState({
    models,
    tenantKey: req.auth.tenantKey,
    financialYear,
    invoices: items,
  });
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
  const filter = applySalesInvoiceScope(
    { _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear },
    req.auth,
  );
  const invoice = await SalesInvoice.findOne(filter).lean();
  if (!invoice) return fail(res, "Sales invoice not found", 404);
  const [withCredit] = await enrichSalesInvoicesWithCreditState({
    models,
    tenantKey: req.auth.tenantKey,
    financialYear,
    invoices: [invoice],
  });
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
      const filter = applySalesInvoiceScope(
        { _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear },
        req.auth,
      );
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
    const calc = await calculateSalesInvoice({
      auth: req.auth,
      body: req.body,
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
    if (preserveRequestedInvoiceNo && requestedInvoiceNo) {
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
    // One last source-of-truth check: never save an unregistered invoice under
    // the registered series, even if the browser sent an outdated number.
    const registeredSale = isRegisteredParty(calc.customer);
    const company = await CompanyProfile.findOne({ tenantKey: calc.tenantKey })
      .select("salesInvoicePrefix salesInvoiceSuffix").lean();
    const expectedPrefix = cleanText(company?.salesInvoicePrefix).replace(/\s+/g, "");
    const expectedSuffix = suffixForFinancialYear(company?.salesInvoiceSuffix, calc.financialYear)
      .replace(/[^0-9A-Za-z]/g, "");
    if (!registeredSale) {
      const expected = new RegExp(`^${escapeSalesRegex(expectedPrefix)}C\\d+${escapeSalesRegex(expectedSuffix)}$`, "i");
      if (!expected.test(series.invoiceNo))
        return fail(res, "An unregistered sale must have Prefix + C + Serial + FY suffix. Invoice was not saved.", 409);
    }
    // A deleted TEST invoice is archived (not erased), so its number can be
    // reused without colliding with the unique index or strict journal keys.
    if (!preserveRequestedInvoiceNo) {
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
        preserveRequestedInvoiceNo || manualInvoiceNo
          ? `Sales invoice ${series.invoiceNo} already exists in FY ${calc.financialYear}`
          : "Generated invoice number already exists. Update the series in Super Admin Profile.",
        409,
      );

    // DIRECT billing remains independent. Only a sourceOrderId explicitly supplied by
    // the Order Desk enables order-linked stock reservation and lifecycle updates.
    const sourceOrderId = cleanText(req.body.sourceOrderId || "");
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
      eInvoice: normalizedEInvoice(req.body),
      transportAssignment: calc.transportAssignment,
      branchId: req.body.branchId || req.auth.branch || "",
      warehouseId: calc.warehouseId,
      warehouseNameSnapshot:
        calc.warehouse.title || calc.warehouse.reference || "",
      assignedTo: req.body.assignedTo || "",
      // Order Desk posting creates a normal POSTED sales invoice. The linked
      // Sales Order separately moves to INVOICED; delivery is completed later
      // from the existing Mark Delivered action on the Sales Invoice page.
      workflowStatus: req.body.workflowStatus || "POSTED",
      releasedToWarehouseAt:
        req.body.workflowStatus === "RELEASED_TO_WAREHOUSE"
          ? new Date()
          : undefined,
      status: "POSTED",
      createdBy: req.auth.sub,
      createdByNameSnapshot: req.auth.name || "",
    });

    // Regular Sales Invoice sequencing is derived from invoices already saved in
    // calc.financialYear. Do not update the legacy global CompanyProfile counter;
    // otherwise an old FY could leak its sequence into a new FY.

    for (const it of calc.items) {
      if (sourceOrder) {
        const usedQty = Number(it.qty || 0);
        await Product.updateOne(
          { _id: it.productId, tenantKey: calc.tenantKey },
          { $inc: { currentStock: -usedQty, reservedStock: -usedQty } },
        );
        await Product.updateOne(
          {
            _id: it.productId,
            tenantKey: calc.tenantKey,
            reservedStock: { $lt: 0 },
          },
          { $set: { reservedStock: 0 } },
        );
      } else {
        await Product.updateOne(
          { _id: it.productId, tenantKey: calc.tenantKey },
          { $inc: { currentStock: -it.qty } },
        );
      }
      await StockMovement.create({
        tenantKey: calc.tenantKey,
        financialYear: calc.financialYear,
        date: calc.date,
        productId: it.productId,
        warehouseId: sourceOrder
          ? (sourceOrderItemMap.get(String(it.productId))?.warehouseId || calc.warehouseId)
          : calc.warehouseId,
        type: sourceOrder ? "ORDER_SALE" : "SALE",
        qtyIn: 0,
        qtyOut: it.qty,
        landedCost: it.landedCostSnapshot,
        referenceId: series.invoiceNo,
      });
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
          oi.reservedQty = Math.max(0, Number(oi.reservedQty || 0) - used);
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
      const complete = (sourceOrder.items || []).every(
        (x) => Number(x.invoicedQty || 0) >= Number(x.qty || 0) - 0.000001,
      );
      const packedConsumed = (sourceOrder.items || []).every(
        (x) =>
          Number(x.invoicedQty || 0) >= Number(x.packedQty || 0) - 0.000001,
      );
      sourceOrder.workflowStatus = complete ? "INVOICED" : "INVOICED_PARTIAL";
      sourceOrder.status = "PROCESSING";
      sourceOrder.lastWorkflowAt = new Date();
      sourceOrder.nextAction = complete
        ? "Prepare dispatch"
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
  const financialYear = await resolveFinancialYear({
      tenantKey: req.auth.tenantKey,
      requested:
        req.body.sourceFinancialYear ||
        req.query.financialYear ||
        req.body.financialYear,
    }),
    models = financialModels(req.auth.tenantKey, financialYear);
  const existing = await models.SalesInvoice.findOne({
    _id: req.params.id,
    tenantKey: req.auth.tenantKey,
    financialYear,
    status: "POSTED",
  });
  if (!existing) return fail(res, "Posted sales invoice not found", 404);
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


// ---------------------------
// DMS Cashier: salesperson cash handover / issues / cashbook / closing
// ---------------------------
const cashierMovementScope = (req) => isAdminAuth(req.auth) ? {} : { recipientUserId: cleanText(req.auth.sub) };
const openCashIssue = (issue) => !["RESOLVED", "CANCELLED"].includes(upper(issue?.status));

router.get("/cashier/handovers", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const filter = {
      tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", "receiptBreakdown.0": { $exists: true },
      ...cashierMovementScope(req),
    };
    const status = upper(req.query.status || "PENDING");
    if (status === "PENDING") filter.status = "PENDING";
    else if (status === "RECEIVED") filter.status = "APPROVED";
    else if (status && status !== "ALL") filter.handoverWorkflowStatus = status;
    const rows = await SalespersonCashMovement.find(filter)
      .select("+handoverOtpCode")
      .sort({ date: -1, createdAt: -1 }).limit(500).lean();
    const items = rows.map((m) => ({
      _id: String(m._id), movementNo: m.movementNo, date: m.date, amount: money2(m.amount),
      salespersonId: m.salespersonId, salespersonName: m.salespersonNameSnapshot || "",
      cashierId: m.recipientUserId || "", cashierName: m.recipientName || "",
      status: m.status, handoverWorkflowStatus: m.handoverWorkflowStatus || "LEGACY",
      handoverOtpStatus: m.handoverOtpStatus || "NOT_REQUIRED",
      handoverOtp: m.handoverOtpStatus === "PENDING" ? (m.handoverOtpCode || "") : "",
      handoverOtpExpiresAt: m.handoverOtpExpiresAt || null,
      denominations: m.denominations || [], receiptBreakdown: m.receiptBreakdown || [],
      partyIssues: (m.partyIssues || []).map((x) => ({
        issueId: x.issueId, receiptId: x.receiptId, receiptNo: x.receiptNo,
        customerGlobalId: x.customerGlobalId, partyName: x.partyNameSnapshot,
        amount: money2(x.amount), reason: x.reason, status: x.status,
        raisedAt: x.raisedAt, acknowledgedAt: x.acknowledgedAt, resolvedAt: x.resolvedAt,
        resolutionRemark: x.resolutionRemark || "",
      })),
      cashierReceivedAt: m.cashierReceivedAt || null,
    }));
    return ok(res, { financialYear, items });
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
    const openIssues = (movement.partyIssues || []).filter(openCashIssue);
    if (openIssues.length) return fail(res, `Resolve ${openIssues.length} cash issue(s) before receiving this handover`, 409, { issues: openIssues.map((x) => ({ issueId: x.issueId, partyName: x.partyNameSnapshot, status: x.status })) });

    movement.status = "APPROVED";
    movement.handoverWorkflowStatus = "RECEIVED";
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
      } },
    );
    return ok(res, { movementNo: movement.movementNo, amount: money2(movement.amount), receivedAt: movement.cashierReceivedAt }, "Cash received and added to cashier cashbook");
  } catch (error) { return fail(res, error.message, error.statusCode || 500, error.details); }
});

router.get("/cashier/cashbook", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const movements = await SalespersonCashMovement.find({
      tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", status: "APPROVED", "receiptBreakdown.0": { $exists: true },
      ...cashierMovementScope(req),
    }).sort({ cashierReceivedAt: -1, date: -1 }).limit(1000).lean();
    const items = [];
    for (const m of movements) for (const r of m.receiptBreakdown || []) items.push({
      id: `${m._id}:${r.receiptId || r.receiptNo}`, batchId: String(m._id), movementNo: m.movementNo,
      receivedAt: m.cashierReceivedAt || m.verifiedAt || m.date, salespersonName: m.salespersonNameSnapshot || "",
      receiptId: r.receiptId, receiptNo: r.receiptNo, customerGlobalId: r.customerGlobalId,
      partyName: r.customerNameSnapshot || "", amount: money2(r.amount), cashierCloseId: m.cashierCloseId || "",
    });
    const total = money2(items.reduce((sum, x) => sum + num(x.amount), 0));
    const unclosedTotal = money2(items.filter((x) => !x.cashierCloseId).reduce((sum, x) => sum + num(x.amount), 0));
    return ok(res, { financialYear, items, total, unclosedTotal });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cashier/close-preview", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const batches = await SalespersonCashMovement.find({
      tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", status: "APPROVED", "receiptBreakdown.0": { $exists: true },
      $or: [{ cashierCloseId: { $exists: false } }, { cashierCloseId: "" }, { cashierCloseId: null }],
      ...cashierMovementScope(req),
    }).sort({ cashierReceivedAt: 1, date: 1 }).lean();
    const expectedAmount = money2(batches.reduce((sum, x) => sum + num(x.amount), 0));
    return ok(res, {
      financialYear, expectedAmount, batchCount: batches.length,
      salespersonCount: new Set(batches.map((x) => x.salespersonId).filter(Boolean)).size,
      batches: batches.map((x) => ({ _id: String(x._id), movementNo: x.movementNo, salespersonName: x.salespersonNameSnapshot || "", amount: money2(x.amount), receivedAt: x.cashierReceivedAt || x.verifiedAt })),
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cashier/close", async (req, res) => {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.body.financialYear || req.query.financialYear });
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const batches = await SalespersonCashMovement.find({
      tenantKey: req.auth.tenantKey, financialYear, type: "HANDOVER", status: "APPROVED", "receiptBreakdown.0": { $exists: true },
      $or: [{ cashierCloseId: { $exists: false } }, { cashierCloseId: "" }, { cashierCloseId: null }],
      ...cashierMovementScope(req),
    });
    if (!batches.length) return fail(res, "There is no unclosed cashier collection", 409);
    const expectedAmount = money2(batches.reduce((sum, x) => sum + num(x.amount), 0));
    const denominations = parseCashDenominations(req.body.denominations);
    const declaredAmount = denominationTotal2(denominations);
    if (!denominations.length) return fail(res, "Enter closing denominations", 400);
    if (Math.abs(declaredAmount - expectedAmount) > 0.009) return fail(res, `Closing denomination total ₹${declaredAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })} must match cashier collection ₹${expectedAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`, 409);

    let movementNo = makeId("CSH-CLOSE");
    while (await SalespersonCashMovement.exists({ tenantKey: req.auth.tenantKey, financialYear, movementNo })) movementNo = makeId("CSH-CLOSE");
    const closing = await SalespersonCashMovement.create({
      tenantKey: req.auth.tenantKey, financialYear, movementNo,
      salespersonId: `CASHIER:${req.auth.sub}`, salespersonNameSnapshot: req.auth.name || "Cashier",
      recipientUserId: req.auth.sub, recipientName: req.auth.name || "Cashier",
      date: new Date(), dayKey: new Date().toISOString().slice(0, 10), type: "CASHIER_CLOSE", direction: "OUT",
      amount: expectedAmount, denominations, closeExpectedAmount: expectedAmount, closeDeclaredAmount: declaredAmount,
      closeVariance: money2(declaredAmount - expectedAmount), closeDate: new Date(), status: "POSTED",
      remarks: cleanText(req.body.remarks), createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "",
    });
    await SalespersonCashMovement.updateMany({ _id: { $in: batches.map((x) => x._id) } }, { $set: { cashierCloseId: String(closing._id) } });
    return ok(res, { closingNo: closing.movementNo, amount: expectedAmount, denominations, batchCount: batches.length }, "Cashier closed successfully", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
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
      date = transactionDate(req.body.date),
      financialYear =
        financialYearFromDate(req.body.date) ||
        financialYearFromDate(date) ||
        (await resolveFinancialYear({
          tenantKey,
          requested: req.body.financialYear,
        })),
      amount = Number(req.body.amount || 0);
    if (amount <= 0)
      return fail(res, "Payment amount must be greater than zero");
    const partyId = req.body.partyGlobalId || req.body.party || "";
    const party = await resolvePostingParty(tenantKey, partyId);
    if (!party)
      return fail(
        res,
        "Party is not ACTIVE. Complete and verify the migrated profile before Purchase/Payment.",
        400,
      );
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
      partyGlobalId: party.globalCustomerId,
      partyNameSnapshot: party.localName || party.displayIdentifier,
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
      partyGlobalId: party.globalCustomerId,
      narration:
        req.body.remarks || req.body.narration || `Payment ${paymentNo}`,
      entries: [
        { accountCode: partyAccountCodeOf(party), debit: amount },
        {
          accountCode: bank.accountCode,
          ledgerId: bank.ledgerId,
          bankAccountId: bank.bankAccountId,
          credit: amount,
        },
      ],
    });
    } catch (error) { await payment.deleteOne(); throw error; }
    return ok(res, payment, "Payment posted", 201);
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
      date = transactionDate(req.body.date),
      financialYear =
        financialYearFromDate(req.body.date) ||
        financialYearFromDate(date) ||
        (await resolveFinancialYear({
          tenantKey,
          requested: req.body.financialYear,
        }));
    const amount = Number(req.body.amount || 0);
    if (amount <= 0)
      return fail(res, "Receipt amount must be greater than zero");
    const party = await resolvePostingParty(
      tenantKey,
      req.body.customerGlobalId,
    );
    if (!party)
      return fail(
        res,
        "Party is not ACTIVE. Complete and verify the migrated profile before Receipt/Sales.",
        400,
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
      customerGlobalId: party.globalCustomerId,
      partyNameSnapshot: party.localName || party.displayIdentifier,
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
      partyGlobalId: party.globalCustomerId,
      narration: req.body.remarks || `Receipt ${receiptNo}`,
      entries: [
        {
          accountCode: bank.accountCode,
          ledgerId: bank.ledgerId,
          bankAccountId: bank.bankAccountId,
          debit: amount,
        },
        { accountCode: partyAccountCodeOf(party), credit: amount },
      ],
    });
    } catch (error) { await receipt.deleteOne(); throw error; }
    return ok(res, receipt, "Receipt posted", 201);
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
