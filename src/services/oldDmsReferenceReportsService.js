// V2-native report suite rebuilt from the OLD DMS report behaviour.
// IMPORTANT: this file uses the old DMS only as a business-rule reference.
// It queries only current V2 models / FY databases and does not import legacy code.
import { financialModels } from "./accountingService.js";
import { buildGstReport } from "./gstReportsService.js";
import { inspectBankLedgerRows } from "./bankLedgerIntegrityService.js";
import { buildLegacyReport, invoiceLines, orderRows, reportPeriod } from "./legacyReportsService.js";
import {
  Product, CustomerLink, Target, GenericRecord, User, Employee, AccountTemplate,
  CompanyLedger, BankAccount, CustomerVisit,
} from "../models/index.js";
import { PurchaseOrder as PurchaseOrderAi } from "../models/purchaseAiModels.js";
import { buildClosingStockRows } from "./closingStockService.js";

const N = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const R = (v) => Math.round((N(v) + Number.EPSILON) * 100) / 100;
const T = (v) => String(v ?? "").trim();
const U = (v) => T(v).toUpperCase();
const LIMIT = 40000;
const DAY = 86400000;

async function read(model, query, sort = { date: -1 }) {
  const rows = await model.find(query).sort(sort).limit(LIMIT + 1).lean();
  if (rows.length > LIMIT) {
    const error = new Error(`Report exceeds ${LIMIT} source documents. Select a shorter period.`);
    error.statusCode = 413;
    throw error;
  }
  return rows;
}
const totals = (rows, fields) => Object.fromEntries(fields.map((field) => [field, R(rows.reduce((s, r) => s + N(r[field]), 0))]));
const dateOnly = (value) => {
  const d = new Date(value || 0);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};
const group = (rows, keys, numeric) => {
  const map = new Map();
  for (const row of rows) {
    const id = keys.map((k) => T(row[k]) || "UNASSIGNED").join("\u001f");
    if (!map.has(id)) map.set(id, {
      ...Object.fromEntries(keys.map((k) => [k, row[k] ?? ""])), count: 0,
      ...Object.fromEntries(numeric.map((k) => [k, 0])),
    });
    const current = map.get(id); current.count += 1;
    numeric.forEach((k) => { current[k] += N(row[k]); });
  }
  return [...map.values()].map((r) => ({ ...r, ...Object.fromEntries(numeric.map((k) => [k, R(r[k])])) }));
};
const signedOpening = (amount, type) => U(type) === "CR" ? -Math.abs(N(amount)) : Math.abs(N(amount));
const fyStartDate = (financialYear) => new Date(`${String(financialYear).slice(0, 4)}-04-01T00:00:00.000Z`);
const endExclusive = (isoDate) => new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + DAY);
const inRange = (date, from, to) => {
  const ts = new Date(date || 0).getTime();
  return ts >= new Date(`${from}T00:00:00.000Z`).getTime() && ts < endExclusive(to).getTime();
};
const monthKey = (date) => {
  const d = new Date(date || 0); if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toUpperCase();
};
const normalizeMonth = (value) => U(value).replace(/[^A-Z0-9]/g, "");
const periodMonths = (from, to) => {
  const out = new Set();
  let d = new Date(`${from}T00:00:00.000Z`), last = new Date(`${to}T00:00:00.000Z`);
  while (d <= last) { out.add(monthKey(d)); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); }
  return out;
};

const OLD_DMS_REPORTS = [
  ["Report", "Stock Report", "stock-report"],
  ["Report", "Team and Target Report", "target-team"],
  ["Report", "Target Report", "target-all"],

  ["All GSTR", "GSTR 1", "gst-gstr1"],
  ["All GSTR", "GSTR 3B", "gst-gstr3b"],
  ["All GSTR", "GSTR 2B", "gst-gstr2b"],
  ["All GSTR", "HSN WISE REPORT", "gst-hsn"],

  ["Purchase Reports", "PRODUCT WISE PURCHASE REPORT", "purchase-product"],
  ["Purchase Reports", "PURCHASE ORDER REPORT", "purchase-order"],
  ["Purchase Reports", "PARTY WISE AND PRODUCT WISE PURCHASE REPORT", "purchase-party-product"],
  ["Purchase Reports", "Purchase Return Report", "purchase-return"],

  ["Stock Reports", "STOCK DIFFERENCE REPORT", "stock-difference"],
  ["Stock Reports", "Dead Stock Report", "stock-dead"],
  ["Stock Reports", "Low Stock Report", "stock-low"],
  ["Stock Reports", "Closing Stock Report", "stock-closing"],
  ["Stock Reports", "WareHouse Stock Shortage", "warehouse-shortage"],
  ["Stock Reports", "Damage Reports", "stock-damage"],
  ["Stock Reports", "WareHouse Reports", "warehouse-summary"],
  ["Stock Reports", "WareHouse Stock Report", "warehouse-stock"],

  ["Sales Reports", "Dead Parties Reports", "dead-parties"],
  ["Sales Reports", "PARTY WISE AND PRODUCT WISE SALE REPORT", "sales-party-product"],
  ["Sales Reports", "PRODUCT WISE SALE REPORT", "sales-product"],
  ["Sales Reports", "Sales Order Report", "sales-order"],
  ["Sales Reports", "Sales Pending Report", "sales-pending"],
  ["Sales Reports", "SalesComplete Order Report", "sales-completed"],
  ["Sales Reports", "Delivered Order Report", "sales-delivered"],
  ["Sales Reports", "Sales Report and Amount", "sales-doc"],
  ["Sales Reports", "Sales Return Report", "sales-return"],
  ["Sales Reports", "SalesTarget Report", "target-sales"],
  ["Sales Reports", "Target Achieved Report", "target-achieved"],
  ["Sales Reports", "Target Pending Report", "target-pending"],
  ["Sales Reports", "SalesDispatch Report", "sales-dispatch"],

  ["Finance Reports", "Lock Party Report", "locked-party"],
  ["Finance Reports", "TAX REPORT", "tax"],
  ["Finance Reports", "Overdue Report", "overdue"],
  ["Finance Reports", "Party Ledger Report", "party-ledger"],
  ["Finance Reports", "cashbook Report", "cashbook"],
  ["Finance Reports", "receipt Report", "receipt"],
  ["Finance Reports", "Payment Report", "payment"],
  ["Finance Reports", "Due Report", "due"],
  // Old DMS listed the following two again under Finance. One V2 source is used.
  ["Finance Reports", "sales Report and Amount", "sales-doc"],
  ["Finance Reports", "sales Return Report", "sales-return"],
  ["Finance Reports", "Bank Statement", "bank-statement"],
  ["Finance Reports", "PartywiseLedger Report", "party-ledger-detail"],
  ["Finance Reports", "Profit and Loss Report", "pnl"],
  ["Finance Reports", "BalanceSheet", "balance-sheet"],
  ["Finance Reports", "Promotional Activity Report", "promotion"],

  ["Reports", "Admin Report", "admin"],
  ["Reports", "Customer Report", "customers"],
  ["Reports", "Staff Report", "staff"],
  ["Reports", "Transaction Report", "transactions"],
  ["Reports", "Product Report", "products"],
  ["Reports", "Earning Report", "earnings"],
];

export const oldDmsReferenceReportCatalog = OLD_DMS_REPORTS.map(([category, name, kind], index) => ({
  id: `ODMS-${String(index + 1).padStart(3, "0")}`,
  category,
  name,
  kind,
  implementation: "V2_OLD_DMS_REFERENCE",
  formats: ["SCREEN", "EXCEL", "PRINT"],
}));
const kindByName = new Map(OLD_DMS_REPORTS.map(([, name, kind]) => [name.toLowerCase(), kind]));
export const oldDmsReferenceReportKind = (name) => kindByName.get(T(name).toLowerCase()) || null;

const delegatedLegacyName = {
  "sales-doc": "Sales Report and Amount",
  "sales-product": "Product Wise Sale Report",
  "sales-party-product": "Party Wise and Product Wise Sale Report",
  "sales-order": "Sales Order Report",
  "sales-pending": "Sales Pending Report",
  "sales-completed": "Sales Complete Order Report",
  "sales-delivered": "Delivered Order Report",
  "sales-dispatch": "Sales Dispatch Report",
  "purchase-product": "Product Wise Purchase Report",
  "purchase-party-product": "Party Wise and Product Wise Purchase Report",
  "purchase-order": "Purchase Order Report",
  "stock-dead": "Dead Stock Report (No Outward This FY)",
  "stock-low": "Low Stock Report (Live)",
  "stock-damage": "Damage Reports",
  "locked-party": "Lock Party Report",
  cashbook: "Cashbook Report",
  receipt: "Receipt Report",
  payment: "Payment Report",
  "bank-statement": "Bank Statement Report",
  "dead-parties": "Dead Parties Report (No Sales in FY)",
};

function reportEnvelope({ name, financialYear, period, rows = [], summary = {}, note = "", source = "V2 data" }) {
  return {
    name, financialYear, startDate: period.from, endDate: period.to, generatedAt: new Date(),
    implementation: "V2_OLD_DMS_REFERENCE", source, note, summary, rows, recordCount: rows.length,
    emptyReason: rows.length ? null : `No matching source records for ${period.from} to ${period.to}. Try Full FY or a period containing transactions.`,
    branding: { footer: "This page is generated by the Rupioo Global System." },
  };
}

function gstRows(data) {
  if (data.sections) return Object.entries(data.sections).flatMap(([section, rows]) => (rows || []).map((row) => ({ section, ...row })));
  if (data.natureOfSupplies) return [
    ...(data.natureOfSupplies || []).map((row) => ({ section: "Nature of Supplies", ...row })),
    ...(data.eligibleITC || []).map((row) => ({ section: "Eligible ITC", ...row })),
  ];
  if (data.regular || data.unregister) return [
    ...(data.regular || []).map((row) => ({ section: "Registered", ...row })),
    ...(data.unregister || []).map((row) => ({ section: "Unregistered", ...row })),
  ];
  return data.rows || [];
}

async function gstReport(kind, args, period, name) {
  const map = { "gst-gstr1": "GSTR1", "gst-gstr2b": "GSTR2B", "gst-gstr3b": "GSTR3B", "gst-hsn": "HSN" };
  const data = await buildGstReport(map[kind], { ...args, startDate: period.from, endDate: period.to });
  const rows = gstRows(data);
  return reportEnvelope({
    name, financialYear: args.financialYear, period, rows,
    summary: data.totals || data.sourceTotals || { records: rows.length },
    source: `V2 GST engine (${map[kind]})`,
    note: kind === "gst-gstr2b" ? "Uses the V2 purchase register. Reconcile with the government GSTR-2B statement before filing." : "Rebuilt from V2 posted invoices using the old-DMS report structure as reference.",
  });
}

async function targetRows({ tenantKey, financialYear, period, f }) {
  const months = periodMonths(period.from, period.to);
  const [targets, sales, receipts, visits, products, customers, users] = await Promise.all([
    read(Target, { tenantKey, financialYear }, { level: 1, entityId: 1 }),
    read(f.SalesInvoice, { tenantKey, financialYear, status: { $in: ["POSTED", "COMPLETED"] }, date: period.cutoff }, { date: 1 }),
    read(f.Receipt, { tenantKey, financialYear, status: "POSTED", date: period.cutoff }, { date: 1 }),
    read(CustomerVisit, { tenantKey, financialYear, status: "COMPLETED", startedAt: period.cutoff }, { startedAt: 1 }),
    read(Product, { tenantKey }, { name: 1 }),
    read(CustomerLink, { tenantKey }, { localName: 1 }),
    read(User, { tenantKey }, { name: 1 }),
  ]);
  const productMap = new Map(products.map((p) => [T(p._id), p]));
  const customerMap = new Map(customers.map((c) => [T(c.globalCustomerId), c]));
  const userMap = new Map(users.map((u) => [T(u._id), u]));
  const customerCreated = customers.filter((c) => inRange(c.createdAt, period.from, period.to));
  const targetForPeriod = (target, field) => {
    if (period.from === `${String(financialYear).slice(0, 4)}-04-01` && period.to === `${Number(String(financialYear).slice(0, 4)) + 1}-03-31`) return N(target?.annual?.[field]);
    const monthly = Array.isArray(target.monthly) ? target.monthly : [];
    const matches = monthly.filter((m) => months.has(normalizeMonth(m.month)) || [...months].some((x) => normalizeMonth(x).startsWith(normalizeMonth(m.month)) || normalizeMonth(m.month).startsWith(normalizeMonth(x).slice(0, 3))));
    return R(matches.reduce((s, m) => s + N(m?.[field]), 0));
  };
  const entityName = (target) => {
    const id = T(target.entityId);
    if (target.level === "COMPANY") return "COMPANY";
    if (["USER", "MANAGER"].includes(target.level)) return userMap.get(id)?.name || id;
    if (target.level === "CUSTOMER") return customerMap.get(id)?.localName || customerMap.get(id)?.displayIdentifier || id;
    if (target.level === "PRODUCT") return productMap.get(id)?.name || productMap.get(id)?.sku || id;
    return id || target.level;
  };
  const invoiceBelongs = (inv, target) => {
    const id = T(target.entityId);
    if (target.level === "COMPANY") return true;
    if (["USER", "MANAGER"].includes(target.level)) return T(inv.assignedTo) === id;
    if (target.level === "CUSTOMER") return T(inv.customerGlobalId) === id;
    if (target.level === "TERRITORY") return T(customerMap.get(T(inv.customerGlobalId))?.territoryId) === id;
    if (target.level === "PRODUCT") return (inv.items || []).some((it) => T(it.productId) === id);
    if (target.level === "CATEGORY") return (inv.items || []).some((it) => T(productMap.get(T(it.productId))?.category) === id);
    return false;
  };
  const receiptBelongs = (rec, target) => {
    const id = T(target.entityId);
    if (target.level === "COMPANY") return true;
    if (["USER", "MANAGER"].includes(target.level)) return T(rec.collectedBySalespersonId || rec.createdBy) === id;
    if (target.level === "CUSTOMER") return T(rec.customerGlobalId) === id;
    if (target.level === "TERRITORY") return T(customerMap.get(T(rec.customerGlobalId))?.territoryId) === id;
    return false;
  };
  const visitBelongs = (visit, target) => {
    const id = T(target.entityId);
    if (target.level === "COMPANY") return true;
    if (["USER", "MANAGER"].includes(target.level)) return T(visit.salespersonId) === id;
    if (target.level === "CUSTOMER") return T(visit.customerGlobalId) === id;
    if (target.level === "TERRITORY") return T(customerMap.get(T(visit.customerGlobalId))?.territoryId) === id;
    return false;
  };
  const newCustomerBelongs = (c, target) => {
    const id = T(target.entityId);
    if (target.level === "COMPANY") return true;
    if (["USER", "MANAGER"].includes(target.level)) return T(c.salespersonId) === id;
    if (target.level === "TERRITORY") return T(c.territoryId) === id;
    if (target.level === "CUSTOMER") return T(c.globalCustomerId) === id;
    return false;
  };
  return targets.map((target) => {
    const matchedSales = sales.filter((x) => invoiceBelongs(x, target));
    const actualSales = R(matchedSales.reduce((s, x) => s + N(x.taxableTotal ?? x.subtotal), 0));
    const actualGrossProfit = R(matchedSales.reduce((s, x) => s + N(x.grossProfit), 0));
    const actualCollection = R(receipts.filter((x) => receiptBelongs(x, target)).reduce((s, x) => s + N(x.amount), 0));
    const actualVisits = visits.filter((x) => visitBelongs(x, target)).length;
    const actualNewCustomers = customerCreated.filter((x) => newCustomerBelongs(x, target)).length;
    const targetSales = targetForPeriod(target, "sales"), targetGrossProfit = targetForPeriod(target, "grossProfit"), targetCollection = targetForPeriod(target, "collection"), targetVisits = targetForPeriod(target, "visits"), targetNewCustomers = targetForPeriod(target, "newCustomers");
    const achievedPct = targetSales > 0 ? R(actualSales / targetSales * 100) : (actualSales > 0 ? 100 : 0);
    return {
      level: target.level, entityId: target.entityId, entity: entityName(target), status: target.status,
      targetSales, actualSales, pendingSales: R(Math.max(0, targetSales - actualSales)), achievedPct,
      targetGrossProfit, actualGrossProfit, pendingGrossProfit: R(Math.max(0, targetGrossProfit - actualGrossProfit)),
      targetCollection, actualCollection, pendingCollection: R(Math.max(0, targetCollection - actualCollection)),
      targetVisits, actualVisits, pendingVisits: R(Math.max(0, targetVisits - actualVisits)),
      targetNewCustomers, actualNewCustomers, pendingNewCustomers: R(Math.max(0, targetNewCustomers - actualNewCustomers)),
    };
  });
}

async function stockPosition({ tenantKey, financialYear, period, f }) {
  const [products, moves, warehouses] = await Promise.all([
    read(Product, { tenantKey }, { name: 1 }),
    read(f.StockMovement, { tenantKey, financialYear, date: { $gte: fyStartDate(financialYear), $lt: endExclusive(period.to) } }, { date: 1 }),
    read(GenericRecord, { tenantKey, app: "dms", resource: "warehouses", status: { $ne: "INACTIVE" } }, { title: 1 }),
  ]);
  const warehouseMap = new Map(warehouses.map((w) => [T(w._id), w.title || w.reference || T(w._id)]));
  const byProduct = new Map();
  const before = new Date(`${period.from}T00:00:00.000Z`).getTime(), after = endExclusive(period.to).getTime();
  for (const move of moves) {
    const id = T(move.productId); if (!byProduct.has(id)) byProduct.set(id, { beforeIn: 0, beforeOut: 0, in: 0, out: 0 });
    const row = byProduct.get(id), ts = new Date(move.date || 0).getTime();
    if (ts < before) { row.beforeIn += N(move.qtyIn); row.beforeOut += N(move.qtyOut); }
    else if (ts < after) { row.in += N(move.qtyIn); row.out += N(move.qtyOut); }
  }
  const isCurrentEnd = period.to >= new Date().toISOString().slice(0, 10);
  const rows = products.map((p) => {
    const x = byProduct.get(T(p._id)) || { beforeIn: 0, beforeOut: 0, in: 0, out: 0 };
    const openingQty = R(N(p.openingStock) + x.beforeIn - x.beforeOut);
    const inwardQty = R(x.in), outwardQty = R(x.out), expectedClosingQty = R(openingQty + inwardQty - outwardQty);
    const actualCurrentQty = isCurrentEnd ? R(p.currentStock) : null;
    const differenceQty = actualCurrentQty == null ? null : R(actualCurrentQty - expectedClosingQty);
    const rate = R(p.landedCost || p.averagePurchasePrice || p.openingRate);
    return {
      productId: T(p._id), sku: p.sku, product: p.name, category: p.category || "", warehouseId: p.warehouseId || "", warehouse: warehouseMap.get(T(p.warehouseId)) || T(p.warehouseId),
      openingQty, inwardQty, outwardQty, expectedClosingQty, actualCurrentQty, differenceQty,
      rate, openingValue: R(openingQty * rate), closingValue: R(expectedClosingQty * rate),
      minQty: R(p.minStockAlert), reservedQty: R(p.reservedStock), availableQty: R(N(p.currentStock) - N(p.reservedStock)),
    };
  });
  return { rows, warehouses, warehouseMap };
}

async function partyLedgerRows({ tenantKey, financialYear, period, f }) {
  const start = new Date(`${period.from}T00:00:00.000Z`), end = endExclusive(period.to);
  const [raw, customers, sales] = await Promise.all([
    read(f.LedgerEntry, { tenantKey, financialYear, status: "POSTED", date: { $gte: fyStartDate(financialYear), $lt: end }, partyGlobalId: { $nin: [null, ""] }, accountCode: { $in: ["SYS_SUNDRY_DEBTORS", "SYS_SUNDRY_CREDITORS"] } }, { date: 1, createdAt: 1 }),
    read(CustomerLink, { tenantKey }, { localName: 1 }),
    read(f.SalesInvoice, { tenantKey, financialYear, status: { $in: ["POSTED", "COMPLETED"] }, date: { $gte: fyStartDate(financialYear), $lt: end } }, { date: 1 }),
  ]);
  const { rows: entries } = await inspectBankLedgerRows({ tenantKey, financialYear, rows: raw });
  const cmap = new Map(customers.map((c) => [T(c.globalCustomerId), c]));
  const lastSale = new Map();
  sales.forEach((s) => { const id = T(s.customerGlobalId); if (!lastSale.has(id) || new Date(s.date) > new Date(lastSale.get(id).date)) lastSale.set(id, s); });
  const grouped = new Map();
  for (const e of entries) {
    const id = T(e.partyGlobalId); if (!id) continue;
    if (!grouped.has(id)) grouped.set(id, { beforeDebit: 0, beforeCredit: 0, debit: 0, credit: 0, transactions: 0 });
    const g = grouped.get(id), d = new Date(e.date || e.createdAt || 0);
    if (d < start) { g.beforeDebit += N(e.debit); g.beforeCredit += N(e.credit); }
    else { g.debit += N(e.debit); g.credit += N(e.credit); g.transactions += 1; }
  }
  const ids = new Set([...grouped.keys(), ...customers.map((c) => T(c.globalCustomerId))]);
  return [...ids].map((id) => {
    const c = cmap.get(id) || {}, g = grouped.get(id) || { beforeDebit: 0, beforeCredit: 0, debit: 0, credit: 0, transactions: 0 };
    const ap = c.accountingProfile || {};
    const masterOpening = !T(ap.financialYear) || T(ap.financialYear) === T(financialYear) ? signedOpening(ap.openingBalance, ap.openingBalanceType) : 0;
    const openingSigned = R(masterOpening + g.beforeDebit - g.beforeCredit);
    const closingSigned = R(openingSigned + g.debit - g.credit);
    const sale = lastSale.get(id), creditDays = N(c.approvedTerms?.creditDays ?? c.creditDays), graceDays = N(c.approvedTerms?.graceDays ?? c.graceDays);
    const baseDate = sale?.date ? new Date(sale.date) : null;
    const dueDate = baseDate ? new Date(baseDate.getTime() + (creditDays + graceDays) * DAY) : null;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const dueDelta = dueDate ? Math.floor((dueDate.getTime() - today.getTime()) / DAY) : 0;
    return {
      partyId: id, party: c.localName || c.displayIdentifier || id, paymentType: c.paymentType || "", status: c.status || "",
      salespersonId: c.salespersonId || "", territoryId: c.territoryId || "", creditLimit: R(c.creditLimit), creditDays, graceDays,
      opening: R(Math.abs(openingSigned)), openingType: openingSigned < 0 ? "CR" : "DR",
      debit: R(g.debit), credit: R(g.credit), closing: R(Math.abs(closingSigned)), closingType: closingSigned < 0 ? "CR" : "DR",
      outstanding: R(Math.max(0, closingSigned)), lastInvoiceDate: sale?.date || null, dueDate, dueDays: dueDelta > 0 ? dueDelta : 0, overdueDays: dueDelta < 0 ? Math.abs(dueDelta) : 0,
      transactions: g.transactions,
    };
  });
}

const natureFallback = (code) => {
  const c = U(code);
  if (/SALES|DIRECT_INCOME|INDIRECT_INCOME/.test(c)) return "INCOME";
  if (/PURCHASE|DIRECT_EXPENSE|INDIRECT_EXPENSE/.test(c)) return "EXPENSE";
  if (/CAPITAL|RESERVES|SHARE_CAPITAL|PARTNER_CAPITAL|PROPRIETOR_CAPITAL/.test(c)) return "EQUITY";
  if (/CREDITORS|LIABILIT|LOAN|BANK_OD|DUTIES_TAXES|PROVISIONS|PAYABLE/.test(c)) return "LIABILITY";
  if (/DEBTORS|CASH|BANK_ACCOUNT|STOCK|ASSET|INVESTMENT|ADVANCE|DEPOSIT/.test(c)) return "ASSET";
  return "OTHER";
};

async function accountingRows({ tenantKey, financialYear, period, f }) {
  const [raw, templates, companyLedgers, customers, banks] = await Promise.all([
    read(f.LedgerEntry, { tenantKey, financialYear, status: "POSTED", date: { $gte: fyStartDate(financialYear), $lt: endExclusive(period.to) } }, { date: 1 }),
    read(AccountTemplate, {}, { systemCode: 1 }),
    read(CompanyLedger, { tenantKey, status: { $ne: "INACTIVE" } }, { name: 1 }),
    read(CustomerLink, { tenantKey }, { localName: 1 }),
    read(BankAccount, { tenantKey, status: "ACTIVE" }, { bankName: 1 }),
  ]);
  const { rows: entries } = await inspectBankLedgerRows({ tenantKey, financialYear, rows: raw });
  const tmap = new Map(templates.map((x) => [T(x.systemCode), x]));
  const openingByCode = new Map();
  const addOpening = (code, signed) => openingByCode.set(code, R(N(openingByCode.get(code)) + N(signed)));
  const ledgerOwnerKeys = new Set();
  for (const ledger of companyLedgers) {
    ledgerOwnerKeys.add(`${ledger.ownerType}|${ledger.ownerId}`);
    const op = (ledger.openingBalances || []).find((x) => T(x.financialYear) === T(financialYear));
    if (op) addOpening(ledger.systemAccountCode, signedOpening(op.amount, op.type));
  }
  for (const c of customers) {
    if (ledgerOwnerKeys.has(`CUSTOMER|${c.globalCustomerId}`)) continue;
    const ap = c.accountingProfile || {}; if (T(ap.financialYear) && T(ap.financialYear) !== T(financialYear)) continue;
    addOpening(ap.systemAccountCode || (U(c.partyType) === "CREDITOR" ? "SYS_SUNDRY_CREDITORS" : "SYS_SUNDRY_DEBTORS"), signedOpening(ap.openingBalance, ap.openingBalanceType));
  }
  for (const bank of banks) {
    if (bank.ledgerId && companyLedgers.some((l) => T(l.ledgerId) === T(bank.ledgerId))) continue;
    const op = (bank.openingBalances || []).find((x) => T(x.financialYear) === T(financialYear));
    if (op) addOpening("SYS_BANK_ACCOUNT", signedOpening(op.amount, op.type));
    else if (!bank.openingBalances?.length && (!bank.financialYear || T(bank.financialYear) === T(financialYear))) addOpening("SYS_BANK_ACCOUNT", signedOpening(bank.openingBalance, bank.openingBalanceType));
  }
  const map = new Map();
  for (const entry of entries) {
    const code = T(entry.accountCode) || "UNMAPPED";
    if (!map.has(code)) map.set(code, { accountCode: code, opening: N(openingByCode.get(code)), debit: 0, credit: 0 });
    const row = map.get(code); row.debit += N(entry.debit); row.credit += N(entry.credit);
  }
  for (const [code, opening] of openingByCode) if (!map.has(code)) map.set(code, { accountCode: code, opening, debit: 0, credit: 0 });
  return [...map.values()].map((row) => {
    const template = tmap.get(row.accountCode) || {};
    const signed = R(row.opening + row.debit - row.credit);
    return {
      accountCode: row.accountCode, accountName: template.name || row.accountCode,
      nature: template.nature || natureFallback(row.accountCode),
      openingSigned: R(row.opening), debit: R(row.debit), credit: R(row.credit), closingSigned: signed,
      closing: R(Math.abs(signed)), closingType: signed < 0 ? "CR" : "DR",
      trading: Boolean(template.reportMap?.trading), pnl: Boolean(template.reportMap?.pnl), balanceSheet: Boolean(template.reportMap?.balanceSheet),
    };
  });
}

async function profitAndLoss({ name, tenantKey, financialYear, period, f }) {
  const [sales, purchases, notes, stock, accounts] = await Promise.all([
    read(f.SalesInvoice, { tenantKey, financialYear, status: { $in: ["POSTED", "COMPLETED"] }, date: period.cutoff }),
    read(f.PurchaseInvoice, { tenantKey, financialYear, status: { $in: ["POSTED", "COMPLETED"] }, date: period.cutoff }),
    read(f.CreditNote, { tenantKey, financialYear, status: { $in: ["ISSUED", "RETURNED"] }, date: period.cutoff }),
    stockPosition({ tenantKey, financialYear, period, f }), accountingRows({ tenantKey, financialYear, period, f }),
  ]);
  const salesReturns = notes.filter((x) => x.documentType === "CREDIT_NOTE").reduce((s, x) => s + N(x.taxableTotal ?? x.subtotal), 0);
  const purchaseReturns = notes.filter((x) => x.documentType === "DEBIT_NOTE").reduce((s, x) => s + N(x.taxableTotal ?? x.subtotal), 0);
  const salesTotal = R(sales.reduce((s, x) => s + N(x.taxableTotal ?? x.subtotal), 0));
  const purchaseTotal = R(purchases.reduce((s, x) => s + N(x.taxableTotal ?? x.subtotal), 0));
  const openingStock = R(stock.rows.reduce((s, x) => s + N(x.openingValue), 0));
  const closingStock = R(stock.rows.reduce((s, x) => s + N(x.closingValue), 0));
  const netSales = R(salesTotal - salesReturns), netPurchases = R(purchaseTotal - purchaseReturns);
  const otherIncome = R(accounts.filter((x) => x.nature === "INCOME" && x.accountCode !== "SYS_SALES").reduce((s, x) => s + Math.max(0, N(x.credit) - N(x.debit)), 0));
  // Expense account movement is debit minus credit. SYS_PURCHASE is already included in netPurchases.
  const operatingExpenses = R(accounts.filter((x) => x.nature === "EXPENSE" && x.accountCode !== "SYS_PURCHASE").reduce((s, x) => s + Math.max(0, N(x.debit) - N(x.credit)), 0));
  const grossProfit = R(netSales + closingStock - openingStock - netPurchases);
  const netProfit = R(grossProfit + otherIncome - operatingExpenses);
  const rows = [
    { section: "TRADING", line: "Opening Stock", debit: openingStock, credit: 0 },
    { section: "TRADING", line: "Net Purchases", debit: netPurchases, credit: 0 },
    { section: "TRADING", line: "Net Sales", debit: 0, credit: netSales },
    { section: "TRADING", line: "Closing Stock", debit: 0, credit: closingStock },
    { section: "TRADING", line: grossProfit >= 0 ? "Gross Profit" : "Gross Loss", debit: grossProfit < 0 ? Math.abs(grossProfit) : 0, credit: grossProfit >= 0 ? grossProfit : 0 },
    { section: "P&L", line: "Other Income", debit: 0, credit: otherIncome },
    { section: "P&L", line: "Operating / Other Expenses", debit: operatingExpenses, credit: 0 },
    { section: "P&L", line: netProfit >= 0 ? "Net Profit" : "Net Loss", debit: netProfit < 0 ? Math.abs(netProfit) : 0, credit: netProfit >= 0 ? netProfit : 0 },
  ];
  return reportEnvelope({ name, financialYear, period, rows,
    summary: { sales: salesTotal, salesReturns: R(salesReturns), netSales, purchases: purchaseTotal, purchaseReturns: R(purchaseReturns), netPurchases, openingStock, closingStock, grossProfit, otherIncome, operatingExpenses, netProfit },
    source: "V2 posted Sales/Purchase/CN/DN + StockMovement/Product + posted ledger",
    note: "Old-DMS Trading/P&L structure rebuilt on V2. Historical stock value uses V2 opening/movements with the product's current landed/average rate when a historical valuation snapshot is unavailable.",
  });
}

async function balanceSheet({ name, tenantKey, financialYear, period, f }) {
  const [accounts, stock] = await Promise.all([accountingRows({ tenantKey, financialYear, period, f }), stockPosition({ tenantKey, financialYear, period, f })]);
  const hasStockAccount = accounts.some((x) => x.accountCode === "SYS_STOCK");
  const computedStock = R(stock.rows.reduce((s, x) => s + N(x.closingValue), 0));
  const rows = accounts.filter((x) => ["ASSET", "LIABILITY", "EQUITY"].includes(x.nature)).map((x) => {
    const signed = N(x.closingSigned);
    const asset = x.nature === "ASSET" ? Math.max(0, signed) : Math.max(0, -signed);
    const liability = x.nature === "ASSET" ? Math.max(0, -signed) : Math.max(0, -signed || 0);
    return { accountCode: x.accountCode, account: x.accountName, nature: x.nature,
      asset: R(x.nature === "ASSET" ? Math.max(0, signed) : 0),
      liabilityEquity: R(["LIABILITY", "EQUITY"].includes(x.nature) ? Math.max(0, -signed) : 0),
      balance: x.closing, balanceType: x.closingType };
  });
  if (!hasStockAccount && computedStock) rows.push({ accountCode: "SYS_STOCK_COMPUTED", account: "Closing Stock (computed)", nature: "ASSET", asset: computedStock, liabilityEquity: 0, balance: computedStock, balanceType: "DR" });
  const totalAssets = R(rows.reduce((s, x) => s + N(x.asset), 0)), totalLiabilitiesEquity = R(rows.reduce((s, x) => s + N(x.liabilityEquity), 0));
  return reportEnvelope({ name, financialYear, period, rows,
    summary: { totalAssets, totalLiabilitiesEquity, difference: R(totalAssets - totalLiabilitiesEquity), closingStock: computedStock },
    source: "V2 CompanyLedger/customer/bank opening balances + posted ledger movements + computed stock",
    note: "Balance Sheet is generated from V2 ledger mappings. Any non-zero difference flags an unmapped/opening-balance issue that should be reconciled rather than hidden.",
  });
}

async function generalReport(kind, { name, tenantKey, financialYear, period, f }) {
  if (kind === "admin") {
    const docs = await read(User, { tenantKey }, { name: 1 });
    const rows = docs.map((x) => ({ name: x.name, mobile: x.mobile || "", email: x.email || "", accountType: x.accountType || "", role: x.role || "", designation: x.designation || "", department: x.department || "", branchId: x.branchId || "", warehouseId: x.warehouseId || "", status: x.status || "" }));
    return reportEnvelope({ name, financialYear, period, rows, summary: { users: rows.length, active: rows.filter((x) => U(x.status) === "ACTIVE").length }, source: "V2 User master", note: "Current master report; FY/month does not hide master users." });
  }
  if (kind === "customers") {
    const docs = await read(CustomerLink, { tenantKey }, { localName: 1 });
    const rows = docs.map((x) => ({ customerId: x.globalCustomerId, customer: x.localName || x.displayIdentifier, gstin: x.displayIdentifier?.length === 15 ? x.displayIdentifier : "", partyType: x.partyType, registrationType: x.registrationType, paymentType: x.paymentType, creditDays: x.creditDays, creditLimit: R(x.creditLimit), salespersonId: x.salespersonId || "", territoryId: x.territoryId || "", transporterId: x.assignedTransportGlobalId || x.assignedTransport || "", city: x.addresses?.[0]?.city || x.ownerCity || "", state: x.addresses?.[0]?.state || x.ownerState || "", status: x.status }));
    return reportEnvelope({ name, financialYear, period, rows, summary: { customers: rows.length, active: rows.filter((x) => U(x.status) === "ACTIVE").length, totalCreditLimit: R(rows.reduce((s, x) => s + N(x.creditLimit), 0)) }, source: "V2 CustomerLink master", note: "Current customer master report." });
  }
  if (kind === "staff") {
    const docs = await read(Employee, { tenantKey }, { name: 1 });
    const rows = docs.map((x) => ({ employeeId: x.employeeId, name: x.name, department: x.department || "", designation: x.designation || "", team: x.team || "", branch: x.branch || "", warehouseId: x.warehouseId || "", territoryId: x.territoryId || "", reportsTo: x.reportsTo || "", employmentType: x.employmentType || "", joiningDate: x.joiningDate, status: x.status }));
    return reportEnvelope({ name, financialYear, period, rows, summary: { staff: rows.length, active: rows.filter((x) => U(x.status) === "ACTIVE").length }, source: "V2 Employee master", note: "Current staff master report." });
  }
  if (kind === "products") {
    const docs = await read(Product, { tenantKey }, { name: 1 });
    const rows = docs.map((x) => ({ sku: x.sku, product: x.name, category: x.category || "", subCategory: x.subCategory || "", hsn: x.hsnCode || "", gstRate: R(x.gstRate), unit: x.unit || x.basicUnit || "", warehouseId: x.warehouseId || "", openingStock: R(x.openingStock), currentStock: R(x.currentStock), reservedStock: R(x.reservedStock), availableStock: R(N(x.currentStock) - N(x.reservedStock)), averagePurchase: R(x.averagePurchasePrice), landedCost: R(x.landedCost), salePrice: R(x.salePrice), profitPct: R(x.profitPercentage), mrp: R(x.mrp), minStock: R(x.minStockAlert), status: x.status }));
    return reportEnvelope({ name, financialYear, period, rows, summary: { products: rows.length, stockQty: R(rows.reduce((s, x) => s + N(x.currentStock), 0)), stockValue: R(rows.reduce((s, x) => s + N(x.currentStock) * N(x.landedCost), 0)) }, source: "V2 Product master", note: "Current product/price/stock master report." });
  }
  if (kind === "promotion") {
    const docs = await read(GenericRecord, { tenantKey, $and: [{ $or: [{ resource: /promot|campaign|coupon|discount/i }, { app: /promot|marketing/i }] }, { $or: [{ date: period.cutoff }, { date: null, createdAt: period.cutoff }] }] }, { date: -1, createdAt: -1 });
    const rows = docs.map((x) => ({ date: x.date || x.createdAt, reference: x.reference || "", title: x.title, type: x.resource, status: x.status, amount: R(x.amount), quantity: R(x.quantity), assignedTo: x.assignedTo || "", notes: x.notes || "", ...(x.data || {}) }));
    return reportEnvelope({ name, financialYear, period, rows, summary: { activities: rows.length, amount: R(rows.reduce((s, x) => s + N(x.amount), 0)) }, source: "V2 GenericRecord promotion/campaign records", note: "Uses V2 promotion/campaign records where available." });
  }
  if (kind === "transactions") {
    const [sales, purchases, receipts, payments, expenses, notes] = await Promise.all([
      read(f.SalesInvoice, { tenantKey, financialYear, date: period.cutoff, status: { $in: ["POSTED", "COMPLETED"] } }),
      read(f.PurchaseInvoice, { tenantKey, financialYear, date: period.cutoff, status: { $in: ["POSTED", "COMPLETED"] } }),
      read(f.Receipt, { tenantKey, financialYear, date: period.cutoff, status: "POSTED" }),
      read(f.Payment, { tenantKey, financialYear, date: period.cutoff, status: "POSTED" }),
      read(f.Expense, { tenantKey, financialYear, date: period.cutoff, status: "POSTED" }),
      read(f.CreditNote, { tenantKey, financialYear, date: period.cutoff, status: { $in: ["ISSUED", "RETURNED"] } }),
    ]);
    const rows = [
      ...sales.map((x) => ({ date: x.date, type: "SALES_INVOICE", voucherNo: x.invoiceNo, party: x.customerNameSnapshot || x.customerGlobalId, debit: R(x.grandTotal), credit: 0, amount: R(x.grandTotal), status: x.status })),
      ...purchases.map((x) => ({ date: x.date, type: "PURCHASE_INVOICE", voucherNo: x.invoiceNo, party: x.supplierNameSnapshot || x.supplierGlobalId, debit: 0, credit: R(x.grandTotal), amount: R(x.grandTotal), status: x.status })),
      ...receipts.map((x) => ({ date: x.date, type: "RECEIPT", voucherNo: x.receiptNo, party: x.partyNameSnapshot || x.customerGlobalId, debit: 0, credit: R(x.amount), amount: R(x.amount), status: x.status })),
      ...payments.map((x) => ({ date: x.date, type: "PAYMENT", voucherNo: x.paymentNo, party: x.partyNameSnapshot || x.partyGlobalId, debit: R(x.amount), credit: 0, amount: R(x.amount), status: x.status })),
      ...expenses.map((x) => ({ date: x.date, type: "EXPENSE", voucherNo: x.expenseNo, party: x.accountCode, debit: R(x.amount), credit: 0, amount: R(x.amount), status: x.status })),
      ...notes.map((x) => ({ date: x.date, type: x.documentType, voucherNo: x.documentNo || x.creditNoteNo, party: x.partyNameSnapshot || x.customerNameSnapshot || x.partyGlobalId || x.customerGlobalId, debit: x.documentType === "DEBIT_NOTE" ? R(x.grandTotal) : 0, credit: x.documentType === "CREDIT_NOTE" ? R(x.grandTotal) : 0, amount: R(x.grandTotal), status: x.status })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));
    return reportEnvelope({ name, financialYear, period, rows, summary: { transactions: rows.length, totalAmount: R(rows.reduce((s, x) => s + N(x.amount), 0)), debit: R(rows.reduce((s, x) => s + N(x.debit), 0)), credit: R(rows.reduce((s, x) => s + N(x.credit), 0)) }, source: "V2 posted financial documents", note: "Document-level transaction register. Ledger balancing should be checked in Ledger/Trial Balance." });
  }
  return null;
}

export async function buildOldDmsReferenceReport({ name, tenantKey, financialYear, startDate = "", endDate = "" }) {
  const kind = oldDmsReferenceReportKind(name);
  if (!kind) return null;
  const period = reportPeriod(financialYear, startDate, endDate);
  const f = financialModels(tenantKey, financialYear);
  const args = { name, tenantKey, financialYear, startDate: period.from, endDate: period.to };

  if (kind.startsWith("gst-")) return gstReport(kind, { tenantKey, financialYear }, period, name);
  if (delegatedLegacyName[kind]) {
    const result = await buildLegacyReport({ ...args, name: delegatedLegacyName[kind] });
    return { ...result, name, implementation: "V2_OLD_DMS_REFERENCE", source: result.source || "V2 source records", note: [result.note, "Old DMS report behaviour used as reference; implementation is V2-native."].filter(Boolean).join(" ") };
  }

  if (["target-team", "target-all", "target-sales", "target-achieved", "target-pending"].includes(kind)) {
    let rows = await targetRows({ tenantKey, financialYear, period, f });
    if (kind === "target-team") rows = rows.filter((x) => ["USER", "MANAGER", "TERRITORY", "COMPANY"].includes(x.level));
    if (kind === "target-sales") rows = rows.filter((x) => N(x.targetSales) || N(x.actualSales));
    if (kind === "target-achieved") rows = rows.filter((x) => N(x.actualSales) > 0 || N(x.actualCollection) > 0 || N(x.actualVisits) > 0);
    if (kind === "target-pending") rows = rows.filter((x) => N(x.pendingSales) > 0 || N(x.pendingCollection) > 0 || N(x.pendingVisits) > 0);
    return reportEnvelope({ name, financialYear, period, rows,
      summary: { targets: rows.length, targetSales: R(rows.reduce((s, x) => s + N(x.targetSales), 0)), actualSales: R(rows.reduce((s, x) => s + N(x.actualSales), 0)), pendingSales: R(rows.reduce((s, x) => s + N(x.pendingSales), 0)), targetCollection: R(rows.reduce((s, x) => s + N(x.targetCollection), 0)), actualCollection: R(rows.reduce((s, x) => s + N(x.actualCollection), 0)) },
      source: "V2 Target + SalesInvoice + Receipt + CustomerVisit", note: "Targets are matched to V2 entities and actuals for the selected FY/month. Product/category collection is not artificially allocated." });
  }

  if (["stock-report", "stock-difference", "stock-closing", "warehouse-shortage", "warehouse-summary", "warehouse-stock"].includes(kind)) {
    const stock = await stockPosition({ tenantKey, financialYear, period, f });
    let rows = stock.rows, note = "Historical quantity is reconstructed from V2 opening stock plus FY StockMovement records.";
    if (kind === "stock-difference") {
      rows = rows.map((x) => ({ sku: x.sku, product: x.product, warehouse: x.warehouse, openingStock: x.openingQty, inward: x.inwardQty, outward: x.outwardQty, expectedClosing: x.expectedClosingQty, actualCurrent: x.actualCurrentQty, difference: x.differenceQty, damageOrUnexplained: x.differenceQty == null ? "HISTORICAL SNAPSHOT NOT STORED" : (x.differenceQty === 0 ? "MATCH" : "CHECK") }));
      note += " Physical difference is shown only when the selected period reaches the current date; V2 does not fabricate historical physical-count snapshots.";
    } else if (kind === "stock-closing") {
      const closing = await buildClosingStockRows({ tenantKey, financialYear, period, models: f });
      rows = closing.rows;
      note = closing.note;
      return reportEnvelope({
        name,
        financialYear,
        period,
        rows,
        summary: closing.summary,
        source: closing.source,
        note,
      });
    }
    else if (kind === "warehouse-shortage") rows = rows.filter((x) => N(x.minQty) > 0 && N(x.actualCurrentQty ?? x.expectedClosingQty) < N(x.minQty)).map((x) => ({ warehouse: x.warehouse, sku: x.sku, product: x.product, currentQty: x.actualCurrentQty ?? x.expectedClosingQty, minimumQty: x.minQty, shortageQty: R(Math.max(0, N(x.minQty) - N(x.actualCurrentQty ?? x.expectedClosingQty))) }));
    else if (kind === "warehouse-stock") rows = rows.map((x) => ({ warehouse: x.warehouse, sku: x.sku, product: x.product, currentQty: x.actualCurrentQty ?? x.expectedClosingQty, reservedQty: x.reservedQty, availableQty: x.availableQty, rate: x.rate, stockValue: R(N(x.actualCurrentQty ?? x.expectedClosingQty) * N(x.rate)) }));
    else if (kind === "warehouse-summary") rows = group(rows.map((x) => ({ warehouse: x.warehouse || "UNASSIGNED", products: 1, currentQty: N(x.actualCurrentQty ?? x.expectedClosingQty), availableQty: N(x.availableQty), stockValue: N(x.actualCurrentQty ?? x.expectedClosingQty) * N(x.rate) })), ["warehouse"], ["products", "currentQty", "availableQty", "stockValue"]);
    return reportEnvelope({ name, financialYear, period, rows, summary: { rows: rows.length, ...totals(rows, ["openingQty", "inwardQty", "outwardQty", "expectedClosingQty", "closingQty", "currentQty", "availableQty", "stockValue", "closingValue", "shortageQty"]) }, source: "V2 Product + StockMovement + Warehouse master", note });
  }

  if (["due", "overdue", "party-ledger", "locked-party", "party-ledger-detail"].includes(kind)) {
    if (kind === "locked-party") {
      const ledgers = await partyLedgerRows({ tenantKey, financialYear, period, f });
      const rows = ledgers.filter((x) => ["ON_HOLD", "BLOCKED", "INACTIVE", "DEACTIVATED"].includes(U(x.status)) || N(x.outstanding) > N(x.creditLimit) && N(x.creditLimit) > 0);
      return reportEnvelope({ name, financialYear, period, rows, summary: { parties: rows.length, outstanding: R(rows.reduce((s, x) => s + N(x.outstanding), 0)) }, source: "V2 CustomerLink + verified party ledger", note: "Includes explicitly locked parties and parties exceeding configured credit limit." });
    }
    if (kind === "party-ledger-detail") {
      const raw = await read(f.LedgerEntry, { tenantKey, financialYear, status: "POSTED", date: period.cutoff, partyGlobalId: { $nin: [null, ""] }, accountCode: { $in: ["SYS_SUNDRY_DEBTORS", "SYS_SUNDRY_CREDITORS"] } }, { date: 1, createdAt: 1 });
      const { rows: clean } = await inspectBankLedgerRows({ tenantKey, financialYear, rows: raw });
      const customers = await read(CustomerLink, { tenantKey }, { localName: 1 }); const cmap = new Map(customers.map((c) => [T(c.globalCustomerId), c.localName || c.displayIdentifier]));
      const rows = clean.map((x) => ({ date: x.date, partyId: x.partyGlobalId, party: cmap.get(T(x.partyGlobalId)) || x.partyGlobalId, voucherType: x.transactionType, voucherNo: x.transactionId, accountCode: x.accountCode, debit: R(x.debit), credit: R(x.credit), narration: x.narration || "" }));
      return reportEnvelope({ name, financialYear, period, rows, summary: { entries: rows.length, debit: R(rows.reduce((s, x) => s + N(x.debit), 0)), credit: R(rows.reduce((s, x) => s + N(x.credit), 0)) }, source: "Verified V2 LedgerEntry", note: "Duplicate/orphan bank-ledger rows are excluded by the ledger integrity checker." });
    }
    let rows = await partyLedgerRows({ tenantKey, financialYear, period, f });
    if (kind === "due") rows = rows.filter((x) => N(x.outstanding) > 0 && N(x.overdueDays) === 0);
    if (kind === "overdue") rows = rows.filter((x) => N(x.outstanding) > 0 && N(x.overdueDays) > 0);
    if (kind === "party-ledger") rows = rows.filter((x) => N(x.debit) || N(x.credit) || N(x.opening) || N(x.closing));
    return reportEnvelope({ name, financialYear, period, rows, summary: { parties: rows.length, outstanding: R(rows.reduce((s, x) => s + N(x.outstanding), 0)), debit: R(rows.reduce((s, x) => s + N(x.debit), 0)), credit: R(rows.reduce((s, x) => s + N(x.credit), 0)) }, source: "V2 CustomerLink + verified LedgerEntry + SalesInvoice", note: "Due/overdue uses current outstanding and the latest invoice date plus configured credit/grace days; it does not invent invoice-allocation data that V2 has not stored." });
  }

  if (["sales-return", "purchase-return"].includes(kind)) {
    const documentType = kind === "sales-return" ? "CREDIT_NOTE" : "DEBIT_NOTE";
    const notes = await read(f.CreditNote, { tenantKey, financialYear, documentType, status: { $in: ["ISSUED", "RETURNED"] }, date: period.cutoff });
    const isPhysicalReturn = (x) => Boolean(x.stockEffectApplied) || /RETURN|DAMAGE|DAMAGED|SHORT|REJECT|DEFECT/i.test(`${T(x.reasonType)} ${T(x.reason)}`);
    const returned = notes.filter(isPhysicalReturn);
    const rows = returned.map((x) => ({ date: x.date, documentNo: x.documentNo || x.creditNoteNo, againstInvoice: x.invoiceNo || x.referenceDocumentNo || "", party: x.partyNameSnapshot || x.customerNameSnapshot || x.partyGlobalId || x.customerGlobalId, reason: x.reason || x.reasonType || "", qty: R((x.items || []).reduce((s, it) => s + N(it.qty), 0)), taxable: R(x.taxableTotal ?? x.subtotal), gst: R(x.taxTotal), amount: R(x.grandTotal), stockEffectApplied: Boolean(x.stockEffectApplied), status: x.status }));
    return reportEnvelope({ name, financialYear, period, rows, summary: { returns: rows.length, ...totals(rows, ["qty", "taxable", "gst", "amount"]) }, source: `V2 ${documentType} records`, note: "Return report excludes non-stock incentive/charge notes unless the note is explicitly marked as a return/damage/shortage/rejection." });
  }

  if (kind === "tax") {
    const [sales, purchases, notes] = await Promise.all([
      read(f.SalesInvoice, { tenantKey, financialYear, status: { $in: ["POSTED", "COMPLETED"] }, date: period.cutoff }),
      read(f.PurchaseInvoice, { tenantKey, financialYear, status: { $in: ["POSTED", "COMPLETED"] }, date: period.cutoff }),
      read(f.CreditNote, { tenantKey, financialYear, status: { $in: ["ISSUED", "RETURNED"] }, date: period.cutoff }),
    ]);
    const salesTax = R(sales.reduce((s, x) => s + N(x.taxTotal), 0));
    const purchaseTax = R(purchases.reduce((s, x) => s + N(x.taxTotal), 0));
    const salesReturnTax = R(notes.filter((x) => x.documentType === "CREDIT_NOTE").reduce((s, x) => s + N(x.taxTotal), 0));
    const purchaseReturnTax = R(notes.filter((x) => x.documentType === "DEBIT_NOTE").reduce((s, x) => s + N(x.taxTotal), 0));
    const totalTaxInput = R(purchaseTax - purchaseReturnTax);
    const totalTaxOutput = R(salesTax - salesReturnTax);
    const netInputCredit = R(totalTaxInput - totalTaxOutput);
    const rows = [{ purchaseGST: purchaseTax, lessPurchaseReturnGST: purchaseReturnTax, totalTaxInput, salesGST: salesTax, lessSalesReturnGST: salesReturnTax, totalTaxOutput, netInputCredit, netTaxPayable: R(Math.max(0, -netInputCredit)) }];
    return reportEnvelope({ name, financialYear, period, rows, summary: rows[0], source: "V2 posted Sales/Purchase invoices + issued CN/DN", note: "V2-correct GST logic: purchase returns reduce input tax and sales returns reduce output tax. Positive netInputCredit is available credit; negative value becomes tax payable." });
  }
  if (kind === "pnl") return profitAndLoss({ name, tenantKey, financialYear, period, f });
  if (kind === "balance-sheet") return balanceSheet({ name, tenantKey, financialYear, period, f });

  if (kind === "earnings") {
    const pnl = await profitAndLoss({ name, tenantKey, financialYear, period, f });
    const s = pnl.summary;
    const rows = [{ period: `${period.from} to ${period.to}`, netSales: s.netSales, netPurchases: s.netPurchases, grossProfit: s.grossProfit, otherIncome: s.otherIncome, operatingExpenses: s.operatingExpenses, netEarning: s.netProfit, earningPct: s.netSales ? R(s.netProfit / s.netSales * 100) : 0 }];
    return reportEnvelope({ name, financialYear, period, rows, summary: rows[0], source: pnl.source, note: "Earning report is derived from the same V2-native Trading/P&L calculation so totals reconcile." });
  }

  const general = await generalReport(kind, { name, tenantKey, financialYear, period, f });
  if (general) return general;

  throw Object.assign(new Error(`Report ${name} is listed but has no V2 mapping`), { statusCode: 422 });
}
