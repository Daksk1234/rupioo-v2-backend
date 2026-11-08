import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  isSuperadmin,cashKey,bookKey,validateBookCorrection,applyCashCorrections,
  applyBankCorrections,reclassifiedJournal,
} from '../src/services/superadminBookCorrectionRules.js';

const fy='2024-25',base={tenantKey:'T',financialYear:fy,reason:'Correct balance',
  bookAccount:{accountCode:'SYS_CASH',bankAccountId:''},
  oldCounter:{accountCode:'SYS_SUNDRY_DEBTORS',partyGlobalId:'A'},
  newCounter:{accountCode:'SYS_SUNDRY_DEBTORS',partyGlobalId:'B'},
  makeId:(()=>{let n=0;return()=>`a${++n}`})(),
};
const signed=lines=>lines.reduce((v,x)=>v+Number(x.debit||0)-Number(x.credit||0),0);

test('only Superadmin identity can correct any source entry',()=>{
  assert.equal(isSuperadmin({role:'MASTER'}),true);
  assert.equal(isSuperadmin({role:'SUPERADMIN'}),true);
  assert.equal(isSuperadmin({role:'ACCOUNTANT',permissions:['*']}),false);
});
test('recognizes immutable CASH and BANK source keys',()=>{
  assert.equal(cashKey({transactionType:'RECEIPT',transactionId:'RCT-1'}),'CB:RECEIPT:RCT-1');
  assert.equal(bookKey({_listId:'BST:abc'},'BANK'),'BST:abc');
});
test('rejects negative, mixed-direction, imprecise and cross-FY amounts',()=>{
  for(const entry of [
    {date:'2024-05-01',debit:1,credit:1},
    {date:'2024-05-01',debit:-1,credit:0},
    {date:'2024-05-01',debit:1.001,credit:0},
    {date:'2025-04-01',debit:0,credit:10},
    {date:'2024-02-30',debit:0,credit:10},
  ])assert.throws(()=>validateBookCorrection(entry,fy));
  assert.equal(validateBookCorrection({date:'2024-05-01',debit:0,credit:10},fy).credit,10);
});
test('CASH corrections recalculate all subsequent running balances and retain particulars',()=>{
  const input=[
    {transactionType:'RECEIPT',transactionId:'R1',date:'2024-04-01',credit:100,debit:0,category:'CASH_RECEIPT',particular:'original',createdAt:'2024-04-01'},
    {transactionType:'PAYMENT',transactionId:'P1',date:'2024-05-03',debit:50,credit:0,category:'CASH_PAYMENT',particular:'purchase',createdAt:'2024-05-03'},
  ];
  const edits=[{sourceKey:'CB:RECEIPT:R1',date:'2024-04-01',credit:80,debit:0,remarks:'uploaded remarks corrected',partyName:'Party B'}];
  const actual=applyCashCorrections(input,edits,25);
  assert.equal(actual.rows[0].particular,'uploaded remarks corrected');
  assert.equal(actual.rows[0].runningBalance,105);
  assert.equal(actual.rows[1].runningBalance,55);
  assert.equal(actual.closingBalance,55);
});
test('deleting a cash receipt excludes it from visible cashbook and downstream balance',()=>{
  const row={transactionType:'RECEIPT',transactionId:'R1',date:'2024-04-01',credit:100,debit:0,category:'CASH_RECEIPT'};
  const corrected=applyCashCorrections([row],[{sourceKey:'CB:RECEIPT:R1',deleted:true}],50);
  assert.deepEqual(corrected.rows,[]);
  assert.equal(corrected.closingBalance,50);
});
test('BANK corrections preserve separate same-date entries and filter only selected row',()=>{
  const rows=[{_listId:'BST:a',credit:100,debit:0},{_listId:'BST:b',credit:100,debit:0}];
  const result=applyBankCorrections(rows,[{sourceKey:'BST:a',deleted:true}]);
  assert.deepEqual(result.map(x=>x._listId),['BST:b']);
});
test('BANK corrections may reverse direction and update amount/date/remarks',()=>{
  const rows=[{_listId:'RCT:a',date:'2024-04-01',credit:100,debit:0,remarks:'old'}];
  const actual=applyBankCorrections(rows,[{sourceKey:'RCT:a',date:'2024-05-01',credit:0,debit:80,remarks:'reversed',partyName:'Other'}]);
  assert.equal(actual[0].debit,80);assert.equal(actual[0].credit,0);
  assert.equal(actual[0].remarks,'reversed');
});
test('same-day new party receipt corrects cash difference and both party balances',()=>{
  const grouped=reclassifiedJournal({...base,oldNet:100,targetNet:80,oldDate:new Date('2024-04-03'),newDate:new Date('2024-04-03')});
  assert.equal(grouped.length,1);
  assert.equal(signed(grouped[0].lines),0);
  assert.equal(grouped[0].lines.find(x=>x.accountCode==='SYS_CASH').credit,20);
  assert.equal(grouped[0].lines.find(x=>x.partyGlobalId==='A').debit,100);
  assert.equal(grouped[0].lines.find(x=>x.partyGlobalId==='B').credit,80);
});
test('moving a receipt to a different date has a balanced reversal and replacement',()=>{
  const grouped=reclassifiedJournal({...base,oldNet:100,targetNet:80,oldDate:new Date('2024-04-03'),newDate:new Date('2024-05-03')});
  assert.equal(grouped.length,2);
  assert.equal(signed(grouped[0].lines),0);assert.equal(signed(grouped[1].lines),0);
  assert.equal(grouped[0].lines.find(x=>x.accountCode==='SYS_CASH').credit,100);
  assert.equal(grouped[1].lines.find(x=>x.accountCode==='SYS_CASH').debit,80);
});
test('deleting a posted receipt yields balanced reversal against old party',()=>{
  const grouped=reclassifiedJournal({...base,oldNet:100,targetNet:0,oldDate:new Date('2024-04-03'),newDate:new Date('2024-04-03')});
  assert.equal(grouped.length,1);assert.equal(signed(grouped[0].lines),0);
  assert.equal(grouped[0].lines.find(x=>x.accountCode==='SYS_CASH').credit,100);
  assert.equal(grouped[0].lines.find(x=>x.partyGlobalId==='A').debit,100);
});
test('correction endpoint includes full trail, journal transaction and strict Superadmin auth',()=>{
  const src=readFileSync(new URL('../src/routes/transactions.js',import.meta.url),'utf8');
  assert.match(src,/router\.post\('\/book-corrections'/);
  assert.match(src,/if\(!isSuperadmin\(req\.auth\)\)/);
  assert.match(src,/BookCorrectionAudit\.create/);
  assert.match(src,/session\.withTransaction/);
  assert.match(src,/recalculateBankRunningBalancesForVoucher/);
});
