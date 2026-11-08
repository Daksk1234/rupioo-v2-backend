import { cashClosingBalance } from './cashbookBalanceMath.js';
import { cashBulkMode } from './cashBulkPartyMatcher.js';
/* Cashbook statement import: business display convention OUT=Debit, IN=Credit.
 * Auto-detection is rule based, not an unreviewed AI financial posting.
 */
import { parseStrictVoucherDate } from '../utils/strictVoucherDate.js';
import { resolveColumns, valueFor } from '../utils/bulkSpreadsheet.js';
const clean=x=>String(x??'').trim();
const isContraNarration=text=>/\b(cash\s+(deposited|deposit)\s+(in|into|to)\s+(the\s+)?bank|bank\s+deposit|cash\s+withdrawn\s+from\s+bank|cash\s+withdrawal\s+from\s+bank)\b/i.test(text);
const categoryHint=text=>{
 if(/hotel|lodging|accommodation/i.test(text))return 'Travelling > Hotel';
 if(/travell?ing|transport|taxi|uber|ticket|flight/i.test(text))return 'Travelling > Transport/Tickets';
 if(/food|snack|meal|restaurant/i.test(text))return 'Indirect Expenses > Food';
 if(/wages|salary|payroll/i.test(text))return 'Employee Costs > Salary/Wages';
 if(/machine|construction|fabrication/i.test(text))return 'Assets / Work-in-progress (review)';
 if(/cash sale|sales invoice/i.test(text))return 'Cash Sales (link invoice before accounting)';
 if(/purchase invoice|cash purchase/i.test(text))return 'Cash Purchases (link invoice before accounting)';
 return '';
};
const amount=x=>{
 const raw=clean(x).replace(/,/g,'').replace(/₹|Rs\.?/gi,'').replace(/\s/g,'');
 if(!raw)return 0;
 const n=Number(raw.replace(/^\((.*)\)$/,'-$1'));
 if(!Number.isFinite(n)||n<0)throw new Error('Debit/Credit must be non-negative numeric amounts');
 return Math.round(n*100)/100;
};
export const cashbookHeaders=['Date','Party Name','Remarks','Mode','Debit','Credit'];
export function readCashbookRows(rows){
 if(!Array.isArray(rows)||!rows.length)throw new Error('No Cashbook entries found');
 const spec=[{key:'date',label:'Date',required:true},{key:'particulars',label:'Remarks',aliases:['particulars','narration','description','remark'],required:true},
  {key:'debit',label:'Debit',required:true},{key:'credit',label:'Credit',required:true},
  {key:'mode',label:'Mode'},{key:'running',label:'Running Balance'},
  {key:'partyName',label:'Party Name',aliases:['party','payee']},
  {key:'partyType',label:'Party Type'}];
 const cols=resolveColumns(rows[0],spec);
 const missing=spec.filter(x=>x.required&&!cols[x.key]).map(x=>x.label);
 if(missing.length)throw new Error(`Missing columns: ${missing.join(', ')}`);
 return rows.map((row,i)=>{
  try{
   const dateText=clean(valueFor(row,cols.date));
   const iso=parseStrictVoucherDate(dateText).toISOString().slice(0,10);
   const particulars=clean(valueFor(row,cols.particulars));
   if(!particulars||particulars.length>500)throw new Error('Remarks is required (maximum 500 characters)');
   const mode=cashBulkMode(valueFor(row,cols.mode));
   const debit=amount(valueFor(row,cols.debit));
   const credit=amount(valueFor(row,cols.credit));
   if((debit>0)===(credit>0))throw new Error('Enter an amount in exactly one of Debit or Credit');
   return {rowNo:i+2,date:iso,particulars,mode,debit,credit,
    transactionType:debit>0?'PAYMENT':'RECEIPT',amount:debit||credit,
    partyName:clean(valueFor(row,cols.partyName)),partyType:clean(valueFor(row,cols.partyType)).toUpperCase(),
    requiresContra:isContraNarration(particulars),categoryHint:categoryHint(particulars),
    bankWarning:isContraNarration(particulars)?'Possible transfer between Cash and company Bank: use Contra instead of this bulk voucher':
      /\b(NEFT|RTGS|IMPS|UPI)\b/i.test(particulars)?'Bank transfer mentioned: verify this was physically CASH before posting':'',
   };
  }catch(e){return {rowNo:i+2,error:e.message};}
 });
}
export function balancePreview(rows,opening){
 let balance=Math.round(Number(opening||0)*100)/100;
 return rows.filter(x=>!x.error).slice().sort((a,b)=>a.date.localeCompare(b.date)||a.rowNo-b.rowNo).map(row=>{
  balance=cashClosingBalance(balance, row);
  return {...row,previewRunningBalance:balance};
 });
}
