import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import crypto from "node:crypto";
import { Plan, Pincode, Hsn, IfscMaster, GlobalTransporterMaster, GlobalTransporterStation, GlobalTransporterLane, Unit, AccountTemplate, Barcode, Branding } from "../models/index.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMaster } from "../middleware/permission.js";
import { readRows, resolveColumns, valueFor, cleanText } from "../utils/bulkSpreadsheet.js";

const router = express.Router();
router.use(requireAuth, requireMaster);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
});

const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
const titleCase = (value) => clean(value).toLowerCase().replace(/(^|[\s\-/,(])([a-z])/g, (_,a,b)=>a+b.toUpperCase());
const normalizePincode = (value) => clean(value).replace(/\.0$/, "").replace(/\D/g, "").slice(0, 6);
const rx = (value) => new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}$`, "i");

const sameIndexKey = (actual = {}, expected = {}) => {
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length &&
    expectedEntries.every(([field, direction], index) =>
      actualEntries[index]?.[0] === field && actualEntries[index]?.[1] === direction
    );
};

let pincodeIndexesPromise = null;

async function createPincodeIndexIfMissing(key, options = {}) {
  const indexes = await Pincode.collection.indexes();
  const existing = indexes.find((index) => sameIndexKey(index.key, key));

  // MongoDB identifies an index by both its key pattern and its options/name.
  // Older/current databases may already have the exact same index under the
  // default MongoDB/Mongoose name. Re-creating it with another explicit name
  // causes error 85 (IndexOptionsConflict), so reuse the existing index.
  if (existing) {
    if (!options.unique || existing.unique === true) return existing.name;

    // A non-unique version of the compound key cannot enforce the master rule.
    // Replace only that exact index, then build the required unique version.
    await Pincode.collection.dropIndex(existing.name);
  }

  try {
    // Do not force a custom name here. This intentionally matches Mongoose's
    // default index name used by pincodeSchema in models/index.js.
    return await Pincode.collection.createIndex(key, options);
  } catch (error) {
    if (error?.code === 85 || error?.codeName === "IndexOptionsConflict") {
      // Handles a harmless race where Mongoose/another request created the
      // equivalent index between indexes() and createIndex().
      const refreshed = await Pincode.collection.indexes();
      const equivalent = refreshed.find((index) =>
        sameIndexKey(index.key, key) && (!options.unique || index.unique === true)
      );
      if (equivalent) return equivalent.name;
    }
    throw error;
  }
}

async function setupPincodeIndexes(){
  // Previous V2 builds created pincode_1 as UNIQUE. India has many areas
  // sharing one PIN, so only that legacy UNIQUE single-field index is removed.
  try {
    const indexes = await Pincode.collection.indexes();
    const oldUniquePincode = indexes.find((index) =>
      index.name === "pincode_1" &&
      index.unique === true &&
      sameIndexKey(index.key, { pincode: 1 })
    );
    if (oldUniquePincode) await Pincode.collection.dropIndex(oldUniquePincode.name);

    // Previous City-less builds used Pincode + Area + District + State as the
    // unique key. City is now part of the MASTER geography, so remove only that
    // exact legacy unique index before creating the new five-field index.
    const oldCitylessUnique = indexes.find((index) =>
      index.unique === true &&
      sameIndexKey(index.key, { pincode: 1, area: 1, district: 1, state: 1 })
    );
    if (oldCitylessUnique) await Pincode.collection.dropIndex(oldCitylessUnique.name);
  } catch (error) {
    if (error?.codeName !== "NamespaceNotFound" && error?.code !== 26) throw error;
  }

  await createPincodeIndexIfMissing(
    { pincode: 1, area: 1, city: 1, district: 1, state: 1 },
    { unique: true }
  );
  await createPincodeIndexIfMissing(
    { state: 1, district: 1, city: 1, area: 1, pincode: 1 }
  );
}

async function ensurePincodeIndexes(){
  // Index inspection/building should not run on every pincode API request.
  // Cache a successful setup, while allowing a retry if setup genuinely fails.
  if (!pincodeIndexesPromise) {
    pincodeIndexesPromise = setupPincodeIndexes().catch((error) => {
      pincodeIndexesPromise = null;
      throw error;
    });
  }
  return pincodeIndexesPromise;
}

function normalizePincodeRecord(input={}){
  return {
    pincode: normalizePincode(input.pincode),
    area: titleCase(input.area),
    city: titleCase(input.city),
    district: titleCase(input.district),
    state: titleCase(input.state),
    country: clean(input.country)||"India",
    status: String(input.status||"ACTIVE").toUpperCase()==="INACTIVE"?"INACTIVE":"ACTIVE"
  };
}

function validatePincodeRecord(row){
  if(!/^\d{6}$/.test(row.pincode)) return "Pincode must be exactly 6 digits";
  if(!row.area) return "Area is required";
  if(!row.city) return "City is required";
  if(!row.district) return "District is required";
  if(!row.state) return "State is required";
  return "";
}

function selectionFilter(selection={}){
  const clauses=[];
  const ids=(selection.ids||[]).filter(Boolean);
  if(ids.length) clauses.push({_id:{$in:ids}});
  for(const scope of selection.scopes||[]){
    const type=String(scope.type||"").toUpperCase();
    if(type==="STATE" && scope.state) clauses.push({state:rx(scope.state)});
    if(type==="DISTRICT" && scope.state && scope.district) clauses.push({state:rx(scope.state),district:rx(scope.district)});
    if(type==="AREA" && scope.state && scope.district && scope.area) clauses.push({state:rx(scope.state),district:rx(scope.district),area:rx(scope.area)});
  }
  return clauses.length?{$or:clauses}:null;
}

// ------------------------- PINCODE MASTER -------------------------
router.get("/pincodes", async (req,res)=>{
  await ensurePincodeIndexes();
  const page=Math.max(1,Number(req.query.page||1));
  const limit=Math.min(500,Math.max(25,Number(req.query.limit||100)));
  const q=clean(req.query.q), state=clean(req.query.state), district=clean(req.query.district), area=clean(req.query.area);
  const filter={};
  if(state) filter.state=rx(state);
  if(district) filter.district=rx(district);
  if(area) filter.area=rx(area);
  if(q) filter.$or=[{pincode:new RegExp(q,"i")},{area:new RegExp(q,"i")},{city:new RegExp(q,"i")},{district:new RegExp(q,"i")},{state:new RegExp(q,"i")}];
  const [items,total]=await Promise.all([
    Pincode.find(filter).sort({state:1,district:1,area:1,pincode:1}).skip((page-1)*limit).limit(limit).lean(),
    Pincode.countDocuments(filter)
  ]);
  return ok(res,{items,meta:pageMeta(page,limit,total)});
});

router.get("/pincodes/states", async (_req,res)=>{
  const rows=await Pincode.aggregate([
    {$group:{_id:"$state",count:{$sum:1}}},{$sort:{_id:1}},{$project:{_id:0,name:"$_id",count:1}}
  ]);
  return ok(res,rows.filter(r=>r.name));
});

router.get("/pincodes/districts", async (req,res)=>{
  const state=clean(req.query.state);
  if(!state) return ok(res,[]);
  const rows=await Pincode.aggregate([
    {$match:{state:rx(state)}},{$group:{_id:"$district",count:{$sum:1}}},{$sort:{_id:1}},{$project:{_id:0,name:"$_id",count:1}}
  ]);
  return ok(res,rows.filter(r=>r.name));
});

router.get("/pincodes/areas", async (req,res)=>{
  const state=clean(req.query.state), district=clean(req.query.district);
  if(!state||!district) return ok(res,[]);
  const rows=await Pincode.aggregate([
    {$match:{state:rx(state),district:rx(district)}},{$group:{_id:"$area",count:{$sum:1}}},{$sort:{_id:1}},{$project:{_id:0,name:"$_id",count:1}}
  ]);
  return ok(res,rows.filter(r=>r.name));
});

router.post("/pincodes", async (req,res)=>{
  await ensurePincodeIndexes();
  const row=normalizePincodeRecord(req.body);
  const error=validatePincodeRecord(row);
  if(error) return fail(res,error,400);
  try{return ok(res,await Pincode.create(row),"Pincode created",201);}
  catch(e){if(e?.code===11000)return fail(res,"This Pincode + Area + City + District + State already exists",409);throw e;}
});

router.put("/pincodes/:id", async (req,res)=>{
  const current=await Pincode.findById(req.params.id);
  if(!current) return fail(res,"Pincode record not found",404);
  const row=normalizePincodeRecord({...current.toObject(),...req.body});
  const error=validatePincodeRecord(row);
  if(error) return fail(res,error,400);
  Object.assign(current,row);
  try{await current.save();return ok(res,current,"Pincode updated");}
  catch(e){if(e?.code===11000)return fail(res,"This Pincode + Area + City + District + State already exists",409);throw e;}
});

router.delete("/pincodes/:id", async (req,res)=>{
  const result=await Pincode.deleteOne({_id:req.params.id});
  if(!result.deletedCount) return fail(res,"Pincode record not found",404);
  return ok(res,{deleted:1},"Pincode deleted");
});

router.post("/pincodes/bulk-upload",upload.single("file"),async (req,res)=>{
  await ensurePincodeIndexes();
  if(!req.file?.buffer) return fail(res,"Excel/CSV file is required",400);
  let workbook;
  try{workbook=XLSX.read(req.file.buffer,{type:"buffer",cellDates:false});}
  catch{return fail(res,"Unable to read the uploaded Excel/CSV file",400);}
  const sheet=workbook.Sheets[workbook.SheetNames[0]];
  const raw=XLSX.utils.sheet_to_json(sheet,{defval:"",raw:false});
  if(!raw.length) return fail(res,"The uploaded file has no rows",400);

  const alias={
    pincode:["pincode","pin code","pin","postal code"],
    area:["area","post office","postoffice","locality","location"],
    district:["district","dist"],
    state:["state","state name"],
    city:["city","city name","town"]
  };
  const keyMap={};
  for(const k of Object.keys(raw[0])) keyMap[clean(k).toLowerCase()]=k;
  const resolve=(name)=>alias[name].map(a=>keyMap[a]).find(Boolean);
  const columns={pincode:resolve("pincode"),area:resolve("area"),city:resolve("city"),district:resolve("district"),state:resolve("state")};
  const missing=["pincode","area","city","district","state"].filter(k=>!columns[k]);
  if(missing.length) return fail(res,`Missing column(s): ${missing.join(", ")}. Required: Pincode, Area, City, District, State`,400);

  const errors=[], seen=new Set(), valid=[];
  raw.forEach((r,index)=>{
    const row=normalizePincodeRecord({pincode:r[columns.pincode],area:r[columns.area],city:columns.city?r[columns.city]:"",district:r[columns.district],state:r[columns.state]});
    const problem=validatePincodeRecord(row);
    const key=`${row.pincode}|${row.area.toLowerCase()}|${row.city.toLowerCase()}|${row.district.toLowerCase()}|${row.state.toLowerCase()}`;
    if(problem){if(errors.length<100)errors.push({row:index+2,error:problem});return;}
    if(seen.has(key)) return;
    seen.add(key); valid.push(row);
  });
  if(!valid.length) return fail(res,"No valid pincode rows were found",400);

  let inserted=0,updated=0;
  for(let i=0;i<valid.length;i+=1000){
    const batch=valid.slice(i,i+1000);
    const result=await Pincode.bulkWrite(batch.map(row=>({updateOne:{
      filter:{pincode:row.pincode,area:row.area,district:row.district,state:row.state,$or:[{city:row.city},{city:""},{city:null},{city:{$exists:false}}]},
      update:{$set:{...row,updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},upsert:true
    }})),{ordered:false});
    inserted+=result.upsertedCount||0;
    updated+=result.modifiedCount||0;
  }
  return ok(res,{received:raw.length,valid:valid.length,inserted,updated,invalid:raw.length-valid.length,errors},"Pincode bulk upload completed");
});

router.post("/pincodes/bulk-edit",async (req,res)=>{
  const filter=selectionFilter(req.body.selection);
  if(!filter) return fail(res,"Select at least one State, District, Area or Pincode",400);
  const input=req.body.changes||{}, changes={};
  if(clean(input.state)) changes.state=titleCase(input.state);
  if(clean(input.district)) changes.district=titleCase(input.district);
  if(clean(input.city)) changes.city=titleCase(input.city);
  if(clean(input.area)) changes.area=titleCase(input.area);
  if(clean(input.status)) changes.status=String(input.status).toUpperCase()==="INACTIVE"?"INACTIVE":"ACTIVE";
  const onlyOneId=(req.body.selection?.ids||[]).length===1 && !(req.body.selection?.scopes||[]).length;
  if(clean(input.pincode)){
    if(!onlyOneId) return fail(res,"Pincode number can be changed only when exactly one row is selected",400);
    const pincode=normalizePincode(input.pincode);
    if(!/^\d{6}$/.test(pincode)) return fail(res,"Pincode must be exactly 6 digits",400);
    changes.pincode=pincode;
  }
  if(!Object.keys(changes).length) return fail(res,"Enter at least one value to change",400);
  try{
    const result=await Pincode.updateMany(filter,{$set:changes},{runValidators:true});
    return ok(res,{matched:result.matchedCount,updated:result.modifiedCount},`${result.modifiedCount} pincode record(s) updated`);
  }catch(e){if(e?.code===11000)return fail(res,"Bulk edit would create duplicate Pincode/Area/City/District/State records",409);throw e;}
});

router.post("/pincodes/bulk-delete",async (req,res)=>{
  const filter=selectionFilter(req.body.selection);
  if(!filter) return fail(res,"Select at least one State, District, Area or Pincode",400);
  const result=await Pincode.deleteMany(filter);
  return ok(res,{deleted:result.deletedCount},`${result.deletedCount} pincode record(s) deleted`);
});


// ------------------------- IFSC / BANK BRANCH MASTER -------------------------
const normalizeIfscRecord = (input = {}) => ({
  ifsc: upper(input.ifsc || input.IFSC),
  bank: clean(input.bank || input.BANK),
  branch: clean(input.branch || input.BRANCH),
  address: clean(input.address || input.ADDRESS),
  city: clean(input.city || input.CITY || input.CITY1 || input.CITY2),
  state: clean(input.state || input.STATE),
  stdCode: clean(input.stdCode ?? input["STD CODE"] ?? input.std ?? input.STD).replace(/\.0$/, ""),
  phone: clean(input.phone ?? input.PHONE).replace(/\.0$/, ""),
  status: String(input.status || "ACTIVE").toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
});

const validateIfscRecord = (row) => {
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(row.ifsc)) return "IFSC must be a valid 11-character code";
  if (!row.bank) return "Bank is required";
  return "";
};

router.get("/ifsc", async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(500, Math.max(25, Number(req.query.limit || 100)));
  const q = clean(req.query.q);
  const state = clean(req.query.state);
  const city = clean(req.query.city);
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  if (state) filter.state = rx(state);
  if (city) filter.city = rx(city);
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { ifsc: new RegExp(`^${safe}`, "i") },
      { bank: new RegExp(safe, "i") },
      { branch: new RegExp(safe, "i") },
      { address: new RegExp(safe, "i") },
      { city: new RegExp(safe, "i") },
      { state: new RegExp(safe, "i") },
    ];
  }
  const [items, total] = await Promise.all([
    IfscMaster.find(filter).sort({ ifsc: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    IfscMaster.countDocuments(filter),
  ]);
  return ok(res, { items, meta: pageMeta(page, limit, total) });
});

router.post("/ifsc", async (req, res) => {
  const row = normalizeIfscRecord(req.body);
  const problem = validateIfscRecord(row);
  if (problem) return fail(res, problem, 400);
  try { return ok(res, await IfscMaster.create(row), "IFSC branch created", 201); }
  catch (e) { if (e?.code === 11000) return fail(res, `IFSC ${row.ifsc} already exists`, 409); throw e; }
});

router.put("/ifsc/:id", async (req, res) => {
  const current = await IfscMaster.findById(req.params.id);
  if (!current) return fail(res, "IFSC branch not found", 404);
  const row = normalizeIfscRecord({ ...current.toObject(), ...req.body });
  const problem = validateIfscRecord(row);
  if (problem) return fail(res, problem, 400);
  Object.assign(current, row);
  try { await current.save(); return ok(res, current, "IFSC branch updated"); }
  catch (e) { if (e?.code === 11000) return fail(res, `IFSC ${row.ifsc} already exists`, 409); throw e; }
});

router.delete("/ifsc/:id", async (req, res) => {
  const row = await IfscMaster.findById(req.params.id);
  if (!row) return fail(res, "IFSC branch not found", 404);
  row.status = "INACTIVE";
  await row.save();
  return ok(res, { id: row._id, status: row.status }, "IFSC branch deactivated");
});

router.post("/ifsc/bulk-upload", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) return fail(res, "IFSC Excel/CSV file is required", 400);
  let workbook;
  try { workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false }); }
  catch { return fail(res, "Unable to read the IFSC Excel/CSV file", 400); }

  let received = 0, valid = 0, inserted = 0, updated = 0, unchanged = 0, invalid = 0;
  const errors = [];
  const seen = new Set();
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const result = await IfscMaster.bulkWrite(batch, { ordered: false });
    inserted += result.upsertedCount || 0;
    updated += result.modifiedCount || 0;
    unchanged += Math.max(0, batch.length - (result.upsertedCount || 0) - (result.modifiedCount || 0));
    batch = [];
  };

  for (const sheetName of workbook.SheetNames) {
    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
    for (let index = 0; index < rawRows.length; index += 1) {
      received += 1;
      const row = normalizeIfscRecord(rawRows[index]);
      const problem = validateIfscRecord(row);
      if (problem) {
        invalid += 1;
        if (errors.length < 100) errors.push({ sheet: sheetName, row: index + 2, ifsc: row.ifsc, error: problem });
        continue;
      }
      if (seen.has(row.ifsc)) continue;
      seen.add(row.ifsc);
      valid += 1;
      batch.push({ updateOne: { filter: { ifsc: row.ifsc }, update: { $set: row }, upsert: true } });
      if (batch.length >= 1000) await flush();
    }
  }
  await flush();
  return ok(res, { received, valid, inserted, updated, unchanged, invalid, errors }, "IFSC MASTER import completed");
});


// ------------------------- GLOBAL TRANSPORTER MASTER -------------------------
const splitList = (value) => String(value ?? "").split(/[;|\n]+/).map(clean).filter(Boolean);
const digitsOnly = (value) => clean(value).replace(/\.0$/, "").replace(/[^0-9+]/g, "");
const transporterMasterKey = (row = {}) => crypto.createHash("sha1")
  .update([clean(row.name).toLowerCase(), clean(row.mobile), clean(row.address).toLowerCase(), clean(row.landline), clean(row.email).toLowerCase(), (row.categories||[]).join(";").toLowerCase(), (row.directoryGroups||[]).join(";").toLowerCase()].join("|"))
  .digest("hex");
const transporterMasterId = (key) => `GTR-${String(key || "").slice(0, 12).toUpperCase()}`;
const transporterStationId = (globalId,name,pincode="") => `GTS-${crypto.createHash("sha1").update(`${globalId}|${clean(name).toLowerCase()}|${normalizePincode(pincode)}`).digest("hex").slice(0,12).toUpperCase()}`;

const normalizeGlobalTransporter = (input = {}) => {
  const name = clean(input.name || input["Firm Name"] || input["Transporter Name"]);
  const address = clean(input.address || input.Address);
  const mobile = digitsOnly(input.mobile ?? input["Mobile Number"] ?? input.Mobile);
  const row = {
    name,
    address,
    pincode: clean(input.pincode ?? input.Pincode).replace(/\.0$/, ""),
    contactPerson: clean(input.contactPerson ?? input["Contact Person"]),
    mobile,
    landline: digitsOnly(input.landline ?? input["Landline Number"]),
    email: clean(input.email ?? input.Email).toLowerCase(),
    directoryGroups: Array.isArray(input.directoryGroups) ? input.directoryGroups.map(clean).filter(Boolean) : splitList(input.directoryGroups ?? input["Directory Groups"] ?? input["Directory Group"]),
    categories: Array.isArray(input.categories) ? input.categories.map(clean).filter(Boolean) : splitList(input.categories ?? input.Categories ?? input.Category),
    listingOccurrences: Number(input.listingOccurrences ?? input["Listing Occurrences"] ?? 1) || 1,
    sourceUrls: Array.isArray(input.sourceUrls) ? input.sourceUrls.map(clean).filter(Boolean) : splitList(input.sourceUrls ?? input["Source URLs"] ?? input["Source URL"]),
    sourceName: clean(input.sourceName || "TransportNagar.in") || "TransportNagar.in",
    status: String(input.status || "ACTIVE").toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
  };
  row.masterKey = clean(input.masterKey) || transporterMasterKey(row);
  row.globalTransporterId = clean(input.globalTransporterId) || transporterMasterId(row.masterKey);
  return row;
};

const validateGlobalTransporter = (row) => {
  if (!row.name) return "Transporter / Firm Name is required";
  if (!row.masterKey) return "Unable to create transporter master key";
  return "";
};

router.get("/transporters", async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(500, Math.max(25, Number(req.query.limit || 100)));
  const q = clean(req.query.q), group = clean(req.query.group), category = clean(req.query.category);
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  if (group) filter.directoryGroups = new RegExp(group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (category) filter.categories = new RegExp(category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { globalTransporterId: new RegExp(`^${safe}`, "i") }, { name: new RegExp(safe, "i") },
      { address: new RegExp(safe, "i") }, { contactPerson: new RegExp(safe, "i") },
      { mobile: new RegExp(safe, "i") }, { landline: new RegExp(safe, "i") },
      { email: new RegExp(safe, "i") }, { directoryGroups: new RegExp(safe, "i") }, { categories: new RegExp(safe, "i") },
    ];
  }
  const [items, total] = await Promise.all([
    GlobalTransporterMaster.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    GlobalTransporterMaster.countDocuments(filter),
  ]);
  return ok(res, { items, meta: pageMeta(page, limit, total) });
});

router.post("/transporters", async (req, res) => {
  const row = normalizeGlobalTransporter(req.body);
  const problem = validateGlobalTransporter(row); if (problem) return fail(res, problem, 400);
  try { return ok(res, await GlobalTransporterMaster.create(row), "Global transporter created", 201); }
  catch (e) { if (e?.code === 11000) return fail(res, "This transporter already exists in Global MASTER", 409); throw e; }
});

router.put("/transporters/:id", async (req, res) => {
  const current = await GlobalTransporterMaster.findById(req.params.id); if (!current) return fail(res, "Global transporter not found", 404);
  const row = normalizeGlobalTransporter({ ...current.toObject(), ...req.body, masterKey: current.masterKey, globalTransporterId: current.globalTransporterId });
  const problem = validateGlobalTransporter(row); if (problem) return fail(res, problem, 400);
  Object.assign(current, row); await current.save(); return ok(res, current, "Global transporter updated");
});

router.delete("/transporters/:id", async (req, res) => {
  const current = await GlobalTransporterMaster.findById(req.params.id); if (!current) return fail(res, "Global transporter not found", 404);
  current.status = "INACTIVE"; await current.save(); return ok(res, { id: current._id, status: current.status }, "Global transporter deactivated");
});

router.post("/transporters/bulk-upload", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) return fail(res, "Transporter Excel/CSV file is required", 400);
  let workbook; try { workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false }); }
  catch { return fail(res, "Unable to read transporter Excel/CSV file", 400); }
  let received = 0, valid = 0, inserted = 0, updated = 0, unchanged = 0, invalid = 0, stationInserted = 0, stationUpdated = 0; const errors = [], seen = new Set(); let batch = [], stationBatch = [];
  const flush = async () => { if (batch.length) { const result = await GlobalTransporterMaster.bulkWrite(batch, { ordered: false }); inserted += result.upsertedCount || 0; updated += result.modifiedCount || 0; unchanged += Math.max(0, batch.length - (result.upsertedCount || 0) - (result.modifiedCount || 0)); batch = []; } if (stationBatch.length) { const sr = await GlobalTransporterStation.bulkWrite(stationBatch, { ordered: false }); stationInserted += sr.upsertedCount || 0; stationUpdated += sr.modifiedCount || 0; stationBatch = []; } };
  const transporterSheets = workbook.SheetNames.includes("Unique Transporters") ? ["Unique Transporters"] : workbook.SheetNames;
  for (const sheetName of transporterSheets) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
    if (!rows.length) continue;
    const headers = new Set(Object.keys(rows[0] || {}).map((x) => clean(x).toLowerCase()));
    if (!headers.has("firm name") && !headers.has("transporter name") && !headers.has("name")) continue;
    for (let index = 0; index < rows.length; index += 1) {
      received += 1; const row = normalizeGlobalTransporter(rows[index]); const problem = validateGlobalTransporter(row);
      if (problem) { invalid += 1; if (errors.length < 100) errors.push({ sheet: sheetName, row: index + 2, name: row.name, error: problem }); continue; }
      if (seen.has(row.masterKey)) continue; seen.add(row.masterKey); valid += 1;
      batch.push({ updateOne: { filter: { masterKey: row.masterKey }, update: { $set: row }, upsert: true } });
      const stationNames = (row.categories || []).length ? row.categories : [...(row.directoryGroups || []), row.address || row.pincode].filter(Boolean).slice(0, 1);
      for (const stationName of stationNames) {
        const stationId = transporterStationId(row.globalTransporterId, stationName, row.pincode);
        stationBatch.push({ updateOne: { filter: { stationId }, update: { $set: { stationId, globalTransporterId: row.globalTransporterId, name: stationName, stationType: "BOTH", address: row.address || "", pincode: row.pincode || "", servicePincodes: [row.pincode].filter(Boolean), serviceCities: [stationName].filter(Boolean), serviceStates: (row.directoryGroups || []).slice(0, 3), sourceCategory: stationName, sourceDirectoryGroup: (row.directoryGroups || [])[0] || "", status: "ACTIVE", contacts: (row.contactPerson || row.mobile || row.email) ? [{ name: row.contactPerson || "", designation: "", phone: row.mobile || row.landline || "", email: row.email || "", active: true }] : [] } }, upsert: true } });
      }
      if (batch.length >= 1000 || stationBatch.length >= 1000) await flush();
    }
  }
  await flush();
  return ok(res, { received, valid, inserted, updated, unchanged, invalid, stationInserted, stationUpdated, errors }, "Global Transporter MASTER + stations import completed");
});


router.get("/transporter-stations", async (req,res) => {
  const filter={};if(req.query.globalTransporterId)filter.globalTransporterId=clean(req.query.globalTransporterId);if(req.query.status)filter.status=String(req.query.status).toUpperCase();
  const q=clean(req.query.q);if(q){const safe=q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");filter.$or=[{name:new RegExp(safe,"i")},{pincode:new RegExp(`^${safe}`,"i")},{area:new RegExp(safe,"i")},{city:new RegExp(safe,"i")},{district:new RegExp(safe,"i")},{state:new RegExp(safe,"i")},{servicePincodes:new RegExp(`^${safe}`,"i")},{serviceCities:new RegExp(safe,"i")}];}
  const items=await GlobalTransporterStation.find(filter).sort({state:1,city:1,name:1}).limit(1000).lean();return ok(res,{items});
});
router.post("/transporter-stations", async (req,res) => {
  const gid=clean(req.body.globalTransporterId),name=clean(req.body.name),pincode=normalizePincode(req.body.pincode);if(!gid||!name)return fail(res,"Global Transporter and Station Name are required",400);
  const stationId=clean(req.body.stationId)||`GTS-${crypto.createHash("sha1").update(`${gid}|${name.toLowerCase()}|${pincode}`).digest("hex").slice(0,12).toUpperCase()}`;
  const item=await GlobalTransporterStation.findOneAndUpdate({stationId},{$set:{...req.body,stationId,globalTransporterId:gid,name,pincode,stationType:String(req.body.stationType||"BOTH").toUpperCase(),servicePincodes:(req.body.servicePincodes||[]).map(normalizePincode).filter(Boolean),serviceCities:(req.body.serviceCities||[]).map(clean).filter(Boolean),serviceStates:(req.body.serviceStates||[]).map(clean).filter(Boolean),status:String(req.body.status||"ACTIVE").toUpperCase()}},{upsert:true,new:true,setDefaultsOnInsert:true,runValidators:true});return ok(res,item,"Transporter station saved",201);
});
router.put("/transporter-stations/:id", async (req,res) => {const item=await GlobalTransporterStation.findByIdAndUpdate(req.params.id,{$set:req.body},{new:true,runValidators:true});if(!item)return fail(res,"Transporter station not found",404);return ok(res,item,"Transporter station updated");});
router.delete("/transporter-stations/:id", async (req,res) => {const item=await GlobalTransporterStation.findByIdAndUpdate(req.params.id,{$set:{status:"INACTIVE"}},{new:true});if(!item)return fail(res,"Transporter station not found",404);return ok(res,item,"Transporter station deactivated");});
router.get("/transporter-lanes", async (req,res) => {const filter={status:{$ne:"INACTIVE"}};if(req.query.globalTransporterId)filter.globalTransporterId=clean(req.query.globalTransporterId);const items=await GlobalTransporterLane.find(filter).sort({createdAt:-1}).limit(1000).lean();return ok(res,{items});});
router.post("/transporter-lanes", async (req,res) => {const gid=clean(req.body.globalTransporterId),origin=clean(req.body.originStationId),destination=clean(req.body.destinationStationId);if(!gid||!origin||!destination)return fail(res,"Transporter, Origin Station and Destination Station are required",400);const laneId=`GTL-${crypto.createHash("sha1").update(`${gid}|${origin}|${destination}`).digest("hex").slice(0,12).toUpperCase()}`;const item=await GlobalTransporterLane.findOneAndUpdate({laneId},{$set:{...req.body,laneId,globalTransporterId:gid,originStationId:origin,destinationStationId:destination,status:String(req.body.status||"ACTIVE").toUpperCase()}},{upsert:true,new:true,runValidators:true,setDefaultsOnInsert:true});return ok(res,item,"Transporter lane saved",201);});
router.put("/transporter-lanes/:id", async (req,res) => {const item=await GlobalTransporterLane.findByIdAndUpdate(req.params.id,{$set:req.body},{new:true,runValidators:true});if(!item)return fail(res,"Transporter lane not found",404);return ok(res,item,"Transporter lane updated");});
router.delete("/transporter-lanes/:id", async (req,res) => {const item=await GlobalTransporterLane.findByIdAndUpdate(req.params.id,{$set:{status:"INACTIVE"}},{new:true});if(!item)return fail(res,"Transporter lane not found",404);return ok(res,item,"Transporter lane deactivated");});

// ------------------------- OTHER MASTER CRUD -------------------------
function selectedIds(req){
  const ids=(req.body?.selection?.ids||[]).filter(Boolean);
  return ids.length?{_id:{$in:ids}}:null;
}

function addBulkMaster(path, Model, cfg={}){
  const fields=cfg.fields||[];
  const uniqueKeys=cfg.uniqueKeys||[];

  router.post(`${path}/bulk-upload`,upload.single("file"),async(req,res)=>{
    if(cfg.disableUpload) return fail(res,"Bulk upload is disabled for this MASTER",409);
    if(!req.file?.buffer) return fail(res,"Excel/CSV file is required",400);
    let rows; try{rows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read Excel/CSV file",400);}
    if(!rows.length)return fail(res,"Uploaded file has no rows",400);
    const cols=resolveColumns(rows[0],fields);
    const required=fields.filter(f=>f.required && !cols[f.key]).map(f=>f.label);
    if(required.length)return fail(res,`Missing column(s): ${required.join(", ")}`,400);

    const errors=[],rejectedRows=[],ops=[],opMeta=[],seenUnique=new Set();
    const pushRejected=(index,error,row={})=>{
      const item={row:index+2,error};
      if(cfg.returnRejectedRows || errors.length<100)errors.push(item);
      if(cfg.returnRejectedRows){
        const values=cfg.rejectedRow?cfg.rejectedRow(row):row;
        rejectedRows.push({row:index+2,...values,error});
      }
    };

    rows.forEach((raw,index)=>{
      const row={};
      for(const f of fields){
        const v=valueFor(raw,cols[f.key],f.type);
        if(v!==undefined&&v!=="")row[f.key]=f.transform?f.transform(v):v;
      }
      if(cfg.prepareRow)Object.assign(row,cfg.prepareRow(row));

      const problem=cfg.validate?.(row)||"";
      if(problem){pushRejected(index,problem,row);return;}

      const filter={};
      for(const key of uniqueKeys)if(row[key]!==undefined&&row[key]!=="")filter[key]=row[key];
      if(!Object.keys(filter).length){pushRejected(index,"Unique key is missing",row);return;}

      const uniqueToken=uniqueKeys.map(key=>String(filter[key]??"").trim().toLowerCase()).join("|");
      if(cfg.rejectFileDuplicates&&uniqueToken&&seenUnique.has(uniqueToken)){
        pushRejected(index,cfg.duplicateError||"Duplicate row in uploaded file",row);
        return;
      }
      if(cfg.rejectFileDuplicates&&uniqueToken)seenUnique.add(uniqueToken);

      ops.push({updateOne:{filter,update:{$set:{...row,updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},upsert:true}});
      opMeta.push({index,row});
    });

    if(!ops.length){
      if(cfg.returnRejectedRows){
        return ok(res,{received:rows.length,valid:0,inserted:0,updated:0,unchanged:0,invalid:rejectedRows.length,errors,rejectedRows},"Bulk upload completed with errors");
      }
      return fail(res,"No valid rows were found",400,{errors});
    }

    let inserted=0,updated=0,writeFailures=0;
    for(let i=0;i<ops.length;i+=1000){
      const batch=ops.slice(i,i+1000);
      try{
        const result=await Model.bulkWrite(batch,{ordered:false});
        inserted+=result.upsertedCount||0;
        updated+=result.modifiedCount||0;
      }catch(error){
        const result=error?.result||error?.writeResult||{};
        inserted+=result.upsertedCount||result?.result?.nUpserted||0;
        updated+=result.modifiedCount||result?.result?.nModified||0;
        const writeErrors=error?.writeErrors||result?.writeErrors||[];
        if(!writeErrors.length)throw error;
        for(const writeError of writeErrors){
          const localIndex=Number(writeError?.index);
          const meta=opMeta[i+localIndex];
          if(!meta)continue;
          writeFailures+=1;
          pushRejected(meta.index,writeError?.errmsg||writeError?.message||"Database rejected this row",meta.row);
        }
      }
    }

    const valid=Math.max(0,ops.length-writeFailures);
    const unchanged=Math.max(0,valid-inserted-updated);
    const invalid=cfg.returnRejectedRows?rejectedRows.length:rows.length-valid;
    return ok(res,{received:rows.length,valid,inserted,updated,unchanged,invalid,errors,...(cfg.returnRejectedRows?{rejectedRows}:{})},invalid?"Bulk upload completed with some rejected rows":"Bulk upload completed");
  });

  router.post(`${path}/bulk-edit`,async(req,res)=>{
    if(cfg.disableEdit) return fail(res,"Bulk edit is disabled for this MASTER",409);
    const filter=selectedIds(req); if(!filter)return fail(res,"Select at least one record",400);
    const changes={};
    const allowed=new Set(cfg.bulkEditable||fields.map(f=>f.key));
    for(const [k,v] of Object.entries(req.body.changes||{})) if(allowed.has(k)&&v!==undefined&&v!=="") changes[k]=v;
    if(!Object.keys(changes).length)return fail(res,"Enter at least one value to change",400);
    if(cfg.normalizeChanges)Object.assign(changes,cfg.normalizeChanges(changes));
    if(cfg.protectLocked) filter.locked={$ne:true};
    try{const result=await Model.updateMany(filter,{$set:changes},{runValidators:true});return ok(res,{matched:result.matchedCount,updated:result.modifiedCount},`${result.modifiedCount} record(s) updated`);}
    catch(e){if(e?.code===11000)return fail(res,"Bulk edit would create duplicate records",409);throw e;}
  });

  router.post(`${path}/bulk-delete`,async(req,res)=>{
    if(cfg.disableDelete)return fail(res,"Bulk delete is disabled for this MASTER",409);
    const filter=selectedIds(req); if(!filter)return fail(res,"Select at least one record",400);
    if(cfg.protectLocked)filter.locked={$ne:true};
    const result=cfg.softDelete
      ? await Model.updateMany(filter,{$set:{status:"INACTIVE"}})
      : await Model.deleteMany(filter);
    const count=cfg.softDelete?result.modifiedCount:result.deletedCount;
    return ok(res,{deleted:count,soft:Boolean(cfg.softDelete)},`${count} record(s) ${cfg.softDelete?"deactivated":"deleted"}`);
  });
}

const crud = (path, Model, options={}) => {
  router.get(path, async (req,res)=> {
    const q=String(req.query.q||"").trim();
    const page=Math.max(1,Number(req.query.page||1));
    const limit=Math.min(500,Math.max(10,Number(req.query.limit||100)));
    let filter={};
    if(q && options.searchFields?.length) filter={$or:options.searchFields.map(k=>({[k]:new RegExp(q,"i")}))};
    if(req.query.status)filter.status=req.query.status;
    const [items,total]=await Promise.all([
      Model.find(filter).sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),
      Model.countDocuments(filter)
    ]);
    return ok(res,{items,meta:pageMeta(page,limit,total)});
  });
  router.post(path, async (req,res)=> {
    try{return ok(res, await Model.create(req.body), "Created", 201);}
    catch(e){if(e?.code===11000)return fail(res,"Duplicate record already exists",409);throw e;}
  });
  router.put(`${path}/:id`, async (req,res)=> {
    const current=await Model.findById(req.params.id); if(!current)return fail(res,"Record not found",404);
    if(options.protectLocked && current.locked){
      const allowed=options.lockedEditable||[]; const payload={}; for(const k of allowed)if(req.body[k]!==undefined)payload[k]=req.body[k];
      return ok(res,await Model.findByIdAndUpdate(req.params.id,payload,{new:true,runValidators:true}),"Updated");
    }
    return ok(res, await Model.findByIdAndUpdate(req.params.id, req.body, {new:true,runValidators:true}), "Updated");
  });
  router.delete(`${path}/:id`, async (req,res)=> {
    const current=await Model.findById(req.params.id); if(!current)return fail(res,"Record not found",404);
    if(options.protectLocked && current.locked)return fail(res,"Locked MASTER record cannot be deleted",409);
    await current.deleteOne(); return ok(res,{deleted:true},"Deleted");
  });
  if(options.bulk)addBulkMaster(path,Model,{...options.bulk,protectLocked:options.protectLocked});
};

const upper=v=>clean(v).toUpperCase();
crud("/plans", Plan,{searchFields:["name","code"]});
crud("/hsn", Hsn,{searchFields:["code","description"],bulk:{
  fields:[
    {key:"code",label:"HSN No",aliases:["hsn","hsn no","hsn number","code"],required:true,transform:upper},
    {key:"description",label:"Product Description",aliases:["description","product description","product"],required:true},
    {key:"gstRate",label:"GST %",aliases:["gst","gst rate","gst rate %","rate"],required:true},
    {key:"cessRate",label:"Cess",aliases:["cess %","cess rate","cess rate %"],required:true}
  ],
  uniqueKeys:["code"],
  bulkEditable:["title","description","gstRate","cessRate"],
  returnRejectedRows:true,
  rejectFileDuplicates:true,
  duplicateError:"Duplicate HSN No in uploaded file",
  rejectedRow:r=>({code:r.code||"",description:r.description||"",gstRate:r.gstRate??"",cessRate:r.cessRate??""}),
  validate:r=>{
    if(!r.code)return "HSN No is required";
    if(!r.description)return "Product Description is required";
    if(!Number.isFinite(Number(r.gstRate))||Number(r.gstRate)<0||Number(r.gstRate)>100)return "GST % must be between 0 and 100";
    if(!Number.isFinite(Number(r.cessRate))||Number(r.cessRate)<0)return "Cess must be 0 or more";
    return "";
  },
  prepareRow:r=>{
    const gst=Number(r.gstRate||0),cess=Number(r.cessRate||0);
    return {...r,gstRate:gst,cgstRate:gst/2,sgstRate:gst/2,igstRate:gst,cessRate:cess,type:"HSN",status:"ACTIVE"};
  },
  normalizeChanges:c=>{
    const out={...c};
    if(c.title!==undefined){out.description=clean(c.title);delete out.title;}
    if(c.description!==undefined)out.description=clean(c.description);
    if(c.gstRate!==undefined){const gst=Number(c.gstRate||0);out.gstRate=gst;out.cgstRate=gst/2;out.sgstRate=gst/2;out.igstRate=gst;}
    if(c.cessRate!==undefined)out.cessRate=Number(c.cessRate||0);
    return out;
  }
}});
crud("/units", Unit,{searchFields:["code","name","uqc"],bulk:{
  fields:[
    {key:"code",label:"Unit Code",aliases:["code","unit"],required:true,transform:upper},
    {key:"name",label:"Unit Name",aliases:["name","description"],required:true},
    {key:"uqc",label:"UQC",aliases:["gst uqc"],transform:upper},
    {key:"decimals",label:"Decimals",type:"number"},
    {key:"status",label:"Status",transform:upper}
  ],uniqueKeys:["code"],bulkEditable:["title","name","uqc","decimals","status"],
  validate:r=>!r.code?"Unit code is required":!r.name?"Unit name is required":"",
  normalizeChanges:c=>{const out={...c};if(c.title){out.name=c.title;delete out.title;}return {...out,...(c.uqc?{uqc:upper(c.uqc)}:{}),...(c.status?{status:upper(c.status)}:{})};}
}});
crud("/accounts", AccountTemplate,{searchFields:["systemCode","name"],protectLocked:true,lockedEditable:["allowCompanyLedger"],bulk:{disableUpload:true,disableDelete:true,bulkEditable:["allowCompanyLedger"]}});
crud("/barcodes", Barcode,{searchFields:["barcodeId","gtin","productName","sku"],bulk:{
  fields:[
    {key:"barcodeId",label:"Barcode ID",aliases:["barcode id","gtin / barcode","gtin","barcode"],required:true},
    {key:"gtin",label:"GTIN",aliases:["ean","ean13","gtin/ean"]},
    {key:"type",label:"Type",transform:upper},
    {key:"owner",label:"Owner"},{key:"brand",label:"Brand"},{key:"sku",label:"SKU"},{key:"productName",label:"Product Name",aliases:["product"]},{key:"status",label:"Status",transform:upper}
  ],uniqueKeys:["barcodeId"],bulkEditable:["title","type","owner","brand","sku","productName","status"],normalizeChanges:c=>{const out={...c};if(c.title){out.productName=c.title;delete out.title;}return out;},validate:r=>!r.barcodeId?"Barcode ID is required":""
}});
router.get("/branding", async (_req,res)=> ok(res, await Branding.findOne({ key:"GLOBAL" }).lean()));
router.put("/branding", async (req,res)=> ok(res, await Branding.findOneAndUpdate({ key:"GLOBAL" }, req.body, { upsert:true,new:true,setDefaultsOnInsert:true }), "Branding updated"));
export default router;
