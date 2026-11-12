import test from 'node:test';
import assert from 'node:assert/strict';
import {projectBankJournalRows} from '../src/services/bankJournalProjection.js';

const banks=[{bankAccountId:'A',bankName:'Company Bank',ledgerId:'LA'},{bankAccountId:'B',bankName:'OD Bank',ledgerId:'LB'}];
const line=(id,extra={})=>({_id:id,transactionId:id,transactionType:'PAYMENT',status:'POSTED',accountCode:'SYS_BANK_ACCOUNT',
 bankAccountId:'A',date:'2026-04-03',debit:200,credit:0,...extra});

test('cash payments into bank are statement credits and cash receipts from bank are statement debits',()=>{
 const rows=projectBankJournalRows({banks,lines:[line('PAY-1'),line('cash-pay',{transactionId:'PAY-1',accountCode:'SYS_CASH',bankAccountId:'',debit:0,credit:200}),
  line('RCT-1',{transactionType:'RECEIPT',debit:0,credit:75}),line('cash-rct',{transactionId:'RCT-1',transactionType:'RECEIPT',accountCode:'SYS_CASH',bankAccountId:'',debit:75,credit:0})]});
 assert.equal(rows.length,2);assert.equal(rows[0].credit,200);assert.equal(rows[0].debit,0);
 assert.equal(rows[1].debit,75);assert.equal(rows[1].credit,0);assert.ok(rows.every(row=>row.matchedPartyName==='Cash-in-Hand'));
});

test('represented source identities prevent duplication while equal date/amount transactions remain separate',()=>{
 const rows=projectBankJournalRows({banks,lines:[line('ONE'),line('TWO'),line('COVERED'),line('OTHER-BANK',{bankAccountId:'B'})],
  covered:[{transactionId:'COVERED',bankAccountId:'A'},{transactionId:'OTHER-BANK',bankAccountId:'A'}]});
 assert.deepEqual(rows.map(row=>row.transactionId),['ONE','OTHER-BANK','TWO']);
});

test('legacy bank ledger IDs resolve one account only; reversed and adjustment journals never appear',()=>{
 const rows=projectBankJournalRows({banks,bankAccountId:'B',lines:[line('LEGACY',{bankAccountId:'',ledgerId:'LB',accountCode:'SYS_BANK_OD'}),
  line('REVERSED',{bankAccountId:'B',status:'REVERSED'}),line('ADJUSTMENT',{bankAccountId:'B',transactionType:'SUPERADMIN_BOOK_ADJUSTMENT'}),
  line('UNKNOWN',{bankAccountId:'',ledgerId:'missing'})]});
 assert.equal(rows.length,1);assert.equal(rows[0].bankAccountId,'B');assert.equal(rows[0].credit,200);
 assert.deepEqual(projectBankJournalRows({banks:[...banks,{bankAccountId:'C',ledgerId:'LB'}],lines:[line('AMBIGUOUS',{bankAccountId:'',ledgerId:'LB'})]}),[]);
});

test('split bank legs are grouped with a stable edit identity and cheque clearing appears as a credit',()=>{
 const lines=[line('z',{transactionId:'CHQ-1',transactionType:'CHEQUE_CLEARING',debit:125}),
  line('a',{transactionId:'CHQ-1',transactionType:'CHEQUE_CLEARING',debit:75})];
 const first=projectBankJournalRows({banks,lines})[0],second=projectBankJournalRows({banks,lines:[...lines].reverse()})[0];
 assert.equal(first.credit,200);assert.match(first._listId,/^JRN:[a-f0-9]{40}$/);assert.equal(second._listId,first._listId);
 assert.equal(projectBankJournalRows({banks,lines:lines.map(line=>({...line,_id:`new-${line._id}`}))})[0]._listId,first._listId);
});
