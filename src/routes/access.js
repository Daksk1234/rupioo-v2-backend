import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import multer from "multer";
import XLSX from "xlsx";
import { Role, Group, User, Plan, CompanyProfile, CompanyLedger, AccountTemplate, PlatformPayment, DesignationTemplate, BranchOffice, Department, PincodeAssignment, Pincode, CustomerLink, GenericRecord } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { createCompanyBaseLedgers, defaultStakeholderRelationships, ensureLegalAccountTemplates, syncStakeholderLedgers, syncUserLedgers } from "../services/companyAccountingService.js";
import { PERMISSION_ACTIONS, permissionCatalogue, sanitizePermissionCodes } from "../config/permissionCatalogue.js";
import { defaultDesignationTemplates, MASTER_DESIGNATION_TENANT } from "../config/defaultDesignationTemplates.js";
import { readRows, resolveColumns, valueFor, cleanText } from "../utils/bulkSpreadsheet.js";
import { env } from "../config/env.js";
import { addBillingPeriod, normalizeBillingCycle, subscriptionSnapshot } from "../utils/subscription.js";
import { eligibleUsersForDepartment, getAssignmentOptions, reconcilePincodeAssignmentsForDepartment } from "../services/assignmentHierarchyService.js";
import { DEFAULT_TALLY_ACCOUNT_TYPES, ensureDefaultTallyAccountTypes } from "../config/defaultTallyAccountTypes.js";
import { DEFAULT_LEDGER_LIBRARY, flattenLedgerLibrary, normalizeLedgerLibraryName } from "../config/defaultLedgerLibrary.js";
import { defaultRoleTemplates, MASTER_TEMPLATE_TENANT } from "../config/defaultRoleTemplates.js";
import { userReferenceDetails } from "../services/referenceIntegrityService.js";
import { resolveBankDetails } from "../services/ifscMasterService.js";
import { reassignOpenLeadsForPincodes } from "../services/leadAssignmentService.js";
import { ensureSystemCashAccount, isSystemCashRecord } from "../services/systemCashAccountService.js";
import { gstChangeConfirmation, migrateCompanyTenantKey, validateGstinChangeTarget } from "../services/tenantMigrationService.js";
import { isTenantKeyReserved, resolveTenantKeyAlias } from "../services/tenantKeyService.js";

const router = express.Router();
router.use(requireAuth);
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:30*1024*1024}});

const canManageAccess = (req) => req.auth?.role === "MASTER" || req.auth?.role === "SUPERADMIN" || (req.auth?.permissions || []).includes("hr.users.manage") || (req.auth?.permissions || []).includes("dms.users.manage") || (req.auth?.permissions || []).includes("dms.others.assign_salesperson_area") || (req.auth?.permissions || []).includes("*");
const normalizeCode = (v) => String(v || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
const cleanDigits = (v) => String(v || "").replace(/\D/g, "");
const normalizePersonPan = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "");
const personHashAadhaar = (v) => crypto.createHash("sha256").update(cleanDigits(v)).digest("hex");
const personMaskAadhaar = (v) => { const d=cleanDigits(v); return d ? `XXXX-XXXX-${d.slice(-4)}` : ""; };
const publicUser = (doc) => {
  const row = doc?.toObject ? doc.toObject() : { ...(doc || {}) };
  delete row.passwordHash; delete row.aadhaarHash;
  if (row.loginEnabled === false) row.email = "";
  return row;
};
const lookupMasterPincode = async (value) => {
  const pincode=cleanDigits(value).slice(0,6);
  if(!/^\d{6}$/.test(pincode)) return null;

  // Use aggregation instead of a normal Mongoose equality query so older
  // MASTER imports where `pincode` was stored as a Number still match.
  // Status is considered active unless it is explicitly INACTIVE.
  const rows=await Pincode.aggregate([
    {$match:{
      $expr:{$eq:[{$toString:"$pincode"},pincode]},
      status:{$ne:"INACTIVE"}
    }},
    {$sort:{city:-1,area:1}},
    {$limit:100}
  ]).allowDiskUse(true);
  if(!rows.length) return null;
  const primary=rows.find(r=>String(r.city||"").trim())||rows[0];
  return {
    _id:primary._id,
    pincode,
    area:String(primary.area||"").trim(),
    city:String(primary.city||"").trim(),
    district:String(primary.district||"").trim(),
    state:String(primary.state||"").trim(),
    country:String(primary.country||"India").trim(),
    alternatives:rows.map(r=>({
      _id:r._id,
      area:String(r.area||"").trim(),
      city:String(r.city||"").trim(),
      district:String(r.district||"").trim(),
      state:String(r.state||"").trim()
    }))
  };
};

const pincodeProfile = async (value, fallback={}) => {
  const pincode=cleanDigits(value).slice(0,6);
  if (!pincode) return { pincode:"", area:"", city:"", district:"", state:"" };
  const row=await lookupMasterPincode(pincode);
  return {
    pincode,
    area:String(row?.area||fallback.area||"").trim(),
    city:String(row?.city||fallback.city||"").trim(),
    district:String(row?.district||fallback.district||"").trim(),
    state:String(row?.state||fallback.state||"").trim(),
  };
};
const tenantFilter = async (req) => {
  const raw = req.auth.role === "MASTER" && req.query.tenantKey ? String(req.query.tenantKey) : req.auth.tenantKey;
  return req.auth.role === "MASTER" ? resolveTenantKeyAlias(raw) : raw;
};

// Shared authenticated MASTER-pincode lookup used by both User and Customer.
// It intentionally does not require User-management permission because a user
// who is allowed to create/edit a Customer also needs this geography lookup.
router.get("/pincode-lookup/:pincode",async(req,res)=>{
  const pincode=cleanDigits(req.params.pincode).slice(0,6);
  if(!/^\d{6}$/.test(pincode)) return fail(res,"Pincode must be exactly 6 digits",400);
  const row=await lookupMasterPincode(pincode);
  if(!row) return fail(res,`Pincode ${pincode} not found in MASTER Pincode data`,404);
  return ok(res,row);
});

// Resolve the Sales Head above any user in the dynamic reporting hierarchy.
// This supports one or many Sales Heads and any number of intermediate roles
// (for example Sales Head -> Sales Manager -> Sales Person).
const salesHeadAncestorForUser=async(tenantKey,startUserId)=>{
  let currentId=String(startUserId||"").trim();
  const seen=new Set();
  for(let depth=0;currentId&&depth<25;depth+=1){
    if(seen.has(currentId))break;seen.add(currentId);
    const user=await User.findOne({_id:currentId,tenantKey}).select("_id name role roleId assignedToUserId coveragePincodes").lean();
    if(!user)break;
    const code=String(user.role||"").toUpperCase();
    if(code==="SALES_HEAD")return {...user,roleCode:code,roleName:"Sales Head"};
    currentId=String(user.assignedToUserId||"");
  }
  return null;
};

const pincodeTreeScope=async(req)=>{
  const scopeUserId=String(req.query.scopeUserId||"").trim();
  if(!scopeUserId)return {};
  const head=await salesHeadAncestorForUser(await tenantFilter(req),scopeUserId);
  if(!head)return {};
  const pins=Array.from(new Set((head.coveragePincodes||[]).map(x=>cleanDigits(x).slice(0,6)).filter(x=>x.length===6)));
  return pins.length?{pincode:{$in:pins}}:{_id:{$exists:false}};
};

// Searchable MASTER pincode catalogue used by Sales Person assignment dialog.
router.get("/pincode-catalog",async(req,res)=>{
  const q=String(req.query.q||"").trim();
  const page=Math.max(1,Number(req.query.page||1));
  const limit=Math.min(500,Math.max(25,Number(req.query.limit||100)));
  const match={status:{$ne:"INACTIVE"}};
  if(q){
    const rx=new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i");
    match.$or=[{pincode:rx},{area:rx},{city:rx},{district:rx},{state:rx}];
  }
  const grouped=await Pincode.aggregate([
    {$match:match},
    // Group BEFORE sorting. The MASTER pincode collection can contain many
    // post-office rows for the same PIN; sorting every raw row can exceed
    // MongoDB's 32 MB in-memory aggregation sort limit.
    {$group:{
      _id:{$toString:"$pincode"},
      areas:{$addToSet:{area:"$area",city:"$city",district:"$district",state:"$state"}},
      district:{$max:{$ifNull:["$district",""]}},
      state:{$max:{$ifNull:["$state",""]}}
    }},
    {$sort:{_id:1}},
    {$facet:{items:[{$skip:(page-1)*limit},{$limit:limit}],meta:[{$count:"total"}]}}
  ]).allowDiskUse(true);
  const data=grouped?.[0]||{items:[],meta:[]};
  const total=Number(data.meta?.[0]?.total||0);
  return ok(res,{items:(data.items||[]).map(x=>({pincode:x._id,areas:x.areas||[],district:x.district||"",state:x.state||""})),meta:pageMeta(page,limit,total)});
});

// Hierarchical MASTER pincode browser used by Sales Head / Sales Person assignment.
// Counts are distinct pincodes, not raw post-office rows, so large states remain easy to navigate.
// One compact hierarchy index is loaded by the checkbox-based selector.
// It returns one canonical geography row per distinct pincode so the frontend can
// calculate checked / partially checked State, District and City nodes instantly.
router.get("/pincode-tree/index",async(req,res)=>{
  const scope=await pincodeTreeScope(req);
  const rows=await Pincode.aggregate([
    {$match:{status:{$ne:"INACTIVE"},...scope}},
    {$project:{
      pin:{$toString:"$pincode"},
      area:{$ifNull:["$area",""]},
      city:{$ifNull:["$city",""]},
      district:{$ifNull:["$district",""]},
      state:{$ifNull:["$state",""]}
    }},
    {$match:{pin:{$nin:[null,""]}}},
    // Reduce the raw MASTER rows to one row per PIN first. This is the key
    // fix for "Sort exceeded memory limit of 33554432 bytes" on the pincode
    // assignment selector. $max naturally prefers populated text over blanks.
    {$group:{
      _id:"$pin",
      areas:{$addToSet:"$area"},
      state:{$max:"$state"},
      district:{$max:"$district"},
      city:{$max:"$city"}
    }},
    {$sort:{_id:1}}
  ]).allowDiskUse(true);

  return ok(res,rows
    .map(row=>({
      pincode:cleanDigits(row._id).slice(0,6),
      state:String(row.state||"").trim(),
      district:String(row.district||"").trim(),
      city:String(row.city||"").trim(),
      areas:(row.areas||[])
        .map(value=>String(value||"").trim())
        .filter(Boolean)
        .sort((a,b)=>a.localeCompare(b))
    }))
    .filter(row=>/^\d{6}$/.test(row.pincode)));
});

router.get("/pincode-tree/states",async(req,res)=>{
  const scope=await pincodeTreeScope(req);
  const rows=await Pincode.aggregate([
    {$match:{status:{$ne:"INACTIVE"},state:{$nin:[null,""]},...scope}},
    {$project:{state:1,pin:{$toString:"$pincode"}}},
    {$group:{_id:{state:"$state",pin:"$pin"}}},
    {$group:{_id:"$_id.state",count:{$sum:1}}},
    {$sort:{_id:1}},
    {$project:{_id:0,name:"$_id",count:1}}
  ]).allowDiskUse(true);
  return ok(res,rows.filter(x=>x.name));
});

router.get("/pincode-tree/districts",async(req,res)=>{
  const state=String(req.query.state||"").trim();
  if(!state)return ok(res,[]);
  const safe=state.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),scope=await pincodeTreeScope(req);
  const rows=await Pincode.aggregate([
    {$match:{status:{$ne:"INACTIVE"},state:{$regex:`^${safe}$`,$options:"i"},district:{$nin:[null,""]},...scope}},
    {$project:{district:1,pin:{$toString:"$pincode"}}},
    {$group:{_id:{district:"$district",pin:"$pin"}}},
    {$group:{_id:"$_id.district",count:{$sum:1}}},
    {$sort:{_id:1}},
    {$project:{_id:0,name:"$_id",count:1}}
  ]).allowDiskUse(true);
  return ok(res,rows.filter(x=>x.name));
});

router.get("/pincode-tree/list",async(req,res)=>{
  const state=String(req.query.state||"").trim(),district=String(req.query.district||"").trim();
  if(!state||!district)return ok(res,[]);
  const esc=v=>String(v).replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),scope=await pincodeTreeScope(req);
  const rows=await Pincode.aggregate([
    {$match:{status:{$ne:"INACTIVE"},state:{$regex:`^${esc(state)}$`,$options:"i"},district:{$regex:`^${esc(district)}$`,$options:"i"},...scope}},
    {$project:{pin:{$toString:"$pincode"},area:{$ifNull:["$area",""]},city:{$ifNull:["$city",""]},state:{$ifNull:["$state",""]},district:{$ifNull:["$district",""]}}},
    // Again group before sorting so large districts cannot overflow the
    // aggregation sort-memory cap.
    {$group:{_id:"$pin",areas:{$addToSet:"$area"},cities:{$addToSet:"$city"},state:{$max:"$state"},district:{$max:"$district"}}},
    {$sort:{_id:1}}
  ]).allowDiskUse(true);
  return ok(res,rows.map(row=>({
    pincode:row._id,
    areas:(row.areas||[]).filter(Boolean).sort((a,b)=>a.localeCompare(b)),
    city:(row.cities||[]).filter(Boolean).sort((a,b)=>a.localeCompare(b))[0]||"",
    state:row.state||state,district:row.district||district
  })));
});

router.get("/user-assignment-options",async(req,res)=>{
  const tenantKey=await tenantFilter(req);
  const role=await Role.findOne({_id:req.query.roleId,tenantKey,status:"ACTIVE"}).lean();
  if(!role)return fail(res,"Select a valid Role",404);
  const department=role.departmentId?await Department.findOne({_id:role.departmentId,tenantKey:MASTER_DEPARTMENT_TENANT,status:"ACTIVE"}).lean():null;
  if(!department)return fail(res,"Assign this Role to an active Department first",409);
  const roles=await Role.find({tenantKey,departmentId:department._id,status:"ACTIVE",hierarchyOrder:{$gt:0}}).sort({hierarchyOrder:1,name:1}).lean();
  const index=roles.findIndex(r=>String(r._id)===String(role._id));
  if(index<0)return fail(res,"Set the Role rank in Department Role Assignment first",409);
  const parentRole=index>0?roles[index-1]:null;
  const users=parentRole?await User.find({tenantKey,status:"ACTIVE",roleId:parentRole._id}).select("name email mobile designation role roleId departmentId").sort({name:1}).lean():[];
  return ok(res,{department:{_id:department._id,name:department.name,code:department.code},role,parentRole,requiresParent:Boolean(parentRole),users});
});

const MASTER_DEPARTMENT_TENANT = "__MASTER_DEPARTMENTS__";

const cleanApps = (apps=[]) => Array.from(new Set((apps||[]).map(x=>String(x).toLowerCase()).filter(x=>["master","dms"].includes(x))));
const cleanPermissions = (permissions=[]) => Array.from(new Set((permissions||[]).map(x=>String(x).trim()).filter(Boolean)));
const OPERATIONAL_PERMISSION_APPS = new Set(["dms","hr","production"]);
const operationalPermissions = (permissions=[]) => sanitizePermissionCodes(permissions).filter(code=>OPERATIONAL_PERMISSION_APPS.has(String(code||"").split(".")[0]));
const filterPermissionsForApps = (permissions,apps) => {
  // DMS V2 no longer uses separate HR/Production application gates. When the
  // company has DMS enabled, all operational permission namespaces can be
  // controlled from the same Role/Department permission system.
  const dmsEnabled=(apps||[]).includes("dms");
  return dmsEnabled?operationalPermissions(permissions):[];
};
const dmsOnlyPermissions = (permissions=[]) => sanitizePermissionCodes(permissions).filter(code=>String(code).startsWith("dms."));
const permissionIntersection=(left=[],right=[])=>{const allowed=new Set(operationalPermissions(right||[]));return operationalPermissions(left).filter(code=>allowed.has(code));};

// Resolve the company plan from the login token first, then fall back to the
// company profile. Older Superadmin tokens may not contain planCode, and in
// that case Role Management used to see an empty permission/role catalogue.
const activePlanForRequest=async(req)=>{
  if(req.auth.role==="MASTER")return null;
  let planCode=String(req.auth.planCode||"").trim().toUpperCase();
  if(!planCode){
    const profile=await CompanyProfile.findOne({tenantKey:req.auth.tenantKey,status:{$ne:"INACTIVE"}}).select("planCode").lean();
    planCode=String(profile?.planCode||"").trim().toUpperCase();
  }
  if(!planCode)return null;
  return Plan.findOne({code:planCode,status:"ACTIVE"}).lean();
};

const companyPermissionCeiling=async(req)=>{
  if(req.auth.role==="MASTER") return null;
  const plan=await activePlanForRequest(req);
  if(!plan||plan?.apps?.dms===false)return [];
  const groupCode=String(plan.groupCode||"").trim().toUpperCase();
  if(!groupCode)return [];
  const group=(await Group.findOne({tenantKey:"demo",code:groupCode,status:"ACTIVE"}).lean())||(await Group.findOne({code:groupCode,status:"ACTIVE"}).sort({createdAt:1}).lean());
  return operationalPermissions(group?.permissions||[]);
};
const hasDmsAccess = (row={}) => (row.apps||[]).includes("dms") || Boolean(row.departmentId) || (row.permissions||[]).some(code=>String(code).startsWith("dms."));

// MASTER owns one global Department catalogue. Departments are NOT copied per
// tenant. Superadmins can only read this fixed catalogue and reference those
// Department IDs from their own tenant-scoped Roles. MASTER can also configure
// the maximum DMS permission set allowed inside each Department.
const masterDepartments = (filter = {}) =>
  Department.find({ tenantKey: MASTER_DEPARTMENT_TENANT, ...filter });

const activeMasterDepartmentById = (departmentId) =>
  Department.findOne({
    _id: departmentId,
    tenantKey: MASTER_DEPARTMENT_TENANT,
    status: "ACTIVE",
  });

const syncLegacyMasterDepartments = async () => {
  // DMS V2 originally stored MASTER > Departments in GenericRecord through
  // /modules/master/departments (title/reference/status/notes). The new
  // hierarchy system uses the dedicated Department model. Keep the dedicated
  // model as the canonical hierarchy/security source, but automatically import
  // and refresh every old MASTER department before any hierarchy/permission
  // operation. This preserves all existing Department references, including
  // references already used in exported XLSX files such as DEPAR-XXXXXXXXXX.
  const legacyRows = await GenericRecord.find({ app: "master", resource: "departments" })
    .sort({ createdAt: 1 })
    .lean();

  for (const legacy of legacyRows) {
    const name = String(legacy.title || legacy.data?.name || "").trim();
    if (!name) continue;

    const reference = String(legacy.reference || "").trim().toUpperCase();
    const requestedCode = normalizeCode(legacy.data?.code || name);
    const description = String(legacy.notes || legacy.data?.description || "").trim();
    const status = String(legacy.status || "ACTIVE").toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE";

    const or = [];
    if (reference) or.push({ reference });
    if (requestedCode) or.push({ code: requestedCode });
    or.push({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });

    let department = await Department.findOne({
      tenantKey: MASTER_DEPARTMENT_TENANT,
      $or: or,
    });

    if (!department) {
      // A code can only occur once in the global MASTER Department catalogue.
      // In the unlikely event that two legacy rows normalize to the same code,
      // retain the first code and derive a stable alternative from reference.
      let code = requestedCode || normalizeCode(reference) || `DEPARTMENT_${Date.now()}`;
      if (await Department.exists({ tenantKey: MASTER_DEPARTMENT_TENANT, code })) {
        code = normalizeCode(reference) || `${code}_${String(legacy._id).slice(-6).toUpperCase()}`;
      }

      department = new Department({
        tenantKey: MASTER_DEPARTMENT_TENANT,
        reference: reference || makeId("DEPAR"),
        name,
        code,
        description,
        status,
        createdBy: legacy.createdBy || "LEGACY_MASTER_IMPORT",
        updatedBy: legacy.updatedBy || legacy.createdBy || "LEGACY_MASTER_IMPORT",
      });
    } else {
      // Import is one-way/backward compatibility only. Once the dedicated
      // Department exists, the new MASTER Department page is authoritative.
      // Do not let an old GenericRecord silently overwrite a later rename,
      // description change, or ACTIVE/INACTIVE change. Fill only legacy identity
      // values that are still missing.
      if (reference && !department.reference) department.reference = reference;
      if (!department.description && description) department.description = description;
    }

    try {
      await department.save();
    } catch (error) {
      // If a legacy duplicate races with an existing normalized Department,
      // resolve by reference/name and keep going instead of breaking the entire
      // permission upload.
      if (error?.code !== 11000) throw error;
      const duplicate =
        (reference ? await Department.findOne({ tenantKey: MASTER_DEPARTMENT_TENANT, reference }) : null) ||
        await Department.findOne({ tenantKey: MASTER_DEPARTMENT_TENANT, name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (!duplicate) throw error;
    }
  }
};

const ensureMasterDepartmentReferences = async () => {
  await syncLegacyMasterDepartments();
  const rows = await Department.find({ tenantKey: MASTER_DEPARTMENT_TENANT, $or: [{ reference: { $exists: false } }, { reference: "" }, { reference: null }] });
  for (const row of rows) {
    row.reference = makeId("DEPAR");
    await row.save();
  }
};

const configuredDepartmentPermissions = (department) => {
  if (!department || department.permissionConfigured !== true) return null;
  return operationalPermissions(department.permissions || []);
};

const effectiveRolePermissionCeiling = async (req, departmentId) => {
  const companyCeiling = await companyPermissionCeiling(req);
  if (!departmentId) return companyCeiling || [];
  const department = await Department.findOne({
    _id: departmentId,
    tenantKey: MASTER_DEPARTMENT_TENANT,
    status: "ACTIVE",
  }).lean();
  if (!department) return [];
  const departmentCeiling = configuredDepartmentPermissions(department);
  return departmentCeiling === null
    ? (companyCeiling || [])
    : permissionIntersection(companyCeiling || [], departmentCeiling);
};

const clampRolesToDepartmentCeiling = async (department) => {
  if (!department || department.permissionConfigured !== true) {
    return { rolesClamped: 0, usersSynced: 0 };
  }
  const ceiling = operationalPermissions(department.permissions || []);
  const roles = await Role.find({ departmentId: department._id });
  let rolesClamped = 0;
  let usersSynced = 0;

  for (const role of roles) {
    const nextPermissions = permissionIntersection(role.permissions || [], ceiling);
    const before = operationalPermissions(role.permissions || []);
    const changed = before.length !== nextPermissions.length || before.some((code, index) => code !== nextPermissions[index]);
    if (changed) {
      role.permissions = nextPermissions;
      await role.save();
      rolesClamped += 1;
    }

    const result = await User.updateMany(
      { tenantKey: role.tenantKey, $or: [{ roleId: role._id }, { role: role.code }] },
      { $set: { permissions: nextPermissions, apps: ["dms"] } }
    );
    usersSynced += Number(result.modifiedCount || 0);
  }

  return { rolesClamped, usersSynced };
};

const migrateLegacyTenantDepartments = async (tenantKey) => {
  if(!tenantKey||tenantKey===MASTER_DEPARTMENT_TENANT)return;
  const legacy=await Department.find({tenantKey}).lean();
  if(!legacy.length)return;
  const masters=await Department.find({tenantKey:MASTER_DEPARTMENT_TENANT}).lean();
  const byCode=new Map(masters.map(d=>[String(d.code||"").toUpperCase(),d]));

  for(const oldDepartment of legacy){
    const code=String(oldDepartment.sourceTemplateCode||oldDepartment.code||"").toUpperCase();
    const master=byCode.get(code);
    if(!master)continue;

    await Role.updateMany({tenantKey,departmentId:oldDepartment._id},{$set:{departmentId:master._id}});
    await User.updateMany({tenantKey,departmentId:oldDepartment._id},{$set:{departmentId:master._id,department:master.name}});

    const oldAssignments=await PincodeAssignment.find({tenantKey,departmentId:oldDepartment._id});
    for(const row of oldAssignments){
      const existing=await PincodeAssignment.findOne({tenantKey,departmentId:master._id,pincode:row.pincode});
      if(existing){
        const merged=Array.from(new Set([...(existing.userIds||[]).map(String),...(row.userIds||[]).map(String)]));
        existing.userIds=merged;
        if(row.status==="ACTIVE")existing.status="ACTIVE";
        await existing.save();
        await row.deleteOne();
      }else{
        row.departmentId=master._id;
        await row.save();
      }
    }

    await Department.updateOne({_id:oldDepartment._id},{$set:{status:"INACTIVE"}});
  }
};

const normalizeDepartmentRoleOrders = async (tenantKey,departmentId) => {
  if(!tenantKey||!departmentId)return;
  const rows=await Role.find({tenantKey,departmentId,status:"ACTIVE",hierarchyOrder:{$gt:0}}).sort({hierarchyOrder:1,createdAt:1,name:1});
  for(let i=0;i<rows.length;i++){if(Number(rows[i].hierarchyOrder)!==i+1){rows[i].hierarchyOrder=i+1;await rows[i].save();}}
};
const ensureDefaultDesignationTemplates = async () => {
  for (const d of defaultDesignationTemplates.filter(hasDmsAccess)) {
    await DesignationTemplate.findOneAndUpdate(
      {tenantKey:MASTER_DESIGNATION_TENANT,code:d.code},
      {$set:{...d,apps:["dms"],permissions:dmsOnlyPermissions(d.permissions||[]),tenantKey:MASTER_DESIGNATION_TENANT,status:"ACTIVE"}},
      {upsert:true,new:true,setDefaultsOnInsert:true}
    );
  }
};
const boolCell = (value) => [true,1,"1","true","yes","y","x","✓","checked"].includes(typeof value === "string" ? value.trim().toLowerCase() : value);
const csvList = (value) => String(value || "").split(/[,;|]/).map(x=>x.trim()).filter(Boolean);
const parseJsonObject = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { const parsed=JSON.parse(String(value)); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
};
const appsFromPermissions = (permissions=[]) => operationalPermissions(permissions).length ? ["dms"] : [];
const designationPayload = (body={},fallback={}) => {
  const permissions=dmsOnlyPermissions(body.permissions ?? fallback.permissions ?? []);
  return {
    name:String(body.name ?? fallback.name ?? "").trim(),
    code:normalizeCode(body.code ?? fallback.code ?? body.name ?? fallback.name),
    department:String(body.department ?? fallback.department ?? "").trim(),
    description:String(body.description ?? fallback.description ?? "").trim(),
    apps:appsFromPermissions(permissions),
    permissions,
    fieldAccess:body.fieldAccess ?? fallback.fieldAccess ?? {},
    workflowTransitions:body.workflowTransitions ?? fallback.workflowTransitions ?? {},
    approvalLimits:{discountPct:0,creditAmount:0,orderAmount:0},
    templateVersion:2,
    status:String(body.status ?? fallback.status ?? "ACTIVE").toUpperCase()==="INACTIVE"?"INACTIVE":"ACTIVE"
  };
};

const rolePayload = (body={},fallback={}) => {
  const permissions=operationalPermissions(body.permissions ?? fallback.permissions ?? []);
  return {
    name:String(body.name ?? fallback.name ?? "").trim(),
    code:normalizeCode(body.code ?? fallback.code ?? body.name ?? fallback.name),
    description:String(body.description ?? fallback.description ?? "").trim(),
    apps:(body.departmentId ?? fallback.departmentId) ? ["dms"] : appsFromPermissions(permissions),
    permissions,
    departmentId:body.departmentId ?? fallback.departmentId ?? undefined,
    hierarchyOrder:Math.max(0,Number(body.hierarchyOrder ?? fallback.hierarchyOrder ?? 0)),
    approvalLimits:{discountPct:0,creditAmount:0,orderAmount:0},
    templateVersion:3,
    status:String(body.status ?? fallback.status ?? "ACTIVE").toUpperCase()==="INACTIVE"?"INACTIVE":"ACTIVE"
  };
};
const groupPayload = (body={},fallback={}) => ({
  name:String(body.name ?? fallback.name ?? "").trim(),
  code:normalizeCode(body.code ?? fallback.code ?? body.name ?? fallback.name),
  description:String(body.description ?? fallback.description ?? "").trim(),
  permissions:operationalPermissions(body.permissions ?? fallback.permissions ?? []),
  status:String(body.status ?? fallback.status ?? "ACTIVE").toUpperCase()==="INACTIVE"?"INACTIVE":"ACTIVE"
});

let removedPermissionCleanupDone = false;
const cleanupRemovedPermissionCodes = async () => {
  if (removedPermissionCleanupDone) return;

  const collections = [Role, DesignationTemplate, Group];

  for (const Model of collections) {
    const rows = await Model.find({ permissions: { $exists: true, $type: "array" } });

    for (const row of rows) {
      const next = sanitizePermissionCodes(row.permissions || []);
      const current = Array.from(new Set((row.permissions || []).map((code) => String(code || "").trim()).filter(Boolean)));

      if (next.length !== current.length || next.some((code, index) => code !== current[index])) {
        row.permissions = next;
        await row.save();
      }
    }
  }

  removedPermissionCleanupDone = true;
};

// ---------- Permission catalogue ----------
// MASTER sees the complete DMS catalogue. A Superadmin sees only its Plan/Group
// ceiling. When departmentId is supplied (editing an already-assigned Role),
// the visible catalogue is additionally restricted by the MASTER Department
// permission ceiling.
router.get("/permission-catalogue", async (req,res) => {
  await cleanupRemovedPermissionCodes();
  const groups=permissionCatalogue.filter(group=>OPERATIONAL_PERMISSION_APPS.has(group.app));
  if(req.auth.role==="MASTER")return ok(res,{actions:PERMISSION_ACTIONS,groups,department:null});

  let effective=await companyPermissionCeiling(req);
  let department=null;
  if(req.query.departmentId){
    department=await Department.findOne({_id:req.query.departmentId,tenantKey:MASTER_DEPARTMENT_TENANT,status:"ACTIVE"}).lean();
    if(!department)return fail(res,"Department not found or inactive",404);
    const departmentCeiling=configuredDepartmentPermissions(department);
    if(departmentCeiling!==null)effective=permissionIntersection(effective||[],departmentCeiling);
  }

  const ceiling=new Set(effective||[]);
  const filteredGroups=groups.map(group=>({...group,screens:(group.screens||[]).map(screen=>{
    const allowedActions=(screen.allowedActions||[]).filter(action=>ceiling.has(`${screen.key}.${action}`));
    return {...screen,allowedActions};
  }).filter(screen=>screen.allowedActions.length)})).filter(group=>group.screens.length);
  return ok(res,{
    actions:PERMISSION_ACTIONS,
    groups:filteredGroups,
    department:department?{
      id:String(department._id),reference:department.reference||"",name:department.name,code:department.code,
      permissionConfigured:department.permissionConfigured===true,permissionCount:operationalPermissions(department.permissions||[]).length
    }:null
  });
});

// MASTER predefined Role Templates are the shared role catalogue used by Plan
// creation, company registration, Role Management, and Department Role Assignment.
// They live under MASTER_TEMPLATE_TENANT. Plans may preselect a subset during
// registration, but every ACTIVE DMS MASTER Role is later synchronized into the
// company tenant so MASTER-created Roles never disappear from access setup.
const ensureMasterRoleTemplates = async () => {
  for (const template of defaultRoleTemplates) {
    await Role.findOneAndUpdate(
      { tenantKey: MASTER_TEMPLATE_TENANT, code: template.code },
      {
        $set: {
          ...template,
          tenantKey: MASTER_TEMPLATE_TENANT,
          sourceTemplateCode: template.code,
          status: "ACTIVE",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
};

// Keep every ACTIVE DMS Role created/maintained by MASTER available inside
// every company tenant. Department/User records must reference tenant Role IDs,
// not the shared MASTER template IDs, so materialize any missing MASTER Role
// once and then preserve the Superadmin's permission edits.
//
// IMPORTANT: Role visibility must NOT depend on Plan.roleTemplateCodes. Plans
// can control commercial/package configuration, but MASTER-created Roles such
// as SALES_PERSON must still be visible in Role Management and Department Role
// Assignment. Their effective permissions are still clipped to the company's
// permission ceiling (and later to the Department ceiling), so syncing a Role
// does not grant the company permissions it does not already have.
const ensureTenantMasterRoles = async (req) => {
  if(req.auth.role==="MASTER")return [];
  const tenantKey=String(req.auth.tenantKey||"").trim();
  if(!tenantKey)return [];

  await ensureMasterRoleTemplates();

  const templateFilter={tenantKey:MASTER_TEMPLATE_TENANT,status:"ACTIVE"};
  const templates=(await Role.find(templateFilter).sort({name:1,code:1}).lean())
    .filter(row=>(row.apps||[]).includes("dms"));
  if(!templates.length)return [];

  const ceiling=await companyPermissionCeiling(req);
  for(const template of templates){
    const existing=await Role.findOne({tenantKey,code:template.code});
    if(existing){
      // Registration already marks copied MASTER roles with sourceTemplateCode.
      // Lock their identity without overwriting permissions/rank/department.
      if(existing.sourceTemplateCode){
        let changed=false;
        if(existing.locked!==true){existing.locked=true;changed=true;}
        if(changed)await existing.save();
      }
      continue;
    }

    try{
      await Role.create({
        tenantKey,
        name:template.name,
        code:template.code,
        description:template.description||"",
        apps:["dms"],
        permissions:permissionIntersection(template.permissions||[],ceiling||[]),
        dataScope:template.dataScope||"SELF",
        approvalLimits:template.approvalLimits||{},
        sourceTemplateCode:template.code,
        templateVersion:template.templateVersion||2,
        departmentId:undefined,
        hierarchyOrder:0,
        locked:true,
        status:"ACTIVE"
      });
    }catch(e){
      if(e?.code!==11000)throw e;
    }
  }

  return Role.find({tenantKey,sourceTemplateCode:{$in:templates.map(t=>t.code)}}).lean();
};

router.get("/role-templates", async (req,res) => {
  await ensureMasterRoleTemplates();
  const rows = await Role.find({
    tenantKey: MASTER_TEMPLATE_TENANT,
    status: "ACTIVE",
  })
    .sort({ name: 1, code: 1 })
    .lean();

  const dmsRows = rows
    .filter((row) => (row.apps || []).includes("dms"))
    .map((row) => ({
      ...row,
      apps: ["dms"],
      permissions: dmsOnlyPermissions(row.permissions || []),
    }));

  return ok(res,dmsRows);
});
router.post("/role-templates/reset-defaults", async (_req,res) => fail(res,"MASTER role templates are read-only. They are maintained by the system defaults and selected from Create Plan.",403));
router.post("/role-templates", async (_req,res) => fail(res,"MASTER predefined Roles are read-only. Select them from Create Plan; Superadmins create tenant Roles.",403));
router.put("/role-templates/:id", async (_req,res) => fail(res,"MASTER predefined Roles are read-only. Tenant Roles are managed by Superadmin.",403));
router.delete("/role-templates/:id", async (_req,res) => fail(res,"MASTER predefined Roles are read-only and cannot be deleted.",403));

// ---------- MASTER designation security templates ----------
router.get("/designations", async (req,res) => {
  await ensureDefaultDesignationTemplates();
  const filter={tenantKey:MASTER_DESIGNATION_TENANT};
  if(req.auth.role!=="MASTER") filter.status="ACTIVE";
  const rows=(await DesignationTemplate.find(filter).sort({department:1,name:1}).lean())
    .filter(hasDmsAccess)
    .map((row)=>({...row,apps:["dms"],permissions:dmsOnlyPermissions(row.permissions||[])}));
  return ok(res,rows);
});

router.post("/designations/reset-defaults", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  await ensureDefaultDesignationTemplates();
  const rows=(await DesignationTemplate.find({tenantKey:MASTER_DESIGNATION_TENANT}).sort({department:1,name:1}).lean()).filter(hasDmsAccess).map(row=>({...row,apps:["dms"],permissions:dmsOnlyPermissions(row.permissions||[])}));
  return ok(res,rows,"DMS designation security defaults restored");
});

router.post("/designations", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const payload=designationPayload(req.body);
  if(!payload.name||!payload.code)return fail(res,"Designation name and code are required",400);
  try{
    const row=await DesignationTemplate.create({...payload,tenantKey:MASTER_DESIGNATION_TENANT});
    return ok(res,row,"Designation security template created",201);
  }catch(e){if(e?.code===11000)return fail(res,"Designation code already exists",409);throw e;}
});

router.put("/designations/:id", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const row=await DesignationTemplate.findOne({_id:req.params.id,tenantKey:MASTER_DESIGNATION_TENANT});
  if(!row)return fail(res,"Designation template not found",404);
  Object.assign(row,designationPayload(req.body,row.toObject()));
  await row.save();return ok(res,row,"Designation security template updated");
});

router.delete("/designations/:id", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const row=await DesignationTemplate.findOneAndUpdate({_id:req.params.id,tenantKey:MASTER_DESIGNATION_TENANT},{status:"INACTIVE"},{new:true});
  if(!row)return fail(res,"Designation template not found",404);
  return ok(res,{id:row._id,status:row.status},"Designation template deactivated");
});

router.post("/designations/bulk-upload", upload.single("file"), async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);
  let rows;try{rows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read Excel/CSV file",400);}
  if(!rows.length)return fail(res,"Uploaded file has no rows",400);

  const fields=[
    {key:"code",label:"Designation Code",required:true},{key:"name",label:"Designation Name",required:true},{key:"department",label:"Department"},
    {key:"screenKey",label:"Screen Key",required:true},
    ...PERMISSION_ACTIONS.map(a=>({key:`action_${a.key}`,label:a.label})),
    {key:"fieldAccess",label:"Field Access JSON"},{key:"workflowTransitions",label:"Workflow Transitions JSON"},
    {key:"status",label:"Status"},{key:"description",label:"Description"}
  ];
  const cols=resolveColumns(rows[0],fields);
  const missing=fields.filter(f=>f.required&&!cols[f.key]).map(f=>f.label);if(missing.length)return fail(res,`Missing column(s): ${missing.join(", ")}`,400);

  const screenMap=new Map();for(const group of permissionCatalogue)for(const screen of group.screens||[])screenMap.set(screen.key,{...screen,app:group.app});
  const grouped=new Map(),errors=[];
  for(let i=0;i<rows.length;i++){
    const code=normalizeCode(valueFor(rows[i],cols.code));const name=cleanText(valueFor(rows[i],cols.name));const screenKey=cleanText(valueFor(rows[i],cols.screenKey));
    const screen=screenMap.get(screenKey);if(!code||!name||!screen||screen.app==="master"){if(errors.length<100)errors.push({row:i+2,error:!screen?`Unknown Screen Key: ${screenKey}`:"Designation Code/Name required or MASTER screen not allowed"});continue;}
    if(!grouped.has(code))grouped.set(code,{name,code,department:cleanText(valueFor(rows[i],cols.department)),description:cleanText(valueFor(rows[i],cols.description)),permissions:new Set(),fieldAccess:{},workflowTransitions:{},status:cleanText(valueFor(rows[i],cols.status)).toUpperCase()||"ACTIVE"});
    const g=grouped.get(code);
    for(const action of PERMISSION_ACTIONS){const cell=valueFor(rows[i],cols[`action_${action.key}`]);if(boolCell(cell)&&screen.allowedActions.includes(action.key))g.permissions.add(`${screenKey}.${action.key}`);}
    Object.assign(g.fieldAccess,parseJsonObject(valueFor(rows[i],cols.fieldAccess)));Object.assign(g.workflowTransitions,parseJsonObject(valueFor(rows[i],cols.workflowTransitions)));
  }
  let inserted=0,updated=0;
  for(const g of grouped.values()){
    const permissions=dmsOnlyPermissions([...g.permissions]);
    const update={tenantKey:MASTER_DESIGNATION_TENANT,name:g.name,code:g.code,department:g.department,description:g.description,apps:appsFromPermissions(permissions),permissions,fieldAccess:g.fieldAccess,workflowTransitions:g.workflowTransitions,approvalLimits:{discountPct:0,creditAmount:0,orderAmount:0},status:g.status==="INACTIVE"?"INACTIVE":"ACTIVE",templateVersion:2};
    const result=await DesignationTemplate.updateOne({tenantKey:MASTER_DESIGNATION_TENANT,code:g.code},{$set:update},{upsert:true});inserted+=result.upsertedCount||0;updated+=result.modifiedCount||0;
  }
  return ok(res,{received:rows.length,designations:grouped.size,inserted,updated,invalid:errors.length,errors},"Designation security bulk upload completed");
});

// ---------- Branch offices: SUPERADMIN manages within Plan branch limit ----------
const branchLimitForTenant=async(tenantKey,planCode="")=>{
  const profile=await CompanyProfile.findOne({tenantKey}).select("planCode branchCount").lean();
  const plan=await Plan.findOne({code:planCode||profile?.planCode,status:"ACTIVE"}).lean();
  const raw=plan?.limits?.companies;
  const limit=raw===null||raw===undefined?Math.max(1,Number(profile?.branchCount||1)):Math.max(1,Number(raw||1));
  return {limit,profile,plan};
};
router.get("/branches", async (req,res) => {
  const tenantKey=req.auth.role==="MASTER"&&req.query.tenantKey?await resolveTenantKeyAlias(normalizeCode(req.query.tenantKey)):req.auth.tenantKey;
  const [rows,cap]=await Promise.all([BranchOffice.find({tenantKey,status:{$ne:"INACTIVE"}}).sort({name:1}).lean(),branchLimitForTenant(tenantKey,req.auth.planCode)]);
  return ok(res,{items:rows,limit:cap.limit,used:rows.length,remaining:Math.max(0,cap.limit-rows.length)});
});
router.post("/branches", async (req,res) => {
  if(!["SUPERADMIN","MASTER"].includes(req.auth.role))return fail(res,"Only SUPERADMIN or MASTER can create a branch",403);
  const tenantKey=req.auth.role==="MASTER"?await resolveTenantKeyAlias(normalizeCode(req.body.tenantKey)):req.auth.tenantKey;
  const branchCode=normalizeCode(req.body.branchCode||req.body.name);
  if(!tenantKey||!branchCode||!req.body.name)return fail(res,"Branch code and name are required",400);
  const cap=await branchLimitForTenant(tenantKey,req.auth.planCode);
  const used=await BranchOffice.countDocuments({tenantKey,status:{$ne:"INACTIVE"}});
  if(used>=cap.limit)return fail(res,`Your plan allows maximum ${cap.limit} branch(es). Upgrade the plan or deactivate an existing branch.`,409);
  try{const row=await BranchOffice.create({...req.body,tenantKey,branchCode,createdBy:req.auth.sub});return ok(res,row,"Branch created",201);}catch(e){if(e?.code===11000)return fail(res,"Branch code already exists in this company",409);throw e;}
});
router.put("/branches/:id", async (req,res) => {
  if(!["SUPERADMIN","MASTER"].includes(req.auth.role))return fail(res,"Only SUPERADMIN or MASTER can edit a branch",403);
  const filter={_id:req.params.id};if(req.auth.role!=="MASTER")filter.tenantKey=req.auth.tenantKey;
  const payload={...req.body,updatedBy:req.auth.sub};delete payload.tenantKey;
  const row=await BranchOffice.findOneAndUpdate(filter,payload,{new:true,runValidators:true});if(!row)return fail(res,"Branch not found",404);return ok(res,row,"Branch updated");
});
router.delete("/branches/:id", async (req,res) => {
  if(!["SUPERADMIN","MASTER"].includes(req.auth.role))return fail(res,"Only SUPERADMIN or MASTER can deactivate a branch",403);
  const filter={_id:req.params.id};if(req.auth.role!=="MASTER")filter.tenantKey=req.auth.tenantKey;
  const inUse=await User.countDocuments({tenantKey:req.auth.tenantKey,branchId:req.params.id,status:"ACTIVE"});if(inUse)return fail(res,"This branch has active users. Move them to another branch first.",409);
  const row=await BranchOffice.findOneAndUpdate(filter,{status:"INACTIVE",updatedBy:req.auth.sub},{new:true});if(!row)return fail(res,"Branch not found",404);return ok(res,{id:row._id,status:row.status},"Branch deactivated");
});

router.get("/roles", async (req,res) => {
  if(req.auth.role==="MASTER")return ok(res,[]);
  const tenantKey=req.auth.tenantKey;
  await migrateLegacyTenantDepartments(tenantKey);
  await ensureTenantMasterRoles(req);
  const rows=await Role.find({tenantKey})
    .populate({path:"departmentId",match:{tenantKey:MASTER_DEPARTMENT_TENANT},select:"name code description status reference permissionConfigured permissions"})
    .sort({hierarchyOrder:1,name:1}).lean();
  return ok(res,rows.map(row=>{
    const isMasterRole=Boolean(row.sourceTemplateCode);
    return {...row,apps:["dms"],isMasterRole,canDelete:!isMasterRole,canEditIdentity:!isMasterRole,canEditPermissions:true};
  }));
});

router.post("/roles", async (req,res) => {
  if(req.auth.role!=="SUPERADMIN")return fail(res,"Only SUPERADMIN can create Roles",403);
  const tenantKey=req.auth.tenantKey;
  const payload=rolePayload({...req.body,departmentId:undefined,hierarchyOrder:0});
  if(!payload.name||!payload.code)return fail(res,"Role name and code are required",400);

  const allowed=await companyPermissionCeiling(req);
  const allowedSet=new Set(allowed||[]);
  const requested=operationalPermissions(req.body.permissions||[]);
  const invalid=requested.filter(code=>!allowedSet.has(code));
  if(invalid.length)return fail(res,`You cannot assign ${invalid.length} permission(s) that are not assigned to this Superadmin. Refresh Role Management and select only available permissions.`,409);

  payload.apps=["dms"];
  payload.permissions=permissionIntersection(requested,allowed||[]);
  payload.departmentId=undefined;
  payload.hierarchyOrder=0;

  try{
    const role=await Role.create({...payload,tenantKey,locked:false,sourceTemplateCode:undefined});
    return ok(res,role,"Role created. Add it to a Department and set its rank from Department Role Assignment.",201);
  }catch(e){
    if(e?.code===11000)return fail(res,"A role with this code already exists",409);
    throw e;
  }
});

router.put("/roles/:id", async (req,res) => {
  if(req.auth.role!=="SUPERADMIN")return fail(res,"Only SUPERADMIN can edit Roles",403);
  const role=await Role.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey});
  if(!role)return fail(res,"Role not found",404);

  // MASTER/Plan roles are visible to Superadmin but their identity is fixed.
  // Superadmin may change only their permissions, within the effective ceiling.
  if(role.sourceTemplateCode){
    const allowed=await effectiveRolePermissionCeiling(req,role.departmentId);
    const allowedSet=new Set(allowed||[]);
    const requested=operationalPermissions(req.body.permissions ?? role.permissions ?? []);
    const invalid=requested.filter(code=>!allowedSet.has(code));
    if(invalid.length){
      const suffix=role.departmentId?" or are outside this Role's Department permission ceiling":"";
      return fail(res,`You cannot assign ${invalid.length} permission(s) that are not assigned to this Superadmin${suffix}. Refresh Role Management and select only available permissions.`,409);
    }
    role.permissions=permissionIntersection(requested,allowed||[]);
    role.apps=["dms"];
    role.locked=true;
    await role.save();
    const department=role.departmentId?await activeMasterDepartmentById(role.departmentId).lean():null;
    await User.updateMany(
      {tenantKey:role.tenantKey,$or:[{roleId:role._id},{role:role.code}]},
      {$set:{roleId:role._id,role:role.code,departmentId:role.departmentId||null,department:department?.name||"",permissions:role.permissions||[],apps:["dms"]}}
    );
    return ok(res,role,"MASTER Role permissions updated");
  }

  const oldCode=role.code;
  const payload=rolePayload({...req.body,departmentId:role.departmentId,hierarchyOrder:role.hierarchyOrder},role.toObject());
  const allowed=await effectiveRolePermissionCeiling(req,role.departmentId);
  const allowedSet=new Set(allowed||[]);
  const requested=operationalPermissions(req.body.permissions ?? role.permissions ?? []);
  const invalid=requested.filter(code=>!allowedSet.has(code));
  if(invalid.length){
    const suffix=role.departmentId?" or are outside this Role's Department permission ceiling":"";
    return fail(res,`You cannot assign ${invalid.length} permission(s) that are not assigned to this Superadmin${suffix}. Refresh Role Management and select only available permissions.`,409);
  }
  payload.permissions=permissionIntersection(requested,allowed||[]);
  payload.apps=["dms"];
  payload.code=role.code; // stable identity; rename with Role Name/Description, not code

  // Department and hierarchy rank are controlled only from Department Role
  // Assignment. Role Management cannot silently move a Role.
  payload.departmentId=role.departmentId;
  payload.hierarchyOrder=role.hierarchyOrder;

  if(payload.status==="INACTIVE"&&role.status!=="INACTIVE"){
    const activeUsers=await User.countDocuments({tenantKey:role.tenantKey,status:"ACTIVE",$or:[{roleId:role._id},{role:role.code}]});
    if(activeUsers)return fail(res,"This role has active users. Move or deactivate those users before deactivating the role.",409);
  }

  Object.assign(role,payload);
  await role.save();
  const department=role.departmentId?await activeMasterDepartmentById(role.departmentId).lean():null;
  await User.updateMany(
    {tenantKey:role.tenantKey,$or:[{roleId:role._id},{role:oldCode}]},
    {$set:{roleId:role._id,role:role.code,departmentId:role.departmentId||null,department:department?.name||"",permissions:role.permissions||[],apps:["dms"]}}
  );
  if(role.departmentId)await reconcilePincodeAssignmentsForDepartment(role.tenantKey,role.departmentId,CustomerLink);
  return ok(res,role,"Role updated");
});

router.delete("/roles/:id", async (req,res) => {
  if(req.auth.role!=="SUPERADMIN")return fail(res,"Only SUPERADMIN can delete Roles",403);
  const role=await Role.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey});
  if(!role)return fail(res,"Role not found",404);
  if(role.sourceTemplateCode)return fail(res,"MASTER predefined Roles cannot be deleted. You can edit their permissions and Department hierarchy only.",403);
  const assignedUsers=await User.countDocuments({tenantKey:role.tenantKey,$or:[{roleId:role._id},{role:role.code}]});
  if(assignedUsers)return fail(res,"This role has users. Move or deactivate those users before deleting the role.",409);
  const departmentId=role.departmentId?String(role.departmentId):"";
  await role.deleteOne();
  if(departmentId){await normalizeDepartmentRoleOrders(role.tenantKey,departmentId);await reconcilePincodeAssignmentsForDepartment(role.tenantKey,departmentId,CustomerLink);}
  return ok(res,{deleted:true},"Role deleted");
});

// ---------- Company permission groups ----------
router.get("/groups", async (req,res) => {
  const tenantKey=await tenantFilter(req);
  const rows=await Group.find({tenantKey}).sort({name:1}).lean();
  return ok(res,rows);
});

router.post("/groups", async (req,res) => {
  if(!canManageAccess(req)) return fail(res,"Access administration permission required",403);
  const tenantKey=req.auth.role==="MASTER"&&req.body.tenantKey?await resolveTenantKeyAlias(req.body.tenantKey):req.auth.tenantKey;
  const payload=groupPayload(req.body);
  if(!payload.name||!payload.code) return fail(res,"Group name and code are required",400);
  if(req.auth.role!=="MASTER"){
    const plan=await Plan.findOne({code:req.auth.planCode,status:"ACTIVE"}).lean();
    const enabledApps=plan?.apps?.dms===false?[]:["dms"];
    payload.permissions=filterPermissionsForApps(payload.permissions,enabledApps).filter(code=>!String(code).startsWith("master.")&&!String(code).startsWith("platform."));
  }
  try{const row=await Group.create({...payload,tenantKey});return ok(res,row,"Group created",201)}
  catch(e){if(e?.code===11000)return fail(res,"A group with this code already exists",409);throw e}
});

router.put("/groups/:id", async (req,res) => {
  if(!canManageAccess(req)) return fail(res,"Access administration permission required",403);
  const row=await Group.findById(req.params.id);
  if(!row)return fail(res,"Group not found",404);
  if(req.auth.role!=="MASTER"&&row.tenantKey!==req.auth.tenantKey)return fail(res,"Group not found",404);
  const payload=groupPayload(req.body,row.toObject());
  if(req.auth.role!=="MASTER"){
    const plan=await Plan.findOne({code:req.auth.planCode,status:"ACTIVE"}).lean();
    const enabledApps=plan?.apps?.dms===false?[]:["dms"];
    payload.permissions=filterPermissionsForApps(payload.permissions,enabledApps).filter(code=>!String(code).startsWith("master.")&&!String(code).startsWith("platform."));
  }
  Object.assign(row,payload);
  await row.save();
  return ok(res,row,"Group updated");
});

router.delete("/groups/:id", async (req,res) => {
  if(!canManageAccess(req)) return fail(res,"Access administration permission required",403);
  const row=await Group.findById(req.params.id);
  if(!row)return fail(res,"Group not found",404);
  if(req.auth.role!=="MASTER"&&row.tenantKey!==req.auth.tenantKey)return fail(res,"Group not found",404);
  await row.deleteOne();
  return ok(res,{deleted:true},"Group deleted");
});

router.get("/users", async (req,res) => {
  const tenantKey=await tenantFilter(req), page=Number(req.query.page||1), limit=Math.min(200,Number(req.query.limit||50)), q=String(req.query.q||"").trim();
  const filter={tenantKey};
  if(q) filter.$or=[
    {name:new RegExp(q,"i")},{email:new RegExp(q,"i")},{accountType:new RegExp(q,"i")},
    {tallyAccountTypeName:new RegExp(q,"i")},{tallyAccountTypeCode:new RegExp(q,"i")},{designation:new RegExp(q,"i")},
    {department:new RegExp(q,"i")},{role:new RegExp(q,"i")},{pan:new RegExp(q,"i")},
    {pincode:new RegExp(q,"i")},{city:new RegExp(q,"i")},{district:new RegExp(q,"i")},{state:new RegExp(q,"i")}
  ];
  const [docs,total]=await Promise.all([
    User.find(filter).select("-passwordHash -aadhaarHash -coveragePincodes").populate("roleId","name code hierarchyOrder departmentId").populate("departmentId","name code status").populate("assignedToUserId","name role designation").populate("branchId","name branchCode").sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),
    User.countDocuments(filter)
  ]);
  return ok(res,{items:docs.map(publicUser),meta:pageMeta(page,limit,total)});
});


const userDownloadColumns=[
  {key:"name",label:"Name"},{key:"tallyAccountTypeCode",label:"Account Type"},{key:"dateOfBirth",label:"DOB"},{key:"mobile",label:"Mobile Number",text:true},{key:"email",label:"Email"},{key:"password",label:"Password"},
  {key:"fatherName",label:"Father Name"},{key:"fatherMobile",label:"Father Mobile Number",text:true},{key:"motherMobile",label:"Mother Mobile Number",text:true},{key:"drivingLicenseNumber",label:"Driving License Number"},{key:"aadhaar",label:"Aadhaar Number",text:true},{key:"pan",label:"PAN Number"},
  {key:"ifsc",label:"IFSC Code",text:true},{key:"bankName",label:"Bank Name"},{key:"bankBranchName",label:"Branch / Area"},{key:"bankAddress",label:"Bank Address"},{key:"bankCity",label:"Bank City"},{key:"bankState",label:"Bank State"},{key:"bankContactNo",label:"Bank Contact",text:true},{key:"bankAccountNumber",label:"Account Number",text:true},{key:"bankAccountName",label:"Account Name"},
  {key:"pincode",label:"Pin Code",text:true},{key:"area",label:"Area / Post Office"},{key:"city",label:"City"},{key:"district",label:"District"},{key:"state",label:"State"},{key:"country",label:"Country"},{key:"address",label:"Address"},
  {key:"roleId",label:"Role ID"},{key:"departmentId",label:"Department ID"},{key:"assignedToUserId",label:"Assigned To User ID"},{key:"branchId",label:"Branch ID"},{key:"designation",label:"Designation"},{key:"appointmentDate",label:"Appointment Date"},{key:"salary",label:"Base Salary / Month"},{key:"pfPercentage",label:"PF Percentage"},
  {key:"openingFinancialYear",label:"Opening Financial Year"},{key:"openingBalance",label:"Opening Balance"},{key:"openingBalanceType",label:"O/P Balance Type"},{key:"ledgerName",label:"Ledger Name"},{key:"status",label:"Status"},{key:"loginEnabled",label:"System Login"},
  {key:"lastWorkingFirmName",label:"Last Working Firm Name"},{key:"lastWorkingProfileName",label:"Last Working Profile Name"},{key:"lastWorkingAddress",label:"Last Working Address"},{key:"lastWorkingContactNumber",label:"Last Working Contact Number",text:true},{key:"references",label:"References JSON"}
];
const exportDateText=v=>v?String(v).slice(0,10):"";
function buildAccessExportWorkbook(columns,rows,sheetName){
  const aoa=[columns.map(c=>c.label),...rows.map(row=>columns.map(c=>row?.[c.key]??""))];
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=columns.map(c=>({wch:Math.min(36,Math.max(12,String(c.label).length+3))}));
  columns.forEach((col,colIndex)=>{
    if(!col.text)return;
    for(let rowIndex=1;rowIndex<aoa.length;rowIndex+=1){
      const address=XLSX.utils.encode_cell({r:rowIndex,c:colIndex});
      if(!ws[address])ws[address]={t:"s",v:""};
      ws[address].t="s";ws[address].v=String(ws[address].v??"");ws[address].z="@";
    }
  });
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,sheetName);return XLSX.write(wb,{type:"buffer",bookType:"xlsx"});
}

router.get("/users/export-data.xlsx",async(req,res)=>{
  if(String(req.auth?.role||"").toUpperCase()!=="SUPERADMIN")return fail(res,"Superadmin access required",403);
  try{
    const tenantKey=await tenantFilter(req);
    const docs=await User.find({tenantKey}).select("-passwordHash -aadhaarHash -coveragePincodes").populate("roleId","name code hierarchyOrder departmentId").populate("departmentId","name code status").populate("assignedToUserId","name role designation").populate("branchId","name branchCode").sort({createdAt:-1}).lean();
    const idText=v=>String(v?._id||v||"");
    const rows=docs.map(u=>{const ledger=(u.accountingMappings||[]).find(x=>x?.status!=="INACTIVE")||(u.accountingMappings||[])[0]||{};return {
      name:u.name||"",tallyAccountTypeCode:u.tallyAccountTypeCode||"",dateOfBirth:exportDateText(u.dateOfBirth),mobile:u.mobile||"",email:u.email||"",password:"",fatherName:u.fatherName||"",fatherMobile:u.fatherMobile||"",motherMobile:u.motherMobile||"",drivingLicenseNumber:u.drivingLicenseNumber||"",aadhaar:"",pan:u.pan||"",ifsc:u.bankDetails?.ifsc||"",bankName:u.bankDetails?.bankName||"",bankBranchName:u.bankDetails?.branchName||u.bankDetails?.branchArea||"",bankAddress:u.bankDetails?.bankAddress||"",bankCity:u.bankDetails?.city||"",bankState:u.bankDetails?.state||"",bankContactNo:u.bankDetails?.contactNo||"",bankAccountNumber:u.bankDetails?.accountNumber||"",bankAccountName:u.bankDetails?.accountName||"",pincode:u.pincode||"",area:u.area||"",city:u.city||"",district:u.district||"",state:u.state||"",country:u.country||"India",address:u.address||"",roleId:idText(u.roleId),departmentId:idText(u.departmentId),assignedToUserId:idText(u.assignedToUserId),branchId:idText(u.branchId),designation:u.designation||"",appointmentDate:exportDateText(u.appointmentDate),salary:u.salary??"",pfPercentage:u.pfPercentage??"",openingFinancialYear:u.openingFinancialYear||ledger.financialYear||"",openingBalance:u.openingBalance??ledger.openingBalance??"",openingBalanceType:u.openingBalanceType||ledger.openingBalanceType||"",ledgerName:ledger.ledgerName||"",status:u.status||"",loginEnabled:u.loginEnabled===false?"NO":"YES",lastWorkingFirmName:u.lastWorkingDetails?.firmName||"",lastWorkingProfileName:u.lastWorkingDetails?.profileName||"",lastWorkingAddress:u.lastWorkingDetails?.address||"",lastWorkingContactNumber:u.lastWorkingDetails?.contactNumber||"",references:JSON.stringify(u.references||[])
    }});
    const buffer=buildAccessExportWorkbook(userDownloadColumns,rows,"Users");
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",`attachment; filename="users-data-${new Date().toISOString().slice(0,10)}.xlsx"`);
    return res.send(buffer);
  }catch(e){return fail(res,e.message||"Unable to export users",500);}
});

router.get("/users/options", async (req,res) => {
  const tenantKey=await tenantFilter(req);
  const docs=await User.find({tenantKey,status:"ACTIVE"}).select("name email mobile accountType tallyAccountTypeName tallyAccountTypeCode designation salary role roleId departmentId department pincode city district state loginEnabled systemManaged systemKey systemNote").populate("roleId","name code hierarchyOrder departmentId").populate("departmentId","name code").sort({name:1}).lean();
  return ok(res,docs.map(publicUser));
});

const resolveTallyAccountType = async (rawCode,{required=false}={}) => {
  const code=normalizeCode(rawCode);
  if(!code){
    if(required) throw new Error("TALLY_ACCOUNT_TYPE_REQUIRED");
    return null;
  }

  // The standard Tally heads are application constants. Do not make User
  // creation dependent on seed data or on AccountTemplate already existing.
  const builtIn=DEFAULT_TALLY_ACCOUNT_TYPES.find(row=>row.systemCode===code);
  if(builtIn) return builtIn;

  // Keep support for any additional account templates created later.
  const row=await AccountTemplate.findOne({systemCode:code}).lean();
  if(!row) throw new Error("INVALID_TALLY_ACCOUNT_TYPE");
  return row;
};

const ROLE_DRIVEN_ACCOUNT_CODES = new Set(["SYS_STAFF_ADVANCE","SYS_SALARY_PAYABLE","SYS_REIMBURSEMENT_PAYABLE"]);
const isStandaloneLedgerAccount = (tally) => {
  const code=String(tally?.systemCode||"").toUpperCase();
  if(!code||ROLE_DRIVEN_ACCOUNT_CODES.has(code)) return false;
  const nature=String(tally?.nature||"").toUpperCase();
  return tally?.allowCompanyLedger===true || ["EXPENSE","INCOME","EQUITY"].includes(nature) || code.startsWith("SYS_");
};

const buildPrimaryUserAccounting = ({name,tally,openingBalance,openingBalanceType,openingFinancialYear,ledgerName}) => {
  if(!tally) return { accountingRequired:false, accountingMappings:[] };
  return {
    accountingRequired:true,
    accountingMappings:[{
      relationshipType:"PERSON_ACCOUNT",
      systemAccountCode:tally.systemCode,
      ledgerName:String(ledgerName||"").trim()||`${name} A/c`,
      openingBalance:Number(openingBalance||0),
      openingBalanceType:String(openingBalanceType||"DR").toUpperCase()==="CR"?"CR":"DR",
      financialYear:String(openingFinancialYear||"").trim(),
      status:"ACTIVE"
    }]
  };
};

const syncPrimaryUserAccounting = async (user) => {
  const activeCode=String(user.tallyAccountTypeCode||"").trim().toUpperCase();
  if(activeCode){
    await CompanyLedger.updateMany(
      {tenantKey:user.tenantKey,ownerType:"USER",ownerId:String(user._id),relationshipType:"PERSON_ACCOUNT",systemAccountCode:{$ne:activeCode},status:"ACTIVE"},
      {$set:{status:"INACTIVE"}}
    );
  }
  if(user.accountingRequired && user.accountingMappings?.length) await syncUserLedgers(user);
};


const ensureLedgerLibraryAccountTypes = async () => {
  await ensureDefaultTallyAccountTypes(AccountTemplate);
};

const ledgerLibrarySnapshot = async (tenantKey) => {
  await ensureLedgerLibraryAccountTypes();
  const existingUsers=await User.find({tenantKey}).select("_id name role accountType tallyAccountTypeCode status").lean();
  const byName=new Map();
  for(const user of existingUsers){
    const key=normalizeLedgerLibraryName(user.name);
    if(key&&!byName.has(key))byName.set(key,user);
  }
  const groups=DEFAULT_LEDGER_LIBRARY.map(group=>{
    const ledgers=group.ledgers.map(item=>{
      const existing=byName.get(normalizeLedgerLibraryName(item.name))||null;
      return {
        ...item,
        mainAccountHead:group.mainAccountHead,
        created:Boolean(existing),
        existingUserId:existing?String(existing._id):"",
        existingStatus:existing?.status||"",
        existingAccountType:existing?.accountType||"",
        existingSystemAccountCode:existing?.tallyAccountTypeCode||""
      };
    });
    return {
      mainAccountHead:group.mainAccountHead,
      defaultSystemAccountCode:group.defaultSystemAccountCode,
      total:ledgers.length,
      created:ledgers.filter(x=>x.created).length,
      available:ledgers.filter(x=>!x.created).length,
      ledgers
    };
  });
  return {
    groups,
    totals:{
      mainAccountHeads:groups.length,
      templates:groups.reduce((n,g)=>n+g.total,0),
      created:groups.reduce((n,g)=>n+g.created,0),
      available:groups.reduce((n,g)=>n+g.available,0)
    }
  };
};

const createLedgerLibraryUser = async ({tenantKey,tenantId,template,financialYear,planCode,passwordHash}) => {
  const tally=await resolveTallyAccountType(template.systemAccountCode,{required:true});
  const name=String(template.name||"").trim();
  if(!name)throw new Error("LEDGER_NAME_REQUIRED");
  const password=crypto.randomBytes(32).toString("hex");
  const accounting=buildPrimaryUserAccounting({
    name,tally,openingBalance:0,openingBalanceType:"DR",openingFinancialYear:financialYear,ledgerName:name
  });
  const user=await User.create({
    tenantKey,tenantId,name,
    email:`ledger-${makeId("USR").toLowerCase()}@no-login.rupio.invalid`,
    passwordHash:passwordHash||await bcrypt.hash(password,12),
    loginEnabled:false,
    accountType:String(template.mainAccountHead||tally.name).trim()||tally.name,
    tallyAccountTypeCode:tally.systemCode,
    tallyAccountTypeName:tally.name,
    tallyAccountNature:tally.nature||"",
    openingBalance:0,
    openingBalanceType:"DR",
    openingFinancialYear:financialYear,
    role:"LEDGER_ACCOUNT",
    apps:[],
    permissions:[],
    planCode:planCode||"COMPLETE",
    approvalLimits:{},
    status:"ACTIVE",
    userOverrides:{},
    ...accounting
  });
  try{
    await syncPrimaryUserAccounting(user);
    return user;
  }catch(error){
    await User.deleteOne({_id:user._id}).catch(()=>{});
    throw error;
  }
};

router.get("/ledger-library",async(req,res)=>{
  if(String(req.auth?.role||"").toUpperCase()!=="SUPERADMIN")return fail(res,"Superadmin access required",403);
  try{
    const tenantKey=req.auth.tenantKey;
    return ok(res,await ledgerLibrarySnapshot(tenantKey));
  }catch(e){return fail(res,e.message||"Unable to load ledger library",500);}
});

router.post("/ledger-library/import",async(req,res)=>{
  if(String(req.auth?.role||"").toUpperCase()!=="SUPERADMIN")return fail(res,"Superadmin access required",403);
  try{
    const tenantKey=req.auth.tenantKey;
    await ensureLedgerLibraryAccountTypes();
    const all=flattenLedgerLibrary();
    const requestedKeys=new Set((Array.isArray(req.body.templateKeys)?req.body.templateKeys:[]).map(String));
    const importAll=req.body.importAll===true;
    let selected=importAll?all:all.filter(item=>requestedKeys.has(String(item.templateKey)));
    if(!selected.length)return fail(res,"Select at least one ledger template",400);

    // Ledger names must remain unique in a company. Some supplied categories contain
    // the same ledger label more than once; keep the first occurrence and skip repeats.
    const deduped=[];
    const requestSeen=new Set();
    for(const item of selected){
      const key=normalizeLedgerLibraryName(item.name);
      if(!key||requestSeen.has(key))continue;
      requestSeen.add(key);deduped.push(item);
    }
    selected=deduped;

    const existing=await User.find({tenantKey}).select("_id name status role accountType tallyAccountTypeCode").lean();
    const existingByName=new Map();
    for(const user of existing){
      const key=normalizeLedgerLibraryName(user.name);
      if(key&&!existingByName.has(key))existingByName.set(key,user);
    }

    const profile=await CompanyProfile.findOne({tenantKey}).select("_id financialYear").lean();
    const tenantId=req.auth.tenantId||String(profile?._id||"");
    const financialYear=String(req.body.financialYear||profile?.financialYear||"").trim();
    const created=[],skipped=[],errors=[],toCreate=[];
    for(const template of selected){
      const key=normalizeLedgerLibraryName(template.name);
      const found=existingByName.get(key);
      if(found){
        skipped.push({templateKey:template.templateKey,name:template.name,reason:"ALREADY_EXISTS",existingUserId:String(found._id)});
      }else{
        toCreate.push(template);
        existingByName.set(key,{_id:"PENDING"});
      }
    }

    // These records can never log in, so one strong random hash can safely be
    // reused for this import. It avoids hundreds of expensive bcrypt operations.
    const noLoginPasswordHash=toCreate.length?await bcrypt.hash(crypto.randomBytes(32).toString("hex"),12):"";
    const concurrency=20;
    for(let offset=0;offset<toCreate.length;offset+=concurrency){
      const batch=toCreate.slice(offset,offset+concurrency);
      const results=await Promise.all(batch.map(async template=>{
        try{
          const user=await createLedgerLibraryUser({
            tenantKey,tenantId,template,financialYear,planCode:req.auth.planCode||"COMPLETE",passwordHash:noLoginPasswordHash
          });
          return {ok:true,template,user};
        }catch(error){
          return {ok:false,template,error};
        }
      }));
      for(const result of results){
        if(result.ok){
          const {template,user}=result;
          existingByName.set(normalizeLedgerLibraryName(template.name),user);
          created.push({templateKey:template.templateKey,name:template.name,userId:String(user._id),mainAccountHead:template.mainAccountHead,systemAccountCode:template.systemAccountCode});
        }else{
          const {template,error}=result;
          existingByName.delete(normalizeLedgerLibraryName(template.name));
          errors.push({templateKey:template.templateKey,name:template.name,error:error.message||"Unable to create ledger"});
        }
      }
    }
    return ok(res,{created,skipped,errors,counts:{requested:selected.length,created:created.length,skipped:skipped.length,errors:errors.length}},"Ledger library import completed");
  }catch(e){return fail(res,e.message||"Unable to import ledger library",500);}
});

const resolveUserHierarchyAssignment=async({tenantKey,roleDoc,assignedToUserId})=>{
  const roles=await Role.find({tenantKey,departmentId:roleDoc.departmentId,status:"ACTIVE",hierarchyOrder:{$gt:0}}).sort({hierarchyOrder:1,name:1}).lean();
  const idx=roles.findIndex(r=>String(r._id)===String(roleDoc._id));
  if(idx<0)throw Object.assign(new Error("Set the Role rank in Department Role Assignment before creating users"),{statusCode:409});
  if(idx===0)return {parentRole:null,parentUser:null};
  const parentRole=roles[idx-1];
  if(!assignedToUserId)throw Object.assign(new Error(`Create/select a ${parentRole.name} user first. ${roleDoc.name} must be assigned under the immediate parent role.`),{statusCode:409});
  const parentUser=await User.findOne({_id:assignedToUserId,tenantKey,status:"ACTIVE",roleId:parentRole._id}).lean();
  if(!parentUser)throw Object.assign(new Error(`Selected parent user must belong to ${parentRole.name}`),{statusCode:409});
  return {parentRole,parentUser};
};

const SALES_GEO_ROLES=new Set(["SALES_HEAD","SALES_PERSON"]);
const cleanPincodeList=(values=[])=>Array.from(new Set((values||[]).map(x=>cleanDigits(x).slice(0,6)).filter(x=>x.length===6))).sort();

const validateMasterPincodes=async(pins)=>{
  if(!pins.length)return [];
  const existing=await Pincode.aggregate([
    {$match:{status:{$ne:"INACTIVE"}}},
    {$project:{pin:{$toString:"$pincode"}}},
    {$match:{pin:{$in:pins}}},
    {$group:{_id:"$pin"}}
  ]).allowDiskUse(true);
  const valid=new Set(existing.map(x=>String(x._id)));
  return pins.filter(pin=>!valid.has(pin));
};

const descendantSalesPersons=async(tenantKey,rootUserId)=>{
  const found=[];const seen=new Set([String(rootUserId)]);let frontier=[rootUserId];
  while(frontier.length){
    const children=await User.find({tenantKey,assignedToUserId:{$in:frontier},status:{$ne:"DELETED"}}).select("_id role roleId assignedToUserId").lean();
    frontier=[];
    for(const child of children){
      const id=String(child._id);if(seen.has(id))continue;seen.add(id);
      const code=String(child.role||"").toUpperCase();
      if(code==="SALES_PERSON")found.push(child._id);else frontier.push(child._id);
    }
  }
  return found;
};

const replaceSalesRolePincodes=async({tenantKey,user,roleDoc,pincodes,actorId})=>{
  const code=String(roleDoc?.code||"").toUpperCase();
  if(!SALES_GEO_ROLES.has(code))return {roleCode:code,pincodes:[]};
  const pins=cleanPincodeList(pincodes);
  if(!pins.length)throw Object.assign(new Error(`Select at least one MASTER pincode for the ${code==="SALES_HEAD"?"Sales Head":"Sales Person"}`),{statusCode:409});
  const invalid=await validateMasterPincodes(pins);
  if(invalid.length)throw Object.assign(new Error(`Pincode(s) not found in MASTER: ${invalid.join(", ")}`),{statusCode:409});

  if(code==="SALES_HEAD"){
    // Do not allow a Head's territory to be shrunk underneath existing
    // subordinate Sales Person allotments. Edit those Sales Persons first.
    const descendants=await descendantSalesPersons(tenantKey,user._id);
    if(descendants.length){
      const rows=await PincodeAssignment.find({tenantKey,status:"ACTIVE",userIds:{$in:descendants}}).select("pincode").lean();
      const allowed=new Set(pins);
      const outside=Array.from(new Set(rows.map(r=>String(r.pincode)).filter(pin=>!allowed.has(pin))));
      if(outside.length)throw Object.assign(new Error(`${outside.length} Sales Person pincode allotment(s) fall outside this new Sales Head coverage. Edit/reassign those Sales Persons first.`),{statusCode:409});
    }
    user.coveragePincodes=pins;await user.save();
    return {roleCode:code,pincodes:pins};
  }

  const head=await salesHeadAncestorForUser(tenantKey,user.assignedToUserId);
  if(head&&Array.isArray(head.coveragePincodes)&&head.coveragePincodes.length){
    const coverage=new Set(head.coveragePincodes.map(x=>cleanDigits(x).slice(0,6)));
    const outside=pins.filter(pin=>!coverage.has(pin));
    if(outside.length)throw Object.assign(new Error(`Selected pincode(s) are outside Sales Head ${head.name}'s coverage: ${outside.slice(0,20).join(", ")}${outside.length>20?` +${outside.length-20} more`:""}`),{statusCode:409});
  }

  const departmentId=roleDoc.departmentId;
  const wanted=new Set(pins);
  const current=await PincodeAssignment.find({tenantKey,departmentId,userIds:user._id});
  for(const row of current){
    if(wanted.has(String(row.pincode)))continue;
    const next=(row.userIds||[]).map(String).filter(id=>id!==String(user._id));
    row.userIds=next;row.status=next.length?"ACTIVE":"INACTIVE";row.updatedBy=actorId;await row.save();
  }
  for(const pincode of pins){
    const row=await PincodeAssignment.findOne({tenantKey,departmentId,pincode});
    const ids=new Set((row?.userIds||[]).map(String));ids.add(String(user._id));
    await PincodeAssignment.findOneAndUpdate(
      {tenantKey,departmentId,pincode},
      {$set:{userIds:[...ids],status:"ACTIVE",updatedBy:actorId},$setOnInsert:{createdBy:actorId}},
      {upsert:true,new:true,setDefaultsOnInsert:true}
    );
  }
  await reconcilePincodeAssignmentsForDepartment(tenantKey,departmentId,CustomerLink);
  return {roleCode:code,pincodes:pins};
};

router.post("/users", async (req,res) => {
  if(!canManageAccess(req)) return fail(res,"Access administration permission required",403);
  const tenantKey=req.auth.role==="MASTER" && req.body.tenantKey ? await resolveTenantKeyAlias(req.body.tenantKey) : req.auth.tenantKey;
  const name=String(req.body.name||"").trim();
  if(!name) return fail(res,"Name is required");

  let tally;
  try{ tally=await resolveTallyAccountType(req.body.tallyAccountTypeCode,{required:false}); }
  catch(e){ return fail(res,"Selected Tally Account Type is invalid",400); }
  const explicitLedgerMode=Boolean(String(req.body.ledgerLibraryMainHead||"").trim());
  if(explicitLedgerMode&&!tally) return fail(res,"Accounting Type is required when creating a standalone Ledger Account",400);
  const ledgerOnly=explicitLedgerMode||isStandaloneLedgerAccount(tally);

  let roleDoc=null,department=null,hierarchyAssignment=null;
  if(!ledgerOnly){
    roleDoc=await Role.findOne({_id:req.body.roleId,tenantKey,status:"ACTIVE"});
    if(!roleDoc) return fail(res,"Select a valid active Role",400);
    if(!roleDoc.departmentId) return fail(res,"Assign this Role to a MASTER department before creating users",409);
    if(Number(roleDoc.hierarchyOrder||0)<=0) return fail(res,"Set the Role rank in Department Role Assignment before creating users",409);
    if(String(roleDoc.code||"").trim().toUpperCase()==="CUSTOMER") return fail(res,"CUSTOMER is a structural hierarchy node and cannot be assigned to a person/user",409);
    department=await Department.findOne({_id:roleDoc.departmentId,tenantKey:MASTER_DEPARTMENT_TENANT,status:"ACTIVE"}).lean();
    if(!department) return fail(res,"The Role's department is not active",409);
    try{hierarchyAssignment=await resolveUserHierarchyAssignment({tenantKey,roleDoc,assignedToUserId:req.body.assignedToUserId});}
    catch(e){return fail(res,e.message,e.statusCode||409);}
  }

  const pan=ledgerOnly?"":normalizePersonPan(req.body.pan);
  const aadhaar=ledgerOnly?"":cleanDigits(req.body.aadhaar).slice(0,12);
  if(pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return fail(res,"Enter a valid 10-character PAN",400);
  if(aadhaar && aadhaar.length!==12) return fail(res,"Aadhaar must contain 12 digits",400);
  if(pan && await User.exists({tenantKey,pan})) return fail(res,"A person with this PAN already exists",409);
  if(aadhaar && await User.exists({tenantKey,aadhaarHash:personHashAadhaar(aadhaar)})) return fail(res,"A person with this Aadhaar already exists",409);

  const loginEnabled=ledgerOnly?false:req.body.loginEnabled===true;
  let email=String(req.body.email||"").trim().toLowerCase();
  let password=String(req.body.password||"");
  if(loginEnabled){
    if(!email || password.length<8) return fail(res,"For System Login, email and password of at least 8 characters are required",400);
    if(await User.exists({email})) return fail(res,"A user with this email already exists",409);
  }else{
    email=`person-${makeId("USR").toLowerCase()}@no-login.rupio.invalid`;
    password=crypto.randomBytes(32).toString("hex");
  }

  const location=ledgerOnly?{}:await pincodeProfile(req.body.pincode,req.body);
  const requestedApps=ledgerOnly?[]:(req.body.apps || roleDoc?.apps || []);
  let apps=requestedApps;
  const planCode=req.body.planCode || req.auth.planCode || "COMPLETE";
  const plan=await Plan.findOne({code:planCode}).lean();
  if(!ledgerOnly&&plan && req.auth.role!=="MASTER") apps=requestedApps.filter(k=>Boolean(plan.apps?.[k]));
  let tenantId=req.auth.tenantId||"";
  const profile=await CompanyProfile.findOne({tenantKey}).select("_id financialYear").lean();
  if(!tenantId && profile?._id)tenantId=String(profile._id);
  const openingFinancialYear=String(req.body.openingFinancialYear||profile?.financialYear||"").trim();
  const accounting=buildPrimaryUserAccounting({
    name,tally,openingBalance:req.body.openingBalance,openingBalanceType:req.body.openingBalanceType,
    openingFinancialYear,ledgerName:req.body.ledgerName
  });

  let branchDoc=null;
  if(!ledgerOnly&&req.body.branchId){
    branchDoc=await BranchOffice.findOne({_id:req.body.branchId,tenantKey,status:"ACTIVE"}).lean();
    if(!branchDoc)return fail(res,"Selected Branch is not active",409);
  }

  let resolvedUserBank=null;
  if(!ledgerOnly){
    try{
      resolvedUserBank=await resolveBankDetails({
        ifsc:req.body.ifsc,accountNumber:req.body.bankAccountNumber,accountName:req.body.bankAccountName,bankName:req.body.bankName
      },{optional:true});
    }catch(error){return fail(res,error.message,error.statusCode||400);}
  }

  const base={
    tenantKey,tenantId,name,email,passwordHash:await bcrypt.hash(password,12),loginEnabled,
    accountType:ledgerOnly?(String(req.body.ledgerLibraryMainHead||"").trim()||tally?.name||""):roleDoc.name,
    tallyAccountTypeCode:tally?.systemCode||"",tallyAccountTypeName:tally?.name||"",tallyAccountNature:tally?.nature||"",
    openingBalance:Number(req.body.openingBalance||0),openingBalanceType:String(req.body.openingBalanceType||"DR").toUpperCase()==="CR"?"CR":"DR",openingFinancialYear,
    role:ledgerOnly?"LEDGER_ACCOUNT":roleDoc.code,
    apps:ledgerOnly?[]:apps,permissions:ledgerOnly?[]:(roleDoc.permissions||[]),planCode,
    approvalLimits:ledgerOnly?{}:(roleDoc.approvalLimits||{}),status:req.body.status||"ACTIVE",userOverrides:req.body.userOverrides||{},
    ...accounting
  };

  if(!ledgerOnly){
    Object.assign(base,{
      dateOfBirth:req.body.dateOfBirth||undefined,
      mobile:req.body.mobile||"",
      fatherName:String(req.body.fatherName||"").trim(),fatherMobile:String(req.body.fatherMobile||"").trim(),motherMobile:String(req.body.motherMobile||"").trim(),
      drivingLicenseNumber:String(req.body.drivingLicenseNumber||"").trim().toUpperCase(),country:String(req.body.country||"India").trim()||"India",
      appointmentDate:req.body.appointmentDate||undefined,pfPercentage:Math.max(0,Number(req.body.pfPercentage||0)),
      bankDetails:resolvedUserBank||undefined,
      lastWorkingDetails:{firmName:String(req.body.lastWorkingFirmName||"").trim(),profileName:String(req.body.lastWorkingProfileName||"").trim(),address:String(req.body.lastWorkingAddress||"").trim(),contactNumber:String(req.body.lastWorkingContactNumber||"").trim()},
      references:Array.isArray(req.body.references)?req.body.references.filter(x=>x&&(x.name||x.mobile)).map(x=>({name:String(x.name||"").trim(),relation:String(x.relation||"").trim(),mobile:String(x.mobile||"").trim()})):[],
      assignedToUserId:hierarchyAssignment?.parentUser?._id||undefined,branchId:req.body.branchId||undefined,
      salary:Number(req.body.salary||0),designation:String(req.body.designation||"").trim(),address:String(req.body.address||"").trim(),pan:pan||undefined,
      aadhaarHash:aadhaar?personHashAadhaar(aadhaar):undefined,aadhaarMasked:aadhaar?personMaskAadhaar(aadhaar):"",
      ...location,
      roleId:roleDoc._id,departmentId:department._id,department:department.name,
      employeeId:req.body.employeeId||"",branch:branchDoc?.name||"",warehouseId:req.body.warehouseId||""
    });
  }

  const user=await User.create(base);
  if(!ledgerOnly){
    try{await replaceSalesRolePincodes({tenantKey,user,roleDoc,pincodes:req.body.pincodes,actorId:req.auth.sub});}
    catch(e){await User.deleteOne({_id:user._id});return fail(res,e.message,e.statusCode||409);}
  }
  await syncPrimaryUserAccounting(user);
  return ok(res,publicUser(user),ledgerOnly?"Ledger account created":"Person / User created",201);
});

router.put("/users/:id", async (req,res) => {
  if(!canManageAccess(req)) return fail(res,"Access administration permission required",403);
  const user=await User.findById(req.params.id); if(!user) return fail(res,"User not found",404);
  if(req.auth.role!=="MASTER" && user.tenantKey!==req.auth.tenantKey) return fail(res,"User not found",404);
  if(isSystemCashRecord(user)) return fail(res,"CASH is a system-managed account and cannot be edited, assigned or deleted",409);
  const oldDepartmentId=user.departmentId?String(user.departmentId):"";
  const payload={};
  let nextTallyForMode=null;
  try{ nextTallyForMode=await resolveTallyAccountType(req.body.tallyAccountTypeCode!==undefined?req.body.tallyAccountTypeCode:user.tallyAccountTypeCode,{required:false}); }
  catch(e){ return fail(res,"Selected Tally Account Type is invalid",400); }
  const ledgerOnlyMode=Boolean(String(req.body.ledgerLibraryMainHead||user.accountType||"").trim()&&user.role==="LEDGER_ACCOUNT")||Boolean(String(req.body.ledgerLibraryMainHead||"").trim())||isStandaloneLedgerAccount(nextTallyForMode);
  for(const key of ["name","mobile","employeeId","status","designation","fatherName","fatherMobile","motherMobile","drivingLicenseNumber","country"]){
    if(req.body[key]!==undefined)payload[key]=req.body[key];
  }
  if(req.body.salary!==undefined)payload.salary=Math.max(0,Number(req.body.salary||0));
  if(req.body.dateOfBirth!==undefined)payload.dateOfBirth=req.body.dateOfBirth||undefined;
  if(req.body.appointmentDate!==undefined)payload.appointmentDate=req.body.appointmentDate||undefined;
  if(req.body.pfPercentage!==undefined)payload.pfPercentage=Math.max(0,Number(req.body.pfPercentage||0));
  if(req.body.address!==undefined)payload.address=String(req.body.address||"").trim();
  if(["bankName","bankAccountNumber","bankAccountName","ifsc"].some(k=>req.body[k]!==undefined)){
    try{
      payload.bankDetails=await resolveBankDetails({
        ifsc:req.body.ifsc??user.bankDetails?.ifsc,
        accountNumber:req.body.bankAccountNumber??user.bankDetails?.accountNumber,
        accountName:req.body.bankAccountName??user.bankDetails?.accountName,
        bankName:req.body.bankName??user.bankDetails?.bankName
      },{optional:true})||undefined;
    }catch(error){return fail(res,error.message,error.statusCode||400);}
  }
  if(["lastWorkingFirmName","lastWorkingProfileName","lastWorkingAddress","lastWorkingContactNumber"].some(k=>req.body[k]!==undefined))payload.lastWorkingDetails={firmName:String(req.body.lastWorkingFirmName??user.lastWorkingDetails?.firmName??"").trim(),profileName:String(req.body.lastWorkingProfileName??user.lastWorkingDetails?.profileName??"").trim(),address:String(req.body.lastWorkingAddress??user.lastWorkingDetails?.address??"").trim(),contactNumber:String(req.body.lastWorkingContactNumber??user.lastWorkingDetails?.contactNumber??"").trim()};
  if(Array.isArray(req.body.references))payload.references=req.body.references.filter(x=>x&&(x.name||x.mobile)).map(x=>({name:String(x.name||"").trim(),relation:String(x.relation||"").trim(),mobile:String(x.mobile||"").trim()}));
  if(req.body.branchId!==undefined){const b=req.body.branchId?await BranchOffice.findOne({_id:req.body.branchId,tenantKey:user.tenantKey,status:"ACTIVE"}).lean():null;if(req.body.branchId&&!b)return fail(res,"Selected Branch is not active",409);payload.branchId=b?._id||undefined;payload.branch=b?.name||"";}

  const pan=req.body.pan!==undefined?normalizePersonPan(req.body.pan):undefined;
  if(pan!==undefined){
    if(pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return fail(res,"Enter a valid 10-character PAN",400);
    if(pan && await User.exists({_id:{$ne:user._id},tenantKey:user.tenantKey,pan})) return fail(res,"A person with this PAN already exists",409);
    payload.pan=pan||undefined;
  }
  if(req.body.aadhaar!==undefined){
    const aadhaar=cleanDigits(req.body.aadhaar).slice(0,12);
    if(aadhaar && aadhaar.length!==12) return fail(res,"Aadhaar must contain 12 digits",400);
    if(aadhaar && await User.exists({_id:{$ne:user._id},tenantKey:user.tenantKey,aadhaarHash:personHashAadhaar(aadhaar)})) return fail(res,"A person with this Aadhaar already exists",409);
    if(aadhaar){payload.aadhaarHash=personHashAadhaar(aadhaar);payload.aadhaarMasked=personMaskAadhaar(aadhaar);}
  }
  if(!ledgerOnlyMode&&req.body.pincode!==undefined){Object.assign(payload,await pincodeProfile(req.body.pincode,req.body));}

  if(ledgerOnlyMode){
    Object.assign(payload,{
      role:"LEDGER_ACCOUNT",roleId:undefined,departmentId:undefined,department:"",assignedToUserId:undefined,
      branchId:undefined,branch:"",designation:"",appointmentDate:undefined,salary:0,pfPercentage:0,
      loginEnabled:false,apps:[],permissions:[],approvalLimits:{},accountType:String(req.body.ledgerLibraryMainHead||"").trim()||user.accountType||nextTallyForMode.name,
      mobile:"",dateOfBirth:undefined,fatherName:"",fatherMobile:"",motherMobile:"",drivingLicenseNumber:"",country:"India",
      bankDetails:undefined,lastWorkingDetails:undefined,references:[],address:"",pan:undefined,aadhaarHash:undefined,aadhaarMasked:"",
      pincode:undefined,area:"",city:"",district:"",state:"",coveragePincodes:[]
    });
  }

  if(!ledgerOnlyMode&&req.body.roleId){
    const roleDoc=await Role.findOne({_id:req.body.roleId,tenantKey:user.tenantKey,status:"ACTIVE"});
    if(!roleDoc)return fail(res,"Selected Role does not belong to this company",409);
    if(!roleDoc.departmentId)return fail(res,"Assign this Role to a MASTER department before assigning users",409);
    if(Number(roleDoc.hierarchyOrder||0)<=0)return fail(res,"Set the Role rank in Department Role Assignment before assigning users",409);
    if(String(roleDoc.code||"").trim().toUpperCase()==="CUSTOMER")return fail(res,"CUSTOMER is a structural hierarchy node and cannot be assigned to a person/user",409);
    const department=await Department.findOne({_id:roleDoc.departmentId,tenantKey:MASTER_DEPARTMENT_TENANT,status:"ACTIVE"}).lean();
    if(!department)return fail(res,"The Role's department is not active",409);
    payload.roleId=roleDoc._id;payload.role=roleDoc.code;payload.accountType=roleDoc.name;payload.departmentId=department._id;payload.department=department.name;payload.permissions=roleDoc.permissions||[];payload.apps=roleDoc.apps||[];payload.approvalLimits=roleDoc.approvalLimits||{};
  }

  if(!ledgerOnlyMode&&(req.body.roleId!==undefined||req.body.assignedToUserId!==undefined)){
    const effectiveRole=await Role.findOne({_id:payload.roleId||user.roleId,tenantKey:user.tenantKey,status:"ACTIVE"});
    if(effectiveRole){try{const hierarchy=await resolveUserHierarchyAssignment({tenantKey:user.tenantKey,roleDoc:effectiveRole,assignedToUserId:req.body.assignedToUserId!==undefined?req.body.assignedToUserId:user.assignedToUserId});payload.assignedToUserId=hierarchy.parentUser?._id||undefined;}catch(e){return fail(res,e.message,e.statusCode||409);}}
  }

  const shouldRefreshAccounting=["tallyAccountTypeCode","openingBalance","openingBalanceType","openingFinancialYear","ledgerName","name"].some(k=>req.body[k]!==undefined);
  if(shouldRefreshAccounting){
    const tally=nextTallyForMode;
    const openingBalance=req.body.openingBalance!==undefined?Number(req.body.openingBalance||0):Number(user.openingBalance||0);
    const openingBalanceType=String(req.body.openingBalanceType||user.openingBalanceType||"DR").toUpperCase()==="CR"?"CR":"DR";
    const openingFinancialYear=String(req.body.openingFinancialYear!==undefined?req.body.openingFinancialYear:(user.openingFinancialYear||"")).trim();
    const nextName=String(req.body.name!==undefined?req.body.name:user.name).trim();
    const currentPrimary=(user.accountingMappings||[]).find(x=>x.relationshipType==="PERSON_ACCOUNT");
    const accounting=buildPrimaryUserAccounting({name:nextName,tally,openingBalance,openingBalanceType,openingFinancialYear,ledgerName:req.body.ledgerName||currentPrimary?.ledgerName});
    payload.tallyAccountTypeCode=tally?.systemCode||"";payload.tallyAccountTypeName=tally?.name||"";payload.tallyAccountNature=tally?.nature||"";
    payload.openingBalance=openingBalance;payload.openingBalanceType=openingBalanceType;payload.openingFinancialYear=openingFinancialYear;
    payload.accountingRequired=accounting.accountingRequired;payload.accountingMappings=accounting.accountingMappings;
    if(ledgerOnlyMode){
      if(!tally)return fail(res,"Accounting Type is required for a standalone Ledger Account",400);
      payload.accountType=String(req.body.ledgerLibraryMainHead||"").trim()||user.accountType||tally.name;
    }
  }

  if(!ledgerOnlyMode&&req.body.loginEnabled!==undefined){
    const enable=req.body.loginEnabled===true;
    if(enable){
      const email=String(req.body.email||(!String(user.email).endsWith("@no-login.rupio.invalid")?user.email:"")).trim().toLowerCase();
      if(!email)return fail(res,"Email is required when System Login is enabled",400);
      if(await User.exists({_id:{$ne:user._id},email}))return fail(res,"A user with this email already exists",409);
      if(user.loginEnabled===false && String(req.body.password||"").length<8)return fail(res,"Enter a password of at least 8 characters when enabling System Login",400);
      payload.email=email;
      if(req.body.password)payload.passwordHash=await bcrypt.hash(String(req.body.password),12);
    }
    payload.loginEnabled=enable;
  }else if(!ledgerOnlyMode&&user.loginEnabled!==false && req.body.email!==undefined){
    const email=String(req.body.email||"").trim().toLowerCase();
    if(!email)return fail(res,"Email cannot be blank while System Login is enabled",400);
    if(await User.exists({_id:{$ne:user._id},email}))return fail(res,"A user with this email already exists",409);
    payload.email=email;
  }
  if(!ledgerOnlyMode&&req.body.password && (req.body.loginEnabled===true || user.loginEnabled!==false)){
    const password=String(req.body.password);if(password.length<8)return fail(res,"Password must be at least 8 characters",400);payload.passwordHash=await bcrypt.hash(password,12);
  }

  if(payload.apps && req.auth.role!=="MASTER"){
    const plan=await Plan.findOne({code:user.planCode}).lean();if(plan)payload.apps=payload.apps.filter(k=>Boolean(plan.apps?.[k]));
  }
  Object.assign(user,payload);await user.save();
  await syncPrimaryUserAccounting(user);
  if(oldDepartmentId) await reconcilePincodeAssignmentsForDepartment(user.tenantKey,oldDepartmentId,CustomerLink);
  if(user.departmentId && String(user.departmentId)!==oldDepartmentId) await reconcilePincodeAssignmentsForDepartment(user.tenantKey,user.departmentId,CustomerLink);
  if(!ledgerOnlyMode&&req.body.pincodes!==undefined){const effectiveRole=await Role.findOne({_id:user.roleId,tenantKey:user.tenantKey,status:"ACTIVE"});if(effectiveRole){try{await replaceSalesRolePincodes({tenantKey:user.tenantKey,user,roleDoc:effectiveRole,pincodes:req.body.pincodes,actorId:req.auth.sub});}catch(e){return fail(res,e.message,e.statusCode||409);}}}
  return ok(res,publicUser(user),"Person / User updated");
});

router.post("/users/:id/reset-password", async (req,res) => {
  if(!canManageAccess(req)) return fail(res,"Access administration permission required",403);
  const password=String(req.body.password||""); if(password.length<8) return fail(res,"Password must be at least 8 characters");
  const user=await User.findById(req.params.id); if(!user) return fail(res,"User not found",404);
  if(req.auth.role!=="MASTER" && user.tenantKey!==req.auth.tenantKey) return fail(res,"User not found",404);
  if(isSystemCashRecord(user)) return fail(res,"CASH is system-managed and does not have a login password",409);
  if(user.loginEnabled===false)return fail(res,"System Login is disabled for this person. Edit the person and enable System Login first.",409);
  user.passwordHash=await bcrypt.hash(password,12); await user.save(); return ok(res,{reset:true},"Password reset");
});

router.post("/users/:id/status", async (req,res) => {
  if(!canManageAccess(req)) return fail(res,"Access administration permission required",403);
  const user=await User.findById(req.params.id); if(!user) return fail(res,"User not found",404);
  if(req.auth.role!=="MASTER" && user.tenantKey!==req.auth.tenantKey) return fail(res,"User not found",404);
  if(isSystemCashRecord(user)) return fail(res,"CASH is a protected system account and cannot be deactivated or deleted",409);
  const nextStatus=req.body.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
  if(nextStatus==="INACTIVE"&&user.status!=="INACTIVE"){
    const references=await userReferenceDetails(user.tenantKey,String(user._id));
    if(references.length)return fail(res,`${user.name||"User"} is already involved in ${references.slice(0,5).join(", ")} and cannot be deleted/deactivated. Keep the user record and remove future access through role/login settings instead.`,409);
  }
  if(nextStatus==="ACTIVE"&&user.role!=="SUPERADMIN"&&user.role!=="LEDGER_ACCOUNT"){
    const roleDoc=await Role.findOne({_id:user.roleId,tenantKey:user.tenantKey,status:"ACTIVE"}).lean();
    if(!roleDoc||!roleDoc.departmentId||Number(roleDoc.hierarchyOrder||0)<=0)return fail(res,"This person's Account Type / Role is not active/ranked in a Department.",409);
    const department=await activeMasterDepartmentById(roleDoc.departmentId).lean();
    if(!department)return fail(res,"This person's Department is inactive",409);
  }
  user.status=nextStatus; await user.save();
  if(user.departmentId) await reconcilePincodeAssignmentsForDepartment(user.tenantKey,user.departmentId,CustomerLink);
  return ok(res,{id:user._id,status:user.status},"User status updated");
});

// ---------- MASTER Department -> Superadmin Role -> User -> Pincode hierarchy ----------
// Departments are global MASTER-owned definitions. MASTER also owns the
// Department permission ceiling. Superadmins can only read Departments and can
// grant a Role permissions that survive BOTH ceilings:
// Plan/Group ceiling AND Department ceiling.
router.get("/departments", async (req,res) => {
  await ensureMasterDepartmentReferences();
  const rows=await Department.find({tenantKey:MASTER_DEPARTMENT_TENANT}).sort({name:1}).lean();
  const shaped=rows.map(row=>({
    ...row,
    permissionCount:operationalPermissions(row.permissions||[]).length,
    permissionConfigured:row.permissionConfigured===true,
    isMasterTemplate:true,
  }));
  if(req.auth.role==="MASTER")return ok(res,shaped.map(row=>({...row,canEdit:true,canDelete:true})));

  await migrateLegacyTenantDepartments(req.auth.tenantKey);
  const tenantRoles=await Role.find({tenantKey:req.auth.tenantKey,status:"ACTIVE",departmentId:{$ne:null}}).select("departmentId code hierarchyOrder").lean();
  const assignmentEnabled=new Set(
    tenantRoles.filter(r=>Number(r.hierarchyOrder||0)>0&&String(r.code||"").toUpperCase()==="SALES_PERSON").map(r=>String(r.departmentId))
  );
  return ok(res,shaped.map(row=>({...row,canEdit:false,canDelete:false,customerAssignmentEnabled:assignmentEnabled.has(String(row._id))})));
});

// Download a live XLSX permission matrix for every MASTER Department. The same
// file can be edited and uploaded back through /departments/bulk-permissions.
router.get("/departments/permission-format", async (req,res) => {
  if(req.auth.role!=="MASTER")return fail(res,"MASTER access required",403);
  await ensureMasterDepartmentReferences();
  const departments=await Department.find({tenantKey:MASTER_DEPARTMENT_TENANT}).sort({name:1}).lean();
  const output=[];

  for(const department of departments){
    const selected=new Set(operationalPermissions(department.permissions||[]));
    for(const group of permissionCatalogue.filter(g=>OPERATIONAL_PERMISSION_APPS.has(g.app))){
      for(const screen of group.screens||[]){
        const row={
          "Department Reference":department.reference||department.code,
          "Department Name":department.name,
          "Department Status":department.status||"ACTIVE",
          "Category":group.category||"",
          "Screen Key":screen.key,
          "Screen Name":screen.label,
        };
        let enabledCount=0;
        for(const action of PERMISSION_ACTIONS){
          const permittedByScreen=(screen.allowedActions||[]).includes(action.key);
          const enabled=permittedByScreen&&selected.has(`${screen.key}.${action.key}`);
          row[action.label]=enabled?1:0;
          if(enabled)enabledCount+=1;
        }
        const screenActionCount=(screen.allowedActions||[]).length;
        row["Access Mode"]=enabledCount===0?"NONE":enabledCount===screenActionCount?"FULL":"LIMITED";
        row["Working Reason"]=department.permissionConfigured===true?"Current MASTER Department permission ceiling":"Not configured yet - edit 0/1 values and bulk upload";
        output.push(row);
      }
    }
  }

  const ws=XLSX.utils.json_to_sheet(output,{header:[
    "Department Reference","Department Name","Department Status","Category","Screen Key","Screen Name",
    ...PERMISSION_ACTIONS.map(a=>a.label),"Access Mode","Working Reason"
  ]});
  ws["!cols"]=[
    {wch:22},{wch:38},{wch:18},{wch:24},{wch:42},{wch:36},
    ...PERMISSION_ACTIONS.map(()=>({wch:12})),{wch:14},{wch:55}
  ];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,"Bulk_Upload");
  const buffer=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",'attachment; filename="Department_Permission_Bulk_Upload.xlsx"');
  return res.send(buffer);
});

// Bulk upload is a FULL REPLACEMENT for each Department included in the file:
// every 1/Yes/X becomes active; everything else becomes inactive. To avoid an
// accidental partial wipe, a Department is applied only when all known DMS
// Screen Keys are present for that Department.
router.post("/departments/bulk-permissions", upload.single("file"), async (req,res) => {
  if(req.auth.role!=="MASTER")return fail(res,"MASTER access required",403);
  if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);

  let rows;
  try{rows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read Excel/CSV file",400);}
  if(!rows.length)return fail(res,"Uploaded permission file has no rows",400);

  const fields=[
    {key:"departmentReference",label:"Department Reference",aliases:["Department ID","Department Code","Reference"]},
    {key:"departmentName",label:"Department Name",aliases:["Department"]},
    {key:"screenKey",label:"Screen Key",required:true},
    ...PERMISSION_ACTIONS.map(a=>({key:`action_${a.key}`,label:a.label})),
  ];
  const cols=resolveColumns(rows[0],fields);
  const missing=fields.filter(f=>f.required&&!cols[f.key]).map(f=>f.label);
  if(missing.length)return fail(res,`Missing column(s): ${missing.join(", ")}`,400);
  if(!cols.departmentReference&&!cols.departmentName)return fail(res,"Department Reference or Department Name column is required",400);

  await ensureMasterDepartmentReferences();
  const departments=await Department.find({tenantKey:MASTER_DEPARTMENT_TENANT});
  const byReference=new Map();
  const byCode=new Map();
  const byName=new Map();
  for(const department of departments){
    if(department.reference)byReference.set(String(department.reference).trim().toUpperCase(),department);
    byCode.set(String(department.code||"").trim().toUpperCase(),department);
    byName.set(String(department.name||"").trim().toUpperCase(),department);
  }

  const screenMap=new Map();
  const requiredScreenKeys=new Set();
  for(const group of permissionCatalogue.filter(g=>OPERATIONAL_PERMISSION_APPS.has(g.app))){
    for(const screen of group.screens||[]){
      screenMap.set(screen.key,{...screen,category:group.category});
      requiredScreenKeys.add(screen.key);
    }
  }

  const grouped=new Map();
  const errors=[];
  const pushError=(entry)=>{if(errors.length<2000)errors.push(entry);};

  for(let i=0;i<rows.length;i++){
    const excelRow=i+2;
    const ref=cleanText(valueFor(rows[i],cols.departmentReference)).toUpperCase();
    const name=cleanText(valueFor(rows[i],cols.departmentName)).toUpperCase();
    const screenKey=cleanText(valueFor(rows[i],cols.screenKey));
    const department=byReference.get(ref)||byCode.get(ref)||byName.get(name);

    if(!department){
      pushError({row:excelRow,departmentReference:ref,departmentName:name,screenKey,error:"Department not found in MASTER Department catalogue"});
      continue;
    }
    if(ref&&String(ref).startsWith("DEPAR-")&&!department.reference){
      department.reference=ref;
      await department.save();
      byReference.set(ref,department);
    }

    const screen=screenMap.get(screenKey);
    if(!screen){
      pushError({row:excelRow,departmentReference:department.reference||department.code,departmentName:department.name,screenKey,error:`Unknown DMS Screen Key: ${screenKey}`});
      continue;
    }

    const key=String(department._id);
    if(!grouped.has(key))grouped.set(key,{department,permissions:new Set(),screenKeys:new Set(),invalid:false});
    const bucket=grouped.get(key);
    bucket.screenKeys.add(screenKey);

    for(const action of PERMISSION_ACTIONS){
      const enabled=boolCell(valueFor(rows[i],cols[`action_${action.key}`]));
      if(!enabled)continue;
      if(!(screen.allowedActions||[]).includes(action.key)){
        bucket.invalid=true;
        pushError({row:excelRow,departmentReference:department.reference||department.code,departmentName:department.name,screenKey,action:action.label,error:`${action.label} is not a valid action for ${screen.label}`});
        continue;
      }
      bucket.permissions.add(`${screenKey}.${action.key}`);
    }
  }

  let appliedDepartments=0,skippedDepartments=0,totalPermissions=0,rolesClamped=0,usersSynced=0;
  const applied=[];
  for(const bucket of grouped.values()){
    const missingScreens=[...requiredScreenKeys].filter(key=>!bucket.screenKeys.has(key));
    if(missingScreens.length){
      bucket.invalid=true;
      pushError({row:"DEPARTMENT",departmentReference:bucket.department.reference||bucket.department.code,departmentName:bucket.department.name,screenKey:"",error:`Incomplete matrix: ${missingScreens.length} DMS Screen Key(s) are missing. Download the latest format and upload the complete Department matrix.`});
    }
    if(bucket.invalid){skippedDepartments+=1;continue;}

    const permissions=operationalPermissions([...bucket.permissions]);
    bucket.department.permissions=permissions;
    bucket.department.permissionConfigured=true;
    bucket.department.permissionUpdatedAt=new Date();
    bucket.department.permissionUpdatedBy=req.auth.sub;
    bucket.department.updatedBy=req.auth.sub;
    await bucket.department.save();

    const clamp=await clampRolesToDepartmentCeiling(bucket.department);
    rolesClamped+=clamp.rolesClamped;
    usersSynced+=clamp.usersSynced;
    totalPermissions+=permissions.length;
    appliedDepartments+=1;
    applied.push({
      id:String(bucket.department._id),reference:bucket.department.reference||"",name:bucket.department.name,
      permissionCount:permissions.length
    });
  }

  if(!appliedDepartments&&grouped.size){
    return ok(res,{
      received:rows.length,departmentsInFile:grouped.size,appliedDepartments:0,skippedDepartments,
      totalPermissions:0,rolesClamped:0,usersSynced:0,applied:[],invalid:errors.length,errors
    },"No Department permission matrix was applied. Download the error file, correct the rows and upload the complete matrix again.");
  }

  return ok(res,{
    received:rows.length,
    departmentsInFile:grouped.size,
    appliedDepartments,
    skippedDepartments,
    totalPermissions,
    rolesClamped,
    usersSynced,
    applied,
    invalid:errors.length,
    errors
  },`Department permission ceiling uploaded for ${appliedDepartments} Department(s)`);
});

router.post("/departments", async (req,res) => {
  if(req.auth.role!=="MASTER")return fail(res,"Only MASTER can create Departments",403);
  const name=String(req.body.name||"").trim();
  const code=normalizeCode(req.body.code||name);
  if(!name||!code)return fail(res,"Department name is required",400);
  try{
    const row=await Department.create({
      tenantKey:MASTER_DEPARTMENT_TENANT,
      reference:makeId("DEPAR"),
      name,code,description:String(req.body.description||"").trim(),
      permissions:[],permissionConfigured:false,
      customerAssignmentEnabled:false,
      status:req.body.status==="INACTIVE"?"INACTIVE":"ACTIVE",createdBy:req.auth.sub
    });
    return ok(res,row,"MASTER Department created",201);
  }catch(e){if(e?.code===11000)return fail(res,"A MASTER Department with this code already exists",409);throw e;}
});

router.put("/departments/:id", async (req,res) => {
  if(req.auth.role!=="MASTER")return fail(res,"Only MASTER can edit Departments",403);
  const row=await Department.findOne({_id:req.params.id,tenantKey:MASTER_DEPARTMENT_TENANT});
  if(!row)return fail(res,"MASTER Department not found",404);
  if(req.body.name!==undefined)row.name=String(req.body.name||"").trim();
  if(!row.name)return fail(res,"Department name is required",400);
  if(req.body.description!==undefined)row.description=String(req.body.description||"").trim();
  if(req.body.status!==undefined)row.status=req.body.status==="INACTIVE"?"INACTIVE":"ACTIVE";
  if(!row.reference)row.reference=makeId("DEPAR");
  row.updatedBy=req.auth.sub;
  await row.save();
  return ok(res,row,"MASTER Department updated");
});

router.delete("/departments/:id", async (req,res) => {
  if(req.auth.role!=="MASTER")return fail(res,"Only MASTER can deactivate Departments",403);
  const row=await Department.findOne({_id:req.params.id,tenantKey:MASTER_DEPARTMENT_TENANT});
  if(!row)return fail(res,"MASTER Department not found",404);
  row.status="INACTIVE";row.updatedBy=req.auth.sub;await row.save();
  return ok(res,{id:row._id,status:row.status},"MASTER Department deactivated");
});

// Roles are created first from Role Management. This page then assigns those
// tenant Roles to a MASTER Department and gives them dynamic ranks.
router.post("/hierarchy/roles", async (_req,res) => fail(res,"Create the Role from Role Management first, then add it to a Department here.",409));

router.put("/hierarchy/roles/:id", async (req,res) => {
  if(req.auth.role!=="SUPERADMIN")return fail(res,"Only SUPERADMIN can manage tenant Role hierarchy",403);
  const tenantKey=req.auth.tenantKey;
  const role=await Role.findOne({_id:req.params.id,tenantKey});
  if(!role)return fail(res,"Role not found",404);
  if(!role.departmentId)return fail(res,"Add this Role to a Department first",409);
  const department=await activeMasterDepartmentById(role.departmentId);
  if(!department)return fail(res,"Role Department is not active",409);
  role.hierarchyOrder=Math.max(0,Number(req.body.hierarchyOrder||0));
  await role.save();
  await normalizeDepartmentRoleOrders(tenantKey,department._id);
  await reconcilePincodeAssignmentsForDepartment(tenantKey,department._id,CustomerLink);
  return ok(res,role,"Role hierarchy rank updated");
});

router.post("/hierarchy/roles/reorder", async (req,res) => {
  if(req.auth.role!=="SUPERADMIN")return fail(res,"Only SUPERADMIN can manage tenant Role hierarchy",403);
  const tenantKey=req.auth.tenantKey,departmentId=req.body.departmentId,roleIds=Array.isArray(req.body.roleIds)?req.body.roleIds.map(String):[];
  const department=await activeMasterDepartmentById(departmentId);
  if(!department)return fail(res,"Department not found",404);
  if(!roleIds.length)return fail(res,"At least one role is required",400);
  const roles=await Role.find({_id:{$in:roleIds},tenantKey,departmentId,status:"ACTIVE"});
  if(roles.length!==roleIds.length)return fail(res,"Every ranked Role must belong to this Department",409);
  const byId=new Map(roles.map(r=>[String(r._id),r]));
  for(let i=0;i<roleIds.length;i++){const role=byId.get(roleIds[i]);role.hierarchyOrder=i+1;await role.save();}
  await reconcilePincodeAssignmentsForDepartment(tenantKey,department._id,CustomerLink);
  return ok(res,{departmentId,roleIds},"Role hierarchy reordered");
});

router.get("/department-role-assignment/:departmentId", async (req,res) => {
  if(req.auth.role!=="SUPERADMIN")return fail(res,"Only SUPERADMIN can manage Department Role assignment",403);
  const tenantKey=req.auth.tenantKey;
  await migrateLegacyTenantDepartments(tenantKey);
  await ensureTenantMasterRoles(req);
  const department=await Department.findOne({_id:req.params.departmentId,tenantKey:MASTER_DEPARTMENT_TENANT}).lean();
  if(!department)return fail(res,"Department not found",404);

  // IMPORTANT: never silently hide a Role from Department Role Assignment.
  // The old query returned only this Department's Roles + unassigned Roles, so
  // a Role already attached to another Department simply disappeared from the
  // screen. Return every tenant Role and let the UI clearly mark whether it is
  // selectable, assigned elsewhere, or inactive.
  const rawRoles=await Role.find({tenantKey})
    .populate({
      path:"departmentId",
      match:{tenantKey:MASTER_DEPARTMENT_TENANT},
      select:"name code status reference"
    })
    .sort({status:1,hierarchyOrder:1,name:1})
    .lean();

  const selectedDepartmentId=String(department._id);
  const roles=rawRoles.map(row=>{
    const roleDepartmentId=String(row.departmentId?._id||row.departmentId||"");
    const active=String(row.status||"ACTIVE").toUpperCase()==="ACTIVE";
    const inThisDepartment=roleDepartmentId===selectedDepartmentId;
    const inAnotherDepartment=Boolean(roleDepartmentId)&&!inThisDepartment;
    return {
      ...row,
      assignmentState:!active?"INACTIVE":inThisDepartment?"CURRENT":inAnotherDepartment?"OTHER_DEPARTMENT":"UNASSIGNED",
      canAssignToSelectedDepartment:active&&!inAnotherDepartment,
      assignedDepartmentName:String(row.departmentId?.name||""),
      assignedDepartmentCode:String(row.departmentId?.code||"")
    };
  });

  // Current hierarchy contains ACTIVE Roles ranked in the selected Department.
  const assigned=roles
    .filter(r=>r.assignmentState==="CURRENT"&&Number(r.hierarchyOrder||0)>0)
    .sort((a,b)=>Number(a.hierarchyOrder||0)-Number(b.hierarchyOrder||0));

  // Put the most useful Roles first without removing anything from the list.
  const stateOrder={CURRENT:0,UNASSIGNED:1,OTHER_DEPARTMENT:2,INACTIVE:3};
  roles.sort((a,b)=>{
    const stateDiff=(stateOrder[a.assignmentState]??9)-(stateOrder[b.assignmentState]??9);
    if(stateDiff)return stateDiff;
    if(a.assignmentState==="CURRENT"){
      const rankDiff=Number(a.hierarchyOrder||0)-Number(b.hierarchyOrder||0);
      if(rankDiff)return rankDiff;
    }
    return String(a.name||"").localeCompare(String(b.name||""));
  });

  return ok(res,{
    department,
    roles,
    assigned,
    roleCounts:{
      total:roles.length,
      current:roles.filter(r=>r.assignmentState==="CURRENT").length,
      unassigned:roles.filter(r=>r.assignmentState==="UNASSIGNED").length,
      otherDepartment:roles.filter(r=>r.assignmentState==="OTHER_DEPARTMENT").length,
      inactive:roles.filter(r=>r.assignmentState==="INACTIVE").length
    }
  });
});

router.put("/department-role-assignment/:departmentId", async (req,res) => {
  if(req.auth.role!=="SUPERADMIN")return fail(res,"Only SUPERADMIN can manage Department Role assignment",403);
  const tenantKey=req.auth.tenantKey;
  await migrateLegacyTenantDepartments(tenantKey);
  await ensureTenantMasterRoles(req);
  const department=await activeMasterDepartmentById(req.params.departmentId);
  if(!department)return fail(res,"Active MASTER Department not found",404);
  const roleIds=Array.isArray(req.body.roleIds)?req.body.roleIds.map(String).filter(Boolean):[];
  if(!roleIds.length)return fail(res,"Select at least one Role",400);

  const roles=await Role.find({_id:{$in:roleIds},tenantKey,status:"ACTIVE"});
  if(roles.length!==roleIds.length)return fail(res,"One or more selected Roles are invalid",409);
  const wrongDepartment=roles.find(r=>r.departmentId&&String(r.departmentId)!==String(department._id));
  if(wrongDepartment)return fail(res,`${wrongDepartment.name} already belongs to another Department. Remove it from that Department first.`,409);

  const byId=new Map(roles.map(r=>[String(r._id),r]));
  const ordered=roleIds.map(id=>byId.get(id));
  const codeIndex=(code)=>ordered.findIndex(r=>String(r.code||"").toUpperCase()===code);
  const sp=codeIndex("SALES_PERSON"),customer=codeIndex("CUSTOMER"),manager=codeIndex("SALES_MANAGER");

  if(customer>=0&&sp<0)return fail(res,"CUSTOMER can only be used directly below SALES_PERSON.",409);
  if(sp>=0){
    const customerRole=await Role.findOne({tenantKey,status:"ACTIVE",code:"CUSTOMER"}).lean();
    if(customerRole&&customer<0){
      if(customerRole.departmentId&&String(customerRole.departmentId)!==String(department._id))return fail(res,"CUSTOMER already belongs to another Department. Remove it there first; CUSTOMER must be in the same Department immediately below SALES_PERSON.",409);
      return fail(res,"CUSTOMER must be included whenever SALES_PERSON is ranked.",409);
    }
    const managerRole=await Role.findOne({tenantKey,status:"ACTIVE",code:"SALES_MANAGER"}).lean();
    if(managerRole&&manager<0){
      if(managerRole.departmentId&&String(managerRole.departmentId)!==String(department._id))return fail(res,"SALES_MANAGER already belongs to another Department. Remove it there first; SALES_MANAGER must be in the same Department above SALES_PERSON.",409);
      return fail(res,"SALES_MANAGER must be included in the same Department whenever SALES_PERSON is ranked.",409);
    }
  }
  if(customer>=0&&customer!==sp+1)return fail(res,"CUSTOMER must be immediately below SALES_PERSON and cannot be placed anywhere else.",409);
  if(manager>=0&&sp>=0&&manager>=sp)return fail(res,"SALES_MANAGER must be above SALES_PERSON.",409);

  // Roles currently assigned to this Department but omitted from the new list
  // are returned to the unassigned Role pool, provided no active user uses them.
  const currentRoles=await Role.find({tenantKey,departmentId:department._id,status:"ACTIVE"});
  const selectedSet=new Set(roleIds);
  for(const role of currentRoles){
    if(selectedSet.has(String(role._id)))continue;
    const users=await User.countDocuments({tenantKey,status:"ACTIVE",$or:[{roleId:role._id},{role:role.code}]});
    if(users)return fail(res,`${role.name} has active users and cannot be removed from this Department.`,409);
  }

  for(const role of currentRoles){
    if(!selectedSet.has(String(role._id))){
      role.departmentId=undefined;role.hierarchyOrder=0;await role.save();
    }
  }

  const effectiveCeiling=await effectiveRolePermissionCeiling(req,department._id);
  const departmentConfigured=department.permissionConfigured===true;
  let permissionsRemoved=0;

  for(let i=0;i<ordered.length;i++){
    const role=ordered[i];
    const before=operationalPermissions(role.permissions||[]);
    const next=permissionIntersection(before,effectiveCeiling||[]);
    permissionsRemoved+=Math.max(0,before.length-next.length);
    role.permissions=next;
    role.departmentId=department._id;
    role.hierarchyOrder=i+1;
    await role.save();
    await User.updateMany(
      {tenantKey,$or:[{roleId:role._id},{role:role.code}]},
      {$set:{roleId:role._id,role:role.code,departmentId:department._id,department:department.name,permissions:next,apps:["dms"]}}
    );
  }

  await reconcilePincodeAssignmentsForDepartment(tenantKey,department._id,CustomerLink);
  return ok(res,{
    departmentId:String(department._id),
    departmentPermissionConfigured:departmentConfigured,
    departmentPermissionCount:operationalPermissions(department.permissions||[]).length,
    permissionsRemoved,
    roles:ordered.map((r,i)=>({_id:String(r._id),name:r.name,code:r.code,rank:i+1,permissionCount:(r.permissions||[]).length})),
    customerAssignmentEnabled:sp>=0
  },permissionsRemoved?`Department Role hierarchy saved. ${permissionsRemoved} permission assignment(s) outside the Department ceiling were removed.`:"Department Role hierarchy saved");
});

router.get("/hierarchy", async (req,res) => {
  const tenantKey=await tenantFilter(req);
  if(req.auth.role!=="MASTER")await migrateLegacyTenantDepartments(tenantKey);
  const [departments,roles,users,assignments]=await Promise.all([
    Department.find({tenantKey:MASTER_DEPARTMENT_TENANT,status:"ACTIVE"}).sort({name:1}).lean(),
    Role.find({tenantKey,status:"ACTIVE",hierarchyOrder:{$gt:0}}).sort({departmentId:1,hierarchyOrder:1,name:1}).lean(),
    User.find({tenantKey,status:"ACTIVE",role:{$ne:"SUPERADMIN"}}).select("name email mobile role roleId departmentId department").sort({name:1}).lean(),
    PincodeAssignment.find({tenantKey,status:"ACTIVE"}).select("departmentId pincode userIds").lean()
  ]);
  const roleUsers=new Map();for(const u of users){const key=String(u.roleId||"");if(!roleUsers.has(key))roleUsers.set(key,[]);roleUsers.get(key).push(u);}
  const pinsByUser=new Map();for(const a of assignments)for(const id of a.userIds||[]){const key=String(id);if(!pinsByUser.has(key))pinsByUser.set(key,[]);pinsByUser.get(key).push(a.pincode);}
  const roots=departments.map(d=>{
    const departmentRoles=roles.filter(r=>String(r.departmentId||"")===String(d._id));
    return {...d,customerAssignmentEnabled:departmentRoles.some(r=>String(r.code||"").toUpperCase()==="SALES_PERSON"),roles:departmentRoles.map(r=>({...r,users:(roleUsers.get(String(r._id))||[]).map(u=>({...u,pincodes:pinsByUser.get(String(u._id))||[]}))}))};
  });
  const unassignedRoles=await Role.find({tenantKey,status:"ACTIVE",hierarchyOrder:{$lte:0}}).lean();
  return ok(res,{roots,unassignedRoles,totalUsers:users.length,totalDepartments:departments.length,totalAssignments:assignments.length});
});

router.get("/sales-pincode-users", async (req,res) => {
  const tenantKey=await tenantFilter(req),q=String(req.query.q||"").trim().toLowerCase();
  const roles=await Role.find({tenantKey,status:"ACTIVE"}).select("name code departmentId hierarchyOrder").lean();
  const roleMap=new Map(roles.map(r=>[String(r._id),r]));
  const geoRoles=roles.filter(r=>["SALES_HEAD","SALES_PERSON"].includes(String(r.code||"").toUpperCase()));
  if(!geoRoles.length)return ok(res,[]);
  const geoRoleIds=new Set(geoRoles.map(r=>String(r._id)));
  const departmentIds=Array.from(new Set(geoRoles.map(r=>String(r.departmentId||"")).filter(Boolean)));
  const allUsers=await User.find({tenantKey,departmentId:{$in:departmentIds},status:{$ne:"DELETED"}})
    .select("name email mobile status role roleId departmentId assignedToUserId coveragePincodes designation")
    .populate("departmentId","name code").sort({name:1}).lean();
  const userMap=new Map(allUsers.map(u=>[String(u._id),u]));
  const displayed=allUsers.filter(u=>geoRoleIds.has(String(u.roleId)));
  const personIds=displayed.filter(u=>String(roleMap.get(String(u.roleId))?.code||u.role).toUpperCase()==="SALES_PERSON").map(u=>u._id);
  const assignments=personIds.length?await PincodeAssignment.find({tenantKey,status:"ACTIVE",userIds:{$in:personIds}}).select("pincode userIds").lean():[];
  const pinsByUser=new Map();
  for(const row of assignments)for(const id of row.userIds||[]){const key=String(id);if(!pinsByUser.has(key))pinsByUser.set(key,[]);pinsByUser.get(key).push(String(row.pincode));}
  const findHead=(u)=>{let id=String(u.assignedToUserId||"");const seen=new Set();for(let depth=0;id&&depth<25;depth+=1){if(seen.has(id))break;seen.add(id);const parent=userMap.get(id);if(!parent)break;const code=String(roleMap.get(String(parent.roleId))?.code||parent.role||"").toUpperCase();if(code==="SALES_HEAD")return parent;id=String(parent.assignedToUserId||"");}return null;};
  const rows=displayed.map(u=>{
    const role=roleMap.get(String(u.roleId)),code=String(role?.code||u.role||"").toUpperCase();
    const pins=code==="SALES_HEAD"?(u.coveragePincodes||[]):(pinsByUser.get(String(u._id))||[]);
    const head=code==="SALES_PERSON"?findHead(u):null;
    const parent=userMap.get(String(u.assignedToUserId||""));
    return {...u,roleCode:code,roleName:role?.name||code,pincodes:Array.from(new Set(pins)).sort(),salesHeadId:head?String(head._id):"",salesHeadName:head?.name||"",parentName:parent?.name||""};
  }).filter(u=>!q||[u.name,u.email,u.mobile,u.salesHeadName,u.parentName].some(v=>String(v||"").toLowerCase().includes(q)));
  return ok(res,rows);
});

router.get("/users/:id/pincodes", async (req,res) => {
  const tenantKey=await tenantFilter(req);
  const user=await User.findOne({_id:req.params.id,tenantKey}).select("name role roleId departmentId assignedToUserId coveragePincodes status").lean();
  if(!user)return fail(res,"User not found",404);
  const role=await Role.findOne({_id:user.roleId,tenantKey}).select("name code departmentId").lean();
  const code=String(role?.code||user.role||"").toUpperCase();
  let pincodes=[];
  if(code==="SALES_HEAD")pincodes=user.coveragePincodes||[];
  else if(code==="SALES_PERSON")pincodes=(await PincodeAssignment.find({tenantKey,departmentId:role?.departmentId||user.departmentId,status:"ACTIVE",userIds:user._id}).select("pincode").lean()).map(x=>String(x.pincode));
  return ok(res,{userId:String(user._id),name:user.name,roleCode:code,roleName:role?.name||code,pincodes:Array.from(new Set(pincodes)).sort()});
});

router.put("/users/:id/pincodes", async (req,res) => {
  if(!canManageAccess(req))return fail(res,"Access administration permission required",403);
  const tenantKey=await tenantFilter(req);
  const user=await User.findOne({_id:req.params.id,tenantKey});
  if(!user)return fail(res,"User not found",404);
  const roleDoc=await Role.findOne({_id:user.roleId,tenantKey,status:"ACTIVE"});
  if(!roleDoc)return fail(res,"User Role is not active",409);
  const code=String(roleDoc.code||"").toUpperCase();
  if(!SALES_GEO_ROLES.has(code))return fail(res,"Pincode allotment is available only for Sales Head and Sales Person",409);
  try{
    const oldPins=code==="SALES_PERSON"?(await PincodeAssignment.find({tenantKey,departmentId:roleDoc.departmentId,status:"ACTIVE",userIds:user._id}).select("pincode").lean()).map(x=>String(x.pincode)):[];
    const result=await replaceSalesRolePincodes({tenantKey,user,roleDoc,pincodes:req.body.pincodes,actorId:req.auth.sub});
    let leadReassignment=null;
    if(code==="SALES_PERSON"){
      const affected=Array.from(new Set([...oldPins,...(result.pincodes||[])]));
      leadReassignment=await reassignOpenLeadsForPincodes(tenantKey,affected,req.auth.sub);
    }
    return ok(res,{...result,leadReassignment},`${code==="SALES_HEAD"?"Sales Head coverage":"Sales Person pincode allotment"} updated`);
  }
  catch(e){return fail(res,e.message,e.statusCode||409);}
});

router.get("/pincode-assignments", async (req,res) => {
  const tenantKey=await tenantFilter(req),filter={tenantKey};if(req.query.departmentId)filter.departmentId=req.query.departmentId;if(req.query.pincode)filter.pincode=String(req.query.pincode).replace(/\D/g,"").slice(0,6);
  const rows=await PincodeAssignment.find(filter).populate("departmentId","name code status").populate("userIds","name email role").sort({pincode:1}).lean();return ok(res,rows);
});

router.post("/pincode-assignments", async (req,res) => {
  if(!canManageAccess(req))return fail(res,"Access administration permission required",403);
  const tenantKey=await tenantFilter(req),departmentId=req.body.departmentId;
  const department=await Department.findOne({_id:departmentId,tenantKey:MASTER_DEPARTMENT_TENANT,status:"ACTIVE"}).lean();if(!department)return fail(res,"Department not found",404);
  const rawPins=Array.isArray(req.body.pincodes)?req.body.pincodes:String(req.body.pincodes||req.body.pincode||"").split(/[,;\s]+/);
  const pincodes=Array.from(new Set(rawPins.map(x=>String(x||"").replace(/\D/g,"").slice(0,6)).filter(x=>x.length===6)));
  if(!pincodes.length)return fail(res,"Enter at least one valid 6-digit pincode",400);
  const userIds=Array.from(new Set((req.body.userIds||[]).map(String).filter(Boolean)));if(!userIds.length)return fail(res,"Select at least one salesperson/user",400);
  const {role,users}=await eligibleUsersForDepartment(tenantKey,departmentId);if(!role)return fail(res,"Create and order roles in this department first",409);
  const allowedIds=new Set(users.map(u=>String(u._id)));const invalid=userIds.filter(id=>!allowedIds.has(id));if(invalid.length)return fail(res,`Pincode can only be assigned to users of the lowest role (${role.name})`,409);
  const masterPins=await Pincode.distinct("pincode",{pincode:{$in:pincodes}});const validPinSet=new Set(masterPins.map(String));const invalidPins=pincodes.filter(pin=>!validPinSet.has(pin));if(invalidPins.length)return fail(res,`These pincodes do not exist in MASTER Pincode: ${invalidPins.join(", ")}`,409);
  for(const pincode of pincodes){
    await PincodeAssignment.findOneAndUpdate({tenantKey,departmentId,pincode},{$set:{userIds,status:"ACTIVE",updatedBy:req.auth.sub},$setOnInsert:{createdBy:req.auth.sub}},{upsert:true,new:true,setDefaultsOnInsert:true});
    if(userIds.length===1){
      await CustomerLink.updateMany({tenantKey,"addresses.pincode":pincode},{$set:{salespersonId:userIds[0]}});
    }else{
      await CustomerLink.updateMany({tenantKey,"addresses.pincode":pincode,salespersonId:{$nin:userIds}},{$set:{salespersonId:""}});
    }
  }
  const leadReassignment=await reassignOpenLeadsForPincodes(tenantKey,pincodes,req.auth.sub);
  return ok(res,{pincodes,userIds,departmentId,bottomRole:{id:String(role._id),name:role.name,code:role.code},leadReassignment},`${pincodes.length} pincode assignment(s) saved`);
});

router.delete("/pincode-assignments/:id", async (req,res) => {
  if(!canManageAccess(req))return fail(res,"Access administration permission required",403);
  const tenantKey=await tenantFilter(req);const row=await PincodeAssignment.findOneAndUpdate({_id:req.params.id,tenantKey},{$set:{status:"INACTIVE",updatedBy:req.auth.sub}},{new:true});if(!row)return fail(res,"Pincode assignment not found",404);
  const options=await getAssignmentOptions(tenantKey,row.pincode);
  if(options.users.length===0)await CustomerLink.updateMany({tenantKey,"addresses.pincode":row.pincode},{$set:{salespersonId:""}});
  else if(options.users.length===1)await CustomerLink.updateMany({tenantKey,"addresses.pincode":row.pincode},{$set:{salespersonId:options.users[0]._id}});
  else {const allowed=options.users.map(u=>u._id);await CustomerLink.updateMany({tenantKey,"addresses.pincode":row.pincode,salespersonId:{$nin:allowed}},{$set:{salespersonId:""}});}
  const leadReassignment=await reassignOpenLeadsForPincodes(tenantKey,[row.pincode],req.auth.sub);
  return ok(res,{id:row._id,status:row.status,leadReassignment},"Pincode assignment removed");
});

router.get("/assignment-options", async (req,res) => {
  return ok(res,await getAssignmentOptions(await tenantFilter(req),req.query.pincode));
});

router.get("/superadmins", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const users=await User.find({role:"SUPERADMIN"}).select("-passwordHash").sort({createdAt:-1}).lean();
  const tenantKeys=users.map(x=>x.tenantKey).filter(Boolean);
  const profiles=await CompanyProfile.find({tenantKey:{$in:tenantKeys}})
    .select("-aadhaarHash -stakeholders.aadhaarHash")
    .lean();
  const planCodes=Array.from(new Set(profiles.map(x=>x.planCode).filter(Boolean)));
  const plans=await Plan.find({code:{$in:planCodes}}).select("name code groupCode monthlyAmount yearlyAmount status").lean();
  const profileMap=new Map(profiles.map(x=>[x.tenantKey,x]));
  const planMap=new Map(plans.map(x=>[x.code,x]));
  return ok(res,users.map(user=>{
    const companyProfile=profileMap.get(user.tenantKey)||null;
    const subscription=companyProfile?subscriptionSnapshot(companyProfile):null;
    return {
      ...user,
      companyProfile,
      subscription,
      plan:companyProfile?planMap.get(companyProfile.planCode)||null:null
    };
  }));
});

const GSTIN_RE=/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE=/^[A-Z]{5}[0-9]{4}[A-Z]$/;
const FY_RE=/^20\d{2}-\d{2}$/;
const normalizeGstin=value=>String(value||"").trim().toUpperCase();
const normalizePan=value=>String(value||"").trim().toUpperCase();
const digits=value=>String(value||"").replace(/\D/g,"");
const panFromGstin=gstin=>GSTIN_RE.test(gstin)?gstin.slice(2,12):"";
const maskAadhaar=value=>{const d=digits(value);return d.length===12?`XXXXXXXX${d.slice(-4)}`:"";};
const hashAadhaar=value=>{const d=digits(value);return d.length===12?crypto.createHash("sha256").update(d).digest("hex"):"";};
const paymentAmountForPlan=(plan,billingCycle)=>{
  const cycle=String(billingCycle||"YEARLY").toUpperCase()==="MONTHLY"?"MONTHLY":"YEARLY";
  const amount=cycle==="MONTHLY"?Number(plan?.monthlyAmount||0):Number(plan?.yearlyAmount||0);
  return {cycle,amountRupees:Math.max(0,amount),amountPaise:Math.max(0,Math.round(amount*100))};
};
const razorpayConfigured=()=>Boolean(env.razorpay.keyId&&env.razorpay.keySecret);
const paymentRef=()=>`RP_${Date.now()}_${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

async function createRazorpayOrder({amountPaise,receipt,notes={}}){
  if(!razorpayConfigured()){
    const error=new Error("Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env and restart Docker.");
    error.status=503;
    throw error;
  }
  const base=String(env.razorpay.baseUrl||"https://api.razorpay.com/v1").replace(/\/$/,"");
  const auth=Buffer.from(`${env.razorpay.keyId}:${env.razorpay.keySecret}`).toString("base64");
  const response=await fetch(`${base}/orders`,{
    method:"POST",
    headers:{Authorization:`Basic ${auth}`,"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify({amount:amountPaise,currency:env.razorpay.currency||"INR",receipt:String(receipt).slice(0,40),notes})
  });
  const text=await response.text();
  let payload={};
  try{payload=text?JSON.parse(text):{};}catch{payload={message:text};}
  if(!response.ok){
    const message=payload?.error?.description||payload?.error?.reason||payload?.message||`Razorpay order failed with HTTP ${response.status}`;
    const error=new Error(message);error.status=response.status>=500?502:400;throw error;
  }
  return payload;
}

async function fetchRazorpayPayment(paymentId){
  if(!razorpayConfigured()){
    const error=new Error("Razorpay is not configured");
    error.status=503;
    throw error;
  }
  const base=String(env.razorpay.baseUrl||"https://api.razorpay.com/v1").replace(/\/$/,"");
  const auth=Buffer.from(`${env.razorpay.keyId}:${env.razorpay.keySecret}`).toString("base64");
  const response=await fetch(`${base}/payments/${encodeURIComponent(paymentId)}`,{
    method:"GET",
    headers:{Authorization:`Basic ${auth}`,Accept:"application/json"}
  });
  const text=await response.text();
  let payload={};
  try{payload=text?JSON.parse(text):{};}catch{payload={message:text};}
  if(!response.ok){
    const message=payload?.error?.description||payload?.error?.reason||payload?.message||`Unable to verify Razorpay payment status (HTTP ${response.status})`;
    const error=new Error(message);error.status=response.status>=500?502:400;throw error;
  }
  return payload;
}

router.get("/superadmins/payment/status", async (req,res)=>{
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  return ok(res,{configured:razorpayConfigured(),keyId:env.razorpay.keyId||"",currency:env.razorpay.currency||"INR"});
});

router.post("/superadmins/payment/order", async (req,res)=>{
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const planCode=normalizeCode(req.body.planCode||"");
  const gstin=normalizeGstin(req.body.gstin);
  const companyName=String(req.body.companyName||"").trim();
  if(!GSTIN_RE.test(gstin)) return fail(res,"Enter a valid 15-character GSTIN",400);
  const plan=await Plan.findOne({code:planCode,status:"ACTIVE"}).lean();
  if(!plan) return fail(res,"Select an active plan",409);
  const {cycle,amountRupees,amountPaise}=paymentAmountForPlan(plan,req.body.billingCycle);
  if(amountPaise<=0) return ok(res,{free:true,amountRupees:0,amountPaise:0,billingCycle:cycle,currency:env.razorpay.currency||"INR"},"No Razorpay payment is required for this plan");
  const ref=paymentRef();
  const order=await createRazorpayOrder({amountPaise,receipt:ref,notes:{gstin,planCode,billingCycle:cycle,companyName:companyName.slice(0,100)}});
  const record=await PlatformPayment.create({paymentRef:ref,companyName,gstin,planCode,billingCycle:cycle,amountRupees,amountPaise,currency:order.currency||env.razorpay.currency||"INR",provider:"RAZORPAY",razorpayOrderId:order.id,status:"ORDER_CREATED",createdBy:req.auth.sub});
  return ok(res,{paymentRef:record.paymentRef,keyId:env.razorpay.keyId,orderId:order.id,amount:amountPaise,amountRupees,currency:record.currency,billingCycle:cycle},"Razorpay order created",201);
});

router.post("/superadmins/payment/verify", async (req,res)=>{
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  if(!razorpayConfigured()) return fail(res,"Razorpay is not configured",503);
  const ref=String(req.body.paymentRef||"").trim();
  const paymentId=String(req.body.razorpay_payment_id||"").trim();
  const orderId=String(req.body.razorpay_order_id||"").trim();
  const signature=String(req.body.razorpay_signature||"").trim();
  const record=await PlatformPayment.findOne({paymentRef:ref});
  if(!record) return fail(res,"Payment reference not found",404);
  if(record.status==="PAID") return ok(res,{paymentRef:record.paymentRef,status:record.status},"Payment already verified");
  if(!paymentId||!orderId||!signature) return fail(res,"Incomplete Razorpay payment response",400);
  if(record.razorpayOrderId!==orderId) return fail(res,"Razorpay order does not match the server order",409);
  const expected=crypto.createHmac("sha256",env.razorpay.keySecret).update(`${record.razorpayOrderId}|${paymentId}`).digest("hex");
  const expectedBuffer=Buffer.from(expected,"utf8");
  const signatureBuffer=Buffer.from(signature,"utf8");
  if(expectedBuffer.length!==signatureBuffer.length||!crypto.timingSafeEqual(expectedBuffer,signatureBuffer)){
    record.status="FAILED";await record.save();return fail(res,"Razorpay signature verification failed",400);
  }

  // Do not provision a company from the Checkout callback alone. Confirm the
  // payment with Razorpay's server API and require the captured status.
  const providerPayment=await fetchRazorpayPayment(paymentId);
  if(String(providerPayment.order_id||"")!==record.razorpayOrderId){
    record.status="FAILED";await record.save();return fail(res,"Razorpay payment is linked to a different order",409);
  }
  if(Number(providerPayment.amount)!==Number(record.amountPaise)){
    record.status="FAILED";await record.save();return fail(res,"Razorpay payment amount does not match the plan amount",409);
  }
  if(String(providerPayment.currency||"").toUpperCase()!==String(record.currency||"INR").toUpperCase()){
    record.status="FAILED";await record.save();return fail(res,"Razorpay payment currency does not match",409);
  }
  if(String(providerPayment.status||"").toLowerCase()!=="captured"){
    return fail(res,`Razorpay payment is ${providerPayment.status||"not captured"}. Enable automatic capture or capture the payment before creating the Superadmin.`,409);
  }

  record.razorpayPaymentId=paymentId;record.status="PAID";record.verifiedAt=new Date();await record.save();
  return ok(res,{paymentRef:record.paymentRef,status:record.status,amountRupees:record.amountRupees},"Payment verified and captured");
});


router.get("/superadmins/:id", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const user=await User.findOne({_id:req.params.id,role:"SUPERADMIN"}).select("-passwordHash").lean();
  if(!user) return fail(res,"Superadmin not found",404);
  const companyProfile=await CompanyProfile.findOne({tenantKey:user.tenantKey})
    .select("-aadhaarHash -stakeholders.aadhaarHash")
    .lean();
  if(!companyProfile) return fail(res,"Company profile not found",404);

  const [plan,payments,activeUsers,totalUsers,roles,branchRows]=await Promise.all([
    Plan.findOne({code:companyProfile.planCode}).lean(),
    PlatformPayment.find({$or:[{tenantKey:user.tenantKey},{linkedUserId:String(user._id)},{linkedCompanyProfileId:String(companyProfile._id)}]})
      .sort({createdAt:-1}).limit(50).lean(),
    User.countDocuments({tenantKey:user.tenantKey,status:"ACTIVE"}),
    User.countDocuments({tenantKey:user.tenantKey}),
    Role.countDocuments({tenantKey:user.tenantKey,status:"ACTIVE"}),
    BranchOffice.countDocuments({tenantKey:user.tenantKey,status:"ACTIVE"})
  ]);

  return ok(res,{
    user,
    companyProfile,
    plan,
    subscription:subscriptionSnapshot(companyProfile),
    payments,
    stats:{
      activeUsers,
      totalUsers,
      roles,
      branches:branchRows||Number(companyProfile.branchCount||1),
      stakeholders:(companyProfile.stakeholders||[]).filter(x=>x.active!==false).length
    }
  });
});

router.put("/superadmins/:id", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const user=await User.findOne({_id:req.params.id,role:"SUPERADMIN"});
  if(!user) return fail(res,"Superadmin not found",404);
  const profile=await CompanyProfile.findOne({tenantKey:user.tenantKey});
  if(!profile) return fail(res,"Company profile not found",404);
  if(String(profile.status).toUpperCase()==="DELETED") return fail(res,"Restore this company before editing it",409);

  const requestedGstin=normalizeGstin(req.body.gstin ?? profile.gstin ?? profile.tenantKey);
  let tenantMigration=null;
  const gstChanged=requestedGstin!==normalizeGstin(profile.gstin);
  const tenantMoveRequested=req.body.migrateTenantData===true&&requestedGstin!==String(profile.tenantKey||"").trim();
  if(gstChanged||tenantMoveRequested){
    try{await validateGstinChangeTarget({profile,nextGstin:requestedGstin});}
    catch(error){return fail(res,error.message,error.status||409,{code:error.code||"GST_CHANGE_FAILED"});}
    const gstPan=panFromGstin(requestedGstin);
    const requestedPan=normalizePan(req.body.pan||gstPan||profile.pan);
    if(gstPan&&requestedPan!==gstPan) return fail(res,`PAN must match the PAN embedded in GSTIN (${gstPan})`,400);
    if(gstChanged&&typeof req.body.migrateTenantData!=="boolean") return fail(
      res,
      "GST Number changed. Confirm whether all company data should move to the new GST tenantKey.",
      409,
      gstChangeConfirmation(profile,requestedGstin)
    );
    profile.gstin=requestedGstin;
    profile.pan=requestedPan;
  }else if(req.body.pan!==undefined){
    profile.pan=normalizePan(req.body.pan);
  }

  const email=String(req.body.email ?? profile.email ?? user.email).trim().toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(email)) return fail(res,"Enter a valid email ID",400);
  const duplicate=await User.exists({email,_id:{$ne:user._id}});
  if(duplicate) return fail(res,"Another user already uses this email",409);

  const financialYears=Array.from(new Set((Array.isArray(req.body.financialYears)?req.body.financialYears:profile.financialYears||[])
    .map(x=>String(x||"").trim()).filter(x=>FY_RE.test(x))));
  const financialYear=String(req.body.financialYear ?? profile.financialYear ?? financialYears[0] ?? "").trim();
  if(financialYear && !financialYears.includes(financialYear)) financialYears.unshift(financialYear);
  if(!financialYears.length) return fail(res,"Add at least one Financial Year",400);

  const branchCount=Math.max(1,Number(req.body.branchCount ?? profile.branchCount ?? 1));
  const hasMultipleBranches=Boolean(req.body.hasMultipleBranches ?? (branchCount>1));
  const plan=await Plan.findOne({code:profile.planCode}).lean();
  const branchLimit=plan?.limits?.companies;
  if(branchLimit!==null&&branchLimit!==undefined&&Number(branchLimit)>=0&&branchCount>Number(branchLimit)){
    return fail(res,`Current plan allows maximum ${branchLimit} branch(es)`,409);
  }

  profile.companyName=String(req.body.companyName ?? profile.companyName).trim();
  profile.tradeName=String(req.body.tradeName ?? profile.tradeName ?? "").trim();
  profile.mobile=digits(req.body.mobile ?? profile.mobile).slice(-10);
  profile.email=email;
  profile.registeredAddress=String(req.body.registeredAddress ?? req.body.address ?? profile.registeredAddress ?? "").trim();
  profile.pincode=digits(req.body.pincode ?? profile.pincode).slice(0,6);
  profile.area=String(req.body.area ?? profile.area ?? "").trim();
  profile.city=String(req.body.city ?? profile.city ?? "").trim();
  profile.district=String(req.body.district ?? profile.district ?? "").trim();
  profile.state=String(req.body.state ?? profile.state ?? "").trim();
  if(req.body.bankDetails && typeof req.body.bankDetails === "object") profile.bankDetails={...(profile.bankDetails?.toObject?.()||profile.bankDetails||{}),...req.body.bankDetails};
  if(req.body.gstVerified!==undefined) profile.gstVerification={...(profile.gstVerification?.toObject?.()||profile.gstVerification||{}),verified:Boolean(req.body.gstVerified),source:String(req.body.gstSource||profile.gstVerification?.source||""),status:String(req.body.gstStatus||profile.gstVerification?.status||""),taxpayerType:String(req.body.gstTaxpayerType||profile.gstVerification?.taxpayerType||""),constitution:String(req.body.gstConstitution||profile.gstVerification?.constitution||""),verifiedAt:req.body.gstVerified?new Date():profile.gstVerification?.verifiedAt};
  profile.financialYear=financialYear;
  profile.financialYears=financialYears;
  profile.hasMultipleBranches=hasMultipleBranches;
  profile.branchCount=branchCount;
  profile.autoRenew=Boolean(req.body.autoRenew ?? profile.autoRenew);
  profile.graceDays=Math.max(0,Math.min(365,Number(req.body.graceDays ?? profile.graceDays ?? 0)));

  // Run the tenant move only after every normal edit validation above has
  // passed, so a later form validation error can never leave a half-changed tenant.
  if(tenantMoveRequested){
    try{tenantMigration=await migrateCompanyTenantKey({companyProfileId:String(profile._id),oldTenantKey:profile.tenantKey,newGstin:requestedGstin,actorId:req.auth.sub,actorRole:req.auth.role});}
    catch(error){return fail(res,error.message,error.status||500,{code:error.code||"TENANT_MIGRATION_FAILED"});}
    profile.tenantKey=requestedGstin;
    user.tenantKey=requestedGstin;
  }
  await profile.save();

  user.name=profile.companyName;
  user.email=email;
  user.mobile=profile.mobile;
  await user.save();

  const safeUser=user.toObject();delete safeUser.passwordHash;
  const safeProfile=profile.toObject();delete safeProfile.aadhaarHash;
  if(Array.isArray(safeProfile.stakeholders)) safeProfile.stakeholders=safeProfile.stakeholders.map(({aadhaarHash,...rest})=>rest);
  return ok(res,{
    user:safeUser,
    companyProfile:safeProfile,
    subscription:subscriptionSnapshot(safeProfile),
    gstChanged,
    tenantMigration,
    tenantKeyChanged:Boolean(tenantMigration?.changed),
    newTenantKey:tenantMigration?.newTenantKey||safeProfile.tenantKey
  },tenantMigration?.changed?"GSTIN updated and company data moved to the new tenantKey":"Superadmin company details updated");
});

router.post("/superadmins/:id/company-status", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const status=String(req.body.status||"").toUpperCase();
  if(!["ACTIVE","SUSPENDED"].includes(status)) return fail(res,"Status must be ACTIVE or SUSPENDED",400);
  const user=await User.findOne({_id:req.params.id,role:"SUPERADMIN"});
  if(!user) return fail(res,"Superadmin not found",404);
  const profile=await CompanyProfile.findOne({tenantKey:user.tenantKey});
  if(!profile) return fail(res,"Company profile not found",404);
  if(String(profile.status).toUpperCase()==="DELETED") return fail(res,"Restore the company before changing status",409);
  profile.status=status;
  profile.subscriptionStatus=status==="ACTIVE"?subscriptionSnapshot({...profile.toObject(),status:"ACTIVE"}).status:"SUSPENDED";
  await profile.save();
  if(status==="ACTIVE" && user.status!=="ACTIVE"){ user.status="ACTIVE"; await user.save(); }
  return ok(res,{status:profile.status,subscription:subscriptionSnapshot(profile.toObject())},status==="ACTIVE"?"Company activated":"Company suspended");
});

router.post("/superadmins/:id/renew", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const user=await User.findOne({_id:req.params.id,role:"SUPERADMIN"});
  if(!user) return fail(res,"Superadmin not found",404);
  const profile=await CompanyProfile.findOne({tenantKey:user.tenantKey});
  if(!profile) return fail(res,"Company profile not found",404);
  if(String(profile.status).toUpperCase()==="DELETED") return fail(res,"Restore the company before renewing it",409);

  const planCode=normalizeCode(req.body.planCode||profile.planCode);
  const plan=await Plan.findOne({code:planCode,status:"ACTIVE"}).lean();
  if(!plan) return fail(res,"Select an active plan",409);
  const billingCycle=normalizeBillingCycle(req.body.billingCycle||profile.billingCycle);
  const periods=Math.max(1,Math.min(36,Number(req.body.periods||1)));
  const unitAmount=billingCycle==="MONTHLY"?Number(plan.monthlyAmount||0):Number(plan.yearlyAmount||0);
  const amountRupees=Math.max(0,unitAmount*periods);
  const now=new Date();
  const snap=subscriptionSnapshot(profile.toObject(),now);
  const existingEnd=new Date(snap.endAt);
  const periodStart=existingEnd>now?existingEnd:now;
  const periodEnd=addBillingPeriod(periodStart,billingCycle,periods);
  const provider=amountRupees<=0?"FREE":"MANUAL";
  const paymentStatus=amountRupees<=0?"FREE":"MANUAL_PAID";

  const payment=await PlatformPayment.create({
    paymentRef:paymentRef(),tenantKey:user.tenantKey,companyName:profile.companyName,gstin:profile.gstin,
    planCode:plan.code,billingCycle,amountRupees,amountPaise:Math.round(amountRupees*100),
    currency:env.razorpay.currency||"INR",provider,status:paymentStatus,
    manualNote:String(req.body.paymentNote||"Plan renewal marked as paid by MASTER").trim(),
    createdBy:req.auth.sub,verifiedAt:now,linkedUserId:String(user._id),linkedCompanyProfileId:String(profile._id),
    subscriptionStartAt:periodStart,subscriptionEndAt:periodEnd
  });

  if(!profile.subscriptionStartAt) profile.subscriptionStartAt=snap.startAt||now;
  profile.subscriptionEndAt=periodEnd;
  profile.renewalDate=periodEnd;
  profile.lastRenewedAt=now;
  profile.subscriptionStatus="ACTIVE";
  profile.planCode=plan.code;
  profile.planGroupCode=plan.groupCode||"";
  profile.billingCycle=billingCycle;
  profile.paymentStatus=payment.status;
  profile.paymentRef=payment.paymentRef;
  if(!Array.isArray(profile.planHistory)) profile.planHistory=[];
  profile.planHistory.push({
    planCode:plan.code,billingCycle,startAt:periodStart,endAt:periodEnd,paymentRef:payment.paymentRef,
    amountRupees,action:plan.code===user.planCode?"RENEWAL":"PLAN_CHANGE",changedBy:req.auth.sub,at:now
  });
  await profile.save();
  user.planCode=plan.code;
  await user.save();

  return ok(res,{companyProfile:profile,plan,payment,subscription:subscriptionSnapshot(profile.toObject())},"Plan renewed successfully");
});

router.delete("/superadmins/:id", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const user=await User.findOne({_id:req.params.id,role:"SUPERADMIN"});
  if(!user) return fail(res,"Superadmin not found",404);
  const profile=await CompanyProfile.findOne({tenantKey:user.tenantKey});
  if(!profile) return fail(res,"Company profile not found",404);
  if(String(profile.status).toUpperCase()==="DELETED") return ok(res,{deleted:true},"Company is already deleted");

  profile.status="DELETED";
  profile.subscriptionStatus="CANCELLED";
  profile.deletedAt=new Date();
  profile.deletedBy=req.auth.sub;
  profile.deleteReason=String(req.body?.reason||req.query?.reason||"Deleted by MASTER").trim();
  await profile.save();
  user.status="INACTIVE";
  await user.save();
  return ok(res,{deleted:true,tenantKey:user.tenantKey},"Company deleted. Business data is retained for audit/recovery.");
});

router.post("/superadmins/:id/restore", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);
  const user=await User.findOne({_id:req.params.id,role:"SUPERADMIN"});
  if(!user) return fail(res,"Superadmin not found",404);
  const profile=await CompanyProfile.findOne({tenantKey:user.tenantKey});
  if(!profile) return fail(res,"Company profile not found",404);
  profile.status="ACTIVE";
  profile.deletedAt=undefined;
  profile.deletedBy="";
  profile.deleteReason="";
  profile.subscriptionStatus=subscriptionSnapshot({...profile.toObject(),status:"ACTIVE"}).status;
  await profile.save();
  user.status="ACTIVE";
  await user.save();
  return ok(res,{restored:true,subscription:subscriptionSnapshot(profile.toObject())},"Company restored successfully");
});

router.post("/superadmins", async (req,res) => {
  if(req.auth.role!=="MASTER") return fail(res,"MASTER access required",403);

  const gstin=normalizeGstin(req.body.gstin);
  const derivedPan=panFromGstin(gstin);
  const pan=normalizePan(req.body.pan||derivedPan);
  const tenantKey=gstin;
  const companyName=String(req.body.companyName||"").trim();
  const tradeName=String(req.body.tradeName||"").trim();
  const companyType=normalizeCode(req.body.companyType||"");
  const address=String(req.body.address||req.body.registeredAddress||"").trim();
  const pincode=digits(req.body.pincode).slice(0,6);
  const area=String(req.body.area||"").trim();
  const city=String(req.body.city||"").trim();
  const district=String(req.body.district||"").trim();
  const state=String(req.body.state||"").trim();
  const bankDetails=req.body.bankDetails&&typeof req.body.bankDetails==="object"?req.body.bankDetails:{};
  const mobile=digits(req.body.mobile).slice(-10);
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  const requestedFinancialYears=Array.isArray(req.body.financialYears)?req.body.financialYears:[req.body.financialYear];
  const financialYears=Array.from(new Set(requestedFinancialYears.map(x=>String(x||"").trim()).filter(x=>FY_RE.test(x))));
  const financialYear=String(req.body.financialYear||financialYears[0]||"").trim();
  if(financialYear && !financialYears.includes(financialYear)) financialYears.unshift(financialYear);
  const planCode=normalizeCode(req.body.planCode||"");
  const hasMultipleBranches=Boolean(req.body.hasMultipleBranches);
  const branchCount=hasMultipleBranches?Math.max(2,Number(req.body.branchCount||2)):1;
  const billingCycle=String(req.body.billingCycle||"YEARLY").toUpperCase()==="MONTHLY"?"MONTHLY":"YEARLY";
  const aadhaar=digits(req.body.aadhaar);
  const skipPayment=Boolean(req.body.skipPayment);
  const paymentReference=String(req.body.paymentRef||"").trim();
  const validCompanyTypes=["PROPRIETORSHIP","PARTNERSHIP","LLP","PRIVATE_LIMITED","PUBLIC_LIMITED","OPC","TRUST","SOCIETY","OTHER"];

  if(!GSTIN_RE.test(gstin)) return fail(res,"GST Number is required and must be a valid 15-character GSTIN",400);
  if(!PAN_RE.test(pan)) return fail(res,"PAN Number is required and must be valid",400);
  if(pan!==derivedPan) return fail(res,`PAN must match the PAN embedded in GSTIN (${derivedPan})`,400);
  if(!companyName) return fail(res,"Company Name is required",400);
  if(!validCompanyTypes.includes(companyType)) return fail(res,"Select a valid Company Type",400);
  if(aadhaar && aadhaar.length!==12) return fail(res,"Aadhaar Number must contain 12 digits",400);
  if(pincode && pincode.length!==6) return fail(res,"Pincode must contain 6 digits",400);
  if(!/^\S+@\S+\.\S+$/.test(email)) return fail(res,"A valid email ID is required",400);
  if(password.length<8) return fail(res,"Password must contain at least 8 characters",400);
  if(!financialYears.length||!FY_RE.test(financialYear)) return fail(res,"Add at least one Financial Year in YYYY-YY format, for example 2026-27",400);
  if(!planCode) return fail(res,"Plan selection is required",400);

  if(await User.exists({email})) return fail(res,"A user with this email already exists",409);
  if(await User.exists({tenantKey,role:"SUPERADMIN"})) return fail(res,"This GSTIN already has a Superadmin",409);
  if(await CompanyProfile.exists({$or:[{tenantKey},{gstin}]})) return fail(res,"This GSTIN already has a company profile",409);
  if(await isTenantKeyReserved(tenantKey)) return fail(res,"This GSTIN is reserved by a previous tenant migration and cannot be reused",409);

  await ensureLegalAccountTemplates();
  const plan=await Plan.findOne({code:planCode,status:"ACTIVE"}).lean();
  if(!plan) return fail(res,"Selected plan is not active",409);
  const branchLimit=plan?.limits?.companies;
  if(branchLimit!==null&&branchLimit!==undefined&&Number(branchLimit)>=0&&branchCount>Number(branchLimit)){
    return fail(res,`This plan allows maximum ${branchLimit} branch(es). Selected: ${branchCount}.`,409);
  }

  const {amountRupees,amountPaise}=paymentAmountForPlan(plan,billingCycle);
  let payment=null;
  if(amountPaise<=0){
    payment=await PlatformPayment.create({paymentRef:paymentRef(),companyName,gstin,planCode:plan.code,billingCycle,amountRupees:0,amountPaise:0,currency:env.razorpay.currency||"INR",provider:"FREE",status:"FREE",createdBy:req.auth.sub,verifiedAt:new Date()});
  }else if(skipPayment){
    payment=await PlatformPayment.create({paymentRef:paymentRef(),companyName,gstin,planCode:plan.code,billingCycle,amountRupees,amountPaise,currency:env.razorpay.currency||"INR",provider:"MANUAL",status:"MANUAL_PAID",manualNote:String(req.body.manualPaymentNote||"Payment marked as received by MASTER").trim(),createdBy:req.auth.sub,verifiedAt:new Date()});
  }else{
    if(!paymentReference) return fail(res,"Complete Razorpay payment or select Payment already received",402);
    payment=await PlatformPayment.findOne({paymentRef:paymentReference,status:"PAID"});
    if(!payment) return fail(res,"Verified Razorpay payment was not found",402);
    if(payment.planCode!==plan.code||payment.billingCycle!==billingCycle||payment.gstin!==gstin) return fail(res,"Verified payment does not match this company/plan",409);
    if(Number(payment.amountPaise)!==amountPaise) return fail(res,"Verified payment amount does not match the current plan price",409);
  }

  const stakeholderInput=Array.isArray(req.body.stakeholders)?req.body.stakeholders:[];
  if(companyType==="PROPRIETORSHIP"&&stakeholderInput.filter(x=>String(x?.name||"").trim()).length!==1) return fail(res,"Proprietorship must have exactly one proprietor",400);
  if(companyType!=="PROPRIETORSHIP"&&!stakeholderInput.some(x=>String(x?.name||"").trim())) return fail(res,"Add at least one stakeholder",400);
  const stakeholders=stakeholderInput.filter(x=>String(x?.name||"").trim()).map(x=>{
    const stakeholderAadhaar=digits(x.aadhaar);
    const st={
      stakeholderId:x.stakeholderId||makeId("STK"),
      name:String(x.name).trim(),
      roleType:normalizeCode(x.roleType||"OWNER"),
      pan:normalizePan(x.pan),
      aadhaarHash:stakeholderAadhaar.length===12?hashAadhaar(stakeholderAadhaar):"",
      aadhaarMasked:stakeholderAadhaar.length===12?maskAadhaar(stakeholderAadhaar):"",
      dinDpin:String(x.dinDpin||"").trim().toUpperCase(),
      mobile:digits(x.mobile).slice(-10),
      email:String(x.email||"").trim().toLowerCase(),
      designation:String(x.designation||"").trim(),
      ownershipPct:Number(x.ownershipPct||0),
      profitSharePct:Number(x.profitSharePct||0),
      contribution:Number(x.contribution||0),
      openingCapital:Number(x.openingCapital||0),
      joiningDate:x.joiningDate||undefined,
      active:true,
      shareholder:Boolean(x.shareholder),
      systemLoginRequired:Boolean(x.systemLoginRequired),
      accountingRelationships:Array.isArray(x.accountingRelationships)?x.accountingRelationships:[]
    };
    if(!st.accountingRelationships.length) st.accountingRelationships=defaultStakeholderRelationships({...st,financialYear},companyType);
    return st;
  });

  let createdUser=null,createdProfile=null;
  try{
    // DMS-only company workspace. HR and Production are intentionally disabled.
    const apps=["dms"];
    createdUser=await User.create({tenantKey,name:companyName,email,mobile,passwordHash:await bcrypt.hash(password,12),role:"SUPERADMIN",apps,permissions:["*"],planCode:plan.code,status:"ACTIVE"});
    const subscriptionStartAt=payment.verifiedAt||new Date();
    const subscriptionEndAt=addBillingPeriod(subscriptionStartAt,billingCycle,1);
    createdProfile=await CompanyProfile.create({
      tenantKey,companyName,tradeName,companyType,gstin,pan,
      aadhaarHash:aadhaar.length===12?hashAadhaar(aadhaar):"",
      aadhaarMasked:aadhaar.length===12?maskAadhaar(aadhaar):"",
      mobile,email,registeredAddress:address,pincode,area,city,district,state,bankDetails,financialYear,financialYears,
      hasMultipleBranches,branchCount,planCode:plan.code,planGroupCode:plan.groupCode||"",billingCycle,
      paymentStatus:payment.status,paymentRef:payment.paymentRef,
      subscriptionStartAt,subscriptionEndAt,renewalDate:subscriptionEndAt,lastRenewedAt:subscriptionStartAt,subscriptionStatus:"ACTIVE",
      planHistory:[{planCode:plan.code,billingCycle,startAt:subscriptionStartAt,endAt:subscriptionEndAt,paymentRef:payment.paymentRef,amountRupees:payment.amountRupees,action:"INITIAL",changedBy:req.auth.sub,at:subscriptionStartAt}],
      gstVerification:{verified:Boolean(req.body.gstVerified),source:String(req.body.gstSource||""),status:String(req.body.gstStatus||""),taxpayerType:String(req.body.gstTaxpayerType||""),constitution:String(req.body.gstConstitution||""),verifiedAt:req.body.gstVerified?new Date():undefined},
      stakeholders,status:"ACTIVE",createdBy:req.auth.sub
    });

    createdUser.tenantId=String(createdProfile._id);
    await createdUser.save();

    await createCompanyBaseLedgers(createdProfile);
    for(const stakeholder of createdProfile.stakeholders.filter(x=>x.active)) await syncStakeholderLedgers({tenantKey,companyType,stakeholder,financialYear});
    payment.tenantKey=tenantKey;payment.linkedUserId=String(createdUser._id);payment.linkedCompanyProfileId=String(createdProfile._id);payment.subscriptionStartAt=subscriptionStartAt;payment.subscriptionEndAt=subscriptionEndAt;await payment.save();

    await ensureSystemCashAccount({tenantKey,tenantId:String(createdProfile._id),planCode:plan.code,actorId:String(createdUser._id)});

    const safe=createdUser.toObject();delete safe.passwordHash;
    return ok(res,{...safe,companyProfile:createdProfile,payment:{paymentRef:payment.paymentRef,status:payment.status,amountRupees:payment.amountRupees,billingCycle:payment.billingCycle}},"Company and Superadmin created successfully",201);
  }catch(error){
    if(createdUser?._id) await User.deleteOne({_id:createdUser._id}).catch(()=>{});
    if(createdProfile?._id) await CompanyProfile.deleteOne({_id:createdProfile._id}).catch(()=>{});
    await CompanyLedger.deleteMany({tenantKey,createdFrom:"COMPANY_SETUP"}).catch(()=>{});
    if(payment?.status==="MANUAL_PAID"||payment?.status==="FREE") await PlatformPayment.deleteOne({_id:payment._id}).catch(()=>{});
    if(error?.code===11000){const field=Object.keys(error.keyPattern||{})[0]||"value";return fail(res,`Duplicate ${field}. Please use a different value.`,409);}
    throw error;
  }
});

export default router;
