import { cashClosingBalance } from './cashbookBalanceMath.js';
/**
 * Fiscal-year accordion projection. Both Cashbook display and BankBook use
 * CREDIT = funds IN, DEBIT = funds OUT for their visible statement tables.
 * This is a read-only projection: it never posts or adjusts journals.
 */
const round = value => Math.round((Number(value) || 0) * 100) / 100;
const months = ['April','May','June','July','August','September','October','November','December','January','February','March'];
const pad = n => String(n).padStart(2,'0');
export function buildBookMonthSummary({ financialYear, openingBalance = 0, rows = [] } = {}) {
 const startYear = Number(String(financialYear || '').slice(0,4));
 if (!Number.isInteger(startYear) || startYear < 1900 || startYear > 9999) throw new Error('A valid financial year is required');
 const results = months.map((name, index) => {
  const calendarIndex = (index + 3) % 12;
  const year = startYear + (calendarIndex < 3 ? 1 : 0);
  const startDate = `${year}-${pad(calendarIndex+1)}-01`;
  const lastDay = new Date(Date.UTC(year, calendarIndex + 1, 0)).getUTCDate();
  return { month:name, label:`${name} ${year}`, startDate,
   endDate:`${year}-${pad(calendarIndex+1)}-${pad(lastDay)}`,
   count:0, debit:0, credit:0, openingBalance:0, closingBalance:0 };
 });
 const byKey = new Map(results.map((x,index)=>[x.startDate.slice(0,7),index]));
 for (const row of rows) {
  const date = row?.date instanceof Date ? row.date.toISOString().slice(0,10) : String(row?.date || '').slice(0,10);
  const index = byKey.get(date.slice(0,7));
  if (index === undefined) continue;
  const item = results[index];
  item.count += 1;
  item.debit = round(item.debit + Number(row.debit || 0));
  item.credit = round(item.credit + Number(row.credit || 0));
 }
 let current = round(openingBalance);
 for (const item of results) {
  item.openingBalance = current;
  current = cashClosingBalance(current, {debit:item.debit,credit:item.credit});
  item.closingBalance = current;
 }
 return results;
}
