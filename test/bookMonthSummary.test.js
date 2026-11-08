import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBookMonthSummary} from '../src/services/bookMonthSummary.js';

test('FY month summary shows April to March including empty months and carries closing',()=>{
 const items=buildBookMonthSummary({financialYear:'2025-26',openingBalance:50000,rows:[
  {date:'2025-04-15',debit:700,credit:1200},{date:'2025-05-01',debit:100,credit:0},
  {date:'2026-03-31',debit:1000,credit:0},
 ]});
 assert.equal(items.length,12);
 assert.equal(items[0].label,'April 2025');
 assert.equal(items[0].openingBalance,50000);
 assert.equal(items[0].closingBalance,50500);
 assert.equal(items[1].openingBalance,50500);
 assert.equal(items[1].closingBalance,50400);
 assert.equal(items[2].count,0);
 assert.equal(items[2].openingBalance,50400);
 assert.equal(items[11].label,'March 2026');
 assert.equal(items[11].closingBalance,49400);
 assert.equal(items[11].endDate,'2026-03-31');
});
test('January follows December, not preceding March',()=>{
 const months=buildBookMonthSummary({financialYear:'2026-27',openingBalance:0,rows:[
  {date:'2026-12-31',credit:5},{date:'2027-01-01',debit:2}
 ]});
 assert.equal(months[8].month,'December');
 assert.equal(months[8].closingBalance,5);
 assert.equal(months[9].month,'January');
 assert.equal(months[9].openingBalance,5);
 assert.equal(months[9].closingBalance,3);
});
test('leap-year February and out-of-FY entries',()=>{
 const months=buildBookMonthSummary({financialYear:'2023-24',openingBalance:7,rows:[
  {date:new Date('2024-02-29T00:00:00Z'),credit:10},{date:'2024-04-01',credit:300}
 ]});
 assert.equal(months[10].endDate,'2024-02-29');
 assert.equal(months[10].credit,10);
 assert.equal(months[11].closingBalance,17);
});
test('cash/bank transfer has one movement per book, not both sides',()=>{
 const cash=buildBookMonthSummary({financialYear:'2026-27',openingBalance:100,rows:[{date:'2026-04-02',debit:30,credit:0}]});
 const bank=buildBookMonthSummary({financialYear:'2026-27',openingBalance:50,rows:[{date:'2026-04-02',debit:0,credit:30}]});
 assert.equal(cash[0].closingBalance,70);
 assert.equal(bank[0].closingBalance,80);
});
