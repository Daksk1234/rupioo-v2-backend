import mongoose from "mongoose";

const ProductImageSchema = new mongoose.Schema(
  {
    imageId: { type: String, required: true },
    isPrimary: { type: Boolean, default: false },
    storageObjectId: { type: mongoose.Schema.Types.ObjectId, ref: "storage_object" },
    replicationStatus: { type: String, enum: ["healthy", "degraded", "pending", "failed"], default: "pending" },
    originalProvider: { type: String, default: "" },
    originalFileId: { type: String, default: "" },
    originalStorageKey: { type: String, default: "" },
    originalName: { type: String, default: "" },
    originalMimeType: { type: String, default: "" },
    originalSize: { type: Number, default: 0 },
    thumbnailUrl: { type: String, default: "" },
    appUrl: { type: String, default: "" },
    detailUrl: { type: String, default: "" },
    legacyFilename: { type: String, default: "" },
    status: { type: String, enum: ["ready", "deleted"], default: "ready" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ProductSchema = new mongoose.Schema(
  {
    id: { type: String },
    sId: { type: String },
    created_by: { type: String },
    database: { type: String },
    partyId: [
      {
        partyId: { type: String },
        purchaseDate: { type: Date },
      },
    ],
    primaryUnit: { type: String },
    secondaryUnit: { type: String },
    secondarySize: { type: Number },
    unitType: { type: String },
    category: { type: String },
    SubCategory: { type: String },
    productSection: { type: String },
    warehouse: { type: String },
    pendingQty: { type: Number, default: 0 },
    Unit: { type: String },
    Product_Title: { type: String },
    Size: { type: String },
    qty: { type: Number, default: 0 },
    discount: { type: Number },
    HSN_Code: { type: String },
    GSTRate: { type: Number },
    Product_Desc: { type: String },

    // Legacy field retained so all old DMS pages keep working.
    Product_image: { type: [] },

    // New V2 catalog image metadata.
    productImages: { type: [ProductImageSchema], default: [] },
    primaryImageUrl: { type: String, default: "" },
    imageReady: { type: Boolean, default: false },
    customerAppPublished: { type: Boolean, default: false },
    salesAppPublished: { type: Boolean, default: false },

    Product_MRP: { type: Number },
    MIN_stockalert: { type: Number },
    addProductType: { type: String },
    status: { type: String, default: "Active" },
    salesDate: { type: Date },
    purchaseDate: { type: Date },
    purchaseStatus: { type: Boolean, default: false },
    Opening_Stock: { type: Number },
    openingRate: { type: Number },
    Purchase_Rate: { type: Number },
    basicPrice: { type: Number },
    landedCost: { type: Number },
    SalesRate: { type: Number },
    ProfitPercentage: { type: Number },
    profitColorCode: { type: String, default: null },

    // Existing V2 FY fields are kept flexible because older deployments may
    // already contain them even if they were not in the original schema.
    financialYear: { type: String },
    openingFinancialYear: { type: String },
    financialYearOpeningStock: { type: Number },
    financialYearOpeningRate: { type: Number },
    openingStockByFY: { type: mongoose.Schema.Types.Mixed },
    openingStocks: { type: mongoose.Schema.Types.Mixed },
    financialYearOpenings: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true, strict: false },
);

ProductSchema.index({ database: 1, status: 1, customerAppPublished: 1 });
ProductSchema.index({ database: 1, status: 1, salesAppPublished: 1 });

export const Product = mongoose.model("product", ProductSchema);
