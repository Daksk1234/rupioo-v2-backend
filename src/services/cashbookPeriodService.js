import { cashClosingBalance, cashMovement } from './cashbookBalanceMath.js';
/**
 * Cashbook statement periods.  Display convention: Debit = cash OUT,
 * Credit = cash IN.  All running balances are calculated chronologically
 * across the entire FY; filtering never restarts the running balance.
 * This is an in-memory projection; it never posts journal entries.
 */
const amount = n => Math.round((Number(n) || 0) * 100) / 100;
const isoDay = value => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

export function cashbookPeriodSnapshot({ rows = [], openingBalance = 0, fromDate = '', toDate = '' } = {}) {
  const start = String(fromDate || '').slice(0, 10);
  const end = String(toDate || '').slice(0, 10);
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('Invalid fromDate');
  if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('Invalid toDate');
  if (start && end && start > end) throw new Error('The start date must not be after the end date');
  let previousMovement = 0, periodDebitTotal = 0, periodCreditTotal = 0;
  const periodRows = [];
  for (const row of rows) {
    const day = isoDay(row.date);
    const debit = amount(row.debit), credit = amount(row.credit);
    if (start && day < start) { previousMovement = amount(previousMovement + cashMovement({ debit, credit })); continue; }
    if (end && day > end) continue;
    periodDebitTotal = amount(periodDebitTotal + debit);
    periodCreditTotal = amount(periodCreditTotal + credit);
    periodRows.push(row);
  }
  const periodOpeningBalance = amount(openingBalance + previousMovement);
  const periodClosingBalance = cashClosingBalance(periodOpeningBalance, { debit:periodDebitTotal, credit:periodCreditTotal });
  return {
    periodRows, periodOpeningBalance, periodClosingBalance,
    periodDebitTotal, periodCreditTotal, periodEntryCount: periodRows.length,
  };
}

/**
 * Roll forward every previous FY closing to the next FY opening.  No FY
 * opening is invented by copying a journal entry; the function returns a
 * statement projection and never alters source documents or journal rows.
 * Later conflicting manual openings are reported rather than used to reset
 * the sequence behind the user's back.
 */
export async function rollForwardCashbook({ startYear, targetYear, initialOpening = 0, explicitOpenings = new Map(), getYearMovements }) {
  if (!Number.isInteger(startYear) || !Number.isInteger(targetYear) || startYear > targetYear || targetYear - startYear > 50) {
    throw new Error('Invalid Cashbook financial-year rollover range');
  }
  if (typeof getYearMovements !== 'function') throw new Error('Cashbook rollover requires a year movement reader');
  let balance = amount(initialOpening), journalBalance = amount(initialOpening), priorYearIssues = 0;
  const mismatchedManualOpenings = [];
  for (let year = startYear; year < targetYear; year++) {
    const fy = `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
    if (year !== startYear && explicitOpenings.has(fy) && Math.abs(amount(explicitOpenings.get(fy)) - balance) > 0.005) {
      mismatchedManualOpenings.push({ financialYear: fy, specified: amount(explicitOpenings.get(fy)), carried: balance });
    }
    const period = await getYearMovements(fy);
    balance = amount(balance + Number(period?.projectedMovement || 0));
    journalBalance = amount(journalBalance + Number(period?.journalMovement || 0));
    priorYearIssues += Number(period?.issueCount || 0);
  }
  const destinationFY = `${targetYear}-${String((targetYear + 1) % 100).padStart(2, '0')}`;
  if (targetYear > startYear && explicitOpenings.has(destinationFY) && Math.abs(amount(explicitOpenings.get(destinationFY)) - balance) > .005) {
    mismatchedManualOpenings.push({ financialYear: destinationFY, specified: amount(explicitOpenings.get(destinationFY)), carried: balance });
  }
  return {
    openingBalance: balance,
    calculatedJournalOpeningBalance: journalBalance,
    priorYearIssues,
    mismatchedManualOpenings,
  };
}
