import express from "express";
import multer from "multer";
import { Employee } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { readRows, resolveColumns, valueFor, cleanText } from "../utils/bulkSpreadsheet.js";

const router=express.Router();router.use(requireAuth);
router.use((req,res,next)=>{if(req.auth?.role==="MASTER"||(req.auth?.apps||[]).includes("hr"))return next();return fail(res,"HR access required",403);});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:30*1024*1024}});
const upper=v=>cleanText(v).toUpperCase();

router.get("/",async(req,res)=>{const page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=String(req.query.q||"").trim(),f={tenantKey:req.auth.tenantKey};if(req.query.status)f.status=req.query.status;if(q)f.$or=[{name:new RegExp(q,"i")},{employeeId:new RegExp(q,"i")},{department:new RegExp(q,"i")},{designation:new RegExp(q,"i")},{mobile:new RegExp(q,"i")},{email:new RegExp(q,"i")}];const[items,total]=await Promise.all([Employee.find(f).sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),Employee.countDocuments(f)]);ok(res,{items,meta:pageMeta(page,limit,total)});});
router.post("/",async(req,res)=>{if(!req.body.name)return fail(res,"Employee name is required");try{const employee=await Employee.create({...req.body,tenantKey:req.auth.tenantKey,employeeId:req.body.employeeId||makeId("EMP")});ok(res,employee,"Employee created",201);}catch(e){if(e?.code===11000)return fail(res,"Employee ID already exists",409);throw e;}});

router.post("/bulk-upload",upload.single("file"),async(req,res)=>{
  if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);let rows;try{rows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read Excel/CSV file",400);}if(!rows.length)return fail(res,"Uploaded file has no rows",400);
  const fields=[{key:"employeeId",label:"Employee ID",aliases:["emp id"]},{key:"name",label:"Employee Name",aliases:["name"],required:true},{key:"mobile",label:"Mobile"},{key:"email",label:"Email"},{key:"joiningDate",label:"Joining Date",type:"date"},{key:"department",label:"Department"},{key:"designation",label:"Designation"},{key:"team",label:"Team"},{key:"branch",label:"Branch"},{key:"shift",label:"Shift"},{key:"salary",label:"Monthly Salary",type:"number"},{key:"employmentType",label:"Employment Type"},{key:"status",label:"Status"}];
  const cols=resolveColumns(rows[0],fields);if(!cols.name)return fail(res,"Missing column: Employee Name",400);const errors=[],ops=[];
  rows.forEach((raw,index)=>{const row={tenantKey:req.auth.tenantKey};for(const f of fields){const v=valueFor(raw,cols[f.key],f.type);if(v!==undefined&&v!=="")row[f.key]=v;}if(!row.name){if(errors.length<100)errors.push({row:index+2,error:"Employee Name is required"});return;}row.employeeId=upper(row.employeeId)||makeId("EMP");row.employmentType=upper(row.employmentType||"FULL_TIME");row.status=upper(row.status||"ACTIVE");row.salary=Number(row.salary||0);ops.push({updateOne:{filter:{tenantKey:req.auth.tenantKey,employeeId:row.employeeId},update:{$set:{...row,updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},upsert:true}});});
  let inserted=0,updated=0;for(let i=0;i<ops.length;i+=1000){const r=await Employee.bulkWrite(ops.slice(i,i+1000),{ordered:false});inserted+=r.upsertedCount||0;updated+=r.modifiedCount||0;}ok(res,{received:rows.length,valid:ops.length,inserted,updated,invalid:errors.length,errors},"Employee bulk upload completed");
});
router.post("/bulk-edit",async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select at least one employee",400);const allowed=["department","designation","team","branch","territoryId","reportsTo","employmentType","shift","salary","status"];const changes={};for(const k of allowed)if(req.body.changes?.[k]!==undefined&&req.body.changes[k]!=="")changes[k]=req.body.changes[k];if(changes.salary!==undefined)changes.salary=Number(changes.salary);if(changes.employmentType)changes.employmentType=upper(changes.employmentType);if(changes.status)changes.status=upper(changes.status);if(!Object.keys(changes).length)return fail(res,"Enter at least one value to change",400);const result=await Employee.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:changes},{runValidators:true});ok(res,{matched:result.matchedCount,updated:result.modifiedCount},`${result.modifiedCount} employee(s) updated`);});
router.post("/bulk-delete",async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select at least one employee",400);const result=await Employee.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:{status:"INACTIVE"}});ok(res,{deleted:result.modifiedCount,soft:true},`${result.modifiedCount} employee(s) deactivated`);});
router.put("/:id",async(req,res)=>{const e=await Employee.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},req.body,{new:true,runValidators:true});if(!e)return fail(res,"Employee not found",404);ok(res,e,"Employee updated");});
router.delete("/:id",async(req,res)=>{const e=await Employee.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},{status:"INACTIVE"},{new:true});if(!e)return fail(res,"Employee not found",404);ok(res,{deleted:true,soft:true},"Employee deactivated");});
export default router;
