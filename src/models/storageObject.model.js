import mongoose from "mongoose";

const CopySchema = new mongoose.Schema(
  {
    slot: { type: String, enum: ["primary", "backup"], required: true },
    provider: {
      type: String,
      enum: ["google_drive", "onedrive"],
      required: true,
    },
    status: {
      type: String,
      enum: ["synced", "pending", "error", "missing"],
      default: "pending",
      index: true,
    },
    fileId: { type: String, default: "" },
    fileName: { type: String, default: "" },
    size: { type: Number, default: 0 },
    checksum: { type: String, default: "" },
    syncedAt: { type: Date },
    lastAttemptAt: { type: Date },
    retryCount: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
  },
  { _id: false },
);

const StorageObjectSchema = new mongoose.Schema(
  {
    database: { type: String, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    documentType: { type: String, default: "Files" },

    fileName: { type: String, required: true },
    mimeType: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
    checksum: { type: String, required: true, index: true },

    copies: { type: [CopySchema], default: [] },

    fallbackStorageKey: { type: String, default: "" },
    fallbackEncrypted: { type: Boolean, default: true },
    fallbackStatus: {
      type: String,
      enum: ["available", "removed", "missing"],
      default: "available",
    },

    replicationStatus: {
      type: String,
      enum: ["healthy", "degraded", "pending", "failed"],
      default: "pending",
      index: true,
    },
    lastReplicationAt: { type: Date },
    lastError: { type: String, default: "" },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

StorageObjectSchema.index({ database: 1, replicationStatus: 1, updatedAt: 1 });

export const StorageObject = mongoose.model("storage_object", StorageObjectSchema);
