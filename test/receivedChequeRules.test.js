import assert from 'node:assert/strict';
import test from 'node:test';
import {receiptCustodyStatus,canAdvanceReceived,fyForDate,validatesChequeIdentity,isCustodyPending} from '../src/services/receivedChequeRules.js';
test('Sales Person and Collector hold cheque until cashier OTP handover',()=>{
 assert.equal(receiptCustodyStatus('SALES_PERSON'),'PENDING_WITH_SALESPERSON');
 assert.equal(receiptCustodyStatus('COLLECTOR'),'PENDING_WITH_COLLECTOR');
 assert.equal(receiptCustodyStatus('CASHIER'),'PENDING_RECEIVED');
 assert.ok(isCustodyPending('HANDOVER_OTP_ISSUED'));
});
test('Only cleared cheque can complete deposit workflow',()=>{
 assert.equal(canAdvanceReceived('PENDING_RECEIVED','CLEARED'),false);
 assert.equal(canAdvanceReceived('PENDING_RECEIVED','DEPOSITED'),true);
 assert.equal(canAdvanceReceived('DEPOSITED','CLEARED'),true);
 assert.equal(canAdvanceReceived('DEPOSITED','BOUNCED'),true);
 assert.equal(canAdvanceReceived('BOUNCED','REDEPOSITED'),true);
 assert.equal(canAdvanceReceived('CLEARED','DEPOSITED'),false);
});
test('FY follows bank posting date',()=>{
 assert.equal(fyForDate('2026-03-31'),'2025-26');
 assert.equal(fyForDate('2026-04-01'),'2026-27');
});
test('Cheque identity validates amounts and identifiers',()=>{
 assert.ok(validatesChequeIdentity({chequeNo:'000123',issuedByPartyName:'Customer',amount:200}));
 assert.throws(()=>validatesChequeIdentity({chequeNo:'12',issuedByPartyName:'Customer',amount:200}));
 assert.throws(()=>validatesChequeIdentity({chequeNo:'000123',issuedByPartyName:'Customer',amount:0}));
});

test('Company can acknowledge a cashier-received cheque without skipping deposit',()=>{
 assert.equal(canAdvanceReceived('PENDING_RECEIVED','RECEIVED'),true);
 assert.equal(canAdvanceReceived('RECEIVED','DEPOSITED'),true);
 assert.equal(canAdvanceReceived('PENDING_RECEIVED','DEPOSITED'),true); // Existing direct-deposit flow remains valid.
 assert.equal(canAdvanceReceived('RECEIVED','CLEARED'),false);
 assert.equal(canAdvanceReceived('PENDING_RECEIVED','CLEARED'),false);
 assert.equal(canAdvanceReceived('HANDOVER_VERIFIED','RECEIVED'),false);
 assert.equal(canAdvanceReceived('HANDOVER_OTP_ISSUED','RECEIVED'),false);
 assert.equal(canAdvanceReceived('PENDING_WITH_SALESPERSON','RECEIVED'),false);
 assert.equal(canAdvanceReceived('DEPOSITED','RECEIVED'),false);
 assert.equal(canAdvanceReceived('CLEARED','RECEIVED'),false);
});
