import express from "express";
import multer from "multer";
import { Product, Unit, CompanyUnit, GenericRecord } from "../models/index.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { profitMetrics } from "../services/pricingService.js";
import { referencedProductIds } from "../services/referenceIntegrityService.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import {
  readRows,
  resolveColumns,
  valueFor,
  cleanText,
} from "../utils/bulkSpreadsheet.js";
import { findHsnByCode } from "../services/hsnLookupService.js";
import {
  allocateBarcode,
  makeUniqueSku,
  suggestProductIdentifiers,
  syncBarcodeMetadata,
} from "../services/productIdentifierService.js";

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.auth?.role === "MASTER" || (req.auth?.apps || []).includes("dms")) {
    return next();
  }
  return fail(res, "DMS access required", 403);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

const upper = (value) => cleanText(value).toUpperCase();
const userIdFromAuth = (auth = {}) =>
  String(auth?.sub || auth?.userId || auth?.id || auth?.email || "").trim();
const hasValue = (value) =>
  value !== undefined && value !== null && String(value).trim() !== "";

const productUploadFields = [
  { key: "sku", label: "SKU", aliases: ["product code", "item code"] },
  { key: "name", label: "Product Name", aliases: ["product", "item", "name"] },
  { key: "category", label: "Category" },
  { key: "subCategory", label: "Sub Category", aliases: ["subcategory", "sub-category"] },
  { key: "warehouseId", label: "Warehouse", aliases: ["warehouse id", "warehouse name", "warehouse"] },
  { key: "hsnCode", label: "HSN / SAC", aliases: ["hsn", "hsn code", "sac", "hsn/sac"] },
  { key: "gstRate", label: "GST %", aliases: ["gst rate", "gst"], type: "number" },
  { key: "basicUnit", label: "Basic Unit", aliases: ["primary unit", "unit"] },
  { key: "packingUnit", label: "Packing Unit", aliases: ["secondary unit", "bag unit"] },
  { key: "qtyInBag", label: "Qty In Bag", aliases: ["quantity in bag", "secondary size", "pack qty"], type: "number" },
  { key: "openingStock", label: "Opening Stock", type: "number" },
  { key: "openingRate", label: "Opening Rate", type: "number" },
  { key: "averagePurchasePrice", label: "Average Purchase Price", aliases: ["avg purchase price"], type: "number" },
  { key: "landedCost", label: "Landed Cost", type: "number" },
  { key: "mrp", label: "MRP", type: "number" },
  { key: "salePrice", label: "Sale Price", aliases: ["selling price", "default sale price"], type: "number" },
  { key: "minStockAlert", label: "Min Stock Alert", type: "number" },
  { key: "minimumProfitPct", label: "Minimum Profit %", aliases: ["minimum margin", "min profit", "min margin"], type: "number" },
  { key: "barcode", label: "Barcode / GTIN", aliases: ["barcode", "gtin", "ean"] },
  { key: "status", label: "Status" },
];

const plainOriginalRow = (raw = {}) => Object.fromEntries(
  Object.entries(raw).map(([key, value]) => [key, value == null ? "" : String(value)]),
);

const warehouseLabel = (warehouse = {}) =>
  cleanText(warehouse.title || warehouse.reference || warehouse.name || warehouse.value || "Warehouse");

const loadActiveWarehouses = async (tenantKey) =>
  GenericRecord.find({ tenantKey, app: "dms", resource: "warehouses", status: "ACTIVE" }).lean();

const resolveWarehouseId = (value, warehouses = []) => {
  const raw = cleanText(value);
  if (!raw) return "";
  const needle = raw.toLowerCase();
  const found = warehouses.find((warehouse) =>
    [warehouse._id, warehouse.title, warehouse.reference, warehouse.name, warehouse.value]
      .filter(Boolean)
      .some((candidate) => String(candidate).trim().toLowerCase() === needle),
  );
  return found ? String(found._id) : raw;
};

const numericProductFields = [
  "gstRate",
  "qtyInBag",
  "openingStock",
  "openingRate",
  "lastPurchasePrice",
  "averagePurchasePrice",
  "landedCost",
  "mrp",
  "salePrice",
  "minStockAlert",
  "minimumProfitPct",
];

const normalizeNumericFields = (target) => {
  for (const key of numericProductFields) {
    if (target[key] !== undefined) target[key] = Number(target[key] || 0);
  }
  if (
    target.gstRate !== undefined &&
    (!Number.isFinite(target.gstRate) || target.gstRate < 0 || target.gstRate > 100)
  ) {
    throw new Error("GST Rate must be between 0 and 100");
  }
};

router.get("/suggest-identifiers", async (req, res) => {
  try {
    const name = cleanText(req.query.name);
    if (!name) return fail(res, "Product Name is required for auto identifiers", 400);

    const suggestion = await suggestProductIdentifiers({
      tenantKey: req.auth.tenantKey,
      category: req.query.category,
      subCategory: req.query.subCategory,
      name,
      hsnCode: req.query.hsnCode,
      excludeProductId: req.query.excludeProductId || undefined,
    });
    return ok(res, suggestion, "Product identifiers generated");
  } catch (error) {
    return fail(res, error.message, 400);
  }
});

router.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));
  const q = String(req.query.q || "").trim();
  const filter = { tenantKey: req.auth.tenantKey };

  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  if (q) {
    filter.$or = [
      { name: new RegExp(q, "i") },
      { sku: new RegExp(q, "i") },
      { category: new RegExp(q, "i") },
      { hsnCode: new RegExp(q, "i") },
      { hsnDescription: new RegExp(q, "i") },
      { barcode: new RegExp(q, "i") },
    ];
  }

  const [items, total] = await Promise.all([
    Product.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);

  const packingCodes = Array.from(new Set(items.map((item) => upper(item.packingUnit)).filter(Boolean)));
  const companyUnits = packingCodes.length
    ? await CompanyUnit.find({ tenantKey: req.auth.tenantKey, code: { $in: packingCodes } }).select("code name").lean()
    : [];
  const unitNames = new Map(companyUnits.map((unit) => [upper(unit.code), cleanText(unit.name) || unit.code]));
  const missingCodes = packingCodes.filter((code) => !unitNames.has(code));
  if (missingCodes.length) {
    const masterUnits = await Unit.find({ code: { $in: missingCodes } }).select("code name").lean();
    for (const unit of masterUnits) unitNames.set(upper(unit.code), cleanText(unit.name) || unit.code);
  }

  const admin = isAdminAuth(req.auth);
  return ok(res, {
    items: items.map((product) => {
      const shaped = {
        ...product,
        packingUnitName: product.packingUnit
          ? unitNames.get(upper(product.packingUnit)) || product.packingUnit
          : "",
      };
      if (admin) {
        shaped.pricing = profitMetrics({
          landedCost: product.landedCost,
          effectiveSellingPrice: product.salePrice,
          minimumProfitPct: product.minimumProfitPct,
        });
      } else {
        delete shaped.minimumProfitPct;
        delete shaped.pricingScheme;
      }
      return shaped;
    }),
    meta: pageMeta(page, limit, total),
  });
});

router.post("/", async (req, res) => {
  try {
    const body = { ...req.body, tenantKey: req.auth.tenantKey };
    if (!isAdminAuth(req.auth)) {
      delete body.minimumProfitPct;
      delete body.pricingScheme;
    }
    const gstWasProvided = hasValue(req.body?.gstRate) || req.body?.gstRate === 0;

    delete body.hsnDescription;
    delete body.barcodeSource;

    body.name = cleanText(body.name);
    body.category = cleanText(body.category);
    body.subCategory = cleanText(body.subCategory);
    if (!body.name) return fail(res, "Product Name is required", 400);
    body.warehouseId = cleanText(body.warehouseId);
    if (!body.warehouseId) return fail(res, "Warehouse is required for Product", 400);
    const warehouse = await GenericRecord.findOne({_id:body.warehouseId,tenantKey:req.auth.tenantKey,app:"dms",resource:"warehouses",status:"ACTIVE"}).lean();
    if (!warehouse) return fail(res, "Select a valid active Warehouse", 400);

    body.sku = upper(body.sku);
    if (!body.sku) {
      body.sku = await makeUniqueSku({
        tenantKey: req.auth.tenantKey,
        category: body.category,
        subCategory: body.subCategory,
        name: body.name,
      });
    } else if (await Product.exists({ tenantKey: req.auth.tenantKey, sku: body.sku })) {
      return fail(res, "SKU already exists", 409);
    }

    body.hsnCode = upper(body.hsnCode);
    if (body.hsnCode) {
      const hsn = await findHsnByCode(body.hsnCode);
      if (!hsn) return fail(res, `HSN/SAC ${body.hsnCode} not found in MASTER`, 400);
      body.hsnCode = hsn.code || body.hsnCode;
      body.hsnDescription = String(hsn.description || "");
      if (!gstWasProvided) body.gstRate = Number(hsn.gstRate || 0);
    } else {
      body.hsnDescription = "";
      if (!gstWasProvided) body.gstRate = 0;
    }

    body.basicUnit = upper(body.basicUnit || body.unit || "PCS");
    body.unit = body.basicUnit;
    body.packingUnit = upper(body.packingUnit);
    normalizeNumericFields(body);

    if (body.currentStock === undefined) body.currentStock = Number(body.openingStock || 0);
    if (!body.averagePurchasePrice) {
      body.averagePurchasePrice = Number(body.openingRate || body.lastPurchasePrice || 0);
    }
    if (!body.lastPurchasePrice) body.lastPurchasePrice = Number(body.openingRate || 0);
    if (!body.landedCost) {
      body.landedCost = Number(body.openingRate || body.averagePurchasePrice || 0);
    }

    const barcode = await allocateBarcode({
      tenantKey: req.auth.tenantKey,
      sku: body.sku,
      productName: body.name,
      requestedBarcode: body.barcode,
      category: body.category,
      subCategory: body.subCategory,
      hsnCode: body.hsnCode,
      userId: userIdFromAuth(req.auth),
    });
    body.barcode = barcode.barcode;
    body.barcodeSource = barcode.barcodeSource;

    const product = await Product.create(body);
    const responseProduct = product.toObject();
    if (!isAdminAuth(req.auth)) { delete responseProduct.minimumProfitPct; delete responseProduct.pricingScheme; }
    return ok(res, responseProduct, "Product created", 201);
  } catch (error) {
    if (error?.code === 11000) {
      const duplicateField = Object.keys(error?.keyPattern || error?.keyValue || {})[0] || "";
      return fail(
        res,
        duplicateField.toLowerCase().includes("sku")
          ? "SKU already exists"
          : "Barcode / GTIN already exists",
        409,
      );
    }
    return fail(res, error.message, 400);
  }
});

router.post("/bulk-preview", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) return fail(res, "Excel/CSV file is required", 400);

  let rows;
  try {
    rows = readRows(req.file.buffer);
  } catch {
    return fail(res, "Unable to read Excel/CSV file", 400);
  }
  if (!rows.length) return fail(res, "Uploaded file has no rows", 400);

  const fields = productUploadFields.filter(
    (field) => isAdminAuth(req.auth) || field.key !== "minimumProfitPct",
  );
  const columns = resolveColumns(rows[0], fields);
  const warehouses = await loadActiveWarehouses(req.auth.tenantKey);

  const hsnCodes = [
    ...new Set(rows.map((raw) => upper(valueFor(raw, columns.hsnCode))).filter(Boolean)),
  ];
  const hsnResults = await Promise.all(
    hsnCodes.map(async (code) => [code, await findHsnByCode(code)]),
  );
  const hsnMap = new Map(hsnResults.filter(([, row]) => row));

  const preview = rows.map((raw, index) => {
    const row = {
      _uploadRow: index + 2,
      _original: plainOriginalRow(raw),
    };

    for (const field of fields) {
      const value = valueFor(raw, columns[field.key], field.type);
      if (value !== undefined && value !== "") row[field.key] = value;
    }

    row.sku = upper(row.sku);
    row.name = cleanText(row.name);
    row.category = cleanText(row.category);
    row.subCategory = cleanText(row.subCategory);
    row.warehouseId = resolveWarehouseId(row.warehouseId, warehouses);
    row.hsnCode = upper(row.hsnCode);
    row.basicUnit = upper(row.basicUnit || "PCS");
    row.packingUnit = upper(row.packingUnit);
    row.status = upper(row.status || "ACTIVE");

    try {
      normalizeNumericFields(row);
    } catch {
      // Preview deliberately does not block. Final commit performs validation.
    }

    if (row.qtyInBag === undefined || row.qtyInBag === "") row.qtyInBag = 1;
    if (row.openingStock === undefined || row.openingStock === "") row.openingStock = 0;
    if (row.openingRate === undefined || row.openingRate === "") row.openingRate = 0;
    if (row.averagePurchasePrice === undefined || row.averagePurchasePrice === "") {
      row.averagePurchasePrice = Number(row.openingRate || 0);
    }
    if (row.landedCost === undefined || row.landedCost === "") {
      row.landedCost = Number(row.averagePurchasePrice || row.openingRate || 0);
    }
    if (row.mrp === undefined || row.mrp === "") row.mrp = 0;
    if (row.salePrice === undefined || row.salePrice === "") row.salePrice = Number(row.mrp || 0);
    if (row.minStockAlert === undefined || row.minStockAlert === "") row.minStockAlert = 0;
    if (row.minimumProfitPct === undefined || row.minimumProfitPct === "") row.minimumProfitPct = 3;
    row.lastPurchasePrice = Number(row.openingRate || 0);
    row.currentStock = Number(row.openingStock || 0);

    if (row.hsnCode) {
      const hsn = hsnMap.get(row.hsnCode);
      if (hsn) {
        row.hsnCode = hsn.code || row.hsnCode;
        row.hsnDescription = String(hsn.description || "");
        if (!hasValue(valueFor(raw, columns.gstRate)) && row.gstRate === 0) {
          row.gstRate = Number(hsn.gstRate || 0);
        }
      }
    }

    const issues = [];
    if (!row.name) issues.push("Product Name is blank");
    if (!row.warehouseId) issues.push("Warehouse is blank");
    if (row.hsnCode && !row.hsnDescription) issues.push("HSN/SAC was not found in MASTER");
    row._issues = issues;
    row._needsAttention = issues.length > 0;
    return row;
  });

  return ok(res, {
    received: rows.length,
    rows: preview,
    columns: fields.map(({ key, label, type }) => ({ key, label, type })),
    warehouses: warehouses.map((warehouse) => ({
      _id: String(warehouse._id),
      name: warehouseLabel(warehouse),
    })),
  }, "Product file ready for review");
});

router.post("/bulk-commit", async (req, res) => {
  const submittedRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!submittedRows.length) return fail(res, "No reviewed products were supplied", 400);
  if (submittedRows.length > 10000) return fail(res, "Maximum 10,000 products per import", 400);

  const admin = isAdminAuth(req.auth);
  const warehouses = await loadActiveWarehouses(req.auth.tenantKey);
  const warehouseIds = new Set(warehouses.map((warehouse) => String(warehouse._id)));

  const neededUnits = [
    ...new Set(
      submittedRows
        .flatMap((row) => [upper(row.basicUnit || "PCS"), upper(row.packingUnit)])
        .filter(Boolean),
    ),
  ];
  const [masterUnits, companyUnits] = await Promise.all([
    Unit.find({ $or: [{ code: { $in: neededUnits } }, { uqc: { $in: neededUnits } }] })
      .select("code uqc")
      .lean(),
    CompanyUnit.find({
      tenantKey: req.auth.tenantKey,
      $or: [{ code: { $in: neededUnits } }, { uqc: { $in: neededUnits } }],
    })
      .select("code uqc")
      .lean(),
  ]);
  const validUnits = new Set(
    [...masterUnits, ...companyUnits]
      .flatMap((row) => [upper(row.code), upper(row.uqc)])
      .filter(Boolean),
  );
  validUnits.add("PCS");

  const hsnCodes = [...new Set(submittedRows.map((row) => upper(row.hsnCode)).filter(Boolean))];
  const hsnResults = await Promise.all(hsnCodes.map(async (code) => [code, await findHsnByCode(code)]));
  const hsnMap = new Map(hsnResults.filter(([, row]) => row));

  const rejectedRows = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (let index = 0; index < submittedRows.length; index += 1) {
    const source = submittedRows[index] || {};
    const rowNumber = Number(source._uploadRow || index + 2);
    const original = source._original && typeof source._original === "object" ? source._original : {};

    try {
      const body = {
        sku: upper(source.sku),
        name: cleanText(source.name),
        category: cleanText(source.category),
        subCategory: cleanText(source.subCategory),
        warehouseId: resolveWarehouseId(source.warehouseId, warehouses),
        hsnCode: upper(source.hsnCode),
        gstRate: source.gstRate,
        basicUnit: upper(source.basicUnit || "PCS"),
        packingUnit: upper(source.packingUnit),
        qtyInBag: source.qtyInBag,
        openingStock: source.openingStock,
        openingRate: source.openingRate,
        averagePurchasePrice: source.averagePurchasePrice,
        landedCost: source.landedCost,
        mrp: source.mrp,
        salePrice: source.salePrice,
        minStockAlert: source.minStockAlert,
        barcode: cleanText(source.barcode),
        status: upper(source.status || "ACTIVE"),
        ...(admin ? { minimumProfitPct: source.minimumProfitPct } : {}),
      };

      if (!body.name) throw new Error("Product Name is required");
      if (!body.warehouseId || !warehouseIds.has(String(body.warehouseId))) {
        throw new Error("Select a valid active Warehouse");
      }
      if (!body.basicUnit) body.basicUnit = "PCS";
      if (!validUnits.has(body.basicUnit)) throw new Error(`Unit ${body.basicUnit} not found in DMS/MASTER Units`);
      if (body.packingUnit && !validUnits.has(body.packingUnit)) {
        throw new Error(`Unit ${body.packingUnit} not found in DMS/MASTER Units`);
      }

      const gstWasProvided = hasValue(source.gstRate) || source.gstRate === 0;
      if (body.hsnCode) {
        const hsn = hsnMap.get(body.hsnCode);
        if (!hsn) throw new Error(`HSN/SAC ${body.hsnCode} not found in MASTER`);
        body.hsnCode = hsn.code || body.hsnCode;
        body.hsnDescription = String(hsn.description || "");
        if (!gstWasProvided) body.gstRate = Number(hsn.gstRate || 0);
      } else {
        body.hsnDescription = "";
        if (!gstWasProvided) body.gstRate = 0;
      }

      normalizeNumericFields(body);
      body.unit = body.basicUnit;
      body.qtyInBag = Number(body.qtyInBag || 1);
      body.openingStock = Number(body.openingStock || 0);
      body.openingRate = Number(body.openingRate || 0);
      body.averagePurchasePrice = Number(body.averagePurchasePrice || body.openingRate || 0);
      body.lastPurchasePrice = Number(source.lastPurchasePrice || body.openingRate || 0);
      body.landedCost = Number(body.landedCost || body.averagePurchasePrice || body.openingRate || 0);
      body.mrp = Number(body.mrp || 0);
      body.salePrice = Number(body.salePrice || body.mrp || 0);
      body.minStockAlert = Number(body.minStockAlert || 0);
      body.currentStock = Number(source.currentStock ?? body.openingStock ?? 0);
      if (admin) body.minimumProfitPct = Number(body.minimumProfitPct || 0);

      let existing = null;
      if (body.sku) {
        existing = await Product.findOne({ tenantKey: req.auth.tenantKey, sku: body.sku }).lean();
      }

      if (!body.sku) {
        body.sku = await makeUniqueSku({
          tenantKey: req.auth.tenantKey,
          category: body.category,
          subCategory: body.subCategory,
          name: body.name,
        });
      }

      if (existing) {
        const barcode = await syncBarcodeMetadata({
          tenantKey: req.auth.tenantKey,
          oldBarcode: existing.barcode,
          newBarcode: body.barcode || existing.barcode,
          oldSku: existing.sku,
          sku: body.sku,
          productName: body.name,
          category: body.category,
          subCategory: body.subCategory,
          hsnCode: body.hsnCode,
          productId: String(existing._id),
          userId: userIdFromAuth(req.auth),
        });
        body.barcode = barcode.barcode;
        body.barcodeSource = barcode.barcodeSource;

        const before = JSON.stringify({
          ...existing,
          _id: undefined,
          __v: undefined,
          createdAt: undefined,
          updatedAt: undefined,
        });
        const afterComparable = JSON.stringify({ ...existing, ...body, _id: undefined, __v: undefined, createdAt: undefined, updatedAt: undefined });
        if (before === afterComparable) {
          unchanged += 1;
        } else {
          await Product.updateOne(
            { _id: existing._id, tenantKey: req.auth.tenantKey },
            { $set: body },
            { runValidators: true },
          );
          updated += 1;
        }
      } else {
        const barcode = await allocateBarcode({
          tenantKey: req.auth.tenantKey,
          sku: body.sku,
          productName: body.name,
          requestedBarcode: body.barcode,
          category: body.category,
          subCategory: body.subCategory,
          hsnCode: body.hsnCode,
          userId: userIdFromAuth(req.auth),
        });
        body.barcode = barcode.barcode;
        body.barcodeSource = barcode.barcodeSource;
        await Product.create({ ...body, tenantKey: req.auth.tenantKey });
        inserted += 1;
      }
    } catch (error) {
      rejectedRows.push({
        ...source,
        _uploadRow: rowNumber,
        _original: original,
        error: error?.code === 11000
          ? "SKU or Barcode / GTIN already exists"
          : (error.message || "Product could not be imported"),
      });
    }
  }

  return ok(res, {
    received: submittedRows.length,
    valid: submittedRows.length - rejectedRows.length,
    inserted,
    updated,
    unchanged,
    invalid: rejectedRows.length,
    rejectedRows,
  }, rejectedRows.length ? "Import completed with rows requiring correction" : "Product import completed");
});

router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) return fail(res, "Excel/CSV file is required", 400);

  let rows;
  try {
    rows = readRows(req.file.buffer);
  } catch {
    return fail(res, "Unable to read Excel/CSV file", 400);
  }
  if (!rows.length) return fail(res, "Uploaded file has no rows", 400);

  const fields = [
    { key: "sku", label: "SKU", aliases: ["product code", "item code"], required: true },
    { key: "name", label: "Product Name", aliases: ["product", "item", "name"], required: true },
    { key: "category", label: "Category" },
    { key: "subCategory", label: "Sub Category", aliases: ["subcategory", "sub-category"] },
    { key: "hsnCode", label: "HSN / SAC", aliases: ["hsn", "hsn code", "sac", "hsn/sac"] },
    { key: "gstRate", label: "GST %", aliases: ["gst rate", "gst"], type: "number" },
    { key: "basicUnit", label: "Basic Unit", aliases: ["primary unit", "unit"] },
    { key: "packingUnit", label: "Packing Unit", aliases: ["secondary unit", "bag unit"] },
    { key: "qtyInBag", label: "Qty In Bag", aliases: ["quantity in bag", "secondary size", "pack qty"], type: "number" },
    { key: "openingStock", label: "Opening Stock", type: "number" },
    { key: "openingRate", label: "Opening Rate", type: "number" },
    { key: "averagePurchasePrice", label: "Average Purchase Price", aliases: ["avg purchase price"], type: "number" },
    { key: "landedCost", label: "Landed Cost", type: "number" },
    { key: "mrp", label: "MRP", type: "number" },
    { key: "salePrice", label: "Sale Price", aliases: ["selling price"], type: "number" },
    { key: "minStockAlert", label: "Min Stock Alert", type: "number" },
    { key: "minimumProfitPct", label: "Minimum Profit %", aliases: ["minimum margin", "min profit", "min margin"], type: "number" },
    { key: "barcode", label: "Barcode", aliases: ["gtin", "ean"] },
    { key: "status", label: "Status" },
  ].filter((field) => isAdminAuth(req.auth) || field.key !== "minimumProfitPct");

  const columns = resolveColumns(rows[0], fields);
  const missing = fields
    .filter((field) => field.required && !columns[field.key])
    .map((field) => field.label);
  if (missing.length) return fail(res, `Missing column(s): ${missing.join(", ")}`, 400);

  const hsnCodes = [
    ...new Set(rows.map((row) => upper(valueFor(row, columns.hsnCode))).filter(Boolean)),
  ];
  const hsnResults = await Promise.all(
    hsnCodes.map(async (code) => [code, await findHsnByCode(code)]),
  );
  const hsnMap = new Map(hsnResults.filter(([, row]) => row));

  const unitCodes = [
    ...new Set(
      rows
        .flatMap((row) => [
          upper(valueFor(row, columns.basicUnit)),
          upper(valueFor(row, columns.packingUnit)),
        ])
        .filter(Boolean),
    ),
  ];
  const [masterUnits, companyUnits] = await Promise.all([
    Unit.find({ $or: [{ code: { $in: unitCodes } }, { uqc: { $in: unitCodes } }] })
      .select("code uqc")
      .lean(),
    CompanyUnit.find({
      tenantKey: req.auth.tenantKey,
      $or: [{ code: { $in: unitCodes } }, { uqc: { $in: unitCodes } }],
    })
      .select("code uqc")
      .lean(),
  ]);
  const validUnit = new Set(
    [...masterUnits, ...companyUnits].flatMap((row) => [row.code, row.uqc].filter(Boolean)),
  );

  const errors = [];
  const operations = [];

  rows.forEach((raw, index) => {
    const row = { tenantKey: req.auth.tenantKey };
    for (const field of fields) {
      const value = valueFor(raw, columns[field.key], field.type);
      if (value !== undefined && value !== "") row[field.key] = value;
    }

    const gstWasProvided = row.gstRate !== undefined && row.gstRate !== "";
    row.sku = upper(row.sku);
    row.hsnCode = upper(row.hsnCode);
    row.basicUnit = upper(row.basicUnit || "PCS");
    row.unit = row.basicUnit;
    row.packingUnit = upper(row.packingUnit);
    row.status = upper(row.status || "ACTIVE");

    try {
      normalizeNumericFields(row);
    } catch (error) {
      if (errors.length < 100) errors.push({ row: index + 2, error: error.message });
      return;
    }

    if (!row.averagePurchasePrice) row.averagePurchasePrice = row.openingRate;
    if (!row.landedCost) row.landedCost = row.averagePurchasePrice;
    if (!row.salePrice) row.salePrice = row.mrp;
    if (row.currentStock === undefined) row.currentStock = row.openingStock;

    if (!row.sku || !row.name) {
      if (errors.length < 100) {
        errors.push({ row: index + 2, error: "SKU and Product Name are required" });
      }
      return;
    }

    if (row.hsnCode) {
      const hsn = hsnMap.get(row.hsnCode);
      if (!hsn) {
        if (errors.length < 100) {
          errors.push({ row: index + 2, error: `HSN/SAC ${row.hsnCode} not found in MASTER` });
        }
        return;
      }
      row.hsnCode = hsn.code || row.hsnCode;
      row.hsnDescription = String(hsn.description || "");
      if (!gstWasProvided) row.gstRate = Number(hsn.gstRate || 0);
    } else {
      row.hsnDescription = "";
    }

    for (const unit of [row.basicUnit, row.packingUnit].filter(Boolean)) {
      if (unitCodes.length && !validUnit.has(unit) && unit !== "PCS") {
        if (errors.length < 100) {
          errors.push({ row: index + 2, error: `Unit ${unit} not found in DMS/MASTER Units` });
        }
        return;
      }
    }

    operations.push({
      updateOne: {
        filter: { tenantKey: req.auth.tenantKey, sku: row.sku },
        update: {
          $set: { ...row, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    });
  });

  if (!operations.length) return fail(res, "No valid product rows were found", 400, { errors });

  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < operations.length; i += 1000) {
    const result = await Product.bulkWrite(operations.slice(i, i + 1000), { ordered: false });
    inserted += result.upsertedCount || 0;
    updated += result.modifiedCount || 0;
  }

  return ok(
    res,
    {
      received: rows.length,
      valid: operations.length,
      inserted,
      updated,
      invalid: rows.length - operations.length,
      errors,
    },
    "Product bulk upload completed",
  );
});

router.post("/bulk-edit", async (req, res) => {
  const ids = (req.body.selection?.ids || []).filter(Boolean);
  if (!ids.length) return fail(res, "Select at least one product", 400);

  const allowed = [
    "category",
    "subCategory",
    "hsnCode",
    "gstRate",
    "basicUnit",
    "packingUnit",
    "qtyInBag",
    "openingStock",
    "openingRate",
    "averagePurchasePrice",
    "landedCost",
    "mrp",
    "salePrice",
    "minStockAlert",
    ...(isAdminAuth(req.auth) ? ["minimumProfitPct", "pricingScheme"] : []),
    "status",
  ];
  const changes = {};
  for (const key of allowed) {
    if (req.body.changes?.[key] !== undefined && req.body.changes[key] !== "") {
      changes[key] = req.body.changes[key];
    }
  }

  const gstWasProvided = changes.gstRate !== undefined;
  if (changes.hsnCode) changes.hsnCode = upper(changes.hsnCode);
  if (changes.basicUnit) {
    changes.basicUnit = upper(changes.basicUnit);
    changes.unit = changes.basicUnit;
  }
  if (changes.packingUnit) changes.packingUnit = upper(changes.packingUnit);
  if (changes.status) changes.status = upper(changes.status);

  try {
    normalizeNumericFields(changes);
  } catch (error) {
    return fail(res, error.message, 400);
  }
  if (!Object.keys(changes).length) return fail(res, "Enter at least one value to change", 400);

  if (changes.hsnCode) {
    const hsn = await findHsnByCode(changes.hsnCode);
    if (!hsn) return fail(res, "Selected HSN/SAC does not exist in MASTER", 400);
    changes.hsnCode = hsn.code || changes.hsnCode;
    changes.hsnDescription = String(hsn.description || "");
    if (!gstWasProvided) changes.gstRate = Number(hsn.gstRate || 0);
  }

  const result = await Product.updateMany(
    { _id: { $in: ids }, tenantKey: req.auth.tenantKey },
    { $set: changes },
    { runValidators: true },
  );
  return ok(
    res,
    { matched: result.matchedCount, updated: result.modifiedCount },
    `${result.modifiedCount} product(s) updated`,
  );
});

router.post("/bulk-delete", async (req, res) => {
  const ids = (req.body.selection?.ids || []).filter(Boolean);
  if (!ids.length) return fail(res, "Select at least one product", 400);

  const inUse = await referencedProductIds(req.auth.tenantKey, ids);
  if (inUse.size) {
    const used = await Product.find({ _id: { $in: [...inUse] }, tenantKey: req.auth.tenantKey }).select("name sku").lean();
    const names = used.slice(0, 8).map((x) => x.name || x.sku || String(x._id));
    return fail(res, `Cannot delete/deactivate product(s) already involved in stock or transactions: ${names.join(", ")}${used.length > 8 ? "…" : ""}`, 409);
  }

  const result = await Product.updateMany(
    { _id: { $in: ids }, tenantKey: req.auth.tenantKey },
    { $set: { status: "INACTIVE" } },
  );
  return ok(
    res,
    { deleted: result.modifiedCount, soft: true },
    `${result.modifiedCount} product(s) deactivated`,
  );
});

router.put("/:id", async (req, res) => {
  try {
    const existing = await Product.findOne({
      _id: req.params.id,
      tenantKey: req.auth.tenantKey,
    }).lean();
    if (!existing) return fail(res, "Product not found", 404);

    const changes = { ...req.body };
    if (!isAdminAuth(req.auth)) {
      delete changes.minimumProfitPct;
      delete changes.pricingScheme;
    }
    const gstWasProvided = hasValue(req.body?.gstRate) || req.body?.gstRate === 0;
    if (String(changes.status || "").toUpperCase() === "INACTIVE" && existing.status !== "INACTIVE") {
      const inUse = await referencedProductIds(req.auth.tenantKey, [req.params.id]);
      if (inUse.has(String(req.params.id))) {
        return fail(res, `${existing.name || existing.sku || "Product"} is already involved in stock/transactions and cannot be deactivated.`, 409);
      }
    }
    delete changes.hsnDescription;
    delete changes.barcodeSource;

    if (changes.name !== undefined) changes.name = cleanText(changes.name);
    if (changes.category !== undefined) changes.category = cleanText(changes.category);
    if (changes.subCategory !== undefined) changes.subCategory = cleanText(changes.subCategory);
    if (changes.warehouseId !== undefined) {
      changes.warehouseId = cleanText(changes.warehouseId);
      if (!changes.warehouseId) return fail(res, "Warehouse is required for Product", 400);
      const warehouse = await GenericRecord.findOne({_id:changes.warehouseId,tenantKey:req.auth.tenantKey,app:"dms",resource:"warehouses",status:"ACTIVE"}).lean();
      if (!warehouse) return fail(res, "Select a valid active Warehouse", 400);
    }

    const nextSku = changes.sku !== undefined ? upper(changes.sku) : upper(existing.sku);
    if (!nextSku) return fail(res, "SKU is required", 400);
    if (
      await Product.exists({
        tenantKey: req.auth.tenantKey,
        sku: nextSku,
        _id: { $ne: existing._id },
      })
    ) {
      return fail(res, "SKU already exists", 409);
    }
    changes.sku = nextSku;

    if (changes.hsnCode !== undefined) {
      changes.hsnCode = upper(changes.hsnCode);
      if (changes.hsnCode) {
        const hsn = await findHsnByCode(changes.hsnCode);
        if (!hsn) return fail(res, `HSN/SAC ${changes.hsnCode} not found in MASTER`, 400);
        changes.hsnCode = hsn.code || changes.hsnCode;
        changes.hsnDescription = String(hsn.description || "");
        if (!gstWasProvided) changes.gstRate = Number(hsn.gstRate || 0);
      } else {
        changes.hsnDescription = "";
        if (!gstWasProvided) changes.gstRate = 0;
      }
    }

    if (changes.basicUnit) {
      changes.basicUnit = upper(changes.basicUnit);
      changes.unit = changes.basicUnit;
    }
    if (changes.packingUnit !== undefined) changes.packingUnit = upper(changes.packingUnit);
    normalizeNumericFields(changes);

    if (changes.openingStock !== undefined && changes.currentStock === undefined) {
      if (Number(existing.currentStock || 0) === Number(existing.openingStock || 0)) {
        changes.currentStock = Number(changes.openingStock || 0);
      }
    }

    const nextName = changes.name !== undefined ? changes.name : existing.name;
    const nextCategory = changes.category !== undefined ? changes.category : existing.category;
    const nextSubCategory =
      changes.subCategory !== undefined ? changes.subCategory : existing.subCategory;
    const nextHsn = changes.hsnCode !== undefined ? changes.hsnCode : existing.hsnCode;
    const nextBarcode = changes.barcode !== undefined ? changes.barcode : existing.barcode;

    const barcode = await syncBarcodeMetadata({
      tenantKey: req.auth.tenantKey,
      oldBarcode: existing.barcode,
      newBarcode: nextBarcode,
      oldSku: existing.sku,
      sku: nextSku,
      productName: nextName,
      category: nextCategory,
      subCategory: nextSubCategory,
      hsnCode: nextHsn,
      productId: String(existing._id),
      userId: userIdFromAuth(req.auth),
    });
    changes.barcode = barcode.barcode;
    changes.barcodeSource = barcode.barcodeSource;

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, tenantKey: req.auth.tenantKey },
      changes,
      { new: true, runValidators: true },
    );
    const responseProduct = product.toObject();
    if (!isAdminAuth(req.auth)) { delete responseProduct.minimumProfitPct; delete responseProduct.pricingScheme; }
    return ok(res, responseProduct, "Product updated");
  } catch (error) {
    if (error?.code === 11000) {
      const duplicateField = Object.keys(error?.keyPattern || error?.keyValue || {})[0] || "";
      return fail(
        res,
        duplicateField.toLowerCase().includes("sku")
          ? "SKU already exists"
          : "Barcode / GTIN already exists",
        409,
      );
    }
    return fail(res, error.message, 400);
  }
});

router.delete("/:id", async (req, res) => {
  const existing = await Product.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey }).select("name sku").lean();
  if (!existing) return fail(res, "Product not found", 404);
  const inUse = await referencedProductIds(req.auth.tenantKey, [req.params.id]);
  if (inUse.has(String(req.params.id))) {
    return fail(res, `${existing.name || existing.sku || "Product"} is already involved in stock/transactions and cannot be deleted or deactivated. Edit it instead.`, 409);
  }
  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, tenantKey: req.auth.tenantKey },
    { status: "INACTIVE" },
    { new: true },
  );
  return ok(res, { deleted: true, soft: true }, "Product deactivated");
});

router.post("/:id/check-price", async (req, res) => {
  const product = await Product.findOne({
    _id: req.params.id,
    tenantKey: req.auth.tenantKey,
  });
  if (!product) return fail(res, "Product not found", 404);
  return ok(
    res,
    profitMetrics({
      landedCost: product.landedCost,
      effectiveSellingPrice: Number(req.body.effectivePrice),
      minimumProfitPct: product.minimumProfitPct,
      bands: req.body.bands,
    }),
  );
});

export default router;
