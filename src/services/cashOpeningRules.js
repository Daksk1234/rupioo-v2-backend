import { normalizeYears, validFY } from './financialYearDiscoveryRules.js';

export function validateCashOpening({financialYear,amount,configured=[],discovered=[]}) {
  if(!validFY(financialYear))throw new Error('Cash opening FY must use YYYY-YY, e.g. 2025-26');
  const years=normalizeYears([...configured,...discovered]);
  if(!years.includes(financialYear))throw new Error('Cash opening year must be an enabled or discovered financial year');
  if(financialYear!==years[0])throw new Error(`Set opening cash in ${years[0]}, the earliest company financial year. Later years carry forward the preceding closing cash.`);
  const value=Number(amount);
  if(!Number.isFinite(value)||Math.abs(value)>1e12||Math.abs(Math.round(value*100)-value*100)>1e-6)
    throw new Error('Cash opening must be a signed amount with at most two decimal places');
  return Math.round(value*100)/100;
}
