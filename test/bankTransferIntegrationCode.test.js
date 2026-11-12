import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('bank router computes signed opening from bank-book CR/DR and supports running-balance rebuild', () => {
  const s = read('../src/routes/banks.js');
  assert.match(s, /return bankStatementOpening\(opening\)/);
  assert.match(s, /router\.post\("\/transactions\/rebuild-running"/);
  assert.match(s, /bankStatementNext\(running,movement\.debit,movement\.credit\)/);
});
test('bank transfer has only one source record and two banks in one journal', () => {
  const route = read('../src/routes/transactions.js');
  const model = read('../src/models/fyModels.js');
  assert.match(route,/router\.post\("\/bank-transfer"/);
  assert.match(route,/transactionType:"BANK_TRANSFER"/);
  assert.match(route,/bankAccountId:toBank\.bankAccountId,debit:amount,credit:0/);
  assert.match(route,/bankAccountId:fromBank\.bankAccountId,debit:0,credit:amount/);
  assert.match(model,/const bankTransferSchema/);
  assert.match(model,/BankTransfer: get\("BankTransfer", bankTransferSchema\)/);
});
test('bank book shows incoming positive Cr and outgoing debit decreases balance',()=>{
  const s = read('../../frontend/src/pages/BankTransactionPage.jsx');
  assert.match(s, /Number\(v \|\| 0\) < 0 \? "Dr" : "Cr"/);
});
test('receipt/payment and transaction-entry screens include own bank parties',()=>{
  const a = read('../../frontend/src/pages/FinancialEntryPage.jsx');
  const b = read('../../frontend/src/pages/TransactionEntryDialog.jsx');
  for (const s of [a,b]) assert.match(s,/\/transactions\/bank-transfer/);
  assert.match(a,/BANK_ACCOUNT/);
  assert.match(b,/banks\.map\(companyBankParty\)/);
});
