/**
 * Read-only MongoDB collection quota diagnostic. Never drops/creates objects.
 * Run from backend: node src/scripts/inspectMongoCollections.js
 * Requires MONGODB_URI and a DB user permitted to list databases/collections.
 */
import mongoose from "mongoose";
import { env } from "../config/env.js";

try {
  await mongoose.connect(env.mongoUri,{serverSelectionTimeoutMS:8000,maxPoolSize:2});
  const client=mongoose.connection.getClient();
  const databases=(await client.db("admin").admin().listDatabases({nameOnly:true})).databases;
  let total=0;
  const report=[];
  for(const {name} of databases){
    if(["admin","config","local"].includes(name))continue;
    const collections=await client.db(name).listCollections({}, {nameOnly:true}).toArray();
    const names=collections.map(x=>x.name).sort();
    total+=names.length;
    report.push({database:name,count:names.length,names});
  }
  report.sort((a,b)=>b.count-a.count||a.database.localeCompare(b.database));
  console.log(`VISIBLE USER COLLECTIONS: ${total}`);
  console.log("Atlas Free tier: maximum 500 collections across all databases.");
  for(const row of report){
    console.log(`\n${row.database}: ${row.count}`);
    console.log(`  ${row.names.join(", ")}`);
  }
  if(total>=490)console.warn("WARNING: Near/over the Atlas Free limit. Do not delete business data. Upgrade tier or archive with a verified backup.");
} catch(error){
  console.error("Read-only collection inventory failed:",error.message);
  process.exitCode=1;
} finally {await mongoose.disconnect();}
