import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import { Product, CustomerLink, GlobalCustomer, CompanyProfile, GenericRecord } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { readRows, resolveColumns, valueFor, cleanText } from "../utils/bulkSpreadsheet.js";
import { financialModels, reversePostedTransaction } from "../services/accountingService.js";
import { financialYearFromDate } from "../utils/financialYear.js";
import { makeId } from "../utils/ids.js";
import { calculateSalesInvoice, postSalesAccounting, normalizedEInvoice } from "./transactions.js";

const router = express.Router();
router.use(requireAuth);
router.use((req,res,next)=>{if(req.auth?.role==="MASTER"||(req.auth?.apps||[]).includes("dms"))return next();return fail(res,"DMS ACCESS REQUIRED",403);});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:30*1024*1024}});
const upper=(v)=>cleanText(v).toUpperCase();
const round2=(n)=>Number((Number(n)||0).toFixed(2));
const SALES_BULK_FIELDS = [
  { key: "gstin", label: "GST NO", aliases: ["GSTIN", "GST NUMBER", "PARTY GSTIN", "PARTY GST NO"] },
  { key: "partyName", label: "PARTY NAME", aliases: ["CUSTOMER NAME", "CUSTOMER", "PARTY", "ACCOUNT NAME", "LEDGER NAME"] },
  { key: "date", label: "DATE", aliases: ["INVOICE DATE"], required: true },
  { key: "invoiceNo", label: "INVOICE NO", aliases: ["INVOICE NUMBER", "BILL NO", "BILL NUMBER"], required: true },
  { key: "productName", label: "PRODUCT NAME", aliases: ["PRODUCT", "ITEM", "ITEM NAME", "PRODUCT / ITEM"] , required: true },
  { key: "qty", label: "QNTY", aliases: ["QTY", "QUANTITY"], type: "number", required: true },
  { key: "basicSalePrice", label: "BASIC SALE PRICE", aliases: ["BASIC PRICE", "BASIC RATE", "SALE BASIC RATE"], type: "number", required: true },
  { key: "invoiceTotal", label: "INVOICE TOTAL", aliases: ["GRAND TOTAL", "INVOICE VALUE", "BILL TOTAL"], type: "number", required: true },
  { key: "discountPct", label: "DISCOUNT %", aliases: ["DISC %", "ITEM DISCOUNT %", "LINE DISCOUNT %"], type: "number" },
  { key: "billDiscount", label: "BILL DISCOUNT", aliases: ["BILL DISCOUNT AMOUNT", "DISCOUNT AMOUNT"], type: "number" },
  { key: "otherCharges", label: "OTHER CHARGES", aliases: ["CHARGES", "FREIGHT", "FREIGHT / OTHER CHARGES"], type: "number" },
  { key: "warehouse", label: "WAREHOUSE", aliases: ["WARE HOUSE", "WAREHOUSE NAME"] },
  { key: "remarks", label: "REMARKS", aliases: ["NARRATION"] },
];

const bulkKey = (value) => upper(value).replace(/[^A-Z0-9]+/g, " ").trim();
const moneyNumber = (value) => {
  const n = Number(String(value ?? "").replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function parseBulkSalesDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = cleanText(value);
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 90000) {
      const x = XLSX.SSF.parse_date_code(serial);
      if (x?.y && x?.m && x?.d) return new Date(x.y, x.m - 1, x.d, 12, 0, 0, 0);
    }
  }
  const ymdMatch = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymdMatch) {
    const d = new Date(Number(ymdMatch[1]), Number(ymdMatch[2]) - 1, Number(ymdMatch[3]), 12, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const dmyMatch = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (dmyMatch) {
    let year = Number(dmyMatch[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const d = new Date(year, Number(dmyMatch[2]) - 1, Number(dmyMatch[1]), 12, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

const alphaKey = (value) => upper(value)
  .replace(/\bM\s*\/?\s*S\.?\b/g, " ")
  .replace(/\bMESSRS\b/g, " ")
  .replace(/[^A-Z0-9]+/g, "")
  .trim();

const partyNameFromRemarks = (value) => {
  const text = upper(value);
  const match = text.match(/(?:^|[|;])\s*PARTY\s*:\s*([^|;]+)/i) || text.match(/^PARTY\s*:\s*([^|;]+)/i);
  return cleanText(match?.[1] || "");
};

const partyMappingKey = ({ partyName = "", gstin = "" } = {}) => `PARTY:${alphaKey(partyName) || "BLANK"}|GST:${upper(gstin).replace(/\s+/g, "") || "BLANK"}`;
const productMappingKey = (name) => `PRODUCT:${alphaKey(name) || upper(name) || "BLANK"}`;

async function buildBulkSalesCustomerCatalog(tenantKey) {
  const links = await CustomerLink.find({ tenantKey, status: { $nin: ["INACTIVE", "DEACTIVATED", "REJECTED"] } }).lean();
  const ids = [...new Set(links.map((x) => x.globalCustomerId).filter(Boolean))];
  const objectIds = ids.filter((value) => /^[a-fA-F0-9]{24}$/.test(String(value)));
  const globals = ids.length ? await GlobalCustomer.find({ $or: [
    { hiddenId: { $in: ids } },
    ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
  ] }).lean() : [];
  const globalMap = new Map();
  for (const global of globals) {
    if (global.hiddenId) globalMap.set(String(global.hiddenId), global);
    if (global._id) globalMap.set(String(global._id), global);
  }
  const entries = links.map((link) => {
    const global = globalMap.get(String(link.globalCustomerId));
    const name = upper(link.localName || global?.tradeName || global?.legalName || link.displayIdentifier || "CUSTOMER");
    const gstins = [...new Set([
      /^[0-9A-Z]{15}$/i.test(cleanText(link.displayIdentifier)) ? upper(link.displayIdentifier) : "",
      ...((global?.gstins || []).map((x) => upper(x?.value)).filter((x) => /^[0-9A-Z]{15}$/.test(x)))
    ].filter(Boolean))];
    return { link, global, name, gstins };
  });

  const cashKeys = new Set(["CASH", "CASHCUSTOMER", "WALKIN", "WALKINCUSTOMER", "COUNTERSALE", "CASHSALE", "CASHSALECUSTOMER"]);
  let cash = entries.find((entry) => cashKeys.has(alphaKey(entry.name)) || /^CASH(?:CUSTOMER|SALE|PARTY)/.test(alphaKey(entry.name))) || null;
  if (!cash) {
    const company = await CompanyProfile.findOne({ tenantKey }).select("city state pincode").lean();
    const hiddenId = makeId("GC");
    const global = await GlobalCustomer.create({
      hiddenId,
      legalName: "CASH",
      tradeName: "CASH",
      customerType: "INDIVIDUAL",
      gstins: [],
      linkedTenants: [{ tenantKey, linkedAt: new Date() }],
    });
    const link = await CustomerLink.create({
      tenantKey,
      globalCustomerId: hiddenId,
      displayIdentifier: "CASH",
      localName: "CASH",
      customerType: "INDIVIDUAL",
      paymentType: "CASH",
      partyType: "DEBTOR",
      status: "ACTIVE",
      addresses: [{ type: "BILLING", address: "CASH COUNTER", city: company?.city || "", state: company?.state || "", pincode: company?.pincode || "" }],
      accountingProfile: { systemAccountCode: "SYS_SUNDRY_DEBTORS", ledgerName: "CASH" },
    });
    cash = { link: link.toObject(), global: global.toObject(), name: "CASH", gstins: [] };
    entries.push(cash);
  }

  const byId = new Map();
  const options = [];
  for (const entry of entries) {
    const id = String(entry.link.globalCustomerId || "");
    if (!id || byId.has(id)) continue;
    byId.set(id, entry);
    options.push({
      id,
      name: entry.name,
      gstin: entry.gstins[0] || "",
      gstins: entry.gstins,
      code: upper(entry.link.customerCode || ""),
      mobile: cleanText(entry.global?.mobile || entry.link.mobile || ""),
      email: cleanText(entry.global?.email || entry.link.email || ""),
    });
  }
  options.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, byId, options, cash, cashId: String(cash.link.globalCustomerId) };
}

function parseManualMappings(raw) {
  if (!cleanText(raw)) return { parties: {}, products: {} };
  try {
    const parsed = JSON.parse(raw);
    return {
      parties: parsed && typeof parsed.parties === "object" ? parsed.parties : {},
      products: parsed && typeof parsed.products === "object" ? parsed.products : {},
    };
  } catch {
    return { parties: {}, products: {} };
  }
}

async function resolveBulkWarehouse({ tenantKey, requestedId = "", rowName = "" }) {
  const rows = await GenericRecord.find({ tenantKey, app: "dms", resource: "warehouses", status: "ACTIVE" }).lean();
  if (!rows.length) return { error: "NO ACTIVE WAREHOUSE FOUND" };
  if (cleanText(rowName)) {
    const key = bulkKey(rowName);
    const match = rows.find((w) => bulkKey(w.title) === key || bulkKey(w.reference) === key || String(w._id) === cleanText(rowName));
    if (!match) return { error: `WAREHOUSE NOT FOUND: ${upper(rowName)}` };
    return { warehouse: match };
  }
  if (cleanText(requestedId)) {
    const match = rows.find((w) => String(w._id) === cleanText(requestedId));
    if (match) return { warehouse: match };
  }
  const v2Exact = rows.find((w) => ["V2", "V2 WAREHOUSE", "WAREHOUSE V2"].includes(bulkKey(w.title)) || ["V2", "V2 WAREHOUSE", "WAREHOUSE V2"].includes(bulkKey(w.reference)));
  if (v2Exact) return { warehouse: v2Exact };
  const v2Like = rows.find((w) => /(^| )V2( |$)/.test(bulkKey(w.title)) || /(^| )V2( |$)/.test(bulkKey(w.reference)));
  if (v2Like) return { warehouse: v2Like };
  if (rows.length === 1) return { warehouse: rows[0] };
  return { error: "SELECT DEFAULT WAREHOUSE FOR BULK SALES INVOICE IMPORT" };
}

function salesBulkTemplateBuffer() {
  const wb = XLSX.utils.book_new();
  const headers = SALES_BULK_FIELDS.map((f) => f.label);
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  ws["!cols"] = [18, 28, 14, 18, 34, 12, 18, 18, 14, 16, 16, 24, 30].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, "SALES INVOICE BULK");
  const example = XLSX.utils.aoa_to_sheet([
    headers,
    ["18ABCDE1234F1Z5", "ABC CUSTOMER", "20-09-2026", "SI-1001", "EXACT PRODUCT NAME FROM V2 - 18% GST EXAMPLE", 10, 100, 2360, 0, 0, 0, "", ""],
    ["", "", "", "", "SECOND PRODUCT OF SAME INVOICE - 18% GST EXAMPLE", 5, 200, "", 0, "", "", "", ""],
  ]);
  example["!cols"] = ws["!cols"];
  XLSX.utils.book_append_sheet(wb, example, "EXAMPLE");
  const instructions = XLSX.utils.aoa_to_sheet([
    ["SALES INVOICE BULK UPLOAD - INSTRUCTIONS"],
    ["REQUIRED", "DATE, INVOICE NO, PRODUCT NAME, QNTY, BASIC SALE PRICE, INVOICE TOTAL. PARTY NAME / GST NO ARE LOADED AS XLS VALUES FOR MANUAL PARTY MAPPING."],
    ["CUSTOMER MATCH", "NO CUSTOMER IS AUTO-MATCHED. LOAD THE XLS FIRST, THEN SEARCH THE V2 CUSTOMER MASTER BY PARTY NAME / GSTIN AND SELECT IT MANUALLY. UNMAPPED PARTY USES CASH DURING VALIDATION."],
    ["PRODUCT MATCH", "NO PRODUCT IS AUTO-MATCHED. LOAD THE XLS FIRST, THEN SEARCH THE V2 PRODUCT MASTER AND SELECT THE PRODUCT MANUALLY. UNMAPPED PRODUCTS ARE BLOCKED; OFFICE ASSET IS AVAILABLE AS A QUICK MANUAL CHOICE."],
    ["WAREHOUSE", "IF WAREHOUSE IS BLANK, THE SELECTED DEFAULT/V2 WAREHOUSE IS USED."],
    ["MULTI PRODUCT INVOICE", "KEEP PRODUCT LINES TOGETHER. GST NO, DATE, INVOICE NO AND INVOICE TOTAL MAY BE LEFT BLANK ON FOLLOWING LINES TO CARRY FORWARD THE PREVIOUS VALUE."],
    ["PRICE", "BASIC SALE PRICE IS BEFORE GST. GST RATE IS TAKEN FROM PRODUCT MASTER. NORMAL V2 TAX/ROUND-OFF CALCULATION IS USED."],
    ["TALLY", "SYSTEM CALCULATED GRAND TOTAL MUST MATCH INVOICE TOTAL WITHIN THE SELECTED TOLERANCE BEFORE POSTING."],
    ["OPTIONAL", "DISCOUNT %, BILL DISCOUNT, OTHER CHARGES, WAREHOUSE, REMARKS."],
    ["SAFETY", "DUPLICATE INVOICE NUMBERS, STOCK SHORTAGE, PRICE BELOW PURCHASE COST, CREDIT LIMIT AND MASTER MISMATCHES ARE BLOCKED/FLAGGED IN PREVIEW."],
  ]);
  instructions["!cols"] = [{ wch: 24 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, instructions, "INSTRUCTIONS");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function normalizeBulkRows(rows) {
  if (!rows.length) return { groups: [], errors: [{ row: 1, error: "NO DATA ROWS FOUND" }] };
  const columns = resolveColumns(rows[0], SALES_BULK_FIELDS);
  const missing = SALES_BULK_FIELDS.filter((f) => f.required && !columns[f.key]).map((f) => f.label);
  if (missing.length) return { groups: [], errors: [{ row: 1, error: `MISSING COLUMN(S): ${missing.join(", ")}` }] };
  const groups = new Map();
  const errors = [];
  const carry = { gstin: "", partyName: "", date: "", invoiceNo: "", invoiceTotal: "", billDiscount: "", otherCharges: "", warehouse: "", remarks: "" };
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i];
    const rowNo = i + 2;
    const productName = cleanText(valueFor(raw, columns.productName));
    const qtyText = cleanText(columns.qty ? raw[columns.qty] : "");
    const priceText = cleanText(columns.basicSalePrice ? raw[columns.basicSalePrice] : "");
    const rawQty = qtyText ? moneyNumber(qtyText) : 0;
    const rawPrice = priceText ? moneyNumber(priceText) : 0;
    const isBlank = !Object.values(raw || {}).some((v) => cleanText(v));
    if (isBlank) continue;

    const explicitGstin = cleanText(valueFor(raw, columns.gstin));
    const explicitPartyName = cleanText(valueFor(raw, columns.partyName));
    const explicitDate = cleanText(valueFor(raw, columns.date));
    const explicitInvoiceNo = cleanText(valueFor(raw, columns.invoiceNo));
    const startsNewInvoice = Boolean(explicitGstin || explicitPartyName || explicitDate || explicitInvoiceNo) && (
      (explicitGstin && upper(explicitGstin).replace(/\s+/g, "") !== upper(carry.gstin).replace(/\s+/g, "")) ||
      (explicitPartyName && alphaKey(explicitPartyName) !== alphaKey(carry.partyName)) ||
      (explicitInvoiceNo && upper(explicitInvoiceNo) !== upper(carry.invoiceNo)) ||
      (explicitDate && String(explicitDate) !== String(carry.date || ""))
    );
    if (startsNewInvoice) {
      carry.invoiceTotal = "";
      carry.billDiscount = "";
      carry.otherCharges = "";
      carry.warehouse = "";
      carry.remarks = "";
    }
    for (const key of Object.keys(carry)) {
      const field = SALES_BULK_FIELDS.find((f) => f.key === key);
      const column = columns[key];
      const cellText = cleanText(column ? raw[column] : "");
      if (!field || !column || !cellText) continue;
      carry[key] = field.type === "number" ? moneyNumber(cellText) : cellText;
    }
    const gstin = upper(carry.gstin).replace(/\s+/g, "");
    const remarks = upper(carry.remarks);
    const partyName = upper(carry.partyName || partyNameFromRemarks(remarks));
    const invoiceNo = upper(carry.invoiceNo);
    const date = parseBulkSalesDate(carry.date);
    const invoiceTotal = moneyNumber(carry.invoiceTotal);
    if (!invoiceNo || !date) {
      errors.push({ row: rowNo, error: "DATE AND INVOICE NO ARE REQUIRED FOR EACH INVOICE GROUP" });
      continue;
    }
    if (!productName) { errors.push({ row: rowNo, error: `PRODUCT NAME IS REQUIRED FOR INVOICE ${invoiceNo}` }); continue; }
    if (!qtyText || !(Number(rawQty) > 0)) { errors.push({ row: rowNo, error: `QNTY MUST BE GREATER THAN ZERO FOR ${productName}` }); continue; }
    if (!priceText || !(Number(rawPrice) >= 0)) { errors.push({ row: rowNo, error: `BASIC SALE PRICE IS REQUIRED FOR ${productName}` }); continue; }
    if (!(invoiceTotal > 0)) { errors.push({ row: rowNo, error: `INVOICE TOTAL MUST BE GREATER THAN ZERO FOR ${invoiceNo}` }); continue; }
    const dateKey = date.toISOString().slice(0, 10);
    const partyGroupKey = alphaKey(partyName) || gstin || "CASH";
    const key = `${partyGroupKey}|${invoiceNo}|${dateKey}`;
    if (!groups.has(key)) groups.set(key, { key, gstin, partyName, invoiceNo, date, expectedTotal: invoiceTotal, billDiscount: moneyNumber(carry.billDiscount), otherCharges: moneyNumber(carry.otherCharges), warehouseInput: cleanText(carry.warehouse), remarks, rows: [], rowNumbers: [] });
    const group = groups.get(key);
    if (!group.partyName && partyName) group.partyName = partyName;
    if (!group.gstin && gstin) group.gstin = gstin;
    if (Math.abs(Number(group.expectedTotal || 0) - invoiceTotal) > 0.009) errors.push({ row: rowNo, error: `INCONSISTENT INVOICE TOTAL FOR ${invoiceNo}: ${group.expectedTotal} VS ${invoiceTotal}` });
    const billDiscountText = cleanText(columns.billDiscount ? raw[columns.billDiscount] : "");
    const otherChargesText = cleanText(columns.otherCharges ? raw[columns.otherCharges] : "");
    const lineBillDiscount = billDiscountText ? moneyNumber(billDiscountText) : undefined;
    const lineOtherCharges = otherChargesText ? moneyNumber(otherChargesText) : undefined;
    const lineWarehouse = cleanText(valueFor(raw, columns.warehouse));
    if (lineBillDiscount !== undefined && Math.abs(Number(group.billDiscount || 0) - Number(lineBillDiscount || 0)) > 0.009) errors.push({ row: rowNo, error: `INCONSISTENT BILL DISCOUNT FOR ${invoiceNo}` });
    if (lineOtherCharges !== undefined && Math.abs(Number(group.otherCharges || 0) - Number(lineOtherCharges || 0)) > 0.009) errors.push({ row: rowNo, error: `INCONSISTENT OTHER CHARGES FOR ${invoiceNo}` });
    if (lineWarehouse && group.warehouseInput && bulkKey(lineWarehouse) !== bulkKey(group.warehouseInput)) errors.push({ row: rowNo, error: `MULTIPLE WAREHOUSES FOUND INSIDE INVOICE ${invoiceNo}` });
    const discountPct = Number(valueFor(raw, columns.discountPct, "number") || 0);
    group.rows.push({ rowNo, productName: upper(productName), qty: Number(rawQty), basicSalePrice: Number(rawPrice), discountPct });
    group.rowNumbers.push(rowNo);
  }
  return { groups: Array.from(groups.values()), errors };
}

async function buildSalesBulkPreview({ auth, fileBuffer, defaultWarehouseId = "", totalTolerance = 0.5, mappingJson = "", validateMappings = false }) {
  let rows;
  try {
    rows = readRows(fileBuffer);
  } catch {
    return {
      receivedRows: 0,
      invoices: [],
      validInvoices: 0,
      invalidInvoices: 0,
      rowErrors: [{ row: 1, error: "UNABLE TO READ EXCEL/CSV FILE" }],
      customerOptions: [],
      productOptions: [],
      uniqueParties: [],
      uniqueProducts: [],
      mappingRequired: true,
    };
  }

  const normalized = normalizeBulkRows(rows);
  const products = await Product.find({ tenantKey: auth.tenantKey, status: "ACTIVE" })
    .select("_id name sku gstRate mrp basicUnit unit currentStock landedCost purchasePrice averagePurchasePrice salePrice")
    .lean();
  const productById = new Map(products.map((product) => [String(product._id), product]));
  const productOptions = products
    .map((product) => ({
      id: String(product._id),
      name: upper(product.name),
      sku: upper(product.sku || ""),
      gstRate: Number(product.gstRate || 0),
      stock: Number(product.currentStock || 0),
      salePrice: Number(product.salePrice || 0),
      landedCost: Number(product.landedCost || product.averagePurchasePrice || product.purchasePrice || 0),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const officeAsset = productOptions.find((product) => alphaKey(product.name) === "OFFICEASSET" || alphaKey(product.sku) === "OFFICEASSET") || null;
  const customerCatalog = await buildBulkSalesCustomerCatalog(auth.tenantKey);
  const mappings = parseManualMappings(mappingJson);
  const tolerance = Math.min(10, Math.max(0, Number(totalTolerance ?? 0.5)));

  const partySummary = new Map();
  const productSummary = new Map();
  for (const group of normalized.groups) {
    const key = partyMappingKey(group);
    const current = partySummary.get(key) || {
      key,
      partyName: group.partyName || "",
      gstin: group.gstin || "",
      invoiceCount: 0,
      invoiceNos: [],
    };
    current.invoiceCount += 1;
    if (current.invoiceNos.length < 5) current.invoiceNos.push(group.invoiceNo);
    partySummary.set(key, current);
    for (const line of group.rows) {
      const productKey = productMappingKey(line.productName);
      const existing = productSummary.get(productKey) || { key: productKey, productName: line.productName, rowCount: 0, invoiceNos: [] };
      existing.rowCount += 1;
      if (existing.invoiceNos.length < 5 && !existing.invoiceNos.includes(group.invoiceNo)) existing.invoiceNos.push(group.invoiceNo);
      productSummary.set(productKey, existing);
    }
  }

  const rawHeaders = rows.length ? Object.keys(rows[0] || {}).map((value) => upper(value)).filter(Boolean) : [];
  const rawRows = rows.slice(0, 5000).map((row, index) => ({
    rowNo: index + 2,
    values: rawHeaders.reduce((acc, header) => {
      const actualKey = Object.keys(row || {}).find((key) => upper(key) === header);
      acc[header] = actualKey ? row[actualKey] : "";
      return acc;
    }, {}),
  }));

  const publicBase = {
    receivedRows: rows.length,
    rawHeaders,
    rawRows,
    rowErrors: normalized.errors.filter((e) => !normalized.groups.some((g) => g.rowNumbers.includes(e.row))),
    totalTolerance: tolerance,
    customerOptions: customerCatalog.options,
    productOptions,
    cashCustomerId: customerCatalog.cashId,
    officeAssetProductId: officeAsset?.id || "",
    uniqueParties: [...partySummary.values()].sort((a, b) => (a.partyName || a.gstin).localeCompare(b.partyName || b.gstin)),
    uniqueProducts: [...productSummary.values()].sort((a, b) => a.productName.localeCompare(b.productName)),
  };

  // First pass: copy XLS fields into V2 without attempting any automatic party/product matching.
  if (!validateMappings) {
    const invoices = normalized.groups.map((group) => ({
      key: group.key,
      partyMappingKey: partyMappingKey(group),
      gstin: group.gstin,
      partyNameInput: group.partyName,
      invoiceNo: group.invoiceNo,
      date: group.date.toISOString().slice(0, 10),
      financialYear: financialYearFromDate(group.date),
      expectedTotal: round2(group.expectedTotal),
      billDiscount: round2(group.billDiscount),
      otherCharges: round2(group.otherCharges),
      warehouseInput: group.warehouseInput || "",
      remarks: group.remarks || "",
      items: group.rows.map((line) => ({
        ...line,
        productMappingKey: productMappingKey(line.productName),
        matched: false,
      })),
      errors: normalized.errors.filter((e) => group.rowNumbers.includes(e.row)).map((e) => e.error),
      warnings: [],
      valid: false,
      mappingPending: true,
    }));
    return {
      ...publicBase,
      mode: "MANUAL_MAPPING",
      mappingRequired: true,
      invoices,
      validInvoices: 0,
      invalidInvoices: invoices.length,
    };
  }

  const invoices = [];
  const fileInvoiceCounts = new Map();
  for (const group of normalized.groups) {
    const key = `${financialYearFromDate(group.date)}|${group.invoiceNo}`;
    fileInvoiceCounts.set(key, Number(fileInvoiceCounts.get(key) || 0) + 1);
  }

  for (const group of normalized.groups) {
    const errors = normalized.errors.filter((e) => group.rowNumbers.includes(e.row)).map((e) => e.error);
    const warnings = [];
    const fy = financialYearFromDate(group.date);
    const fileInvoiceKey = `${fy}|${group.invoiceNo}`;
    if (Number(fileInvoiceCounts.get(fileInvoiceKey) || 0) > 1) {
      errors.push(`DUPLICATE INVOICE NO ${group.invoiceNo} APPEARS MORE THAN ONCE IN THE XLS FOR FY ${fy}`);
    }

    const pKey = partyMappingKey(group);
    const selectedCustomerId = cleanText(mappings.parties?.[pKey]);
    let customerEntry = selectedCustomerId ? customerCatalog.byId.get(selectedCustomerId) : null;
    let customerSource = "MANUAL_SELECTION";
    if (!customerEntry) {
      customerEntry = customerCatalog.cash;
      customerSource = "CASH_FALLBACK";
      warnings.push(`PARTY ${group.partyName || group.gstin || "BLANK"} HAS NOT BEEN MAPPED. CASH WILL BE USED.`);
    }
    const customer = customerEntry?.link || null;
    if (!customer) errors.push("CASH / CUSTOMER RECORD IS NOT AVAILABLE");
    if (group.gstin && customerEntry && customerSource === "MANUAL_SELECTION" && customerEntry.gstins.length && !customerEntry.gstins.includes(upper(group.gstin))) {
      warnings.push(`XLS GST NO ${group.gstin} DOES NOT MATCH THE SELECTED PARTY GSTIN ${customerEntry.gstins.join(" / ")}.`);
    }

    const whResult = await resolveBulkWarehouse({ tenantKey: auth.tenantKey, requestedId: defaultWarehouseId, rowName: group.warehouseInput });
    if (whResult.error) errors.push(whResult.error);

    const items = [];
    const itemPreview = [];
    for (const line of group.rows) {
      const mapKey = productMappingKey(line.productName);
      const selectedProductId = cleanText(mappings.products?.[mapKey]);
      const product = selectedProductId ? productById.get(selectedProductId) : null;
      if (!product) {
        errors.push(`ROW ${line.rowNo}: SELECT A V2 PRODUCT FOR XLS PRODUCT ${line.productName}`);
        itemPreview.push({ ...line, productMappingKey: mapKey, matched: false, matchSource: "MANUAL_SELECTION_REQUIRED" });
        continue;
      }
      const gstRate = Number(product.gstRate || 0);
      items.push({
        productId: String(product._id),
        qty: line.qty,
        basicRate: line.basicSalePrice,
        saleRate: round2(line.basicSalePrice * (1 + gstRate / 100)),
        discountPct: line.discountPct,
        gstRate,
      });
      itemPreview.push({
        ...line,
        productMappingKey: mapKey,
        productId: String(product._id),
        matchedProduct: upper(product.name),
        sku: upper(product.sku || ""),
        gstRate,
        availableStock: Number(product.currentStock || 0),
        matched: true,
        matchSource: "MANUAL_SELECTION",
      });
    }

    let calc = null;
    if (!errors.length && customer && whResult.warehouse) {
      try {
        calc = await calculateSalesInvoice({
          auth,
          body: {
            importSource: "BULK_XLS_MANUAL_MAP",
            date: group.date,
            financialYear: fy,
            invoiceNo: group.invoiceNo,
            customerGlobalId: customer.globalCustomerId,
            warehouseId: String(whResult.warehouse._id),
            billDiscount: group.billDiscount,
            otherCharges: group.otherCharges,
            remarks: group.remarks,
            items,
          },
        });
        const models = financialModels(auth.tenantKey, calc.financialYear);
        const duplicate = await models.SalesInvoice.findOne({ tenantKey: auth.tenantKey, financialYear: calc.financialYear, invoiceNo: group.invoiceNo }).select("_id invoiceNo date customerGlobalId").lean();
        if (duplicate) errors.push(`DUPLICATE INVOICE NO ${group.invoiceNo} ALREADY EXISTS IN FY ${calc.financialYear}`);
        const diff = round2(Number(calc.grandTotal || 0) - Number(group.expectedTotal || 0));
        if (Math.abs(diff) > tolerance + 0.0001) {
          errors.push(`INVOICE TOTAL MISMATCH: XLS ₹${Number(group.expectedTotal).toFixed(2)} VS V2 ₹${Number(calc.grandTotal).toFixed(2)} (DIFF ₹${diff.toFixed(2)})`);
        } else if (Math.abs(diff) > 0.009) {
          warnings.push(`TOTAL DIFFERENCE ₹${diff.toFixed(2)} IS WITHIN TOLERANCE ₹${tolerance.toFixed(2)}`);
        }
      } catch (e) {
        errors.push(upper(e.message || "INVOICE CALCULATION FAILED"));
      }
    }

    invoices.push({
      key: group.key,
      partyMappingKey: pKey,
      gstin: group.gstin,
      partyNameInput: group.partyName,
      invoiceNo: group.invoiceNo,
      date: group.date.toISOString().slice(0, 10),
      financialYear: fy,
      expectedTotal: round2(group.expectedTotal),
      calculatedTotal: calc ? round2(calc.grandTotal) : 0,
      difference: calc ? round2(calc.grandTotal - group.expectedTotal) : 0,
      customerGlobalId: customer?.globalCustomerId || "",
      customerName: customerEntry?.name || "CASH",
      customerMatchSource: customerSource,
      customerMatchConfidence: customerSource === "MANUAL_SELECTION" ? 100 : 0,
      customerFallback: customerSource === "CASH_FALLBACK",
      warehouseId: whResult.warehouse?._id ? String(whResult.warehouse._id) : "",
      warehouseName: whResult.warehouse?.title || whResult.warehouse?.reference || "",
      taxableTotal: calc ? round2(calc.taxableTotal) : 0,
      taxTotal: calc ? round2(calc.taxTotal) : 0,
      roundOff: calc ? round2(calc.roundOff) : 0,
      billDiscount: round2(group.billDiscount),
      otherCharges: round2(group.otherCharges),
      warehouseInput: group.warehouseInput || "",
      remarks: group.remarks || "",
      items: itemPreview,
      errors: Array.from(new Set(errors)),
      warnings: Array.from(new Set(warnings)),
      valid: errors.length === 0,
      mappingPending: false,
      _postingBody: errors.length === 0 ? {
        importSource: "BULK_XLS_MANUAL_MAP",
        date: group.date,
        financialYear: fy,
        invoiceNo: group.invoiceNo,
        customerGlobalId: customer.globalCustomerId,
        warehouseId: String(whResult.warehouse._id),
        billDiscount: group.billDiscount,
        otherCharges: group.otherCharges,
        remarks: group.remarks,
        items,
      } : null,
    });
  }

  return {
    ...publicBase,
    mode: "VALIDATED",
    mappingRequired: false,
    invoices,
    validInvoices: invoices.filter((x) => x.valid).length,
    invalidInvoices: invoices.filter((x) => !x.valid).length,
  };
}

async function advanceSalesInvoiceSeriesFromImportedNo(tenantKey, invoiceNo) {
  const company = await CompanyProfile.findOne({ tenantKey }).select("salesInvoicePrefix salesInvoiceSuffix salesInvoiceNextNumber").lean();
  if (!company) return;
  const prefix = cleanText(company.salesInvoicePrefix);
  const suffix = cleanText(company.salesInvoiceSuffix);
  if (!prefix || !suffix) return;
  const text = cleanText(invoiceNo);
  const start = `${prefix}-`, end = `-${suffix}`;
  if (!text.startsWith(start) || !text.endsWith(end)) return;
  const middle = text.slice(start.length, text.length - end.length);
  if (!/^\d+$/.test(middle)) return;
  const next = Number(middle) + 1;
  if (next > 0) await CompanyProfile.updateOne({ tenantKey }, { $max: { salesInvoiceNextNumber: next } });
}

async function postBulkDirectSalesInvoice({ auth, body }) {
  const calc = await calculateSalesInvoice({ auth, body });
  const models = financialModels(calc.tenantKey, calc.financialYear);
  const { SalesInvoice, StockMovement } = models;
  const invoiceNo = upper(body.invoiceNo);
  if (!invoiceNo) throw Object.assign(new Error("INVOICE NO IS REQUIRED"), { statusCode: 400 });
  if (await SalesInvoice.exists({ tenantKey: calc.tenantKey, financialYear: calc.financialYear, invoiceNo, })) throw Object.assign(new Error(`DUPLICATE INVOICE NO ${invoiceNo} ALREADY EXISTS IN FY ${calc.financialYear}`), { statusCode: 409 });
  let invoice = null;
  const moved = [];
  try {
    invoice = await SalesInvoice.create({ tenantKey: calc.tenantKey, financialYear: calc.financialYear, invoiceNo, date: calc.date, customerGlobalId: calc.customer.globalCustomerId, customerNameSnapshot: calc.customer.localName || calc.customer.displayIdentifier || "CUSTOMER", gstinSnapshot: calc.customer.displayIdentifier?.length === 15 ? calc.customer.displayIdentifier : "", addressSnapshot: calc.customerAddress?.address || "", items: calc.items, subtotal: calc.lineSubtotal, billDiscount: Number(body.billDiscount || 0), otherCharges: Number(body.otherCharges || 0), taxableTotal: calc.taxableTotal, taxTotal: calc.taxTotal, roundOff: calc.roundOff, grandTotal: calc.grandTotal, grossProfit: calc.grossProfit, grossMarginPct: calc.taxableTotal ? calc.grossProfit / calc.taxableTotal * 100 : 0, billingMode: "DIRECT", sourceOrderId: "", orderNo: body.orderNo || "", arn: body.arn || "", noOfPackages: Number(body.noOfPackages || 0), deliveryBoy: body.deliveryBoy || "", gstType: calc.gstType, remarks: upper(body.remarks || "BULK XLS IMPORT"), eInvoice: normalizedEInvoice(body), transportAssignment: calc.transportAssignment, branchId: body.branchId || auth.branch || "", warehouseId: calc.warehouseId, warehouseNameSnapshot: calc.warehouse.title || calc.warehouse.reference || "", assignedTo: body.assignedTo || "", workflowStatus: "POSTED", status: "POSTED", createdBy: auth.sub, createdByNameSnapshot: auth.name || "" });
    for (const it of calc.items) {
      await Product.updateOne({ _id: it.productId, tenantKey: calc.tenantKey }, { $inc: { currentStock: -it.qty } });
      moved.push({ productId: it.productId, qty: Number(it.qty || 0) });
      await StockMovement.create({ tenantKey: calc.tenantKey, financialYear: calc.financialYear, date: calc.date, productId: it.productId, warehouseId: calc.warehouseId, type: "SALE", qtyIn: 0, qtyOut: it.qty, landedCost: it.landedCostSnapshot, referenceId: invoiceNo });
    }
    await postSalesAccounting({ ...calc, invoiceNo });
    await advanceSalesInvoiceSeriesFromImportedNo(calc.tenantKey, invoiceNo).catch(() => {});
    return invoice;
  } catch (e) {
    for (const row of moved) await Product.updateOne({ _id: row.productId, tenantKey: calc.tenantKey }, { $inc: { currentStock: row.qty } }).catch(() => {});
    await StockMovement.deleteMany({ tenantKey: calc.tenantKey, financialYear: calc.financialYear, referenceId: invoiceNo, type: "SALE" }).catch(() => {});
    await reversePostedTransaction({ tenantKey: calc.tenantKey, financialYear: calc.financialYear, transactionId: invoiceNo, reason: "Bulk sales invoice posting rolled back" }).catch(() => {});
    if (invoice?._id) await SalesInvoice.deleteOne({ _id: invoice._id }).catch(() => {});
    throw e;
  }
}


router.get("/bulk-health", (_req, res) => ok(res, {
  build: "2026-09-20-sales-bulk-v7-manual-first",
  preview: "/api/transactions/sales-invoices/bulk-preview",
  upload: "/api/transactions/sales-invoices/bulk-upload",
  mode: "LOAD XLS -> MANUAL PARTY/PRODUCT MAPPING -> VALIDATE -> POST"
}, "SALES INVOICE BULK API READY"));

router.post("/bulk-preview", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return fail(res, "EXCEL/CSV FILE IS REQUIRED", 400);
    const result = await buildSalesBulkPreview({
      auth: req.auth,
      fileBuffer: req.file.buffer,
      defaultWarehouseId: req.body.defaultWarehouseId || "",
      totalTolerance: req.body.totalTolerance,
      mappingJson: req.body.mappingJson || "",
      validateMappings: String(req.body.validateMappings || "") === "1",
    });
    const publicResult = { ...result, invoices: result.invoices.map(({ _postingBody, ...invoice }) => invoice) };
    return ok(res, publicResult, result.mappingRequired ? "XLS FIELDS LOADED - MAP PARTIES AND PRODUCTS" : "MAPPED SALES INVOICE PREVIEW READY");
  } catch (e) {
    return fail(res, e.message || "BULK PREVIEW FAILED", e.statusCode || 400, e.details);
  }
});

router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return fail(res, "EXCEL/CSV FILE IS REQUIRED", 400);
    const preview = await buildSalesBulkPreview({
      auth: req.auth,
      fileBuffer: req.file.buffer,
      defaultWarehouseId: req.body.defaultWarehouseId || "",
      totalTolerance: req.body.totalTolerance,
      mappingJson: req.body.mappingJson || "",
      validateMappings: true,
    });
    const results = [];
    let posted = 0;
    for (const row of preview.invoices) {
      if (!row.valid || !row._postingBody) {
        results.push({ invoiceNo: row.invoiceNo, status: "SKIPPED", errors: row.errors });
        continue;
      }
      try {
        const invoice = await postBulkDirectSalesInvoice({ auth: req.auth, body: row._postingBody });
        posted += 1;
        results.push({ invoiceNo: invoice.invoiceNo, status: "POSTED", id: String(invoice._id), grandTotal: invoice.grandTotal, financialYear: invoice.financialYear });
      } catch (e) {
        results.push({ invoiceNo: row.invoiceNo, status: "ERROR", errors: [upper(e.message || "POSTING FAILED")] });
      }
    }
    return ok(res, {
      posted,
      skipped: results.filter((x) => x.status === "SKIPPED").length,
      failed: results.filter((x) => x.status === "ERROR").length,
      receivedRows: preview.receivedRows,
      totalInvoices: preview.invoices.length,
      results,
    }, `${posted} SALES INVOICE(S) POSTED`);
  } catch (e) {
    return fail(res, e.message || "BULK UPLOAD FAILED", e.statusCode || 400, e.details);
  }
});

export default router;
