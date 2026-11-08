import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyCashbook } from '../src/services/companyCashbookEngine.js';
import { cashbookPeriodSnapshot, rollForwardCashbook } from '../src/services/cashbookPeriodService.js';

const mkLine = (id, kind, debit, credit, date) => ({
  _id: `${id}-${debit}-${credit}`, transactionId: id, transactionType: kind,
  date: `${date}T00:00:00.000Z`, debit, credit, createdAt: `${date}T12:00:00.000Z`,
});
const asMovement = ({ lines, payments = [], receipts = [] }) => {
  const b = buildCompanyCashbook({ lines, payments, receipts, openingBalance: 0 });
  return { projectedMovement: b.closingBalance, journalMovement: b.journalClosingBalance, issueCount: b.issues.length };
};

test('FY 2025-26 closing becomes FY 2026-27 opening and then rolls again', async () => {
  const periods = new Map([
    ['2025-26', asMovement({lines:[
      mkLine('RCPT-1','RECEIPT',900,0,'2025-07-03'),
      mkLine('PAY-1','PAYMENT',0,400,'2026-03-31'),
    ]})],
    ['2026-27', asMovement({lines:[
      mkLine('SALE-1','CASH_SALE',250,0,'2026-04-01'),
      mkLine('PAY-2','PAYMENT',0,100,'2027-02-11'),
    ]})],
  ]);
  const forFY = year => rollForwardCashbook({startYear:2025,targetYear:year,initialOpening:10000,getYearMovements:async fy=>periods.get(fy)});
  const fy1=await forFY(2025),fy2=await forFY(2026),fy3=await forFY(2027);
  assert.equal(fy1.openingBalance,10000);
  assert.equal(fy2.openingBalance,10500);
  assert.equal(fy3.openingBalance,10650);
});

test('An empty previous FY carries its opening unchanged', async()=>{
  const s=await rollForwardCashbook({startYear:2025,targetYear:2027,initialOpening:700,
    getYearMovements:async()=>({projectedMovement:0,journalMovement:0,issueCount:0})});
  assert.equal(s.openingBalance,700);
});

test('Legacy self-offset payment rolls forward the source-voucher cash decrease and flags discrepancy',async()=>{
  const legacy=asMovement({lines:[
    mkLine('PAY-331','PAYMENT',40000,0,'2025-11-30'),
    mkLine('PAY-331','PAYMENT',0,40000,'2025-11-30'),
  ], payments:[{_id:'p331',paymentNo:'PAY-331',amount:40000,mode:'CASH',status:'POSTED'}]});
  assert.equal(legacy.projectedMovement,-40000);
  assert.equal(legacy.journalMovement,0);
  const result=await rollForwardCashbook({startYear:2025,targetYear:2026,initialOpening:60000,
    getYearMovements:async()=>legacy});
  assert.equal(result.openingBalance,20000);
  assert.equal(result.calculatedJournalOpeningBalance,60000);
  assert.equal(result.priorYearIssues,1);
});

test('Monthly opening includes every previous month, while rows keep their original running balance',()=>{
  const book=buildCompanyCashbook({openingBalance:1000,lines:[
    mkLine('PAY-1','PAYMENT',0,200,'2026-04-10'),
    mkLine('RC-1','RECEIPT',100,0,'2026-05-01'),
    mkLine('PAY-2','PAYMENT',0,20,'2026-05-19'),
    mkLine('RC-2','RECEIPT',30,0,'2026-06-02'),
  ]});
  const april=cashbookPeriodSnapshot({openingBalance:1000,rows:book.rows,fromDate:'2026-04-01',toDate:'2026-04-30'});
  const may=cashbookPeriodSnapshot({openingBalance:1000,rows:book.rows,fromDate:'2026-05-01',toDate:'2026-05-31'});
  const june=cashbookPeriodSnapshot({openingBalance:1000,rows:book.rows,fromDate:'2026-06-01',toDate:'2026-06-30'});
  assert.equal(april.periodOpeningBalance,1000);
  assert.equal(april.periodClosingBalance,800);
  assert.equal(may.periodOpeningBalance,800);
  assert.equal(may.periodDebitTotal,20);
  assert.equal(may.periodCreditTotal,100);
  assert.equal(may.periodClosingBalance,880);
  assert.equal(may.periodRows.at(-1).runningBalance,880);
  assert.equal(june.periodOpeningBalance,880);
  assert.equal(june.periodClosingBalance,910);
});

test('Month with no transactions shows opening and closing equal to previous month closing',()=>{
  const book=buildCompanyCashbook({openingBalance:1000,lines:[mkLine('P1','PAYMENT',0,40,'2026-04-01')]});
  const may=cashbookPeriodSnapshot({openingBalance:1000,rows:book.rows,fromDate:'2026-05-01',toDate:'2026-05-31'});
  assert.equal(may.periodEntryCount,0);
  assert.equal(may.periodOpeningBalance,960);
  assert.equal(may.periodClosingBalance,960);
});

test('Conflicting later manual FY opening is reported, not silently used to break carryforward',async()=>{
  const manual=new Map([['2025-26',1000],['2026-27',9999]]);
  const r=await rollForwardCashbook({startYear:2025,targetYear:2026,initialOpening:1000,explicitOpenings:manual,
   getYearMovements:async()=>({projectedMovement:300,journalMovement:300,issueCount:0})});
  assert.equal(r.openingBalance,1300);
  assert.deepEqual(r.mismatchedManualOpenings,[{financialYear:'2026-27',specified:9999,carried:1300}]);
});
