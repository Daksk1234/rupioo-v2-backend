import mongoose from "mongoose";

const DocumentAssetSchema = new mongoose.Schema(
  {
    database: { type: String, required: true, index: true },
    entityType: {
      type: String,
      enum: [
        "product",
        "customer",
        "user",
        "transporter",
        "purchase_invoice",
        "sales_invoice",
        "other",
      ],
      required: true,
      index: true,
    },
    entityId: { type: String, required: true, index: true },
    documentType: { type: String, required: true },
    version: { type: Number, default: 1 },
    current: { type: Boolean, default: true },

    storageObjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "storage_object",
      index: true,
    },

    // Legacy compatibility fields. New files use storageObjectId.
    provider: { type: String, default: "" },
    fileId: { type: String, default: "" },
    storageKey: { type: String, default: "" },

    fileName: { type: String, required: true },
    mimeType: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
    checksum: { type: String, default: "" },
    uploadedBy: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "deletion_requested", "deleted"],
      default: "active",
      index: true,
    },
    deletionRequestedAt: { type: Date },
    deleteAfter: { type: Date },
  },
  { timestamps: true },
);

DocumentAssetSchema.index({
  database: 1,
  entityType: 1,
  entityId: 1,
  documentType: 1,
  current: 1,
});

export const DocumentAsset = mongoose.model("document_asset", DocumentAssetSchema);
