import express from "express";
import crypto from "node:crypto";
import multer from "multer";
import { Transporter, GlobalTransporterMaster, GlobalTransporterStation, GlobalTransporterLane, Territory, Pincode } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { readRows, resolveColumns, valueFor, cleanText } from "../utils/bulkSpreadsheet.js";

const router=express.Router();router.use(requireAuth);
router.use((req,res,next)=>{if(req.auth?.role==="MASTER"||(req.auth?.apps||[]).includes("dms"))return next();return fail(res,"DMS access required",403);});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:30*1024*1024}});
const upper=v=>cleanText(v).toUpperCase();

const regexSafe=v=>cleanText(v).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const stationIdFor=(globalId,name,pincode)=>`GTS-${crypto.createHash("sha1").update(`${globalId}|${cleanText(name).toLowerCase()}|${cleanText(pincode)}`).digest("hex").slice(0,12).toUpperCase()}`;
const globalKeyFor=(name,mobile="",address="")=>crypto.createHash("sha1").update(`${cleanText(name).toLowerCase()}|${cleanText(mobile)}|${cleanText(address).toLowerCase()}`).digest("hex");
const globalIdFor=key=>`GTR-${key.slice(0,12).toUpperCase()}`;
async function geoFromPincode(pincode){
  const pin=String(pincode||"").replace(/\D/g,"").slice(0,6);if(pin.length!==6)return {pincode:pin};
  const row=await Pincode.findOne({pincode:pin,status:{$ne:"INACTIVE"}}).sort({area:1}).lean();
  return {pincode:pin,area:cleanText(row?.area),city:cleanText(row?.city||row?.area),district:cleanText(row?.district),state:cleanText(row?.state)};
}
async function ensureGlobalTransporterFromCompany(payload={}){
  const name=cleanText(payload.name);if(!name)throw Object.assign(new Error("Transporter name is required"),{statusCode:400});
  const firstStation=(payload.stations||[])[0]||{};const firstContact=(firstStation.contacts||[])[0]||{};
  let global=payload.globalTransporterId?await GlobalTransporterMaster.findOne({globalTransporterId:payload.globalTransporterId}):null;
  if(!global){
    const key=globalKeyFor(name,firstContact.phone,firstStation.address);const gid=globalIdFor(key);
    global=await GlobalTransporterMaster.findOne({$or:[{globalTransporterId:gid},{masterKey:key}]});
    if(!global)global=new GlobalTransporterMaster({masterKey:key,globalTransporterId:gid});
  }
  global.name=name;global.address=cleanText(firstStation.address||global.address);global.pincode=cleanText(firstStation.pincode||global.pincode);global.contactPerson=cleanText(firstContact.name||global.contactPerson);global.mobile=cleanText(firstContact.phone||global.mobile);global.email=cleanText(firstContact.email||global.email).toLowerCase();
  const geo=await geoFromPincode(firstStation.pincode);const cat=[cleanText(firstStation.name),geo.city].filter(Boolean);global.categories=[...new Set([...(global.categories||[]),...cat])];global.directoryGroups=[...new Set([...(global.directoryGroups||[]),geo.state].filter(Boolean))];global.sourceName=global.sourceName||"Rupioo DMS";global.status="ACTIVE";await global.save();
  for(const st of payload.stations||[]){
    if(!cleanText(st.name)&&!cleanText(st.pincode))continue;const g=await geoFromPincode(st.pincode);const sid=stationIdFor(global.globalTransporterId,st.name||g.city||name,st.pincode);
    await GlobalTransporterStation.findOneAndUpdate({stationId:sid},{$set:{stationId:sid,globalTransporterId:global.globalTransporterId,name:cleanText(st.name||g.city||name),stationType:upper(st.type||"BOTH"),address:cleanText(st.address),pincode:g.pincode||cleanText(st.pincode),area:g.area||"",city:g.city||cleanText(st.city),district:g.district||"",state:g.state||cleanText(st.state),contacts:Array.isArray(st.contacts)?st.contacts:[],servicePincodes:[...new Set([g.pincode,...(Array.isArray(st.servicePincodes)?st.servicePincodes:[]).map(x=>String(x).replace(/\D/g,"").slice(0,6))].filter(Boolean))],serviceCities:[...new Set([g.city,...(Array.isArray(st.serviceCities)?st.serviceCities:[]).map(cleanText)].filter(Boolean))],serviceStates:[...new Set([g.state,...(Array.isArray(st.serviceStates)?st.serviceStates:[]).map(cleanText)].filter(Boolean))],status:"ACTIVE"}},{upsert:true,new:true,setDefaultsOnInsert:true});
  }
  return global;
}

router.get("/transporters",async(req,res)=>{
  const page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=cleanText(req.query.q),filter={tenantKey:req.auth.tenantKey};
  if(req.query.status)filter.status=req.query.status;if(q)filter.$or=[{name:new RegExp(q,"i")},{gstin:new RegExp(q,"i")},{pan:new RegExp(q,"i")},{"stations.name":new RegExp(q,"i")},{"stations.contacts.phone":new RegExp(q,"i")}];
  const[items,total]=await Promise.all([Transporter.find(filter).sort({name:1}).skip((page-1)*limit).limit(limit).lean(),Transporter.countDocuments(filter)]);ok(res,{items,meta:pageMeta(page,limit,total)});
});

router.get("/transporters/global-search",async(req,res)=>{
  const q=cleanText(req.query.q);if(q.length<2)return ok(res,{items:[]});const safe=regexSafe(q);
  const filter={status:"ACTIVE",$or:[{name:new RegExp(safe,"i")},{address:new RegExp(safe,"i")},{contactPerson:new RegExp(safe,"i")},{mobile:new RegExp(safe,"i")},{email:new RegExp(safe,"i")},{directoryGroups:new RegExp(safe,"i")},{categories:new RegExp(safe,"i")}]};
  const items=await GlobalTransporterMaster.find(filter).sort({name:1}).limit(30).lean();ok(res,{items});
});

router.get("/transporters/service-match",async(req,res)=>{
  const pincode=String(req.query.pincode||"").replace(/\D/g,"").slice(0,6),city=cleanText(req.query.city),state=cleanText(req.query.state);
  if(!pincode&&!city&&!state)return ok(res,{items:[]});
  const primaryOr=[];if(pincode){primaryOr.push({pincode},{servicePincodes:pincode});}if(city){const r=new RegExp(`^${regexSafe(city)}$`,"i");primaryOr.push({city:r},{serviceCities:r},{name:r});}
  let stations=primaryOr.length?await GlobalTransporterStation.find({status:"ACTIVE",stationType:{$in:["DELIVERY","BOTH"]},$or:primaryOr}).limit(500).lean():[];
  if(!stations.length&&state){const r=new RegExp(`^${regexSafe(state)}$`,"i");stations=await GlobalTransporterStation.find({status:"ACTIVE",stationType:{$in:["DELIVERY","BOTH"]},$or:[{state:r},{serviceStates:r}]}).limit(250).lean();}
  const byGlobal=new Map();for(const st of stations){let score=0;if(pincode&&st.pincode===pincode)score=100;else if(pincode&&(st.servicePincodes||[]).includes(pincode))score=95;else if(city&&String(st.city||"").toLowerCase()===city.toLowerCase())score=85;else if(city&&(st.serviceCities||[]).some(x=>String(x).toLowerCase()===city.toLowerCase()))score=80;else if(state&&String(st.state||"").toLowerCase()===state.toLowerCase())score=55;else score=40;const arr=byGlobal.get(st.globalTransporterId)||[];arr.push({...st,_score:score});byGlobal.set(st.globalTransporterId,arr);}
  let gids=[...byGlobal.keys()];
  if(!gids.length){
    const fallbackOr=[];if(city){const r=new RegExp(regexSafe(city),"i");fallbackOr.push({categories:r},{directoryGroups:r},{address:r});}if(state){const r=new RegExp(regexSafe(state),"i");fallbackOr.push({directoryGroups:r},{address:r});}if(pincode)fallbackOr.push({pincode});
    const fallback=await GlobalTransporterMaster.find({status:"ACTIVE",$or:fallbackOr}).limit(60).lean();for(const g of fallback){byGlobal.set(g.globalTransporterId,[]);}gids=fallback.map(x=>x.globalTransporterId);
  }
  const [globals,locals,bookingStations]=await Promise.all([
    GlobalTransporterMaster.find({globalTransporterId:{$in:gids},status:"ACTIVE"}).lean(),
    Transporter.find({tenantKey:req.auth.tenantKey,globalTransporterId:{$in:gids},status:{$ne:"INACTIVE"}}).lean(),
    GlobalTransporterStation.find({globalTransporterId:{$in:gids},status:"ACTIVE",stationType:{$in:["BOOKING","BOTH"]}}).lean()
  ]);
  const localMap=new Map(locals.map(x=>[x.globalTransporterId,x]));const bookingMap=new Map();for(const st of bookingStations){const a=bookingMap.get(st.globalTransporterId)||[];a.push(st);bookingMap.set(st.globalTransporterId,a);}
  const items=globals.map(g=>{const delivery=(byGlobal.get(g.globalTransporterId)||[]).sort((a,b)=>b._score-a._score);const score=delivery[0]?._score||35;return {_id:g._id,globalTransporterId:g.globalTransporterId,name:g.name,address:g.address,mobile:g.mobile,email:g.email,score,localTransporterId:localMap.get(g.globalTransporterId)?._id||"",needsImport:!localMap.has(g.globalTransporterId),deliveryStations:delivery.slice(0,20),bookingStations:(bookingMap.get(g.globalTransporterId)||[]).slice(0,20)};}).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,80);
  ok(res,{items,destination:{pincode,city,state}});
});

router.get("/transporters/:globalId/stations",async(req,res)=>{
  const items=await GlobalTransporterStation.find({globalTransporterId:req.params.globalId,status:"ACTIVE"}).sort({state:1,city:1,name:1}).lean();ok(res,{items});
});

router.post("/transporters/import-global/:id",async(req,res)=>{
  const g=await GlobalTransporterMaster.findOne({_id:req.params.id,status:"ACTIVE"}).lean();if(!g)return fail(res,"Global transporter not found",404);
  const gst=await GlobalTransporterStation.find({globalTransporterId:g.globalTransporterId,status:"ACTIVE"}).lean();
  const stations=gst.map(st=>({name:st.name,type:st.stationType,address:st.address,pincode:st.pincode,latitude:st.latitude,longitude:st.longitude,contacts:st.contacts||[]}));
  if(!stations.length&&((g.categories||[]).length||g.address||g.pincode))stations.push({name:(g.categories||[])[0]||g.address||g.name,type:"BOTH",address:g.address||"",pincode:g.pincode||"",contacts:(g.contactPerson||g.mobile||g.email)?[{name:g.contactPerson||"",designation:"",phone:g.mobile||g.landline||"",email:g.email||"",active:true}]:[]});
  const set={tenantKey:req.auth.tenantKey,globalTransporterId:g.globalTransporterId,name:g.name,stations,status:"ACTIVE"};
  let t=await Transporter.findOne({tenantKey:req.auth.tenantKey,globalTransporterId:g.globalTransporterId});if(t){t.set(set);await t.save();return ok(res,t,"Global transporter refreshed in company list");}
  t=await Transporter.create({...set,paymentTerms:"",freightNotes:""});return ok(res,t,"Global transporter added to company list",201);
});

router.post("/transporters",async(req,res)=>{
  if(!req.body.name)return fail(res,"Transporter name is required");
  try{const global=await ensureGlobalTransporterFromCompany(req.body);const t=await Transporter.create({...req.body,globalTransporterId:global.globalTransporterId,tenantKey:req.auth.tenantKey});ok(res,t,"Transporter created and added to Global MASTER",201);}catch(e){return fail(res,e.message||"Unable to create transporter",e.statusCode||400);}
});

router.post("/transporters/bulk-upload",upload.single("file"),async(req,res)=>{
  if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);let rows;try{rows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read Excel/CSV file",400);}if(!rows.length)return fail(res,"Uploaded file has no rows",400);
  const fields=[{key:"name",label:"Transporter Name",required:true},{key:"gstin",label:"GSTIN"},{key:"pan",label:"PAN"},{key:"stationName",label:"Station Name"},{key:"stationType",label:"Station Type"},{key:"address",label:"Station Address"},{key:"pincode",label:"Pincode"},{key:"contactName",label:"Contact Person"},{key:"designation",label:"Designation"},{key:"phone",label:"Phone"},{key:"email",label:"Email"},{key:"paymentTerms",label:"Payment Terms"},{key:"freightNotes",label:"Freight Notes"},{key:"status",label:"Status"}];
  const cols=resolveColumns(rows[0],fields);if(!cols.name)return fail(res,"Missing column: Transporter Name",400);const errors=[];let inserted=0,updated=0;
  for(let i=0;i<rows.length;i++){
    const r={};for(const f of fields){const v=valueFor(rows[i],cols[f.key],f.type);if(v!==undefined&&v!=="")r[f.key]=v;}if(!r.name){if(errors.length<100)errors.push({row:i+2,error:"Transporter Name is required"});continue;}
    const stations=r.stationName?[{name:r.stationName,type:upper(r.stationType||"BOTH"),address:r.address||"",pincode:String(r.pincode||""),contacts:(r.contactName||r.phone)?[{name:r.contactName||"",designation:r.designation||"",phone:r.phone||"",email:r.email||"",active:true}]:[]}]:[];
    try{const global=await ensureGlobalTransporterFromCompany({name:r.name,stations});const filter=r.gstin?{tenantKey:req.auth.tenantKey,gstin:upper(r.gstin)}:{tenantKey:req.auth.tenantKey,name:r.name};const result=await Transporter.updateOne(filter,{$set:{tenantKey:req.auth.tenantKey,globalTransporterId:global.globalTransporterId,name:r.name,gstin:upper(r.gstin),pan:upper(r.pan),stations,paymentTerms:r.paymentTerms||"",freightNotes:r.freightNotes||"",status:upper(r.status||"ACTIVE"),updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},{upsert:true});if(result.upsertedCount)inserted++;else if(result.modifiedCount)updated++;}catch(e){if(errors.length<100)errors.push({row:i+2,error:e.message});}
  }
  ok(res,{received:rows.length,valid:rows.length-errors.length,inserted,updated,invalid:errors.length,errors},"Transporter bulk upload completed");
});
router.post("/transporters/bulk-edit",async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select at least one transporter",400);const allowed=["paymentTerms","freightNotes","status"];const changes={};for(const k of allowed)if(req.body.changes?.[k]!==undefined&&req.body.changes[k]!=="")changes[k]=k==="status"?upper(req.body.changes[k]):req.body.changes[k];if(!Object.keys(changes).length)return fail(res,"Enter at least one value to change",400);const result=await Transporter.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:changes});ok(res,{matched:result.matchedCount,updated:result.modifiedCount},`${result.modifiedCount} transporter(s) updated`);});
router.post("/transporters/bulk-delete",async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select at least one transporter",400);const result=await Transporter.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:{status:"INACTIVE"}});ok(res,{deleted:result.modifiedCount,soft:true},`${result.modifiedCount} transporter(s) deactivated`);});
router.put("/transporters/:id",async(req,res)=>{const current=await Transporter.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey});if(!current)return fail(res,"Transporter not found",404);const global=await ensureGlobalTransporterFromCompany({...req.body,globalTransporterId:req.body.globalTransporterId||current.globalTransporterId});current.set({...req.body,globalTransporterId:global.globalTransporterId});await current.save();ok(res,current,"Transporter updated and Global MASTER stations synced");});
router.delete("/transporters/:id",async(req,res)=>{const t=await Transporter.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},{status:"INACTIVE"},{new:true});if(!t)return fail(res,"Transporter not found",404);ok(res,{deleted:true,soft:true},"Transporter deactivated");});

router.get("/territories",async(req,res)=>{
  const page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=cleanText(req.query.q),filter={tenantKey:req.auth.tenantKey};if(req.query.status)filter.status=req.query.status;if(q)filter.$or=[{name:new RegExp(q,"i")},{pincodes:new RegExp(q,"i")}];
  const[items,total]=await Promise.all([Territory.find(filter).sort({name:1}).skip((page-1)*limit).limit(limit).lean(),Territory.countDocuments(filter)]);ok(res,{items,meta:pageMeta(page,limit,total)});
});
router.post("/territories",async(req,res)=>{if(!req.body.name)return fail(res,"Territory name is required");const t=await Territory.create({...req.body,tenantKey:req.auth.tenantKey,pincodes:(req.body.pincodes||[]).map(String)});ok(res,t,"Territory created",201);});
router.post("/territories/bulk-upload",upload.single("file"),async(req,res)=>{
  if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);let rows;try{rows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read Excel/CSV file",400);}if(!rows.length)return fail(res,"Uploaded file has no rows",400);
  const fields=[{key:"name",label:"Territory Name",required:true},{key:"pincodes",label:"Pincodes"},{key:"userId",label:"Primary Salesperson ID"},{key:"managerId",label:"Manager ID"},{key:"status",label:"Status"}];const cols=resolveColumns(rows[0],fields);if(!cols.name)return fail(res,"Missing column: Territory Name",400);const errors=[],ops=[];
  for(let i=0;i<rows.length;i++){
    const r={};for(const f of fields){const v=valueFor(rows[i],cols[f.key],f.type);if(v!==undefined&&v!=="")r[f.key]=v;}if(!r.name){if(errors.length<100)errors.push({row:i+2,error:"Territory Name is required"});continue;}const pins=String(r.pincodes||"").split(/[,;\s]+/).map(x=>x.trim()).filter(Boolean);if(pins.length){const count=await Pincode.countDocuments({pincode:{$in:pins}});if(count===0){if(errors.length<100)errors.push({row:i+2,error:"None of the supplied pincodes exist in MASTER"});continue;}}
    ops.push({updateOne:{filter:{tenantKey:req.auth.tenantKey,name:r.name},update:{$set:{tenantKey:req.auth.tenantKey,name:r.name,pincodes:pins,userId:r.userId||"",managerId:r.managerId||"",status:upper(r.status||"ACTIVE"),updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},upsert:true}});
  }
  let inserted=0,updated=0;for(let i=0;i<ops.length;i+=500){const r=await Territory.bulkWrite(ops.slice(i,i+500),{ordered:false});inserted+=r.upsertedCount||0;updated+=r.modifiedCount||0;}ok(res,{received:rows.length,valid:ops.length,inserted,updated,invalid:errors.length,errors},"Territory bulk upload completed");
});
router.post("/territories/bulk-edit",async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select at least one territory",400);const allowed=["userId","managerId","status"];const changes={};for(const k of allowed)if(req.body.changes?.[k]!==undefined&&req.body.changes[k]!=="")changes[k]=k==="status"?upper(req.body.changes[k]):req.body.changes[k];if(!Object.keys(changes).length)return fail(res,"Enter at least one value to change",400);const result=await Territory.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:changes});ok(res,{matched:result.matchedCount,updated:result.modifiedCount},`${result.modifiedCount} territory(s) updated`);});
router.post("/territories/bulk-delete",async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select at least one territory",400);const result=await Territory.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:{status:"INACTIVE"}});ok(res,{deleted:result.modifiedCount,soft:true},`${result.modifiedCount} territory(s) deactivated`);});
router.put("/territories/:id",async(req,res)=>{const payload={...req.body};if(payload.pincodes)payload.pincodes=payload.pincodes.map(String);const t=await Territory.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},payload,{new:true,runValidators:true});if(!t)return fail(res,"Territory not found",404);ok(res,t,"Territory updated");});
router.delete("/territories/:id",async(req,res)=>{const t=await Territory.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},{status:"INACTIVE"},{new:true});if(!t)return fail(res,"Territory not found",404);ok(res,{deleted:true,soft:true},"Territory deactivated");});
export default router;
