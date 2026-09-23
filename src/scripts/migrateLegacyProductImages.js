import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import mongoose from "mongoose";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { Product } from "../models/product.model.js";
import { putPrivateFile } from "../services/storage/storage.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const publicRoot = path.join(backendRoot, "public");
const legacyRoot = path.join(publicRoot, "Images");

const clean = (value, fallback = "unknown") =>
  String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;

const variant = (buffer, width, quality) =>
  sharp(buffer)
    .rotate()
    .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer();

const save = (filePath, buffer) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
};

const main = async () => {
  const database = String(process.argv[2] || "").trim();
  if (!database) {
    throw new Error(
      "Usage: node scripts/migrateLegacyProductImages.js <SUPERADMIN_DATABASE>",
    );
  }

  const mongoUri = process.env.DATABASE_URL;
  if (!mongoUri) throw new Error("DATABASE_URL is missing from backend .env");

  await mongoose.connect(mongoUri);
  console.log(`[migration] Connected. Database key: ${database}`);

  const products = await Product.find({ database, status: "Active" });
  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const product of products) {
    if (Array.isArray(product.productImages) && product.productImages.length) {
      skipped += 1;
      continue;
    }

    const legacyNames = Array.isArray(product.Product_image)
      ? product.Product_image.filter(Boolean).slice(0, 5)
      : [];
    if (!legacyNames.length) {
      skipped += 1;
      continue;
    }

    const productKey = clean(product._id || product.id || product.Product_Title);
    const nextImages = [];

    for (let index = 0; index < legacyNames.length; index += 1) {
      const legacyName = String(legacyNames[index]);
      const source = path.join(legacyRoot, path.basename(legacyName));
      if (!fs.existsSync(source)) {
        console.warn(`[migration] Missing legacy image: ${source}`);
        missing += 1;
        continue;
      }

      try {
        const buffer = fs.readFileSync(source);
        const imageId = crypto.randomUUID();
        const base = `migrated-${Date.now()}-${imageId.slice(0, 8)}`;
        const webpName = `${base}.webp`;

        const original = await putPrivateFile({
          database,
          entityType: "Products",
          entityId: productKey,
          documentType: "Original Images",
          buffer,
          fileName: path.basename(legacyName),
          mimeType: "application/octet-stream",
        });

        const [thumb, app, detail] = await Promise.all([
          variant(buffer, 160, 76),
          variant(buffer, 480, 80),
          variant(buffer, 1000, 84),
        ]);

        const relativeBase = path.join(
          "catalog",
          clean(database),
          "products",
          productKey,
        );
        const thumbRel = path
          .join(relativeBase, "thumb", webpName)
          .replace(/\\/g, "/");
        const appRel = path
          .join(relativeBase, "app", webpName)
          .replace(/\\/g, "/");
        const detailRel = path
          .join(relativeBase, "detail", webpName)
          .replace(/\\/g, "/");

        save(path.join(publicRoot, thumbRel), thumb);
        save(path.join(publicRoot, appRel), app);
        save(path.join(publicRoot, detailRel), detail);

        nextImages.push({
          imageId,
          isPrimary: nextImages.length === 0,
          originalProvider: original.provider,
          originalFileId: original.fileId || "",
          originalStorageKey: original.storageKey || "",
          originalName: path.basename(legacyName),
          originalMimeType: "",
          originalSize: buffer.length,
          thumbnailUrl: `/${thumbRel}`,
          appUrl: `/${appRel}`,
          detailUrl: `/${detailRel}`,
          legacyFilename: legacyName,
          status: "ready",
        });
      } catch (error) {
        console.error(
          `[migration] ${product.Product_Title || product._id}: ${error.message}`,
        );
      }
    }

    if (!nextImages.length) continue;

    product.productImages = nextImages;
    product.primaryImageUrl = nextImages[0].appUrl;
    product.imageReady = true;
    product.customerAppPublished = true;
    product.salesAppPublished = true;
    await product.save();
    updated += 1;
  }

  console.log(
    `[migration] Completed. updated=${updated}, skipped=${skipped}, missingFiles=${missing}`,
  );
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error("[migration] FAILED:", error.message);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
