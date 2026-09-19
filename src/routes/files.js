import express from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { saveUploadedFile, readFile } from "../services/storageService.js";
const router=express.Router(),upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024}});router.use(requireAuth);
router.post("/upload",upload.single("file"),async(req,res)=>{if(!req.file)return fail(res,"File required");const meta=await saveUploadedFile({file:req.file,tenantKey:req.auth.tenantKey,module:req.body.module,entityType:req.body.entityType,entityId:req.body.entityId,uploadedBy:req.auth.sub,access:req.body.access||"PRIVATE"});ok(res,meta,"File uploaded",201);});
router.get("/:fileId",async(req,res)=>{const result=await readFile(req.params.fileId);if(!result)return fail(res,"File not found",404);res.setHeader("Content-Type",result.meta.mimeType||"application/octet-stream");res.setHeader("Content-Disposition",`inline; filename=\"${result.meta.originalName}\"`);res.send(result.buffer);});
export default router;
