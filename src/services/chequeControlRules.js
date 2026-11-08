// Pure validation used by Cheque Controlling System, independent of MongoDB.
const outgoing = Object.freeze({
  AVAILABLE:['AVAILABLE','ISSUED','CANCELLED','LOST','STOLEN','MISTAKEN'],
  ISSUED:['ISSUED','CLEARED','RETURNED','CANCELLED','LOST','STOLEN','MISTAKEN'],
  RETURNED:['RETURNED','ISSUED'],
  CLEARED:['CLEARED'],CANCELLED:['CANCELLED'],LOST:['LOST'],STOLEN:['STOLEN'],MISTAKEN:['MISTAKEN']
});
const incoming = Object.freeze({
  RECEIVED:['RECEIVED','DEPOSITED','CANCELLED','LOST'],
  DEPOSITED:['DEPOSITED','CLEARED','RETURNED','BOUNCED'],
  RETURNED:['RETURNED','REDEPOSITED'],
  BOUNCED:['BOUNCED','REDEPOSITED'],
  REDEPOSITED:['REDEPOSITED','CLEARED','RETURNED','BOUNCED'],
  CLEARED:['CLEARED'],CANCELLED:['CANCELLED'],LOST:['LOST']
});
export function canChequeTransition(direction,current,next){
  const statuses=direction==='ISSUED'?outgoing:direction==='RECEIVED'?incoming:null;
  if(!statuses)return false;
  return (statuses[String(current||'').toUpperCase()]||[]).includes(String(next||'').toUpperCase());
}
export function chequeSerials(startValue,countValue){
  const start=String(startValue??'').trim(),count=Number(countValue);
  if(!/^\d{1,18}$/.test(start))throw new Error('Starting cheque number must be 1–18 digits');
  if(!Number.isInteger(count)||count<1||count>500)throw new Error('Number of cheque leaves must be 1–500');
  if(BigInt(start)+BigInt(count)-1n>999999999999999999n)throw new Error('Cheque number exceeds 18 digits');
  return Array.from({length:count},(_,i)=>String(BigInt(start)+BigInt(i)).padStart(start.length,'0'));
}
export function chequeISODate(value){
  if(value===undefined||value===null||String(value).trim()==='')return '';
  const text=String(value).trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw new Error('Date must be YYYY-MM-DD');
  const parsed=new Date(`${text}T00:00:00.000Z`);
  if(!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,10)!==text)throw new Error(`Invalid date: ${text}`);
  return text;
}

// Cheque numbers are numeric identifiers, not lexicographic strings. The first
// available physical leaf wins, even when cheque books have different zero padding.
export function pickFirstAvailableCheque(leaves){
  const available=(Array.isArray(leaves)?leaves:[]).filter(x=>x?.data?.status==='AVAILABLE' && /^\d{1,18}$/.test(String(x?.data?.chequeNo||'')));
  available.sort((a,b)=>{
    const av=BigInt(a.data.chequeNo),bv=BigInt(b.data.chequeNo);
    if(av!==bv)return av<bv?-1:1;
    const at=String(a.createdAt||''),bt=String(b.createdAt||'');
    return at.localeCompare(bt)||String(a._id||'').localeCompare(String(b._id||''));
  });
  return available[0]||null;
}
export function chequeIssuePurpose(value){
  const purpose=String(value||'CHEQUE').trim().toUpperCase();
  if(!['CHEQUE','NEFT','RTGS'].includes(purpose))throw new Error('Issue purpose must be CHEQUE, NEFT or RTGS');
  return purpose;
}
export function chequeMissingLeafStatus(value){
  const status=String(value||'').trim().toUpperCase();
  if(!['CANCELLED','STOLEN','MISTAKEN'].includes(status))throw new Error('Select Cancelled, Stolen or Mistaken for an unavailable cheque leaf');
  return status;
}
