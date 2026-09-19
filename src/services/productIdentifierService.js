import crypto from "crypto";
import { Barcode, Product } from "../models/index.js";

const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();

const skuSegment = (value, maxLength = 40) =>
  upper(value)
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, maxLength)
    .replace(/-+$/g, "");

export function buildSkuBase({ category, subCategory, name } = {}) {
  const parts = [
    skuSegment(category, 24),
    skuSegment(subCategory, 24),
    skuSegment(name, 56),
  ].filter(Boolean);
  return parts.join("-").slice(0, 110).replace(/-+$/g, "") || "PRODUCT";
}

export async function makeUniqueSku({
  tenantKey,
  category,
  subCategory,
  name,
  excludeProductId,
  preferredSku,
} = {}) {
  const requested = skuSegment(preferredSku, 110);
  const base = requested || buildSkuBase({ category, subCategory, name });
  let candidate = base;
  let suffix = 2;

  while (true) {
    const filter = { tenantKey, sku: candidate };
    if (excludeProductId) filter._id = { $ne: excludeProductId };
    const exists = await Product.exists(filter);
    if (!exists) return candidate;
    candidate = `${base}-${suffix++}`.slice(0, 120);
  }
}

function ean13CheckDigit(base12) {
  const digits = String(base12).replace(/\D/g, "").padStart(12, "0").slice(-12);
  let total = 0;
  for (let i = 0; i < 12; i += 1) {
    const n = Number(digits[i]);
    total += i % 2 === 0 ? n : n * 3;
  }
  return String((10 - (total % 10)) % 10);
}

function internalBarcodeCandidate(seed, salt = 0) {
  const hash = crypto
    .createHash("sha256")
    .update(`${seed}|${salt}`)
    .digest("hex");
  const value = BigInt(`0x${hash.slice(0, 20)}`) % 10000000000n;
  const base12 = `20${value.toString().padStart(10, "0")}`;
  return `${base12}${ean13CheckDigit(base12)}`;
}

async function barcodeInUse(value, { excludeProductId } = {}) {
  const code = clean(value);
  if (!code) return false;
  const productFilter = { barcode: code };
  if (excludeProductId) productFilter._id = { $ne: excludeProductId };
  const [productExists, registryExists] = await Promise.all([
    Product.exists(productFilter),
    Barcode.exists({ $or: [{ barcodeId: code }, { gtin: code }] }),
  ]);
  return Boolean(productExists || registryExists);
}

export async function generateInternalEan13({
  tenantKey,
  category,
  subCategory,
  name,
  sku,
  hsnCode,
  excludeProductId,
} = {}) {
  const seed = [tenantKey, category, subCategory, name, sku, hsnCode]
    .map(clean)
    .join("|");
  for (let salt = 0; salt < 5000; salt += 1) {
    const candidate = internalBarcodeCandidate(seed, salt);
    if (!(await barcodeInUse(candidate, { excludeProductId }))) return candidate;
  }
  throw new Error("Unable to generate a unique internal EAN-13 barcode");
}

export async function suggestProductIdentifiers({
  tenantKey,
  category,
  subCategory,
  name,
  hsnCode,
  excludeProductId,
} = {}) {
  const sku = await makeUniqueSku({
    tenantKey,
    category,
    subCategory,
    name,
    excludeProductId,
  });

  const available = await Barcode.findOne({ status: "AVAILABLE" })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  if (available) {
    const code = clean(available.gtin || available.barcodeId);
    if (code) {
      const productFilter = { barcode: code };
      if (excludeProductId) productFilter._id = { $ne: excludeProductId };
      if (!(await Product.exists(productFilter))) {
        return {
          sku,
          barcode: code,
          barcodeSource: available.gtin ? "MASTER_GTIN" : "MASTER_BARCODE",
          registryId: String(available._id),
        };
      }
    }
  }

  return {
    sku,
    barcode: await generateInternalEan13({
      tenantKey,
      category,
      subCategory,
      name,
      sku,
      hsnCode,
      excludeProductId,
    }),
    barcodeSource: "INTERNAL_EAN13",
    registryId: "",
  };
}

const registryMatchesCode = (code) => ({
  $or: [{ barcodeId: code }, { gtin: code }],
});

async function ensureProductBarcodeUnique({ tenantKey, barcode, excludeProductId }) {
  const code = clean(barcode);
  if (!code) return;
  const filter = { tenantKey, barcode: code };
  if (excludeProductId) filter._id = { $ne: excludeProductId };
  if (await Product.exists(filter)) {
    throw new Error(`Barcode / GTIN ${code} is already used by another product`);
  }
}

export async function allocateBarcode({
  tenantKey,
  sku,
  productName,
  oldSku,
  requestedBarcode,
  category,
  subCategory,
  hsnCode,
  excludeProductId,
  userId,
} = {}) {
  let barcode = clean(requestedBarcode);
  let source = "MANUAL";

  if (!barcode) {
    const suggestion = await suggestProductIdentifiers({
      tenantKey,
      category,
      subCategory,
      name: productName,
      hsnCode,
      excludeProductId,
    });
    barcode = suggestion.barcode;
    source = suggestion.barcodeSource;
  }

  await ensureProductBarcodeUnique({ tenantKey, barcode, excludeProductId });

  const registry = await Barcode.findOne(registryMatchesCode(barcode));
  if (registry) {
    const currentOwner = clean(registry.owner);
    const currentSku = upper(registry.sku);
    const status = upper(registry.status);
    const sameOwner = !currentOwner || currentOwner === clean(tenantKey);
    const sameSku = !currentSku || currentSku === upper(sku) || currentSku === upper(oldSku);

    if (!["AVAILABLE", "RESERVED", "ALLOCATED", "ACTIVE"].includes(status)) {
      throw new Error(`Barcode / GTIN ${barcode} is ${registry.status} in MASTER Barcode Center`);
    }
    if (!["AVAILABLE", "RESERVED"].includes(status) && (!sameOwner || !sameSku)) {
      throw new Error(`Barcode / GTIN ${barcode} is already allocated in MASTER Barcode Center`);
    }

    registry.status = "ALLOCATED";
    registry.owner = clean(tenantKey);
    registry.sku = upper(sku);
    registry.productName = clean(productName);
    registry.allocationHistory = Array.isArray(registry.allocationHistory)
      ? registry.allocationHistory
      : [];
    registry.allocationHistory.push({
      action: "ALLOCATED_TO_PRODUCT",
      at: new Date(),
      by: clean(userId),
      note: `Allocated to ${upper(sku)} - ${clean(productName)}`,
    });
    await registry.save();
    source = registry.gtin
      ? "MASTER_GTIN"
      : upper(registry.type) === "INTERNAL"
        ? "INTERNAL_EAN13"
        : source === "MANUAL"
          ? "MASTER_BARCODE"
          : source;
  } else {
    await Barcode.create({
      barcodeId: barcode,
      type: source === "INTERNAL_EAN13" ? "INTERNAL" : "MANUAL",
      owner: clean(tenantKey),
      sku: upper(sku),
      productName: clean(productName),
      status: "ALLOCATED",
      allocationHistory: [
        {
          action: source === "INTERNAL_EAN13" ? "AUTO_GENERATED" : "MANUAL_ALLOCATION",
          at: new Date(),
          by: clean(userId),
          note: `Linked to ${upper(sku)} - ${clean(productName)}`,
        },
      ],
    });
  }

  return { barcode, barcodeSource: source };
}

export async function syncBarcodeMetadata({
  tenantKey,
  oldBarcode,
  newBarcode,
  sku,
  productName,
  oldSku,
  category,
  subCategory,
  hsnCode,
  productId,
  userId,
} = {}) {
  const oldCode = clean(oldBarcode);
  const requested = clean(newBarcode);

  const allocation = await allocateBarcode({
    tenantKey,
    sku,
    productName,
    oldSku,
    requestedBarcode: requested || oldCode,
    category,
    subCategory,
    hsnCode,
    excludeProductId: productId,
    userId,
  });

  if (oldCode && allocation.barcode && oldCode !== allocation.barcode) {
    const oldRegistry = await Barcode.findOne(registryMatchesCode(oldCode));
    if (
      oldRegistry &&
      clean(oldRegistry.owner) === clean(tenantKey) &&
      (upper(oldRegistry.sku) === upper(oldSku) || upper(oldRegistry.sku) === upper(sku))
    ) {
      oldRegistry.status = "DISCONTINUED";
      oldRegistry.allocationHistory = Array.isArray(oldRegistry.allocationHistory)
        ? oldRegistry.allocationHistory
        : [];
      oldRegistry.allocationHistory.push({
        action: "REPLACED_ON_PRODUCT",
        at: new Date(),
        by: clean(userId),
        note: `Replaced by ${allocation.barcode}`,
      });
      await oldRegistry.save();
    }
  }

  return allocation;
}
