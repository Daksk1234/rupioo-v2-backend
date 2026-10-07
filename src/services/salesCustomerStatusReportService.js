import { financialModels } from "./accountingService.js";
import { CompanyLedger, CompanyProfile, CustomerLink, User } from "../models/index.js";

const DAY = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 15 * 1000;
const reportCache = new Map();

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();

function fyStart(fy) {
  const value = Number(String(fy || "").slice(0, 4));
  return Number.isFinite(value) ? value : 0;
}

function fyLabel(start) {
  return `${start}-${String(start + 1).slice(-2)}`;
}

function currentFy(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return fyLabel(month >= 4 ? year : year - 1);
}

function currentDateOnly(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfFinancialYear(fy) {
  const start = fyStart(fy);
  return start ? new Date(Date.UTC(start, 3, 1, 0, 0, 0, 0)) : new Date(0);
}

function signedOpening(amount, type) {
  const value = Math.abs(Number(amount || 0));
  return upper(type) === "CR" ? -value : value;
}

function customerDistrict(customer) {
  const addresses = Array.isArray(customer?.addresses) ? customer.addresses : [];
  const preferred = addresses.find((x) => ["BILLING", "BUSINESS"].includes(upper(x?.type)))
    || addresses.find((x) => clean(x?.district))
    || addresses[0];
  return clean(preferred?.district || customer?.ownerDistrict) || "UNASSIGNED DISTRICT";
}

function customerMobile(customer) {
  const contacts = Array.isArray(customer?.contacts) ? customer.contacts : [];
  return clean(
    contacts.find((x) => x?.primary && clean(x?.mobile))?.mobile
    || contacts.find((x) => clean(x?.mobile))?.mobile
    || customer?.companyContactNumber
    || customer?.ownerMobile,
  );
}

function looksLikeGstin(value) {
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/i.test(clean(value));
}

function registrationType(customer) {
  if (upper(customer?.localName) === "CASH") return "UNREGISTER";
  const configured = upper(customer?.registrationType);
  if (configured.includes("UNREG")) return "UNREGISTER";
  if (configured.includes("REGULAR") || configured === "REGISTERED") return "REGULAR";
  return looksLikeGstin(customer?.displayIdentifier) ? "REGULAR" : "UNREGISTER";
}

function gstinOf(customer) {
  return looksLikeGstin(customer?.displayIdentifier) ? upper(customer.displayIdentifier) : "";
}

function isSalesCustomer(customer) {
  const type = upper(customer?.partyType);
  return !["CREDITOR", "SUPPLIER"].includes(type);
}

function openingCandidates(customer, companyLedgers = []) {
  const candidates = [];
  for (const ledger of companyLedgers || []) {
    for (const row of ledger.openingBalances || []) {
      const start = fyStart(row.financialYear);
      if (start) {
        candidates.push({
          financialYear: fyLabel(start),
          start,
          signed: signedOpening(row.amount, row.type),
          source: "COMPANY_LEDGER",
        });
      }
    }
  }
  const profile = customer?.accountingProfile || {};
  const profileStart = fyStart(profile.financialYear);
  if (Number(profile.openingBalance || 0) || profileStart) {
    candidates.push({
      financialYear: profileStart ? fyLabel(profileStart) : "",
      start: profileStart,
      signed: signedOpening(profile.openingBalance, profile.openingBalanceType),
      source: "CUSTOMER_MASTER",
    });
  }
  return candidates;
}

function latestOpening(customer, ledgers, currentFinancialYear) {
  const currentStart = fyStart(currentFinancialYear);
  const candidates = openingCandidates(customer, ledgers)
    .filter((row) => row.start > 0 && row.start <= currentStart)
    .sort((a, b) => b.start - a.start || (a.source === "COMPANY_LEDGER" ? -1 : 1));
  return candidates[0] || null;
}

function normalizeYearList(profile, currentFinancialYear, ledgers = []) {
  const years = new Set();
  const add = (value) => {
    const start = fyStart(value);
    if (start >= 2000 && start <= fyStart(currentFinancialYear)) years.add(fyLabel(start));
  };
  add(currentFinancialYear);
  add(profile?.financialYear);
  for (const fy of Array.isArray(profile?.financialYears) ? profile.financialYears : []) add(fy);
  for (const ledger of ledgers) {
    for (const row of ledger.openingBalances || []) add(row.financialYear);
  }
  return [...years].sort((a, b) => fyStart(a) - fyStart(b));
}

function cacheGet(key) {
  const hit = reportCache.get(key);
  if (!hit || hit.expiresAt <= Date.now()) {
    reportCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  reportCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (reportCache.size > 100) {
    for (const [k, item] of reportCache.entries()) {
      if (item.expiresAt <= Date.now()) reportCache.delete(k);
    }
  }
}

function applyDebit(state, amount, date) {
  let value = Math.max(0, Number(amount || 0));
  if (!value) return;
  state.totalDebit += value;
  if (state.creditCarry > 0) {
    const used = Math.min(state.creditCarry, value);
    state.creditCarry -= used;
    value -= used;
  }
  if (value > 0) state.debitLots.push({ amount: value, date: new Date(date || 0) });
}

function applyCredit(state, amount) {
  let value = Math.max(0, Number(amount || 0));
  if (!value) return;
  state.totalCredit += value;
  while (value > 0.000001 && state.debitLots.length) {
    const lot = state.debitLots[0];
    const used = Math.min(lot.amount, value);
    lot.amount -= used;
    value -= used;
    if (lot.amount <= 0.000001) state.debitLots.shift();
  }
  if (value > 0) state.creditCarry += value;
}

function makeLedgerState(openingSigned, openingDate) {
  const state = { totalDebit: 0, totalCredit: 0, debitLots: [], creditCarry: 0 };
  if (openingSigned > 0) applyDebit(state, openingSigned, openingDate);
  else if (openingSigned < 0) applyCredit(state, Math.abs(openingSigned));
  return state;
}

async function masterContext(tenantKey, now = new Date()) {
  const financialYear = currentFy(now);
  const [allCustomers, customerLedgers, users, company] = await Promise.all([
    CustomerLink.find({ tenantKey })
      .select("globalCustomerId localName displayIdentifier registrationType partyType paymentType creditDays creditLimit approvedTerms accountingProfile salespersonId contacts addresses companyContactNumber ownerMobile ownerDistrict")
      .sort({ localName: 1, displayIdentifier: 1 })
      .lean(),
    CompanyLedger.find({
      tenantKey,
      ownerType: "CUSTOMER",
      status: { $ne: "INACTIVE" },
      systemAccountCode: "SYS_SUNDRY_DEBTORS",
    }).select("ownerId openingBalances").lean(),
    User.find({ tenantKey }).select("_id name status").lean(),
    CompanyProfile.findOne({ tenantKey }).select("financialYear financialYears").lean(),
  ]);

  const customers = allCustomers.filter(isSalesCustomer);
  const ledgersByCustomer = new Map();
  for (const ledger of customerLedgers) {
    const key = clean(ledger.ownerId);
    if (!ledgersByCustomer.has(key)) ledgersByCustomer.set(key, []);
    ledgersByCustomer.get(key).push(ledger);
  }
  const userMap = new Map(users.map((user) => [clean(user._id), clean(user.name) || "UNASSIGNED"]));
  const availableYears = normalizeYearList(company, financialYear, customerLedgers);
  const earliestAvailableStart = fyStart(availableYears[0] || financialYear);
  const baseByCustomer = new Map();

  for (const customer of customers) {
    const id = clean(customer.globalCustomerId);
    const opening = latestOpening(customer, ledgersByCustomer.get(id) || [], financialYear);
    baseByCustomer.set(id, opening || {
      financialYear: fyLabel(earliestAvailableStart),
      start: earliestAvailableStart,
      signed: 0,
      source: "ZERO",
    });
  }

  return { financialYear, customers, userMap, baseByCustomer, availableYears };
}

async function debtorLedgerRowsForYear({ tenantKey, financialYear, customerIds, throughExclusive }) {
  const { LedgerEntry } = financialModels(tenantKey, financialYear);
  return LedgerEntry.find({
    tenantKey,
    financialYear,
    status: "POSTED",
    accountCode: "SYS_SUNDRY_DEBTORS",
    partyGlobalId: { $in: customerIds },
    ...(throughExclusive ? { date: { $lt: throughExclusive } } : {}),
  })
    .select("partyGlobalId date debit credit createdAt")
    .sort({ date: 1, createdAt: 1 })
    .lean();
}

function metaFromRows(rows) {
  const parties = rows.map((row) => ({ id: row.partyId, name: row.partyName })).sort((a, b) => a.name.localeCompare(b.name));
  const salespersonMap = new Map();
  const districts = new Set();
  rows.forEach((row) => {
    if (row.salespersonId) salespersonMap.set(row.salespersonId, row.salespersonName || "UNASSIGNED");
    if (row.district) districts.add(row.district);
  });
  return {
    parties,
    salespersons: [...salespersonMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    districts: [...districts].sort((a, b) => a.localeCompare(b)),
  };
}

function filterCommon(rows, filters = {}) {
  const status = upper(filters.status);
  const partyId = clean(filters.partyId);
  const salespersonId = clean(filters.salespersonId);
  const district = upper(filters.district);
  const search = upper(filters.search);
  return rows.filter((row) => {
    if (status && upper(row.status) !== status) return false;
    if (partyId && row.partyId !== partyId) return false;
    if (salespersonId && row.salespersonId !== salespersonId) return false;
    if (district && upper(row.district) !== district) return false;
    if (search && !upper(`${row.partyName} ${row.gstin} ${row.mobile} ${row.salespersonName} ${row.district}`).includes(search)) return false;
    return true;
  });
}

async function buildLockBase(tenantKey) {
  const now = currentDateOnly(new Date());
  const context = await masterContext(tenantKey, now);
  const throughExclusive = new Date(now.getTime() + DAY);
  const customerIds = context.customers.map((customer) => clean(customer.globalCustomerId)).filter(Boolean);
  const states = new Map();

  for (const customer of context.customers) {
    const id = clean(customer.globalCustomerId);
    const base = context.baseByCustomer.get(id);
    states.set(id, {
      customer,
      effectiveStart: base.start,
      ledger: makeLedgerState(base.signed, startOfFinancialYear(base.financialYear)),
    });
  }

  // Only actual company FY databases are queried, and they are queried in parallel.
  const years = context.availableYears.filter((fy) => fyStart(fy) <= fyStart(context.financialYear));
  const yearRows = await Promise.all(years.map(async (financialYear) => ({
    financialYear,
    rows: await debtorLedgerRowsForYear({ tenantKey, financialYear, customerIds, throughExclusive }),
  })));

  yearRows.sort((a, b) => fyStart(a.financialYear) - fyStart(b.financialYear));
  for (const block of yearRows) {
    const yearStart = fyStart(block.financialYear);
    for (const event of block.rows) {
      const holder = states.get(clean(event.partyGlobalId));
      if (!holder || yearStart < holder.effectiveStart) continue;
      if (Number(event.debit || 0) > 0) applyDebit(holder.ledger, event.debit, event.date || event.createdAt);
      if (Number(event.credit || 0) > 0) applyCredit(holder.ledger, event.credit);
    }
  }

  const rows = [];
  for (const [partyId, holder] of states.entries()) {
    const customer = holder.customer;
    const ledger = holder.ledger;
    const signedBalance = money(ledger.totalDebit - ledger.totalCredit);
    const balanceType = signedBalance > 0.005 ? "DR" : signedBalance < -0.005 ? "CR" : "";
    const balance = money(Math.abs(signedBalance));
    const oldestDebit = ledger.debitLots.find((lot) => lot.amount > 0.005)?.date || null;
    const dueDays = signedBalance > 0.005 && oldestDebit
      ? Math.max(0, Math.floor((now.getTime() - new Date(oldestDebit).getTime()) / DAY))
      : 0;
    const creditLimit = money(customer?.approvedTerms?.creditLimit ?? customer?.creditLimit ?? 0);
    const creditPeriod = Math.max(0, Number(customer?.approvedTerms?.creditDays ?? customer?.creditDays ?? 0));
    const periodBreached = signedBalance > 0.005 && dueDays > creditPeriod;
    const limitBreached = signedBalance > 0.005 && creditLimit > 0 && signedBalance > creditLimit;
    const locked = signedBalance > 0.005 && (periodBreached || limitBreached);
    const salespersonId = upper(customer?.localName) === "CASH" ? "" : clean(customer?.salespersonId);

    rows.push({
      partyId,
      partyName: clean(customer?.localName || customer?.displayIdentifier || partyId) || "PARTY",
      gstin: gstinOf(customer),
      registrationType: registrationType(customer),
      paymentType: upper(customer?.paymentType) || "CASH",
      salespersonId,
      salespersonName: salespersonId ? (context.userMap.get(salespersonId) || "UNASSIGNED") : "UNASSIGNED",
      district: customerDistrict(customer),
      creditLimit,
      creditPeriod,
      dueDays,
      status: locked ? "LOCKED" : "ACTIVE",
      debit: money(ledger.totalDebit),
      credit: money(ledger.totalCredit),
      balance,
      balanceType,
      oldestUnpaidDate: oldestDebit,
      limitBreached,
      periodBreached,
    });
  }

  return { rows, meta: metaFromRows(rows), generatedAt: new Date(), balanceAsOf: now };
}

export async function buildLockPartyReport({ tenantKey, refresh = false, ...filters }) {
  const cacheKey = `LOCK|${tenantKey}`;
  let base = refresh ? null : cacheGet(cacheKey);
  if (!base) {
    base = await buildLockBase(tenantKey);
    cacheSet(cacheKey, base);
  }

  let filtered = filterCommon(base.rows, filters);
  const paymentType = upper(filters.paymentType);
  const dueBucket = upper(filters.dueBucket);
  if (paymentType) filtered = filtered.filter((row) => upper(row.paymentType) === paymentType);
  if (dueBucket === "DUE") filtered = filtered.filter((row) => row.dueDays > 0);
  if (dueBucket === "1_30") filtered = filtered.filter((row) => row.dueDays >= 1 && row.dueDays <= 30);
  if (dueBucket === "31_60") filtered = filtered.filter((row) => row.dueDays >= 31 && row.dueDays <= 60);
  if (dueBucket === "61_90") filtered = filtered.filter((row) => row.dueDays >= 61 && row.dueDays <= 90);
  if (dueBucket === "90_PLUS") filtered = filtered.filter((row) => row.dueDays > 90);
  filtered.sort((a, b) => (a.status === b.status ? b.dueDays - a.dueDays : a.status === "LOCKED" ? -1 : 1) || a.partyName.localeCompare(b.partyName));

  return {
    generatedAt: base.generatedAt,
    balanceAsOf: base.balanceAsOf,
    rows: filtered,
    ...base.meta,
    totals: {
      customers: filtered.length,
      locked: filtered.filter((row) => row.status === "LOCKED").length,
      active: filtered.filter((row) => row.status === "ACTIVE").length,
      debit: money(filtered.reduce((sum, row) => sum + Number(row.debit || 0), 0)),
      credit: money(filtered.reduce((sum, row) => sum + Number(row.credit || 0), 0)),
      debitBalance: money(filtered.filter((row) => row.balanceType === "DR").reduce((sum, row) => sum + Number(row.balance || 0), 0)),
      creditBalance: money(filtered.filter((row) => row.balanceType === "CR").reduce((sum, row) => sum + Number(row.balance || 0), 0)),
    },
  };
}

function threeMonthCutoff(now) {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - 3);
  return date;
}

async function salesHistoryAggregate({ tenantKey, financialYear, throughExclusive, cutoff }) {
  const { SalesInvoice } = financialModels(tenantKey, financialYear);
  const rows = await SalesInvoice.aggregate([
    {
      $match: {
        tenantKey,
        financialYear,
        status: { $in: ["POSTED", "COMPLETED"] },
        customerGlobalId: { $nin: [null, ""] },
        date: { $lt: throughExclusive },
      },
    },
    { $sort: { customerGlobalId: 1, date: 1, createdAt: 1 } },
    {
      $group: {
        _id: "$customerGlobalId",
        lastPurchaseDate: { $last: "$date" },
        lastCreatedAt: { $last: "$createdAt" },
        lastInvoiceNo: { $last: "$invoiceNo" },
        lastInvoiceAmount: { $last: "$grandTotal" },
        recentInvoices: {
          $sum: { $cond: [{ $gte: ["$date", cutoff] }, 1, 0] },
        },
        recentSales: {
          $sum: { $cond: [{ $gte: ["$date", cutoff] }, "$grandTotal", 0] },
        },
      },
    },
  ]).allowDiskUse(true);
  return rows;
}

async function buildDeadBase(tenantKey) {
  const now = currentDateOnly(new Date());
  const context = await masterContext(tenantKey, now);
  const throughExclusive = new Date(now.getTime() + DAY);
  const cutoff = threeMonthCutoff(now);

  // Query each real company FY once, in parallel, with server-side aggregation.
  const historyBlocks = await Promise.all(context.availableYears.map(async (financialYear) => ({
    financialYear,
    rows: await salesHistoryAggregate({ tenantKey, financialYear, throughExclusive, cutoff }),
  })));

  const history = new Map();
  for (const block of historyBlocks) {
    for (const item of block.rows) {
      const partyId = clean(item._id);
      const existing = history.get(partyId);
      const itemDate = new Date(item.lastPurchaseDate || item.lastCreatedAt || 0);
      const existingDate = new Date(existing?.lastPurchaseDate || existing?.lastCreatedAt || 0);
      if (!existing || itemDate > existingDate) {
        history.set(partyId, {
          ...existing,
          lastPurchaseDate: item.lastPurchaseDate || item.lastCreatedAt || null,
          lastCreatedAt: item.lastCreatedAt || null,
          lastInvoiceNo: clean(item.lastInvoiceNo),
          lastInvoiceAmount: money(item.lastInvoiceAmount),
          recentInvoices: Number(existing?.recentInvoices || 0) + Number(item.recentInvoices || 0),
          recentSales: money(Number(existing?.recentSales || 0) + Number(item.recentSales || 0)),
        });
      } else {
        existing.recentInvoices = Number(existing.recentInvoices || 0) + Number(item.recentInvoices || 0);
        existing.recentSales = money(Number(existing.recentSales || 0) + Number(item.recentSales || 0));
      }
    }
  }

  const rows = context.customers.map((customer) => {
    const partyId = clean(customer.globalCustomerId);
    const sale = history.get(partyId) || {};
    const saleDate = sale.lastPurchaseDate ? new Date(sale.lastPurchaseDate) : null;
    const daysSincePurchase = saleDate && !Number.isNaN(saleDate.getTime())
      ? Math.max(0, Math.floor((now.getTime() - saleDate.getTime()) / DAY))
      : null;
    const status = saleDate && saleDate >= cutoff ? "ACTIVE" : "DEAD";
    const salespersonId = upper(customer?.localName) === "CASH" ? "" : clean(customer?.salespersonId);
    return {
      partyId,
      partyName: clean(customer.localName || customer.displayIdentifier || partyId) || "PARTY",
      gstin: gstinOf(customer),
      registrationType: registrationType(customer),
      salespersonId,
      salespersonName: salespersonId ? (context.userMap.get(salespersonId) || "UNASSIGNED") : "UNASSIGNED",
      district: customerDistrict(customer),
      mobile: customerMobile(customer),
      lastPurchaseDate: saleDate,
      daysSincePurchase,
      lastInvoiceNo: clean(sale.lastInvoiceNo),
      lastInvoiceAmount: money(sale.lastInvoiceAmount),
      last3MonthInvoices: Number(sale.recentInvoices || 0),
      last3MonthSales: money(sale.recentSales),
      status,
    };
  });

  return { rows, meta: metaFromRows(rows), generatedAt: new Date(), cutoffDate: cutoff };
}

export async function buildDeadPartyReport({ tenantKey, refresh = false, ...filters }) {
  const cacheKey = `DEAD|${tenantKey}`;
  let base = refresh ? null : cacheGet(cacheKey);
  if (!base) {
    base = await buildDeadBase(tenantKey);
    cacheSet(cacheKey, base);
  }

  let filtered = filterCommon(base.rows, filters);
  const partyType = upper(filters.partyType);
  if (partyType) filtered = filtered.filter((row) => row.registrationType === partyType);
  filtered.sort((a, b) => {
    if (a.status !== b.status) return a.status === "DEAD" ? -1 : 1;
    if (a.daysSincePurchase == null && b.daysSincePurchase != null) return -1;
    if (a.daysSincePurchase != null && b.daysSincePurchase == null) return 1;
    return Number(b.daysSincePurchase || 0) - Number(a.daysSincePurchase || 0) || a.partyName.localeCompare(b.partyName);
  });

  return {
    generatedAt: base.generatedAt,
    cutoffDate: base.cutoffDate,
    rows: filtered,
    ...base.meta,
    totals: {
      customers: filtered.length,
      dead: filtered.filter((row) => row.status === "DEAD").length,
      active: filtered.filter((row) => row.status === "ACTIVE").length,
      last3MonthInvoices: filtered.reduce((sum, row) => sum + Number(row.last3MonthInvoices || 0), 0),
      last3MonthSales: money(filtered.reduce((sum, row) => sum + Number(row.last3MonthSales || 0), 0)),
    },
  };
}
