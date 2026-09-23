import express from "express";
import multer from "multer";
import crypto from "crypto";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { env } from "../config/env.js";
import { Product, CustomerLink, GlobalCustomer, FileMeta } from "../models/index.js";
import {
  PurchaseRequirement,
  PurchaseRfq,
  PurchaseOrder as PurchaseOrderAi,
  PurchaseGoodsReceipt,
  PurchaseComplaint,
  PurchaseDocument,
  VendorPortalAccess,
} from "../models/purchaseAiModels.js";
import { financialModels, postBalancedEntries } from "../services/accountingService.js";
import { configuredFinancialYear, financialYearFromDate, normalizeFinancialYear } from "../utils/financialYear.js";
import { createOtp, verifyOtp } from "../services/otpService.js";
import { saveUploadedFile, readFile } from "../services/storageService.js";
import { extractDocument } from "../services/documentAiService.js";
import { getDocumentTemplate } from "../config/documentForms.js";
import { resolveTenantKeyAlias } from "../services/tenantKeyService.js";
import { isTenantMigrationActive } from "../services/tenantMigrationLock.js";

const router = express.Router();
const vendorRouter = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const round2 = (v) => Number(num(v).toFixed(2));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, num(v)));
const asDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const activePoStatuses = ["PO_SENT", "SUPPLIER_CONFIRMED", "PART_DISPATCHED", "DISPATCHED", "IN_TRANSIT", "PART_RECEIVED", "QC_PENDING", "QC_IN_PROGRESS", "QC_COMPLETE", "INWARD_PENDING", "ACCOUNTING_PENDING"];

function previousFy(fy) {
  const m = /^(\d{4})-(\d{2})$/.exec(normalizeFinancialYear(fy));
  if (!m) return "";
  const y = Number(m[1]) - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

function ceilMultiple(value, multiple = 1, moq = 1) {
  const min = Math.max(0, num(moq));
  const mult = Math.max(1, num(multiple));
  const base = Math.max(min, num(value));
  return Math.ceil(base / mult) * mult;
}

function portalSignature(payloadB64) {
  return crypto.createHmac("sha256", env.jwtSecret).update(payloadB64).digest("base64url");
}

function makePortalToken({ tenantKey, vendorGlobalId, version = 1 }) {
  const payload = Buffer.from(JSON.stringify({ t: tenantKey, v: vendorGlobalId, n: version }), "utf8").toString("base64url");
  return `${payload}.${portalSignature(payload)}`;
}

async function decodePortalToken(token) {
  const [payload, sig] = clean(token).split(".");
  if (!payload || !sig) throw Object.assign(new Error("Invalid vendor portal link"), { statusCode: 401 });
  const expected = portalSignature(payload);
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error("Invalid vendor portal link"), { statusCode: 401 });
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw Object.assign(new Error("Invalid vendor portal link"), { statusCode: 401 }); }
  const tokenTenantKey = clean(parsed.t);
  if (isTenantMigrationActive(tokenTenantKey)) throw Object.assign(new Error("Company GST/tenant migration is in progress. Retry shortly."), { statusCode: 423 });
  const tenantKey = await resolveTenantKeyAlias(tokenTenantKey);
  const access = await VendorPortalAccess.findOne({ tenantKey, vendorGlobalId: parsed.v, active: true }).lean();
  if (!access || Number(access.version || 1) !== Number(parsed.n || 1)) throw Object.assign(new Error("Vendor portal link has been revoked"), { statusCode: 401 });
  await VendorPortalAccess.updateOne({ _id: access._id }, { $set: { lastUsedAt: new Date() } });
  return { tenantKey, originalTenantKey: tokenTenantKey, vendorGlobalId: parsed.v, version: parsed.n };
}

async function ensureVendorAccess(tenantKey, vendorGlobalId) {
  const access = await VendorPortalAccess.findOneAndUpdate(
    { tenantKey, vendorGlobalId },
    { $setOnInsert: { tenantKey, vendorGlobalId, version: 1, active: true }, $set: { active: true } },
    { upsert: true, new: true },
  );
  return { access, token: makePortalToken({ tenantKey, vendorGlobalId, version: access.version || 1 }) };
}

async function vendorProfile(tenantKey, vendorGlobalId) {
  const [link, global] = await Promise.all([
    CustomerLink.findOne({ tenantKey, globalCustomerId: vendorGlobalId }).lean(),
    GlobalCustomer.findOne({ hiddenId: vendorGlobalId }).lean(),
  ]);
  if (!link && !global) return { vendorGlobalId, name: vendorGlobalId || "Supplier", gstin: "", mobile: "", email: "", creditDays: 0 };
  const primaryContact = (link?.contacts || []).find((x) => x.primary && x.active !== false) || (link?.contacts || []).find((x) => x.active !== false) || {};
  const mobile = clean(primaryContact.mobile || link?.companyContactNumber || global?.mobiles?.find((x) => x.primary)?.value || global?.mobiles?.[0]?.value);
  const email = clean(primaryContact.email || global?.emails?.find((x) => x.primary)?.value || global?.emails?.[0]?.value);
  const gstin = clean(link?.displayIdentifier?.length === 15 ? link.displayIdentifier : global?.gstins?.[0]?.value);
  return {
    vendorGlobalId,
    name: clean(link?.localName || global?.tradeName || global?.legalName || vendorGlobalId || "Supplier"),
    gstin,
    mobile,
    email,
    creditDays: num(link?.creditDays || link?.approvedTerms?.creditDays),
    paymentType: link?.paymentType || link?.approvedTerms?.paymentType || "CREDIT",
  };
}

async function currentFy(tenantKey, requested) {
  return normalizeFinancialYear(requested) || await configuredFinancialYear(tenantKey);
}

async function salesMetrics(tenantKey, financialYear) {
  const now = new Date();
  const since90 = new Date(now.getTime() - 90 * 86400000);
  const since30 = new Date(now.getTime() - 30 * 86400000);
  const fys = [financialYear, previousFy(financialYear)].filter(Boolean);
  const metrics = new Map();
  for (const fy of fys) {
    const { SalesInvoice } = financialModels(tenantKey, fy);
    const rows = await SalesInvoice.aggregate([
      { $match: { tenantKey, date: { $gte: since90 }, status: { $ne: "DELETED" } } },
      { $unwind: "$items" },
      { $group: {
        _id: "$items.productId",
        qty90: { $sum: { $ifNull: ["$items.qty", 0] } },
        qty30: { $sum: { $cond: [{ $gte: ["$date", since30] }, { $ifNull: ["$items.qty", 0] }, 0] } },
        invoices: { $sum: 1 },
        lastSaleAt: { $max: "$date" },
      } },
    ]).catch(() => []);
    for (const r of rows) {
      const id = String(r._id || ""); if (!id) continue;
      const x = metrics.get(id) || { qty90: 0, qty30: 0, invoices: 0, lastSaleAt: null };
      x.qty90 += num(r.qty90); x.qty30 += num(r.qty30); x.invoices += num(r.invoices);
      if (!x.lastSaleAt || (r.lastSaleAt && new Date(r.lastSaleAt) > new Date(x.lastSaleAt))) x.lastSaleAt = r.lastSaleAt;
      metrics.set(id, x);
    }
  }
  return metrics;
}

async function purchaseHistory(tenantKey, financialYear) {
  const fys = [financialYear, previousFy(financialYear)].filter(Boolean);
  const byProduct = new Map();
  for (const fy of fys) {
    const { PurchaseInvoice } = financialModels(tenantKey, fy);
    const invoices = await PurchaseInvoice.find({ tenantKey, status: { $ne: "DELETED" } }).sort({ date: -1, createdAt: -1 }).limit(2500).lean().catch(() => []);
    for (const inv of invoices) {
      for (const it of inv.items || []) {
        const pid = String(it.productId || ""); if (!pid) continue;
        const map = byProduct.get(pid) || { last: null, vendors: new Map() };
        const rate = num(it.effectiveRate ?? it.rate);
        const landed = num(it.landedCostSnapshot ?? rate);
        const qty = num(it.qty);
        const vendorId = clean(inv.supplierGlobalId);
        if (!map.last || new Date(inv.date || 0) > new Date(map.last.date || 0)) {
          map.last = { date: inv.date, invoiceNo: inv.invoiceNo, rate, landedRate: landed, qty, vendorGlobalId: vendorId, vendorName: inv.supplierNameSnapshot || "Supplier", gstin: inv.supplierGstinSnapshot || "" };
        }
        if (vendorId) {
          const v = map.vendors.get(vendorId) || { vendorGlobalId: vendorId, vendorName: inv.supplierNameSnapshot || "Supplier", lastPurchaseDate: null, lastInvoiceNo: "", lastRate: 0, lastQty: 0, value: 0, qty: 0, purchaseCount: 0 };
          v.value += rate * qty; v.qty += qty; v.purchaseCount += 1;
          if (!v.lastPurchaseDate || new Date(inv.date || 0) > new Date(v.lastPurchaseDate || 0)) { v.lastPurchaseDate = inv.date; v.lastInvoiceNo = inv.invoiceNo; v.lastRate = rate; v.lastQty = qty; }
          map.vendors.set(vendorId, v);
        }
        byProduct.set(pid, map);
      }
    }
  }
  const vendorIds = new Set();
  for (const p of byProduct.values()) for (const id of p.vendors.keys()) vendorIds.add(id);
  const profiles = new Map();
  await Promise.all([...vendorIds].map(async (id) => profiles.set(id, await vendorProfile(tenantKey, id))));
  for (const p of byProduct.values()) {
    for (const [id, v] of p.vendors) {
      const pr = profiles.get(id) || {};
      v.mobile = pr.mobile || ""; v.email = pr.email || ""; v.gstin = pr.gstin || ""; v.creditDays = num(pr.creditDays); v.avgRate = v.qty > 0 ? round2(v.value / v.qty) : v.lastRate;
      v.score = round2(Math.min(100, 55 + Math.min(20, v.purchaseCount * 2) + Math.min(15, v.creditDays / 3) + 10));
      v.reason = `${v.purchaseCount} purchase${v.purchaseCount === 1 ? "" : "s"}; last ₹${round2(v.lastRate)}; ${v.creditDays || 0} credit days`;
    }
    if (p.last?.vendorGlobalId) {
      const pr = profiles.get(p.last.vendorGlobalId) || {};
      p.last.mobile = pr.mobile || ""; p.last.email = pr.email || ""; p.last.gstin = p.last.gstin || pr.gstin || "";
    }
  }
  return byProduct;
}

async function pendingPoMap(tenantKey) {
  const rows = await PurchaseOrderAi.find({ tenantKey, status: { $in: activePoStatuses } }).select("items status").lean();
  const map = new Map();
  for (const po of rows) for (const it of po.items || []) {
    const remaining = Math.max(0, num(it.confirmedQty || it.orderedQty) - num(it.acceptedQty));
    map.set(String(it.productId), num(map.get(String(it.productId))) + remaining);
  }
  return map;
}

function classifyTrend(products, metrics) {
  const scored = products.map((p) => {
    const m = metrics.get(String(p._id)) || {};
    const avg30 = num(m.qty30) / 30;
    const avg90 = num(m.qty90) / 90;
    const frequency = num(m.invoices) / 90;
    const score = avg30 * 0.55 + avg90 * 0.3 + frequency * 0.15;
    return { id: String(p._id), score };
  }).sort((a, b) => b.score - a.score);
  const n = scored.length || 1;
  const result = new Map();
  scored.forEach((row, idx) => result.set(row.id, idx < Math.ceil(n * 0.3) ? "HIGH" : idx < Math.ceil(n * 0.7) ? "MEDIUM" : "LOW"));
  return result;
}

function triggerPctFor(cls) { return cls === "HIGH" ? 30 : cls === "MEDIUM" ? 10 : 5; }

async function buildRequirementCandidate({ product, trendClass, metric, pendingPoQty, history }) {
  const policy = product.purchaseAutomation || {};
  const avgDaily30 = num(metric?.qty30) / 30;
  const avgDaily90 = num(metric?.qty90) / 90;
  const weightedDaily = avgDaily30 > 0 || avgDaily90 > 0 ? avgDaily30 * 0.65 + avgDaily90 * 0.35 : 0;
  const cls = ["HIGH", "MEDIUM", "LOW"].includes(policy.trendOverride) ? policy.trendOverride : trendClass;
  const triggerPct = triggerPctFor(cls);
  const leadDays = Math.max(1, num(policy.leadDays || 7));
  const safetyDays = Math.max(0, num(policy.safetyDays || 7));
  const forecast30 = weightedDaily * 30;
  const safetyStock = weightedDaily * safetyDays;
  const configuredTarget = num(policy.targetStock);
  const inferredFromAlert = num(product.minStockAlert) > 0 ? num(product.minStockAlert) / (triggerPct / 100) : 0;
  const historicalTarget = forecast30 + weightedDaily * leadDays + safetyStock;
  const fallbackTarget = Math.max(num(product.openingStock), num(product.currentStock), 1);
  const targetStock = round2(Math.max(configuredTarget, inferredFromAlert, historicalTarget, fallbackTarget));
  const triggerQty = round2(targetStock * triggerPct / 100);
  const currentStock = num(product.currentStock);
  const reservedStock = num(product.reservedStock);
  const availableStock = Math.max(0, currentStock - reservedStock);
  const effectiveStock = round2(availableStock + num(pendingPoQty));
  const moq = Math.max(1, num(policy.moq || 1));
  const orderMultiple = Math.max(1, num(policy.orderMultiple || 1));
  const rawNeed = Math.max(0, targetStock - effectiveStock);
  const suggestedQty = rawNeed > 0 ? ceilMultiple(rawNeed, orderMultiple, moq) : 0;
  const vendors = [...(history?.vendors?.values?.() || [])].sort((a, b) => (new Date(b.lastPurchaseDate || 0) - new Date(a.lastPurchaseDate || 0))).slice(0, 10);
  const preferred = clean(policy.preferredSupplierGlobalId);
  if (preferred) vendors.sort((a, b) => (a.vendorGlobalId === preferred ? -1 : b.vendorGlobalId === preferred ? 1 : 0));
  return {
    productId: String(product._id), sku: product.sku || "", productName: product.name || "", hsnCode: product.hsnCode || "", unit: product.basicUnit || product.unit || "PCS",
    trendClass: cls, triggerPct, targetStock, triggerQty, currentStock, reservedStock, availableStock, pendingPoQty: round2(pendingPoQty), effectiveStock,
    avgDaily30: round2(avgDaily30), avgDaily90: round2(avgDaily90), salesQty30: round2(metric?.qty30), salesQty90: round2(metric?.qty90), forecast30: round2(forecast30), safetyStock: round2(safetyStock),
    suggestedQty: round2(suggestedQty), requestedQty: round2(suggestedQty), moq, orderMultiple, leadDays,
    aiReason: `${cls} trend → ${triggerPct}% trigger. ATP ${round2(availableStock)} + incoming PO ${round2(pendingPoQty)} = ${effectiveStock}; AI target ${targetStock}; suggested ${round2(suggestedQty)} ${product.basicUnit || product.unit || "PCS"}.`,
    lastPurchase: history?.last || null,
    vendorSuggestions: vendors,
    automationEnabled: policy.enabled !== false,
  };
}

async function scanAndUpsert(tenantKey, financialYear, userId) {
  const [products, metrics, history, pending] = await Promise.all([
    Product.find({ tenantKey, status: "ACTIVE" }).lean(),
    salesMetrics(tenantKey, financialYear),
    purchaseHistory(tenantKey, financialYear),
    pendingPoMap(tenantKey),
  ]);
  const trend = classifyTrend(products, metrics);
  let triggered = 0; const output = [];
  for (const product of products) {
    const pid = String(product._id);
    const c = await buildRequirementCandidate({ product, trendClass: trend.get(pid) || "LOW", metric: metrics.get(pid), pendingPoQty: pending.get(pid) || 0, history: history.get(pid) });
    const isTriggered = c.automationEnabled && c.effectiveStock <= c.triggerQty;
    if (!isTriggered) continue;
    triggered += 1;
    const existing = await PurchaseRequirement.findOne({ tenantKey, productId: pid, status: { $in: ["TRIGGERED", "ORDER_SHEET", "HOLD"] } });
    const base = { ...c, tenantKey, financialYear, lastTriggeredAt: new Date(), updatedBy: userId || "SYSTEM", scanVersion: 2 };
    if (existing) {
      const preserveQty = existing.quantitySource === "MANUAL";
      Object.assign(existing, base, { requestedQty: preserveQty ? existing.requestedQty : c.requestedQty, quantitySource: preserveQty ? "MANUAL" : "AI" });
      if (existing.status === "HOLD" && existing.holdUntil && existing.holdUntil <= new Date()) existing.status = "TRIGGERED";
      await existing.save(); output.push(existing.toObject());
    } else {
      const doc = await PurchaseRequirement.create({ ...base, quantitySource: "AI", requirementNo: makeId("PREQ"), createdBy: userId || "SYSTEM", status: "TRIGGERED" });
      output.push(doc.toObject());
    }
  }
  return { triggered, items: output };
}

function rfqTotals(items) {
  let taxable = 0, tax = 0, landed = 0;
  for (const i of items || []) {
    const qty = num(i.qty), rate = num(i.rate), discount = clamp(i.discountPct, 0, 100), gst = num(i.gstRate), freight = num(i.freight);
    const line = qty * rate * (1 - discount / 100);
    taxable += line; tax += line * gst / 100; landed += line + freight;
    i.landedRate = qty > 0 ? round2((line + freight) / qty) : round2(rate);
  }
  return { totalTaxable: round2(taxable), totalTax: round2(tax), grandTotal: round2(taxable + tax), landedTotal: round2(landed + tax) };
}

function recalcComparison(rfq) {
  const submitted = (rfq.vendors || []).filter((v) => v.status === "SUBMITTED" && num(v.landedTotal) > 0);
  if (!submitted.length) return;
  const prices = submitted.map((v) => num(v.landedTotal));
  const minPrice = Math.min(...prices), maxPrice = Math.max(...prices);
  const days = submitted.map((v) => Math.max(1, num(v.quoteItems?.[0]?.deliveryDays || 999)));
  const minDays = Math.min(...days), maxDays = Math.max(...days);
  for (const v of submitted) {
    const priceScore = maxPrice === minPrice ? 50 : 50 * (maxPrice - num(v.landedTotal)) / (maxPrice - minPrice);
    const d = Math.max(1, num(v.quoteItems?.[0]?.deliveryDays || 999));
    const deliveryScore = maxDays === minDays ? 20 : 20 * (maxDays - d) / (maxDays - minDays);
    const creditScore = Math.min(15, num(v.creditDays) / 3);
    const historyScore = 15;
    v.comparisonScore = round2(priceScore + deliveryScore + creditScore + historyScore);
    v.comparisonReasons = [`Landed ₹${round2(v.landedTotal)}`, `${d === 999 ? "Delivery not specified" : `${d} day delivery`}`, `${num(v.creditDays)} credit days`];
  }
}

async function authorizeVendorFile({ tenantKey, vendorGlobalId, fileId }) {
  const doc = await PurchaseDocument.findOne({ tenantKey, vendorGlobalId, fileId }).lean();
  if (doc) return true;
  const complaint = await PurchaseComplaint.findOne({ tenantKey, vendorGlobalId, $or: [
    { evidenceFileIds: fileId }, { "items.evidenceFileIds": fileId }, { "vendorResponse.responseFileIds": fileId }, { "creditNote.fileIds": fileId },
  ] }).lean();
  if (complaint) return true;
  const po = await PurchaseOrderAi.findOne({ tenantKey, vendorGlobalId, $or: [{ "shipments.invoiceFileIds": fileId }, { "shipments.lrFileIds": fileId }] }).lean();
  return Boolean(po);
}

// ---------------- Private DMS Purchase AI ----------------
router.use(requireAuth);

let purchaseAiSchedulerStarted = false;
export function startPurchaseAiAutomation({ intervalMs = 15 * 60 * 1000, initialDelayMs = 45 * 1000 } = {}) {
  if (purchaseAiSchedulerStarted) return;
  purchaseAiSchedulerStarted = true;
  const run = async () => {
    try {
      const tenants = (await Product.distinct("tenantKey", { status: "ACTIVE" })).filter(Boolean);
      for (const tenantKey of tenants) {
        try {
          const financialYear = await currentFy(tenantKey);
          await scanAndUpsert(tenantKey, financialYear, "SYSTEM");
        } catch (error) {
          console.error(`[PurchaseAI] auto scan failed for ${tenantKey}:`, error?.message || error);
        }
      }
    } catch (error) {
      console.error("[PurchaseAI] auto scan failed:", error?.message || error);
    }
  };
  const starter = setTimeout(() => {
    run();
    const timer = setInterval(run, Math.max(5 * 60 * 1000, Number(intervalMs) || 15 * 60 * 1000));
    timer.unref?.();
  }, Math.max(1000, Number(initialDelayMs) || 45 * 1000));
  starter.unref?.();
}

router.get("/health", (_req, res) => ok(res, { module: "purchase-ai", build: "2026-09-20-advanced", autoScan: true, intervalMinutes: 15 }));

router.get("/dashboard", async (req, res) => {
  try {
    const tenantKey = req.auth.tenantKey;
    const [requirements, rfqs, pos, grns, complaints] = await Promise.all([
      PurchaseRequirement.countDocuments({ tenantKey, status: { $in: ["TRIGGERED", "ORDER_SHEET"] } }),
      PurchaseRfq.countDocuments({ tenantKey, status: { $in: ["OPEN", "QUOTATIONS_RECEIVED"] } }),
      PurchaseOrderAi.countDocuments({ tenantKey, status: { $in: activePoStatuses } }),
      PurchaseGoodsReceipt.countDocuments({ tenantKey, qcStatus: { $in: ["IN_PROGRESS", "QC_COMPLETE", "INWARD_PENDING"] } }),
      PurchaseComplaint.countDocuments({ tenantKey, status: { $ne: "CLOSED" } }),
    ]);
    const overdue = await PurchaseOrderAi.countDocuments({ tenantKey, requiredByDate: { $lt: new Date() }, status: { $in: activePoStatuses } });
    const insights = [];
    if (requirements) insights.push(`${requirements} stock trigger${requirements === 1 ? "" : "s"} need purchase review.`);
    if (overdue) insights.push(`${overdue} purchase order${overdue === 1 ? " is" : "s are"} past required delivery date.`);
    if (complaints) insights.push(`${complaints} supplier complaint${complaints === 1 ? "" : "s"} remain unresolved.`);
    return ok(res, { requirements, rfqs, purchaseOrders: pos, grns, complaints, overdue, insights });
  } catch (e) { return fail(res, e.message, 400); }
});

router.post("/scan-stock", async (req, res) => {
  try {
    const financialYear = await currentFy(req.auth.tenantKey, req.body.financialYear);
    const result = await scanAndUpsert(req.auth.tenantKey, financialYear, req.auth.sub);
    return ok(res, { financialYear, ...result }, `${result.triggered} purchase trigger${result.triggered === 1 ? "" : "s"} detected`);
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.get("/requirements", async (req, res) => {
  const filter = { tenantKey: req.auth.tenantKey };
  if (req.query.status && req.query.status !== "ALL") filter.status = req.query.status;
  const rows = await PurchaseRequirement.find(filter).sort({ lastTriggeredAt: -1, updatedAt: -1 }).limit(500).lean();
  return ok(res, rows);
});

router.patch("/requirements/:id", async (req, res) => {
  const doc = await PurchaseRequirement.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey });
  if (!doc) return fail(res, "Purchase requirement not found", 404);
  if (req.body.requestedQty !== undefined) { doc.requestedQty = Math.max(0, num(req.body.requestedQty)); doc.quantitySource = "MANUAL"; }
  if (["TRIGGERED", "ORDER_SHEET", "HOLD", "IGNORED", "CLOSED"].includes(req.body.status)) doc.status = req.body.status;
  if (req.body.holdUntil !== undefined) doc.holdUntil = asDate(req.body.holdUntil);
  if (req.body.holdReason !== undefined) doc.holdReason = clean(req.body.holdReason);
  doc.updatedBy = req.auth.sub; await doc.save();
  return ok(res, doc, "Requirement updated");
});

router.post("/requirements/:id/generate", async (req, res) => {
  try {
    const doc = await PurchaseRequirement.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey });
    if (!doc) return fail(res, "Purchase requirement not found", 404);
    const financialYear = doc.financialYear || await currentFy(req.auth.tenantKey, req.body.financialYear);
    const [products, metrics, history, pending] = await Promise.all([
      Product.find({ tenantKey: req.auth.tenantKey, status: "ACTIVE" }).lean(),
      salesMetrics(req.auth.tenantKey, financialYear),
      purchaseHistory(req.auth.tenantKey, financialYear),
      pendingPoMap(req.auth.tenantKey),
    ]);
    const trend = classifyTrend(products, metrics);
    const primaryHistory = history.get(String(doc.productId));
    const primaryVendorId = clean(req.body.vendorGlobalId || doc.lastPurchase?.vendorGlobalId || primaryHistory?.last?.vendorGlobalId || doc.vendorSuggestions?.[0]?.vendorGlobalId);
    const candidateRows = [];
    for (const product of products) {
      const pid = String(product._id);
      const c = await buildRequirementCandidate({ product, trendClass: trend.get(pid) || "LOW", metric: metrics.get(pid), pendingPoQty: pending.get(pid) || 0, history: history.get(pid) });
      const dealsWithPrimary = !primaryVendorId || c.lastPurchase?.vendorGlobalId === primaryVendorId || (c.vendorSuggestions || []).some((v) => v.vendorGlobalId === primaryVendorId);
      const nearTrigger = c.effectiveStock <= c.triggerQty * 1.35;
      if (pid === String(doc.productId) || (dealsWithPrimary && nearTrigger)) candidateRows.push(c);
    }
    candidateRows.sort((a,b) => (String(a.productId) === String(doc.productId) ? -1 : String(b.productId) === String(doc.productId) ? 1 : (a.effectiveStock / Math.max(1,a.triggerQty)) - (b.effectiveStock / Math.max(1,b.triggerQty))));
    const toDraft = candidateRows.slice(0, 25).map((r) => ({
      productId: r.productId, sku: r.sku, productName: r.productName, hsnCode: r.hsnCode, unit: r.unit,
      currentStock: r.currentStock, reservedStock: r.reservedStock, availableStock: r.availableStock, incomingPoQty: r.pendingPoQty, effectiveStock: r.effectiveStock,
      trendClass: r.trendClass, triggerPct: r.triggerPct, targetStock: r.targetStock, triggerQty: r.triggerQty, avgDaily30: r.avgDaily30, avgDaily90: r.avgDaily90, salesQty30: r.salesQty30, salesQty90: r.salesQty90, forecast30: r.forecast30, safetyStock: r.safetyStock,
      suggestedQty: r.suggestedQty, requestedQty: r.requestedQty || r.suggestedQty, moq: r.moq, orderMultiple: r.orderMultiple, leadDays: r.leadDays,
      primaryVendorGlobalId: primaryVendorId || r.lastPurchase?.vendorGlobalId || "", primaryVendorName: r.lastPurchase?.vendorName || "", primaryVendorLastRate: r.lastPurchase?.rate || 0,
    }));
    doc.draftItems = toDraft; doc.status = "ORDER_SHEET"; doc.generatedAt = new Date(); doc.updatedBy = req.auth.sub; await doc.save();
    const vendorMap = new Map();
    for (const r of candidateRows) for (const v of r.vendorSuggestions || []) {
      const existing = vendorMap.get(v.vendorGlobalId);
      if (!existing || num(v.purchaseCount) > num(existing.purchaseCount)) vendorMap.set(v.vendorGlobalId, v);
    }
    const vendorSuggestions = [...vendorMap.values()].sort((a, b) => {
      if (a.vendorGlobalId === primaryVendorId) return -1; if (b.vendorGlobalId === primaryVendorId) return 1;
      return num(b.score) - num(a.score);
    });
    return ok(res, { requirement: doc, draftItems: toDraft, vendorSuggestions, primaryVendorGlobalId: primaryVendorId }, `AI order sheet generated with ${toDraft.length} product${toDraft.length === 1 ? "" : "s"}, including same-supplier stock near trigger`);
  } catch (e) { return fail(res, e.message, 400); }
});

router.get("/vendors/:vendorGlobalId/portal-link", async (req, res) => {
  try {
    const vendor = await vendorProfile(req.auth.tenantKey, req.params.vendorGlobalId);
    const { token } = await ensureVendorAccess(req.auth.tenantKey, req.params.vendorGlobalId);
    const url = `${clean(env.frontendUrl).replace(/\/$/, "")}/vendor/portal/${encodeURIComponent(token)}`;
    return ok(res, { vendor, token, url });
  } catch (e) { return fail(res, e.message, 400); }
});

router.post("/rfqs", async (req, res) => {
  try {
    const financialYear = await currentFy(req.auth.tenantKey, req.body.financialYear);
    const items = Array.isArray(req.body.items) ? req.body.items.filter((x) => clean(x.productId) && num(x.requestedQty || x.qty) > 0).map((x) => ({ ...x, requestedQty: num(x.requestedQty || x.qty) })) : [];
    if (!items.length) return fail(res, "Add at least one product to RFQ", 400);
    const vendorIds = [...new Set((req.body.vendorGlobalIds || []).map(clean).filter(Boolean))];
    if (!vendorIds.length) return fail(res, "Select at least one supplier for quotation", 400);
    const vendors = [];
    for (const vendorId of vendorIds) {
      const profile = await vendorProfile(req.auth.tenantKey, vendorId);
      await ensureVendorAccess(req.auth.tenantKey, vendorId);
      vendors.push({ vendorGlobalId: vendorId, vendorName: profile.name, gstin: profile.gstin, contact: { name: profile.name, mobile: profile.mobile, email: profile.email }, creditDays: profile.creditDays, status: "SENT", sentAt: new Date() });
    }
    const requirementIds = (req.body.requirementIds || []).map(String);
    const rfq = await PurchaseRfq.create({ tenantKey: req.auth.tenantKey, financialYear, rfqNo: makeId("RFQ"), requirementIds, items, vendors, status: "OPEN", requiredByDate: asDate(req.body.requiredByDate), deliveryLocation: clean(req.body.deliveryLocation), remarks: clean(req.body.remarks), createdBy: req.auth.sub });
    if (requirementIds.length) await PurchaseRequirement.updateMany({ _id: { $in: requirementIds }, tenantKey: req.auth.tenantKey }, { $set: { status: "RFQ_SENT", updatedBy: req.auth.sub } });
    const links = [];
    for (const v of vendors) { const { token } = await ensureVendorAccess(req.auth.tenantKey, v.vendorGlobalId); links.push({ vendorGlobalId: v.vendorGlobalId, vendorName: v.vendorName, email: v.contact?.email, mobile: v.contact?.mobile, url: `${clean(env.frontendUrl).replace(/\/$/, "")}/vendor/portal/${encodeURIComponent(token)}` }); }
    return ok(res, { rfq, vendorLinks: links }, "RFQ created and vendor portal links prepared", 201);
  } catch (e) { return fail(res, e.message, 400); }
});

router.get("/rfqs", async (req, res) => {
  const filter = { tenantKey: req.auth.tenantKey };
  if (req.query.status && req.query.status !== "ALL") filter.status = req.query.status;
  return ok(res, await PurchaseRfq.find(filter).sort({ createdAt: -1 }).limit(300).lean());
});

router.post("/rfqs/:id/award", async (req, res) => {
  try {
    const rfq = await PurchaseRfq.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey });
    if (!rfq) return fail(res, "RFQ not found", 404);
    const vendorId = clean(req.body.vendorGlobalId);
    const quote = rfq.vendors.find((v) => v.vendorGlobalId === vendorId && v.status === "SUBMITTED");
    if (!quote) return fail(res, "Selected supplier has not submitted a quotation", 409);
    const profile = await vendorProfile(req.auth.tenantKey, vendorId);
    const quoteMap = new Map((quote.quoteItems || []).map((i) => [String(i.productId), i]));
    const items = rfq.items.map((r) => {
      const q = quoteMap.get(String(r.productId)) || {};
      const qty = num(r.requestedQty || r.suggestedQty); const rate = num(q.rate); const discount = clamp(q.discountPct, 0, 100); const gst = num(q.gstRate);
      const taxable = qty * rate * (1 - discount / 100); const tax = taxable * gst / 100;
      return { productId: r.productId, sku: r.sku, productName: r.productName, hsnCode: r.hsnCode, unit: r.unit, orderedQty: qty, confirmedQty: 0, rate, discountPct: discount, gstRate: gst, freight: num(q.freight), landedRate: num(q.landedRate || rate), lineTaxable: round2(taxable), lineTax: round2(tax), lineTotal: round2(taxable + tax) };
    });
    const totalTaxable = round2(items.reduce((s, i) => s + num(i.lineTaxable), 0)); const totalTax = round2(items.reduce((s, i) => s + num(i.lineTax), 0));
    const po = await PurchaseOrderAi.create({ tenantKey: req.auth.tenantKey, financialYear: rfq.financialYear, poNo: makeId("PO"), rfqId: String(rfq._id), rfqNo: rfq.rfqNo, requirementIds: rfq.requirementIds, vendorGlobalId: vendorId, vendorName: profile.name, vendorGstin: profile.gstin, vendorContact: { name: profile.name, mobile: profile.mobile, email: profile.email }, items, totalTaxable, totalTax, grandTotal: round2(totalTaxable + totalTax), landedTotal: num(quote.landedTotal || totalTaxable + totalTax), creditDays: num(quote.creditDays || profile.creditDays), paymentTerms: clean(req.body.paymentTerms), deliveryLocation: clean(req.body.deliveryLocation || rfq.deliveryLocation), requiredByDate: asDate(req.body.requiredByDate || rfq.requiredByDate), status: "PO_SENT", createdBy: req.auth.sub });
    rfq.selectedVendorGlobalId = vendorId; rfq.selectedVendorReason = clean(req.body.reason) || `Selected after quotation comparison. Score ${num(quote.comparisonScore)}.`; rfq.status = "AWARDED"; rfq.awardedBy = req.auth.sub; rfq.awardedAt = new Date(); await rfq.save();
    if (rfq.requirementIds?.length) await PurchaseRequirement.updateMany({ _id: { $in: rfq.requirementIds }, tenantKey: req.auth.tenantKey }, { $set: { status: "PO_CREATED", updatedBy: req.auth.sub } });
    const { token } = await ensureVendorAccess(req.auth.tenantKey, vendorId);
    return ok(res, { purchaseOrder: po, vendorPortalUrl: `${clean(env.frontendUrl).replace(/\/$/, "")}/vendor/portal/${encodeURIComponent(token)}` }, "Supplier awarded and Purchase Order created", 201);
  } catch (e) { return fail(res, e.message, 400); }
});

router.get("/purchase-orders", async (req, res) => {
  const filter = { tenantKey: req.auth.tenantKey }; if (req.query.status && req.query.status !== "ALL") filter.status = req.query.status;
  return ok(res, await PurchaseOrderAi.find(filter).sort({ createdAt: -1 }).limit(500).lean());
});

router.get("/incoming", async (req, res) => {
  const rows = await PurchaseOrderAi.find({ tenantKey: req.auth.tenantKey, status: { $in: ["SUPPLIER_CONFIRMED", "PART_DISPATCHED", "DISPATCHED", "IN_TRANSIT", "PART_RECEIVED", "QC_PENDING", "QC_IN_PROGRESS"] } }).sort({ "shipments.expectedArrival": 1, updatedAt: -1 }).lean();
  return ok(res, rows);
});

router.post("/files", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return fail(res, "File required", 400);
    const meta = await saveUploadedFile({ file: req.file, tenantKey: req.auth.tenantKey, module: "purchase-ai", entityType: clean(req.body.entityType || "EVIDENCE"), entityId: clean(req.body.entityId || makeId("DOC")), uploadedBy: req.auth.sub, access: "PRIVATE" });
    return ok(res, meta, "Purchase evidence uploaded", 201);
  } catch (e) { return fail(res, e.message, 400); }
});

router.post("/purchase-orders/:id/grn", async (req, res) => {
  try {
    const po = await PurchaseOrderAi.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey });
    if (!po) return fail(res, "Purchase Order not found", 404);
    const shipment = req.body.shipmentId ? po.shipments.id(req.body.shipmentId) : po.shipments[po.shipments.length - 1];
    const itemInput = new Map((req.body.items || []).map((i) => [String(i.productId), i]));
    const items = po.items.map((p) => {
      const x = itemInput.get(String(p.productId)) || {};
      const received = Math.max(0, num(x.receivedQty));
      return { productId: p.productId, sku: p.sku, productName: p.productName, dispatchedQty: num(x.dispatchedQty || shipment?.items?.find((s) => s.productId === p.productId)?.qty || p.dispatchedQty), receivedQty: received, acceptedQty: num(x.acceptedQty || received), damagedQty: num(x.damagedQty), rejectedQty: num(x.rejectedQty), shortQty: num(x.shortQty), excessQty: num(x.excessQty), wrongProductQty: num(x.wrongProductQty), remarks: clean(x.remarks), evidenceFileIds: x.evidenceFileIds || [] };
    });
    const grn = await PurchaseGoodsReceipt.create({ tenantKey: req.auth.tenantKey, financialYear: po.financialYear, grnNo: makeId("GRN"), purchaseOrderId: String(po._id), poNo: po.poNo, shipmentId: shipment?._id ? String(shipment._id) : "", vendorGlobalId: po.vendorGlobalId, vendorName: po.vendorName, arrivedAt: asDate(req.body.arrivedAt) || new Date(), warehouseId: clean(req.body.warehouseId), warehouseName: clean(req.body.warehouseName), dispatchedPackages: num(req.body.dispatchedPackages || shipment?.packages), receivedPackages: num(req.body.receivedPackages), packageCondition: req.body.packageCondition || [], items, generalEvidenceFileIds: req.body.generalEvidenceFileIds || [], qcStatus: "IN_PROGRESS", remarks: clean(req.body.remarks) });
    po.status = "QC_IN_PROGRESS"; await po.save();
    return ok(res, grn, "GRN created; QC started", 201);
  } catch (e) { return fail(res, e.message, 400); }
});

router.get("/grns", async (req, res) => {
  const filter = { tenantKey: req.auth.tenantKey }; if (req.query.qcStatus && req.query.qcStatus !== "ALL") filter.qcStatus = req.query.qcStatus;
  return ok(res, await PurchaseGoodsReceipt.find(filter).sort({ createdAt: -1 }).limit(500).lean());
});

router.post("/grns/:id/qc-complete", async (req, res) => {
  try {
    const grn = await PurchaseGoodsReceipt.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey });
    if (!grn) return fail(res, "GRN not found", 404);
    if (Array.isArray(req.body.items)) {
      const map = new Map(req.body.items.map((i) => [String(i.productId), i]));
      grn.items = grn.items.map((it) => { const x = map.get(String(it.productId)); if (!x) return it; return { ...it.toObject(), ...x, receivedQty: num(x.receivedQty), acceptedQty: num(x.acceptedQty), damagedQty: num(x.damagedQty), rejectedQty: num(x.rejectedQty), shortQty: num(x.shortQty), excessQty: num(x.excessQty), wrongProductQty: num(x.wrongProductQty), evidenceFileIds: x.evidenceFileIds || it.evidenceFileIds || [] }; });
    }
    grn.qcStatus = "QC_COMPLETE"; grn.qcCompletedAt = new Date(); grn.qcCompletedBy = req.auth.sub;
    const po = await PurchaseOrderAi.findOne({ _id: grn.purchaseOrderId, tenantKey: req.auth.tenantKey });
    const problematic = grn.items.filter((i) => num(i.damagedQty) + num(i.rejectedQty) + num(i.shortQty) + num(i.wrongProductQty) > 0);
    if (problematic.length) {
      const evidence = [...new Set(problematic.flatMap((i) => i.evidenceFileIds || []))];
      const existing = await PurchaseComplaint.findOne({ tenantKey: req.auth.tenantKey, grnId: String(grn._id), status: { $ne: "CLOSED" } });
      if (!existing) await PurchaseComplaint.create({ tenantKey: req.auth.tenantKey, complaintNo: makeId("CLM"), purchaseOrderId: grn.purchaseOrderId, poNo: grn.poNo, grnId: String(grn._id), grnNo: grn.grnNo, vendorGlobalId: grn.vendorGlobalId, vendorName: grn.vendorName, supplierInvoiceNo: po?.shipments?.[po.shipments.length - 1]?.invoiceNo || "", issueType: "QC_VARIANCE", title: `QC variance against ${grn.poNo}`, description: `Warehouse QC found damage/rejection/shortage in ${problematic.length} product line(s).`, items: problematic, evidenceFileIds: evidence, status: "OPEN", requestedResolution: clean(req.body.requestedResolution || "REPLACEMENT_OR_CREDIT_NOTE"), timeline: [{ at: new Date(), byType: "DMS", byId: req.auth.sub, action: "COMPLAINT_RAISED", note: "Created automatically from warehouse QC." }], createdBy: req.auth.sub });
    }
    const otp = await createOtp({ tenantKey: req.auth.tenantKey, transactionId: String(grn._id), actionType: "WAREHOUSE_PURCHASE_INWARD", recipientId: req.auth.sub, context: { grnNo: grn.grnNo, poNo: grn.poNo } });
    grn.warehouseOtpId = otp.otpId; grn.qcStatus = "INWARD_PENDING"; await grn.save();
    if (po) { po.status = "INWARD_PENDING"; await po.save(); }
    return ok(res, { grn, otpId: otp.otpId, expiresAt: otp.expiresAt, devCode: env.nodeEnv === "production" ? undefined : otp.code }, "QC complete; warehouse OTP generated for Order Desk inward");
  } catch (e) { return fail(res, e.message, 400); }
});

router.post("/grns/:id/inward", async (req, res) => {
  try {
    const grn = await PurchaseGoodsReceipt.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey });
    if (!grn) return fail(res, "GRN not found", 404);
    if (grn.purchaseInvoiceId) return fail(res, "This GRN is already inwarded", 409);
    const vr = await verifyOtp({ otpId: clean(req.body.otpId || grn.warehouseOtpId), code: clean(req.body.code) });
    if (!vr.ok) return fail(res, vr.reason, 400);
    if (vr.challenge.actionType !== "WAREHOUSE_PURCHASE_INWARD" || String(vr.challenge.transactionId) !== String(grn._id)) return fail(res, "OTP is not valid for this GRN", 409);
    const po = await PurchaseOrderAi.findOne({ _id: grn.purchaseOrderId, tenantKey: req.auth.tenantKey });
    if (!po) return fail(res, "Purchase Order not found", 404);
    const products = await Product.find({ tenantKey: req.auth.tenantKey, _id: { $in: grn.items.map((i) => i.productId) } });
    const pmap = new Map(products.map((p) => [String(p._id), p]));
    const rateMap = new Map((req.body.items || []).map((i) => [String(i.productId), i]));
    const poMap = new Map(po.items.map((i) => [String(i.productId), i]));
    const items = [];
    for (const q of grn.items) {
      const accepted = Math.max(0, num(q.acceptedQty)); if (!accepted) continue;
      const p = pmap.get(String(q.productId)); if (!p) return fail(res, `Product not found: ${q.productName}`, 409);
      const pi = poMap.get(String(q.productId)) || {}; const override = rateMap.get(String(q.productId)) || {};
      const rate = num(override.rate ?? pi.rate); const discountPct = clamp(override.discountPct ?? pi.discountPct, 0, 100); const gst = num(override.gstRate ?? pi.gstRate ?? p.gstRate);
      const effectiveRate = round2(rate * (1 - discountPct / 100)); const taxable = round2(accepted * effectiveRate); const tax = round2(taxable * gst / 100);
      items.push({ productId: String(p._id), sku: p.sku, nameSnapshot: p.name, hsnSnapshot: p.hsnCode, qty: accepted, unit: p.basicUnit || p.unit || "PCS", packingUnit: p.packingUnit || "", qtyInBag: num(p.qtyInBag || 1), grossQty: num(p.qtyInBag) > 0 ? round2(accepted / num(p.qtyInBag)) : accepted, rate, discountPct, effectiveRate, taxable, gstRateSnapshot: gst, cgst: round2(tax / 2), sgst: round2(tax / 2), igst: 0, tax, lineTotal: round2(taxable + tax), landedCostSnapshot: num(override.landedRate ?? pi.landedRate ?? effectiveRate) });
    }
    if (!items.length) return fail(res, "No accepted quantity available for inward", 400);
    const date = asDate(req.body.invoiceDate) || po.shipments?.[po.shipments.length - 1]?.invoiceDate || new Date();
    const financialYear = financialYearFromDate(date) || po.financialYear;
    const { PurchaseInvoice, StockMovement } = financialModels(req.auth.tenantKey, financialYear);
    const invoiceNo = clean(req.body.invoiceNo || po.shipments?.[po.shipments.length - 1]?.invoiceNo || makeId("PINV"));
    if (await PurchaseInvoice.exists({ tenantKey: req.auth.tenantKey, financialYear, invoiceNo })) return fail(res, `Purchase invoice ${invoiceNo} already exists`, 409);
    const taxableTotal = round2(items.reduce((s, i) => s + i.taxable, 0)), taxTotal = round2(items.reduce((s, i) => s + i.tax, 0)); const beforeRound = round2(taxableTotal + taxTotal); const grandTotal = Math.round(beforeRound); const roundOff = round2(grandTotal - beforeRound);
    const invoice = await PurchaseInvoice.create({ tenantKey: req.auth.tenantKey, financialYear, invoiceNo, date, supplierGlobalId: po.vendorGlobalId, supplierNameSnapshot: po.vendorName, supplierGstinSnapshot: po.vendorGstin, purchaseType: "GST", items, subtotal: taxableTotal, billDiscount: 0, otherCharges: 0, taxableTotal, taxTotal, roundOff, grandTotal, landedCharges: 0, transportationCost: 0, labourCost: 0, localFreight: 0, miscellaneousCost: 0, landedTax: 0, landedExpensePercentage: 0, maxGstPercentage: 0, remarks: `PO ${po.poNo} / GRN ${grn.grnNo}. Awaiting Accounts posting.`, createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "", status: "INWARD_PENDING_ACCOUNTING", procurementMode: "PO", sourcePurchaseOrderId: String(po._id), sourcePurchaseOrderNo: po.poNo, sourceGrnId: String(grn._id), sourceGrnNo: grn.grnNo, accountingStatus: "PENDING", warehouseOtpVerifiedAt: new Date(), vendorInvoiceFileIds: po.shipments?.[po.shipments.length - 1]?.invoiceFileIds || [] });
    for (const item of items) {
      const p = pmap.get(String(item.productId)); const oldQty = num(p.purchaseQtyAccumulated), oldVal = num(p.purchaseValueAccumulated); const newQty = oldQty + item.qty; const newVal = oldVal + item.qty * item.effectiveRate; const avg = newQty > 0 ? round2(newVal / newQty) : item.effectiveRate;
      await Product.updateOne({ _id: p._id, tenantKey: req.auth.tenantKey }, { $set: { currentStock: round2(num(p.currentStock) + item.qty), purchaseQtyAccumulated: round2(newQty), purchaseValueAccumulated: round2(newVal), averagePurchasePrice: avg, lastPurchasePrice: round2(item.effectiveRate), landedCost: round2(item.landedCostSnapshot || item.effectiveRate) } });
      await StockMovement.create({ tenantKey: req.auth.tenantKey, financialYear, date, productId: String(p._id), type: "PURCHASE_PO_INWARD", qtyIn: item.qty, qtyOut: 0, landedCost: item.landedCostSnapshot || item.effectiveRate, referenceId: invoiceNo });
      const poi = po.items.find((x) => String(x.productId) === String(p._id)); if (poi) { poi.receivedQty = num(poi.receivedQty) + num(grn.items.find((x) => x.productId === String(p._id))?.receivedQty); poi.acceptedQty = num(poi.acceptedQty) + item.qty; poi.damagedQty = num(poi.damagedQty) + num(grn.items.find((x) => x.productId === String(p._id))?.damagedQty); poi.rejectedQty = num(poi.rejectedQty) + num(grn.items.find((x) => x.productId === String(p._id))?.rejectedQty); poi.shortQty = num(poi.shortQty) + num(grn.items.find((x) => x.productId === String(p._id))?.shortQty); }
    }
    grn.warehouseOtpVerifiedAt = new Date(); grn.inwardedAt = new Date(); grn.inwardedBy = req.auth.sub; grn.purchaseInvoiceId = String(invoice._id); grn.purchaseInvoiceNo = invoiceNo; grn.accountingStatus = "PENDING"; grn.qcStatus = "INWARDED"; await grn.save();
    po.status = "ACCOUNTING_PENDING"; po.accountingStatus = "PENDING"; const allDone = po.items.every((i) => num(i.acceptedQty) >= num(i.confirmedQty || i.orderedQty)); if (allDone) po.status = "ACCOUNTING_PENDING"; await po.save();
    return ok(res, { purchaseInvoice: invoice, grn, purchaseOrder: po }, "Warehouse OTP verified; accepted stock inwarded and sent to Accounts", 201);
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.get("/accounts-queue", async (req, res) => {
  const financialYear = await currentFy(req.auth.tenantKey, req.query.financialYear);
  const { PurchaseInvoice } = financialModels(req.auth.tenantKey, financialYear);
  const invoices = await PurchaseInvoice.find({ tenantKey: req.auth.tenantKey, status: "INWARD_PENDING_ACCOUNTING" }).sort({ date: -1, createdAt: -1 }).lean();
  return ok(res, invoices);
});

router.post("/accounts/:invoiceId/post", async (req, res) => {
  try {
    const financialYear = await currentFy(req.auth.tenantKey, req.body.financialYear || req.query.financialYear);
    const { PurchaseInvoice } = financialModels(req.auth.tenantKey, financialYear);
    const invoice = await PurchaseInvoice.findOne({ _id: req.params.invoiceId, tenantKey: req.auth.tenantKey, status: "INWARD_PENDING_ACCOUNTING" });
    if (!invoice) return fail(res, "Pending purchase invoice not found", 404);
    await postBalancedEntries({ tenantKey: req.auth.tenantKey, financialYear, transactionId: invoice.invoiceNo, transactionType: "PURCHASE_INVOICE", date: invoice.date, partyGlobalId: invoice.supplierGlobalId || "", narration: `Purchase Invoice ${invoice.invoiceNo}`, entries: [
      { accountCode: "SYS_PURCHASE", debit: num(invoice.taxableTotal) },
      { accountCode: "SYS_DUTIES_TAXES", debit: num(invoice.taxTotal) },
      { accountCode: "SYS_SUNDRY_CREDITORS", credit: num(invoice.grandTotal) },
      { accountCode: num(invoice.roundOff) >= 0 ? "SYS_INDIRECT_EXPENSE" : "SYS_INDIRECT_INCOME", debit: num(invoice.roundOff) > 0 ? num(invoice.roundOff) : 0, credit: num(invoice.roundOff) < 0 ? Math.abs(num(invoice.roundOff)) : 0 },
    ].filter((x) => num(x.debit) || num(x.credit)) });
    invoice.status = "POSTED"; invoice.accountingStatus = "POSTED"; invoice.accountingPostedAt = new Date(); invoice.accountingPostedBy = req.auth.sub; await invoice.save();
    const po = invoice.sourcePurchaseOrderId ? await PurchaseOrderAi.findOne({ _id: invoice.sourcePurchaseOrderId, tenantKey: req.auth.tenantKey }) : null;
    if (po) { po.accountingStatus = "POSTED"; po.status = "ACCOUNTED"; po.paymentStatus = po.creditDays > 0 ? "DUE" : "DUE"; const due = new Date(invoice.date); due.setDate(due.getDate() + num(po.creditDays)); po.paymentDueDate = due; await po.save(); }
    if (invoice.sourceGrnId) await PurchaseGoodsReceipt.updateOne({ _id: invoice.sourceGrnId, tenantKey: req.auth.tenantKey }, { $set: { accountingStatus: "POSTED" } });
    return ok(res, invoice, "Purchase invoice posted to Accounts/GST");
  } catch (e) { return fail(res, e.message, 400); }
});

router.get("/complaints", async (req, res) => {
  const filter = { tenantKey: req.auth.tenantKey }; if (req.query.status && req.query.status !== "ALL") filter.status = req.query.status;
  return ok(res, await PurchaseComplaint.find(filter).sort({ createdAt: -1 }).limit(500).lean());
});

router.post("/complaints/:id/close", async (req, res) => {
  const c = await PurchaseComplaint.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey }); if (!c) return fail(res, "Complaint not found", 404);
  c.status = "CLOSED"; c.closedAt = new Date(); c.closedBy = req.auth.sub; c.timeline.push({ at: new Date(), byType: "DMS", byId: req.auth.sub, action: "CLOSED", note: clean(req.body.remarks) }); await c.save(); return ok(res, c, "Complaint closed");
});

// ---------------- Public secure Vendor Portal ----------------
async function vendorContext(req, res, next) {
  try { req.vendorPortal = await decodePortalToken(req.params.token); req.ip && await VendorPortalAccess.updateOne({ tenantKey: req.vendorPortal.tenantKey, vendorGlobalId: req.vendorPortal.vendorGlobalId }, { $set: { lastIp: req.ip } }); return next(); }
  catch (e) { return fail(res, e.message, e.statusCode || 401); }
}

vendorRouter.get("/:token/home", vendorContext, async (req, res) => {
  try {
    const { tenantKey, vendorGlobalId } = req.vendorPortal;
    const [vendor, rfqs, purchaseOrders, complaints] = await Promise.all([
      vendorProfile(tenantKey, vendorGlobalId),
      PurchaseRfq.find({ tenantKey, "vendors.vendorGlobalId": vendorGlobalId, status: { $in: ["OPEN", "QUOTATIONS_RECEIVED", "AWARDED"] } }).sort({ createdAt: -1 }).limit(100).lean(),
      PurchaseOrderAi.find({ tenantKey, vendorGlobalId }).sort({ createdAt: -1 }).limit(150).lean(),
      PurchaseComplaint.find({ tenantKey, vendorGlobalId }).sort({ createdAt: -1 }).limit(150).lean(),
    ]);
    const vendorRfqs = rfqs.map((r) => ({ ...r, vendors: (r.vendors || []).filter((v) => v.vendorGlobalId === vendorGlobalId) }));
    return ok(res, { vendor, rfqs: vendorRfqs, purchaseOrders, complaints });
  } catch (e) { return fail(res, e.message, 400); }
});

vendorRouter.post("/:token/documents/extract", vendorContext, upload.single("document"), async (req, res) => {
  try {
    if (!req.file) return fail(res, "Upload a PDF or image", 400);
    const type = upper(req.body.documentType);
    if (!["VENDOR_QUOTATION", "LR_COPY", "SUPPLIER_INVOICE", "SUPPLIER_CREDIT_NOTE"].includes(type)) return fail(res, "Unsupported vendor document type", 400);
    const template = getDocumentTemplate(type); if (!template) return fail(res, "Document template not available", 400);
    const docId = makeId("PODOC");
    const meta = await saveUploadedFile({ file: req.file, tenantKey: req.vendorPortal.tenantKey, module: "purchase-ai", entityType: type, entityId: docId, uploadedBy: `VENDOR:${req.vendorPortal.vendorGlobalId}`, access: "PRIVATE" });
    const extraction = await extractDocument({ file: req.file, template });
    const doc = await PurchaseDocument.create({ tenantKey: req.vendorPortal.tenantKey, vendorGlobalId: req.vendorPortal.vendorGlobalId, documentId: docId, documentType: type, scopeType: clean(req.body.scopeType), scopeId: clean(req.body.scopeId), fileId: meta.fileId, originalName: req.file.originalname, mimeType: req.file.mimetype, extractionEngine: extraction.engine || "", extraction, status: "EXTRACTED", createdByType: "VENDOR", createdBy: req.vendorPortal.vendorGlobalId });
    return ok(res, { documentId: doc.documentId, fileId: meta.fileId, extraction, engine: extraction.engine || "" }, "AI document scan complete; verify extracted fields", 201);
  } catch (e) { return fail(res, e.message, 400); }
});

vendorRouter.get("/:token/files/:fileId", vendorContext, async (req, res) => {
  try {
    if (!await authorizeVendorFile({ ...req.vendorPortal, fileId: req.params.fileId })) return fail(res, "File is not available to this vendor", 403);
    const result = await readFile(req.params.fileId); if (!result) return fail(res, "File not found", 404);
    res.setHeader("Content-Type", result.meta.mimeType || "application/octet-stream"); res.setHeader("Content-Disposition", `inline; filename=\"${String(result.meta.originalName || "document").replace(/\"/g, "")}\"`); return res.send(result.buffer);
  } catch (e) { return fail(res, e.message, 400); }
});

vendorRouter.post("/:token/rfqs/:id/quote", vendorContext, async (req, res) => {
  try {
    const { tenantKey, vendorGlobalId } = req.vendorPortal;
    const rfq = await PurchaseRfq.findOne({ _id: req.params.id, tenantKey, "vendors.vendorGlobalId": vendorGlobalId }); if (!rfq) return fail(res, "RFQ not found", 404);
    const v = rfq.vendors.find((x) => x.vendorGlobalId === vendorGlobalId); if (!v) return fail(res, "Vendor is not invited to this RFQ", 403);
    v.status = "SUBMITTED"; v.submittedAt = new Date(); v.quoteNo = clean(req.body.quoteNo); v.quoteDate = asDate(req.body.quoteDate) || new Date(); v.validityDate = asDate(req.body.validityDate); v.creditDays = num(req.body.creditDays); v.freightTerms = clean(req.body.freightTerms); v.overallFreight = num(req.body.overallFreight); v.expectedDispatchDate = asDate(req.body.expectedDispatchDate); v.expectedDeliveryDate = asDate(req.body.expectedDeliveryDate); v.vendorRemarks = clean(req.body.vendorRemarks); v.quoteItems = Array.isArray(req.body.items) ? req.body.items.map((i) => ({ productId: clean(i.productId), sku: clean(i.sku), productName: clean(i.productName), qty: num(i.qty), unit: clean(i.unit), rate: num(i.rate), discountPct: num(i.discountPct), gstRate: num(i.gstRate), freight: num(i.freight), deliveryDays: num(i.deliveryDays), remarks: clean(i.remarks) })) : [];
    const totals = rfqTotals(v.quoteItems); Object.assign(v, totals); v.quotationFileIds = req.body.quotationFileIds || []; v.aiExtractionId = clean(req.body.aiExtractionId);
    recalcComparison(rfq); const allInvited = rfq.vendors.length; const submitted = rfq.vendors.filter((x) => x.status === "SUBMITTED").length; if (submitted > 0) rfq.status = submitted === allInvited ? "QUOTATIONS_RECEIVED" : "OPEN"; await rfq.save();
    return ok(res, { rfqNo: rfq.rfqNo, status: v.status, comparisonScore: v.comparisonScore }, "Quotation submitted successfully");
  } catch (e) { return fail(res, e.message, 400); }
});

vendorRouter.post("/:token/purchase-orders/:id/confirm", vendorContext, async (req, res) => {
  try {
    const { tenantKey, vendorGlobalId } = req.vendorPortal; const po = await PurchaseOrderAi.findOne({ _id: req.params.id, tenantKey, vendorGlobalId }); if (!po) return fail(res, "Purchase Order not found", 404);
    po.supplierConfirmation = { accepted: req.body.accepted !== false, confirmedAt: new Date(), expectedDispatchDate: asDate(req.body.expectedDispatchDate), expectedDispatchTime: clean(req.body.expectedDispatchTime), expectedArrivalDate: asDate(req.body.expectedArrivalDate), remarks: clean(req.body.remarks) };
    if (Array.isArray(req.body.items)) { const map = new Map(req.body.items.map((i) => [String(i.productId), i])); for (const item of po.items) item.confirmedQty = Math.max(0, num(map.get(String(item.productId))?.confirmedQty ?? item.orderedQty)); } else for (const item of po.items) item.confirmedQty = num(item.orderedQty);
    po.status = req.body.accepted === false ? "SUPPLIER_CHANGE_REQUESTED" : "SUPPLIER_CONFIRMED"; await po.save(); return ok(res, po, req.body.accepted === false ? "Change request sent to buyer" : "Purchase Order confirmed");
  } catch (e) { return fail(res, e.message, 400); }
});

vendorRouter.post("/:token/purchase-orders/:id/dispatch", vendorContext, async (req, res) => {
  try {
    const { tenantKey, vendorGlobalId } = req.vendorPortal; const po = await PurchaseOrderAi.findOne({ _id: req.params.id, tenantKey, vendorGlobalId }); if (!po) return fail(res, "Purchase Order not found", 404);
    if (!clean(req.body.lrNo) && !(req.body.lrFileIds || []).length) return fail(res, "LR/Bilty number or LR copy is required", 400);
    const shipmentNo = makeId("SHP"); const items = Array.isArray(req.body.items) ? req.body.items.map((i) => ({ productId: clean(i.productId), qty: num(i.qty) })) : po.items.map((i) => ({ productId: i.productId, qty: Math.max(0, num(i.confirmedQty || i.orderedQty) - num(i.dispatchedQty)) }));
    po.shipments.push({ shipmentNo, invoiceNo: clean(req.body.invoiceNo), invoiceDate: asDate(req.body.invoiceDate), invoiceAmount: num(req.body.invoiceAmount), invoiceFileIds: req.body.invoiceFileIds || [], lrNo: clean(req.body.lrNo), lrDate: asDate(req.body.lrDate), lrFileIds: req.body.lrFileIds || [], transporterName: clean(req.body.transporterName), transporterId: clean(req.body.transporterId), vehicleNo: clean(req.body.vehicleNo), fromLocation: clean(req.body.fromLocation), destination: clean(req.body.destination), packages: num(req.body.packages), weight: num(req.body.weight), freight: num(req.body.freight), freightMode: clean(req.body.freightMode), dispatchDate: asDate(req.body.dispatchDate) || new Date(), dispatchTime: clean(req.body.dispatchTime), expectedArrival: asDate(req.body.expectedArrival), items, aiExtractionIds: req.body.aiExtractionIds || [], status: "DISPATCHED", submittedAt: new Date() });
    for (const s of items) { const it = po.items.find((x) => String(x.productId) === String(s.productId)); if (it) it.dispatchedQty = num(it.dispatchedQty) + num(s.qty); }
    const fully = po.items.every((i) => num(i.dispatchedQty) >= num(i.confirmedQty || i.orderedQty)); po.status = fully ? "DISPATCHED" : "PART_DISPATCHED"; await po.save(); return ok(res, po, "Dispatch details submitted; warehouse incoming list updated");
  } catch (e) { return fail(res, e.message, 400); }
});

vendorRouter.post("/:token/complaints/:id/respond", vendorContext, async (req, res) => {
  try {
    const { tenantKey, vendorGlobalId } = req.vendorPortal; const c = await PurchaseComplaint.findOne({ _id: req.params.id, tenantKey, vendorGlobalId }); if (!c) return fail(res, "Complaint not found", 404);
    c.vendorResponse = { action: upper(req.body.action), remarks: clean(req.body.remarks), promisedDate: asDate(req.body.promisedDate), responseFileIds: req.body.responseFileIds || [], respondedAt: new Date() };
    if (req.body.creditNote) c.creditNote = { creditNoteNo: clean(req.body.creditNote.creditNoteNo), date: asDate(req.body.creditNote.date), taxableValue: num(req.body.creditNote.taxableValue), tax: num(req.body.creditNote.tax), total: num(req.body.creditNote.total), fileIds: req.body.creditNote.fileIds || [], aiExtractionId: clean(req.body.creditNote.aiExtractionId) };
    c.status = "VENDOR_RESPONDED"; c.timeline.push({ at: new Date(), byType: "VENDOR", byId: vendorGlobalId, action: upper(req.body.action || "RESPONDED"), note: clean(req.body.remarks) }); await c.save(); return ok(res, c, "Complaint response submitted");
  } catch (e) { return fail(res, e.message, 400); }
});

export { vendorRouter };
export default router;
