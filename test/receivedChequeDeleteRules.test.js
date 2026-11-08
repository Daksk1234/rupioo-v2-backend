import test from 'node:test';
import assert from 'node:assert/strict';
import { receivedChequeDeleteBlocker as blocked } from '../src/services/receivedChequeDeleteRules.js';

test('Unlinked, manually entered, unposted cheque can be deleted',()=>{
  assert.equal(blocked({entryType:'CHEQUE',status:'PENDING_RECEIVED',chequeNo:'123456',ledgerStatus:'NOT_POSTED'}),'');
  assert.equal(blocked({entryType:'CHEQUE',status:'RECEIVED',chequeNo:'123456'}),'');
});
test('OTP-backed cheques cannot be deleted even if undeposited',()=>{
  assert.match(blocked({entryType:'CHEQUE',receiptBacked:true,status:'PENDING_RECEIVED'}),/receipt/i);
  assert.match(blocked({entryType:'CHEQUE',collectionLinked:true,status:'PENDING_RECEIVED'}),/receipt/i);
  assert.match(blocked({entryType:'CHEQUE',linkedReceiptNo:'RCPT-1',status:'RECEIVED'}),/receipt/i);
});
test('Online and missing-register receipt rows cannot be deleted',()=>{
  assert.match(blocked({entryType:'ONLINE',id:'online:507f1f77bcf86cd799439011'}),/online/i);
  assert.match(blocked({status:'NEEDS_REGISTRATION',id:'unlinked:507f1f77bcf86cd799439011'}),/registration/i);
});
test('Deposited, cleared, bounced, or bank-posted cheques cannot be deleted',()=>{
  for(const status of ['DEPOSITED','REDEPOSITED','CLEARED','BOUNCED','RETURNED'])assert.notEqual(blocked({status}),'');
  for(const key of ['linkedBankTransactionId','ledgerTransactionId','bounceChargeTransactionId','reversalTransactionId'])assert.notEqual(blocked({status:'RECEIVED',[key]:'REF001'}),'');
  assert.notEqual(blocked({status:'RECEIVED',ledgerStatus:'POSTED'}),'');
});
test('Cheques in collector/cashier OTP custody cannot be deleted',()=>{
  for(const status of ['PENDING_WITH_SALESPERSON','PENDING_WITH_COLLECTOR','HANDOVER_REQUESTED','HANDOVER_OTP_ISSUED','HANDOVER_VERIFIED'])assert.match(blocked({status}),/custody/i);
});
