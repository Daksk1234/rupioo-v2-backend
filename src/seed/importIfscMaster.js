import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import XLSX from "xlsx";
import { connectDb } from "../config/db.js";
import { IfscMaster } from "../models/index.js";

const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
const upper = (value) => clean(value).toUpperCase();
const normalize = (input = {}) => ({
  ifsc: upper(input.ifsc || input.IFSC),
  bank: clean(input.bank || input.BANK),
  branch: clean(input.branch || input.BRANCH),
  address: clean(input.address || input.ADDRESS),
  city: clean(input.city || input.CITY || input.CITY1 || input.CITY2),
  state: clean(input.state || input.STATE),
  stdCode: clean(input.stdCode ?? input["STD CODE"] ?? input.std ?? input.STD).replace(/\.0$/, ""),
  phone: clean(input.phone ?? input.PHONE).replace(/\.0$/, ""),
  status: "ACTIVE",
});

const file = path.resolve(process.argv[2] || "data/IFSC_Master_India.xlsx");
if (!fs.existsSync(file)) {
  console.error(`IFSC file not found: ${file}`);
  process.exit(1);
}

await connectDb();
console.log(`Importing IFSC MASTER from ${file}`);
const workbook = XLSX.readFile(file, { cellDates: false });
let received = 0, valid = 0, inserted = 0, updated = 0, unchanged = 0, invalid = 0;
const seen = new Set();
let batch = [];

async function flush() {
  if (!batch.length) return;
  const result = await IfscMaster.bulkWrite(batch, { ordered: false });
  inserted += result.upsertedCount || 0;
  updated += result.modifiedCount || 0;
  unchanged += Math.max(0, batch.length - (result.upsertedCount || 0) - (result.modifiedCount || 0));
  batch = [];
  process.stdout.write(`\rProcessed ${valid.toLocaleString("en-IN")} valid IFSC rows...`);
}

for (const sheetName of workbook.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
  for (const raw of rows) {
    received += 1;
    const row = normalize(raw);
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(row.ifsc) || !row.bank) { invalid += 1; continue; }
    if (seen.has(row.ifsc)) continue;
    seen.add(row.ifsc);
    valid += 1;
    batch.push({ updateOne: { filter: { ifsc: row.ifsc }, update: { $set: row }, upsert: true } });
    if (batch.length >= 1000) await flush();
  }
}
await flush();
console.log(`\nIFSC MASTER import complete.`);
console.log({ received, valid, inserted, updated, unchanged, invalid });
await mongoose.disconnect();
