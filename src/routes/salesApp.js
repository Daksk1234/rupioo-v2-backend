import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import { BankAccount, CustomerSupportTicket, CustomerDamageClaim, CustomerGrade, CustomerLink, CustomerVisit, FileMeta, GenericRecord, GlobalCustomer, Lead, Product, SalesCompetitorIntel, SalesCrmActivity, SalespersonTrip, SalesRoutePlan, Target, User, Pincode, OtpChallenge,CollectionClaim } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { financialModels, postBalancedEntries,financialCollectionExists } from "../services/accountingService.js";
import { hierarchyVisibilityForUser } from "../services/assignmentHierarchyService.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { getDocumentTemplate } from "../config/documentForms.js";
import { extractDocument, enrichExtractedValues } from "../services/documentAiService.js";
import { readFile, saveUploadedFile } from "../services/storageService.js";
import { configuredFinancialYear, financialYearFromDate } from "../utils/financialYear.js";
import orderFlowRoutes from "./orderFlow.js";
import { enrichSalesInvoicesWithCreditState } from "../services/creditNoteRulesService.js";
import {
  getMaxActiveGradeDiscount,
  gradeBasicFromMrp,
  historicalAverageRates,
  mrpBasicExcludingGst,
  priceFromOldDmsLogic,
  purchaseRateOf,
  round2,
} from "../services/oldDmsPricingService.js";
import { buildCustomerReceivableLedger } from "../services/customerReceivableLedgerService.js";
import { dmsAvailableStockMap } from "../services/dmsAvailableStockService.js";
import { createOtp, verifyOtp } from "../services/otpService.js";
import { finalizeSalespersonReceipt } from "../services/salespersonReceiptWorkflowService.js";
import { isReceiptLedgerPosted } from "../services/receiptAccountingRules.js";
import { getIfscMaster, normalizeIfsc } from "../services/ifscMasterService.js";
import { syncChequeForReceipt } from "../services/collectionHubService.js";
import { assertReceiptCustomerLink, assertReceiptOtpParty } from "../utils/collectorReceiptIdentity.js";
import {collectorTerritoryFilter,collectorForCustomerFilter,normalizedCollectorPincodes} from '../services/collectorTerritoryService.js';
import {loadPendingCollections,selectCollectionDocuments,collectionFinancialYears,collectionPaymentFailed} from '../services/pendingCollectionService.js';
import {COLLECTOR_WORKFLOW_VERSION} from '../services/collectorWorkflowVersion.js';

const router = express.Router();
const COLLECTION_EXECUTIVE_ROLES = ["COLLECTION_EXECUTIVE", "COLLECTOR"];
const isCollectionExecutiveRole = (code) => COLLECTION_EXECUTIVE_ROLES.includes(String(code || "").trim().toUpperCase());

// Order Flow is intentionally mounted INSIDE the long-standing /api/sales-app
// router. The original V2 server has always mounted /api/sales-app, so this
// endpoint does not depend on adding a new top-level server route.
router.get("/order-flow/health", (_req, res) => res.json({
  ok: true,
  module: "order-flow",
  build: "2026-09-20-sales-order-existing-router-v3",
  time: new Date().toISOString(),
}));
router.use("/order-flow", orderFlowRoutes);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.use(requireAuth);
// The Collection Executive app reuses the existing audited receipt/cash handover flow.
// Do not grant collection executives access to the other sales-app CRM/order APIs.
router.use(async (req, res, next) => {
  if (!isCollectionExecutiveRole(req.auth?.role)) return next();
  try {
    const active=await User.exists({ _id:req.auth.sub, tenantKey:req.auth.tenantKey, role:{ $in: COLLECTION_EXECUTIVE_ROLES },status:"ACTIVE",loginEnabled:true });
    if(!active)return fail(res,"Collection Executive account has been deactivated",403);
  } catch(e) { return fail(res,"Collection Executive access validation failed",403); }
  const path = req.path;
  const allowed = /^\/cash\/(?:cashier-pickups|assigned-customers|summary|collections|deposit-preview|handover|handovers(?:\/.*)?|day-closing(?:\/.*)?)\/?$/.test(path)
    || /^\/customers\/[^/]+\/(?:receipts|receipt-form)\/?$/.test(path)
    || /^\/receipts\/[^/]+\/(?:customer-otp\/(?:verify|resend)|cancel)\/?$/.test(path)
    || /^\/collector\/(?:receipts|collected|day-wise|assigned-customers|pending-collections(?:\/[^/]+)?)\/?$/.test(path);
  if (!allowed) return fail(res, "Collection Executive access is limited to receipts and cash collection", 403);
  next();
});
router.use(async (req, _res, next) => {
  try { req.defaultFinancialYear = await configuredFinancialYear(req.auth?.tenantKey); next(); }
  catch (error) { next(error); }
});

const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const escapeRx = (v) => clean(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const objectIdText = (v) => /^[a-fA-F0-9]{24}$/.test(clean(v));
const fyOf = (req) => financialYearFromDate(req.body?.date || req.query?.date)
  || clean(req.query.financialYear || req.body?.financialYear)
  || clean(req.defaultFinancialYear);
const startOfDay = (value = new Date()) => {
  const d = new Date(value); d.setHours(0, 0, 0, 0); return d;
};
const addDays = (value, days) => {
  const d = new Date(value); d.setDate(d.getDate() + Math.max(0, Number(days || 0))); return d;
};
const daysBetween = (a, b) => Math.floor((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000);
const primaryContact = (c = {}) => (c.contacts || []).find((x) => x?.primary && x?.active !== false) || (c.contacts || []).find((x) => x?.active !== false) || (c.contacts || [])[0] || {};
const billingAddress = (c = {}) => (c.addresses || []).find((x) => upper(x?.type) === "BILLING") || (c.addresses || [])[0] || {};
const customerName = (c = {}) => clean(c.localName || c.displayIdentifier || "Customer");
const customerMobile = (c = {}) => clean(c.companyContactNumber || c.ownerMobile || primaryContact(c).mobile);
const customerEmail = (c = {}) => clean(primaryContact(c).email);

async function visibility(req) {
  return hierarchyVisibilityForUser(req.auth);
}

async function collectorCustomerFilter(req, extra = {}) {
  const actor = await User.findOne({ _id: req.auth.sub, tenantKey: req.auth.tenantKey, role: { $in: COLLECTION_EXECUTIVE_ROLES }, status: "ACTIVE", loginEnabled: true })
    .select("name collectorPincodes").lean();
  if (!actor) { const err = new Error("Collection Executive account is not active"); err.statusCode = 403; throw err; }
  const filter = { tenantKey: req.auth.tenantKey, status: "ACTIVE", ...extra, ...collectorTerritoryFilter(actor.collectorPincodes) };
  return { filter, scope: { unrestricted: false, userIds: [],assignedPincodeCount:normalizedCollectorPincodes(actor.collectorPincodes).length,
    collectorId:String(actor._id),collectorName:actor.name||'' } };
}

async function visibleCustomerFilter(req, extra = {}) {
  if (isCollectionExecutiveRole(req.auth?.role)) return collectorCustomerFilter(req, extra);
  const filter = { tenantKey: req.auth.tenantKey, status: { $nin: ["INACTIVE", "DEACTIVATED"] }, ...extra };
  const scope = await visibility(req);
  if (!scope.unrestricted) filter.salespersonId = { $in: scope.userIds };
  return { filter, scope };
}

async function requireVisibleCustomer(req, globalId, { activeOnly = true, customerLinkId = "" } = {}) {
  const { filter } = await visibleCustomerFilter(req, { globalCustomerId: clean(globalId) });
  if (activeOnly) filter.status = "ACTIVE";
  // Resolve the exact tenant-local CustomerLink the collector selected.
  // Without this, a stale/duplicate global identifier can select a different
  // company while the mobile UI continues to display the chosen party.
  if (customerLinkId) {
    if (!objectIdText(customerLinkId)) {
      const err = new Error("Invalid selected customer record ID"); err.statusCode = 400; throw err;
    }
    filter._id = customerLinkId;
  }
  const customer = await CustomerLink.findOne(filter).lean();
  if (!customer) {
    const err = new Error("Customer not found or is outside your assigned sales hierarchy");
    err.statusCode = 404;
    throw err;
  }
  return customer;
}

async function globalsFor(ids = []) {
  const unique = [...new Set(ids.map(clean).filter(Boolean))];
  const objectIds = unique.filter(objectIdText);
  if (!unique.length) return new Map();
  const rows = await GlobalCustomer.find({
    $or: [
      { hiddenId: { $in: unique } },
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ],
  }).select("hiddenId legalName tradeName registeredAddress gstins pan mobiles emails globalHealth gstProfile").lean();
  const map = new Map();
  for (const row of rows) {
    map.set(clean(row.hiddenId), row);
    map.set(String(row._id), row);
  }
  return map;
}

function shapeCustomer(c, global = null, financial = {}) {
  const address = billingAddress(c);
  const contact = primaryContact(c);
  const gstin = clean(global?.gstins?.find?.((x) => x?.active !== false)?.value || (clean(c.displayIdentifier).length === 15 ? c.displayIdentifier : ""));
  return {
    id: c.globalCustomerId,
    globalCustomerId: c.globalCustomerId,
    name: customerName(c),
    CompanyName: customerName(c),
    displayIdentifier: c.displayIdentifier,
    gstin,
    gstNumber: gstin,
    pan: clean(global?.pan),
    mobile: customerMobile(c),
    contactNumber: customerMobile(c),
    email: customerEmail(c),
    ownerName: c.ownerName || contact.name || "",
    address: address.address || global?.registeredAddress || "",
    address2: c.address2 || "",
    area: address.area || "",
    city: address.city || "",
    district: address.district || "",
    state: address.state || "",
    pincode: address.pincode || "",
    pinCode: address.pincode || "",
    paymentType: c.paymentType,
    creditDays: num(c.creditDays || c.approvedTerms?.creditDays),
    creditLimit: num(c.creditLimit || c.approvedTerms?.creditLimit),
    graceDays: num(c.graceDays || c.approvedTerms?.graceDays),
    salespersonId: c.salespersonId || "",
    gradeCode: c.gradeCode || "",
    gradeDiscountPct: num(c.gradeDiscountPct),
    customerRating: num(c.customerRating ?? c.rating),
    rating: num(c.customerRating ?? c.rating),
    status: c.status,
    financial: {
      sales: money(financial.sales),
      invoiceCount: num(financial.invoiceCount),
      receipts: money(financial.receipts),
      outstanding: money(financial.outstanding),
      lastInvoiceAt: financial.lastInvoiceAt || null,
      lastReceiptAt: financial.lastReceiptAt || null,
    },
  };
}

function openingSigned(customer, financialYear) {
  const p = customer?.accountingProfile || {};
  if (!num(p.openingBalance)) return 0;
  if (clean(p.financialYear) && clean(p.financialYear) !== clean(financialYear)) return 0;
  return upper(p.openingBalanceType) === "CR" ? -num(p.openingBalance) : num(p.openingBalance);
}

async function liveGradeForSalesCustomer(tenantKey, customer) {
  const code = upper(customer?.gradeCode);
  if (!code) return { code: "", name: "", discountPct: 0 };
  const grade = await CustomerGrade.findOne({ tenantKey, code, status: "ACTIVE" }).select("code name discountPct").lean();
  return grade ? { code: grade.code, name: grade.name || "", discountPct: num(grade.discountPct) } : { code, name: "", discountPct: 0 };
}

async function priceRowsForSalesCustomer({ tenantKey, customer, products, financialYear }) {
  const grade = await liveGradeForSalesCustomer(tenantKey, customer);
  const fy = clean(financialYear);
  const productIds = products.map((p) => String(p._id));
  const [maxDiscount, history, stockByProduct] = await Promise.all([
    getMaxActiveGradeDiscount(tenantKey),
    historicalAverageRates({ tenantKey, financialYear: fy, productIds }).catch(() => ({ sales: new Map(), purchases: new Map() })),
    dmsAvailableStockMap({ tenantKey, financialYear: fy }),
  ]);
  return products.map((p) => {
    const id = String(p._id);
    const saleHistory = history.sales.get(id);
    const purchaseHistory = history.purchases.get(id);
    const marketSalePrice = Number(saleHistory?.averageRate || 0);
    const averagePurchaseRate = Number(purchaseHistory?.averageRate || 0);
    const fallbackPurchase = purchaseRateOf(p);
    const purchaseRate = averagePurchaseRate > 0 ? averagePurchaseRate : fallbackPurchase;
    const landedPrice = Number(p.landedCost || 0) > 0 ? Number(p.landedCost) : Number(purchaseRate || 0);
    const rawMarketProfitPct = landedPrice > 0 && marketSalePrice > 0 ? ((marketSalePrice - landedPrice) / landedPrice) * 100 : 3;
    const exactProfitPercentage = Math.max(3, rawMarketProfitPct);
    const minimumSalePrice = landedPrice > 0 ? round2(landedPrice * (1 + exactProfitPercentage / 100)) : 0;
    const priced = priceFromOldDmsLogic(
      { ...p, salePrice: minimumSalePrice, profitPercentage: exactProfitPercentage },
      maxDiscount,
      { costOverride: landedPrice, saleRateOverride: minimumSalePrice, profitOverride: exactProfitPercentage },
    );
    const gstRate = num(priced.gstRate);
    const mrp = money(priced.mrp);
    const mrpBasic = mrp > 0 ? mrpBasicExcludingGst(mrp, gstRate) : money(minimumSalePrice || p.salePrice);
    const effectiveRate = mrp > 0
      ? gradeBasicFromMrp(mrp, gstRate, grade.discountPct)
      : money(mrpBasic * (1 - Math.min(100, Math.max(0, grade.discountPct)) / 100));
    return {
      productId:id, sku:p.sku, name:p.name, category:p.category||"", subCategory:p.subCategory||"", hsnCode:p.hsnCode||"", gstRate,
      unit:p.basicUnit||"PCS", packingUnit:p.packingUnit||"", qtyInBag:num(p.qtyInBag||1),
      currentStock:stockByProduct.get(id) ?? 0,
      physicalStock:num(p.currentStock), reservedStock:Math.max(0,num(p.reservedStock)), availableStock:stockByProduct.get(id) ?? 0,
      mrp, basicRate:money(mrpBasic), discountPct:money(grade.discountPct), landedPrice:money(landedPrice), marketSalePrice:money(marketSalePrice), minimumSalePrice:money(minimumSalePrice), maxGradeDiscountPct:money(maxDiscount),
      gradeCode:grade.code, gradeName:grade.name, rate:money(effectiveRate), saleIncludingGst:money(effectiveRate*(1+gstRate/100)), pricingFinancialYear:fy, imageFileIds:p.imageFileIds||[],
    };
  });
}

async function keepOnlySalesProductImages(tenantKey, products) {
  const ids = [...new Set(products.flatMap((p) => p.imageFileIds || []).map(clean).filter(Boolean))];
  if (!ids.length) return products.map((p) => ({ ...p, imageFileIds: [], images: [] }));
  const files = await FileMeta.find({ tenantKey, fileId: { $in: ids }, mimeType: { $in: ["image/jpeg", "image/png", "image/webp", "image/avif"] } }).select("fileId originalName mimeType").lean();
  const allowed = new Map(files.map((f) => [String(f.fileId), f]));
  return products.map((p) => {
    const valid = (p.imageFileIds || []).map(clean).filter((id) => allowed.has(id));
    return { ...p, imageFileIds: valid, images: valid.map((id) => ({ fileId:id, originalName:allowed.get(id)?.originalName||"Product image", mimeType:allowed.get(id)?.mimeType||"image/jpeg", url:`/sales-app/product-images/${encodeURIComponent(id)}` })) };
  });
}

async function receivableMap({ tenantKey, financialYear, customerIds }) {
  const ids = [...new Set((customerIds || []).map(clean).filter(Boolean))];
  if (!ids.length) return new Map();
  const { LedgerEntry } = financialModels(tenantKey, financialYear);
  const rows = await LedgerEntry.aggregate([
    { $match: { tenantKey, financialYear, partyGlobalId: { $in: ids }, accountCode: "SYS_SUNDRY_DEBTORS", status: "POSTED" } },
    { $group: { _id: "$partyGlobalId", debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), num(r.debit) - num(r.credit)]));
}


function allocateReceiptsToInvoices(invoices = [], totalReceipts = 0, creditDays = 0) {
  let available = Math.max(0, num(totalReceipts));
  const today = startOfDay(new Date());
  const oldestFirst = [...invoices].sort((a, b) => new Date(a.date) - new Date(b.date));
  return oldestFirst.map((inv) => {
    const grossTotal = Math.max(0, num(inv.grandTotal));
    const credited = Math.max(0, num(inv.creditNoteAmount));
    const total = Math.max(0, num(inv.netInvoiceAmount ?? (grossTotal - credited)));
    const applied = Math.min(total, available);
    available = money(available - applied);
    const outstanding = money(total - applied);
    const dueDate = addDays(inv.date, creditDays);
    const diff = daysBetween(today, dueDate);
    const overdueDays = outstanding > 0 && diff > 0 ? diff : 0;
    const dueInDays = outstanding > 0 && diff < 0 ? Math.abs(diff) : 0;
    return {
      _id: String(inv._id),
      invoiceNo: inv.invoiceNo,
      date: inv.date,
      dueDate,
      total: money(total),
      paidAllocated: money(applied),
      outstanding,
      overdueDays,
      dueInDays,
      status: outstanding <= 0 ? "PAID" : overdueDays > 0 ? "OVERDUE" : diff === 0 ? "DUE_TODAY" : "UPCOMING",
      workflowStatus: inv.workflowStatus || inv.status,
    };
  });
}

async function invoiceOutstandingForCustomer({ tenantKey, financialYear, customer, onlyOpen = false }) {
  const models = financialModels(tenantKey, financialYear);
  const { SalesInvoice } = models;
  const [invoices, ledger] = await Promise.all([
    SalesInvoice.find({ tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" })
      .select("invoiceNo date grandTotal creditNoteAmount netInvoiceAmount workflowStatus status")
      .sort({ date: 1, createdAt: 1 }).lean(),
    buildCustomerReceivableLedger({ tenantKey, financialYear, customer }),
  ]);
  const netInvoices = await enrichSalesInvoicesWithCreditState({ models, tenantKey, financialYear, invoices });
  // Due invoices are determined from the customer ledger, not only from Receipt documents.
  // Sales credit notes are already netted against invoices above, so exclude them here to avoid double allocation.
  const allocatableCredits = money(ledger.rows
    .filter((r) => upper(r.transactionType) !== "SALES_CREDIT_NOTE")
    .reduce((sum, r) => sum + num(r.credit), 0));
  const bills = allocateReceiptsToInvoices(netInvoices, allocatableCredits, customer.creditDays || customer.approvedTerms?.creditDays || 0);
  return onlyOpen ? bills.filter((x) => x.outstanding > 0) : bills;
}

async function productSuggestions({ tenantKey, financialYear, customerGlobalId, limit = 20 }) {
  const { SalesInvoice, SalesOrder } = financialModels(tenantKey, financialYear);
  const [invoices, lastOrder] = await Promise.all([
    SalesInvoice.find({ tenantKey, financialYear, customerGlobalId, status: "POSTED" })
      .select("date items invoiceNo").sort({ date: -1 }).limit(20).lean(),
    SalesOrder.findOne({ tenantKey, financialYear, customerGlobalId, status: { $nin: ["CANCELLED", "REJECTED"] } })
      .sort({ date: -1, createdAt: -1 }).lean(),
  ]);

  const stat = new Map();
  for (const invoice of invoices) {
    for (const item of invoice.items || []) {
      const id = clean(item.productId);
      if (!id) continue;
      const row = stat.get(id) || { productId: id, name: item.nameSnapshot || "", sku: item.sku || "", quantities: [], dates: [], rate: item.rate || item.effectiveRate || 0, count: 0 };
      row.quantities.push(num(item.qty)); row.dates.push(new Date(invoice.date)); row.rate = num(item.rate || item.effectiveRate || row.rate); row.count += 1;
      stat.set(id, row);
    }
  }
  if (!stat.size && lastOrder) {
    for (const item of lastOrder.items || []) {
      const id = clean(item.productId); if (!id) continue;
      stat.set(id, { productId: id, name: item.nameSnapshot || "", sku: item.sku || "", quantities: [num(item.qty)], dates: [new Date(lastOrder.date)], rate: num(item.rate), count: 1 });
    }
  }
  const ids = [...stat.keys()];
  const products = ids.length ? await Product.find({ tenantKey, _id: { $in: ids.filter(objectIdText) }, status: "ACTIVE" }).lean() : [];
  const pm = new Map(products.map((p) => [String(p._id), p]));
  const now = new Date();
  return [...stat.values()].map((row) => {
    row.dates.sort((a, b) => b - a);
    const gaps = [];
    for (let i = 0; i < row.dates.length - 1; i += 1) gaps.push(Math.max(1, daysBetween(row.dates[i], row.dates[i + 1])));
    const avgGapDays = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 30;
    const daysSinceLast = row.dates[0] ? Math.max(0, daysBetween(now, row.dates[0])) : 0;
    const averageQty = row.quantities.length ? Math.max(1, Math.round((row.quantities.reduce((a, b) => a + b, 0) / row.quantities.length) * 100) / 100) : 1;
    const p = pm.get(row.productId) || {};
    const dueRatio = avgGapDays ? daysSinceLast / avgGapDays : 0;
    return {
      productId: row.productId,
      sku: p.sku || row.sku,
      name: p.name || row.name || "Product",
      hsnCode: p.hsnCode || "",
      gstRate: num(p.gstRate),
      unit: p.basicUnit || p.unit || "PCS",
      packingUnit: p.packingUnit || "",
      qtyInBag: num(p.qtyInBag || 1),
      currentStock: num(p.currentStock),
      listRate: num(p.salePrice || row.rate),
      suggestedQty: averageQty,
      lastQty: row.quantities[0] || averageQty,
      purchaseCount: row.count,
      avgGapDays,
      daysSinceLast,
      reorderDue: daysSinceLast >= Math.max(1, avgGapDays),
      score: Math.round((row.count * 12 + Math.min(60, dueRatio * 25)) * 10) / 10,
    };
  }).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, Number(limit || 20))));
}



const validCoord = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;
const customerCoordinates = (customer = {}) => {
  const candidates = [customer.location, ...(customer.addresses || [])];
  for (const row of candidates) {
    const latitude = Number(row?.latitude), longitude = Number(row?.longitude);
    if (validCoord(latitude, longitude)) return { latitude, longitude, accuracy: num(row?.accuracy) || null };
  }
  return null;
};
const haversine = (a, b) => {
  if (!a || !b) return Infinity;
  const lat1 = Number(a.latitude ?? a.lat), lon1 = Number(a.longitude ?? a.lng);
  const lat2 = Number(b.latitude ?? b.lat), lon2 = Number(b.longitude ?? b.lng);
  if (!validCoord(lat1, lon1) || !validCoord(lat2, lon2)) return Infinity;
  const r = 6371000, rad = (v) => v * Math.PI / 180;
  const dLat = rad(lat2-lat1), dLon = rad(lon2-lon1);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*r*Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
};
const routePoint = (raw = {}) => {
  const lat = Number(raw.lat ?? raw.latitude), lng = Number(raw.lng ?? raw.longitude);
  if (!validCoord(lat, lng)) return null;
  return { lat, lng, accuracy: Number.isFinite(Number(raw.accuracy)) ? Number(raw.accuracy) : null, speed: Number.isFinite(Number(raw.speed)) ? Number(raw.speed) : null, heading: Number.isFinite(Number(raw.heading)) ? Number(raw.heading) : null, ts: clean(raw.ts || raw.timestamp) || new Date().toISOString() };
};
const polylineDistance = (points = []) => points.reduce((sum, point, i) => i ? sum + (Number.isFinite(haversine(points[i-1], point)) ? haversine(points[i-1], point) : 0) : sum, 0);
const addDateDays = (date, delta) => { const d = new Date(date); d.setDate(d.getDate()+Number(delta||0)); return d; };
const avg = (rows = []) => rows.length ? rows.reduce((s, x) => s + num(x), 0) / rows.length : 0;
const median = (rows = []) => { const a = rows.map(num).sort((x,y)=>x-y); if (!a.length) return 0; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };

async function customerSalesIntelligence({ tenantKey, financialYear, customer, includeCrossSell = true }) {
  const { SalesInvoice } = financialModels(tenantKey, financialYear);
  const invoices = await SalesInvoice.find({ tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" })
    .select("date grandTotal items invoiceNo").sort({ date: 1, createdAt: 1 }).lean();
  if (!invoices.length) return { lifecycle: { status: "NEW", invoiceCount: 0, confidence: 0 }, reorder: [], upsell: [], crossSell: [], averageOrderValue: 0 };

  const dates = invoices.map((x) => new Date(x.date)).filter((x) => !Number.isNaN(x.getTime()));
  const gaps = [];
  for (let i=1;i<dates.length;i+=1) gaps.push(Math.max(1, daysBetween(dates[i], dates[i-1])));
  const normalGapDays = gaps.length ? Math.max(1, Math.round(median(gaps))) : 30;
  const lastInvoiceAt = dates[dates.length-1];
  const daysSinceLast = Math.max(0, daysBetween(new Date(), lastInvoiceAt));
  const expectedNextAt = addDateDays(lastInvoiceAt, normalGapDays);
  const lateDays = Math.max(0, daysBetween(new Date(), expectedNextAt));
  const variability = gaps.length > 1 ? Math.sqrt(avg(gaps.map((x)=>(x-avg(gaps))**2))) / Math.max(1, avg(gaps)) : .5;
  const confidence = Math.max(30, Math.min(96, Math.round(48 + Math.min(36, invoices.length*6) - Math.min(22, variability*22))));
  let lifecycleStatus = "ACTIVE";
  if (invoices.length >= 2 && daysSinceLast >= Math.max(45, Math.round(normalGapDays*2.2))) lifecycleStatus = "LOST";
  else if (invoices.length >= 2 && daysSinceLast >= Math.max(30, Math.round(normalGapDays*1.5))) lifecycleStatus = "AT_RISK";
  else if (daysSinceLast >= Math.max(7, Math.round(normalGapDays*.9))) lifecycleStatus = "REORDER_DUE";

  const byProduct = new Map();
  for (const invoice of invoices) {
    for (const item of invoice.items || []) {
      const productId=clean(item.productId); if(!productId) continue;
      const row=byProduct.get(productId)||{productId,name:item.nameSnapshot||"Product",sku:item.sku||"",dates:[],qtys:[],rates:[],values:[]};
      row.dates.push(new Date(invoice.date)); row.qtys.push(num(item.qty)); row.rates.push(num(item.rate||item.effectiveRate)); row.values.push(num(item.lineTotal||item.taxable)); byProduct.set(productId,row);
    }
  }
  const productIds=[...byProduct.keys()];
  const prodDocs=productIds.length?await Product.find({tenantKey,_id:{$in:productIds.filter(objectIdText)},status:"ACTIVE"}).select("name sku salePrice basicUnit packingUnit gstRate").lean():[];
  const prodMap=new Map(prodDocs.map((p)=>[String(p._id),p]));
  const reorder=[]; const upsell=[];
  for(const row of byProduct.values()){
    row.dates.sort((a,b)=>a-b);
    const pg=[]; for(let i=1;i<row.dates.length;i+=1)pg.push(Math.max(1,daysBetween(row.dates[i],row.dates[i-1])));
    const gap=pg.length?Math.max(1,Math.round(median(pg))):normalGapDays;
    const last=row.dates[row.dates.length-1], since=Math.max(0,daysBetween(new Date(),last)), next=addDateDays(last,gap), late=Math.max(0,daysBetween(new Date(),next));
    const p=prodMap.get(row.productId)||{}; const averageQty=Math.max(1,Math.round(avg(row.qtys)*100)/100), lastQty=row.qtys[row.qtys.length-1]||averageQty;
    const recent=row.qtys.slice(-3), prior=row.qtys.slice(Math.max(0,row.qtys.length-6),Math.max(0,row.qtys.length-3));
    const growth=prior.length?avg(recent)/Math.max(.01,avg(prior)):1;
    const base={productId:row.productId,name:p.name||row.name,sku:p.sku||row.sku,unit:p.basicUnit||"PCS",purchaseCount:row.dates.length,lastPurchasedAt:last,daysSinceLast:since,avgGapDays:gap,predictedNextAt:next,lateDays:late,averageQty,lastQty,rate:money(p.salePrice||row.rates[row.rates.length-1]||0),gstRate:num(p.gstRate),confidence:Math.max(35,Math.min(96,Math.round(45+Math.min(40,row.dates.length*8)-Math.min(15,(pg.length?Math.abs(avg(pg)-median(pg))/Math.max(1,avg(pg)):0)*30))))};
    if(row.dates.length>=2 && since>=Math.max(5,Math.round(gap*.8))) reorder.push({...base,suggestedQty:averageQty,expectedValue:money(averageQty*base.rate),status:late>0?"OVERDUE":"DUE_SOON",score:Math.round((row.dates.length*10+Math.min(50,since/gap*30)+Math.min(30,late))*10)/10});
    if(row.dates.length>=3 && growth>=1.08) upsell.push({...base,suggestedQty:Math.max(lastQty,Math.ceil(averageQty*1.15)),growthPct:Math.round((growth-1)*1000)/10,reason:"Purchase quantity is trending upward",score:Math.round((growth*35+row.dates.length*5)*10)/10});
  }
  reorder.sort((a,b)=>b.score-a.score); upsell.sort((a,b)=>b.score-a.score);

  const crossSell=[];
  if(includeCrossSell && productIds.length){
    const anchorIds=new Set(productIds); const recentTenant=await SalesInvoice.find({tenantKey,financialYear,status:"POSTED",customerGlobalId:{$ne:customer.globalCustomerId},"items.productId":{$in:productIds}}).select("items").sort({date:-1}).limit(1200).lean();
    let matchingBaskets=0; const co=new Map();
    for(const inv of recentTenant){
      const basket=[...new Set((inv.items||[]).map((i)=>clean(i.productId)).filter(Boolean))];
      if(!basket.some((id)=>anchorIds.has(id))) continue; matchingBaskets+=1;
      for(const item of inv.items||[]){const id=clean(item.productId);if(!id||anchorIds.has(id))continue;const r=co.get(id)||{productId:id,name:item.nameSnapshot||"Product",sku:item.sku||"",count:0,rate:num(item.rate||item.effectiveRate)};r.count+=1;co.set(id,r);}
    }
    const candidateIds=[...co.values()].sort((a,b)=>b.count-a.count).slice(0,20).map((x)=>x.productId);
    const docs=candidateIds.length?await Product.find({tenantKey,_id:{$in:candidateIds.filter(objectIdText)},status:"ACTIVE"}).select("name sku salePrice basicUnit gstRate").lean():[]; const dm=new Map(docs.map((x)=>[String(x._id),x]));
    for(const row of [...co.values()].sort((a,b)=>b.count-a.count).slice(0,10)){const p=dm.get(row.productId)||{};const support=matchingBaskets?row.count/matchingBaskets:0;if(row.count<2||support<.08)continue;crossSell.push({productId:row.productId,name:p.name||row.name,sku:p.sku||row.sku,unit:p.basicUnit||"PCS",rate:money(p.salePrice||row.rate),gstRate:num(p.gstRate),similarCustomerCount:row.count,confidence:Math.min(95,Math.round(support*100)),reason:`Bought by ${row.count} similar customer orders`,suggestedQty:1,score:Math.round((row.count*10+support*100)*10)/10});}
  }
  return {
    lifecycle:{status:lifecycleStatus,invoiceCount:invoices.length,lastInvoiceAt,daysSinceLast,normalGapDays,expectedNextAt,lateDays,confidence,averageOrderValue:money(avg(invoices.map((x)=>x.grandTotal)))},
    reorder:reorder.slice(0,10),upsell:upsell.slice(0,8),crossSell:crossSell.sort((a,b)=>b.score-a.score).slice(0,8),averageOrderValue:money(avg(invoices.map((x)=>x.grandTotal))),
  };
}

function dynamicCustomerActions({ summary = {}, intelligence = {}, visit = null }) {
  const actions=[]; const overdue=num(summary.overdueAmount), outstanding=num(summary.outstanding), creditLimit=num(summary.creditLimit), available=num(summary.availableCredit);
  if(overdue>0) actions.push({key:"COLLECT",label:"Collect Payment",icon:"cash-plus",priority:130,reason:`₹${money(overdue).toLocaleString("en-IN")} overdue`});
  if(intelligence.lifecycle?.status==="LOST") actions.push({key:"VISIT",label:"Recover Customer",icon:"account-reactivate-outline",priority:115,reason:`No order for ${intelligence.lifecycle.daysSinceLast} days`});
  else if(intelligence.lifecycle?.status==="AT_RISK") actions.push({key:"VISIT",label:"Reconnect Customer",icon:"account-alert-outline",priority:108,reason:`Buying cycle is slipping • ${intelligence.lifecycle.daysSinceLast} days since order`});
  if((intelligence.reorder||[]).length) actions.push({key:"ORDER",label:"Reorder Now",icon:"cart-arrow-down",priority:105,reason:`${intelligence.reorder.length} products predicted due`});
  if((intelligence.crossSell||[]).length || (intelligence.upsell||[]).length) actions.push({key:"GROW",label:"Grow Customer",icon:"chart-line",priority:92,reason:`${(intelligence.crossSell||[]).length} cross-sell • ${(intelligence.upsell||[]).length} upsell suggestions`});
  const daysSinceVisit=visit?.startedAt?Math.max(0,daysBetween(new Date(),visit.startedAt)):999;
  if(daysSinceVisit>=21) actions.push({key:"VISIT",label:"Visit Customer",icon:"map-marker-check-outline",priority:88,reason:visit?`Last visit ${daysSinceVisit} days ago`:"No V2 visit recorded"});
  if(creditLimit>0&&available<=Math.max(0,creditLimit*.1)) actions.push({key:"COLLECT",label:"Collect Before Order",icon:"credit-card-alert-outline",priority:125,reason:"Credit nearly exhausted"});
  actions.push({key:"VOICE",label:"Voice Update",icon:"microphone-outline",priority:65,reason:"Speak visit/follow-up notes"});
  if(!actions.some((x)=>x.key==="ORDER")) actions.push({key:"ORDER",label:"Take Order",icon:"cart-plus",priority:60,reason:"Create sales order"});
  if(outstanding<=0&&!actions.some((x)=>x.key==="VISIT")) actions.push({key:"VISIT",label:"Visit",icon:"map-marker-outline",priority:55,reason:"Build relationship"});
  return actions.sort((a,b)=>b.priority-a.priority).slice(0,6);
}

function parseFollowUpDate(text) {
  const t=clean(text).toLowerCase(), now=startOfDay(new Date());
  if(/\btomorrow\b/.test(t)) return addDateDays(now,1);
  const after=t.match(/\b(?:after|in)\s+(\d{1,3})\s+days?\b/); if(after)return addDateDays(now,Number(after[1]));
  const slash=t.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/); if(slash){let y=Number(slash[3]);if(y<100)y+=2000;const d=new Date(y,Number(slash[2])-1,Number(slash[1]));if(!Number.isNaN(d.getTime()))return d;}
  const weekdayNames=["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  for(let i=0;i<weekdayNames.length;i+=1)if(new RegExp(`\\b${weekdayNames[i]}\\b`).test(t)){const d=new Date(now);let delta=(i-d.getDay()+7)%7;if(delta===0)delta=7;d.setDate(d.getDate()+delta);return d;}
  return null;
}

async function parseVoiceCrm({ tenantKey, transcript }) {
  const text=clean(transcript), lower=text.toLowerCase(); if(!text)return {transcript:"",outcome:"",nextFollowUpAt:null,products:[],amount:null,quantity:null,rate:null,tags:[]};
  const products=await Product.find({tenantKey,status:"ACTIVE"}).select("_id name sku salePrice basicUnit").limit(1500).lean();
  const mentions=products.filter((p)=>{const n=clean(p.name).toLowerCase(),sku=clean(p.sku).toLowerCase();return (n.length>=4&&lower.includes(n))||(sku.length>=3&&lower.includes(sku));}).slice(0,10).map((p)=>({productId:String(p._id),name:p.name,sku:p.sku,rate:num(p.salePrice),unit:p.basicUnit||"PCS"}));
  const amountMatch=lower.match(/(?:₹|rs\.?|rupees?|payment|pay|collect(?:ion)?)[\s:,-]*(\d[\d,]*(?:\.\d+)?)/i);
  const rateMatch=lower.match(/(?:rate|price|at)[\s:₹rs.-]*(\d[\d,]*(?:\.\d+)?)/i);
  const qtyMatch=lower.match(/(\d+(?:\.\d+)?)\s*(pcs?|pieces?|boxes?|cartons?|packs?|kg|kgs|reams?)/i);
  let outcome="FOLLOW_UP"; if(/not interested|reject|refused|no requirement/.test(lower))outcome="NOT_INTERESTED";else if(/order|book|confirm|purchase/.test(lower))outcome="ORDER_INTEREST";else if(/payment|pay|collect|cheque|cash/.test(lower))outcome="PAYMENT_FOLLOW_UP";else if(/interested|sample|quotation|quote|price/.test(lower))outcome="INTERESTED";
  const tags=[]; if(mentions.length)tags.push("PRODUCT"); if(amountMatch)tags.push("AMOUNT"); if(qtyMatch)tags.push("QUANTITY"); if(/competitor|supplier|buying from/.test(lower))tags.push("COMPETITOR");
  return {transcript:text,outcome,nextFollowUpAt:parseFollowUpDate(text),products:mentions,amount:amountMatch?money(String(amountMatch[1]).replace(/,/g,"")):null,quantity:qtyMatch?num(qtyMatch[1]):null,quantityUnit:qtyMatch?upper(qtyMatch[2]):"",rate:rateMatch?money(String(rateMatch[1]).replace(/,/g,"")):null,tags};
}

const localDateKey = (value = new Date()) => {
  const d = new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const monthKey = (value = new Date()) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const endOfDay = (value = new Date()) => {
  const d = startOfDay(value); d.setDate(d.getDate() + 1); return d;
};
const collectionOwnerFilter = (userId) => ({
  $or: [
    { collectedBySalespersonId: clean(userId) },
    { collectedBySalespersonId: { $in: [null, ""] }, createdBy: clean(userId) },
    { collectedBySalespersonId: { $exists: false }, createdBy: clean(userId) },
  ],
});
// Receipt ownership is immutable after creation. Viewing another role's receipt
// never authorises deposit, cash counting, OTP submission or cashier handover.
const receiptOwnerId = (receipt) => clean(receipt?.collectedBySalespersonId || receipt?.createdBy);
const RECEIPT_SCOPE_VALUES = new Set(["ME", "OTHER", "ALL"]);
async function receiptViewerScope(req, requested = "ME") {
  const scope = upper(requested || "ME");
  if (!RECEIPT_SCOPE_VALUES.has(scope)) {
    const err = new Error("Invalid receipt creator filter"); err.statusCode = 400; throw err;
  }
  const mine = collectionOwnerFilter(req.auth.sub);
  if (scope === "ME") return mine;

  // Shared visibility requires (1) same tenant, (2) assigned customer and
  // (3) receipt ownership by a user in the OPPOSITE mobile-app role.
  const { filter: customerFilter } = await visibleCustomerFilter(req);
  const customerIds = await CustomerLink.distinct("globalCustomerId", customerFilter);
  const oppositeRoles = isCollectionExecutiveRole(req.auth?.role)
    ? ["SALES_PERSON", "SALES_HEAD", "SALES_MANAGER"]
    : COLLECTION_EXECUTIVE_ROLES;
  const oppositeIds = (await User.distinct("_id", {
    tenantKey: req.auth.tenantKey, role: { $in: oppositeRoles },
  })).map(String);
  const fromOther = oppositeIds.length && customerIds.length ? {
    customerGlobalId: { $in: customerIds },
    $or: [
      { collectedBySalespersonId: { $in: oppositeIds } },
      { collectedBySalespersonId: { $in: [null, ""] }, createdBy: { $in: oppositeIds } },
      { collectedBySalespersonId: { $exists: false }, createdBy: { $in: oppositeIds } },
    ],
  } : { _id: { $in: [] } };
  if (scope === "OTHER") return fromOther;
  return { $or: [mine, fromOther] };
}
const effectiveCashStatus = { $in: ["POSTED", "APPROVED"] };

async function collectionTargetForUser({ tenantKey, financialYear, userId, at = new Date() }) {
  const target = await Target.findOne({ tenantKey, financialYear, level: "USER", entityId: clean(userId), status: { $ne: "CANCELLED" } }).lean();
  const mk = monthKey(at);
  const monthNo = String(new Date(at).getMonth() + 1).padStart(2, "0");
  const fullMonth = new Date(at).toLocaleString("en-US", { month: "long" });
  const shortMonth = new Date(at).toLocaleString("en-US", { month: "short" });
  const monthRow = (target?.monthly || []).find((x) => {
    const key = clean(x?.month).toLowerCase();
    return [mk, monthNo, fullMonth, shortMonth].map((x) => x.toLowerCase()).includes(key);
  });
  const targetAmount = money(num(monthRow?.collection) || (num(target?.annual?.collection) > 0 ? num(target.annual.collection) / 12 : 0));
  const from = new Date(at.getFullYear(), at.getMonth(), 1);
  const to = new Date(at.getFullYear(), at.getMonth() + 1, 1);
  const { Receipt } = financialModels(tenantKey, financialYear);
  const [row] = await Receipt.aggregate([
    { $match: { tenantKey, financialYear, status: "POSTED", date: { $gte: from, $lt: to }, ...collectionOwnerFilter(userId) } },
    { $group: { _id: null, achieved: { $sum: "$amount" } } },
  ]);
  const achieved = money(row?.achieved || 0);
  const remaining = money(Math.max(0, targetAmount - achieved));
  const pct = targetAmount > 0 ? Math.round(Math.min(999, achieved / targetAmount * 100) * 10) / 10 : 0;
  return { month: mk, target: targetAmount, achieved, remaining, achievementPct: pct, configured: targetAmount > 0 };
}

async function cashSummaryForUser({ tenantKey, financialYear, salespersonId, at = new Date() }) {
  const { Receipt, SalespersonCashMovement } = financialModels(tenantKey, financialYear);
  const userId = clean(salespersonId);
  const dayStart = startOfDay(at), dayEnd = endOfDay(at), key = localDateKey(at);
  // Receipts are the source of truth for money collected. In particular, do
  // NOT sum old COLLECTION or other historical movement amounts to determine
  // custody: a collector's current undeposited receipts are authoritative.
  const liveCashReceipts = {
    tenantKey, financialYear, status: "POSTED", mode: "CASH",
    collectionSource: "SALESPERSON_APP", ...collectionOwnerFilter(userId),
  };
  // Once the cashier OTP is VERIFIED, the salesperson has handed over the
  // receipts even if DMS cashier counting/approval is still pending. Count
  // that cash OUT now; an APPROVED handover continues to count exactly once.
  // PENDING OTP and cancelled handovers must never reduce CASH IN HAND.
  const movementScope = {
    tenantKey, financialYear, salespersonId: userId,
    type: { $ne: "COLLECTION" },
    $or: [
      { status: effectiveCashStatus },
      { type: "HANDOVER", status: "PENDING", handoverOtpStatus: "VERIFIED" },
    ],
  };
  // Only an OTP-verified physical handover transfers custody. A legacy
  // APPROVED handover must not subtract the same cash a second time, and
  // historic/manual movement rows cannot hide today's undeposited receipts.
  const verifiedHandoverIds = (await SalespersonCashMovement.distinct('_id', {
    tenantKey, financialYear, salespersonId: userId,
    type: 'HANDOVER', status: { $in: ['PENDING', 'APPROVED', 'POSTED'] },
    handoverOtpStatus: 'VERIFIED',
  })).map(String);
  const custodialCashReceipts = {
    ...liveCashReceipts, customerOtpStatus: 'VERIFIED',
    cashDepositStatus: { $nin: ['DEPOSITED_TO_CASHIER', 'CLOSED', 'DEPOSITED', 'CANCELLED'] },
    $and: [
      { $or: [{ cashDepositStatus: { $ne: 'HANDOVER_PENDING' } },
        { cashDepositBatchId: { $nin: verifiedHandoverIds } }] },
    ],
  };
  const [custodyTotals, receiptTotals, todayMovements, pending, todayReceipts] = await Promise.all([
    Receipt.aggregate([
      { $match: custodialCashReceipts },
      { $group: { _id: null, total: { $sum: '$amount' },
        beforeToday: { $sum: { $cond: [{ $lt: ['$date', dayStart] }, '$amount', 0] } } } },
    ]),
    Receipt.aggregate([
      { $match: liveCashReceipts },
      { $group: {
        _id: null,
        total: { $sum: "$amount" },
        beforeToday: { $sum: { $cond: [{ $lt: ["$date", dayStart] }, "$amount", 0] } },
        collectedToday: { $sum: { $cond: [
          { $and: [{ $gte: ["$date", dayStart] }, { $lt: ["$date", dayEnd] }] },
          "$amount", 0,
        ] } },
      } },
    ]),
    SalespersonCashMovement.find({ ...movementScope, date: { $gte: dayStart, $lt: dayEnd } })
      .sort({ date: -1, createdAt: -1 }).limit(100).lean(),
    SalespersonCashMovement.find({ tenantKey, financialYear, salespersonId: userId, status: "PENDING", type: { $in: ["HANDOVER", "BANK_DEPOSIT"] } })
      .sort({ date: -1, createdAt: -1 }).lean(),
    Receipt.find({ ...liveCashReceipts, date: { $gte: dayStart, $lt: dayEnd } })
      .select("_id receiptNo amount date customerGlobalId partyNameSnapshot").sort({ date: -1, createdAt: -1 }).limit(100).lean(),
  ]);
  const cashReceipts = receiptTotals[0] || {};
  // Physical custody is determined by each original receipt's live status.
  // Movement journals remain for reporting but cannot erase an undeposited
  // collector receipt or create a negative/zero balance from stale entries.
  const netCash = num(custodyTotals[0]?.total);
  const netOpening = num(custodyTotals[0]?.beforeToday);
  // Direct database deletion can also orphan a previously approved handover.
  // Such historical withdrawals must not turn the current displayed cash negative.
  const cashInHand = money(Math.max(0, netCash));
  const openingCash = money(Math.max(0, netOpening));
  const sumType = (type, direction = null) => money(todayMovements
    .filter((row) => row.type === type && (!direction || row.direction === direction))
    .reduce((total, row) => total + num(type === "HANDOVER" ? (row.cashAmount ?? row.amount) : row.amount), 0));
  // Verified handovers are excluded from the live receipt custody totals.
  // Unverified handovers remain physically in hand but are already reserved.
  const pendingHandover = money(pending.filter((row) => row.type === "HANDOVER" && upper(row.handoverOtpStatus) !== "VERIFIED")
    .reduce((total, row) => total + num(row.cashAmount ?? row.amount), 0));
  const pendingBankDeposit = money(pending.filter((row) => row.type === "BANK_DEPOSIT")
    .reduce((total, row) => total + num(row.amount), 0));
  const recentReceipts = todayReceipts.map((receipt) => ({
    _id: String(receipt._id), receiptId: String(receipt._id), receiptNo: receipt.receiptNo,
    date: receipt.date, type: "COLLECTION", direction: "IN", status: "POSTED",
    amount: money(receipt.amount), customerGlobalId: receipt.customerGlobalId,
    customerNameSnapshot: receipt.partyNameSnapshot || "",
  }));
  const recentToday = [...recentReceipts, ...todayMovements]
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10);
  return {
    dayKey: key,
    openingCash,
    cashCollectedToday: money(cashReceipts.collectedToday),
    handoverApprovedToday: sumType("HANDOVER", "OUT"),
    bankDepositApprovedToday: sumType("BANK_DEPOSIT", "OUT"),
    shortageApprovedToday: sumType("SHORTAGE", "OUT"),
    excessApprovedToday: sumType("EXCESS", "IN"),
    adjustmentsInToday: sumType("ADJUSTMENT_IN", "IN"),
    adjustmentsOutToday: sumType("ADJUSTMENT_OUT", "OUT"),
    cashInHand,
    pendingHandover,
    pendingBankDeposit,
    pendingTotal: money(pendingHandover + pendingBankDeposit),
    recentToday,
  };
}

function collectionRange(period = "UNDEPOSITED", at = new Date(), financialYear = "", options = {}) {
  const key = upper(period || "UNDEPOSITED");
  if (key === "UNDEPOSITED") return null;

  // Explicit selections from the salesperson collection filters. Every range
  // is half-open [from, to), within the chosen April-to-March financial year.
  // The old DAY/MONTH/Q1/H1 shortcuts below remain compatible with older apps.
  const fiscalStartYear = Number(String(financialYear).slice(0,4));
  if (!Number.isInteger(fiscalStartYear) || fiscalStartYear < 2000 || fiscalStartYear > 2100) {
    const error = new Error("Select a valid financial year"); error.statusCode = 400; throw error;
  }
  const fyFrom = new Date(fiscalStartYear, 3, 1);
  const fyTo = new Date(fiscalStartYear + 1, 3, 1);
  const invalidPeriod = (message) => { const error = new Error(message); error.statusCode = 400; throw error; };
  if (key === "DATE" || key === "DATE_WISE") {
    const parseDay = (raw) => {
      const match = String(raw || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return null;
      const y = Number(match[1]), m = Number(match[2]), day = Number(match[3]);
      const date = new Date(y, m-1, day);
      return date.getFullYear() === y && date.getMonth() === m-1 && date.getDate() === day ? date : null;
    };
    const from = parseDay(options.fromDate);
    const last = parseDay(options.toDate);
    if (!from || !last) invalidPeriod("Choose valid From Date and To Date (YYYY-MM-DD)");
    if (from > last) invalidPeriod("From Date cannot be after To Date");
    if (from < fyFrom || last >= fyTo) invalidPeriod("Date Wise range must be within the selected financial year");
    const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    return { from, to };
  }
  if (key === "MONTH" && options.month !== undefined) {
    if (!/^(?:[1-9]|1[0-2])$/.test(String(options.month))) invalidPeriod("Invalid selected month");
    const month = Number(options.month) - 1;
    const year = month >= 3 ? fiscalStartYear : fiscalStartYear + 1;
    return { from: new Date(year,month,1), to: new Date(year,month+1,1) };
  }
  if (key === "QUARTER" && options.quarter !== undefined) {
    const quarter = upper(options.quarter);
    if (!/^Q[1-4]$/.test(quarter)) invalidPeriod("Invalid selected quarter");
    const n = Number(quarter.slice(1)) - 1;
    return { from: new Date(fiscalStartYear,3+n*3,1), to: new Date(fiscalStartYear,3+(n+1)*3,1) };
  }
  if ((key === "HALF_YEAR" || key === "HALF-YEAR") && options.half !== undefined) {
    const half = upper(options.half);
    if (!["H1","H2"].includes(half)) invalidPeriod("Invalid selected half year");
    return half === "H1"
      ? {from:new Date(fiscalStartYear,3,1),to:new Date(fiscalStartYear,9,1)}
      : {from:new Date(fiscalStartYear,9,1),to:new Date(fiscalStartYear+1,3,1)};
  }
  if (key === "FY" || key === "YEAR" || key === "YEARLY") return {from:fyFrom,to:fyTo};

  const now = new Date(at);
  // Align relative DAY/MONTH/QUARTER/HALF_YEAR selections with the
  // selected financial year, not necessarily the device's current FY.
  // Example: October selected for FY 2025-26 must query October 2025.
  const targetFYStart = Number(String(financialYear).slice(0, 4));
  const nowFYStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  if (Number.isInteger(targetFYStart) && targetFYStart >= 2000 && targetFYStart <= 2100 && targetFYStart !== nowFYStart) {
    now.setFullYear(now.getFullYear() + targetFYStart - nowFYStart);
  }
  let from; let to;
  if (key === "DAY" || key === "TODAY") {
    from = startOfDay(now); to = endOfDay(now);
  } else if (key === "MONTH") {
    from = new Date(now.getFullYear(), now.getMonth(), 1); to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  } else if (/^Q[1-4]$/.test(key)) {
    const startYear = Number(String(financialYear).slice(0, 4));
    const q = Number(key.slice(1)) - 1;
    from = new Date(startYear, 3 + q * 3, 1);
    to = new Date(startYear, 3 + (q + 1) * 3, 1);
  } else if (key === "H1" || key === "H2") {
    const startYear = Number(String(financialYear).slice(0, 4));
    from = new Date(startYear, key === "H1" ? 3 : 9, 1);
    to = new Date(startYear + (key === "H2" ? 1 : 0), key === "H1" ? 9 : 3, 1);
  } else if (key === "QUARTER") {
    const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const fiscalMonth = (now.getMonth() + 9) % 12;
    const q = Math.floor(fiscalMonth / 3);
    const startMonth = (3 + q * 3) % 12;
    const startYear = startMonth < 3 ? fyStartYear + 1 : fyStartYear;
    from = new Date(startYear, startMonth, 1);
    to = new Date(from.getFullYear(), from.getMonth() + 3, 1);
  } else if (key === "HALF_YEAR" || key === "HALF-YEAR" || key === "HALFYEAR") {
    const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const firstHalf = now.getMonth() >= 3 && now.getMonth() <= 8;
    from = firstHalf ? new Date(fyStartYear, 3, 1) : new Date(fyStartYear, 9, 1);
    to = firstHalf ? new Date(fyStartYear, 9, 1) : new Date(fyStartYear + 1, 3, 1);
  } else {
    const startYear = Number(String(financialYear || "").slice(0, 4)) || (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
    from = new Date(startYear, 3, 1); to = new Date(startYear + 1, 3, 1);
  }
  return { from, to };
}

// Cash and bank receipts remain in hand until their cashier-handover OTP is
// verified. Final DMS cashier receipt/approval happens later and must not
// deduct a second time. Legacy BANK receipts have NOT_APPLICABLE status.
function pendingCashDepositFilter() {
  return { $or: [
    { cashDepositStatus: { $exists: false } },
    { cashDepositStatus: { $in: [null, "", "NOT_APPLICABLE", "AWAITING_RECEIPT_VERIFICATION", "PENDING_TO_DEPOSIT", "HANDOVER_PENDING"] } },
  ] };
}
function bankReceiptPendingFilter() {
  return { mode: "BANK", cashDepositStatus: { $in: ["NOT_APPLICABLE", null, "", "PENDING_TO_DEPOSIT"] } };
}

function cashIssueRows(movements = []) {
  const byReceipt = new Map();
  for (const movement of movements || []) {
    for (const issue of movement.partyIssues || []) {
      if (["RESOLVED", "RESOLVED_BY_SALESPERSON", "CANCELLED"].includes(upper(issue.status))) continue;
      const key = clean(issue.receiptId || issue.receiptNo);
      if (key) byReceipt.set(key, {
        batchId: String(movement._id), movementNo: movement.movementNo,
        issueId: issue.issueId, reason: issue.reason, status: issue.status,
        acknowledgementOtp: issue.acknowledgementOtpCode || "",
        acknowledgementOtpExpiresAt: issue.acknowledgementOtpExpiresAt || null,
      });
    }
  }
  return byReceipt;
}

async function collectionPriorityItems({ tenantKey, financialYear, customers }) {
  const today=startOfDay(new Date());
  const pending=await loadPendingCollections({tenantKey,financialYear,customers});
  const byParty=new Map(pending.map(party=>[String(party.id),party]));
  const rows=await Promise.all(customers.map(async(c)=>{
    const party=byParty.get(String(c.globalCustomerId));
    const bills=(party?.documents||[]).map(document=>{const dueDate=addDays(document.date,c.creditDays||0),diff=daysBetween(today,dueDate);
      return {...document,outstanding:document.outstanding,overdueDays:Math.max(0,diff),status:diff===0?'DUE_TODAY':diff>0?'OVERDUE':'UPCOMING'};});
    const outstanding=money(party?.outstanding||0);
    const overdueAmount=money(bills.filter((x)=>x.overdueDays>0).reduce((sum,x)=>sum+num(x.outstanding),0));
    const dueToday=money(bills.filter((x)=>x.status==="DUE_TODAY").reduce((sum,x)=>sum+num(x.outstanding),0));
    const maxOverdueDays=bills.reduce((m,x)=>Math.max(m,x.overdueDays),0);
    const aging={"0_7":0,"8_15":0,"16_30":0,"31_60":0,"61_90":0,"90_plus":0,opening_or_unallocated:0};
    let invoiceOutstanding=0,oldestPendingDays=0;
    for(const bill of bills){const pendingDays=Math.max(0,daysBetween(today,bill.date));oldestPendingDays=Math.max(oldestPendingDays,pendingDays);aging[pendingAgeBucket(pendingDays)]+=num(bill.outstanding);invoiceOutstanding+=num(bill.outstanding);}
    aging.opening_or_unallocated=money(Math.max(0,outstanding-invoiceOutstanding));
    for(const key of Object.keys(aging)) aging[key]=money(aging[key]);
    const score=Math.round((Math.min(50,overdueAmount/2000)+Math.min(35,maxOverdueDays)+(dueToday>0?12:0))*10)/10;
    return {customer:shapeCustomer(c,null,{outstanding}),outstanding,overdueAmount,dueToday,maxOverdueDays,oldestPendingDays,aging,openBills:bills.length,priorityScore:score,priority:maxOverdueDays>30?"CRITICAL":overdueAmount>0?"HIGH":dueToday>0?"MEDIUM":"NORMAL"};
  }));
  return rows.filter((x)=>x.outstanding>0).sort((a,b)=>b.priorityScore-a.priorityScore);
}

async function opportunityItemsForUser({ req, financialYear, limit = 50, customers: providedCustomers = null, priority: providedPriority = null }) {
  let customers = providedCustomers;
  if (!customers) {
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    customers = await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses creditDays creditLimit accountingProfile salespersonId").lean();
  }
  const ids = customers.map((x) => x.globalCustomerId);
  const customerMap = new Map(customers.map((c) => [c.globalCustomerId, c]));
  const priority = providedPriority || await collectionPriorityItems({ tenantKey: req.auth.tenantKey, financialYear, customers });
  const { SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
  const invoiceStats = ids.length ? await SalesInvoice.aggregate([
    { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" } },
    { $sort: { date: 1, createdAt: 1 } },
    { $group: { _id: "$customerGlobalId", firstDate: { $first: "$date" }, lastDate: { $last: "$date" }, count: { $sum: 1 }, sales: { $sum: "$grandTotal" }, lastInvoiceNo: { $last: "$invoiceNo" }, lastItems: { $last: "$items" } } },
  ]) : [];
  const out = [];
  for (const row of priority.slice(0, 25)) {
    const c = row.customer;
    const amount = row.overdueAmount || row.outstanding;
    out.push({
      id: `COL-${c.id}`,
      type: "COLLECTION",
      score: 120 + row.priorityScore,
      title: "Collection opportunity",
      subtitle: `${c.name} • ${money(amount).toLocaleString("en-IN")} ${row.maxOverdueDays ? `• ${row.maxOverdueDays}d overdue` : ""}`,
      customerGlobalId: c.id,
      customerName: c.name,
      amount,
      action: "COLLECT",
      priority: row.priority,
    });
  }
  const today = startOfDay(new Date());
  for (const st of invoiceStats) {
    const c = customerMap.get(String(st._id)); if (!c) continue;
    const count = num(st.count), span = Math.max(0, daysBetween(st.lastDate, st.firstDate));
    const avgGap = count > 1 ? Math.max(1, Math.round(span / (count - 1))) : 30;
    const daysSince = Math.max(0, daysBetween(today, st.lastDate));
    if (daysSince < Math.max(7, Math.round(avgGap * 0.9))) continue;
    const topItem = [...(st.lastItems || [])].sort((a, b) => num(b.lineTotal) - num(a.lineTotal))[0];
    const overdueBy = Math.max(0, daysSince - avgGap);
    const recovery = count >= 2 && daysSince >= Math.max(30, Math.round(avgGap * 1.8));
    out.push({
      id: `${recovery ? "RECOVERY" : "REORDER"}-${st._id}`,
      type: recovery ? "CUSTOMER_RECOVERY" : "REORDER_DUE",
      score: (recovery ? 108 : 80) + Math.min(40, overdueBy) + Math.min(30, num(st.sales) / 10000),
      title: recovery ? "Recover inactive customer" : "Reorder likely due",
      subtitle: `${customerName(c)} • Last order ${daysSince}d ago • Normal gap ~${avgGap}d${topItem?.nameSnapshot ? ` • ${topItem.nameSnapshot}` : ""}`,
      customerGlobalId: c.globalCustomerId,
      customerName: customerName(c),
      amount: money(num(st.sales) / Math.max(1, count)),
      action: recovery ? "CUSTOMER" : "ORDER",
      orderMode: "SUGGESTED",
      lifecycleStatus: recovery ? "LOST" : "REORDER_DUE",
      predictedNextAt: addDateDays(st.lastDate, avgGap),
      lateDays: overdueBy,
      confidence: Math.max(35, Math.min(95, 45 + count * 7)),
      priority: recovery || overdueBy > 20 ? "HIGH" : "MEDIUM",
    });
  }

  // Growth recommendations are intentionally limited to the strongest active
  // accounts so the Opportunity screen stays quick even with thousands of customers.
  const growthCandidates = [...invoiceStats].sort((a,b)=>num(b.sales)-num(a.sales)).slice(0,6);
  const growthResults = await Promise.all(growthCandidates.map(async (st) => {
    const customer = customerMap.get(String(st._id));
    if (!customer) return null;
    const intelligence = await customerSalesIntelligence({ tenantKey: req.auth.tenantKey, financialYear, customer, includeCrossSell: true });
    const topUpsell = intelligence.upsell?.[0], topCross = intelligence.crossSell?.[0];
    const best = topCross && (!topUpsell || num(topCross.score) >= num(topUpsell.score)) ? { kind:"CROSS_SELL", row:topCross } : topUpsell ? { kind:"UPSELL", row:topUpsell } : null;
    if (!best) return null;
    return {
      id: `${best.kind}-${customer.globalCustomerId}-${best.row.productId}`,
      type: best.kind,
      score: 76 + Math.min(45, num(best.row.score)),
      title: best.kind === "CROSS_SELL" ? "Cross-sell opportunity" : "Upsell opportunity",
      subtitle: `${customerName(customer)} • ${best.row.name} • ${best.kind === "CROSS_SELL" ? best.row.reason : `Suggested qty ${best.row.suggestedQty}`}`,
      customerGlobalId: customer.globalCustomerId, customerName: customerName(customer), productId: best.row.productId,
      amount: money(num(best.row.rate) * num(best.row.suggestedQty || 1)), action: "ORDER", orderMode: "GROW", priority: "MEDIUM",
    };
  }));
  out.push(...growthResults.filter(Boolean));

  const leadScope = await visibility(req);
  const leadFilter = { tenantKey: req.auth.tenantKey, deletedAt: { $exists: false }, stage: { $in: ["NEW", "ASSIGNED", "FOLLOW_UP"] } };
  if (leadScope.isLeaf) leadFilter.assignedUserId = req.auth.sub;
  else if (!leadScope.unrestricted) leadFilter.assignedUserId = { $in: leadScope.userIds || [] };
  const leads = await Lead.find(leadFilter)
    .select("leadId companyName contactPerson mobile pincode priority nextFollowUpAt stage updatedAt assignedUserId").sort({ nextFollowUpAt: 1, updatedAt: 1 }).limit(60).lean();
  for (const lead of leads) {
    const followDue = lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) <= new Date();
    const priorityScore = upper(lead.priority) === "HIGH" ? 35 : upper(lead.priority) === "URGENT" ? 45 : 10;
    out.push({
      id: `LEAD-${lead._id}`,
      type: followDue ? "LEAD_FOLLOW_UP" : "LEAD",
      score: 70 + priorityScore + (followDue ? 25 : 0),
      title: followDue ? "Lead follow-up due" : "Lead opportunity",
      subtitle: `${lead.companyName || lead.contactPerson || "Lead"}${lead.pincode ? ` • ${lead.pincode}` : ""}`,
      leadId: String(lead._id),
      businessLeadId: lead.leadId,
      amount: 0,
      action: "LEAD",
      priority: followDue || priorityScore >= 35 ? "HIGH" : "NORMAL",
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(200, Number(limit || 50))));
}


const normalizeWords = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const digits10 = (v) => clean(v).replace(/\D/g, "").slice(-10);
const tokenSimilarity = (a, b) => {
  const left = new Set(normalizeWords(a).split(/\s+/).filter(Boolean));
  const right = new Set(normalizeWords(b).split(/\s+/).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let common = 0; for (const x of left) if (right.has(x)) common += 1;
  return common / Math.max(left.size, right.size);
};
const duplicateRisk = (score) => score >= 90 ? "BLOCK" : score >= 58 ? "WARN" : "CLEAR";

async function duplicateMatches(req, payload = {}) {
  const companyName = clean(payload.companyName || payload.legalName || payload.name);
  const mobile = digits10(payload.mobile || payload.companyContactNumber || payload.ownerMobile);
  const gstin = upper(payload.gstin);
  const pan = upper(payload.pan || payload.ownerPan);
  const pincode = clean(payload.pincode).replace(/\D/g, "").slice(0, 6);
  const address = clean(payload.address);
  const excludeLeadId = clean(payload.excludeLeadId);
  const excludeCustomerGlobalId = clean(payload.excludeCustomerGlobalId);
  const out = [];

  const leadOr = [];
  if (mobile.length === 10) leadOr.push({ mobile });
  if (companyName) leadOr.push({ companyName: new RegExp(escapeRx(companyName), "i") });
  if (pincode) leadOr.push({ pincode });
  if (leadOr.length) {
    const leadFilter = { tenantKey: req.auth.tenantKey, deletedAt: { $exists: false }, stage: { $nin: ["DELETED", "CANCELLED"] }, $or: leadOr };
    if (objectIdText(excludeLeadId)) leadFilter._id = { $ne: new mongoose.Types.ObjectId(excludeLeadId) };
    const leads = await Lead.find(leadFilter).select("leadId companyName mobile pincode address city state assignedUserId stage").limit(30).lean();
    for (const row of leads) {
      let score = 0; const reasons = [];
      if (mobile && digits10(row.mobile) === mobile) { score += 72; reasons.push("Same mobile number"); }
      const nameSim = tokenSimilarity(companyName, row.companyName);
      if (nameSim >= .95) { score += 38; reasons.push("Same company name"); }
      else if (nameSim >= .65) { score += 22; reasons.push("Similar company name"); }
      if (pincode && clean(row.pincode) === pincode) { score += 14; reasons.push("Same pincode"); }
      if (address && tokenSimilarity(address, row.address) >= .65) { score += 18; reasons.push("Similar address"); }
      score = Math.min(100, score);
      if (score >= 35) out.push({ type:"LEAD", id:String(row._id), publicId:row.leadId, name:row.companyName, mobile:row.mobile, pincode:row.pincode, city:row.city, state:row.state, stage:row.stage, score, risk:duplicateRisk(score), reasons });
    }
  }

  const globalClauses = [];
  if (gstin) globalClauses.push({ "gstins.value": gstin });
  if (pan) globalClauses.push({ pan });
  if (mobile.length === 10) globalClauses.push({ "mobiles.value": mobile });
  const globalRows = globalClauses.length ? await GlobalCustomer.find({ $or: globalClauses }).select("hiddenId legalName tradeName gstins pan mobiles registeredAddress").limit(30).lean() : [];
  const globalIds = globalRows.map((x)=>clean(x.hiddenId)).filter((id)=>id && id !== excludeCustomerGlobalId);
  const linkOr = [];
  if (mobile.length === 10) linkOr.push({ $or: [{ companyContactNumber: mobile }, { ownerMobile: mobile }, { "contacts.mobile": mobile }] });
  if (companyName) linkOr.push({ localName: new RegExp(escapeRx(companyName), "i") });
  if (pincode) linkOr.push({ "addresses.pincode": pincode });
  if (globalIds.length) linkOr.push({ globalCustomerId: { $in: globalIds } });
  if (linkOr.length) {
    const cFilter = { tenantKey: req.auth.tenantKey, status: { $nin: ["INACTIVE", "DEACTIVATED"] }, $or: linkOr };
    if (excludeCustomerGlobalId) cFilter.globalCustomerId = { $ne: excludeCustomerGlobalId };
    const links = await CustomerLink.find(cFilter).select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses status salespersonId").limit(40).lean();
    const gm = await globalsFor(links.map((x)=>x.globalCustomerId));
    for (const row of links) {
      const g = gm.get(row.globalCustomerId) || {};
      const rowMobile = digits10(customerMobile(row));
      const rowGstin = upper(g?.gstins?.find?.((x)=>x?.active !== false)?.value || (clean(row.displayIdentifier).length===15 ? row.displayIdentifier : ""));
      const rowPan = upper(g?.pan);
      let score = 0; const reasons = [];
      if (gstin && rowGstin === gstin) { score += 100; reasons.push("Same GSTIN"); }
      if (pan && rowPan === pan) { score += 92; reasons.push("Same PAN"); }
      if (mobile && rowMobile === mobile) { score += 72; reasons.push("Same mobile number"); }
      const nameSim = tokenSimilarity(companyName, row.localName || g.legalName || g.tradeName);
      if (nameSim >= .95) { score += 38; reasons.push("Same company name"); }
      else if (nameSim >= .65) { score += 22; reasons.push("Similar company name"); }
      const addr = billingAddress(row);
      if (pincode && clean(addr.pincode) === pincode) { score += 14; reasons.push("Same pincode"); }
      if (address && tokenSimilarity(address, addr.address || g.registeredAddress) >= .65) { score += 18; reasons.push("Similar address"); }
      score = Math.min(100, score);
      if (score >= 35) out.push({ type:"CUSTOMER", id:row.globalCustomerId, name:row.localName || g.legalName || "Customer", mobile:rowMobile, gstin:rowGstin, pan:rowPan, pincode:addr.pincode || "", city:addr.city || "", state:addr.state || "", status:row.status, score, risk:duplicateRisk(score), reasons });
    }
  }
  const dedup = new Map();
  for (const row of out.sort((a,b)=>b.score-a.score)) { const key=`${row.type}:${row.id}`; if(!dedup.has(key)) dedup.set(key,row); }
  return [...dedup.values()].slice(0,20);
}

function notificationFromOpportunity(item) {
  const severity = item.priority === "CRITICAL" ? "CRITICAL" : item.priority === "HIGH" ? "HIGH" : "NORMAL";
  return { id:`OPP:${item.id}`, type:item.type, severity, title:item.title, body:item.subtitle, action:item.action, customerGlobalId:item.customerGlobalId || "", leadId:item.leadId || "", amount:num(item.amount), createdAt:new Date().toISOString() };
}

async function roleScope(req) {
  const scope = await visibility(req);
  const user = await User.findOne({_id:req.auth.sub,tenantKey:req.auth.tenantKey,status:"ACTIVE"}).select("_id name role roleId designation department").lean();
  return { scope, user };
}


router.post("/duplicates/check", async (req,res)=>{
  try {
    const matches=await duplicateMatches(req,req.body||{});
    const highest=matches[0]?.score||0;
    return ok(res,{risk:duplicateRisk(highest),score:highest,matches,blocked:highest>=90});
  } catch(error){ return fail(res,error.message,error.statusCode||500); }
});

router.post("/ocr/extract", upload.single("document"), async(req,res)=>{
  try {
    if(!req.file) return fail(res,"Take a photo or choose an image/PDF first",400);
    const documentType=upper(req.body.documentType||"LEAD");
    if(!["LEAD","CUSTOMER","EXPENSE","DELIVERY_PROOF"].includes(documentType)) return fail(res,"Unsupported mobile Scan & Fill document type",400);
    const template=getDocumentTemplate(documentType); if(!template) return fail(res,"Document template not configured",404);
    const allowed=["application/pdf","image/jpeg","image/png","image/webp"];
    if(!allowed.includes(String(req.file.mimetype||"").toLowerCase())) return fail(res,"Use PDF, JPG, PNG or WEBP",400);
    const scanId=makeId("MSCAN");
    const fileMeta=await saveUploadedFile({file:req.file,tenantKey:req.auth.tenantKey,module:"sales-app",entityType:documentType,entityId:scanId,uploadedBy:req.auth.sub,access:"PRIVATE"});
    const raw=await extractDocument({file:req.file,template});
    const extraction=await enrichExtractedValues({tenantKey:req.auth.tenantKey,template,extraction:raw});
    await GenericRecord.create({tenantKey:req.auth.tenantKey,app:"dms",resource:"mobile_document_scan",reference:scanId,title:`${documentType} • ${req.file.originalname||"mobile capture"}`,status:"EXTRACTED",createdBy:req.auth.sub,data:{documentType,fileId:fileMeta.fileId,extraction}});
    const duplicateInput={ companyName:extraction?.values?.legalName||extraction?.values?.companyName, legalName:extraction?.values?.legalName, mobile:extraction?.values?.companyContactNumber||extraction?.values?.ownerMobile||extraction?.values?.mobile, gstin:extraction?.values?.gstin, pan:extraction?.values?.pan||extraction?.values?.ownerPan, pincode:extraction?.values?.pincode, address:extraction?.values?.address };
    const duplicates=await duplicateMatches(req,duplicateInput);
    return ok(res,{scanId,fileId:fileMeta.fileId,documentType,template,extraction,duplicateRisk:duplicateRisk(duplicates[0]?.score||0),duplicates},"Document read. Review all extracted fields before using them.",201);
  }catch(error){ return fail(res,error.message,error.statusCode||400); }
});

router.get("/competitors", async(req,res)=>{
  try{
    const q=clean(req.query.q),customerGlobalId=clean(req.query.customerGlobalId),limit=Math.min(200,Math.max(10,Number(req.query.limit||80)));
    const scope=await visibility(req); const filter={tenantKey:req.auth.tenantKey};
    if(customerGlobalId){ await requireVisibleCustomer(req,customerGlobalId); filter.customerGlobalId=customerGlobalId; }
    if(scope.isLeaf) filter.salespersonId=req.auth.sub; else if(!scope.unrestricted&&scope.userIds?.length) filter.salespersonId={$in:scope.userIds};
    if(q){const rx=new RegExp(escapeRx(q),"i");filter.$or=[{competitorName:rx},{productName:rx},{customerNameSnapshot:rx},{notes:rx}];}
    const rows=await SalesCompetitorIntel.find(filter).sort({capturedAt:-1,createdAt:-1}).limit(limit).lean();
    return ok(res,{items:rows.map(x=>({...x,id:String(x._id)}))});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/competitors", async(req,res)=>{
  try{
    const body=req.body||{}; const competitorName=clean(body.competitorName); if(!competitorName)return fail(res,"Competitor name is required",400);
    const customerGlobalId=clean(body.customerGlobalId); let customer=null;
    if(customerGlobalId) customer=await requireVisibleCustomer(req,customerGlobalId);
    const clientMutationId=clean(body.clientMutationId);
    if(clientMutationId){const existing=await SalesCompetitorIntel.findOne({tenantKey:req.auth.tenantKey,clientMutationId}).lean();if(existing)return ok(res,existing,"Already synced");}
    const me=await User.findOne({_id:req.auth.sub,tenantKey:req.auth.tenantKey}).select("name").lean();
    const doc=await SalesCompetitorIntel.create({tenantKey:req.auth.tenantKey,competitorId:makeId("COMP"),clientMutationId:clientMutationId||undefined,salespersonId:req.auth.sub,salespersonNameSnapshot:me?.name||req.auth.name||"",customerGlobalId,customerNameSnapshot:customer?customerName(customer):clean(body.customerName),leadObjectId:objectIdText(body.leadId)?body.leadId:undefined,competitorName,productId:clean(body.productId),productName:clean(body.productName),quotedRate:money(body.quotedRate),scheme:clean(body.scheme),creditDays:num(body.creditDays),reasonCustomerPrefers:clean(body.reasonCustomerPrefers),strengths:clean(body.strengths),weaknesses:clean(body.weaknesses),notes:clean(body.notes),source:["VOICE","OCR"].includes(upper(body.source))?upper(body.source):"MANUAL",capturedAt:body.capturedAt?new Date(body.capturedAt):new Date(),location:body.location||{},createdBy:req.auth.sub});
    return ok(res,doc,"Competitor intelligence saved",201);
  }catch(error){if(error?.code===11000&&req.body?.clientMutationId){const row=await SalesCompetitorIntel.findOne({tenantKey:req.auth.tenantKey,clientMutationId:req.body.clientMutationId}).lean();if(row)return ok(res,row,"Already synced");}return fail(res,error.message,error.statusCode||400);}
});

router.get("/competitors/summary", async(req,res)=>{
  try{
    const scope=await visibility(req); const match={tenantKey:req.auth.tenantKey};
    if(scope.isLeaf)match.salespersonId=req.auth.sub;else if(!scope.unrestricted&&scope.userIds?.length)match.salespersonId={$in:scope.userIds};
    const rows=await SalesCompetitorIntel.aggregate([{$match:match},{$group:{_id:"$competitorName",mentions:{$sum:1},avgQuotedRate:{$avg:"$quotedRate"},customers:{$addToSet:"$customerGlobalId"},lastSeenAt:{$max:"$capturedAt"}}},{$sort:{mentions:-1}},{$limit:30}]);
    return ok(res,{items:rows.map(x=>({competitorName:x._id,mentions:x.mentions,avgQuotedRate:money(x.avgQuotedRate),customerCount:(x.customers||[]).filter(Boolean).length,lastSeenAt:x.lastSeenAt}))});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/notifications", async(req,res)=>{
  try{
    const financialYear=fyOf(req); const opportunities=await opportunityItemsForUser({req,financialYear,limit:80});
    const notifications=opportunities.slice(0,40).map(notificationFromOpportunity);
    const { SalespersonCashMovement, SalespersonDayClosing, SalesOrder }=financialModels(req.auth.tenantKey,financialYear);
    const [cashPending,closingReview,creditHolds]=await Promise.all([
      SalespersonCashMovement.countDocuments({tenantKey:req.auth.tenantKey,financialYear,salespersonId:req.auth.sub,status:"PENDING"}),
      SalespersonDayClosing.countDocuments({tenantKey:req.auth.tenantKey,financialYear,salespersonId:req.auth.sub,status:"REVIEW_REQUIRED"}),
      SalesOrder.countDocuments({tenantKey:req.auth.tenantKey,financialYear,salespersonId:req.auth.sub,status:"CREDIT_HOLD"}),
    ]);
    if(cashPending)notifications.unshift({id:"CASH:PENDING",type:"CASH_CONTROL",severity:"HIGH",title:"Cash verification pending",body:`${cashPending} cash handover/deposit item(s) are waiting for verification.`,action:"CASH",createdAt:new Date().toISOString()});
    if(closingReview)notifications.unshift({id:"CASH:CLOSING_REVIEW",type:"DAY_CLOSING",severity:"CRITICAL",title:"Day closing needs review",body:`${closingReview} closing variance case(s) are still open.`,action:"CASH",createdAt:new Date().toISOString()});
    if(creditHolds)notifications.unshift({id:"ORDER:CREDIT_HOLD",type:"CREDIT_HOLD",severity:"HIGH",title:"Orders on credit hold",body:`${creditHolds} order(s) are waiting for credit approval.`,action:"ORDERS",createdAt:new Date().toISOString()});
    const counts=notifications.reduce((a,x)=>{a[x.severity]=(a[x.severity]||0)+1;return a;},{});
    return ok(res,{items:notifications.slice(0,60),counts,generatedAt:new Date()});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/ai/next-best-action", async(req,res)=>{
  try{
    const financialYear=fyOf(req); const items=await opportunityItemsForUser({req,financialYear,limit:12}); const best=items[0]||null;
    const signals=items.slice(0,6).map(x=>({type:x.type,score:x.score,priority:x.priority,amount:x.amount||0,customerName:x.customerName||""}));
    const recommendation=best?{...best,why:[best.priority&&`Priority: ${best.priority}`,num(best.amount)>0&&`Commercial value: ₹${money(best.amount).toLocaleString("en-IN")}`,best.type&&`Signal: ${best.type.replaceAll("_"," ")}`].filter(Boolean),confidence:Math.max(55,Math.min(98,Math.round(55+Math.min(43,num(best.score)/4))))}:{title:"No urgent action",subtitle:"No high-priority sales or collection action is waiting.",action:"NONE",confidence:90,why:["Current priority queue is clear"]};
    return ok(res,{engine:"RUPIO_DECISION_ENGINE_V2",financialYear,recommendation,signals,generatedAt:new Date()});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/team/intelligence", async(req,res)=>{
  try{
    const financialYear=fyOf(req), now=new Date(), monthStart=new Date(now.getFullYear(),now.getMonth(),1), monthEnd=new Date(now.getFullYear(),now.getMonth()+1,1);
    const {scope,user}=await roleScope(req);
    if(scope.isLeaf)return fail(res,"Team intelligence is available to Sales Head / Sales Manager roles",403);
    const userIds=scope.unrestricted?[]:(scope.userIds||[]);
    const userFilter={tenantKey:req.auth.tenantKey,status:"ACTIVE"}; if(userIds.length)userFilter._id={$in:userIds}; else if(!scope.unrestricted)userFilter._id={$exists:false};
    const members=await User.find(userFilter).select("_id name email mobile role roleId assignedToUserId coveragePincodes").sort({name:1}).lean();
    const memberIds=members.map(x=>String(x._id));
    const customers=memberIds.length?await CustomerLink.find({tenantKey:req.auth.tenantKey,status:"ACTIVE",salespersonId:{$in:memberIds}}).select("globalCustomerId salespersonId accountingProfile").lean():[];
    const customerIds=customers.map(x=>x.globalCustomerId); const ownerByCustomer=new Map(customers.map(x=>[x.globalCustomerId,String(x.salespersonId||"")]));
    const {SalesInvoice,Receipt}=financialModels(req.auth.tenantKey,financialYear);
    const [invoiceRows,receiptRows,visitRows,leadRows,balanceMap,targets]=await Promise.all([
      customerIds.length?SalesInvoice.aggregate([{$match:{tenantKey:req.auth.tenantKey,financialYear,customerGlobalId:{$in:customerIds},status:"POSTED",date:{$gte:monthStart,$lt:monthEnd}}},{$group:{_id:"$customerGlobalId",sales:{$sum:"$grandTotal"},invoices:{$sum:1}}}]):[],
      memberIds.length?Receipt.aggregate([{$match:{tenantKey:req.auth.tenantKey,financialYear,status:"POSTED",date:{$gte:monthStart,$lt:monthEnd},collectedBySalespersonId:{$in:memberIds}}},{$group:{_id:"$collectedBySalespersonId",collections:{$sum:"$amount"},receipts:{$sum:1}}}]):[],
      memberIds.length ? CustomerVisit.aggregate([
        {
          $match: {
            tenantKey: req.auth.tenantKey,
            salespersonId: { $in: memberIds },
            startedAt: { $gte: monthStart, $lt: monthEnd },
          },
        },
        {
          $group: {
            _id: "$salespersonId",
            visits: { $sum: 1 },
            autoVisits: {
              $sum: {
                $cond: [{ $eq: ["$source", "AUTO_DETECTED"] }, 1, 0],
              },
            },
          },
        },
      ]) : [],
      memberIds.length ? Lead.aggregate([
        {
          $match: {
            tenantKey: req.auth.tenantKey,
            assignedUserId: { $in: memberIds },
            deletedAt: { $exists: false },
          },
        },
        {
          $group: {
            _id: "$assignedUserId",
            leads: { $sum: 1 },
            openLeads: {
              $sum: {
                $cond: [{ $in: ["$stage", ["NEW", "ASSIGNED", "FOLLOW_UP"]] }, 1, 0],
              },
            },
            converted: {
              $sum: {
                $cond: [{ $eq: ["$stage", "CUSTOMER"] }, 1, 0],
              },
            },
          },
        },
      ]) : [],
      receivableMap({tenantKey:req.auth.tenantKey,financialYear,customerIds}),
      Target.find({tenantKey:req.auth.tenantKey,financialYear,level:"USER",entityId:{$in:memberIds},status:{$ne:"CANCELLED"}}).lean(),
    ]);
    const agg=new Map(members.map(m=>[String(m._id),{userId:String(m._id),name:m.name,role:m.role,customers:0,sales:0,invoices:0,collections:0,receipts:0,visits:0,autoVisits:0,leads:0,openLeads:0,converted:0,outstanding:0,target:0}]));
    for(const c of customers){const id=ownerByCustomer.get(c.globalCustomerId);const a=agg.get(id);if(a){a.customers+=1;a.outstanding+=num(balanceMap.get(c.globalCustomerId))+openingSigned(c,financialYear);}}
    for(const r of invoiceRows){const a=agg.get(ownerByCustomer.get(String(r._id)));if(a){a.sales+=num(r.sales);a.invoices+=num(r.invoices);}}
    for(const r of receiptRows){const a=agg.get(String(r._id));if(a){a.collections+=num(r.collections);a.receipts+=num(r.receipts);}}
    for(const r of visitRows){const a=agg.get(String(r._id));if(a){a.visits+=num(r.visits);a.autoVisits+=num(r.autoVisits);}}
    for(const r of leadRows){const a=agg.get(String(r._id));if(a){a.leads+=num(r.leads);a.openLeads+=num(r.openLeads);a.converted+=num(r.converted);}}
    const mk=monthKey(now).toLowerCase(); for(const t of targets){const a=agg.get(String(t.entityId));if(!a)continue;const row=(t.monthly||[]).find(x=>clean(x.month).toLowerCase()===mk);a.target=num(row?.sales)||(num(t.annual?.sales)>0?num(t.annual.sales)/12:0);}
    const rows=[...agg.values()].map(a=>({...a,sales:money(a.sales),collections:money(a.collections),outstanding:money(Math.max(0,a.outstanding)),target:money(a.target),achievementPct:a.target>0?Math.round(a.sales/a.target*1000)/10:0,conversionPct:a.leads>0?Math.round(a.converted/a.leads*1000)/10:0,collectionToSalesPct:a.sales>0?Math.round(a.collections/a.sales*1000)/10:0})).sort((a,b)=>b.sales-a.sales);
    const totals=rows.reduce((x,r)=>({members:x.members+1,customers:x.customers+r.customers,sales:x.sales+r.sales,collections:x.collections+r.collections,outstanding:x.outstanding+r.outstanding,visits:x.visits+r.visits,openLeads:x.openLeads+r.openLeads,converted:x.converted+r.converted,target:x.target+r.target}),{members:0,customers:0,sales:0,collections:0,outstanding:0,visits:0,openLeads:0,converted:0,target:0});
    totals.achievementPct=totals.target>0?Math.round(totals.sales/totals.target*1000)/10:0;
    const attention=rows.filter(r=>r.openLeads>10||r.outstanding>0||(r.target>0&&r.achievementPct<70)).sort((a,b)=>(b.outstanding-a.outstanding)||(a.achievementPct-b.achievementPct)).slice(0,12);
    return ok(res,{role:user?.role||req.auth.role,totals,team:rows,attention,financialYear,month:monthKey(now)});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/customers", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(10, Number(req.query.limit || 50)));
    const q = clean(req.query.q);
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    if (q) {
      const rx = new RegExp(escapeRx(q), "i");
      filter.$or = [{ localName: rx }, { displayIdentifier: rx }, { companyContactNumber: rx }, { ownerMobile: rx }, { "contacts.mobile": rx }, { "addresses.pincode": rx }, { "addresses.city": rx }];
    }
    const [customers, total] = await Promise.all([
      CustomerLink.find(filter).sort({ localName: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      CustomerLink.countDocuments(filter),
    ]);
    const ids = customers.map((x) => x.globalCustomerId);
    const { SalesInvoice, Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const [gm, sales, receipts, ledgers] = await Promise.all([
      globalsFor(ids),
      SalesInvoice.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" } },
        { $group: { _id: "$customerGlobalId", sales: { $sum: "$grandTotal" }, invoiceCount: { $sum: 1 }, lastInvoiceAt: { $max: "$date" } } },
      ]),
      Receipt.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" } },
        { $group: { _id: "$customerGlobalId", receipts: { $sum: "$amount" }, lastReceiptAt: { $max: "$date" } } },
      ]),
      Promise.all(customers.map((c) => buildCustomerReceivableLedger({ tenantKey:req.auth.tenantKey, financialYear, customer:c }))),
    ]);
    const sm = new Map(sales.map((x) => [String(x._id), x]));
    const rm = new Map(receipts.map((x) => [String(x._id), x]));
    const lm = new Map(customers.map((c,i) => [c.globalCustomerId, ledgers[i]]));
    const items = customers.map((c) => {
      const sr = sm.get(c.globalCustomerId) || {}, rr = rm.get(c.globalCustomerId) || {}, ledger = lm.get(c.globalCustomerId);
      return shapeCustomer(c, gm.get(c.globalCustomerId), { ...sr, ...rr, outstanding: money(ledger?.closingSigned) });
    });
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/360", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const customer = await requireVisibleCustomer(req, req.params.globalId);
    const { SalesInvoice, Receipt, SalesOrder } = financialModels(req.auth.tenantKey, financialYear);
    const [gm, salesAgg, receiptAgg, ledger, dueBills, pendingOrderAgg, collectors] = await Promise.all([
      globalsFor([customer.globalCustomerId]),
      SalesInvoice.aggregate([{ $match:{ tenantKey:req.auth.tenantKey, financialYear, customerGlobalId:customer.globalCustomerId, status:"POSTED" } }, { $group:{ _id:null, sales:{ $sum:"$grandTotal" }, invoiceCount:{ $sum:1 }, lastInvoiceAt:{ $max:"$date" } } }]),
      Receipt.aggregate([{ $match:{ tenantKey:req.auth.tenantKey, financialYear, customerGlobalId:customer.globalCustomerId, status:"POSTED" } }, { $group:{ _id:null, receipts:{ $sum:"$amount" }, receiptCount:{ $sum:1 }, lastReceiptAt:{ $max:"$date" } } }]),
      buildCustomerReceivableLedger({ tenantKey:req.auth.tenantKey, financialYear, customer }),
      invoiceOutstandingForCustomer({ tenantKey:req.auth.tenantKey, financialYear, customer, onlyOpen:true }),
      SalesOrder.aggregate([{ $match:{ tenantKey:req.auth.tenantKey, financialYear, customerGlobalId:customer.globalCustomerId, status:{ $in:["SUBMITTED","CREDIT_HOLD","APPROVED","PROCESSING"] } } }, { $group:{ _id:null,total:{ $sum:"$grandTotal" },count:{ $sum:1 } } }]),
      User.find({ tenantKey: req.auth.tenantKey, role: { $in: COLLECTION_EXECUTIVE_ROLES }, status: "ACTIVE", loginEnabled: true,
        ...collectorForCustomerFilter(customer) }).select("_id name mobile").sort({ name: 1 }).lean(),
    ]);
    const sales=salesAgg[0]||{}, receipts=receiptAgg[0]||{};
    const outstanding=money(ledger.closingSigned);
    const overdueAmount=money(dueBills.filter((x)=>x.overdueDays>0).reduce((sum,x)=>sum+num(x.outstanding),0));
    const dueToday=money(dueBills.filter((x)=>x.status==="DUE_TODAY").reduce((sum,x)=>sum+num(x.outstanding),0));
    const pendingOrderExposure=money(pendingOrderAgg[0]?.total||0);
    const creditLimit=money(customer.creditLimit||customer.approvedTerms?.creditLimit||0);
    return ok(res,{
      customer:shapeCustomer(customer,gm.get(customer.globalCustomerId),{...sales,...receipts,outstanding}),
      summary:{ sales:money(sales.sales), invoiceCount:num(sales.invoiceCount), receipts:money(receipts.receipts), receiptCount:num(receipts.receiptCount), outstanding, overdueAmount, dueToday, openBills:dueBills.length, creditLimit, pendingOrderExposure, pendingOrderCount:num(pendingOrderAgg[0]?.count), lastInvoiceAt:sales.lastInvoiceAt||null, lastReceiptAt:receipts.lastReceiptAt||null },
      dueBills:dueBills.slice(0,10), financialYear,
      collectors: collectors.map((u) => ({ id: String(u._id), name: u.name || "Collection Executive", mobile: u.mobile || "" })),
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/intelligence", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const customer = await requireVisibleCustomer(req, req.params.globalId);
    const intelligence = await customerSalesIntelligence({ tenantKey: req.auth.tenantKey, financialYear, customer, includeCrossSell: true });
    return ok(res, { intelligence, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/invoices", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId);
    const page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
    const { SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
    const filter = { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: { $in: ["POSTED", "COMPLETED"] } };
    const [items, total] = await Promise.all([
      SalesInvoice.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SalesInvoice.countDocuments(filter),
    ]);
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/ledger", async (req, res) => {
  try {
    const financialYear=fyOf(req);
    const customer=await requireVisibleCustomer(req,req.params.globalId,{activeOnly:false});
    const page=Math.max(1,Number(req.query.page||1)), limit=Math.min(200,Math.max(20,Number(req.query.limit||100)));
    const ledger=await buildCustomerReceivableLedger({tenantKey:req.auth.tenantKey,financialYear,customer});
    const desc=[...ledger.rows].reverse();
    const total=desc.length;
    const items=desc.slice((page-1)*limit,page*limit);
    return ok(res,{
      customer:{id:customer.globalCustomerId,name:customerName(customer)},
      items,
      summary:{
        openingBalance:money(Math.abs(ledger.openingSigned)), openingBalanceType:ledger.openingSigned<0?"CR":"DR",
        totalDebit:ledger.totalDebit,totalCredit:ledger.totalCredit,
        closingBalance:money(Math.abs(ledger.closingSigned)),closingBalanceType:ledger.closingSigned<0?"CR":"DR",outstanding:money(ledger.closingSigned),
      },
      meta:pageMeta(page,limit,total),financialYear,
    });
  } catch(error){ return fail(res,error.message,error.statusCode||500); }
});

router.get("/customers/:globalId/due-bills",async(req,res)=>{
 try{
  const financialYear=fyOf(req),customer=await requireVisibleCustomer(req,req.params.globalId);
  const party=(await loadPendingCollections({tenantKey:req.auth.tenantKey,financialYear,customers:[customer]}))[0];
  const documents=party.documents.map(document=>({...document,_id:document.id,invoiceNo:document.number,paidAllocated:document.paid,
   dueDate:addDays(document.date,customer.creditDays||0),overdueDays:Math.max(0,daysBetween(new Date(),addDays(document.date,customer.creditDays||0))),
   hasReceipt:document.reserved>0,receiptCount:document.pendingReceipts.length}));
  const items=documents.filter(document=>!document.hasReceipt);
  return ok(res,{financialYear,customer:{id:party.id,name:party.name},items,orders:items.filter(row=>row.kind==='ORDER'),
   summary:{outstanding:party.outstanding,invoiceOutstanding:party.outstanding,totalBillValue:money(items.reduce((sum,row)=>sum+row.total,0)),
    overdue:money(documents.filter(row=>row.overdueDays>0).reduce((sum,row)=>sum+row.outstanding,0)),openBills:documents.length,noReceiptBills:items.length},
   filterMode:'LIVE_DOCUMENT_BALANCES'});
 }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/products", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const customerId = clean(req.query.customerGlobalId);
    if (!customerId) return fail(res, "customerGlobalId is required for customer-specific pricing", 400);
    const customer = await requireVisibleCustomer(req, customerId, { activeOnly: false });
    const q = clean(req.query.q), page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 50)));
    const filter = { tenantKey: req.auth.tenantKey, status: "ACTIVE" };
    if (q) { const rx = new RegExp(escapeRx(q), "i"); filter.$or = [{ name: rx }, { sku: rx }, { category: rx }, { subCategory: rx }, { hsnCode: rx }]; }
    if (clean(req.query.category)) filter.category = clean(req.query.category);
    const [rows, total, categories] = await Promise.all([
      Product.find(filter).select("sku name category subCategory hsnCode gstRate basicUnit packingUnit qtyInBag currentStock reservedStock mrp salePrice landedCost averagePurchasePrice lastPurchasePrice openingRate minimumProfitPct profitPercentage imageFileIds").sort({ category:1, name:1 }).skip((page-1)*limit).limit(limit).lean(),
      Product.countDocuments(filter),
      Product.distinct("category", { tenantKey:req.auth.tenantKey, status:"ACTIVE" }),
    ]);
    const pricedRaw = await priceRowsForSalesCustomer({ tenantKey:req.auth.tenantKey, customer, products:rows, financialYear });
    const items = await keepOnlySalesProductImages(req.auth.tenantKey, pricedRaw);
    return ok(res, { items, categories:categories.filter(Boolean).sort(), financialYear, meta:pageMeta(page,limit,total) });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cart/reprice", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const customer = await requireVisibleCustomer(req, req.body.customerGlobalId, { activeOnly:false });
    const productIds = [...new Set((Array.isArray(req.body.productIds) ? req.body.productIds : []).map(clean).filter(objectIdText))].slice(0, 250);
    if (!productIds.length) return ok(res, { items:[], financialYear });
    const products = await Product.find({ tenantKey:req.auth.tenantKey, _id:{ $in:productIds }, status:"ACTIVE" })
      .select("sku name category subCategory hsnCode gstRate basicUnit packingUnit qtyInBag currentStock reservedStock mrp salePrice landedCost averagePurchasePrice lastPurchasePrice openingRate minimumProfitPct profitPercentage imageFileIds")
      .lean();
    const pricedRaw = await priceRowsForSalesCustomer({ tenantKey:req.auth.tenantKey, customer, products, financialYear });
    const items = await keepOnlySalesProductImages(req.auth.tenantKey, pricedRaw);
    return ok(res, { items, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/product-images/:fileId", async (req, res) => {
  try {
    const fileId = clean(req.params.fileId);
    if (!fileId) return fail(res, "Product image not found", 404);
    const product = await Product.findOne({ tenantKey:req.auth.tenantKey, status:"ACTIVE", imageFileIds:fileId }).select("_id imageFileIds").lean();
    if (!product) return fail(res, "Product image not available", 404);
    const meta = await FileMeta.findOne({ tenantKey:req.auth.tenantKey, fileId, mimeType:{ $in:["image/jpeg","image/png","image/webp","image/avif"] } }).lean();
    if (!meta) return fail(res, "Product image not found", 404);
    const result = await readFile(fileId);
    if (!result?.buffer) return fail(res, "Product image not found", 404);
    res.setHeader("Content-Type", result.meta?.mimeType || meta.mimeType || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.send(result.buffer);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/orders", async (req, res) => {
  try {
    const financialYear = fyOf(req), page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
    const { SalesOrder } = financialModels(req.auth.tenantKey, financialYear); const { filter: customerFilter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    const visible = await CustomerLink.find(customerFilter).select("globalCustomerId").lean(); const ids = visible.map((x) => x.globalCustomerId);
    const filter = { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids } }; if (req.query.customerGlobalId) filter.customerGlobalId = clean(req.query.customerGlobalId); if (req.query.status) filter.status = upper(req.query.status);
    const [items, total] = await Promise.all([SalesOrder.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SalesOrder.countDocuments(filter)]);
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/orders/last/:globalId", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId); const { SalesOrder, SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
    const order = await SalesOrder.findOne({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: { $nin: ["CANCELLED", "REJECTED"] } }).sort({ date: -1, createdAt: -1 }).lean();
    if (order) return ok(res, { source: "ORDER", order });
    const invoice = await SalesInvoice.findOne({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" }).sort({ date: -1, createdAt: -1 }).lean();
    return ok(res, { source: invoice ? "INVOICE" : "NONE", invoice: invoice || null });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/orders/suggestions/:globalId", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId); const items = await productSuggestions({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, limit: Number(req.query.limit || 20) });
    return ok(res, { items, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/orders", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.body.customerGlobalId); const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rawItems.length) return fail(res, "Add at least one product to the order", 400);
    const ids = [...new Set(rawItems.map((x) => clean(x.productId)).filter(objectIdText))];
    const products = await Product.find({ tenantKey: req.auth.tenantKey, _id: { $in: ids }, status: "ACTIVE" }).lean();
    const pricedProducts = await priceRowsForSalesCustomer({ tenantKey:req.auth.tenantKey, customer, products, financialYear });
    const pm = new Map(pricedProducts.map((p) => [String(p.productId), p]));
    const isDmsOrder = upper(req.body.orderChannel) === "DMS_WEB";
    if (isDmsOrder && !isAdminAuth(req.auth))
      return fail(res, "Only an administrator may create a DMS website order", 403);
    const items = []; let subtotal = 0, discountTotal = 0, taxTotal = 0, grandTotal = 0;
    for (const row of rawItems) {
      const p = pm.get(clean(row.productId));
      if (!p) return fail(res, `Product ${row.productId || ""} is not available`, 400);
      const qty = num(row.qty); if (qty <= 0) continue;
      // Mobile orders continue using their existing live product-grade rules.
      // DMS orders save customer Grade in gradeDiscountPct and optional extra
      // Disc % in discountPct. Never re-map Grade into the extra Disc field.
      const gradePct = Math.min(100, Math.max(0, num(p.discountPct)));
      const listRate = isDmsOrder ? money(Math.max(0, num(row.listRate ?? row.rate ?? p.basicRate))) : money(p.basicRate);
      const rate = isDmsOrder ? money(listRate * (1 - gradePct / 100)) : money(p.rate);
      const discountPct = isDmsOrder ? Math.min(100, Math.max(0, num(row.discountPct))) : gradePct;
      const gross = money(qty * listRate);
      const taxable = isDmsOrder
        ? money(qty * money(rate * (1 - discountPct / 100)))
        : money(gross - money(gross * discountPct / 100));
      const discount = money(gross - taxable);
      const gstRate = num(p.gstRate);
      const tax = money(taxable * gstRate / 100);
      const lineTotal = money(taxable + tax);
      subtotal += gross; discountTotal += discount; taxTotal += tax; grandTotal += lineTotal;
      items.push({ productId:p.productId, sku:p.sku, nameSnapshot:p.name, hsnSnapshot:p.hsnCode, qty, unit:p.unit||"PCS", packingUnit:p.packingUnit||"", qtyInBag:num(p.qtyInBag||1), listRate, rate,
        ...(isDmsOrder ? { gradeDiscountPct: gradePct } : {}),
        discountPct, taxable, gstRateSnapshot:gstRate, tax, lineTotal });
    }
    subtotal=money(subtotal); discountTotal=money(discountTotal); taxTotal=money(taxTotal); grandTotal=money(grandTotal);
    if (!items.length) return fail(res, "Enter quantity for at least one product", 400);
    const { SalesOrder, OrderEvent, OrderNotification } = financialModels(req.auth.tenantKey, financialYear);
    const [receivableLedger, pendingAgg] = await Promise.all([
      buildCustomerReceivableLedger({ tenantKey:req.auth.tenantKey, financialYear, customer }),
      SalesOrder.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: { $in: ["SUBMITTED", "CREDIT_HOLD", "APPROVED", "PROCESSING"] } } },
        { $group: { _id: null, total: { $sum: "$grandTotal" } } },
      ]),
    ]);
    const receivableBeforeOrder = money(receivableLedger.closingSigned);
    const pendingOrderExposure = money(pendingAgg[0]?.total || 0);
    const creditLimit = money(customer.creditLimit || customer.approvedTerms?.creditLimit || 0);
    const projectedExposure = money(Math.max(0, receivableBeforeOrder) + pendingOrderExposure + grandTotal);
    const availableBeforeOrder = creditLimit > 0 ? money(Math.max(0, creditLimit - Math.max(0, receivableBeforeOrder) - pendingOrderExposure)) : 0;
    const exceededBy = creditLimit > 0 ? money(Math.max(0, projectedExposure - creditLimit)) : 0;
    const creditHold = creditLimit > 0 && exceededBy > 0;
    let orderNo = clean(req.body.orderNo) || makeId("SO");
    while (await SalesOrder.exists({ tenantKey: req.auth.tenantKey, financialYear, orderNo })) orderNo = makeId("SO");
    const requestedChannel = upper(req.body.orderChannel);
    const orderChannel = ["DMS", "DMS_WEB", "CUSTOMER", "SALESPERSON_ON_BEHALF"].includes(requestedChannel)
      ? requestedChannel
      : "SALESPERSON_ON_BEHALF";
    const customerOtpRequired = orderChannel === "SALESPERSON_ON_BEHALF";

    // Website-created DMS orders must carry a valid active warehouse. Existing mobile/app
    // orders remain backward compatible and are not forced to send a warehouse.
    const warehouseId = clean(req.body.warehouseId);
    let warehouse = null;
    if (warehouseId) {
      if (!objectIdText(warehouseId)) return fail(res, "Invalid warehouse selected", 400);
      warehouse = await GenericRecord.findOne({
        _id: warehouseId,
        tenantKey: req.auth.tenantKey,
        app: "dms",
        resource: "warehouses",
        status: "ACTIVE",
      }).select("title reference name value").lean();
      if (!warehouse) return fail(res, "Selected warehouse is not active or does not exist", 400);
    }
    if (orderChannel === "DMS_WEB" && !warehouse) return fail(res, "Warehouse is required for a website-created order", 400);

    const workflowStatus = creditHold ? "CREDIT_HOLD" : customerOtpRequired ? "OTP_PENDING" : "ORDER_PLACED";
    const order = await SalesOrder.create({
      tenantKey: req.auth.tenantKey,
      financialYear,
      orderNo,
      date: req.body.date ? new Date(req.body.date) : new Date(),
      customerGlobalId: customer.globalCustomerId,
      customerNameSnapshot: customerName(customer),
      salespersonId: clean(customer.salespersonId || req.auth.sub),
      orderChannel,
      warehouseId: warehouse ? String(warehouse._id) : "",
      warehouseNameSnapshot: warehouse ? clean(warehouse.title || warehouse.name || warehouse.reference || warehouse.value) : clean(req.body.warehouseName),
      customerOtpRequired,
      workflowStatus,
      nextAction: creditHold ? "Credit approval required" : customerOtpRequired ? "Customer OTP verification required" : "Verify order",
      lastWorkflowAt: new Date(),
      source: ["MANUAL", "REPEAT", "SUGGESTED", "WEB"].includes(upper(req.body.source)) ? upper(req.body.source) : "MANUAL",
      repeatFromOrderNo: clean(req.body.repeatFromOrderNo),
      repeatFromInvoiceNo: clean(req.body.repeatFromInvoiceNo),
      items,
      subtotal: money(subtotal), discountTotal: money(discountTotal), taxTotal: money(taxTotal), grandTotal: money(grandTotal),
      remarks: clean(req.body.remarks),
      status: creditHold ? "CREDIT_HOLD" : "SUBMITTED",
      creditControl: {
        creditLimit,
        receivableBeforeOrder,
        pendingOrderExposure,
        availableBeforeOrder,
        orderAmount: money(grandTotal),
        projectedExposure,
        exceededBy,
        holdReason: creditHold ? `Credit limit exceeded by ₹${exceededBy.toLocaleString("en-IN")}` : "",
        checkedAt: new Date(),
      },
      createdBy: req.auth.sub,
      createdByNameSnapshot: req.auth.name || "",
    });
    const eventNo = makeId("EVT");
    await OrderEvent.create({
      tenantKey: req.auth.tenantKey, financialYear, eventNo, orderId: String(order._id), orderNo: order.orderNo,
      type: "ORDER_CREATED", fromStatus: "", toStatus: workflowStatus,
      note: orderChannel === "CUSTOMER"
        ? "Order placed directly by customer"
        : orderChannel === "SALESPERSON_ON_BEHALF"
          ? "Order placed by salesperson on behalf of customer"
          : orderChannel === "DMS_WEB"
            ? "Order created directly from DMS website"
            : "Order created from DMS",
      meta: { orderChannel, warehouseId: order.warehouseId || "", warehouseName: order.warehouseNameSnapshot || "", grandTotal: money(grandTotal), creditHold }, audience: ["DMS", "CUSTOMER", "SALESPERSON"],
      actorId: req.auth.sub, actorNameSnapshot: req.auth.name || "", actorRole: req.auth.role || "", occurredAt: new Date(),
    });
    await OrderNotification.insertMany([
      { recipientType: "CUSTOMER", recipientId: customer.globalCustomerId },
      ...(clean(customer.salespersonId || req.auth.sub) ? [{ recipientType: "SALESPERSON", recipientId: clean(customer.salespersonId || req.auth.sub) }] : []),
    ].map((row) => ({ tenantKey: req.auth.tenantKey, financialYear, notificationNo: makeId("NTF"), orderId: String(order._id), orderNo: order.orderNo, eventNo, ...row, channel: "IN_APP", title: `Order ${order.orderNo} received`, body: creditHold ? "Order received and waiting for credit approval" : customerOtpRequired ? "Order received; customer OTP verification is required" : "Order received and waiting for verification", data: { workflowStatus }, status: "PENDING" })));
    return ok(res, {
      ...order.toObject(),
      requiresCustomerOtp: customerOtpRequired && !creditHold,
      customerOtpEndpoint: customerOtpRequired && !creditHold ? `/api/sales-app/order-flow/orders/${order._id}/customer-otp?financialYear=${encodeURIComponent(financialYear)}` : "",
    }, creditHold ? "Order saved on credit hold for approval" : customerOtpRequired ? "Order saved; customer OTP verification is required" : "Sales order submitted", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/orders/:id/credit-decision", async (req, res) => {
  try {
    if (!isAdminAuth(req.auth)) return fail(res, "Administrator approval is required", 403);
    const financialYear = fyOf(req);
    const { SalesOrder, OrderEvent, OrderNotification } = financialModels(req.auth.tenantKey, financialYear);
    const order = await SalesOrder.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!order) return fail(res, "Sales order not found", 404);
    if (order.status !== "CREDIT_HOLD") return ok(res, order, `Order is already ${order.status}`);
    const action = upper(req.body.action || "APPROVE");
    if (!["APPROVE", "REJECT"].includes(action)) return fail(res, "Action must be APPROVE or REJECT", 400);
    order.status = action === "APPROVE" ? "APPROVED" : "REJECTED";
    order.workflowStatus = action === "APPROVE"
      ? (order.customerOtpRequired && !order.customerOtpVerifiedAt ? "OTP_PENDING" : "ORDER_PLACED")
      : "REJECTED";
    order.nextAction = action === "APPROVE"
      ? (order.customerOtpRequired && !order.customerOtpVerifiedAt ? "Customer OTP verification required" : (order.reservation?.status === "RESERVED" ? "Send to warehouse" : "Verify order"))
      : "Rejected";
    order.lastWorkflowAt = new Date();
    if (action === "REJECT" && order.reservation?.status === "RESERVED") {
      for (const item of order.items || []) {
        const qty = Math.max(0, num(item.reservedQty));
        if (!qty) continue;
        await Product.updateOne({ _id: item.productId, tenantKey: req.auth.tenantKey }, { $inc: { reservedStock: -qty } });
        await Product.updateOne({ _id: item.productId, tenantKey: req.auth.tenantKey, reservedStock: { $lt: 0 } }, { $set: { reservedStock: 0 } });
        item.reservedQty = 0;
      }
      order.reservation = { status: "RELEASED", releasedAt: new Date(), releasedReason: "Credit hold rejected" };
    }

    order.creditControl = {
      ...(order.creditControl?.toObject?.() || order.creditControl || {}),
      decision: action,
      decisionBy: req.auth.sub,
      decisionByNameSnapshot: req.auth.name || "",
      decisionAt: new Date(),
      decisionRemark: clean(req.body.remarks),
    };
    await order.save();
    const eventNo = makeId("EVT");
    await OrderEvent.create({ tenantKey: req.auth.tenantKey, financialYear, eventNo, orderId: String(order._id), orderNo: order.orderNo, type: action === "APPROVE" ? "CREDIT_APPROVED" : "CREDIT_REJECTED", fromStatus: "CREDIT_HOLD", toStatus: order.workflowStatus, note: action === "APPROVE" ? "Credit hold approved" : "Credit hold rejected", meta: { remarks: clean(req.body.remarks), exceededBy: num(order.creditControl?.exceededBy) }, audience: ["DMS", "CUSTOMER", "SALESPERSON"], actorId: req.auth.sub, actorNameSnapshot: req.auth.name || "", actorRole: req.auth.role || "", occurredAt: new Date() });
    await OrderNotification.insertMany([
      { recipientType: "CUSTOMER", recipientId: order.customerGlobalId },
      ...(order.salespersonId ? [{ recipientType: "SALESPERSON", recipientId: order.salespersonId }] : []),
    ].map((row) => ({ tenantKey: req.auth.tenantKey, financialYear, notificationNo: makeId("NTF"), orderId: String(order._id), orderNo: order.orderNo, eventNo, ...row, channel: "IN_APP", title: `Order ${order.orderNo}: credit ${action === "APPROVE" ? "approved" : "rejected"}`, body: clean(req.body.remarks) || (action === "APPROVE" ? "Order can continue for verification" : "Order was rejected during credit approval"), data: { workflowStatus: order.workflowStatus }, status: "PENDING" })));
    return ok(res, order, action === "APPROVE" ? "Credit hold approved" : "Credit hold rejected");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});



// Read-only customer issue history, scoped through the existing assigned-customer permission check.
router.get("/customers/:globalId/issues", async (req, res) => {
  try {
    const customer = await requireVisibleCustomer(req, req.params.globalId);
    const filter = { tenantKey: req.auth.tenantKey, globalCustomerId: customer.globalCustomerId };
    const [complaints, damageClaims] = await Promise.all([
      CustomerSupportTicket.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
      CustomerDamageClaim.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
    ]);
    return ok(res, { complaints, damageClaims, customer: { globalCustomerId: customer.globalCustomerId, name: customerName(customer), mobile: customer.mobile || customer.phone || customer.mobileNumber || "" } });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

// ---------------------------
// Salesperson receipt OTP workflow
// ---------------------------
function receiptForClient(doc) {
  if (!doc) return doc;
  const out = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  delete out.customerOtpCode;
  delete out.cashierOtpCode;
  out.paymentStatus = isReceiptLedgerPosted(out) ? "PAID" : "UNPAID";
  return out;
}

function validCollectionDate(value) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return String(value).split(",").map(clean).filter(Boolean); }
}

function collectionRequestMatches(receipt, body) {
  const mode=upper(body.paymentMode||body.mode||'CASH');
  if(receipt.mode!==mode||receipt.receiptType!==(mode==='CASH'?'CASH':upper(body.receiptType)))return false;
  if(!receipt.againstDocuments?.length||!body.documents)return true;
  const saved=new Map(receipt.againstDocuments.map(row=>[row.canonicalKey,money(row.amount)]));
  const requested=jsonArray(body.documents);
  return requested.length===saved.size&&new Set(requested.map(row=>row.canonicalKey)).size===saved.size&&
    requested.every(row=>saved.has(row.canonicalKey)&&(row.amount==null||money(row.amount)===saved.get(row.canonicalKey)));
}

const allowedDenominations = new Set([500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5]);
function parseDenominations(value) {
  const rows = jsonArray(value).map((row) => {
    const denomination = num(row?.denomination);
    const count = Math.max(0, Math.floor(num(row?.count)));
    return { denomination, count, amount: money(denomination * count) };
  }).filter((row) => row.count > 0 && allowedDenominations.has(row.denomination));
  return rows;
}
function denominationTotal(rows = []) {
  return money((rows || []).reduce((sum, row) => sum + num(row.amount || num(row.denomination) * num(row.count)), 0));
}
function assertDenominationsMatch(rows, expected, label = "cash") {
  const total = denominationTotal(rows);
  if (!rows.length) {
    const error = new Error(`Enter the ${label} denomination`); error.statusCode = 400; throw error;
  }
  if (Math.abs(total - money(expected)) > 0.009) {
    const error = new Error(`Denomination total ₹${total.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} must match ${label} amount ₹${money(expected).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    error.statusCode = 409; throw error;
  }
  return total;
}

function isChequeReceipt(receipt) {
  const type = upper(receipt?.receiptType);
  const mode = upper(receipt?.mode);
  return type === "CHEQUE" || ["CHEQUE", "CHECK", "CHQ"].includes(mode);
}

async function salespersonReceiptById(req, financialYear, receiptId, { includeSecrets = false } = {}) {
  const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
  const id = clean(receiptId);
  const filter = { tenantKey: req.auth.tenantKey, financialYear };
  if (objectIdText(id)) filter.$or = [{ _id: id }, { receiptNo: id }];
  else filter.receiptNo = id;
  let query = Receipt.findOne(filter);
  if (includeSecrets) query = query.select("+customerOtpCode +cashierOtpCode");
  const receipt = await query;
  if (!receipt) {
    const error = new Error("Receipt not found");
    error.statusCode = 404;
    throw error;
  }
  if (!isAdminAuth(req.auth) && clean(receipt.collectedBySalespersonId) !== clean(req.auth.sub)) {
    const error = new Error("This receipt belongs to another salesperson");
    error.statusCode = 403;
    throw error;
  }
  return receipt;
}

async function newReceiptOtp({ tenantKey, receipt, type }) {
  const customer = type === "CUSTOMER";
  return createOtp({
    tenantKey,
    transactionId: String(receipt._id),
    actionType: customer ? "SALESPERSON_RECEIPT_CUSTOMER_CONFIRM" : "SALESPERSON_RECEIPT_CASHIER_CONFIRM",
    recipientId: customer ? receipt.customerGlobalId : `CASHIER:${tenantKey}`,
    ttlSeconds: customer ? 30 * 60 : 24 * 60 * 60,
    context: {
      receiptNo: receipt.receiptNo,
      amount: money(receipt.amount),
      mode: receipt.mode,
      receiptType: receipt.receiptType || "",
      customerGlobalId: receipt.customerGlobalId,
      salespersonId: receipt.collectedBySalespersonId || "",
    },
  });
}

function receiptOtpTimestampText(value) {
  const at = new Date(value || Date.now());
  return {
    date: at.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" }),
    time: at.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }),
  };
}

async function sendReceiptCustomerAcknowledgement({ tenantKey, financialYear, receipt }) {
  const { OrderNotification } = financialModels(tenantKey, financialYear);
  const receiptId = String(receipt._id);
  const existing = await OrderNotification.findOne({
    tenantKey,
    financialYear,
    recipientType: "CUSTOMER",
    recipientId: receipt.customerGlobalId,
    "data.notificationType": "RECEIPT_CUSTOMER_CONFIRMATION",
    "data.receiptId": receiptId,
  });
  if (existing) return existing;

  const verifiedAt = receipt.customerOtpVerifiedAt || new Date();
  const when = receiptOtpTimestampText(verifiedAt);
  const salespersonName = clean(receipt.collectedBySalespersonNameSnapshot || receipt.createdByNameSnapshot) || "Sales Person";
  const isCashReceipt = upper(receipt.mode) === "CASH";
  const body = isCashReceipt
    ? `Thank you for the payment of ₹${money(receipt.amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} dated ${when.date} timed ${when.time} to ${salespersonName}.`
    : "The status of the payment will be changed as soon as the payment is received!";

  return OrderNotification.create({
    tenantKey,
    financialYear,
    notificationNo: makeId("NTF"),
    orderId: "",
    orderNo: "",
    eventNo: "",
    recipientType: "CUSTOMER",
    recipientId: receipt.customerGlobalId,
    channel: "IN_APP",
    title: `Receipt ${receipt.receiptNo} created`,
    body,
    data: {
      notificationType: "RECEIPT_CUSTOMER_CONFIRMATION",
      receiptId,
      receiptNo: receipt.receiptNo,
      amount: money(receipt.amount),
      mode: upper(receipt.mode),
      receiptType: upper(receipt.receiptType),
      customerOtpVerifiedAt: verifiedAt,
      salespersonName,
    },
    status: "PENDING",
  });
}

async function receiptFormContext({ tenantKey, financialYear, customer }) {
  const { Receipt } = financialModels(tenantKey, financialYear);
  const [bills, pendingReceipts, receiptAccounts] = await Promise.all([
    invoiceOutstandingForCustomer({ tenantKey, financialYear, customer, onlyOpen: true }),
    Receipt.find({
      tenantKey,
      financialYear,
      customerGlobalId: customer.globalCustomerId,
      collectionSource: "SALESPERSON_APP",
      status: { $nin: ["DELETED", "VOID", "VOIDED", "REVERSED", "CANCELLED"] },ledgerPostedAt:{$in:[null]},
      receiptWorkflowStatus: { $nin: ["COMPLETED", "CANCELLED"] },
    }).select("receiptNo againstInvoices payerAccountNumber date receiptWorkflowStatus").lean(),
    Receipt.find({
      tenantKey,
      financialYear,
      customerGlobalId: customer.globalCustomerId,
      payerAccountNumber: { $exists: true, $nin: [null, ""] },
    }).select("payerAccountNumber date createdAt").sort({ date: -1, createdAt: -1 }).limit(100).lean(),
  ]);

  const reserved = new Map();
  const pendingByInvoice = new Map();
  for (const receipt of pendingReceipts) {
    for (const row of receipt.againstInvoices || []) {
      const key = clean(row.invoiceId || row.invoiceNo);
      const noKey = clean(row.invoiceNo);
      const amount = money(row.amount);
      if (key) reserved.set(key, money(num(reserved.get(key)) + amount));
      if (noKey && noKey !== key) reserved.set(noKey, money(num(reserved.get(noKey)) + amount));
      if (noKey) {
        const list = pendingByInvoice.get(noKey) || [];
        list.push(receipt.receiptNo);
        pendingByInvoice.set(noKey, list);
      }
    }
  }

  const invoices = [...bills]
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
    .map((bill) => {
      const pendingReceiptAmount = Math.min(
        num(bill.outstanding),
        Math.max(num(reserved.get(clean(bill._id))), num(reserved.get(clean(bill.invoiceNo)))),
      );
      const availableAmount = money(Math.max(0, num(bill.outstanding) - pendingReceiptAmount));
      return {
        ...bill,
        pendingReceiptAmount: money(pendingReceiptAmount),
        availableAmount,
        selectable: pendingReceiptAmount <= 0.009 && availableAmount > 0,
        pendingReceiptNos: pendingByInvoice.get(clean(bill.invoiceNo)) || [],
      };
    });

  const accountNumbers = [];
  const seen = new Set();
  for (const row of customer.bankDetails || []) {
    const accountNumber = clean(row.accountNumber);
    if (accountNumber && !seen.has(accountNumber)) { seen.add(accountNumber); accountNumbers.push(accountNumber); }
  }
  for (const row of receiptAccounts) {
    const accountNumber = clean(row.payerAccountNumber);
    if (accountNumber && !seen.has(accountNumber)) { seen.add(accountNumber); accountNumbers.push(accountNumber); }
  }

  const hasUnpaidInvoices = invoices.some((x) => num(x.outstanding) > 0);
  // ADVANCE stays visible at all times. It becomes usable only when every live
  // unpaid invoice is already fully covered by a pending receipt. Completed
  // receipts are already reflected in the live outstanding calculation above.
  const uncoveredInvoices = invoices.filter((x) => money(num(x.outstanding) - num(x.pendingReceiptAmount)) > 0.009);
  const canAdvance = uncoveredInvoices.length === 0;

  return {
    financialYear,
    invoices,
    hasUnpaidInvoices,
    hasPendingReceiptReservation: invoices.some((x) => num(x.pendingReceiptAmount) > 0),
    canAdvance,
    advanceBlockedInvoiceNos: uncoveredInvoices.map((x) => x.invoiceNo),
    advanceBlockedReason: canAdvance
      ? ""
      : `Advance can be created only after every unpaid invoice is either covered by a pending receipt or completed. Pending coverage is still required for: ${uncoveredInvoices.map((x) => x.invoiceNo).join(", ")}`,
    accountNumbers,
  };
}

router.get("/customers/:globalId/receipt-form", async (req, res) => {
  try {
    const customer = await requireVisibleCustomer(req, req.params.globalId, { customerLinkId: clean(req.query.customerLinkId) });
    assertReceiptCustomerLink(customer, { globalId: req.params.globalId, linkId: clean(req.query.customerLinkId) });
    const financialYear = fyOf(req);
    const form = await receiptFormContext({ tenantKey: req.auth.tenantKey, financialYear, customer });
    const collection=(await loadPendingCollections({tenantKey:req.auth.tenantKey,financialYear,customers:[customer]}))[0];
    return ok(res, {
      ...form,
      documents:collection.documents,orders:collection.documents.filter(document=>document.kind==='ORDER'),
      invoices:collection.documents.filter(document=>document.kind!=='DEBIT_NOTE').map(document=>({...document,_id:document.id,invoiceNo:document.number,
        total:document.total,outstanding:document.outstanding,pendingReceiptAmount:document.reserved,pendingReceiptNos:document.pendingReceipts})),
      hasUnpaidInvoices:collection.documents.some(document=>document.kind!=='DEBIT_NOTE'),
      canAdvance:isCollectionExecutiveRole(req.auth.role)?false:form.canAdvance&&!collection.documents.length,
      customer: { id: customer.globalCustomerId, linkId: String(customer._id), name: customerName(customer) },
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/receipts", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const customer = await requireVisibleCustomer(req, req.params.globalId);
    const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const items = await Receipt.find({
      tenantKey: req.auth.tenantKey,
      financialYear,
      customerGlobalId: customer.globalCustomerId,
      status: { $ne: "DELETED" },
      collectionSource: "SALESPERSON_APP",
      $and: [await receiptViewerScope(req, req.query.createdByScope)],
    }).sort({ date: -1, createdAt: -1 }).limit(500).lean();
    return ok(res, {
      financialYear,
      customer: { id: customer.globalCustomerId, name: customerName(customer) },
      items: items.map(r => ({ ...receiptForClient(r), isMine: receiptOwnerId(r) === clean(req.auth.sub), canDeposit: receiptOwnerId(r) === clean(req.auth.sub) })),
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/customers/:globalId/receipts", upload.single("paymentImage"), async (req, res) => {
  let receipt = null;
  try {
    const customer = await requireVisibleCustomer(req, req.params.globalId, { customerLinkId: clean(req.body.customerLinkId) });
    // Reject wrong-party saves BEFORE generating any receipt or OTP.
    assertReceiptCustomerLink(customer, {
      globalId: req.params.globalId,
      linkId: clean(req.body.customerLinkId),
      expectedName: clean(req.body.expectedCustomerName),
    });
    const date = req.body.date ? new Date(req.body.date) : new Date();
    if (Number.isNaN(date.getTime())) return fail(res, "Invalid receipt date", 400);
    const financialYear = financialYearFromDate(date) || fyOf(req);

    const mode = upper(req.body.paymentMode || req.body.mode || "CASH");
    if (!["CASH", "BANK"].includes(mode)) return fail(res, "Payment mode must be Cash or Bank", 400);
    const receiptType = mode === "CASH" ? "CASH" : upper(req.body.receiptType);
    if (mode === "BANK" && !["CHEQUE", "UPI", "NEFT", "RTGS", "IMPS"].includes(receiptType)) return fail(res, "Bank receipt type must be Cheque, UPI, NEFT, RTGS or IMPS", 400);

    const clientMutationId = clean(req.body.clientMutationId);
    if (clientMutationId && !/^[a-zA-Z0-9:_-]{12,96}$/.test(clientMutationId)) return fail(res, "Invalid collection request ID", 400);
    // Unique collection request ID protects against mobile retries after network timeouts.
    if (clientMutationId) {
      const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
      await Receipt.init();
      const previous = await Receipt.findOne({ tenantKey:req.auth.tenantKey, financialYear, clientMutationId });
      if (previous) {
        if (clean(previous.collectedBySalespersonId)!==clean(req.auth.sub) || clean(previous.customerGlobalId)!==clean(customer.globalCustomerId))
          return fail(res,"Collection request ID is already used for another customer",409);
        if(['CANCELLED','VOID','VOIDED','DELETED','REJECTED','REVERSED'].includes(previous.status)||collectionPaymentFailed(previous))return fail(res,'This collection was cancelled or failed. Start a new collection.',409);
        if(!collectionRequestMatches(previous,req.body))return fail(res,'This request already belongs to another document/payment selection. Resume the original receipt from Collected.',409);
        return ok(res,{receipt:receiptForClient(previous),reused:true},"Existing collection returned; verify its original OTP");
      }
    }
    let selections=jsonArray(req.body.documents),partyForSelection=null;
    const requestedIds=jsonArray(req.body.invoiceIds||req.body.againstInvoiceIds).map(clean);
    if(!selections.length&&requestedIds.length){
      partyForSelection=(await loadPendingCollections({tenantKey:req.auth.tenantKey,financialYear,customers:[customer]}))[0];
      const chosen=requestedIds.map(id=>partyForSelection.documents.find(document=>document.id===id||document.number===id));
      if(chosen.every(Boolean))selections=chosen.map(document=>({canonicalKey:document.canonicalKey}));
      else if(isCollectionExecutiveRole(req.auth.role)||requestedIds.some(id=>partyForSelection.documents.some(document=>document.invoices.some(invoice=>String(invoice._id)===id||invoice.invoiceNo===id))))
        return fail(res,'The selected documents changed. Refresh Pending Collection and select their current invoice/order entries.',409);
    }
    const form = selections.length?null:await receiptFormContext({ tenantKey: req.auth.tenantKey, financialYear, customer });
    const selectedKeys = new Set(jsonArray(req.body.invoiceIds || req.body.againstInvoiceIds).map(clean).filter(Boolean));
    let allocationType = upper(req.body.allocationType || (selections.length?'DOCUMENT':form.hasUnpaidInvoices ? "INVOICE" : "ADVANCE"));
    let againstInvoices = [];
    let againstDocuments=[],selectedDocuments=[];
    let amount = 0;

    if(selections.length){
      const party=partyForSelection||(await loadPendingCollections({tenantKey:req.auth.tenantKey,financialYear,customers:[customer]}))[0];
      selectedDocuments=selectCollectionDocuments(party,selections);
      againstDocuments=selectedDocuments.map(document=>({kind:document.kind,documentId:document.id,documentNo:document.number,
        financialYear:document.financialYear,canonicalKey:document.canonicalKey,amount:document.amount}));
      againstInvoices=selectedDocuments.flatMap(document=>{
        let remaining=document.amount;
        return document.invoices.map(invoice=>{const allocated=money(Math.min(remaining,Number(invoice.netInvoiceAmount??invoice.grandTotal)||0));remaining=money(remaining-allocated);
          return {invoiceId:String(invoice._id),invoiceNo:invoice.invoiceNo,invoiceDate:invoice.date,financialYear:invoice.financialYear,amount:allocated};}).filter(row=>row.amount>0);
      });
      amount=money(selectedDocuments.reduce((sum,document)=>sum+document.amount,0));allocationType='DOCUMENT';
    }else if (allocationType === "ADVANCE") {
      if(isCollectionExecutiveRole(req.auth.role))return fail(res,'Collectors can create receipts only against an invoice, order or debit note',400);
      if (!form.canAdvance) return fail(res, form.advanceBlockedReason || "Advance is blocked until every unpaid invoice is pending or completed", 409);
      amount = money(req.body.amount);
      if (!(amount > 0)) return fail(res, "Enter a valid advance amount", 400);
      againstInvoices = [];
    } else if (allocationType === "INVOICE") {
      if (!form.hasUnpaidInvoices) return fail(res, "There is no unpaid invoice. Select ADVANCE instead.", 409);
      if (!selectedKeys.size) return fail(res, "Select at least the oldest unpaid invoice", 400);

      const selectedIndexes = form.invoices
        .map((bill, index) => selectedKeys.has(clean(bill._id)) || selectedKeys.has(clean(bill.invoiceNo)) ? index : -1)
        .filter((index) => index >= 0);
      if (!selectedIndexes.length) return fail(res, "Selected invoice was not found in the customer's live unpaid invoices", 409);
      const lastIndex = Math.max(...selectedIndexes);

      // A receipt may cover the oldest invoice, or a continuous oldest-first
      // group. It may never skip an older unpaid invoice to settle a newer one.
      for (let index = 0; index <= lastIndex; index += 1) {
        const bill = form.invoices[index];
        const selected = selectedKeys.has(clean(bill._id)) || selectedKeys.has(clean(bill.invoiceNo));
        if (!selected) return fail(res, `Invoice ${bill.invoiceNo} is older and must be paid before newer invoices`, 409);
        if (!bill.selectable) {
          const pendingNo = bill.pendingReceiptNos?.[0];
          return fail(res, pendingNo ? `Invoice ${bill.invoiceNo} already has pending receipt ${pendingNo}` : `Invoice ${bill.invoiceNo} already has a pending receipt`, 409);
        }
      }
      for (let index = lastIndex + 1; index < form.invoices.length; index += 1) {
        const bill = form.invoices[index];
        if (selectedKeys.has(clean(bill._id)) || selectedKeys.has(clean(bill.invoiceNo))) {
          return fail(res, "Invoices must be selected continuously from the oldest unpaid invoice", 409);
        }
      }

      againstInvoices = form.invoices.slice(0, lastIndex + 1).map((bill) => ({
        invoiceId: clean(bill._id),
        invoiceNo: clean(bill.invoiceNo),
        invoiceDate: bill.date,
        amount: money(bill.outstanding),
      }));
      amount = money(againstInvoices.reduce((sum, row) => sum + num(row.amount), 0));
    } else {
      return fail(res, "Allocation type must be INVOICE or ADVANCE", 400);
    }

    const payerAccountNumber = clean(req.body.payerAccountNumber || req.body.accountNumber);
    const chequeNumber = clean(req.body.chequeNumber);
    const upiPaymentText = clean(req.body.upiPaymentText);
    if (req.file && !/^image\//i.test(clean(req.file.mimetype))) return fail(res, "Payment proof must be an image", 400);

    if (mode === "BANK" && receiptType === "CHEQUE") {
      if (!payerAccountNumber) return fail(res, "Customer account number is required for cheque receipt", 400);
      if (!chequeNumber) return fail(res, "Cheque number is required", 400);
      if (!req.file) return fail(res, "Upload the cheque image", 400);
    }
    if (mode === "BANK" && receiptType === "UPI" && !upiPaymentText && !req.file) {
      return fail(res, "Enter UPI payment text/reference or upload the UPI payment image", 400);
    }

    const payerIfsc = receiptType === "CHEQUE" ? normalizeIfsc(req.body.ifsc || req.body.payerIfsc) : "";
    let payerBankName = "";
    if (receiptType === "CHEQUE") {
      if (!payerIfsc) return fail(res, "IFSC required for cheque collection", 400);
      const bankMaster = await getIfscMaster(payerIfsc);
      payerBankName = clean(bankMaster.bank);
      const chequeDate = clean(req.body.chequeDate);
      if (!validCollectionDate(chequeDate))
        return fail(res, "Valid cheque date required (YYYY-MM-DD)", 400);
    }
    if (mode === "BANK" && receiptType !== "CHEQUE" && !clean(req.body.upiPaymentText))
      return fail(res, "Transaction reference or UTR required for online payment", 400);
    // New document collections use proof-based online submission in both apps.
    // Legacy mobile forms without documents retain their existing OTP contract.
    const online=mode==='BANK'&&receiptType!=='CHEQUE'&&jsonArray(req.body.documents).length>0&&selections.length>0;
    if(online&&(!req.file||!validCollectionDate(clean(req.body.onlineTransactionDate))||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(req.body.onlineTransactionTime))))
      return fail(res,'Online collection requires payment date, time, transaction details and payment image',400);
    const cashDenominations = mode === "CASH" ? parseDenominations(req.body.cashDenominations) : [];
    if (mode === "CASH") assertDenominationsMatch(cashDenominations, amount, "receipt cash");

    const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
    let receiptNo = makeId("RCT");
    while (await Receipt.exists({ tenantKey: req.auth.tenantKey, financialYear, receiptNo })) receiptNo = makeId("RCT");

    let paymentProofFileId = "";
    if (req.file) {
      const meta = await saveUploadedFile({
        file: req.file,
        tenantKey: req.auth.tenantKey,
        module: "sales-app",
        entityType: "RECEIPT_PAYMENT_PROOF",
        entityId: receiptNo,
        uploadedBy: req.auth.sub,
        access: "PRIVATE",
      });
      paymentProofFileId = meta.fileId;
    }

    const receiptInput = {
      tenantKey: req.auth.tenantKey,
      financialYear,
      receiptNo,
      sourceKey: `SALESPERSON:${receiptNo}`,
      clientMutationId: clientMutationId || undefined,
      collectedByRole: upper(req.auth.role),
      payerIfsc, payerBankName,
      date,
      customerGlobalId: customer.globalCustomerId,
      customerLinkId: String(customer._id),
      partyNameSnapshot: customerName(customer),
      amount,
      mode,
      receiptType,
      allocationType,
      againstInvoices,
      againstDocuments,collectionBatchId:clean(req.body.collectionBatchId),customerConfirmationMethod:online?'ONLINE_PROOF':'OTP',
      onlineTransactionDate:online?new Date(`${req.body.onlineTransactionDate}T00:00:00Z`):undefined,
      onlineTransactionTime:online?clean(req.body.onlineTransactionTime):'',
      payerAccountNumber: receiptType === "CHEQUE" ? payerAccountNumber : "",
      paymentProofFileId,
      paymentProofKind: req.file ? receiptType : "",
      upiPaymentText: mode === "BANK" && receiptType !== "CHEQUE" ? upiPaymentText : "",
      reference: receiptType === "CHEQUE" ? chequeNumber : mode === "BANK" ? upiPaymentText : "",
      chequeNumber: receiptType === "CHEQUE" ? chequeNumber : "",
      chequeIssueDate: receiptType === "CHEQUE" ? new Date(clean(req.body.chequeDate)+"T00:00:00Z") : undefined,
      chequeStatus: receiptType === "CHEQUE" ? "PENDING_VERIFICATION" : undefined,
      bounceStatus: receiptType === "CHEQUE" ? "PENDING" : "CLEAR",
      remarks: clean(req.body.remarks),
      collectedBySalespersonId: req.auth.sub,
      collectedBySalespersonNameSnapshot: req.auth.name || "",
      collectionSource: "SALESPERSON_APP",
      receiptWorkflowStatus: online?'ONLINE_SUBMITTED':"PENDING_CUSTOMER_OTP",
      customerOtpStatus: online?'NOT_REQUIRED':"PENDING",
      customerOtpExpiresAt:online?undefined:new Date(Date.now()+30*60*1000),
      cashierOtpStatus: "NOT_REQUIRED",
      cashDenominations,
      cashDepositStatus: online?'NOT_APPLICABLE':"AWAITING_RECEIPT_VERIFICATION",
      createdBy: req.auth.sub,
      createdByNameSnapshot: req.auth.name || "",
      status: online?'POSTED':"PENDING_VERIFICATION",
    };
    if(selectedDocuments.length){
      await Promise.all([Receipt.init(),CollectionClaim.init()]);const session=await Receipt.db.startSession();
      try{await session.withTransaction(async()=>{
        [receipt]=await Receipt.create([receiptInput],{session});
        for(const document of selectedDocuments){
          const existing=await CollectionClaim.findOne({tenantKey:req.auth.tenantKey,canonicalKey:document.canonicalKey}).session(session).lean();
          let completed=false;
          if(existing?.status==='ACTIVE'&&existing.receiptId){
            const previous=await financialModels(req.auth.tenantKey,existing.receiptFinancialYear).Receipt.findOne({_id:existing.receiptId,
              tenantKey:req.auth.tenantKey}).session(session).lean();
            completed=Boolean(previous?.ledgerPostedAt||['CANCELLED','VOID','VOIDED','DELETED','REJECTED','REVERSED'].includes(previous?.status)||previous&&collectionPaymentFailed(previous));
          }
          if(existing?.status==='ACTIVE'&&!completed&&(!existing.expiresAt||new Date(existing.expiresAt)>new Date()))
            throw Object.assign(new Error('This invoice/order is already being collected. Refresh the pending list.'),{statusCode:409});
          await CollectionClaim.updateOne({tenantKey:req.auth.tenantKey,canonicalKey:document.canonicalKey},{$set:{receiptId:String(receipt._id),
            receiptFinancialYear:financialYear,collectorId:req.auth.sub,status:'ACTIVE',expiresAt:online?null:receiptInput.customerOtpExpiresAt}},{upsert:true,session});
        }
      });}finally{await session.endSession();}
    }else receipt=await Receipt.create(receiptInput);

    if(online)return ok(res,{receipt:receiptForClient(receipt)},'Online payment submitted to Company Received for bank verification',201);

    if (receiptType === "CHEQUE" && payerAccountNumber) {
      const customerDoc = await CustomerLink.findOne({ tenantKey: req.auth.tenantKey, globalCustomerId: customer.globalCustomerId });
      if (customerDoc) {
        const exists = (customerDoc.bankDetails || []).some((row) => clean(row.accountNumber) === payerAccountNumber);
        if (!exists) {
          customerDoc.bankDetails = [...(customerDoc.bankDetails || []), { accountNumber: payerAccountNumber }];
          await customerDoc.save();
        }
      }
    }

    const otp = await newReceiptOtp({ tenantKey: req.auth.tenantKey, receipt, type: "CUSTOMER" });
    receipt.customerOtpId = otp.otpId;
    receipt.customerOtpCode = otp.code;
    receipt.customerOtpExpiresAt = otp.expiresAt;
    await receipt.save();
    return ok(res, { receipt: receiptForClient(receipt) }, "Receipt saved; verify customer OTP", 201);
  } catch (error) {
    if (error?.code === 11000 && clean(req.body.clientMutationId)) {
      try {
        const fy = financialYearFromDate(req.body.date || new Date()) || fyOf(req);
        const { Receipt } = financialModels(req.auth.tenantKey, fy);
        const previous = await Receipt.findOne({tenantKey:req.auth.tenantKey,financialYear:fy,clientMutationId:clean(req.body.clientMutationId)});
        if (previous && !['CANCELLED','VOID','VOIDED','DELETED','REJECTED','REVERSED'].includes(previous.status)&&!collectionPaymentFailed(previous)&&collectionRequestMatches(previous,req.body)&&
          clean(previous.collectedBySalespersonId) === clean(req.auth.sub)&&clean(previous.customerGlobalId) === clean(req.params.globalId))
          return ok(res,{receipt:receiptForClient(previous),reused:true},'Original collection returned after simultaneous retry');
      } catch (_) { /* expose original failure below */ }
    }
    if (receipt?._id && receipt.status !== "POSTED") {
      await receipt.deleteOne().catch(() => {});
      await CollectionClaim.updateMany({tenantKey:req.auth.tenantKey,receiptId:String(receipt._id),status:'ACTIVE'},
        {$set:{status:'RELEASED',expiresAt:new Date()}}).catch(()=>{});
    }
    return fail(res, error.code===11000?'This invoice/order is already being collected; refresh the pending list.':error.message, error.code===11000?409:error.statusCode || 500);
  }
});

router.post("/receipts/:receiptId/customer-otp/resend", async (req, res) => {
  try {
    const financialYear = clean(req.body.financialYear || req.query.financialYear) || fyOf(req);
    const receipt = await salespersonReceiptById(req, financialYear, req.params.receiptId, { includeSecrets: true });
    if(receipt.customerConfirmationMethod==='ONLINE_PROOF'||['CANCELLED','VOID','DELETED'].includes(receipt.status))return fail(res,'This receipt does not accept customer OTP',409);
    assertReceiptOtpParty(receipt, { expectedGlobalId: req.body.expectedCustomerGlobalId, expectedLinkId: req.body.expectedCustomerLinkId, expectedName: req.body.expectedCustomerName });
    if (receipt.customerOtpStatus === "VERIFIED") return fail(res, "Customer OTP is already verified", 409);
    if(receipt.againstDocuments?.length){const claims=await CollectionClaim.updateMany({tenantKey:req.auth.tenantKey,receiptId:String(receipt._id),status:'ACTIVE'},{$set:{expiresAt:new Date(Date.now()+30*60*1000)}});
      if(claims.matchedCount!==receipt.againstDocuments.length)return fail(res,'This collection expired and its documents are being collected elsewhere. Refresh Pending Collection.',409);}
    const otp = await newReceiptOtp({ tenantKey: req.auth.tenantKey, receipt, type: "CUSTOMER" });
    receipt.customerOtpId = otp.otpId;
    receipt.customerOtpCode = otp.code;
    receipt.customerOtpExpiresAt = otp.expiresAt;
    receipt.customerOtpStatus = "PENDING";
    receipt.receiptWorkflowStatus = "PENDING_CUSTOMER_OTP";
    await receipt.save();
    if(receipt.againstDocuments?.length){const claims=await CollectionClaim.updateMany({tenantKey:req.auth.tenantKey,receiptId:String(receipt._id),status:'ACTIVE'},{$set:{expiresAt:otp.expiresAt}});
      if(claims.matchedCount!==receipt.againstDocuments.length)return fail(res,'This collection expired and its documents are being collected elsewhere. Refresh Pending Collection.',409);}
    return ok(res, { receipt: receiptForClient(receipt) }, "New customer OTP generated");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/receipts/:receiptId/customer-otp/verify", async (req, res) => {
  try {
    const financialYear = clean(req.body.financialYear || req.query.financialYear) || fyOf(req);
    const receipt = await salespersonReceiptById(req, financialYear, req.params.receiptId, { includeSecrets: true });
    if(receipt.customerConfirmationMethod==='ONLINE_PROOF'||['CANCELLED','VOID','DELETED'].includes(receipt.status))return fail(res,'This receipt does not accept customer OTP',409);
    if(receipt.againstDocuments?.length&&receipt.customerOtpStatus!=='VERIFIED'){
      const claims=await CollectionClaim.updateMany({tenantKey:req.auth.tenantKey,receiptId:String(receipt._id),status:'ACTIVE'},{$set:{expiresAt:new Date(Date.now()+30*60*1000)}});
      if(claims.matchedCount!==receipt.againstDocuments.length)return fail(res,'This collection expired and its documents are being collected elsewhere. Refresh Pending Collection.',409);
    }
    // A different party can never be finalized even with an otherwise valid OTP.
    assertReceiptOtpParty(receipt, { expectedGlobalId: req.body.expectedCustomerGlobalId, expectedLinkId: req.body.expectedCustomerLinkId, expectedName: req.body.expectedCustomerName });
    if (receipt.customerOtpStatus !== "VERIFIED") {
      const code = clean(req.body.code);
      if (!code) return fail(res, "Enter customer OTP", 400);
      const result = await verifyOtp({ otpId: receipt.customerOtpId, code });
      if (!result.ok) return fail(res, result.reason, 400);
      if (String(result.challenge.transactionId) !== String(receipt._id) || String(result.challenge.recipientId) !== String(receipt.customerGlobalId)) {
        return fail(res, "OTP does not belong to this receipt", 403);
      }
      const changed=await financialModels(req.auth.tenantKey,financialYear).Receipt.updateOne({_id:receipt._id,tenantKey:req.auth.tenantKey,
        customerOtpStatus:'PENDING',status:{$nin:['CANCELLED','VOID','DELETED']}},{$set:{customerOtpStatus:'VERIFIED',customerOtpVerifiedAt:new Date()}});
      if(changed.modifiedCount!==1)return fail(res,'Receipt was cancelled or changed during OTP verification. Refresh before continuing.',409);
      receipt.customerOtpStatus = "VERIFIED";
      receipt.customerOtpVerifiedAt = new Date();
      receipt.customerOtpCode = undefined;
    }
    // Persist customer verification before queuing the acknowledgement so the
    // exact OTP-verification timestamp is used in the cash confirmation text.
    await receipt.save();
    const customerMessage = await sendReceiptCustomerAcknowledgement({
      tenantKey: req.auth.tenantKey,
      financialYear,
      receipt,
    });
    // Customer OTP completes the receipt. The later physical cash handover to
    // cashier is a separate custody workflow with its own batch OTP.
    receipt.cashierOtpStatus = "NOT_REQUIRED";
    receipt.cashierOtpCode = undefined;
    receipt.cashierOtpId = undefined;
    receipt.cashierOtpExpiresAt = undefined;
    receipt.receiptWorkflowStatus = "VERIFIED_PENDING_POSTING";
    await receipt.save();
    const posted = await finalizeSalespersonReceipt({
      tenantKey: req.auth.tenantKey,
      financialYear,
      receipt,
      actorId: req.auth.sub,
      actorName: req.auth.name || "",
    });
    if(posted.againstDocuments?.length)await CollectionClaim.updateMany({tenantKey:req.auth.tenantKey,receiptId:String(posted._id),status:'ACTIVE'},{$set:{expiresAt:null}});
    // One original OTP-verified receipt drives both Cashier and cheque register.
    // The link never posts a second customer receipt/journal. On failure the
    // verified payment remains committed, with a retriable admin link repair.
    let chequeLink = null, collectionLinkWarning = "";
    if (upper(posted.receiptType) === "CHEQUE") {
      try { chequeLink = await syncChequeForReceipt(posted, req.auth); }
      catch (linkError) {
        collectionLinkWarning = linkError.message;
        console.error("Cheque register sync needs review:", posted.receiptNo, linkError.message);
      }
    }
    const customer = await requireVisibleCustomer(req, posted.customerGlobalId, { customerLinkId: clean(posted.customerLinkId) });
    const ledger = await buildCustomerReceivableLedger({ tenantKey: req.auth.tenantKey, financialYear, customer });
    const cash = upper(posted.mode) === "CASH"
      ? await cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: posted.collectedBySalespersonId || req.auth.sub })
      : null;
    return ok(res, {
      receipt: receiptForClient(posted),
      chequeRegister: chequeLink, collectionLinkWarning,
      customerMessage: { title: customerMessage.title, body: customerMessage.body },
      partyName: posted.partyNameSnapshot || customerName(customer),
      outstanding: money(ledger.closingSigned),
      cashInHand: cash?.cashInHand ?? null,
    }, `Successfully created the receipt for ${posted.partyNameSnapshot || "customer"}`);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/receipts/:receiptId/cashier-otp/resend", async (req, res) => {
  try {
    const financialYear = clean(req.body.financialYear || req.query.financialYear) || fyOf(req);
    const receipt = await salespersonReceiptById(req, financialYear, req.params.receiptId, { includeSecrets: true });
    if (receipt.customerOtpStatus !== "VERIFIED") return fail(res, "Verify customer OTP first", 409);
    if (receipt.cashierOtpStatus === "VERIFIED" && receipt.status === "POSTED") return fail(res, "Receipt is already completed", 409);
    const otp = await newReceiptOtp({ tenantKey: req.auth.tenantKey, receipt, type: "CASHIER" });
    receipt.cashierOtpId = otp.otpId;
    receipt.cashierOtpCode = otp.code;
    receipt.cashierOtpExpiresAt = otp.expiresAt;
    receipt.cashierOtpStatus = "PENDING";
    receipt.receiptWorkflowStatus = "PENDING_CASHIER_OTP";
    await receipt.save();
    return ok(res, { receipt: receiptForClient(receipt) }, "New cashier OTP generated");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/receipts/:receiptId/cashier-otp/verify", async (req, res) => {
  try {
    const financialYear = clean(req.body.financialYear || req.query.financialYear) || fyOf(req);
    const receipt = await salespersonReceiptById(req, financialYear, req.params.receiptId, { includeSecrets: true });
    if (receipt.customerOtpStatus !== "VERIFIED") return fail(res, "Customer OTP must be verified first", 409);
    if (receipt.cashierOtpStatus !== "VERIFIED") {
      const code = clean(req.body.code);
      if (!code) return fail(res, "Enter cashier OTP", 400);
      const result = await verifyOtp({ otpId: receipt.cashierOtpId, code });
      if (!result.ok) return fail(res, result.reason, 400);
      if (String(result.challenge.transactionId) !== String(receipt._id)) return fail(res, "OTP does not belong to this receipt", 403);
      receipt.cashierOtpStatus = "VERIFIED";
      receipt.cashierOtpVerifiedAt = new Date();
      receipt.cashierOtpVerifiedBy = req.auth.sub;
      receipt.cashierOtpVerifiedByNameSnapshot = req.auth.name || "";
      receipt.cashierOtpCode = undefined;
      receipt.receiptWorkflowStatus = "VERIFIED_PENDING_POSTING";
      await receipt.save();
    }
    const posted = await finalizeSalespersonReceipt({
      tenantKey: req.auth.tenantKey,
      financialYear,
      receipt,
      actorId: req.auth.sub,
      actorName: req.auth.name || "",
    });
    const customer = await requireVisibleCustomer(req, posted.customerGlobalId, { customerLinkId: clean(posted.customerLinkId) });
    const ledger = await buildCustomerReceivableLedger({ tenantKey: req.auth.tenantKey, financialYear, customer });
    const cash = upper(posted.mode) === "CASH"
      ? await cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: posted.collectedBySalespersonId || req.auth.sub })
      : null;
    return ok(res, { receipt: receiptForClient(posted), outstanding: money(ledger.closingSigned), cashInHand: cash?.cashInHand ?? null }, "Receipt fully verified and posted");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

// ---------------------------
// V2 Sales Person cash system
// ---------------------------
router.get("/cash/receivers", async (req, res) => {
  try {
    const items = await User.find({
      tenantKey: req.auth.tenantKey,
      status: "ACTIVE",
      _id: { $ne: req.auth.sub },
    }).select("name role accountType departmentId mobile").sort({ name: 1 }).limit(500).lean();
    return ok(res, { items: items.map((x) => ({ id: String(x._id), name: x.name || "User", role: x.role || x.accountType || "", mobile: x.mobile || "" })) });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/verification-inbox", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const admin = isAdminAuth(req.auth);
    const { SalespersonCashMovement, SalespersonDayClosing, SalesOrder } = financialModels(req.auth.tenantKey, financialYear);
    const movementFilter = { tenantKey: req.auth.tenantKey, financialYear, status: "PENDING", type: { $in: ["HANDOVER", "BANK_DEPOSIT"] } };
    if (!admin) movementFilter.recipientUserId = clean(req.auth.sub);
    const [movements, closings, creditHolds] = await Promise.all([
      SalespersonCashMovement.find(movementFilter).sort({ date: -1, createdAt: -1 }).limit(200).lean(),
      admin ? SalespersonDayClosing.find({ tenantKey: req.auth.tenantKey, financialYear, status: "REVIEW_REQUIRED" }).sort({ closingDate: -1 }).limit(200).lean() : Promise.resolve([]),
      admin ? SalesOrder.find({ tenantKey: req.auth.tenantKey, financialYear, status: "CREDIT_HOLD" }).sort({ date: -1, createdAt: -1 }).limit(200).lean() : Promise.resolve([]),
    ]);
    return ok(res, { movements, dayClosings: closings, creditHolds, admin, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/banks", async (req, res) => {
  try {
    const items = await BankAccount.find({ tenantKey: req.auth.tenantKey, status: "ACTIVE" })
      .select("bankAccountId bankName branchName accountHolderName accountNumber ifsc upiId isPrimary ledgerId")
      .sort({ isPrimary: -1, bankName: 1 }).lean();
    return ok(res, { items });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/customers/:globalId/cash-collection", async (_req, res) => {
  return fail(res, "Direct cash posting is disabled. Create the receipt and complete customer OTP verification.", 410);
});

router.get("/cash/collections", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const period = upper(req.query.period || "FY");
    const depositStatus = upper(req.query.depositStatus || "UNDEPOSITED");
    const at = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(at.getTime())) return fail(res, "Invalid date", 400);
    const { Receipt, SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);

    // Compatibility for receipts created under the earlier receipt-level cashier
    // OTP flow: customer-verified cash must immediately become Pending to Deposit.
    const legacyVerified = await Receipt.find({
      tenantKey: req.auth.tenantKey, financialYear, mode: "CASH", collectionSource: "SALESPERSON_APP",
      customerOtpStatus: "VERIFIED", status: { $nin: ["POSTED", "DELETED"] },
      $and: [collectionOwnerFilter(req.auth.sub)],
    }).limit(100);
    for (const legacy of legacyVerified) {
      try {
        legacy.cashierOtpStatus = "NOT_REQUIRED";
        legacy.receiptWorkflowStatus = "VERIFIED_PENDING_POSTING";
        await legacy.save();
        await finalizeSalespersonReceipt({ tenantKey: req.auth.tenantKey, financialYear, receipt: legacy, actorId: req.auth.sub, actorName: req.auth.name || "" });
      } catch (compatError) {
        console.warn("Unable to auto-complete legacy customer-verified cash receipt", legacy.receiptNo, compatError?.message || compatError);
      }
    }
    const viewerScope = await receiptViewerScope(req, req.query.createdByScope);
    const filter = {
      tenantKey: req.auth.tenantKey, financialYear, status: "POSTED", collectionSource: "SALESPERSON_APP",
      $and: [viewerScope],
    };
    if (depositStatus === "UNDEPOSITED") filter.$and.push(pendingCashDepositFilter());
    if (depositStatus === "DEPOSITED") filter.cashDepositStatus = "DEPOSITED_TO_CASHIER";
    if (period !== "UNDEPOSITED") {
      const range = collectionRange(period, at, financialYear, req.query);
      if (range) filter.date = { $gte: range.from, $lt: range.to };
    }
    const receipts = await Receipt.find(filter).sort({ date: -1, createdAt: -1 }).limit(1000).lean();
    const activeHandovers = await SalespersonCashMovement.find({
      tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, type: "HANDOVER",
      status: { $in: ["PENDING", "APPROVED"] },
      "partyIssues.0": { $exists: true },
    }).select("movementNo partyIssues").lean();
    const issues = cashIssueRows(activeHandovers);
    const items = receipts.map((r) => {
      const issue = issues.get(String(r._id)) || issues.get(clean(r.receiptNo)) || null;
      return {
        _id: String(r._id), receiptNo: r.receiptNo, date: r.date,
        customerGlobalId: r.customerGlobalId, partyName: r.partyNameSnapshot || "",
        createdById: receiptOwnerId(r),
        createdByName: r.collectedBySalespersonNameSnapshot || r.createdByNameSnapshot || "",
        isMine: receiptOwnerId(r) === clean(req.auth.sub),
        canDeposit: receiptOwnerId(r) === clean(req.auth.sub),
        mode: upper(r.receiptType)==="CHEQUE"||upper(r.mode)==="CHEQUE" ? "CHEQUE" : upper(r.mode), receiptType: upper(r.receiptType), amount: money(r.amount),
        cashDepositStatus: upper(r.cashDepositStatus) === "NOT_APPLICABLE" && upper(r.mode) === "BANK" ? "PENDING_TO_DEPOSIT" : (upper(r.cashDepositStatus) || "PENDING_TO_DEPOSIT"),
        ageDays: Math.max(0, Math.floor((startOfDay(new Date()).getTime() - startOfDay(new Date(r.date)).getTime()) / 86400000)),
        cashDepositBatchId: r.cashDepositBatchId || "", cashDepositedAt: r.cashDepositedAt || null, issue,
      };
    });
    const totals = items.reduce((acc, r) => {
      const amount = num(r.amount);
      if (r.mode === "CASH") acc.cash += amount;
      else acc.bank += amount;
      if (r.receiptType === "CHEQUE") acc.cheque += amount;
      if (r.receiptType === "UPI") acc.upi += amount;
      acc.grand += amount;
      return acc;
    }, { cash: 0, bank: 0, cheque: 0, upi: 0, grand: 0 });
    Object.keys(totals).forEach((k) => { totals[k] = money(totals[k]); });
    return ok(res, { financialYear, period, depositStatus, items, totals });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

// A salesperson may abandon the cashier OTP step (including by closing the app).
// Until the OTP is verified the handover is only a temporary reservation, NOT
// a deposit. Release only these unverified movements, never a verified/received
// movement. Keep cancelled movements in the audit trail.
const unverifiedCashHandover = {
  type: "HANDOVER", status: "PENDING", handoverOtpStatus: "PENDING",
  handoverWorkflowStatus: "PENDING_SALESPERSON_OTP",
};
async function releaseUnverifiedCashHandovers({ tenantKey, financialYear, salespersonId, movementId = "" }) {
  const { SalespersonCashMovement, Receipt } = financialModels(tenantKey, financialYear);
  const scope = { tenantKey, financialYear, salespersonId: clean(salespersonId), ...unverifiedCashHandover };
  if (movementId) scope._id = movementId;
  const waiting = await SalespersonCashMovement.find(scope).select("_id movementNo handoverOtpId receiptBreakdown").lean();
  const released = [];
  for (const item of waiting) {
    // Compare-and-set: cashier OTP verification and restart cannot both win.
    const movement = await SalespersonCashMovement.findOneAndUpdate(
      { ...scope, _id: item._id },
      { $set: { status: "CANCELLED", handoverWorkflowStatus: "CANCELLED", handoverOtpStatus: "CANCELLED" },
        $unset: { handoverOtpCode: "" } },
      { new: false },
    );
    if (!movement) continue; // OTP was verified/cancelled during the request.
    const receiptIds = (movement.receiptBreakdown || []).map(x => x.receiptId).filter(objectIdText);
    if (receiptIds.length) await Receipt.updateMany(
      { tenantKey, financialYear, _id: { $in: receiptIds },
        cashDepositStatus: "HANDOVER_PENDING", cashDepositBatchId: String(movement._id) },
      { $set: { cashDepositStatus: "PENDING_TO_DEPOSIT", cashDepositBatchId: "" } },
    );
    await GenericRecord.updateMany({tenantKey,app:'dms',resource:'cheque-control-received','data.cashierHandoverId':String(movement._id),
      'data.status':'HANDOVER_REQUESTED'},{$set:{'data.status':'PENDING_WITH_COLLECTOR','data.custodyStatus':'PENDING_WITH_COLLECTOR'},
        $unset:{'data.cashierHandoverId':''}});
    // Even if the physical OTP is still inside its TTL, it is now unusable.
    if (movement.handoverOtpId) await OtpChallenge.updateOne(
      { tenantKey, otpId: movement.handoverOtpId, transactionId: String(movement._id), status: "PENDING" },
      { $set: { status: "CANCELLED" } },
    );
    released.push(movement.movementNo);
  }
  return released;
}

// Invoked when Deposit to Cashier is opened again, as well as when Cancel &
// Restart is chosen from the OTP dialog. This also repairs already-stuck
// HANDOVER_PENDING receipts from older builds.
router.post("/cash/handovers/otp/restart", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const movementId = clean(req.body.movementId);
    const tenantKey = req.auth.tenantKey, salespersonId = req.auth.sub;
    if (movementId && !objectIdText(movementId)) return fail(res, "Invalid handover ID", 400);
    if (movementId) {
      const { SalespersonCashMovement } = financialModels(tenantKey, financialYear);
      const existing = await SalespersonCashMovement.findOne({
        _id: movementId, tenantKey, financialYear, salespersonId, type: "HANDOVER",
      }).select("status handoverOtpStatus handoverWorkflowStatus").lean();
      if (!existing) return fail(res, "Handover not found", 404);
      if (existing.status === "CANCELLED") return ok(res, { released: 0 }, "Handover already cancelled");
      if (existing.status !== "PENDING" || existing.handoverOtpStatus !== "PENDING" || existing.handoverWorkflowStatus !== "PENDING_SALESPERSON_OTP") {
        return fail(res, "Cashier OTP already verified or handover processed; it cannot be restarted", 409);
      }
    }
    const released = await releaseUnverifiedCashHandovers({ tenantKey, financialYear, salespersonId, movementId });
    if (movementId && released.length === 0) return fail(res, "Handover was verified during restart; refresh the deposit status", 409);
    return ok(res, { released: released.length, movementNos: released },
      released.length ? "Unverified handover cancelled; receipts are available to select again" : "No unfinished cashier OTP handovers");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/deposit-preview", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const period = upper(req.query.period || "FY");
    const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const filter = {
      tenantKey: req.auth.tenantKey, financialYear, status: "POSTED",
      // Collector owns both physical instruments until cashier handover.
      // Online / UPI / NEFT never enter the physical handover queue.
      collectionSource: "SALESPERSON_APP", customerOtpStatus: "VERIFIED",
      disputeStatus: { $ne: "HOLD" },
      $and: [collectionOwnerFilter(req.auth.sub), {
        $or: [{ mode: "CASH" }, { receiptType: "CHEQUE" }, { mode: "CHEQUE" }],
      }, { cashDepositStatus: { $in: ["PENDING_TO_DEPOSIT", null, "", "NOT_APPLICABLE"] } }],
    };
    const range = collectionRange(period, new Date(), financialYear, req.query);
    if (range) filter.date = { $gte: range.from, $lt: range.to };
    const receipts = await Receipt.find(filter).sort({ date: 1, createdAt: 1 }).lean();
    const items = receipts.map(r => ({
      _id: String(r._id), receiptNo: r.receiptNo, date: r.date,
      customerGlobalId: r.customerGlobalId, partyName: r.partyNameSnapshot || "",
      // Cheques normally use BANK as their accounting mode. Handing over the
      // physical cheque must still appear as CHEQUE in the collector app.
      mode: upper(r.receiptType) === "CHEQUE" || upper(r.mode) === "CHEQUE" ? "CHEQUE" : "CASH",
      receiptType: upper(r.receiptType),
      amount: money(r.amount), cashDenominations: r.cashDenominations || [],
    }));
    const totalCash = money(items.filter(x => x.mode === "CASH").reduce((sum,x)=>sum+num(x.amount),0));
    const totalBank = money(items.filter(x => x.mode === "CHEQUE").reduce((sum,x)=>sum+num(x.amount),0));
    const partyMap = new Map();
    for (const row of items) {
      const key = `${row.mode}:${clean(row.customerGlobalId || row.partyName)}`;
      const existing = partyMap.get(key) || { mode: row.mode, customerGlobalId: row.customerGlobalId, partyName: row.partyName, amount: 0, receiptNos: [] };
      existing.amount = money(existing.amount + num(row.amount)); existing.receiptNos.push(row.receiptNo); partyMap.set(key, existing);
    }
    return ok(res, { financialYear, period, items, parties: [...partyMap.values()], totalCash, totalBank, grandTotal: money(totalCash+totalBank) });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/issues", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const movements = await SalespersonCashMovement.find({
      tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, type: "HANDOVER", "partyIssues.0": { $exists: true },
    }).sort({ createdAt: -1 }).lean();
    const items = [];
    for (const movement of movements) for (const issue of movement.partyIssues || []) {
      if (["RESOLVED", "CANCELLED"].includes(upper(issue.status))) continue;
      items.push({
        batchId: String(movement._id), movementNo: movement.movementNo, issueId: issue.issueId,
        receiptId: issue.receiptId, receiptNo: issue.receiptNo, customerGlobalId: issue.customerGlobalId,
        partyName: issue.partyNameSnapshot, amount: money(issue.amount), reason: issue.reason, status: issue.status,
        acknowledgementOtp: issue.acknowledgementOtpCode || "", acknowledgementOtpExpiresAt: issue.acknowledgementOtpExpiresAt || null,
        raisedAt: issue.raisedAt || null,
      });
    }
    return ok(res, { financialYear, items });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cash/handovers/:movementId/issues/:issueId/resolve", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const { SalespersonCashMovement, OrderNotification } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({ _id: req.params.movementId, tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, type: "HANDOVER" });
    if (!movement) return fail(res, "Cash handover not found", 404);
    const issue = (movement.partyIssues || []).find((x) => clean(x.issueId) === clean(req.params.issueId));
    if (!issue) return fail(res, "Cash issue not found", 404);
    if (upper(issue.status) !== "ACKNOWLEDGED") return fail(res, "The cashier must first verify the salesperson issue OTP before this issue can be cleared", 409);
    if (!clean(req.body.remarks)) return fail(res, "Enter how the cash issue was cleared", 400);
    issue.status = "RESOLVED"; issue.resolvedAt = new Date(); issue.resolvedBy = req.auth.sub; issue.resolutionRemark = clean(req.body.remarks);
    const hasOpen = (movement.partyIssues || []).some((x) => !["RESOLVED", "CANCELLED"].includes(upper(x.status)));
    if (!hasOpen && movement.handoverOtpStatus === "VERIFIED") movement.handoverWorkflowStatus = "READY_FOR_CASHIER_COUNT";
    await movement.save();
    if (!hasOpen && movement.handoverOtpStatus === "VERIFIED") {
      const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
      await Receipt.updateMany({
        tenantKey: req.auth.tenantKey, financialYear,
        cashDepositBatchId: String(movement._id),
        receiptWorkflowStatus: "ISSUE_OPEN",
      }, { $set: { receiptWorkflowStatus: "READY_FOR_CASHIER_COUNT" } });
    }
    if (issue.customerGlobalId) await OrderNotification.create({
      tenantKey: req.auth.tenantKey, financialYear, notificationNo: makeId("NTF"), recipientType: "CUSTOMER", recipientId: issue.customerGlobalId,
      channel: "IN_APP", title: `Cash collection issue cleared • ${issue.receiptNo || "Receipt"}`,
      body: `The cash collection issue for ${issue.receiptNo || "your receipt"} has been cleared by ${req.auth.name || "the sales person"}.`,
      data: { notificationType: "CASH_COLLECTION_ISSUE", issueId: issue.issueId, receiptNo: issue.receiptNo, status: "RESOLVED", resolutionRemark: issue.resolutionRemark },
      status: "PENDING",
    });
    return ok(res, { movementNo: movement.movementNo, issueId: issue.issueId, status: issue.status }, "Issue marked as cleared");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/summary", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const at = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(at.getTime())) return fail(res, "Invalid date", 400);
    const [summary, target] = await Promise.all([
      cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, at }),
      collectionTargetForUser({ tenantKey: req.auth.tenantKey, financialYear, userId: req.auth.sub, at }),
    ]);
    const { SalespersonCashMovement, SalespersonDayClosing, Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const dayStart = startOfDay(at), dayEnd = endOfDay(at);
    const [recent, closing, collectedToday, verifiedPendingHandoverIds] = await Promise.all([
      SalespersonCashMovement.find({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub }).sort({ date: -1, createdAt: -1 }).limit(25).lean(),
      SalespersonDayClosing.findOne({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, dayKey: localDateKey(at) }).lean(),
      Receipt.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, status: "POSTED", collectionSource: "SALESPERSON_APP", date: { $gte: dayStart, $lt: dayEnd }, ...collectionOwnerFilter(req.auth.sub) } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // BANK receipts in an OTP-verified (but not yet DMS-approved) bundle
      // should stop appearing as "in hand" immediately. The receipt remains
      // HANDOVER_PENDING for the DMS approval workflow.
      SalespersonCashMovement.distinct("_id", {
        tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub,
        type: "HANDOVER", status: "PENDING", handoverOtpStatus: "VERIFIED",
      }),
    ]);
    const bankPending = await Receipt.aggregate([
      { $match: { tenantKey: req.auth.tenantKey, financialYear, status: "POSTED", collectionSource: "SALESPERSON_APP", ...collectionOwnerFilter(req.auth.sub), ...bankReceiptPendingFilter() } },
      { $group: { _id: null, amount: { $sum: "$amount" } } },
    ]);
    const bankHandoverPending = await Receipt.aggregate([
      { $match: { tenantKey: req.auth.tenantKey, financialYear, status: "POSTED", collectionSource: "SALESPERSON_APP", ...collectionOwnerFilter(req.auth.sub), mode: "BANK", cashDepositStatus: "HANDOVER_PENDING",
        cashDepositBatchId: { $nin: verifiedPendingHandoverIds.map(String) } } },
      { $group: { _id: null, amount: { $sum: "$amount" } } },
    ]);
    return ok(res, { ...summary, bankReceiptsInHand: money(num(bankPending?.[0]?.amount)+num(bankHandoverPending?.[0]?.amount)), collectionTodayTotal: money(collectedToday?.[0]?.total || 0), collectionTarget: target, recentMovements: recent, dayClosing: closing || null, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/movements", async (req, res) => {
  try {
    const financialYear = fyOf(req), page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 50)));
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const filter = { tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub };
    if (req.query.type) filter.type = upper(req.query.type);
    if (req.query.status) filter.status = upper(req.query.status);
    const [items, total] = await Promise.all([
      SalespersonCashMovement.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SalespersonCashMovement.countDocuments(filter),
    ]);
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cash/handover", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    // Collector initiates ONE handover for physical CASH and CHEQUE receipts.
    // Customer OTP proves the customer's payment, not company possession.
    // No online payment is eligible for a cashier physical handover.
    // The salesperson no longer selects a receiver. Route new handovers to the
    // company's active DMS cashier, with an administrator as a safe fallback.
    // Preserve explicit recipients for older app versions still in use.
    const explicitRecipientId = clean(req.body.recipientUserId);
    if (explicitRecipientId && !objectIdText(explicitRecipientId)) return fail(res, "Invalid cashier ID", 400);
    let receiver;
    if (explicitRecipientId) {
      receiver = await User.findOne({
        _id: explicitRecipientId, tenantKey: req.auth.tenantKey, status: "ACTIVE",
      }).select("name role").lean();
      if (!receiver) return fail(res, "Selected cashier is not active", 400);
    } else {
      const activeDmsUser = {
        tenantKey: req.auth.tenantKey, status: "ACTIVE", loginEnabled: { $ne: false },
        apps: "dms", _id: { $ne: req.auth.sub },
      };
      receiver = await User.findOne({
        ...activeDmsUser,
        $or: [
          { role: /CASHIER/i }, { accountType: /CASHIER/i },
          { designation: /CASHIER/i }, { designationCode: /CASHIER/i },
        ],
      }).select("name role").sort({ createdAt: 1, _id: 1 }).lean();
      if (!receiver) receiver = await User.findOne({
        ...activeDmsUser,
        role: { $in: [/^SUPERADMIN$/i, /^COMPANY_ADMIN$/i, /^DMS_ADMIN$/i, /^ADMIN$/i, /^ADMINISTRATOR$/i, /^MASTER$/i] },
      }).select("name role").sort({ createdAt: 1, _id: 1 }).lean();
      if (!receiver) return fail(res, "No active DMS cashier or administrator is available for handovers", 409);
    }
    const recipientUserId = String(receiver._id);

    const { Receipt, SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const requestedIds = new Set(jsonArray(req.body.receiptIds).map(clean).filter(Boolean));
    const receiptFilter = {
      tenantKey: req.auth.tenantKey, financialYear, status: "POSTED", collectionSource: "SALESPERSON_APP",
      customerOtpStatus: "VERIFIED", disputeStatus: { $ne: "HOLD" },
      $and: [collectionOwnerFilter(req.auth.sub),
        { $or: [{ mode: "CASH" }, { receiptType: "CHEQUE" }, { mode: "CHEQUE" }] },
        { cashDepositStatus: { $in: ["PENDING_TO_DEPOSIT", null, "", "NOT_APPLICABLE"] } },
      ],
    };
    if (requestedIds.size) {
      const objectIds = [...requestedIds].filter(objectIdText);
      receiptFilter.$and.push({ $or: [
        ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
        { receiptNo: { $in: [...requestedIds] } },
      ] });
    }
    const receipts = await Receipt.find(receiptFilter).sort({ date: 1, createdAt: 1 });
    if (!receipts.length) return fail(res, "There is no undeposited verified receipt to forward", 409);
    if (requestedIds.size && receipts.length !== requestedIds.size) return fail(res, "Some selected receipts are no longer available for deposit; refresh selection", 409);
    const amount = money(receipts.reduce((sum, r) => sum + num(r.amount), 0));
    const chequeReceipts=receipts.filter(r=>upper(r.receiptType)==="CHEQUE"||upper(r.mode)==="CHEQUE");
    const cashAmount = money(receipts.filter(r=>upper(r.mode)==="CASH" && upper(r.receiptType)!=="CHEQUE").reduce((sum,r)=>sum+num(r.amount),0));
    const bankAmount = money(chequeReceipts.reduce((sum,r)=>sum+num(r.amount),0));
    if (Math.abs(amount-cashAmount-bankAmount)>0.009) return fail(res,"Only physical cash and cheques can be handed over",409);
    // All cheques must have an exact linked control record BEFORE the bundle is reserved.
    for(const r of chequeReceipts){
      const cheque=await syncChequeForReceipt(r,req.auth);
      if(!cheque) return fail(res,`Cheque ${r.receiptNo} cannot be registered`,409);
      const doc=await GenericRecord.findOne({_id:cheque.id,tenantKey:req.auth.tenantKey,app:'dms',resource:'cheque-control-received'}).lean();
      if(!doc||!['PENDING_WITH_COLLECTOR','PENDING_WITH_SALESPERSON','HANDOVER_REQUESTED'].includes(upper(doc.data?.status)))
        return fail(res,`Cheque ${r.receiptNo} is already in another custody workflow`,409);
    }
    const denominations = cashAmount > 0 ? parseDenominations(req.body.denominations) : [];
    if (cashAmount > 0) assertDenominationsMatch(denominations, cashAmount, "cash handover");

    // Receipt custody is authoritative for a physical handover. The separate
    // cash day-book may contain legacy adjustments, already-approved handovers
    // or stale entries; none may turn an unhanded receipt into ₹0 available.
    // Re-read eligible CASH receipts to guard against changes during preview.
    const [availableRow] = await Receipt.aggregate([
      { $match: {
        tenantKey: req.auth.tenantKey, financialYear, status: 'POSTED', mode: 'CASH',
        receiptType: { $ne: 'CHEQUE' }, collectionSource: 'SALESPERSON_APP',
        customerOtpStatus: 'VERIFIED', disputeStatus: { $ne: 'HOLD' },
        cashDepositStatus: { $in: ['PENDING_TO_DEPOSIT', null, '', 'NOT_APPLICABLE'] },
        ...collectionOwnerFilter(req.auth.sub),
      } },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]);
    const available = money(availableRow?.amount || 0);
    if (cashAmount > available + 0.009) return fail(res, `Only ₹${available.toLocaleString("en-IN")} in undeposited, customer-verified cash receipts is available for a new handover`, 409, { available });

    let movementNo = makeId("HND");
    while (await SalespersonCashMovement.exists({ tenantKey: req.auth.tenantKey, financialYear, movementNo })) movementNo = makeId("HND");
    const movement = await SalespersonCashMovement.create({
      tenantKey: req.auth.tenantKey, financialYear, movementNo,
      salespersonId: req.auth.sub, salespersonNameSnapshot: req.auth.name || "",
      date: new Date(), dayKey: localDateKey(), type: "HANDOVER", direction: "OUT", amount, cashAmount, bankAmount,
      recipientUserId, recipientName: clean(receiver.name) || "Cashier",
      reference: clean(req.body.reference), remarks: clean(req.body.remarks), denominations,
      receiptBreakdown: receipts.map((r) => ({
        receiptId: String(r._id), receiptNo: r.receiptNo, customerGlobalId: r.customerGlobalId,
        customerNameSnapshot: r.partyNameSnapshot || "", amount: money(r.amount),
        mode: upper(r.receiptType)==="CHEQUE"||upper(r.mode)==="CHEQUE"?"CHEQUE":"CASH", receiptType: upper(r.receiptType),
        receiptDenominations: r.cashDenominations || [], collectedAt:r.customerOtpVerifiedAt||r.createdAt||r.date,
      })),
      handoverWorkflowStatus: "PENDING_SALESPERSON_OTP",
      handoverOtpStatus: "PENDING",
      status: "PENDING", createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "",
    });

    const otp = await createOtp({
      tenantKey: req.auth.tenantKey, transactionId: String(movement._id),
      actionType: "CASH_HANDOVER_CASHIER_TO_SALESPERSON", recipientId: req.auth.sub,
      context: { movementNo, amount, cashierId: recipientUserId, cashierName: movement.recipientName },
    });
    movement.handoverOtpId = otp.otpId;
    movement.handoverOtpCode = otp.code;
    movement.handoverOtpExpiresAt = otp.expiresAt;
    await movement.save();

    const claimed=[];
    try {
      for(const r of receipts){
        const updated=await Receipt.updateOne({_id:r._id,tenantKey:req.auth.tenantKey,financialYear,
          customerOtpStatus:'VERIFIED',disputeStatus:{$ne:'HOLD'},cashDepositStatus:{$in:['PENDING_TO_DEPOSIT',null,'','NOT_APPLICABLE']}},
          {$set:{cashDepositStatus:'HANDOVER_PENDING',cashDepositBatchId:String(movement._id)}});
        if(updated.modifiedCount!==1)throw Object.assign(new Error('A receipt was already reserved for handover. Refresh.'),{statusCode:409});
        claimed.push(r._id);
      }
      for(const r of chequeReceipts){
        const changed=await GenericRecord.updateOne({tenantKey:req.auth.tenantKey,app:'dms',resource:'cheque-control-received',
          'data.linkedReceiptNo':r.receiptNo,'data.linkedReceiptFy':financialYear,
          'data.status':{$in:['PENDING_WITH_COLLECTOR','PENDING_WITH_SALESPERSON','HANDOVER_REQUESTED']}},
          {$set:{'data.status':'HANDOVER_REQUESTED','data.custodyStatus':'HANDOVER_REQUESTED','data.cashierHandoverId':String(movement._id)}});
        if(changed.modifiedCount!==1)throw Object.assign(new Error('Cheque custody changed during handover. Please retry.'),{statusCode:409});
      }
    }catch(error){
      await Receipt.updateMany({_id:{$in:claimed},cashDepositBatchId:String(movement._id)},{$set:{cashDepositStatus:'PENDING_TO_DEPOSIT',cashDepositBatchId:''}});
      await GenericRecord.updateMany({tenantKey:req.auth.tenantKey,app:'dms',resource:'cheque-control-received','data.cashierHandoverId':String(movement._id)},
        {$set:{'data.status':'PENDING_WITH_COLLECTOR','data.custodyStatus':'PENDING_WITH_COLLECTOR'},$unset:{'data.cashierHandoverId':''}});
      await SalespersonCashMovement.updateOne({_id:movement._id},{$set:{status:'CANCELLED',handoverWorkflowStatus:'CANCELLED',handoverOtpStatus:'CANCELLED'}});
      throw error;
    }

    return ok(res, {
      movement: {
        _id: String(movement._id), movementNo: movement.movementNo, amount: movement.amount, cashAmount, bankAmount, receiptCount: receipts.length,
        recipientName: movement.recipientName, handoverWorkflowStatus: movement.handoverWorkflowStatus,
        handoverOtpStatus: movement.handoverOtpStatus, handoverOtpExpiresAt: movement.handoverOtpExpiresAt,
      },
    }, "Receipt(s) forwarded to cashier; enter the OTP shown on the cashier page", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

// Cashier-initiated pickup: private OTP is visible ONLY to the collector whose
// receipts the cashier selected. Cashier must enter this OTP in DMS.
router.get('/cash/cashier-pickups',async(req,res)=>{
 try{
  const financialYear=clean(req.query.financialYear)||req.defaultFinancialYear;
  const {SalespersonCashMovement}=financialModels(req.auth.tenantKey,financialYear);
  const rows=await SalespersonCashMovement.find({tenantKey:req.auth.tenantKey,financialYear,salespersonId:clean(req.auth.sub),
    type:'HANDOVER',status:'PENDING',handoverWorkflowStatus:'CASHIER_REQUESTED'}).select('+handoverOtpCode').sort({createdAt:-1}).limit(25).lean();
  return ok(res,{items:rows.map(r=>({id:String(r._id),movementNo:r.movementNo,amount:r.amount,receiptCount:r.receiptBreakdown?.length||0,
    cashierName:r.recipientName,otp:r.handoverOtpExpiresAt&&new Date(r.handoverOtpExpiresAt)>new Date()?r.handoverOtpCode||'':'',expiresAt:r.handoverOtpExpiresAt}))});
 }catch(e){return fail(res,e.message,e.statusCode||500);}
});
// Resume the collector's unverified handover rather than silently cancelling
// it when the mobile screen reloads or returns from the background.
router.get("/cash/handovers/pending-otp", async (req,res) => {
  try {
    const financialYear=fyOf(req);
    const {SalespersonCashMovement}=financialModels(req.auth.tenantKey,financialYear);
    const rows=await SalespersonCashMovement.find({tenantKey:req.auth.tenantKey,financialYear,
      salespersonId:req.auth.sub,type:'HANDOVER',status:'PENDING',handoverOtpStatus:'PENDING',
      handoverWorkflowStatus:'PENDING_SALESPERSON_OTP'}).sort({createdAt:-1}).limit(5).lean();
    const items=rows.map(m=>({_id:String(m._id),movementNo:m.movementNo,amount:money(m.amount),
      cashAmount:money(m.cashAmount||0),bankAmount:money(m.bankAmount||0),
      receiptCount:(m.receiptBreakdown||[]).length,recipientName:m.recipientName||'Cashier',
      handoverOtpStatus:m.handoverOtpStatus,handoverOtpExpiresAt:m.handoverOtpExpiresAt}));
    return ok(res,{items},items.length?'Unverified cashier handover can be resumed':'No pending cashier OTP handover');
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/cash/handovers/:movementId/otp/verify", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({
      _id: req.params.movementId, tenantKey: req.auth.tenantKey, financialYear,
      salespersonId: req.auth.sub, type: "HANDOVER", status: "PENDING",
    });
    if (!movement) return fail(res, "Pending cash handover not found", 404);
    if (movement.handoverOtpStatus === "VERIFIED") return ok(res, { movementNo: movement.movementNo, status: movement.handoverWorkflowStatus }, "Handover OTP is already verified");
    const code = clean(req.body.code);
    if (!code) return fail(res, "Enter the cashier handover OTP", 400);
    const result = await verifyOtp({ otpId: movement.handoverOtpId, code });
    if (!result.ok) return fail(res, result.reason, 400);
    if (String(result.challenge.transactionId) !== String(movement._id) || String(result.challenge.recipientId) !== String(req.auth.sub)) return fail(res, "OTP does not belong to this cash handover", 409);
    if ((movement.partyIssues||[]).some(x=>!["RESOLVED","CANCELLED"].includes(upper(x.status))))
      return fail(res,"Resolve open handover issues before Cashier OTP confirmation",409);
    const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const receiptIds = (movement.receiptBreakdown || []).map(r=>r.receiptId).filter(objectIdText);
    if(receiptIds.length!==(movement.receiptBreakdown||[]).length || !receiptIds.length)
      return fail(res,"A handover must contain valid original receipts",409);
    const live=await Receipt.find({_id:{$in:receiptIds},tenantKey:req.auth.tenantKey,financialYear,
      status:"POSTED",customerOtpStatus:"VERIFIED",cashDepositBatchId:String(movement._id),cashDepositStatus:"HANDOVER_PENDING",disputeStatus:{$ne:"HOLD"}}).lean();
    if(live.length!==receiptIds.length)return fail(res,"A receipt changed before handover verification; refresh the deposit",409);
    const chequeRows=movement.receiptBreakdown.filter(r=>upper(r.mode)==="CHEQUE");
    for(const row of chequeRows){
      const linked=await GenericRecord.exists({tenantKey:req.auth.tenantKey,app:"dms",resource:"cheque-control-received",
        "data.linkedReceiptNo":row.receiptNo,"data.linkedReceiptFy":financialYear,
        "data.cashierHandoverId":String(movement._id),"data.status":"HANDOVER_REQUESTED"});
      if(!linked)return fail(res,`Cheque ${row.receiptNo} has changed custody; repair its linked register before handover`,409);
    }
    const now=new Date();
    // Custody is accepted at the moment Collector enters Cashier OTP. There is
    // no second Confirm/Close Cashier action. This CAS cannot resurrect a
    // handover cancelled via Cancel & Restart.
    const verified=await SalespersonCashMovement.findOneAndUpdate(
      {_id:movement._id,tenantKey:req.auth.tenantKey,financialYear,salespersonId:req.auth.sub,type:"HANDOVER",...unverifiedCashHandover},
      {$set:{handoverOtpStatus:"VERIFIED",handoverOtpVerifiedAt:now,handoverWorkflowStatus:"RECEIVED",status:"APPROVED",
        cashierReceivedAt:now,cashierReceivedBy:movement.recipientUserId,cashierReceivedByNameSnapshot:movement.recipientName,
        verifiedBy:movement.recipientUserId,verifiedByNameSnapshot:movement.recipientName,verifiedAt:now},
        $unset:{handoverOtpCode:""}},{new:true});
    if(!verified)return fail(res,"Handover was cancelled or already verified; refresh Deposit to Cashier",409);
    await Receipt.updateMany({_id:{$in:receiptIds},tenantKey:req.auth.tenantKey,financialYear,
      cashDepositBatchId:String(verified._id),cashDepositStatus:"HANDOVER_PENDING"},{$set:{
      cashDepositStatus:"DEPOSITED_TO_CASHIER",cashDepositedAt:now,cashDepositedBy:movement.recipientUserId,
      cashDepositedByNameSnapshot:movement.recipientName,cashierOtpStatus:"VERIFIED",cashierOtpVerifiedAt:now,
      cashierOtpVerifiedBy:movement.recipientUserId,cashierOtpVerifiedByNameSnapshot:movement.recipientName,
      receiptWorkflowStatus:"WITH_CASHIER"}});
    for(const row of chequeRows){
      await GenericRecord.updateOne({tenantKey:req.auth.tenantKey,app:"dms",resource:"cheque-control-received",
        "data.linkedReceiptNo":row.receiptNo,"data.linkedReceiptFy":financialYear,
        "data.cashierHandoverId":String(verified._id),"data.status":"HANDOVER_REQUESTED"},
        {$set:{"data.status":"WITH_CASHIER","data.custodyStatus":"WITH_CASHIER",
          "data.cashierUserId":movement.recipientUserId,"data.cashierReceivedAt":now.toISOString(),
          "data.statusDate":now.toISOString().slice(0,10)}});
    }
    return ok(res,{movementNo:verified.movementNo,status:"RECEIVED"},
      "Cashier OTP verified: cash and cheques are now with Cashier. Ledger posting requires a separate authorized action.");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cash/bank-deposit", async (req, res) => {
  try {
    const financialYear = fyOf(req), amount = money(req.body.amount);
    if (amount <= 0) return fail(res, "Deposit amount must be greater than zero", 400);
    const summary = await cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub });
    const available = money(Math.max(0, summary.cashInHand - summary.pendingTotal));
    if (amount > available) return fail(res, `Only ₹${available.toLocaleString("en-IN")} is available for a new handover/deposit request`, 409, { cashInHand: summary.cashInHand, pendingTotal: summary.pendingTotal, available });
    const bank = await BankAccount.findOne({ tenantKey: req.auth.tenantKey, bankAccountId: clean(req.body.bankAccountId), status: "ACTIVE" }).lean();
    if (!bank) return fail(res, "Select a valid company bank account", 400);
    const reference = clean(req.body.reference);
    if (!reference) return fail(res, "Bank deposit reference / slip number is required", 400);
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    let movementNo = makeId("DEP"); while (await SalespersonCashMovement.exists({ tenantKey: req.auth.tenantKey, financialYear, movementNo })) movementNo = makeId("DEP");
    const movement = await SalespersonCashMovement.create({
      tenantKey: req.auth.tenantKey, financialYear, movementNo, salespersonId: req.auth.sub, salespersonNameSnapshot: req.auth.name || "",
      date: new Date(), dayKey: localDateKey(), type: "BANK_DEPOSIT", direction: "OUT", amount,
      bankAccountId: bank.bankAccountId, bankNameSnapshot: bank.bankName, reference, proofReference: clean(req.body.proofReference), remarks: clean(req.body.remarks),
      status: "PENDING", createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "",
    });
    return ok(res, movement, "Bank deposit submitted for verification", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/cash/movements/:id/cancel", async (req, res) => {
  try {
    const financialYear = fyOf(req); const { SalespersonCashMovement, Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, type: { $in: ["HANDOVER", "BANK_DEPOSIT"] } });
    if (!movement) return fail(res, "Cash movement not found", 404);
    if (movement.status !== "PENDING") return fail(res, "Only pending handover/deposit requests can be cancelled", 409);
    if (movement.type === "HANDOVER" && upper(movement.handoverOtpStatus) === "VERIFIED") {
      return fail(res, "Cashier OTP already verified; this handover cannot be restarted or cancelled by the salesperson", 409);
    }
    if (movement.type === "HANDOVER" && upper(movement.handoverWorkflowStatus) === "PENDING_SALESPERSON_OTP") {
      const released = await releaseUnverifiedCashHandovers({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, movementId: String(movement._id) });
      if (!released.length) return fail(res, "Handover was already processed; refresh its status", 409);
      return ok(res, { movementNo: movement.movementNo, status: "CANCELLED" }, "Unverified cashier OTP handover cancelled; receipts released");
    }
    movement.status = "CANCELLED"; movement.handoverWorkflowStatus = movement.type === "HANDOVER" ? "CANCELLED" : movement.handoverWorkflowStatus; movement.remarks = [movement.remarks, clean(req.body.remarks)].filter(Boolean).join(" | "); await movement.save();
    if (movement.type === "HANDOVER" && (movement.receiptBreakdown || []).length) {
      await Receipt.updateMany(
        { _id: { $in: movement.receiptBreakdown.map((x) => x.receiptId).filter(Boolean) }, cashDepositBatchId: String(movement._id) },
        { $set: { cashDepositStatus: "PENDING_TO_DEPOSIT", cashDepositBatchId: "" } },
      );
    }
    return ok(res, movement, "Request cancelled");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/cash/movements/:id/verify", async (req, res) => {
  try {
    const financialYear = fyOf(req); const { SalespersonCashMovement, LedgerEntry } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, type: { $in: ["HANDOVER", "BANK_DEPOSIT"] } });
    if (!movement) return fail(res, "Cash movement not found", 404);
    const handoverWorkflow = upper(movement.handoverWorkflowStatus);
    if (movement.type === "HANDOVER" && handoverWorkflow && handoverWorkflow !== "LEGACY") {
      return fail(res, "This cash handover uses the cashier count workflow and must be received from the DMS Cashier page", 409);
    }
    const receiverMatch = clean(movement.recipientUserId) && clean(movement.recipientUserId) === clean(req.auth.sub);
    if (!isAdminAuth(req.auth) && !receiverMatch) return fail(res, "Only the assigned receiver or an administrator can verify this movement", 403);
    if (movement.status !== "PENDING") return ok(res, movement, `Movement is already ${movement.status}`);
    const action = upper(req.body.action || "APPROVE");
    if (!['APPROVE','REJECT'].includes(action)) return fail(res, "Action must be APPROVE or REJECT", 400);
    if (action === "REJECT") {
      movement.status = "REJECTED"; movement.rejectionReason = clean(req.body.remarks || req.body.reason); movement.verifiedBy = req.auth.sub; movement.verifiedByNameSnapshot = req.auth.name || ""; movement.verifiedAt = new Date(); await movement.save();
      return ok(res, movement, "Cash movement rejected");
    }
    if (movement.type === "BANK_DEPOSIT") {
      const bank = await BankAccount.findOne({ tenantKey: req.auth.tenantKey, bankAccountId: movement.bankAccountId, status: "ACTIVE" }).lean();
      if (!bank) return fail(res, "The selected company bank account is no longer active", 409);
      const transactionId = `CASHDEP-${movement.movementNo}`;
      const exists = await LedgerEntry.exists({ tenantKey: req.auth.tenantKey, financialYear, transactionId, status: "POSTED" });
      if (!exists) await postBalancedEntries({
        tenantKey: req.auth.tenantKey, financialYear, transactionId, transactionType: "SALESPERSON_BANK_DEPOSIT", date: movement.date,
        narration: movement.remarks || `Cash deposited to ${bank.bankName}`,
        entries: [
          { accountCode: "SYS_BANK_ACCOUNT", ledgerId: bank.ledgerId || "", bankAccountId: bank.bankAccountId, debit: num(movement.amount) },
          { accountCode: "SYS_CASH", credit: num(movement.amount) },
        ],
      });
      movement.accountingTransactionId = transactionId;
    }
    movement.status = "APPROVED"; movement.verifiedBy = req.auth.sub; movement.verifiedByNameSnapshot = req.auth.name || ""; movement.verifiedAt = new Date(); await movement.save();
    return ok(res, movement, movement.type === "HANDOVER" ? "Cash handover verified" : "Bank deposit verified");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/day-closing/preview", async (req, res) => {
  try {
    const financialYear = fyOf(req), at = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(at.getTime())) return fail(res, "Invalid closing date", 400);
    const summary = await cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, at });
    const { Receipt, SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const from = startOfDay(at), to = endOfDay(at);
    const base = { tenantKey: req.auth.tenantKey, financialYear, status: "POSTED", collectionSource: "SALESPERSON_APP", ...collectionOwnerFilter(req.auth.sub) };
    const [todayReceipts, bankOpen, bankClosed, bankReceivedToday, movements] = await Promise.all([
      Receipt.find({ ...base, date: { $gte: from, $lt: to } }).sort({ date: -1 }).lean(),
      Receipt.aggregate([{ $match: { ...base, mode: "BANK", date: { $lt: from }, $and: [collectionOwnerFilter(req.auth.sub), { $or: [{ cashDepositedAt: { $exists: false } }, { cashDepositedAt: null }, { cashDepositedAt: { $gte: from } }] }] } },{ $group: { _id: null, total: { $sum: "$amount" } } }]),
      Receipt.aggregate([{ $match: { ...base, mode: "BANK", date: { $lt: to }, $and: [collectionOwnerFilter(req.auth.sub), { $or: [{ cashDepositedAt: { $exists: false } }, { cashDepositedAt: null }, { cashDepositedAt: { $gte: to } }] }] } },{ $group: { _id: null, total: { $sum: "$amount" } } }]),
      Receipt.aggregate([{ $match: { ...base, mode: "BANK", cashDepositedAt: { $gte: from, $lt: to } } },{ $group: { _id: null, total: { $sum: "$amount" } } }]),
      SalespersonCashMovement.find({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, type: "HANDOVER", status: "APPROVED", cashierReceivedAt: { $gte: from, $lt: to } }).lean(),
    ]);
    const bankCollectedToday = money(todayReceipts.filter(r=>upper(r.mode)==="BANK").reduce((t,r)=>t+num(r.amount),0));
    const cashCollectedToday = money(todayReceipts.filter(r=>upper(r.mode)==="CASH").reduce((t,r)=>t+num(r.amount),0));
    const transactions = [
      ...todayReceipts.map(r=>({ id: String(r._id), date:r.date, type:"COLLECTION", receiptNo:r.receiptNo, partyName:r.partyNameSnapshot||"", mode:upper(r.mode), receiptType:upper(r.receiptType), amount:money(r.amount), depositStatus:upper(r.cashDepositStatus) })),
      ...movements.flatMap(m=>(m.receiptBreakdown||[]).map(r=>({ id:`${m._id}:${r.receiptId||r.receiptNo}`, date:m.cashierReceivedAt, type:"CASHIER RECEIVED", receiptNo:r.receiptNo, partyName:r.customerNameSnapshot||"", mode:upper(r.mode||"CASH"), receiptType:upper(r.receiptType), amount:-money(r.amount), depositStatus:"DEPOSITED_TO_CASHIER" }))),
    ].sort((a,b)=>new Date(b.date)-new Date(a.date));
    return ok(res, { ...summary, expectedClosing: summary.cashInHand, date: localDateKey(at), financialYear,
      bankOpening:money(bankOpen?.[0]?.total), bankCollectedToday, bankDepositedToday:money(bankReceivedToday?.[0]?.total), bankClosing:money(bankClosed?.[0]?.total), cashCollectedToday, transactions });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cash/day-closing", async (req, res) => {
  try {
    const financialYear = fyOf(req), at = req.body.date ? new Date(req.body.date) : new Date();
    if (Number.isNaN(at.getTime())) return fail(res, "Invalid closing date", 400);
    const declaredClosing = money(req.body.declaredClosing);
    if (declaredClosing < 0) return fail(res, "Declared cash cannot be negative", 400);
    const summary = await cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, at });
    const expectedClosing = money(summary.cashInHand), variance = money(declaredClosing - expectedClosing);
    const varianceType = Math.abs(variance) <= 0.01 ? "NONE" : variance < 0 ? "SHORTAGE" : "EXCESS";
    if (varianceType !== "NONE" && !clean(req.body.remarks)) return fail(res, "A remark is required when declared cash differs from expected cash", 400);
    const { SalespersonDayClosing } = financialModels(req.auth.tenantKey, financialYear);
    const key = localDateKey(at);
    const existing = await SalespersonDayClosing.findOne({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, dayKey: key });
    if (existing && ["APPROVED", "REVIEW_REQUIRED"].includes(existing.status)) return fail(res, `Day closing for ${key} is already ${existing.status}`, 409);
    let closingNo = existing?.closingNo || makeId("CLOSE"); while (!existing && await SalespersonDayClosing.exists({ tenantKey: req.auth.tenantKey, financialYear, closingNo })) closingNo = makeId("CLOSE");
    const payload = {
      tenantKey: req.auth.tenantKey, financialYear, closingNo, salespersonId: req.auth.sub, salespersonNameSnapshot: req.auth.name || "",
      dayKey: key, closingDate: at,
      openingCash: summary.openingCash, cashCollected: summary.cashCollectedToday,
      approvedHandover: summary.handoverApprovedToday, approvedBankDeposit: summary.bankDepositApprovedToday,
      approvedAdjustmentsIn: money(summary.excessApprovedToday + summary.adjustmentsInToday),
      approvedAdjustmentsOut: money(summary.shortageApprovedToday + summary.adjustmentsOutToday),
      expectedClosing, declaredClosing, variance, varianceType, remarks: clean(req.body.remarks),
      status: varianceType === "NONE" ? "CLOSED" : "REVIEW_REQUIRED",
      createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "",
    };
    const closing = existing ? await SalespersonDayClosing.findByIdAndUpdate(existing._id, { $set: payload }, { new: true }) : await SalespersonDayClosing.create(payload);
    return ok(res, closing, varianceType === "NONE" ? "Day closed successfully" : `${varianceType} recorded and sent for review`, existing ? 200 : 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/day-closings", async (req, res) => {
  try {
    const financialYear = fyOf(req), page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
    const { SalespersonDayClosing } = financialModels(req.auth.tenantKey, financialYear);
    const filter = { tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub };
    const [items, total] = await Promise.all([
      SalespersonDayClosing.find(filter).sort({ closingDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SalespersonDayClosing.countDocuments(filter),
    ]);
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/cash/day-closings/:id/review", async (req, res) => {
  try {
    if (!isAdminAuth(req.auth)) return fail(res, "Administrator approval is required", 403);
    const financialYear = fyOf(req); const { SalespersonDayClosing, SalespersonCashMovement, LedgerEntry } = financialModels(req.auth.tenantKey, financialYear);
    const closing = await SalespersonDayClosing.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!closing) return fail(res, "Day closing not found", 404);
    if (closing.status !== "REVIEW_REQUIRED") return ok(res, closing, `Day closing is already ${closing.status}`);
    const action = upper(req.body.action || "APPROVE");
    if (!['APPROVE','REJECT'].includes(action)) return fail(res, "Action must be APPROVE or REJECT", 400);
    if (action === "REJECT") {
      closing.status = "REJECTED"; closing.reviewRemark = clean(req.body.remarks); closing.reviewedBy = req.auth.sub; closing.reviewedByNameSnapshot = req.auth.name || ""; closing.reviewedAt = new Date(); await closing.save();
      return ok(res, closing, "Day closing rejected for correction");
    }
    const variance = num(closing.variance);
    if (Math.abs(variance) > 0.01 && !closing.varianceMovementId) {
      const isExcess = variance > 0, amount = money(Math.abs(variance));
      let movementNo = makeId(isExcess ? "EXC" : "SHT"); while (await SalespersonCashMovement.exists({ tenantKey: req.auth.tenantKey, financialYear, movementNo })) movementNo = makeId(isExcess ? "EXC" : "SHT");
      const transactionId = `CASHVAR-${closing.closingNo}`;
      const exists = await LedgerEntry.exists({ tenantKey: req.auth.tenantKey, financialYear, transactionId, status: "POSTED" });
      if (!exists) await postBalancedEntries({
        tenantKey: req.auth.tenantKey, financialYear, transactionId, transactionType: isExcess ? "CASH_EXCESS" : "CASH_SHORTAGE", date: closing.closingDate,
        narration: closing.reviewRemark || closing.remarks || `${closing.varianceType} at day closing`,
        entries: isExcess
          ? [{ accountCode: "SYS_CASH", debit: amount }, { accountCode: "SYS_INDIRECT_INCOME", credit: amount }]
          : [{ accountCode: "SYS_INDIRECT_EXPENSE", debit: amount }, { accountCode: "SYS_CASH", credit: amount }],
      });
      const movement = await SalespersonCashMovement.create({
        tenantKey: req.auth.tenantKey, financialYear, movementNo, salespersonId: closing.salespersonId, salespersonNameSnapshot: closing.salespersonNameSnapshot,
        date: closing.closingDate, dayKey: closing.dayKey, type: isExcess ? "EXCESS" : "SHORTAGE", direction: isExcess ? "IN" : "OUT", amount,
        sourceDayClosingId: String(closing._id), remarks: closing.remarks, status: "APPROVED",
        verifiedBy: req.auth.sub, verifiedByNameSnapshot: req.auth.name || "", verifiedAt: new Date(), accountingTransactionId: transactionId,
        createdBy: closing.createdBy, createdByNameSnapshot: closing.createdByNameSnapshot,
      });
      closing.varianceMovementId = String(movement._id);
    }
    closing.status = "APPROVED"; closing.reviewRemark = clean(req.body.remarks); closing.reviewedBy = req.auth.sub; closing.reviewedByNameSnapshot = req.auth.name || ""; closing.reviewedAt = new Date(); await closing.save();
    return ok(res, closing, "Day closing variance approved and adjusted");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});


// ---------------- V2 FIELD ROUTE / VISIT SYSTEM ----------------
const routePriorityWeight = (priority = "") => ({ CRITICAL: 70, HIGH: 45, MEDIUM: 24, NORMAL: 8 }[upper(priority)] || 8);
const routeActionServiceMinutes = (action = "") => ({ COLLECT: 16, ORDER: 22, CUSTOMER: 18, LEAD: 15 }[upper(action)] || 18);
const routeRoadMeters = (a, b) => {
  const direct = haversine({ latitude: a?.lat ?? a?.latitude, longitude: a?.lng ?? a?.longitude }, { latitude: b?.lat ?? b?.latitude, longitude: b?.lng ?? b?.longitude });
  return Number.isFinite(direct) ? Math.round(direct * 1.22) : 0;
};
const routeTravelMinutes = (meters) => Math.max(1, Math.round((Math.max(0, num(meters)) / 1000) / 24 * 60));

function orderRouteCandidates(items = [], startLocation, maxStops = 12) {
  const remaining = [...items].filter((x) => validCoord(x.latitude, x.longitude));
  const ordered = [];
  let cursor = { lat: Number(startLocation?.lat ?? startLocation?.latitude), lng: Number(startLocation?.lng ?? startLocation?.longitude) };
  while (remaining.length && ordered.length < Math.max(1, Math.min(30, Number(maxStops || 12)))) {
    let bestIndex = 0, bestUtility = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const row = remaining[i];
      const distanceMeters = routeRoadMeters(cursor, { lat: row.latitude, lng: row.longitude });
      const distancePenalty = Math.min(85, distanceMeters / 700);
      const valueBoost = Math.min(35, num(row.amount) / 4000);
      const utility = num(row.score) + routePriorityWeight(row.priority) + valueBoost - distancePenalty;
      if (utility > bestUtility) { bestUtility = utility; bestIndex = i; }
    }
    const row = remaining.splice(bestIndex, 1)[0];
    const legMeters = routeRoadMeters(cursor, { lat: row.latitude, lng: row.longitude });
    ordered.push({ ...row, legMeters, travelMinutes: routeTravelMinutes(legMeters) });
    cursor = { lat: row.latitude, lng: row.longitude };
  }
  return ordered;
}

function buildRouteStops(items = [], startLocation, startAt = new Date()) {
  let eta = new Date(startAt);
  return items.map((row, index) => {
    eta = new Date(eta.getTime() + num(row.travelMinutes) * 60000);
    const stop = {
      stopId: makeId("STOP"), sequence: index + 1, customerGlobalId: row.customerGlobalId,
      customerNameSnapshot: row.customerName, mobileSnapshot: row.mobile, addressSnapshot: row.address,
      citySnapshot: row.city, pincodeSnapshot: row.pincode, location: { lat: row.latitude, lng: row.longitude },
      priority: row.priority, score: num(row.score), opportunityType: row.opportunityType, recommendedAction: row.recommendedAction,
      reason: row.reason, opportunityAmount: money(row.amount), collectionAmount: upper(row.recommendedAction) === "COLLECT" ? money(row.amount) : 0,
      status: "PENDING", estimatedDistanceFromPreviousMeters: num(row.legMeters), estimatedTravelMinutes: num(row.travelMinutes), estimatedArrivalAt: new Date(eta),
    };
    eta = new Date(eta.getTime() + routeActionServiceMinutes(row.recommendedAction) * 60000);
    return stop;
  });
}

function recomputeRoutePlan(plan) {
  const stops = Array.isArray(plan.stops) ? plan.stops : [];
  plan.completedStops = stops.filter((x) => x.status === "COMPLETED").length;
  plan.skippedStops = stops.filter((x) => x.status === "SKIPPED").length;
  plan.estimatedDistanceMeters = money(stops.reduce((s, x) => s + num(x.estimatedDistanceFromPreviousMeters), 0));
  plan.estimatedTravelMinutes = Math.round(stops.reduce((s, x) => s + num(x.estimatedTravelMinutes), 0));
  plan.estimatedWorkMinutes = Math.round(stops.reduce((s, x) => s + num(x.estimatedTravelMinutes) + routeActionServiceMinutes(x.recommendedAction), 0));
  plan.totalOpportunityAmount = money(stops.reduce((s, x) => s + num(x.opportunityAmount), 0));
  plan.totalCollectionAmount = money(stops.reduce((s, x) => s + num(x.collectionAmount), 0));
  const terminal = stops.length > 0 && stops.every((x) => ["COMPLETED", "SKIPPED"].includes(x.status));
  if (terminal && plan.status !== "CANCELLED") { plan.status = "COMPLETED"; plan.completedAt = plan.completedAt || new Date(); }
  return plan;
}

async function completeRouteStopFromVisit({ tenantKey, salespersonId, customerGlobalId, visit, distanceMeters = null }) {
  const dateKey = localDateKey(visit?.startedAt || new Date());
  const plan = await SalesRoutePlan.findOne({ tenantKey, salespersonId: String(salespersonId), dateKey, status: { $in: ["READY", "IN_PROGRESS"] }, "stops.customerGlobalId": customerGlobalId }).sort({ updatedAt: -1 });
  if (!plan) return null;
  const stop = (plan.stops || []).find((x) => x.customerGlobalId === customerGlobalId && !["COMPLETED", "SKIPPED"].includes(x.status));
  if (!stop) return plan;
  stop.status = "COMPLETED"; stop.completedAt = visit?.endedAt || new Date(); stop.arrivedAt = stop.arrivedAt || visit?.startedAt || new Date(); stop.outcome = clean(visit?.outcome) || "VISIT_COMPLETED"; stop.visitId = String(visit?._id || visit?.visitId || "");
  if (Number.isFinite(Number(distanceMeters))) stop.actualDistanceOnArrivalMeters = money(distanceMeters);
  if (plan.status === "READY") { plan.status = "IN_PROGRESS"; plan.startedAt = plan.startedAt || visit?.startedAt || new Date(); }
  recomputeRoutePlan(plan); plan.updatedBy = salespersonId; await plan.save(); return plan;
}

async function routePlanAccessFilter(req, salespersonId = "") {
  const scope = await visibility(req); const requested = clean(salespersonId);
  if (!requested) return { salespersonId: req.auth.sub, scope };
  if (requested === String(req.auth.sub)) return { salespersonId: requested, scope };
  if (scope.unrestricted || (scope.userIds || []).map(String).includes(requested)) return { salespersonId: requested, scope };
  const err = new Error("Salesperson is outside your assigned sales hierarchy"); err.statusCode = 403; throw err;
}

router.get("/field/customers", async (req, res) => {
  try {
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    const rows = await CustomerLink.find(filter)
      .select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses location salespersonId")
      .lean();
    const items = rows.map((c) => {
      const geo = customerCoordinates(c); if (!geo) return null;
      const address = billingAddress(c);
      return {
        _id: c.globalCustomerId, id: c.globalCustomerId, globalCustomerId: c.globalCustomerId,
        CompanyName: customerName(c), name: customerName(c), mobile: customerMobile(c),
        CompanyAddress: address.address || "", address: address.address || "", City: address.city || "", State: address.state || "", Pincode: address.pincode || "",
        city: address.city || "", state: address.state || "", pincode: address.pincode || "",
        latitude: geo.latitude, longitude: geo.longitude, accuracy: geo.accuracy,
        geotagging: `${geo.latitude},${geo.longitude}`,
      };
    }).filter(Boolean);
    return ok(res, { items, total: items.length });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/visits", async (req, res) => {
  try {
    const page=Math.max(1,Number(req.query.page||1)), limit=Math.min(200,Math.max(10,Number(req.query.limit||100)));
    const filter={tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,status:{$ne:"CANCELLED"}};
    if(clean(req.query.customerGlobalId)) filter.customerGlobalId=clean(req.query.customerGlobalId);
    if(clean(req.query.from)){const d=new Date(req.query.from);if(!Number.isNaN(d.getTime()))filter.startedAt={$gte:startOfDay(d)};}
    if(clean(req.query.to)){const d=new Date(req.query.to);if(!Number.isNaN(d.getTime()))filter.startedAt={...(filter.startedAt||{}),$lt:endOfDay(d)};}
    const [items,total]=await Promise.all([CustomerVisit.find(filter).sort({startedAt:-1}).skip((page-1)*limit).limit(limit).lean(),CustomerVisit.countDocuments(filter)]);
    return ok(res,{items,meta:pageMeta(page,limit,total)});
  } catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/customers/:globalId/visits", async (req, res) => {
  try {
    const customer=await requireVisibleCustomer(req,req.params.globalId), geo=customerCoordinates(customer);
    if(!geo)return fail(res,"Customer has no saved geolocation",400);
    const lat=Number(req.body.latitude??req.body.lat), lng=Number(req.body.longitude??req.body.lng), accuracy=num(req.body.accuracy??req.body.gpsAccuracy);
    if(!validCoord(lat,lng))return fail(res,"Valid current GPS location is required",400);
    if(accuracy>30)return fail(res,`GPS accuracy is too low (${Math.round(accuracy)} m). Move to an open area and try again.`,400);
    const distance=haversine({latitude:lat,longitude:lng},geo);
    if(!Number.isFinite(distance)||distance>10)return fail(res,`Visit can only be created within 10 m of the customer. Current distance is about ${Math.round(distance)} m.`,400,{distanceMeters:distance});
    const clientMutationId=clean(req.body.clientMutationId);
    if(clientMutationId){const existing=await CustomerVisit.findOne({tenantKey:req.auth.tenantKey,clientMutationId}).lean();if(existing)return ok(res,{visit:existing,deduplicated:true},"Visit already synced");}
    let visitId=makeId("VIS");while(await CustomerVisit.exists({visitId}))visitId=makeId("VIS");
    const now=new Date();
    const visit=await CustomerVisit.create({tenantKey:req.auth.tenantKey,visitId,clientMutationId:clientMutationId||undefined,financialYear:fyOf(req),customerGlobalId:customer.globalCustomerId,customerNameSnapshot:customerName(customer),salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",tripId:clean(req.body.tripId),visitType:"MANUAL",status:"COMPLETED",startedAt:now,endedAt:now,durationSeconds:0,outcome:clean(req.body.outcome),note:clean(req.body.note),nextFollowUpAt:req.body.nextFollowUpAt?new Date(req.body.nextFollowUpAt):null,startLocation:{latitude:lat,longitude:lng,accuracy},endLocation:{latitude:lat,longitude:lng,accuracy},customerLocation:{latitude:geo.latitude,longitude:geo.longitude},minDistanceMeters:money(distance),gpsVerified:true,autoDetected:false,createdBy:req.auth.sub});
    const routePlan=await completeRouteStopFromVisit({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,customerGlobalId:customer.globalCustomerId,visit,distanceMeters:distance});
    return ok(res,{visit,distanceMeters:money(distance),routePlan:routePlan?{_id:routePlan._id,status:routePlan.status,completedStops:routePlan.completedStops,skippedStops:routePlan.skippedStops}:null},"Visit created",201);
  } catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/visits/auto-detect", async (req, res) => {
  try {
    const customer=await requireVisibleCustomer(req,req.body.customerGlobalId), geo=customerCoordinates(customer); if(!geo)return fail(res,"Customer has no saved geolocation",400);
    const enteredAt=new Date(req.body.enteredAt), leftAt=new Date(req.body.leftAt||new Date()); if(Number.isNaN(enteredAt.getTime())||Number.isNaN(leftAt.getTime()))return fail(res,"Valid enter/leave time is required",400);
    const durationSeconds=Math.max(0,Math.round((leftAt-enteredAt)/1000)), minDistance=num(req.body.minDistanceMeters);
    if(durationSeconds<90)return fail(res,"Automatic visit requires at least 90 seconds near the customer",400);
    if(minDistance>20)return fail(res,"Automatic visit was not close enough to the customer",400);
    const clientMutationId=clean(req.body.clientMutationId);
    if(clientMutationId){const synced=await CustomerVisit.findOne({tenantKey:req.auth.tenantKey,clientMutationId}).lean();if(synced)return ok(res,{visit:synced,deduplicated:true},"Visit already synced");}
    const recent=await CustomerVisit.findOne({tenantKey:req.auth.tenantKey,customerGlobalId:customer.globalCustomerId,salespersonId:req.auth.sub,startedAt:{$gte:new Date(Date.now()-30*60*1000)},status:{$ne:"CANCELLED"}}).lean();
    if(recent)return ok(res,{visit:recent,deduplicated:true},"Visit already recorded");
    let visitId=makeId("AVIS");while(await CustomerVisit.exists({visitId}))visitId=makeId("AVIS");
    const start=routePoint(req.body.startLocation||{}), end=routePoint(req.body.endLocation||{});
    const visit=await CustomerVisit.create({tenantKey:req.auth.tenantKey,visitId,clientMutationId:clientMutationId||undefined,financialYear:fyOf(req),customerGlobalId:customer.globalCustomerId,customerNameSnapshot:customerName(customer),salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",tripId:clean(req.body.tripId),visitType:"AUTO_DETECTED",status:"COMPLETED",startedAt:enteredAt,endedAt:leftAt,durationSeconds,outcome:"AUTO_DETECTED_VISIT",note:clean(req.body.note)||"Automatically detected from verified proximity and dwell time",startLocation:start?{latitude:start.lat,longitude:start.lng,accuracy:start.accuracy}:undefined,endLocation:end?{latitude:end.lat,longitude:end.lng,accuracy:end.accuracy}:undefined,customerLocation:{latitude:geo.latitude,longitude:geo.longitude},minDistanceMeters:money(minDistance),gpsVerified:true,autoDetected:true,createdBy:req.auth.sub});
    const routePlan=await completeRouteStopFromVisit({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,customerGlobalId:customer.globalCustomerId,visit,distanceMeters:minDistance});
    return ok(res,{visit,deduplicated:false,routePlan:routePlan?{_id:routePlan._id,status:routePlan.status,completedStops:routePlan.completedStops,skippedStops:routePlan.skippedStops}:null},"Automatic visit recorded",201);
  } catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/route/trips", async (req,res)=>{
  try{const limit=Math.min(200,Math.max(10,Number(req.query.limit||100)));const items=await SalespersonTrip.find({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}).sort({startedAt:-1}).limit(limit).lean();return ok(res,{trips:items});}catch(error){return fail(res,error.message,500);}
});
router.get("/route/trips/:id", async (req,res)=>{
  try{const trip=await SalespersonTrip.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}).lean();if(!trip)return fail(res,"Trip not found",404);return ok(res,{trip});}catch(error){return fail(res,error.message,500);}
});
router.post("/route/trips/start", async (req,res)=>{
  try{
    const dateKey=clean(req.body.dateKey)||localDateKey();
    const plan=await SalesRoutePlan.findOne({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,dateKey,status:{$in:["READY","IN_PROGRESS"]}}).sort({updatedAt:-1});
    const active=await SalespersonTrip.findOne({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,status:"active"}).sort({startedAt:-1});
    if(active){if(plan&&!active.routePlanId){active.routePlanId=String(plan._id);await active.save();plan.tripId=String(active._id);plan.status="IN_PROGRESS";plan.startedAt=plan.startedAt||active.startedAt||new Date();await plan.save();}return ok(res,{trip:active,routePlan:plan||null},"Active trip resumed");}
    const point=routePoint(req.body.startLocation||{});if(!point)return fail(res,"Valid start location is required",400);let tripId=makeId("TRIP");while(await SalespersonTrip.exists({tripId}))tripId=makeId("TRIP");
    const trip=await SalespersonTrip.create({tenantKey:req.auth.tenantKey,tripId,salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",dateKey,status:"active",startedAt:new Date(),startLocation:point,routePoints:[point],pointCount:1,distanceMeters:0,routePlanId:plan?String(plan._id):"",createdBy:req.auth.sub});
    if(plan){plan.tripId=String(trip._id);plan.status="IN_PROGRESS";plan.startedAt=plan.startedAt||trip.startedAt;plan.currentLocation=point;plan.updatedBy=req.auth.sub;await plan.save();}
    return ok(res,{trip,routePlan:plan||null},"Trip started",201);
  }catch(error){return fail(res,error.message,500);}
});
router.post("/route/trips/:id/points", async (req,res)=>{
  try{
    const trip=await SalespersonTrip.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,status:"active"});if(!trip)return fail(res,"Active trip not found",404);
    const incoming=(Array.isArray(req.body.points)?req.body.points:[]).map(routePoint).filter(Boolean);const known=new Set((trip.routePoints||[]).map((p)=>clean(p.ts)));for(const p of incoming)if(!known.has(clean(p.ts))){trip.routePoints.push(p);known.add(clean(p.ts));}
    if(trip.routePoints.length>5000)trip.routePoints=trip.routePoints.slice(-5000);if(Array.isArray(req.body.pauseEvents))trip.pauseEvents=[...(trip.pauseEvents||[]),...req.body.pauseEvents.slice(-100)].slice(-300);
    trip.pointCount=trip.routePoints.length;trip.distanceMeters=money(polylineDistance(trip.routePoints));trip.durationSeconds=Math.max(0,Math.round((Date.now()-new Date(trip.startedAt).getTime())/1000));trip.updatedBy=req.auth.sub;await trip.save();
    if(trip.routePlanId){const last=trip.routePoints?.[trip.routePoints.length-1];await SalesRoutePlan.updateOne({_id:trip.routePlanId,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub},{$set:{currentLocation:last||undefined,lastGpsAt:new Date(),actualDistanceMeters:trip.distanceMeters,actualDurationSeconds:trip.durationSeconds,updatedBy:req.auth.sub}});}
    return ok(res,{trip:{_id:trip._id,tripId:trip.tripId,status:trip.status,pointCount:trip.pointCount,distanceMeters:trip.distanceMeters,durationSeconds:trip.durationSeconds,routePlanId:trip.routePlanId||""}});
  }catch(error){return fail(res,error.message,500);}
});
router.patch("/route/trips/:id/stop", async (req,res)=>{
  try{const trip=await SalespersonTrip.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub});if(!trip)return fail(res,"Trip not found",404);if(trip.status!=="active")return ok(res,{trip},"Trip already stopped");const p=routePoint(req.body.endLocation||{});trip.status="completed";trip.endedAt=req.body.endedAt?new Date(req.body.endedAt):new Date();trip.endLocation=p||trip.routePoints?.[trip.routePoints.length-1];trip.distanceMeters=money(polylineDistance(trip.routePoints||[]));trip.pointCount=(trip.routePoints||[]).length;trip.durationSeconds=Math.max(0,Math.round((trip.endedAt-new Date(trip.startedAt))/1000));trip.stoppedReason=clean(req.body.reason)||"manual";trip.updatedBy=req.auth.sub;await trip.save();if(trip.routePlanId){await SalesRoutePlan.updateOne({_id:trip.routePlanId,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub},{$set:{currentLocation:trip.endLocation||undefined,lastGpsAt:new Date(),actualDistanceMeters:trip.distanceMeters,actualDurationSeconds:trip.durationSeconds,updatedBy:req.auth.sub}});}return ok(res,{trip},"Trip stopped");}catch(error){return fail(res,error.message,500);}
});

async function priorityRouteItems({req,financialYear,latitude,longitude,radiusMeters=50000,limit=30}){
  const {filter}=await visibleCustomerFilter(req,{status:"ACTIVE"});
  const customers=await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses location creditDays creditLimit accountingProfile salespersonId").lean();
  const located=customers.map((c)=>({customer:c,geo:customerCoordinates(c)})).filter((x)=>x.geo).map((x)=>({...x,distanceMeters:haversine({latitude,longitude},x.geo)})).filter((x)=>Number.isFinite(x.distanceMeters)&&x.distanceMeters<=radiusMeters);
  if(!located.length)return [];
  const subset=located.map((x)=>x.customer), priority=await collectionPriorityItems({tenantKey:req.auth.tenantKey,financialYear,customers:subset});
  const opportunity=await opportunityItemsForUser({req,financialYear,limit:200,customers:subset,priority});
  const oppMap=new Map();for(const o of opportunity){if(!o.customerGlobalId)continue;const curr=oppMap.get(o.customerGlobalId);if(!curr||num(o.score)>num(curr.score))oppMap.set(o.customerGlobalId,o);}
  const prMap=new Map(priority.map((x)=>[x.customer.id,x]));
  const rows=located.map(({customer:c,geo,distanceMeters})=>{const o=oppMap.get(c.globalCustomerId),pr=prMap.get(c.globalCustomerId);const distanceKm=distanceMeters/1000;const businessScore=num(o?.score)||(pr?70+num(pr.priorityScore):25);const routeScore=Math.round((businessScore-Math.min(55,distanceKm*2))*10)/10;return {customerGlobalId:c.globalCustomerId,customerName:customerName(c),mobile:customerMobile(c),address:billingAddress(c).address||"",city:billingAddress(c).city||"",pincode:billingAddress(c).pincode||"",latitude:geo.latitude,longitude:geo.longitude,distanceMeters:Math.round(distanceMeters),distanceKm:Math.round(distanceKm*10)/10,score:routeScore,priority:o?.priority||pr?.priority||"NORMAL",opportunityType:o?.type||"VISIT",reason:o?.subtitle||"Customer relationship visit",amount:num(o?.amount),recommendedAction:o?.action||"CUSTOMER"};}).sort((a,b)=>b.score-a.score||a.distanceMeters-b.distanceMeters).slice(0,Math.max(1,Math.min(100,limit)));
  return rows.map((x,i)=>({...x,rank:i+1}));
}


router.get("/route/plans/today", async(req,res)=>{
  try{
    const dateKey=clean(req.query.dateKey)||localDateKey(), access=await routePlanAccessFilter(req,req.query.salespersonId);
    const plan=await SalesRoutePlan.findOne({tenantKey:req.auth.tenantKey,salespersonId:access.salespersonId,dateKey}).lean();
    return ok(res,{plan:plan||null,dateKey});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/route/plans/history", async(req,res)=>{
  try{
    const access=await routePlanAccessFilter(req,req.query.salespersonId), page=Math.max(1,Number(req.query.page||1)),limit=Math.min(60,Math.max(10,Number(req.query.limit||20)));
    const filter={tenantKey:req.auth.tenantKey,salespersonId:access.salespersonId}; if(clean(req.query.status))filter.status=upper(req.query.status);
    const [items,total]=await Promise.all([SalesRoutePlan.find(filter).sort({dateKey:-1,createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),SalesRoutePlan.countDocuments(filter)]);
    return ok(res,{items,meta:pageMeta(page,limit,total)});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/route/plans/generate", async(req,res)=>{
  try{
    const point=routePoint(req.body.currentLocation||req.body.startLocation||{}); if(!point)return fail(res,"Valid current location is required to generate a route",400);
    const dateKey=clean(req.body.dateKey)||localDateKey(), maxStops=Math.min(25,Math.max(3,Number(req.body.maxStops||12))),radiusKm=Math.min(100,Math.max(1,Number(req.body.radiusKm||40)));
    let existing=await SalesRoutePlan.findOne({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,dateKey});
    if(existing?.status==="IN_PROGRESS")return fail(res,"Today's route is already in progress. Use Re-plan Remaining instead.",409,{plan:existing});
    if(existing?.status==="COMPLETED")return fail(res,"Today's route is already completed and is locked in route history.",409,{plan:existing});
    const candidates=await priorityRouteItems({req,financialYear:fyOf(req),latitude:point.lat,longitude:point.lng,radiusMeters:radiusKm*1000,limit:Math.max(maxStops*4,40)});
    if(!candidates.length)return fail(res,"No geotagged customers/opportunities are available for today's route",404);
    const ordered=orderRouteCandidates(candidates,point,maxStops),stops=buildRouteStops(ordered,point,new Date());
    let planNo=existing?.planNo||makeId("ROUTE"); while(!existing&&await SalesRoutePlan.exists({planNo}))planNo=makeId("ROUTE");
    const payload={tenantKey:req.auth.tenantKey,planNo,financialYear:fyOf(req),dateKey,salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",status:"READY",generatedBy:existing?"REPLAN":"AUTO",routeVersion:num(existing?.routeVersion)+1||1,startLocation:point,currentLocation:point,maxStops,radiusMeters:radiusKm*1000,stops,createdBy:existing?.createdBy||req.auth.sub,updatedBy:req.auth.sub,startedAt:null,completedAt:null,tripId:""};
    if(existing){existing.set(payload);recomputeRoutePlan(existing);await existing.save();}
    else{existing=new SalesRoutePlan(payload);recomputeRoutePlan(existing);await existing.save();}
    return ok(res,{plan:existing,candidateCount:candidates.length},"Daily sales route generated",201);
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.patch("/route/plans/:id/start", async(req,res)=>{
  try{
    const plan=await SalesRoutePlan.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}); if(!plan)return fail(res,"Route plan not found",404);
    if(["COMPLETED","CANCELLED"].includes(plan.status))return fail(res,`Cannot start a ${plan.status.toLowerCase()} route`,400);
    const point=routePoint(req.body.currentLocation||{}); if(point)plan.currentLocation=point; plan.startLocation=plan.startLocation||point; plan.status="IN_PROGRESS"; plan.startedAt=plan.startedAt||new Date(); plan.updatedBy=req.auth.sub; await plan.save();
    return ok(res,{plan},"Daily route started");
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.patch("/route/plans/:id/stops/:stopId", async(req,res)=>{
  try{
    const plan=await SalesRoutePlan.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}); if(!plan)return fail(res,"Route plan not found",404);
    const stop=(plan.stops||[]).find(x=>x.stopId===req.params.stopId); if(!stop)return fail(res,"Route stop not found",404);
    const action=upper(req.body.action); if(["COMPLETED","SKIPPED"].includes(stop.status)&&action!=="RESTORE")return ok(res,{plan,stop},"Route stop is already closed");
    const now=new Date(),point=routePoint(req.body.currentLocation||{});
    if(point)plan.currentLocation=point;
    if(action==="START") { stop.status="STARTED"; stop.startedAt=stop.startedAt||now; if(plan.status==="READY"){plan.status="IN_PROGRESS";plan.startedAt=plan.startedAt||now;} }
    else if(action==="ARRIVE") {
      if(!point)return fail(res,"Current location is required to mark arrival",400);
      const d=haversine({latitude:point.lat,longitude:point.lng},{latitude:stop.location?.lat,longitude:stop.location?.lng}); if(!Number.isFinite(d)||d>250)return fail(res,`You are about ${Math.round(d)} m from this stop. Arrival can be marked within 250 m.`,400,{distanceMeters:d});
      stop.status="ARRIVED"; stop.arrivedAt=now; stop.actualDistanceOnArrivalMeters=money(d); stop.startedAt=stop.startedAt||now; if(plan.status==="READY"){plan.status="IN_PROGRESS";plan.startedAt=plan.startedAt||now;}
    }
    else if(action==="SKIP") { const reason=clean(req.body.reason); if(!reason)return fail(res,"Skip reason is required",400); stop.status="SKIPPED"; stop.skippedAt=now; stop.skipReason=reason; }
    else if(action==="RESTORE") { stop.status="PENDING"; stop.skippedAt=null; stop.skipReason=""; stop.completedAt=null; stop.visitId=""; plan.completedAt=null; if(plan.status==="COMPLETED")plan.status="IN_PROGRESS"; }
    else return fail(res,"Action must be START, ARRIVE, SKIP or RESTORE",400);
    recomputeRoutePlan(plan); plan.updatedBy=req.auth.sub; await plan.save(); return ok(res,{plan,stop},"Route stop updated");
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/route/plans/:id/replan", async(req,res)=>{
  try{
    const plan=await SalesRoutePlan.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}); if(!plan)return fail(res,"Route plan not found",404);
    if(["COMPLETED","CANCELLED"].includes(plan.status))return fail(res,"Closed route cannot be re-planned",400);
    const point=routePoint(req.body.currentLocation||{}); if(!point)return fail(res,"Current location is required to re-plan",400);
    const fixed=(plan.stops||[]).filter(x=>["COMPLETED","SKIPPED"].includes(x.status)).sort((a,b)=>a.sequence-b.sequence), open=(plan.stops||[]).filter(x=>!["COMPLETED","SKIPPED"].includes(x.status));
    const asItems=open.map(x=>({customerGlobalId:x.customerGlobalId,customerName:x.customerNameSnapshot,mobile:x.mobileSnapshot,address:x.addressSnapshot,city:x.citySnapshot,pincode:x.pincodeSnapshot,latitude:x.location?.lat,longitude:x.location?.lng,score:x.score,priority:x.priority,opportunityType:x.opportunityType,reason:x.reason,amount:x.opportunityAmount,recommendedAction:x.recommendedAction}));
    const ordered=orderRouteCandidates(asItems,point,open.length), rebuilt=buildRouteStops(ordered,point,new Date());
    const preservedByCustomer=new Map(open.map(x=>[x.customerGlobalId,x]));
    rebuilt.forEach((x,i)=>{const prev=preservedByCustomer.get(x.customerGlobalId);x.stopId=prev?.stopId||x.stopId;x.status=prev?.status==="ARRIVED"?"ARRIVED":prev?.status==="STARTED"?"STARTED":"PENDING";x.startedAt=prev?.startedAt;x.arrivedAt=prev?.arrivedAt;x.actualDistanceOnArrivalMeters=prev?.actualDistanceOnArrivalMeters;x.sequence=fixed.length+i+1;});
    fixed.forEach((x,i)=>{x.sequence=i+1;}); plan.stops=[...fixed,...rebuilt]; plan.currentLocation=point; plan.generatedBy="REPLAN"; plan.routeVersion=num(plan.routeVersion)+1; recomputeRoutePlan(plan); plan.updatedBy=req.auth.sub; await plan.save();
    return ok(res,{plan},"Remaining route re-planned from current location");
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});


router.post("/route/plans/:id/stops", async(req,res)=>{
  try{
    const plan=await SalesRoutePlan.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}); if(!plan)return fail(res,"Route plan not found",404);
    if(["COMPLETED","CANCELLED"].includes(plan.status))return fail(res,"Closed route cannot accept new stops",400);
    const customer=await requireVisibleCustomer(req,req.body.customerGlobalId), geo=customerCoordinates(customer); if(!geo)return fail(res,"Customer has no saved geolocation",400);
    if((plan.stops||[]).some(x=>x.customerGlobalId===customer.globalCustomerId&&x.status!=="SKIPPED"))return fail(res,"Customer is already on today's route",409);
    const priority=await collectionPriorityItems({tenantKey:req.auth.tenantKey,financialYear:plan.financialYear||fyOf(req),customers:[customer]});
    const opportunities=await opportunityItemsForUser({req,financialYear:plan.financialYear||fyOf(req),limit:20,customers:[customer],priority});
    const best=opportunities.find(x=>x.customerGlobalId===customer.globalCustomerId), cursor=routePoint(req.body.currentLocation||{})||plan.currentLocation||plan.startLocation||{lat:geo.latitude,lng:geo.longitude};
    const item={customerGlobalId:customer.globalCustomerId,customerName:customerName(customer),mobile:customerMobile(customer),address:billingAddress(customer).address||"",city:billingAddress(customer).city||"",pincode:billingAddress(customer).pincode||"",latitude:geo.latitude,longitude:geo.longitude,score:num(best?.score)||40,priority:best?.priority||"NORMAL",opportunityType:best?.type||"AD_HOC_VISIT",reason:best?.subtitle||"Added during field route",amount:num(best?.amount),recommendedAction:best?.action||"CUSTOMER"};
    const leg=routeRoadMeters(cursor,{lat:geo.latitude,lng:geo.longitude}), built=buildRouteStops([{...item,legMeters:leg,travelMinutes:routeTravelMinutes(leg)}],cursor,new Date())[0]; built.sequence=Math.max(0,...(plan.stops||[]).map(x=>num(x.sequence)))+1;
    plan.stops.push(built); plan.maxStops=Math.max(num(plan.maxStops),plan.stops.length); recomputeRoutePlan(plan); plan.updatedBy=req.auth.sub; await plan.save(); return ok(res,{plan,stop:built},"Customer added to today's route",201);
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/route/team/today", async(req,res)=>{
  try{
    const {scope}=await roleScope(req); if(scope.isLeaf)return fail(res,"Team route monitoring is available to Sales Head / Sales Manager roles",403);
    const dateKey=clean(req.query.dateKey)||localDateKey(); const ids=scope.unrestricted?null:(scope.userIds||[]).map(String); const userFilter={tenantKey:req.auth.tenantKey,status:"ACTIVE"}; if(ids)userFilter._id={$in:ids};
    const members=await User.find(userFilter).select("_id name role mobile").sort({name:1}).lean(), memberIds=members.map(x=>String(x._id));
    const plans=memberIds.length?await SalesRoutePlan.find({tenantKey:req.auth.tenantKey,dateKey,salespersonId:{$in:memberIds}}).lean():[]; const pm=new Map(plans.map(x=>[String(x.salespersonId),x]));
    const items=members.map(m=>{const p=pm.get(String(m._id));const stops=p?.stops||[];const next=stops.find(x=>!["COMPLETED","SKIPPED"].includes(x.status));return {salespersonId:String(m._id),name:m.name,role:m.role,mobile:m.mobile||"",planId:p?String(p._id):"",status:p?.status||"NOT_PLANNED",totalStops:stops.length,completedStops:p?.completedStops||0,skippedStops:p?.skippedStops||0,progressPct:stops.length?Math.round((num(p?.completedStops)+num(p?.skippedStops))/stops.length*100):0,opportunityAmount:money(p?.totalOpportunityAmount),collectionAmount:money(p?.totalCollectionAmount),estimatedDistanceMeters:num(p?.estimatedDistanceMeters),actualDistanceMeters:num(p?.actualDistanceMeters),actualDurationSeconds:num(p?.actualDurationSeconds),currentLocation:p?.currentLocation||null,lastGpsAt:p?.lastGpsAt||null,startedAt:p?.startedAt||null,nextStop:next?{customerName:next.customerNameSnapshot,reason:next.reason,status:next.status}:null};});
    const totals=items.reduce((a,x)=>({people:a.people+1,planned:a.planned+(x.planId?1:0),inProgress:a.inProgress+(x.status==="IN_PROGRESS"?1:0),completed:a.completed+(x.status==="COMPLETED"?1:0),stops:a.stops+x.totalStops,done:a.done+x.completedStops,opportunity:a.opportunity+x.opportunityAmount,collection:a.collection+x.collectionAmount}),{people:0,planned:0,inProgress:0,completed:0,stops:0,done:0,opportunity:0,collection:0});
    totals.opportunity=money(totals.opportunity);totals.collection=money(totals.collection);return ok(res,{dateKey,items,totals});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/route/priority", async(req,res)=>{
  try{const lat=Number(req.query.lat),lng=Number(req.query.lng);if(!validCoord(lat,lng))return fail(res,"Current latitude and longitude are required",400);const radiusKm=Math.min(100,Math.max(.2,Number(req.query.radiusKm||25))),limit=Math.min(100,Math.max(3,Number(req.query.limit||30)));const items=await priorityRouteItems({req,financialYear:fyOf(req),latitude:lat,longitude:lng,radiusMeters:radiusKm*1000,limit});return ok(res,{items,current:{latitude:lat,longitude:lng},radiusKm});}catch(error){return fail(res,error.message,error.statusCode||500);}
});
router.get("/route/nearby", async(req,res)=>{
  try{const lat=Number(req.query.lat),lng=Number(req.query.lng);if(!validCoord(lat,lng))return fail(res,"Current latitude and longitude are required",400);const radiusMeters=Math.min(10000,Math.max(50,Number(req.query.radiusMeters||1500)));const items=await priorityRouteItems({req,financialYear:fyOf(req),latitude:lat,longitude:lng,radiusMeters,limit:50});return ok(res,{items,radiusMeters});}catch(error){return fail(res,error.message,error.statusCode||500);}
});

// ---------------- VOICE TO CRM ----------------
router.post("/voice/parse", async(req,res)=>{
  try{const parsed=await parseVoiceCrm({tenantKey:req.auth.tenantKey,transcript:req.body.transcript});if(!parsed.transcript)return fail(res,"Transcript is required",400);return ok(res,{parsed});}catch(error){return fail(res,error.message,500);}
});
router.post("/voice/customer/:globalId", async(req,res)=>{
  try{
    const customer=await requireVisibleCustomer(req,req.params.globalId);const parsed=req.body.structured&&typeof req.body.structured==="object"?req.body.structured:await parseVoiceCrm({tenantKey:req.auth.tenantKey,transcript:req.body.transcript});const transcript=clean(req.body.transcript||parsed.transcript);if(!transcript)return fail(res,"Transcript is required",400);
    const clientMutationId=clean(req.body.clientMutationId);if(clientMutationId){const existing=await SalesCrmActivity.findOne({tenantKey:req.auth.tenantKey,clientMutationId}).lean();if(existing)return ok(res,{activity:existing,parsed:existing.structured||parsed},"CRM activity already synced");}
    let activityId=makeId("CRM");while(await SalesCrmActivity.exists({activityId}))activityId=makeId("CRM");const next=parsed.nextFollowUpAt?new Date(parsed.nextFollowUpAt):null;
    const activity=await SalesCrmActivity.create({tenantKey:req.auth.tenantKey,activityId,clientMutationId:clientMutationId||undefined,salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",customerGlobalId:customer.globalCustomerId,customerNameSnapshot:customerName(customer),channel:upper(req.body.channel)==="TEXT"?"TEXT":"VOICE",transcript,structured:parsed,outcome:clean(parsed.outcome),nextFollowUpAt:next&&!Number.isNaN(next.getTime())?next:null,status:"SAVED",createdBy:req.auth.sub});return ok(res,{activity,parsed},"CRM activity saved",201);
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});
router.get("/voice/customer/:globalId", async(req,res)=>{
  try{await requireVisibleCustomer(req,req.params.globalId);const items=await SalesCrmActivity.find({tenantKey:req.auth.tenantKey,customerGlobalId:clean(req.params.globalId),status:"SAVED"}).sort({createdAt:-1}).limit(50).lean();return ok(res,{items});}catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/collection-target", async (req, res) => {
  try {
    const financialYear = fyOf(req), at = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(at.getTime())) return fail(res, "Invalid date", 400);
    return ok(res, { ...(await collectionTargetForUser({ tenantKey: req.auth.tenantKey, financialYear, userId: req.auth.sub, at })), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/opportunities", async (req, res) => {
  try {
    const financialYear = fyOf(req), limit = Math.min(200, Math.max(10, Number(req.query.limit || 60)));
    const items = await opportunityItemsForUser({ req, financialYear, limit });
    const counts = items.reduce((acc, item) => { acc[item.type] = (acc[item.type] || 0) + 1; return acc; }, {});
    return ok(res, { items, counts, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

function financialYearBounds(financialYear) {
  const match = clean(financialYear).match(/^(\d{4})-(\d{2}|\d{4})$/);
  const startYear = match ? Number(match[1]) : (new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1);
  return { start: new Date(startYear, 3, 1), end: new Date(startYear + 1, 3, 1), startYear };
}
function salesCollectionPeriodBuckets(financialYear, periodValue) {
  const period = upper(periodValue || "MONTHLY");
  const { start, end, startYear } = financialYearBounds(financialYear);
  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const from = new Date(startYear, 3 + i, 1);
    const to = new Date(startYear, 4 + i, 1);
    months.push({ index: i, from, to, label: from.toLocaleString("en-IN", { month: "short" }), key: `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}` });
  }
  if (period === "QUARTERLY") return [0, 1, 2, 3].map((q) => ({ key: `Q${q + 1}`, label: `Q${q + 1}`, from: months[q * 3].from, to: months[q * 3 + 2].to }));
  if (["HALF_YEARLY", "HALFYEARLY", "HALF-YEARLY"].includes(period)) return [
    { key: "H1", label: "H1 • Apr-Sep", from: months[0].from, to: months[5].to },
    { key: "H2", label: "H2 • Oct-Mar", from: months[6].from, to: months[11].to },
  ];
  if (period === "YEARLY") return [{ key: financialYear, label: `FY ${financialYear}`, from: start, to: end }];
  return months;
}
function pendingAgeBucket(days) {
  const d = Math.max(0, Number(days || 0));
  if (d <= 7) return "0_7";
  if (d <= 15) return "8_15";
  if (d <= 30) return "16_30";
  if (d <= 60) return "31_60";
  if (d <= 90) return "61_90";
  return "90_plus";
}

router.get("/analytics/sales-collection", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const period = upper(req.query.period || "MONTHLY");
    const partyQ = clean(req.query.q).toLowerCase();
    const partyLimit = Math.min(200, Math.max(25, Number(req.query.partyLimit || 75)));
    const { start, end } = financialYearBounds(financialYear);
    const buckets = salesCollectionPeriodBuckets(financialYear, period);
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    const customers = await CustomerLink.find(filter)
      .select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses creditDays creditLimit approvedTerms accountingProfile salespersonId")
      .sort({ localName: 1 }).lean();
    const ids = customers.map((x) => clean(x.globalCustomerId)).filter(Boolean);
    if (!ids.length) return ok(res, { financialYear, period, summary: { sales: 0, collections: 0, gap: 0, collectionPct: 0, outstanding: 0 }, trend: buckets.map((b) => ({ ...b, from: b.from, to: b.to, sales: 0, collections: 0, gap: 0, collectionPct: 0 })), parties: [], aging: {} });

    const { SalesInvoice, Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const [salesByMonth, collectionByMonth, partySales, partyCollections, invoiceRows, receiptTotals, balanceMap] = await Promise.all([
      SalesInvoice.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $gte: start, $lt: end } } },
        { $group: { _id: { year: { $year: "$date" }, month: { $month: "$date" } }, amount: { $sum: "$grandTotal" }, count: { $sum: 1 } } },
      ]),
      Receipt.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $gte: start, $lt: end } } },
        { $group: { _id: { year: { $year: "$date" }, month: { $month: "$date" } }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      SalesInvoice.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $gte: start, $lt: end } } },
        { $group: { _id: "$customerGlobalId", amount: { $sum: "$grandTotal" }, invoices: { $sum: 1 }, lastSaleAt: { $max: "$date" } } },
      ]),
      Receipt.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $gte: start, $lt: end } } },
        { $group: { _id: "$customerGlobalId", amount: { $sum: "$amount" }, receipts: { $sum: 1 }, lastCollectionAt: { $max: "$date" } } },
      ]),
      SalesInvoice.find({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $lt: end } })
        .select("customerGlobalId invoiceNo date grandTotal creditNoteAmount netInvoiceAmount workflowStatus status").sort({ date: 1, createdAt: 1 }).lean(),
      Receipt.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $lt: end } } },
        { $group: { _id: "$customerGlobalId", total: { $sum: "$amount" } } },
      ]),
      receivableMap({ tenantKey: req.auth.tenantKey, financialYear, customerIds: ids }),
    ]);

    const monthSales = new Map(salesByMonth.map((x) => [`${x._id.year}-${String(x._id.month).padStart(2, "0")}`, { amount: num(x.amount), count: num(x.count) }]));
    const monthCollections = new Map(collectionByMonth.map((x) => [`${x._id.year}-${String(x._id.month).padStart(2, "0")}`, { amount: num(x.amount), count: num(x.count) }]));
    const monthlyRows = salesCollectionPeriodBuckets(financialYear, "MONTHLY").map((m) => ({
      ...m,
      sales: money(monthSales.get(m.key)?.amount || 0),
      collections: money(monthCollections.get(m.key)?.amount || 0),
      invoiceCount: num(monthSales.get(m.key)?.count),
      receiptCount: num(monthCollections.get(m.key)?.count),
    }));
    const trend = buckets.map((bucket) => {
      const rows = monthlyRows.filter((m) => m.from >= bucket.from && m.from < bucket.to);
      const sales = money(rows.reduce((sum, x) => sum + x.sales, 0));
      const collections = money(rows.reduce((sum, x) => sum + x.collections, 0));
      return {
        key: bucket.key, label: bucket.label, from: bucket.from, to: bucket.to,
        sales, collections, gap: money(sales - collections), collectionPct: sales > 0 ? Math.round(collections / sales * 1000) / 10 : (collections > 0 ? 100 : 0),
        invoiceCount: rows.reduce((sum, x) => sum + x.invoiceCount, 0), receiptCount: rows.reduce((sum, x) => sum + x.receiptCount, 0),
      };
    });

    const salesMap = new Map(partySales.map((x) => [String(x._id), x]));
    const receiptMap = new Map(partyCollections.map((x) => [String(x._id), x]));
    const receiptTotalMap = new Map(receiptTotals.map((x) => [String(x._id), num(x.total)]));
    const netInvoiceRows = await enrichSalesInvoicesWithCreditState({ models: financialModels(req.auth.tenantKey, financialYear), tenantKey: req.auth.tenantKey, financialYear, invoices: invoiceRows });
    const invoiceMap = new Map();
    for (const inv of netInvoiceRows) {
      const id = clean(inv.customerGlobalId);
      if (!invoiceMap.has(id)) invoiceMap.set(id, []);
      invoiceMap.get(id).push(inv);
    }
    const today = startOfDay(new Date());
    const aging = { "0_7": 0, "8_15": 0, "16_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0, opening_or_unallocated: 0 };
    const parties = customers.map((customer) => {
      const id = clean(customer.globalCustomerId);
      const s = salesMap.get(id) || {}, r = receiptMap.get(id) || {};
      const bills = allocateReceiptsToInvoices(invoiceMap.get(id) || [], receiptTotalMap.get(id) || 0, customer.creditDays || customer.approvedTerms?.creditDays || 0).filter((x) => x.outstanding > 0);
      let oldestPendingDays = 0, maxOverdueDays = 0, invoiceOutstanding = 0, overdueAmount = 0;
      const partyAging = { "0_7": 0, "8_15": 0, "16_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 };
      for (const bill of bills) {
        const pendingDays = Math.max(0, daysBetween(today, bill.date));
        oldestPendingDays = Math.max(oldestPendingDays, pendingDays);
        maxOverdueDays = Math.max(maxOverdueDays, num(bill.overdueDays));
        invoiceOutstanding += num(bill.outstanding);
        if (num(bill.overdueDays) > 0) overdueAmount += num(bill.outstanding);
        const key = pendingAgeBucket(pendingDays);
        partyAging[key] += num(bill.outstanding);
        aging[key] += num(bill.outstanding);
      }
      const outstanding = money(Math.max(0, num(balanceMap.get(id)) + openingSigned(customer, financialYear)));
      const unallocated = money(Math.max(0, outstanding - invoiceOutstanding));
      aging.opening_or_unallocated += unallocated;
      return {
        customerGlobalId: id,
        customerName: customerName(customer),
        mobile: customerMobile(customer),
        city: billingAddress(customer).city || "",
        pincode: billingAddress(customer).pincode || "",
        sales: money(s.amount || 0), invoices: num(s.invoices), lastSaleAt: s.lastSaleAt || null,
        collections: money(r.amount || 0), receipts: num(r.receipts), lastCollectionAt: r.lastCollectionAt || null,
        gap: money(num(s.amount) - num(r.amount)),
        collectionPct: num(s.amount) > 0 ? Math.round(num(r.amount) / num(s.amount) * 1000) / 10 : (num(r.amount) > 0 ? 100 : 0),
        outstanding,
        overdueAmount: money(overdueAmount),
        oldestPendingDays,
        maxOverdueDays,
        openBills: bills.length,
        aging: Object.fromEntries(Object.entries(partyAging).map(([k,v]) => [k, money(v)])),
        openingOrUnallocated: unallocated,
      };
    }).filter((x) => x.sales > 0 || x.collections > 0 || x.outstanding > 0)
      .sort((a, b) => b.outstanding - a.outstanding || b.oldestPendingDays - a.oldestPendingDays || b.sales - a.sales);

    const totalSales = money(trend.reduce((sum, x) => sum + x.sales, 0));
    const totalCollections = money(trend.reduce((sum, x) => sum + x.collections, 0));
    const totalOutstanding = money(parties.reduce((sum, x) => sum + x.outstanding, 0));
    const overdueOutstanding = money(parties.reduce((sum, x) => sum + num(x.overdueAmount), 0));
    const filteredParties = partyQ ? parties.filter((x) => [x.customerName, x.mobile, x.city, x.pincode].some((v) => clean(v).toLowerCase().includes(partyQ))) : parties;
    return ok(res, {
      financialYear, period,
      summary: { sales: totalSales, collections: totalCollections, gap: money(totalSales - totalCollections), collectionPct: totalSales > 0 ? Math.round(totalCollections / totalSales * 1000) / 10 : (totalCollections > 0 ? 100 : 0), outstanding: totalOutstanding, overdueOutstanding, parties: parties.length },
      trend,
      aging: Object.fromEntries(Object.entries(aging).map(([k,v]) => [k, money(v)])),
      parties: filteredParties.slice(0, partyLimit),
      partyMeta: { total: filteredParties.length, returned: Math.min(filteredParties.length, partyLimit), limit: partyLimit, query: partyQ },
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

function homeActionNested(route, screen, params = {}) {
  return { type: "NESTED", route, screen, params };
}
function homeActionRoute(route, params = {}) {
  return { type: "NAVIGATE", route, params };
}
function dynamicMoneyTone(value, thresholds = {}) {
  const n = num(value);
  if (thresholds.critical !== undefined && n >= thresholds.critical) return "CRITICAL";
  if (thresholds.high !== undefined && n >= thresholds.high) return "HIGH";
  if (thresholds.good !== undefined && n >= thresholds.good) return "GOOD";
  return "TEAL";
}
function currentFiscalIndex(now, financialYear) {
  const { start } = financialYearBounds(financialYear);
  const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  return Math.max(0, Math.min(11, months));
}
function periodSummaryFromMonthly(monthlyRows, financialYear, now = new Date()) {
  const idx = currentFiscalIndex(now, financialYear);
  const sumRange = (from, to) => {
    const rows = monthlyRows.slice(from, to + 1);
    const sales = money(rows.reduce((a, x) => a + num(x.sales), 0));
    const collections = money(rows.reduce((a, x) => a + num(x.collections), 0));
    return { sales, collections, gap: money(sales - collections), collectionPct: sales > 0 ? Math.round((collections / sales) * 1000) / 10 : collections > 0 ? 100 : 0 };
  };
  const month = sumRange(idx, idx);
  const qStart = Math.floor(idx / 3) * 3;
  const halfStart = Math.floor(idx / 6) * 6;
  return [
    { id: "MONTHLY", label: monthlyRows[idx]?.label || "This Month", shortLabel: "Month", ...month },
    { id: "QUARTERLY", label: `Q${Math.floor(idx / 3) + 1}`, shortLabel: "Quarter", ...sumRange(qStart, Math.min(qStart + 2, idx)) },
    { id: "HALF_YEARLY", label: idx < 6 ? "H1 • Apr-Sep" : "H2 • Oct-Mar", shortLabel: "Half Year", ...sumRange(halfStart, Math.min(halfStart + 5, idx)) },
    { id: "YEARLY", label: `FY ${financialYear}`, shortLabel: "Year", ...sumRange(0, idx) },
  ];
}
async function homeLeadMarketContext(req, latitude, longitude) {
  const scope = await visibility(req);
  const match = { tenantKey: req.auth.tenantKey, stage: { $in: ["NEW", "ASSIGNED", "FOLLOW_UP"] } };
  if (scope.isLeaf) match.assignedUserId = String(req.auth.sub);
  else if (!scope.unrestricted) match.assignedUserId = { $in: (scope.userIds || []).map(String) };

  const groups = await Lead.aggregate([
    { $match: match },
    { $group: {
      _id: { $ifNull: ["$pincode", ""] },
      count: { $sum: 1 },
      highPriority: { $sum: { $cond: [{ $in: ["$priority", ["HIGH", "URGENT", "CRITICAL"]] }, 1, 0] } },
      followUpDue: { $sum: { $cond: [{ $and: [{ $ne: ["$nextFollowUpAt", null] }, { $lte: ["$nextFollowUpAt", new Date()] }] }, 1, 0] } },
      city: { $first: "$city" }, state: { $first: "$state" }, updatedAt: { $max: "$updatedAt" },
    } },
    { $sort: { count: -1, highPriority: -1, followUpDue: -1 } },
    { $limit: 250 },
  ]);
  const pins = groups.map((x) => clean(x._id).replace(/\D/g, "").slice(0, 6)).filter((x) => x.length === 6);
  const pinRows = pins.length ? await Pincode.find({ pincode: { $in: pins } }).select("pincode area city district state latitude longitude").lean() : [];
  const geoMap = new Map();
  for (const row of pinRows) {
    const pin = clean(row.pincode);
    const lat = Number(row.latitude), lng = Number(row.longitude);
    const existing = geoMap.get(pin) || { latitude: 0, longitude: 0, n: 0, area: "", city: "", district: "", state: "" };
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      existing.latitude = (existing.latitude * existing.n + lat) / (existing.n + 1);
      existing.longitude = (existing.longitude * existing.n + lng) / (existing.n + 1);
      existing.n += 1;
    }
    existing.area ||= clean(row.area); existing.city ||= clean(row.city); existing.district ||= clean(row.district); existing.state ||= clean(row.state);
    geoMap.set(pin, existing);
  }
  const areas = groups.slice(0, 8).map((row) => {
    const pincode = clean(row._id).replace(/\D/g, "").slice(0, 6) || "NO_PINCODE";
    const geo = geoMap.get(pincode) || {};
    return {
      pincode, count: num(row.count), highPriority: num(row.highPriority), followUpDue: num(row.followUpDue),
      area: geo.area || "", city: clean(row.city) || geo.city || "", district: geo.district || "", state: clean(row.state) || geo.state || "",
    };
  });

  let nearestLead = null;
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && geoMap.size) {
    const nearPins = [...geoMap.entries()].filter(([, g]) => g.n > 0).map(([pincode, g]) => ({
      pincode, distanceMeters: haversine({ latitude, longitude }, { latitude: g.latitude, longitude: g.longitude }), geo: g,
    })).filter((x) => Number.isFinite(x.distanceMeters)).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 10);
    if (nearPins.length) {
      const distanceMap = new Map(nearPins.map((x) => [x.pincode, x]));
      const candidateMatch = { ...match, pincode: { $in: nearPins.map((x) => x.pincode) } };
      const candidates = await Lead.find(candidateMatch).select("_id leadId companyName contactPerson mobile address pincode city state priority nextFollowUpAt updatedAt").sort({ updatedAt: -1 }).limit(120).lean();
      nearestLead = candidates.map((lead) => {
        const x = distanceMap.get(clean(lead.pincode));
        return x ? { ...lead, distanceMeters: x.distanceMeters, distanceKm: Math.round(x.distanceMeters / 100) / 10, latitude: x.geo.latitude, longitude: x.geo.longitude } : null;
      }).filter(Boolean).sort((a, b) => a.distanceMeters - b.distanceMeters || (upper(b.priority) === "HIGH" ? 1 : 0) - (upper(a.priority) === "HIGH" ? 1 : 0))[0] || null;
    }
  }
  return { areas, totalAreas: groups.filter((x) => clean(x._id)).length, totalOpenLeads: groups.reduce((a, x) => a + num(x.count), 0), nearestLead };
}
function actionForOpportunity(x, financialYear) {
  if (!x) return null;
  if (x.action === "COLLECT" && x.customerGlobalId) return homeActionNested("Customers", "CreateReceipt", { customerId: x.customerGlobalId, customerName: x.customerName, financialYear });
  if (x.action === "ORDER" && x.customerGlobalId) return homeActionNested("Customers", "CreateOrder", { customerId: x.customerGlobalId, customerName: x.customerName, financialYear, mode: x.orderMode || "SUGGESTED" });
  if (x.action === "CUSTOMER" && x.customerGlobalId) return homeActionNested("Customers", "Customer360", { customerId: x.customerGlobalId, customerName: x.customerName, financialYear });
  if (x.action === "LEAD") return homeActionNested("Leads", "LeadList", { initialTab: "leads" });
  return null;
}

router.post('/receipts/:receiptId/cancel',async(req,res)=>{
 try{
  const financialYear=clean(req.body.financialYear)||fyOf(req),receipt=await salespersonReceiptById(req,financialYear,req.params.receiptId);
  if(receipt.customerConfirmationMethod==='ONLINE_PROOF')return fail(res,'Submitted online payments cannot be cancelled from the collector app',409);
  if(receipt.customerOtpStatus==='VERIFIED'||receipt.ledgerPostedAt)return fail(res,'Verified collections must follow the cashier/accounting workflow',409);
  const {Receipt}=financialModels(req.auth.tenantKey,financialYear),session=await Receipt.db.startSession();
  try{await session.withTransaction(async()=>{
   const changed=await Receipt.updateOne({_id:receipt._id,tenantKey:req.auth.tenantKey,customerOtpStatus:'PENDING',status:'PENDING_VERIFICATION'},
    {$set:{status:'CANCELLED',receiptWorkflowStatus:'CANCELLED',customerOtpCode:null}},{session});
   if(changed.modifiedCount!==1)throw Object.assign(new Error('Receipt changed before cancellation; refresh'),{statusCode:409});
   await CollectionClaim.updateMany({tenantKey:req.auth.tenantKey,receiptId:String(receipt._id),status:'ACTIVE'},{$set:{status:'RELEASED',expiresAt:new Date()}},{session});
  });}finally{await session.endSession();}
  return ok(res,{cancelled:true},'Collection cancelled; invoice/order balance remains pending');
 }catch(error){return fail(res,error.message,error.statusCode||500);}
});

const pendingCollectionsHandler=async(req,res)=>{
 try{
  const financialYear=fyOf(req),{filter,scope}=await visibleCustomerFilter(req);
  const q=clean(req.query.q);if(q){const rx=new RegExp(escapeRx(q),'i');filter.$or=[{localName:rx},{displayIdentifier:rx},{'addresses.city':rx},{'addresses.pincode':rx},{'registrationMeta.pincode':rx}];}
  if(req.query.customerId)filter.globalCustomerId=clean(req.query.customerId);
    if(req.query.customerLinkId){if(!objectIdText(req.query.customerLinkId))return fail(res,'Invalid customer record',400);filter._id=clean(req.query.customerLinkId);}
  const customers=await CustomerLink.find(filter).sort({localName:1}).lean();
  const all=(await loadPendingCollections({tenantKey:req.auth.tenantKey,financialYear,customers})).filter(party=>party.outstanding>0);
  const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));
  return ok(res,{financialYear,collectorWorkflowVersion:COLLECTOR_WORKFLOW_VERSION,items:all.slice((page-1)*limit,page*limit),meta:pageMeta(page,limit,all.length),
   totalPending:money(all.reduce((sum,party)=>sum+party.outstanding,0)),assignedCustomerCount:customers.length,
   assignedPincodeCount:scope?.assignedPincodeCount??null,
   collector:scope?.collectorId?{id:scope.collectorId,name:scope.collectorName}:null});
 }catch(error){return fail(res,error.message,error.statusCode||500);}
};
router.get('/collector/pending-collections',pendingCollectionsHandler);
router.get('/cash/pending-collections',pendingCollectionsHandler);
const pendingCollectionPartyHandler=async(req,res)=>{
 try{
  const financialYear=fyOf(req),customer=await requireVisibleCustomer(req,req.params.globalId,{customerLinkId:clean(req.query.customerLinkId)});
  const party=(await loadPendingCollections({tenantKey:req.auth.tenantKey,financialYear,customers:[customer]}))[0];
  return ok(res,{financialYear,party});
 }catch(error){return fail(res,error.message,error.statusCode||500);}
};
router.get('/collector/pending-collections/:globalId',pendingCollectionPartyHandler);
router.get('/cash/pending-collections/:globalId',pendingCollectionPartyHandler);
// The salesperson app reads the same live obligations, including newly placed
// customer orders. Territory/customer ownership remains role-specific.
router.get('/collection-priority',async(req,res)=>{
 try{const financialYear=fyOf(req),{filter}=await visibleCustomerFilter(req),customers=await CustomerLink.find(filter).lean();
  const priority=await collectionPriorityItems({tenantKey:req.auth.tenantKey,financialYear,customers}),q=clean(req.query.q).toLowerCase();
  const items=priority.filter(row=>!q||[row.customer.name,row.customer.mobile,row.customer.city,row.customer.pincode].some(value=>clean(value).toLowerCase().includes(q)));
  const limit=Math.min(500,Math.max(1,Number(req.query.limit)||100));
  return ok(res,{financialYear,items:items.slice(0,limit).map(row=>({...row,promisedToday:row.promisedToday||0}))});
 }catch(error){return fail(res,error.message,error.statusCode||500);}
});
const collectedHistoryHandler=async(req,res)=>{
 try{
  const financialYear=fyOf(req),years=await collectionFinancialYears({tenantKey:req.auth.tenantKey,financialYear});
  const groups=await Promise.all(years.map(async year=>{
   const {Receipt,SalespersonCashMovement}=financialModels(req.auth.tenantKey,year);
   const exists=await financialCollectionExists(req.auth.tenantKey,year,'receipts');if(!exists)return [];
   const receipts=await Receipt.find({tenantKey:req.auth.tenantKey,financialYear:year,collectedBySalespersonId:req.auth.sub,
    collectionSource:'SALESPERSON_APP',status:{$nin:['DELETED','VOID','VOIDED','CANCELLED','REVERSED']}}).sort({date:-1,createdAt:-1}).lean();
   const ids=[...new Set(receipts.map(receipt=>receipt.cashDepositBatchId).filter(objectIdText))];
   const batches=ids.length?await SalespersonCashMovement.find({tenantKey:req.auth.tenantKey,financialYear:year,_id:{$in:ids}})
    .select('_id movementNo status verifiedAt handoverOtpStatus handoverOtpVerifiedAt cashierReceivedAt cashierReceivedByNameSnapshot recipientNameSnapshot').lean():[];
   const byId=new Map(batches.map(batch=>[String(batch._id),batch]));
   return receipts.map(receipt=>({...receiptForClient(receipt),_id:String(receipt._id),handover:byId.get(String(receipt.cashDepositBatchId))||null}));
  }));
  const all=groups.flat().sort((a,b)=>new Date(b.date)-new Date(a.date)||new Date(b.createdAt)-new Date(a.createdAt));
  const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||50));
  return ok(res,{items:all.slice((page-1)*limit,page*limit),meta:pageMeta(page,limit,all.length)});
 }catch(error){return fail(res,error.message,error.statusCode||500);}
};
router.get('/collector/collected',(req,res)=>isCollectionExecutiveRole(req.auth.role)?collectedHistoryHandler(req,res):fail(res,'Collection Executive account required',403));
router.get('/cash/collected',collectedHistoryHandler);

router.get("/collector/assigned-customers", async (req,res) => {
  try {
    if (!isCollectionExecutiveRole(req.auth.role)) return fail(res, "Collection Executive account required", 403);
    const { filter } = await visibleCustomerFilter(req);
    const rows = await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier creditDays creditLimit paymentType companyContactNumber ownerMobile").sort({ localName: 1 }).limit(5000).lean();
    return ok(res, { items: rows.map(c => ({ id: c.globalCustomerId, customerLinkId: String(c._id), name: customerName(c), creditDays: num(c.creditDays), creditLimit: num(c.creditLimit), paymentType: c.paymentType, mobile: customerMobile(c) })) });
  } catch(e) { return fail(res, e.message, e.statusCode || 500); }
});

router.get("/collector/receipts", async (req, res) => {
  try {
    if (!isCollectionExecutiveRole(req.auth.role)) return fail(res, "Collection Executive account required", 403);
    const financialYear = financialYearFromDate(new Date());
    const { filter } = await visibleCustomerFilter(req);
    const customers = await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier").lean();
    const ids = customers.map(c => c.globalCustomerId);
    const customerId = clean(req.query.customerId);
    if (customerId && !ids.includes(customerId)) return fail(res, "Customer not assigned to Collection Executive", 403);
    if (!ids.length) return ok(res, { financialYear, items: [], total: 0 });
    const period = upper(req.query.period || "MONTH");
    const range = collectionRange(period, new Date(), financialYear, req.query);
    const { Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const viewerScope = await receiptViewerScope(req, req.query.createdByScope);
    const filterReceipts = { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customerId || { $in: ids }, collectionSource: "SALESPERSON_APP", status: { $nin: ["DELETED", "CANCELLED", "VOID", "REVERSED"] }, receiptWorkflowStatus: { $nin: ["CANCELLED", "VOID", "REVERSED"] }, $and: [viewerScope] };
    if (range) filterReceipts.date = { $gte: range.from, $lt: range.to };
    const receipts = await Receipt.find(filterReceipts).sort({ date: -1, createdAt: -1 }).limit(2000).lean();
    const names = new Map(customers.map(c => [c.globalCustomerId,customerName(c)]));
    return ok(res, { financialYear, items: receipts.map(r => ({ ...receiptForClient(r), _id: String(r._id), customerName: names.get(r.customerGlobalId) || r.partyNameSnapshot || "Customer", isMine: receiptOwnerId(r) === clean(req.auth.sub), canDeposit: receiptOwnerId(r) === clean(req.auth.sub) })), total: receipts.length });
  } catch(e) { return fail(res, e.message, e.statusCode || 500); }
});

router.get("/collector/day-wise", async (req, res) => {
  try {
    if (!isCollectionExecutiveRole(req.auth.role)) return fail(res, "Collection Executive account required", 403);
    const financialYear = financialYearFromDate(new Date());
    const { filter } = await visibleCustomerFilter(req);
    const customers = await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier paymentType creditDays creditLimit approvedTerms accountingProfile companyContactNumber ownerMobile contacts").sort({ localName: 1 }).limit(5000).lean();
    // Closing balance includes the previous FY opening carry-forward.
    const items = [];
    for (let start = 0; start < customers.length; start += 15) {
      const group = await Promise.all(customers.slice(start,start+15).map(async c => {
        const ledger = await buildCustomerReceivableLedger({ tenantKey: req.auth.tenantKey, financialYear, customer: c });
        const outstanding = money(Math.max(0,ledger.closingSigned));
        const creditDays = num(c.creditDays ?? c.approvedTerms?.creditDays);
        const creditLimit = num(c.creditLimit ?? c.approvedTerms?.creditLimit);
        const isCash = upper(c.paymentType).includes("CASH") || (!creditDays && !creditLimit);
        const bracket = creditDays <= 10 ? "1-10" : creditDays <= 25 ? "11-25" : creditDays <= 45 ? "26-45" : creditDays <= 60 ? "46-60" : "61+";
        return { id: c.globalCustomerId, name: customerName(c), mobile: customerMobile(c), type: isCash ? "CASH" : "CREDIT", creditDays, creditLimit, bracket, outstanding, unpaid: outstanding > 0 };
      }));
      items.push(...group);
    }
    // Cash customers always first; unpaid first within cash/each credit bracket.
    items.sort((a,b) => Number(b.type === "CASH") - Number(a.type === "CASH") ||
      (a.type === "CREDIT" ? (["1-10","11-25","26-45","46-60","61+"].indexOf(a.bracket) - ["1-10","11-25","26-45","46-60","61+"].indexOf(b.bracket)) : 0) ||
      Number(b.unpaid) - Number(a.unpaid) || b.outstanding - a.outstanding || a.name.localeCompare(b.name));
    return ok(res,{ financialYear, items, totals: { cash: items.filter(x=>x.type==="CASH").length, credit:items.filter(x=>x.type==="CREDIT").length, unpaid:items.filter(x=>x.unpaid).length, outstanding:money(items.reduce((n,x)=>n+x.outstanding,0)) } });
  } catch(e) { return fail(res,e.message,e.statusCode||500); }
});

router.get("/cash/assigned-customers", async (req,res) => {
  try {
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    const rows = await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier").sort({localName:1}).limit(5000).lean();
    return ok(res, { items: rows.map(x=>({ id:x.globalCustomerId, name:x.localName||x.displayIdentifier||x.globalCustomerId })) });
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/sales/invoices-today", async (req,res) => {
  try {
    const financialYear = fyOf(req), at = req.query.date ? new Date(req.query.date) : new Date();
    if(Number.isNaN(at.getTime())) return fail(res,"Invalid date",400);
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    const customers = await CustomerLink.find(filter).select("globalCustomerId").lean();
    const ids = customers.map(x=>x.globalCustomerId);
    if(!ids.length) return ok(res,{financialYear,items:[],total:0,count:0});
    const { SalesInvoice } = financialModels(req.auth.tenantKey,financialYear);
    const items = await SalesInvoice.find({tenantKey:req.auth.tenantKey,financialYear,status:"POSTED",invoiceType:{$ne:"PERFORMA"},customerGlobalId:{$in:ids},date:{$gte:startOfDay(at),$lt:endOfDay(at)}}).select("invoiceNo date customerGlobalId customerNameSnapshot grandTotal status").sort({date:-1}).lean();
    return ok(res,{financialYear,items:items.map(x=>({...x,_id:String(x._id)})),total:money(items.reduce((t,x)=>t+num(x.grandTotal),0)),count:items.length});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/home", async (req, res) => {
  try {
    const financialYear = fyOf(req), now = new Date();
    const latitude = Number(req.query.latitude ?? req.query.lat), longitude = Number(req.query.longitude ?? req.query.lng ?? req.query.lon);
    const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude);
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    const customers = await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses creditDays creditLimit accountingProfile salespersonId").lean();
    const ids = customers.map((x) => x.globalCustomerId);
    const { SalesInvoice, SalesOrder, Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1), monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1), todayStart = startOfDay(now), todayEnd = endOfDay(now);
    const { start: fyStart, end: fyEnd } = financialYearBounds(financialYear);
    const [priority, cash, collectionTarget, monthSalesAgg, todayOrdersAgg, todayInvoicesAgg, todayCollectionsAgg, targetDoc, fySalesRows, fyCollectionRows, routePlan, market] = await Promise.all([
      collectionPriorityItems({ tenantKey: req.auth.tenantKey, financialYear, customers }),
      cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, at: now }),
      collectionTargetForUser({ tenantKey: req.auth.tenantKey, financialYear, userId: req.auth.sub, at: now }),
      ids.length ? SalesInvoice.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $gte: monthStart, $lt: monthEnd } } }, { $group: { _id: null, sales: { $sum: "$grandTotal" }, invoices: { $sum: 1 } } }]) : [],
      SalesOrder.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, date: { $gte: todayStart, $lt: todayEnd }, status: { $nin: ["CANCELLED", "REJECTED"] } } }, { $group: { _id: null, sales: { $sum: "$grandTotal" }, orders: { $sum: 1 } } }]),
      ids.length ? SalesInvoice.aggregate([{ $match: { tenantKey:req.auth.tenantKey,financialYear,customerGlobalId:{$in:ids},status:"POSTED",invoiceType:{$ne:"PERFORMA"},date:{$gte:todayStart,$lt:todayEnd} } },{ $group: {_id:null,amount:{$sum:"$grandTotal"},count:{$sum:1}} }]) : [],
      Receipt.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, status: "POSTED", date: { $gte: todayStart, $lt: todayEnd }, ...collectionOwnerFilter(req.auth.sub) } }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      Target.findOne({ tenantKey: req.auth.tenantKey, financialYear, level: "USER", entityId: req.auth.sub, status: { $ne: "CANCELLED" } }).lean(),
      ids.length ? SalesInvoice.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $gte: fyStart, $lt: fyEnd } } }, { $group: { _id: { year: { $year: "$date" }, month: { $month: "$date" } }, amount: { $sum: "$grandTotal" }, count: { $sum: 1 } } }]) : [],
      ids.length ? Receipt.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $gte: fyStart, $lt: fyEnd } } }, { $group: { _id: { year: { $year: "$date" }, month: { $month: "$date" } }, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]) : [],
      SalesRoutePlan.findOne({ tenantKey: req.auth.tenantKey, salespersonId: String(req.auth.sub), dateKey: localDateKey() }).sort({ updatedAt: -1 }).lean(),
      homeLeadMarketContext(req, hasLocation ? latitude : NaN, hasLocation ? longitude : NaN),
    ]);

    const opportunities = await opportunityItemsForUser({ req, financialYear, limit: 24, customers, priority });
    const salesMonth = money(monthSalesAgg[0]?.sales || 0), invoicesMonth = num(monthSalesAgg[0]?.invoices), todayOrderSales = money(todayOrdersAgg[0]?.sales || 0), todayOrders = num(todayOrdersAgg[0]?.orders);
    const todayCollections = money(todayCollectionsAgg[0]?.amount || 0), todayReceiptCount = num(todayCollectionsAgg[0]?.count);
    const monthlyNames = [monthKey(now), String(now.getMonth()+1).padStart(2,"0"), now.toLocaleString("en-US",{month:"long"}), now.toLocaleString("en-US",{month:"short"})].map((x)=>x.toLowerCase());
    const salesMonthRow = (targetDoc?.monthly || []).find((x) => monthlyNames.includes(clean(x?.month).toLowerCase()));
    const salesTarget = money(num(salesMonthRow?.sales) || (num(targetDoc?.annual?.sales) > 0 ? num(targetDoc.annual.sales) / 12 : 0));
    const salesRemaining = money(Math.max(0, salesTarget - salesMonth));
    const salesAchievementPct = salesTarget > 0 ? Math.round(Math.min(999, salesMonth / salesTarget * 100) * 10) / 10 : 0;
    const overdue = money(priority.reduce((s, x) => s + num(x.overdueAmount), 0));
    const outstanding = money(priority.reduce((s, x) => s + Math.max(0, num(x.outstanding)), 0));

    const salesByMonth = new Map(fySalesRows.map((x) => [`${x._id.year}-${String(x._id.month).padStart(2,"0")}`, x]));
    const receiptByMonth = new Map(fyCollectionRows.map((x) => [`${x._id.year}-${String(x._id.month).padStart(2,"0")}`, x]));
    const fiscalMonths = salesCollectionPeriodBuckets(financialYear, "MONTHLY").map((m) => ({
      ...m,
      sales: money(salesByMonth.get(m.key)?.amount || 0), collections: money(receiptByMonth.get(m.key)?.amount || 0),
      invoiceCount: num(salesByMonth.get(m.key)?.count), receiptCount: num(receiptByMonth.get(m.key)?.count),
    }));
    const periodComparisons = periodSummaryFromMonthly(fiscalMonths, financialYear, now);

    const aging = { "0_7": 0, "8_15": 0, "16_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0, opening_or_unallocated: 0 };
    for (const row of priority) for (const [key, value] of Object.entries(row.aging || {})) aging[key] = money(num(aging[key]) + num(value));
    const topPendingParties = [...priority].filter((x) => num(x.outstanding) > 0).sort((a,b) => num(b.outstanding) - num(a.outstanding) || num(b.oldestPendingDays) - num(a.oldestPendingDays)).slice(0,5);

    const openStops = (routePlan?.stops || []).filter((x) => !["COMPLETED","SKIPPED"].includes(upper(x.status)));
    const nextStop = openStops[0] || null;
    const routeProgress = routePlan?.stops?.length ? Math.round(((num(routePlan.completedStops)+num(routePlan.skippedStops))/routePlan.stops.length)*100) : 0;

    const routeCandidate = routePlan && ["READY","IN_PROGRESS"].includes(upper(routePlan.status)) && nextStop ? {
      id: `ROUTE-${routePlan._id}`, type: "ROUTE_NEXT_STOP", score: 128, priority: "HIGH", title: routePlan.status === "IN_PROGRESS" ? "Continue today's route" : "Start today's route",
      subtitle: `${nextStop.customerNameSnapshot || "Next customer"} • ${nextStop.reason || "Planned field visit"}`, amount: num(nextStop.opportunityAmount), actionDescriptor: homeActionRoute("PriorityRoute")
    } : null;
    const topOpportunity = opportunities[0] || null;
    const heroSource = routeCandidate && (!topOpportunity || num(routeCandidate.score) >= num(topOpportunity.score)) ? routeCandidate : topOpportunity;
    const heroAction = heroSource?.actionDescriptor || actionForOpportunity(heroSource, financialYear) || homeActionRoute("PriorityCenter");
    const hour = now.getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

    const sections = [];
    const push = (section) => { if (section && (!section.items || section.items.length) && (!section.cards || section.cards.length)) sections.push(section); };

    const urgentCards = [];
    if (overdue > 0) urgentCards.push({ id:"overdue", icon:"alert-circle-outline", label:"Overdue", value:overdue, format:"MONEY", sub:`${priority.filter(x=>x.overdueAmount>0).length} party(s)`, tone:"HIGH", size:"HALF", action:homeActionRoute("Customers") });
    if (market.nearestLead) urgentCards.push({ id:"nearest-lead", icon:"map-marker-star-outline", label:"Nearest Lead", value:market.nearestLead.companyName || market.nearestLead.contactPerson || "Lead", format:"TEXT", sub:`${market.nearestLead.distanceKm.toFixed(1)} km • ${market.nearestLead.pincode || "No pincode"}`, tone:"TEAL", size:"FULL", action:homeActionNested("Leads","LeadList",{initialTab:"leads",initialPincode:market.nearestLead.pincode||"",initialSearch:market.nearestLead.companyName||market.nearestLead.mobile||"",focusLeadId:String(market.nearestLead._id)}) });
    if (routePlan && ["READY","IN_PROGRESS"].includes(upper(routePlan.status))) urgentCards.push({ id:"route", icon:"map-marker-path", label:routePlan.status === "IN_PROGRESS" ? "Route In Progress" : "Route Ready", value:`${routePlan.completedStops||0}/${routePlan.stops?.length||0}`, format:"TEXT", sub:nextStop?`Next: ${nextStop.customerNameSnapshot}`:`${routeProgress}% completed`, tone:"GOOD", size:"FULL", action:homeActionRoute("PriorityRoute") });
    push({ id:"act-now", kind:"METRIC_GRID", title:"Act Now", priority:110, cards:urgentCards });

    push({ id:"today", kind:"METRIC_GRID", title:"Today", priority:95, cards:[
      { id:"orders",icon:"cart-check",label:"Orders Booked",value:todayOrderSales,format:"MONEY",sub:`${todayOrders} order(s)`,tone:todayOrders?"GOOD":"MUTED",size:"HALF",action:homeActionRoute("Customers") },
      { id:"collections",icon:"cash-check",label:"Collected",value:todayCollections,format:"MONEY",sub:`${todayReceiptCount} receipt(s)`,tone:todayCollections?"GOOD":"MUTED",size:"HALF",action:homeActionRoute("Cash") },
      { id:"cash",icon:"wallet-outline",label:"Cash With Me",value:cash.cashInHand,format:"MONEY",sub:num(cash.cashInHand)>0?"Physical cash responsibility":"No cash pending",tone:num(cash.cashInHand)>0?"TEAL":"MUTED",size:"HALF",action:homeActionRoute("Cash") },
    ]});

    const currentComparison = periodComparisons[0] || {};
    const comparisonPriority = num(currentComparison.sales) > 0 && num(currentComparison.collectionPct) < 70 ? 103 : num(currentComparison.gap) > 0 ? 96 : 86;
    push({ id:"sales-collection", kind:"PERIOD_COMPARE", title:"Sales vs Collection", subtitle:"Tap any period for complete analysis and party drill-down", priority:comparisonPriority,
      action:homeActionRoute("SalesCollectionAnalytics"), items:periodComparisons.map((x)=>({ ...x, action:homeActionRoute("SalesCollectionAnalytics",{initialPeriod:x.id}) })) });

    const ageLabels = {"0_7":"0-7 Days","8_15":"8-15 Days","16_30":"16-30 Days","31_60":"31-60 Days","61_90":"61-90 Days","90_plus":"90+ Days",opening_or_unallocated:"Opening / Legacy"};
    const ageOrder = ["90_plus","61_90","31_60","16_30","8_15","0_7","opening_or_unallocated"];
    const agingCards = ageOrder.filter((key)=>num(aging[key])>0).map((key)=>({ id:key,label:ageLabels[key],value:money(aging[key]),format:"MONEY",tone:["90_plus","61_90"].includes(key)?"CRITICAL":["31_60","16_30"].includes(key)?"HIGH":"TEAL",size:"HALF",action:homeActionRoute("SalesCollectionAnalytics",{initialPeriod:"MONTHLY"}) }));
    const agingPriority = num(aging["90_plus"]) > 0 ? 106 : num(aging["61_90"]) > 0 ? 102 : overdue > 0 ? 97 : 78;
    push({ id:"pending-age",kind:"METRIC_GRID",title:"Pending Amount by Age",subtitle:`Total outstanding ${outstanding.toLocaleString("en-IN")}`,priority:agingPriority,cards:agingCards });

    const topPendingPriority = topPendingParties.some((x)=>num(x.maxOverdueDays)>=60) ? 104 : overdue > 0 ? 94 : 76;
    push({ id:"top-pending",kind:"LIST",title:"Top Pending Parties",subtitle:"Tap party name to open ledger",priority:topPendingPriority,items:topPendingParties.map((row)=>({
      id:row.customer.id,title:row.customer.name,subtitle:`${row.openBills||0} open bill(s) • Oldest ${row.oldestPendingDays||0} days${row.maxOverdueDays?` • ${row.maxOverdueDays}d overdue`:""}`,
      value:row.outstanding,format:"MONEY",badge:row.maxOverdueDays?`${row.maxOverdueDays}d overdue`:`${row.oldestPendingDays||0}d pending`,tone:row.maxOverdueDays>60?"CRITICAL":row.maxOverdueDays>15?"HIGH":"TEAL",
      action:homeActionNested("Customers","CustomerLedger",{customerId:row.customer.id,customerName:row.customer.name,financialYear})
    })) });

    const marketItems = market.areas.map((x)=>({
      id:x.pincode,title:x.pincode === "NO_PINCODE" ? "Pincode Missing" : x.pincode,subtitle:[x.area,x.city,x.district,x.state].filter(Boolean).join(" • ") || "Market area",
      value:x.count,format:"NUMBER",badge:[x.highPriority?`${x.highPriority} high`:"",x.followUpDue?`${x.followUpDue} follow-up due`:""].filter(Boolean).join(" • "),tone:x.highPriority?"HIGH":x.followUpDue?"TEAL":"MUTED",
      action:x.pincode !== "NO_PINCODE"?homeActionNested("Leads","LeadList",{initialTab:"leads",initialPincode:x.pincode}):homeActionNested("Leads","LeadList",{initialTab:"leads"})
    }));
    const marketUrgent = market.areas.reduce((a,x)=>a+num(x.highPriority)+num(x.followUpDue),0);
    const marketPriority = market.nearestLead && num(market.nearestLead.distanceKm) <= 2 ? 101 : marketUrgent > 0 ? 95 : 84;
    push({ id:"market",kind:"MARKET",title:"Lead Market Areas",subtitle:`${market.totalOpenLeads} open lead(s) across ${market.totalAreas} pincode area(s)`,priority:marketPriority,nearest:market.nearestLead?{
      title:market.nearestLead.companyName||market.nearestLead.contactPerson||"Nearest lead",subtitle:`${market.nearestLead.distanceKm.toFixed(1)} km away • ${market.nearestLead.pincode||""}`,tone:"TEAL",
      action:homeActionNested("Leads","LeadList",{initialTab:"leads",initialPincode:market.nearestLead.pincode||"",initialSearch:market.nearestLead.companyName||market.nearestLead.mobile||"",focusLeadId:String(market.nearestLead._id)})
    }:null,items:marketItems });

    const targetCards = [];
    if (salesTarget>0) targetCards.push({id:"sales-target",label:"Sales Target",current:salesMonth,target:salesTarget,pct:salesAchievementPct,remaining:salesRemaining,format:"MONEY",tone:salesAchievementPct>=100?"GOOD":salesAchievementPct<60?"HIGH":"TEAL",action:homeActionRoute("SalesCollectionAnalytics",{initialPeriod:"MONTHLY"})});
    if (collectionTarget?.configured) targetCards.push({id:"collection-target",label:"Collection Target",current:num(collectionTarget.achieved),target:num(collectionTarget.target),pct:num(collectionTarget.achievementPct),remaining:num(collectionTarget.remaining),format:"MONEY",tone:num(collectionTarget.achievementPct)>=100?"GOOD":num(collectionTarget.achievementPct)<60?"HIGH":"TEAL",action:homeActionRoute("SalesCollectionAnalytics",{initialPeriod:"MONTHLY"})});
    const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    const expectedPacePct = daysInMonth ? now.getDate()/daysInMonth*100 : 0;
    const targetBehind = (salesTarget>0 && salesAchievementPct+12<expectedPacePct) || (collectionTarget?.configured && num(collectionTarget.achievementPct)+12<expectedPacePct);
    push({id:"targets",kind:"PROGRESS",title:"Target Pace",priority:targetBehind?99:82,items:targetCards});

    push({id:"opportunities",kind:"LIST",title:"Best Opportunities",subtitle:`${opportunities.length} ranked sales / collection opportunity signal(s)`,priority:80,items:opportunities.slice(0,8).map((x)=>({
      id:x.id,title:x.title,subtitle:x.subtitle,value:num(x.amount),format:num(x.amount)>0?"MONEY":"",badge:x.priority||"",tone:x.priority||"TEAL",action:actionForOpportunity(x,financialYear)
    })).filter((x)=>x.action)});

    const quick = [
      overdue>0?{id:"collection",icon:"account-cash-outline",label:"Due Customers",tone:"HIGH",action:homeActionRoute("Customers")}:null,
      market.totalOpenLeads>0?{id:"lead-areas",icon:"map-marker-radius-outline",label:"Leads by Pincode",tone:"TEAL",action:homeActionNested("Leads","LeadList",{initialTab:"leads",initialMarketMode:"AREA"})}:null,
      {id:"analytics",icon:"chart-bar",label:"Sales vs Collection",tone:"TEAL",action:homeActionRoute("SalesCollectionAnalytics")},
      {id:"route",icon:"map-marker-path",label:routePlan?"Today's Route":"Build Daily Route",tone:routePlan?"GOOD":"TEAL",action:homeActionRoute("PriorityRoute")},
      {id:"cash",icon:"wallet-outline",label:"Cash & Collection",tone:num(cash.cashInHand)>0?"HIGH":"TEAL",action:homeActionRoute("Cash")},
      {id:"priority",icon:"bell-alert-outline",label:"Priority Center",tone:"TEAL",action:homeActionRoute("PriorityCenter")},
    ].filter(Boolean);
    push({id:"quick-actions",kind:"ACTION_GRID",title:"Quick Actions",priority:50,items:quick});

    sections.sort((a,b)=>num(b.priority)-num(a.priority));
    const heroTitle = heroSource?.title || "You're caught up";
    const heroSubtitle = heroSource?.subtitle || "No urgent sales or collection action is waiting right now.";
    return ok(res, {
      financialYear,
      generatedAt:new Date(),
      context:{greeting,role:upper(req.auth.role||req.auth.appRoleCode||"SALES_PERSON"),locationAvailable:hasLocation,dayPart:hour<12?"MORNING":hour<17?"AFTERNOON":"EVENING"},
      hero:{eyebrow:`${greeting.toUpperCase()} • DYNAMIC SALES HOME`,title:heroTitle,subtitle:heroSubtitle,tone:heroSource?.priority||"TEAL",action:heroAction,confidence:heroSource?.confidence||null},
      simplifiedHome:{
        todayInvoiceSales:money(todayInvoicesAgg?.[0]?.amount||0), todayInvoiceCount:num(todayInvoicesAgg?.[0]?.count),
        todayCollections, todayReceiptCount, totalDue:outstanding,
        topPendingParties:topPendingParties.map(x=>({ id:x.customer.id, name:x.customer.name, outstanding:num(x.outstanding), overdueDays:x.maxOverdueDays||0 })),
        fiscalMonths, nearLead:market.nearestLead||null, nearLeadCount:market.totalOpenLeads||0,
      },
      dynamicLayout:{version:2,sections},
      // Backward-compatible values are retained for older app builds.
      today:{orderSales:todayOrderSales,orders:todayOrders,collections:todayCollections,receipts:todayReceiptCount,cashInHand:cash.cashInHand},
      month:{sales:salesMonth,invoices:invoicesMonth,salesTarget,salesRemaining,salesAchievementPct,collectionTarget},
      receivables:{outstanding,overdue,priorityCustomers:priority.length},
      cash,
      market,
      route:{plan:routePlan||null,progressPct:routeProgress,nextStop:nextStop||null},
      salesCollection:{periods:periodComparisons,aging},
      nextBestAction:heroSource?{...heroSource,headline:heroTitle,headlineSub:heroSubtitle}:{headline:heroTitle,headlineSub:heroSubtitle},
      opportunities:opportunities.slice(0,10),opportunityCount:opportunities.length,
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

export default router;
