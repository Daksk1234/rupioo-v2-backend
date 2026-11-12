import test from 'node:test';
import assert from 'node:assert/strict';
import transactions from '../src/routes/transactions.js';
import {financialModels} from '../src/services/accountingService.js';
import {cashbookImportVoucherNo} from '../src/services/cashbookImportIdentity.js';
import {CustomerLink,GenericRecord,BankAccount} from '../src/models/index.js';
import mongoose from 'mongoose';
import workflow from '../src/routes/collectionWorkflow.js';
import {buildCashbookView,loadCashbookSourceRows,isCashbookReceipt} from '../src/services/cashbookViewService.js';

// Run the real route, voucher validation and journal builder with an isolated
// transactional store. No connection to the configured company database.
const query=value=>({lean:async()=>value,session(){return this},select(){return this},sort(){return this},
  then(resolve,reject){return Promise.resolve(value).then(resolve,reject)}});
const handler=transactions.stack.find(x=>x.route?.path==='/cashbook/bulk-post').route.stack[0].handle;
const invoke=async body=>{
  const req={body,auth:{tenantKey:'CASHBOOK_INTEGRATION_TEST',role:'SUPERADMIN',permissions:['*'],sub:'admin',name:'Admin'}};
  const res={status(n){this.statusCode=n;return this},json(payload){this.payload=payload;return this}};
  await handler(req,res);return res;
};

test('cashbook loads posted cash/bank journals without a receipts collection and never posts them again',async t=>{
 const tenantKey='CASHBOOK_BANK_DEPOSIT_TEST',financialYear='2026-27';
 const models=financialModels(tenantKey,financialYear);
 const ledger=[{_id:'cash-deposit',tenantKey,financialYear,transactionId:'CTR-1',transactionType:'CONTRA',
  accountCode:'SYS_CASH',status:'POSTED',date:new Date('2026-11-07'),debit:0,credit:300}];
 t.mock.method(CustomerLink,'find',()=>query([]));
 t.mock.method(mongoose.connection,'getClient',()=>({db:()=>({listCollections:({name})=>({hasNext:async()=>name==='ledgerentries'})})}));
 t.mock.method(models.Receipt,'find',()=>assert.fail('A missing receipts collection must not be queried'));
 t.mock.method(models.LedgerEntry,'insertMany',()=>assert.fail('Reading cashbook must not repost bank deposits'));
 t.mock.method(models.LedgerEntry,'find',filter=>{
  assert.equal(filter.tenantKey,tenantKey);assert.equal(filter.financialYear,financialYear);
  assert.equal(filter.status,'POSTED');assert.deepEqual(filter.accountCode.$in,['SYS_CASH','SYS_BANK_ACCOUNT','SYS_BANK_OD']);
  assert.deepEqual(filter.transactionType.$in,['CONTRA','SALESPERSON_BANK_DEPOSIT','CASH_BANK_DEPOSIT','BANK_CASH_WITHDRAWAL','RECEIPT','PAYMENT']);
  return query(ledger);
 });
 const sources=await loadCashbookSourceRows({tenantKey,financialYear});
 const book=buildCashbookView({...sources,openingBalance:1000});
 assert.equal(book.rows.length,1);assert.equal(book.rows[0].transactionId,'CTR-1');
 assert.equal(book.rows[0].debit,300);assert.equal(book.rows[0].credit,0);assert.equal(book.closingBalance,700);
 assert.equal(ledger.length,1);
});

test('cashbook source loading includes every posted Cash voucher and preserves the bank-account particulars',async t=>{
 const tenantKey='ALL_CASH_VOUCHERS_TEST',financialYear='2026-27',models=financialModels(tenantKey,financialYear);
 const receipts=[{_id:'r1',receiptNo:'R1',date:'2026-04-01',amount:100,mode:'CASH',status:'POSTED',partyNameSnapshot:'Customer'},
  {_id:'r2',receiptNo:'R2',date:'2026-05-02',amount:250,mode:'CASH',status:'POSTED',partyType:'BANK_ACCOUNT',partyNameSnapshot:'Company Bank'}];
 const payments=[{_id:'p1',paymentNo:'P1',date:'2026-06-01',amount:300,mode:'CASH',status:'POSTED',partyNameSnapshot:'Supplier'},
  {_id:'p2',paymentNo:'P2',date:'2026-07-02',amount:200,mode:'CASH',status:'POSTED',partyNameSnapshot:'Company Bank'}];
 const ledger=[{_id:'bank-payment',transactionId:'P2',transactionType:'PAYMENT',date:'2026-07-02',accountCode:'SYS_BANK_ACCOUNT',bankAccountId:'BANK-1',status:'POSTED',debit:200,credit:0},
  {_id:'contra-cash',transactionId:'CTR-1',transactionType:'CONTRA',date:'2026-11-02',accountCode:'SYS_CASH',status:'POSTED',debit:0,credit:20},
  {_id:'contra-bank',transactionId:'CTR-1',transactionType:'CONTRA',date:'2026-11-02',accountCode:'SYS_BANK_ACCOUNT',bankAccountId:'BANK-1',status:'POSTED',debit:20,credit:0}];
 t.mock.method(CustomerLink,'find',()=>query([]));
 t.mock.method(mongoose.connection,'getClient',()=>({db:()=>({listCollections:({name})=>({hasNext:async()=>['receipts','payments','ledgerentries'].includes(name)})})}));
 for(const [Model,rows] of [[models.Receipt,receipts],[models.Payment,payments]])t.mock.method(Model,'find',filter=>{
  assert.deepEqual(filter,{tenantKey,financialYear,mode:'CASH',status:'POSTED'});return query(rows);
 });
 t.mock.method(models.LedgerEntry,'find',()=>query(ledger));
 t.mock.method(models.LedgerEntry,'insertMany',()=>assert.fail('A source projection must not write a second journal'));
 t.mock.method(BankAccount,'find',filter=>{
  assert.deepEqual(filter,{tenantKey,bankAccountId:{$in:['BANK-1']}});
  return query([{bankAccountId:'BANK-1',bankName:'Company Bank',accountNumber:'123456'}]);
 });
 const book=buildCashbookView({...await loadCashbookSourceRows({tenantKey,financialYear}),openingBalance:1000});
 assert.equal(book.rows.length,5);assert.equal(book.closingBalance,830);
 assert.deepEqual(book.rows.map(row=>[row.transactionId,row.category,row.debit,row.credit]),[
  ['R1','CASH_RECEIPT',0,100],['R2','CONTRA_IN',0,250],['P1','CASH_PAYMENT',300,0],
  ['P2','CONTRA_OUT',200,0],['CTR-1','CONTRA_OUT',20,0],
 ]);
 assert.equal(book.rows.at(-1).partyName,'Company Bank · A/C 123456');
});

test('partial cash upload commits valid rows atomically, retains failed rows, and retry never posts a success twice',async t=>{
  const models=financialModels('CASHBOOK_INTEGRATION_TEST','2026-27');
  let vouchers=[],journals=[],failRow=true;
  const importId='c'.repeat(64),failingNo=cashbookImportVoucherNo('CASHBOOK_INTEGRATION_TEST',importId,3,'RECEIPT');
  const session={async withTransaction(fn){const beforeV=[...vouchers],beforeJ=[...journals];
    try{await fn()}catch(e){vouchers=beforeV;journals=beforeJ;throw e}},async endSession(){}};
  t.mock.method(models.Receipt.db,'startSession',async()=>session);
  for(const Model of [models.Receipt,models.Payment,models.LedgerEntry])t.mock.method(Model,'init',async()=>{});
  t.mock.method(models.Receipt,'findOne',filter=>query(vouchers.find(x=>filter.receiptNo.$in.includes(x.receiptNo))||null));
  t.mock.method(models.Receipt,'create',async(rows,options)=>{
    assert.equal(options.session,session);
    const record={...rows[0],toObject(){return {...rows[0]}}};vouchers.push(record);return [record];
  });
  t.mock.method(models.LedgerEntry,'find',filter=>query(filter.status==='POSTED'?journals.filter(x=>x.transactionId===filter.transactionId):[]));
  t.mock.method(models.LedgerEntry,'exists',async filter=>journals.some(x=>x.transactionId===filter.transactionId));
  t.mock.method(models.LedgerEntry,'insertMany',async(rows,options)=>{
    assert.equal(options.session,session);
    if(failRow&&rows[0].transactionId===failingNo)throw new Error('Simulated journal failure');
    journals.push(...rows);return rows;
  });
  const rows=[2,3,4].map(rowNo=>({rowNo,date:rowNo===4?'2026-02-30':'2026-11-07',
    particulars:'  Cash  received\nfrom unknown party  ',partyName:'Unidentified cash counterparty',partyType:'OTHER',debit:0,credit:30,mode:'CASH'}));
  const first=await invoke({importId,rows});
  assert.equal(first.statusCode,201);assert.equal(first.payload.data.inserted,1);
  assert.deepEqual(first.payload.data.postedRows,[2]);assert.equal(first.payload.data.errors.length,2);
  assert.equal(vouchers.length,1);assert.equal(journals.length,2);
  assert.equal(vouchers[0].remarks,rows[0].particulars);
  assert.equal(journals.find(x=>x.accountCode==='SYS_CASH').debit,30);
  assert.equal(journals.find(x=>x.accountCode==='SYS_SUSPENSE').credit,30);
  failRow=false;
  const retry=await invoke({importId,rows:rows.slice(0,2)});
  assert.equal(retry.payload.data.skipped,1);assert.equal(retry.payload.data.inserted,1);
  assert.deepEqual(retry.payload.data.postedRows,[2,3]);assert.deepEqual(retry.payload.data.errors,[]);
  assert.equal(vouchers.length,2);assert.equal(journals.length,4);
  assert.equal(journals.reduce((n,x)=>n+x.debit-x.credit,0),0);
  const manual=transactions.stack.find(x=>x.route?.path==='/manual-entry/:channel').route.stack[0].handle;
  const res={status(n){this.statusCode=n;return this},json(payload){this.payload=payload;return this}};
  await manual({params:{channel:'cash'},auth:{tenantKey:'CASHBOOK_INTEGRATION_TEST',role:'SUPERADMIN',permissions:['*'],sub:'admin'},
    body:{date:'2026-11-07',transactionType:'RECEIPT',partyName:'Unknown counterparty',partyType:'OTHER',amount:40,
      mode:'CASH',creationSource:'UNTRUSTED_CLIENT_VALUE'}},res);
  assert.equal(res.statusCode,201);assert.equal(res.payload.data.record.creationSource,'CASHBOOK_CREATE_TRANSACTION');
  assert.equal(isCashbookReceipt(res.payload.data.record),true);
  const current=buildCashbookView({receipts:vouchers});
  assert.equal(current.rows.length,3);assert.equal(current.closingBalance,100);
});

test('Cashier Post to Ledger posts cash and customer atomically, appears in Cashbook on accounting date, and retries once',async t=>{
  const tenantKey='CASHIER_POST_INTEGRATION_TEST',financialYear='2026-27',receiptId='c'.repeat(24),batchId='d'.repeat(24);
  const models=financialModels(tenantKey,financialYear);
  let receipt={_id:receiptId,receiptNo:'COL-POST',customerGlobalId:'CUSTOMER-1',amount:120,mode:'CASH',status:'POSTED',
    date:new Date('2026-11-01'),cashDepositedAt:new Date('2026-11-02'),customerOtpStatus:'VERIFIED',
    collectionSource:'SALESPERSON_APP',cashDepositStatus:'DEPOSITED_TO_CASHIER',cashDepositBatchId:batchId,receiptWorkflowStatus:'COMPLETED'};
  const batch={_id:batchId,status:'APPROVED',cashierReceivedBy:'cashier',receiptBreakdown:[{
    receiptId,receiptNo:receipt.receiptNo,customerGlobalId:receipt.customerGlobalId,amount:120,mode:'CASH'}]};
  let journals=[],fail=true;
  const session={async withTransaction(fn){const before=structuredClone({receipt,journals});
    try{await fn()}catch(e){({receipt,journals}=before);throw e}},async endSession(){}};
  t.mock.method(models.LedgerEntry.db,'startSession',async()=>session);
  t.mock.method(models.LedgerEntry,'init',async()=>{});
  t.mock.method(models.Receipt,'findOne',()=>query(receipt));
  t.mock.method(models.Receipt,'find',()=>query([receipt]));
  t.mock.method(models.Payment,'find',()=>query([]));
  t.mock.method(models.Receipt,'updateOne',async(_filter,update,options)=>{
    assert.equal(options.session,session);Object.assign(receipt,update.$set);return {modifiedCount:1};
  });
  t.mock.method(models.SalespersonCashMovement,'findOne',()=>query(batch));
  t.mock.method(CustomerLink,'findOne',()=>query({accountingProfile:{systemAccountCode:'SYS_SUNDRY_DEBTORS'}}));
  t.mock.method(CustomerLink,'find',()=>query([]));
  t.mock.method(mongoose.connection,'getClient',()=>({db:()=>({listCollections:()=>({hasNext:async()=>true})})}));
  t.mock.method(models.LedgerEntry,'find',filter=>query(filter.status==='POSTED'?
    journals.filter(row=>!filter.accountCode||filter.accountCode.$in?.includes(row.accountCode)||row.accountCode===filter.accountCode):[]));
  t.mock.method(models.LedgerEntry,'insertMany',async(rows,options)=>{
    assert.equal(options.session,session);journals.push(...rows);if(fail)throw new Error('Simulated posting failure');return rows;
  });
  const route=workflow.stack.find(x=>x.route?.path==='/cashier/cash/post').route.stack.at(-1).handle;
  const post=async()=>{
    const res={status(n){this.statusCode=n;return this},json(payload){this.payload=payload;return this}};
    await route({auth:{tenantKey,sub:'cashier',role:'SUPERADMIN',permissions:['*']},
      body:{financialYear,postingDate:'2026-11-07',receiptIds:[receiptId]},query:{}},res);return res;
  };
  const before=buildCashbookView(await loadCashbookSourceRows({tenantKey,financialYear}));assert.equal(before.rows.length,0);
  batch.receiptBreakdown[0].customerGlobalId='WRONG_CUSTOMER';
  assert.equal((await post()).statusCode,409);assert.equal(journals.length,0);
  batch.receiptBreakdown[0].customerGlobalId='CUSTOMER-1';
  assert.equal((await post()).statusCode,500);assert.equal(journals.length,0);assert.equal(receipt.ledgerPostedAt,undefined);
  fail=false;
  const result=await post();assert.equal(result.statusCode,200);assert.equal(result.payload.data.posted,1);
  assert.equal(journals.length,2);assert.equal(journals.reduce((sum,row)=>sum+row.debit-row.credit,0),0);
  const book=buildCashbookView(await loadCashbookSourceRows({tenantKey,financialYear}));
  assert.equal(book.rows.length,1);assert.equal(book.rows[0].category,'CASHIER_RECEIPT');assert.equal(book.closingBalance,120);
  assert.equal(new Date(book.rows[0].date).toISOString().slice(0,10),'2026-11-07');
  assert.equal((await post()).payload.data.alreadyPosted,1);assert.equal(journals.length,2);
});

test('typing CASH as an unidentified party cannot bypass the system cash counterparty guard',async()=>{
  const route=transactions.stack.find(x=>x.route?.path==='/manual-entry/:channel').route.stack[0].handle;
  const res={status(n){this.statusCode=n;return this},json(payload){this.payload=payload;return this}};
  await route({params:{channel:'cash'},auth:{tenantKey:'ISOLATED_GUARD_TEST',role:'SUPERADMIN',permissions:['*']},
    body:{date:'2026-11-07',transactionType:'RECEIPT',partyName:'CASH',partyType:'OTHER',amount:30,mode:'CASH'}},res);
  assert.equal(res.statusCode,422);assert.match(res.payload.message,/actual cash counterparty/);
});

test('cashier day close rolls back all postings on failure, resumes once, and releases cheques without booking them as cash',async t=>{
  const tenantKey='CASHIER_CLOSE_INTEGRATION_TEST',financialYear='2026-27',batchId='a'.repeat(24),closeId='b'.repeat(24);
  const models=financialModels(tenantKey,financialYear);
  let receipts=[30,20,100].map((amount,i)=>({_id:String(i+1).repeat(24),tenantKey,financialYear,receiptNo:`COL-${i+1}`,
    customerGlobalId:`CUSTOMER-${i+1}`,amount,date:new Date('2026-11-01'),cashDepositedAt:new Date('2026-11-02'),
    mode:i===2?'BANK':'CASH',receiptType:i===2?'CHEQUE':'CASH',customerOtpStatus:'VERIFIED',status:'POSTED',
    collectionSource:'SALESPERSON_APP',cashDepositStatus:'DEPOSITED_TO_CASHIER',cashDepositBatchId:batchId,disputeStatus:'NONE'}));
  let batch={_id:batchId,type:'HANDOVER',status:'APPROVED',cashierReceivedBy:'cashier',cashierCloseId:'',
    receiptBreakdown:receipts.map(r=>({receiptId:r._id,receiptNo:r.receiptNo,customerGlobalId:r.customerGlobalId,amount:r.amount,mode:r.receiptType}))};
  let close=null,journals=[],cheque={_id:'cheque',data:{status:'WITH_CASHIER',amount:100,customerGlobalId:'CUSTOMER-3',chequeDate:'2026-11-01'}};
  let failSecond=true;
  const session={async withTransaction(fn){const saved=structuredClone({receipts,batch,close,journals,cheque});
    try{await fn()}catch(e){({receipts,batch,close,journals,cheque}=saved);throw e}},async endSession(){}};
  t.mock.method(models.LedgerEntry.db,'startSession',async()=>session);
  t.mock.method(models.LedgerEntry,'init',async()=>{});
  t.mock.method(models.LedgerEntry,'find',filter=>query(filter.status==='POSTED'?journals.filter(j=>j.transactionId===filter.transactionId):[]));
  t.mock.method(models.LedgerEntry,'insertMany',async(rows,options)=>{
    assert.equal(options.session,session);
    if(failSecond&&rows[0].transactionId==='COL-2')throw new Error('Simulated second party posting failure');
    journals.push(...rows);return rows;
  });
  t.mock.method(models.Receipt,'find',()=>query(receipts));
  t.mock.method(models.Receipt,'findOne',filter=>query(receipts.find(r=>r._id===String(filter._id))||null));
  t.mock.method(models.Receipt,'updateOne',async(filter,update,options)=>{
    assert.equal(options.session,session);
    const r=receipts.find(x=>x._id===String(filter._id));Object.assign(r,update.$set);
    return {matchedCount:1,modifiedCount:1};
  });
  t.mock.method(models.SalespersonCashMovement,'findOne',filter=>query(filter.type==='CASHIER_CLOSE'?
    close?.status==='PENDING'?close:null:batch.cashierCloseId===filter.cashierCloseId?batch:null));
  t.mock.method(models.SalespersonCashMovement,'find',()=>query([batch]));
  t.mock.method(models.SalespersonCashMovement,'exists',async()=>false);
  t.mock.method(models.SalespersonCashMovement,'create',async input=>{close={...input,_id:closeId};return close});
  t.mock.method(models.SalespersonCashMovement,'updateOne',async(filter,update,options)=>{
    if(String(filter._id)===batchId)Object.assign(batch,update.$set);
    else{assert.equal(options.session,session);Object.assign(close,update.$set);}
    return {modifiedCount:1};
  });
  t.mock.method(CustomerLink,'findOne',()=>query({accountingProfile:{systemAccountCode:'SYS_SUNDRY_DEBTORS'}}));
  t.mock.method(GenericRecord,'findOne',()=>query(cheque));
  t.mock.method(GenericRecord,'findOneAndUpdate',(_f,_u,options)=>{assert.equal(options.session,session);return query({_id:'approval'})});
  t.mock.method(GenericRecord,'updateOne',async(_filter,update,options)=>{
    assert.equal(options.session,session);
    for(const [key,value] of Object.entries(update.$set))cheque.data[key.slice(5)]=value;
    return {matchedCount:1,modifiedCount:1};
  });
  const closeHandler=transactions.stack.find(x=>x.route?.path==='/cashier/close').route.stack[0].handle;
  const doClose=async()=>{
    const res={status(n){this.statusCode=n;return this},json(payload){this.payload=payload;return this}};
    await closeHandler({auth:{tenantKey,role:'SUPERADMIN',sub:'cashier',name:'Cashier',permissions:['*']},query:{},
      body:{financialYear,date:'2026-11-07',denominations:[{denomination:50,count:1}]}},res);return res;
  };
  const failed=await doClose();assert.equal(failed.statusCode,500);assert.match(failed.payload.message,/second party/);
  assert.equal(journals.length,0);assert.equal(receipts.some(r=>r.ledgerPostedAt),false);
  assert.equal(close.status,'PENDING');assert.equal(cheque.data.status,'WITH_CASHIER');
  failSecond=false;
  const completed=await doClose();assert.equal(completed.statusCode,201);
  assert.equal(completed.payload.data.cashPosted,2);assert.equal(completed.payload.data.chequesTransferred,1);
  assert.equal(journals.length,4);assert.equal(journals.filter(j=>j.accountCode==='SYS_CASH').reduce((n,j)=>n+j.debit,0),50);
  assert.equal(journals.every(j=>new Date(j.date).toISOString().slice(0,10)==='2026-11-07'),true);
  assert.equal(close.status,'POSTED');assert.equal(cheque.data.status,'WAITING_FOR_DEPOSIT');
  assert.equal(receipts[2].ledgerPostedAt,undefined);assert.equal(receipts[2].chequeApprovalStatus,'APPROVED');
});
