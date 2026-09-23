import express from "express";
import { Product, CustomerLink, Lead, Target, Employee, GenericRecord, Candidate, JobOpening } from "../models/index.js";
import { ok } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { companyHealth } from "../services/healthService.js";
import { buildInsights } from "../services/aiService.js";
import { financialModels } from "../services/accountingService.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { resolveFinancialYear } from "../utils/financialYear.js";
const router=express.Router();router.use(requireAuth);
const sum=(arr,key)=>arr.reduce((s,x)=>s+Number(x[key]||0),0);
router.get("/",async(req,res)=>{
 const app=String(req.query.app||"dms"),tenantKey=req.auth.tenantKey,financialYear=await resolveFinancialYear({tenantKey,requested:req.query.financialYear});
 if(req.auth.role!=="MASTER" && !(req.auth.apps||[]).includes(app)) return res.status(403).json({success:false,message:`${app} is not enabled for this user`});
 if(app==="hr"){
   const today=new Date();today.setHours(0,0,0,0);const tomorrow=new Date(today);tomorrow.setDate(today.getDate()+1);
   const [employees,attendance,payroll,leavePending,openJobs,candidates]=await Promise.all([
    Employee.countDocuments({tenantKey,status:"ACTIVE"}),GenericRecord.find({tenantKey,app:"hr",resource:"attendance",date:{$gte:today,$lt:tomorrow}}).lean(),GenericRecord.find({tenantKey,app:"hr",resource:"payroll"}).sort({updatedAt:-1}).limit(300).lean(),GenericRecord.countDocuments({tenantKey,app:"hr",resource:"leave",status:"REQUESTED"}),JobOpening.countDocuments({tenantKey,status:{$in:["OPEN","APPROVED"]}}),Candidate.countDocuments({tenantKey,stage:{$nin:["JOINED","REJECTED","WITHDRAWN"]}})
   ]);
   const present=attendance.filter(x=>["PRESENT","HALF_DAY"].includes(x.status)).length;
   return ok(res,{app:"hr",kpis:{employees,presentToday:present,attendancePct:employees?Number((present/employees*100).toFixed(1)):0,payroll:sum(payroll,"amount"),leavePending,openJobs,candidates},trend:[],insights:[{severity:leavePending>5?"medium":"good",title:"Leave approvals",text:`${leavePending} leave requests are pending.`},{severity:openJobs>0?"medium":"good",title:"Recruitment",text:`${openJobs} vacancies are currently open.`}]});
 }
 if(app==="production"){
   const [plans,execution,wip,qc,machines,maintenance]=await Promise.all([
    GenericRecord.find({tenantKey,app:"production",resource:"planning"}).limit(500).lean(),GenericRecord.find({tenantKey,app:"production",resource:"execution"}).limit(500).lean(),GenericRecord.find({tenantKey,app:"production",resource:"wip"}).limit(500).lean(),GenericRecord.find({tenantKey,app:"production",resource:"quality"}).limit(500).lean(),GenericRecord.find({tenantKey,app:"production",resource:"machines"}).limit(500).lean(),GenericRecord.find({tenantKey,app:"production",resource:"maintenance",status:{$in:["PLANNED","IN_PROGRESS"]}}).limit(500).lean()
   ]);
   const planned=sum(plans,"quantity"),actual=sum(execution,"quantity"),reject=qc.reduce((s,x)=>s+Number(x.data?.rejectedQty||0),0),checked=sum(qc,"quantity");
   return ok(res,{app:"production",kpis:{planned,actual,planAchievement:planned?Number((actual/planned*100).toFixed(1)):0,wip:sum(wip,"quantity"),rejectionPct:checked?Number((reject/checked*100).toFixed(1)):0,machines:machines.length,maintenance:maintenance.length},insights:[{severity:maintenance.length?"medium":"good",title:"Maintenance attention",text:`${maintenance.length} maintenance jobs are open.`},{severity:checked&&reject/checked>.03?"high":"good",title:"Quality",text:checked?`Current rejection is ${(reject/checked*100).toFixed(1)}%.`:"No QC data yet."}]});
 }
 const {SalesInvoice,Receipt,Expense,StockMovement}=financialModels(tenantKey,financialYear);
 const [products,customers,leads,activeTargets,invoices,receipts,expenses,stockMoves]=await Promise.all([
  Product.countDocuments({tenantKey,status:"ACTIVE"}),CustomerLink.countDocuments({tenantKey,status:"ACTIVE"}),Lead.countDocuments({tenantKey}),Target.find({tenantKey,status:{$in:["PUBLISHED","ACTIVE"]}}).lean(),SalesInvoice.find({tenantKey,financialYear,status:"POSTED"}).limit(3000).lean(),Receipt.find({tenantKey,financialYear,status:"POSTED"}).limit(3000).lean(),Expense.find({tenantKey,financialYear,status:"POSTED"}).limit(3000).lean(),StockMovement.find({tenantKey,financialYear}).limit(5000).lean()
 ]);
 const sales=sum(invoices,"subtotal"),grossProfit=sum(invoices,"grossProfit"),collections=sum(receipts,"amount"),expenseTotal=sum(expenses,"amount");
 let green=0,blue=0,red=0;for(const inv of invoices)for(const it of inv.items||[]){if(it.marginColor==="GREEN")green+=Number(it.taxable||0);else if(it.marginColor==="BLUE")blue+=Number(it.taxable||0);else red+=Number(it.taxable||0)}const marginTotal=green+blue+red||1;
 const stockMap=new Map();for(const m of stockMoves){const x=stockMap.get(m.productId)||{qty:0,cost:Number(m.landedCost||0)};x.qty+=Number(m.qtyIn||0)-Number(m.qtyOut||0);if(m.landedCost)x.cost=Number(m.landedCost);stockMap.set(m.productId,x)}const stockValue=[...stockMap.values()].reduce((s,x)=>s+x.qty*x.cost,0);
 const targetAnnual=activeTargets.reduce((s,t)=>s+Number(t.annual?.sales||0),0),targetAchievement=targetAnnual?Math.min(200,Number((sales/targetAnnual*100).toFixed(1))):0;
 const kpis={sales,grossProfit,grossMarginPct:sales?Number((grossProfit/sales*100).toFixed(1)):0,collectionAchievement:sales?Number((collections/sales*100).toFixed(1)):0,targetAchievement,greenSalesPct:Number((green/marginTotal*100).toFixed(1)),blueSalesPct:Number((blue/marginTotal*100).toFixed(1)),redSalesPct:Number((red/marginTotal*100).toFixed(1)),receivable:Math.max(0,sales-collections),overdue:0,stockValue,deadStockValue:0,products,customers,leads,expenses:expenseTotal};
 const health=companyHealth({profitability:Math.min(100,Math.max(0,50+kpis.grossMarginPct*3)),salesGrowth:targetAchievement||50,collections:Math.min(100,kpis.collectionAchievement),inventory:stockValue?80:50,cashFlow:Math.min(100,kpis.collectionAchievement),customerQuality:customers?80:50,targetPerformance:targetAchievement||50,gstCompliance:90});
 const insights=buildInsights({kpis});
 const months=["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];const salesTrend=months.map((m,i)=>({month:m,sales:0}));for(const inv of invoices){const d=new Date(inv.date),fyMonth=(d.getMonth()+9)%12;salesTrend[fyMonth].sales+=Number(inv.subtotal||0)/100000}salesTrend.forEach(x=>x.sales=Number(x.sales.toFixed(2)));
 const admin = isAdminAuth(req.auth);
 const safeKpis = admin
   ? kpis
   : Object.fromEntries(Object.entries(kpis).filter(([key]) => !["grossProfit","grossMarginPct","greenSalesPct","blueSalesPct","redSalesPct"].includes(key)));
 const safeInsights = admin
   ? insights
   : (insights || []).filter((item) => !/(profit|margin|health)/i.test(`${item?.title || ""} ${item?.text || ""}`));
 return ok(res,{
   kpis:safeKpis,
   ...(admin ? {health,marginMix:[{name:"Green",value:kpis.greenSalesPct},{name:"Blue",value:kpis.blueSalesPct},{name:"Red",value:kpis.redSalesPct}]} : {}),
   insights:safeInsights,
   activeTargets:activeTargets.slice(0,5),
   salesTrend
 });
});
export default router;
