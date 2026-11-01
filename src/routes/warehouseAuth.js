import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { GenericRecord } from "../models/index.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { ok,fail } from "../utils/http.js";
const router=express.Router();
router.post("/login",async(req,res)=>{
  try{
    const email=String(req.body?.email||"").trim().toLowerCase();
    const password=String(req.body?.password||"");
    if(!email||!password)return fail(res,"Email and password are required",400);
    const rows=await GenericRecord.find({app:"dms",resource:"warehouses",status:"ACTIVE","data.loginEmail":email}).select("_id tenantKey title data").lean();
    // Reject ambiguous duplicate credentials instead of silently choosing another tenant.
    const matches=[];
    for(const item of rows){if(item.data?.passwordHash && await bcrypt.compare(password,item.data.passwordHash))matches.push(item);}
    if(matches.length!==1)return fail(res,matches.length?"Warehouse email is assigned more than once; contact Superadmin":"Invalid warehouse email or password",401);
    const row=matches[0];
    const token=jwt.sign({sub:String(row._id),tenantKey:row.tenantKey,role:"WAREHOUSE",warehouseId:String(row._id),name:row.title,dataScope:"WAREHOUSE",apps:["dms"],tokenVersion:3},env.jwtSecret,{expiresIn:"12h"});
    return ok(res,{token,warehouse:{id:String(row._id),name:row.title,isMain:Boolean(row.data?.isMainWarehouse)}},"Warehouse login successful");
  }catch(e){return fail(res,e.message,500)}
});
router.get("/me",requireAuth,async(req,res)=>{
  if(req.auth.role!=="WAREHOUSE")return fail(res,"Warehouse login required",403);
  const row=await GenericRecord.findOne({_id:req.auth.warehouseId,tenantKey:req.auth.tenantKey,app:"dms",resource:"warehouses",status:"ACTIVE"}).select("_id title data.isMainWarehouse").lean();
  if(!row)return fail(res,"Warehouse no longer active",401);
  return ok(res,{id:String(row._id),name:row.title,isMain:Boolean(row.data?.isMainWarehouse)});
});
export default router;
