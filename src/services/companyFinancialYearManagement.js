/**
 * Company FY configuration. Deletion is permitted only when no FY database
 * documents or meaningful opening/transaction records exist. Never drop the
 * shared main database: FY databases use the physical tenant's own prefix.
 */
import mongoose from 'mongoose';
import { BankAccount, CompanyLedger, CustomerLink, User, Product } from '../models/index.js';
import { getFinancialYearDbName } from '../config/db.js';
import { ensureFinancialStorageTenantKey } from './financialStorageTenantService.js';
import { normalizeYears, validFY, invalidateFinancialYearDiscovery, discoverFinancialYears } from './financialYearDiscoveryService.js';

const clean = value => String(value ?? '').trim();
const nonzero = value => Number(value || 0) !== 0;
const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const fields = year => ({ $or: [
  { financialYear: year }, { openingFinancialYear: year },
  { 'openingBalances.financialYear': year },
  { 'accountingProfile.financialYear': year },
  { 'data.financialYear': year }, { 'data.openingFinancialYear': year },
] });

async function databaseState(tenantKey, year) {
  const physical = await ensureFinancialStorageTenantKey(tenantKey);
  const databaseName = getFinancialYearDbName(physical, year);
  const db = mongoose.connection.getClient().db(databaseName);
  // listCollections does not create the database. An inaccessible database
  // fails closed instead of being accidentally deleted.
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();
  for (const { name, type } of collections) {
    if (type === 'view') throw failure(`Cannot remove ${year}: a database view named ${name} exists`);
    if (await db.collection(name).findOne({}, { projection: { _id: 1 } })) {
      throw failure(`Cannot remove ${year}: MongoDB database ${databaseName} contains records in ${name}. Delete/migrate the records first.`);
    }
  }
  return { db, databaseName, exists: collections.length > 0 };
}

async function assertNoMainData(tenantKey, year, { firstCashFinancialYear, firstCashOpeningBalance } = {}) {
  if (firstCashFinancialYear === year && nonzero(firstCashOpeningBalance)) {
    throw failure(`Cannot remove ${year}: the company has a cash opening balance in that financial year.`);
  }
  const [ledgers, banks, users, customers, products] = await Promise.all([
    CompanyLedger.find({ tenantKey, 'openingBalances.financialYear': year }).select('openingBalances').lean(),
    BankAccount.find({ tenantKey, $or: [{ financialYear: year }, { 'openingBalances.financialYear': year }] }).select('financialYear openingBalance openingBalances').lean(),
    User.find({ tenantKey, openingFinancialYear: year }).select('openingBalance').lean(),
    CustomerLink.find({ tenantKey, 'accountingProfile.financialYear': year }).select('accountingProfile').lean(),
    Product.find({ tenantKey, $or: [{ openingFinancialYear: year }, { financialYear: year },
      { [`openingStockByFY.${year}`]: { $exists: true } }, { [`openingStocks.${year}`]: { $exists: true } },
      { [`financialYearOpenings.${year}`]: { $exists: true } }] })
      .select('openingFinancialYear financialYear financialYearOpeningStock financialYearOpeningRate openingStock openingRate openingStockByFY openingStocks financialYearOpenings').lean(),
  ]);
  if (ledgers.some(row => (row.openingBalances || []).some(b => b.financialYear === year && nonzero(b.amount))))
    throw failure(`Cannot remove ${year}: company or party ledger opening balances exist.`);
  if (banks.some(row => (row.financialYear === year && nonzero(row.openingBalance)) ||
    (row.openingBalances || []).some(b => b.financialYear === year && nonzero(b.amount))))
    throw failure(`Cannot remove ${year}: bank opening balances exist.`);
  if (users.some(row => nonzero(row.openingBalance))) throw failure(`Cannot remove ${year}: user opening balances exist.`);
  if (customers.some(row => nonzero(row.accountingProfile?.openingBalance)))
    throw failure(`Cannot remove ${year}: customer opening balances exist.`);
  if (products.some(row =>
    ['openingStockByFY', 'openingStocks', 'financialYearOpenings'].some(field => Object.prototype.hasOwnProperty.call(row[field] || {}, year)) ||
    (row.openingFinancialYear === year && [row.financialYearOpeningStock, row.financialYearOpeningRate, row.openingStock, row.openingRate].some(nonzero))))
    throw failure(`Cannot remove ${year}: product opening stock or opening rate records exist.`);

  // Other business collections may contain FY-scoped records in the shared
  // database (including newer features). Do not silently omit those records.
  const managed = new Set([
    'companyprofiles', 'companyledgers', 'bankaccounts', 'users', 'customerlinks', 'products',
  ]);
  const mainDb = mongoose.connection.db;
  const collections = await mainDb.listCollections({}, { nameOnly: true }).toArray();
  for (const { name, type } of collections) {
    if (type === 'view' || managed.has(name)) continue;
    if (await mainDb.collection(name).findOne({ tenantKey, ...fields(year) }, { projection: { _id: 1 } })) {
      throw failure(`Cannot remove ${year}: ${name} contains linked financial-year records.`);
    }
  }
}

/** Validate only; no writes. Called before either Profile or Master save. */
export async function prepareFinancialYears({ company, body }) {
  if (!Array.isArray(body.financialYears) && body.financialYear === undefined && body.firstFinancialYear === undefined) return null;
  const discovered = await discoverFinancialYears({ tenantKey: company.tenantKey, configured: company.financialYears || [] });
  const oldYears = normalizeYears([...(company.financialYears || []), company.financialYear, ...discovered.discovered]);
  const input = Array.isArray(body.financialYears) ? body.financialYears.map(clean) : oldYears;
  if (input.some(year => !validFY(year))) throw failure('Use valid Financial Years in YYYY-YY format (e.g. 2026-27).', 400);
  const years = normalizeYears(input);
  if (!years.length) throw failure('At least one financial year must remain enabled.', 400);
  const defaultYear = clean(body.financialYear ?? company.financialYear) || years[0];
  if (!years.includes(defaultYear)) throw failure('Default FY must be an enabled financial year.', 400);
  const firstYear = clean(body.firstFinancialYear ?? company.firstFinancialYear) || years[0];
  if (!years.includes(firstYear)) throw failure('Select First FY from the enabled financial years.', 400);
  const removed = oldYears.filter(year => !years.includes(year));
  for (const year of removed) {
    await assertNoMainData(company.tenantKey, year, company);
    await databaseState(company.tenantKey, year);
  }
  return { years, defaultYear, firstYear, removed, tenantKey: company.tenantKey };
}

/** Final recheck and deletion. Call AFTER the company settings have saved. */
export async function removeEmptyFinancialYearDatabases(plan, company) {
  if (!plan?.removed?.length) return [];
  const removedDatabases = [];
  for (const year of plan.removed) {
    await assertNoMainData(company.tenantKey, year, company);
    const { db, databaseName, exists } = await databaseState(company.tenantKey, year);
    if (exists) {
      await db.dropDatabase();
      removedDatabases.push(databaseName);
    }
  }
  // Zero-value opening rows are metadata only. Remove these stale references
  // so discovery cannot re-add an empty/deleted financial year to the UI.
  const tenantKey = company.tenantKey, removed = plan.removed;
  await Promise.all([
    CompanyLedger.updateMany({ tenantKey }, { $pull: { openingBalances: { financialYear: { $in: removed }, amount: { $in: [0, null] } } } }),
    BankAccount.updateMany({ tenantKey }, { $pull: { openingBalances: { financialYear: { $in: removed }, amount: { $in: [0, null] } } } }),
    User.updateMany({ tenantKey, openingFinancialYear: { $in: removed }, openingBalance: { $in: [0, null] } }, { $set: { openingFinancialYear: '' } }),
    CustomerLink.updateMany({ tenantKey, 'accountingProfile.financialYear': { $in: removed }, 'accountingProfile.openingBalance': { $in: [0, null] } },
      { $set: { 'accountingProfile.financialYear': '' } }),
    BankAccount.updateMany({ tenantKey, financialYear: { $in: removed }, openingBalance: { $in: [0, null] } }, { $set: { financialYear: '' } }),
    Product.updateMany({ tenantKey, openingFinancialYear: { $in: removed }, financialYearOpeningStock: { $in: [0, null] }, openingStock: 0 }, { $set: { openingFinancialYear: '' } }),
  ]);
  invalidateFinancialYearDiscovery(tenantKey);
  return removedDatabases;
}
