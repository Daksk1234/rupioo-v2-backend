import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const sales = readFileSync(new URL('../src/routes/salesApp.js', import.meta.url),'utf8');
const transactions = readFileSync(new URL('../src/routes/transactions.js', import.meta.url),'utf8');
const cheque = readFileSync(new URL('../src/routes/cheques.js', import.meta.url),'utf8');
const collector = readFileSync(new URL('../../collector-app/src/screens/cash/CashHandoverScreen.js', import.meta.url),'utf8');
const received = readFileSync(new URL('../../frontend/src/pages/ChequeControlPage.jsx', import.meta.url),'utf8');
const cashier = readFileSync(new URL('../../frontend/src/pages/CashierPendingHandover.jsx', import.meta.url),'utf8');
const between = (text,start,end) => text.slice(text.indexOf(start), text.indexOf(end,text.indexOf(start)));
test('collector handover preview uses physical cheque instrument type, not BANK mode alone',()=>{
  const portion = between(sales,'router.get("/cash/deposit-preview"','router.get("/cash/issues"');
  assert.match(portion,/upper\(r\.receiptType\) === "CHEQUE" \|\| upper\(r\.mode\) === "CHEQUE" \? "CHEQUE" : "CASH"/);
  assert.match(portion,/disputeStatus: \{ \$ne: "HOLD" \}/);
});
test('a collector handover records cash and cheques in the same immutable receipt bundle',()=>{
  const portion=between(sales,'router.post("/cash/handover"','router.post("/cash/handovers/:movementId/otp/verify"');
  assert.match(portion,/const chequeReceipts=receipts\.filter/);
  assert.match(portion,/cashAmount, bankAmount/);
  assert.match(portion,/cashDepositStatus:'HANDOVER_PENDING'/);
  assert.match(portion,/handoverOtpStatus: "PENDING"/);
});
test('customer OTP receipt finalization is not the cashier day close',()=>{
  const portion=readFileSync(new URL('../src/services/salespersonReceiptWorkflowService.js',import.meta.url),'utf8');
  assert.match(portion,/Customer OTP permits custody handover; it is NOT ledger posting/);
  assert.match(portion,/ledgerPostedAt.*Receipt\.updateOne/s);
});
test('collector enters cashier batch OTP before cashier may physically accept',()=>{
  const portion=between(transactions,'router.post("/cashier/handovers/:id/receive"','router.post("/cashier/ledger-confirm"');
  assert.match(portion,/handoverOtpStatus !== "VERIFIED"/);
  assert.match(portion,/movement\.status = "APPROVED"/);
  assert.doesNotMatch(portion,/postCustodyApprovedReceipt/);
});
test('cashier close is the only stage posting cash and transferring collector cheques',()=>{
  const portion=between(transactions,'router.post("/cashier/close"','router.get("/payments"');
  assert.match(portion,/postCustodyApprovedReceipt/);
  assert.match(portion,/CASHIER-CLOSE:/);
  assert.match(portion,/chequeApprovalStatus:'APPROVED'/);
  assert.match(portion,/cashierReceivedBy:cleanText\(req\.auth\.sub\)/);
});
test('cancel pending mixed handover releases both cash and linked cheque custody',()=>{
  const portion=between(transactions,"router.delete('/cashier/handovers/:id'",'router.post("/cashier/handovers/:id/otp/refresh"');
  assert.match(portion,/cashDepositStatus:'PENDING_TO_DEPOSIT'/);
  assert.match(portion,/resource:'cheque-control-received'/);
  assert.match(portion,/PENDING_WITH_COLLECTOR/);
});
test('Superadmin-only void and edit cannot silently change verified customer or amount',()=>{
  const portion=between(transactions,"router.patch('/cashier/receipts/:id/superadmin-correct'",'// Receipt disputes are separate');
  assert.equal((portion.match(/SUPERADMIN'\)return fail\(res,'Superadmin only'/g)||[]).length,2);
  assert.match(portion,/status:'VOID'/);
  assert.doesNotMatch(portion,/original\.amount\s*=|original\.customerGlobalId\s*=/);
});
test('legacy cheque approval shortcuts are disabled',()=>{
  for(const route of ["router.post('/cashier/collect-cheques'","router.post('/pending-approvals/:id/verify'"]){
    const start=cheque.indexOf(route);
    assert.notEqual(start,-1);
    assert.match(cheque.slice(start,start+440),/Legacy cheque approval is retired[^\n]+410/);
  }
  assert.doesNotMatch(received,/changeTab\('approvals'\)/);
});
test('Cashier pending handover does not initiate collection or prematurely post receipt',()=>{
  assert.match(cashier,/Collector initiates Deposit to Cashier/);
  assert.doesNotMatch(cashier,/cashier\/ledger-confirm|cashier\/collect-cash|cheques\/cashier\/collect-cheques/);
});
test('Collector App includes both cash and cheque and no online in physical handover',()=>{
  assert.match(collector,/\["CASH","CHEQUE"\]/);
  assert.match(collector,/const cash=selectedRows/);
  assert.match(collector,/const autoDenominations/);
  assert.doesNotMatch(collector,/\["CASH","CHEQUE","ONLINE"\]/);
});
test('Collector App does not silently cancel cashier OTP handover when returning to screen',()=>{
  const load=between(collector,'const load=useCallback','useFocusEffect(');
  assert.match(load,/cash\/handovers\/pending-otp/);
  assert.doesNotMatch(load,/otp\/restart/);
  assert.match(collector,/CANCEL & RESTART/);
  assert.match(sales,/router.get\("\/cash\/handovers\/pending-otp"/);
});
