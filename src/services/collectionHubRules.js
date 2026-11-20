// Pure rules; testable without MongoDB and reusable in both app/DMS builds.
const clean = v => String(v ?? '').trim();
export function collectionChannel(receipt) {
  const mode=clean(receipt?.mode).toUpperCase(),type=clean(receipt?.receiptType).toUpperCase();
  if(mode==='CASH')return 'CASH';
  if(['CHEQUE','CHECK','CHQ'].includes(mode)||['CHEQUE','CHECK','CHQ'].includes(type))return 'CHEQUE';
  return 'ONLINE';
}
export const collectionConfirmationFilter={$or:[{customerOtpStatus:'VERIFIED'},
 {customerConfirmationMethod:'ONLINE_PROOF',customerOtpStatus:'NOT_REQUIRED',mode:'BANK',receiptType:{$nin:['CASH','CHEQUE','CHECK','CHQ']},paymentProofFileId:{$exists:true,$nin:[null,'']}}]};
export const receiptIsVerified = r => r?.status==='POSTED'&&(r?.customerOtpStatus==='VERIFIED'||
 r?.customerConfirmationMethod==='ONLINE_PROOF'&&r?.customerOtpStatus==='NOT_REQUIRED'&&r?.mode==='BANK'&&collectionChannel(r)==='ONLINE'&&Boolean(r?.paymentProofFileId));
export const chequeCollectionReference = r => `CLN:${clean(r.financialYear)}:${clean(r.receiptNo)}`.toUpperCase();
export function onlineCollectionStatus(r){return r?.bankMatchStatus==='BANK_MATCHED'?'BANK_MATCHED':receiptIsVerified(r)?'PENDING_BANK_VERIFICATION':'PENDING_CUSTOMER_OTP';}
export const referenceKey = value=>clean(value).toUpperCase().replace(/[^A-Z0-9]/g,'');
export function matchesPostedBankCredit(receipt,statement){
  const utr=referenceKey(receipt?.upiPaymentText||receipt?.reference);
  return utr.length>=6 && statement?.classification==='POSTED'
    && Number(statement?.credit)>0
    && Math.abs(Number(statement.credit)-Number(receipt?.amount))<.005
    && referenceKey(`${statement?.remarks||''} ${statement?.partyName||''}`).includes(utr);
}
