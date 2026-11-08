import test from 'node:test';
import assert from 'node:assert/strict';
import {isLiveCashierReceipt,cashierReceiptMatchesRow,projectCashierHandover} from '../src/services/cashierReceiptProjection.js';

const receipt=(id,no,amount,mode='CASH',extras={})=>({
 _id:id,receiptNo:no,amount,mode,receiptType:mode,customerGlobalId:'QUALITY-FOODS',
 status:'POSTED',customerOtpStatus:'VERIFIED',collectionSource:'SALESPERSON_APP',...extras,
});
const row=(r,extras={})=>({receiptId:String(r._id),receiptNo:r.receiptNo,amount:r.amount,
  customerGlobalId:r.customerGlobalId,mode:r.mode,...extras});
const batch=rows=>({movementNo:'HND-001',receiptBreakdown:rows,amount:1200,cashAmount:1200});

test('deleted receipt is removed from active cashier handover',()=>{
 const deleted=receipt('aaaaaaaaaaaaaaaaaaaaaaaa','C-001',700);
 const result=projectCashierHandover(batch([row(deleted)]),[]);
 assert.equal(result.rows.length,0);
 assert.equal(result.missingReceiptCount,1);
 assert.equal(result.cashAmount,0);
 assert.equal(result.amount,0);
});
test('mixed cash and cheque handover projects only surviving original receipts',()=>{
 const cash=receipt('aaaaaaaaaaaaaaaaaaaaaaaa','C-001',700);
 const deleted=receipt('bbbbbbbbbbbbbbbbbbbbbbbb','Q-002',500,'CHEQUE');
 const r=projectCashierHandover(batch([row(cash),row(deleted)]),[cash]);
 assert.deepEqual(r.rows.map(x=>x.receiptNo),['C-001']);
 assert.equal(r.cashAmount,700);
 assert.equal(r.chequeAmount,0);
 assert.equal(r.missingReceiptCount,1);
});
test('voided and unverified receipts never resurrect from old handover snapshots',()=>{
 const r=receipt('aaaaaaaaaaaaaaaaaaaaaaaa','C-001',700);
 for(const changed of [{status:'VOIDED'},{status:'DELETED'},{customerOtpStatus:'PENDING'},{collectionSource:'DMS'}]){
   const updated={...r,...changed};
   assert.equal(isLiveCashierReceipt(updated),false);
   assert.equal(projectCashierHandover(batch([row(r)]),[updated]).rows.length,0);
 }
});
test('receipt ID is authoritative even when a replacement uses the old receipt number',()=>{
 const previous=receipt('aaaaaaaaaaaaaaaaaaaaaaaa','C-001',700);
 const replacement=receipt('bbbbbbbbbbbbbbbbbbbbbbbb','C-001',700);
 assert.equal(cashierReceiptMatchesRow(row(previous),replacement),false);
 assert.equal(projectCashierHandover(batch([row(previous)]),[replacement]).rows.length,0);
});
test('snapshot cannot belong to a different customer or amount',()=>{
 const r=receipt('aaaaaaaaaaaaaaaaaaaaaaaa','C-001',700);
 assert.equal(cashierReceiptMatchesRow(row(r,{customerGlobalId:'BAHL-PAPER-MILLS'}),r),false);
 assert.equal(cashierReceiptMatchesRow(row(r,{amount:701}),r),false);
});
test('CHEQUE needs a live cheque receipt, not an online bank payment',()=>{
 const r=receipt('aaaaaaaaaaaaaaaaaaaaaaaa','Q-002',500,'BANK',{receiptType:'CHEQUE'});
 const okRow=row(r,{mode:'CHEQUE'});
 assert.equal(cashierReceiptMatchesRow(okRow,r),true);
 assert.equal(cashierReceiptMatchesRow(okRow,{...r,receiptType:'ONLINE'}),false);
 const p=projectCashierHandover(batch([okRow]),[r]);
 assert.equal(p.chequeAmount,500);
});
test('cashbook amounts always reflect live source receipt totals',()=>{
 const good=receipt('aaaaaaaaaaaaaaaaaaaaaaaa','C-001',700);
 const deleted=receipt('bbbbbbbbbbbbbbbbbbbbbbbb','C-002',500);
 const p=projectCashierHandover(batch([row(good),row(deleted)]),[good]);
 assert.equal(p.amount,700);
 assert.equal(p.missingReceiptCount,1);
});
test('empty handovers have no missing references',()=>{
 assert.deepEqual(projectCashierHandover(batch([]),[]).rows,[]);
 assert.equal(projectCashierHandover(batch([]),[]).missingReceiptCount,0);
});
