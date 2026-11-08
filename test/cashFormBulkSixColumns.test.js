import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {detectCashBulkParty, cashBulkMode, cashBulkAmount} from '../src/services/cashBulkPartyMatcher.js';
const source=(relative)=>readFileSync(new URL(relative,import.meta.url),'utf8');
const directory=[
 {name:'Quality Foods',id:'QF-1',type:'CUSTOMER'},
 {name:'Bahl Paper Mills',id:'BP-2',type:'CUSTOMER'},
 {name:'Bishnupur Furniture',id:'USER:111',type:'USER'},
];
test('CASH Create Transaction has BANK-style fields without extra debit/credit/party-type controls',()=>{
 const ui=source('../../frontend/src/pages/TransactionEntryDialog.jsx');
 assert.match(ui,/<th>Party Name \*<\/th><th>Receipt \/ Payment \*<\/th>/);
 assert.match(ui,/\{isBank&&<th>Bank Account \*<\/th>\}/);
 assert.match(ui,/<th>Amount \*<\/th><th>Remarks<\/th>/);
 assert.doesNotMatch(ui,/<th>Particulars \*<\/th>/);
 assert.match(ui,/transactionType:r\.transactionType/);
 assert.match(ui,/mode:isBank\?"BANK":"CASH"/);
});
test('CASH template has EXACT six columns, ordered',()=>{
 const ui=source('../../frontend/src/pages/TransactionEntryDialog.jsx');
 const cashTemplate=ui.match(/channel==="cash"\?\[(.*?)\]:\[/s);
 assert.ok(cashTemplate);
 assert.equal(cashTemplate[1],'"Date","Party Name","Remarks","Mode","Debit","Credit"');
 const cashbookTemplate=source('../../frontend/src/pages/CashbookBulkPage.jsx');
 assert.match(cashbookTemplate,/\['Date','Party Name','Remarks','Mode','Debit','Credit'\]/);
});
test('From Remarks, unique exact whole-name match auto-fills the correct party ID',()=>{
 assert.equal(detectCashBulkParty({remarks:'CASH paid to Quality Foods - branch 2'},directory)?.id,'QF-1');
 assert.equal(detectCashBulkParty({remarks:'BISHNUPUR FURNITURE -Furniture mistri'},directory)?.id,'USER:111');
});
test('Explicitly selected party wins even if Remarks mention another party',()=>{
 assert.equal(detectCashBulkParty({partyName:'Quality Foods',remarks:'Bahl Paper Mills'},directory)?.id,'QF-1');
 assert.equal(detectCashBulkParty({partyName:'Nonexistent Corp',remarks:'Quality Foods'},directory),null);
});
test('Ambiguous or absent narration never guesses a ledger',()=>{
 assert.equal(detectCashBulkParty({remarks:'Paid to Quality Foods and Bahl Paper Mills'},directory),null);
 assert.equal(detectCashBulkParty({remarks:'Petrol for vehicle'},directory),null);
 assert.equal(detectCashBulkParty({remarks:'Cash purchase'},directory),null);
});
test('CASH import direction and Mode reject bank rows',()=>{
 for(const mode of ['CASH','cash','RECEIPT','PAYMENT'])assert.equal(cashBulkMode(mode),'CASH');
 assert.throws(()=>cashBulkMode('BANK'),/not CASH/);
 assert.throws(()=>cashBulkMode('UPI'),/not CASH/);
 assert.equal(cashBulkAmount('52,360.00'),52360);
 assert.throws(()=>cashBulkAmount('-30'),/non-negative/);
 assert.throws(()=>cashBulkAmount('abc'),/non-negative/);
});
test('CASH bulk route derives receipt/payment from debit/credit, uses stable same-file id and preserves bank flow',()=>{
 const api=source('../src/routes/transactions.js');
 assert.match(api,/const fields=channel==="cash"\?\[/);
 assert.match(api,/input\.transactionType=debit>0\?"PAYMENT":"RECEIPT"/);
 assert.match(api,/detectCashBulkParty\(input,directory\)/);
 assert.match(api,/input\.partyType="OTHER";input\.cashMatchSource="SUSPENSE"/);
 assert.match(api,/if\(input\.cashMatchSource==="SUSPENSE"\)postedToSuspense\+\+/);
 assert.match(api,/input\[input\.transactionType==='PAYMENT'\?'paymentNo':'receiptNo'\]/);
 assert.match(api,/if\(channel==="bank"\)bankYears\.set/);
});
