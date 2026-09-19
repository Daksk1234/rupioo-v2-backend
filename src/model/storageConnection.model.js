import mongoose from "mongoose";

const StorageConnectionSchema = new mongoose.Schema(
  {
    database: { type: String, required: true, index: true },
    superadminId: { type: String, default: "" },
    slot: {
      type: String,
      enum: ["primary", "backup"],
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ["google_drive", "onedrive"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["connected", "disconnected", "error"],
      default: "disconnected",
      index: true,
    },

    // Never store Google/Microsoft passwords. Only encrypted OAuth material.
    encryptedCredential: { type: String, default: "" },
    credentialType: {
      type: String,
      enum: ["google_refresh_token", "microsoft_msal_cache", ""],
      default: "",
    },
    accountHomeId: { type: String, default: "" },
    accountEmail: { type: String, default: "" },
    rootFolderId: { type: String, default: "" },

    consentAccepted: { type: Boolean, default: false },
    consentAcceptedAt: { type: Date },
    consentVersion: { type: String, default: "2.0" },

    lastHealthAt: { type: Date },
    lastSuccessAt: { type: Date },
    lastErrorAt: { type: Date },
    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

StorageConnectionSchema.index(
  { database: 1, slot: 1 },
  { unique: true, name: "database_1_slot_1" },
);
StorageConnectionSchema.index(
  { database: 1, provider: 1 },
  { unique: true, name: "database_1_provider_1" },
);

export const StorageConnection = mongoose.model(
  "storage_connection",
  StorageConnectionSchema,
);
