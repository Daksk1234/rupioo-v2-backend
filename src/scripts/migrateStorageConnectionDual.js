import mongoose from "mongoose";
import { StorageConnection } from "../model/storageConnection.model.js";

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGO_URI or MONGODB_URI before running this migration");

  await mongoose.connect(uri);
  const collection = StorageConnection.collection;
  const indexes = await collection.indexes();

  // Old V1 hybrid patch used one unique connection per database.
  const old = indexes.find(
    (idx) => idx.name === "database_1" && idx.unique === true,
  );
  if (old) {
    await collection.dropIndex(old.name);
    console.log("Dropped old unique index:", old.name);
  }

  const rows = await collection
    .find({ $or: [{ slot: { $exists: false } }, { provider: "google_drive" }] })
    .toArray();

  for (const row of rows) {
    if (!row.slot) {
      await collection.updateOne(
        { _id: row._id },
        {
          $set: {
            slot: "primary",
            provider: row.provider === "google_drive" ? "google_drive" : "google_drive",
            encryptedCredential:
              row.encryptedCredential || row.encryptedRefreshToken || "",
            credentialType:
              row.encryptedCredential || row.encryptedRefreshToken
                ? "google_refresh_token"
                : "",
            consentVersion: row.consentVersion || "2.0",
          },
          $unset: { encryptedRefreshToken: "" },
        },
      );
      console.log("Migrated storage connection for", row.database);
    }
  }

  await collection.createIndex(
    { database: 1, slot: 1 },
    { unique: true, name: "database_1_slot_1" },
  );
  await collection.createIndex(
    { database: 1, provider: 1 },
    { unique: true, name: "database_1_provider_1" },
  );

  console.log("Dual-cloud storage connection migration complete.");
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
