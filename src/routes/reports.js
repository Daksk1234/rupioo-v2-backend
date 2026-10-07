import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { financialModels } from "../services/accountingService.js";
import { canonicalBankType, inspectBankLedgerRows } from "../services/bankLedgerIntegrityService.js";
import { GenericRecord, Product, CustomerLink, CompanyProfile, CompanyLedger, Lead, Employee, Candidate, JobOpening } from "../models/index.js";
import { sendBusinessEmail } from "../services/mailService.js";
import { buildLedgerPdf } from "../services/simplePdfService.js";
import XLSX from "xlsx";
import PDFDocument from "pdfkit";
import { buildGstReport } from "../services/gstReportsService.js";
import { resolveFinancialYear } from "../utils/financialYear.js";
import { buildLegacyReport, legacyReportCatalog, legacyReportKind } from "../services/legacyReportsService.js";
import { buildV2LiveReport, v2LiveReportCatalog, v2LiveReportKind } from "../services/v2LiveReportsService.js";
import { buildOldDmsReferenceReport, oldDmsReferenceReportCatalog, oldDmsReferenceReportKind } from "../services/oldDmsReferenceReportsService.js";
import { REPORT_PERMISSION_MAP, canScreenAction } from "../config/permissionPageMap.js";
import { buildSalesAnalysisReport, buildSalesPartyProductReport } from "../services/salesAnalysisReportService.js";
import { buildPurchaseAnalysisReport, buildPurchasePartyProductReport } from "../services/purchaseAnalysisReportService.js";
import { buildLockPartyReport, buildDeadPartyReport } from "../services/salesCustomerStatusReportService.js";
import { buildStockAnalysisReport, buildStockAlertReport } from "../services/stockAnalysisReportService.js";
import { buildCustomerCreditExposure, buildReceiptBounce, buildCashFlow, buildFundFlow, buildWorkingCapital, buildRatioAnalysis } from "../services/financeReportsService.js";

const router=express.Router();router.use(requireAuth);
const reports=[
"Executive Company Health","Sales Summary","Sales by Product","Sales by Customer","Sales by Salesperson","Sales by Territory","Margin Colour Mix","Lead Funnel","Visit Achievement","Target Achievement","Collection Achievement","Purchase Summary","Supplier Performance","Landed Cost Analysis","Stock Summary","Closing Stock","Stock Ageing","Dead Stock","Warehouse Stock","Product Profitability","Trial Balance","Trading Account","Profit & Loss","Balance Sheet","Provisional Balance Sheet","Cash Flow","Fund Flow","Expense Analysis","Break-even","CMA Operating Statement","CMA Balance Sheet Analysis","Working Capital","Ratio Analysis","GSTR-1 Reconciliation","GSTR-2B Reconciliation","GSTR-3B Reconciliation","GSTR-9 Annual Reconciliation","GST Compliance Health","Customer Health","Customer Credit Exposure","Customer Rating Trend","Receipt & Bounce","Transporter Network","HR Attendance","HR Payroll","HR Leave","Production Plan vs Actual","Production Efficiency","WIP","QC & Rejection","Machine Downtime","Family Net Worth","Family Cash Flow","Barcode Registry","Storage Usage","Audit Trail"
];
const money=n=>Number(Number(n||0).toFixed(2));
const PROFIT_SENSITIVE_REPORT = /(profit|margin|trading|break-even|company health)/i;
const PRIVATE_HR_REPORT = /(?:HR Payroll|Staff Salary|Payslip)/i;
const reportPermissionKeys = (name) => {
  const raw = String(name || "").trim();
  if (!raw) return [];
  if (REPORT_PERMISSION_MAP[raw]) return REPORT_PERMISSION_MAP[raw];
  const wanted = raw.toLowerCase();
  return Object.entries(REPORT_PERMISSION_MAP).find(([label]) => label.toLowerCase() === wanted)?.[1] || [];
};
const stripProfitFields = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(profit|margin)/i.test(key)));
};
router.get("/catalog",async(req,res)=>{
  const admin=isAdminAuth(req.auth);
  const previous=reports.map((name,i)=>({id:`RPT-${String(i+1).padStart(3,"0")}`,category:"Existing V2",name,
    formats:["SCREEN","PRINT","CSV"],implementation:oldDmsReferenceReportKind(name)?"V2_OLD_DMS_REFERENCE":v2LiveReportKind(name)?"V2_LIVE":legacyReportKind(name)?"V2_NATIVE":"UNSUPPORTED"}));
  // One row per report name: the V2 live mapping wins over older generic labels.
  const combined=[...oldDmsReferenceReportCatalog,...v2LiveReportCatalog,...legacyReportCatalog,...previous];
  const unique=new Map();
  for(const item of combined){const k=item.name.toLowerCase();if(!unique.has(k))unique.set(k,item);}
  const list=[...unique.values()]
    .filter((report) => {
      if (admin) return true;
      if (PROFIT_SENSITIVE_REPORT.test(report.name) || PRIVATE_HR_REPORT.test(report.name)) return false;
      const keys = reportPermissionKeys(report.name);
      return keys.length > 0 && canScreenAction(req.auth?.permissions || [], keys, "view");
    });
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
    BANK_STATEMENT_RECEIPT: "Receipt",
    BANK_STATEMENT_PAYMENT: "Payment",
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
  const rawJournal = await LedgerEntry.find(ledgerEntryFilter(entity, tenantKey, fy)).sort({ date: 1, createdAt: 1 }).lean();
  const { rows: journalRows } = await inspectBankLedgerRows({ tenantKey, financialYear: fy, rows: rawJournal });
  // BANK_STATEMENT_RECEIPT is the same voucher as the corresponding RECEIPT.
  // Comparing raw transaction types previously added the same receipt twice.
  const represented = new Set(journalRows.map((row) => partyTxnKey(canonicalBankType(row.transactionType), row.transactionId)));

  // Previous-DMS/migrated records may have the business document but no V2
  // LedgerEntry.  Add only documents whose party control entry is missing.
  // Existing V2 journal rows win, so there is no double counting.
  const [sales, purchases, receipts, payments] = await Promise.all([
    SalesInvoice.find({ tenantKey, financialYear: fy, customerGlobalId: entity.entityId, status: "POSTED" })
      .select("_id invoiceNo date grandTotal remarks createdAt").lean(),
    PurchaseInvoice.find({ tenantKey, financialYear: fy, supplierGlobalId: entity.entityId, status: "POSTED" })
      .select("_id invoiceNo date grandTotal remarks createdAt").lean(),
    Receipt.find({ tenantKey, financialYear: fy, customerGlobalId: entity.entityId, status: "POSTED" })
      .select("_id receiptNo date amount remarks createdAt statementImportId").lean(),
    Payment.find({ tenantKey, financialYear: fy, partyGlobalId: entity.entityId, status: "POSTED" })
      .select("_id paymentNo date amount remarks createdAt statementImportId").lean(),
  ]);

  // A bank-imported receipt/payment without its statement row is not an
  // authoritative voucher; do not recreate it in Ledger as legacy fallback.
  const bankLinkedNos = [...new Set([
    ...receipts.filter(r=>cleanText(r.statementImportId)).map(r=>cleanText(r.receiptNo)),
    ...payments.filter(r=>cleanText(r.statementImportId)).map(r=>cleanText(r.paymentNo)),
  ])];
  const { BankStatementRow } = financialModels(tenantKey, fy);
  const bankLinked = bankLinkedNos.length
    ? await BankStatementRow.find({tenantKey,financialYear:fy,transactionId:{$in:bankLinkedNos}}).select("transactionId importId").lean()
    : [];
  const validBankSource = new Set(bankLinked.map(r=>`${cleanText(r.transactionId)}|${cleanText(r.importId)}`));
  const fallback = [];
  const fallbackSeen = new Set(represented);
  for (const row of sales) {
    const key = partyTxnKey("SALES_INVOICE", row.invoiceNo);
    if (fallbackSeen.has(key)) continue;
    fallbackSeen.add(key);
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
    if (fallbackSeen.has(key)) continue;
    fallbackSeen.add(key);
    fallback.push({
      _id: `LEGACY-PURCHASE-${row._id}`, tenantKey, financialYear: fy, date: row.date, createdAt: row.createdAt,
      transactionType: "PURCHASE_INVOICE", transactionId: cleanText(row.invoiceNo), partyGlobalId: entity.entityId,
      accountCode: "SYS_SUNDRY_CREDITORS", debit: 0, credit: Number(row.grandTotal || 0),
      narration: cleanText(row.remarks) || `Purchase Invoice ${cleanText(row.invoiceNo)}`, status: "POSTED",
      sourceDocumentType: "PURCHASE_INVOICE", sourceDocumentId: cleanText(row._id), legacyFallback: true,
    });
  }
  for (const row of receipts) {
    if (cleanText(row.statementImportId) && !validBankSource.has(`${cleanText(row.receiptNo)}|${cleanText(row.statementImportId)}`)) continue;
    const key = partyTxnKey("RECEIPT", row.receiptNo);
    if (fallbackSeen.has(key)) continue;
    fallbackSeen.add(key);
    fallback.push({
      _id: `LEGACY-RECEIPT-${row._id}`, tenantKey, financialYear: fy, date: row.date, createdAt: row.createdAt,
      transactionType: "RECEIPT", transactionId: cleanText(row.receiptNo), partyGlobalId: entity.entityId,
      accountCode: "SYS_SUNDRY_DEBTORS", debit: 0, credit: Number(row.amount || 0),
      narration: cleanText(row.remarks) || `Receipt ${cleanText(row.receiptNo)}`, status: "POSTED", legacyFallback: true,
    });
  }
  for (const row of payments) {
    if (cleanText(row.statementImportId) && !validBankSource.has(`${cleanText(row.paymentNo)}|${cleanText(row.statementImportId)}`)) continue;
    const key = partyTxnKey("PAYMENT", row.paymentNo);
    if (fallbackSeen.has(key)) continue;
    fallbackSeen.add(key);
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
  const { rows: verified } = await inspectBankLedgerRows({ tenantKey, financialYear: fy, rows: source });
  return money(verified.reduce((sum, row) => sum + Number(row.debit || 0) - Number(row.credit || 0), 0));
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
  const { rows: verified } = await inspectBankLedgerRows({ tenantKey, financialYear: fy, rows: source });
  return verified;
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
  const fy = normalizeFY(financialYear || await resolveFinancialYear({ tenantKey }));
  const entity = await resolveLedgerEntity({ tenantKey, entityType, entityId });
  const opening = await effectiveLedgerOpening({ tenantKey, entity, financialYear: fy });
  let source = await fetchLedgerSourceRows({ tenantKey, entity, financialYear: fy });
  source = await attachSourceDocuments({ tenantKey, financialYear: fy, rows: source });

  const from = cleanText(startDate);
  const to = cleanText(endDate);
  // Monthly ledger opening includes posted movement from this FY before the
  // requested start date; filtering rows first used to understate the balance.
  const beforePeriod = from ? source.filter((row) => isoDateOnly(row.date) < from) : [];
  const periodOpening = from
    ? signedOpeningObject(Number(opening.signed || 0) + beforePeriod.reduce((sum, row) =>
      sum + Number(row.debit || 0) - Number(row.credit || 0), 0), fy)
    : opening;
  if (from) source = source.filter((row) => isoDateOnly(row.date) >= from);
  if (to) source = source.filter((row) => isoDateOnly(row.date) <= to);

  let runningSigned = Number(periodOpening.signed || 0);
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

  const openingDebit = periodOpening.type === "DR" ? Number(periodOpening.amount || 0) : 0;
  const openingCredit = periodOpening.type === "CR" ? Number(periodOpening.amount || 0) : 0;
  const movementDebit = money(rows.reduce((sum, row) => sum + Number(row.debit || 0), 0));
  const movementCredit = money(rows.reduce((sum, row) => sum + Number(row.credit || 0), 0));
  const totalDebit = money(openingDebit + movementDebit);
  const totalCredit = money(openingCredit + movementCredit);
  const closingDiff = money(Math.abs(totalDebit - totalCredit));
  const showOnDebit = totalCredit > totalDebit;
  const showOnCredit = totalDebit > totalCredit;
  const balancedTotal = money(Math.max(totalDebit, totalCredit));
  const actualSignedClosing = money(Number(periodOpening.signed || 0) + movementDebit - movementCredit);

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
    opening:periodOpening,
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
    const financialYear=normalizeFY(await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body.financialYear}));
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


const gstReportArgs = async (req) => ({
  tenantKey: req.auth.tenantKey,
  financialYear: await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.query.financialYear}),
  startDate: String(req.query.startDate || "").trim(),
  endDate: String(req.query.endDate || "").trim(),
});

router.get("/gst/:kind", async (req, res) => {
  try {
    const data = await buildGstReport(req.params.kind, await gstReportArgs(req));
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
    const data = await buildGstReport(req.params.kind, await gstReportArgs(req));
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

// Native report export is calculated with the SAME function as the screen,
// rather than fetching a different dataset or silently truncating rows.
router.get('/export.xlsx',async(req,res)=>{
  try{
    const name=String(req.query.name||'').trim();
    if(!oldDmsReferenceReportKind(name)&&!v2LiveReportKind(name)&&!legacyReportKind(name))return fail(res,'This report has no verified V2 data source or Excel exporter',422);
    if(!isAdminAuth(req.auth)&&(PROFIT_SENSITIVE_REPORT.test(name)||PRIVATE_HR_REPORT.test(name)))return fail(res,'Restricted financial or payroll report',403);
    const tenantKey=req.auth.tenantKey;
    const financialYear=await resolveFinancialYear({tenantKey,requested:req.query.financialYear});
    const reportArgs={name,tenantKey,financialYear,
      startDate:String(req.query.startDate||'').trim(),endDate:String(req.query.endDate||'').trim()};
    const data=oldDmsReferenceReportKind(name)?await buildOldDmsReferenceReport(reportArgs):v2LiveReportKind(name)?await buildV2LiveReport(reportArgs):await buildLegacyReport(reportArgs);
    const book=XLSX.utils.book_new();
    // Avoid spreadsheet-formula injection from user-controlled party/narration text.
    const safeValue=value=>typeof value==='string'&&/^[\s]*[=+@\-]/.test(value)?`'${value}`:value;
    const safeRows=(data.rows||[]).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>
      [k,safeValue(v instanceof Date?v.toISOString().slice(0,10):v)])));
    appendSheet(book,'Report',safeRows);
    appendSheet(book,'Summary',[{name:data.name,financialYear:data.financialYear,
      startDate:data.startDate,endDate:data.endDate,note:data.note||'',...data.summary}]);
    const buffer=XLSX.write(book,{type:'buffer',bookType:'xlsx'});
    const file=name.replace(/[^a-z0-9_-]+/gi,'_').slice(0,65)||'Report';
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${file}_${financialYear}.xlsx"`);
    return res.send(buffer);
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/run",async(req,res)=>{
  const name=String(req.query.name||"Report"),tenantKey=req.auth.tenantKey,financialYear=await resolveFinancialYear({tenantKey,requested:req.query.financialYear});
  const admin=isAdminAuth(req.auth);
  if(!admin && (PROFIT_SENSITIVE_REPORT.test(name)||PRIVATE_HR_REPORT.test(name))) return fail(res,"Restricted financial or payroll report",403);
  if(oldDmsReferenceReportKind(name)||v2LiveReportKind(name)||legacyReportKind(name)){
    try{
      const reportArgs={name,tenantKey,financialYear,
        startDate:String(req.query.startDate||'').trim(),endDate:String(req.query.endDate||'').trim()};
      const data=oldDmsReferenceReportKind(name)?await buildOldDmsReferenceReport(reportArgs):v2LiveReportKind(name)?await buildV2LiveReport(reportArgs):await buildLegacyReport(reportArgs);
      return ok(res,data,'Report generated from V2 source records');
    }catch(error){return fail(res,error.message,error.statusCode||500);}
  }
  const {LedgerEntry,SalesInvoice,PurchaseInvoice,Receipt,Payment,StockMovement,Expense}=financialModels(tenantKey,financialYear);
  // Month/FY filters are applied at source, BEFORE aggregation and totals.
  const validISO = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const fyStart = `${financialYear.slice(0,4)}-04-01`;
  const fyEnd = `${Number(financialYear.slice(0,4)) + 1}-03-31`;
  const rawFrom = String(req.query.startDate || '').trim();
  const rawTo = String(req.query.endDate || '').trim();
  if ((rawFrom && !validISO(rawFrom)) || (rawTo && !validISO(rawTo))) return fail(res,'Invalid report date format; use YYYY-MM-DD',400);
  const startDate = rawFrom ? (rawFrom > fyStart ? rawFrom : fyStart) : fyStart;
  const endDate = rawTo ? (rawTo < fyEnd ? rawTo : fyEnd) : fyEnd;
  if (startDate > endDate) return fail(res,'The selected month is outside the selected financial year',400);
  const dateFilter = { $gte: new Date(`${startDate}T00:00:00.000Z`), $lt: new Date(Date.parse(`${endDate}T00:00:00.000Z`) + 86400000) };
  const fyToDate = { $gte: new Date(`${fyStart}T00:00:00.000Z`), $lt: dateFilter.$lt };
  let rows=[],summary={};
  if(/trial balance/i.test(name)){
    const raw=await LedgerEntry.find({tenantKey,financialYear,status:"POSTED",date:fyToDate}).lean();
    const {rows:posted}=await inspectBankLedgerRows({tenantKey,financialYear,rows:raw});
    const totals=new Map();
    for(const entry of posted){
      const r=totals.get(entry.accountCode)||{accountCode:entry.accountCode,debit:0,credit:0};
      r.debit+=Number(entry.debit||0);r.credit+=Number(entry.credit||0);totals.set(entry.accountCode,r);
    }
    rows=[...totals.values()].map(r=>({...r,debit:money(r.debit),credit:money(r.credit),balance:money(r.debit-r.credit)}))
      .sort((a,b)=>String(a.accountCode).localeCompare(String(b.accountCode)));
  } else if(/^ledger$/i.test(name.trim())){
    const partyGlobalId=String(req.query.partyGlobalId||"").trim();
    if(partyGlobalId){const ledger=await buildLedgerStatement({tenantKey,financialYear,entityType:"PARTY",entityId:partyGlobalId,startDate,endDate});rows=ledger.rows;summary=ledger.summary;}
    else {rows=[];summary={message:"Select a party to view ledger"};}
  } else if(/sales|gstr-1|margin|product profitability/i.test(name)){
    const items=await SalesInvoice.find({tenantKey,financialYear,status:"POSTED",date:dateFilter}).sort({date:-1}).limit(1000).lean();
    if(/by product|product profitability|margin/i.test(name)){
      const map=new Map();for(const inv of items)for(const it of inv.items||[]){const x=map.get(it.sku)||{sku:it.sku,product:it.nameSnapshot,qty:0,sales:0,grossProfit:0,green:0,blue:0,red:0};x.qty+=Number(it.qty||0);x.sales+=Number(it.taxable||0);x.grossProfit+=(Number(it.effectiveRate||0)-Number(it.landedCostSnapshot||0))*Number(it.qty||0);x[String(it.marginColor||"").toLowerCase()]++;map.set(it.sku,x)}rows=[...map.values()].map(x=>({...x,sales:money(x.sales),grossProfit:money(x.grossProfit),marginPct:x.sales?money(x.grossProfit/x.sales*100):0}));
    }else rows=items.map(x=>({invoiceNo:x.invoiceNo,date:x.date,customer:x.customerNameSnapshot,taxable:money(x.taxableTotal??x.subtotal),gst:money(x.taxTotal),total:money(x.grandTotal),grossProfit:money(x.grossProfit),grossMarginPct:money(x.grossMarginPct),status:x.status}));
    summary={sales:money(items.reduce((s,x)=>s+Number(x.taxableTotal??x.subtotal??0),0)),grossProfit:money(items.reduce((s,x)=>s+Number(x.grossProfit||0),0)),invoices:items.length};
  } else if(/purchase|gstr-2b/i.test(name)){
    const items=await PurchaseInvoice.find({tenantKey,financialYear,status:"POSTED",date:dateFilter}).sort({date:-1}).limit(1000).lean();rows=items.map(x=>({invoiceNo:x.invoiceNo,date:x.date,supplier:x.supplierGlobalId,taxable:money(x.taxableTotal ?? x.subtotal ?? 0),gst:money(x.taxTotal),total:money(x.grandTotal),landedCharges:money(x.landedCharges),status:x.status}));summary={purchase:money(items.reduce((s,x)=>s+Number(x.grandTotal||0),0)),invoices:items.length};
  } else if(/receipt|collection|bounce/i.test(name)){
    const items=await Receipt.find({tenantKey,financialYear,date:dateFilter}).sort({date:-1}).limit(1000).lean();rows=items.map(x=>({receiptNo:x.receiptNo,date:x.date,customer:x.customerGlobalId,amount:money(x.amount),mode:x.mode,reference:x.reference,bounceStatus:x.bounceStatus,status:x.status}));summary={collection:money(items.filter(x=>x.status==="POSTED").reduce((s,x)=>s+Number(x.amount||0),0)),receipts:items.length};
  } else if(/expense|break-even|profit & loss|trading|balance sheet|cash flow|fund flow|cma|working capital|ratio/i.test(name)){
    const [rawLedger,expenses]=await Promise.all([LedgerEntry.find({tenantKey,financialYear,status:"POSTED",date:/balance sheet|working capital|ratio/i.test(name)?fyToDate:dateFilter}).sort({date:-1}).limit(1500).lean(),Expense.find({tenantKey,financialYear,status:"POSTED",date:dateFilter}).sort({date:-1}).limit(1000).lean()]);
    const {rows:ledger}=await inspectBankLedgerRows({tenantKey,financialYear,rows:rawLedger});
    if(/expense|break-even/i.test(name)){rows=expenses.map(x=>({date:x.date,accountCode:x.accountCode,amount:money(x.amount),nature:x.nature,allocationMethod:x.allocationMethod,status:x.status}));summary={expenses:money(expenses.reduce((s,x)=>s+Number(x.amount||0),0))};}
    else {const map=new Map();for(const e of ledger){const x=map.get(e.accountCode)||{accountCode:e.accountCode,debit:0,credit:0};x.debit+=Number(e.debit||0);x.credit+=Number(e.credit||0);map.set(e.accountCode,x)}rows=[...map.values()].map(x=>({...x,debit:money(x.debit),credit:money(x.credit),balance:money(x.debit-x.credit)}));summary={totalDebit:money(rows.reduce((s,x)=>s+x.debit,0)),totalCredit:money(rows.reduce((s,x)=>s+x.credit,0))};}
  } else if(/stock|warehouse|dead stock|closing/i.test(name)){
    const moves=await StockMovement.find({tenantKey,financialYear,date:fyToDate}).limit(3000).lean();const products=await Product.find({tenantKey}).select("name sku landedCost").lean();const pmap=new Map(products.map(p=>[String(p._id),p]));const map=new Map();for(const m of moves){const x=map.get(m.productId)||{productId:m.productId,qtyIn:0,qtyOut:0};x.qtyIn+=Number(m.qtyIn||0);x.qtyOut+=Number(m.qtyOut||0);map.set(m.productId,x)}rows=[...map.values()].map(x=>{const p=pmap.get(String(x.productId));const closing=x.qtyIn-x.qtyOut;return {sku:p?.sku,product:p?.name,qtyIn:x.qtyIn,qtyOut:x.qtyOut,closing,value:money(closing*Number(p?.landedCost||0))}});summary={stockValue:money(rows.reduce((s,x)=>s+x.value,0)),products:rows.length};
  } else if(/lead funnel/i.test(name)){
    rows=await Lead.aggregate([{$match:{tenantKey}},{$group:{_id:"$stage",count:{$sum:1}}},{$project:{_id:0,stage:"$_id",count:1}},{$sort:{count:-1}}]);summary={leads:rows.reduce((s,x)=>s+x.count,0)};
  } else if(/customer/i.test(name)){
    const items=await CustomerLink.find({tenantKey}).sort({updatedAt:-1}).limit(1000).lean();rows=items.map(x=>({customer:x.localName,identifier:x.displayIdentifier,paymentType:x.paymentType,creditDays:x.creditDays,creditLimit:x.creditLimit,status:x.status,health:x.companyHealth?.score||0}));summary={customers:items.length,creditLimit:money(items.reduce((s,x)=>s+Number(x.creditLimit||0),0))};
  } else if(/hr attendance|hr payroll|hr leave/i.test(name)){
    const resource=/attendance/i.test(name)?"attendance":/payroll/i.test(name)?"payroll":"leave";const items=await GenericRecord.find({tenantKey,app:"hr",resource,$or:[{date:dateFilter},{date:null,createdAt:dateFilter}]}).sort({date:-1,updatedAt:-1}).limit(1000).lean();rows=items.map(x=>({reference:x.reference,title:x.title,date:x.date,amount:x.amount,quantity:x.quantity,status:x.status,...(x.data||{})}));summary={records:items.length,amount:money(items.reduce((s,x)=>s+Number(x.amount||0),0))};
  } else if(/production/i.test(name)||/wip|qc|machine downtime/i.test(name)){
    const resource=/wip/i.test(name)?"wip":/qc/i.test(name)?"quality":/downtime/i.test(name)?"maintenance":"execution";const items=await GenericRecord.find({tenantKey,app:"production",resource,$or:[{date:dateFilter},{date:null,createdAt:dateFilter}]}).sort({date:-1,updatedAt:-1}).limit(1000).lean();rows=items.map(x=>({reference:x.reference,title:x.title,date:x.date,quantity:x.quantity,status:x.status,...(x.data||{})}));summary={records:items.length,quantity:items.reduce((s,x)=>s+Number(x.quantity||0),0)};
  } else if(/recruit|candidate/i.test(name)){
    const [c,j]=await Promise.all([Candidate.countDocuments({tenantKey}),JobOpening.countDocuments({tenantKey,status:{$in:["OPEN","APPROVED"]}})]);summary={candidates:c,openJobs:j};
  } else {
    return fail(res,`The report "${name}" has not been mapped to a verified V2 source. No unrelated records were substituted.`,422);
  }
  if(!admin){
    rows=(rows||[]).map(stripProfitFields);
    summary=stripProfitFields(summary||{});
  }
  return ok(res,{name,financialYear,startDate,endDate,generatedAt:new Date(),summary,rows,
    implementation:'EXISTING_V2_UNVERIFIED',note:'Existing V2 report. Old-DMS calculation parity has not been verified.',branding:{footer:"This page is generated by the Rupioo Global System."}},"Report generated");
});


const salesAnalysisArgs = async (req) => {
  const tenantKey = req.auth.tenantKey;
  const financialYear = await resolveFinancialYear({ tenantKey, requested: req.query.financialYear });
  return {
    tenantKey,
    financialYear,
    view: String(req.query.view || "MONTHLY"),
    period: String(req.query.period || ""),
    dateFrom: String(req.query.dateFrom || ""),
    dateTo: String(req.query.dateTo || ""),
    partyType: String(req.query.partyType || ""),
    salespersonId: String(req.query.salespersonId || ""),
    district: String(req.query.district || ""),
    partyId: String(req.query.partyId || ""),
    productId: String(req.query.productId || ""),
    taxType: String(req.query.taxType || ""),
  };
};

router.get("/sales-analysis", async (req, res) => {
  try {
    const data = await buildSalesAnalysisReport(await salesAnalysisArgs(req));
    return ok(res, data, "Sales summary generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

router.get("/sales-party-product", async (req, res) => {
  try {
    const args = await salesAnalysisArgs(req);
    const data = await buildSalesPartyProductReport(args);
    return ok(res, data, "Party and product wise sales report generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

const salesCustomerStatusArgs = (req) => ({
  tenantKey: req.auth.tenantKey,
  status: String(req.query.status || ""),
  partyId: String(req.query.partyId || ""),
  salespersonId: String(req.query.salespersonId || ""),
  district: String(req.query.district || ""),
  search: String(req.query.search || ""),
  paymentType: String(req.query.paymentType || ""),
  dueBucket: String(req.query.dueBucket || ""),
  partyType: String(req.query.partyType || ""),
  refresh: ["1", "TRUE", "YES"].includes(String(req.query.refresh || "").toUpperCase()),
});

router.get("/sales-lock-party", async (req, res) => {
  try {
    const data = await buildLockPartyReport(salesCustomerStatusArgs(req));
    return ok(res, data, "Lock party report generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

router.get("/sales-dead-party", async (req, res) => {
  try {
    const data = await buildDeadPartyReport(salesCustomerStatusArgs(req));
    return ok(res, data, "Dead party report generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

const salesExportRows = (rows = []) => rows.map((row) => ({
  Date: row.date ? new Date(row.date).toISOString().slice(0, 10) : "",
  "Invoice Number": row.number || "",
  "Party Name": row.partyName || "",
  "Party Type": row.registrationType === "REGULAR" ? "Regular" : "UnRegister",
  Territory: row.district || "",
  "Sales Person": row.salespersonName || "",
  "No. of Products": Number(row.noOfProducts || 0),
  "No. of Packages": Number(row.noOfPackages || 0),
  CGST: money(row.cgst),
  SGST: money(row.sgst),
  IGST: money(row.igst),
  "Basic Amount": money(row.basicAmount),
  "Taxable Amount": money(row.taxableAmount),
  "Grand Total": money(row.grandTotal),
}));

router.get("/sales-analysis.xlsx", async (req, res) => {
  try {
    const data = await buildSalesAnalysisReport(await salesAnalysisArgs(req));
    const wb = XLSX.utils.book_new();
    const rows = salesExportRows(data.rows);
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Message: "No sales invoices for selected filters" }]);
    ws["!cols"] = [
      { wch: 12 }, { wch: 22 }, { wch: 30 }, { wch: 14 }, { wch: 20 }, { wch: 24 },
      { wch: 15 }, { wch: 15 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Sales Summary");
    const summary = XLSX.utils.json_to_sheet([{
      "Financial Year": data.financialYear,
      "From": data.dateFrom,
      "To": data.dateTo,
      "Invoices": data.totals.records,
      "Unique Products": data.totals.products,
      "Packages": data.totals.packages,
      "CGST": data.totals.cgst,
      "SGST": data.totals.sgst,
      "IGST": data.totals.igst,
      "Basic Amount": data.totals.basicAmount,
      "Taxable Amount": data.totals.taxableAmount,
      "Grand Total": data.totals.grandTotal,
    }]);
    XLSX.utils.book_append_sheet(wb, summary, "Filtered Total");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Sales_Summary_${data.financialYear}.xlsx"`);
    return res.send(buffer);
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

function salesAnalysisPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 20 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const cols = [
        ["DATE", 47], ["INVOICE", 70], ["PARTY NAME", 105], ["TERRITORY", 72], ["SALES PERSON", 78],
        ["PRODUCTS", 40], ["PACKAGES", 42], ["CGST", 48], ["SGST", 48], ["IGST", 48],
        ["BASIC", 62], ["TAXABLE", 62], ["GRAND TOTAL", 68],
      ];
      const startX = 20;
      const rowHeight = 18;
      const drawRow = (values, y, header = false) => {
        let x = startX;
        doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(header ? 6.5 : 6);
        values.forEach((value, index) => {
          const width = cols[index][1];
          doc.rect(x, y, width, rowHeight).stroke("#d1d5db");
          doc.text(String(value ?? ""), x + 2, y + 4, { width: width - 4, height: rowHeight - 5, ellipsis: true, align: index >= 5 ? "right" : "left" });
          x += width;
        });
      };
      const header = () => {
        doc.font("Helvetica-Bold").fontSize(13).text("SALES SUMMARY", 20, 18);
        doc.font("Helvetica").fontSize(8).text(`FY ${data.financialYear}   ${data.dateFrom} TO ${data.dateTo}`, 20, 35);
        drawRow(cols.map((c) => c[0]), 50, true);
        return 50 + rowHeight;
      };

      let y = header();
      for (const row of data.rows || []) {
        if (y + rowHeight > doc.page.height - 35) {
          doc.addPage({ size: "A4", layout: "landscape", margin: 20 });
          y = header();
        }
        drawRow([
          row.date ? new Date(row.date).toISOString().slice(0, 10) : "", row.number, row.partyName, row.district, row.salespersonName,
          row.noOfProducts, row.noOfPackages, money(row.cgst).toFixed(2), money(row.sgst).toFixed(2), money(row.igst).toFixed(2),
          money(row.basicAmount).toFixed(2), money(row.taxableAmount).toFixed(2), money(row.grandTotal).toFixed(2),
        ], y);
        y += rowHeight;
      }
      if (y + rowHeight > doc.page.height - 35) {
        doc.addPage({ size: "A4", layout: "landscape", margin: 20 });
        y = header();
      }
      drawRow([
        "", "TOTAL", `${data.totals.records} INVOICES`, "", "", data.totals.products, data.totals.packages,
        money(data.totals.cgst).toFixed(2), money(data.totals.sgst).toFixed(2), money(data.totals.igst).toFixed(2),
        money(data.totals.basicAmount).toFixed(2), money(data.totals.taxableAmount).toFixed(2), money(data.totals.grandTotal).toFixed(2),
      ], y, true);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

router.get("/sales-analysis.pdf", async (req, res) => {
  try {
    const data = await buildSalesAnalysisReport(await salesAnalysisArgs(req));
    const buffer = await salesAnalysisPdf(data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Sales_Summary_${data.financialYear}.pdf"`);
    return res.send(buffer);
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

const purchaseAnalysisArgs = async (req) => {
  const tenantKey = req.auth.tenantKey;
  const financialYear = await resolveFinancialYear({ tenantKey, requested: req.query.financialYear });
  return {
    tenantKey,
    financialYear,
    view: String(req.query.view || "MONTHLY"),
    period: String(req.query.period || ""),
    dateFrom: String(req.query.dateFrom || ""),
    dateTo: String(req.query.dateTo || ""),
    partyType: String(req.query.partyType || ""),
    userId: String(req.query.userId || ""),
    district: String(req.query.district || ""),
    partyId: String(req.query.partyId || ""),
    productId: String(req.query.productId || ""),
    taxType: String(req.query.taxType || ""),
  };
};

router.get("/purchase-analysis", async (req, res) => {
  try {
    const data = await buildPurchaseAnalysisReport(await purchaseAnalysisArgs(req));
    return ok(res, data, "Purchase summary generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

router.get("/purchase-party-product", async (req, res) => {
  try {
    const data = await buildPurchasePartyProductReport(await purchaseAnalysisArgs(req));
    return ok(res, data, "Party and product wise purchase report generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

const purchaseExportRows = (rows = []) => rows.map((row) => ({
  Date: row.date ? new Date(row.date).toISOString().slice(0, 10) : "",
  "Invoice Number": row.number || "",
  "Party Name": row.partyName || "",
  "Party Type": row.registrationType === "REGULAR" ? "Regular" : "UnRegister",
  Territory: row.district || "",
  "Purchase User": row.userName || "",
  "No. of Products": Number(row.noOfProducts || 0),
  CGST: money(row.cgst),
  SGST: money(row.sgst),
  IGST: money(row.igst),
  "Basic Amount": money(row.basicAmount),
  "Taxable Amount": money(row.taxableAmount),
  "Grand Total": money(row.grandTotal),
}));

router.get("/purchase-analysis.xlsx", async (req, res) => {
  try {
    const data = await buildPurchaseAnalysisReport(await purchaseAnalysisArgs(req));
    const wb = XLSX.utils.book_new();
    const rows = purchaseExportRows(data.rows);
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Message: "No purchase invoices for selected filters" }]);
    ws["!cols"] = [
      { wch: 12 }, { wch: 22 }, { wch: 30 }, { wch: 14 }, { wch: 20 }, { wch: 24 },
      { wch: 15 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Purchase Summary");
    const summary = XLSX.utils.json_to_sheet([{
      "Financial Year": data.financialYear,
      "From": data.dateFrom,
      "To": data.dateTo,
      "Invoices": data.totals.records,
      "Unique Products": data.totals.products,
      "CGST": data.totals.cgst,
      "SGST": data.totals.sgst,
      "IGST": data.totals.igst,
      "Basic Amount": data.totals.basicAmount,
      "Taxable Amount": data.totals.taxableAmount,
      "Grand Total": data.totals.grandTotal,
    }]);
    XLSX.utils.book_append_sheet(wb, summary, "Filtered Total");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Purchase_Summary_${data.financialYear}.xlsx"`);
    return res.send(buffer);
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

function purchaseAnalysisPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 20 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      const cols = [
        ["DATE", 47], ["INVOICE", 70], ["PARTY NAME", 120], ["TERRITORY", 80], ["PURCHASE USER", 82],
        ["PRODUCTS", 42], ["CGST", 50], ["SGST", 50], ["IGST", 50], ["BASIC", 66], ["TAXABLE", 66], ["GRAND TOTAL", 72],
      ];
      const startX = 20, rowHeight = 18;
      const drawRow = (values, y, header = false) => {
        let x = startX;
        doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(header ? 6.5 : 6);
        values.forEach((value, index) => {
          const width = cols[index][1];
          doc.rect(x, y, width, rowHeight).stroke("#d1d5db");
          doc.text(String(value ?? ""), x + 2, y + 4, { width: width - 4, height: rowHeight - 5, ellipsis: true, align: index >= 5 ? "right" : "left" });
          x += width;
        });
      };
      const header = () => {
        doc.font("Helvetica-Bold").fontSize(13).text("PURCHASE SUMMARY", 20, 18);
        doc.font("Helvetica").fontSize(8).text(`FY ${data.financialYear}   ${data.dateFrom} TO ${data.dateTo}`, 20, 35);
        drawRow(cols.map((c) => c[0]), 50, true);
        return 50 + rowHeight;
      };
      let y = header();
      for (const row of data.rows || []) {
        if (y + rowHeight > doc.page.height - 35) { doc.addPage({ size: "A4", layout: "landscape", margin: 20 }); y = header(); }
        drawRow([
          row.date ? new Date(row.date).toISOString().slice(0, 10) : "", row.number, row.partyName, row.district, row.userName,
          row.noOfProducts, money(row.cgst).toFixed(2), money(row.sgst).toFixed(2), money(row.igst).toFixed(2),
          money(row.basicAmount).toFixed(2), money(row.taxableAmount).toFixed(2), money(row.grandTotal).toFixed(2),
        ], y);
        y += rowHeight;
      }
      if (y + rowHeight > doc.page.height - 35) { doc.addPage({ size: "A4", layout: "landscape", margin: 20 }); y = header(); }
      drawRow([
        "", "TOTAL", `${data.totals.records} INVOICES`, "", "", data.totals.products,
        money(data.totals.cgst).toFixed(2), money(data.totals.sgst).toFixed(2), money(data.totals.igst).toFixed(2),
        money(data.totals.basicAmount).toFixed(2), money(data.totals.taxableAmount).toFixed(2), money(data.totals.grandTotal).toFixed(2),
      ], y, true);
      doc.end();
    } catch (error) { reject(error); }
  });
}

router.get("/purchase-analysis.pdf", async (req, res) => {
  try {
    const data = await buildPurchaseAnalysisReport(await purchaseAnalysisArgs(req));
    const buffer = await purchaseAnalysisPdf(data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Purchase_Summary_${data.financialYear}.pdf"`);
    return res.send(buffer);
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});


router.get("/stock-alerts", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey;
    const financialYear = await resolveFinancialYear({ tenantKey, requested: req.query.financialYear });
    const data = await buildStockAlertReport({
      tenantKey,
      financialYear,
      reportType: String(req.query.reportType || "LOW_STOCK"),
      category: String(req.query.category || ""),
      subCategory: String(req.query.subCategory || ""),
      warehouseId: String(req.query.warehouseId || ""),
      productId: String(req.query.productId || ""),
      alertStatus: String(req.query.alertStatus || ""),
      movementType: String(req.query.movementType || ""),
    });
    return ok(res, data, "Stock alert report generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});


router.get("/stock-analysis", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey;
    const financialYear = await resolveFinancialYear({ tenantKey, requested: req.query.financialYear });
    const data = await buildStockAnalysisReport({
      tenantKey,
      financialYear,
      reportType: String(req.query.reportType || "ALL_IN_ONE"),
      category: String(req.query.category || ""),
      subCategory: String(req.query.subCategory || ""),
      warehouseId: String(req.query.warehouseId || ""),
      productId: String(req.query.productId || ""),
    });
    return ok(res, data, "Stock report generated");
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});



router.get("/finance/:kind", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey;
    const kind = String(req.params.kind || "").trim().toUpperCase().replaceAll("-", "_");
    const requested = req.query.financialYear;
    const financialYear = requested ? await resolveFinancialYear({ tenantKey, requested }) : "";
    let data;
    if (kind === "CUSTOMER_CREDIT_EXPOSURE") data = await buildCustomerCreditExposure({ tenantKey, refresh: String(req.query.refresh || "") === "1" });
    else if (kind === "RECEIPT_BOUNCE") data = await buildReceiptBounce({ tenantKey, financialYear });
    else if (kind === "CASH_FLOW") data = await buildCashFlow({ tenantKey, financialYear });
    else if (kind === "FUND_FLOW") data = await buildFundFlow({ tenantKey, financialYear });
    else if (kind === "WORKING_CAPITAL") data = await buildWorkingCapital({ tenantKey, financialYear });
    else if (kind === "RATIO_ANALYSIS") data = await buildRatioAnalysis({ tenantKey, financialYear });
    else return fail(res, "Unknown finance report", 404);
    return ok(res, data);
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 500);
  }
});

router.get("/:reportId",async(req,res)=>ok(res,{reportId:req.params.reportId,filters:req.query,generatedAt:new Date(),branding:{footer:"This page is generated by the Rupioo Global System."},rows:[]},"Report generated"));
export default router;
