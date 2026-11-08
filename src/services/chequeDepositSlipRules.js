// Pure, testable rules for SBI cheque deposit slips. No accounting posting.
const clean = v => String(v ?? '').trim();
export const kolkataToday = () => {
  const f = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'});
  const p=Object.fromEntries(f.formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
export const isISODate = raw => {
  const s=clean(raw);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
  const d=new Date(s+'T00:00:00.000Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;
};
export const isSbiDepositAccount = bank => /^(STATE\s+BANK\s+OF\s+INDIA|S\.?B\.?I\.?)(\s|$)/i.test(clean(bank?.bankName));
export const isEligibleReceivedCheque = (row,depositDate,bankAccountId) => {
  if(!isISODate(depositDate)||!clean(bankAccountId))return false;
  if(!['PENDING_RECEIVED','RECEIVED'].includes(clean(row?.status).toUpperCase()))return false;
  if(!isISODate(row.chequeDate)||row.chequeDate>depositDate)return false;
  if(!isISODate(row.receivedDate)||row.receivedDate>depositDate)return false;
  if(row.depositDate||row.clearedDate||row.ledgerTransactionId)return false;
  if(row.depositBankAccountId&&clean(row.depositBankAccountId)!==clean(bankAccountId))return false;
  if(!clean(row.chequeNo)||!(Number(row.amount)>0))return false;
  return true;
};
export const slipGroups = (cheques,perSlip=4) => {
  if(!Number.isInteger(perSlip)||perSlip<1||perSlip>20)throw new Error('Invalid slip capacity');
  const groups=[];for(let i=0;i<cheques.length;i+=perSlip)groups.push(cheques.slice(i,i+perSlip));
  return groups;
};
export const moneyWords = n => {
  const units=['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  const upTo999 = n => {if(!n)return '';const parts=[];if(n>=100){parts.push(units[Math.floor(n/100)],'Hundred');n%=100;}if(n>=20){parts.push(tens[Math.floor(n/10)]);n%=10;}if(n)parts.push(units[n]);return parts.join(' ');};
  const integer=Math.floor(Number(n)||0),paise=Math.round((Number(n)-integer)*100);
  const chunks=[['Crore',10000000],['Lakh',100000],['Thousand',1000],['',1]];
  let remaining=integer;const parts=[];
  for(const [name,div] of chunks){const part=Math.floor(remaining/div);remaining%=div;if(part)parts.push(upTo999(part),name);}
  return `Rupees ${parts.join(' ').trim()||'Zero'}${paise?` and ${upTo999(paise)} Paise`:''} Only`;
};
