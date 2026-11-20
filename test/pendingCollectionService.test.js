import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPendingCollectionDocuments,selectCollectionDocuments} from '../src/services/pendingCollectionService.js';
import {collectorTerritoryFilter,collectorForCustomerFilter} from '../src/services/collectorTerritoryService.js';
import {matchesMongo} from './helpers/mongoPredicate.js';
import {receiptIsVerified,collectionConfirmationFilter} from '../src/services/collectionHubRules.js';
const order=(extra={})=>({_id:'ORDER-ID',orderNo:'ORD-1',financialYear:'2026-27',date:'2026-04-01',status:'SUBMITTED',workflowStatus:'ORDER_PLACED',grandTotal:500,...extra});
const invoice=(extra={})=>({_id:'INV-ID',invoiceNo:'INV-1',financialYear:'2026-27',date:'2026-04-02',status:'POSTED',grandTotal:500,...extra});
const allocation={kind:'ORDER',documentId:'ORDER-ID',financialYear:'2026-27',canonicalKey:'ORDER:2026-27:ORDER-ID',amount:200};
const receipt=(extra={})=>({receiptNo:'RCT-1',financialYear:'2026-27',amount:200,status:'POSTED',collectionSource:'SALESPERSON_APP',
 customerOtpStatus:'VERIFIED',againstDocuments:[allocation],...extra});

test('collector access follows assigned pincodes, independent of customer or salesperson IDs',()=>{
 const territory=collectorTerritoryFilter(['781001','781002','781001']);
 assert.equal(matchesMongo({addresses:[{pincode:'781002'}]},territory),true);
 assert.equal(matchesMongo({addresses:[{pincode:'110001'}]},territory),false);
 assert.deepEqual(collectorTerritoryFilter([]),{'addresses.pincode':{$in:[]}});
 assert.deepEqual(collectorForCustomerFilter({globalCustomerId:'CUSTOMER',addresses:[{pincode:'781001'},{pincode:'781002'}]}),
  {collectorPincodes:{$in:['781001','781002']}});
});
test('new orders are collectible immediately and conversion into invoices does not duplicate their balance',()=>{
 assert.equal(buildPendingCollectionDocuments({orders:[order()]})[0].outstanding,500);
 const documents=buildPendingCollectionDocuments({orders:[order()],invoices:[invoice({sourceOrderId:'ORDER-ID'})]});
 assert.equal(documents.length,1);assert.equal(documents[0].kind,'ORDER');assert.equal(documents[0].outstanding,500);
 assert.deepEqual(documents[0].invoiceNumbers,['INV-1']);
});

test('an imported customer with only an unpaid opening balance remains visible without enabling advance receipts',()=>{
 const documents=buildPendingCollectionDocuments({openingBalance:1200,openingFinancialYear:'2025-26'});
 assert.equal(documents.length,1);assert.equal(documents[0].kind,'OPENING_BALANCE');assert.equal(documents[0].outstanding,1200);
 assert.equal(documents[0].referenceRequired,true);assert.equal(documents[0].selectable,false);
 assert.throws(()=>selectCollectionDocuments({documents},[{canonicalKey:documents[0].canonicalKey}]),/Link.*invoice, order or debit note/);
});

test('unallocated ledger credits settle the opening balance first without reducing new invoices twice',()=>{
 const documents=buildPendingCollectionDocuments({openingBalance:700,openingFinancialYear:'2025-26',invoices:[invoice()],
  ledger:[{transactionType:'RECEIPT',credit:200}]});
 assert.equal(documents[0].kind,'OPENING_BALANCE');assert.equal(documents[0].outstanding,500);
 assert.equal(documents[1].outstanding,500);assert.equal(documents.reduce((sum,row)=>sum+row.outstanding,0),1000);
 const cleared=buildPendingCollectionDocuments({openingBalance:700,ledger:[{transactionType:'RECEIPT',credit:700}]});
 assert.equal(cleared.length,0);
});

test('a receipt explicitly settling an invoice leaves the opening balance unpaid',()=>{
 const documents=buildPendingCollectionDocuments({openingBalance:700,openingFinancialYear:'2025-26',invoices:[invoice()],
  receipts:[receipt({againstDocuments:[],againstInvoices:[{invoiceId:'INV-ID',amount:200}],ledgerPostedAt:'2026-04-04'})],
  ledger:[{transactionType:'RECEIPT',transactionId:'RCT-1',financialYear:'2026-27',credit:200}]});
 assert.equal(documents[0].outstanding,700);assert.equal(documents[1].outstanding,300);
});

test('historical invoice references and their carried opening balance are recognized once',()=>{
 const old=invoice({financialYear:'2025-26',date:'2025-11-01'});
 const documents=buildPendingCollectionDocuments({openingBalance:500,openingFinancialYear:'2026-27',invoices:[old]});
 assert.equal(documents.length,1);assert.equal(documents[0].kind,'INVOICE');assert.equal(documents[0].outstanding,500);
 const partial=buildPendingCollectionDocuments({openingBalance:700,openingFinancialYear:'2026-27',invoices:[old]});
 assert.equal(partial.reduce((sum,row)=>sum+row.outstanding,0),700);
 assert.equal(partial.find(row=>row.kind==='OPENING_BALANCE').outstanding,200);
});

test('credits already included in an opening balance are not deducted again from that balance',()=>{
 const documents=buildPendingCollectionDocuments({openingBalance:700,openingFinancialYear:'2026-27',
  ledger:[{financialYear:'2025-26',transactionType:'RECEIPT',credit:200},{financialYear:'2026-27',transactionType:'RECEIPT',credit:50}]});
 assert.equal(documents[0].outstanding,650);
});

test('the opening-year boundary reconciles historical balances while preserving current invoices',()=>{
 const old=invoice({financialYear:'2025-26',date:'2025-11-01'}),current=invoice({_id:'CURRENT',invoiceNo:'CURRENT',grandTotal:200});
 const documents=buildPendingCollectionDocuments({openingBalance:300,openingFinancialYear:'2026-27',invoices:[old,current]});
 assert.equal(documents.reduce((sum,row)=>sum+row.outstanding,0),500);assert.equal(documents[0].outstanding,300);
 assert.equal(documents[1].outstanding,200);
});
test('order invoices through delivery remain in the order section; final invoice value replaces unbilled exposure',()=>{
 const invoices=[invoice({sourceOrderId:'ORDER-ID',grandTotal:450})];
 assert.equal(buildPendingCollectionDocuments({orders:[order()],invoices})[0].total,500);
 const delivered=buildPendingCollectionDocuments({orders:[order({workflowStatus:'DELIVERED'})],invoices});
 assert.equal(delivered[0].total,450);assert.equal(delivered[0].kind,'ORDER');
});
test('direct invoices and debit notes are independently selectable while drafts/cancelled orders are excluded',()=>{
 const documents=buildPendingCollectionDocuments({invoices:[invoice()],orders:[order({status:'CANCELLED'})],
  notes:[{_id:'DN',documentNo:'DN-1',documentType:'DEBIT_NOTE',financialYear:'2026-27',date:'2026-04-03',status:'ISSUED',grandTotal:75}]});
 assert.equal(documents.length,2);assert.equal(documents[1].kind,'DEBIT_NOTE');assert.equal(documents[1].selectable,true);
 assert.equal(selectCollectionDocuments({documents},documents.map(row=>({canonicalKey:row.canonicalKey}))).length,2);
});
test('customer-verified cash is reserved until ledger posting and cannot be collected twice',()=>{
 const documents=buildPendingCollectionDocuments({orders:[order()],receipts:[receipt()]});
 assert.equal(documents[0].outstanding,500);assert.equal(documents[0].reserved,200);assert.equal(documents[0].availableAmount,300);
 assert.equal(documents[0].selectable,false);assert.throws(()=>selectCollectionDocuments({documents},[{canonicalKey:allocation.canonicalKey}]),/already being collected/);
});
test('cancellation and expiry release pending collection without reducing any ledger balance',()=>{
 for(const row of [receipt({status:'CANCELLED'}),receipt({status:'PENDING_VERIFICATION',customerOtpStatus:'PENDING',customerOtpExpiresAt:'2020-01-01'})]){
  const document=buildPendingCollectionDocuments({orders:[order()],receipts:[row]})[0];
  assert.equal(document.outstanding,500);assert.equal(document.availableAmount,500);assert.equal(document.selectable,true);
 }
});

test('a bounced cheque releases its original documents and a posted principal reversal reopens the balance',()=>{
 for(const row of [receipt({chequeStatus:'BOUNCED'}),receipt({receiptWorkflowStatus:'BOUNCE_POSTED'})]){
  const document=buildPendingCollectionDocuments({orders:[order()],receipts:[row]})[0];
  assert.equal(document.outstanding,500);assert.equal(document.reserved,0);assert.equal(document.selectable,true);
 }
 const document=buildPendingCollectionDocuments({orders:[order()],receipts:[receipt({ledgerPostedAt:'2026-04-03',chequeStatus:'BOUNCED'})],
  ledger:[{transactionType:'RECEIPT',transactionId:'RCT-1',financialYear:'2026-27',credit:200},
   {transactionType:'CHEQUE_BOUNCE_REVERSAL',debit:200}]})[0];
 assert.equal(document.outstanding,500);
});
test('a posted document allocation and its journal credit reduce pending only once',()=>{
 const documents=buildPendingCollectionDocuments({orders:[order()],receipts:[receipt({ledgerPostedAt:'2026-04-04'})],
  ledger:[{transactionType:'RECEIPT',transactionId:'RCT-1',financialYear:'2026-27',credit:200}]});
 assert.equal(documents[0].outstanding,300);assert.equal(documents[0].reserved,0);
});
test('order collections keep their identity across invoicing and financial years',()=>{
 const old=order({financialYear:'2025-26'}),oldAllocation={...allocation,financialYear:'2025-26',canonicalKey:'ORDER:2025-26:ORDER-ID'};
 const documents=buildPendingCollectionDocuments({orders:[old],invoices:[invoice({sourceOrderId:'ORDER-ID'})],
  receipts:[receipt({againstDocuments:[oldAllocation],ledgerPostedAt:'2026-04-01'})]});
 assert.equal(documents.length,1);assert.equal(documents[0].outstanding,300);assert.equal(documents[0].canonicalKey,oldAllocation.canonicalKey);
});
test('credit notes reduce the invoice once and unallocated credits settle oldest documents',()=>{
 const documents=buildPendingCollectionDocuments({invoices:[invoice({creditNoteAmount:50})],
  notes:[{documentType:'CREDIT_NOTE',invoiceId:'INV-ID',financialYear:'2026-27',grandTotal:50,status:'ISSUED'}],
  ledger:[{transactionType:'SALES_CREDIT_NOTE',credit:50},{transactionType:'RECEIPT',credit:100}]});
 assert.equal(documents[0].total,450);assert.equal(documents[0].outstanding,350);
});
test('overpayments, duplicate selections and fractions of a paisa are rejected',()=>{
 const documents=buildPendingCollectionDocuments({orders:[order()]});
 assert.throws(()=>selectCollectionDocuments({documents},[{canonicalKey:allocation.canonicalKey,amount:501}]),/exceeds/);
 assert.throws(()=>selectCollectionDocuments({documents},[{canonicalKey:allocation.canonicalKey,amount:100.001}]),/decimal/);
 assert.throws(()=>selectCollectionDocuments({documents},[{canonicalKey:allocation.canonicalKey},{canonicalKey:allocation.canonicalKey}]),/duplicated/);
});
test('online proof uses direct submission without pretending an OTP was verified',()=>{
 const online={status:'POSTED',mode:'BANK',receiptType:'UPI',customerOtpStatus:'NOT_REQUIRED',customerConfirmationMethod:'ONLINE_PROOF',paymentProofFileId:'PROOF'};
 assert.equal(receiptIsVerified(online),true);assert.equal(receiptIsVerified({...online,paymentProofFileId:''}),false);
 assert.equal(receiptIsVerified({...online,receiptType:'CHEQUE'}),false);assert.equal(receiptIsVerified({...online,mode:'CASH'}),false);
 assert.equal(collectionConfirmationFilter.$or.length,2);
});
