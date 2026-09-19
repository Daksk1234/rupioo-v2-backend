import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import xlsx from "xlsx";
import zlib from "node:zlib";
import {
  User, Role, BranchOffice, GenericRecord, GlobalCustomer, CustomerLink,
  CompanyUnit, ProductCategory, CustomerGrade, BankAccount, Product, Transporter,
  LegacyMigrationMap, LegacyMigrationRun, LegacyMigrationItem
} from "../models/index.js";

const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const normalizeKey = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, "");
const first = (row, keys, fallback="") => {
  const entries = Object.entries(row || {});
  for (const wanted of keys) {
    const nk = normalizeKey(wanted);
    const hit = entries.find(([k]) => normalizeKey(k) === nk);
    if (hit && hit[1] !== undefined && hit[1] !== null && clean(hit[1]) !== "") return hit[1];
  }
  return fallback;
};
const legacyIdOf = (row, fallback="") => clean(first(row,["legacyId","previousId","oldId","sId","id","ID","code","customerId","userId","productId","unitId","_id"],fallback));
const dateValue = (v) => {
  if (!v) return undefined;
  if (v && typeof v === "object" && v.$date) v=v.$date;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const unwrapExtendedJson = (value) => {
  if (Array.isArray(value)) return value.map(unwrapExtendedJson);
  if (!value || typeof value !== "object") return value;
  if (Object.keys(value).length === 1 && value.$oid) return String(value.$oid);
  if (Object.keys(value).length === 1 && value.$date) return value.$date;
  if (Object.keys(value).length === 1 && value.$numberInt) return Number(value.$numberInt);
  if (Object.keys(value).length === 1 && value.$numberLong) return Number(value.$numberLong);
  if (Object.keys(value).length === 1 && value.$numberDecimal) return Number(value.$numberDecimal);
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,unwrapExtendedJson(v)]));
};

const ENTITY_ALIASES = {
  units:["unit","units","uqc","unitmaster","unitsmaster"],
  categories:["category","categories","productcategory","productcategories","categorymaster"],
  grades:["grade","grades","customergrade","customergrades"],
  warehouses:["warehouse","warehouses","godown","godowns"],
  branches:["branch","branches","branchoffice","branchoffices"],
  transporters:["transporter","transporters","transportmaster"],
  bankaccounts:["bankaccount","bankaccounts","banks","companybanks"],
  products:["product","products","productmaster"],
  users:["user","users","usermaster","employees"],
  customers:["customer","customers","parties","party","debtors","creditors","ecommerce"]
};
const canonicalEntity = (name="") => {
  const base = normalizeKey(String(name).replace(/\.[^.]+$/,""));
  for (const [entity, aliases] of Object.entries(ENTITY_ALIASES)) {
    if (aliases.some(a => base === normalizeKey(a) || base.includes(normalizeKey(a)))) return entity;
  }
  return "";
};

function readZipEntries(buffer){
  const EOCD=0x06054b50, CEN=0x02014b50, LOC=0x04034b50;
  let eocd=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--){if(buffer.readUInt32LE(i)===EOCD){eocd=i;break;}}
  if(eocd<0) throw Object.assign(new Error("Invalid ZIP export"),{statusCode:400});
  const total=buffer.readUInt16LE(eocd+10), centralOffset=buffer.readUInt32LE(eocd+16);
  let pos=centralOffset; const entries=[];
  for(let n=0;n<total;n++){
    if(buffer.readUInt32LE(pos)!==CEN) throw Object.assign(new Error("Unsupported ZIP directory"),{statusCode:400});
    const method=buffer.readUInt16LE(pos+10), compSize=buffer.readUInt32LE(pos+20), uncompSize=buffer.readUInt32LE(pos+24);
    const nameLen=buffer.readUInt16LE(pos+28), extraLen=buffer.readUInt16LE(pos+30), commentLen=buffer.readUInt16LE(pos+32), localOffset=buffer.readUInt32LE(pos+42);
    const name=buffer.slice(pos+46,pos+46+nameLen).toString("utf8");
    pos+=46+nameLen+extraLen+commentLen;
    if(name.endsWith("/")) continue;
    if(buffer.readUInt32LE(localOffset)!==LOC) continue;
    const localNameLen=buffer.readUInt16LE(localOffset+26), localExtraLen=buffer.readUInt16LE(localOffset+28), start=localOffset+30+localNameLen+localExtraLen;
    const compressed=buffer.slice(start,start+compSize);
    let data;
    if(method===0) data=compressed;
    else if(method===8) data=zlib.inflateRawSync(compressed);
    else continue;
    if(uncompSize && data.length!==uncompSize) {/* tolerate exporters with metadata differences */}
    entries.push({name,data});
  }
  return entries;
}

function parseJsonBuffer(buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/,"").trim();
  if (!text) return [];
  try {
    const parsed = unwrapExtendedJson(JSON.parse(text));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  const rows=[];
  for (const line of text.split(/\r?\n/)) {
    const s=line.trim(); if(!s) continue;
    try { rows.push(unwrapExtendedJson(JSON.parse(s))); } catch {}
  }
  return rows;
}
function parseTabular(buffer, ext) {
  const wb=xlsx.read(buffer,{type:"buffer",cellDates:true});
  const out={};
  for(const sheet of wb.SheetNames){
    out[sheet]=xlsx.utils.sheet_to_json(wb.Sheets[sheet],{defval:"",raw:false});
  }
  return out;
}
function addRows(target, name, value) {
  if (!value) return;
  if (Array.isArray(value)) {
    const entity=canonicalEntity(name);
    if(entity) target[entity].push(...value.filter(v=>v&&typeof v==="object"));
    return;
  }
  if (typeof value === "object") {
    for(const [k,v] of Object.entries(value)) addRows(target,k,v);
  }
}
export function parseLegacyUpload(file) {
  const result=Object.fromEntries(Object.keys(ENTITY_ALIASES).map(k=>[k,[]]));
  const name=String(file?.originalname||"upload");
  const ext=name.toLowerCase().split(".").pop();
  if(ext==="zip"){
    for(const entry of readZipEntries(file.buffer)){
      const n=entry.name;
      const e=n.toLowerCase().split(".").pop();
      if(e==="json") addRows(result,n,parseJsonBuffer(entry.data));
      else if(["xlsx","xls","csv"].includes(e)) addRows(result,n,parseTabular(entry.data,e));
    }
  } else if(ext==="json") addRows(result,name,parseJsonBuffer(file.buffer));
  else if(["xlsx","xls","csv"].includes(ext)) addRows(result,name,parseTabular(file.buffer,ext));
  else throw Object.assign(new Error("Upload ZIP, JSON, CSV or Excel database export"),{statusCode:400});
  return result;
}

const requiredStatus = (entity,row) => {
  const missing=[];
  const has=(keys)=>clean(first(row,keys));
  if(entity==="customers"){
    if(!has(["name","customerName","partyName","legalName","firmName","companyName"])) missing.push("Party Name");
    if(!has(["address","registeredAddress","billingAddress","address1","ownerAddress"])) missing.push("Address");
    if(!has(["mobile","mobileNumber","phone","contactNumber","companyContactNumber"])) missing.push("Mobile");
    if(!has(["pincode","pin","postalCode","zip"])) missing.push("Pincode");
  } else if(entity==="users"){
    if(!has(["name","fullName","userName","employeeName","firstName"])) missing.push("Name");
    if(!has(["mobile","mobileNumber","phone","contactNumber"])) missing.push("Mobile");
  } else if(entity==="products"){
    if(!has(["name","productName","Product_Title","ProductName","itemName"])) missing.push("Product Name");
    if(!has(["unit","basicUnit","uqc","unitName"])) missing.push("Unit");
    if(!has(["warehouseId","warehouse","godown","warehouseName"])) missing.push("Warehouse");
  } else if(entity==="units"){
    if(!has(["name","unitName","unit"])) missing.push("Unit Name");
  } else if(entity==="categories"){
    if(!has(["name","categoryName","category"])) missing.push("Category Name");
  } else if(entity==="transporters"){
    if(!has(["name","transporterName","firmName","companyName"])) missing.push("Transporter Name");
  } else if(entity==="bankaccounts"){
    if(!has(["accountNumber","bankAccountNo","accountNo"])) missing.push("Account No");
    if(!has(["bankName","bank"])) missing.push("Bank Name");
  }
  return {complete:missing.length===0,missing};
};

export function buildMigrationPreview(data){
  const entities={}; let total=0, incomplete=0;
  for(const [entity,rows] of Object.entries(data)){
    const details=rows.map((row,index)=>({index,legacyId:legacyIdOf(row,String(index+1)),...requiredStatus(entity,row)}));
    const inc=details.filter(x=>!x.complete).length;
    entities[entity]={count:rows.length,complete:rows.length-inc,incomplete:inc,samples:details.slice(0,8)};
    total+=rows.length; incomplete+=inc;
  }
  return {total,incomplete,pendingFields:incomplete,ready:total,importable:total,entities};
}

async function saveMap({tenantKey,entity,legacyId,newId,runId,status="IMPORTED"}){
  if(!legacyId) return;
  await LegacyMigrationMap.findOneAndUpdate({tenantKey,entity,legacyId},{$set:{newId:String(newId||""),runId,status,lastImportedAt:new Date()}},{upsert:true,new:true,setDefaultsOnInsert:true});
}
async function mappedId(tenantKey, entity, legacyId){
  if(!legacyId) return "";
  const hit=await LegacyMigrationMap.findOne({tenantKey,entity,legacyId}).lean();
  return hit?.newId||"";
}
const sourceStatus = (row = {}) => upper(first(row,["status","recordStatus","activeStatus"],"ACTIVE"));
const sourceIsActive = (row = {}) => !["INACTIVE","DEACTIVE","DEACTIVATED","BLOCKED","REJECTED","DISABLED"].includes(sourceStatus(row));
const activeInactiveStatus = (row = {}) => sourceIsActive(row) ? "ACTIVE" : "INACTIVE";
const customerSourceStatus = (row = {}) => sourceIsActive(row) ? "ACTIVE" : "DEACTIVATED";
const drCr = (row = {}, amount = 0) => {
  const raw=upper(first(row,["Type","openingBalanceType","balanceType"],""));
  if(raw.startsWith("C")) return "CR";
  if(raw.startsWith("D")) return "DR";
  return Number(amount)<0 ? "CR" : "DR";
};
const aadhaarParts = (row = {}) => {
  const raw=clean(first(row,["aadharNo","aadhaarNo","aadhaar","aadhar"])).replace(/\D/g,"");
  if(!raw) return {hash:"",masked:""};
  return {hash:crypto.createHash("sha256").update(raw).digest("hex"),masked:`XXXX-XXXX-${raw.slice(-4)}`};
};
async function stageIssue({tenantKey,runId,entity,legacyId,row,missing,message}){
  await LegacyMigrationItem.findOneAndUpdate({tenantKey,entity,legacyId,runId},{$set:{raw:row,status:"PENDING_FIELDS",missingFields:missing||[],message:message||"Imported and usable. Complete the remaining profile fields when convenient."}},{upsert:true,new:true});
}
const migrationMeta=(legacyId,runId,complete,sourceData={})=>({legacyId,runId,status:complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS",profileComplete:!!complete,verified:false,importedAt:new Date(),sourceData});

async function importUnits(rows,ctx){
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1)),check=requiredStatus("units",r);
    const rawName=clean(first(r,["name","unitName","unit"]));
    const name=rawName||`Legacy Unit ${legacyId||i+1}`;
    const code=upper(first(r,["code","unitCode","uqc"],rawName||`LEG${i+1}`)).replace(/\s+/g,"_").slice(0,30);
    const doc=await CompanyUnit.findOneAndUpdate({tenantKey:ctx.tenantKey,$or:[{"migration.legacyId":legacyId},{code}]},{$set:{tenantKey:ctx.tenantKey,code,name,uqc:upper(first(r,["uqc","gstUqc"],code)),decimals:num(first(r,["decimals","decimalPlaces"],0)),status:activeInactiveStatus(r),migration:migrationMeta(legacyId,ctx.runId,check.complete,r)}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await saveMap({...ctx,entity:"units",legacyId,newId:doc._id,status:check.complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});
    ctx.summary.units.imported++;
    if(!check.complete){await stageIssue({...ctx,entity:"units",legacyId,row:r,missing:check.missing});ctx.summary.units.incomplete++;}
  }
}
async function importCategories(rows,ctx){
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1));
    const rawName=clean(first(r,["name","categoryName","category"]));
    const name=rawName||`Legacy Category ${legacyId||i+1}`;
    const complete=!!rawName;
    const code=upper(first(r,["code","categoryCode"],rawName||`LEG_CAT_${i+1}`)).replace(/\s+/g,"_").slice(0,30);
    const subText=clean(first(r,["subcategories","subCategories","subcategory","subCategory"]));
    const subs=subText?subText.split(/[,|;]/).map((x,j)=>({code:`${code}-${j+1}`,name:clean(x),status:"ACTIVE"})).filter(x=>x.name):[];
    const doc=await ProductCategory.findOneAndUpdate({tenantKey:ctx.tenantKey,$or:[{"migration.legacyId":legacyId},{code}]},{$set:{tenantKey:ctx.tenantKey,code,name,subcategories:subs,status:activeInactiveStatus(r),migration:migrationMeta(legacyId,ctx.runId,complete,r)}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await saveMap({...ctx,entity:"categories",legacyId,newId:doc._id,status:complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});
    ctx.summary.categories.imported++;
    if(!complete){await stageIssue({...ctx,entity:"categories",legacyId,row:r,missing:["Category Name"]});ctx.summary.categories.incomplete++;}
  }
}
async function importGrades(rows,ctx){
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1));
    const rawName=clean(first(r,["name","gradeName","grade"]));
    const name=rawName||`Legacy Grade ${legacyId||i+1}`;
    const complete=!!rawName;
    const code=upper(first(r,["code","gradeCode"],rawName||`LEG_GRADE_${i+1}`)).replace(/\s+/g,"_").slice(0,30);
    const doc=await CustomerGrade.findOneAndUpdate({tenantKey:ctx.tenantKey,$or:[{"migration.legacyId":legacyId},{code}]},{$set:{tenantKey:ctx.tenantKey,code,name,discountPct:num(first(r,["discountPct","discount","gradeDiscount"])),description:clean(first(r,["description","remarks"])),status:activeInactiveStatus(r),migration:migrationMeta(legacyId,ctx.runId,complete,r)}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await saveMap({...ctx,entity:"grades",legacyId,newId:doc._id,status:complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});
    ctx.summary.grades.imported++;
    if(!complete){await stageIssue({...ctx,entity:"grades",legacyId,row:r,missing:["Grade Name"]});ctx.summary.grades.incomplete++;}
  }
}
async function importWarehouses(rows,ctx){
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1));
    const rawTitle=clean(first(r,["title","name","warehouseName","godownName","warehouse"]));
    const title=rawTitle||`Legacy Warehouse ${legacyId||i+1}`;
    const complete=!!rawTitle;
    const reference=clean(first(r,["code","warehouseCode","reference"],`WH-${legacyId||i+1}`));
    let doc=await GenericRecord.findOne({tenantKey:ctx.tenantKey,app:"dms",resource:"warehouses","data.migration.legacyId":legacyId});
    if(!doc) doc=await GenericRecord.findOne({tenantKey:ctx.tenantKey,app:"dms",resource:"warehouses",$or:[{reference},{title}]});
    if(!doc) doc=new GenericRecord({tenantKey:ctx.tenantKey,app:"dms",resource:"warehouses",title,reference});
    doc.title=title;doc.reference=reference;doc.status=activeInactiveStatus(r);doc.data={...(doc.data||{}),address:clean(first(r,["address","warehouseAddress"])),city:clean(first(r,["city"])),pincode:clean(first(r,["pincode","pin"])),migration:migrationMeta(legacyId,ctx.runId,complete,r)};await doc.save();
    await saveMap({...ctx,entity:"warehouses",legacyId,newId:doc._id,status:complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});ctx.summary.warehouses.imported++;
    if(!complete){await stageIssue({...ctx,entity:"warehouses",legacyId,row:r,missing:["Warehouse Name"]});ctx.summary.warehouses.incomplete++;}
  }
}
async function importBranches(rows,ctx){
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1));
    const rawName=clean(first(r,["name","branchName","branch"]));
    const name=rawName||`Legacy Branch ${legacyId||i+1}`;
    const complete=!!rawName;
    const branchCode=upper(first(r,["branchCode","code"],`BR${i+1}`)).replace(/\s+/g,"_");
    const doc=await BranchOffice.findOneAndUpdate({tenantKey:ctx.tenantKey,$or:[{"migration.legacyId":legacyId},{branchCode}]},{$set:{tenantKey:ctx.tenantKey,name,branchCode,address:clean(first(r,["address"])),district:clean(first(r,["district","city"])),state:clean(first(r,["state"])),pincode:clean(first(r,["pincode","pin"])),status:activeInactiveStatus(r),migration:migrationMeta(legacyId,ctx.runId,complete,r)}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await saveMap({...ctx,entity:"branches",legacyId,newId:doc._id,status:complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});ctx.summary.branches.imported++;
    if(!complete){await stageIssue({...ctx,entity:"branches",legacyId,row:r,missing:["Branch Name"]});ctx.summary.branches.incomplete++;}
  }
}
async function importTransporters(rows,ctx){
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1));
    const rawName=clean(first(r,["name","transporterName","firmName","companyName"]));
    const name=rawName||`Legacy Transporter ${legacyId||i+1}`;
    const stationName=clean(first(r,["station","city","City","branch","deliveryStation"]));
    const missing=[];if(!rawName)missing.push("Transporter Name");if(!stationName)missing.push("Station/City");
    const complete=missing.length===0;
    const doc=await Transporter.findOneAndUpdate({tenantKey:ctx.tenantKey,$or:[{"migration.legacyId":legacyId},{name}]},{$set:{tenantKey:ctx.tenantKey,name,gstin:upper(first(r,["gstin","gstNo","gstNumber","gst"])),pan:upper(first(r,["pan","panNo","comPanNo"])),stations:stationName?[{name:stationName,type:"BOTH",address:clean(first(r,["address","address1"])),pincode:clean(first(r,["pincode","pin"])),contacts:[{name:clean(first(r,["contactPerson","contactName","ownerName"])),phone:clean(first(r,["mobile","mobileNumber","phone","contactNumber"])),email:clean(first(r,["email"])),active:true}]}]:[],paymentTerms:clean(first(r,["paymentTerms","paymentTerm"])),freightNotes:clean(first(r,["freightNotes","remarks"])),status:activeInactiveStatus(r),migration:migrationMeta(legacyId,ctx.runId,complete,r)}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await saveMap({...ctx,entity:"transporters",legacyId,newId:doc._id,status:complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});ctx.summary.transporters.imported++;
    if(!complete){await stageIssue({...ctx,entity:"transporters",legacyId,row:r,missing});ctx.summary.transporters.incomplete++;}
  }
}
async function importBanks(rows,ctx){
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1)),check=requiredStatus("bankaccounts",r);
    const rawAccount=clean(first(r,["accountNumber","bankAccountNo","accountNo","Account_No"]));
    const rawBank=clean(first(r,["bankName","bank"]));
    const accountNumber=rawAccount||`LEGACY-${ctx.tenantKey}-${legacyId||i+1}`;
    const bankName=rawBank||"LEGACY BANK - COMPLETE PROFILE";
    const holder=clean(first(r,["accountHolderName","accountName","holderName","Account_Name"],"Legacy Account"));
    const normalized=accountNumber.replace(/\D/g,"")||accountNumber.replace(/\s/g,"");
    const doc=await BankAccount.findOneAndUpdate({tenantKey:ctx.tenantKey,$or:[{"migration.legacyId":legacyId},{accountNumberNormalized:normalized}]},{$set:{tenantKey:ctx.tenantKey,bankAccountId:clean(first(r,["bankAccountId","code"],`LEG-${ctx.tenantKey}-BANK-${legacyId||i+1}`)),bankName,branchName:clean(first(r,["branchName","branch"])),branchAddress:clean(first(r,["branchAddress","address"])),city:clean(first(r,["city","City"])),state:clean(first(r,["state","State"])),accountHolderName:holder,accountNumber,accountNumberNormalized:normalized,ifsc:upper(first(r,["ifsc","ifscCode","Ifsc_code"])),micr:clean(first(r,["micr"])),upiId:clean(first(r,["upiId","upi"])),status:activeInactiveStatus(r),migration:migrationMeta(legacyId,ctx.runId,check.complete,r)}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await saveMap({...ctx,entity:"bankaccounts",legacyId,newId:doc._id,status:check.complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});ctx.summary.bankaccounts.imported++;
    if(!check.complete){await stageIssue({...ctx,entity:"bankaccounts",legacyId,row:r,missing:check.missing});ctx.summary.bankaccounts.incomplete++;}
  }
}
async function importProducts(rows,ctx){
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1));
    const rawName=clean(first(r,["name","productName","Product_Title","itemName"]));
    const name=rawName||`Legacy Product ${legacyId||i+1}`;
    const unitLegacy=clean(first(r,["unitId","unitLegacyId","unitCode"])); const whLegacy=clean(first(r,["warehouseId","warehouseLegacyId","godownId"]));
    let unitName=clean(first(r,["unit","basicUnit","uqc","unitName"]));
    if(unitLegacy){const id=await mappedId(ctx.tenantKey,"units",unitLegacy); if(id){const u=await CompanyUnit.findById(id).lean(); if(u) unitName=u.name||u.code;}}
    let warehouseId=""; if(whLegacy) warehouseId=await mappedId(ctx.tenantKey,"warehouses",whLegacy);
    if(!warehouseId){const whName=clean(first(r,["warehouse","warehouseName","godown"])); if(whName){const w=await GenericRecord.findOne({tenantKey:ctx.tenantKey,app:"dms",resource:"warehouses",title:new RegExp(`^${whName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'i')}).lean();warehouseId=w?._id?String(w._id):"";}}
    const catLegacy=clean(first(r,["categoryId","categoryLegacyId"])); let category=clean(first(r,["category","categoryName"])); if(catLegacy){const id=await mappedId(ctx.tenantKey,"categories",catLegacy);if(id){const c=await ProductCategory.findById(id).lean();if(c)category=c.name;}}
    const missing=[];if(!rawName)missing.push("Product Name");if(!unitName)missing.push("Unit");if(!warehouseId)missing.push("Warehouse");
    const complete=missing.length===0;
    const sku=upper(first(r,["sku","productCode","code"],`LEG-${legacyId||i+1}`)).replace(/\s+/g,"-");
    const doc=await Product.findOneAndUpdate({tenantKey:ctx.tenantKey,$or:[{"migration.legacyId":legacyId},{sku}]},{$set:{tenantKey:ctx.tenantKey,sku,name,category,subCategory:clean(first(r,["subCategory","subcategory"])),warehouseId,hsnCode:clean(first(r,["hsnCode","hsn","HSN_Code"])),hsnDescription:clean(first(r,["hsnDescription","description"])),gstRate:num(first(r,["gstRate","gst","taxRate","GSTRate"])),basicUnit:unitName||"PCS",packingUnit:clean(first(r,["packingUnit"])),qtyInBag:num(first(r,["qtyInBag","packQty"],1),1),unit:unitName||"PCS",openingStock:num(first(r,["openingStock","stock"])),currentStock:num(first(r,["currentStock","stock","openingStock"])),openingRate:num(first(r,["openingRate","purchaseRate"])),lastPurchasePrice:num(first(r,["lastPurchasePrice","purchasePrice","purchaseRate"])),averagePurchasePrice:num(first(r,["averagePurchasePrice","avgPurchasePrice","purchaseRate"])),landedCost:num(first(r,["landedCost","landingPrice"])),mrp:num(first(r,["mrp"])),salePrice:num(first(r,["salePrice","sellingPrice"])),barcode:clean(first(r,["barcode","gtin","ean"])),status:activeInactiveStatus(r),migration:migrationMeta(legacyId,ctx.runId,complete,r)}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await saveMap({...ctx,entity:"products",legacyId,newId:doc._id,status:complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});ctx.summary.products.imported++;
    if(!complete){await stageIssue({...ctx,entity:"products",legacyId,row:r,missing});ctx.summary.products.incomplete++;}
  }
}
async function importUsers(rows,ctx){
  const deferred=[];
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1));
    const rawName=clean(first(r,["name","fullName","userName","employeeName","firstName"]));
    const name=rawName||`Legacy User ${legacyId||i+1}`;
    const sourceEmail=clean(first(r,["email","emailId"])).toLowerCase();
    const stable=String(legacyId||i+1).replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,50);
    const tenantPart=String(ctx.tenantKey||"tenant").replace(/[^a-zA-Z0-9]/g,"_").slice(0,30);
    const email=sourceEmail||`legacy.${tenantPart}.${stable}@migration.invalid`;
    const mobile=clean(first(r,["mobile","mobileNumber","phone","contactNumber"])); const roleName=clean(first(r,["role","roleName","designation"]));
    const role=roleName?await Role.findOne({tenantKey:ctx.tenantKey,$or:[{name:new RegExp(`^${roleName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'i')},{code:upper(roleName)}]}).lean():null;
    const missing=[];if(!rawName)missing.push("Name");if(!mobile)missing.push("Mobile");if(roleName&&!role)missing.push("Role mapping");if(!roleName)missing.push("Role mapping");
    const complete=missing.length===0;
    const legacyPassword=clean(first(r,["passwordHash","password"]));
    let passwordHash=legacyPassword;
    if(!passwordHash.startsWith("$2")) passwordHash=legacyPassword?await bcrypt.hash(legacyPassword,10):await bcrypt.hash(crypto.randomBytes(18).toString("hex"),10);
    const canLogin=sourceIsActive(r)&&!!sourceEmail&&!!legacyPassword;
    const doc=await User.findOneAndUpdate({tenantKey:ctx.tenantKey,$or:[{"migration.legacyId":legacyId},{email}]},{$set:{tenantKey:ctx.tenantKey,tenantId:ctx.tenantId||"",name,email,passwordHash,role:role?.code||"USER",roleId:role?._id,departmentId:role?.departmentId,mobile,address:clean(first(r,["address","address1"])),pincode:clean(first(r,["pincode","pin"])),city:clean(first(r,["city","City"])),district:clean(first(r,["district"])),state:clean(first(r,["state","State"])),pan:upper(first(r,["pan","panNo","comPanNo"])),designation:clean(first(r,["designation"])),employeeId:clean(first(r,["employeeId","staffId","sId"])),loginEnabled:canLogin,status:activeInactiveStatus(r),migration:migrationMeta(legacyId,ctx.runId,complete,r)}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await saveMap({...ctx,entity:"users",legacyId,newId:doc._id,status:complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});deferred.push({doc,r,legacyId,complete});ctx.summary.users.imported++;
    if(!complete){await stageIssue({...ctx,entity:"users",legacyId,row:r,missing});ctx.summary.users.incomplete++;}
  }
  for(const item of deferred){
    const parentLegacy=clean(first(item.r,["parentUserId","reportsToId","assignedToUserId","managerId"])); const branchLegacy=clean(first(item.r,["branchId","branchLegacyId"]));
    const patch={}; if(parentLegacy){const id=await mappedId(ctx.tenantKey,"users",parentLegacy);if(id){patch.assignedToUserId=id;patch.reportsTo=id;}}
    if(branchLegacy){const id=await mappedId(ctx.tenantKey,"branches",branchLegacy);if(id)patch.branchId=id;}
    if(Object.keys(patch).length) await User.updateOne({_id:item.doc._id},{$set:patch});
  }
}
async function importCustomers(rows,ctx){
  for(let i=0;i<rows.length;i++){
    const r=rows[i],legacyId=legacyIdOf(r,String(i+1));
    const rawName=clean(first(r,["name","customerName","partyName","legalName","firmName","companyName"]));
    const gstin=upper(first(r,["gstin","gstNo","gstNumber"]));
    const pan=upper(first(r,["pan","panNo","comPanNo"]));
    const name=rawName||gstin||pan||`Legacy Customer ${legacyId||i+1}`;
    const mobile=clean(first(r,["mobile","mobileNumber","phone","contactNumber","companyContactNumber"])); const email=clean(first(r,["email","emailId"]));
    const address=clean(first(r,["address","registeredAddress","billingAddress","address1","ownerAddress"])); const pincode=clean(first(r,["pincode","pin","postalCode","zip"])); const city=clean(first(r,["city","City"])); const state=clean(first(r,["state","State"]));
    const missing=[];if(!rawName)missing.push("Party Name");if(!address)missing.push("Address");if(!mobile)missing.push("Mobile");if(!pincode)missing.push("Pincode");
    const complete=missing.length===0;
    let global=null;
    if(gstin) global=await GlobalCustomer.findOne({"gstins.value":gstin});
    if(!global && mobile) global=await GlobalCustomer.findOne({"mobiles.value":mobile});
    if(!global) global=new GlobalCustomer({hiddenId:`LEGACY-${ctx.tenantKey}-${legacyId||crypto.randomUUID()}`,legalName:name});
    global.legalName=name;global.tradeName=clean(first(r,["tradeName","CompanyName","companyName"],name));global.pan=pan||global.pan;global.registeredAddress=address||global.registeredAddress;
    if(gstin&&!global.gstins?.some(x=>x.value===gstin)) global.gstins=[...(global.gstins||[]),{value:gstin,status:"UNVERIFIED"}];
    if(mobile&&!global.mobiles?.some(x=>x.value===mobile)) global.mobiles=[...(global.mobiles||[]),{value:mobile,verified:false,primary:true,active:true}];
    if(email&&!global.emails?.some(x=>x.value===email)) global.emails=[...(global.emails||[]),{value:email,verified:false,primary:true,active:true}];
    global.migration=migrationMeta(legacyId,ctx.runId,complete,r);await global.save();

    const oldCode=clean(first(r,["sId","customerCode","code","id","customerId"]));
    const identifier=oldCode||gstin||pan||`LEG-${legacyId||i+1}`;
    // New imports use the permanent GlobalCustomer.hiddenId just like normal V2 customers.
    // The ObjectId lookup remains only for backward compatibility with records imported by older patches.
    let link=await CustomerLink.findOne({tenantKey:ctx.tenantKey,$or:[{"migration.legacyId":legacyId},{globalCustomerId:{$in:[global.hiddenId,String(global._id)]}}]});
    if(!link) link=new CustomerLink({tenantKey:ctx.tenantKey,globalCustomerId:global.hiddenId,displayIdentifier:identifier});
    const salespersonLegacy=clean(first(r,["salespersonId","salesPersonId","assignedToUserId","salesmanId"])); const salespersonId=salespersonLegacy?await mappedId(ctx.tenantKey,"users",salespersonLegacy):"";
    const gradeLegacy=clean(first(r,["gradeId","customerGradeId"])); let gradeCode=upper(first(r,["gradeCode","grade"])); if(gradeLegacy){const id=await mappedId(ctx.tenantKey,"grades",gradeLegacy);if(id){const g=await CustomerGrade.findById(id).lean();if(g)gradeCode=g.code;}}
    const transportLegacy=clean(first(r,["transporterId","transportId"])); const transportId=transportLegacy?await mappedId(ctx.tenantKey,"transporters",transportLegacy):"";
    const paymentRaw=upper(first(r,["paymentType","paymentTerm"],"CASH"));
    const openingRaw=num(first(r,["OpeningBalance","openingBalance"],0));
    const aadhaar=aadhaarParts(r);
    const nestedBanks=Array.isArray(r?.bankDetails)?r.bankDetails.map(b=>({
      ifsc:upper(first(b,["ifsc","ifscCode","Ifsc_code"])),bankName:clean(first(b,["bankName","bank"])),branchName:clean(first(b,["branchName","branch"])),
      accountName:clean(first(b,["accountName","Account_Name"])),accountNumber:clean(first(b,["accountNumber","accountNo","Account_No"])),city:clean(first(b,["city"])),state:clean(first(b,["state"]))
    })).filter(b=>Object.values(b).some(Boolean)):[];
    const embeddedTransport=Array.isArray(r?.assignTransporter)&&r.assignTransporter[0]?r.assignTransporter[0]:null;
    const assignedTransportName=transportId||clean(first(r,["transporterName","transportName"]))||clean(embeddedTransport?.companyName||embeddedTransport?.name||"");

    link.displayIdentifier=identifier;
    link.customerCode=oldCode||identifier;
    link.localName=name;
    link.firstName=clean(first(r,["firstName"]));link.lastName=clean(first(r,["lastName"]));link.ownerName=clean(first(r,["ownerName","contactPerson"]));link.ownerMobile=clean(first(r,["ownerMobile","mobileNumber","contactNumber"]));link.ownerPan=upper(first(r,["panNo","comPanNo","pan"]));
    link.ownerAadhaarHash=aadhaar.hash||undefined;link.ownerAadhaarMasked=aadhaar.masked||"";link.passportNumber=upper(first(r,["passPortNo","passportNo","passportNumber"]));
    link.ownerAddress=clean(first(r,["ownerAddress","address"]));link.ownerPincode=clean(first(r,["personalPincode","ownerPincode"]));link.ownerCity=clean(first(r,["Pcity","ownerCity"]));link.ownerState=clean(first(r,["Pstate","ownerState"]));
    link.partyType=upper(first(r,["partyType","type","accountType"],"DEBITOR"));link.registrationType=upper(first(r,["registrationType"],"UNKNOWN"));link.paymentType=paymentRaw.includes("CREDIT")?"CREDIT":"CASH";
    link.creditDays=num(first(r,["creditDays","lockInTime","duedate","dueDays"]));link.creditLimit=num(first(r,["creditLimit","limit"]));link.companyContactNumber=mobile;link.address2=clean(first(r,["address2"]));link.salespersonId=salespersonId||"";link.gradeCode=gradeCode;link.assignedTransport=assignedTransportName;
    link.regionType=upper(first(r,["regionType"],"LOCAL"));link.category=clean(first(r,["category"]));link.dealsInProducts=clean(first(r,["dealsInProducts"]));link.annualTurnover=num(first(r,["annualTurnover"]));link.shopSize=clean(first(r,["shopSize"]));link.serviceArea=clean(first(r,["serviceArea"]));link.bankDetails=nestedBanks;
    link.status=customerSourceStatus(r);
    link.contacts=[{name:clean(first(r,["contactPerson","ownerName"],name)),mobile,email,primary:true,active:true}];
    link.addresses=[{type:"BILLING",address,pincode,city,state,area:clean(first(r,["area"])),district:clean(first(r,["district"]))}];
    link.accountingProfile={systemAccountCode:"SYS_SUNDRY_DEBTORS",ledgerName:name,openingBalance:Math.abs(openingRaw),openingBalanceType:drCr(r,openingRaw),financialYear:clean(first(r,["openingFinancialYear","financialYear"]))};
    link.approval={status:"APPROVED",submittedBy:ctx.userId,submittedAt:new Date(),reviewedBy:ctx.userId,reviewedAt:new Date(),remarks:complete?"Imported from Previous DMS":"Imported from Previous DMS and activated; profile fields may be completed later",decision:"MIGRATED_ACTIVE"};
    link.migration=migrationMeta(legacyId,ctx.runId,complete,r);await link.save();
    await saveMap({...ctx,entity:"customers",legacyId,newId:link._id,status:complete?"IMPORTED":"IMPORTED_WITH_PENDING_FIELDS"});ctx.summary.customers.imported++;
    if(!complete){await stageIssue({...ctx,entity:"customers",legacyId,row:r,missing});ctx.summary.customers.incomplete++;}
  }
}

export async function activateExistingLegacyImports({tenantKey,userId}){
  const items=await LegacyMigrationItem.find({tenantKey,status:"NEEDS_COMPLETION"}).limit(5000);
  const counts={customers:0,users:0,products:0,transporters:0,other:0};
  for(const item of items){
    const legacyId=item.legacyId, raw=item.raw||{}, active=sourceIsActive(raw);
    if(item.entity==="customers"){
      await CustomerLink.updateMany({tenantKey,"migration.legacyId":legacyId},{$set:{status:active?"ACTIVE":"DEACTIVATED","approval.status":"APPROVED","approval.reviewedBy":userId,"approval.reviewedAt":new Date(),"approval.remarks":"Previous DMS import activated; remaining profile fields can be completed later","approval.decision":"MIGRATED_ACTIVE","migration.status":"IMPORTED_WITH_PENDING_FIELDS","migration.profileComplete":false}});
      await GlobalCustomer.updateMany({"migration.legacyId":legacyId},{$set:{"migration.status":"IMPORTED_WITH_PENDING_FIELDS","migration.profileComplete":false}});
      counts.customers++;
    } else if(item.entity==="users"){
      await User.updateMany({tenantKey,"migration.legacyId":legacyId},{$set:{status:active?"ACTIVE":"INACTIVE","migration.status":"IMPORTED_WITH_PENDING_FIELDS","migration.profileComplete":false}});counts.users++;
    } else if(item.entity==="products"){
      await Product.updateMany({tenantKey,"migration.legacyId":legacyId},{$set:{status:active?"ACTIVE":"INACTIVE","migration.status":"IMPORTED_WITH_PENDING_FIELDS","migration.profileComplete":false}});counts.products++;
    } else if(item.entity==="transporters"){
      await Transporter.updateMany({tenantKey,"migration.legacyId":legacyId},{$set:{status:active?"ACTIVE":"INACTIVE","migration.status":"IMPORTED_WITH_PENDING_FIELDS","migration.profileComplete":false}});counts.transporters++;
    } else counts.other++;
    item.status="PENDING_FIELDS";
    item.message="Imported and usable. Complete the remaining profile fields when convenient.";
    await item.save();
    await LegacyMigrationMap.updateMany({tenantKey,entity:item.entity,legacyId},{$set:{status:"IMPORTED_WITH_PENDING_FIELDS",lastImportedAt:new Date()}});
  }
  // Old importer also kept complete customers in PENDING_VERIFICATION and users INACTIVE.
  await CustomerLink.updateMany({tenantKey,"migration.legacyId":{$exists:true,$ne:""},status:"PENDING_VERIFICATION"},{$set:{status:"ACTIVE","approval.status":"APPROVED","approval.reviewedBy":userId,"approval.reviewedAt":new Date(),"approval.remarks":"Previous DMS import activated under migration policy","approval.decision":"MIGRATED_ACTIVE"}});
  await User.updateMany({tenantKey,"migration.legacyId":{$exists:true,$ne:""},status:"INACTIVE"},{$set:{status:"ACTIVE"}});
  return {processed:items.length,counts};
}

export async function importLegacyData({data,tenantKey,tenantId,userId,fileName}){
  const run=await LegacyMigrationRun.create({tenantKey,tenantId,fileName,status:"RUNNING",startedBy:userId,startedAt:new Date(),summary:{}});
  const summary=Object.fromEntries(Object.keys(ENTITY_ALIASES).map(k=>[k,{imported:0,incomplete:0,failed:0}]));
  const ctx={tenantKey,tenantId,userId,runId:String(run._id),summary};
  const jobs=[
    ["units",importUnits],["categories",importCategories],["grades",importGrades],["warehouses",importWarehouses],["branches",importBranches],
    ["transporters",importTransporters],["bankaccounts",importBanks],["products",importProducts],["users",importUsers],["customers",importCustomers]
  ];
  try{
    for(const [entity,fn] of jobs){
      try{await fn(data[entity]||[],ctx);}catch(error){summary[entity].failed+=(data[entity]||[]).length;summary[entity].error=error.message;}
    }
    const totalImported=Object.values(summary).reduce((a,x)=>a+x.imported,0), totalIncomplete=Object.values(summary).reduce((a,x)=>a+x.incomplete,0), totalFailed=Object.values(summary).reduce((a,x)=>a+x.failed,0);
    run.status=totalFailed?"COMPLETED_WITH_ERRORS":"COMPLETED";run.completedAt=new Date();run.summary={...summary,totalImported,totalIncomplete,totalFailed};await run.save();return run.toObject();
  }catch(error){run.status="FAILED";run.completedAt=new Date();run.error=error.message;await run.save();throw error;}
}
