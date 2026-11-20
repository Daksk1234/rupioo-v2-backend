// Rupioo V2 Cheque Controlling System. Uses EXISTING GenericRecord collection:
// no extra MongoDB collection is created (important on Atlas M0's 500-collection cap).
// This is a custody/control register, NOT an automatic bank-ledger posting endpoint.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { BankAccount, GenericRecord, CustomerLink, User, OtpChallenge } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { canPageAction } from '../config/permissionPageMap.js';
import { isAdminAuth } from '../utils/adminAccess.js';
import { ok, fail, pageMeta } from '../utils/http.js';
import { getIfscMaster, ifscSnapshot, normalizeIfsc } from '../services/ifscMasterService.js';
import { createOtp, verifyOtp } from '../services/otpService.js';
import { financialModels, postBalancedEntries } from '../services/accountingService.js';
import { receiptCustodyStatus, isChequeCollector, isChequeSalesperson, isChequeCashier, isCustodyPending, canAdvanceReceived, fyForDate, validatesChequeIdentity } from '../services/receivedChequeRules.js';
import { chequeSerials, canChequeTransition, chequeISODate, pickFirstAvailableCheque, chequeIssuePurpose, chequeMissingLeafStatus } from '../services/chequeControlRules.js';
import { chequePartyFilter, chequePartyRow } from '../services/chequePartyDirectory.js';
import { kolkataToday, isISODate, isSbiDepositAccount, isEligibleReceivedCheque } from '../services/chequeDepositSlipRules.js';
import { streamSbiDepositSlipPDF } from '../services/chequeDepositSlipPdf.js';
import { syncChequeForReceipt } from '../services/collectionHubService.js';
import { receivedChequeDeleteBlocker } from '../services/receivedChequeDeleteRules.js';
import { postCustodyApprovedReceipt } from '../services/salespersonReceiptWorkflowService.js';
import {collectorTerritoryFilter,customerCollectionPincodes} from '../services/collectorTerritoryService.js';
import {collectionConfirmationFilter} from '../services/collectionHubRules.js';

const router = express.Router();
router.use(requireAuth);
const app='dms';
const PAGE='/dms/cheque-control';
const BOOKS='cheque-control-books';
const LEAVES='cheque-control-issued';
const RECEIVED='cheque-control-received';
const APPROVALS='cheque-control-approval-bundles';
const clean = (v)=>String(v??'').trim();
const formatDate=chequeISODate;
const nonNegativeMoney=(raw)=>{const v=Number(raw);if(!Number.isFinite(v)||v<0)throw new Error('Amount must be zero or greater');return Math.round(v*100)/100;};
const positiveMoney=(raw)=>{const v=nonNegativeMoney(raw);if(v<=0)throw new Error('Amount must be greater than zero');return v;};
const latestEvent = (status, auth, reason='') => ({status,at:new Date().toISOString(),by:clean(auth?.sub),reason:clean(reason).slice(0,500)});
const access=(action)=>(req,res,next)=>{
  if(req.auth?.role==='MASTER'||!((req.auth?.apps||[]).includes('dms')))return fail(res,'DMS access required',403);
  if(isAdminAuth(req.auth)||canPageAction(req.auth?.permissions||[],PAGE,action))return next();
  return fail(res,`Cheque Control ${action} permission required`,403);
};
const safe=(handler)=>async(req,res)=>{try{await handler(req,res);}catch(error){
  if(error?.code===11000)return fail(res,'Cheque number already registered for this company bank account',409);
  return fail(res,error?.message||'Cheque operation failed',error?.statusCode||400);
}};
const bankFor=async(tenantKey,bankAccountId)=>{
  const bank=await BankAccount.findOne({tenantKey,bankAccountId:clean(bankAccountId),status:'ACTIVE'}).select('bankName bankAccountId accountNumber isPrimary').lean();
  if(!bank)throw new Error('Choose an active company bank account');return bank;
};
const source=(tenantKey,resource)=>({tenantKey,app,resource});
const permissionStatus=(auth, action)=>isAdminAuth(auth)||canPageAction(auth?.permissions||[],PAGE,action);
const leafReference=(bankAccountId,chequeNo)=>`${clean(bankAccountId)}:${chequeNo}`;

// Shared Debtor/Creditor master endpoint and tenant-scoped selection validator.
// The endpoint can page/search ALL matches, not just the first 100.
async function requiredChequeParty(tenantKey,globalCustomerId){
  const id=clean(globalCustomerId);
  if(!id){const err=new Error('Select a Debtor or Creditor from the Party Name dropdown');err.statusCode=422;throw err;}
  const row=await CustomerLink.findOne({...chequePartyFilter(tenantKey),globalCustomerId:id})
    .select('globalCustomerId localName displayIdentifier partyType').lean();
  if(!row){const err=new Error('Selected party is not an active Debtor/Creditor in your company master');err.statusCode=422;throw err;}
  return chequePartyRow(row);
}
router.get('/parties',access('view'),safe(async(req,res)=>{
  const page=Math.max(1,Number.parseInt(req.query.page,10)||1);
  const limit=Math.min(100,Math.max(10,Number.parseInt(req.query.limit,10)||60));
  const q=clean(req.query.q).slice(0,100);
  const filter=chequePartyFilter(req.auth.tenantKey,q);
  const [rows,total]=await Promise.all([
    CustomerLink.find(filter).select('globalCustomerId localName displayIdentifier partyType')
      .sort({localName:1,globalCustomerId:1}).skip((page-1)*limit).limit(limit).lean(),
    CustomerLink.countDocuments(filter)
  ]);
  return ok(res,{items:rows.map(chequePartyRow),meta:pageMeta(page,limit,total)});
}));

// A unique index inside the EXISTING GenericRecord collection ensures simultaneous
// cheque-book registrations cannot assign the same leaf twice.
let indexPromise;
const ensureLeafIndex=()=>{
  if(!indexPromise)indexPromise=GenericRecord.collection.createIndex(
    {tenantKey:1,app:1,resource:1,reference:1},
    {name:'rupioo_unique_company_issued_cheque',unique:true,partialFilterExpression:{resource:LEAVES}}
  ).catch(e=>{indexPromise=null;throw e;});
  return indexPromise;
};

router.get('/banks',access('view'),safe(async(req,res)=>{
  const items=await BankAccount.find({tenantKey:req.auth.tenantKey,status:'ACTIVE'})
    .select('bankAccountId bankName accountNumber isPrimary').sort({isPrimary:-1,bankName:1}).lean();
  return ok(res,{items});
}));
router.get('/permissions',access('view'),safe(async(req,res)=>ok(res,{
  create:permissionStatus(req.auth,'create'),edit:permissionStatus(req.auth,'edit'),delete:permissionStatus(req.auth,'delete'),download:permissionStatus(req.auth,'download')
})));
router.get('/issued/books',access('view'),safe(async(req,res)=>{
  const items=await GenericRecord.find(source(req.auth.tenantKey,BOOKS)).sort({createdAt:-1}).lean();
  return ok(res,{items:items.map(x=>({id:String(x._id),...x.data}))});
}));
router.post('/issued/books',access('create'),safe(async(req,res)=>{
  const tenantKey=req.auth.tenantKey;const bank=await bankFor(tenantKey,req.body?.bankAccountId);
  const numbers=chequeSerials(req.body?.startingNo,req.body?.numberOfLeaves);const start=numbers[0],count=numbers.length;
  const now=new Date(); const bookId=randomUUID();
  const common={tenantKey,app,createdBy:clean(req.auth.sub),status:'ACTIVE'};
  const book={...common,resource:BOOKS,reference:bookId,title:`${bank.bankName} ${numbers[0]}-${numbers[count-1]}`,date:now,
    data:{bookId,bankAccountId:bank.bankAccountId,bankName:bank.bankName,startingNo:start,endingNo:numbers[count-1],numberOfLeaves:count,receivedDate:formatDate(req.body.receivedDate)||now.toISOString().slice(0,10),remarks:clean(req.body.remarks)}};
  const docs=numbers.map(chequeNo=>({...common,resource:LEAVES,reference:leafReference(bank.bankAccountId,chequeNo),title:chequeNo,date:now,
    data:{bookId,bankAccountId:bank.bankAccountId,bankName:bank.bankName,chequeNo,status:'AVAILABLE',issuedDate:'',chequeDate:'',issuedPartyName:'',issuedPartyGlobalId:'',issueFor:'CHEQUE',amount:0,clearedDate:'',bankTransactionReference:'',remarks:'',history:[latestEvent('AVAILABLE',req.auth,'Cheque leaf registered')]}}));
  await ensureLeafIndex();
  const session=await GenericRecord.startSession();
  try{
    await session.withTransaction(async()=>{
      const existing=await GenericRecord.findOne({tenantKey,app,resource:LEAVES,reference:{$in:docs.map(x=>x.reference)}}).select('_id reference').session(session).lean();
      if(existing) {const error=new Error('Some cheque leaves already exist in this bank account. Check starting number and leaf count.');error.statusCode=409;throw error;}
      await GenericRecord.create([book],{session});
      await GenericRecord.insertMany(docs,{session,ordered:true});
    });
  }finally{await session.endSession();}
  return ok(res,{bookId,startingNo:start,endingNo:numbers.at(-1),numberOfLeaves:count},'Cheque book registered',201);
}));
// Shared filtering keeps the highlighted and expanded issued-cheque registers
// consistent with the regular status/search/book filters.
const issuedFilter = (req) => {
  const filter={...source(req.auth.tenantKey,LEAVES)};
  if(clean(req.query.bankAccountId))filter['data.bankAccountId']=clean(req.query.bankAccountId);
  if(clean(req.query.bookId))filter['data.bookId']=clean(req.query.bookId);
  if(clean(req.query.status))filter['data.status']=clean(req.query.status).toUpperCase();
  const q=clean(req.query.q).slice(0,100);
  if(q){const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');filter.$or=[{'data.chequeNo':{$regex:escaped,$options:'i'}},{'data.issuedPartyName':{$regex:escaped,$options:'i'}}];}
  return filter;
};
const chequePageOptions = (req) => ({
  page:Math.max(1,Number.parseInt(req.query.page,10)||1),
  limit:Math.max(1,Math.min(100,Number.parseInt(req.query.limit,10)||50)),
});
const issuedResponse = docs => docs.map(x=>({id:String(x._id),...x.data}));
const unclearedChequeStatuses=['ISSUED','RETURNED'];
// Numeric order must match Issue Cheque even across books with different
// zero-padding or lengths (e.g. 99 precedes 100 and 0099).
const firstThreeAvailable = filter => GenericRecord.aggregate([
  {$match:{...filter,'data.status':'AVAILABLE'}},
  {$addFields:{chequeSerialSort:{$convert:{input:'$data.chequeNo',to:'decimal',onError:null,onNull:null}}}},
  {$sort:{chequeSerialSort:1,createdAt:1,_id:1}},
  {$limit:3}
]);
// The default Company Issued view shows uncleared cheques before any unused
// leaves, rather than letting a full cheque book hide pending payments.
router.get('/issued/highlights',access('view'),safe(async(req,res)=>{
  const filter=issuedFilter(req),{page,limit}=chequePageOptions(req);
  const uncleared={...filter,'data.status':{$in:unclearedChequeStatuses}};
  const available={...filter,'data.status':'AVAILABLE'};
  const [docs,unclearedTotal,preview,availableTotal,allTotal]=await Promise.all([
    GenericRecord.find(uncleared).sort({'data.issuedDate':-1,'data.chequeNo':1,_id:1}).skip((page-1)*limit).limit(limit).lean(),
    GenericRecord.countDocuments(uncleared),
    firstThreeAvailable(filter),
    GenericRecord.countDocuments(available),
    GenericRecord.countDocuments(filter)
  ]);
  return ok(res,{items:issuedResponse(docs),availablePreview:issuedResponse(preview),
    availableTotal,unclearedTotal,allTotal,remainingTotal:Math.max(0,allTotal-unclearedTotal-preview.length),
    meta:pageMeta(page,limit,unclearedTotal)});
}));
router.get('/issued/remaining',access('view'),safe(async(req,res)=>{
  const filter=issuedFilter(req),{page,limit}=chequePageOptions(req);
  const preview=await firstThreeAvailable(filter);
  const rest={...filter,'data.status':{$nin:unclearedChequeStatuses},_id:{$nin:preview.map(row=>row._id)}};
  const [docs,total]=await Promise.all([
    GenericRecord.find(rest).sort({'data.status':1,'data.chequeNo':1,_id:1}).skip((page-1)*limit).limit(limit).lean(),
    GenericRecord.countDocuments(rest)
  ]);
  return ok(res,{items:issuedResponse(docs),meta:pageMeta(page,limit,total)});
}));
router.get('/issued',access('view'),safe(async(req,res)=>{
  const {page,limit}=chequePageOptions(req),filter=issuedFilter(req);
  const [docs,total]=await Promise.all([GenericRecord.find(filter).sort({'data.chequeNo':1,_id:1}).skip((page-1)*limit).limit(limit).lean(),GenericRecord.countDocuments(filter)]);
  return ok(res,{items:issuedResponse(docs),meta:pageMeta(page,limit,total)});
}));
// Return the next AVAILABLE cheque for one company bank. Cheque number is
// read-only in the UI. This endpoint does not reserve a cheque: assignment
// happens atomically when the operator submits the Issue form.
const nextAvailableLeaf=async(tenantKey,bankAccountId)=>{
  const leaves=await GenericRecord.find({...source(tenantKey,LEAVES),'data.bankAccountId':bankAccountId,'data.status':'AVAILABLE'})
    .select('_id data.chequeNo data.bankAccountId data.bankName data.bookId data.status createdAt').lean();
  return pickFirstAvailableCheque(leaves);
};
router.get('/issued/next',access('view'),safe(async(req,res)=>{
  const bank=await bankFor(req.auth.tenantKey,req.query.bankAccountId);
  const leaf=await nextAvailableLeaf(req.auth.tenantKey,bank.bankAccountId);
  return ok(res,{available:!!leaf,bankAccountId:bank.bankAccountId,bankName:bank.bankName,
    next:leaf?{chequeNo:leaf.data.chequeNo,bookId:leaf.data.bookId,bankAccountId:bank.bankAccountId}:null});
}));

// One atomic claim for the FIRST available cheque. On a simultaneous claim,
// retry against the next available leaf. Never let the browser select a leaf.
async function claimFirstLeaf(req,data,status,reason){
  const bank=await bankFor(req.auth.tenantKey,data.bankAccountId);
  for(let attempt=0;attempt<5;attempt++){
    const leaf=await nextAvailableLeaf(req.auth.tenantKey,bank.bankAccountId);
    if(!leaf){const err=new Error('No available cheque leaves for this bank account. Register a cheque book first.');err.statusCode=409;throw err;}
    const event=latestEvent(status,req.auth,reason);
    const setFields={'data.status':status,'data.issueFor':status==='ISSUED'?data.issueFor:'CHEQUE',
      'data.issuedDate':status==='ISSUED'?data.issuedDate:'',
      'data.chequeDate':status==='ISSUED'?data.chequeDate:'',
      'data.issuedPartyName':status==='ISSUED'?data.issuedPartyName:'',
      'data.issuedPartyGlobalId':status==='ISSUED'?data.issuedPartyGlobalId:'',
      'data.amount':status==='ISSUED'?data.amount:0,
      'data.clearedDate':'',
      'data.bankTransactionReference':status==='ISSUED'?data.bankTransactionReference:'',
      'data.remarks':data.remarks,
      updatedBy:clean(req.auth.sub),amount:status==='ISSUED'?data.amount:0};
    const claimed=await GenericRecord.findOneAndUpdate(
      {...source(req.auth.tenantKey,LEAVES),_id:leaf._id,'data.status':'AVAILABLE'},
      {$set:setFields,$push:{'data.history':event}},
      {new:true,runValidators:true}
    );
    if(claimed)return {id:String(claimed._id),...claimed.data};
  }
  const err=new Error('Another user just assigned these cheque leaves. Refresh and try again.');err.statusCode=409;throw err;
}
router.post('/issued/issue',access('create'),safe(async(req,res)=>{
  const body=req.body||{};
  const issuedDate=formatDate(body.issuedDate),chequeDate=formatDate(body.chequeDate);
  const party=await requiredChequeParty(req.auth.tenantKey,body.issuedPartyGlobalId);
  const issuedPartyName=party.name,amount=positiveMoney(body.amount);
  if(!issuedDate)throw new Error('Date issued is required');
  const data={bankAccountId:clean(body.bankAccountId),issueFor:chequeIssuePurpose(body.issueFor),
    issuedDate,chequeDate,issuedPartyName,issuedPartyGlobalId:party.id,amount,
    bankTransactionReference:clean(body.bankTransactionReference),remarks:clean(body.remarks)};
  const item=await claimFirstLeaf(req,data,'ISSUED',`Issued for ${data.issueFor} to ${issuedPartyName}`);
  return ok(res,{item,chequeNo:item.chequeNo},`Cheque ${item.chequeNo} issued`,201);
}));
router.post('/issued/skip',access('create'),safe(async(req,res)=>{
  const body=req.body||{},status=chequeMissingLeafStatus(body.status),reason=clean(body.reason);
  if(!reason)throw new Error('Reason is mandatory before marking a cheque leaf unavailable');
  const data={bankAccountId:clean(body.bankAccountId),remarks:clean(body.remarks)};
  const item=await claimFirstLeaf(req,data,status,reason);
  return ok(res,{item,chequeNo:item.chequeNo},`Cheque ${item.chequeNo} marked ${status}`,201);
}));

router.patch('/issued/:id',access('edit'),safe(async(req,res)=>{
  const doc=await GenericRecord.findOne({...source(req.auth.tenantKey,LEAVES),_id:req.params.id});
  if(!doc)return fail(res,'Cheque leaf not found',404);
  const old=doc.data||{};
  if(['CLEARED','CANCELLED','LOST','STOLEN','MISTAKEN'].includes(old.status))return fail(res,'This cheque is locked. Status history cannot be overwritten.',409);
  const incomingStatus=clean(req.body.status||old.status).toUpperCase();
  if(old.status==='AVAILABLE')return fail(res,'Unused cheque leaves must be issued or marked unavailable through Issue Cheque in sequence',409);
  if(!canChequeTransition('ISSUED',old.status,incomingStatus))return fail(res,'Invalid cheque status transition',409);
  const party=await requiredChequeParty(req.auth.tenantKey,req.body.issuedPartyGlobalId||old.issuedPartyGlobalId);
  const changes={issuedDate:formatDate(req.body.issuedDate),chequeDate:formatDate(req.body.chequeDate),issuedPartyName:party.name,issuedPartyGlobalId:party.id,issueFor:chequeIssuePurpose(req.body.issueFor??old.issueFor),amount:nonNegativeMoney(req.body.amount),clearedDate:formatDate(req.body.clearedDate),bankTransactionReference:clean(req.body.bankTransactionReference),remarks:clean(req.body.remarks)};
  if(['ISSUED','CLEARED'].includes(incomingStatus)){
    if(!changes.issuedDate||!changes.issuedPartyName||changes.amount<=0)throw new Error('Issued date, party and positive amount are required');
  }
  if(incomingStatus==='CLEARED'&&!changes.clearedDate)throw new Error('Cleared date is required');
  if(['CANCELLED','LOST','STOLEN','MISTAKEN'].includes(incomingStatus)&&!clean(req.body.reason))throw new Error('A reason is required for Cancelled, Lost, Stolen or Mistaken cheques');
  doc.data={...old,...changes,status:incomingStatus,history:[...(old.history||[]),latestEvent(incomingStatus,req.auth,req.body.reason||'Updated cheque details')]};
  doc.amount=changes.amount;doc.updatedBy=clean(req.auth.sub);doc.markModified('data');await doc.save();
  return ok(res,{id:String(doc._id),...doc.data},'Cheque updated');
}));

// Company Received: physical custody never implies money has cleared.
// Mobile sessions use the separate /api/sales-app/cheques path and are scoped to
// their own records. The existing DMS /api/cheques routes retain Master rights.
const mobileRouter = express.Router();
mobileRouter.use(requireAuth);
const actorRole = auth => String(auth?.role||'').trim().toUpperCase().replace(/[- ]/g,'_');
const actorIsAllowed = auth => isChequeCollector(auth?.role)||isChequeSalesperson(auth?.role)||isChequeCashier(auth?.role);
const cashierActor = auth => isChequeCashier(auth?.role);
const mobileAuth = (req,res,next)=>{
  if(!actorIsAllowed(req.auth))return fail(res,'Only Sales Person, Collector or Cashier may use this workflow',403);
  return next();
};
const docForReceived=async(req,id)=>{
  const doc=await GenericRecord.findOne({...source(req.auth.tenantKey,RECEIVED),_id:id});
  if(!doc){const e=new Error('Cheque record not found');e.statusCode=404;throw e;}
  return doc;
};
const ownRecord=(auth,data)=>clean(data.receivedByUserId)===clean(auth.sub);
const accessReceived=(auth,data)=>isAdminAuth(auth)||cashierActor(auth)||ownRecord(auth,data);
const eventOf=(status,auth,reason='')=>latestEvent(status,auth,reason);
const resolvedCustomer=async(tenantKey,id)=>{
  if(!clean(id))return null;
  const customer=await CustomerLink.findOne({tenantKey,globalCustomerId:clean(id),status:{$ne:'INACTIVE'}})
    .select('globalCustomerId localName displayIdentifier accountingProfile salespersonId addresses registrationMeta').lean();
  if(!customer){const e=new Error('Select a linked customer from the company customer master before ledger posting');e.statusCode=409;throw e;}
  return customer;
};
const checkReceiver=async(auth)=>{
  const user=await User.findOne({_id:auth.sub,tenantKey:auth.tenantKey,status:'ACTIVE',loginEnabled:true})
    .select('name role designation accountType collectorPincodes').lean();
  if(!user)throw Object.assign(new Error('Your company user account is inactive'),{statusCode:403});
  return user;
};
const resolveChequeBank=async(code)=>{
  const ifsc=normalizeIfsc(code);
  if(!ifsc)throw new Error('IFSC is required');
  return ifscSnapshot(await getIfscMaster(ifsc));
};
const receivedData=async(req,raw,existing=null)=>{
  const d=raw||{}, old=existing||{};
  const item={
    chequeNo:clean(d.chequeNo??old.chequeNo),
    issuedByPartyName:clean(d.issuedByPartyName??old.issuedByPartyName),
    customerGlobalId:clean(d.customerGlobalId??old.customerGlobalId),
    ifsc:normalizeIfsc(d.ifsc??old.ifsc),
    receivedDate:formatDate(d.receivedDate??old.receivedDate),
    chequeDate:formatDate(d.chequeDate??old.chequeDate),
    amount:positiveMoney(d.amount??old.amount),
    remarks:clean(d.remarks??old.remarks),
    linkedReceiptNo:clean(d.linkedReceiptNo??old.linkedReceiptNo),
    linkedReceiptFy:clean(d.linkedReceiptFy??old.linkedReceiptFy),
    linkedBankTransactionId:clean(d.linkedBankTransactionId??old.linkedBankTransactionId)
  };
  validatesChequeIdentity(item);
  if(!item.receivedDate||!item.chequeDate)throw new Error('Cheque received date and cheque date are required');
  const bank=await resolveChequeBank(item.ifsc);
  // NEVER trust client-supplied bank name, branch or address.
  return {...item,issuerBankName:bank.bankName,issuerBranchName:bank.branchName,
    issuerBankAddress:bank.bankAddress,issuerCity:bank.city,issuerState:bank.state};
};
async function createReceived(req,res){
  const d=await receivedData(req,req.body);
  const role=actorRole(req.auth);
  const mobile=String(req.originalUrl||'').startsWith('/api/sales-app/');
  if(mobile){await checkReceiver(req.auth);if(!actorIsAllowed(req.auth))return fail(res,'Mobile cheque recording not permitted',403);}
  if(!mobile){
    const selected=await requiredChequeParty(req.auth.tenantKey,d.customerGlobalId);
    d.issuedByPartyName=selected.name;
  }
  if(d.customerGlobalId){
    const customer=await resolvedCustomer(req.auth.tenantKey,d.customerGlobalId);
    if(mobile&&(isChequeSalesperson(role)&&clean(customer.salespersonId)!==clean(req.auth.sub)))return fail(res,'Cheque customer is not assigned to this salesperson',403);
    if(mobile&&isChequeCollector(role)){const me=await checkReceiver(req.auth);if(!customerCollectionPincodes(customer).some(pin=>(me.collectorPincodes||[]).includes(pin)))return fail(res,'Cheque customer is outside your assigned pincodes',403);}
  }
  if(d.linkedBankTransactionId){
    const reusedBank=await GenericRecord.exists({...source(req.auth.tenantKey,RECEIVED),'data.linkedBankTransactionId':d.linkedBankTransactionId,'data.status':{$nin:['CANCELLED','LOST']}});
    if(reusedBank)return fail(res,'This bank posting is already linked to another active cheque',409);
  }
  if(d.linkedReceiptNo){
    const reused=await GenericRecord.exists({...source(req.auth.tenantKey,RECEIVED),'data.linkedReceiptNo':d.linkedReceiptNo,'data.status':{$nin:['CANCELLED','LOST']}});
    if(reused)return fail(res,'This original receipt is already linked to another active cheque',409);
  }
  const duplicate=await GenericRecord.exists({...source(req.auth.tenantKey,RECEIVED),'data.chequeNo':d.chequeNo,'data.ifsc':d.ifsc,'data.amount':d.amount,'data.status':{$nin:['CANCELLED','LOST']}});
  if(duplicate)return fail(res,'A matching active cheque is already registered (number, IFSC and amount)',409);
  const status=mobile?receiptCustodyStatus(role):'PENDING_RECEIVED';
  const id=randomUUID();
  const item={...d,status,custodyStatus:status,receivedByUserId:clean(req.auth.sub),
    receivedByName:clean(req.auth.name),receivedByRole:role,
    cashierUserId:cashierActor(req.auth)?clean(req.auth.sub):'',cashierReceivedAt:cashierActor(req.auth)?new Date().toISOString():'',
    depositBankAccountId:'',depositBankName:'',depositDate:'',clearedDate:'',statusDate:d.receivedDate,
    bouncedDate:'',bounceCharge:0,bounceChargeBearer:'COMPANY',bankTransactionReference:'',
    ledgerStatus:'NOT_POSTED',ledgerTransactionId:'',bounceChargeTransactionId:'',
    handoverOtpId:'',handoverCashierId:'',handoverVerified:false,
    history:[eventOf(status,req.auth,'Cheque physically received')]};
  const doc=await GenericRecord.create({tenantKey:req.auth.tenantKey,app,resource:RECEIVED,reference:id,
    title:`${item.chequeNo} • ${item.issuedByPartyName}`,date:new Date(`${item.receivedDate}T00:00:00.000Z`),
    amount:item.amount,status:'ACTIVE',createdBy:clean(req.auth.sub),data:item});
  return ok(res,{id:String(doc._id),...item},'Cheque recorded; custody tracked',201);
}
router.get('/ifsc/:ifsc',access('view'),safe(async(req,res)=>ok(res,{details:await resolveChequeBank(req.params.ifsc)})));
mobileRouter.get('/ifsc/:ifsc',mobileAuth,safe(async(req,res)=>ok(res,{details:await resolveChequeBank(req.params.ifsc)})));
router.get('/received/parties',access('view'),safe(async(req,res)=>{
  const q=clean(req.query.q).slice(0,70),filter={tenantKey:req.auth.tenantKey,status:{$ne:'INACTIVE'}};
  if(q){const re=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');filter.$or=[{localName:{$regex:re,$options:'i'}},{displayIdentifier:{$regex:re,$options:'i'}}];}
  const items=await CustomerLink.find(filter).select('globalCustomerId localName displayIdentifier').limit(100).lean();
  return ok(res,{items:items.map(x=>({id:x.globalCustomerId,name:x.localName||x.displayIdentifier||x.globalCustomerId}))});
}));
mobileRouter.get('/received/parties',mobileAuth,safe(async(req,res)=>{
  const self=await checkReceiver(req.auth),filter={tenantKey:req.auth.tenantKey,status:{$ne:'INACTIVE'}};
  if(isChequeSalesperson(req.auth.role))filter.salespersonId=clean(req.auth.sub);
  if(isChequeCollector(req.auth.role))Object.assign(filter,collectorTerritoryFilter(self.collectorPincodes));
  const items=await CustomerLink.find(filter).select('globalCustomerId localName displayIdentifier').limit(150).lean();
  return ok(res,{items:items.map(x=>({id:x.globalCustomerId,name:x.localName||x.displayIdentifier||x.globalCustomerId}))});
}));
router.post('/received',access('create'),safe(createReceived));
mobileRouter.post('/received',mobileAuth,safe(createReceived));
async function listReceived(req,res,mobile=false){
  const page=Math.max(1,Number.parseInt(req.query.page,10)||1),limit=Math.max(1,Math.min(100,Number.parseInt(req.query.limit,10)||50));
  const filter=source(req.auth.tenantKey,RECEIVED);
  if(mobile&&!cashierActor(req.auth))filter['data.receivedByUserId']=clean(req.auth.sub);
  if(clean(req.query.status))filter['data.status']=clean(req.query.status).toUpperCase();
  if(clean(req.query.bankAccountId))filter['data.depositBankAccountId']=clean(req.query.bankAccountId);
  const q=clean(req.query.q).slice(0,100);if(q){const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');filter.$or=[{'data.chequeNo':{$regex:escaped,$options:'i'}},{'data.issuedByPartyName':{$regex:escaped,$options:'i'}}];}
  const [docs,total]=await Promise.all([GenericRecord.find(filter).sort({'data.receivedDate':-1,_id:-1}).skip((page-1)*limit).limit(limit).lean(),GenericRecord.countDocuments(filter)]);
  return ok(res,{items:docs.map(x=>({id:String(x._id),...x.data})),meta:pageMeta(page,limit,total)});
}
router.get('/received',access('view'),safe((req,res)=>listReceived(req,res)));

// Single Company Received register: physical cheques + OTP-confirmed online receipts.
// Receipt-backed cheques remain visible even if IFSC is missing and automated
// cheque registration failed; those rows are flagged for review, not dropped.
// Repair only missing original payer IFSC; financial fields remain untouched.
// Repair also re-attempts the same idempotent registration used by Sales App.
router.patch('/company-received/receipts/:id/ifsc',access('edit'),safe(async(req,res)=>{
  const fy=clean(req.body?.financialYear);
  if(!/^20\d{2}-\d{2}$/.test(fy))return fail(res,'Financial year required',422);
  const {Receipt}=financialModels(req.auth.tenantKey,fy);
  const receipt=await Receipt.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear:fy,
    collectionSource:'SALESPERSON_APP',customerOtpStatus:'VERIFIED',status:'POSTED',$or:[{receiptType:'CHEQUE'},{mode:'CHEQUE'}]});
  if(!receipt)return fail(res,'Original OTP-verified cheque receipt not found',404);
  const linked=await GenericRecord.exists({...source(req.auth.tenantKey,RECEIVED),'data.linkedReceiptNo':receipt.receiptNo,'data.linkedReceiptFy':fy});
  if(linked)return fail(res,'Cheque already registered; edit its control record instead',409);
  if(clean(receipt.payerIfsc))return fail(res,'Original IFSC is already recorded; manual review required before changing a verified payer bank',409);
  const ifsc=normalizeIfsc(req.body?.ifsc);
  if(!ifsc)return fail(res,'Enter a valid 11-character IFSC',422);
  await getIfscMaster(ifsc);
  receipt.payerIfsc=ifsc;await receipt.save();
  const result=await syncChequeForReceipt(receipt,req.auth);
  return ok(res,{receiptId:String(receipt._id),chequeRegister:result},'Missing cheque IFSC completed and Company Received record linked');
}));

// One OTP approves an immutable bundle of the collector's cheques. The secret
// is issued only to DMS Cashier, while Accounts verifies it in Pending Approvals.
router.post('/cashier/collect-cheques',safe(async(req,res)=>{
  return fail(res,'Legacy cheque approval is retired. Collector hands cheques to Cashier using Deposit to Cashier; Company Received updates only at Cashier Close.',410);

  if(!cashierActor(req.auth)&&!isAdminAuth(req.auth)&&!canPageAction(req.auth.permissions||[],'/dms/cashier','edit'))return fail(res,'Cashier permission required',403);
  const fy=clean(req.body?.financialYear),ids=[...new Set(Array.isArray(req.body?.chequeIds)?req.body.chequeIds.map(clean):[])];
  if(!/^20\d{2}-\d{2}$/.test(fy)||!ids.length||ids.length>200||ids.some(x=>!/^[a-f0-9]{24}$/i.test(x)))return fail(res,'Select 1–100 valid cheques within a financial year',422);
  const docs=await GenericRecord.find({...source(req.auth.tenantKey,RECEIVED),_id:{$in:ids}});
  if(docs.length!==ids.length)return fail(res,'Selected cheque record not found',409);
  const collectorId=clean(req.body?.collectorId);
  if(!collectorId||docs.some(x=>clean(x.data?.receivedByUserId)!==collectorId))return fail(res,'Choose cheques collected by one person only',409);
  if(docs.some(x=>!['PENDING_WITH_SALESPERSON','PENDING_WITH_COLLECTOR','HANDOVER_REQUESTED','HANDOVER_OTP_ISSUED','HANDOVER_VERIFIED','PENDING_RECEIVED'].includes(x.data?.status)||!x.data?.linkedReceiptNo))
    return fail(res,'Only unapproved, receipt-linked cheques in collector custody may be bundled. Repair unlinked cheques first.',409);
  const {Receipt}=financialModels(req.auth.tenantKey,fy),nos=docs.map(x=>clean(x.data.linkedReceiptNo));
  if(docs.some(x=>clean(x.data.linkedReceiptFy)!==fy))return fail(res,'Cheque linked receipt belongs to another FY',409);
  const receipts=await Receipt.find({tenantKey:req.auth.tenantKey,financialYear:fy,receiptNo:{$in:nos},customerOtpStatus:'VERIFIED',
    collectionSource:'SALESPERSON_APP',disputeStatus:{$ne:'HOLD'},ledgerPostedAt:{$exists:false}}).lean();
  if(receipts.length!==ids.length||receipts.some(r=>!['CHEQUE','CHECK','CHQ'].includes(clean(r.receiptType||r.mode).toUpperCase())||!['PENDING','NOT_REQUIRED',''].includes(clean(r.chequeApprovalStatus||'PENDING').toUpperCase())))
    return fail(res,'A selected cheque is disputed, already approved/posted or not a verified cheque receipt',409);
  const active=await GenericRecord.exists({...source(req.auth.tenantKey,APPROVALS),'data.status':'PENDING','data.chequeIds':{$in:ids}});
  if(active)return fail(res,'One of these cheques is already in a pending approval bundle',409);
  const amount=docs.reduce((n,d)=>n+Number(d.data.amount||0),0),reference=randomUUID();
  const bundle=await GenericRecord.create({tenantKey:req.auth.tenantKey,app,resource:APPROVALS,reference,title:`Cheque bundle ${docs.length} (${collectorId})`,date:new Date(),status:'ACTIVE',createdBy:clean(req.auth.sub),data:{status:'PENDING',financialYear:fy,
    chequeIds:ids,receiptNos:nos,collectorId,collectorName:clean(docs[0].data.receivedByName),count:ids.length,amount,
    cashierId:clean(req.auth.sub),cashierName:clean(req.auth.name),createdAt:new Date().toISOString(),otpId:'',history:[]}});
  try{
    const otp=await createOtp({tenantKey:req.auth.tenantKey,transactionId:String(bundle._id),actionType:'CHEQUE_BUNDLE_COMPANY_APPROVAL',recipientId:clean(req.auth.sub),
      context:{bundleId:String(bundle._id),financialYear:fy,amount,count:ids.length},ttlSeconds:900});
    await GenericRecord.updateOne({_id:bundle._id},{$set:{'data.otpId':otp.otpId,'data.otpExpiresAt':otp.expiresAt}});
    await Receipt.updateMany({tenantKey:req.auth.tenantKey,financialYear:fy,receiptNo:{$in:nos},chequeApprovalStatus:{$ne:'APPROVED'}},{$set:{chequeApprovalStatus:'PENDING',chequeApprovalBatchId:String(bundle._id)}});
    return ok(res,{bundleId:String(bundle._id),otp:otp.code,expiresAt:otp.expiresAt,amount,count:ids.length},'Cashier OTP created. Enter it in Cheque Control → Pending Approvals.');
  }catch(e){await GenericRecord.updateOne({_id:bundle._id},{$set:{'data.status':'CANCELLED'}});throw e;}
}));
// Only the cashier who created a pending bundle can request a replacement OTP.
// The previous OTP becomes unusable as soon as its ID is replaced.
router.get('/cashier/pending-bundles',safe(async(req,res)=>{
  if(!cashierActor(req.auth)&&!isAdminAuth(req.auth)&&!canPageAction(req.auth.permissions||[],'/dms/cashier','view'))return fail(res,'Cashier View permission required',403);
  const fy=clean(req.query.financialYear),rows=await GenericRecord.find({...source(req.auth.tenantKey,APPROVALS),'data.status':'PENDING',
    ...(fy?{'data.financialYear':fy}:{}),...(isAdminAuth(req.auth)?{}:{'data.cashierId':clean(req.auth.sub)})}).sort({createdAt:-1}).limit(300).lean();
  return ok(res,{items:rows.map(x=>({id:String(x._id),collectorId:x.data?.collectorId,collectorName:x.data?.collectorName,
    cashierName:x.data?.cashierName,receiptCount:x.data?.count,amount:x.data?.amount,expiresAt:x.data?.otpExpiresAt}))});
}));
router.post('/cashier/pending-bundles/:id/refresh-otp',safe(async(req,res)=>{
  return fail(res,'Legacy cheque approval is retired. Collector hands cheques to Cashier using Deposit to Cashier; Company Received updates only at Cashier Close.',410);

  if(!cashierActor(req.auth)&&!isAdminAuth(req.auth)&&!canPageAction(req.auth.permissions||[],'/dms/cashier','edit'))return fail(res,'Cashier Edit permission required',403);
  const doc=await GenericRecord.findOne({...source(req.auth.tenantKey,APPROVALS),_id:req.params.id,'data.status':'PENDING',
    ...(isAdminAuth(req.auth)?{}:{'data.cashierId':clean(req.auth.sub)})});
  if(!doc)return fail(res,'Pending cashier cheque bundle not found',409);
  const otp=await createOtp({tenantKey:req.auth.tenantKey,transactionId:String(doc._id),actionType:'CHEQUE_BUNDLE_COMPANY_APPROVAL',
    recipientId:clean(doc.data.cashierId),context:{bundleId:String(doc._id),financialYear:doc.data.financialYear,
      amount:doc.data.amount,count:doc.data.count},ttlSeconds:900});
  const changed=await GenericRecord.updateOne({_id:doc._id,tenantKey:req.auth.tenantKey,'data.status':'PENDING'},
    {$set:{'data.otpId':otp.otpId,'data.otpExpiresAt':otp.expiresAt}});
  if(changed.modifiedCount!==1)return fail(res,'Bundle was approved while requesting OTP. Refresh.',409);
  return ok(res,{bundleId:String(doc._id),otp:otp.code,expiresAt:otp.expiresAt,count:doc.data.count},'New OTP generated. Enter in Cheque Control → Pending Approvals.');
}));
router.get('/pending-approvals',access('view'),safe(async(req,res)=>{
  const fy=clean(req.query.financialYear),query={...source(req.auth.tenantKey,APPROVALS)};
  if(fy)query['data.financialYear']=fy;
  const rows=await GenericRecord.find(query).sort({createdAt:-1}).limit(500).lean();
  return ok(res,{items:rows.map(x=>({id:String(x._id),...x.data,otpId:undefined}))});
}));
router.post('/pending-approvals/:id/verify',access('edit'),safe(async(req,res)=>{
  return fail(res,'Legacy cheque approval is retired. Collector hands cheques to Cashier using Deposit to Cashier; Company Received updates only at Cashier Close.',410);

  const doc=await GenericRecord.findOne({...source(req.auth.tenantKey,APPROVALS),_id:req.params.id});
  if(!doc||doc.data?.status!=='PENDING')return fail(res,'Approval bundle not found or already confirmed',409);
  const d=doc.data,code=clean(req.body?.otp);
  if(!/^\d{6}$/.test(code))return fail(res,'Enter six-digit cashier OTP',422);
  const receipts=financialModels(req.auth.tenantKey,d.financialYear).Receipt;
  const rows=await receipts.find({tenantKey:req.auth.tenantKey,financialYear:d.financialYear,receiptNo:{$in:d.receiptNos},disputeStatus:{$ne:'HOLD'},ledgerPostedAt:{$exists:false}}).lean();
  if(rows.length!==d.receiptNos.length)return fail(res,'One or more cheque receipts are disputed, posted, or missing. Bundle cannot be approved.',409);
  const current=await GenericRecord.find({...source(req.auth.tenantKey,RECEIVED),_id:{$in:d.chequeIds}}).lean();
  if(current.length!==d.chequeIds.length||current.some(x=>!['PENDING_WITH_SALESPERSON','PENDING_WITH_COLLECTOR','HANDOVER_REQUESTED','HANDOVER_OTP_ISSUED','HANDOVER_VERIFIED','PENDING_RECEIVED'].includes(x.data?.status)))return fail(res,'One or more cheques changed custody state. Refresh the bundle.',409);
  const otp=await verifyOtp({otpId:d.otpId,code});if(!otp.ok)return fail(res,otp.reason,400);
  if(otp.challenge.tenantKey!==req.auth.tenantKey||String(otp.challenge.transactionId)!==String(doc._id)||otp.challenge.actionType!=='CHEQUE_BUNDLE_COMPANY_APPROVAL'||String(otp.challenge.recipientId)!==clean(d.cashierId))return fail(res,'OTP does not belong to this cashier bundle',403);
  const at=new Date(),changed=await GenericRecord.findOneAndUpdate({_id:doc._id,'data.status':'PENDING'},{$set:{'data.status':'APPROVED','data.approvedAt':at,'data.approvedBy':clean(req.auth.sub),'data.approvedByName':clean(req.auth.name)}});
  if(!changed)return fail(res,'Bundle was approved by another user; refresh',409);
  for(const item of current)await GenericRecord.updateOne({_id:item._id,tenantKey:req.auth.tenantKey},{$set:{'data.status':'RECEIVED','data.custodyStatus':'RECEIVED','data.cashierUserId':clean(d.cashierId),
    'data.cashierReceivedAt':at.toISOString(),'data.statusDate':at.toISOString().slice(0,10),'data.approvalBundleId':String(doc._id)}});
  await receipts.updateMany({tenantKey:req.auth.tenantKey,financialYear:d.financialYear,receiptNo:{$in:d.receiptNos},chequeApprovalBatchId:String(doc._id)},
    {$set:{chequeApprovalStatus:'APPROVED',receiptWorkflowStatus:'READY_TO_POST_LEDGER'}});
  return ok(res,{bundleId:String(doc._id),count:current.length,amount:d.amount},'Cheque bundle verified. Receipts moved to Company Received; Post to Ledger remains separate.');
}));
router.post('/company-received/:id/post-ledger',access('edit'),safe(async(req,res)=>{
  const doc=await GenericRecord.findOne({...source(req.auth.tenantKey,RECEIVED),_id:req.params.id});
  if(!doc)return fail(res,'Registered company cheque not found',404);
  const d=doc.data||{},fy=clean(d.linkedReceiptFy||req.body?.financialYear);
  if(d.collectionLinked)return fail(res,'Collector cheques must pass Accounts OTP, bank deposit, clearance and explicit posting in the new Company Received workflow',409);
  if(!d.linkedReceiptNo||!d.approvalBundleId||!['RECEIVED','DEPOSITED','REDEPOSITED','CLEARED'].includes(d.status))return fail(res,'Cheque requires verified bundle approval before posting',409);
  const {Receipt}=financialModels(req.auth.tenantKey,fy),receipt=await Receipt.findOne({tenantKey:req.auth.tenantKey,financialYear:fy,receiptNo:d.linkedReceiptNo,chequeApprovalStatus:'APPROVED'});
  if(!receipt)return fail(res,'Approved original customer receipt not found',409);
  if(clean(receipt.chequeApprovalBatchId)!==clean(d.approvalBundleId))return fail(res,'Cheque approval bundle does not match the original receipt',409);
  const approvedBundle=await GenericRecord.exists({...source(req.auth.tenantKey,APPROVALS),_id:d.approvalBundleId,'data.status':'APPROVED',
    'data.financialYear':fy});
  if(!approvedBundle)return fail(res,'Original cheque bundle has not been approved',409);
  if(clean(receipt.customerGlobalId)!==clean(d.customerGlobalId)||Math.abs(Number(receipt.amount)-Number(d.amount))>0.009)return fail(res,'Original party or amount differs from cheque; posting blocked',409);
  const date=clean(req.body?.bankReceivedDate);
  const result=await postCustodyApprovedReceipt({tenantKey:req.auth.tenantKey,financialYear:fy,receiptId:receipt._id,channel:'CHEQUE',bankReceivedDate:date,
    bankAccountId:clean(req.body?.bankAccountId)||d.depositBankAccountId,actorId:req.auth.sub,actorName:req.auth.name||''});
  await GenericRecord.updateOne({_id:doc._id},{$set:{'data.ledgerStatus':'POSTED','data.ledgerTransactionId':receipt.receiptNo,
    'data.ledgerFinancialYear':fy,'data.ledgerPostingMode':'RECEIPT_BANK','data.bankReceivedDate':date,
    'data.depositBankAccountId':result.bankAccountId,'data.depositBankName':result.bankName,'data.bankLedgerTransactionId':result.bankTransactionId}});
  return ok(res,{...result,bankReceivedDate:date},result.alreadyPosted?'Existing ledger and bank posting verified':'Cheque posted to customer ledger and Bank Statement');
}));
router.get('/company-received',access('view'),safe(async(req,res)=>{
  const fy=clean(req.query.financialYear);
  if(!/^20\d{2}-\d{2}$/.test(fy)||Number(fy.slice(-2))!==((Number(fy.slice(0,4))+1)%100))return fail(res,'Select a valid financial year',400);
  const start=`${fy.slice(0,4)}-04-01`,end=`${Number(fy.slice(0,4))+1}-04-01`;
  const page=Math.max(1,Number.parseInt(req.query.page,10)||1),limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||50));
  const category=clean(req.query.category||'ALL').toUpperCase();
  const status=clean(req.query.status).toUpperCase(),q=clean(req.query.q).toLowerCase();
  const bankAccountId=clean(req.query.bankAccountId);
  const {Receipt}=financialModels(req.auth.tenantKey,fy);
  const [chequeDocs,receipts]=await Promise.all([
    GenericRecord.find({...source(req.auth.tenantKey,RECEIVED),$or:[
      {'data.linkedReceiptFy':fy},{'data.receivedDate':{$gte:start,$lt:end}}
    ]}).sort({'data.receivedDate':-1,_id:-1}).limit(5000).lean(),
    Receipt.find({tenantKey:req.auth.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',
      mode:{$ne:'CASH'},$and:[collectionConfirmationFilter],status:'POSTED'})
      .sort({date:-1,_id:-1}).limit(5000).lean()
  ]);
  const byReceipt=new Map();
  for(const doc of chequeDocs){const d=doc.data||{};if(clean(d.linkedReceiptFy)===fy&&clean(d.linkedReceiptNo))byReceipt.set(clean(d.linkedReceiptNo),doc);}
  // Cheques received this FY can legitimately originate from a verified
  // receipt in an earlier FY. Validate those links before treating records as
  // orphans; never hide a legitimate carried-forward cheque.
  const carriedLinks=new Set();
  const carriedByFY=new Map();
  for(const doc of chequeDocs){const d=doc.data||{};
    const origFY=clean(d.linkedReceiptFy),origNo=clean(d.linkedReceiptNo);
    if(!origFY||origFY===fy||!origNo||!/^20\d{2}-\d{2}$/.test(origFY))continue;
    if(!carriedByFY.has(origFY))carriedByFY.set(origFY,new Set());
    carriedByFY.get(origFY).add(origNo);
  }
  for(const [origFY,numbers] of carriedByFY){
    const {Receipt:OldReceipt}=financialModels(req.auth.tenantKey,origFY);
    const found=await OldReceipt.find({tenantKey:req.auth.tenantKey,financialYear:origFY,
      receiptNo:{$in:[...numbers]},status:'POSTED'}).select('receiptNo').lean();
    for(const receipt of found)carriedLinks.add(`${origFY}:${clean(receipt.receiptNo)}`);
  }
  const used=new Set(),rows=[];
  for(const receipt of receipts){
    const type=(clean(receipt.receiptType).toUpperCase()==='CHEQUE'||clean(receipt.mode).toUpperCase()==='CHEQUE')?'CHEQUE':clean(receipt.mode).toUpperCase()==='CASH'?'CASH':'ONLINE';
    if(type==='CASH')continue; // Cash is shown ONLY in Cashier / Pending Handover.
    // Customer-verified instruments are visible immediately; custody/Accounts
    // approval still controls deposit and ledger actions in the workflow.
    const base={entryType:type,receiptBacked:true,receiptId:String(receipt._id),receiptNo:receipt.receiptNo,
      collectedBy:receipt.collectedBySalespersonNameSnapshot||receipt.createdByNameSnapshot||'',
      date:receipt.date,amount:Number(receipt.amount||0),customerGlobalId:receipt.customerGlobalId||'',
      issuedByPartyName:receipt.partyNameSnapshot||'',remarks:receipt.remarks||'',
      reference:receipt.upiPaymentText||receipt.reference||'',
      originalReceiptStatus:receipt.status,customerOtpStatus:receipt.customerOtpStatus};
    if(type==='ONLINE'){
      rows.push({...base,id:`online:${receipt._id}`,status:receipt.bankMatchStatus==='BANK_MATCHED'?'BANK_MATCHED':'PENDING_BANK_VERIFICATION',
        paymentType:receipt.receiptType||'',bankAccountId:receipt.bankAccountId||'',
        bankMatchStatus:receipt.bankMatchStatus||'',onlineStatus:receipt.bankMatchStatus==='BANK_MATCHED'?'BANK_MATCHED':'PENDING_BANK_VERIFICATION',
        editableNotes:receipt.bankMatchStatus!=='BANK_MATCHED',deletable:false});
      continue;
    }
    const doc=byReceipt.get(clean(receipt.receiptNo));
    if(doc){used.add(String(doc._id));rows.push({...base,...doc.data,id:String(doc._id),entryType:'CHEQUE',
      receiptBacked:true,receiptId:String(receipt._id),receiptNo:receipt.receiptNo,
      collectedBy:base.collectedBy,editableNotes:true,deletable:false});}
    else rows.push({...base,id:`unlinked:${receipt._id}`,chequeNo:receipt.chequeNumber||'',
      ifsc:receipt.payerIfsc||'',chequeDate:receipt.chequeIssueDate?new Date(receipt.chequeIssueDate).toISOString().slice(0,10):'',
      receivedDate:receipt.date?new Date(receipt.date).toISOString().slice(0,10):'',
      status:'NEEDS_REGISTRATION',registrationIssue:!receipt.payerIfsc?'IFSC missing — update the original collection details':'Automatic cheque linkage incomplete',
      editableNotes:true,deletable:false});
  }
  for(const doc of chequeDocs){if(used.has(String(doc._id)))continue;const d=doc.data||{};
    // Avoid showing an orphan from the same FY twice if it was already covered
    // by a receipt-backed cheque without a successful register link.
    if(clean(d.linkedReceiptNo)) {
      // Collector-linked cheque documents outlive manually deleted Receipt
      // documents. Show only a verified cross-year carry-forward link here;
      // same-year originals are handled by the main Receipt-backed rows above.
      if(!carriedLinks.has(`${clean(d.linkedReceiptFy)}:${clean(d.linkedReceiptNo)}`))continue;
    }
    if(d.collectionLinked && !d.approvalBundleId)continue; // collector-held cheques cannot appear in Company Received
    if(d.approvalBundleId&&d.status!=='RECEIVED'&&!['DEPOSITED','CLEARED','REDEPOSITED'].includes(d.status))continue;
    rows.push({...d,id:String(doc._id),entryType:'CHEQUE',receiptBacked:false,
      date:d.receivedDate||doc.date,editableNotes:true,deletable:!['DEPOSITED','REDEPOSITED','CLEARED'].includes(d.status)&&!d.ledgerTransactionId});
  }
  const filtered=rows.filter(r=>(category==='ALL'||category===r.entryType)
    &&(!status||clean(r.status).toUpperCase()===status)
    &&(!bankAccountId||clean(r.depositBankAccountId||r.bankAccountId)===bankAccountId)
    &&(!q||[r.chequeNo,r.receiptNo,r.issuedByPartyName,r.collectedBy,r.reference,r.ifsc]
      .some(v=>clean(v).toLowerCase().includes(q))));
  const dateOf=r=>{const x=r.receivedDate||r.date;return x?new Date(x).getTime()||0:0;};
  filtered.sort((a,b)=>dateOf(b)-dateOf(a)||String(b.id).localeCompare(String(a.id)));
  const total=filtered.length;
  // Per-row eligibility prevents a disabled trash button from appearing broken.
  // The DELETE route independently re-checks this rule against current DB data.
  const resultPage=filtered.slice((page-1)*limit,page*limit).map(row=>{
    const deleteBlockedReason=receivedChequeDeleteBlocker(row);
    return {...row,deletable:!deleteBlockedReason,deleteBlockedReason};
  });
  return ok(res,{items:resultPage,meta:pageMeta(page,limit,total),
    counts:{cheques:rows.filter(x=>x.entryType==='CHEQUE').length,online:rows.filter(x=>x.entryType==='ONLINE').length},
    partial:chequeDocs.length===5000||receipts.length===5000});
}));

// DMS cashier may VIEW incoming cheque custody alongside cash handover batches.
// Only an authenticated CASHIER may generate or accept the custody OTP (mobile
// workflow remains the single source for custody state changes).
router.get('/cashier/queue', (req,res,next)=>{
  if(isAdminAuth(req.auth)||canPageAction(req.auth.permissions||[],'/dms/cashier','view')||permissionStatus(req.auth,'view'))return next();
  return fail(res,'Cashier View permission required',403);
},safe(async(req,res)=>{
  const fy=clean(req.query.financialYear),scope=source(req.auth.tenantKey,RECEIVED);
  const docs=await GenericRecord.find({...scope,
    'data.status':{$in:['PENDING_WITH_SALESPERSON','PENDING_WITH_COLLECTOR','HANDOVER_REQUESTED','HANDOVER_OTP_ISSUED','HANDOVER_VERIFIED']}})
    .sort({createdAt:-1}).limit(1000).lean();
  let items=docs.map(x=>({id:String(x._id),...x.data}));
  if(fy){
    if(!/^20\d{2}-\d{2}$/.test(fy))return fail(res,'Valid financial year required',400);
    const {Receipt}=financialModels(req.auth.tenantKey,fy);
    const receiptFilter={tenantKey:req.auth.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',
      $or:[{receiptType:'CHEQUE'},{mode:'CHEQUE'}],customerOtpStatus:'VERIFIED',status:'POSTED'};
    const selectedFields='_id receiptNo chequeNumber payerIfsc amount date chequeIssueDate partyNameSnapshot collectedBySalespersonNameSnapshot disputeStatus disputeRemark ledgerPostedAt chequeApprovalStatus chequeApprovalBatchId collectedBySalespersonId';
    const newestReceipts=await Receipt.find(receiptFilter).select(selectedFields).sort({date:-1}).limit(2000).lean();
    // Check the specific register rows as well: a receipt outside the newest
    // 2000 must not be incorrectly classified as deleted.
    const linkedNos=[...new Set(items.map(x=>clean(x.linkedReceiptNo)).filter(Boolean))];
    const linkedReceipts=linkedNos.length?await Receipt.find({...receiptFilter,receiptNo:{$in:linkedNos}})
      .select(selectedFields).lean():[];
    const receipts=[...new Map([...newestReceipts,...linkedReceipts].map(r=>[String(r._id),r])).values()];
    const already=await GenericRecord.find({...scope,'data.linkedReceiptFy':fy,'data.linkedReceiptNo':{$in:receipts.map(r=>r.receiptNo)}})
      .select('data.linkedReceiptNo').lean();
    const linked=new Set(already.map(r=>clean(r.data?.linkedReceiptNo)));
    const missing=receipts.filter(r=>!linked.has(clean(r.receiptNo))).map(r=>({id:`unlinked:${r._id}`,
      receiptId:String(r._id),receiptNo:r.receiptNo,receivedDate:r.date?new Date(r.date).toISOString().slice(0,10):'',
      chequeDate:r.chequeIssueDate?new Date(r.chequeIssueDate).toISOString().slice(0,10):'',
      chequeNo:r.chequeNumber,issuedByPartyName:r.partyNameSnapshot,receivedByName:r.collectedBySalespersonNameSnapshot,
      amount:r.amount,ifsc:r.payerIfsc||'',status:'NEEDS_REGISTRATION',collectionLinked:true,
      registrationIssue:!r.payerIfsc?'IFSC missing':'Registration requires review'}));
    const byNo=new Map(receipts.map(r=>[clean(r.receiptNo),r]));
    items=[...items.filter(x=>{
      const date=clean(x.receivedDate),linkedNo=clean(x.linkedReceiptNo);
      // Only ACTIVE verified original receipts qualify for collector custody.
      // A stale GenericRecord is not an independent collector payment.
      return linkedNo && byNo.has(linkedNo) && (!date||fyForDate(date)===fy) &&
        (!clean(x.linkedReceiptFy)||clean(x.linkedReceiptFy)===fy);
    }).map(x=>{
      const r=byNo.get(clean(x.linkedReceiptNo));return {...x,receiptId:String(r._id),
      receiptNo:r.receiptNo,disputeStatus:r.disputeStatus||'NONE',
      disputeRemark:r.disputeRemark||'',ledgerPostedAt:r.ledgerPostedAt||null,chequeApprovalBatchId:r.chequeApprovalBatchId||'',receivedByUserId:r.collectedBySalespersonId||x.receivedByUserId||''};
    }),...missing.map(x=>({...x,disputeStatus:byNo.get(clean(x.receiptNo))?.disputeStatus||'NONE',receivedByUserId:byNo.get(clean(x.receiptNo))?.collectedBySalespersonId||''}))];
  }
  return ok(res,{items});
}));

// Edits and deletion apply to control records only, not customer/Bank Ledger
// postings. Linked receipt rows cannot be deleted independently of accounting.
router.patch('/received/:id/notes',(req,res,next)=>{
  if(isAdminAuth(req.auth)||permissionStatus(req.auth,'edit')||canPageAction(req.auth.permissions||[],'/dms/cashier','edit'))return next();
  return fail(res,'Cheque Control or Cashier Edit permission required',403);
},safe(async(req,res)=>{
  const doc=await docForReceived(req,req.params.id),d=doc.data||{};
  const remarks=clean(req.body?.remarks);
  if(remarks.length>1000)return fail(res,'Remarks limited to 1,000 characters',422);
  doc.data={...d,remarks,history:[...(d.history||[]),latestEvent(d.status,req.auth,'Non-financial remarks amended')]};
  doc.updatedBy=clean(req.auth.sub);doc.markModified('data');await doc.save();
  return ok(res,{id:String(doc._id),remarks},'Cheque remarks edited; custody and ledger unchanged');
}));
router.delete('/received/:id',access('delete'),safe(async(req,res)=>{
  const doc=await docForReceived(req,req.params.id),d=doc.data||{};
  const blocked=receivedChequeDeleteBlocker(d);
  if(blocked)return fail(res,blocked,409);
  const reason=clean(req.body?.reason);
  if(reason.length<5)return fail(res,'Enter a deletion reason (at least 5 characters)',422);
  // Guard against concurrent cashier handover, deposit, or ledger linkage.
  // If the document changed after the eligibility check, require refresh.
  const result=await GenericRecord.deleteOne({_id:doc._id,...source(req.auth.tenantKey,RECEIVED),updatedAt:doc.updatedAt});
  if(result.deletedCount!==1)return fail(res,'Cheque changed while deleting. Refresh Company Received and try again.',409);
  return ok(res,{deleted:true,reason},'Independent, unposted received cheque deleted');
}));
// Bulk delete means audit-preserving cancellation of physical cheque leaves.
// An issued number may not disappear, be reused, or be cancelled after posting.
// The batch is all-or-nothing: every selected row is checked inside a transaction.
router.post('/issued/bulk-cancel',access('delete'),safe(async(req,res)=>{
  const ids=req.body?.ids;
  const reason=clean(req.body?.reason);
  if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{24}$/i.test(id))||new Set(ids).size!==ids.length)
    return fail(res,'Select between 1 and 200 distinct cheque leaves',422);
  if(reason.length<5)return fail(res,'Enter a cancellation reason of at least 5 characters',422);
  const session=await GenericRecord.startSession();
  try{
    await session.withTransaction(async()=>{
      const docs=await GenericRecord.find({...source(req.auth.tenantKey,LEAVES),_id:{$in:ids}}).session(session);
      if(docs.length!==ids.length)throw Object.assign(new Error('Some cheques no longer exist. Refresh and select again.'),{statusCode:409});
      for(const doc of docs){
        const data=doc.data||{};
        if(!['AVAILABLE','ISSUED','RETURNED'].includes(data.status))
          throw Object.assign(new Error(`Cheque ${data.chequeNo||''} cannot be cancelled in status ${data.status||'UNKNOWN'}`),{statusCode:409});
        if(clean(data.bankTransactionReference)||data.ledgerTransactionId)
          throw Object.assign(new Error(`Cheque ${data.chequeNo||''} has a bank/ledger reference; reconcile it before cancellation`),{statusCode:409});
      }
      for(const doc of docs){
        doc.data={...doc.data,status:'CANCELLED',history:[...(doc.data?.history||[]),latestEvent('CANCELLED',req.auth,`Bulk deletion requested: ${reason}`)]};
        doc.updatedBy=clean(req.auth.sub);
        doc.markModified('data');
        await doc.save({session});
      }
    });
  }finally{await session.endSession();}
  return ok(res,{cancelled:ids.length},`${ids.length} cheque leaf/leaves cancelled with audit history retained`);
}));
router.delete('/issued/:id',access('delete'),safe(async(req,res)=>{
  const doc=await GenericRecord.findOne({...source(req.auth.tenantKey,LEAVES),_id:req.params.id});
  if(!doc)return fail(res,'Cheque leaf not found',404);
  const d=doc.data||{};
  if(d.status==='AVAILABLE')return fail(res,'Available leaves belong to a registered cheque book. Delete the unused cheque book instead.',409);
  if(!['ISSUED','RETURNED'].includes(d.status))return fail(res,'Cleared, lost, cancelled and otherwise finalized cheque leaves cannot be deleted',409);
  if(clean(d.bankTransactionReference)||d.ledgerTransactionId)return fail(res,'Cheque has a bank/ledger reference; reverse or reconcile its accounting first',409);
  const reason=clean(req.body?.reason);
  if(reason.length<5)return fail(res,'Reason of at least 5 characters required to cancel the issued cheque',422);
  // An issued physical cheque number must never become AVAILABLE or disappear.
  // Delete action is recorded as CANCELLED in the audit register.
  doc.data={...d,status:'CANCELLED',history:[...(d.history||[]),latestEvent('CANCELLED',req.auth,`Deletion requested: ${reason}`)]};
  doc.updatedBy=clean(req.auth.sub);doc.markModified('data');await doc.save();
  return ok(res,{id:String(doc._id),status:'CANCELLED'},'Issued cheque cancelled; numbered audit record preserved');
}));
router.delete('/issued/books/:id',access('delete'),safe(async(req,res)=>{
  const book=await GenericRecord.findOne({...source(req.auth.tenantKey,BOOKS),'data.bookId':req.params.id});
  if(!book)return fail(res,'Cheque book not found',404);
  const scope={...source(req.auth.tenantKey,LEAVES),'data.bookId':req.params.id};
  const used=await GenericRecord.exists({...scope,'data.status':{$ne:'AVAILABLE'}});
  if(used)return fail(res,'Cannot delete a cheque book after any leaf is issued or marked unavailable',409);
  await GenericRecord.deleteMany({...scope,'data.status':'AVAILABLE'});
  await GenericRecord.deleteOne({_id:book._id,...source(req.auth.tenantKey,BOOKS)});
  return ok(res,{deleted:true},'Unused cheque book deleted');
}));


// Deposit-slip preparation is read-only: never changes cheque custody/status,
// and never posts to the Bank Book or customer ledger.
async function depositSlipBank(req, id) {
  const bank = await BankAccount.findOne({tenantKey:req.auth.tenantKey,bankAccountId:clean(id),status:'ACTIVE'})
    .select('bankAccountId bankName branchName accountHolderName accountNumber phone contactNo isPrimary').lean();
  if (!bank) throw Object.assign(new Error('Select an active company bank account'),{statusCode:422});
  return bank;
}
function slipDate(raw){
  const d=clean(raw)||kolkataToday();
  if(!isISODate(d)||d>kolkataToday())throw Object.assign(new Error('Slip deposit date must be a valid date up to today'),{statusCode:422});
  return d;
}
async function dueDepositCheques(req,bank,depositDate){
  const query={...source(req.auth.tenantKey,RECEIVED),
    'data.status':{$in:['PENDING_RECEIVED','RECEIVED']},
    'data.chequeDate':{$lte:depositDate},'data.receivedDate':{$lte:depositDate},
    $or:[{'data.depositBankAccountId':bank.bankAccountId},{'data.depositBankAccountId':''},{'data.depositBankAccountId':{$exists:false}}]};
  const docs=await GenericRecord.find(query)
    .select('_id data status').sort({'data.chequeDate':1,'data.receivedDate':1,_id:1}).limit(1501).lean();
  // The post-query validator checks every record, including malformed legacy rows.
  const eligible=docs.filter(doc=>isEligibleReceivedCheque(doc.data||{},depositDate,bank.bankAccountId))
    .map(doc=>({id:String(doc._id),...doc.data}));
  return {items:eligible.slice(0,1500),hasMore:docs.length>1500};
}
router.get('/received/deposit-slip/eligible',access('view'),safe(async(req,res)=>{
  const depositDate=slipDate(req.query.depositDate);
  const bank=await depositSlipBank(req,req.query.bankAccountId);
  const eligible=await dueDepositCheques(req,bank,depositDate);
  return ok(res,{depositDate,bank:{bankAccountId:bank.bankAccountId,bankName:bank.bankName,
    branchName:bank.branchName,accountHolderName:bank.accountHolderName,
    accountNumberMasked:`•••• ${String(bank.accountNumber||'').slice(-4)}`},
    supportedForm:isSbiDepositAccount(bank),
    ...eligible,
    totalAmount:eligible.items.reduce((sum,c)=>sum+Number(c.amount||0),0),
    note:'Preview only. Printing does not deposit/clear cheques or post ledger entries.'});
}));
router.post('/received/deposit-slip/pdf',access('download'),safe(async(req,res)=>{
  const depositDate=slipDate(req.body?.depositDate),bank=await depositSlipBank(req,req.body?.bankAccountId);
  if(!isSbiDepositAccount(bank))return fail(res,'The uploaded form is an SBI deposit slip. Select an SBI bank account; do not use this form for other banks.',422);
  const ids=req.body?.chequeIds;
  if(!Array.isArray(ids)||ids.length<1||ids.length>200||ids.some(id=>!(/^[a-f0-9]{24}$/i.test(clean(id)))))return fail(res,'Select between 1 and 200 valid received cheques',422);
  const unique=[...new Set(ids.map(x=>clean(x)))];
  if(unique.length!==ids.length)return fail(res,'Duplicate cheques selected',422);
  const all=await dueDepositCheques(req,bank,depositDate);
  if(all.hasMore)return fail(res,'More than 1,500 eligible cheques; refine the register before printing',422);
  const byId=new Map(all.items.map(row=>[row.id,row]));
  if(unique.some(id=>!byId.has(id)))return fail(res,'Some cheques are not yet due, are not in company custody, or have already been deposited. Refresh the queue.',409);
  const chosen=unique.map(id=>byId.get(id)).sort((a,b)=>a.chequeDate.localeCompare(b.chequeDate)||a.chequeNo.localeCompare(b.chequeNo));
  streamSbiDepositSlipPDF(res,{bank,depositDate,cheques:chosen});
}));

mobileRouter.get('/received',mobileAuth,safe((req,res)=>listReceived(req,res,true)));
// Sender requests handover, but cannot create or read a cashier's OTP.
mobileRouter.post('/received/:id/handover/request',mobileAuth,safe(async(req,res)=>{
  if(!(isChequeCollector(req.auth.role)||isChequeSalesperson(req.auth.role)))return fail(res,'Only the collecting person may request handover',403);
  const doc=await docForReceived(req,req.params.id),d=doc.data||{};
  if(!ownRecord(req.auth,d)||!['PENDING_WITH_COLLECTOR','PENDING_WITH_SALESPERSON','HANDOVER_REQUESTED'].includes(d.status))return fail(res,'This cheque is not awaiting your handover',409);
  doc.data={...d,status:'HANDOVER_REQUESTED',statusDate:new Date().toISOString().slice(0,10),history:[...(d.history||[]),eventOf('HANDOVER_REQUESTED',req.auth,'Requested cashier handover')]};
  doc.markModified('data');await doc.save();return ok(res,{id:String(doc._id),status:doc.data.status},'Ask cashier to generate their handover OTP');
}));
// OTP is shown ONLY to the authenticated cashier, and is never sent back to
// the collector/salesperson who requested the handover.
mobileRouter.post('/received/:id/handover/cashier-otp',mobileAuth,safe(async(req,res)=>{
  if(!cashierActor(req.auth))return fail(res,'Cashier login required',403);
  await checkReceiver(req.auth);
  const doc=await docForReceived(req,req.params.id),d=doc.data||{};
  if(!['HANDOVER_REQUESTED','HANDOVER_OTP_ISSUED'].includes(d.status))return fail(res,'Sender must request handover first',409);
  if(d.handoverOtpId)await OtpChallenge.updateOne({tenantKey:req.auth.tenantKey,otpId:d.handoverOtpId,status:'PENDING'},{$set:{status:'EXPIRED'}});
  const otp=await createOtp({tenantKey:req.auth.tenantKey,transactionId:String(doc._id),actionType:'CHEQUE_CASHIER_HANDOVER',recipientId:clean(req.auth.sub),ttlSeconds:300,
    context:{chequeNo:d.chequeNo,amount:d.amount,senderId:d.receivedByUserId}});
  doc.data={...d,status:'HANDOVER_OTP_ISSUED',handoverOtpId:otp.otpId,handoverCashierId:clean(req.auth.sub),handoverVerified:false,handoverTries:0,
    history:[...(d.history||[]),eventOf('HANDOVER_OTP_ISSUED',req.auth,'Cashier generated handover OTP')]};
  doc.markModified('data');await doc.save();
  return ok(res,{otp:otp.code,expiresAt:otp.expiresAt,chequeNo:d.chequeNo,amount:d.amount},'Show OTP to the collecting person after physically checking cheque');
}));
mobileRouter.post('/received/:id/handover/sender-verify',mobileAuth,safe(async(req,res)=>{
  if(!(isChequeCollector(req.auth.role)||isChequeSalesperson(req.auth.role)))return fail(res,'Collecting person login required',403);
  const doc=await docForReceived(req,req.params.id),d=doc.data||{};
  if(!ownRecord(req.auth,d)||d.status!=='HANDOVER_OTP_ISSUED'||!d.handoverOtpId)return fail(res,'No active handover OTP for your cheque',409);
  const tries=Number(d.handoverTries||0);
  if(tries>=5)return fail(res,'Too many failed attempts. Cashier must generate a new OTP.',429);
  const result=await verifyOtp({otpId:d.handoverOtpId,code:clean(req.body.code)});
  if(!result.ok){await GenericRecord.updateOne({_id:doc._id,tenantKey:req.auth.tenantKey,'data.status':'HANDOVER_OTP_ISSUED'},{$inc:{'data.handoverTries':1}});return fail(res,result.reason,400);}
  if(result.challenge.tenantKey!==req.auth.tenantKey||String(result.challenge.transactionId)!==String(doc._id)||result.challenge.actionType!=='CHEQUE_CASHIER_HANDOVER'||clean(result.challenge.recipientId)!==clean(d.handoverCashierId))return fail(res,'OTP does not belong to this handover',403);
  doc.data={...d,status:'HANDOVER_VERIFIED',handoverVerified:true,
    history:[...(d.history||[]),eventOf('HANDOVER_VERIFIED',req.auth,'Sender entered cashier OTP')]};
  doc.markModified('data');await doc.save();return ok(res,{verified:true},'OTP verified; cashier must accept the physical cheque');
}));
mobileRouter.post('/received/:id/handover/cashier-accept',mobileAuth,safe(async(req,res)=>{
  if(!cashierActor(req.auth))return fail(res,'Cashier login required',403);
  await checkReceiver(req.auth);
  const doc=await docForReceived(req,req.params.id),d=doc.data||{};
  if(d.status!=='HANDOVER_VERIFIED'||!d.handoverVerified||clean(d.handoverCashierId)!==clean(req.auth.sub))return fail(res,'Cheque must be OTP verified for this cashier first',409);
  const item=await GenericRecord.findOneAndUpdate({_id:doc._id,tenantKey:req.auth.tenantKey,app,resource:RECEIVED,'data.status':'HANDOVER_VERIFIED','data.handoverCashierId':clean(req.auth.sub)},
    {$set:{'data.status':'PENDING_RECEIVED','data.custodyStatus':'WITH_CASHIER','data.cashierUserId':clean(req.auth.sub),'data.cashierReceivedAt':new Date().toISOString(),'data.statusDate':new Date().toISOString().slice(0,10)},
      $push:{'data.history':eventOf('PENDING_RECEIVED',req.auth,'Cashier checked and accepted original cheque')}} ,{new:true});
  if(!item)return fail(res,'Cheque handover was already completed or changed',409);
  return ok(res,{id:String(item._id),...item.data},'Cheque received by cashier; company register now Pending Received');
}));
// Read-only cashier queue (both unverified handovers and accepted cheques).
mobileRouter.get('/cashier/queue',mobileAuth,safe(async(req,res)=>{
  if(!cashierActor(req.auth))return fail(res,'Cashier login required',403);
  const rows=await GenericRecord.find({...source(req.auth.tenantKey,RECEIVED),'data.status':{$in:['HANDOVER_REQUESTED','HANDOVER_OTP_ISSUED','HANDOVER_VERIFIED','PENDING_RECEIVED']}}).sort({createdAt:-1}).limit(100).lean();
  return ok(res,{items:rows.map(x=>({id:String(x._id),...x.data}))});
}));
// Ledger posting is deliberately separated from custody and from depositing.
// A bank credit can be posted ONLY after cheque clearance confirmation.
async function postChequeClearing(req,doc,data,clearedDate,bank,reference){
  if(!data.customerGlobalId)throw Object.assign(new Error('Link a verified customer before clearing/posting cheque'),{statusCode:409});
  const customer=await resolvedCustomer(req.auth.tenantKey,data.customerGlobalId);
  const financialYear=fyForDate(clearedDate),models=financialModels(req.auth.tenantKey,financialYear);
  const amount=positiveMoney(data.amount),transactionId=`CHQ-${clean(doc.reference).replace(/-/g,'').slice(0,20)}`;
  const date=new Date(`${clearedDate}T00:00:00.000Z`);
  const linkedNo=clean(data.linkedReceiptNo);
  let mode='NEW_RECEIPT';
  if(data.linkedBankTransactionId&&linkedNo)throw Object.assign(new Error('Do not link an already-credited customer receipt to another posted bank receipt without reconciliation'),{statusCode:409});
  if(linkedNo){
    const oldFy=clean(data.linkedReceiptFy)||fyForDate(data.receivedDate);
    const existing=await financialModels(req.auth.tenantKey,oldFy).Receipt.findOne({tenantKey:req.auth.tenantKey,financialYear:oldFy,receiptNo:linkedNo,status:'POSTED'}).lean();
    if(!existing||Number(existing.amount)!==amount||clean(existing.customerGlobalId)!==data.customerGlobalId || !['CHEQUE','CHECK','CHQ'].includes(clean(existing.receiptType||existing.mode).toUpperCase())){
      throw Object.assign(new Error('Linked original cheque receipt was not found or has different amount/customer'),{statusCode:409});
    }
    const postedBank=await financialModels(req.auth.tenantKey,oldFy).LedgerEntry.findOne({tenantKey:req.auth.tenantKey,financialYear:oldFy,
      transactionId:existing.bankLedgerTransactionId||linkedNo,bankAccountId:bank.bankAccountId,
      accountCode:['OD','CC'].includes(clean(bank.accountType).toUpperCase())?'SYS_BANK_OD':'SYS_BANK_ACCOUNT',status:'POSTED',debit:amount}).lean();
    if(postedBank)return {transactionId:existing.bankLedgerTransactionId||linkedNo,financialYear:oldFy,mode:'LINKED_EXISTING'};
    const oldLedger=await financialModels(req.auth.tenantKey,oldFy).LedgerEntry.findOne({tenantKey:req.auth.tenantKey,financialYear:oldFy,transactionId:linkedNo,transactionType:'RECEIPT',accountCode:'SYS_SUSPENSE',status:'POSTED',debit:amount}).lean();
    if(!oldLedger)throw Object.assign(new Error('Linked receipt has no matching open cheque suspense debit; reconcile before clearing'),{statusCode:409});
    mode='SUSPENSE_CLEARING';
  }
  if(data.linkedBankTransactionId){
    const rows=await models.LedgerEntry.find({tenantKey:req.auth.tenantKey,financialYear,transactionId:data.linkedBankTransactionId,status:'POSTED'}).lean();
    const debitBank=rows.some(x=>x.accountCode==='SYS_BANK_ACCOUNT'&&x.bankAccountId===bank.bankAccountId&&Math.abs(Number(x.debit||0)-amount)<0.01);
    const creditParty=rows.some(x=>x.accountCode===(customer.accountingProfile?.systemAccountCode||'SYS_SUNDRY_DEBTORS')&&String(x.partyGlobalId)===data.customerGlobalId&&Math.abs(Number(x.credit||0)-amount)<0.01);
    if(!debitBank||!creditParty)throw Object.assign(new Error('Existing bank posting must match this cheque amount, bank and customer credit before linkage'),{statusCode:409});
    return {transactionId:data.linkedBankTransactionId,financialYear,mode:'LINKED_EXISTING'};
  }
  // If the bank statement already produced a matching receipt on this reference,
  // refuse to post a second one. Reviewer must explicitly link the existing journal.
  const duplicateBank=await models.LedgerEntry.findOne({tenantKey:req.auth.tenantKey,financialYear,
    transactionId:reference,accountCode:'SYS_BANK_ACCOUNT',bankAccountId:bank.bankAccountId,status:'POSTED',debit:amount}).lean();
  if(duplicateBank)throw Object.assign(new Error('Bank reference already posted. Link its existing transaction ID instead of posting the cheque twice.'),{statusCode:409});
  const existingReceipt=await models.Receipt.findOne({tenantKey:req.auth.tenantKey,financialYear,sourceKey:transactionId}).lean();
  if(!linkedNo && !existingReceipt){
    // Creating a cheque-only receipt with a stable sourceKey allows safe retry.
    await models.Receipt.create({tenantKey:req.auth.tenantKey,financialYear,receiptNo:transactionId,sourceKey:transactionId,
      date,customerGlobalId:data.customerGlobalId,partyType:'CUSTOMER',partyNameSnapshot:data.issuedByPartyName,
      amount,mode:'BANK',receiptType:'CHEQUE',allocationType:'ADVANCE',bankAccountId:bank.bankAccountId,
      bankNameSnapshot:bank.bankName,reference,remarks:`Cleared cheque ${data.chequeNo}`,
      bounceStatus:'CLEAR',chequeNumber:data.chequeNo,chequeStatus:'CLEARED',chequeIssueDate:new Date(`${data.chequeDate}T00:00:00.000Z`),
      chequeDepositDate:new Date(`${data.depositDate}T00:00:00.000Z`),chequeClearanceDate:date,
      receiptWorkflowStatus:'CHEQUE_CLEARANCE',customerOtpStatus:'NOT_REQUIRED',cashierOtpStatus:'NOT_REQUIRED',
      collectionSource:'CHEQUE_CONTROL',status:'PENDING_ACCOUNTING',createdBy:req.auth.sub});
  }
  const entries=[{accountCode:'SYS_BANK_ACCOUNT',bankAccountId:bank.bankAccountId,debit:amount},
    {accountCode:mode==='SUSPENSE_CLEARING'?'SYS_SUSPENSE':customer.accountingProfile?.systemAccountCode||'SYS_SUNDRY_DEBTORS',credit:amount}];
  await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear,transactionId,
    transactionType:mode==='SUSPENSE_CLEARING'?'CHEQUE_CLEARING':'RECEIPT',date,partyGlobalId:data.customerGlobalId,
    entries,narration:`Cheque cleared ${data.chequeNo}; bank ref ${reference}`});
  if(!linkedNo)await models.Receipt.updateOne({tenantKey:req.auth.tenantKey,financialYear,sourceKey:transactionId},{$set:{status:'POSTED',ledgerPostedAt:new Date()}});
  return {transactionId,financialYear,mode};
}
async function postBounceCharge(req,doc,data,bank,bounceDate,fee,bearer){
  if(!(fee>0))return null;
  const financialYear=fyForDate(bounceDate),{Payment}=financialModels(req.auth.tenantKey,financialYear);
  const no=`CHQB-${clean(doc.reference).replace(/-/g,'').slice(0,20)}`;
  const date=new Date(`${bounceDate}T00:00:00.000Z`);
  const alreadyPostedFee=await financialModels(req.auth.tenantKey,financialYear).LedgerEntry.findOne({tenantKey:req.auth.tenantKey,financialYear,transactionId:clean(data.bankTransactionReference),bankAccountId:bank.bankAccountId,accountCode:'SYS_BANK_ACCOUNT',credit:fee,status:'POSTED'}).lean();
  if(alreadyPostedFee)throw Object.assign(new Error('Bounce charge already appears in the bank ledger; do not post twice'),{statusCode:409});
  const customer=bearer==='CUSTOMER'?await resolvedCustomer(req.auth.tenantKey,data.customerGlobalId):null;
  const prior=await Payment.findOne({tenantKey:req.auth.tenantKey,financialYear,sourceKey:no}).lean();
  if(!prior)await Payment.create({tenantKey:req.auth.tenantKey,financialYear,paymentNo:no,sourceKey:no,date,
    partyGlobalId:data.customerGlobalId||'',partyType:'BANK_CHARGES',partyNameSnapshot:'Cheque Return Charge',
    amount:fee,mode:'BANK',bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,
    reference:clean(data.bankTransactionReference),remarks:`Cheque ${data.chequeNo} bounced`,status:'PENDING_ACCOUNTING',createdBy:req.auth.sub});
  await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear,transactionId:no,transactionType:'PAYMENT',date,
    partyGlobalId:bearer==='CUSTOMER'?data.customerGlobalId:'',narration:`Cheque bounce charges ${data.chequeNo}`,
    entries:[{accountCode:bearer==='CUSTOMER'?(customer.accountingProfile?.systemAccountCode||'SYS_SUNDRY_DEBTORS'):'SYS_INDIRECT_EXPENSE',debit:fee,narration:'Cheque Return Charges'},
      {accountCode:'SYS_BANK_ACCOUNT',bankAccountId:bank.bankAccountId,credit:fee}]});
  await Payment.updateOne({tenantKey:req.auth.tenantKey,financialYear,sourceKey:no},{$set:{status:'POSTED'}});
  return {transactionId:no,financialYear};
}
router.patch('/received/:id',access('edit'),safe(async(req,res)=>{
  const doc=await docForReceived(req,req.params.id),old=doc.data||{},d=req.body||{};
  if(old.collectionLinked)return fail(res,'Collector-linked cheques are managed through the verified Cashier/Accounts/Bank workflow only',409);
  if(isCustodyPending(old.status))return fail(res,'Cashier OTP handover must finish before DMS editing/deposit',409);
  if(['CLEARED','CANCELLED','LOST'].includes(old.status))return fail(res,'Finalized cheque is locked',409);
  // Company acknowledgment is a real next step after cashier receipt.
  // The OTP custody gate above prevents a direct handover-to-RECEIVED jump.
  const status=clean(d.status||old.status).toUpperCase();
  if(!canAdvanceReceived(old.status,status))return fail(res,`Invalid transition ${old.status} → ${status}`,409);
  const detail=await receivedData(req,d,old);
  const selected=await requiredChequeParty(req.auth.tenantKey,detail.customerGlobalId);
  // Once deposited, preserve the original party-name snapshot if its master name changed.
  detail.issuedByPartyName=['PENDING_RECEIVED','RECEIVED'].includes(old.status) ? selected.name : (old.issuedByPartyName||selected.name);
  for(const field of ['linkedReceiptNo','linkedBankTransactionId']){
    if(detail[field]&&detail[field]!==old[field]){
      const linked=await GenericRecord.exists({...source(req.auth.tenantKey,RECEIVED),_id:{$ne:doc._id},[`data.${field}`]:detail[field],'data.status':{$nin:['CANCELLED','LOST']}});
      if(linked)return fail(res,`${field} already linked to another cheque`,409);
    }
  }
  if(!['PENDING_RECEIVED','RECEIVED'].includes(old.status) && ['chequeNo','issuedByPartyName','customerGlobalId','amount','ifsc'].some(k=>String(detail[k])!==String(old[k])))return fail(res,'Cheque identity locked after deposit',409);
  if(detail.customerGlobalId)await resolvedCustomer(req.auth.tenantKey,detail.customerGlobalId);
  let bank=null,bankId=clean(d.depositBankAccountId??old.depositBankAccountId);
  if(bankId)bank=await bankFor(req.auth.tenantKey,bankId);
  let statusDate=formatDate(d.statusDate??old.statusDate),depositDate=formatDate(d.depositDate??old.depositDate),clearedDate=formatDate(d.clearedDate??old.clearedDate);
  if(status!==old.status&&!d.statusDate)throw new Error('Status date is mandatory when changing status');
  if(['DEPOSITED','REDEPOSITED','CLEARED'].includes(status)&&(!bank||!depositDate))throw new Error('Select company bank and deposit date');
  if(status==='CLEARED'&&!clearedDate)throw new Error('Cheque cleared date is required');
  const reference=clean(d.bankTransactionReference??old.bankTransactionReference);
  if(status==='CLEARED'&&!reference)throw new Error('Confirmed bank statement/transaction reference is mandatory for clearing');
  if(['BOUNCED','RETURNED','CANCELLED','LOST'].includes(status)&&status!==old.status&&!clean(d.reason))throw new Error('Reason required for returned/bounced/cancelled/lost cheques');
  const charge=(status==='BOUNCED')?nonNegativeMoney(d.bounceCharge??0):0;
  const bearer=clean(d.bounceChargeBearer||'COMPANY').toUpperCase();
  if(!['COMPANY','CUSTOMER'].includes(bearer))throw new Error('Bounce charge bearer must be COMPANY or CUSTOMER');
  if(status==='BOUNCED'&&charge>0&&!bank)throw new Error('Select charged company bank to post bounce charge');
  if(status==='BOUNCED'&&charge>0&&!reference)throw new Error('Bank debit reference required for posting bounce charges');
  if(status==='BOUNCED'&&charge>0&&bearer==='CUSTOMER'&&!detail.customerGlobalId)throw new Error('Link customer before charging cheque bounce fee');
  const isCompanyAcknowledgement=status==='RECEIVED'&&old.status!=='RECEIVED';
  const merged={...old,...detail,status,statusDate,depositDate,clearedDate,depositBankAccountId:bank?.bankAccountId||'',depositBankName:bank?.bankName||'',
    bankTransactionReference:reference,bounceCharge:charge,bounceChargeBearer:bearer,
    ...(isCompanyAcknowledgement?{custodyStatus:'WITH_COMPANY',companyReceivedAt:new Date().toISOString(),companyReceivedByUserId:clean(req.auth.sub)}:{}),
    history:[...(old.history||[]),eventOf(status,req.auth,d.reason||(isCompanyAcknowledgement?'Company acknowledged physical cheque receipt':'Updated received cheque'))]};
  if(status==='CLEARED' && old.status!=='CLEARED'){
    const result=await postChequeClearing(req,doc,merged,clearedDate,bank,reference);
    merged.ledgerStatus=result.mode==='LINKED_EXISTING'?'LINKED':'POSTED';merged.ledgerTransactionId=result.transactionId;merged.ledgerFinancialYear=result.financialYear;
    merged.ledgerPostingMode=result.mode;
  }
  if(status==='BOUNCED'&&old.status!=='BOUNCED'){
    if(merged.linkedReceiptNo){
      const originalFy=merged.linkedReceiptFy||fyForDate(merged.receivedDate),originalModels=financialModels(req.auth.tenantKey,originalFy);
      const receipt=await originalModels.Receipt.findOne({tenantKey:req.auth.tenantKey,financialYear:originalFy,receiptNo:merged.linkedReceiptNo,status:'POSTED'});
      if(!receipt||Number(receipt.amount)!==Number(merged.amount)||clean(receipt.customerGlobalId)!==clean(merged.customerGlobalId))throw new Error('Original cheque receipt must match before bounce reversal');
      const suspense=await originalModels.LedgerEntry.findOne({tenantKey:req.auth.tenantKey,financialYear:originalFy,transactionId:receipt.receiptNo,transactionType:'RECEIPT',accountCode:'SYS_SUSPENSE',debit:merged.amount,status:'POSTED'}).lean();
      if(!suspense)throw new Error('Original cheque suspense receipt not found. Manual accountant reconciliation required before bouncing');
      const customer=await resolvedCustomer(req.auth.tenantKey,merged.customerGlobalId);
      const bounceFy=fyForDate(statusDate);
      const reverseNo=`CHQREV-${originalFy.replace('-','')}-${clean(receipt.receiptNo).replace(/[^a-z0-9]/ig,'').slice(0,25)}`;
      await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear:bounceFy,transactionId:reverseNo,
        transactionType:'CHEQUE_BOUNCE_REVERSAL',date:new Date(`${statusDate}T00:00:00.000Z`),
        partyGlobalId:merged.customerGlobalId,narration:`Bounced cheque ${merged.chequeNo} reverses receipt ${receipt.receiptNo}`,
        entries:[{accountCode:customer.accountingProfile?.systemAccountCode||'SYS_SUNDRY_DEBTORS',debit:merged.amount},{accountCode:'SYS_SUSPENSE',credit:merged.amount}]});
      receipt.bounceStatus='BOUNCED';receipt.chequeStatus='BOUNCED';receipt.chequeBounceDate=new Date(`${statusDate}T00:00:00.000Z`);
      await receipt.save();merged.reversalTransactionId=reverseNo;
    }
    const result=await postBounceCharge(req,doc,merged,bank,statusDate,charge,bearer);
    if(result){merged.bounceChargeTransactionId=result.transactionId;merged.bounceChargeFinancialYear=result.financialYear;}
    merged.bouncedDate=statusDate;
  }
  doc.data=merged;doc.amount=detail.amount;doc.title=`${detail.chequeNo} • ${detail.issuedByPartyName}`;
  doc.updatedBy=clean(req.auth.sub);doc.markModified('data');await doc.save();
  return ok(res,{id:String(doc._id),...doc.data},'Received cheque updated');
}));
export { mobileRouter as chequeMobileRouter };
export default router;
