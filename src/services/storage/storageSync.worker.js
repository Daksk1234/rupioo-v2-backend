import { StorageObject } from "../../models/storageObject.model.js";
import { StorageConnection } from "../../models/storageConnection.model.js";
import { retryStorageObject } from "./storage.service.js";
import { testGoogleDriveConnection } from "./googleDrive.service.js";
import { testOneDriveConnection } from "./oneDrive.service.js";

let timer = null;
let running = false;

const markHealth = async (connection, fn) => {
  if (!connection || connection.status === "disconnected") return;
  try {
    await fn(connection.database);
    connection.status = "connected";
    connection.lastHealthAt = new Date();
    connection.lastSuccessAt = new Date();
    connection.lastError = "";
    await connection.save();
  } catch (error) {
    connection.status = "error";
    connection.lastHealthAt = new Date();
    connection.lastErrorAt = new Date();
    connection.lastError = String(error?.message || error).slice(0, 1000);
    await connection.save();
  }
};

export const runStorageSyncCycle = async () => {
  if (running) return;
  running = true;
  try {
    const connections = await StorageConnection.find({
      status: { $in: ["connected", "error"] },
    });

    for (const connection of connections) {
      if (connection.provider === "google_drive") {
        await markHealth(connection, testGoogleDriveConnection);
      } else if (connection.provider === "onedrive") {
        await markHealth(connection, testOneDriveConnection);
      }
    }

    const pending = await StorageObject.find({
      deletedAt: { $exists: false },
      replicationStatus: { $in: ["pending", "degraded", "failed"] },
    })
      .sort({ updatedAt: 1 })
      .limit(Number(process.env.STORAGE_SYNC_BATCH || 20));

    for (const object of pending) {
      try {
        await retryStorageObject(object);
      } catch (error) {
        object.lastError = String(error?.message || error).slice(0, 1800);
        await object.save().catch(() => {});
      }
    }
  } finally {
    running = false;
  }
};

export const startStorageSyncWorker = () => {
  if (timer) return timer;
  const interval = Math.max(
    30_000,
    Number(process.env.STORAGE_SYNC_INTERVAL_MS || 60_000),
  );
  setTimeout(() => runStorageSyncCycle().catch(console.error), 5_000);
  timer = setInterval(() => runStorageSyncCycle().catch(console.error), interval);
  timer.unref?.();
  return timer;
};
