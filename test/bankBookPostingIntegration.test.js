import test from 'node:test';
import assert from 'node:assert/strict';
import bankRoutes from '../src/routes/banks.js';
import {financialModels} from '../src/services/accountingService.js';
import {postCustodyApprovedReceipt} from '../src/services/salespersonReceiptWorkflowService.js';
import {resolveSuperadminBookSource} from '../src/services/superadminBookSource.js';
import {BankAccount,CustomerLink,GlobalCustomer,User} from '../src/models/index.js';

const tenantKey='BANK_POSTING_INTEGRATION_TEST',financialYear='2026-27';
const banks=[{bankAccountId:'BANK-A',bankName:'Main Bank',ledgerId:'LA',accountType:'CURRENT',financialYear,openingBalance:1000,openingBalanceType:'CR',status:'ACTIVE'},
 {bankAccountId:'BANK-B',bankName:'OD Bank',ledgerId:'LB',accountType:'OD',financialYear,openingBalance:1000,openingBalanceType:'CR',status:'ACTIVE'}];
const valueAt=(row,path)=>path.split('.').reduce((v,key)=>v?.[key],row);
const equal=(a,b)=>a instanceof Date||b instanceof Date?new Date(a).getTime()===new Date(b).getTime():a==null&&b==null||a===b;
function matches(row,filter){return Object.entries(filter).every(([field,condition])=>{
 if(field==='$or')return condition.some(part=>matches(row,part));
 if(field==='$and')return condition.every(part=>matches(row,part));
 const value=valueAt(row,field);
 if(condition instanceof RegExp)return condition.test(String(value||''));
 if(condition&&typeof condition==='object'&&!(condition instanceof Date))return Object.entries(condition).every(([op,v])=>{
  if(op==='$in')return v.some(item=>equal(value,item));if(op==='$nin')return !v.some(item=>equal(value,item));
  if(op==='$ne')return !equal(value,v);if(op==='$exists')return (value!==undefined)===v;
  if(op==='$type')return typeof value===v;if(op==='$gte')return new Date(value)>=new Date(v);if(op==='$lte')return new Date(value)<=new Date(v);
  throw new Error('Unhandled query operation '+op);
 });
 return equal(value,condition);
});}
const query=value=>({lean:async()=>value,select(){return this},sort(){return this},limit(){return this},session(){return this},
 then(resolve,reject){return Promise.resolve(value).then(resolve,reject)}});
const ledger=(id,transactionType,accountCode,debit,credit,extra={})=>({_id:id,tenantKey,financialYear,transactionId:id,transactionType,
 accountCode,date:new Date('2026-04-03'),debit,credit,status:'POSTED',...extra});
function fixture(t,initial={}){
 const models=financialModels(tenantKey,financialYear),state={receipts:[],payments:[],contras:[],transfers:[],statements:[],corrections:[],ledger:[],...initial};
 for(const [Model,key] of [[models.Receipt,'receipts'],[models.Payment,'payments'],[models.ContraVoucher,'contras'],
  [models.BankTransfer,'transfers'],[models.BankStatementRow,'statements'],[models.BookCorrection,'corrections'],[models.LedgerEntry,'ledger']]){
  t.mock.method(Model,'find',filter=>query(state[key].filter(row=>matches(row,filter))));
  t.mock.method(Model,'findOne',filter=>query(state[key].find(row=>matches(row,filter))||null));
 }
 t.mock.method(BankAccount,'find',filter=>query(banks.map(bank=>({...bank,tenantKey})).filter(row=>matches(row,filter))));
 t.mock.method(BankAccount,'findOne',filter=>query(banks.map(bank=>({...bank,tenantKey})).find(row=>matches(row,filter))||null));
 t.mock.method(CustomerLink,'findOne',()=>query({globalCustomerId:'CUSTOMER',accountingProfile:{systemAccountCode:'SYS_SUNDRY_DEBTORS'}}));
 t.mock.method(CustomerLink,'find',()=>query([{globalCustomerId:'CUSTOMER',localName:'Test Customer'}]));
 t.mock.method(GlobalCustomer,'find',()=>query([]));t.mock.method(User,'find',()=>query([]));
 t.mock.method(models.LedgerEntry,'init',async()=>{});
 const session={async withTransaction(fn){const before=structuredClone(state);try{await fn()}catch(error){Object.assign(state,before);throw error}},async endSession(){}};
 t.mock.method(models.LedgerEntry.db,'startSession',async()=>session);
 t.mock.method(models.LedgerEntry,'insertMany',async(rows,options)=>{
  assert.equal(options.session,session);const posted=rows.map((row,index)=>({...row,_id:(state.ledger.length+index+1).toString(16).padStart(24,'0')}));state.ledger.push(...posted);return posted;
 });
 t.mock.method(models.Receipt,'updateOne',async(filter,update,options)=>{
  assert.equal(options.session,session);const receipt=state.receipts.find(row=>matches(row,filter));
  if(!receipt)return {matchedCount:0,modifiedCount:0};if(state.failReceiptUpdate)throw new Error('Simulated receipt update failure');
  Object.assign(receipt,update.$set);return {matchedCount:1,modifiedCount:1};
 });
 return {state,models};
}
async function readBank(bankAccountId='BANK-A',extra={}){
 const handler=bankRoutes.stack.find(layer=>layer.route?.path==='/transactions'&&layer.route.methods.get).route.stack[0].handle;
 const res={status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this}};
 await handler({auth:{tenantKey,role:'SUPERADMIN',permissions:['*']},query:{financialYear,bankAccountId,...extra}},res);
 assert.equal(res.payload.success,true,JSON.stringify(res.payload));return res.payload.data;
}
const cheque=()=>({_id:'c'.repeat(24),tenantKey,financialYear,receiptNo:'COL-CHQ',date:new Date('2026-04-01'),amount:300,
 mode:'BANK',receiptType:'CHEQUE',status:'POSTED',collectionSource:'SALESPERSON_APP',customerOtpStatus:'VERIFIED',
 customerGlobalId:'CUSTOMER',partyNameSnapshot:'Test Customer',chequeApprovalStatus:'APPROVED',receiptWorkflowStatus:'READY_TO_POST_LEDGER'});
const postCheque=(bankAccountId='BANK-B')=>postCustodyApprovedReceipt({tenantKey,financialYear,receiptId:'c'.repeat(24),channel:'CHEQUE',
 bankAccountId,bankReceivedDate:'2026-05-07',actorId:'accounts'});

test('cash-bank vouchers appear on the opposite bank side with accurate balances and no duplicate contra rows',async t=>{
 const {state}=fixture(t,{payments:[{tenantKey,financialYear,paymentNo:'CASH-PAY',mode:'CASH',status:'POSTED',amount:50}],
 receipts:[{tenantKey,financialYear,receiptNo:'CASH-RCT',mode:'CASH',status:'POSTED',amount:100}],
 contras:[{_id:'contra-in',tenantKey,financialYear,contraNo:'CONTRA-IN',status:'POSTED',bankAccountId:'BANK-A',date:'2026-04-03',direction:'DEPOSIT',amount:200},
  {_id:'contra-out',tenantKey,financialYear,contraNo:'CONTRA-OUT',status:'POSTED',bankAccountId:'BANK-A',date:'2026-04-03',direction:'WITHDRAWAL',amount:20}],
 ledger:[ledger('CASH-PAY','PAYMENT','SYS_BANK_ACCOUNT',50,0,{ledgerId:'LA'}),ledger('cash-pay-leg','PAYMENT','SYS_CASH',0,50,{transactionId:'CASH-PAY'}),
  ledger('CASH-RCT','RECEIPT','SYS_BANK_ACCOUNT',0,100,{bankAccountId:'BANK-A'}),ledger('cash-rct-leg','RECEIPT','SYS_CASH',100,0,{transactionId:'CASH-RCT'}),
  ledger('CONTRA-IN','CONTRA','SYS_BANK_ACCOUNT',200,0,{bankAccountId:'BANK-A'}),ledger('CONTRA-OUT','CONTRA','SYS_BANK_ACCOUNT',0,20,{bankAccountId:'BANK-A'})]});
 const book=await readBank('BANK-A',{groupByMonth:'1'});
 assert.equal(book.meta.total,4);assert.equal(book.totals.credit,250);assert.equal(book.totals.debit,120);
 assert.equal(book.monthlySummaries[0].closingBalance,1130);assert.equal(book.monthlySummaries[1].openingBalance,1130);
 assert.equal(book.items.find(row=>row.transactionId==='CASH-PAY').credit,50);
 assert.equal(book.items.find(row=>row.transactionId==='CASH-RCT').debit,100);
 const source=await resolveSuperadminBookSource({tenantKey,financialYear,book:'BANK',sourceKey:book.items.find(row=>row.transactionId==='CASH-PAY')._listId});
 assert.equal(source.originalCredit,50);assert.equal(source.bankAccountId,'BANK-A');assert.equal(state.ledger.length,6);
});

test('cheque Post to Ledger atomically credits its selected bank on the bank receipt date and retries once',async t=>{
 const {state}=fixture(t,{receipts:[cheque()]});
 assert.equal((await readBank('BANK-B')).meta.total,0);
 const result=await postCheque();assert.equal(result.alreadyPosted,false);assert.equal(state.ledger.length,2);
 assert.equal(state.ledger.find(line=>line.accountCode==='SYS_BANK_OD').debit,300);
 const book=await readBank('BANK-B',{groupByMonth:'1',fromDate:'2026-05-01',toDate:'2026-05-31'});
 assert.equal(book.meta.total,1);assert.equal(book.items[0].credit,300);assert.equal(new Date(book.items[0].date).toISOString().slice(0,10),'2026-05-07');
 assert.equal(book.items[0].runningBalance,1300);assert.equal(book.monthlySummaries[1].credit,300);
 assert.equal((await postCheque()).alreadyPosted,true);assert.equal(state.ledger.length,2);
 await assert.rejects(postCheque('BANK-A'),/another bank|another company bank/);assert.equal(state.ledger.length,2);
});

test('failed cheque receipt update rolls the bank journal back; retry posts exactly once',async t=>{
 const {state}=fixture(t,{receipts:[cheque()],failReceiptUpdate:true});
 await assert.rejects(postCheque(),/Simulated receipt update failure/);assert.equal(state.ledger.length,0);
 assert.equal(state.receipts[0].ledgerPostedAt,undefined);assert.equal((await readBank('BANK-B')).meta.total,0);
 state.failReceiptUpdate=false;await postCheque();assert.equal(state.ledger.length,2);assert.equal((await readBank('BANK-B')).meta.total,1);
});

test('a legacy suspense cheque moves to bank without crediting the customer twice or duplicating statement rows',async t=>{
 const receipt={...cheque(),ledgerPostedAt:new Date('2026-04-01')};
 const {state}=fixture(t,{receipts:[receipt],ledger:[ledger('old-suspense','RECEIPT','SYS_SUSPENSE',300,0,{transactionId:receipt.receiptNo,partyGlobalId:'CUSTOMER'}),
  ledger('old-customer','RECEIPT','SYS_SUNDRY_DEBTORS',0,300,{transactionId:receipt.receiptNo,partyGlobalId:'CUSTOMER'})]});
 await postCheque();await postCheque();
 assert.equal(state.ledger.length,4);assert.equal(state.ledger.filter(line=>line.accountCode==='SYS_SUNDRY_DEBTORS'&&line.credit===300).length,1);
 const book=await readBank('BANK-B');assert.equal(book.meta.total,1);assert.equal(book.items[0].credit,300);
 assert.equal(book.items[0].transactionId,'CHQ-BANK-COL-CHQ');assert.equal(book.items[0].runningBalance,1300);
});

test('existing cheque-clearing bank journals appear even without a separate bank receipt display record',async t=>{
 fixture(t,{ledger:[ledger('CHQ-CLEAR','CHEQUE_CLEARING','SYS_BANK_ACCOUNT',300,0,{bankAccountId:'BANK-A',partyGlobalId:'CUSTOMER'})]});
 const book=await readBank('BANK-A');assert.equal(book.meta.total,1);assert.equal(book.items[0].credit,300);assert.equal(book.items[0].runningBalance,1300);
});

test('unposted collector receipts and orphaned or voided cash journals never reappear as bank movements',async t=>{
 fixture(t,{receipts:[{...cheque(),bankAccountId:'BANK-A'}],
  payments:[{tenantKey,financialYear,paymentNo:'VOID-CASH',mode:'CASH',status:'VOID'}],
  ledger:[ledger('VOID-CASH','PAYMENT','SYS_BANK_ACCOUNT',300,0,{bankAccountId:'BANK-A'}),
   ledger('ORPHAN','RECEIPT','SYS_BANK_ACCOUNT',300,0,{bankAccountId:'BANK-A'})]});
 assert.equal((await readBank('BANK-A')).meta.total,0);
});
