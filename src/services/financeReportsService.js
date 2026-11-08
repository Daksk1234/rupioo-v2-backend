import { financialModels } from "./accountingService.js";
import { companyCashOpening } from "./companyCashOpeningService.js";
import { BankAccount, CompanyLedger, CompanyProfile, CustomerLink } from "../models/index.js";
import { buildLockPartyReport } from "./salesCustomerStatusReportService.js";
import { buildStockAnalysisReport } from "./stockAnalysisReportService.js";

const CACHE_MS = 20 * 1000;
const cache = new Map();
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const id = (v) => clean(v?._id || v);
const signed = (amount, type) => upper(type) === "CR" ? -Math.abs(Number(amount || 0)) : Math.abs(Number(amount || 0));

function currentFy(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}
function fyStart(fy) { const n = Number(String(fy || "").slice(0, 4)); return Number.isFinite(n) ? n : 0; }
function normalizeFy(fy) { const start = fyStart(fy); return start ? `${start}-${String(start + 1).slice(-2)}` : currentFy(); }
function fyDates(fy) {
  const start = fyStart(fy);
  return { from: new Date(Date.UTC(start, 3, 1)), to: new Date(Date.UTC(start + 1, 3, 1)) };
}
function monthLabel(d) { return new Date(d).toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }).toUpperCase(); }
function cacheGet(key) { const v = cache.get(key); if (!v || v.exp <= Date.now()) { cache.delete(key); return null; } return v.data; }
function cacheSet(key, data) { cache.set(key, { data, exp: Date.now() + CACHE_MS }); return data; }

async function financeMeta(tenantKey, requestedFy = "") {
  const profile = await CompanyProfile.findOne({ tenantKey }).select("financialYear financialYears").lean();
  const financialYear = normalizeFy(requestedFy || profile?.financialYear || currentFy());
  const financialYears = [...new Set([...(profile?.financialYears || []), profile?.financialYear, financialYear].filter(Boolean).map(normalizeFy))]
    .sort((a, b) => fyStart(b) - fyStart(a));
  return { financialYear, financialYears };
}

async function pendingOrderExposure(tenantKey, years) {
  const blocks = await Promise.all(years.map(async (financialYear) => {
    const { SalesOrder } = financialModels(tenantKey, financialYear);
    return SalesOrder.find({
      tenantKey,
      financialYear,
      status: { $nin: ["CONVERTED", "CANCELLED", "REJECTED"] },
      workflowStatus: { $nin: ["COMPLETED", "CANCELLED", "DELIVERED"] },
    }).select("customerGlobalId grandTotal invoices").lean();
  }));
  const byParty = new Map();
  for (const orders of blocks) for (const order of orders) {
    const partyId = clean(order.customerGlobalId);
    if (!partyId) continue;
    const invoiced = (order.invoices || []).reduce((s, x) => s + Number(x?.grandTotal || 0), 0);
    const remaining = Math.max(0, Number(order.grandTotal || 0) - invoiced);
    byParty.set(partyId, money((byParty.get(partyId) || 0) + remaining));
  }
  return byParty;
}

export async function buildCustomerCreditExposure({ tenantKey, refresh = false }) {
  const key = `FIN:CREDIT:${tenantKey}`;
  const hit = refresh ? null : cacheGet(key);
  if (hit) return hit;
  const meta = await financeMeta(tenantKey);
  const [lock, pending] = await Promise.all([
    buildLockPartyReport({ tenantKey, refresh }),
    pendingOrderExposure(tenantKey, meta.financialYears),
  ]);
  const rows = (lock.rows || []).map((r) => {
    const receivable = r.balanceType === "DR" ? money(r.balance) : 0;
    const advance = r.balanceType === "CR" ? money(r.balance) : 0;
    const pendingOrders = money(pending.get(r.partyId) || 0);
    const exposure = money(receivable + pendingOrders);
    const available = money(Number(r.creditLimit || 0) - exposure);
    let risk = "NORMAL";
    if (Number(r.creditLimit || 0) > 0 && exposure > Number(r.creditLimit || 0)) risk = "OVER LIMIT";
    else if (receivable > 0 && Number(r.creditPeriod || 0) >= 0 && Number(r.dueDays || 0) > Number(r.creditPeriod || 0)) risk = "OVERDUE";
    else if (Number(r.creditLimit || 0) > 0 && exposure >= Number(r.creditLimit || 0) * 0.8) risk = "HIGH";
    return {
      partyId: r.partyId, partyName: r.partyName, salespersonId: r.salespersonId, salespersonName: r.salespersonName,
      territory: r.district, creditLimit: money(r.creditLimit), creditPeriod: Number(r.creditPeriod || 0), dueDays: Number(r.dueDays || 0),
      receivable, advance, pendingOrders, exposure, available, lockStatus: r.status, risk,
    };
  }).sort((a, b) => b.exposure - a.exposure || a.partyName.localeCompare(b.partyName));
  return cacheSet(key, {
    report: "CUSTOMER_CREDIT_EXPOSURE", generatedAt: new Date(), rows,
    totals: {
      customers: rows.length,
      receivable: money(rows.reduce((s, r) => s + r.receivable, 0)),
      pendingOrders: money(rows.reduce((s, r) => s + r.pendingOrders, 0)),
      exposure: money(rows.reduce((s, r) => s + r.exposure, 0)),
      overLimit: rows.filter((r) => r.risk === "OVER LIMIT").length,
      overdue: rows.filter((r) => r.risk === "OVERDUE").length,
    },
    meta: { salespersons: lock.salespersons || [], territories: lock.districts || [] },
  });
}

function receiptState(value) {
  const v = upper(value);
  if (v.includes("BOUNCE") || v.includes("RETURN") || v.includes("DISHON")) return "BOUNCED";
  if (["CLEAR", "CLEARED", "SUCCESS", "PAID", "POSTED"].includes(v)) return "CLEARED";
  if (["CANCELLED", "CANCELED", "VOID"].includes(v)) return "CANCELLED";
  return "PENDING";
}

function chequeLifecycleState(receipt) {
  if (upper(receipt.collectionSource) === "SALESPERSON_APP" && upper(receipt.status) !== "POSTED") return "PENDING";
  const explicit = upper(receipt.chequeStatus);
  if (["BOUNCED", "BOUNCE", "RETURNED", "DISHONOURED", "DISHONORED"].includes(explicit)) return "BOUNCED";
  if (["CLEARED", "CLEAR"].includes(explicit)) return "CLEARED";
  if (["DEPOSITED", "DEPOSIT"].includes(explicit)) return "DEPOSITED";
  if (["ISSUED", "ISSUE"].includes(explicit)) return "ISSUED";

  const bounce = receiptState(receipt.bounceStatus);
  if (bounce === "BOUNCED") return "BOUNCED";
  if (receipt.chequeClearanceDate) return "CLEARED";
  // A bank-statement-backed cheque receipt has already appeared in the bank,
  // so for legacy rows it is safe to treat it as cleared.
  if (receipt.statementImportId) return "CLEARED";
  if (receipt.chequeDepositDate) return "DEPOSITED";
  return "ISSUED";
}

export async function buildReceiptBounce({ tenantKey, financialYear }) {
  const meta = await financeMeta(tenantKey, financialYear);
  const { Receipt } = financialModels(tenantKey, meta.financialYear);
  const docs = await Receipt.find({ tenantKey, financialYear: meta.financialYear, status: { $ne: "DELETED" } })
    .select("receiptNo date customerGlobalId partyNameSnapshot amount mode receiptType allocationType againstInvoices payerAccountNumber paymentProofFileId upiPaymentText reference bankAccountId bankNameSnapshot statementImportId bounceStatus status remarks chequeNumber chequeIssueDate chequeDepositDate chequeClearanceDate chequeBounceDate chequeStatus collectionSource receiptWorkflowStatus customerOtpStatus cashierOtpStatus collectedBySalespersonNameSnapshot createdByNameSnapshot cashierOtpExpiresAt updatedAt")
    .sort({ date: -1, createdAt: -1 }).lean();

  // This report is specifically for cheque lifecycle tracking. Non-cheque
  // receipts (cash/NEFT/UPI etc.) stay in the normal Receipt reports.
  const chequeDocs = docs.filter((r) => {
    const mode = upper(r.mode);
    const receiptType = upper(r.receiptType);
    return receiptType === "CHEQUE" || Boolean(clean(r.chequeNumber)) || /CHEQUE|CHECK|CHQ/.test(mode);
  });

  const bankIds = [...new Set(chequeDocs.map((r) => clean(r.bankAccountId)).filter(Boolean))];
  const banks = bankIds.length
    ? await BankAccount.find({ tenantKey, bankAccountId: { $in: bankIds }, status: { $ne: "DELETED" } })
        .select("bankAccountId bankName accountNumber").lean()
    : [];
  const bankMap = new Map(banks.map((b) => [clean(b.bankAccountId), b]));

  const rows = chequeDocs.map((r) => {
    const bank = bankMap.get(clean(r.bankAccountId));
    const lifecycle = chequeLifecycleState(r);
    const issueDate = r.chequeIssueDate || r.date || null;
    const depositDate = r.chequeDepositDate || null;
    const clearanceDate = r.chequeClearanceDate || (lifecycle === "CLEARED" && r.statementImportId ? r.date : null);
    const bounceDate = r.chequeBounceDate || (lifecycle === "BOUNCED" ? (r.updatedAt || r.date) : null);
    return {
      id: id(r._id),
      receiptNo: clean(r.receiptNo),
      partyId: clean(r.customerGlobalId),
      partyName: clean(r.partyNameSnapshot) || "PARTY",
      amount: money(r.amount),
      mode: upper(r.mode) || "BANK",
      receiptType: upper(r.receiptType) || "CHEQUE",
      chequeNumber: clean(r.chequeNumber || r.reference),
      payerAccountNumber: clean(r.payerAccountNumber),
      paymentProofFileId: clean(r.paymentProofFileId),
      allocationType: clean(r.allocationType),
      againstInvoices: r.againstInvoices || [],
      issueDate,
      depositDate,
      clearanceDate,
      bounceDate,
      bankAccountId: clean(r.bankAccountId),
      bank: clean(r.bankNameSnapshot || bank?.bankName),
      accountNumber: clean(r.payerAccountNumber || bank?.accountNumber),
      status: lifecycle,
      workflowStatus: clean(r.receiptWorkflowStatus),
      customerOtpStatus: clean(r.customerOtpStatus) || "NOT_REQUIRED",
      cashierOtpStatus: clean(r.cashierOtpStatus) || "NOT_REQUIRED",
      cashierOtpExpiresAt: r.cashierOtpExpiresAt || null,
      madeBy: clean(r.collectedBySalespersonNameSnapshot || r.createdByNameSnapshot),
      collectionSource: clean(r.collectionSource),
      remarks: clean(r.remarks),
    };
  });

  const parties = [...new Map(rows.map((r) => [r.partyId || r.partyName, { id: r.partyId, name: r.partyName }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const bankOptions = [...new Map(rows.filter((r) => r.bank || r.bankAccountId).map((r) => [r.bankAccountId || r.bank, {
    id: r.bankAccountId || r.bank,
    name: r.bank || r.accountNumber || "BANK",
    accountNumber: r.accountNumber,
  }])).values()].sort((a, b) => a.name.localeCompare(b.name));

  const pendingRows = rows.filter((r) => r.status === "PENDING");
  const issuedRows = rows.filter((r) => r.status === "ISSUED" || r.status === "DEPOSITED");
  const clearedRows = rows.filter((r) => r.status === "CLEARED");
  const bouncedRows = rows.filter((r) => r.status === "BOUNCED");

  return {
    report: "RECEIPT_BOUNCE",
    financialYear: meta.financialYear,
    rows,
    totals: {
      cheques: rows.length,
      amount: money(rows.reduce((s, r) => s + r.amount, 0)),
      pending: money(pendingRows.reduce((s, r) => s + r.amount, 0)),
      pendingCount: pendingRows.length,
      issued: money(issuedRows.reduce((s, r) => s + r.amount, 0)),
      issuedCount: issuedRows.length,
      cleared: money(clearedRows.reduce((s, r) => s + r.amount, 0)),
      clearedCount: clearedRows.length,
      bounced: money(bouncedRows.reduce((s, r) => s + r.amount, 0)),
      bounceCount: bouncedRows.length,
    },
    meta: { financialYears: meta.financialYears, parties, banks: bankOptions },
  };
}

async function liquidOpening(tenantKey, financialYear) {
  const banks=await BankAccount.find({tenantKey,status:{$ne:"DELETED"}})
    .select("accountType openingBalance openingBalanceType financialYear openingBalances").lean();
  let opening=await companyCashOpening({tenantKey,financialYear});
  for(const bank of banks){
    const row=(bank.openingBalances||[]).find(x=>clean(x.financialYear)&&normalizeFy(x.financialYear)===financialYear);
    opening+=row?signed(row.amount,row.type):(clean(bank.financialYear)&&normalizeFy(bank.financialYear)===financialYear?signed(bank.openingBalance,bank.openingBalanceType):0);
  }
  return money(opening);
}

export async function buildCashFlow({ tenantKey, financialYear }) {
  const meta = await financeMeta(tenantKey, financialYear);
  const { LedgerEntry } = financialModels(tenantKey, meta.financialYear);
  const opening = await liquidOpening(tenantKey, meta.financialYear);
  const lines = await LedgerEntry.find({
    tenantKey, financialYear: meta.financialYear, status: "POSTED",
    accountCode: { $in: ["SYS_CASH", "SYS_BANK_ACCOUNT", "SYS_BANK_OD"] },
  }).select("transactionId transactionType date debit credit narration").sort({ date: 1, createdAt: 1 }).lean();
  const tx = new Map();
  for (const line of lines) {
    const key = `${clean(line.transactionId)}|${upper(line.transactionType)}|${new Date(line.date || 0).toISOString().slice(0, 10)}`;
    const cur = tx.get(key) || { transactionId: clean(line.transactionId), transactionType: upper(line.transactionType) || "OTHER", date: line.date, narration: clean(line.narration), net: 0 };
    cur.net += Number(line.debit || 0) - Number(line.credit || 0);
    tx.set(key, cur);
  }
  const months = new Map(); const categories = new Map();
  for (const row of tx.values()) {
    const net = money(row.net); if (Math.abs(net) < 0.005) continue; // internal cash/bank transfer nets to zero
    const month = monthLabel(row.date);
    const m = months.get(month) || { month, sortDate: new Date(row.date).toISOString().slice(0, 7), inflow: 0, outflow: 0, net: 0 };
    if (net > 0) m.inflow += net; else m.outflow += Math.abs(net); m.net += net; months.set(month, m);
    const c = categories.get(row.transactionType) || { category: row.transactionType, inflow: 0, outflow: 0, net: 0, transactions: 0 };
    if (net > 0) c.inflow += net; else c.outflow += Math.abs(net); c.net += net; c.transactions += 1; categories.set(row.transactionType, c);
  }
  const monthRows = [...months.values()].sort((a, b) => a.sortDate.localeCompare(b.sortDate));
  let running = opening;
  monthRows.forEach((r) => { r.inflow = money(r.inflow); r.outflow = money(r.outflow); r.net = money(r.net); running = money(running + r.net); r.closing = running; });
  const inflow = money(monthRows.reduce((s, r) => s + r.inflow, 0));
  const outflow = money(monthRows.reduce((s, r) => s + r.outflow, 0));
  return {
    report: "CASH_FLOW", financialYear: meta.financialYear, opening, rows: monthRows,
    categories: [...categories.values()].map((r) => ({ ...r, inflow: money(r.inflow), outflow: money(r.outflow), net: money(r.net) })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)),
    totals: { opening, inflow, outflow, net: money(inflow - outflow), closing: money(opening + inflow - outflow) },
    meta: { financialYears: meta.financialYears },
  };
}

function openingExact(rows, fy) {
  const row = (rows || []).find((x) => normalizeFy(x.financialYear) === fy);
  return row ? signed(row.amount, row.type) : 0;
}

async function workingCapitalCore(tenantKey, financialYear) {
  const key = `FIN:WC:${tenantKey}:${financialYear}`;
  const hit = cacheGet(key); if (hit) return hit;
  const meta = await financeMeta(tenantKey, financialYear);
  const models = financialModels(tenantKey, meta.financialYear);
  const [companyLedgers, customers, banks, movements, stock, salesAgg, purchaseAgg, receiptAgg] = await Promise.all([
    CompanyLedger.find({ tenantKey, status: { $ne: "INACTIVE" } }).select("ownerType ownerId systemAccountCode openingBalances").lean(),
    CustomerLink.find({ tenantKey }).select("globalCustomerId partyType accountingProfile").lean(),
    BankAccount.find({ tenantKey, status: { $ne: "DELETED" } }).select("accountType openingBalance openingBalanceType financialYear openingBalances").lean(),
    models.LedgerEntry.aggregate([
      { $match: { tenantKey, financialYear: meta.financialYear, status: "POSTED" } },
      { $group: { _id: "$accountCode", debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
    ]),
    buildStockAnalysisReport({ tenantKey, financialYear: meta.financialYear, reportType: "CLOSING" }),
    models.SalesInvoice.aggregate([{ $match: { tenantKey, financialYear: meta.financialYear, status: { $in: ["POSTED", "COMPLETED"] } } }, { $group: { _id: null, total: { $sum: "$grandTotal" } } }]),
    models.PurchaseInvoice.aggregate([{ $match: { tenantKey, financialYear: meta.financialYear, status: { $in: ["POSTED", "COMPLETED"] } } }, { $group: { _id: null, total: { $sum: "$grandTotal" } } }]),
    models.Receipt.aggregate([{ $match: { tenantKey, financialYear: meta.financialYear, status: "POSTED", bounceStatus: { $not: /BOUNCE|RETURN|DISHON/i },
      $or: [{ collectionSource: { $ne: "SALESPERSON_APP" } }, { ledgerPostedAt: { $exists: true } }] } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
  ]);
  const move = new Map(movements.map((x) => [upper(x._id), { debit: Number(x.debit || 0), credit: Number(x.credit || 0) }]));
  const companyOpening = new Map();
  for (const l of companyLedgers) {
    const code = upper(l.systemAccountCode);
    if (["SYS_BANK_ACCOUNT", "SYS_BANK_OD", "SYS_STOCK"].includes(code)) continue;
    companyOpening.set(code, (companyOpening.get(code) || 0) + openingExact(l.openingBalances, meta.financialYear));
  }

  const ledgerOwners = new Set(companyLedgers.filter((l) => ["SYS_SUNDRY_DEBTORS", "SYS_SUNDRY_CREDITORS"].includes(upper(l.systemAccountCode))).map((l) => clean(l.ownerId)));
  for (const c of customers) {
    if (ledgerOwners.has(clean(c.globalCustomerId))) continue;
    const p = c.accountingProfile || {}; if (!clean(p.financialYear) || normalizeFy(p.financialYear) !== meta.financialYear) continue;
    const code = upper(p.systemAccountCode || (["CREDITOR", "SUPPLIER"].includes(upper(c.partyType)) ? "SYS_SUNDRY_CREDITORS" : "SYS_SUNDRY_DEBTORS"));
    companyOpening.set(code, (companyOpening.get(code) || 0) + signed(p.openingBalance, p.openingBalanceType));
  }
  let bankAssetOpen = 0, bankOdOpen = 0;
  for (const bank of banks) {
    const row = (bank.openingBalances || []).find((x) => clean(x.financialYear) && normalizeFy(x.financialYear) === meta.financialYear);
    const val = row ? signed(row.amount, row.type) : (clean(bank.financialYear) && normalizeFy(bank.financialYear) === meta.financialYear ? signed(bank.openingBalance, bank.openingBalanceType) : 0);
    if (["OD", "CC"].includes(upper(bank.accountType))) bankOdOpen += Math.max(0, -val); else bankAssetOpen += val;
  }
  const asset = (code, extraOpen = 0) => {
    const o = Number(companyOpening.get(code) || 0) + extraOpen; const m = move.get(code) || { debit: 0, credit: 0 }; return { opening: money(Math.max(0, o)), closing: money(Math.max(0, o + m.debit - m.credit)) };
  };
  const liability = (code, extraOpen = 0) => {
    const raw = Number(companyOpening.get(code) || 0); const o = Math.max(0, -raw) + extraOpen; const m = move.get(code) || { debit: 0, credit: 0 }; return { opening: money(o), closing: money(Math.max(0, o + m.credit - m.debit)) };
  };
  const debtors = asset("SYS_SUNDRY_DEBTORS");
  const creditors = liability("SYS_SUNDRY_CREDITORS");
  // Cashbook and Balance Sheet MUST have the same opening (including the
  // first-FY profile balance and properly rolled-forward prior-year activity).
  companyOpening.set("SYS_CASH", await companyCashOpening({tenantKey,financialYear:meta.financialYear}));
  const cash = asset("SYS_CASH");
  const bank = asset("SYS_BANK_ACCOUNT", bankAssetOpen);
  const bankOd = liability("SYS_BANK_OD", bankOdOpen);
  const advances = asset("SYS_LOANS_ADVANCES");
  const deposits = asset("SYS_DEPOSIT_ASSET");
  const otherCA = asset("SYS_CURRENT_ASSETS");
  const taxes = liability("SYS_DUTIES_TAXES");
  const provisions = liability("SYS_PROVISIONS");
  const otherCL = liability("SYS_CURRENT_LIABILITIES");
  const inventory = { opening: money(stock.totals?.openingTotal), closing: money(stock.totals?.closingTotal) };
  const components = [
    { key: "DEBTORS", name: "CUSTOMER RECEIVABLES", type: "ASSET", ...debtors },
    { key: "INVENTORY", name: "INVENTORY / STOCK", type: "ASSET", ...inventory },
    { key: "CASH", name: "CASH IN HAND", type: "ASSET", ...cash },
    { key: "BANK", name: "BANK BALANCE", type: "ASSET", ...bank },
    { key: "ADVANCES", name: "LOANS & ADVANCES", type: "ASSET", ...advances },
    { key: "DEPOSITS", name: "DEPOSITS", type: "ASSET", ...deposits },
    { key: "OTHER_CA", name: "OTHER CURRENT ASSETS", type: "ASSET", ...otherCA },
    { key: "CREDITORS", name: "SUPPLIER PAYABLES", type: "LIABILITY", ...creditors },
    { key: "BANK_OD", name: "BANK OD / CC", type: "LIABILITY", ...bankOd },
    { key: "TAXES", name: "DUTIES & TAXES PAYABLE", type: "LIABILITY", ...taxes },
    { key: "PROVISIONS", name: "PROVISIONS", type: "LIABILITY", ...provisions },
    { key: "OTHER_CL", name: "OTHER CURRENT LIABILITIES", type: "LIABILITY", ...otherCL },
  ].map((r) => ({ ...r, change: money(r.closing - r.opening) }));
  const openingAssets = money(components.filter((x) => x.type === "ASSET").reduce((s, x) => s + x.opening, 0));
  const closingAssets = money(components.filter((x) => x.type === "ASSET").reduce((s, x) => s + x.closing, 0));
  const openingLiabilities = money(components.filter((x) => x.type === "LIABILITY").reduce((s, x) => s + x.opening, 0));
  const closingLiabilities = money(components.filter((x) => x.type === "LIABILITY").reduce((s, x) => s + x.closing, 0));
  return cacheSet(key, { meta, components, totals: { openingAssets, closingAssets, openingLiabilities, closingLiabilities, openingWorkingCapital: money(openingAssets - openingLiabilities), closingWorkingCapital: money(closingAssets - closingLiabilities), change: money((closingAssets - closingLiabilities) - (openingAssets - openingLiabilities)) }, activity: { sales: money(salesAgg[0]?.total), purchases: money(purchaseAgg[0]?.total), receipts: money(receiptAgg[0]?.total) }, move, companyOpening });
}

export async function buildWorkingCapital({ tenantKey, financialYear }) {
  const core = await workingCapitalCore(tenantKey, normalizeFy(financialYear));
  return { report: "WORKING_CAPITAL", financialYear: core.meta.financialYear, rows: core.components, totals: core.totals, meta: { financialYears: core.meta.financialYears } };
}

export async function buildFundFlow({ tenantKey, financialYear }) {
  const core = await workingCapitalCore(tenantKey, normalizeFy(financialYear));
  const rows = core.components.map((r) => {
    const change = money(r.closing - r.opening); let source = 0, use = 0;
    if (r.type === "ASSET") { if (change > 0) use = change; else source = Math.abs(change); }
    else { if (change > 0) source = change; else use = Math.abs(change); }
    return { ...r, source: money(source), use: money(use) };
  });
  const sources = money(rows.reduce((s, r) => s + r.source, 0)); const uses = money(rows.reduce((s, r) => s + r.use, 0));
  return { report: "FUND_FLOW", financialYear: core.meta.financialYear, rows, totals: { sources, uses, netFundFlow: money(sources - uses), workingCapitalChange: core.totals.change }, meta: { financialYears: core.meta.financialYears } };
}

function closingByCodes(core, codes, normal = "CR") {
  let total = 0;
  for (const code of codes) {
    const openSigned = Number(core.companyOpening.get(code) || 0); const mv = core.move.get(code) || { debit: 0, credit: 0 };
    const closeSigned = openSigned + mv.debit - mv.credit;
    total += normal === "DR" ? Math.max(0, closeSigned) : Math.max(0, -closeSigned);
  }
  return money(total);
}

export async function buildRatioAnalysis({ tenantKey, financialYear }) {
  const core = await workingCapitalCore(tenantKey, normalizeFy(financialYear));
  const ca = core.totals.closingAssets, cl = core.totals.closingLiabilities;
  const inv = core.components.find((x) => x.key === "INVENTORY") || { opening: 0, closing: 0 };
  const debtors = core.components.find((x) => x.key === "DEBTORS")?.closing || 0;
  const creditors = core.components.find((x) => x.key === "CREDITORS")?.closing || 0;
  const days = 365;
  const avgInv = (Number(inv.opening || 0) + Number(inv.closing || 0)) / 2;
  const debt = money(closingByCodes(core, ["SYS_SECURED_LOAN", "SYS_UNSECURED_LOAN", "SYS_LOAN_LIABILITY", "SYS_DIRECTOR_LOAN", "SYS_PARTNER_LOAN"], "CR") + Number(core.components.find((x) => x.key === "BANK_OD")?.closing || 0));
  const equity = closingByCodes(core, ["SYS_CAPITAL", "SYS_PROPRIETOR_CAPITAL", "SYS_PARTNER_CAPITAL", "SYS_SHARE_CAPITAL", "SYS_RESERVES_SURPLUS"], "CR");
  const sales = core.activity.sales, purchases = core.activity.purchases, receipts = core.activity.receipts;
  const ratio = (n, d) => d ? money(n / d) : null; const pct = (n, d) => d ? money((n / d) * 100) : null;
  const rows = [
    { ratio: "CURRENT RATIO", value: ratio(ca, cl), unit: "x", formula: "CURRENT ASSETS / CURRENT LIABILITIES", note: "SHORT-TERM LIQUIDITY" },
    { ratio: "QUICK RATIO", value: ratio(ca - Number(inv.closing || 0), cl), unit: "x", formula: "(CURRENT ASSETS - INVENTORY) / CURRENT LIABILITIES", note: "LIQUIDITY WITHOUT STOCK" },
    { ratio: "WORKING CAPITAL", value: money(ca - cl), unit: "₹", formula: "CURRENT ASSETS - CURRENT LIABILITIES", note: "NET SHORT-TERM FUNDS" },
    { ratio: "DEBT / EQUITY", value: ratio(debt, equity), unit: "x", formula: "INTEREST-BEARING DEBT / EQUITY", note: "LEVERAGE" },
    { ratio: "DEBTOR DAYS", value: sales ? money((debtors / sales) * days) : null, unit: "DAYS", formula: "CLOSING RECEIVABLES / SALES × 365", note: "COLLECTION SPEED" },
    { ratio: "CREDITOR DAYS", value: purchases ? money((creditors / purchases) * days) : null, unit: "DAYS", formula: "CLOSING PAYABLES / PURCHASES × 365", note: "SUPPLIER PAYMENT CYCLE" },
    { ratio: "INVENTORY TURNOVER", value: ratio(purchases, avgInv), unit: "x", formula: "PURCHASES / AVERAGE INVENTORY", note: "STOCK MOVEMENT INDICATOR" },
    { ratio: "COLLECTION / SALES", value: pct(receipts, sales), unit: "%", formula: "CUSTOMER RECEIPTS / SALES × 100", note: "COLLECTION EFFICIENCY" },
  ];
  return { report: "RATIO_ANALYSIS", financialYear: core.meta.financialYear, rows, base: { currentAssets: ca, currentLiabilities: cl, inventory: inv.closing, debtors, creditors, sales, purchases, receipts, debt, equity }, meta: { financialYears: core.meta.financialYears } };
}
