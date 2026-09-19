import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { Product, CustomerLink, CompanyProfile, CompanyUnit, Unit, GenericRecord, Transporter, GlobalTransporterStation, BankAccount, Branding } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { costBaseOf, historicalAverageRates, purchaseRateOf } from "../services/oldDmsPricingService.js";
import { financialModels, postBalancedEntries, customerReceivableBalance, reversePostedTransaction } from "../services/accountingService.js";
import { readRows, resolveColumns, valueFor, cleanText } from "../utils/bulkSpreadsheet.js";
import { requireAnyPermission } from "../middleware/permission.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { env } from "../config/env.js";
import { sendBusinessEmail } from "../services/mailService.js";
import { buildMasterSalesInvoicePdf } from "../services/masterInvoicePdfService.js";
import { readFile } from "../services/storageService.js";
import { resolveCustomerDeliveryMode, resolveFirmDeliveryLocation, gstTypeFromLocations } from "../services/deliveryLocalityService.js";
import { enrichTransactionRows, resolvePartyDisplayMap } from "../services/transactionDisplayService.js";

const router = express.Router();
router.use(requireAuth);
router.use((req,res,next)=>{if(req.auth?.role==="MASTER"||(req.auth?.apps||[]).includes("dms"))return next();return fail(res,"DMS access required",403);});

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:30*1024*1024}});
const upper=v=>cleanText(v).toUpperCase();

const salesInvoiceForAuth=(invoice,auth)=>{
  if(!invoice||isAdminAuth(auth))return invoice;
  const row=typeof invoice?.toObject==="function"?invoice.toObject():{...invoice};
  delete row.grossProfit;
  delete row.grossMarginPct;
  row.items=(row.items||[]).map(item=>{const next={...item};delete next.profitPct;delete next.marginColor;return next;});
  return row;
};

async function customerTransportSnapshot({tenantKey,customer}){
  const locality=await resolveCustomerDeliveryMode({tenantKey,customer});
  if(!locality.requiresTransport)return {mode:"LOCAL",firmCitySnapshot:locality.firmCity,customerCitySnapshot:locality.customerCity,serviceAreaSnapshot:cleanText(customer?.serviceArea||locality.customerCity||"")};
  const globalId=cleanText(customer?.assignedTransportGlobalId),localId=cleanText(customer?.assignedTransport),deliveryId=cleanText(customer?.assignedTransportDeliveryStationId),bookingId=cleanText(customer?.assignedTransportBookingStationId);
  if(!globalId||!localId||!deliveryId)throw Object.assign(new Error(`${customer?.localName||"Customer"} is outside ${locality.firmCity} and has no complete transporter assignment. Edit Customer and assign a transporter/delivery station first.`),{statusCode:409});
  const [transporter,delivery,booking]=await Promise.all([
    Transporter.findOne({_id:localId,tenantKey,globalTransporterId:globalId,status:{$ne:"INACTIVE"}}).lean(),
    GlobalTransporterStation.findOne({stationId:deliveryId,globalTransporterId:globalId,status:"ACTIVE",stationType:{$in:["DELIVERY","BOTH"]}}).lean(),
    bookingId?GlobalTransporterStation.findOne({stationId:bookingId,globalTransporterId:globalId,status:"ACTIVE",stationType:{$in:["BOOKING","BOTH"]}}).lean():Promise.resolve(null),
  ]);
  if(!transporter||!delivery)throw Object.assign(new Error(`${customer?.localName||"Customer"} transporter assignment is no longer active. Reassign it in Customer Master.`),{statusCode:409});
  return {
    mode:"OUTSIDE",firmCitySnapshot:locality.firmCity,customerCitySnapshot:locality.customerCity,transporterId:String(transporter._id),globalTransporterId:globalId,transporterNameSnapshot:cleanText(transporter.name),
    bookingStationId:booking?.stationId||"",bookingStationNameSnapshot:booking?.name||"",bookingStationAddressSnapshot:booking?.address||"",bookingStationCitySnapshot:booking?.city||"",bookingStationPincodeSnapshot:booking?.pincode||"",
    deliveryStationId:delivery.stationId,deliveryStationNameSnapshot:delivery.name||"",deliveryStationAddressSnapshot:delivery.address||"",deliveryStationCitySnapshot:delivery.city||"",deliveryStationPincodeSnapshot:delivery.pincode||"",serviceAreaSnapshot:cleanText(customer?.serviceArea||delivery.name||delivery.city||locality.customerCity),
  };
}

function billLevelTaxSummary(items=[],billDiscount=0,otherCharges=0){
  const groups=new Map();let subtotal=0,maxGst=0;
  for(const item of items||[]){
    const taxable=Math.max(0,Number(item?.taxable||0)),rate=Math.max(0,Number(item?.gstRateSnapshot||0)),hsn=String(item?.hsnSnapshot||"NA"),key=`${hsn}|${rate}`;
    const group=groups.get(key)||{taxable:0,rate};group.taxable+=taxable;groups.set(key,group);subtotal+=taxable;maxGst=Math.max(maxGst,rate);
  }
  subtotal=round2(subtotal);
  const discount=Math.min(subtotal,Math.max(0,Number(billDiscount||0))),discountedBase=round2(Math.max(0,subtotal-discount)),charges=Math.max(0,Number(otherCharges||0));
  let itemTaxTotal=0;
  for(const group of groups.values()){
    const share=subtotal>0?group.taxable/subtotal:0;
    const adjustedTaxable=round2(Math.max(0,group.taxable-discount*share));
    itemTaxTotal+=round2(adjustedTaxable*group.rate/100);
  }
  itemTaxTotal=round2(itemTaxTotal);
  const chargesTax=round2(charges*maxGst/100),taxableTotal=round2(discountedBase+charges),taxTotal=round2(itemTaxTotal+chargesTax);
  return {subtotal,discount,charges,discountedBase,maxGst,itemTaxTotal,chargesTax,taxableTotal,taxTotal};
}

async function resolveReceiptCustomer(tenantKey,value){
  const key=cleanText(value);if(!key)return null;
  return CustomerLink.findOne({tenantKey,$or:[{globalCustomerId:key},{displayIdentifier:upper(key)}],status:"ACTIVE"}).lean();
}

async function resolvePostingParty(tenantKey,globalCustomerId){
  const id=cleanText(globalCustomerId);if(!id)return null;
  return CustomerLink.findOne({tenantKey,globalCustomerId:id,status:"ACTIVE"}).lean();
}

function partyAccountCodeOf(party){
  const configured=cleanText(party?.accountingProfile?.systemAccountCode);
  if(configured)return configured;
  return ["CREDITOR","SUPPLIER"].includes(upper(party?.partyType))?"SYS_SUNDRY_CREDITORS":"SYS_SUNDRY_DEBTORS";
}

async function resolveTransactionBank(tenantKey,mode,bankAccountId){
  if(upper(mode)==="CASH")return {accountCode:"SYS_CASH",ledgerId:"",bankAccountId:"",bankName:"Cash"};
  let bank=null;
  if(cleanText(bankAccountId))bank=await BankAccount.findOne({tenantKey,$or:[{_id:bankAccountId},{bankAccountId:cleanText(bankAccountId)}],status:"ACTIVE"}).lean();
  if(!bank)bank=await BankAccount.findOne({tenantKey,status:"ACTIVE",isPrimary:true}).lean();
  if(!bank){const count=await BankAccount.countDocuments({tenantKey,status:"ACTIVE"});if(count===1)bank=await BankAccount.findOne({tenantKey,status:"ACTIVE"}).lean();}
  if(!bank)throw Object.assign(new Error("Select an active Bank Account for non-cash transaction"),{statusCode:400});
  return {accountCode:["OD","CC"].includes(upper(bank.accountType))?"SYS_BANK_OD":"SYS_BANK_ACCOUNT",ledgerId:bank.ledgerId||"",bankAccountId:bank.bankAccountId,bankName:bank.bankName};
}

router.post("/:type/bulk-upload",upload.single("file"),async(req,res,next)=>{
  try{
    const type=req.params.type;if(!["receipts","payments","expenses"].includes(type))return next();
    if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);
    let rows;try{rows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read Excel/CSV file",400);}if(!rows.length)return fail(res,"Uploaded file has no rows",400);
    const fy=req.body.financialYear||"2026-27";
    const common=[{key:"date",label:"Date",type:"date"},{key:"amount",label:"Amount",type:"number",required:true},{key:"reference",label:"Reference"}];
    const fields=type==="receipts"?[{key:"receiptNo",label:"Receipt No.",aliases:["voucher no","voucher"]},{key:"customer",label:"Customer ID / GSTIN / PAN",aliases:["customer","party","gstin","pan"],required:true},...common,{key:"mode",label:"Mode"},{key:"bounceStatus",label:"Bounce Status"}]
      :type==="payments"?[{key:"paymentNo",label:"Payment No.",aliases:["voucher no","voucher"]},{key:"partyGlobalId",label:"Party / Supplier ID",aliases:["party","supplier"],required:true},...common,{key:"mode",label:"Mode"}]
      :[{key:"expenseNo",label:"Expense No.",aliases:["voucher no","voucher"]},{key:"accountCode",label:"Expense Account",aliases:["account","account code"],required:true},...common,{key:"paymentMode",label:"Payment Mode"},{key:"nature",label:"Nature"},{key:"allocationMethod",label:"Allocation Method",aliases:["allocation"]},{key:"narration",label:"Narration"}];
    const cols=resolveColumns(rows[0],fields);const missing=fields.filter(f=>f.required&&!cols[f.key]).map(f=>f.label);if(missing.length)return fail(res,`Missing column(s): ${missing.join(", ")}`,400);
    const errors=[];let inserted=0,duplicates=0;
    const models=financialModels(req.auth.tenantKey,fy);
    for(let i=0;i<rows.length;i++){
      const body={financialYear:fy};for(const f of fields){const v=valueFor(rows[i],cols[f.key],f.type);if(v!==undefined&&v!=="")body[f.key]=v;}
      const amount=Number(body.amount||0);if(amount<=0){if(errors.length<100)errors.push({row:i+2,error:"Amount must be greater than zero"});continue;}
      try{
        if(type==="receipts"){
          const customer=await resolveReceiptCustomer(req.auth.tenantKey,body.customer);if(!customer){if(errors.length<100)errors.push({row:i+2,error:`Customer not found: ${body.customer||""}`});continue;}
          const receiptNo=cleanText(body.receiptNo)||makeId("RCT");if(await models.Receipt.exists({tenantKey:req.auth.tenantKey,financialYear:fy,receiptNo})){duplicates++;continue;}
          const date=body.date?new Date(body.date):new Date(),mode=upper(body.mode||"BANK");
          await models.Receipt.create({tenantKey:req.auth.tenantKey,financialYear:fy,receiptNo,date,customerGlobalId:customer.globalCustomerId,partyNameSnapshot:customer.localName||customer.displayIdentifier||body.customer||"Customer",amount,mode,reference:body.reference||"",bounceStatus:upper(body.bounceStatus||"CLEAR"),createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||"",status:"POSTED"});
          await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear:fy,transactionId:receiptNo,transactionType:"RECEIPT",date,partyGlobalId:customer.globalCustomerId,narration:`Receipt ${receiptNo}`,entries:[{accountCode:mode==="CASH"?"SYS_CASH":"SYS_BANK_ACCOUNT",debit:amount},{accountCode:"SYS_SUNDRY_DEBTORS",credit:amount}]});
        }else if(type==="payments"){
          const paymentNo=cleanText(body.paymentNo)||makeId("PAY");if(await models.Payment.exists({tenantKey:req.auth.tenantKey,financialYear:fy,paymentNo})){duplicates++;continue;}
          const date=body.date?new Date(body.date):new Date(),mode=upper(body.mode||"BANK"),party=cleanText(body.partyGlobalId);
          const partyMap=await resolvePartyDisplayMap(req.auth.tenantKey,[party]);
          const partyName=partyMap.get(party)?.name||party||"Party";
          await models.Payment.create({tenantKey:req.auth.tenantKey,financialYear:fy,paymentNo,date,partyGlobalId:party,partyNameSnapshot:partyName,amount,mode,reference:body.reference||"",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||"",status:"POSTED"});
          await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear:fy,transactionId:paymentNo,transactionType:"PAYMENT",date,partyGlobalId:party,narration:`Payment ${paymentNo}`,entries:[{accountCode:"SYS_SUNDRY_CREDITORS",debit:amount},{accountCode:mode==="CASH"?"SYS_CASH":"SYS_BANK_ACCOUNT",credit:amount}]});
        }else{
          const expenseNo=cleanText(body.expenseNo)||makeId("EXP");if(await models.Expense.exists({tenantKey:req.auth.tenantKey,financialYear:fy,expenseNo})){duplicates++;continue;}
          const date=body.date?new Date(body.date):new Date(),paymentMode=upper(body.paymentMode||"BANK");
          await models.Expense.create({tenantKey:req.auth.tenantKey,financialYear:fy,expenseNo,date,accountCode:body.accountCode,amount,nature:upper(body.nature||"FIXED"),allocationMethod:upper(body.allocationMethod||"TURNOVER"),status:"POSTED"});
          await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear:fy,transactionId:expenseNo,transactionType:"EXPENSE",date,narration:body.narration||`Expense ${expenseNo}`,entries:[{accountCode:body.accountCode,debit:amount},{accountCode:paymentMode==="BANK"?"SYS_BANK_ACCOUNT":"SYS_CASH",credit:amount}]});
        }
        inserted++;
      }catch(e){if(errors.length<100)errors.push({row:i+2,error:e.message});}
    }
    return ok(res,{received:rows.length,inserted,duplicates,invalid:errors.length,errors},`${inserted} ${type} imported`);
  }catch(e){next(e);}
});

router.post("/:type/bulk-edit",async(req,res,next)=>{
  const type=req.params.type;if(!["receipts","payments","expenses"].includes(type))return next();
  const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select at least one record",400);
  const fy=req.body.financialYear||"2026-27",models=financialModels(req.auth.tenantKey,fy),raw=req.body.changes||{};
  const Model=type==="receipts"?models.Receipt:type==="payments"?models.Payment:models.Expense;
  const allowed=type==="receipts"?["reference","bounceStatus"]:type==="payments"?["reference"]:["nature","allocationMethod"];
  const changes={};for(const k of allowed)if(raw[k]!==undefined&&raw[k]!=="")changes[k]=k==="reference"?cleanText(raw[k]):upper(raw[k]);
  if(!Object.keys(changes).length)return fail(res,`For posted ${type}, bulk edit is limited to ${allowed.join(", ")}. Amount/account/mode changes must be cancelled and reposted.`,400);
  const result=await Model.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey,financialYear:fy,status:"POSTED"},{$set:changes});
  return ok(res,{matched:result.matchedCount,updated:result.modifiedCount},`${result.modifiedCount} ${type} updated`);
});

router.post("/:type/bulk-delete",async(req,res,next)=>{
  const type=req.params.type;if(!["receipts","payments","expenses"].includes(type))return next();
  const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select at least one record",400);
  const fy=req.body.financialYear||"2026-27",models=financialModels(req.auth.tenantKey,fy),Model=type==="receipts"?models.Receipt:type==="payments"?models.Payment:models.Expense;
  const docs=await Model.find({_id:{$in:ids},tenantKey:req.auth.tenantKey,financialYear:fy,status:"POSTED"});let cancelled=0;
  for(const doc of docs){const transactionId=type==="receipts"?doc.receiptNo:type==="payments"?doc.paymentNo:doc.expenseNo;if(!transactionId)continue;await reversePostedTransaction({tenantKey:req.auth.tenantKey,financialYear:fy,transactionId,reason:`Bulk cancelled ${type.slice(0,-1)}`});doc.status="CANCELLED";await doc.save();cancelled++;}
  return ok(res,{deleted:cancelled,reversed:true},`${cancelled} ${type} cancelled and reversed`);
});

const floor2=n=>Math.floor((Number(n)||0)*100)/100;
const ceil2=n=>Math.ceil((Number(n)||0)*100)/100;
const round2=n=>Number((Number(n)||0).toFixed(2));
const saleFromMrpByGrade=(mrp,gradePct)=>floor2(Number(mrp||0)/(1+Number(gradePct||0)/100));
const basicFromSaleGst=(sale,gstPct)=>ceil2(Number(sale||0)/(1+Number(gstPct||0)/100));

async function resolvedProductRate({customer,product,row}){
  const gradePct=Number(row.gradeDiscountPct ?? customer.gradeDiscountPct ?? 0);
  let saleRate=Number(row.saleRate ?? 0);
  if(!saleRate)saleRate=saleFromMrpByGrade(product.mrp||product.salePrice||0,gradePct);
  return {saleRate,gradeDiscountPct:gradePct};
}

function formatSalesInvoiceNumber(prefix, serial, suffix){
  return [cleanText(prefix), String(serial), cleanText(suffix)].filter(Boolean).join("-");
}

async function salesInvoiceSeries(tenantKey,{consume=false}={}){
  let company=await CompanyProfile.findOne({tenantKey});
  if(!company)throw Object.assign(new Error("Company profile not found"),{statusCode:404});
  const prefix=cleanText(company.salesInvoicePrefix),suffix=cleanText(company.salesInvoiceSuffix);
  const start=Math.max(1,Math.trunc(Number(company.salesInvoiceStartingNumber||1)));
  if(!prefix||!suffix){
    throw Object.assign(new Error("Complete Sales Invoice Prefix, Starting Number and Suffix in Super Admin Profile before creating invoices"),{statusCode:409});
  }
  if(!company.salesInvoiceNextNumber||Number(company.salesInvoiceNextNumber)<start){
    await CompanyProfile.updateOne(
      {tenantKey,$or:[{salesInvoiceNextNumber:{$exists:false}},{salesInvoiceNextNumber:null},{salesInvoiceNextNumber:{$lt:start}}]},
      {$set:{salesInvoiceNextNumber:start}},
    );
    company=await CompanyProfile.findOne({tenantKey});
  }
  if(!consume){
    const serial=Math.max(start,Math.trunc(Number(company.salesInvoiceNextNumber||start)));
    return {invoiceNo:formatSalesInvoiceNumber(prefix,serial,suffix),serial,prefix,suffix,startingNumber:start};
  }
  const before=await CompanyProfile.findOneAndUpdate(
    {tenantKey},
    {$inc:{salesInvoiceNextNumber:1}},
    {new:false},
  );
  const serial=Math.max(start,Math.trunc(Number(before?.salesInvoiceNextNumber||start)));
  return {invoiceNo:formatSalesInvoiceNumber(prefix,serial,suffix),serial,prefix,suffix,startingNumber:start};
}

function applySalesInvoiceScope(filter,auth){
  if(auth?.role==="MASTER"||auth?.role==="SUPERADMIN")return filter;
  if(auth?.dataScope==="WAREHOUSE"){
    if(!auth?.warehouseId){filter._id="__NO_ACCESS__";return filter;}
    filter.warehouseId=auth.warehouseId;
    filter.workflowStatus={$in:["RELEASED_TO_WAREHOUSE","PICKING","PACKED","READY_FOR_DISPATCH"]};
  }else if(auth?.dataScope==="ASSIGNED"){
    filter.$or=[{assignedTo:auth.sub},{createdBy:auth.sub}];
  }else if(auth?.dataScope==="SELF"){
    filter.createdBy=auth.sub;
  }else if(auth?.dataScope==="BRANCH"&&auth?.branch){
    filter.branchId=auth.branch;
  }
  return filter;
}

async function calculateSalesInvoice({auth,body,existingInvoice=null}){
  const tenantKey=auth.tenantKey,financialYear=body.financialYear||existingInvoice?.financialYear||"2026-27";
  const customer=await CustomerLink.findOne({tenantKey,globalCustomerId:body.customerGlobalId,status:"ACTIVE"}).lean();
  if(!customer)throw Object.assign(new Error("Active approved customer is required"),{statusCode:400});
  const transportAssignment=await customerTransportSnapshot({tenantKey,customer});
  const firm=await resolveFirmDeliveryLocation(tenantKey);
  const customerGstin=customer.displayIdentifier?.length===15?customer.displayIdentifier:"";
  const customerAddress=(customer.addresses||[]).find(x=>upper(x.type||"BILLING")==="BILLING")||(customer.addresses||[])[0]||{};
  // Tax locality and delivery locality are intentionally separate:
  // GSTIN/state decides CGST+SGST vs IGST; city decides Local vs Transport.
  const gstType=gstTypeFromLocations({companyGstin:firm.company?.gstin,customerGstin,companyState:firm.state,customerState:customerAddress.state,requested:body.gstType});

  const warehouseId=cleanText(body.warehouseId||existingInvoice?.warehouseId);
  if(!warehouseId)throw Object.assign(new Error("Warehouse is mandatory for Sales Invoice"),{statusCode:400});
  const warehouse=await GenericRecord.findOne({_id:warehouseId,tenantKey,app:"dms",resource:"warehouses",status:"ACTIVE"}).lean();
  if(!warehouse)throw Object.assign(new Error("Select a valid active warehouse"),{statusCode:400});

  const requested=Array.isArray(body.items)?body.items:[];
  if(!requested.length)throw Object.assign(new Error("At least one product row is required"),{statusCode:400});
  const ids=Array.from(new Set(requested.map(x=>String(x.productId||"")).filter(Boolean)));
  const products=await Product.find({tenantKey,_id:{$in:ids},status:"ACTIVE"});
  const pm=new Map(products.map(p=>[String(p._id),p]));
  const packingCodes=Array.from(new Set(products.map(p=>upper(p.packingUnit)).filter(Boolean)));
  const companyUnits=packingCodes.length?await CompanyUnit.find({tenantKey,code:{$in:packingCodes}}).select("code name").lean():[];
  const packingNames=new Map(companyUnits.map(u=>[upper(u.code),cleanText(u.name)||u.code]));
  const missingPacking=packingCodes.filter(code=>!packingNames.has(code));
  if(missingPacking.length){const masterUnits=await Unit.find({code:{$in:missingPacking}}).select("code name").lean();for(const u of masterUnits)packingNames.set(upper(u.code),cleanText(u.name)||u.code);}
  let averages={sales:new Map(),purchases:new Map()};
  try{averages=await historicalAverageRates({tenantKey,financialYear,productIds:ids});}catch(e){console.error("sales invoice average purchase lookup failed",e?.message||e);}
  const oldQty=new Map();
  for(const item of existingInvoice?.items||[])oldQty.set(String(item.productId),Number(oldQty.get(String(item.productId))||0)+Number(item.qty||0));

  const items=[];let lineSubtotal=0,taxTotal=0,grossProfit=0;
  for(const row of requested){
    const p=pm.get(String(row.productId));if(!p)throw Object.assign(new Error(`Product not found: ${row.productId}`),{statusCode:400});
    const qty=Number(row.qty||0);if(qty<=0)throw Object.assign(new Error(`Invalid quantity for ${p.name}`),{statusCode:400});
    const available=Number(p.currentStock||0)+Number(oldQty.get(String(p._id))||0);
    if(available<qty&&!body.allowNegativeStock)throw Object.assign(new Error(`${p.name}: only ${available} ${p.basicUnit||p.unit||"PCS"} available`),{statusCode:409});
    const {saleRate,gradeDiscountPct}=await resolvedProductRate({customer,product:p,row});
    const gstRate=Number(row.gstRate??p.gstRate??0),basicRate=Number(row.basicRate||basicFromSaleGst(saleRate,gstRate)),itemDiscountPct=Number(row.discountPct||0);
    const effectiveRate=round2(basicRate*(1-itemDiscountPct/100));
    const avgPurchase=Number(averages.purchases.get(String(p._id))?.averageRate||0);
    const purchaseCost=avgPurchase>0?avgPurchase:purchaseRateOf(p);
    const taxable=round2(effectiveRate*qty),tax=round2(taxable*gstRate/100),cgst=gstType==="IGST"?0:round2(tax/2),sgst=gstType==="IGST"?0:round2(tax/2),igst=gstType==="IGST"?tax:0;
    lineSubtotal+=taxable;taxTotal+=tax;grossProfit+=round2((effectiveRate-purchaseCost)*qty);
    items.push({productId:String(p._id),sku:p.sku,nameSnapshot:p.name,hsnSnapshot:p.hsnCode,qty,unit:p.basicUnit||p.unit,packingUnit:(p.packingUnit?packingNames.get(upper(p.packingUnit))||p.packingUnit:""),qtyInBag:Number(p.qtyInBag||1),grossQty:Number(p.qtyInBag||0)>0?round2(qty/Number(p.qtyInBag||1)):qty,mrpSnapshot:Number(row.mrp||p.mrp||0),gradeDiscountPct,landedCostSnapshot:Number(purchaseCost||0),averagePurchasePriceSnapshot:Number(avgPurchase||p.averagePurchasePrice||0),rate:saleRate,discountPct:itemDiscountPct,effectiveRate,taxable,gstRateSnapshot:gstRate,cgst,sgst,igst,tax,lineTotal:round2(taxable+tax),profitPct:purchaseCost>0?round2((effectiveRate-purchaseCost)/purchaseCost*100):0,marginColor:effectiveRate<purchaseCost?"RED":"GREEN"});
  }
  const billDiscount=Number(body.billDiscount||0),otherCharges=Number(body.otherCharges||0);
  const billTax=billLevelTaxSummary(items,billDiscount,otherCharges);

  // Billing must never go below purchase cost. The item stays selectable/editable;
  // only posting is rejected. Bill-level discounts are proportionately applied
  // before the final comparison so a discount cannot silently push a line below cost.
  const discountFactor=billTax.subtotal>0?Math.max(0,(billTax.subtotal-billTax.discount)/billTax.subtotal):1;
  const belowPurchase=[];
  for(const item of items){
    const finalBillingRate=round2(Number(item.effectiveRate||0)*discountFactor);
    const purchaseCost=Number(item.landedCostSnapshot||0);
    if(purchaseCost>0&&finalBillingRate+0.005<purchaseCost){
      belowPurchase.push({productId:item.productId,product:item.nameSnapshot,billingRate:finalBillingRate,purchaseRate:round2(purchaseCost)});
    }
  }
  if(belowPurchase.length){
    const first=belowPurchase[0];
    throw Object.assign(new Error(`${first.product}: billing price ₹${first.billingRate.toFixed(2)} is below purchase price ₹${first.purchaseRate.toFixed(2)}. Increase the billing rate or reduce discount.`),{statusCode:409,details:{belowPurchase}});
  }

  const taxableTotal=billTax.taxableTotal;taxTotal=billTax.taxTotal;
  const beforeRound=round2(taxableTotal+taxTotal),grandTotal=body.roundGrandTotal===false?beforeRound:Math.round(beforeRound),roundOff=round2(grandTotal-beforeRound);
  if(customer.paymentType==="CREDIT"&&customer.creditLimit>0&&!body.creditOverrideApproved){
    const balance=await customerReceivableBalance({tenantKey,financialYear,customerGlobalId:customer.globalCustomerId});
    const adjustedBalance=balance-Number(existingInvoice?.grandTotal||0);
    if(adjustedBalance+grandTotal>customer.creditLimit)throw Object.assign(new Error("Customer credit limit would be exceeded"),{statusCode:409,details:{currentOutstanding:adjustedBalance,newOrder:grandTotal,creditLimit:customer.creditLimit}});
  }
  return {tenantKey,financialYear,customer,transportAssignment,gstType,warehouse,warehouseId,items,lineSubtotal,taxTotal,grossProfit,taxableTotal,grandTotal,roundOff,date:body.date?new Date(body.date):new Date()};
}

async function postSalesAccounting({tenantKey,financialYear,invoiceNo,date,customer,grandTotal,taxableTotal,taxTotal,roundOff}){
  await postBalancedEntries({tenantKey,financialYear,transactionId:invoiceNo,transactionType:"SALES_INVOICE",date,partyGlobalId:customer.globalCustomerId,narration:`Sales Invoice ${invoiceNo}`,entries:[{accountCode:"SYS_SUNDRY_DEBTORS",debit:grandTotal},{accountCode:"SYS_SALES",credit:taxableTotal},{accountCode:"SYS_DUTIES_TAXES",credit:taxTotal},{accountCode:roundOff>=0?"SYS_INDIRECT_INCOME":"SYS_INDIRECT_EXPENSE",credit:roundOff>0?roundOff:0,debit:roundOff<0?Math.abs(roundOff):0}].filter(x=>Number(x.debit||0)||Number(x.credit||0))});
}

function normalizedEInvoice(body = {}, existing = {}) {
  const source = body?.eInvoice && typeof body.eInvoice === "object" ? body.eInvoice : {};
  const previous = existing && typeof existing === "object" ? existing : {};
  const rawStatus = upper(source.status ?? previous.status ?? "NOT_GENERATED");
  const allowed = new Set(["NOT_GENERATED", "PENDING", "GENERATED", "CANCELLED"]);
  const status = allowed.has(rawStatus) ? rawStatus : "NOT_GENERATED";
  const ackDateRaw = cleanText(source.ackDate ?? previous.ackDate ?? "");
  let ackDate;
  if (ackDateRaw) {
    const parsed = new Date(ackDateRaw);
    if (!Number.isNaN(parsed.getTime())) ackDate = parsed;
  }
  return {
    status,
    irn: cleanText(source.irn ?? previous.irn ?? ""),
    ackNo: cleanText(source.ackNo ?? previous.ackNo ?? ""),
    ackDate,
    signedQrPayload: cleanText(source.signedQrPayload ?? previous.signedQrPayload ?? ""),
  };
}

router.get("/sales-invoices/next-number",async(req,res)=>{
  try{return ok(res,await salesInvoiceSeries(req.auth.tenantKey));}catch(e){return fail(res,e.message,e.statusCode||400);}
});

router.get("/sales-invoices", async (req, res) => {
  const financialYear = req.query.financialYear || "2026-27";
  const { SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
  const page = Number(req.query.page || 1), limit = Math.min(100, Number(req.query.limit || 25));
  const filter = applySalesInvoiceScope({ tenantKey: req.auth.tenantKey, financialYear }, req.auth);
  if(req.query.includeDeleted!=="true")filter.status={$nin:["DELETED","CANCELLED"]};
  let [items,total] = await Promise.all([
    SalesInvoice.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SalesInvoice.countDocuments(filter)
  ]);
  if(req.auth?.dataScope === "WAREHOUSE"){
    items=items.map(invoice=>({...invoice,items:(invoice.items||[]).map(item=>({...item,landedCostSnapshot:undefined,averagePurchasePriceSnapshot:undefined}))}));
  }
  items=await enrichTransactionRows({tenantKey:req.auth.tenantKey,rows:items,partyIdKey:"customerGlobalId",partySnapshotKey:"customerNameSnapshot"});
  items=items.map(invoice=>salesInvoiceForAuth(invoice,req.auth));
  ok(res, { items, meta: pageMeta(page, limit, total) });
});

router.get("/sales-invoices/:id",async(req,res)=>{
  const financialYear=req.query.financialYear||"2026-27",{SalesInvoice}=financialModels(req.auth.tenantKey,financialYear);
  const filter=applySalesInvoiceScope({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear},req.auth);
  const invoice=await SalesInvoice.findOne(filter).lean();
  if(!invoice)return fail(res,"Sales invoice not found",404);
  const [enriched]=await enrichTransactionRows({tenantKey:req.auth.tenantKey,rows:[invoice],partyIdKey:"customerGlobalId",partySnapshotKey:"customerNameSnapshot"});
  return ok(res,salesInvoiceForAuth(enriched,req.auth));
});

router.get("/sales-invoices/:id/pdf", async (req, res) => {
  try {
    const financialYear = req.query.financialYear || "2026-27";
    const { SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
    const filter = applySalesInvoiceScope({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear }, req.auth);
    const invoice = await SalesInvoice.findOne(filter).lean();
    if (!invoice) return fail(res, "Sales invoice not found", 404);
    const pdf = await buildInvoicePdfBuffer({ tenantKey: req.auth.tenantKey, financialYear, invoice });
    const fileName = safeFilePart(`Invoice-${invoice.invoiceNo || req.params.id}.pdf`);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="${fileName}"`);
    return res.send(pdf);
  } catch (error) {
    return fail(res, error.message || "Could not generate invoice PDF", 500);
  }
});

router.post("/sales-invoices", async (req, res) => {
  try{
    const calc=await calculateSalesInvoice({auth:req.auth,body:req.body});
    const importSource=upper(req.body.importSource||"");
    const preserveRequestedInvoiceNo=new Set(["SCAN_FILL","QUICK_ENTRY"]).has(importSource);
    const requestedInvoiceNo=cleanText(req.body.invoiceNo||"");
    const series=preserveRequestedInvoiceNo&&requestedInvoiceNo?{invoiceNo:requestedInvoiceNo}:await salesInvoiceSeries(req.auth.tenantKey,{consume:true});
    const {SalesInvoice,StockMovement}=financialModels(calc.tenantKey,calc.financialYear);
    if(await SalesInvoice.exists({tenantKey:calc.tenantKey,financialYear:calc.financialYear,invoiceNo:series.invoiceNo}))return fail(res,preserveRequestedInvoiceNo?`Sales invoice ${series.invoiceNo} already exists in FY ${calc.financialYear}`:"Generated invoice number already exists. Update the series in Super Admin Profile.",409);
    const invoice=await SalesInvoice.create({tenantKey:calc.tenantKey,financialYear:calc.financialYear,invoiceNo:series.invoiceNo,date:calc.date,customerGlobalId:calc.customer.globalCustomerId,customerNameSnapshot:calc.customer.localName||calc.customer.displayIdentifier||"Customer",gstinSnapshot:calc.customer.displayIdentifier?.length===15?calc.customer.displayIdentifier:"",addressSnapshot:req.body.addressSnapshot||calc.customer.addresses?.[0]?.address||"",items:calc.items,subtotal:calc.lineSubtotal,billDiscount:Number(req.body.billDiscount||0),otherCharges:Number(req.body.otherCharges||0),taxableTotal:calc.taxableTotal,taxTotal:calc.taxTotal,roundOff:calc.roundOff,grandTotal:calc.grandTotal,grossProfit:calc.grossProfit,grossMarginPct:calc.taxableTotal?calc.grossProfit/calc.taxableTotal*100:0,orderNo:req.body.orderNo,arn:req.body.arn,noOfPackages:Number(req.body.noOfPackages||0),deliveryBoy:req.body.deliveryBoy,gstType:calc.gstType,remarks:req.body.remarks,eInvoice:normalizedEInvoice(req.body),transportAssignment:calc.transportAssignment,branchId:req.body.branchId||req.auth.branch||"",warehouseId:calc.warehouseId,warehouseNameSnapshot:calc.warehouse.title||calc.warehouse.reference||"",assignedTo:req.body.assignedTo||"",workflowStatus:req.body.workflowStatus||"POSTED",releasedToWarehouseAt:req.body.workflowStatus==="RELEASED_TO_WAREHOUSE"?new Date():undefined,status:"POSTED",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
    for(const it of calc.items){await Product.updateOne({_id:it.productId,tenantKey:calc.tenantKey},{$inc:{currentStock:-it.qty}});await StockMovement.create({tenantKey:calc.tenantKey,financialYear:calc.financialYear,date:calc.date,productId:it.productId,warehouseId:calc.warehouseId,type:"SALE",qtyIn:0,qtyOut:it.qty,landedCost:it.landedCostSnapshot,referenceId:series.invoiceNo});}
    await postSalesAccounting({...calc,invoiceNo:series.invoiceNo});
    return ok(res,salesInvoiceForAuth(invoice,req.auth),"Sales invoice posted",201);
  }catch(e){return fail(res,e.message,e.statusCode||400,e.details);}
});

router.put("/sales-invoices/:id",async(req,res)=>{
  const financialYear=req.body.financialYear||req.query.financialYear||"2026-27",models=financialModels(req.auth.tenantKey,financialYear);
  const existing=await models.SalesInvoice.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear,status:"POSTED"});
  if(!existing)return fail(res,"Posted sales invoice not found",404);
  try{
    const calc=await calculateSalesInvoice({auth:req.auth,body:{...req.body,financialYear},existingInvoice:existing.toObject()});
    await reversePostedTransaction({tenantKey:req.auth.tenantKey,financialYear,transactionId:existing.invoiceNo,reason:"Sales invoice edited"});
    for(const it of existing.items||[]){await Product.updateOne({_id:it.productId,tenantKey:req.auth.tenantKey},{$inc:{currentStock:Number(it.qty||0)}});await models.StockMovement.create({tenantKey:req.auth.tenantKey,financialYear,date:new Date(),productId:String(it.productId),warehouseId:existing.warehouseId||"",type:"SALE_EDIT_REVERSAL",qtyIn:Number(it.qty||0),qtyOut:0,landedCost:Number(it.landedCostSnapshot||0),referenceId:existing.invoiceNo});}
    existing.date=calc.date;existing.customerGlobalId=calc.customer.globalCustomerId;existing.customerNameSnapshot=calc.customer.localName;existing.gstinSnapshot=calc.customer.displayIdentifier?.length===15?calc.customer.displayIdentifier:"";existing.addressSnapshot=req.body.addressSnapshot||calc.customer.addresses?.[0]?.address||"";existing.items=calc.items;existing.subtotal=calc.lineSubtotal;existing.billDiscount=Number(req.body.billDiscount||0);existing.otherCharges=Number(req.body.otherCharges||0);existing.taxableTotal=calc.taxableTotal;existing.taxTotal=calc.taxTotal;existing.roundOff=calc.roundOff;existing.grandTotal=calc.grandTotal;existing.grossProfit=calc.grossProfit;existing.grossMarginPct=calc.taxableTotal?calc.grossProfit/calc.taxableTotal*100:0;existing.orderNo=req.body.orderNo;existing.arn=req.body.arn;existing.noOfPackages=Number(req.body.noOfPackages||0);existing.deliveryBoy=req.body.deliveryBoy;existing.gstType=calc.gstType;existing.remarks=req.body.remarks;existing.eInvoice=normalizedEInvoice(req.body,existing.eInvoice||{});existing.transportAssignment=calc.transportAssignment;existing.branchId=req.body.branchId||existing.branchId||req.auth.branch||"";existing.warehouseId=calc.warehouseId;existing.warehouseNameSnapshot=calc.warehouse.title||calc.warehouse.reference||"";existing.assignedTo=req.body.assignedTo||existing.assignedTo||"";existing.workflowStatus=req.body.workflowStatus||existing.workflowStatus||"POSTED";existing.status="POSTED";await existing.save();
    for(const it of calc.items){await Product.updateOne({_id:it.productId,tenantKey:req.auth.tenantKey},{$inc:{currentStock:-it.qty}});await models.StockMovement.create({tenantKey:req.auth.tenantKey,financialYear,date:calc.date,productId:it.productId,warehouseId:calc.warehouseId,type:"SALE",qtyIn:0,qtyOut:it.qty,landedCost:it.landedCostSnapshot,referenceId:existing.invoiceNo});}
    await postSalesAccounting({...calc,invoiceNo:existing.invoiceNo});
    return ok(res,salesInvoiceForAuth(existing,req.auth),"Sales invoice updated");
  }catch(e){return fail(res,e.message,e.statusCode||400,e.details);}
});

router.delete("/sales-invoices/:id",async(req,res)=>{
  const financialYear=req.body?.financialYear||req.query.financialYear||"2026-27",models=financialModels(req.auth.tenantKey,financialYear);
  const invoice=await models.SalesInvoice.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear});
  if(!invoice)return fail(res,"Sales invoice not found",404);
  if(invoice.status==="DELETED"||invoice.status==="CANCELLED")return ok(res,salesInvoiceForAuth(invoice,req.auth),"Sales invoice already deleted");
  await reversePostedTransaction({tenantKey:req.auth.tenantKey,financialYear,transactionId:invoice.invoiceNo,reason:"Sales invoice deleted"});
  for(const it of invoice.items||[]){await Product.updateOne({_id:it.productId,tenantKey:req.auth.tenantKey},{$inc:{currentStock:Number(it.qty||0)}});await models.StockMovement.create({tenantKey:req.auth.tenantKey,financialYear,date:new Date(),productId:String(it.productId),warehouseId:invoice.warehouseId||"",type:"SALE_DELETE_REVERSAL",qtyIn:Number(it.qty||0),qtyOut:0,landedCost:Number(it.landedCostSnapshot||0),referenceId:invoice.invoiceNo});}
  invoice.status="DELETED";invoice.workflowStatus="DELETED";await invoice.save();
  return ok(res,salesInvoiceForAuth(invoice,req.auth),"Sales invoice deleted, stock restored and accounting reversed");
});


const safeFilePart = (value) => String(value || "file").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 90);
const customerEmailOf = (customer) => {
  const contacts = Array.isArray(customer?.contacts) ? customer.contacts : [];
  return String(contacts.find((row) => row.primary && row.email)?.email || contacts.find((row) => row.email)?.email || "").trim();
};

async function storeDeliveryFiles({ tenantKey, invoiceNo, files = [] }) {
  if (!files.length) return [];
  const root = path.resolve(env.storageRoot || "../storage", safeFilePart(tenantKey), "delivery-proofs", safeFilePart(invoiceNo));
  await fs.mkdir(root, { recursive: true });
  const saved = [];
  for (const entry of files) {
    if (!entry?.file?.buffer) continue;
    const ext = path.extname(entry.file.originalname || "") || (entry.file.mimetype === "application/pdf" ? ".pdf" : "");
    const storedName = `${entry.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`;
    const absolute = path.join(root, storedName);
    await fs.writeFile(absolute, entry.file.buffer);
    saved.push({
      kind: entry.kind,
      fileName: entry.file.originalname || storedName,
      storedName,
      path: absolute,
      mimeType: entry.file.mimetype || "application/octet-stream",
      size: Number(entry.file.size || entry.file.buffer.length || 0),
    });
  }
  return saved;
}

async function invoicePrintContext({ tenantKey, financialYear, invoice, customer = null }) {
  const resolvedCustomer = customer || await CustomerLink.findOne({ tenantKey, globalCustomerId: invoice.customerGlobalId }).lean();
  const [company, bank, ledgerSigned, lastPayment, branding] = await Promise.all([
    CompanyProfile.findOne({ tenantKey }).lean(),
    BankAccount.findOne({ tenantKey, status: "ACTIVE", isPrimary: true }).lean().then(async (row) => {
      if (row) return row;
      const activeCount = await BankAccount.countDocuments({ tenantKey, status: "ACTIVE" });
      return activeCount === 1 ? BankAccount.findOne({ tenantKey, status: "ACTIVE" }).lean() : null;
    }),
    customerReceivableBalance({ tenantKey, financialYear, customerGlobalId: invoice.customerGlobalId }).catch(() => null),
    financialModels(tenantKey, financialYear).Receipt.findOne({
      tenantKey, financialYear, customerGlobalId: invoice.customerGlobalId, status: "POSTED"
    }).sort({ date: -1, createdAt: -1 }).select("date amount").lean().catch(() => null),
    Branding.findOne({ key: "GLOBAL" }).lean().catch(() => null),
  ]);

  const readOptional = async (fileId) => {
    if (!fileId) return null;
    try { return (await readFile(fileId))?.buffer || null; } catch { return null; }
  };
  const [companyLogo, signature, appLogo] = await Promise.all([
    readOptional(company?.logoFileId),
    readOptional(company?.signatureFileId),
    readOptional(branding?.masterLogoFileId),
  ]);

  return { company, customer: resolvedCustomer, bank, ledgerSigned, lastPayment, companyLogo, signature, appLogo };
}

async function buildInvoicePdfBuffer({ tenantKey, financialYear, invoice, customer = null }) {
  const context = await invoicePrintContext({ tenantKey, financialYear, invoice, customer });
  return buildMasterSalesInvoicePdf({ invoice, ...context });
}

async function emailDeliveredInvoice({ tenantKey, financialYear, invoice, customer, uploadedFiles = [] }) {
  const to = customerEmailOf(customer);
  if (!to) return { status: "NO_EMAIL", to: "", error: "Customer email is not available" };
  const pdf = await buildInvoicePdfBuffer({ tenantKey, financialYear, invoice, customer });
  const attachments = [
    { filename: `${safeFilePart(invoice.invoiceNo)}.pdf`, content: pdf, contentType: "application/pdf" },
    ...uploadedFiles.filter((entry) => entry?.file?.buffer).map((entry) => ({
      filename: entry.file.originalname || `${entry.kind}.bin`,
      content: entry.file.buffer,
      contentType: entry.file.mimetype || "application/octet-stream",
    })),
  ];
  await sendBusinessEmail({
    to,
    subject: `Invoice ${invoice.invoiceNo} - Delivered`,
    text: [
      `Dear ${invoice.customerNameSnapshot || "Customer"},`,
      "",
      `Your invoice ${invoice.invoiceNo} has been delivered.`,
      `Amount: INR ${Number(invoice.grandTotal || 0).toFixed(2)}`,
      invoice.delivery?.deliveredTo ? `Delivered to: ${invoice.delivery.deliveredTo}` : "",
      invoice.delivery?.biltyNo ? `Bilty/LR No: ${invoice.delivery.biltyNo}` : "",
      "",
      "The invoice PDF and available delivery proof/bilty documents are attached.",
    ].filter(Boolean).join("\n"),
    html: `<div style="font-family:Arial,sans-serif;color:#263238"><h2>Invoice ${invoice.invoiceNo} delivered</h2><p>Dear ${invoice.customerNameSnapshot || "Customer"},</p><p>Your invoice has been marked delivered.</p><p><b>Amount:</b> INR ${Number(invoice.grandTotal || 0).toFixed(2)}</p>${invoice.delivery?.deliveredTo ? `<p><b>Delivered to:</b> ${invoice.delivery.deliveredTo}</p>` : ""}${invoice.delivery?.biltyNo ? `<p><b>Bilty/LR No:</b> ${invoice.delivery.biltyNo}</p>` : ""}<p>The invoice PDF and delivery documents are attached.</p></div>`,
    attachments,
  });
  return { status: "SENT", to, error: "" };
}

router.post("/sales-invoices/:id/process",
  requireAnyPermission("dms.sales.sales_invoice.process","dms.sales.sales_invoices.process","dms.sales.dispatch.process","dms.sales.dispatch_details.process"),
  upload.fields([{ name:"deliveryProof", maxCount:1 }, { name:"biltyCopy", maxCount:1 }]),
  async(req,res)=>{
    const financialYear=req.body.financialYear||req.query.financialYear||"2026-27";
    const {SalesInvoice}=financialModels(req.auth.tenantKey,financialYear);
    const invoice=await SalesInvoice.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear});
    if(!invoice)return fail(res,"Sales invoice not found",404);
    if(req.auth.role!=="MASTER"&&req.auth.role!=="SUPERADMIN"){
      if(req.auth.dataScope==="WAREHOUSE" && (!req.auth.warehouseId || invoice.warehouseId!==req.auth.warehouseId)) return fail(res,"Invoice is outside your assigned warehouse",403);
      if(req.auth.dataScope==="ASSIGNED" && invoice.assignedTo!==req.auth.sub && invoice.createdBy!==req.auth.sub) return fail(res,"Invoice is outside your assigned work",403);
    }
    const from=String(invoice.workflowStatus||"POSTED").toUpperCase(),to=String(req.body.toStatus||"").toUpperCase();if(!to)return fail(res,"toStatus is required",400);
    const transition=`${from}>${to}`;
    if(req.auth.role!=="MASTER"&&req.auth.role!=="SUPERADMIN"){
      const allowed=req.auth.workflowTransitions?.salesInvoice||[];if(!allowed.includes(transition))return fail(res,`Your designation cannot perform ${transition}`,403);
    }

    let deliveryMessage="";
    if(to==="DELIVERED"){
      const customer=await CustomerLink.findOne({tenantKey:req.auth.tenantKey,globalCustomerId:invoice.customerGlobalId}).lean();
      if(!customer)return fail(res,"Customer record not found for delivery",404);
      const proof=req.files?.deliveryProof?.[0]||null;
      const bilty=req.files?.biltyCopy?.[0]||null;
      const nonLocal=upper(invoice.transportAssignment?.mode||customer.regionType||"LOCAL")!=="LOCAL";
      if(!cleanText(req.body.deliveredTo))return fail(res,"Delivered To is required",400);
      if(!proof)return fail(res,"Delivery proof is required before marking Delivered",400);
      if(nonLocal&&!bilty)return fail(res,"Bilty/LR copy is mandatory for a non-local customer",400);
      const uploaded=[{kind:"DELIVERY_PROOF",file:proof},...(bilty?[{kind:"BILTY_COPY",file:bilty}]:[])];
      let stored=[];
      try{stored=await storeDeliveryFiles({tenantKey:req.auth.tenantKey,invoiceNo:invoice.invoiceNo,files:uploaded});}
      catch(error){return fail(res,`Unable to save delivery proof: ${error.message}`,500);}
      invoice.delivery={
        deliveredAt:req.body.deliveredAt?new Date(req.body.deliveredAt):new Date(),
        deliveredTo:cleanText(req.body.deliveredTo),
        mobile:cleanText(req.body.deliveryMobile),
        vehicleNo:cleanText(req.body.vehicleNo),
        biltyNo:cleanText(req.body.biltyNo),
        remarks:cleanText(req.body.deliveryRemarks),
        proofFiles:stored,
        emailStatus:"PENDING",
      };
      invoice.workflowStatus=to;invoice.warehouseProcessedBy=req.auth.sub;await invoice.save();
      try{
        const result=await emailDeliveredInvoice({tenantKey:req.auth.tenantKey,financialYear,invoice,customer,uploadedFiles:uploaded});
        invoice.delivery.emailStatus=result.status;invoice.delivery.emailTo=result.to;invoice.delivery.emailError=result.error||"";
        if(result.status==="SENT")invoice.delivery.emailedAt=new Date();
        deliveryMessage=result.status==="SENT"?` Invoice emailed automatically to ${result.to}.`:` Invoice email not sent: ${result.error}.`;
      }catch(error){
        invoice.delivery.emailStatus="FAILED";invoice.delivery.emailError=String(error.message||error);deliveryMessage=` Invoice delivered, but email failed: ${error.message}.`;
      }
      await invoice.save();
      return ok(res,salesInvoiceForAuth(invoice,req.auth),`Invoice moved to DELIVERED.${deliveryMessage}`);
    }

    invoice.workflowStatus=to;invoice.warehouseProcessedBy=req.auth.sub;await invoice.save();return ok(res,salesInvoiceForAuth(invoice,req.auth),`Invoice moved to ${to}`);
  }
);

async function calculatePurchaseInvoice({auth,body}){
  const tenantKey=auth.tenantKey,financialYear=body.financialYear||"2026-27",requested=Array.isArray(body.items)?body.items:[];
  if(!requested.length)throw Object.assign(new Error("At least one product row is required"),{statusCode:400});
  const ids=Array.from(new Set(requested.map(x=>String(x.productId||"")).filter(Boolean)));
  const products=await Product.find({tenantKey,_id:{$in:ids},status:"ACTIVE"});
  const pm=new Map(products.map(p=>[String(p._id),p]));
  let subtotal=0;const items=[];
  for(const row of requested){
    const p=pm.get(String(row.productId));if(!p)throw Object.assign(new Error(`Product not found: ${row.productId}`),{statusCode:400});
    const qty=Number(row.qty||0),rate=Number(row.rate||0),discountPct=Number(row.discountPct||0);
    if(qty<=0||rate<0)throw Object.assign(new Error(`Invalid quantity/rate for ${p.name}`),{statusCode:400});
    const effectiveRate=round2(rate*(1-discountPct/100)),taxable=round2(effectiveRate*qty),gstRate=Number(row.gstRate??p.gstRate??0),tax=round2(taxable*gstRate/100);
    subtotal+=taxable;
    items.push({productId:String(p._id),sku:p.sku,nameSnapshot:p.name,hsnSnapshot:p.hsnCode,qty,unit:p.basicUnit||p.unit,packingUnit:p.packingUnit||"",qtyInBag:Number(p.qtyInBag||1),grossQty:Number(p.qtyInBag||0)>0?round2(qty/Number(p.qtyInBag||1)):qty,mrpSnapshot:Number(p.mrp||0),landedCostSnapshot:Number(p.landedCost||0),averagePurchasePriceSnapshot:Number(p.averagePurchasePrice||0),rate,discountPct,effectiveRate,taxable,gstRateSnapshot:gstRate,tax,lineTotal:round2(taxable+tax)});
  }

  const billDiscount=Math.max(0,Number(body.billDiscount||0)),otherCharges=Math.max(0,Number(body.otherCharges||0));
  const billTax=billLevelTaxSummary(items,billDiscount,otherCharges);
  const taxableTotal=billTax.taxableTotal,taxTotal=billTax.taxTotal;
  const transportationCost=Math.max(0,Number(body.transportationCost||0));
  const labourCost=Math.max(0,Number(body.labourCost||0));
  const localFreight=Math.max(0,Number(body.localFreight||0));
  const miscellaneousCost=Math.max(0,Number(body.miscellaneousCost||0));
  const landedCharges=round2(transportationCost+labourCost+localFreight+miscellaneousCost);
  const basicPurchaseTotalAfterAdjustments=round2(Math.max(0,billTax.taxableTotal));
  const landedExpensePercentage=basicPurchaseTotalAfterAdjustments>0?round2((landedCharges/basicPurchaseTotalAfterAdjustments)*100):0;
  const landedTax=0;

  for(const it of items){
    const basicPurchasePrice=Math.max(0,Number(it.effectiveRate||0));
    it.landedCostSnapshot=round2(basicPurchasePrice+(basicPurchasePrice*landedExpensePercentage/100));
  }

  const beforeRound=round2(taxableTotal+taxTotal),grandTotal=body.roundGrandTotal===false?beforeRound:Math.round(beforeRound),roundOff=round2(grandTotal-beforeRound);
  return {tenantKey,financialYear,items,subtotal:round2(subtotal),billTax,taxableTotal,taxTotal,transportationCost,labourCost,localFreight,miscellaneousCost,landedCharges,landedTax,landedExpensePercentage,beforeRound,grandTotal,roundOff,date:body.date?new Date(body.date):new Date()};
}

function summarizePurchaseItems(items=[]){
  const out=new Map();
  for(const it of items||[]){
    const id=String(it.productId||"");if(!id)continue;
    const row=out.get(id)||{qty:0,value:0,lastRate:0,lastLanded:0};
    const qty=Number(it.qty||0),rate=Number(it.effectiveRate??it.rate??0),landed=Number(it.landedCostSnapshot??rate);
    row.qty+=qty;row.value+=qty*rate;row.lastRate=rate;row.lastLanded=landed;out.set(id,row);
  }
  return out;
}

async function applyPurchaseProductChanges({tenantKey,financialYear,invoiceNo,date,oldItems=[],newItems=[],reason="EDIT"}){
  const oldMap=summarizePurchaseItems(oldItems),newMap=summarizePurchaseItems(newItems),ids=Array.from(new Set([...oldMap.keys(),...newMap.keys()]));
  if(!ids.length)return;
  const products=await Product.find({tenantKey,_id:{$in:ids}}),pm=new Map(products.map(p=>[String(p._id),p]));
  const models=financialModels(tenantKey,financialYear);

  // Validate all stock changes before writing anything.
  for(const id of ids){
    const p=pm.get(id);if(!p)throw Object.assign(new Error(`Product not found while adjusting purchase: ${id}`),{statusCode:409});
    const oldRow=oldMap.get(id)||{qty:0,value:0},newRow=newMap.get(id)||{qty:0,value:0};
    const nextStock=Number(p.currentStock||0)-Number(oldRow.qty||0)+Number(newRow.qty||0);
    if(nextStock<-0.0001)throw Object.assign(new Error(`${p.name}: Purchase Invoice cannot be ${reason==="DELETE"?"deleted":"edited"} because ${round2(Number(oldRow.qty||0)-Number(newRow.qty||0))} units from this purchase are already consumed. Current stock is ${round2(Number(p.currentStock||0))}.`),{statusCode:409});
  }

  for(const id of ids){
    const p=pm.get(id),oldRow=oldMap.get(id)||{qty:0,value:0,lastRate:0,lastLanded:0},newRow=newMap.get(id)||{qty:0,value:0,lastRate:0,lastLanded:0};
    const nextQty=Math.max(0,Number(p.purchaseQtyAccumulated||0)-Number(oldRow.qty||0)+Number(newRow.qty||0));
    const nextVal=Math.max(0,Number(p.purchaseValueAccumulated||0)-Number(oldRow.value||0)+Number(newRow.value||0));
    const nextAvg=nextQty>0?round2(nextVal/nextQty):Number(p.openingRate||0);
    const nextStock=round2(Number(p.currentStock||0)-Number(oldRow.qty||0)+Number(newRow.qty||0));
    const oldWasCurrent=Math.abs(Number(p.lastPurchasePrice||0)-Number(oldRow.lastRate||0))<0.005;
    const oldLandedWasCurrent=Math.abs(Number(p.landedCost||0)-Number(oldRow.lastLanded||0))<0.005;
    const lastPurchasePrice=Number(newRow.qty||0)>0?(oldWasCurrent||!Number(oldRow.qty||0)?Number(newRow.lastRate||0):Number(p.lastPurchasePrice||0)):(oldWasCurrent?nextAvg:Number(p.lastPurchasePrice||nextAvg));
    const landedCost=Number(newRow.qty||0)>0?(oldLandedWasCurrent||!Number(oldRow.qty||0)?Number(newRow.lastLanded||newRow.lastRate||0):Number(p.landedCost||0)):(oldLandedWasCurrent?nextAvg:Number(p.landedCost||nextAvg));
    await Product.updateOne({_id:p._id,tenantKey},{$set:{currentStock:nextStock,purchaseQtyAccumulated:round2(nextQty),purchaseValueAccumulated:round2(nextVal),averagePurchasePrice:round2(nextAvg),lastPurchasePrice:round2(lastPurchasePrice),landedCost:round2(landedCost)}});
  }

  for(const it of oldItems||[]){
    await models.StockMovement.create({tenantKey,financialYear,date:new Date(),productId:String(it.productId),type:reason==="DELETE"?"PURCHASE_DELETE_REVERSAL":"PURCHASE_EDIT_REVERSAL",qtyIn:0,qtyOut:Number(it.qty||0),landedCost:Number(it.landedCostSnapshot||it.effectiveRate||0),referenceId:invoiceNo});
  }
  for(const it of newItems||[]){
    await models.StockMovement.create({tenantKey,financialYear,date,productId:String(it.productId),type:"PURCHASE",qtyIn:Number(it.qty||0),qtyOut:0,landedCost:Number(it.landedCostSnapshot||it.effectiveRate||0),referenceId:invoiceNo});
  }
}

async function postPurchaseAccounting({tenantKey,financialYear,invoiceNo,date,supplierGlobalId,taxableTotal,taxTotal,roundOff,grandTotal}){
  await postBalancedEntries({tenantKey,financialYear,transactionId:invoiceNo,transactionType:"PURCHASE_INVOICE",date,partyGlobalId:supplierGlobalId||"",narration:`Purchase Invoice ${invoiceNo}`,entries:[{accountCode:"SYS_PURCHASE",debit:taxableTotal},{accountCode:"SYS_DUTIES_TAXES",debit:taxTotal},{accountCode:"SYS_SUNDRY_CREDITORS",credit:grandTotal},{accountCode:roundOff>=0?"SYS_INDIRECT_EXPENSE":"SYS_INDIRECT_INCOME",debit:roundOff>0?roundOff:0,credit:roundOff<0?Math.abs(roundOff):0}].filter(x=>Number(x.debit||0)||Number(x.credit||0))});
}

router.get("/purchase-invoices",async(req,res)=>{
  const financialYear=req.query.financialYear||"2026-27",page=Math.max(1,Number(req.query.page||1)),limit=Math.min(100,Math.max(10,Number(req.query.limit||25)));const {PurchaseInvoice}=financialModels(req.auth.tenantKey,financialYear);const f={tenantKey:req.auth.tenantKey,financialYear};if(req.query.includeDeleted!=="true")f.status={$ne:"DELETED"};let[items,total]=await Promise.all([PurchaseInvoice.find(f).sort({date:-1,createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),PurchaseInvoice.countDocuments(f)]);items=await enrichTransactionRows({tenantKey:req.auth.tenantKey,rows:items,partyIdKey:"supplierGlobalId",partySnapshotKey:"supplierNameSnapshot"});ok(res,{items,meta:pageMeta(page,limit,total)});
});

router.get("/purchase-invoices/:id",async(req,res)=>{
  const financialYear=req.query.financialYear||"2026-27",{PurchaseInvoice}=financialModels(req.auth.tenantKey,financialYear);
  const invoice=await PurchaseInvoice.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear}).lean();
  if(!invoice)return fail(res,"Purchase invoice not found",404);
  const [enriched]=await enrichTransactionRows({tenantKey:req.auth.tenantKey,rows:[invoice],partyIdKey:"supplierGlobalId",partySnapshotKey:"supplierNameSnapshot"});
  return ok(res,enriched);
});

router.post("/purchase-invoices",async(req,res)=>{
  try{
    const calc=await calculatePurchaseInvoice({auth:req.auth,body:req.body});
    const invoiceNo=cleanText(req.body.invoiceNo)||makeId("PINV"),{PurchaseInvoice}=financialModels(calc.tenantKey,calc.financialYear);
    if(await PurchaseInvoice.exists({tenantKey:calc.tenantKey,financialYear:calc.financialYear,invoiceNo}))return fail(res,"Purchase invoice number already exists",409);
    const supplierRef=cleanText(req.body.supplierGlobalId||"");
    const supplierMap=await resolvePartyDisplayMap(calc.tenantKey,[supplierRef]);
    const supplierName=supplierMap.get(supplierRef)?.name||cleanText(req.body.supplierName)||"Supplier";
    const invoice=await PurchaseInvoice.create({tenantKey:calc.tenantKey,financialYear:calc.financialYear,invoiceNo,date:calc.date,supplierGlobalId:supplierRef,supplierNameSnapshot:supplierName,supplierGstinSnapshot:upper(req.body.supplierGstin),purchaseType:upper(req.body.purchaseType||"GST"),items:calc.items,subtotal:calc.subtotal,billDiscount:calc.billTax.discount,otherCharges:calc.billTax.charges,taxableTotal:calc.taxableTotal,taxTotal:calc.taxTotal,roundOff:calc.roundOff,grandTotal:calc.grandTotal,landedCharges:calc.landedCharges,transportationCost:calc.transportationCost,labourCost:calc.labourCost,localFreight:calc.localFreight,miscellaneousCost:calc.miscellaneousCost,landedTax:calc.landedTax,landedExpensePercentage:calc.landedExpensePercentage,maxGstPercentage:0,remarks:req.body.remarks,createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||"",status:"POSTED"});
    await applyPurchaseProductChanges({tenantKey:calc.tenantKey,financialYear:calc.financialYear,invoiceNo,date:calc.date,oldItems:[],newItems:calc.items,reason:"CREATE"});
    await postPurchaseAccounting({...calc,invoiceNo,supplierGlobalId:req.body.supplierGlobalId||""});
    return ok(res,invoice,"Purchase invoice posted and landed costs updated",201);
  }catch(e){return fail(res,e.message,e.statusCode||400,e.details);}
});

router.put("/purchase-invoices/:id",async(req,res)=>{
  const financialYear=req.body.financialYear||req.query.financialYear||"2026-27",models=financialModels(req.auth.tenantKey,financialYear);
  const existing=await models.PurchaseInvoice.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear,status:"POSTED"});
  if(!existing)return fail(res,"Posted purchase invoice not found",404);
  try{
    const calc=await calculatePurchaseInvoice({auth:req.auth,body:{...req.body,financialYear}});
    await applyPurchaseProductChanges({tenantKey:req.auth.tenantKey,financialYear,invoiceNo:existing.invoiceNo,date:calc.date,oldItems:existing.items||[],newItems:calc.items,reason:"EDIT"});
    await reversePostedTransaction({tenantKey:req.auth.tenantKey,financialYear,transactionId:existing.invoiceNo,reason:"Purchase invoice edited"});
    existing.date=calc.date;existing.supplierGlobalId=cleanText(req.body.supplierGlobalId||"");const supplierMap=await resolvePartyDisplayMap(req.auth.tenantKey,[existing.supplierGlobalId]);existing.supplierNameSnapshot=supplierMap.get(existing.supplierGlobalId)?.name||cleanText(req.body.supplierName)||existing.supplierNameSnapshot||"Supplier";existing.supplierGstinSnapshot=upper(req.body.supplierGstin);existing.purchaseType=upper(req.body.purchaseType||"GST");existing.items=calc.items;existing.subtotal=calc.subtotal;existing.billDiscount=calc.billTax.discount;existing.otherCharges=calc.billTax.charges;existing.taxableTotal=calc.taxableTotal;existing.taxTotal=calc.taxTotal;existing.roundOff=calc.roundOff;existing.grandTotal=calc.grandTotal;existing.landedCharges=calc.landedCharges;existing.transportationCost=calc.transportationCost;existing.labourCost=calc.labourCost;existing.localFreight=calc.localFreight;existing.miscellaneousCost=calc.miscellaneousCost;existing.landedTax=calc.landedTax;existing.landedExpensePercentage=calc.landedExpensePercentage;existing.maxGstPercentage=0;existing.remarks=req.body.remarks;existing.status="POSTED";await existing.save();
    await postPurchaseAccounting({...calc,invoiceNo:existing.invoiceNo,supplierGlobalId:req.body.supplierGlobalId||""});
    return ok(res,existing,"Purchase invoice updated; stock, accounting and landed cost recalculated");
  }catch(e){return fail(res,e.message,e.statusCode||400,e.details);}
});

router.delete("/purchase-invoices/:id",async(req,res)=>{
  const financialYear=req.body?.financialYear||req.query.financialYear||"2026-27",models=financialModels(req.auth.tenantKey,financialYear);
  const invoice=await models.PurchaseInvoice.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear});
  if(!invoice)return fail(res,"Purchase invoice not found",404);
  if(invoice.status==="DELETED")return ok(res,invoice,"Purchase invoice already deleted");
  try{
    await applyPurchaseProductChanges({tenantKey:req.auth.tenantKey,financialYear,invoiceNo:invoice.invoiceNo,date:new Date(),oldItems:invoice.items||[],newItems:[],reason:"DELETE"});
    await reversePostedTransaction({tenantKey:req.auth.tenantKey,financialYear,transactionId:invoice.invoiceNo,reason:"Purchase invoice deleted"});
    invoice.status="DELETED";await invoice.save();
    return ok(res,invoice,"Purchase invoice deleted; stock and accounting reversed");
  }catch(e){return fail(res,e.message,e.statusCode||400,e.details);}
});

router.get("/receipts", async (req,res)=>{
  const financialYear=req.query.financialYear||"2026-27",page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=String(req.query.q||"").trim(); const {Receipt}=financialModels(req.auth.tenantKey,financialYear);
  const filter={tenantKey:req.auth.tenantKey,financialYear};if(q)filter.$or=[{receiptNo:new RegExp(q,"i")},{customerGlobalId:new RegExp(q,"i")},{partyNameSnapshot:new RegExp(q,"i")},{reference:new RegExp(q,"i")},{remarks:new RegExp(q,"i")},{bankNameSnapshot:new RegExp(q,"i")},{mode:new RegExp(q,"i")}];
  const [items,total]=await Promise.all([Receipt.find(filter).sort({date:-1,createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),Receipt.countDocuments(filter)]);
  ok(res,{items,meta:pageMeta(page,limit,total)});
});

router.get("/payments", async (req,res)=>{
  const financialYear=req.query.financialYear||"2026-27",page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=String(req.query.q||"").trim(); const {Payment}=financialModels(req.auth.tenantKey,financialYear);
  const filter={tenantKey:req.auth.tenantKey,financialYear};if(q)filter.$or=[{paymentNo:new RegExp(q,"i")},{partyGlobalId:new RegExp(q,"i")},{partyNameSnapshot:new RegExp(q,"i")},{reference:new RegExp(q,"i")},{remarks:new RegExp(q,"i")},{bankNameSnapshot:new RegExp(q,"i")},{mode:new RegExp(q,"i")}];
  const [items,total]=await Promise.all([Payment.find(filter).sort({date:-1,createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),Payment.countDocuments(filter)]);
  ok(res,{items,meta:pageMeta(page,limit,total)});
});
router.post("/payments", async (req,res)=>{
  try{
    const tenantKey=req.auth.tenantKey,financialYear=req.body.financialYear||"2026-27",amount=Number(req.body.amount||0); if(amount<=0)return fail(res,"Payment amount must be greater than zero");
    const partyId=req.body.partyGlobalId||req.body.party||"";const party=await resolvePostingParty(tenantKey,partyId);if(!party)return fail(res,"Party is not ACTIVE. Complete and verify the migrated profile before Purchase/Payment.",400);
    const mode=upper(req.body.mode||"BANK"),bank=await resolveTransactionBank(tenantKey,mode,req.body.bankAccountId);
    const {Payment}=financialModels(tenantKey,financialYear); const paymentNo=req.body.paymentNo||makeId("PAY"),date=req.body.date?new Date(req.body.date):new Date();
    const payment=await Payment.create({tenantKey,financialYear,paymentNo,date,partyGlobalId:party.globalCustomerId,partyNameSnapshot:party.localName||party.displayIdentifier,amount,mode,reference:req.body.reference||"",remarks:req.body.remarks||req.body.narration||"",bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,status:"POSTED",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
    await postBalancedEntries({tenantKey,financialYear,transactionId:paymentNo,transactionType:"PAYMENT",date,partyGlobalId:party.globalCustomerId,narration:req.body.remarks||req.body.narration||`Payment ${paymentNo}`,entries:[{accountCode:partyAccountCodeOf(party),debit:amount},{accountCode:bank.accountCode,ledgerId:bank.ledgerId,bankAccountId:bank.bankAccountId,credit:amount}]});
    return ok(res,payment,"Payment posted",201);
  }catch(error){return fail(res,error.message,error.statusCode||400);}
});

router.get("/expenses", async (req,res)=>{
  const financialYear=req.query.financialYear||"2026-27",page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=String(req.query.q||"").trim(); const {Expense}=financialModels(req.auth.tenantKey,financialYear);
  const filter={tenantKey:req.auth.tenantKey,financialYear};if(q)filter.$or=[{expenseNo:new RegExp(q,"i")},{accountCode:new RegExp(q,"i")},{nature:new RegExp(q,"i")},{allocationMethod:new RegExp(q,"i")}];
  const [items,total]=await Promise.all([Expense.find(filter).sort({date:-1,createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),Expense.countDocuments(filter)]);
  ok(res,{items,meta:pageMeta(page,limit,total)});
});

router.post("/receipts", async (req, res) => {
  try{
    const tenantKey=req.auth.tenantKey,financialYear=req.body.financialYear||"2026-27";
    const amount=Number(req.body.amount||0);if(amount<=0)return fail(res,"Receipt amount must be greater than zero");
    const party=await resolvePostingParty(tenantKey,req.body.customerGlobalId);if(!party)return fail(res,"Party is not ACTIVE. Complete and verify the migrated profile before Receipt/Sales.",400);
    const mode=upper(req.body.mode||"BANK"),bank=await resolveTransactionBank(tenantKey,mode,req.body.bankAccountId);
    const {Receipt}=financialModels(tenantKey,financialYear);const receiptNo=req.body.receiptNo||makeId("RCT"),date=req.body.date?new Date(req.body.date):new Date();
    const receipt=await Receipt.create({tenantKey,financialYear,receiptNo,date,customerGlobalId:party.globalCustomerId,partyNameSnapshot:party.localName||party.displayIdentifier,amount,mode,reference:req.body.reference||"",remarks:req.body.remarks||"",bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,bounceStatus:"CLEAR",status:"POSTED",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
    await postBalancedEntries({tenantKey,financialYear,transactionId:receiptNo,transactionType:"RECEIPT",date,partyGlobalId:party.globalCustomerId,narration:req.body.remarks||`Receipt ${receiptNo}`,entries:[{accountCode:bank.accountCode,ledgerId:bank.ledgerId,bankAccountId:bank.bankAccountId,debit:amount},{accountCode:partyAccountCodeOf(party),credit:amount}]});
    return ok(res,receipt,"Receipt posted",201);
  }catch(error){return fail(res,error.message,error.statusCode||400);}
});

router.post("/expenses", async (req, res) => {
  const tenantKey = req.auth.tenantKey, financialYear = req.body.financialYear || "2026-27";
  const amount = Number(req.body.amount || 0); if (amount <= 0) return fail(res, "Expense amount must be greater than zero");
  const { Expense } = financialModels(tenantKey, financialYear);
  const transactionId = req.body.expenseNo || makeId("EXP"), date = req.body.date ? new Date(req.body.date) : new Date();
  const expense = await Expense.create({ tenantKey, financialYear, expenseNo: transactionId, date, accountCode: req.body.accountCode || "SYS_INDIRECT_EXPENSE", amount, nature: req.body.nature || "FIXED", allocationMethod: req.body.allocationMethod || "TURNOVER", branchId: req.body.branchId, productId: req.body.productId, customerGlobalId: req.body.customerGlobalId, status: "POSTED" });
  await postBalancedEntries({ tenantKey, financialYear, transactionId, transactionType: "EXPENSE", date, partyGlobalId: req.body.customerGlobalId, narration: req.body.narration || "Expense", entries: [
    { accountCode: req.body.accountCode || "SYS_INDIRECT_EXPENSE", debit: amount },
    { accountCode: req.body.paymentMode === "BANK" ? "SYS_BANK_ACCOUNT" : "SYS_CASH", credit: amount }
  ]});
  ok(res, expense, "Expense posted", 201);
});

export default router;
