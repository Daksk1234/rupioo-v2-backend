// Collector -> Cashier -> Accounts -> Bank -> Ledger.
// One original OTP-verified Receipt is the financial source of truth.
// Uses the existing FY Receipt and central GenericRecord collections only.
import express from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { BankAccount, CompanyProfile, CustomerLink, GenericRecord, OtpChallenge } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { isAdminAuth } from '../utils/adminAccess.js';
import { canPageAction } from '../config/permissionPageMap.js';
import { ok, fail } from '../utils/http.js';
import { configuredFinancialYear } from '../utils/financialYear.js';
import { financialModels, postBalancedEntries } from '../services/accountingService.js';
import { postCustodyApprovedReceipt } from '../services/salespersonReceiptWorkflowService.js';
import { createOtp, verifyOtp } from '../services/otpService.js';
import { sealHandoverOtp, unsealHandoverOtp } from '../services/collectionWorkflowOtpVault.js';
import { streamSbiDepositSlipPDF } from '../services/chequeDepositSlipPdf.js';
import { isSbiDepositAccount } from '../services/chequeDepositSlipRules.js';
import {collectionConfirmationFilter} from '../services/collectionHubRules.js';

const router=express.Router();
router.use(requireAuth);
const clean=v=>String(v??'').trim();
const upper=v=>clean(v).toUpperCase();
const money=v=>Math.round(Number(v||0)*100)/100;
const iso=v=>{if(!v)return '';const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10)};
const formatError=(e,res)=>fail(res,e?.message||'Collection workflow error',e?.statusCode||500);
const safe=fn=>async(req,res)=>{try{await fn(req,res)}catch(e){return formatError(e,res)}};
const reject=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const source=(req,resource)=>({tenantKey:req.auth.tenantKey,app:'dms',resource});
const RECEIVED='cheque-control-received',BUNDLES='cheque-control-account-handovers',SLIPS='cheque-control-workflow-slips';
const isCheque=r=>['CHEQUE','CHECK','CHQ'].includes(upper(r?.receiptType))||['CHEQUE','CHECK','CHQ'].includes(upper(r?.mode));
const channel=r=>upper(r?.mode)==='CASH'?'CASH':isCheque(r)?'CHEQUE':'ONLINE';
const receiptFilter=(req,fy)=>({tenantKey:req.auth.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',$and:[collectionConfirmationFilter],status:'POSTED'});
const may=(req,page,action='view')=>req.auth?.role!=='MASTER'&&(req.auth?.apps||[]).includes('dms')&&(isAdminAuth(req.auth)||canPageAction(req.auth.permissions||[],page,action));
const allow=(page,action='view')=>(req,res,next)=>may(req,page,action)?next():fail(res,`${page} ${action} permission required`,403);
const cashier='/dms/cashier',cheque='/dms/cheque-control';
async function fyOf(req){const fy=clean(req.body?.financialYear||req.query.financialYear)||await configuredFinancialYear(req.auth.tenantKey);
 if(!/^20\d{2}-\d{2}$/.test(fy)||Number(fy.slice(-2))!==(Number(fy.slice(0,4))+1)%100)throw reject('Select a valid financial year',422);return fy;}
const dateCheck=v=>/^\d{4}-\d{2}-\d{2}$/.test(clean(v))&&iso(`${v}T00:00:00Z`)===v;
const idsOf=(value,max=200)=>{
 if(!Array.isArray(value)||!value.length||value.length>max)throw reject(`Select between 1 and ${max} receipts`,422);
 const unique=[...new Set(value.map(clean))];if(unique.length!==value.length||unique.some(x=>!mongoose.isValidObjectId(x)))throw reject('Unique valid receipt IDs required',422);return unique;
};
const note=(state,req,reason='')=>({status:state,at:new Date().toISOString(),by:clean(req.auth.sub),reason:clean(reason).slice(0,500)});
async function original(req,fy,id){if(!mongoose.isValidObjectId(id))throw reject('Invalid original receipt ID',422);
 const {Receipt}=financialModels(req.auth.tenantKey,fy);
 const row=await Receipt.findOne({...receiptFilter(req,fy),_id:id});if(!row)throw reject('Verified original customer receipt not found',404);return row;}
async function registered(req,fy,receipt){const doc=await GenericRecord.findOne({...source(req,RECEIVED),'data.linkedReceiptFy':fy,'data.linkedReceiptNo':receipt.receiptNo});
 if(!doc)throw reject(`Cheque ${receipt.receiptNo} is not registered. Use the existing Sync Cheques repair action`,409);
 const d=doc.data||{};if(clean(d.customerGlobalId)!==clean(receipt.customerGlobalId)||money(d.amount)!==money(receipt.amount)||clean(d.chequeNo)!==clean(receipt.chequeNumber))
   throw reject('Cheque party, number or amount differs from the original receipt; manual review required',409);
 return doc;
}
const receivedCustody=r=>upper(r.cashDepositStatus)==='DEPOSITED_TO_CASHIER'||upper(r.cashDepositStatus)==='CLOSED';
const ledgerPosted=r=>Boolean(r.ledgerPostedAt);
const withCollector=r=>!receivedCustody(r);
async function cashList(req,fy){const {Receipt}=financialModels(req.auth.tenantKey,fy);
 const rows=await Receipt.find({...receiptFilter(req,fy),$or:[{mode:'CASH'},{receiptType:'CHEQUE'},{mode:'CHEQUE'}]}).sort({date:-1,_id:-1}).limit(5000).lean();
 const cheques=rows.filter(isCheque);const docs=cheques.length?await GenericRecord.find({...source(req,RECEIVED),'data.linkedReceiptFy':fy,
   'data.linkedReceiptNo':{$in:cheques.map(r=>r.receiptNo)}}).lean():[];
 const lookup=new Map(docs.map(d=>[clean(d.data?.linkedReceiptNo),{id:String(d._id),...d.data}]));
 return rows.map(r=>({id:String(r._id),receiptNo:r.receiptNo,partyName:r.partyNameSnapshot,customerGlobalId:r.customerGlobalId,
  amount:money(r.amount),date:r.customerOtpVerifiedAt||r.date,collectorId:r.collectedBySalespersonId||r.createdBy,
  collector:r.collectedBySalespersonNameSnapshot||r.createdByNameSnapshot,channel:channel(r),
  status:receivedCustody(r)?'WITH_CASHIER':upper(r.cashDepositStatus)==='HANDOVER_PENDING'?'HANDOVER_PENDING':'WITH_COLLECTOR',
  receiptWorkflowStatus:r.receiptWorkflowStatus,disputeStatus:r.disputeStatus||'NONE',disputeRemark:r.disputeRemark||'',
  ledgerPostedAt:r.ledgerPostedAt||null,denominations:r.cashDenominations||[],remarks:r.remarks||'',
  cashierBatchId:r.cashDepositBatchId||'',cheque:lookup.get(r.receiptNo)||null}));
}
router.get('/cashier',allow(cashier),safe(async(req,res)=>{
 const fy=await fyOf(req),page=Math.max(1,Number.parseInt(req.query.page,10)||1),limit=Math.min(100,Math.max(10,Number.parseInt(req.query.limit,10)||50));
 const kind=upper(req.query.channel||'ALL'),search=clean(req.query.search).toLowerCase(),holder=upper(req.query.holder||'ALL');
 const all=(await cashList(req,fy)).filter(r=>(kind==='ALL'||r.channel===kind)&&
   (holder==='ALL'||r.status===holder)&&(!search||[r.partyName,r.receiptNo,r.collector,r.cheque?.chequeNo].some(v=>clean(v).toLowerCase().includes(search))));
 const {SalespersonCashMovement}=financialModels(req.auth.tenantKey,fy);
 const handovers=await SalespersonCashMovement.find({tenantKey:req.auth.tenantKey,financialYear:fy,
   type:'HANDOVER',status:'PENDING','receiptBreakdown.0':{$exists:true}}).select('+handoverOtpCode').sort({createdAt:-1}).limit(250).lean();
 const cashierId=clean(req.auth.sub);
 // Never expose the OTP to a different employee's cashier account.
 const pendingHandovers=handovers.map(m=>({id:String(m._id),movementNo:m.movementNo,
   collector:m.salespersonNameSnapshot,amount:money(m.amount),count:(m.receiptBreakdown||[]).length,
   status:m.handoverOtpStatus,otp:m.recipientUserId===cashierId||isAdminAuth(req.auth)?(m.handoverOtpCode||''):'',
   expiresAt:m.handoverOtpExpiresAt}));
 return ok(res,{items:all.slice((page-1)*limit,page*limit),meta:{page,limit,total:all.length,pages:Math.max(1,Math.ceil(all.length/limit))},
  summary:{withCollector:all.filter(r=>r.status==='WITH_COLLECTOR').length,withCashier:all.filter(r=>r.status==='WITH_CASHIER').length,
  held:all.filter(r=>upper(r.disputeStatus)==='HOLD').length,unpostedCash:money(all.filter(r=>r.channel==='CASH'&&r.status==='WITH_CASHIER'&&!r.ledgerPostedAt).reduce((n,r)=>n+r.amount,0))},
  pendingHandovers,
  accountHandovers:(await GenericRecord.find({...source(req,BUNDLES),'data.financialYear':fy,
    'data.cashierId':cashierId,'data.status':'PENDING'}).sort({createdAt:-1}).limit(100).lean())
    .map(b=>({id:String(b._id),count:b.data?.chequeIds?.length||0,amount:money(b.data?.amount),createdAt:b.createdAt,expiresAt:b.data?.expiresAt}))});
}));
router.patch('/cashier/:id/notes',allow(cashier,'edit'),safe(async(req,res)=>{
 const fy=await fyOf(req),r=await original(req,fy,req.params.id);
 if(!receivedCustody(r)||ledgerPosted(r)||upper(r.disputeStatus)==='HOLD')throw reject('Cashier can edit notes only after physical handover and before posting',409);
 const remarks=clean(req.body.remarks);if(remarks.length>1000)throw reject('Remarks too long',422);
 r.remarks=remarks;r.disputeHistory.push({status:'CASHIER_EDIT',remark:clean(req.body.reason)||'Remarks correction',at:new Date(),by:req.auth.sub,byName:req.auth.name||''});await r.save();
 return ok(res,{id:String(r._id),remarks});
}));
router.post('/cashier/:id/dispute',allow(cashier,'edit'),safe(async(req,res)=>{
 const fy=await fyOf(req),r=await original(req,fy,req.params.id),action=upper(req.body.action);
 if(!receivedCustody(r)||ledgerPosted(r))throw reject('Disputes are available only for received, unposted receipts',409);
 const reason=clean(req.body.reason);if(reason.length<5||reason.length>500)throw reject('Dispute reason must have 5–500 characters',422);
 if(action==='RESOLVE'){if(upper(r.disputeStatus)!=='HOLD')throw reject('Receipt is not on HOLD');r.disputeStatus='NONE';r.disputeResolvedAt=new Date();r.disputeRemark='';}
 else{if(upper(r.disputeStatus)==='HOLD')throw reject('Already on HOLD');r.disputeStatus='HOLD';r.disputeRaisedAt=new Date();r.disputeRemark=reason;}
 r.disputeHistory.push({status:action==='RESOLVE'?'RESOLVED':'HOLD',remark:reason,at:new Date(),by:req.auth.sub,byName:req.auth.name||''});await r.save();
 return ok(res,{id:String(r._id),disputeStatus:r.disputeStatus});
}));
// Deletion is an audited VOID; a verified payment is never silently hard-deleted.
router.delete('/cashier/:id',allow(cashier,'delete'),safe(async(req,res)=>{
 const fy=await fyOf(req),r=await original(req,fy,req.params.id),reason=clean(req.body.reason);
 if(reason.length<5)throw reject('Enter a reason for voiding this confirmed receipt',422);
 if(!receivedCustody(r)||ledgerPosted(r)||upper(r.disputeStatus)==='HOLD')throw reject('Only received, unposted and undisputed receipts may be voided');
 if(channel(r)==='CHEQUE'){const c=await registered(req,fy,r);if(!['WITH_CASHIER'].includes(upper(c.data.status)))throw reject('Cheque already transferred to Accounts; cannot void');}
 const {Receipt}=financialModels(req.auth.tenantKey,fy);
 const updated=await Receipt.findOneAndUpdate({...receiptFilter(req,fy),_id:r._id,ledgerPostedAt:{$in:[null]},disputeStatus:{$ne:'HOLD'}},
  {$set:{status:'VOID',receiptWorkflowStatus:'VOIDED_BY_CASHIER'},$push:{disputeHistory:{status:'CASHIER_VOID',remark:reason,at:new Date(),by:req.auth.sub,byName:req.auth.name||''}}});
 if(!updated)throw reject('Receipt changed during void; reload');
 if(channel(r)==='CHEQUE')await GenericRecord.updateOne({...source(req,RECEIVED),'data.linkedReceiptFy':fy,'data.linkedReceiptNo':r.receiptNo,'data.status':'WITH_CASHIER'},{$set:{'data.status':'CANCELLED','data.custodyStatus':'CANCELLED'}});
 return ok(res,{id:String(r._id)},'Receipt voided with audit history; reconcile the physical cash or cheque separately');
}));
router.post('/cashier/cash/post',allow(cashier,'edit'),safe(async(req,res)=>{
 const fy=await fyOf(req),ids=idsOf(req.body.receiptIds),tenantKey=req.auth.tenantKey;
 const {LedgerEntry}=financialModels(tenantKey,fy);
 await LedgerEntry.init();
 const session=await LedgerEntry.db.startSession();const results=[];
 try{
  await session.withTransaction(async()=>{
   results.length=0;
   for(const receiptId of ids)results.push(await postCustodyApprovedReceipt({tenantKey,financialYear:fy,receiptId,
    channel:'CASH',cashierLedgerPost:true,ledgerDate:clean(req.body.postingDate)||new Date().toISOString().slice(0,10),
    allowOtherCashier:isAdminAuth(req.auth),session,actorId:req.auth.sub,actorName:req.auth.name||''}));
  });
  return ok(res,{items:results,posted:results.filter(row=>!row.alreadyPosted).length,
   alreadyPosted:results.filter(row=>row.alreadyPosted).length},'Cash receipts posted to their customer ledgers and Cashbook');
 }finally{await session.endSession();}
}));
async function rowsForCheques(req,fy){
 const {Receipt}=financialModels(req.auth.tenantKey,fy);
 const originals=await Receipt.find({...receiptFilter(req,fy),$or:[{receiptType:'CHEQUE'},{mode:'CHEQUE'}]}).sort({date:-1,_id:-1}).limit(5000).lean();
 const docs=originals.length?await GenericRecord.find({...source(req,RECEIVED),'data.linkedReceiptFy':fy,
  'data.linkedReceiptNo':{$in:originals.map(r=>r.receiptNo)}}).lean():[];
 const map=new Map(docs.map(d=>[clean(d.data?.linkedReceiptNo),{...d.data,id:String(d._id)}]));
 return originals.map(r=>{const d=map.get(r.receiptNo)||{},baseState=withCollector(r)?'WITH_COLLECTOR':'WITH_CASHIER';
   const status=['PENDING_WITH_COLLECTOR','PENDING_WITH_SALESPERSON','HANDOVER_REQUESTED','HANDOVER_OTP_ISSUED','HANDOVER_VERIFIED'].includes(upper(d.status))?baseState:
      upper(d.status)==='ACCOUNT_HANDOVER_PENDING'?'WITH_CASHIER':upper(d.status)||baseState;
   return {id:d.id||'',receiptId:String(r._id),receiptNo:r.receiptNo,partyName:r.partyNameSnapshot,
     customerGlobalId:r.customerGlobalId,collector:r.collectedBySalespersonNameSnapshot||'',amount:money(r.amount),
     chequeNo:d.chequeNo||r.chequeNumber||'',ifsc:d.ifsc||r.payerIfsc||'',bankDetails:[d.issuerBankName,d.issuerBranchName].filter(Boolean).join(' · '),
     receivedDate:d.receivedDate||iso(r.customerOtpVerifiedAt||r.date),chequeDate:d.chequeDate||iso(r.chequeIssueDate||r.date),
     depositDate:d.depositDate||d.chequeDate||iso(r.chequeIssueDate||r.date),status,statusDate:d.statusDate||iso(r.date),
     depositBankAccountId:d.depositBankAccountId||'',slipId:d.slipId||'',accountHandoverBatchId:d.accountHandoverBatchId||'',
     disputeStatus:r.disputeStatus||'NONE',ledgerPostedAt:r.ledgerPostedAt||null,bouncePostedAt:r.chequeBouncePostedAt||null,
     unregistered:!d.id,remarks:r.remarks||''};});
}
router.get('/cheques/company-received',allow(cheque),safe(async(req,res)=>{
 const fy=await fyOf(req),page=Math.max(1,parseInt(req.query.page,10)||1),limit=Math.min(100,Math.max(10,parseInt(req.query.limit,10)||50));
 const search=clean(req.query.search).toLowerCase(),status=upper(req.query.status||'ALL');
 const all=(await rowsForCheques(req,fy)).filter(x=>(status==='ALL'||x.status===status)&&
   (!search||[x.chequeNo,x.partyName,x.receiptNo,x.ifsc].some(v=>clean(v).toLowerCase().includes(search))));
 return ok(res,{items:all.slice((page-1)*limit,page*limit),meta:{page,limit,pages:Math.max(1,Math.ceil(all.length/limit)),total:all.length}});
}));
// The cashier can initiate one cheque or an entire bundle; only Accounts sees the OTP.
router.post('/cashier/cheques/handover',allow(cashier,'edit'),safe(async(req,res)=>{
 return fail(res,'Use Cashier Day Close to release accepted cheques to Company Received',410);
}));
router.get('/cheques/pending',allow(cheque),safe(async(req,res)=>{
 const fy=await fyOf(req);
 const bundles=await GenericRecord.find({...source(req,BUNDLES),'data.financialYear':fy,'data.status':'PENDING'}).sort({createdAt:-1}).limit(250).lean();
 const now=Date.now();
 const list=bundles.map(doc=>{const d=doc.data||{},valid=new Date(d.expiresAt).getTime()>now;
   return {id:String(doc._id),count:(d.chequeIds||[]).length,amount:money(d.amount),cashier:d.cashierName,createdAt:doc.createdAt,
    expiresAt:d.expiresAt,otp:valid&&may(req,cheque,'edit')?unsealHandoverOtp(d.otpSecret):'',expired:!valid};});
 const {Receipt}=financialModels(req.auth.tenantKey,fy);
 const threeDays=new Date(now-72*60*60*1000);
 const overdue=await Receipt.find({...receiptFilter(req,fy),mode:{$nin:['CASH','CHEQUE','CHECK','CHQ']},
   receiptType:{$nin:['CHEQUE','CHECK','CHQ']},ledgerPostedAt:{$in:[null]},
   $or:[{customerOtpVerifiedAt:{$lte:threeDays}},{customerOtpVerifiedAt:null,createdAt:{$lte:threeDays}}]})
   .sort({customerOtpVerifiedAt:1}).limit(500).lean();
 return ok(res,{bundles:list,onlineOverdue:overdue.map(r=>({receiptId:String(r._id),receiptNo:r.receiptNo,
  partyName:r.partyNameSnapshot,amount:money(r.amount),customerOtpVerifiedAt:r.customerOtpVerifiedAt||r.createdAt}))});
}));
// Expired or incorrect Accounts OTPs must not strand physically held cheques.
// A cancelled *unverified* request restores those instruments to Cashier custody.
router.post('/cashier/cheques/handover/:id/cancel',allow(cashier,'edit'),safe(async(req,res)=>{
 const doc=await GenericRecord.findOne({...source(req,BUNDLES),_id:req.params.id});if(!doc)throw reject('Handover not found',404);
 const d=doc.data||{};
 if(clean(d.cashierId)!==clean(req.auth.sub)&&!isAdminAuth(req.auth))throw reject('Only requesting Cashier may cancel an unverified handover',403);
 if(d.status!=='PENDING')throw reject('A verified Accounts handover cannot be cancelled',409);
 const ids=d.chequeIds||[];
 const rows=await GenericRecord.find({...source(req,RECEIVED),_id:{$in:ids},'data.accountHandoverBatchId':String(doc._id),'data.status':'ACCOUNT_HANDOVER_PENDING'});
 if(rows.length!==ids.length)throw reject('One or more cheques already changed custody. Do not cancel; contact Accounts.',409);
 const changed=await GenericRecord.updateOne({...source(req,BUNDLES),_id:doc._id,'data.status':'PENDING'},
   {$set:{'data.status':'CANCELLED','data.cancelledAt':new Date(),'data.otpSecret':''}});
 if(changed.modifiedCount!==1)throw reject('Handover changed concurrently; reload');
 await OtpChallenge.updateOne({otpId:d.otpId,status:'PENDING'},{$set:{status:'CANCELLED'}});
 await GenericRecord.updateMany({...source(req,RECEIVED),_id:{$in:ids},'data.accountHandoverBatchId':String(doc._id),
   'data.status':'ACCOUNT_HANDOVER_PENDING'},{$set:{'data.status':'WITH_CASHIER','data.statusDate':iso(new Date())},
   $unset:{'data.accountHandoverBatchId':''}});
 return ok(res,{restored:ids.length},'Unverified Accounts handover cancelled. Cheques remain with Cashier and can be resubmitted.');
}));
// Retry-safe Accounts acceptance: OTP authorizes custody exactly once. A network
// interruption after OTP success can resume from OTP_VERIFIED without a second OTP.
router.post('/cashier/cheques/handover/:id/verify',allow(cashier,'edit'),safe(async(req,res)=>{
 const doc=await GenericRecord.findOne({...source(req,BUNDLES),_id:req.params.id});if(!doc)throw reject('Handover bundle not found',404);
 const d=doc.data||{};if(clean(d.cashierId)!==clean(req.auth.sub)&&!isAdminAuth(req.auth))throw reject('Only requesting Cashier may verify this handover',403);
 if(d.status==='VERIFIED')return ok(res,{id:String(doc._id),count:d.chequeIds?.length||0},'Previously verified');
 if(!['PENDING','OTP_VERIFIED'].includes(d.status))throw reject('Bundle is not pending or authorized');
 const ids=d.chequeIds||[];
 const rows=await GenericRecord.find({...source(req,RECEIVED),_id:{$in:ids},'data.accountHandoverBatchId':String(doc._id),
   'data.status':{$in:['ACCOUNT_HANDOVER_PENDING','WAITING_FOR_DEPOSIT']}});
 if(rows.length!==ids.length)throw reject('One or more cheques changed during handover; review before retry');
 const {Receipt}=financialModels(req.auth.tenantKey,d.financialYear);
 for(const c of rows){const ref=await Receipt.findOne({...receiptFilter(req,d.financialYear),receiptNo:c.data.linkedReceiptNo});
   if(!ref||!receivedCustody(ref)||upper(ref.disputeStatus)==='HOLD'||ledgerPosted(ref))throw reject('Original cheque not eligible for Accounts acceptance');}
 if(d.status==='PENDING'){
   const result=await verifyOtp({otpId:d.otpId,code:clean(req.body.otp)});
   if(!result.ok)throw reject(result.reason,400);
   if(result.challenge.tenantKey!==req.auth.tenantKey||result.challenge.actionType!=='CHEQUE_ACCOUNTS_HANDOVER'||
      clean(result.challenge.transactionId)!==`ACCOUNTS:${clean(doc.reference)}`||clean(result.challenge.recipientId)!==clean(d.cashierId))
     throw reject('OTP does not belong to this Accounts handover',403);
   const updated=await GenericRecord.updateOne({...source(req,BUNDLES),_id:doc._id,'data.status':'PENDING'},
     {$set:{'data.status':'OTP_VERIFIED','data.otpVerifiedAt':new Date(),'data.otpSecret':''}});
   if(updated.modifiedCount!==1)throw reject('Accounts OTP was processed concurrently; reload handover');
 }
 for(const c of rows){
   if(c.data.status==='ACCOUNT_HANDOVER_PENDING'){
     await GenericRecord.updateOne({_id:c._id,...source(req,RECEIVED),'data.accountHandoverBatchId':String(doc._id),
       'data.status':'ACCOUNT_HANDOVER_PENDING'},
       {$set:{'data.status':'WAITING_FOR_DEPOSIT','data.custodyStatus':'WITH_ACCOUNTS','data.statusDate':iso(new Date()),
        'data.depositDate':c.data.depositDate||c.data.chequeDate,'data.accountsReceivedAt':new Date().toISOString(),
        'data.accountsReceivedBy':req.auth.sub},$push:{'data.history':note('WAITING_FOR_DEPOSIT',req,'Accounts OTP verified')}});
   }
   await Receipt.updateOne({...receiptFilter(req,d.financialYear),receiptNo:c.data.linkedReceiptNo},
      {$set:{chequeApprovalStatus:'APPROVED',chequeApprovalBatchId:String(doc._id),receiptWorkflowStatus:'WAITING_FOR_DEPOSIT'}});
 }
 await GenericRecord.updateOne({_id:doc._id,...source(req,BUNDLES),'data.status':'OTP_VERIFIED'},
   {$set:{'data.status':'VERIFIED','data.verifiedAt':new Date()}});
 return ok(res,{id:String(doc._id),count:rows.length},'Accounts has confirmed physical cheque receipt');
}));
router.patch('/cheques/:id/deposit-date',allow(cheque,'edit'),safe(async(req,res)=>{
 const doc=await GenericRecord.findOne({...source(req,RECEIVED),_id:req.params.id});if(!doc)throw reject('Cheque not found',404);
 if(upper(doc.data?.status)!=='WAITING_FOR_DEPOSIT')throw reject('Deposit date is locked once slip is generated');
 const date=clean(req.body.depositDate);if(!dateCheck(date))throw reject('Valid YYYY-MM-DD deposit date required',422);
 if(date<clean(doc.data.chequeDate))throw reject('Deposit date cannot be before cheque date',422);
 await GenericRecord.updateOne({_id:doc._id,...source(req,RECEIVED)},{$set:{'data.depositDate':date},$push:{'data.history':note('DEPOSIT_DATE_EDIT',req,date)}});
 return ok(res,{depositDate:date});
}));
async function slipBank(req,id){const b=await BankAccount.findOne({tenantKey:req.auth.tenantKey,bankAccountId:clean(id),status:'ACTIVE'}).lean();
 if(!b)throw reject('Choose an active company bank account',422);return b;}
router.post('/cheques/slips',allow(cheque,'edit'),safe(async(req,res)=>{
 const fy=await fyOf(req),bank=await slipBank(req,req.body.bankAccountId),depositDate=clean(req.body.depositDate);
 if(!dateCheck(depositDate))throw reject('Valid deposit slip date required',422);
 const requested=req.body.chequeIds&&idsOf(req.body.chequeIds,200);
 const filter={...source(req,RECEIVED),'data.linkedReceiptFy':fy,'data.status':'WAITING_FOR_DEPOSIT',
   'data.depositDate':{$lte:depositDate},'data.accountHandoverBatchId':{$nin:['',null]}};
 if(requested)filter._id={$in:requested};
 const docs=await GenericRecord.find(filter).sort({'data.depositDate':1,'data.chequeNo':1}).limit(201);
 if(!docs.length)throw reject('No Accounts-approved cheques due for deposit on the selected date');
 if(docs.length>200||requested&&docs.length!==requested.length)throw reject('Some cheques are unavailable, not due or already included in a slip');
 const {Receipt}=financialModels(req.auth.tenantKey,fy);
 const originals=await Receipt.find({...receiptFilter(req,fy),receiptNo:{$in:docs.map(d=>d.data.linkedReceiptNo)}}).lean();
 const map=new Map(originals.map(r=>[r.receiptNo,r]));
 for(const doc of docs){const r=map.get(doc.data.linkedReceiptNo);if(!r||!receivedCustody(r)||upper(r.disputeStatus)==='HOLD'||ledgerPosted(r)||clean(r.customerGlobalId)!==clean(doc.data.customerGlobalId))
  throw reject('One cheque has a different party, is disputed or has been posted');}
 const key=randomUUID(),now=new Date();const slip=await GenericRecord.create({...source(req,SLIPS),reference:key,date:now,title:`Cheque Deposit Slip ${depositDate}`,
  createdBy:req.auth.sub,data:{financialYear:fy,depositDate,bankAccountId:bank.bankAccountId,bankName:bank.bankName,
   chequeIds:docs.map(d=>String(d._id)),amount:money(docs.reduce((s,d)=>s+money(d.data.amount),0)),status:'DRAFT',createdAt:now,history:[note('DRAFT',req)]}});
 let claimed=0;
 try{for(const d of docs){const u=await GenericRecord.updateOne({...source(req,RECEIVED),_id:d._id,'data.status':'WAITING_FOR_DEPOSIT'},
  {$set:{'data.status':'SLIP_READY','data.slipId':String(slip._id),'data.depositBankAccountId':bank.bankAccountId,'data.depositBankName':bank.bankName,
   'data.statusDate':iso(now)},$push:{'data.history':note('SLIP_READY',req)}});if(u.modifiedCount!==1)throw reject('Cheque changed while preparing deposit slip');claimed++;}}
 catch(e){await GenericRecord.updateMany({...source(req,RECEIVED),'data.slipId':String(slip._id),'data.status':'SLIP_READY'},
  {$set:{'data.status':'WAITING_FOR_DEPOSIT'},$unset:{'data.slipId':'','data.depositBankAccountId':'','data.depositBankName':''}});
  await GenericRecord.updateOne({_id:slip._id},{$set:{'data.status':'CANCELLED'}});throw e;}
 return ok(res,{slipId:String(slip._id),chequeCount:claimed,amount:slip.data.amount,bankName:bank.bankName},'Deposit slip generated; review and confirm before taking cheques to bank');
}));
router.get('/cheques/slips/:id/pdf',allow(cheque,'download'),safe(async(req,res)=>{
 const slip=await GenericRecord.findOne({...source(req,SLIPS),_id:req.params.id}).lean();if(!slip)throw reject('Deposit slip not found',404);
 const d=slip.data||{};if(d.status==='CANCELLED')throw reject('Slip cancelled');const bank=await slipBank(req,d.bankAccountId);
 const docs=await GenericRecord.find({...source(req,RECEIVED),_id:{$in:d.chequeIds||[]},'data.slipId':String(slip._id)}).lean();
 if(docs.length!==(d.chequeIds||[]).length)throw reject('Slip no longer matches assigned cheques');
 const cheques=docs.map(x=>({...x.data,id:String(x._id),amount:money(x.data.amount)}));
 if(isSbiDepositAccount(bank))return streamSbiDepositSlipPDF(res,{bank,depositDate:d.depositDate,cheques});
 res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`inline; filename="Cheque_Deposit_${d.depositDate}.pdf"`);
 const pdf=new PDFDocument({margin:45});pdf.pipe(res);pdf.fontSize(17).text('CHEQUE DEPOSIT SLIP',{align:'center'});
 pdf.moveDown().fontSize(10).text(`Deposit date: ${d.depositDate}`).text(`Company bank: ${bank.bankName}`).text(`Account: ${bank.accountNumber||''}`);pdf.moveDown();
 cheques.forEach((c,i)=>pdf.text(`${i+1}. ${c.chequeNo}  |  ${c.issuedByPartyName}  |  Rs ${money(c.amount).toFixed(2)}  |  ${c.issuerBankName||''}`));
 pdf.moveDown().fontSize(12).text(`TOTAL: Rs ${money(d.amount).toFixed(2)}`);pdf.moveDown().fontSize(9).text('Prepared for bank submission. This slip is not evidence of physical deposit or clearance.');pdf.end();
}));
router.post('/cheques/slips/:id/confirm',allow(cheque,'edit'),safe(async(req,res)=>{
 const slip=await GenericRecord.findOne({...source(req,SLIPS),_id:req.params.id});if(!slip||slip.data?.status!=='DRAFT')throw reject('Only a draft slip can be confirmed');
 const ids=slip.data.chequeIds||[],docs=await GenericRecord.find({...source(req,RECEIVED),_id:{$in:ids},'data.status':'SLIP_READY','data.slipId':String(slip._id)});
 if(docs.length!==ids.length)throw reject('Slip cheque selection changed; cannot confirm');
 await GenericRecord.updateOne({_id:slip._id,'data.status':'DRAFT'},{$set:{'data.status':'CONFIRMED','data.confirmedAt':new Date()}});
 return ok(res,{slipId:String(slip._id)},'Slip reviewed and confirmed');
}));
router.post('/cheques/slips/:id/prepare-deposit',allow(cheque,'edit'),safe(async(req,res)=>{
 const slip=await GenericRecord.findOne({...source(req,SLIPS),_id:req.params.id});if(!slip||slip.data?.status!=='CONFIRMED')throw reject('Confirm slip before preparing bank deposit');
 const ids=slip.data.chequeIds||[],docs=await GenericRecord.find({...source(req,RECEIVED),_id:{$in:ids},'data.status':'SLIP_READY','data.slipId':String(slip._id)});
 if(docs.length!==ids.length)throw reject('Slip cheque selection changed');
 await GenericRecord.updateMany({_id:{$in:ids},...source(req,RECEIVED),'data.status':'SLIP_READY','data.slipId':String(slip._id)},{$set:{'data.status':'BANK_DEPOSIT_PREPARED','data.statusDate':iso(new Date())}});
 await GenericRecord.updateOne({_id:slip._id},{$set:{'data.status':'PREPARED','data.preparedAt':new Date()}});
 return ok(res,{count:ids.length},'Slip prepared for physical bank deposit; bank deposit is not confirmed yet');
}));
router.post('/cheques/slips/:id/deposited',allow(cheque,'edit'),safe(async(req,res)=>{
 const slip=await GenericRecord.findOne({...source(req,SLIPS),_id:req.params.id});if(!slip||slip.data?.status!=='PREPARED')throw reject('Prepare deposit first');
 const ids=slip.data.chequeIds||[],docs=await GenericRecord.find({...source(req,RECEIVED),_id:{$in:ids},'data.status':'BANK_DEPOSIT_PREPARED','data.slipId':String(slip._id)});
 if(docs.length!==ids.length)throw reject('One cheque is not prepared for bank deposit');
 await GenericRecord.updateMany({_id:{$in:ids},...source(req,RECEIVED),'data.status':'BANK_DEPOSIT_PREPARED','data.slipId':String(slip._id)},{$set:{'data.status':'DEPOSITED','data.statusDate':iso(new Date()),'data.physicallyDepositedAt':new Date().toISOString()}});
 await GenericRecord.updateOne({_id:slip._id},{$set:{'data.status':'DEPOSITED','data.depositedAt':new Date()}});
 return ok(res,{count:ids.length},'Cheques confirmed as physically deposited at the bank');
}));
router.get('/cheques/slips',allow(cheque),safe(async(req,res)=>{
 const fy=await fyOf(req);const docs=await GenericRecord.find({...source(req,SLIPS),'data.financialYear':fy,'data.status':{$nin:['CANCELLED']}}).sort({createdAt:-1}).limit(100).lean();
 return ok(res,{items:docs.map(d=>({id:String(d._id),...d.data}))});
}));
router.post('/cheques/:id/bank-result',allow(cheque,'edit'),safe(async(req,res)=>{
 const doc=await GenericRecord.findOne({...source(req,RECEIVED),_id:req.params.id});if(!doc)throw reject('Cheque not found',404);
 const status=upper(req.body.status),old=upper(doc.data?.status);
 if(!['CLEARED','UNCLEARED','BOUNCED'].includes(status))throw reject('Choose Cleared, Uncleared or Bounced',422);
 if(!['DEPOSITED','UNCLEARED'].includes(old))throw reject('Cheque is not deposited or awaiting bank result');
 if(old==='UNCLEARED'&&status==='UNCLEARED')throw reject('Cheque already uncleared');
 const fy=clean(doc.data.linkedReceiptFy),{Receipt}=financialModels(req.auth.tenantKey,fy);
 const receipt=await Receipt.findOne({...receiptFilter(req,fy),receiptNo:doc.data.linkedReceiptNo});
 if(!receipt||upper(receipt.disputeStatus)==='HOLD'||!receivedCustody(receipt)||ledgerPosted(receipt))throw reject('Cheque receipt not eligible for a bank result');
 const result=await GenericRecord.updateOne({...source(req,RECEIVED),_id:doc._id,'data.status':old},
  {$set:{'data.status':status,'data.statusDate':iso(new Date()),'data.bankResultReason':clean(req.body.reason)},
   $push:{'data.history':note(status,req,req.body.reason)}});
 if(result.modifiedCount!==1)throw reject('Status changed concurrently; reload');
 if(status==='CLEARED')await Receipt.updateOne({_id:receipt._id},{$set:{chequeStatus:'CLEARED',chequeClearanceDate:new Date()}});
 if(status==='BOUNCED')await Receipt.updateOne({_id:receipt._id},{$set:{chequeStatus:'BOUNCED',chequeBounceDate:new Date()}});
 return ok(res,{status});
}));
router.post('/cheques/:id/post-ledger',allow(cheque,'edit'),safe(async(req,res)=>{
 const doc=await GenericRecord.findOne({...source(req,RECEIVED),_id:req.params.id});if(!doc)throw reject('Cheque not found',404);
 const d=doc.data||{},fy=clean(d.linkedReceiptFy),status=upper(d.status);
 if(!['CLEARED','BOUNCED'].includes(status))throw reject('Only Cleared or Bounced cheques can be posted');
 const {Receipt}=financialModels(req.auth.tenantKey,fy);
 const receipt=await Receipt.findOne({...receiptFilter(req,fy),receiptNo:d.linkedReceiptNo});
 if(!receipt||!receivedCustody(receipt)||upper(receipt.disputeStatus)==='HOLD'||clean(receipt.customerGlobalId)!==clean(d.customerGlobalId)||money(receipt.amount)!==money(d.amount))
   throw reject('Original receipt mismatch, disputed, or not physically transferred');
 if(status==='CLEARED'){
  if(receipt.chequeApprovalStatus!=='APPROVED')throw reject('Accounts OTP approval is required');
  const date=clean(d.statusDate)||iso(new Date());
  const posting=await postCustodyApprovedReceipt({tenantKey:req.auth.tenantKey,financialYear:fy,receiptId:receipt._id,channel:'CHEQUE',bankReceivedDate:date,
    bankAccountId:d.depositBankAccountId||clean(req.body.bankAccountId),actorId:req.auth.sub,actorName:req.auth.name||''});
  await GenericRecord.updateOne({...source(req,RECEIVED),_id:doc._id,'data.status':'CLEARED'},
   {$set:{'data.status':'LEDGER_POSTED','data.ledgerStatus':'POSTED','data.ledgerPostedAt':new Date().toISOString(),
     'data.statusDate':iso(new Date()),'data.ledgerTransactionId':receipt.receiptNo,'data.bankLedgerTransactionId':posting.bankTransactionId,
     'data.depositBankAccountId':posting.bankAccountId},$push:{'data.history':note('LEDGER_POSTED',req)}});
  return ok(res,{...posting,status:'LEDGER_POSTED'},'Cleared cheque posted once to customer ledger and Bank Statement');
 }
 if(receipt.chequeBouncePostedAt)return ok(res,{alreadyPosted:true},'Bounce already posted');
 const company=await CompanyProfile.findOne({tenantKey:req.auth.tenantKey}).select('chequeBounceCharge').lean();
 const charge=money(company?.chequeBounceCharge||0);
 if(!(charge>=0&&charge<=100000))throw reject('Invalid configured bounce charge; correct Superadmin Profile',422);
 if(charge>0){const customer=await CustomerLink.findOne({tenantKey:req.auth.tenantKey,globalCustomerId:receipt.customerGlobalId}).lean();
  if(!customer)throw reject('Customer record not found');
  await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear:fy,transactionId:`CHQ-BOUNCE-${receipt.receiptNo}`,
    transactionType:'CHEQUE_BOUNCE_CHARGE',date:new Date(`${d.statusDate}T00:00:00.000Z`),partyGlobalId:receipt.customerGlobalId,
    narration:`Bounced cheque ${d.chequeNo} - charge only; principal payment was never posted`,
    entries:[{accountCode:clean(customer.accountingProfile?.systemAccountCode)||'SYS_SUNDRY_DEBTORS',debit:charge},
      {accountCode:'SYS_INDIRECT_INCOME',credit:charge}]});}
 await Receipt.updateOne({_id:receipt._id,chequeBouncePostedAt:{$in:[null]}},
  {$set:{chequeBouncePostedAt:new Date(),chequeBounceChargeSnapshot:charge,receiptWorkflowStatus:'BOUNCE_POSTED'}});
 await GenericRecord.updateOne({_id:doc._id,...source(req,RECEIVED),'data.status':'BOUNCED'},
  {$set:{'data.status':'LEDGER_POSTED','data.ledgerStatus':'BOUNCE_POSTED','data.bounceCharge':charge,
    'data.ledgerPostedAt':new Date().toISOString(),'data.statusDate':iso(new Date())},$push:{'data.history':note('BOUNCE_POSTED',req)}});
 return ok(res,{status:'LEDGER_POSTED',charge},'Bounce charge posted to customer ledger; cheque payment principal not credited');
}));
router.get('/online',allow(cheque),safe(async(req,res)=>{
 const fy=await fyOf(req),page=Math.max(1,parseInt(req.query.page,10)||1),limit=Math.min(100,Math.max(10,parseInt(req.query.limit,10)||50));
 const {Receipt}=financialModels(req.auth.tenantKey,fy);
 const rows=await Receipt.find({...receiptFilter(req,fy),mode:{$nin:['CASH','CHEQUE','CHECK','CHQ']},
  receiptType:{$nin:['CHEQUE','CHECK','CHQ']}}).sort({customerOtpVerifiedAt:-1,date:-1,_id:-1}).lean();
 const all=rows.filter(r=>r.ledgerPostedAt||Date.now()-new Date(r.customerOtpVerifiedAt||r.createdAt).getTime()<72*3600*1000)
  .map(r=>({id:String(r._id),receiptNo:r.receiptNo,partyName:r.partyNameSnapshot,amount:money(r.amount),
  date:r.customerOtpVerifiedAt||r.date,reference:r.upiPaymentText||r.reference,remarks:r.remarks||'',
  status:r.ledgerPostedAt?'POSTED':Date.now()-new Date(r.customerOtpVerifiedAt||r.createdAt).getTime()>=72*3600*1000?'OVERDUE':'UNPOSTED',
  ledgerPostedAt:r.ledgerPostedAt||null}));
 return ok(res,{items:all.slice((page-1)*limit,page*limit),meta:{page,limit,total:all.length,pages:Math.max(1,Math.ceil(all.length/limit))}});
}));
router.post('/online/:id/post-ledger',allow(cheque,'edit'),safe(async(req,res)=>{
 const fy=await fyOf(req),r=await original(req,fy,req.params.id);if(channel(r)!=='ONLINE')throw reject('Receipt is not an online payment',422);
 if(upper(r.disputeStatus)==='HOLD')throw reject('Receipt on HOLD');
 const {LedgerEntry,Receipt}=financialModels(req.auth.tenantKey,fy);
 if(r.ledgerPostedAt)return ok(res,{alreadyPosted:true,receiptNo:r.receiptNo},'Already posted');
 const existing=await LedgerEntry.find({tenantKey:req.auth.tenantKey,financialYear:fy,transactionId:r.receiptNo,transactionType:'RECEIPT',status:'POSTED'}).lean();
 if(existing.length){if(existing.length!==2||!existing.some(x=>clean(x.partyGlobalId)===clean(r.customerGlobalId)&&money(x.credit)===money(r.amount)))
    throw reject('Existing ledger transaction conflicts with original receipt; manual review required');
 }else{
  const customer=await CustomerLink.findOne({tenantKey:req.auth.tenantKey,globalCustomerId:r.customerGlobalId}).lean();
  if(!customer)throw reject('Customer master not found');
  await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear:fy,transactionId:r.receiptNo,transactionType:'RECEIPT',
    date:r.date||new Date(),partyGlobalId:r.customerGlobalId,narration:r.remarks||`Online receipt ${r.receiptNo}`,
    entries:[{accountCode:'SYS_SUSPENSE',debit:money(r.amount)},
      {accountCode:clean(customer.accountingProfile?.systemAccountCode)||'SYS_SUNDRY_DEBTORS',credit:money(r.amount)}]});
 }
 await Receipt.updateOne({...receiptFilter(req,fy),_id:r._id,ledgerPostedAt:{$in:[null]}},{$set:{ledgerPostedAt:new Date(),ledgerPostedBy:req.auth.sub,
  ledgerPostedByNameSnapshot:req.auth.name||'',receiptWorkflowStatus:'LEDGER_POSTED'}});
 return ok(res,{receiptNo:r.receiptNo,alreadyPosted:false},'Online receipt posted to customer ledger');
}));
router.patch('/online/:id/notes',allow(cheque,'edit'),safe(async(req,res)=>{
 const fy=await fyOf(req),r=await original(req,fy,req.params.id);if(channel(r)!=='ONLINE'||ledgerPosted(r))throw reject('Only unposted online receipts may be edited');
 const remarks=String(req.body.remarks??'');if(remarks.length>2000)throw reject('Remarks too long',422);
 r.remarks=remarks;await r.save();return ok(res,{id:String(r._id)});
}));
router.delete('/online/:id',allow(cheque,'delete'),safe(async(req,res)=>{
 const fy=await fyOf(req),r=await original(req,fy,req.params.id);if(channel(r)!=='ONLINE'||ledgerPosted(r))throw reject('Only unposted online receipts may be voided');
 const reason=clean(req.body.reason);if(reason.length<5)throw reject('Deletion reason required',422);
 const {Receipt}=financialModels(req.auth.tenantKey,fy);
 await Receipt.updateOne({_id:r._id,...receiptFilter(req,fy),ledgerPostedAt:{$in:[null]}},
  {$set:{status:'VOID',receiptWorkflowStatus:'VOIDED'},$push:{disputeHistory:{status:'VOID',remark:reason,at:new Date(),by:req.auth.sub,byName:req.auth.name||''}}});
 return ok(res,{id:String(r._id)},'Online receipt voided; audit retained');
}));
export default router;
