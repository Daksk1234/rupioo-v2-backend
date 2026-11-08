import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cashClosingBalance } from '../src/services/cashbookBalanceMath.js';
import { buildCompanyCashbook } from '../src/services/companyCashbookEngine.js';
import { applyCashCorrections } from '../src/services/superadminBookCorrectionRules.js';
import { buildBookMonthSummary } from '../src/services/bookMonthSummary.js';
import { cashbookPeriodSnapshot, rollForwardCashbook } from '../src/services/cashbookPeriodService.js';

const day='2026-04-10T00:00:00.000Z';
const payment = { _id:'cash-pay-id', paymentNo:'PAY-30', amount:30, mode:'CASH', status:'POSTED', partyNameSnapshot:'Vendor', date:day, remarks:'Payment'};
const creditJournal = (debit,credit) => ({_id:`journal-${debit}-${credit}`,transactionId:'PAY-30',transactionType:'PAYMENT',date:day,createdAt:day,debit,credit,narration:'Payment'});

test('cash math ALWAYS subtracts debit even from an already negative opening',()=>{
 assert.equal(cashClosingBalance(-100,{debit:30,credit:0}),-130);
 assert.equal(cashClosingBalance(-130,{debit:0,credit:60}),-70);
 assert.equal(cashClosingBalance(-70,{debit:20,credit:10}),-80);
 assert.equal(cashClosingBalance(-100,{debit:0.1,credit:0.2}),-99.9);
});

test('payment source and correct SYS_CASH journal: -100 - 30 = -130',()=>{
 const book=buildCompanyCashbook({openingBalance:-100,lines:[creditJournal(0,30)],payments:[payment],enforceSourceDocuments:true});
 assert.equal(book.rows[0].debit,30);
 assert.equal(book.rows[0].credit,0);
 assert.equal(book.rows[0].runningBalance,-130);
 assert.equal(book.closingBalance,-130);
 assert.equal(book.provisional,false);
});

test('legacy wrong-way SYS_CASH journal cannot make a posted payment increase cash',()=>{
 const book=buildCompanyCashbook({openingBalance:-100,lines:[creditJournal(30,0)],payments:[payment],enforceSourceDocuments:true});
 assert.equal(book.rows[0].debit,30);
 assert.equal(book.rows[0].credit,0);
 assert.equal(book.rows[0].runningBalance,-130);
 assert.equal(book.closingBalance,-130);
 assert.equal(book.journalClosingBalance,-70);
 assert.equal(book.provisional,true);
 assert.match(book.issues[0].message,/journal/);
});

test('negative opening carries through inline corrections, months and date periods',()=>{
 const original=buildCompanyCashbook({openingBalance:-100,lines:[creditJournal(0,30)],payments:[payment],enforceSourceDocuments:true});
 const corrected=applyCashCorrections(original.rows,[], -100);
 assert.equal(corrected.closingBalance,-130);
 assert.equal(corrected.rows[0].runningBalance,-130);
 const months=buildBookMonthSummary({financialYear:'2026-27',openingBalance:-100,rows:corrected.rows});
 assert.equal(months[0].openingBalance,-100);
 assert.equal(months[0].debit,30);
 assert.equal(months[0].closingBalance,-130);
 assert.equal(months[1].openingBalance,-130);
 assert.equal(months[1].closingBalance,-130);
 const period=cashbookPeriodSnapshot({rows:corrected.rows,openingBalance:-100,fromDate:'2026-04-01',toDate:'2026-04-30'});
 assert.equal(period.periodOpeningBalance,-100);
 assert.equal(period.periodClosingBalance,-130);
});

test('receipt following negative cash payment increases from -130 to -70',()=>{
 const source=buildCompanyCashbook({openingBalance:-100,lines:[creditJournal(0,30),
  {_id:'j2',transactionId:'RCT-60',transactionType:'RECEIPT',date:'2026-05-12T00:00:00.000Z',createdAt:'2026-05-12T00:00:00.000Z',debit:60,credit:0}],
  payments:[payment],receipts:[{_id:'receipt-60',receiptNo:'RCT-60',amount:60,mode:'CASH',status:'POSTED'}],enforceSourceDocuments:true});
 assert.deepEqual(source.rows.map(x=>x.runningBalance),[-130,-70]);
 assert.equal(source.closingBalance,-70);
});

test('bulk cashbook preview uses the same debit-subtracting function',()=>{
 const source=fs.readFileSync(new URL('../src/services/cashbookImport.js',import.meta.url),'utf8');
 assert.match(source,/balance=cashClosingBalance\(balance, row\)/);
});

test('negative cash closing carries to next financial year',async()=>{
 const r=await rollForwardCashbook({startYear:2025,targetYear:2026,initialOpening:-100,
  getYearMovements:async()=>({projectedMovement:-30,journalMovement:-30,issueCount:0})});
 assert.equal(r.openingBalance,-130);
});

test('month accordion does not hide negative opening or closing via Math.abs',()=>{
 const source=fs.readFileSync(new URL('../../frontend/src/components/BookMonthAccordion.jsx',import.meta.url),'utf8');
 const page=fs.readFileSync(new URL('../../frontend/src/pages/CashbookPage.jsx',import.meta.url),'utf8');
 assert.doesNotMatch(source,/Math\.abs\(Number\(v\|\|0\)\)/);
 assert.match(page,/balanceFormat=\{money\}/);
});
