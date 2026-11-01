import { GenericRecord, Product } from "../models/index.js";
import { financialModels } from "./accountingService.js";
import { financialYearFromDate } from "../utils/financialYear.js";
import { productFyOpeningQty,productFyOpeningRate } from "./closingStockService.js";

const N=v=>Number.isFinite(Number(v))?Number(v):0;
const R=v=>Math.round((N(v)+Number.EPSILON)*1000)/1000;
const U=v=>String(v||"").trim().toUpperCase();
export function indiaToday(date=new Date()) {
  const bits=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return `${bits.year}-${bits.month}-${bits.day}`;
}
export function previousMonth(date=new Date()) {
  const now=indiaToday(date);
  const first=new Date(`${now.slice(0,7)}-01T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth()-1);
  return first.toISOString().slice(0,7);
}
const earlierThanMonthEnd=(monthKey)=>new Date(`${monthKey}-01T00:00:00Z`); // advanced below
export async function warehouseStockSnapshot({tenantKey,financialYear,warehouseId,throughDate=null}){
  const warehouse=await GenericRecord.findOne({_id:warehouseId,tenantKey,app:"dms",resource:"warehouses"}).select("title").lean();
  if(!warehouse)throw Object.assign(new Error("Warehouse not found"),{statusCode:404});
  const {StockMovement,SalesOrder}=financialModels(tenantKey,financialYear);
  const [assigned,allMovements,orders]=await Promise.all([
    Product.find({tenantKey,warehouseId}).select("_id sku name openingStock openingFinancialYear openingStockByFY openingStocks financialYearOpenings financialYearOpeningStock basicUnit hsnCode openingRate financialYearOpeningRate averagePurchasePrice landedCost salePrice").lean(),
    StockMovement.find({tenantKey,financialYear,warehouseId,...(throughDate?{date:{$lt:new Date(throughDate)}}:{})}).select("productId type qtyIn qtyOut date").lean(),
    SalesOrder.find({tenantKey,financialYear,...(throughDate?{date:{$lt:new Date(throughDate)}}:{})}).select("items workflowStatus dispatchCustody").lean(),
  ]);
  const ids=new Set([...assigned.map(x=>String(x._id)),...allMovements.map(x=>String(x.productId))]);
  const orderPending=new Map();
  const inactive=new Set(["DELIVERED","CLOSED","CANCELLED","REJECTED","RETURNED_TO_WAREHOUSE"]);
  for(const order of orders){
    if(inactive.has(U(order.workflowStatus)))continue;
    // Assigned stock is no longer physically inside the Warehouse.
    // Custody-out is an otherOut movement; pending cannot subtract it again.
    if(order.dispatchCustody?.recordedAt && !order.dispatchCustody?.settledAt)continue;
    for(const item of order.items||[]){
      if(String(item.currentWarehouseId||item.warehouseId)!==String(warehouseId))continue;
      const key=String(item.productId);ids.add(key);
      orderPending.set(key,R((orderPending.get(key)||0)+Math.max(0,N(item.qty)-N(item.cancelledQty))));
    }
  }
  const productRows=await Product.find({tenantKey,_id:{$in:[...ids]}}).select("_id sku name warehouseId openingStock openingFinancialYear openingStockByFY openingStocks financialYearOpenings financialYearOpeningStock basicUnit hsnCode openingRate financialYearOpeningRate averagePurchasePrice landedCost salePrice").lean();
  const byId=new Map();
  for(const pr of productRows){
    const id=String(pr._id),isHome=String(pr.warehouseId||"")===String(warehouseId);
    const cost=R(N(pr.averagePurchasePrice)||N(pr.landedCost)||N(pr.openingRate));
    byId.set(id,{productId:id,sku:pr.sku||"",name:pr.name||pr.sku||"Product",hsn:pr.hsnCode||"",unit:pr.basicUnit||"PCS",opening:isHome?productFyOpeningQty(pr,financialYear):0,
      openingRate:isHome?productFyOpeningRate(pr,financialYear):0,openingSource:isHome?"Product FY Opening":"Warehouse Transfer",
      inward:0,transferIn:0,purchaseIn:0,transferOut:0,outward:0,otherOut:0,pending:0,closing:0,physicalExpected:0,
      inwardRate:cost,pendingRate:R(N(pr.salePrice)||cost),outwardRate:R(N(pr.salePrice)||cost),closingRate:cost,
      openingTotal:0,inwardTotal:0,pendingTotal:0,outwardTotal:0,closingTotal:0});
  }
  for(const m of allMovements){
    const row=byId.get(String(m.productId));if(!row)continue;
    const type=U(m.type),qtyIn=N(m.qtyIn),qtyOut=N(m.qtyOut);
    row.inward+=qtyIn;
    if(type.includes("TRANSFER")){row.transferIn+=qtyIn;row.transferOut+=qtyOut;}
    else if(type.includes("PURCHASE")||type==="INWARD")row.purchaseIn+=qtyIn;
    if(type==="SALE"||type==="ORDER_SALE"||type==="DELIVERY_SALE")row.outward+=qtyOut;
    else if(!type.includes("TRANSFER"))row.otherOut+=qtyOut;
  }
  for(const row of byId.values()){
    row.pending=R(orderPending.get(row.productId)||0);
    row.opening=R(row.opening);row.inward=R(row.inward);row.outward=R(row.outward);row.transferOut=R(row.transferOut);
    row.physicalExpected=R(row.opening+row.inward-row.outward-row.transferOut-row.otherOut);
    row.closing=R(row.physicalExpected-row.pending);
    row.openingTotal=R(row.opening*row.openingRate);
    row.inwardTotal=R(row.inward*row.inwardRate);
    row.pendingTotal=R(row.pending*row.pendingRate);
    row.outwardTotal=R(row.outward*row.outwardRate);
    row.closingTotal=R(row.closing*row.closingRate);
  }
  const rows=[...byId.values()].sort((a,b)=>a.name.localeCompare(b.name));
  return {warehouseId,warehouseName:warehouse.title,financialYear,rows,totals:rows.reduce((a,x)=>{for(const key of ["opening","inward","pending","outward","transferOut","closing","physicalExpected"])a[key]=R((a[key]||0)+x[key]);return a},{})};
}
export async function ensureWarehouseMonthlyClosing({tenantKey,warehouseId,monthKey}){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey))throw Object.assign(new Error("Invalid month"),{statusCode:400});
  const financialYear=financialYearFromDate(`${monthKey}-01`);
  const models=financialModels(tenantKey,financialYear);
  const prev=models.WarehouseClosing;
  const existing=await prev.findOne({tenantKey,financialYear,warehouseId,monthKey});
  if(existing)return existing;
  const until=new Date(`${monthKey}-01T00:00:00Z`);until.setUTCMonth(until.getUTCMonth()+1);
  const report=await warehouseStockSnapshot({tenantKey,financialYear,warehouseId,throughDate:until});
  return prev.findOneAndUpdate({tenantKey,financialYear,warehouseId,monthKey},{$setOnInsert:{tenantKey,financialYear,warehouseId,monthKey,status:"OPEN",rows:report.rows.map(x=>({productId:x.productId,productName:x.name,expected:x.physicalExpected}))}},{upsert:true,new:true,setDefaultsOnInsert:true});
}
// Idempotent: on 1st IST generate previous month's report for each active warehouse.
export function startWarehouseClosingScheduler(){
  async function check(){
    if(!indiaToday().endsWith("-01"))return;
    const monthKey=previousMonth();
    const wh=await GenericRecord.find({app:"dms",resource:"warehouses",status:"ACTIVE"}).select("_id tenantKey").lean();
    for(const w of wh){try{await ensureWarehouseMonthlyClosing({tenantKey:w.tenantKey,warehouseId:String(w._id),monthKey});}catch(e){console.warn("Warehouse monthly closing:",w._id,e.message);}}
  }
  check().catch(e=>console.warn("Warehouse stock closing scheduler:",e.message));
  const interval=setInterval(()=>check().catch(e=>console.warn("Warehouse stock closing scheduler:",e.message)),60*60*1000);
  if(interval.unref)interval.unref();
}
