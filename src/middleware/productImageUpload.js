import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { Product } from "../models/product.model.js";
import { putPrivateFile } from "../services/storage/storage.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const publicRoot = path.join(backendRoot, "public");
const compatibilityDir = path.join(publicRoot, "Images");

const clean = (value, fallback = "unknown") =>
  String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;

const bool = (v) =>
  v === true || String(v).toLowerCase() === "true" || v === "1";

const imageVariant = async (buffer, width, quality) =>
  sharp(buffer)
    .rotate()
    .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer();

const saveBuffer = (abs, buffer) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
};

const activeImages = (items = []) =>
  (Array.isArray(items) ? items : []).filter(
    (x) => x && x.status !== "deleted",
  );

export const processProductImages = async (req, res, next) => {
  try {
    const incoming = Array.isArray(req.files) ? req.files : [];
    if (!incoming.length) {
      req.files = undefined;
      return next();
    }

    const database = String(req.body.database || "").trim();
    if (!database) {
      return res.status(400).json({ status: false, message: "database is required" });
    }

    const productKey = clean(
      req.params.id || req.body.id || req.body.Product_Title || "new-product",
    );
    let existing = [];
    let existingLegacy = [];
    let existingCustomerPublished = false;
    let existingSalesPublished = false;

    if (req.params.id) {
      const product = await Product.findById(req.params.id).lean();
      existing = activeImages(product?.productImages || []);
      existingLegacy = Array.isArray(product?.Product_image)
        ? product.Product_image.filter(Boolean)
        : [];
      existingCustomerPublished = Boolean(product?.customerAppPublished);
      existingSalesPublished = Boolean(product?.salesAppPublished);
    }

    if (existing.length + incoming.length > 5) {
      return res.status(400).json({
        status: false,
        message: "Maximum 5 active product images are allowed",
      });
    }

    const generated = [];
    const generatedLegacy = [];

    for (let index = 0; index < incoming.length; index += 1) {
      const file = incoming[index];
      if (!file?.buffer) continue;

      const imageId = crypto.randomUUID();
      const base = `${Date.now()}-${imageId.slice(0, 8)}`;
      const webpName = `${base}.webp`;

      // Original is written once by the UI but replicated automatically to:
      // Primary Google Drive + Backup Microsoft OneDrive.
      const original = await putPrivateFile({
        database,
        entityType: "product",
        entityId: productKey,
        documentType: "Original Images",
        buffer: file.buffer,
        fileName: file.originalname || `${base}.image`,
        mimeType: file.mimetype || "application/octet-stream",
      });

      const [thumb, app, detail] = await Promise.all([
        imageVariant(file.buffer, 160, 76),
        imageVariant(file.buffer, 480, 80),
        imageVariant(file.buffer, 1000, 84),
      ]);

      const db = clean(database);
      const relativeBase = path.join("catalog", db, "products", productKey);
      const thumbRel = path
        .join(relativeBase, "thumb", webpName)
        .replace(/\\/g, "/");
      const appRel = path
        .join(relativeBase, "app", webpName)
        .replace(/\\/g, "/");
      const detailRel = path
        .join(relativeBase, "detail", webpName)
        .replace(/\\/g, "/");

      saveBuffer(path.join(publicRoot, thumbRel), thumb);
      saveBuffer(path.join(publicRoot, appRel), app);
      saveBuffer(path.join(publicRoot, detailRel), detail);

      // Existing DMS pages still read Product_image from /Images.
      fs.mkdirSync(compatibilityDir, { recursive: true });
      saveBuffer(path.join(compatibilityDir, webpName), detail);
      generatedLegacy.push(webpName);

      generated.push({
        imageId,
        isPrimary: existing.length === 0 && index === 0,
        storageObjectId: original.storageObjectId,
        replicationStatus: original.replicationStatus,
        originalProvider: original.provider,
        originalFileId: original.fileId || "",
        originalStorageKey: original.storageKey || "",
        originalName: file.originalname || "",
        originalMimeType: file.mimetype || "",
        originalSize: Number(file.size || file.buffer.length || 0),
        thumbnailUrl: `/${thumbRel}`,
        appUrl: `/${appRel}`,
        detailUrl: `/${detailRel}`,
        legacyFilename: webpName,
        status: "ready",
      });
    }

    const merged = [...existing, ...generated];
    if (merged.length && !merged.some((x) => x.isPrimary)) {
      merged[0].isPrimary = true;
    }
    const primary = merged.find((x) => x.isPrimary) || merged[0];

    req.body.productImages = merged;
    req.body.primaryImageUrl = primary?.appUrl || primary?.detailUrl || "";
    req.body.imageReady = merged.length > 0;

    if (req.body.customerAppPublished === undefined) {
      req.body.customerAppPublished = req.params.id
        ? existingCustomerPublished
        : merged.length > 0;
    }
    if (req.body.salesAppPublished === undefined) {
      req.body.salesAppPublished = req.params.id
        ? existingSalesPublished
        : merged.length > 0;
    }

    if (
      (bool(req.body.customerAppPublished) || bool(req.body.salesAppPublished)) &&
      !merged.length
    ) {
      return res.status(400).json({
        status: false,
        message:
          "At least one product image is required before publishing to Customer/Sales App",
      });
    }

    req.files = [...existingLegacy, ...generatedLegacy].map((filename) => ({
      filename,
    }));
    return next();
  } catch (error) {
    console.error("[product image processing]", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "Unable to process product images",
    });
  }
};
