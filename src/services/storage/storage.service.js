import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { StorageObject } from "../../models/storageObject.model.js";
import {
  uploadBufferToGoogleDrive,
  getGoogleDriveFileBuffer,
  getGoogleDriveFileStream,
} from "./googleDrive.service.js";
import {
  uploadBufferToOneDrive,
  getOneDriveFileBuffer,
  getOneDriveFileStream,
} from "./oneDrive.service.js";
import { encryptBuffer, decryptBuffer } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../..");
const privateRoot = path.join(backendRoot, "storage", "private");

const clean = (v, fallback = "unknown") => {
  const text = String(v || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || fallback;
};

const checksum = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");

const buildFolderParts = ({ entityType, entityId, documentType }) => [
  clean(entityType, "Other"),
  clean(entityId, "Unknown"),
  clean(documentType, "Files"),
];

const saveEncryptedFallback = ({ database, objectId, buffer }) => {
  const dir = path.join(privateRoot, clean(database, "default"));
  fs.mkdirSync(dir, { recursive: true });
  const key = `${objectId}.rupioenc`;
  const abs = path.join(dir, key);
  fs.writeFileSync(abs, encryptBuffer(buffer));
  return path.relative(privateRoot, abs).replace(/\\/g, "/");
};

const loadEncryptedFallback = (storageKey) => {
  const abs = path.resolve(privateRoot, String(storageKey || ""));
  if (!abs.startsWith(path.resolve(privateRoot))) throw new Error("Invalid fallback storage key");
  if (!fs.existsSync(abs)) throw new Error("Fallback file is missing");

  const raw = fs.readFileSync(abs);

  // New V2 dual-cloud fallbacks are AES-256-GCM encrypted and start with RUPIO2.
  // Older hybrid-storage builds may have a plaintext local fallback. Read those
  // only for backward compatibility so an upgrade never makes an old file unreadable.
  if (raw.subarray(0, 6).toString("utf8") === "RUPIO2") {
    return decryptBuffer(raw);
  }

  return raw;
};

const removeEncryptedFallback = (storageKey) => {
  if (!storageKey) return;
  const abs = path.resolve(privateRoot, String(storageKey));
  if (!abs.startsWith(path.resolve(privateRoot))) return;
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
};

const blankCopy = (slot, provider) => ({
  slot,
  provider,
  status: "pending",
  fileId: "",
  fileName: "",
  size: 0,
  checksum: "",
  lastError: "",
  retryCount: 0,
});

const replicationStatus = (copies = []) => {
  const primary = copies.find((x) => x.slot === "primary");
  const backup = copies.find((x) => x.slot === "backup");
  const p = primary?.status === "synced";
  const b = backup?.status === "synced";
  if (p && b) return "healthy";
  if (p || b) return "degraded";
  if (copies.some((x) => x.status === "pending")) return "pending";
  return "failed";
};

const setCopyResult = (copies, slot, provider, result, expectedChecksum) => {
  const index = copies.findIndex((x) => x.slot === slot);
  const base = index >= 0 ? { ...copies[index].toObject?.() || copies[index] } : blankCopy(slot, provider);
  const next = {
    ...base,
    slot,
    provider,
    status: "synced",
    fileId: result.fileId || "",
    fileName: result.fileName || "",
    size: Number(result.size || 0),
    checksum: expectedChecksum,
    syncedAt: new Date(),
    lastAttemptAt: new Date(),
    lastError: "",
  };
  if (index >= 0) copies[index] = next;
  else copies.push(next);
};

const setCopyError = (copies, slot, provider, error) => {
  const index = copies.findIndex((x) => x.slot === slot);
  const old = index >= 0 ? { ...copies[index].toObject?.() || copies[index] } : blankCopy(slot, provider);
  const next = {
    ...old,
    slot,
    provider,
    status: "error",
    lastAttemptAt: new Date(),
    retryCount: Number(old.retryCount || 0) + 1,
    lastError: String(error?.message || error || "Upload failed").slice(0, 1000),
  };
  if (index >= 0) copies[index] = next;
  else copies.push(next);
};

const uploadToSlot = async ({ slot, database, buffer, fileName, mimeType, folderParts }) => {
  if (slot === "primary") {
    return uploadBufferToGoogleDrive({ database, buffer, fileName, mimeType, folderParts });
  }
  return uploadBufferToOneDrive({ database, buffer, fileName, mimeType, folderParts });
};

export const putPrivateFile = async ({
  database,
  entityType,
  entityId,
  documentType = "Files",
  buffer,
  fileName,
  mimeType = "application/octet-stream",
}) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("File buffer is required");
  const digest = checksum(buffer);
  const folderParts = buildFolderParts({ entityType, entityId, documentType });

  const object = await StorageObject.create({
    database,
    entityType: String(entityType || "other"),
    entityId: String(entityId || "unknown"),
    documentType,
    fileName,
    mimeType,
    size: buffer.length,
    checksum: digest,
    copies: [blankCopy("primary", "google_drive"), blankCopy("backup", "onedrive")],
    replicationStatus: "pending",
  });

  object.fallbackStorageKey = saveEncryptedFallback({
    database,
    objectId: String(object._id),
    buffer,
  });
  object.fallbackStatus = "available";
  await object.save();

  const copies = object.copies.map((x) => ({ ...x.toObject() }));

  // Try both providers in the same request. A failure never loses the upload,
  // because the encrypted fallback remains until both replicas are verified.
  const results = await Promise.allSettled([
    uploadToSlot({ slot: "primary", database, buffer, fileName, mimeType, folderParts }),
    uploadToSlot({ slot: "backup", database, buffer, fileName, mimeType, folderParts }),
  ]);

  if (results[0].status === "fulfilled") {
    setCopyResult(copies, "primary", "google_drive", results[0].value, digest);
  } else {
    setCopyError(copies, "primary", "google_drive", results[0].reason);
  }

  if (results[1].status === "fulfilled") {
    setCopyResult(copies, "backup", "onedrive", results[1].value, digest);
  } else {
    setCopyError(copies, "backup", "onedrive", results[1].reason);
  }

  object.copies = copies;
  object.replicationStatus = replicationStatus(copies);
  object.lastReplicationAt = new Date();
  object.lastError = copies
    .filter((x) => x.status !== "synced" && x.lastError)
    .map((x) => `${x.slot}: ${x.lastError}`)
    .join(" | ")
    .slice(0, 1800);

  if (object.replicationStatus === "healthy") {
    removeEncryptedFallback(object.fallbackStorageKey);
    object.fallbackStorageKey = "";
    object.fallbackStatus = "removed";
  }
  await object.save();

  return {
    storageObjectId: object._id,
    checksum: digest,
    replicationStatus: object.replicationStatus,
    copies: object.copies,
    provider:
      object.copies.find((x) => x.slot === "primary" && x.status === "synced")?.provider ||
      object.copies.find((x) => x.status === "synced")?.provider ||
      "local_encrypted",
    fileId:
      object.copies.find((x) => x.slot === "primary" && x.status === "synced")?.fileId ||
      object.copies.find((x) => x.status === "synced")?.fileId ||
      "",
    storageKey: object.fallbackStorageKey || "",
    fileName,
    mimeType,
    size: buffer.length,
  };
};

const bufferFromStorageObject = async (object) => {
  if (object.fallbackStatus === "available" && object.fallbackStorageKey) {
    return loadEncryptedFallback(object.fallbackStorageKey);
  }

  const primary = object.copies.find((x) => x.slot === "primary" && x.status === "synced" && x.fileId);
  if (primary) {
    return getGoogleDriveFileBuffer({ database: object.database, fileId: primary.fileId });
  }

  const backup = object.copies.find((x) => x.slot === "backup" && x.status === "synced" && x.fileId);
  if (backup) {
    return getOneDriveFileBuffer({ database: object.database, fileId: backup.fileId });
  }

  throw new Error("No readable copy of the file is available");
};

export const retryStorageObject = async (idOrObject) => {
  const object = typeof idOrObject === "string" || idOrObject?._bsontype
    ? await StorageObject.findById(idOrObject)
    : idOrObject;
  if (!object || object.deletedAt) return null;

  const buffer = await bufferFromStorageObject(object);
  const digest = checksum(buffer);
  if (digest !== object.checksum) {
    object.replicationStatus = "failed";
    object.lastError = "SHA-256 integrity check failed before replication";
    await object.save();
    throw new Error(object.lastError);
  }

  const folderParts = buildFolderParts(object);
  const copies = object.copies.map((x) => ({ ...x.toObject() }));

  for (const target of [
    { slot: "primary", provider: "google_drive" },
    { slot: "backup", provider: "onedrive" },
  ]) {
    const current = copies.find((x) => x.slot === target.slot);
    if (current?.status === "synced" && current.fileId) continue;
    try {
      const result = await uploadToSlot({
        slot: target.slot,
        database: object.database,
        buffer,
        fileName: object.fileName,
        mimeType: object.mimeType,
        folderParts,
      });
      setCopyResult(copies, target.slot, target.provider, result, digest);
    } catch (error) {
      setCopyError(copies, target.slot, target.provider, error);
    }
  }

  object.copies = copies;
  object.replicationStatus = replicationStatus(copies);
  object.lastReplicationAt = new Date();
  object.lastError = copies
    .filter((x) => x.status !== "synced" && x.lastError)
    .map((x) => `${x.slot}: ${x.lastError}`)
    .join(" | ")
    .slice(0, 1800);

  if (object.replicationStatus === "healthy" && object.fallbackStorageKey) {
    removeEncryptedFallback(object.fallbackStorageKey);
    object.fallbackStorageKey = "";
    object.fallbackStatus = "removed";
  }
  await object.save();
  return object;
};

export const getPrivateFileStream = async (assetOrObject) => {
  let object = null;
  if (assetOrObject?.storageObjectId) {
    object = await StorageObject.findById(assetOrObject.storageObjectId).lean();
  } else if (assetOrObject?._id && assetOrObject?.copies) {
    object = assetOrObject;
  }

  // Backward compatibility for old single-provider records.
  if (!object) {
    if (assetOrObject?.provider === "google_drive" && assetOrObject?.fileId) {
      return getGoogleDriveFileStream({
        database: assetOrObject.database,
        fileId: assetOrObject.fileId,
      });
    }
    if (assetOrObject?.provider === "onedrive" && assetOrObject?.fileId) {
      return getOneDriveFileStream({
        database: assetOrObject.database,
        fileId: assetOrObject.fileId,
      });
    }
    if (assetOrObject?.storageKey) {
      const buffer = loadEncryptedFallback(assetOrObject.storageKey);
      return {
        stream: Readable.from(buffer),
        meta: { name: assetOrObject.fileName, mimeType: assetOrObject.mimeType, size: buffer.length },
      };
    }
    throw new Error("Storage object not found");
  }

  const primary = object.copies?.find(
    (x) => x.slot === "primary" && x.status === "synced" && x.fileId,
  );
  if (primary) {
    try {
      return await getGoogleDriveFileStream({ database: object.database, fileId: primary.fileId });
    } catch (_) {
      // fail over to backup below
    }
  }

  const backup = object.copies?.find(
    (x) => x.slot === "backup" && x.status === "synced" && x.fileId,
  );
  if (backup) {
    try {
      return await getOneDriveFileStream({ database: object.database, fileId: backup.fileId });
    } catch (_) {
      // fail over to local fallback below
    }
  }

  if (object.fallbackStatus === "available" && object.fallbackStorageKey) {
    const buffer = loadEncryptedFallback(object.fallbackStorageKey);
    return {
      stream: ReadableFromBuffer(buffer),
      meta: { name: object.fileName, mimeType: object.mimeType, size: buffer.length },
    };
  }
  throw new Error("No healthy storage copy is currently available");
};

const ReadableFromBuffer = (buffer) => Readable.from(buffer);
