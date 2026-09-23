import express from "express";
import { AccountTemplate, CompanyLedger, CompanyProfile } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { createCompanyBaseLedgers, defaultStakeholderRelationships, ensureLegalAccountTemplates, syncStakeholderLedgers } from "../services/companyAccountingService.js";
import { gstChangeConfirmation, migrateCompanyTenantKey, normalizeCompanyGstin, validateGstinChangeTarget } from "../services/tenantMigrationService.js";

const router = express.Router();
router.use(requireAuth);

const canManage = req => req.auth?.role === "MASTER" || req.auth?.role === "SUPERADMIN" || (req.auth?.permissions || []).includes("*") || (req.auth?.permissions || []).includes("company.manage");
const clean = v => String(v ?? "").trim();
const maskProfitShare = (value, auth) => {
  if (isAdminAuth(auth) || !value) return value;
  const copy = JSON.parse(JSON.stringify(value));
  if (Array.isArray(copy?.stakeholders)) copy.stakeholders = copy.stakeholders.map(({ profitSharePct, ...row }) => row);
  return copy;
};

const typeOf = v => clean(v).toUpperCase().replace(/\s+/g,"_");
const stakeholderRoles = {
  PROPRIETORSHIP: ["PROPRIETOR"],
  PARTNERSHIP: ["PARTNER"],
  LLP: ["DESIGNATED_PARTNER","PARTNER"],
  PRIVATE_LIMITED: ["DIRECTOR","SHAREHOLDER","PROMOTER","AUTHORISED_SIGNATORY"],
  PUBLIC_LIMITED: ["DIRECTOR","SHAREHOLDER","PROMOTER","AUTHORISED_SIGNATORY"],
  OPC: ["DIRECTOR","SHAREHOLDER","PROMOTER","AUTHORISED_SIGNATORY"],
  TRUST: ["TRUSTEE","AUTHORISED_SIGNATORY"],
  SOCIETY: ["MEMBER","AUTHORISED_SIGNATORY"],
  OTHER: ["OWNER","MEMBER","AUTHORISED_SIGNATORY"]
};

function normalizeStakeholder(row = {}, companyType = "", financialYear = "") {
  const stakeholder = {
    stakeholderId: row.stakeholderId || makeId("STK"),
    name: clean(row.name),
    roleType: typeOf(row.roleType || stakeholderRoles[companyType]?.[0] || "OWNER"),
    pan: clean(row.pan).toUpperCase(),
    dinDpin: clean(row.dinDpin).toUpperCase(),
    mobile: clean(row.mobile),
    email: clean(row.email).toLowerCase(),
    designation: clean(row.designation),
    ownershipPct: Number(row.ownershipPct || 0),
    profitSharePct: Number(row.profitSharePct || 0),
    contribution: Number(row.contribution || 0),
    openingCapital: Number(row.openingCapital || 0),
    joiningDate: row.joiningDate || undefined,
    active: row.active !== false,
    shareholder: Boolean(row.shareholder),
    systemLoginRequired: Boolean(row.systemLoginRequired),
    accountingRelationships: Array.isArray(row.accountingRelationships) ? row.accountingRelationships : []
  };
  if (!stakeholder.accountingRelationships.length) {
    stakeholder.accountingRelationships = defaultStakeholderRelationships({ ...stakeholder, financialYear }, companyType);
  }
  return stakeholder;
}

router.get("/profile", async (req,res) => {
  const profile = await CompanyProfile.findOne({tenantKey:req.auth.tenantKey}).lean();
  return ok(res, maskProfitShare(profile, req.auth) || null);
});

router.post("/profile", async (req,res) => {
  if(!canManage(req)) return fail(res,"Company administration permission required",403);
  if(await CompanyProfile.exists({tenantKey:req.auth.tenantKey})) return fail(res,"Company profile already exists",409);
  const companyName=clean(req.body.companyName), companyType=typeOf(req.body.companyType), financialYear=clean(req.body.financialYear);
  if(!companyName)return fail(res,"Company name is required",400);
  if(!stakeholderRoles[companyType])return fail(res,"Select a valid company type",400);
  const stakeholders=(Array.isArray(req.body.stakeholders)?req.body.stakeholders:[]).filter(x=>clean(x?.name)).map(x=>normalizeStakeholder(x,companyType,financialYear));
  if(["PROPRIETORSHIP","PARTNERSHIP","LLP","PRIVATE_LIMITED","PUBLIC_LIMITED","OPC"].includes(companyType)&&!stakeholders.length)return fail(res,"Add at least one proprietor / partner / director",400);
  const profile=await CompanyProfile.create({tenantKey:req.auth.tenantKey,companyName,tradeName:clean(req.body.tradeName),companyType,gstin:clean(req.body.gstin).toUpperCase(),pan:clean(req.body.pan).toUpperCase(),registeredAddress:clean(req.body.registeredAddress),financialYear,stakeholders,status:"ACTIVE",createdBy:req.auth.sub});
  await createCompanyBaseLedgers(profile);
  for(const stakeholder of profile.stakeholders.filter(x=>x.active))await syncStakeholderLedgers({tenantKey:profile.tenantKey,companyType:profile.companyType,stakeholder,financialYear:profile.financialYear});
  return ok(res,profile,"Existing company profile initialized with legal/accounting structure",201);
});

router.put("/profile", async (req,res) => {
  if(!canManage(req)) return fail(res,"Company administration permission required",403);
  const current = await CompanyProfile.findOne({tenantKey:req.auth.tenantKey});
  if(!current) return fail(res,"Company profile has not been created by MASTER yet",404);
  if(req.body.companyType && typeOf(req.body.companyType) !== current.companyType) {
    return fail(res,"Legal constitution cannot be changed from normal Edit. Use Change Legal Constitution so history and accounting mappings are preserved.",409);
  }

  const requestedGstin=normalizeCompanyGstin(req.body.gstin ?? current.gstin ?? current.tenantKey);
  let tenantMigration=null;
  const gstChanged=requestedGstin!==normalizeCompanyGstin(current.gstin);
  const tenantMoveRequested=req.body.migrateTenantData===true&&requestedGstin!==String(current.tenantKey||"").trim();
  if(gstChanged||tenantMoveRequested){
    try{await validateGstinChangeTarget({profile:current,nextGstin:requestedGstin});}
    catch(error){return fail(res,error.message,error.status||409,{code:error.code||"GST_CHANGE_FAILED"});}
    const gstPan=requestedGstin.slice(2,12);
    const requestedPan=clean(req.body.pan||gstPan||current.pan).toUpperCase();
    if(gstPan&&requestedPan!==gstPan)return fail(res,`PAN must match the PAN embedded in GSTIN (${gstPan})`,400);
    if(gstChanged&&typeof req.body.migrateTenantData!=="boolean")return fail(
      res,
      "GST Number changed. Confirm whether all company data should move to the new GST tenantKey.",
      409,
      gstChangeConfirmation(current,requestedGstin)
    );
    if(tenantMoveRequested){
      try{tenantMigration=await migrateCompanyTenantKey({companyProfileId:String(current._id),oldTenantKey:current.tenantKey,newGstin:requestedGstin,actorId:req.auth.sub,actorRole:req.auth.role});}
      catch(error){return fail(res,error.message,error.status||500,{code:error.code||"TENANT_MIGRATION_FAILED"});}
      current.tenantKey=requestedGstin;
      req.auth.tenantKey=requestedGstin;
    }
    current.gstin=requestedGstin;
    current.pan=requestedPan;
  }else if(req.body.pan!==undefined){
    current.pan=clean(req.body.pan).toUpperCase();
  }


  for(const key of ["companyName","tradeName","registeredAddress","financialYear","status"]) {
    if(req.body[key] !== undefined) current[key] = typeof req.body[key] === "string" ? clean(req.body[key]) : req.body[key];
  }
  await current.save();
  const result={...current.toObject(),gstChanged,tenantMigration,tenantKeyChanged:Boolean(tenantMigration?.changed),newTenantKey:tenantMigration?.newTenantKey||current.tenantKey};
  return ok(res,result,tenantMigration?.changed?"GSTIN updated and company data moved to the new tenantKey":"Company profile updated");
});

router.post("/change-constitution", async (req,res) => {
  if(!canManage(req)) return fail(res,"Company administration permission required",403);
  const profile = await CompanyProfile.findOne({tenantKey:req.auth.tenantKey});
  if(!profile) return fail(res,"Company profile not found",404);
  const nextType = typeOf(req.body.companyType);
  if(!stakeholderRoles[nextType]) return fail(res,"Select a valid company type",400);
  if(nextType === profile.companyType) return fail(res,"New company type is the same as the current company type",400);
  if(!req.body.effectiveDate || !clean(req.body.reason)) return fail(res,"Effective date and reason are required",400);
  const oldType = profile.companyType;
  profile.constitutionHistory.push({from:oldType,to:nextType,effectiveDate:new Date(req.body.effectiveDate),reason:clean(req.body.reason),approvedBy:req.auth.sub,at:new Date()});
  profile.companyType = nextType;
  if(Array.isArray(req.body.stakeholders)) profile.stakeholders = req.body.stakeholders.map(x=>normalizeStakeholder(x,nextType,profile.financialYear));
  await profile.save();
  await createCompanyBaseLedgers(profile);
  for(const stakeholder of profile.stakeholders.filter(x=>x.active)) await syncStakeholderLedgers({tenantKey:profile.tenantKey,companyType:profile.companyType,stakeholder,financialYear:profile.financialYear});
  return ok(res,profile,"Legal constitution changed with history preserved. Existing historical ledgers were not deleted.");
});

router.get("/stakeholders", async (req,res) => {
  const profile=await CompanyProfile.findOne({tenantKey:req.auth.tenantKey}).lean();
  return ok(res,isAdminAuth(req.auth)?(profile?.stakeholders||[]):(profile?.stakeholders||[]).map(({profitSharePct,...row})=>row));
});

router.post("/stakeholders", async (req,res) => {
  if(!canManage(req)) return fail(res,"Company administration permission required",403);
  const profile=await CompanyProfile.findOne({tenantKey:req.auth.tenantKey});
  if(!profile)return fail(res,"Company profile not found",404);
  const stakeholder=normalizeStakeholder(req.body,profile.companyType,profile.financialYear);
  if(!stakeholder.name)return fail(res,"Stakeholder name is required",400);
  profile.stakeholders.push(stakeholder);
  await profile.save();
  await syncStakeholderLedgers({tenantKey:profile.tenantKey,companyType:profile.companyType,stakeholder,financialYear:profile.financialYear});
  return ok(res,stakeholder,"Stakeholder created",201);
});

router.put("/stakeholders/:id", async (req,res) => {
  if(!canManage(req)) return fail(res,"Company administration permission required",403);
  const profile=await CompanyProfile.findOne({tenantKey:req.auth.tenantKey});
  if(!profile)return fail(res,"Company profile not found",404);
  const index=profile.stakeholders.findIndex(x=>x.stakeholderId===req.params.id);
  if(index<0)return fail(res,"Stakeholder not found",404);
  const stakeholder=normalizeStakeholder({...profile.stakeholders[index].toObject(),...req.body,stakeholderId:req.params.id},profile.companyType,profile.financialYear);
  profile.stakeholders[index]=stakeholder;
  await profile.save();
  await syncStakeholderLedgers({tenantKey:profile.tenantKey,companyType:profile.companyType,stakeholder,financialYear:profile.financialYear});
  return ok(res,stakeholder,"Stakeholder updated");
});

router.post("/stakeholders/:id/status", async (req,res) => {
  if(!canManage(req)) return fail(res,"Company administration permission required",403);
  const profile=await CompanyProfile.findOne({tenantKey:req.auth.tenantKey});
  if(!profile)return fail(res,"Company profile not found",404);
  const stakeholder=profile.stakeholders.find(x=>x.stakeholderId===req.params.id);
  if(!stakeholder)return fail(res,"Stakeholder not found",404);
  stakeholder.active=req.body.active!==false;
  await profile.save();
  if(!stakeholder.active) await CompanyLedger.updateMany({tenantKey:profile.tenantKey,ownerType:"STAKEHOLDER",ownerId:stakeholder.stakeholderId},{$set:{status:"INACTIVE"}});
  else await syncStakeholderLedgers({tenantKey:profile.tenantKey,companyType:profile.companyType,stakeholder,financialYear:profile.financialYear});
  return ok(res,{stakeholderId:stakeholder.stakeholderId,active:stakeholder.active},"Stakeholder status updated");
});

router.get("/account-options", async (_req,res) => {
  await ensureLegalAccountTemplates();
  const codes=[
    "SYS_CAPITAL","SYS_PROPRIETOR_CAPITAL","SYS_PARTNER_CAPITAL","SYS_PARTNER_CURRENT","SYS_PARTNER_LOAN","SYS_DRAWINGS",
    "SYS_SHARE_CAPITAL","SYS_DIRECTOR_LOAN","SYS_DIRECTOR_ADVANCE","SYS_DIRECTOR_REMUNERATION","SYS_LOANS_ADVANCES","SYS_LOAN_LIABILITY",
    "SYS_STAFF_ADVANCE","SYS_SALARY_PAYABLE","SYS_REIMBURSEMENT_PAYABLE","SYS_SUNDRY_DEBTORS","SYS_SUNDRY_CREDITORS"
  ];
  const rows=await AccountTemplate.find({$or:[{systemCode:{$in:codes}},{allowCompanyLedger:true}]}).sort({name:1}).lean();
  return ok(res,rows);
});

router.get("/ledgers", async (req,res) => {
  const q=clean(req.query.q); const filter={tenantKey:req.auth.tenantKey};
  if(q)filter.$or=[{name:new RegExp(q,"i")},{relationshipType:new RegExp(q,"i")},{systemAccountCode:new RegExp(q,"i")}];
  return ok(res,await CompanyLedger.find(filter).sort({name:1}).limit(1000).lean());
});

export default router;
