import { CompanyProfile, GenericRecord, Product } from "../models/index.js";
import { financialModels } from "./accountingService.js";
import { normalizeFinancialYear } from "../utils/financialYear.js";

const INVALID_INVOICE_STATUSES = ["DELETED", "CANCELLED", "VOID", "DRAFT", "PERFORMA", "CONVERTING", "CONVERTED"];
const INVALID_ORDER_STATUSES = ["DRAFT", "CANCELLED", "REJECTED", "DELETED", "VOID"];
const COMPLETED_ORDER_WORKFLOWS = [
  "INVOICED",
  "DELIVERED",
  "HANDED_TO_TRANSPORTER",
  "CLOSED",
  "CANCELLED",
  "REJECTED",
  "RETURNED_TO_WAREHOUSE",
];

const N = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const R = (value) => Math.round((N(value) + Number.EPSILON) * 100) / 100;
const T = (value) => String(value ?? "").trim();
const U = (value) => T(value).toUpperCase();
const id = (value) => T(value);

function fyStart(fy) {
  return Number(String(normalizeFinancialYear(fy)).slice(0, 4)) || 0;
}

function fyLabel(start) {
  return `${start}-${String(start + 1).slice(-2).padStart(2, "0")}`;
}

function sortFys(values = []) {
  return [...new Set(values.map(normalizeFinancialYear).filter(Boolean))].sort((a, b) => fyStart(a) - fyStart(b));
}

function exactOpeningQty(product, fy) {
  const stores = [product?.openingStockByFY, product?.openingStocks, product?.financialYearOpenings];
  for (const store of stores) {
    if (!store || typeof store !== "object") continue;
    const value = store[fy] ?? store[String(fy)];
    if (value == null) continue;
    if (typeof value === "number" || typeof value === "string") return R(value);
    for (const key of ["qty", "quantity", "openingStock", "Opening_Stock", "stock"]) {
      if (value?.[key] != null) return R(value[key]);
    }
  }
  if (normalizeFinancialYear(product?.openingFinancialYear) === fy) {
    if (product?.financialYearOpeningStock != null) return R(product.financialYearOpeningStock);
  }
  return null;
}

function exactOpeningRate(product, fy) {
  const stores = [product?.openingStockByFY, product?.openingStocks, product?.financialYearOpenings];
  for (const store of stores) {
    if (!store || typeof store !== "object") continue;
    const value = store[fy] ?? store[String(fy)];
    if (!value || typeof value !== "object") continue;
    for (const key of ["rate", "openingRate", "Opening_Rate", "averageRate", "closingAveRate"]) {
      if (value[key] != null) return R(value[key]);
    }
  }
  if (normalizeFinancialYear(product?.openingFinancialYear) === fy && product?.financialYearOpeningRate != null) {
    return R(product.financialYearOpeningRate);
  }
  return null;
}

function masterOpeningQty(product) {
  return R(product?.openingStock ?? product?.financialYearOpeningStock ?? product?.Opening_Stock ?? 0);
}

function masterOpeningRate(product) {
  return R(product?.openingRate ?? product?.financialYearOpeningRate ?? product?.Opening_Rate ?? product?.averagePurchasePrice ?? product?.landedCost ?? 0);
}

function weightedRate(value, qty, fallback = 0) {
  return R(N(qty) ? N(value) / N(qty) : N(fallback));
}

function emptyMovement() {
  return {
    inwardQty: 0,
    inwardValue: 0,
    lastPurchaseQty: 0,
    lastPurchaseRate: 0,
    lastPurchaseDate: null,
    outwardQty: 0,
    outwardValue: 0,
    lastSaleQty: 0,
    lastSaleRate: 0,
    lastSaleDate: null,
    pendingQty: 0,
    pendingValue: 0,
  };
}

function movementFor(map, productId) {
  return map.get(id(productId)) || emptyMovement();
}

function mergeMovement(target, rows, type) {
  for (const raw of rows || []) {
    const pid = id(raw?._id);
    if (!pid) continue;
    const row = target.get(pid) || emptyMovement();
    if (type === "PURCHASE") {
      row.inwardQty = R(raw.qty);
      row.inwardValue = R(raw.value);
      row.lastPurchaseQty = R(raw.lastQty);
      row.lastPurchaseRate = R(raw.lastRate);
      row.lastPurchaseDate = raw.lastDate || null;
    } else if (type === "SALE") {
      row.outwardQty = R(raw.qty);
      row.outwardValue = R(raw.value);
      row.lastSaleQty = R(raw.lastQty);
      row.lastSaleRate = R(raw.lastRate);
      row.lastSaleDate = raw.lastDate || null;
    } else if (type === "PENDING") {
      row.pendingQty = R(raw.qty);
      row.pendingValue = R(raw.value);
    }
    target.set(pid, row);
  }
}

async function aggregatePurchase(models, tenantKey, financialYear, productIds) {
  if (!productIds.length) return [];
  return models.PurchaseInvoice.aggregate([
    { $match: { tenantKey, financialYear, status: { $nin: INVALID_INVOICE_STATUSES } } },
    { $unwind: "$items" },
    { $addFields: {
      _pid: { $toString: "$items.productId" },
      _qty: { $ifNull: ["$items.qty", 0] },
      _rate: { $ifNull: ["$items.netRate", { $ifNull: ["$items.effectiveRate", { $ifNull: ["$items.rate", 0] }] }] },
      _value: { $ifNull: ["$items.netTaxable", { $ifNull: ["$items.taxable", { $multiply: [{ $ifNull: ["$items.qty", 0] }, { $ifNull: ["$items.rate", 0] }] }] }] },
    } },
    { $match: { _pid: { $in: productIds } } },
    { $sort: { date: 1, createdAt: 1, _id: 1 } },
    { $group: {
      _id: "$_pid",
      qty: { $sum: "$_qty" },
      value: { $sum: "$_value" },
      lastQty: { $last: "$_qty" },
      lastRate: { $last: "$_rate" },
      lastDate: { $last: "$date" },
    } },
  ]).allowDiskUse(true);
}

async function aggregateSales(models, tenantKey, financialYear, productIds) {
  if (!productIds.length) return [];
  return models.SalesInvoice.aggregate([
    { $match: { tenantKey, financialYear, status: { $nin: INVALID_INVOICE_STATUSES } } },
    { $unwind: "$items" },
    { $addFields: {
      _pid: { $toString: "$items.productId" },
      _qty: { $ifNull: ["$items.qty", 0] },
      _rate: { $ifNull: ["$items.effectiveRate", { $ifNull: ["$items.rate", 0] }] },
      _value: { $ifNull: ["$items.taxable", { $multiply: [{ $ifNull: ["$items.qty", 0] }, { $ifNull: ["$items.effectiveRate", { $ifNull: ["$items.rate", 0] }] }] }] },
    } },
    { $match: { _pid: { $in: productIds } } },
    { $sort: { date: 1, createdAt: 1, _id: 1 } },
    { $group: {
      _id: "$_pid",
      qty: { $sum: "$_qty" },
      value: { $sum: "$_value" },
      lastQty: { $last: "$_qty" },
      lastRate: { $last: "$_rate" },
      lastDate: { $last: "$date" },
    } },
  ]).allowDiskUse(true);
}

async function aggregatePending(models, tenantKey, financialYear, productIds) {
  if (!productIds.length) return [];
  return models.SalesOrder.aggregate([
    {
      $match: {
        tenantKey,
        financialYear,
        status: { $nin: INVALID_ORDER_STATUSES },
        workflowStatus: { $nin: COMPLETED_ORDER_WORKFLOWS },
      },
    },
    { $unwind: "$items" },
    {
      $addFields: {
        _pid: { $toString: "$items.productId" },
        _rawPending: {
          $cond: [
            { $eq: [{ $toUpper: { $ifNull: ["$reservation.status", ""] } }, "RELEASED"] },
            0,
            {
              $cond: [
                { $gt: [{ $ifNull: ["$items.reservedQty", 0] }, 0] },
                { $ifNull: ["$items.reservedQty", 0] },
                {
                  $let: {
                    vars: {
                      remaining: {
                        $subtract: [
                          { $ifNull: ["$items.qty", 0] },
                          {
                            $add: [
                              { $ifNull: ["$items.invoicedQty", 0] },
                              { $ifNull: ["$items.cancelledQty", 0] },
                              { $ifNull: ["$items.returnedQty", 0] },
                            ],
                          },
                        ],
                      },
                    },
                    in: { $cond: [{ $gt: ["$$remaining", 0] }, "$$remaining", 0] },
                  },
                },
              ],
            },
          ],
        },
        _rate: {
          $ifNull: [
            "$items.rate",
            {
              $cond: [
                { $gt: [{ $ifNull: ["$items.qty", 0] }, 0] },
                { $divide: [{ $ifNull: ["$items.taxable", 0] }, "$items.qty"] },
                0,
              ],
            },
          ],
        },
      },
    },
    { $match: { _pid: { $in: productIds }, _rawPending: { $gt: 0 } } },
    { $group: { _id: "$_pid", qty: { $sum: "$_rawPending" }, value: { $sum: { $multiply: ["$_rawPending", "$_rate"] } } } },
  ]).allowDiskUse(true);
}

async function readFyMovement({ tenantKey, financialYear, productIds, includePurchase = true, includeSales = true, includePending = true }) {
  const models = financialModels(tenantKey, financialYear);
  const [purchases, sales, pending] = await Promise.all([
    includePurchase ? aggregatePurchase(models, tenantKey, financialYear, productIds) : Promise.resolve([]),
    includeSales ? aggregateSales(models, tenantKey, financialYear, productIds) : Promise.resolve([]),
    includePending ? aggregatePending(models, tenantKey, financialYear, productIds) : Promise.resolve([]),
  ]);
  const movement = new Map();
  mergeMovement(movement, purchases, "PURCHASE");
  mergeMovement(movement, sales, "SALE");
  mergeMovement(movement, pending, "PENDING");
  return movement;
}

function latestPriorSale(productId, fyMovements, selectedFy) {
  let best = { qty: 0, rate: 0, date: null };
  for (const [fy, map] of fyMovements) {
    if (fyStart(fy) >= fyStart(selectedFy)) continue;
    const move = movementFor(map, productId);
    if (!move.lastSaleDate) continue;
    if (!best.date || new Date(move.lastSaleDate) > new Date(best.date)) {
      best = { qty: R(move.lastSaleQty), rate: R(move.lastSaleRate), date: move.lastSaleDate };
    }
  }
  return best;
}

function firstTransactionFy(productId, orderedFys, fyMovements) {
  for (const fy of orderedFys) {
    const move = movementFor(fyMovements.get(fy) || new Map(), productId);
    if (N(move.inwardQty) || N(move.outwardQty) || move.lastPurchaseDate || move.lastSaleDate) return fy;
  }
  return "";
}

function openingForSelectedFy({ product, selectedFy, orderedFys, fyMovements }) {
  const productId = id(product._id);
  const firstTx = firstTransactionFy(productId, orderedFys, fyMovements);
  const baseFy = firstTx
    || normalizeFinancialYear(product?.openingFinancialYear)
    || normalizeFinancialYear(product?.financialYear)
    || selectedFy;

  if (fyStart(selectedFy) < fyStart(baseFy)) return { qty: 0, rate: 0, baseFy, firstTx };

  let qty = exactOpeningQty(product, baseFy);
  let rate = exactOpeningRate(product, baseFy);
  if (qty == null) qty = masterOpeningQty(product);
  if (rate == null) rate = masterOpeningRate(product);

  const baseStart = fyStart(baseFy);
  const selectedStart = fyStart(selectedFy);
  for (let year = baseStart; year < selectedStart; year += 1) {
    const fy = fyLabel(year);
    const move = movementFor(fyMovements.get(fy) || new Map(), productId);
    const inwardRate = weightedRate(move.inwardValue, move.inwardQty, rate);
    const costQty = N(qty) + N(move.inwardQty);
    const costValue = N(qty) * N(rate) + (N(move.inwardValue) || N(move.inwardQty) * inwardRate);
    const closingRate = weightedRate(costValue, costQty, inwardRate || rate);
    const closingQty = R(N(qty) + N(move.inwardQty) - N(move.pendingQty) - N(move.outwardQty));
    qty = closingQty;
    rate = closingRate;
  }

  return { qty: R(qty), rate: R(rate), baseFy, firstTx };
}

function totalRows(rows = []) {
  const sum = (key) => R(rows.reduce((acc, row) => acc + N(row[key]), 0));
  return {
    products: rows.length,
    openingQty: sum("openingQty"),
    openingTotal: sum("openingTotal"),
    inwardQty: sum("inwardQty"),
    inwardTotal: sum("inwardTotal"),
    pendingQty: sum("pendingQty"),
    pendingTotal: sum("pendingTotal"),
    outwardQty: sum("outwardQty"),
    outwardTotal: sum("outwardTotal"),
    closingQty: sum("closingQty"),
    closingTotal: sum("closingTotal"),
  };
}

export async function buildStockAnalysisReport({
  tenantKey,
  financialYear,
  reportType = "ALL_IN_ONE",
  category = "",
  subCategory = "",
  warehouseId = "",
  productId = "",
}) {
  const selectedFy = normalizeFinancialYear(financialYear);
  const type = U(reportType || "ALL_IN_ONE");
  const [profile, products, warehouses] = await Promise.all([
    CompanyProfile.findOne({ tenantKey }).select("financialYear financialYears").lean(),
    Product.find({ tenantKey, status: { $ne: "DELETED" } }).sort({ name: 1 }).lean(),
    GenericRecord.find({ tenantKey, app: "dms", resource: "warehouses", status: { $ne: "DELETED" } })
      .select("_id title reference status")
      .sort({ title: 1 })
      .lean(),
  ]);

  const warehouseMap = new Map(warehouses.map((w) => [id(w._id), T(w.title || w.reference || w._id)]));
  const allProducts = products.map((product) => ({
    ...product,
    _warehouseName: warehouseMap.get(id(product.warehouseId)) || id(product.warehouseId) || "UNASSIGNED",
  }));

  const categories = [...new Set(allProducts.map((p) => T(p.category)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const subCategories = [...new Set(allProducts.map((p) => T(p.subCategory)).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const filteredProducts = allProducts.filter((product) => {
    if (category && T(product.category) !== T(category)) return false;
    if (subCategory && T(product.subCategory) !== T(subCategory)) return false;
    if (warehouseId && id(product.warehouseId) !== id(warehouseId)) return false;
    if (productId && id(product._id) !== id(productId)) return false;
    return true;
  });
  const productIds = filteredProducts.map((p) => id(p._id));

  const configured = sortFys([
    ...(Array.isArray(profile?.financialYears) ? profile.financialYears : []),
    profile?.financialYear,
    selectedFy,
    ...allProducts.map((p) => p.openingFinancialYear),
  ]);
  const selectedStart = fyStart(selectedFy);
  const priorAndSelected = configured.filter((fy) => fyStart(fy) <= selectedStart);
  const needsOpening = ["OPENING", "CLOSING", "ALL_IN_ONE"].includes(type);
  // Opening-year ownership is determined from the product's FIRST sale/purchase,
  // so opening-based reports also inspect configured later FYs.  Pending is only
  // needed through the selected FY because later orders cannot affect this report.
  const yearsToRead = needsOpening ? configured : [selectedFy];

  const fyMovements = new Map();
  await Promise.all(yearsToRead.map(async (fy) => {
    const movement = await readFyMovement({
      tenantKey,
      financialYear: fy,
      productIds,
      includePurchase: type !== "OUTWARD" || needsOpening,
      includeSales: type !== "INWARD" || needsOpening,
      includePending: needsOpening && fyStart(fy) <= selectedStart,
    });
    fyMovements.set(fy, movement);
  }));

  const selectedMovement = fyMovements.get(selectedFy) || new Map();
  const rows = filteredProducts.map((product) => {
    const pid = id(product._id);
    const move = movementFor(selectedMovement, pid);
    const opening = needsOpening
      ? openingForSelectedFy({ product, selectedFy, orderedFys: configured, fyMovements })
      : { qty: 0, rate: 0, baseFy: "", firstTx: "" };
    const priorSale = needsOpening ? latestPriorSale(pid, fyMovements, selectedFy) : { qty: 0, rate: 0, date: null };

    const openingQty = R(opening.qty);
    const openingRate = R(opening.rate);
    const openingTotal = R(openingQty * openingRate);

    const inwardQty = R(move.inwardQty);
    const inwardRate = weightedRate(move.inwardValue, inwardQty, product.averagePurchasePrice || product.openingRate);
    const inwardTotal = R(move.inwardValue || inwardQty * inwardRate);

    const pendingQty = R(move.pendingQty);
    const pendingRate = weightedRate(move.pendingValue, pendingQty, product.salePrice);
    const pendingTotal = R(move.pendingValue || pendingQty * pendingRate);

    const outwardQty = R(move.outwardQty);
    const outwardRate = weightedRate(move.outwardValue, outwardQty, product.salePrice);
    const outwardTotal = R(move.outwardValue || outwardQty * outwardRate);

    const closingQty = R(openingQty + inwardQty - pendingQty - outwardQty);
    const closingCostQty = openingQty + inwardQty;
    const closingCostValue = openingTotal + inwardTotal;
    const closingRate = weightedRate(closingCostValue, closingCostQty, inwardRate || openingRate || product.averagePurchasePrice || product.openingRate);
    const closingTotal = R(closingQty * closingRate);

    return {
      id: pid,
      financialYear: selectedFy,
      warehouseId: id(product.warehouseId),
      warehouse: product._warehouseName,
      productName: T(product.name || product.sku),
      category: T(product.category),
      subCategory: T(product.subCategory),
      hsn: T(product.hsnCode),
      minStockAlert: R(product.minStockAlert),
      productCreatedAt: product.createdAt || null,
      baseFinancialYear: opening.baseFy || "",
      firstTransactionFinancialYear: opening.firstTx || "",

      lastOpeningSaleQty: R(priorSale.qty),
      lastOpeningSaleRate: R(priorSale.rate),
      lastOpeningSaleDate: priorSale.date,
      openingQty,
      openingRate,
      openingTotal,

      lastPurchaseQty: R(move.lastPurchaseQty),
      lastPurchaseRate: R(move.lastPurchaseRate),
      lastPurchaseDate: move.lastPurchaseDate,
      inwardQty,
      inwardRate,
      inwardTotal,

      pendingQty,
      pendingRate,
      pendingTotal,

      lastSaleQty: R(move.lastSaleQty),
      lastSaleRate: R(move.lastSaleRate),
      lastSaleDate: move.lastSaleDate,
      outwardQty,
      outwardRate,
      outwardTotal,

      closingQty,
      closingRate,
      closingTotal,
    };
  });

  return {
    reportType: type,
    financialYear: selectedFy,
    rows,
    totals: totalRows(rows),
    meta: {
      categories,
      subCategories,
      warehouses: warehouses.map((w) => ({ id: id(w._id), name: T(w.title || w.reference || w._id) })),
      products: allProducts.map((p) => ({
        id: id(p._id),
        name: T(p.name || p.sku),
        hsn: T(p.hsnCode),
        category: T(p.category),
        subCategory: T(p.subCategory),
        warehouseId: id(p.warehouseId),
      })),
      financialYears: configured,
    },
    formula: "CLOSING = OPENING + INWARD - PENDING - OUTWARD",
  };
}


function newerActivity(current, candidate) {
  if (!candidate?.date) return current;
  if (!current?.date) return candidate;
  return new Date(candidate.date).getTime() >= new Date(current.date).getTime() ? candidate : current;
}

async function aggregateLastPurchaseDetails(models, tenantKey, financialYear, productIds) {
  if (!productIds.length) return [];
  return models.PurchaseInvoice.aggregate([
    { $match: { tenantKey, financialYear, status: { $nin: INVALID_INVOICE_STATUSES } } },
    { $unwind: "$items" },
    { $addFields: {
      _pid: { $toString: "$items.productId" },
      _rate: { $ifNull: ["$items.netRate", { $ifNull: ["$items.effectiveRate", { $ifNull: ["$items.rate", 0] }] }] },
    } },
    { $match: { _pid: { $in: productIds } } },
    { $sort: { date: 1, createdAt: 1, _id: 1 } },
    { $group: {
      _id: "$_pid",
      lastDate: { $last: "$date" },
      lastRate: { $last: "$_rate" },
      supplierGlobalId: { $last: "$supplierGlobalId" },
      supplierName: { $last: "$supplierNameSnapshot" },
      invoiceNo: { $last: "$invoiceNo" },
    } },
  ]).allowDiskUse(true);
}

async function aggregateLastSaleDetails(models, tenantKey, financialYear, productIds) {
  if (!productIds.length) return [];
  return models.SalesInvoice.aggregate([
    { $match: { tenantKey, financialYear, status: { $nin: INVALID_INVOICE_STATUSES } } },
    { $unwind: "$items" },
    { $addFields: { _pid: { $toString: "$items.productId" } } },
    { $match: { _pid: { $in: productIds } } },
    { $sort: { date: 1, createdAt: 1, _id: 1 } },
    { $group: {
      _id: "$_pid",
      lastDate: { $last: "$date" },
      invoiceNo: { $last: "$invoiceNo" },
    } },
  ]).allowDiskUse(true);
}

async function readLatestProductActivity({ tenantKey, financialYears, productIds }) {
  const purchaseMap = new Map();
  const saleMap = new Map();
  await Promise.all(financialYears.map(async (fy) => {
    const models = financialModels(tenantKey, fy);
    const [purchases, sales] = await Promise.all([
      aggregateLastPurchaseDetails(models, tenantKey, fy, productIds),
      aggregateLastSaleDetails(models, tenantKey, fy, productIds),
    ]);
    for (const row of purchases) {
      const pid = id(row._id);
      const candidate = {
        date: row.lastDate || null,
        rate: R(row.lastRate),
        supplierGlobalId: T(row.supplierGlobalId),
        supplierName: T(row.supplierName),
        invoiceNo: T(row.invoiceNo),
        financialYear: fy,
      };
      purchaseMap.set(pid, newerActivity(purchaseMap.get(pid), candidate));
    }
    for (const row of sales) {
      const pid = id(row._id);
      const candidate = { date: row.lastDate || null, invoiceNo: T(row.invoiceNo), financialYear: fy };
      saleMap.set(pid, newerActivity(saleMap.get(pid), candidate));
    }
  }));
  return { purchaseMap, saleMap };
}

function inactivityDays(date, now = new Date()) {
  if (!date) return null;
  const a = new Date(date);
  if (Number.isNaN(a.getTime())) return null;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  return Math.max(0, Math.floor((end - start) / 86400000));
}

export async function buildStockAlertReport({
  tenantKey,
  financialYear,
  reportType = "LOW_STOCK",
  category = "",
  subCategory = "",
  warehouseId = "",
  productId = "",
  alertStatus = "",
  movementType = "",
}) {
  const type = U(reportType);
  if (!["LOW_STOCK", "OVERDUE", "DEAD_STOCK"].includes(type)) {
    const error = new Error("Unsupported stock alert report type");
    error.statusCode = 400;
    throw error;
  }

  const [profile, base] = await Promise.all([
    CompanyProfile.findOne({ tenantKey })
      .select("financialYear financialYears stockOverdueDays deadStockDays")
      .lean(),
    buildStockAnalysisReport({
      tenantKey,
      financialYear,
      reportType: "CLOSING",
      category,
      subCategory,
      warehouseId,
      productId,
    }),
  ]);

  const productIds = (base.rows || []).map((row) => id(row.id)).filter(Boolean);
  const configuredFys = sortFys([
    ...(Array.isArray(profile?.financialYears) ? profile.financialYears : []),
    profile?.financialYear,
    financialYear,
  ]);
  const { purchaseMap, saleMap } = await readLatestProductActivity({ tenantKey, financialYears: configuredFys, productIds });

  const overdueDays = Math.max(1, Math.trunc(N(profile?.stockOverdueDays) || 60));
  const deadStockDays = Math.max(1, Math.trunc(N(profile?.deadStockDays) || 180));
  const wantedAlert = U(alertStatus);
  const wantedMovement = U(movementType);

  let rows = (base.rows || []).map((row) => {
    const pid = id(row.id);
    const purchase = purchaseMap.get(pid) || {};
    const sale = saleMap.get(pid) || {};
    const purchaseDate = purchase.date ? new Date(purchase.date) : null;
    const saleDate = sale.date ? new Date(sale.date) : null;
    let lastMovementDate = null;
    let lastMovementType = "NEVER";
    if (purchaseDate && (!saleDate || purchaseDate >= saleDate)) {
      lastMovementDate = purchase.date;
      lastMovementType = "PURCHASE";
    } else if (saleDate) {
      lastMovementDate = sale.date;
      lastMovementType = "SALE";
    }
    const activityBaseline = lastMovementDate || row.productCreatedAt || null;
    const inactive = inactivityDays(activityBaseline);
    const lowStock = R(row.minStockAlert);
    const currentStock = R(row.closingQty);
    const nearLimit = R(lowStock * 1.2);
    const lowStatus = lowStock > 0 && currentStock <= lowStock
      ? "LOW"
      : lowStock > 0 && currentStock <= nearLimit
        ? "NEAR LOW"
        : "NORMAL";

    return {
      ...row,
      lowStock,
      currentStock,
      lowStockStatus: lowStatus,
      lastPurchasePartyName: T(purchase.supplierName) || "—",
      lastPurchasePartyGlobalId: T(purchase.supplierGlobalId),
      lastPurchasePartyRate: R(purchase.rate),
      lastPurchaseDate: purchase.date || null,
      lastPurchaseInvoiceNo: T(purchase.invoiceNo),
      lastSaleDate: sale.date || null,
      lastSaleInvoiceNo: T(sale.invoiceNo),
      lastMovementDate,
      lastMovementType,
      inactiveDays: inactive,
      activityBaseline,
    };
  });

  if (type === "LOW_STOCK") {
    rows = rows.filter((row) => row.lowStock > 0 && ["LOW", "NEAR LOW"].includes(row.lowStockStatus));
    if (wantedAlert && wantedAlert !== "ALL") rows = rows.filter((row) => U(row.lowStockStatus) === wantedAlert);
    rows.sort((a, b) => (a.currentStock - a.lowStock) - (b.currentStock - b.lowStock) || a.productName.localeCompare(b.productName));
  } else {
    const limit = type === "OVERDUE" ? overdueDays : deadStockDays;
    rows = rows.filter((row) => N(row.currentStock) > 0 && row.inactiveDays != null && row.inactiveDays >= limit);
    if (wantedMovement && wantedMovement !== "ALL") rows = rows.filter((row) => U(row.lastMovementType) === wantedMovement);
    rows.sort((a, b) => N(b.inactiveDays) - N(a.inactiveDays) || a.productName.localeCompare(b.productName));
  }

  return {
    reportType: type,
    financialYear: base.financialYear,
    rows,
    totals: {
      products: rows.length,
      currentStock: R(rows.reduce((sum, row) => sum + N(row.currentStock), 0)),
      currentStockValue: R(rows.reduce((sum, row) => sum + N(row.closingTotal), 0)),
    },
    meta: {
      ...(base.meta || {}),
      stockOverdueDays: overdueDays,
      deadStockDays,
      movementTypes: ["PURCHASE", "SALE", "NEVER"],
      alertStatuses: ["LOW", "NEAR LOW"],
    },
  };
}
