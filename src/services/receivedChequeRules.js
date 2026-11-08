// Pure, reusable received-cheque workflow rules.
export const RECEIVED_STATES = Object.freeze([
  'PENDING_WITH_SALESPERSON','PENDING_WITH_COLLECTOR','HANDOVER_REQUESTED',
  'HANDOVER_OTP_ISSUED','HANDOVER_VERIFIED','PENDING_RECEIVED','RECEIVED',
  'DEPOSITED','REDEPOSITED','CLEARED','RETURNED','BOUNCED','CANCELLED','LOST'
]);
export const normalizeRole = r=>String(r||'').trim().toUpperCase().replace(/[- ]/g,'_');
export const isChequeCollector = r=>['COLLECTOR','COLLECTION_EXECUTIVE'].includes(normalizeRole(r));
export const isChequeSalesperson = r=>['SALESPERSON','SALES_PERSON'].includes(normalizeRole(r));
export const isChequeCashier = r=>normalizeRole(r)==='CASHIER';
export const receiptCustodyStatus = role=>isChequeCollector(role)?'PENDING_WITH_COLLECTOR':isChequeSalesperson(role)?'PENDING_WITH_SALESPERSON':'PENDING_RECEIVED';
export const isCustodyPending = state=>['PENDING_WITH_COLLECTOR','PENDING_WITH_SALESPERSON','HANDOVER_REQUESTED','HANDOVER_OTP_ISSUED','HANDOVER_VERIFIED'].includes(state);
export function canAdvanceReceived(from,to){
 const transitions={RECEIVED:['PENDING_RECEIVED','DEPOSITED','CANCELLED','LOST'],PENDING_RECEIVED:['PENDING_RECEIVED','RECEIVED','DEPOSITED','CANCELLED','LOST'],DEPOSITED:['CLEARED','BOUNCED','RETURNED'],REDEPOSITED:['CLEARED','BOUNCED','RETURNED'],RETURNED:['REDEPOSITED'],BOUNCED:['REDEPOSITED'],CLEARED:[],CANCELLED:[],LOST:[]};
 return from===to || (transitions[from]||[]).includes(to);
}
export function fyForDate(date){const d=String(date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(d))throw new Error('Valid transaction date required');const y=Number(d.slice(0,4));const start=Number(d.slice(5,7))>=4?y:y-1;return `${start}-${String((start+1)%100).padStart(2,'0')}`;}
export function validatesChequeIdentity(row){if(!/^[0-9A-Za-z/-]{3,30}$/.test(String(row.chequeNo||'')))throw new Error('Valid cheque number required');if(!String(row.issuedByPartyName||'').trim())throw new Error('Party name required');if(!(Number(row.amount)>0))throw new Error('Positive amount required');return true;}
