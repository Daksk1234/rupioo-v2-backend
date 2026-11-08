/**
 * Single source of truth for the company-wide SYS_CASH opening balance.
 * Use in Cashbook, Cash Flow and Balance Sheet. Never read a user's
 * cash-account label as a separate physical Cash-in-Hand balance.
 */
import { CompanyLedger, CompanyProfile } from "../models/index.js";
import { financialModels, financialCollectionExists } from "./accountingService.js";

const amount = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const signed = (row) => (String(row?.type || "DR").toUpperCase() === "CR" ? -1 : 1) * Number(row?.amount || 0);
const validFY = (fy) => /^(\d{4})-(\d{2})$/.test(String(fy || "")) && Number(String(fy).slice(5)) === ((Number(String(fy).slice(0, 4)) + 1) % 100);

export async function companyCashOpening({ tenantKey, financialYear }) {
  if (!validFY(financialYear)) throw new Error("Valid Financial Year is required for cash opening");
  const [profile, ledgers] = await Promise.all([
    CompanyProfile.findOne({ tenantKey }).select("firstCashFinancialYear firstCashOpeningBalance").lean(),
    CompanyLedger.find({ tenantKey, systemAccountCode: "SYS_CASH", status: { $ne: "INACTIVE" } })
      .select("ownerType openingBalances").lean(),
  ]);
  // Prefer the company cash ledger; user-associated Cash labels are NOT
  // independent cash accounts and must not multiply the company opening.
  const companyLedgers = ledgers.filter((x) => x.ownerType === "COMPANY");
  const candidates = companyLedgers.length ? companyLedgers : ledgers;
  const explicit = new Map();
  for (const ledger of candidates) for (const entry of ledger.openingBalances || []) {
    if (validFY(entry.financialYear)) explicit.set(entry.financialYear, amount((explicit.get(entry.financialYear) || 0) + signed(entry)));
  }
  if (validFY(profile?.firstCashFinancialYear)) {
    explicit.set(profile.firstCashFinancialYear, amount(profile.firstCashOpeningBalance));
  }
  if (explicit.has(financialYear)) return amount(explicit.get(financialYear));
  const earlier = [...explicit.keys()].filter((fy) => fy < financialYear).sort();
  if (!earlier.length) return 0;
  const start = Number(earlier[0].slice(0, 4));
  const target = Number(financialYear.slice(0, 4));
  if (target - start > 50) throw new Error("Cash FY opening rollover exceeds supported range");
  let balance = 0;
  for (let year = start; year < target; year++) {
    const fy = `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
    if (explicit.has(fy)) balance = amount(explicit.get(fy));
    // A historical FY without posted journals has no movement. In that case
    // do not compile LedgerEntry: doing so could recreate a missing collection.
    if(!await financialCollectionExists(tenantKey,fy,"ledgerentries"))continue;
    const { LedgerEntry } = financialModels(tenantKey, fy);
    const totals = await LedgerEntry.aggregate([
      { $match: { tenantKey, financialYear: fy, status: "POSTED", accountCode: "SYS_CASH" } },
      { $group: { _id: null, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
    ]);
    balance = amount(balance + Number(totals[0]?.debit || 0) - Number(totals[0]?.credit || 0));
  }
  return balance;
}
