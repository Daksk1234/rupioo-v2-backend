import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { financialModels } from "../services/accountingService.js";
import { GenericRecord, Product, CustomerLink, CompanyProfile, CompanyLedger, Lead, Employee, Candidate, JobOpening } from "../models/index.js";
import { sendBusinessEmail } from "../services/mailService.js";
import { buildLedgerPdf } from "../services/simplePdfService.js";
import XLSX from "xlsx";
import { buildGstReport } from "../services/gstReportsService.js";

const router=express.Router();router.use(requireAuth);
const reports=[
"Executive Company Health","Sales Summary","Sales by Product","Sales by Customer","Sales by Salesperson","Sales by Territory","Margin Colour Mix","Lead Funnel","Visit Achievement","Target Achievement","Collection Achievement","Purchase Summary","Supplier Performance","Landed Cost Analysis","Stock Summary","Closing Stock","Stock Ageing","Dead Stock","Warehouse Stock","Product Profitability","Trial Balance","Trading Account","Profit & Loss","Balance Sheet","Provisional Balance Sheet","Cash Flow","Fund Flow","Expense Analysis","Break-even","CMA Operating Statement","CMA Balance Sheet Analysis","Working Capital","Ratio Analysis","GSTR-1 Reconciliation","GSTR-2B Reconciliation","GSTR-3B Reconciliation","GSTR-9 Annual Reconciliation","GST Compliance Health","Customer Health","Customer Credit Exposure","Customer Rating Trend","Receipt & Bounce","Transporter Network","HR Attendance","HR Payroll","HR Leave","Production Plan vs Actual","Production Efficiency","WIP","QC & Rejection","Machine Downtime","Family Net Worth","Family Cash Flow","Barcode Registry","Storage Usage","Audit Trail"
];
const money=n=>Number(Number(n||0).toFixed(2));
const PROFIT_SENSITIVE_REPORT = /(profit|margin|trading|break-even|company health)/i;
const stripProfitFields = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(profit|margin)/i.test(key)));
};
router.get("/catalog",async(req,res)=>{
  const admin=isAdminAuth(req.auth);
  const list=reports.map((name,i)=>({id:`RPT-${String(i+1).padStart(3,"0")}`,name,formats:["SCREEN","PDF","EXCEL","PRINT"]}))
    .filter((report)=>admin || !PROFIT_SENSITIVE_REPORT.test(report.name));
  return ok(res,list);
});


const ledgerEmailOf = (customer) => {
  const contacts = Array.isArray(customer?.contacts) ? customer.contacts : [];
  return String(contacts.find((row) => row.primary && row.email)?.email || contacts.find((row) => row.email)?.email || "").trim();
};

const cleanText = (value) => String(value ?? "").trim();
const normalizeFY = (value) => {
  const raw = cleanText(value);
  const match = raw.match(/^(\d{4})\s*-\s*(\d{2}|\d{4})$/);
  if (!match) return raw;
  return `${match[1]}-${match[2].length === 4 ? match[2].slice(-2) : match[2]}`;
};
const fyStart = (fy) => {
  const start = Number(String(normalizeFY(fy)).split("-")[0]);
  return Number.isFinite(start) ? start : 0;
};
const fyLabel = (start) => `${start}-${String(start + 1).slice(-2)}`;
const signedOpening = (amount, type) => String(type || "DR").toUpperCase() === "CR" ? -Math.abs(Number(amount || 0)) : Math.abs(Number(amount || 0));
const signedOpeningObject = (signed, financialYear = "") => ({
  amount: money(Math.abs(Number(signed || 0))),
  type: Number(signed || 0) < 0 ? "CR" : "DR",
  financialYear: normalizeFY(financialYear),
  signed: money(signed),
});
const partyAccountCode = (customer) => {
  const configured = cleanText(customer?.accountingProfile?.systemAccountCode);
  if (configured) return configured;
  return ["CREDITOR", "SUPPLIER"].includes(cleanText(customer?.partyType).toUpperCase()) ? "SYS_SUNDRY_CREDITORS" : "SYS_SUNDRY_DEBTORS";
};
const friendlyVoucherType = (value) => {
  const raw = cleanText(value).toUpperCase();
  const map = {
    SALES_INVOICE: "Sales Invoice",
    PURCHASE_INVOICE: "Purchase Invoice",
    RECEIPT: "Receipt",
    PAYMENT: "Payment",
    EXPENSE: "Expense",
    JOURNAL: "Journal",
    CONTRA: "Contra",
    CREDIT_NOTE: "Credit Note",
    DEBIT_NOTE: "Debit Note",
  };
  return map[raw] || raw.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
};
const isoDateOnly = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return cleanText(value).slice(0, 10);
  return d.toISOString().slice(0, 10);
};
const safeFilePart = (value) => cleanText(value || "Ledger").replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "Ledger";

async function resolveLedgerEntity({ tenantKey, entityType, entityId }) {
  const type = cleanText(entityType || "PARTY").toUpperCase();
  const id = cleanText(entityId);
  if (!id) {
    const error = new Error("Select a party/account to view ledger");
    error.statusCode = 400;
    throw error;
  }

  if (type === "PARTY") {
    const customer = await CustomerLink.findOne({
      tenantKey,
      globalCustomerId: id,
      status: { $nin: ["INACTIVE", "DEACTIVATED"] },
    }).lean();
    if (!customer) {
      const error = new Error("Party not found");
      error.statusCode = 404;
      throw error;
    }
    return {
      entityType: "PARTY",
      entityId: customer.globalCustomerId,
      name: customer.localName || customer.displayIdentifier || "Party",
      accountCode: partyAccountCode(customer),
      ledgerId: "",
      ownerType: "CUSTOMER",
      customer,
      email: ledgerEmailOf(customer),
      opening: {
        amount: Number(customer?.accountingProfile?.openingBalance || 0),
        type: String(customer?.accountingProfile?.openingBalanceType || "DR").toUpperCase() === "CR" ? "CR" : "DR",
        financialYear: normalizeFY(customer?.accountingProfile?.financialYear || ""),
      },
    };
  }

  const ledger = await CompanyLedger.findOne({ tenantKey, ledgerId: id, status: { $ne: "INACTIVE" } }).lean();
  if (!ledger) {
    const error = new Error("Ledger account not found");
    error.statusCode = 404;
    throw error;
  }
  return {
    entityType: "LEDGER",
    entityId: ledger.ledgerId,
    name: ledger.name || ledger.ledgerId,
    accountCode: ledger.systemAccountCode || "",
    ledgerId: ledger.ledgerId,
    ownerType: ledger.ownerType || "OTHER",
    ledger,
    email: "",
    openingBalances: Array.isArray(ledger.openingBalances) ? ledger.openingBalances : [],
  };
}

const PARTY_CONTROL_ACCOUNTS = ["SYS_SUNDRY_DEBTORS", "SYS_SUNDRY_CREDITORS"];

function ledgerEntryFilter(entity, tenantKey, financialYear) {
  const base = { tenantKey, financialYear: normalizeFY(financialYear), status: "POSTED" };
  if (entity.entityType === "PARTY") {
    // A single business party can be both a customer and a supplier.  Always read
    // both personal control accounts and let DR/CR produce one net party balance.
    return { ...base, partyGlobalId: entity.entityId, accountCode: { $in: PARTY_CONTROL_ACCOUNTS } };
  }
  return { ...base, ledgerId: entity.ledgerId };
}

const partyTxnKey = (type, id) => `${cleanText(type).toUpperCase()}|${cleanText(id)}`;

async function partySourceRowsWithLegacyFallback({ tenantKey, entity, financialYear }) {
  const fy = normalizeFY(financialYear);
  const { LedgerEntry, SalesInvoice, PurchaseInvoice, Receipt, Payment } = financialModels(tenantKey, fy);
  const journalRows = await LedgerEntry.find(ledgerEntryFilter(entity, tenantKey, fy)).sort({ date: 1, createdAt: 1 }).lean();
  const represented = new Set(journalRows.map((row) => partyTxnKey(row.transactionType, row.transactionId)));

  // Previous-DMS/migrated records may have the business document but no V2
  // LedgerEntry.  Add only documents whose party control entry is missing.
  // Existing V2 journal rows win, so there is no double counting.
  const [sales, purchases, receipts, payments] = await Promise.all([
    SalesInvoice.find({ tenantKey, financialYear: fy, customerGlobalId: entity.entityId, status: "POSTED" })
      .select("_id invoiceNo date grandTotal remarks createdAt").lean(),
    PurchaseInvoice.find({ tenantKey, financialYear: fy, supplierGlobalId: entity.entityId, status: "POSTED" })
      .select("_id invoiceNo date grandTotal remarks createdAt").lean(),
    Receipt.find({ tenantKey, financialYear: fy, customerGlobalId: entity.entityId, status: "POSTED" })
      .select("_id receiptNo date amount remarks createdAt").lean(),
    Payment.find({ tenantKey, financialYear: fy, partyGlobalId: entity.entityId, status: "POSTED" })
      .select("_id paymentNo date amount remarks createdAt").lean(),
  ]);

  const fallback = [];
  for (const row of sales) {
    const key = partyTxnKey("SALES_INVOICE", row.invoiceNo);
    if (represented.has(key)) continue;
    fallback.push({
      _id: `LEGACY-SALES-${row._id}`, tenantKey, financialYear: fy, date: row.date, createdAt: row.createdAt,
      transactionType: "SALES_INVOICE", transactionId: cleanText(row.invoiceNo), partyGlobalId: entity.entityId,
      accountCode: "SYS_SUNDRY_DEBTORS", debit: Number(row.grandTotal || 0), credit: 0,
      narration: cleanText(row.remarks) || `Sales Invoice ${cleanText(row.invoiceNo)}`, status: "POSTED",
      sourceDocumentType: "SALES_INVOICE", sourceDocumentId: cleanText(row._id), legacyFallback: true,
    });
  }
  for (const row of purchases) {
    const key = partyTxnKey("PURCHASE_INVOICE", row.invoiceNo);
    if (represented.has(key)) continue;
    fallback.push({
      _id: `LEGACY-PURCHASE-${row._id}`, tenantKey, financialYear: fy, date: row.date, createdAt: row.createdAt,
      transactionType: "PURCHASE_INVOICE", transactionId: cleanText(row.invoiceNo), partyGlobalId: entity.entityId,
      accountCode: "SYS_SUNDRY_CREDITORS", debit: 0, credit: Number(row.grandTotal || 0),
      narration: cleanText(row.remarks) || `Purchase Invoice ${cleanText(row.invoiceNo)}`, status: "POSTED",
      sourceDocumentType: "PURCHASE_INVOICE", sourceDocumentId: cleanText(row._id), legacyFallback: true,
    });
  }
  for (const row of receipts) {
    const key = partyTxnKey("RECEIPT", row.receiptNo);
    if (represented.has(key)) continue;
    fallback.push({
      _id: `LEGACY-RECEIPT-${row._id}`, tenantKey, financialYear: fy, date: row.date, createdAt: row.createdAt,
      transactionType: "RECEIPT", transactionId: cleanText(row.receiptNo), partyGlobalId: entity.entityId,
      accountCode: "SYS_SUNDRY_DEBTORS", debit: 0, credit: Number(row.amount || 0),
      narration: cleanText(row.remarks) || `Receipt ${cleanText(row.receiptNo)}`, status: "POSTED", legacyFallback: true,
    });
  }
  for (const row of payments) {
    const key = partyTxnKey("PAYMENT", row.paymentNo);
    if (represented.has(key)) continue;
    fallback.push({
      _id: `LEGACY-PAYMENT-${row._id}`, tenantKey, financialYear: fy, date: row.date, createdAt: row.createdAt,
      transactionType: "PAYMENT", transactionId: cleanText(row.paymentNo), partyGlobalId: entity.entityId,
      accountCode: "SYS_SUNDRY_CREDITORS", debit: Number(row.amount || 0), credit: 0,
      narration: cleanText(row.remarks) || `Payment ${cleanText(row.paymentNo)}`, status: "POSTED", legacyFallback: true,
    });
  }

  return [...journalRows, ...fallback].sort((a, b) => {
    const ad = new Date(a.date || a.createdAt || 0).getTime();
    const bd = new Date(b.date || b.createdAt || 0).getTime();
    if (ad !== bd) return ad - bd;
    return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  });
}

async function ledgerMovementForFY({ tenantKey, entity, financialYear }) {
  const fy = normalizeFY(financialYear);
  const { LedgerEntry } = financialModels(tenantKey, fy);
  let source;
  if (entity.entityType === "PARTY") {
    source = await partySourceRowsWithLegacyFallback({ tenantKey, entity, financialYear: fy });
  } else {
    source = await LedgerEntry.find(ledgerEntryFilter(entity, tenantKey, fy)).select("debit credit").lean();
  }
  // Some company/system ledgers created before ledgerId posting existed only have
  // accountCode. Use that fallback only for non-personal COMPANY/OTHER ledgers so
  // two user/customer ledgers sharing one account code are never mixed together.
  if (!source.length && entity.entityType === "LEDGER" && ["COMPANY", "OTHER"].includes(entity.ownerType) && entity.accountCode) {
    source = await LedgerEntry.find({ tenantKey, financialYear: fy, accountCode: entity.accountCode, status: "POSTED" }).select("debit credit").lean();
  }
  return money(source.reduce((sum, row) => sum + Number(row.debit || 0) - Number(row.credit || 0), 0));
}

async function effectiveLedgerOpening({ tenantKey, entity, financialYear }) {
  const targetFY = normalizeFY(financialYear);
  const targetStart = fyStart(targetFY);
  if (!targetStart) return signedOpeningObject(0, targetFY);

  let amount = 0;
  let type = "DR";
  let baseFY = "";

  if (entity.entityType === "PARTY") {
    amount = Number(entity.opening?.amount || 0);
    type = entity.opening?.type || "DR";
    baseFY = normalizeFY(entity.opening?.financialYear || "");
    // Legacy masters without an opening FY used the saved opening in the active FY.
    if (!baseFY) return signedOpeningObject(signedOpening(amount, type), targetFY);
  } else {
    const rows = (entity.openingBalances || [])
      .map((row) => ({ ...row, financialYear: normalizeFY(row.financialYear) }))
      .filter((row) => fyStart(row.financialYear));
    const exact = rows.find((row) => row.financialYear === targetFY);
    if (exact) return signedOpeningObject(signedOpening(exact.amount, exact.type), targetFY);
    const previous = rows
      .filter((row) => fyStart(row.financialYear) < targetStart)
      .sort((a, b) => fyStart(b.financialYear) - fyStart(a.financialYear))[0];
    if (!previous) return signedOpeningObject(0, targetFY);
    amount = Number(previous.amount || 0);
    type = previous.type || "DR";
    baseFY = previous.financialYear;
  }

  const baseStart = fyStart(baseFY);
  if (!baseStart) return signedOpeningObject(signedOpening(amount, type), targetFY);
  if (targetStart < baseStart) return signedOpeningObject(0, targetFY);
  if (targetStart === baseStart) return signedOpeningObject(signedOpening(amount, type), targetFY);

  let signed = signedOpening(amount, type);
  for (let start = baseStart; start < targetStart; start += 1) {
    signed += await ledgerMovementForFY({ tenantKey, entity, financialYear: fyLabel(start) });
  }
  return signedOpeningObject(signed, targetFY);
}

async function fetchLedgerSourceRows({ tenantKey, entity, financialYear }) {
  const fy = normalizeFY(financialYear);
  const { LedgerEntry } = financialModels(tenantKey, fy);
  let source = entity.entityType === "PARTY"
    ? await partySourceRowsWithLegacyFallback({ tenantKey, entity, financialYear: fy })
    : await LedgerEntry.find(ledgerEntryFilter(entity, tenantKey, fy)).sort({ date: 1, createdAt: 1 }).lean();
  if (!source.length && entity.entityType === "LEDGER" && ["COMPANY", "OTHER"].includes(entity.ownerType) && entity.accountCode) {
    source = await LedgerEntry.find({ tenantKey, financialYear: fy, accountCode: entity.accountCode, status: "POSTED" }).sort({ date: 1, createdAt: 1 }).lean();
  }
  return source;
}

async function attachSourceDocuments({ tenantKey, financialYear, rows }) {
  const fy = normalizeFY(financialYear);
  const { SalesInvoice, PurchaseInvoice } = financialModels(tenantKey, fy);
  const salesNos = [...new Set(rows.filter((row) => cleanText(row.transactionType).toUpperCase() === "SALES_INVOICE").map((row) => cleanText(row.transactionId)).filter(Boolean))];
  const purchaseNos = [...new Set(rows.filter((row) => cleanText(row.transactionType).toUpperCase() === "PURCHASE_INVOICE").map((row) => cleanText(row.transactionId)).filter(Boolean))];
  const [sales, purchases] = await Promise.all([
    salesNos.length ? SalesInvoice.find({ tenantKey, financialYear: fy, invoiceNo: { $in: salesNos } }).select("_id invoiceNo").lean() : [],
    purchaseNos.length ? PurchaseInvoice.find({ tenantKey, financialYear: fy, invoiceNo: { $in: purchaseNos } }).select("_id invoiceNo").lean() : [],
  ]);
  const salesMap = new Map(sales.map((row) => [cleanText(row.invoiceNo), cleanText(row._id)]));
  const purchaseMap = new Map(purchases.map((row) => [cleanText(row.invoiceNo), cleanText(row._id)]));
  return rows.map((row) => {
    const type = cleanText(row.transactionType).toUpperCase();
    const key = cleanText(row.transactionId);
    if (type === "SALES_INVOICE" && salesMap.has(key)) return { ...row, sourceDocumentType: "SALES_INVOICE", sourceDocumentId: salesMap.get(key) };
    if (type === "PURCHASE_INVOICE" && purchaseMap.has(key)) return { ...row, sourceDocumentType: "PURCHASE_INVOICE", sourceDocumentId: purchaseMap.get(key) };
    return row;
  });
}

async function buildLedgerStatement({ tenantKey, financialYear, entityType = "PARTY", entityId, startDate = "", endDate = "" }) {
  const fy = normalizeFY(financialYear || "2026-27");
  const entity = await resolveLedgerEntity({ tenantKey, entityType, entityId });
  const opening = await effectiveLedgerOpening({ tenantKey, entity, financialYear: fy });
  let source = await fetchLedgerSourceRows({ tenantKey, entity, financialYear: fy });
  source = await attachSourceDocuments({ tenantKey, financialYear: fy, rows: source });

  const from = cleanText(startDate);
  const to = cleanText(endDate);
  if (from) source = source.filter((row) => isoDateOnly(row.date) >= from);
  if (to) source = source.filter((row) => isoDateOnly(row.date) <= to);

  let runningSigned = Number(opening.signed || 0);
  const rows = source.map((entry) => {
    const debit = money(entry.debit);
    const credit = money(entry.credit);
    runningSigned = money(runningSigned + debit - credit);
    const transactionType = cleanText(entry.transactionType);
    const narration = cleanText(entry.narration);
    const receiptPayment = ["RECEIPT", "PAYMENT"].includes(transactionType.toUpperCase());
    const particular = receiptPayment && narration ? `${entity.name} - ${narration}` : entity.name;
    return {
      id: cleanText(entry._id),
      date: entry.date,
      particular,
      voucherType: friendlyVoucherType(transactionType),
      voucherNo: cleanText(entry.transactionId),
      transactionType,
      transactionId: cleanText(entry.transactionId),
      narration,
      debit,
      credit,
      runningBalance: money(Math.abs(runningSigned)),
      runningBalanceType: runningSigned < 0 ? "CR" : "DR",
      sourceDocumentType: entry.sourceDocumentType || "",
      sourceDocumentId: entry.sourceDocumentId || "",
    };
  });

  const openingDebit = opening.type === "DR" ? Number(opening.amount || 0) : 0;
  const openingCredit = opening.type === "CR" ? Number(opening.amount || 0) : 0;
  const movementDebit = money(rows.reduce((sum, row) => sum + Number(row.debit || 0), 0));
  const movementCredit = money(rows.reduce((sum, row) => sum + Number(row.credit || 0), 0));
  const totalDebit = money(openingDebit + movementDebit);
  const totalCredit = money(openingCredit + movementCredit);
  const closingDiff = money(Math.abs(totalDebit - totalCredit));
  const showOnDebit = totalCredit > totalDebit;
  const showOnCredit = totalDebit > totalCredit;
  const balancedTotal = money(Math.max(totalDebit, totalCredit));
  const actualSignedClosing = money(Number(opening.signed || 0) + movementDebit - movementCredit);

  const company = await CompanyProfile.findOne({ tenantKey }).lean();
  return {
    entity: {
      entityType: entity.entityType,
      entityId: entity.entityId,
      name: entity.name,
      accountCode: entity.accountCode,
      ownerType: entity.ownerType,
      email: entity.email || "",
    },
    financialYear: fy,
    filters: { startDate: from, endDate: to },
    opening,
    rows,
    summary: {
      openingDebit: money(openingDebit),
      openingCredit: money(openingCredit),
      movementDebit,
      movementCredit,
      totalDebit,
      totalCredit,
      closingDiff,
      showOnDebit,
      showOnCredit,
      balancedTotal,
      actualClosingBalance: money(Math.abs(actualSignedClosing)),
      actualClosingType: actualSignedClosing < 0 ? "CR" : "DR",
      signedClosing: actualSignedClosing,
    },
    company: company ? {
      companyName: company.companyName || company.tradeName || "",
      tradeName: company.tradeName || "",
      registeredAddress: company.registeredAddress || "",
      mobile: company.mobile || "",
      email: company.email || "",
      gstin: company.gstin || "",
    } : {},
  };
}

router.get("/ledger/options", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey;
    const [customers, ledgers] = await Promise.all([
      CustomerLink.find({ tenantKey, status: { $nin: ["INACTIVE", "DEACTIVATED"] } })
        .select("globalCustomerId localName displayIdentifier partyType accountingProfile contacts status")
        .sort({ localName: 1 }).limit(5000).lean(),
      CompanyLedger.find({ tenantKey, status: { $ne: "INACTIVE" }, ownerType: { $ne: "CUSTOMER" } })
        .sort({ name: 1 }).limit(5000).lean(),
    ]);
    const partyOptions = customers.map((customer) => ({
      entityType: "PARTY",
      entityId: customer.globalCustomerId,
      name: customer.localName || customer.displayIdentifier || "Party",
      label: customer.localName || customer.displayIdentifier || "Party",
      accountType: customer.partyType || "CUSTOMER",
      accountCode: partyAccountCode(customer),
      email: ledgerEmailOf(customer),
      openingBalance: Number(customer?.accountingProfile?.openingBalance || 0),
      openingBalanceType: customer?.accountingProfile?.openingBalanceType || "DR",
      openingFinancialYear: normalizeFY(customer?.accountingProfile?.financialYear || ""),
    }));
    const accountOptions = ledgers.map((ledger) => ({
      entityType: "LEDGER",
      entityId: ledger.ledgerId,
      name: ledger.name || ledger.ledgerId,
      label: ledger.name || ledger.ledgerId,
      accountType: ledger.ownerType || ledger.relationshipType || "ACCOUNT",
      accountCode: ledger.systemAccountCode || "",
      ledgerId: ledger.ledgerId,
    }));
    const items = [...partyOptions, ...accountOptions].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
    return ok(res, { items, total: items.length }, "Ledger options loaded");
  } catch (error) {
    return fail(res, error.message, error.statusCode || 500);
  }
});

router.get("/ledger/statement", async (req, res) => {
  try {
    const data = await buildLedgerStatement({
      tenantKey: req.auth.tenantKey,
      financialYear: req.query.financialYear,
      entityType: req.query.entityType,
      entityId: req.query.entityId || req.query.partyGlobalId,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    return ok(res, data, "Ledger generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || 500);
  }
});

router.get("/ledger/export.xlsx", async (req, res) => {
  try {
    const data = await buildLedgerStatement({
      tenantKey: req.auth.tenantKey,
      financialYear: req.query.financialYear,
      entityType: req.query.entityType,
      entityId: req.query.entityId || req.query.partyGlobalId,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    const rows = [];
    rows.push(["THIS LEDGER IS GENERATED IN RUPIO SOFT"]);
    if (data.company.companyName) rows.push([data.company.companyName]);
    if (data.company.registeredAddress) rows.push([data.company.registeredAddress]);
    if (data.company.email) rows.push([data.company.email]);
    if (data.company.mobile) rows.push([data.company.mobile]);
    rows.push([`${data.entity.name} - Ledger (${data.financialYear})`]);
    rows.push([]);
    rows.push(["Date", "Particular", "Voucher Type", "Voucher No", "Debit", "Credit"]);
    rows.push(["", `Opening Balance (${data.financialYear})`, "", "", data.summary.openingDebit || "", data.summary.openingCredit || ""]);
    for (const row of data.rows) rows.push([isoDateOnly(row.date), row.particular, row.voucherType, row.voucherNo, row.debit || "", row.credit || ""]);
    rows.push(["", "Closing Balance", "", "", data.summary.showOnDebit ? data.summary.closingDiff : "", data.summary.showOnCredit ? data.summary.closingDiff : ""]);
    rows.push(["", "Total", "", "", data.summary.balancedTotal, data.summary.balancedTotal]);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 48 }, { wch: 22 }, { wch: 22 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws, "Ledger");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const name = safeFilePart(data.entity.name);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Ledger_${name}_${data.financialYear}.xlsx"`);
    return res.send(buf);
  } catch (error) {
    return fail(res, error.message, error.statusCode || 500);
  }
});

router.get("/ledger/pdf", async (req, res) => {
  try {
    const data = await buildLedgerStatement({
      tenantKey: req.auth.tenantKey,
      financialYear: req.query.financialYear,
      entityType: req.query.entityType,
      entityId: req.query.entityId || req.query.partyGlobalId,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    const pdf = await buildLedgerPdf({ company: data.company, customer: { localName: data.entity.name }, financialYear: data.financialYear, entries: data.rows, summary: data.summary, opening: data.opening });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Ledger_${safeFilePart(data.entity.name)}_${data.financialYear}.pdf"`);
    return res.send(pdf);
  } catch (error) {
    return fail(res, error.message, error.statusCode || 500);
  }
});

router.post("/ledger/email", async(req,res)=>{
  try{
    const financialYear=normalizeFY(req.body.financialYear||"2026-27");
    const entityType=cleanText(req.body.entityType||"PARTY").toUpperCase();
    const entityId=cleanText(req.body.entityId||req.body.partyGlobalId);
    if(entityType!=="PARTY")return fail(res,"Ledger email is available for customer/supplier parties only",400);
    const data=await buildLedgerStatement({tenantKey:req.auth.tenantKey,financialYear,entityType,entityId,startDate:req.body.startDate,endDate:req.body.endDate});
    const customer=await CustomerLink.findOne({tenantKey:req.auth.tenantKey,globalCustomerId:entityId,status:{$nin:["INACTIVE","DEACTIVATED"]}}).lean();
    if(!customer)return fail(res,"Party not found",404);
    const to=ledgerEmailOf(customer);if(!to)return fail(res,"Selected party does not have an email address",400);
    const pdf=await buildLedgerPdf({company:data.company,customer:{localName:data.entity.name},financialYear:data.financialYear,entries:data.rows,summary:data.summary,opening:data.opening});
    await sendBusinessEmail({
      to,
      subject:`Ledger Statement - ${data.entity.name} - ${data.financialYear}`,
      text:`Dear ${data.entity.name},\n\nPlease find attached your ledger statement for ${data.financialYear}.\nClosing balance: INR ${Number(data.summary.actualClosingBalance||0).toFixed(2)} ${data.summary.actualClosingType}.\n\nRegards,\n${data.company.companyName || "Rupioo Global"}`,
      html:`<div style="font-family:Arial,sans-serif"><h2>Ledger Statement</h2><p>Dear ${data.entity.name},</p><p>Please find attached your ledger statement for <b>${data.financialYear}</b>.</p><p><b>Closing balance:</b> INR ${Number(data.summary.actualClosingBalance||0).toFixed(2)} ${data.summary.actualClosingType}</p></div>`,
      attachments:[{filename:`Ledger_${safeFilePart(data.entity.name)}_${data.financialYear}.pdf`,content:pdf,contentType:"application/pdf"}],
    });
    return ok(res,{to,financialYear:data.financialYear,entityId,entries:data.rows.length},`Ledger emailed to ${to}`);
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

async function partyLedgerRows({ tenantKey, financialYear, partyGlobalId }) {
  const data = await buildLedgerStatement({ tenantKey, financialYear, entityType: "PARTY", entityId: partyGlobalId });
  return {
    rows: data.rows.map((row) => ({
      date: row.date,
      transactionType: row.transactionType,
      transactionId: row.transactionId,
      narration: row.narration,
      debit: row.debit,
      credit: row.credit,
      balance: row.runningBalanceType === "CR" ? -row.runningBalance : row.runningBalance,
    })),
    summary: {
      totalDebit: data.summary.movementDebit,
      totalCredit: data.summary.movementCredit,
      balance: data.summary.signedClosing,
    },
  };
}


const gstReportArgs = (req) => ({
  tenantKey: req.auth.tenantKey,
  financialYear: String(req.query.financialYear || "2026-27"),
  startDate: String(req.query.startDate || "").trim(),
  endDate: String(req.query.endDate || "").trim(),
});

router.get("/gst/:kind", async (req, res) => {
  try {
    const data = await buildGstReport(req.params.kind, gstReportArgs(req));
    return ok(res, data, "GST report generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || 500);
  }
});

const cleanSheetName = (name) => String(name || "Report").replace(/[\\/?*\[\]:]/g, " ").slice(0, 31) || "Report";
const appendSheet = (wb, name, rows) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  const ws = XLSX.utils.json_to_sheet(safeRows.length ? safeRows : [{ message: "No data" }]);
  const keys = safeRows.length ? Object.keys(safeRows[0]) : ["message"];
  ws["!cols"] = keys.map((key) => ({
    wch: Math.min(45, Math.max(String(key).length + 2, ...safeRows.slice(0, 300).map((r) => String(r?.[key] ?? "").length + 2), 10)),
  }));
  XLSX.utils.book_append_sheet(wb, ws, cleanSheetName(name));
};

router.get("/gst-export/:kind.xlsx", async (req, res) => {
  try {
    const data = await buildGstReport(req.params.kind, gstReportArgs(req));
    const wb = XLSX.utils.book_new();
    const kind = String(data.report || req.params.kind).toUpperCase();
    if (data.sections) Object.entries(data.sections).forEach(([name, rows]) => appendSheet(wb, name, rows));
    else if (kind === "GSTR3B") {
      appendSheet(wb, "Nature of Supplies", data.natureOfSupplies);
      appendSheet(wb, "Eligible ITC", data.eligibleITC);
    } else if (kind === "HSN") {
      appendSheet(wb, "Regular", data.regular);
      appendSheet(wb, "UnRegister", data.unregister);
      appendSheet(wb, "Reconciliation", [
        { Metric:"Taxable", HSN:data.reconciliation?.hsn?.taxable, Sales:data.reconciliation?.sales?.taxable },
        { Metric:"CGST", HSN:data.reconciliation?.hsn?.cgst, Sales:data.reconciliation?.sales?.cgst },
        { Metric:"SGST", HSN:data.reconciliation?.hsn?.sgst, Sales:data.reconciliation?.sales?.sgst },
        { Metric:"IGST", HSN:data.reconciliation?.hsn?.igst, Sales:data.reconciliation?.sales?.igst },
        { Metric:"Round Off", HSN:data.reconciliation?.hsn?.roundOff, Sales:data.reconciliation?.sales?.roundOff },
        { Metric:"Grand Total", HSN:data.reconciliation?.hsn?.grand, Sales:data.reconciliation?.sales?.grand },
      ]);
    } else appendSheet(wb, kind, data.rows || []);
    const buf = XLSX.write(wb, { type:"buffer", bookType:"xlsx" });
    const fy = String(data.financialYear || "FY").replace(/[^0-9A-Za-z-]/g, "_");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${kind}_${fy}.xlsx"`);
    return res.send(buf);
  } catch (error) {
    return fail(res, error.message, error.statusCode || 500);
  }
});

router.get("/run",async(req,res)=>{
  const name=String(req.query.name||"Report"),financialYear=String(req.query.financialYear||"2026-27"),tenantKey=req.auth.tenantKey;
  const admin=isAdminAuth(req.auth);
  if(!admin && PROFIT_SENSITIVE_REPORT.test(name)) return fail(res,"Profit, margin and profitability reports are restricted to Admin users",403);
  const {LedgerEntry,SalesInvoice,PurchaseInvoice,Receipt,Payment,StockMovement,Expense}=financialModels(tenantKey,financialYear);
  let rows=[],summary={};
  if(/trial balance/i.test(name)){
    rows=await LedgerEntry.aggregate([{$match:{tenantKey,financialYear,status:"POSTED"}},{$group:{_id:"$accountCode",debit:{$sum:"$debit"},credit:{$sum:"$credit"}}},{$project:{_id:0,accountCode:"$_id",debit:1,credit:1,balance:{$subtract:["$debit","$credit"]}}},{$sort:{accountCode:1}}]);
  } else if(/^ledger$/i.test(name.trim())){
    const partyGlobalId=String(req.query.partyGlobalId||"").trim();
    if(partyGlobalId){const ledger=await partyLedgerRows({tenantKey,financialYear,partyGlobalId});rows=ledger.rows;summary=ledger.summary;}
    else {rows=[];summary={message:"Select a party to view ledger"};}
  } else if(/sales|gstr-1|margin|product profitability/i.test(name)){
    const items=await SalesInvoice.find({tenantKey,financialYear,status:"POSTED"}).sort({date:-1}).limit(1000).lean();
    if(/by product|product profitability|margin/i.test(name)){
      const map=new Map();for(const inv of items)for(const it of inv.items||[]){const x=map.get(it.sku)||{sku:it.sku,product:it.nameSnapshot,qty:0,sales:0,grossProfit:0,green:0,blue:0,red:0};x.qty+=Number(it.qty||0);x.sales+=Number(it.taxable||0);x.grossProfit+=(Number(it.effectiveRate||0)-Number(it.landedCostSnapshot||0))*Number(it.qty||0);x[String(it.marginColor||"").toLowerCase()]++;map.set(it.sku,x)}rows=[...map.values()].map(x=>({...x,sales:money(x.sales),grossProfit:money(x.grossProfit),marginPct:x.sales?money(x.grossProfit/x.sales*100):0}));
    }else rows=items.map(x=>({invoiceNo:x.invoiceNo,date:x.date,customer:x.customerNameSnapshot,taxable:money(x.subtotal),gst:money(x.taxTotal),total:money(x.grandTotal),grossProfit:money(x.grossProfit),grossMarginPct:money(x.grossMarginPct),status:x.status}));
    summary={sales:money(items.reduce((s,x)=>s+Number(x.subtotal||0),0)),grossProfit:money(items.reduce((s,x)=>s+Number(x.grossProfit||0),0)),invoices:items.length};
  } else if(/purchase|gstr-2b/i.test(name)){
    const items=await PurchaseInvoice.find({tenantKey,financialYear,status:"POSTED"}).sort({date:-1}).limit(1000).lean();rows=items.map(x=>({invoiceNo:x.invoiceNo,date:x.date,supplier:x.supplierGlobalId,taxable:money(x.subtotal),gst:money(x.taxTotal),total:money(x.grandTotal),landedCharges:money(x.landedCharges),status:x.status}));summary={purchase:money(items.reduce((s,x)=>s+Number(x.grandTotal||0),0)),invoices:items.length};
  } else if(/receipt|collection|bounce/i.test(name)){
    const items=await Receipt.find({tenantKey,financialYear}).sort({date:-1}).limit(1000).lean();rows=items.map(x=>({receiptNo:x.receiptNo,date:x.date,customer:x.customerGlobalId,amount:money(x.amount),mode:x.mode,reference:x.reference,bounceStatus:x.bounceStatus,status:x.status}));summary={collection:money(items.filter(x=>x.status==="POSTED").reduce((s,x)=>s+Number(x.amount||0),0)),receipts:items.length};
  } else if(/expense|break-even|profit & loss|trading|balance sheet|cash flow|fund flow|cma|working capital|ratio/i.test(name)){
    const [ledger,expenses]=await Promise.all([LedgerEntry.find({tenantKey,financialYear,status:"POSTED"}).sort({date:-1}).limit(1500).lean(),Expense.find({tenantKey,financialYear,status:"POSTED"}).sort({date:-1}).limit(1000).lean()]);
    if(/expense|break-even/i.test(name)){rows=expenses.map(x=>({date:x.date,accountCode:x.accountCode,amount:money(x.amount),nature:x.nature,allocationMethod:x.allocationMethod,status:x.status}));summary={expenses:money(expenses.reduce((s,x)=>s+Number(x.amount||0),0))};}
    else {const map=new Map();for(const e of ledger){const x=map.get(e.accountCode)||{accountCode:e.accountCode,debit:0,credit:0};x.debit+=Number(e.debit||0);x.credit+=Number(e.credit||0);map.set(e.accountCode,x)}rows=[...map.values()].map(x=>({...x,debit:money(x.debit),credit:money(x.credit),balance:money(x.debit-x.credit)}));summary={totalDebit:money(rows.reduce((s,x)=>s+x.debit,0)),totalCredit:money(rows.reduce((s,x)=>s+x.credit,0))};}
  } else if(/stock|warehouse|dead stock|closing/i.test(name)){
    const moves=await StockMovement.find({tenantKey,financialYear}).limit(3000).lean();const products=await Product.find({tenantKey}).select("name sku landedCost").lean();const pmap=new Map(products.map(p=>[String(p._id),p]));const map=new Map();for(const m of moves){const x=map.get(m.productId)||{productId:m.productId,qtyIn:0,qtyOut:0};x.qtyIn+=Number(m.qtyIn||0);x.qtyOut+=Number(m.qtyOut||0);map.set(m.productId,x)}rows=[...map.values()].map(x=>{const p=pmap.get(String(x.productId));const closing=x.qtyIn-x.qtyOut;return {sku:p?.sku,product:p?.name,qtyIn:x.qtyIn,qtyOut:x.qtyOut,closing,value:money(closing*Number(p?.landedCost||0))}});summary={stockValue:money(rows.reduce((s,x)=>s+x.value,0)),products:rows.length};
  } else if(/lead funnel/i.test(name)){
    rows=await Lead.aggregate([{$match:{tenantKey}},{$group:{_id:"$stage",count:{$sum:1}}},{$project:{_id:0,stage:"$_id",count:1}},{$sort:{count:-1}}]);summary={leads:rows.reduce((s,x)=>s+x.count,0)};
  } else if(/customer/i.test(name)){
    const items=await CustomerLink.find({tenantKey}).sort({updatedAt:-1}).limit(1000).lean();rows=items.map(x=>({customer:x.localName,identifier:x.displayIdentifier,paymentType:x.paymentType,creditDays:x.creditDays,creditLimit:x.creditLimit,status:x.status,health:x.companyHealth?.score||0}));summary={customers:items.length,creditLimit:money(items.reduce((s,x)=>s+Number(x.creditLimit||0),0))};
  } else if(/hr attendance|hr payroll|hr leave/i.test(name)){
    const resource=/attendance/i.test(name)?"attendance":/payroll/i.test(name)?"payroll":"leave";const items=await GenericRecord.find({tenantKey,app:"hr",resource}).sort({date:-1,updatedAt:-1}).limit(1000).lean();rows=items.map(x=>({reference:x.reference,title:x.title,date:x.date,amount:x.amount,quantity:x.quantity,status:x.status,...(x.data||{})}));summary={records:items.length,amount:money(items.reduce((s,x)=>s+Number(x.amount||0),0))};
  } else if(/production/i.test(name)||/wip|qc|machine downtime/i.test(name)){
    const resource=/wip/i.test(name)?"wip":/qc/i.test(name)?"quality":/downtime/i.test(name)?"maintenance":"execution";const items=await GenericRecord.find({tenantKey,app:"production",resource}).sort({date:-1,updatedAt:-1}).limit(1000).lean();rows=items.map(x=>({reference:x.reference,title:x.title,date:x.date,quantity:x.quantity,status:x.status,...(x.data||{})}));summary={records:items.length,quantity:items.reduce((s,x)=>s+Number(x.quantity||0),0)};
  } else if(/recruit|candidate/i.test(name)){
    const [c,j]=await Promise.all([Candidate.countDocuments({tenantKey}),JobOpening.countDocuments({tenantKey,status:{$in:["OPEN","APPROVED"]}})]);summary={candidates:c,openJobs:j};
  } else {
    const items=await GenericRecord.find({tenantKey}).sort({updatedAt:-1}).limit(300).lean();rows=items.map(x=>({app:x.app,resource:x.resource,reference:x.reference,title:x.title,status:x.status,date:x.date,amount:x.amount,quantity:x.quantity}));summary={records:items.length,employees:await Employee.countDocuments({tenantKey})};
  }
  if(!admin){
    rows=(rows||[]).map(stripProfitFields);
    summary=stripProfitFields(summary||{});
  }
  return ok(res,{name,financialYear,generatedAt:new Date(),summary,rows,branding:{footer:"This page is generated by the Rupioo Global System."}},"Report generated");
});

router.get("/:reportId",async(req,res)=>ok(res,{reportId:req.params.reportId,filters:req.query,generatedAt:new Date(),branding:{footer:"This page is generated by the Rupioo Global System."},rows:[]},"Report generated"));
export default router;
