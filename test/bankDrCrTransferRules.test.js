import test from 'node:test';
import assert from 'node:assert/strict';
import { bankStatementOpening, bankStatementNext, bankStatementSide, bankTransferMovement } from '../src/services/bankStatementBalanceRules.js';
import { buildBookMonthSummary } from '../src/services/bookMonthSummary.js';

test('credit FY opening stays positive and debit reduces it',()=>{
  const opening=bankStatementOpening({amount:99923.59,type:'CR'});
  assert.equal(opening,99923.59);
  assert.equal(bankStatementNext(opening,52360,0),47563.59);
  assert.equal(bankStatementSide(47563.59),'Cr');
});
test('debit opening is negative and is shown as Dr until credits cover it',()=>{
  const opening=bankStatementOpening({amount:5000,type:'DR'});
  assert.equal(opening,-5000);
  assert.equal(bankStatementNext(opening,0,2000),-3000);
  assert.equal(bankStatementSide(-3000),'Dr');
});
test('monthly May debit subtracts prior April Cr closing',()=>{
  const fy=buildBookMonthSummary({financialYear:'2026-27',openingBalance:0,rows:[
    {date:'2026-04-16',credit:99923.59},
    {date:'2026-05-04',debit:52360},
  ]});
  assert.equal(fy[0].closingBalance,99923.59);
  assert.equal(fy[1].openingBalance,99923.59);
  assert.equal(fy[1].closingBalance,47563.59);
});
test('an internal transfer is debit in source, credit in destination',()=>{
  const transfer={amount:12000,fromBankAccountId:'A',toBankAccountId:'B'};
  assert.deepEqual(bankTransferMovement(transfer,'A'),{debit:12000,credit:0});
  assert.deepEqual(bankTransferMovement(transfer,'B'),{debit:0,credit:12000});
  assert.equal(bankStatementNext(70000,12000,0),58000);
  assert.equal(bankStatementNext(30000,0,12000),42000);
  assert.throws(()=>bankTransferMovement(transfer,'C'));
});
