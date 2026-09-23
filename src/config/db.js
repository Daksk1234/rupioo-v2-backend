import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDb() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.mongoUri, {
    maxPoolSize: 30,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 8000
  });

  // v18.1 migration: MongoDB cannot maintain one compound multikey index
  // when BOTH directoryGroups and categories are arrays. Older v18 builds
  // created { directoryGroups: 1, categories: 1 }, which causes
  // "cannot index parallel arrays" during transporter import/update.
  // Drop only that obsolete compound index; the schema now creates two
  // independent indexes instead. This is safe to run on every startup.
  try {
    const db = mongoose.connection.db;
    const collectionName = "globaltransportermasters";
    const exists = await db.listCollections({ name: collectionName }, { nameOnly: true }).hasNext();
    if (exists) {
      const collection = db.collection(collectionName);
      const indexes = await collection.indexes();
      for (const idx of indexes) {
        const keys = idx?.key || {};
        const names = Object.keys(keys);
        if (names.length === 2 && keys.directoryGroups === 1 && keys.categories === 1) {
          await collection.dropIndex(idx.name);
          console.log(`[DB migration] Dropped invalid Global Transporter index: ${idx.name}`);
        }
      }
      // Safe multikey indexes: one array field per index.
      await collection.createIndex({ directoryGroups: 1 }, { name: "directoryGroups_1" });
      await collection.createIndex({ categories: 1 }, { name: "categories_1" });
    }
  } catch (error) {
    // Do not stop the whole application for a non-critical index migration.
    console.warn("[DB migration] Global Transporter index repair warning:", error?.message || error);
  }

  return mongoose.connection;
}

export function getTenantDbName(tenantKey) {
  return `rupioo_${String(tenantKey || "demo").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

export function getFinancialYearDbName(tenantKey, financialYear) {
  const now = new Date();
  const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fallback = `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  const fy = String(financialYear || fallback).replace(/[^0-9-]/g, "");
  return `${getTenantDbName(tenantKey)}_${fy}`;
}

const connectionCache = new Map();
export function useDatabase(dbName) {
  if (!connectionCache.has(dbName)) {
    connectionCache.set(dbName, mongoose.connection.useDb(dbName, { useCache: true }));
  }
  return connectionCache.get(dbName);
}
