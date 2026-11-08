import express from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { financialModels } from '../services/accountingService.js';
import { GenericRecord } from '../models/index.js';
import { configuredFinancialYear } from '../utils/financialYear.js';
import { isAdminAuth } from '../utils/adminAccess.js';
import { canPageAction } from '../config/permissionPageMap.js';
import { ok, fail } from '../utils/http.js';
import { syncChequeForReceipt, RECEIVED_RESOURCE } from '../services/collectionHubService.js';
import { collectionChannel, onlineCollectionStatus, referenceKey, matchesPostedBankCredit } from '../services/collectionHubRules.js';

const clean = v => String(v ?? '').trim();
const financialYear = async req => {
  const fy = clean(req.query.financialYear || req.body?.financialYear) || await configuredFinancialYear(req.auth.tenantKey);
  if (!/^20\d{2}-\d{2}$/.test(fy) || (+fy.slice(-2) !== ((+fy.slice(0,4)+1)%100))) throw Object.assign(new Error('Invalid financial year'),{statusCode:400});
  return fy;
};
const readLimit = req => Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
const role = auth => clean(auth?.role).toUpperCase().replace(/[- ]/g,'_');
const mobileAllowed = auth => ['SALES_PERSON','SALESPERSON','COLLECTION_EXECUTIVE','COLLECTOR','CASHIER'].includes(role(auth));
const companyAllowed = auth => auth?.role !== 'MASTER' && (auth?.apps || []).includes('dms') && (
  isAdminAuth(auth) || ['/dms/cashier','/dms/cheque-control'].some(page => canPageAction(auth.permissions || [],page,'view'))
);
function safe(handler) { return async(req,res) => {try{await handler(req,res);}catch(error){return fail(res,error.message||'Collection Hub failed',error.statusCode||500);}}; }

async function fetchVerifiedReceipts(req,{mobile=false, channel='', verified=true}={}) {
  const fy = await financialYear(req);
  const { Receipt } = financialModels(req.auth.tenantKey,fy);
  const filter = {tenantKey:req.auth.tenantKey,financialYear:fy, collectionSource:'SALESPERSON_APP', status:{$nin:['DELETED','VOIDED']}};
  if(verified){ filter.customerOtpStatus='VERIFIED'; filter.status='POSTED'; }
  if(channel==='CASH')filter.mode='CASH';
  if(channel==='CHEQUE')filter.$or=[{receiptType:{$in:['CHEQUE','CHECK','CHQ']}},{mode:{$in:['CHEQUE','CHECK','CHQ']}}];
  if(channel==='ONLINE'){filter.mode={$nin:['CASH','CHEQUE','CHECK','CHQ']};filter.receiptType={$nin:['CHEQUE','CHECK','CHQ']};}
  if(mobile && role(req.auth)!=='CASHIER')filter.collectedBySalespersonId = clean(req.auth.sub);
  const page=Math.max(1,Math.min(10000,parseInt(req.query.page,10)||1));
  const records = await Receipt.find(filter).sort({date:-1,_id:-1}).skip((page-1)*readLimit(req)).limit(readLimit(req)).lean();
  const rows = records.map(r => ({ id:String(r._id),financialYear:fy,receiptNo:r.receiptNo,
    date:r.date,partyName:r.partyNameSnapshot,customerGlobalId:r.customerGlobalId,
    amount:Number(r.amount||0), channel:collectionChannel(r),paymentType:r.receiptType,
    collectedBy:r.collectedBySalespersonNameSnapshot,collectorRole:r.collectedByRole||'SALES_PERSON',
    customerOtpStatus:r.customerOtpStatus,physicalStatus:r.cashDepositStatus,
    receiptWorkflowStatus:r.receiptWorkflowStatus,cashierBatchId:r.cashDepositBatchId||'',
    denominations:r.cashDenominations||[],remarks:r.remarks||'',
    chequeNo:r.chequeNumber||'',ifsc:r.payerIfsc||'',reference:r.reference||'',
    onlineStatus:onlineCollectionStatus(r),bankAccountId:r.bankAccountId||'',
    bankMatchStatus:r.bankMatchStatus||'',bankMatchedAt:r.bankMatchedAt||null,
    ledgerStatus:r.ledgerPostedAt?'ORIGINAL_RECEIPT_POSTED':'NOT_POSTED'}));
  return {fy,rows:channel?rows.filter(x=>x.channel===channel):rows,returned:records.length,page};
}

export const mobileCollectionHubRouter = express.Router();
mobileCollectionHubRouter.use(requireAuth);
mobileCollectionHubRouter.use((req,res,next)=>mobileAllowed(req.auth)?next():fail(res,'Salesperson, Collector or Cashier login required',403));
mobileCollectionHubRouter.get('/my-collections',safe(async(req,res)=>{
  const {fy,rows,returned}=await fetchVerifiedReceipts(req,{mobile:true,verified:false});
  return ok(res,{financialYear:fy,items:rows,returned,hasMore:returned===readLimit(req)});
}));

export const dmsCollectionHubRouter = express.Router();
dmsCollectionHubRouter.use(requireAuth);
dmsCollectionHubRouter.use((req,res,next)=>companyAllowed(req.auth)?next():fail(res,'Cashier or Cheque Control View permission required',403));
dmsCollectionHubRouter.get('/overview',safe(async(req,res)=>{
  const requestedChannel=clean(req.query.channel).toUpperCase();
  if(requestedChannel&&!['CASH','CHEQUE','ONLINE'].includes(requestedChannel))return fail(res,'Unsupported collection channel',422);
  const {fy,rows,returned,page}=await fetchVerifiedReceipts(req,{channel:requestedChannel});
  // Full-FY totals from all verified collections, not merely current page.
  const {Receipt}=financialModels(req.auth.tenantKey,fy);
  const aggregate=await Receipt.aggregate([
    {$match:{tenantKey:req.auth.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',status:'POSTED',customerOtpStatus:'VERIFIED'}},
    {$project:{amount:1,cashDepositStatus:1,bankMatchStatus:1,
      channel:{$cond:[{$eq:['$mode','CASH']},'CASH',{$cond:[{$eq:['$receiptType','CHEQUE']},'CHEQUE','ONLINE']}]}}},
    {$group:{_id:'$channel',total:{$sum:'$amount'},count:{$sum:1},
      cashPending:{$sum:{$cond:[{$and:[{$eq:['$channel','CASH']},{$not:[{$in:['$cashDepositStatus',['DEPOSITED_TO_CASHIER','CLOSED']]}]}]},1,0]}},
      onlinePending:{$sum:{$cond:[{$and:[{$eq:['$channel','ONLINE']},{$ne:['$bankMatchStatus','BANK_MATCHED']}]},1,0]}}}}
  ]);
  const agg=Object.fromEntries(aggregate.map(x=>[x._id,x]));
  const cheques=rows.filter(x=>x.channel==='CHEQUE');
  let chequeMap=new Map();
  if(cheques.length){
    const linked=await GenericRecord.find({tenantKey:req.auth.tenantKey,app:'dms',resource:RECEIVED_RESOURCE,
      'data.linkedReceiptFy':fy,'data.linkedReceiptNo':{$in:cheques.map(x=>x.receiptNo)}})
      .select('data.linkedReceiptNo data.status').lean();
    chequeMap=new Map(linked.map(x=>[clean(x.data?.linkedReceiptNo),{id:String(x._id),status:x.data?.status||''}]));
  }
  const items=rows.map(x=>x.channel==='CHEQUE'?{...x,chequeRegister:chequeMap.get(x.receiptNo)||null}:x);
  return ok(res,{financialYear:fy,items,hasMore:returned===readLimit(req),limit:readLimit(req),
    page,summary:{cash:agg.CASH?.total||0,cheque:agg.CHEQUE?.total||0,online:agg.ONLINE?.total||0,
      cashPending:agg.CASH?.cashPending||0,
      chequeUnlinked:items.filter(x=>x.channel==='CHEQUE'&&!x.chequeRegister).length,
      chequeUnlinkedScope:'CURRENT_PAGE',onlinePending:agg.ONLINE?.onlinePending||0},
    notice:'Online entries are visible after OTP; bank clearing requires bank-statement reconciliation. Customer ledger may already have an original OTP posting to suspense.'});
}));

// Query outstanding physical cash BEFORE pagination, rather than paging all
// receipts and dropping deposited ones in the browser. Otherwise older cash
// collections vanish when the FY contains more than one page of receipts.
dmsCollectionHubRouter.get('/cashier/pending-cash',safe(async(req,res)=>{
  const fy=await financialYear(req),{Receipt}=financialModels(req.auth.tenantKey,fy);
  const page=Math.max(1,parseInt(req.query.page,10)||1),limit=Math.min(200,Math.max(1,parseInt(req.query.limit,10)||100));
  const filter={tenantKey:req.auth.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',
    status:'POSTED',customerOtpStatus:'VERIFIED',mode:'CASH',
    cashDepositStatus:{$nin:['DEPOSITED_TO_CASHIER','CLOSED']},
    $or:[{cashDepositBatchId:{$exists:false}},{cashDepositBatchId:''},{cashDepositBatchId:null}]};
  const [rows,total]=await Promise.all([
    Receipt.find(filter).sort({date:-1,_id:-1}).skip((page-1)*limit).limit(limit).lean(),
    Receipt.countDocuments(filter)]);
  return ok(res,{financialYear:fy,page,limit,total,pages:Math.max(1,Math.ceil(total/limit)),
    items:rows.map(r=>({id:String(r._id),receiptNo:r.receiptNo,partyName:r.partyNameSnapshot,
      date:r.customerOtpVerifiedAt||r.createdAt||r.date,collectedBy:r.collectedBySalespersonNameSnapshot||r.createdByNameSnapshot||'',
      collectedById:r.collectedBySalespersonId||r.createdBy||'',
      amount:Number(r.amount||0),denominations:r.cashDenominations||[],physicalStatus:r.cashDepositStatus||'PENDING_TO_DEPOSIT',
      disputeStatus:r.disputeStatus||'NONE',disputeRemark:r.disputeRemark||'',ledgerPostedAt:r.ledgerPostedAt||null}))});
}));

// Non-financial corrections for receipt-backed ONLINE and CHEQUE rows. Amount,
// party, date, bank match and posting cannot be changed by this endpoint.
dmsCollectionHubRouter.patch('/receipts/:id/notes',safe(async(req,res)=>{
  if(!isAdminAuth(req.auth)&&!['/dms/cashier','/dms/cheque-control'].some(page=>canPageAction(req.auth.permissions||[],page,'edit')))
    return fail(res,'Edit permission required',403);
  const fy=await financialYear(req),{Receipt}=financialModels(req.auth.tenantKey,fy);
  if(!mongoose.isValidObjectId(req.params.id))return fail(res,'Invalid receipt ID',400);
  const receipt=await Receipt.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear:fy,
    collectionSource:'SALESPERSON_APP',status:'POSTED',customerOtpStatus:'VERIFIED'});
  if(!receipt)return fail(res,'Confirmed collection not found',404);
  const remarks=clean(req.body?.remarks);
  if(remarks.length>1000)return fail(res,'Remarks are limited to 1,000 characters',422);
  receipt.remarks=remarks;
  await receipt.save();
  return ok(res,{id:String(receipt._id),remarks},'Collection remarks updated; financial amounts and ledger unchanged');
}));

// Retry failed OTP-to-cheque links for existing confirmed receipts. Does NOT create receipt or ledger entries.
dmsCollectionHubRouter.post('/sync-cheques',safe(async(req,res)=>{
  if(!isAdminAuth(req.auth) && !canPageAction(req.auth.permissions||[],'/dms/cheque-control','edit'))return fail(res,'Cheque Control Edit permission required',403);
  const fy=await financialYear(req),{Receipt}=financialModels(req.auth.tenantKey,fy);
  const receipts=await Receipt.find({tenantKey:req.auth.tenantKey,financialYear:fy,collectionSource:'SALESPERSON_APP',
    status:'POSTED',customerOtpStatus:'VERIFIED',$or:[{receiptType:'CHEQUE'},{mode:'CHEQUE'}]}).sort({date:-1}).limit(300).lean();
  const report={linked:0,alreadyLinked:0,needsReview:[]};
  for(const receipt of receipts){
    try{const result=await syncChequeForReceipt(receipt,req.auth);if(result?.alreadyLinked)report.alreadyLinked++;else report.linked++;}
    catch(e){report.needsReview.push({receiptNo:receipt.receiptNo,reason:e.message});}
  }
  return ok(res,{financialYear:fy,...report,partial:receipts.length===300},'Cheque linkage checked; no financial journal entries were posted');
}));

// Suggest only EXPLICIT UTR matches in real posted credits. Amount-only
// suggestions are dangerous when multiple customers pay the same value.
dmsCollectionHubRouter.get('/online/:receiptId/suggestions',safe(async(req,res)=>{
  const fy=await financialYear(req),{Receipt,BankStatementRow}=financialModels(req.auth.tenantKey,fy);
  if(!mongoose.isValidObjectId(req.params.receiptId))return fail(res,'Valid receipt ID required',400);
  const receipt=await Receipt.findOne({_id:req.params.receiptId,tenantKey:req.auth.tenantKey,financialYear:fy,status:'POSTED',customerOtpStatus:'VERIFIED',collectionSource:'SALESPERSON_APP'}).lean();
  if(!receipt||collectionChannel(receipt)!=='ONLINE')return fail(res,'Verified online receipt not found',404);
  const ref=referenceKey(receipt.upiPaymentText||receipt.reference);
  if(ref.length<6)return fail(res,'UTR or transaction reference is too short for automatic bank matching',422);
  const candidates=await BankStatementRow.find({tenantKey:req.auth.tenantKey,financialYear:fy,
    credit:{$gte:Number(receipt.amount)-0.005,$lte:Number(receipt.amount)+0.005},
    classification:'POSTED',transactionId:{$nin:[null,'']}})
    .sort({date:-1}).limit(3000).select('_id bankAccountId date credit remarks partyName transactionId').lean();
  const items=candidates.filter(row=>matchesPostedBankCredit(receipt,{...row,classification:'POSTED'}))
    .slice(0,20).map(row=>({id:String(row._id),bankAccountId:row.bankAccountId,
      date:row.date,amount:row.credit,reference:row.remarks,bankTransactionId:row.transactionId}));
  return ok(res,{items,matchRule:'Exact UTR found in posted bank-credit narration with matching amount',hasMore:candidates.length===3000});
}));
// Risk-free bank reference matching: only compare posted statement rows, and never post another ledger journal.
dmsCollectionHubRouter.post('/online/:receiptId/match',safe(async(req,res)=>{
  if(!isAdminAuth(req.auth) && !canPageAction(req.auth.permissions||[],'/dms/banking','edit'))return fail(res,'Bank Edit permission required',403);
  const fy=await financialYear(req),{Receipt,BankStatementRow}=financialModels(req.auth.tenantKey,fy);
  if(!mongoose.isValidObjectId(req.params.receiptId) || !mongoose.isValidObjectId(req.body?.statementRowId))return fail(res,'Valid receipt and bank statement row IDs required',400);
  const receipt=await Receipt.findOne({_id:req.params.receiptId,tenantKey:req.auth.tenantKey,financialYear:fy,status:'POSTED',customerOtpStatus:'VERIFIED',collectionSource:'SALESPERSON_APP'});
  if(!receipt||collectionChannel(receipt)!=='ONLINE')return fail(res,'Verified online collection not found',404);
  const row=await BankStatementRow.findOne({_id:req.body.statementRowId,tenantKey:req.auth.tenantKey,financialYear:fy,
    bankAccountId:clean(req.body.bankAccountId),classification:'POSTED',transactionId:{$nin:[null,'']}}).lean();
  if(!row||!matchesPostedBankCredit(receipt,row))return fail(res,'Bank statement credit must match the receipt amount AND exact UTR/reference',409);

  const already=await Receipt.exists({tenantKey:req.auth.tenantKey,financialYear:fy,_id:{$ne:receipt._id},bankMatchStatementRowId:String(row._id),bankMatchStatus:'BANK_MATCHED'});
  if(already)return fail(res,'This bank credit is already allocated to another online collection',409);
  if(receipt.bankMatchStatus==='BANK_MATCHED')return fail(res,'This online receipt is already matched',409);
  receipt.bankMatchStatementRowId=String(row._id);receipt.bankMatchStatus='BANK_MATCHED';receipt.bankMatchedAt=new Date();
  receipt.bankAccountId=row.bankAccountId;try{await receipt.save();}catch(e){if(e.code===11000)return fail(res,'Bank credit was linked concurrently to another receipt',409);throw e;}
  return ok(res,{receiptNo:receipt.receiptNo,bankAccountId:row.bankAccountId,ledgerReconciled:false},
    'Bank credit matched. Review suspense/customer ledger before financial settlement; no second journal was posted.');
}));
