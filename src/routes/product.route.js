import express from "express";
import multer from "multer";
import {
  DeleteProduct,
  UpdateProductProfitColors,
  HSNWisePurchaseReport,
  HSNWiseSalesReport,
  SaveProduct,
  StockAlert,
  UpdateProduct,
  UpdateProductSalesRate,
  UpdateProductSalesRateMultiple,
  ViewProduct,
  ViewProductById,
  ViewProductForPurchase,
  saveItemWithExcel,
  updateItemWithExcel,
  viewCurrentStock,
} from "../controller/product.controller.js";
import {
  updateProductPublishing,
  setPrimaryProductImage,
  deleteProductImage,
  getPublishedCatalog,
  backfillLegacyProductImages,
} from "../controller/productMedia.controller.js";
import {
  getGoogleDriveConnectUrl,
  googleDriveCallback,
  getOneDriveConnectUrl,
  oneDriveCallback,
  storageStatus,
  storageHealth,
  testStorageConnection,
  disconnectStorage,
} from "../controller/storageConnection.controller.js";
import {
  uploadDocumentAsset,
  listDocumentAssets,
  downloadDocumentAsset,
  requestDocumentDeletion,
  restoreDocumentAsset,
} from "../controller/documentAsset.controller.js";
import { processProductImages } from "../middleware/productImageUpload.js";
import {
  requireRupioAuth,
  requireDatabaseAccess,
  requireUserAccount,
} from "../middleware/rupioAuth.js";
import { startStorageSyncWorker } from "../services/storage/storageSync.worker.js";

const router = express.Router();
startStorageSyncWorker();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
    ]);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, WEBP and AVIF product images are allowed"));
    }
    return cb(null, true);
  },
});

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const excelUpload = multer({ dest: "public/ExcelFile/" });

router.post("/import-item-data/:database", excelUpload.single("file"), saveItemWithExcel);
router.post("/update-import-product/:database", excelUpload.single("file"), updateItemWithExcel);

// Existing Product Create/Edit URLs stay unchanged.
router.post(
  "/save-product",
  imageUpload.array("files", 5),
  processProductImages,
  SaveProduct,
);
router.put(
  "/update-product/:id",
  imageUpload.array("files", 5),
  processProductImages,
  UpdateProduct,
);
router.get("/view-product/:id/:database", ViewProduct);
router.get("/view-product-purchase/:database", ViewProductForPurchase);
router.get("/view-product-by-id/:id", ViewProductById);
router.delete("/delete-product/:id", DeleteProduct);
router.get("/view-stock-alert/:database", StockAlert);
router.get("/view-current-stock/:id/:productId", viewCurrentStock);
router.post("/hsn-sales-summary/:database", HSNWiseSalesReport);
router.post("/hsn-purchase-summary/:database", HSNWisePurchaseReport);
router.put("/product-price-update/:id", UpdateProductSalesRate);
router.put("/product-price-updated", UpdateProductSalesRateMultiple);
router.post("/update-profit-colors/:database", UpdateProductProfitColors);

router.get("/catalog/:database", getPublishedCatalog);
router.put(
  "/catalog/publish/:id",
  requireRupioAuth,
  requireUserAccount,
  updateProductPublishing,
);
router.put(
  "/catalog/primary/:id/:imageId",
  requireRupioAuth,
  requireUserAccount,
  setPrimaryProductImage,
);
router.delete(
  "/catalog/image/:id/:imageId",
  requireRupioAuth,
  requireUserAccount,
  deleteProductImage,
);
router.post(
  "/catalog/backfill/:database",
  requireRupioAuth,
  requireUserAccount,
  requireDatabaseAccess,
  backfillLegacyProductImages,
);

// PRIMARY: Google Drive
router.get(
  "/storage/google/connect",
  requireRupioAuth,
  requireUserAccount,
  requireDatabaseAccess,
  getGoogleDriveConnectUrl,
);
router.get("/storage/google/callback", googleDriveCallback);

// BACKUP: Microsoft OneDrive
router.get(
  "/storage/onedrive/connect",
  requireRupioAuth,
  requireUserAccount,
  requireDatabaseAccess,
  getOneDriveConnectUrl,
);
router.get("/storage/onedrive/callback", oneDriveCallback);

router.get(
  "/storage/status/:database",
  requireRupioAuth,
  requireUserAccount,
  requireDatabaseAccess,
  storageStatus,
);
router.get(
  "/storage/health/:database",
  requireRupioAuth,
  requireUserAccount,
  requireDatabaseAccess,
  storageHealth,
);
router.post(
  "/storage/test/:database/:slot",
  requireRupioAuth,
  requireUserAccount,
  requireDatabaseAccess,
  testStorageConnection,
);
router.post(
  "/storage/disconnect/:database/:slot",
  requireRupioAuth,
  requireUserAccount,
  requireDatabaseAccess,
  disconnectStorage,
);

// Private documents for Product / Customer / User / Transporter / invoices.
router.post(
  "/storage/document",
  requireRupioAuth,
  requireUserAccount,
  requireDatabaseAccess,
  documentUpload.single("file"),
  uploadDocumentAsset,
);
router.get(
  "/storage/documents/:database/:entityType/:entityId",
  requireRupioAuth,
  requireUserAccount,
  requireDatabaseAccess,
  listDocumentAssets,
);
router.get(
  "/storage/document/:id/view",
  requireRupioAuth,
  requireUserAccount,
  downloadDocumentAsset,
);
router.delete(
  "/storage/document/:id",
  requireRupioAuth,
  requireUserAccount,
  requestDocumentDeletion,
);
router.post(
  "/storage/document/:id/restore",
  requireRupioAuth,
  requireUserAccount,
  restoreDocumentAsset,
);

export default router;
