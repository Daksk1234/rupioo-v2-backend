import test from 'node:test';
import assert from 'node:assert/strict';
import { isReceiptLedgerPosted, isValidReceiptBankDate } from '../src/services/receiptAccountingRules.js';

const verified = {status:'POSTED',collectionSource:'SALESPERSON_APP',customerOtpStatus:'VERIFIED'};

test('customer OTP alone is not a financial ledger posting',()=>{
  assert.equal(isReceiptLedgerPosted({...verified,mode:'CASH'}),false);
  assert.equal(isReceiptLedgerPosted({...verified,mode:'BANK',receiptType:'CHEQUE'}),false);
});
test('physical cash handover or cheque company approval alone is not posting',()=>{
  assert.equal(isReceiptLedgerPosted({...verified,cashDepositStatus:'DEPOSITED_TO_CASHIER'}),false);
  assert.equal(isReceiptLedgerPosted({...verified,chequeApprovalStatus:'APPROVED'}),false);
});
test('only explicit posting marks new collector receipt paid',()=>{
  assert.equal(isReceiptLedgerPosted({...verified,ledgerPostedAt:new Date()}),true);
});
test('legacy company POSTED receipts remain paid',()=>{
  assert.equal(isReceiptLedgerPosted({status:'POSTED',mode:'CASH'}),true);
  assert.equal(isReceiptLedgerPosted({status:'POSTED',collectionSource:'DMS'}),true);
  assert.equal(isReceiptLedgerPosted({status:'DELETED',collectionSource:'DMS'}),false);
});
test('nonposted and empty receipt cannot appear paid',()=>{
  assert.equal(isReceiptLedgerPosted({status:'DRAFT',ledgerPostedAt:new Date()}),false);
  assert.equal(isReceiptLedgerPosted(null),false);
});
test('bank received date must be an exact calendar day',()=>{
  assert.equal(isValidReceiptBankDate('2026-02-30','2025-26'),false);
  assert.equal(isValidReceiptBankDate('2026-13-06','2026-27'),false);
  assert.equal(isValidReceiptBankDate('2026-11-06T01:00:00Z','2026-27'),false);
});
test('bank received date must be within requested Indian financial year',()=>{
  assert.equal(isValidReceiptBankDate('2026-04-01','2026-27'),true);
  assert.equal(isValidReceiptBankDate('2027-03-31','2026-27'),true);
  assert.equal(isValidReceiptBankDate('2027-04-01','2026-27'),false);
  assert.equal(isValidReceiptBankDate('2026-03-31','2025-26'),true);
  assert.equal(isValidReceiptBankDate('2026-04-01','2025-26'),false);
});
