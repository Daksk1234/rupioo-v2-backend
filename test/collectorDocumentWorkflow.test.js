import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import {env} from '../src/config/env.js';
import router from '../src/routes/salesApp.js';
import cheques from '../src/routes/cheques.js';
import {financialModels} from '../src/services/accountingService.js';
import {User,CustomerLink,CompanyProfile,CompanyLedger,BankAccount,Product,OtpChallenge,CollectionClaim,FileMeta,IfscMaster,GenericRecord,Role,Department,PincodeAssignment} from '../src/models/index.js';
import {buildPendingCollectionDocuments} from '../src/services/pendingCollectionService.js';
import {receiptIsVerified} from '../src/services/collectionHubRules.js';
import {matchesMongo as matches} from './helpers/mongoPredicate.js';

// Exercise real route handlers, document allocation, transactions, OTP hashing,
// verification and custody using a local transactional store. Never contact Mongo,
// SMTP or a payment network, and never write proof files to the configured NAS.
const query=value=>({select(){return this},sort(){return this},limit(){return this},session(){return this},
 lean:async()=>value,then(resolve,reject){return Promise.resolve(value).then(resolve,reject)}});
const eq=(a,b)=>String(a??'')===String(b??'');
function setup(t,{salesperson=false}={}){
 const tenantKey=`COLLECTION_ROUTE_${new mongoose.Types.ObjectId()}`,financialYear='2026-27';
 const models=financialModels(tenantKey,financialYear),state={receipts:[],claims:[],otps:[],movements:[],notifications:[],failOtp:false,writes:0};
 const customer={_id:'a'.repeat(24),tenantKey,globalCustomerId:'PARTY-1',localName:'Test Shop',status:'ACTIVE',addresses:[{city:'Guwahati',pincode:'781001'}]};
 const auth={tenantKey,role:salesperson?'SALES_PERSON':'COLLECTOR',sub:salesperson?'salesperson-1':'collector-1',name:salesperson?'Sales Person':'Collector'};
 if(salesperson)customer.salespersonId=auth.sub;
 const orders=[{_id:'b'.repeat(24),tenantKey,financialYear,customerGlobalId:'PARTY-1',orderNo:'ORD-1',date:new Date('2026-11-01'),status:'SUBMITTED',workflowStatus:'ORDER_PLACED',grandTotal:500}];
 const notes=[{_id:'c'.repeat(24),tenantKey,financialYear,customerGlobalId:'PARTY-1',documentNo:'DN-1',documentType:'DEBIT_NOTE',date:new Date('2026-11-02'),status:'ISSUED',grandTotal:100}];
 const doc=row=>Object.assign(row,{async save(){return this},toObject(){return Object.fromEntries(Object.entries(this).filter(([,value])=>typeof value!=='function'))}});
 const update=(rows,filter,change)=>{const selected=rows.filter(row=>matches(row,filter));for(const row of selected)Object.assign(row,change.$set);return {matchedCount:selected.length,modifiedCount:selected.length}};
 const session={async withTransaction(fn){const beforeReceipts=[...state.receipts],beforeClaims=state.claims.map(row=>({...row}));
  try{return await fn()}catch(error){state.receipts=beforeReceipts;state.claims=beforeClaims;throw error}},async endSession(){}};
 t.mock.method(models.Receipt.db,'startSession',async()=>session);
 t.mock.method(mongoose.connection,'getClient',()=>({db:()=>({admin:()=>({listDatabases:async()=>({databases:[]})}),
  listCollections:({name})=>({hasNext:async()=>['salesorders','creditnotes','receipts'].includes(name)})})}));
 for(const model of [CompanyLedger,BankAccount,Product,User,CustomerLink])t.mock.method(model,'find',()=>query([]));
 t.mock.method(User,'findOne',filter=>query(salesperson&&!filter.role?.$in?{_id:auth.sub,tenantKey,role:'SALES_PERSON',roleId:'sales-role',departmentId:'sales-dept'}:
  {_id:auth.sub,name:auth.name,collectorPincodes:['781001'],collectorCustomerIds:['OUTSIDE-PARTY']}));
 if(salesperson){const role={_id:'sales-role',code:'SALES_PERSON',tenantKey,departmentId:'sales-dept',hierarchyOrder:1};
  t.mock.method(Role,'findOne',()=>query(role));t.mock.method(Role,'find',()=>query([role]));
  t.mock.method(Department,'findOne',()=>query({_id:'sales-dept',tenantKey}));
  t.mock.method(PincodeAssignment,'find',()=>query([]));}
 t.mock.method(CustomerLink,'findOne',filter=>query(matches(customer,filter)?doc(customer):null));
 for(const model of [models.Receipt,CollectionClaim])t.mock.method(model,'init',async()=>{});
 t.mock.method(models.SalesOrder,'find',filter=>query(orders.filter(row=>matches(row,filter))));
 t.mock.method(models.SalesInvoice,'find',()=>query([]));
 t.mock.method(models.CreditNote,'find',filter=>query(notes.filter(row=>matches(row,filter))));
 t.mock.method(models.LedgerEntry,'find',()=>query([]));
 t.mock.method(models.LedgerEntry,'insertMany',()=>assert.fail('Customer confirmation must not post a ledger journal'));
 t.mock.method(models.Receipt,'find',filter=>query(state.receipts.filter(row=>matches(row,filter))));
 t.mock.method(models.Receipt,'findOne',filter=>query(state.receipts.find(row=>matches(row,filter))||null));
 t.mock.method(models.Receipt,'findById',id=>query(state.receipts.find(row=>eq(row._id,id))||null));
 t.mock.method(models.Receipt,'exists',async filter=>state.receipts.some(row=>matches(row,filter)));
 t.mock.method(models.Receipt,'updateOne',async(filter,change)=>update(state.receipts,filter,change));
 t.mock.method(models.Receipt,'aggregate',async()=>[]);
 t.mock.method(models.Receipt,'create',async input=>{
  const row=doc({...Array.isArray(input)?input[0]:input,_id:String(new mongoose.Types.ObjectId())});
  row.deleteOne=async()=>{state.receipts=state.receipts.filter(item=>item!==row)};
  state.receipts.push(row);return Array.isArray(input)?[row]:row;
 });
 t.mock.method(CollectionClaim,'findOne',filter=>query(state.claims.find(row=>matches(row,filter))||null));
 t.mock.method(CollectionClaim,'updateOne',async(filter,change)=>{
  let row=state.claims.find(item=>matches(item,filter));if(!row){row={...filter};state.claims.push(row)}
  Object.assign(row,change.$set);return {matchedCount:1,modifiedCount:1};
 });
 t.mock.method(CollectionClaim,'updateMany',async(filter,change)=>update(state.claims,filter,change));
 t.mock.method(OtpChallenge,'create',async input=>{if(state.failOtp)throw new Error('OTP storage unavailable');
  const row=doc({...input,status:'PENDING'});state.otps.push(row);return row});
 t.mock.method(OtpChallenge,'findOne',filter=>query(state.otps.find(row=>matches(row,filter))||null));
 t.mock.method(models.OrderNotification,'findOne',filter=>query(state.notifications.find(row=>matches(row,filter))||null));
 t.mock.method(models.OrderNotification,'create',async input=>{state.notifications.push(input);return input});
 t.mock.method(models.SalespersonCashMovement,'findOne',filter=>query(state.movements.find(row=>matches(row,filter))||null));
 t.mock.method(models.SalespersonCashMovement,'find',filter=>query(state.movements.filter(row=>matches(row,filter))));
 t.mock.method(models.SalespersonCashMovement,'exists',async()=>false);
 t.mock.method(models.SalespersonCashMovement,'distinct',async()=>[]);
 t.mock.method(models.SalespersonCashMovement,'create',async input=>{const row=doc({...input,_id:String(new mongoose.Types.ObjectId())});state.movements.push(row);return row});
 t.mock.method(fs,'mkdir',async()=>{});t.mock.method(fs,'writeFile',async()=>{state.writes++});
 t.mock.method(FileMeta,'create',async()=>({fileId:'PROOF-1'}));
 t.mock.method(IfscMaster,'findOne',filter=>query(filter.ifsc==='SBIN0001234'?{ifsc:filter.ifsc,bank:'State Bank',address:'Branch Road'}:null));
 const canonicalKey=`ORDER:${financialYear}:${orders[0]._id}`;
 const body={date:'2026-11-12',financialYear,customerLinkId:customer._id,expectedCustomerName:customer.localName,
  documents:JSON.stringify([{canonicalKey}]),paymentMode:'CASH',receiptType:'CASH',cashDenominations:JSON.stringify([{denomination:500,count:1}]),clientMutationId:'collection-test-0001'};
 async function invoke(path,changes={},params={},options={}){
  const route=router.stack.find(layer=>layer.route?.path===path&&layer.route.methods.post).route;
  const req={body:{...body,...changes},query:{},params:{globalId:customer.globalCustomerId,...params},
   auth,...options};
  const res={statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this}};
  await route.stack.at(-1).handle(req,res);return res;
 }
 async function get(path,extra={},options={}){
  const handler=router.stack.find(layer=>layer.route?.path===path&&layer.route.methods.get).route.stack.at(-1).handle;
  const req={params:{globalId:customer.globalCustomerId},body:{},query:{financialYear,...extra},auth,...options};
  const res={statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this}};
  await handler(req,res);return res;
 }
 return {state,customer,orders,notes,body,canonicalKey,auth,invoke,get,create:(changes,options)=>invoke('/customers/:globalId/receipts',changes,{},options)};
}

test('order collection locks its live obligation; retry reuses its receipt and OTP; changed selection fails',async t=>{
 const app=setup(t),first=await app.create();assert.equal(first.statusCode,201,JSON.stringify(first.payload));
 assert.equal(app.state.receipts[0].againstDocuments[0].kind,'ORDER');assert.equal(app.state.claims.length,1);
 assert.equal(app.state.otps.length,1);assert.equal(app.state.movements.length,0);
 assert.equal((await app.create()).statusCode,200);assert.equal(app.state.receipts.length,1);assert.equal(app.state.otps.length,1);
 assert.equal((await app.create({documents:JSON.stringify([{canonicalKey:app.canonicalKey,amount:100}])})).statusCode,409);
 assert.equal((await app.create({clientMutationId:'collection-other-0002'})).statusCode,409);
});

test('assigned Assam Supply Syndicate appears when its only pending amount is an imported opening balance',async t=>{
 const app=setup(t);app.customer.localName='Assam Supply Syndicate';
 app.customer.accountingProfile={openingBalance:2500,openingBalanceType:'DR',financialYear:'2026-27'};
 app.customer.addresses[0].pincode=' 781001 ';app.orders.length=0;app.notes.length=0;
 t.mock.method(CustomerLink,'find',filter=>query(matches(app.customer,filter)?[app.customer]:[]));
 const result=await app.get('/collector/pending-collections',{q:'Assam'});assert.equal(result.statusCode,200,JSON.stringify(result.payload));
 const data=result.payload.data;assert.equal(data.assignedCustomerCount,1);assert.equal(data.assignedPincodeCount,1);assert.equal(data.items.length,1);
 assert.equal(data.items[0].name,'Assam Supply Syndicate');assert.equal(data.items[0].outstanding,2500);
 assert.equal(data.items[0].documents[0].kind,'OPENING_BALANCE');assert.equal(data.items[0].documents[0].selectable,false);
 app.customer.accountingProfile.openingBalance=0;
 const cleared=await app.get('/collector/pending-collections');assert.equal(cleared.payload.data.items.length,0);assert.equal(cleared.payload.data.assignedCustomerCount,1);
});

test('the mounted mobile HTTP route authenticates a collector and returns the current nonempty pincode response',async t=>{
 const fixture=setup(t);
 t.mock.method(CompanyProfile,'findOne',()=>query({financialYear:'2026-27'}));
 t.mock.method(User,'exists',async()=>true);
 t.mock.method(CustomerLink,'find',filter=>query(matches(fixture.customer,filter)?[fixture.customer]:[]));
 const app=express();app.use(express.json());app.use('/api/sales-app',router);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const token=jwt.sign(fixture.auth,env.jwtSecret,{expiresIn:'1m'});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sales-app/collector/pending-collections?financialYear=2026-27`,{headers:{Authorization:`Bearer ${token}`}});
 const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));
 assert.equal(payload.data.collectorWorkflowVersion,3);assert.equal(payload.data.assignedCustomerCount,1);assert.equal(payload.data.assignedPincodeCount,1);
 assert.equal(payload.data.collector.id,fixture.auth.sub);assert.equal(payload.data.items[0].outstanding,600);
});

test('collector can collect debit notes and cannot use advances or outside-pincode customers',async t=>{
 const app=setup(t),key=`DEBIT_NOTE:2026-27:${app.notes[0]._id}`;
 const result=await app.create({documents:JSON.stringify([{canonicalKey:key}]),cashDenominations:JSON.stringify([{denomination:100,count:1}])});
 assert.equal(result.statusCode,201,JSON.stringify(result.payload));assert.equal(app.state.receipts[0].againstDocuments[0].kind,'DEBIT_NOTE');
 assert.equal((await app.create({clientMutationId:'advance-test-0001',documents:[],allocationType:'ADVANCE',amount:10})).statusCode,400);
 app.customer.addresses=[{pincode:'999999'}];
 assert.equal((await app.create({clientMutationId:'outside-test-0001'})).statusCode,404);
});

test('cancellation releases reservation, preserves pending balance and cannot be reused by a retry',async t=>{
 const app=setup(t);await app.create();const receipt=app.state.receipts[0];
 assert.equal((await app.invoke('/receipts/:receiptId/cancel',{}, {receiptId:receipt._id})).statusCode,200);
 assert.equal(receipt.status,'CANCELLED');assert.equal(app.state.claims[0].status,'RELEASED');assert.equal(app.state.movements.length,0);
 assert.equal(buildPendingCollectionDocuments({orders:app.orders,receipts:app.state.receipts})[0].outstanding,500);
 assert.equal((await app.create()).statusCode,409);
 assert.equal((await app.create({clientMutationId:'after-cancel-0002'})).statusCode,201);
});

test('active global claim rolls a competing receipt back, even when another receipt snapshot is unavailable',async t=>{
 const app=setup(t);app.state.claims.push({tenantKey:app.customer.tenantKey,canonicalKey:app.canonicalKey,receiptId:'d'.repeat(24),
  receiptFinancialYear:'2026-27',status:'ACTIVE',expiresAt:null});
 assert.equal((await app.create()).statusCode,409);assert.equal(app.state.receipts.length,0);assert.equal(app.state.otps.length,0);
});

test('OTP persistence failure removes the unfinished receipt and releases its document claim',async t=>{
 const app=setup(t);app.state.failOtp=true;assert.equal((await app.create()).statusCode,500);
 assert.equal(app.state.receipts.length,0);assert.equal(app.state.claims[0].status,'RELEASED');
 app.state.failOtp=false;assert.equal((await app.create()).statusCode,201);
});

test('cash OTP creates one cashier custody movement, holds its claim, and never posts the ledger',async t=>{
 const app=setup(t);await app.create();const receipt=app.state.receipts[0],code=receipt.customerOtpCode;
 const path='/receipts/:receiptId/customer-otp/verify',params={receiptId:receipt._id};
 assert.equal((await app.invoke(path,{code:'000000'},params)).statusCode,400);
 const verified=await app.invoke(path,{code},params);assert.equal(verified.statusCode,200,JSON.stringify(verified.payload));
 assert.equal(receipt.customerOtpStatus,'VERIFIED');assert.equal(receipt.status,'POSTED');assert.equal(receipt.ledgerPostedAt,undefined);
 assert.equal(app.state.movements.length,1);assert.equal(app.state.claims[0].expiresAt,null);
 assert.equal((await app.invoke(path,{code},params)).statusCode,200);assert.equal(app.state.movements.length,1);
 assert.equal((await app.invoke('/receipts/:receiptId/cancel',{},params)).statusCode,409);
});

test('expired receipt cannot send another OTP or verify after its claim has moved to another collection',async t=>{
 const app=setup(t);await app.create();const receipt=app.state.receipts[0];app.state.claims[0].receiptId='e'.repeat(24);
 const params={receiptId:receipt._id};
 assert.equal((await app.invoke('/receipts/:receiptId/customer-otp/resend',{},params)).statusCode,409);
 assert.equal(app.state.otps.length,1);
 assert.equal((await app.invoke('/receipts/:receiptId/customer-otp/verify',{code:receipt.customerOtpCode},params)).statusCode,409);
 assert.equal(receipt.customerOtpStatus,'PENDING');assert.equal(app.state.movements.length,0);
});

test('a bounced collection releases its live obligation and global claim for a fresh collection',async t=>{
 const app=setup(t);await app.create();const receipt=app.state.receipts[0];
 Object.assign(receipt,{mode:'BANK',receiptType:'CHEQUE',status:'POSTED',customerOtpStatus:'VERIFIED',chequeStatus:'BOUNCED'});
 app.state.claims[0].expiresAt=null;
 assert.equal((await app.create({clientMutationId:'after-bounce-0002'})).statusCode,201);
 assert.equal(app.state.claims[0].receiptId,app.state.receipts[1]._id);
});

test('online proof submits directly for bank verification, requires a real date, and cannot request OTP or cancel',async t=>{
 const app=setup(t),details={paymentMode:'BANK',receiptType:'UPI',upiPaymentText:'UTR123456',onlineTransactionDate:'2026-11-12',onlineTransactionTime:'12:30'},
  options={file:{originalname:'proof.jpg',mimetype:'image/jpeg',buffer:Buffer.from('test image'),size:10}};
 assert.equal((await app.create({...details,onlineTransactionDate:'2026-02-30'},options)).statusCode,400);
 assert.equal((await app.create(details)).statusCode,400);
 const result=await app.create(details,options);assert.equal(result.statusCode,201,JSON.stringify(result.payload));
 const receipt=app.state.receipts[0],params={receiptId:receipt._id};
 assert.equal(receiptIsVerified(receipt),true);assert.equal(receipt.customerOtpStatus,'NOT_REQUIRED');assert.equal(receipt.customerConfirmationMethod,'ONLINE_PROOF');
 assert.equal(app.state.otps.length,0);assert.equal(app.state.movements.length,0);assert.equal(app.state.writes,1);assert.equal(receipt.ledgerPostedAt,undefined);
 for(const path of ['/receipts/:receiptId/customer-otp/resend','/receipts/:receiptId/customer-otp/verify','/receipts/:receiptId/cancel'])
  assert.equal((await app.invoke(path,{},params)).statusCode,409);
});

test('cheque creation accepts only MASTER IFSC details, a real date and attached proof before OTP',async t=>{
 const app=setup(t),details={paymentMode:'BANK',receiptType:'CHEQUE',payerAccountNumber:'1234567890',chequeNumber:'123456',ifsc:'SBIN0001234',chequeDate:'2026-11-12'},
  options={file:{originalname:'cheque.jpg',mimetype:'image/jpeg',buffer:Buffer.from('cheque'),size:6}};
 assert.equal((await app.create({...details,ifsc:'XXXX0000000'},options)).statusCode,404);
 assert.equal((await app.create({...details,chequeDate:'2026-02-30'},options)).statusCode,400);
 const result=await app.create(details,options);assert.equal(result.statusCode,201,JSON.stringify(result.payload));
 assert.equal(app.state.receipts[0].payerBankName,'State Bank');assert.equal(app.state.otps.length,1);assert.equal(app.state.receipts[0].customerOtpStatus,'PENDING');
});

test('Company Received shows proof-backed online payments and customer-verified cheques before Accounts handover',async t=>{
 const app=setup(t),fy='2026-27',models=financialModels(app.customer.tenantKey,fy);
 app.state.receipts.push({_id:'online',tenantKey:app.customer.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',status:'POSTED',
  receiptNo:'RCT-ONLINE',mode:'BANK',receiptType:'UPI',amount:100,customerOtpStatus:'NOT_REQUIRED',customerConfirmationMethod:'ONLINE_PROOF',paymentProofFileId:'PROOF'},
  {_id:'cheque',tenantKey:app.customer.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',status:'POSTED',
   receiptNo:'RCT-CHEQUE',mode:'BANK',receiptType:'CHEQUE',amount:100,customerOtpStatus:'VERIFIED',chequeApprovalStatus:'PENDING',cashDepositStatus:'PENDING_TO_DEPOSIT'},
  {_id:'unconfirmed',tenantKey:app.customer.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',status:'POSTED',
   receiptNo:'RCT-UNCONFIRMED',mode:'BANK',receiptType:'UPI',amount:100,customerOtpStatus:'PENDING'});
 t.mock.method(GenericRecord,'find',()=>query([]));
 const handler=cheques.stack.find(layer=>layer.route?.path==='/company-received').route.stack.at(-1).handle;
 const req={query:{financialYear:fy},auth:{tenantKey:app.customer.tenantKey,role:'SUPERADMIN',permissions:['*']}},
  res={statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this}};
 await handler(req,res);assert.equal(res.statusCode,200,JSON.stringify(res.payload));
 assert.deepEqual(res.payload.data.items.map(row=>row.receiptNo).sort(),['RCT-CHEQUE','RCT-ONLINE']);
 assert.equal(res.payload.data.items.find(row=>row.receiptNo==='RCT-ONLINE').status,'PENDING_BANK_VERIFICATION');
});

test('salesperson priorities and due bills include a newly placed order and exclude reserved documents from no-receipt bills',async t=>{
 const app=setup(t);
 t.mock.method(CustomerLink,'find',filter=>query(filter.status?[app.customer]:[]));
 async function get(path,extra={}){
  const handler=router.stack.find(layer=>layer.route?.path===path&&layer.route.methods.get).route.stack.at(-1).handle;
  const req={params:{globalId:app.customer.globalCustomerId},body:{},query:{financialYear:'2026-27',...extra},
   auth:{tenantKey:app.customer.tenantKey,sub:'admin',role:'SUPERADMIN',permissions:['*']}},
   res={statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this}};
  await handler(req,res);assert.equal(res.statusCode,200,JSON.stringify(res.payload));return res.payload.data;
 }
 const priority=await get('/collection-priority');assert.equal(priority.items[0].outstanding,600);assert.equal(priority.items[0].openBills,2);
 assert.equal((await get('/collection-priority',{q:'absent-shop'})).items.length,0);
 const due=await get('/customers/:globalId/due-bills');assert.equal(due.orders[0].number,'ORD-1');assert.equal(due.orders[0].paidAllocated,0);
 await app.create();const after=await get('/customers/:globalId/due-bills');
 assert.equal(after.summary.outstanding,600);assert.equal(after.items.length,1);assert.equal(after.items[0].kind,'DEBIT_NOTE');
});

test('salesperson pending collection uses sales ownership and cannot collect another salesperson customer',async t=>{
 const app=setup(t,{salesperson:true});
 const outside={...app.customer,_id:'9'.repeat(24),globalCustomerId:'OTHER',salespersonId:'other-salesperson'};
 t.mock.method(CustomerLink,'find',filter=>query([app.customer,outside].filter(row=>matches(row,filter))));
 const result=await app.get('/cash/pending-collections');assert.equal(result.statusCode,200,JSON.stringify(result.payload));
 assert.equal(result.payload.data.items.length,1);assert.equal(result.payload.data.items[0].id,app.customer.globalCustomerId);
 assert.equal(result.payload.data.items[0].outstanding,600);assert.equal(result.payload.data.items[0].documents[0].kind,'ORDER');
 app.customer.salespersonId='other-salesperson';assert.equal((await app.create()).statusCode,404);
});

test('salesperson cash confirmation enters cashier custody once and blocks other users from cancelling it',async t=>{
 const app=setup(t,{salesperson:true}),result=await app.create();assert.equal(result.statusCode,201,JSON.stringify(result.payload));
 const receipt=app.state.receipts[0],params={receiptId:receipt._id};
 const blocked=await app.invoke('/receipts/:receiptId/cancel',{},params,{auth:{...app.auth,sub:'other-salesperson'}});
 assert.equal(blocked.statusCode,403);assert.equal(receipt.status,'PENDING_VERIFICATION');
 const verified=await app.invoke('/receipts/:receiptId/customer-otp/verify',{code:receipt.customerOtpCode},params);
 assert.equal(verified.statusCode,200,JSON.stringify(verified.payload));assert.equal(app.state.movements.length,1);
 assert.equal(app.state.movements[0].salespersonId,app.auth.sub);assert.equal(receipt.ledgerPostedAt,undefined);
 assert.equal((await app.invoke('/receipts/:receiptId/cancel',{},params)).statusCode,409);
});

test('salesperson online proof submits without OTP and is safely reused after a network retry',async t=>{
 const app=setup(t,{salesperson:true}),details={paymentMode:'BANK',receiptType:'UPI',upiPaymentText:'SALESUTR1234',onlineTransactionDate:'2026-11-12',onlineTransactionTime:'16:30'},
  options={file:{originalname:'proof.jpg',mimetype:'image/jpeg',buffer:Buffer.from('test'),size:4}};
 const result=await app.create(details,options);assert.equal(result.statusCode,201,JSON.stringify(result.payload));
 const receipt=app.state.receipts[0];assert.equal(receipt.collectedByRole,'SALES_PERSON');assert.equal(receipt.customerOtpStatus,'NOT_REQUIRED');
 assert.equal(receiptIsVerified(receipt),true);assert.equal(app.state.otps.length,0);assert.equal(app.state.movements.length,0);
 assert.equal((await app.create(details,options)).statusCode,200);assert.equal(app.state.receipts.length,1);assert.equal(app.state.writes,1);
});

test('collector and salesperson cannot collect the same outstanding order concurrently',async t=>{
 const app=setup(t,{salesperson:true});
 const collector=await app.create({}, {auth:{...app.auth,role:'COLLECTOR',sub:'collector-1'}});
 assert.equal(collector.statusCode,201,JSON.stringify(collector.payload));
 assert.equal(app.state.receipts[0].collectedBySalespersonId,'collector-1');
 assert.equal((await app.create({clientMutationId:'second-collection-0002'})).statusCode,409);
 assert.equal(app.state.receipts.length,1);
});

test('salesperson collection history retains only own receipts and never exposes OTP secrets',async t=>{
 const app=setup(t,{salesperson:true});await app.create();const receipt=app.state.receipts[0];
 app.state.receipts.push({...receipt,_id:'7'.repeat(24),receiptNo:'OTHER-RCT',collectedBySalespersonId:'other-salesperson'});
 const history=await app.get('/cash/collected');assert.equal(history.statusCode,200,JSON.stringify(history.payload));
 assert.equal(history.payload.data.items.length,1);assert.equal(history.payload.data.items[0].receiptNo,receipt.receiptNo);
 assert.equal(history.payload.data.items[0].customerOtpCode,undefined);
 assert.equal((await app.get('/collector/collected')).statusCode,403);
});

test('salesperson deposit preview includes only own verified cash and physical cheques, excluding online payments',async t=>{
 const app=setup(t,{salesperson:true});await app.create();const receipt=app.state.receipts[0];
 Object.assign(receipt,{status:'POSTED',customerOtpStatus:'VERIFIED',cashDepositStatus:'PENDING_TO_DEPOSIT'});
 app.state.receipts.push({...receipt,_id:'6'.repeat(24),receiptNo:'CHQ-1',mode:'BANK',receiptType:'CHEQUE'},
  {...receipt,_id:'7'.repeat(24),receiptNo:'UPI-1',mode:'BANK',receiptType:'UPI',customerOtpStatus:'NOT_REQUIRED'},
  {...receipt,_id:'8'.repeat(24),receiptNo:'OTHER-1',collectedBySalespersonId:'other-salesperson',createdBy:'other-salesperson'});
 const result=await app.get('/cash/deposit-preview',{period:'FY'});assert.equal(result.statusCode,200,JSON.stringify(result.payload));
 assert.deepEqual(result.payload.data.items.map(row=>row.mode).sort(),['CASH','CHEQUE']);
 assert.equal(result.payload.data.totalCash,500);assert.equal(result.payload.data.totalBank,500);
});

test('salesperson cash and cheque bundle resumes its OTP and transfers custody once without posting the ledger',async t=>{
 const app=setup(t,{salesperson:true});await app.create();const cash=app.state.receipts[0],models=financialModels(app.auth.tenantKey,'2026-27');
 Object.assign(cash,{status:'POSTED',customerOtpStatus:'VERIFIED',cashDepositStatus:'PENDING_TO_DEPOSIT'});
 const cheque={...cash,_id:'6'.repeat(24),receiptNo:'CHQ-1',mode:'BANK',receiptType:'CHEQUE',payerIfsc:'SBIN0001234',chequeNumber:'123456'};
 app.state.receipts.push(cheque);
 const control={_id:'5'.repeat(24),tenantKey:app.auth.tenantKey,app:'dms',resource:'cheque-control-received',data:{linkedReceiptNo:'CHQ-1',linkedReceiptFy:'2026-27',
  customerGlobalId:app.customer.globalCustomerId,amount:500,chequeNo:'123456',status:'PENDING_WITH_SALESPERSON'}};
 t.mock.method(User,'findOne',()=>query({_id:'4'.repeat(24),name:'Cashier',role:'CASHIER'}));
 t.mock.method(models.Receipt,'aggregate',async()=>[{amount:500}]);
 t.mock.method(models.Receipt,'updateMany',async(filter,change)=>{let count=0;for(const row of app.state.receipts){if(matches(row,filter)){Object.assign(row,change.$set);count++}}return {matchedCount:count,modifiedCount:count}});
 t.mock.method(GenericRecord,'findOne',()=>query(control));
 t.mock.method(GenericRecord,'exists',async filter=>matches(control,filter));
 t.mock.method(GenericRecord,'updateOne',async(filter,change)=>{if(!matches(control,filter))return {modifiedCount:0};
  for(const [key,value] of Object.entries(change.$set||{})){const parts=key.split('.');if(parts.length===2)control[parts[0]][parts[1]]=value;else control[key]=value}return {modifiedCount:1}});
 t.mock.method(models.SalespersonCashMovement,'findOneAndUpdate',(filter,change)=>{const row=app.state.movements.find(item=>matches(item,filter));
  if(row){Object.assign(row,change.$set);for(const key of Object.keys(change.$unset||{}))delete row[key]}return query(row||null)});
 const result=await app.invoke('/cash/handover',{receiptIds:[cash._id,cheque._id],denominations:[{denomination:500,count:1}]});
 assert.equal(result.statusCode,201,JSON.stringify(result.payload));
 const movement=app.state.movements[0],code=movement.handoverOtpCode;
 assert.equal(movement.cashAmount,500);assert.equal(movement.bankAmount,500);assert.equal(movement.amount,1000);
 assert.equal(cash.cashDepositStatus,'HANDOVER_PENDING');assert.equal(control.data.status,'HANDOVER_REQUESTED');
 const resumed=await app.get('/cash/handovers/pending-otp');assert.equal(resumed.payload.data.items[0]._id,movement._id);
 assert.equal(resumed.payload.data.items[0].handoverOtpCode,undefined);assert.equal(movement.status,'PENDING');
 const verified=await app.invoke('/cash/handovers/:movementId/otp/verify',{code},{movementId:movement._id});
 assert.equal(verified.statusCode,200,JSON.stringify(verified.payload));assert.equal(movement.status,'APPROVED');assert.equal(movement.handoverOtpCode,undefined);
 assert.equal(cash.cashDepositStatus,'DEPOSITED_TO_CASHIER');assert.equal(cheque.cashDepositStatus,'DEPOSITED_TO_CASHIER');assert.equal(control.data.status,'WITH_CASHIER');
 assert.equal(cash.ledgerPostedAt,undefined);assert.equal(cheque.ledgerPostedAt,undefined);
 assert.equal((await app.invoke('/cash/handover',{receiptIds:[cash._id,cheque._id],denominations:[{denomination:500,count:1}]})).statusCode,409);
 assert.equal(app.state.movements.length,1);
});
