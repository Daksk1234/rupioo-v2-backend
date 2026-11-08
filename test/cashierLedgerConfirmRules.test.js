import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCashierLedgerConfirmation} from '../src/services/cashierLedgerConfirmRules.js';
const r=()=>({receiptNo:'R-1',customerGlobalId:'C-1',mode:'CASH',collectionSource:'SALESPERSON_APP',status:'POSTED',customerOtpStatus:'VERIFIED',cashDepositStatus:'DEPOSITED_TO_CASHIER',ledgerPostedAt:new Date(),amount:950});
const lines=()=>[{status:'POSTED',transactionType:'RECEIPT',transactionId:'R-1',partyGlobalId:'C-1',accountCode:'SYS_CASH',debit:950,credit:0},{status:'POSTED',transactionType:'RECEIPT',transactionId:'R-1',partyGlobalId:'C-1',accountCode:'SYS_SUNDRY_DEBTORS',debit:0,credit:950}];
test('accepts original balanced party-wise cash entry once deposited',()=>assert.equal(validateCashierLedgerConfirmation(r(),lines()).ok,true));
test('rejects missing original journal',()=>assert.equal(validateCashierLedgerConfirmation(r(),[]).ok,false));
test('rejects incorrect party credit',()=>{const x=lines();x[1].partyGlobalId='C-2';assert.equal(validateCashierLedgerConfirmation(r(),x).ok,false)});
test('rejects extra duplicate postings even if balanced',()=>{const x=lines();x.push(...lines());assert.equal(validateCashierLedgerConfirmation(r(),x).ok,false)});
test('rejects unaccepted cashier cash or bank payment',()=>{const a=r();a.cashDepositStatus='PENDING_TO_DEPOSIT';assert.equal(validateCashierLedgerConfirmation(a,lines()).ok,false);a.cashDepositStatus='DEPOSITED_TO_CASHIER';a.mode='BANK';assert.equal(validateCashierLedgerConfirmation(a,lines()).ok,false)});

test('rejects a suspense credit that did not reach the party ledger',()=>{const x=lines();x[1].accountCode='SYS_SUSPENSE';assert.equal(validateCashierLedgerConfirmation(r(),x).ok,false)});
