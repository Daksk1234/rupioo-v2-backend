import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import { CustomerLink, GlobalCustomer, Product, GenericRecord, User } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { cleanText } from "../utils/bulkSpreadsheet.js";
import { resolveFirmDeliveryLocation, gstTypeFromLocations } from "../services/deliveryLocalityService.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.auth?.role === "MASTER" || (req.auth?.apps || []).includes("dms")) return next();
  return fail(res, "DMS access required", 403);
});

const upper = (value) => cleanText(value).toUpperCase();
const isObjectIdText = (value) => /^[0-9a-fA-F]{24}$/.test(cleanText(value));
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headerKey = (value) => upper(value).replace(/[^A-Z0-9]+/g, "");

const editableUploadHeaders = {
  date: ["DATE", "INVOICE DATE"],
  invoiceNo: ["INVOICE NO", "INVOICE NUMBER", "BILL NO"],
  gstin: ["GST NO", "GST NUMBER", "GSTIN", "PARTY GSTIN"],
  productName: ["PRODUCT", "PRODUCT NAME", "ITEM", "ITEM NAME"],
  qty: ["QTY", "QNTY", "QUANTITY"],
  unit: ["UNIT", "UOM"],
  rate: ["RATE", "PRICE", "BASIC RATE"],
  discountPct: ["DISCOUNT", "DISCOUNT %", "DISCOUNT PERCENT", "DISCOUNT PCT"],
};

function uploadValue(row, aliases) {
  const map = new Map(Object.entries(row || {}).map(([key, value]) => [headerKey(key), value]));
  for (const alias of aliases) if (map.has(headerKey(alias))) return map.get(headerKey(alias));
  return "";
}

function parseUploadDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = cleanText(value);
  if (!text) return "";
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 90000) {
      const x = XLSX.SSF.parse_date_code(serial);
      if (x?.y && x?.m && x?.d) return `${x.y}-${String(x.m).padStart(2, "0")}-${String(x.d).padStart(2, "0")}`;
    }
  }
  const ymd = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${String(ymd[2]).padStart(2, "0")}-${String(ymd[3]).padStart(2, "0")}`;
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return `${year}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

async function resolveProduct({ tenantKey, productId, productName }) {
  if (productId && isObjectIdText(productId)) {
    const byId = await Product.findOne({ _id: productId, tenantKey, status: "ACTIVE" }).lean();
    if (byId) return byId;
  }
  const clean = cleanText(productName);
  if (!clean) return null;
  const bySku = await Product.findOne({ tenantKey, status: "ACTIVE", sku: upper(clean) }).lean();
  if (bySku) return bySku;
  return Product.findOne({ tenantKey, status: "ACTIVE", name: { $regex: `^${escapeRegex(clean)}$`, $options: "i" } }).lean();
}

async function resolveCustomer({ tenantKey, gstin }) {
  const normalized = upper(gstin).replace(/\s+/g, "").slice(0, 15);
  let customer = null;
  if (normalized) {
    customer = await CustomerLink.findOne({ tenantKey, status: "ACTIVE", displayIdentifier: normalized }).lean();
    if (!customer) {
      const global = await GlobalCustomer.findOne({ "gstins.value": normalized }).select("hiddenId").lean();
      if (global?.hiddenId) customer = await CustomerLink.findOne({ tenantKey, status: "ACTIVE", globalCustomerId: global.hiddenId }).lean();
    }
  }
  let cash = false;
  if (!customer) {
    cash = true;
    customer = await CustomerLink.findOne({
      tenantKey,
      status: "ACTIVE",
      $or: [{ systemKey: "CASH" }, { displayIdentifier: "CASH" }, { localName: /^CASH$/i }],
    }).lean();
  }
  let salespersonName = "";
  const salespersonId = cleanText(customer?.salespersonId);
  if (salespersonId && isObjectIdText(salespersonId)) {
    const salesperson = await User.findOne({ _id: salespersonId, tenantKey }).select("name").lean();
    salespersonName = cleanText(salesperson?.name);
  }
  return { customer, cash, salespersonId, salespersonName, normalizedGstin: normalized };
}

async function productPayloadFor({ tenantKey, product, warehouseCache = new Map() }) {
  if (!product) return null;
  const units = [...new Set([cleanText(product.basicUnit || product.unit), cleanText(product.packingUnit)].filter(Boolean))];
  const warehouseId = cleanText(product.warehouseId);
  let warehouse = null;
  if (warehouseId) {
    if (!warehouseCache.has(warehouseId)) {
      warehouse = await GenericRecord.findOne({ _id: warehouseId, tenantKey, app: "dms", resource: "warehouses" }).select("title reference name value").lean();
      warehouseCache.set(warehouseId, warehouse || null);
    } else warehouse = warehouseCache.get(warehouseId);
  }
  return {
    id: String(product._id),
    name: cleanText(product.name),
    sku: cleanText(product.sku),
    hsn: cleanText(product.hsnCode),
    gstRate: Number(product.gstRate || 0),
    units,
    defaultUnit: cleanText(product.basicUnit || product.unit || units[0]),
    warehouseId,
    warehouseName: cleanText(warehouse?.title || warehouse?.reference || warehouse?.name || warehouse?.value),
  };
}

router.get("/sales-with-products/health", (_req, res) => ok(res, { route: "sales-with-products", ready: true }, "Sales with Product API ready"));

router.post("/sales-with-products/import-preview", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return fail(res, "Excel file is required", 400);
    let workbook;
    try { workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false }); }
    catch { return fail(res, "Unable to read Excel file", 400); }
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    if (!rawRows.length) return fail(res, "Uploaded workbook has no data rows", 400);
    if (rawRows.length > 1000) return fail(res, "Maximum 1000 product rows can be uploaded at once", 400);

    const tenantKey = req.auth.tenantKey;
    const firm = await resolveFirmDeliveryLocation(tenantKey);
    const customerCache = new Map();
    const productCache = new Map();
    const warehouseCache = new Map();
    let carry = { date: "", invoiceNo: "", gstin: "" };
    const rows = [];

    for (const source of rawRows) {
      const typedDate = parseUploadDate(uploadValue(source, editableUploadHeaders.date));
      const typedInvoice = cleanText(uploadValue(source, editableUploadHeaders.invoiceNo));
      const typedGstin = upper(uploadValue(source, editableUploadHeaders.gstin)).replace(/\s+/g, "").slice(0, 15);
      if (typedDate) carry.date = typedDate;
      if (typedInvoice) carry.invoiceNo = typedInvoice;
      if (typedGstin) carry.gstin = typedGstin;

      const productName = cleanText(uploadValue(source, editableUploadHeaders.productName));
      const qty = cleanText(uploadValue(source, editableUploadHeaders.qty));
      const enteredUnit = cleanText(uploadValue(source, editableUploadHeaders.unit));
      const rate = cleanText(uploadValue(source, editableUploadHeaders.rate));
      const discountPct = cleanText(uploadValue(source, editableUploadHeaders.discountPct));
      if (!carry.date && !carry.invoiceNo && !carry.gstin && !productName && !qty && !rate) continue;

      const out = {
        date: carry.date,
        invoiceNo: carry.invoiceNo,
        gstin: carry.gstin,
        customerName: "",
        customerGlobalId: "",
        productName,
        productId: "",
        sku: "",
        hsn: "",
        qty,
        unit: enteredUnit,
        unitOptions: [],
        rate,
        discountPct,
        gstRate: 0,
        warehouseId: "",
        warehouseName: "",
        salespersonId: "",
        salespersonName: "",
        gstType: "CGST_SGST",
        cashCustomer: false,
        error: "",
      };

      try {
        const customerKey = carry.gstin || "__CASH__";
        let customerResult = customerCache.get(customerKey);
        if (!customerResult) {
          customerResult = await resolveCustomer({ tenantKey, gstin: carry.gstin });
          customerCache.set(customerKey, customerResult);
        }
        const customer = customerResult.customer;
        if (!customer) throw new Error("System CASH customer is not configured");
        out.customerName = customerResult.cash ? "CASH" : cleanText(customer.localName || customer.displayIdentifier || "CASH");
        out.customerGlobalId = cleanText(customer.globalCustomerId);
        out.cashCustomer = Boolean(customerResult.cash);
        out.salespersonId = customerResult.salespersonId || "";
        out.salespersonName = customerResult.salespersonName || "";
        const billing = (Array.isArray(customer.addresses) ? customer.addresses : []).find((a) => upper(a?.type || "BILLING") === "BILLING") || {};
        out.gstType = gstTypeFromLocations({
          companyGstin: firm.company?.gstin,
          customerGstin: carry.gstin,
          companyState: firm.state,
          customerState: billing.state,
          requested: "CGST_SGST",
        });

        if (!productName) throw new Error("Product is required");
        const productKey = upper(productName);
        let product = productCache.get(productKey);
        if (product === undefined) {
          product = await resolveProduct({ tenantKey, productName });
          productCache.set(productKey, product || null);
        }
        if (!product) throw new Error(`Product not found in Product Master: ${productName}`);
        const productPayload = await productPayloadFor({ tenantKey, product, warehouseCache });
        Object.assign(out, {
          productId: productPayload.id,
          productName: productPayload.name,
          sku: productPayload.sku,
          hsn: productPayload.hsn,
          gstRate: productPayload.gstRate,
          unitOptions: productPayload.units,
          unit: enteredUnit && productPayload.units.includes(enteredUnit) ? enteredUnit : (productPayload.defaultUnit || enteredUnit || ""),
          warehouseId: productPayload.warehouseId,
          warehouseName: productPayload.warehouseName,
        });
      } catch (error) {
        out.error = error?.message || "Could not resolve this row";
      }
      rows.push(out);
    }

    // Treat repeated Date + Invoice No. + GSTIN rows as product lines of ONE invoice.
    // Keep every product row (same behaviour as clicking "+ Add More" on the frontend),
    // but return them contiguously so the UI can create one multi-item sales invoice.
    const grouped = new Map();
    const groupOrder = [];
    for (const row of rows) {
      const key = `${cleanText(row.date)}|${upper(row.invoiceNo)}|${upper(row.gstin)}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
        groupOrder.push(key);
      }
      grouped.get(key).push(row);
    }
    const groupedRows = groupOrder.flatMap((key) => grouped.get(key));
    const invoiceGroups = groupOrder.map((key) => {
      const productRows = grouped.get(key) || [];
      const first = productRows[0] || {};
      return {
        key,
        date: first.date || "",
        invoiceNo: first.invoiceNo || "",
        gstin: first.gstin || "",
        productCount: productRows.length,
      };
    });

    return ok(res, {
      rows: groupedRows,
      invoiceGroups,
      received: rawRows.length,
      resolved: groupedRows.filter((row) => !row.error).length,
      invoiceCount: invoiceGroups.length,
    }, "Sales product workbook resolved and grouped invoice-wise");
  } catch (error) {
    return fail(res, error.message || "Could not preview Sales with Product workbook", error.statusCode || error.status || 400, error.details);
  }
});

router.post("/sales-with-products/resolve-row", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey;
    const gstin = upper(req.body?.gstin).replace(/\s+/g, "").slice(0, 15);
    const productId = cleanText(req.body?.productId);
    const productName = cleanText(req.body?.productName);
    const customerResult = await resolveCustomer({ tenantKey, gstin });
    const customer = customerResult.customer;
    if (!customer) return fail(res, "System CASH customer is not configured", 409);
    const billing = (Array.isArray(customer.addresses) ? customer.addresses : []).find((row) => upper(row?.type || "BILLING") === "BILLING") || {};
    const firm = await resolveFirmDeliveryLocation(tenantKey);
    const customerGstin = gstin || (!customerResult.cash && cleanText(customer.displayIdentifier).length === 15 ? cleanText(customer.displayIdentifier) : "");
    const gstType = gstTypeFromLocations({ companyGstin: firm.company?.gstin, customerGstin, companyState: firm.state, customerState: billing.state, requested: "CGST_SGST" });
    const product = await resolveProduct({ tenantKey, productId, productName });
    const productPayload = await productPayloadFor({ tenantKey, product });

    return ok(res, {
      customer: {
        globalCustomerId: cleanText(customer.globalCustomerId),
        name: customerResult.cash ? "CASH" : cleanText(customer.localName || customer.displayIdentifier || "CASH"),
        cash: customerResult.cash,
        salespersonId: customerResult.salespersonId,
        salespersonName: customerResult.salespersonName,
      },
      product: productPayload,
      gstType,
      companyState: firm.state || "",
    }, "Sales product row resolved");
  } catch (error) {
    return fail(res, error.message || "Could not resolve sales product row", error.statusCode || error.status || 400, error.details);
  }
});

export default router;
