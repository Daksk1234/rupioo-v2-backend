import express from "express";
import { Pincode, Hsn, IfscMaster, Unit, AccountTemplate, Branding } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import { searchTaxpayer, configurationStatus } from "../services/masterGstService.js";
import { ensureDefaultTallyAccountTypes } from "../config/defaultTallyAccountTypes.js";
import { formatIfscContact, getIfscMaster, ifscSnapshot } from "../services/ifscMasterService.js";

const router = express.Router();
router.use(requireAuth);

router.get("/pincodes", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = q ? { $or: [
    { pincode: new RegExp(q, "i") },
    { area: new RegExp(q, "i") },
    { city: new RegExp(q, "i") },
    { district: new RegExp(q, "i") },
    { state: new RegExp(q, "i") }
  ] } : {};
  const rows=await Pincode.find(filter).sort({pincode:1,area:1}).limit(50).lean();
  ok(res, rows);
});

// Exact MASTER pincode lookup used by User and Customer forms.
// This deliberately reads the global MASTER Pincode collection, not any FY DB.
router.get("/pincodes/:pincode", async (req,res) => {
  const pincode=String(req.params.pincode||"").replace(/\D/g,"").slice(0,6);
  if(!/^\d{6}$/.test(pincode)) return res.status(400).json({ok:false,message:"Pincode must be exactly 6 digits"});
  const rows=await Pincode.find({pincode,status:{$ne:"INACTIVE"}}).sort({area:1}).lean();
  if(!rows.length) return res.status(404).json({ok:false,message:`Pincode ${pincode} not found in MASTER Pincode data`});
  const primary=rows.find(r=>String(r.city||"").trim())||rows[0];
  ok(res,{
    ...primary,
    pincode,
    area:String(primary.area||"").trim(),
    city:String(primary.city||"").trim(),
    district:String(primary.district||"").trim(),
    state:String(primary.state||"").trim(),
    alternatives:rows.map(r=>({area:r.area||"",city:r.city||"",district:r.district||"",state:r.state||""}))
  });
});

router.get("/hsn", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter = q ? {
    status: { $ne: "INACTIVE" },
    $or: [
      // Code search is deliberately prefix-first: typing 44 shows 44xxxx,
      // typing 4411 narrows it further. Description text can still be searched.
      { code: new RegExp(`^${safe}`, "i") },
      { description: new RegExp(safe, "i") }
    ]
  } : { status: { $ne: "INACTIVE" } };
  const rows = await Hsn.find(filter).sort({ code: 1 }).limit(limit).lean();
  ok(res, rows);
});

router.get("/hsn/:code", async (req,res) => {
  const code=String(req.params.code||"").trim().toUpperCase();
  const row=await Hsn.findOne({code,status:{$ne:"INACTIVE"}}).lean();
  if(!row)return res.status(404).json({ok:false,message:`HSN/SAC ${code} not found in MASTER`});
  return ok(res,row);
});

// Diagnostic endpoint: never returns secret values.
router.get("/gst/status", (_req, res) => ok(res, configurationStatus()));

// Direct GSTIN lookup before a customer is created.
router.get("/gst/search", async (req, res, next) => {
  try {
    const taxpayer = await searchTaxpayer(req.query.gstin);
    return ok(res, taxpayer, "GST taxpayer found");
  } catch (error) {
    return next(error);
  }
});

// MASTER IFSC lookup used by every bank-detail form. No external lookup is required.
router.get("/ifsc", async (req,res) => {
  const q=String(req.query.q||"").trim();
  if(!q) return ok(res,[]);
  const safe=q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const rows=await IfscMaster.find({status:{$ne:"INACTIVE"},$or:[
    {ifsc:new RegExp(`^${safe}`,"i")},{bank:new RegExp(safe,"i")},{branch:new RegExp(safe,"i")},{city:new RegExp(safe,"i")}
  ]}).sort({ifsc:1}).limit(Math.min(50,Math.max(1,Number(req.query.limit||20)))).lean();
  return ok(res,rows.map(row=>ifscSnapshot(row)));
});

router.get("/ifsc/:ifsc", async (req,res,next) => {
  try{
    const row=await getIfscMaster(req.params.ifsc);
    return ok(res,{...ifscSnapshot(row),contactNo:formatIfscContact(row)},"IFSC details found in MASTER");
  }catch(error){
    const code=error.statusCode||500;
    if(code<500)return res.status(code).json({ok:false,message:error.message});
    return next(error);
  }
});

router.get("/units", async (_req, res) => ok(res, await Unit.find({ status:"ACTIVE" }).sort({ name:1 }).lean()));
router.get("/accounts", async (_req, res) => {
  const rows=await ensureDefaultTallyAccountTypes(AccountTemplate);
  return ok(res,rows);
});
router.get("/branding", async (_req, res) => ok(res, await Branding.findOne({ key: "GLOBAL" }).lean()));

export default router;
