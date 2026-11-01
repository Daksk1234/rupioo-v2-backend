/** Phase 2: one authoritative route for delivery, cancellation and stock custody.
 *  Uses the existing FY models and journals; never reverses the original invoice debit.
 */
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { CustomerLink, GenericRecord, Product, User, Transporter, FileMeta } from "../models/index.js";
import { financialModels, postBalancedEntries } from "../services/accountingService.js";
import { createOtp, getActiveCustomerOrderOtp, verifyOtp } from "../services/otpService.js";
import { syncSalesInvoiceCreditState, validateCreditNoteAgainstInvoice } from "../services/creditNoteRulesService.js";
import { saveUploadedFile } from "../services/storageService.js";
import { ok, fail } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { resolveFinancialYear } from "../utils/financialYear.js";
const router=express.Router();router.use(requireAuth);
const S=v=>String(v??"").trim(), U=v=>S(v).toUpperCase(), N=v=>Number.isFinite(Number(v))?Number(v):0, M=v=>Math.round((N(v)+Number.EPSILON)*100)/100;
const admin=a=>["MASTER","SUPERADMIN"].includes(U(a?.role));
const staff=a=>admin(a)||["ORDER_DESK","ORDER_PROCESSING_DESK","SALESPERSON","SALES_PERSON"].includes(U(a?.role));
const forbid=(msg,status=409)=>Object.assign(new Error(msg),{statusCode:status});
const raised=(e,res)=>fail(res,e.message,e.statusCode||500);
const ownership=(a,run)=>admin(a)||U(a?.role)==="DELIVERY_BOY"&&S(run.deliveryBoyId)===S(a.sub);
async function ctx(req){const fy=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.query.financialYear||req.body?.financialYear});return {fy,models:financialModels(req.auth.tenantKey,fy),tenantKey:req.auth.tenantKey}}
async function record(ctx,id){const order=await ctx.models.SalesOrder.findOne({_id:id,tenantKey:ctx.tenantKey,financialYear:ctx.fy});if(!order)throw forbid("Sales order not found",404);return order}
async function link(ctx,order){const invoiceId=S(order.invoice?.invoiceId);return invoiceId?ctx.models.SalesInvoice.findOne({_id:invoiceId,tenantKey:ctx.tenantKey,financialYear:ctx.fy}):null}
async function runFor(ctx,order){if(!order.deliveryRunId)return null;return ctx.models.DeliveryRun.findOne({_id:order.deliveryRunId,tenantKey:ctx.tenantKey,financialYear:ctx.fy})}
async function event(req,ctx,order,type,note,from){await ctx.models.OrderEvent.create({tenantKey:ctx.tenantKey,financialYear:ctx.fy,eventNo:makeId("EVT"),orderId:String(order._id),orderNo:order.orderNo,invoiceId:order.invoice?.invoiceId||"",invoiceNo:order.invoice?.invoiceNo||"",deliveryRunId:order.deliveryRunId||"",type,fromStatus:from||order.workflowStatus,toStatus:order.workflowStatus,note,audience:["DMS","CUSTOMER","SALESPERSON","WAREHOUSE","DELIVERY_BOY"],actorId:req.auth.sub,actorRole:req.auth.role,actorNameSnapshot:req.auth.name||"",occurredAt:new Date()})}
async function updateStatus(req,ctx,order,status,note,type){const old=order.workflowStatus;order.workflowStatus=status;order.lastWorkflowAt=new Date();order.nextAction=note;if(status==="CANCELLED")order.status="CANCELLED";else if(status==="DELIVERED")order.status="CONVERTED";else order.status="PROCESSING";await order.save();await event(req,ctx,order,type||status,note,old)}
async function main(ctx,order){const w=await GenericRecord.findOne({_id:order.mainWarehouseId,tenantKey:ctx.tenantKey,app:"dms",resource:"warehouses",status:"ACTIVE"}).lean();if(!w)throw forbid("Main Warehouse is missing or inactive");return w}
async function ledgerCancel(req,ctx,order,invoice){
  if(!invoice)return null;
  if(invoice.delivery?.deliveredAt||["DELIVERED","HANDED_TO_TRANSPORTER"].includes(U(invoice.workflowStatus)))throw forbid("Delivered invoices cannot be cancelled");
  const existing=await ctx.models.CreditNote.findOne({tenantKey:ctx.tenantKey,financialYear:ctx.fy,invoiceId:String(invoice._id),origin:"ORDER_CANCELLATION"});
  if(existing){if(existing.status!=="ISSUED")throw forbid("A prior cancellation Credit Note needs accounts reconciliation");return existing}
  // Number is based on original invoice's numeric serial, with only FY suffix retained.
  const base=S(invoice.invoiceNo).replace(/[-\/_]?(?:20)?\d{2}[-\/_]\d{2}$/,'');
  const serial=base.match(/(\d+)$/)?.[1];if(!serial)throw forbid("Could not derive the original invoice serial for Credit Note");
  const fyShort=`${ctx.fy.slice(2,4)}-${ctx.fy.slice(-2)}`;
  const creditNoteNo=`CN-${serial}-${fyShort}`;
  if(await ctx.models.CreditNote.exists({tenantKey:ctx.tenantKey,financialYear:ctx.fy,creditNoteNo}))throw forbid(`Credit Note number collision: ${creditNoteNo}. Check existing invoice numbering before proceeding.`);
  const items=(invoice.items||[]).map(x=>({productId:x.productId,sku:x.sku,nameSnapshot:x.nameSnapshot,hsnSnapshot:x.hsnSnapshot,qty:N(x.qty),unit:x.unit,packingUnit:x.packingUnit,rate:N(x.rate),gradeDiscountPct:N(x.gradeDiscountPct),discountPct:N(x.discountPct),effectiveRate:N(x.effectiveRate),taxable:M(x.taxable),gstRateSnapshot:N(x.gstRateSnapshot),cgst:M(x.cgst),sgst:M(x.sgst),igst:M(x.igst),tax:M(x.tax),lineTotal:M(x.lineTotal),condition:"UNDELIVERED"}));
  const noteData={tenantKey:ctx.tenantKey,financialYear:ctx.fy,documentType:"CREDIT_NOTE",creditNoteNo,documentNo:creditNoteNo,date:new Date(),orderId:String(order._id),orderNo:order.orderNo,invoiceId:String(invoice._id),invoiceNo:invoice.invoiceNo,referenceDocumentId:String(invoice._id),referenceDocumentNo:invoice.invoiceNo,referenceDocumentDate:invoice.date,customerGlobalId:invoice.customerGlobalId,customerNameSnapshot:invoice.customerNameSnapshot,partyGlobalId:invoice.customerGlobalId,partyNameSnapshot:invoice.customerNameSnapshot,partyGstinSnapshot:invoice.gstinSnapshot,addressSnapshot:invoice.addressSnapshot,items,subtotal:M(invoice.subtotal),billDiscount:M(invoice.billDiscount),otherCharges:M(invoice.otherCharges),taxableTotal:M(invoice.taxableTotal),taxTotal:M(invoice.taxTotal),roundOff:M(invoice.roundOff),grandTotal:M(invoice.grandTotal),warehouseId:order.mainWarehouseId||invoice.warehouseId,reasonType:"ORDER_CANCELLATION",reason:order.cancellation?.remarks||order.cancellation?.reason||"Cancelled before delivery",gstType:invoice.gstType,origin:"ORDER_CANCELLATION",stockEffectApplied:false,status:"DRAFT",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""};
  await validateCreditNoteAgainstInvoice({models:ctx.models,tenantKey:ctx.tenantKey,financialYear:ctx.fy,invoice,note:noteData});
  const note=await ctx.models.CreditNote.create(noteData);
  const customer=await CustomerLink.findOne({tenantKey:ctx.tenantKey,globalCustomerId:invoice.customerGlobalId}).select("accountingProfile.systemAccountCode").lean();
  const receivableCode=S(customer?.accountingProfile?.systemAccountCode)||"SYS_SUNDRY_DEBTORS";
  const roundOff=M(note.roundOff);
  await postBalancedEntries({tenantKey:ctx.tenantKey,financialYear:ctx.fy,transactionId:note.creditNoteNo,transactionType:"SALES_CREDIT_NOTE",date:note.date,partyGlobalId:invoice.customerGlobalId,narration:`Credit Note ${note.creditNoteNo} against cancelled Invoice ${invoice.invoiceNo}`,entries:[
    {accountCode:"SYS_SALES",debit:note.taxableTotal},
    {accountCode:"SYS_DUTIES_TAXES",debit:note.taxTotal},
    {accountCode:roundOff>=0?"SYS_INDIRECT_INCOME":"SYS_INDIRECT_EXPENSE",debit:roundOff>0?roundOff:0,credit:roundOff<0?Math.abs(roundOff):0},
    {accountCode:receivableCode,credit:note.grandTotal},
  ].filter(x=>N(x.debit)||N(x.credit))});
  note.status="ISSUED";note.issuedAt=new Date();note.issuedBy=req.auth.sub;await note.save();
  invoice.status="CANCELLED";invoice.workflowStatus="CANCELLED";await invoice.save();
  await syncSalesInvoiceCreditState({models:ctx.models,tenantKey:ctx.tenantKey,financialYear:ctx.fy,invoiceId:String(invoice._id)});
  return note;
}
async function reverseReady(ctx,order){
  const transfers=await ctx.models.WarehouseTransfer.find({tenantKey:ctx.tenantKey,financialYear:ctx.fy,orderId:String(order._id)}).lean();
  if(transfers.some(t=>t.status==="REQUESTED"))return false;
  for(const t of transfers.filter(t=>t.mode!=="RETURN"&&t.status==="RECEIVED")){
    const sent=transfers.filter(r=>r.mode==="RETURN"&&r.status==="RECEIVED"&&S(r.toWarehouseId)===S(t.fromWarehouseId));
    for(const item of t.items||[]){const received=sent.reduce((v,r)=>v+(r.items||[]).filter(i=>S(i.productId)===S(item.productId)).reduce((n,i)=>n+N(i.qty),0),0);if(received+0.00001<N(item.qty))return false}
  }return true;
}
async function finalize(req,ctx,order){
  if(U(order.workflowStatus)!=="CANCELLATION_IN_PROCESS")throw forbid("No approved cancellation is in progress");
  if(!["APPROVED","RETURNED"].includes(U(order.cancellation?.status)))throw forbid("Cancellation requires role-specific approval before finalizing");
  if(order.deliveryRunId&&U(order.handover?.status)!=="RECEIVED")throw forbid("Delivery Boy must hand all items to the Main Warehouse first");
  if(!await reverseReady(ctx,order))throw forbid("Complete every original-warehouse reverse transfer before final cancellation");
  const invoice=await link(ctx,order);
  const note=await ledgerCancel(req,ctx,order,invoice);
  for(const item of order.items||[]){const qty=N(item.reservedQty);if(qty){await Product.updateOne({_id:item.productId,tenantKey:ctx.tenantKey},{$inc:{reservedStock:-qty}});await Product.updateOne({_id:item.productId,tenantKey:ctx.tenantKey,reservedStock:{$lt:0}},{$set:{reservedStock:0}})}item.reservedQty=0;item.cancelledQty=N(item.qty)}
  order.reservation={status:"RELEASED",releasedAt:new Date(),releasedReason:"Cancelled before delivery"};
  order.cancellation.status="COMPLETED";order.cancellation.completedAt=new Date();if(note){order.cancellation.creditNoteId=String(note._id);order.cancellation.creditNoteNo=note.creditNoteNo}
  const run=await runFor(ctx,order);if(run){for(const stop of run.stops||[]){if(S(stop.orderId)===String(order._id))stop.status="SKIPPED"}run.status="COMPLETED";run.completedAt=new Date();await run.save()}
  await updateStatus(req,ctx,order,"CANCELLED",`Cancelled${note?` • Credit Note ${note.creditNoteNo}`:""}`,"ORDER_CANCELLED");return note;
}
async function settleCustody(req,ctx,order,kind){
  if(order.dispatchCustody?.settledAt)return;
  const warehouseId=S(order.mainWarehouseId);if(!warehouseId)throw forbid("Main Warehouse not found");
  if(order.dispatchCustody?.recordedAt){
    for(const item of order.items||[]){const qty=N(item.packedQty)||N(item.qty);if(qty>0)await ctx.models.StockMovement.create({tenantKey:ctx.tenantKey,financialYear:ctx.fy,date:new Date(),productId:item.productId,warehouseId,type:kind==="RETURN"?"WAREHOUSE_RETURN_IN":"DELIVERY_CUSTODY_SETTLED_IN",qtyIn:qty,qtyOut:0,referenceId:order.orderNo})}
  }else if(kind==="RETURN"){
    // Legacy dispatches without a custody-out movement must not double count stock.
    // The physical return is recorded in the custody audit, not as a second stock receipt.
  }
  order.dispatchCustody={...(order.dispatchCustody?.toObject?.()||order.dispatchCustody||{}),settledAt:new Date(),settlement:kind};await order.save();
}
async function deliver(req,ctx,order,payload){
  if(!["DELIVERY_ASSIGNED","OUT_FOR_DELIVERY"].includes(U(order.workflowStatus)))throw forbid("Order is not pending delivery");
  const run=await runFor(ctx,order);if(!run||!ownership(req.auth,run))throw forbid("Only assigned Delivery Boy can deliver this order",403);
  const stop=run.stops.find(s=>S(s.orderId)===String(order._id));if(!stop||!["PENDING","STARTED","ARRIVED"].includes(stop.status))throw forbid("Stop already completed or no longer active");
  const invoice=await link(ctx,order);if(!invoice||invoice.status!=="POSTED")throw forbid("Posted order invoice is required");
  // Check stock BEFORE consuming customer's OTP or changing any custody records.
  for(const item of order.items||[]){
    const qty=N(item.invoicedQty)||N(item.packedQty)||N(item.qty);
    const product=await Product.findOne({_id:item.productId,tenantKey:ctx.tenantKey}).select("name currentStock").lean();
    if(!product||N(product.currentStock)+0.000001<qty)throw forbid(`${item.nameSnapshot}: current stock is below the delivered quantity; reconcile before verification`);
  }
  if(stop.destinationType==="CUSTOMER"){
    const ch=await verifyOtp({otpId:S(payload.otpId||order.handover?.customerOtpId),code:S(payload.code)});
    if(!ch.ok||ch.challenge.tenantKey!==ctx.tenantKey||ch.challenge.transactionId!==String(order._id)||ch.challenge.actionType!=="DELIVERY_CUSTOMER_CONFIRM"||S(ch.challenge.recipientId)!==S(order.customerGlobalId))throw forbid("Invalid customer delivery OTP");
    stop.customerOtp={otpId:ch.challenge.otpId,verifiedAt:new Date()};stop.status="DELIVERED";
  }else{
    const customer=await CustomerLink.findOne({tenantKey:ctx.tenantKey,globalCustomerId:order.customerGlobalId}).lean();
    const allowed=(customer?.assignedTransporters||[]).map(t=>S(t.transporterId)).filter(Boolean);
    const tId=S(payload.transporterId||invoice.transportAssignment?.transporterId);
    if(!tId||!(allowed.includes(tId)||tId===S(invoice.transportAssignment?.transporterId)))throw forbid("Choose a transporter assigned to this customer");
    const transporter=await Transporter.findOne({_id:tId,tenantKey:ctx.tenantKey}).lean();if(!transporter)throw forbid("Transporter not found");
    if(!S(payload.bnNo)||!S(payload.bnDate)||!S(payload.proofFileId)||!(N(payload.packages)>0)||!(N(payload.weight)>0))throw forbid("BN number, date, image, packages and weight are required");
    if(!Number.isFinite(Date.parse(payload.bnDate)))throw forbid("Invalid BN date");
    const proof=await FileMeta.findOne({fileId:S(payload.proofFileId),tenantKey:ctx.tenantKey,module:"ORDER",entityType:"DELIVERY_PROOF",entityId:String(order._id)}).lean();
    if(!proof||!S(proof.mimeType).startsWith("image/"))throw forbid("Upload a valid BN image for this order");
    if(N(stop.packageCount)>0&&N(payload.packages)!==N(stop.packageCount))throw forbid("Packages differ from Main Warehouse handover");
    stop.transporterHandover={cnNo:S(payload.bnNo),cnDate:new Date(payload.bnDate),packages:N(payload.packages),weight:N(payload.weight),transporterId:tId,totalAmount:N(invoice.grandTotal),proofFileId:S(payload.proofFileId),capturedAt:new Date()};
    stop.transporterId=tId;stop.transporterNameSnapshot=transporter.name||transporter.title||"Transporter";stop.status="HANDED_TO_TRANSPORTER";
  }
  await settleCustody(req,ctx,order,"DELIVERED");
  for(const item of order.items||[]){const qty=N(item.invoicedQty)||N(item.packedQty)||N(item.qty);if(!(qty>0))continue;
    const product=await Product.findOneAndUpdate({_id:item.productId,tenantKey:ctx.tenantKey,currentStock:{$gte:qty}},{$inc:{currentStock:-qty,reservedStock:-N(item.reservedQty)}},{new:true});if(!product)throw forbid(`${item.nameSnapshot}: insufficient stock for final delivery`);
    if(N(product.reservedStock)<0)await Product.updateOne({_id:product._id},{$set:{reservedStock:0}});
    await ctx.models.StockMovement.create({tenantKey:ctx.tenantKey,financialYear:ctx.fy,date:new Date(),productId:item.productId,warehouseId:order.mainWarehouseId||order.warehouseId||"",type:"DELIVERY_SALE",qtyIn:0,qtyOut:qty,referenceId:invoice.invoiceNo});item.reservedQty=0;
  }
  order.reservation={status:"RELEASED",releasedAt:new Date(),releasedReason:"Delivered"};
  stop.completedAt=new Date();await run.save();
  invoice.workflowStatus="DELIVERED";invoice.delivery={...(invoice.delivery?.toObject?.()||invoice.delivery||{}),deliveredAt:new Date(),deliveredTo:stop.destinationType==="CUSTOMER"?stop.customerNameSnapshot:stop.transporterNameSnapshot,deliveryMode:stop.destinationType==="CUSTOMER"?"CUSTOMER_OTP":"TRANSPORTER_BN",biltyNo:stop.transporterHandover?.cnNo||"",proofFileIds:stop.transporterHandover?.proofFileId?[stop.transporterHandover.proofFileId]:[]};await invoice.save();
  run.status="COMPLETED";run.completedAt=new Date();await run.save();
  await updateStatus(req,ctx,order,"DELIVERED",stop.destinationType==="CUSTOMER"?"Customer OTP verified; stock moved to Outward":"BN captured; stock moved to Outward","DELIVERED");
  return {order,run,stop};
}
// For safely saving a BN or cancelled-stock photo; no public filesystem URLs.
router.post("/phase2/proofs",async(req,res)=>{try{
  if(!["DELIVERY_BOY","WAREHOUSE"].includes(U(req.auth.role))&&!admin(req.auth))return fail(res,"Not authorized",403);
  const mime=S(req.body.mimeType||"image/jpeg");if(!["image/jpeg","image/png","image/webp"].includes(mime))return fail(res,"Only JPG, PNG or WEBP allowed",400);
  const raw=S(req.body.base64).replace(/^data:image\/\w+;base64,/,"");if(!raw||raw.length>3_500_000)return fail(res,"Image is missing or exceeds ~2.5 MB",400);
  const buffer=Buffer.from(raw,"base64");if(buffer.length>2_600_000)return fail(res,"Image too large",400);
  const meta=await saveUploadedFile({file:{buffer,mimetype:mime,originalname:`order-proof-${Date.now()}.${mime.split('/')[1]}`,size:buffer.length},tenantKey:req.auth.tenantKey,module:"ORDER",entityType:"DELIVERY_PROOF",entityId:S(req.body.orderId),uploadedBy:req.auth.sub,access:"PRIVATE"});return ok(res,meta,"Proof uploaded",201);
}catch(e){return raised(e,res)}});
router.get("/phase2/deliveries",async(req,res)=>{try{
  if(U(req.auth.role)!=="DELIVERY_BOY"&&!admin(req.auth))return fail(res,"Delivery Boy login required",403);
  const c=await ctx(req),filter={tenantKey:c.tenantKey,financialYear:c.fy};if(!admin(req.auth))filter.deliveryBoyId=S(req.auth.sub);
  const runs=await c.models.DeliveryRun.find(filter).sort({createdAt:-1}).limit(250).lean();const ids=[...new Set(runs.flatMap(r=>(r.stops||[]).map(s=>s.orderId)))];
  const orders=await c.models.SalesOrder.find({_id:{$in:ids},tenantKey:c.tenantKey,financialYear:c.fy}).lean();const byId=new Map(orders.map(o=>[String(o._id),o]));
  const items=runs.flatMap(r=>(r.stops||[]).map(stop=>{const order=byId.get(S(stop.orderId));if(!order)return null;
    const status=U(order.workflowStatus),handover=U(order.handover?.status);const tab=status==="DELIVERED"?"DELIVERED":status==="CANCELLED"?"CANCELLED":status==="CANCELLATION_IN_PROCESS"&&handover!=="RECEIVED"?"HANDOVER":"PENDING";
    return {_id:String(order._id),orderNo:order.orderNo,invoiceNo:stop.invoiceNo,customerName:order.customerNameSnapshot,amount:order.grandTotal,destinationType:stop.destinationType,deliveryRunId:String(r._id),stopId:stop.stopId,tab,status,warehouseId:order.mainWarehouseId,cancellation:order.cancellation,handover:order.handover,items:order.items,transporterName:stop.transporterNameSnapshot,packageCount:stop.packageCount,weight:stop.actualWeight};}).filter(Boolean));return ok(res,{financialYear:c.fy,items});
}catch(e){return raised(e,res)}});
router.get("/phase2/deliveries/:id/transporters",async(req,res)=>{try{const c=await ctx(req),o=await record(c,req.params.id),run=await runFor(c,o);if(!run||!ownership(req.auth,run))return fail(res,"Not assigned",403);const customer=await CustomerLink.findOne({tenantKey:c.tenantKey,globalCustomerId:o.customerGlobalId}).lean();const invoice=await link(c,o);const choices=(customer?.assignedTransporters||[]).map(t=>({id:S(t.transporterId),name:t.transporterName}));if(invoice?.transportAssignment?.transporterId&&!choices.some(x=>x.id===S(invoice.transportAssignment.transporterId)))choices.push({id:S(invoice.transportAssignment.transporterId),name:invoice.transportAssignment.transporterNameSnapshot||"Assigned Transporter"});return ok(res,{items:choices.filter(x=>x.id)});}catch(e){return raised(e,res)}});
router.post("/phase2/deliveries/:id/otp",async(req,res)=>{try{const c=await ctx(req),o=await record(c,req.params.id),run=await runFor(c,o);if(!run||!ownership(req.auth,run))return fail(res,"Not assigned",403);if(!["DELIVERY_ASSIGNED","OUT_FOR_DELIVERY"].includes(U(o.workflowStatus)))return fail(res,"Order not pending delivery",409);const stop=run.stops.find(s=>S(s.orderId)===String(o._id));if(stop?.destinationType!=="CUSTOMER")return fail(res,"Only LOCAL delivery uses customer OTP",409);const otp=await createOtp({tenantKey:c.tenantKey,transactionId:String(o._id),actionType:"DELIVERY_CUSTOMER_CONFIRM",recipientId:o.customerGlobalId});o.handover={...(o.handover?.toObject?.()||o.handover||{}),customerOtpId:otp.otpId};await o.save();return ok(res,{otpId:otp.otpId,expiresAt:otp.expiresAt},"Customer can view this OTP in Customer App");}catch(e){return raised(e,res)}});
router.post("/phase2/deliveries/:id/complete",async(req,res)=>{try{const c=await ctx(req),o=await record(c,req.params.id);return ok(res,await deliver(req,c,o,req.body),"Delivered; stock moved to Outward");}catch(e){return raised(e,res)}});
router.get("/phase2/cancellation/:id/salesperson-otp",async(req,res)=>{try{const c=await ctx(req),o=await record(c,req.params.id);if(!admin(req.auth)&&S(o.salespersonId)!==S(req.auth.sub))return fail(res,"Only assigned Salesperson can view OTP",403);return ok(res,await getActiveCustomerOrderOtp({tenantKey:c.tenantKey,transactionId:String(o._id),recipientId:S(o.salespersonId),otpId:o.cancellation?.salespersonOtpId,actionType:"SALESPERSON_CANCEL"})||{otp:null});}catch(e){return raised(e,res)}});
router.post("/phase2/cancellation/:id/salesperson-otp",async(req,res)=>{try{const c=await ctx(req),o=await record(c,req.params.id),run=await runFor(c,o);if(!run||!ownership(req.auth,run))return fail(res,"Not assigned",403);if(!S(o.salespersonId))return fail(res,"No assigned Salesperson; ask Order Desk to cancel",409);const otp=await createOtp({tenantKey:c.tenantKey,transactionId:String(o._id),actionType:"SALESPERSON_CANCEL",recipientId:S(o.salespersonId)});o.cancellation={...(o.cancellation?.toObject?.()||o.cancellation||{}),salespersonOtpId:otp.otpId};await o.save();return ok(res,{otpId:otp.otpId,expiresAt:otp.expiresAt},"Ask assigned Salesperson for OTP");}catch(e){return raised(e,res)}});
router.post("/phase2/cancellation/:id/customer-otp",async(req,res)=>{try{const c=await ctx(req),o=await record(c,req.params.id);if(!admin(req.auth)&&S(o.salespersonId)!==S(req.auth.sub))return fail(res,"Only assigned Salesperson can request customer OTP",403);if(["CANCELLED","DELIVERED","HANDED_TO_TRANSPORTER"].includes(U(o.workflowStatus)))return fail(res,"Order cannot be cancelled",409);const otp=await createOtp({tenantKey:c.tenantKey,transactionId:String(o._id),actionType:"ORDER_CANCEL_CONFIRM",recipientId:o.customerGlobalId});o.cancellation={...(o.cancellation?.toObject?.()||o.cancellation||{}),customerOtpId:otp.otpId};await o.save();return ok(res,{otpId:otp.otpId,expiresAt:otp.expiresAt},"Customer OTP generated. Customer must share it with Salesperson");}catch(e){return raised(e,res)}});
router.post("/phase2/cancellation/:id/request",async(req,res)=>{try{
  const c=await ctx(req),o=await record(c,req.params.id),source=U(req.body.source);if(!["SALESPERSON","DELIVERY_BOY","ORDER_DESK"].includes(source))return fail(res,"Invalid cancellation source",400);
  if(["DELIVERED","HANDED_TO_TRANSPORTER","CLOSED","CANCELLED","REJECTED"].includes(U(o.workflowStatus)))return fail(res,"Cannot cancel delivered or closed orders",409);
  if(U(o.workflowStatus)==="CANCELLATION_IN_PROCESS")return fail(res,"Cancellation already in process",409);
  const reason=S(req.body.reason),remarks=S(req.body.remarks);if(!reason)return fail(res,"Cancellation reason required",400);
  const run=await runFor(c,o);let otpId="";
  if(source==="SALESPERSON"){
    if(!admin(req.auth)&&S(o.salespersonId)!==S(req.auth.sub))return fail(res,"Only assigned Salesperson can cancel",403);
    const check=await verifyOtp({otpId:S(o.cancellation?.customerOtpId),code:S(req.body.code)});if(!check.ok||check.challenge.tenantKey!==c.tenantKey||check.challenge.transactionId!==String(o._id)||check.challenge.actionType!=="ORDER_CANCEL_CONFIRM")return fail(res,"Customer cancellation OTP incorrect",400);otpId=check.challenge.otpId;
  }else if(source==="DELIVERY_BOY"){
    if(!run||!ownership(req.auth,run))return fail(res,"Only assigned Delivery Boy can cancel",403);
    if(!S(req.body.stockImageFileId))return fail(res,"Stock image is mandatory",400);
    const stockPhoto=await FileMeta.findOne({fileId:S(req.body.stockImageFileId),tenantKey:c.tenantKey,module:"ORDER",entityType:"DELIVERY_PROOF",entityId:String(o._id)}).lean();
    if(!stockPhoto||!S(stockPhoto.mimeType).startsWith("image/"))return fail(res,"Upload a valid stock image for this order",400);
    const items=Array.isArray(req.body.items)?req.body.items:[];
    if(items.length!==(o.items||[]).length||items.some(i=>!(N(i.qty)>0)))return fail(res,"Enter stock quantity for every product",400);
    const check=await verifyOtp({otpId:S(o.cancellation?.salespersonOtpId),code:S(req.body.code)});if(!check.ok||check.challenge.tenantKey!==c.tenantKey||check.challenge.transactionId!==String(o._id)||check.challenge.actionType!=="SALESPERSON_CANCEL"||S(check.challenge.recipientId)!==S(o.salespersonId))return fail(res,"Assigned Salesperson OTP incorrect",400);otpId=check.challenge.otpId;
  }else if(!admin(req.auth)&&!["ORDER_DESK","ORDER_PROCESSING_DESK"].includes(U(req.auth.role)))return fail(res,"Order Desk authorization required",403);
  const old=o.workflowStatus;o.cancellation={source,status:"APPROVED",reason,remarks:remarks||reason,requestedBy:req.auth.sub,requestedAt:new Date(),approvedBy:req.auth.sub,approvedAt:new Date(),customerOtpId:source==="SALESPERSON"?otpId:undefined,salespersonOtpId:source==="DELIVERY_BOY"?otpId:undefined,stockImageFileId:S(req.body.stockImageFileId),items:(req.body.items||[]).map(x=>({productId:x.productId,qty:N(x.qty)}))};
  await updateStatus(req,c,o,"CANCELLATION_IN_PROCESS",`${source} cancellation approved; stock returns pending`,"CANCELLATION_REQUESTED");
  if(!run&&await reverseReady(c,o))return ok(res,{order:o,creditNote:await finalize(req,c,o)},"Order cancelled; Credit Note posted if invoiced");
  return ok(res,{order:o},"Cancellation in process; complete warehouse handover and reverse transfers");
}catch(e){return raised(e,res)}});
router.post("/phase2/cancellation/:id/approve-customer",async(req,res)=>{try{const c=await ctx(req),o=await record(c,req.params.id);if(U(o.workflowStatus)!=="CANCELLATION_IN_PROCESS"||U(o.cancellation?.source)!=="CUSTOMER")return fail(res,"Not a customer cancellation request",409);if(!admin(req.auth)&&S(o.salespersonId)!==S(req.auth.sub))return fail(res,"Only assigned Salesperson can confirm customer contact",403);if(req.body.customerContacted!==true||!S(req.body.remarks))return fail(res,"Confirm customer contact and record remarks",400);o.cancellation.status="APPROVED";o.cancellation.remarks=S(req.body.remarks);o.cancellation.salespersonContactedAt=new Date();o.cancellation.approvedBy=req.auth.sub;o.cancellation.approvedAt=new Date();await o.save();if(!o.deliveryRunId&&await reverseReady(c,o))return ok(res,{order:o,creditNote:await finalize(req,c,o)},"Cancellation completed");return ok(res,o,"Approved; physical return or reverse transfers required");}catch(e){return raised(e,res)}});
router.post("/phase2/cancellation/:id/finalize",async(req,res)=>{try{if(!staff(req.auth)&&U(req.auth.role)!=="WAREHOUSE")return fail(res,"Not authorized",403);const c=await ctx(req),o=await record(c,req.params.id);if(U(req.auth.role)==="WAREHOUSE"&&S(req.auth.warehouseId)!==S(o.mainWarehouseId))return fail(res,"Only Main Warehouse can close stock returns",403);return ok(res,{order:o,creditNote:await finalize(req,c,o)},"Order cancellation finalized and Credit Note posted");}catch(e){return raised(e,res)}});
router.post("/phase2/handovers/:id/otp",async(req,res)=>{try{if(U(req.auth.role)!=="WAREHOUSE"&&!admin(req.auth))return fail(res,"Warehouse login required",403);const c=await ctx(req),o=await record(c,req.params.id);if(U(req.auth.role)==="WAREHOUSE"&&S(req.auth.warehouseId)!==S(o.mainWarehouseId))return fail(res,"Only Main Warehouse can receive",403);if(U(o.workflowStatus)!=="CANCELLATION_IN_PROCESS"||!o.deliveryRunId)return fail(res,"No pending Delivery Boy handover",409);const otp=await createOtp({tenantKey:c.tenantKey,transactionId:String(o._id),actionType:"WAREHOUSE_RETURN",recipientId:S(o.mainWarehouseId)});o.handover={...(o.handover?.toObject?.()||o.handover||{}),status:"AWAITING_DELIVERY_BOY",otpId:otp.otpId,requestedAt:new Date(),requestedBy:req.auth.sub};await o.save();return ok(res,{otp:otp.code,otpId:otp.otpId,expiresAt:otp.expiresAt},"Give this code to the Delivery Boy at physical handover");}catch(e){return raised(e,res)}});
router.post("/phase2/handovers/:id/offer",async(req,res)=>{try{const c=await ctx(req),o=await record(c,req.params.id),run=await runFor(c,o);if(!run||!ownership(req.auth,run))return fail(res,"Only assigned Delivery Boy can offer return",403);if(U(o.workflowStatus)!=="CANCELLATION_IN_PROCESS"||U(o.cancellation?.status)!=="APPROVED")return fail(res,"Cancellation not approved",409);if(U(o.handover?.status)!=="AWAITING_DELIVERY_BOY")return fail(res,"Main Warehouse must generate a handover OTP",409);const rows=Array.isArray(req.body.items)?req.body.items:[];if(rows.length!==(o.items||[]).length)return fail(res,"All products must be handed over",400);for(const it of o.items||[]){const row=rows.find(x=>S(x.productId)===S(it.productId));if(!row||N(row.qty)!==N(it.invoicedQty||it.packedQty||it.qty)||!(N(row.packageCount)>0)||!(N(row.weight)>0))return fail(res,`Product-wise quantities, packages and weight required for ${it.nameSnapshot}`,400)}const check=await verifyOtp({otpId:S(o.handover.otpId),code:S(req.body.code)});if(!check.ok||check.challenge.tenantKey!==c.tenantKey||check.challenge.transactionId!==String(o._id)||check.challenge.actionType!=="WAREHOUSE_RETURN"||S(check.challenge.recipientId)!==S(o.mainWarehouseId))return fail(res,"Main Warehouse OTP incorrect",400);o.handover.status="OFFERED";o.handover.offeredAt=new Date();o.handover.items=rows.map(x=>({productId:S(x.productId),qty:N(x.qty),packageCount:N(x.packageCount),weight:N(x.weight)}));await o.save();await event(req,c,o,"HANDOVER_OFFERED","Delivery Boy presented items to Main Warehouse");return ok(res,o,"Await Main Warehouse physical receipt confirmation");}catch(e){return raised(e,res)}});
router.get("/phase2/handovers",async(req,res)=>{try{if(U(req.auth.role)!=="WAREHOUSE"&&!admin(req.auth))return fail(res,"Warehouse login required",403);const c=await ctx(req),query={tenantKey:c.tenantKey,financialYear:c.fy,workflowStatus:"CANCELLATION_IN_PROCESS",deliveryRunId:{$exists:true,$ne:""}};if(U(req.auth.role)==="WAREHOUSE")query.mainWarehouseId=S(req.auth.warehouseId);const items=await c.models.SalesOrder.find(query).sort({updatedAt:-1}).limit(100).lean();return ok(res,{items})}catch(e){return raised(e,res)}});
router.post("/phase2/handovers/:id/receive",async(req,res)=>{try{if(U(req.auth.role)!=="WAREHOUSE"&&!admin(req.auth))return fail(res,"Warehouse required",403);const c=await ctx(req),o=await record(c,req.params.id);if(U(req.auth.role)==="WAREHOUSE"&&S(req.auth.warehouseId)!==S(o.mainWarehouseId))return fail(res,"Only Main Warehouse receives",403);if(U(o.handover?.status)!=="OFFERED")return fail(res,"Delivery Boy has not completed handover OTP and product details",409);const items=Array.isArray(req.body.items)?req.body.items:[];for(const x of o.handover.items||[]){const r=items.find(v=>S(v.productId)===S(x.productId));if(!r||N(r.qty)!==N(x.qty)||N(r.packageCount)!==N(x.packageCount)||Math.abs(N(r.weight)-N(x.weight))>0.001)return fail(res,"Warehouse quantities, package counts and weights must match Delivery Boy entries",409)}await settleCustody(req,c,o,"RETURN");o.handover.status="RECEIVED";o.handover.confirmedAt=new Date();o.handover.confirmedBy=req.auth.sub;await o.save();await event(req,c,o,"WAREHOUSE_RETURN_RECEIVED","Main Warehouse confirmed physical stock handover; inward recorded");return ok(res,o,"Main Warehouse inward confirmed; initiate reverse transfers if needed");}catch(e){return raised(e,res)}});
router.get("/phase2/reverse-transfers",async(req,res)=>{try{if(U(req.auth.role)!=="WAREHOUSE"&&!admin(req.auth))return fail(res,"Warehouse access required",403);const c=await ctx(req);const f={tenantKey:c.tenantKey,financialYear:c.fy,mode:"RETURN"};if(U(req.auth.role)==="WAREHOUSE")f.$or=[{fromWarehouseId:S(req.auth.warehouseId)},{toWarehouseId:S(req.auth.warehouseId)}];const items=await c.models.WarehouseTransfer.find(f).sort({createdAt:-1}).limit(200).lean();return ok(res,{items})}catch(e){return raised(e,res)}});
router.post("/phase2/reverse-transfers",async(req,res)=>{try{const c=await ctx(req),o=await record(c,S(req.body.orderId));if(U(o.workflowStatus)!=="CANCELLATION_IN_PROCESS"||U(o.cancellation?.status)!=="APPROVED")return fail(res,"An approved cancellation is required",409);if(o.deliveryRunId&&U(o.handover?.status)!=="RECEIVED")return fail(res,"Receive Delivery Boy handover first",409);if(U(req.auth.role)==="WAREHOUSE"&&S(req.auth.warehouseId)!==S(o.mainWarehouseId)||!admin(req.auth)&&U(req.auth.role)!=="WAREHOUSE")return fail(res,"Only Main Warehouse initiates reverse transfer",403);
  const destination=S(req.body.toWarehouseId);if(!destination||destination===S(o.mainWarehouseId))return fail(res,"Choose original warehouse",400);const rows=Array.isArray(req.body.items)?req.body.items:[];if(!rows.length)return fail(res,"Products required",400);for(const row of rows){const item=(o.items||[]).find(x=>S(x.productId)===S(row.productId)&&S(x.warehouseId)===destination);if(!item||N(row.qty)!==N(item.qty)||!(N(row.packageCount)>0)||!(N(row.weight)>0))return fail(res,"Return must match order-linked originating warehouse stock with product-wise packages and weight",400)}
  if(await c.models.WarehouseTransfer.exists({tenantKey:c.tenantKey,financialYear:c.fy,orderId:String(o._id),mode:"RETURN",toWarehouseId:destination,status:{$in:["REQUESTED","RECEIVED"]}}))return fail(res,"Return transfer already exists for this warehouse",409);
  const row=await c.models.WarehouseTransfer.create({tenantKey:c.tenantKey,financialYear:c.fy,transferNo:makeId("RTR"),orderId:String(o._id),orderNo:o.orderNo,fromWarehouseId:S(o.mainWarehouseId),toWarehouseId:destination,mode:"RETURN",status:"REQUESTED",items:rows.map(x=>({productId:S(x.productId),productName:(o.items||[]).find(i=>S(i.productId)===S(x.productId))?.nameSnapshot,qty:N(x.qty),packageCount:N(x.packageCount),weight:N(x.weight)})),requestedAt:new Date(),requestedBy:req.auth.sub});await event(req,c,o,"REVERSE_TRANSFER_REQUESTED",`Reverse transfer ${row.transferNo} to original warehouse`);return ok(res,row,"Reverse transfer initiated",201);
}catch(e){return raised(e,res)}});
router.post("/phase2/reverse-transfers/:id/receive",async(req,res)=>{try{const c=await ctx(req),t=await c.models.WarehouseTransfer.findOne({_id:req.params.id,tenantKey:c.tenantKey,financialYear:c.fy,mode:"RETURN"});if(!t)return fail(res,"Return transfer not found",404);if(U(req.auth.role)==="WAREHOUSE"&&S(req.auth.warehouseId)!==S(t.toWarehouseId)||!admin(req.auth)&&U(req.auth.role)!=="WAREHOUSE")return fail(res,"Only receiving warehouse can confirm",403);if(t.status!=="REQUESTED")return fail(res,"Already received",409);const order=await record(c,t.orderId);if(U(order.workflowStatus)!=="CANCELLATION_IN_PROCESS")return fail(res,"Order no longer cancelling",409);for(const item of t.items||[]){await c.models.StockMovement.create({tenantKey:c.tenantKey,financialYear:c.fy,date:new Date(),productId:item.productId,warehouseId:t.fromWarehouseId,type:"TRANSFER_OUT",qtyOut:item.qty,qtyIn:0,referenceId:t.transferNo});await c.models.StockMovement.create({tenantKey:c.tenantKey,financialYear:c.fy,date:new Date(),productId:item.productId,warehouseId:t.toWarehouseId,type:"TRANSFER_IN",qtyOut:0,qtyIn:item.qty,referenceId:t.transferNo});const oi=order.items.find(x=>S(x.productId)===S(item.productId));if(oi)oi.currentWarehouseId=S(t.toWarehouseId)}t.status="RECEIVED";t.receivedAt=new Date();t.receivedBy=req.auth.sub;await t.save();await order.save();await event(req,c,order,"REVERSE_TRANSFER_RECEIVED",`Return ${t.transferNo} confirmed`);return ok(res,{transfer:t,order},"Originating warehouse inward increased");}catch(e){return raised(e,res)}});
export default router;
