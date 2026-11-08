import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bankStatementNext} from '../src/services/bankStatementBalanceRules.js';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');

test('A debit following a credit must decrease the statement running balance',()=>{
  assert.equal(bankStatementNext(99923.59,52360,0),47563.59);
  assert.equal(bankStatementNext(99923.59,52360,0),99923.59-52360);
  assert.equal(bankStatementNext(47563.59,0,25000),72563.59);
});

test('Own-bank transfer and cash/bank contra do NOT reject new movements because the date and amount match',()=>{
  const source=read('../src/routes/transactions.js');
  const transfer=source.split('router.post("/bank-transfer"')[1].split('router.post("/contra"')[0];
  const contra=source.split('router.post("/contra"')[1].split('router.post(')[0];
  assert.ok(transfer && contra);
  assert.doesNotMatch(transfer,/BankStatementRow\.exists/);
  assert.doesNotMatch(contra,/BankStatementRow\.exists/);
  assert.match(transfer,/BankTransfer\.findOne\(\{tenantKey,financialYear,transferNo\}\)/);
  assert.match(contra,/ContraVoucher\.findOne\(\{tenantKey:req\.auth\.tenantKey,financialYear,contraNo\}\)/);
  assert.match(transfer,/postBalancedEntries\(/);
  assert.match(contra,/postBalancedEntries\(/);
});

test('BANK/CASH click-heading editing uses original voucher+balanced journal update, not direct row mutation',()=>{
  const bank=read('../../frontend/src/pages/BankTransactionPage.jsx');
  const cash=read('../../frontend/src/pages/CashbookPage.jsx');
  const editor=read('../../frontend/src/lib/useBankCashColumnEditor.jsx');
  for (const source of [bank,cash]){
    assert.match(source,/inline\.header\(/);
    assert.match(source,/inline\.cell\(/);
    assert.match(source,/inline\.save/);
    assert.match(source,/Save All Changes/);
  }
  assert.match(editor,/\/transactions\/vouchers\/\$\{d\.kind\}\/\$\{encodeURIComponent\(d\.id\)\}\/edit/);
  assert.match(editor,/version:v\.updatedAt/);
  assert.match(editor,/reason:reason\.trim\(\)/);
  assert.match(editor,/setDrafts\(previous=>\{const next=\{\.\.\.previous\};delete next\[key\]/);
});
