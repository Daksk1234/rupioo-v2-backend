import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import mongoose from "mongoose";
import XLSX from "xlsx";
import { connectDb } from "../config/db.js";
import { GlobalTransporterMaster, GlobalTransporterStation } from "../models/index.js";

const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
const splitList = (value) => String(value ?? "").split(/[;|\n]+/).map(clean).filter(Boolean);
const digitsOnly = (value) => clean(value).replace(/\.0$/, "").replace(/[^0-9+]/g, "");
const stationIdFor = (globalId,name,pincode="") => `GTS-${crypto.createHash("sha1").update(`${globalId}|${clean(name).toLowerCase()}|${clean(pincode)}`).digest("hex").slice(0,12).toUpperCase()}`;
const keyFor = (row) => crypto.createHash("sha1")
  .update([clean(row.name).toLowerCase(), clean(row.mobile), clean(row.address).toLowerCase(), clean(row.landline), clean(row.email).toLowerCase(), (row.categories||[]).join(";").toLowerCase(), (row.directoryGroups||[]).join(";").toLowerCase()].join("|"))
  .digest("hex");
const normalize = (input = {}) => {
  const row = {
    name: clean(input.name || input["Firm Name"] || input["Transporter Name"]),
    address: clean(input.address || input.Address),
    pincode: clean(input.pincode ?? input.Pincode).replace(/\.0$/, ""),
    contactPerson: clean(input.contactPerson ?? input["Contact Person"]),
    mobile: digitsOnly(input.mobile ?? input["Mobile Number"] ?? input.Mobile),
    landline: digitsOnly(input.landline ?? input["Landline Number"]),
    email: clean(input.email ?? input.Email).toLowerCase(),
    directoryGroups: splitList(input.directoryGroups ?? input["Directory Groups"] ?? input["Directory Group"]),
    categories: splitList(input.categories ?? input.Categories ?? input.Category),
    listingOccurrences: Number(input.listingOccurrences ?? input["Listing Occurrences"] ?? 1) || 1,
    sourceUrls: splitList(input.sourceUrls ?? input["Source URLs"] ?? input["Source URL"]),
    sourceName: "TransportNagar.in",
    status: "ACTIVE",
  };
  row.masterKey = keyFor(row);
  row.globalTransporterId = `GTR-${row.masterKey.slice(0, 12).toUpperCase()}`;
  return row;
};

const file = path.resolve(process.argv[2] || "data/TransportNagar_All_India_Transporters.xlsx");
if (!fs.existsSync(file)) { console.error(`Transporter file not found: ${file}`); process.exit(1); }
await connectDb();

// Defensive repair for databases created with v18.0. The old compound
// { directoryGroups: 1, categories: 1 } index is invalid once both fields
// contain arrays. connectDb() already repairs it on normal startup; this
// extra check makes the standalone seed command safe as well.
try {
  const collection = GlobalTransporterMaster.collection;
  const indexes = await collection.indexes();
  for (const idx of indexes) {
    const keys = idx?.key || {};
    const names = Object.keys(keys);
    if (names.length === 2 && keys.directoryGroups === 1 && keys.categories === 1) {
      await collection.dropIndex(idx.name);
      console.log(`Dropped obsolete transporter index: ${idx.name}`);
    }
  }
} catch (error) {
  if (error?.codeName !== "NamespaceNotFound") {
    console.warn("Transporter index repair warning:", error?.message || error);
  }
}

console.log(`Importing Global Transporter MASTER from ${file}`);
const workbook = XLSX.readFile(file, { cellDates: false });
let received=0,valid=0,inserted=0,updated=0,unchanged=0,invalid=0,stationInserted=0,stationUpdated=0; const seen=new Set(); let batch=[],stationBatch=[];
async function flush(){
  if(batch.length){
    const result=await GlobalTransporterMaster.bulkWrite(batch,{ordered:false});
    inserted+=result.upsertedCount||0;updated+=result.modifiedCount||0;
    unchanged+=Math.max(0,batch.length-(result.upsertedCount||0)-(result.modifiedCount||0));batch=[];
  }
  if(stationBatch.length){const r=await GlobalTransporterStation.bulkWrite(stationBatch,{ordered:false});stationInserted+=r.upsertedCount||0;stationUpdated+=r.modifiedCount||0;stationBatch=[];}
  process.stdout.write(`\rProcessed ${valid.toLocaleString("en-IN")} valid transporter rows...`);
}
const transporterSheets=workbook.SheetNames.includes("Unique Transporters")?["Unique Transporters"]:workbook.SheetNames;
for(const sheetName of transporterSheets){
  const rows=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{defval:"",raw:false});
  if(!rows.length)continue;
  const headers=new Set(Object.keys(rows[0]||{}).map(x=>clean(x).toLowerCase()));
  if(!headers.has("firm name")&&!headers.has("transporter name")&&!headers.has("name"))continue;
  for(const raw of rows){
    received+=1;const row=normalize(raw);if(!row.name){invalid+=1;continue;}if(seen.has(row.masterKey))continue;seen.add(row.masterKey);valid+=1;
    batch.push({updateOne:{filter:{masterKey:row.masterKey},update:{$set:row},upsert:true}});
    const stationNames=(row.categories||[]).length?row.categories:[...(row.directoryGroups||[]),row.address||row.pincode].filter(Boolean).slice(0,1);
    for(const stationName of stationNames){const sid=stationIdFor(row.globalTransporterId,stationName,row.pincode);stationBatch.push({updateOne:{filter:{stationId:sid},update:{$set:{stationId:sid,globalTransporterId:row.globalTransporterId,name:stationName,stationType:"BOTH",address:row.address||"",pincode:row.pincode||"",servicePincodes:[row.pincode].filter(Boolean),serviceCities:[stationName].filter(Boolean),serviceStates:(row.directoryGroups||[]).slice(0,3),sourceCategory:stationName,sourceDirectoryGroup:(row.directoryGroups||[])[0]||"",status:"ACTIVE",contacts:(row.contactPerson||row.mobile||row.email)?[{name:row.contactPerson||"",designation:"",phone:row.mobile||row.landline||"",email:row.email||"",active:true}]:[]}},upsert:true}});}
    if(batch.length>=1000||stationBatch.length>=1000)await flush();
  }
}
await flush();
console.log("\nGlobal Transporter MASTER import complete.");
console.log({received,valid,inserted,updated,unchanged,invalid,stationInserted,stationUpdated});
await mongoose.disconnect();
