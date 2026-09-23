import express from "express";
import { Target, CustomerLink, GenericRecord } from "../models/index.js";
import { ok, fail } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { generateNextMonthTarget, weightedAchievement } from "../services/targetService.js";
import { financialModels } from "../services/accountingService.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { resolveFinancialYear } from "../utils/financialYear.js";
const router=express.Router();router.use(requireAuth);
router.use((req,res,next)=>{if(req.auth?.role==="MASTER"||(req.auth?.apps||[]).includes("dms"))return next();return fail(res,"DMS access required",403);});
router.get("/",async(req,res)=>{
  const tenantKey=req.auth.tenantKey,fy=await resolveFinancialYear({tenantKey,requested:req.query.financialYear});
  const targets=await Target.find({tenantKey,financialYear:fy}).sort({level:1,createdAt:-1}).lean();
  const {SalesInvoice,Receipt}=financialModels(tenantKey,fy);
  const [salesAgg,receiptAgg,visits]=await Promise.all([
    SalesInvoice.aggregate([{$match:{tenantKey,financialYear:fy,status:"POSTED"}},{$group:{_id:"$customerGlobalId",sales:{$sum:"$subtotal"},grossProfit:{$sum:"$grossProfit"}}}]),
    Receipt.aggregate([{$match:{tenantKey,financialYear:fy,status:"POSTED"}},{$group:{_id:"$customerGlobalId",collection:{$sum:"$amount"}}}]),
    GenericRecord.find({tenantKey,app:"dms",resource:"visits",status:"COMPLETED"}).select("title data assignedTo").lean()
  ]);
  const sm=new Map(salesAgg.map(x=>[String(x._id),x])),rm=new Map(receiptAgg.map(x=>[String(x._id),x]));
  const companySales=salesAgg.reduce((s,x)=>s+Number(x.sales||0),0),companyGp=salesAgg.reduce((s,x)=>s+Number(x.grossProfit||0),0),companyCollection=receiptAgg.reduce((s,x)=>s+Number(x.collection||0),0);
  const out=targets.map(t=>{let ach={...(t.achievement||{})};if(t.level==="COMPANY"){ach={...ach,sales:companySales,grossProfit:companyGp,collection:companyCollection,visits:visits.length};}else if(t.level==="CUSTOMER"){const s=sm.get(String(t.entityId))||{},r=rm.get(String(t.entityId))||{};ach={...ach,sales:Number(s.sales||0),grossProfit:Number(s.grossProfit||0),collection:Number(r.collection||0)};}const weights=t.weights||{};ach.overallScore=weightedAchievement({sales:t.annual?.sales?Math.min(200,ach.sales/t.annual.sales*100):0,grossProfit:t.annual?.grossProfit?Math.min(200,(ach.grossProfit||0)/t.annual.grossProfit*100):0,collection:t.annual?.collection?Math.min(200,(ach.collection||0)/t.annual.collection*100):0,newCustomers:0,leadsVisits:t.annual?.visits?Math.min(200,(ach.visits||0)/t.annual.visits*100):0},weights);return {...t,achievement:ach};});
  const safeOut=isAdminAuth(req.auth)?out:out.map(t=>{
    const row={...t,annual:{...(t.annual||{})},achievement:{...(t.achievement||{})},weights:{...(t.weights||{})}};
    delete row.annual.grossProfit;delete row.achievement.grossProfit;delete row.weights.grossProfit;
    return row;
  });
  ok(res,safeOut);
});
router.post("/yearly",async(req,res)=>{const fy=await resolveFinancialYear({tenantKey:req.auth.tenantKey,requested:req.body.financialYear});let annual={...(req.body.annual||{})},weights={...(req.body.weights||{})};if(!isAdminAuth(req.auth)){const prior=await Target.findOne({tenantKey:req.auth.tenantKey,financialYear:fy,level:"COMPANY",entityId:req.auth.tenantKey}).lean();delete annual.grossProfit;delete weights.grossProfit;delete weights.marginQuality;if(prior?.annual?.grossProfit!==undefined)annual.grossProfit=prior.annual.grossProfit;if(prior?.weights?.grossProfit!==undefined)weights.grossProfit=prior.weights.grossProfit;if(prior?.weights?.marginQuality!==undefined)weights.marginQuality=prior.weights.marginQuality;}const company=await Target.findOneAndUpdate({tenantKey:req.auth.tenantKey,financialYear:fy,level:"COMPANY",entityId:req.auth.tenantKey},{annual,weights,status:"PUBLISHED"},{upsert:true,new:true,setDefaultsOnInsert:true});const customers=await CustomerLink.find({tenantKey:req.auth.tenantKey,status:"ACTIVE"}).lean();const annualSales=Number(req.body.annual?.sales||0);const per=customers.length?annualSales/customers.length:0;for(const c of customers){await Target.findOneAndUpdate({tenantKey:req.auth.tenantKey,financialYear:fy,level:"CUSTOMER",entityId:c.globalCustomerId},{annual:{sales:per},status:"PUBLISHED"},{upsert:true,new:true,setDefaultsOnInsert:true});}ok(res,{company,customersDistributed:customers.length,perCustomerAnnualSales:per},"Yearly target published");});
router.put("/:id",async(req,res)=>{const t=await Target.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},req.body,{new:true,runValidators:true});if(!t)return fail(res,"Target not found",404);ok(res,t,"Target updated");});
router.delete("/:id",async(req,res)=>{const t=await Target.findOneAndDelete({_id:req.params.id,tenantKey:req.auth.tenantKey});if(!t)return fail(res,"Target not found",404);ok(res,{deleted:true},"Target deleted");});
router.post("/:id/recalculate",async(req,res)=>{const t=await Target.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey});if(!t)return fail(res,"Target not found",404);const next=generateNextMonthTarget({annualTarget:t.annual?.sales||0,achieved:req.body.achieved||0,remainingMonths:req.body.remainingMonths||1,seasonalityFactor:req.body.seasonalityFactor||1});const overall=weightedAchievement(req.body.achievement||{},t.weights?.toObject?.()||t.weights||{});t.achievement={...(t.achievement?.toObject?.()||{}),overallScore:overall};await t.save();ok(res,{target:t,nextMonth:next},"Target recalculated");});
export default router;
