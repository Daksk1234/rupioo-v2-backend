import express from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { LegacyMigrationRun, LegacyMigrationItem, LegacyMigrationMap } from "../models/index.js";
import { parseLegacyUpload, buildMigrationPreview, importLegacyData, activateExistingLegacyImports } from "../services/legacyMigrationService.js";

const router=express.Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:150*1024*1024}});
const previewCache=new Map();
const requireMigrationAdmin=(req,res,next)=>isAdminAuth(req.auth)?next():fail(res,"Only Admin/Superadmin can migrate Previous DMS data",403);

router.use(requireAuth,requireMigrationAdmin);

router.post("/preview",upload.single("file"),(req,res)=>{
  try{
    if(!req.file) return fail(res,"Select the Previous DMS database export",400);
    const data=parseLegacyUpload(req.file);
    const preview=buildMigrationPreview(data);
    if(!preview.total) return fail(res,"No supported master records found. Export users/customers/products/units/categories/transporters/banks/warehouses/branches as JSON/CSV/Excel and upload them, preferably inside one ZIP.",400);
    const token=`mig_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
    previewCache.set(token,{data,fileName:req.file.originalname,tenantKey:req.auth.tenantKey,expires:Date.now()+30*60*1000});
    for(const [key,val] of previewCache){if(val.expires<Date.now())previewCache.delete(key);}
    return ok(res,{token,fileName:req.file.originalname,...preview},"Previous DMS export checked. Nothing has been written yet.");
  }catch(error){return fail(res,error.message,error.statusCode||400);}
});

router.post("/import",async(req,res,next)=>{
  try{
    const token=String(req.body?.token||""); const cached=previewCache.get(token);
    if(!cached||cached.expires<Date.now()) return fail(res,"Migration preview expired. Upload the database export again.",400);
    if(cached.tenantKey!==req.auth.tenantKey) return fail(res,"Migration session does not belong to this company",403);
    const run=await importLegacyData({data:cached.data,tenantKey:req.auth.tenantKey,tenantId:req.auth.tenantId,userId:req.auth.sub,fileName:cached.fileName});
    previewCache.delete(token);
    return ok(res,run,"Previous DMS masters imported into V2");
  }catch(error){next(error);}
});


router.post("/activate-existing",async(req,res,next)=>{
  try{
    const result=await activateExistingLegacyImports({tenantKey:req.auth.tenantKey,userId:req.auth.sub});
    return ok(res,result,`${result.processed} previous migration issue(s) converted to active records with pending profile fields.`);
  }catch(error){next(error);}
});
router.get("/runs",async(req,res,next)=>{try{const rows=await LegacyMigrationRun.find({tenantKey:req.auth.tenantKey}).sort({createdAt:-1}).limit(50).lean();return ok(res,rows);}catch(e){next(e)}});
router.get("/issues",async(req,res,next)=>{try{const runId=String(req.query.runId||"");const filter={tenantKey:req.auth.tenantKey,status:{$in:["PENDING_FIELDS","NEEDS_COMPLETION"]}};if(runId)filter.runId=runId;const rows=await LegacyMigrationItem.find(filter).sort({entity:1,createdAt:1}).limit(1000).lean();return ok(res,rows);}catch(e){next(e)}});
router.get("/map",async(req,res,next)=>{try{const rows=await LegacyMigrationMap.find({tenantKey:req.auth.tenantKey}).sort({entity:1,legacyId:1}).limit(5000).lean();return ok(res,rows);}catch(e){next(e)}});

export default router;
