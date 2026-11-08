import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionChannel,receiptIsVerified,chequeCollectionReference,onlineCollectionStatus,matchesPostedBankCredit} from '../src/services/collectionHubRules.js';
test('Cash, Cheque and five digital payment methods have one channel',()=>{
  assert.equal(collectionChannel({mode:'CASH'}),'CASH');
  assert.equal(collectionChannel({mode:'BANK',receiptType:'CHEQUE'}),'CHEQUE');
  assert.equal(collectionChannel({mode:'CHEQUE'}),'CHEQUE');
  for(const receiptType of ['UPI','NEFT','RTGS','IMPS'])assert.equal(collectionChannel({mode:'BANK',receiptType}),'ONLINE');
});
test('Before customer OTP, online payment cannot be bank matched automatically',()=>{
  assert.equal(receiptIsVerified({status:'PENDING_VERIFICATION',customerOtpStatus:'PENDING'}),false);
  assert.equal(onlineCollectionStatus({status:'PENDING_VERIFICATION',customerOtpStatus:'PENDING'}),'PENDING_CUSTOMER_OTP');
  assert.equal(onlineCollectionStatus({status:'POSTED',customerOtpStatus:'VERIFIED'}),'PENDING_BANK_VERIFICATION');
});
test('Repeated original receipt yields same cheque record reference',()=>{
  assert.equal(chequeCollectionReference({financialYear:'2026-27',receiptNo:'RCT-123'}),'CLN:2026-27:RCT-123');
});
test('Only true posted bank credits with matching UTR and amount are offered',()=>{
  const r={amount:40000,upiPaymentText:'SBIN 526193677664'};
  const b={credit:40000,classification:'POSTED',remarks:'TO TRANSFER INB NEFT UTR No SBIN526193677664'};
  assert.equal(matchesPostedBankCredit(r,b),true);
  assert.equal(matchesPostedBankCredit(r,{...b,credit:45000}),false);
  assert.equal(matchesPostedBankCredit(r,{...b,classification:'DRAFT'}),false);
  assert.equal(matchesPostedBankCredit(r,{...b,remarks:'another payment'}),false);
});
