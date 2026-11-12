import { cashClosingBalance } from './cashbookBalanceMath.js';
// Superadmin correction rows are book-level adjustments. Source documents
// (invoices, cashier OTP, imported bank files) remain immutable evidence.
// CASH/BANK projection uses the effective row; journal delta adjusts the actual
// account balance with an equal and opposite party/suspense posting.
const cents = n => Math.round((Number(n)||0)*100);
const amount = n => cents(n)/100;
export const isSuperadmin = auth => ['MASTER','SUPERADMIN'].includes(String(auth?.role||'').toUpperCase());
export const cashKey = r => `CB:${String(r.transactionType||'')}:${String(r.transactionId||'')}`;
export const bookKey = (r,book) => book==='CASH'?cashKey(r):String(r._listId||r.sourceKey||'');
export function validateBookCorrection(input, financialYear){
  const first=Number(String(financialYear||'').slice(0,4));
  const date=String(input.date||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)))throw new Error('Enter a valid date');
  const dt=new Date(`${date}T00:00:00.000Z`);
  if(dt.toISOString().slice(0,10)!==date)throw new Error('Invalid calendar date');
  const year=dt.getUTCFullYear(),month=dt.getUTCMonth()+1;
  if((month>=4?year:year-1)!==first)throw new Error('Move entries to a different financial year using a separate audited FY transfer');
  const debit=Number(input.debit||0),credit=Number(input.credit||0);
  if(!Number.isFinite(debit)||!Number.isFinite(credit)||debit<0||credit<0||
     (!input.deleted&&(debit<=0&&credit<=0))||(debit>0&&credit>0)||
     Math.abs(cents(debit)-debit*100)>1e-6||Math.abs(cents(credit)-credit*100)>1e-6)
    throw new Error('Enter either a positive Debit or a positive Credit, with up to two decimals');
  return {date:dt,debit:input.deleted?0:amount(debit),credit:input.deleted?0:amount(credit),
    remarks:String(input.remarks??'').slice(0,2000),
    partyName:String(input.partyName||'').trim().slice(0,250),deleted:Boolean(input.deleted)};
}
export function applyCashCorrections(rows,corrections,opening=0){
  const byKey=new Map(corrections.map(c=>[c.sourceKey,c]));
  const prepared=[];
  for(const row of rows){
    const edit=byKey.get(cashKey(row));
    if(edit?.deleted)continue;
    const next=edit?{...row,date:edit.date,debit:amount(edit.debit),credit:amount(edit.credit),
      particular:edit.remarks??row.particular,remarks:edit.remarks??row.remarks,
      partyGlobalId:edit.partyGlobalId||row.partyGlobalId,partyType:edit.partyType||row.partyType,
      partyName:edit.partyName||row.partyName,adminCorrected:true,needsCorrection:false,
      journalCorrectionPending:false,correctionMessage:'',
      type:Number(edit.credit||0)>0?'RECEIPT':'PAYMENT',
      category:(Number(row.credit||0)>0)===(Number(edit.credit||0)>0)
        ?row.category:(Number(edit.credit||0)>0?'CASH_ADJUSTMENT_IN':'CASH_ADJUSTMENT_OUT'),
    }:row;
    prepared.push(next);
  }
  prepared.sort((a,b)=>new Date(a.date)-new Date(b.date)||new Date(a.createdAt||0)-new Date(b.createdAt||0)||String(a.transactionId).localeCompare(String(b.transactionId)));
  let running=amount(opening);const totals={};
  const result=prepared.map(row=>{
    running=cashClosingBalance(running,{debit:row.debit,credit:row.credit});
    const cat=row.category||'OTHER';const entry=totals[cat]||{count:0,received:0,paid:0};
    entry.count++;entry.received=amount(entry.received+Number(row.credit||0));entry.paid=amount(entry.paid+Number(row.debit||0));totals[cat]=entry;
    return {...row,runningBalance:running,cashNetMovement:amount(Number(row.credit||0)-Number(row.debit||0))};
  });
  return {rows:result,closingBalance:running,categoryTotals:totals};
}
export function applyBankCorrections(rows,corrections){
  const map=new Map(corrections.map(c=>[c.sourceKey,c]));
  return rows.flatMap(row=>{
    const edit=map.get(bookKey(row,'BANK'));
    if(edit?.deleted)return [];
    if(!edit)return [row];
    const correctedParty = String(edit.partyGlobalId || '').trim();
    return [{...row,date:edit.date,debit:amount(edit.debit),credit:amount(edit.credit),
      remarks:edit.remarks??row.remarks,
      matchedPartyGlobalId: correctedParty || row.matchedPartyGlobalId,
      matchedPartyName:edit.partyName||row.matchedPartyName,
      partyNameDisplay:edit.partyName||row.partyNameDisplay,
      classification:correctedParty ? 'POSTED' : row.classification,
      adminCorrected:true}];
  });
}
export function adjustmentJournal({currentNet,originalNet,bookAccount,counterAccount,date,reason,tenantKey,financialYear,transactionId}){
  const delta=amount(currentNet-originalNet);
  if(Math.abs(delta)<0.005)return [];
  if(!bookAccount?.accountCode||!counterAccount?.accountCode)throw new Error('Account mapping missing');
  const payload={tenantKey,financialYear,transactionId,transactionType:'SUPERADMIN_BOOK_ADJUSTMENT',date,
    narration:`Superadmin book correction: ${reason}`,status:'POSTED'};
  const entry=(account,sign)=>({...payload,...account,debit:sign>0?amount(Math.abs(sign)):0,credit:sign<0?amount(Math.abs(sign)):0});
  return [entry(bookAccount,delta),entry(counterAccount,-delta)];
}

// Reclassify a posted two-sided cash/bank movement directly: old party's
// original net is reversed, new party receives the corrected amount, and the
// book's own account receives only the difference. This keeps every journal
// balanced, including changes that switch debit/credit direction.
export function reclassifiedJournal({oldNet,targetNet,oldDate,newDate,bookAccount,oldCounter,newCounter,
  tenantKey,financialYear,reason,makeId}){
 const raw=[];
 const oldDay=new Date(oldDate).toISOString().slice(0,10);
 const newDay=new Date(newDate).toISOString().slice(0,10);
 const group=(date,id,contributions)=>{
   const map=new Map();
   for(const [account,value] of contributions){
     const signed=amount(value);
     if(Math.abs(signed)<0.005)continue;
     const key=[account.accountCode,account.ledgerId||'',account.bankAccountId||'',account.partyGlobalId||''].join('|');
     const old=map.get(key)||{account,signed:0};old.signed=amount(old.signed+signed);map.set(key,old);
   }
   const lines=[...map.values()].filter(x=>Math.abs(x.signed)>=0.005).map(({account,signed})=>({
     tenantKey,financialYear,date,transactionId:id,transactionType:'SUPERADMIN_BOOK_ADJUSTMENT',
     narration:`Superadmin book correction: ${reason}`,status:'POSTED',...account,
     debit:signed>0?amount(signed):0,credit:signed<0?amount(-signed):0,
   }));
   if(lines.length){
     if(lines.length<2||Math.abs(lines.reduce((n,l)=>n+Number(l.debit)-Number(l.credit),0))>=0.005)
       throw new Error('Correction journal would be unbalanced');
     raw.push({id,lines});
   }
 };
 if(oldDay===newDay){
   group(newDate,makeId(),[[bookAccount,targetNet-oldNet],[oldCounter,oldNet],[newCounter,-targetNet]]);
 }else{
   group(oldDate,makeId(),[[bookAccount,-oldNet],[oldCounter,oldNet]]);
   group(newDate,makeId(),[[bookAccount,targetNet],[newCounter,-targetNet]]);
 }
 return raw;
}
