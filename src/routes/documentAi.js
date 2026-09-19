import express from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.js";
import { GenericRecord } from "../models/index.js";
import { saveUploadedFile } from "../services/storageService.js";
import { ok, fail } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { getDocumentTemplate, listDocumentTemplates } from "../config/documentForms.js";
import { canPageAction } from "../config/permissionPageMap.js";
import { extractDocument, enrichExtractedValues } from "../services/documentAiService.js";

const router = express.Router();
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:30*1024*1024 } });
router.use(requireAuth);

const DOCUMENT_PAGE_ACCESS = {
  CUSTOMER: { path: "/dms/customers", action: "create" },
  USER: { path: "/dms/users", action: "create" },
  TRANSPORTER: { path: "/dms/transporters", action: "create" },
  PRODUCT: { path: "/dms/products", action: "create" },
  SALES_INVOICE: { path: "/dms/sales-invoices", action: "create" },
  PURCHASE_INVOICE: { path: "/dms/purchase-invoices", action: "create" },
  LEAD: { path: "/dms/leads", action: "create" },
  EXPENSE: { path: "/dms/expenses", action: "create" },
  DELIVERY_PROOF: { path: "/dms/sales-invoices", action: "edit" }
};

function documentAccess(req, type, requestedAction) {
  if (req.auth?.role === "MASTER") return true;
  const rule = DOCUMENT_PAGE_ACCESS[String(type || "").toUpperCase()];
  if (!rule) return false;
  const action = requestedAction || rule.action;
  return canPageAction(req.auth?.permissions || [], rule.path, action);
}

function requireDocumentAccess(req, res, type, action) {
  if (documentAccess(req, type, action)) return true;
  fail(res, `Permission required for ${String(type || "document").replaceAll("_", " ")}`, 403);
  return false;
}

router.get("/templates", (req,res)=>{
  const templates=listDocumentTemplates().filter((t)=>documentAccess(req,t.type,"view") || documentAccess(req,t.type));
  return ok(res,templates,"Scan & Fill templates");
});
router.get("/templates/:type", (req,res)=>{
  const template=getDocumentTemplate(req.params.type); if(!template)return fail(res,"Unknown Scan & Fill template",404);
  if(!requireDocumentAccess(req,res,template.type,"view")) return;
  return ok(res,template);
});

router.post("/extract", upload.single("document"), async(req,res)=>{
  try {
    if(!req.file) return fail(res,"Image or PDF is required",400);
    const template=getDocumentTemplate(req.body.documentType); if(!template)return fail(res,"Select a valid document type",400);
    if(!requireDocumentAccess(req,res,template.type)) return;
    const allowed=["application/pdf","image/jpeg","image/png","image/webp","image/gif"];
    if(!allowed.includes(String(req.file.mimetype||"").toLowerCase())) return fail(res,"Use PDF, JPG, PNG, WEBP or non-animated GIF",400);
    const scanId=makeId("SCAN");
    const fileMeta=await saveUploadedFile({file:req.file,tenantKey:req.auth.tenantKey,module:"document-ai",entityType:template.type,entityId:scanId,uploadedBy:req.auth.sub,access:"PRIVATE"});
    const raw=await extractDocument({file:req.file,template});
    const extraction=await enrichExtractedValues({tenantKey:req.auth.tenantKey,template,extraction:raw});
    const record=await GenericRecord.create({tenantKey:req.auth.tenantKey,app:"dms",resource:"document_scan",reference:scanId,title:`${template.type} • ${req.file.originalname}`,status:"EXTRACTED",createdBy:req.auth.sub,data:{documentType:template.type,templateVersion:template.version,fileId:fileMeta.fileId,originalName:req.file.originalname,mimeType:req.file.mimetype,formId:extraction.formId||"",extractionEngine:extraction.engine||raw.engine||"",extraction}});
    return ok(res,{scanId,recordId:String(record._id),fileId:fileMeta.fileId,documentType:template.type,template,extraction},`Document read${extraction.engine ? ` with ${extraction.engine === "OLD_DMS_PDF" ? "local old-DMS parser" : extraction.engine}` : ""}. Review highlighted fields before applying.`,201);
  } catch(error) { return fail(res,error.message,400); }
});

router.post("/scans/:scanId/review", async(req,res)=>{
  const record=await GenericRecord.findOne({tenantKey:req.auth.tenantKey,app:"dms",resource:"document_scan",reference:req.params.scanId});
  if(!record)return fail(res,"Scan record not found",404);
  if(!requireDocumentAccess(req,res,record.data?.documentType)) return;
  record.status=req.body.status||"REVIEWED";
  record.updatedBy=req.auth.sub;
  record.data={...(record.data||{}),correctedValues:req.body.values||{},correctedItems:req.body.items||[],reviewedAt:new Date(),targetPath:req.body.targetPath||""};
  await record.save();
  return ok(res,{scanId:record.reference,status:record.status},"Scan review saved");
});

router.get("/scans", async(req,res)=>{
  const rows=await GenericRecord.find({tenantKey:req.auth.tenantKey,app:"dms",resource:"document_scan"}).sort({createdAt:-1}).limit(100).lean();
  return ok(res,rows);
});

export default router;
