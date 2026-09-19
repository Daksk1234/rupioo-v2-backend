import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { GlobalTransporterMaster } from "../models/index.js";

await connectDb();

try {
  const collection = GlobalTransporterMaster.collection;
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch (error) {
    if (error?.codeName !== "NamespaceNotFound") throw error;
  }

  let dropped = 0;
  for (const idx of indexes) {
    const keys = idx?.key || {};
    const names = Object.keys(keys);
    if (names.length === 2 && keys.directoryGroups === 1 && keys.categories === 1) {
      await collection.dropIndex(idx.name);
      console.log(`Dropped invalid compound multikey index: ${idx.name}`);
      dropped += 1;
    }
  }

  await collection.createIndex({ directoryGroups: 1 }, { name: "directoryGroups_1" });
  await collection.createIndex({ categories: 1 }, { name: "categories_1" });
  await collection.createIndex({ name: 1, mobile: 1 }, { name: "name_1_mobile_1" });

  console.log(`Global Transporter index repair complete. Invalid indexes dropped: ${dropped}`);
  console.log("Safe indexes ready: directoryGroups_1, categories_1, name_1_mobile_1");
} finally {
  await mongoose.disconnect();
}
