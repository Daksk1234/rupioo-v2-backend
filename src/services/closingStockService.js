// V2 Closing Stock report rebuilt with the OLD DMS Closing Stock presentation.
// Old DMS is used only as a behavioural/layout reference; all data comes from V2.
//
// Business quantity rule requested for V2:
//   Closing Stock = FY Opening Stock + FY Purchases - Stock In Order - FY Sales
//
// Inward         = every valid Purchase Invoice quantity in the selected FY, product-wise.
// Outward        = every valid Sales Invoice quantity in the selected FY, product-wise.
// Stock In Order = placed/active Sales Order quantity that has NOT yet been invoiced.
// Once an order quantity is invoiced it leaves Stock In Order and is counted in Outward,
// so the same quantity is never deducted twice.

import { Product, GenericRecord } from "../models/index.js";

const LIMIT = 40000;
const DAY = 86400000;
const N = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const R = (value) => Math.round((N(value) + Number.EPSILON) * 100) / 100;
const T = (value) => String(value ?? "").trim();
const U = (value) => T(value).toUpperCase();

const FINAL_ORDER_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "CLOSED",
  "RETURNED_TO_WAREHOUSE",
]);

const fyStartDate = (financialYear) =>
  new Date(`${String(financialYear).slice(0, 4)}-04-01T00:00:00.000Z`);
const endExclusive = (isoDate) =>
  new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + DAY);

async function read(model, query, sort = { date: 1 }) {
  const rows = await model.find(query).sort(sort).limit(LIMIT + 1).lean();
  if (rows.length > LIMIT) {
    const error = new Error(
      `Closing Stock exceeds ${LIMIT} source documents. Select a shorter period.`,
    );
    error.statusCode = 413;
    throw error;
  }
  return rows;
}

function fyOpeningFromMixed(value, financialYear) {
  if (!value || typeof value !== "object") return null;
  const item = value[financialYear] ?? value[String(financialYear)];
  if (item == null) return null;
  if (typeof item === "number" || typeof item === "string") return N(item);
  if (typeof item === "object") {
    for (const key of ["qty", "quantity", "openingStock", "Opening_Stock", "stock"]) {
      if (item[key] != null) return N(item[key]);
    }
  }
  return null;
}

function fyOpeningRateFromMixed(value, financialYear) {
  if (!value || typeof value !== "object") return null;
  const item = value[financialYear] ?? value[String(financialYear)];
  if (!item || typeof item !== "object") return null;
  for (const key of ["rate", "openingRate", "Opening_Rate", "averageRate", "closingAveRate"]) {
    if (item[key] != null) return N(item[key]);
  }
  return null;
}

export function productFyOpeningQty(product, financialYear) {
  for (const value of [
    product?.openingStockByFY,
    product?.openingStocks,
    product?.financialYearOpenings,
  ]) {
    const found = fyOpeningFromMixed(value, financialYear);
    if (found != null) return R(found);
  }

  if (T(product?.openingFinancialYear) === T(financialYear)) {
    if (product?.financialYearOpeningStock != null)
      return R(product.financialYearOpeningStock);
    if (product?.Opening_Stock != null) return R(product.Opening_Stock);
    if (product?.openingStock != null) return R(product.openingStock);
  }

  // V2 product master stores the current FY opening here. Migrated products may
  // still use the legacy names, so retain safe fallbacks.
  return R(
    product?.openingStock ??
      product?.financialYearOpeningStock ??
      product?.Opening_Stock ??
      0,
  );
}

export function productFyOpeningRate(product, financialYear) {
  for (const value of [
    product?.openingStockByFY,
    product?.openingStocks,
    product?.financialYearOpenings,
  ]) {
    const found = fyOpeningRateFromMixed(value, financialYear);
    if (found != null) return R(found);
  }

  return R(
    product?.openingRate ??
      product?.Opening_Rate ??
      product?.averagePurchasePrice ??
      product?.landedCost ??
      0,
  );
}

function initialMovement() {
  return {
    purchase: 0,
    purchaseValue: 0,
    outward: 0,
    outwardValue: 0,
    stockInOrder: 0,
    stockInOrderValue: 0,
    openOrders: 0,
  };
}

function getMovement(map, productId) {
  const id = T(productId);
  if (!id) return null;
  if (!map.has(id)) map.set(id, initialMovement());
  return map.get(id);
}

function addQtyValue(map, productId, qtyField, valueField, qty, value = 0) {
  const row = getMovement(map, productId);
  if (!row || !N(qty)) return;
  row[qtyField] += N(qty);
  if (valueField) row[valueField] += N(value);
}

function addCount(map, productId, field, amount = 1) {
  const row = getMovement(map, productId);
  if (!row) return;
  row[field] += N(amount);
}

function activeOrderAtCutoff(order) {
  const status = U(order?.status);
  const workflow = U(order?.workflowStatus);
  if (["DRAFT", "CANCELLED", "REJECTED", "DELETED", "VOID"].includes(status)) return false;
  if (FINAL_ORDER_STATUSES.has(workflow)) return false;
  return true;
}

function netOrderItemQty(item) {
  return Math.max(
    0,
    N(item?.qty) - N(item?.cancelledQty) - N(item?.returnedQty),
  );
}

function purchaseLine(item = {}) {
  const qty = N(item?.qty);
  let value = N(item?.netTaxable ?? item?.taxable);
  let rate = N(item?.netRate ?? item?.effectiveRate ?? item?.rate);
  if (!value && qty && rate) value = qty * rate;
  if (!rate && qty && value) rate = value / qty;
  return { qty: R(qty), rate: R(rate), value: R(value) };
}

function salesLine(item = {}) {
  const qty = N(item?.qty);
  let value = N(item?.taxable);
  let rate = N(item?.effectiveRate ?? item?.rate);
  if (!value && qty && rate) value = qty * rate;
  if (!rate && qty && value) rate = value / qty;
  return { qty: R(qty), rate: R(rate), value: R(value) };
}

function orderLine(item = {}, qtyOverride = null) {
  const fullQty = N(item?.qty);
  const qty = qtyOverride == null ? fullQty : N(qtyOverride);
  let rate = N(item?.rate);
  if (!rate && fullQty) rate = N(item?.taxable) / fullQty;
  return { qty: R(qty), rate: R(rate), value: R(qty * rate) };
}

export function closingStockFormula({
  fyOpening = 0,
  purchase = 0,
  stockInOrder = 0,
  outward = 0,
}) {
  // Closing Stock is a financial-year cumulative report. Opening is the FY opening,
  // Inward is every purchase in the FY up to the cutoff, Outward is every sale in
  // the FY up to the cutoff, and Stock In Order contains only quantities not yet invoiced.
  const openingStock = R(N(fyOpening));
  const physicalStock = R(openingStock + N(purchase) - N(outward));
  const closingStock = R(physicalStock - N(stockInOrder));
  return { openingStock, physicalStock, closingStock };
}

function weightedRate(value, qty, fallback = 0) {
  return R(N(qty) ? N(value) / N(qty) : N(fallback));
}

export async function buildClosingStockRows({
  tenantKey,
  financialYear,
  period,
  models,
  ProductModel = Product,
  WarehouseModel = GenericRecord,
}) {
  const fyStart = fyStartDate(financialYear);
  const periodEnd = endExclusive(period.to);

  const [products, purchases, sales, orders, warehouses] = await Promise.all([
    read(
      ProductModel,
      { tenantKey, status: { $nin: ["INACTIVE", "DELETED"] } },
      { name: 1 },
    ),
    read(
      models.PurchaseInvoice,
      {
        tenantKey,
        financialYear,
        date: { $gte: fyStart, $lt: periodEnd },
        status: { $nin: ["DELETED", "CANCELLED", "VOID", "DRAFT"] },
      },
      { date: 1 },
    ),
    read(
      models.SalesInvoice,
      {
        tenantKey,
        financialYear,
        date: { $gte: fyStart, $lt: periodEnd },
        status: { $nin: ["DELETED", "CANCELLED", "VOID", "DRAFT"] },
      },
      { date: 1 },
    ),
    read(
      models.SalesOrder,
      {
        tenantKey,
        financialYear,
        date: { $gte: fyStart, $lt: periodEnd },
      },
      { date: 1 },
    ),
    read(
      WarehouseModel,
      {
        tenantKey,
        app: "dms",
        resource: "warehouses",
        status: { $ne: "INACTIVE" },
      },
      { title: 1 },
    ),
  ]);

  // An order-linked tax invoice is Pending until actual delivery; never turn
  // it into Outward just because the Order Desk generated an invoice.
  const orderById = new Map(orders.map((x) => [T(x._id), x]));
  const orderByNumber = new Map(orders.map((x) => [T(x.orderNo), x]));
  const movement = new Map();

  // INWARD STOCK: every valid Purchase Invoice quantity in the selected FY,
  // product-wise, up to the report cutoff. Bill-level discount/charges are already
  // reflected in netTaxable where available.
  for (const invoice of purchases) {
    const ts = new Date(invoice.date || 0);
    if (Number.isNaN(ts.getTime()) || ts >= periodEnd) continue;
    for (const item of invoice.items || []) {
      const line = purchaseLine(item);
      if (!line.qty) continue;
      addQtyValue(
        movement,
        item.productId,
        "purchase",
        "purchaseValue",
        line.qty,
        line.value,
      );
    }
  }

  // OUTWARD STOCK: every valid Sales Invoice is a sale and therefore Outward for
  // this stock report, regardless of warehouse/delivery workflow status. Keep both
  // order-id and order-number links so Stock In Order can remove already-invoiced qty.
  const invoicedByOrderProduct = new Map();
  const addInvoicedLink = (orderKey, productId, qty) => {
    const ok = T(orderKey);
    const pid = T(productId);
    if (!ok || !pid) return;
    const key = `${ok}\u001f${pid}`;
    invoicedByOrderProduct.set(key, N(invoicedByOrderProduct.get(key)) + N(qty));
  };

  for (const invoice of sales) {
    const ts = new Date(invoice.date || 0);
    if (Number.isNaN(ts.getTime()) || ts >= periodEnd) continue;
    const isOrderInvoice = Boolean(T(invoice.sourceOrderId) || U(invoice.billingMode)==="ORDER");
    const linkedOrder = isOrderInvoice ? (orderById.get(T(invoice.sourceOrderId)) || orderByNumber.get(T(invoice.orderNo))) : null;
    // Delivery status is authoritative for order invoices. Direct invoices
    // retain their established immediate Outward accounting.
    if (isOrderInvoice && !linkedOrder) continue;
    if (linkedOrder && !["DELIVERED", "CLOSED", "HANDED_TO_TRANSPORTER"].includes(U(linkedOrder.workflowStatus))) continue;
    for (const item of invoice.items || []) {
      const line = salesLine(item);
      if (!line.qty) continue;
      addQtyValue(
        movement,
        item.productId,
        "outward",
        "outwardValue",
        line.qty,
        line.value,
      );
      addInvoicedLink(invoice.sourceOrderId, item.productId, line.qty);
      addInvoicedLink(invoice.orderNo, item.productId, line.qty);
    }
  }

  // STOCK IN ORDER: placed/active Sales Order quantity not yet invoiced. Once a
  // quantity becomes a Sales Invoice it is already in Outward above and must leave
  // this bucket immediately, preventing double deduction.
  for (const order of orders) {
    if (!activeOrderAtCutoff(order)) continue;
    const pendingProducts = new Set();
    for (const item of order.items || []) {
      const ordered = netOrderItemQty(item);
      if (!ordered) continue;
      const pid = T(item.productId);
      const invoicedById = N(invoicedByOrderProduct.get(`${T(order._id)}\u001f${pid}`));
      const invoicedByNo = N(invoicedByOrderProduct.get(`${T(order.orderNo)}\u001f${pid}`));
      const invoiced = Math.max(invoicedById, invoicedByNo);
      const pending = R(Math.max(0, ordered - invoiced));
      if (pending <= 0) continue;

      const line = orderLine(item, pending);
      addQtyValue(
        movement,
        item.productId,
        "stockInOrder",
        "stockInOrderValue",
        line.qty,
        line.value,
      );
      pendingProducts.add(pid);
    }
    for (const productId of pendingProducts) addCount(movement, productId, "openOrders", 1);
  }

  const warehouseMap = new Map(
    warehouses.map((warehouse) => [
      T(warehouse._id),
      warehouse.title || warehouse.warehouseName || warehouse.reference || T(warehouse._id),
    ]),
  );

  const rows = products.map((product) => {
    const id = T(product._id);
    const x = movement.get(id) || initialMovement();
    const fyOpening = productFyOpeningQty(product, financialYear);
    const fyOpeningRate = productFyOpeningRate(product, financialYear);
    const fyOpeningValue = R(fyOpening * fyOpeningRate);

    const { openingStock, physicalStock, closingStock } = closingStockFormula({
      fyOpening,
      ...x,
    });

    // Old-DMS style rate presentation:
    //  - Opening Rate carries weighted cost from FY opening + earlier purchases.
    //  - Inward Rate is weighted purchase rate in the selected period.
    //  - Stock In Order / Outward rates are their weighted sales/order basic rates.
    //  - Closing Rate is weighted stock cost; reservation/outward changes quantity,
    //    not the cost rate of the remaining units.
    const openingRate = R(fyOpeningRate);
    const openingTotal = R(fyOpeningValue);

    const inwardRate = weightedRate(x.purchaseValue, x.purchase, product.averagePurchasePrice);
    const inwardTotal = R(x.purchaseValue || N(x.purchase) * inwardRate);

    const stockInOrderRate = weightedRate(x.stockInOrderValue, x.stockInOrder, product.salePrice);
    const stockInOrderTotal = R(x.stockInOrderValue || N(x.stockInOrder) * stockInOrderRate);

    const outwardRate = weightedRate(x.outwardValue, x.outward, product.salePrice);
    const outwardTotal = R(x.outwardValue || N(x.outward) * outwardRate);

    const closingCostQty = openingStock + N(x.purchase);
    const closingCostValue = openingTotal + inwardTotal;
    const closingRate = weightedRate(
      closingCostValue,
      closingCostQty,
      inwardRate || openingRate || product.averagePurchasePrice || product.openingRate,
    );
    const closingTotal = R(closingStock * closingRate);

    const openingSource = "Product FY Opening";

    return {
      financialYear,
      productId: id,
      warehouse: warehouseMap.get(T(product.warehouseId)) || T(product.warehouseId) || "UNASSIGNED",
      product: product.name || product.sku || "",
      hsn: product.hsnCode || "",

      openingQty: R(openingStock),
      openingRate: R(openingRate),
      openingTotal,
      openingSource,

      inwardQty: R(x.purchase),
      inwardRate: R(inwardRate),
      inwardTotal,

      stockInOrderQty: R(x.stockInOrder),
      stockInOrderRate: R(stockInOrderRate),
      stockInOrderTotal,

      outwardQty: R(x.outward),
      outwardRate: R(outwardRate),
      outwardTotal,

      closingQty: R(closingStock),
      closingRate: R(closingRate),
      closingTotal,
    };
  });

  const sum = (key) => R(rows.reduce((total, row) => total + N(row[key]), 0));
  const summary = {
    products: rows.length,
    openingQty: sum("openingQty"),
    openingTotal: sum("openingTotal"),
    inwardQty: sum("inwardQty"),
    inwardTotal: sum("inwardTotal"),
    stockInOrderQty: sum("stockInOrderQty"),
    stockInOrderTotal: sum("stockInOrderTotal"),
    outwardQty: sum("outwardQty"),
    outwardTotal: sum("outwardTotal"),
    closingQty: sum("closingQty"),
    closingTotal: sum("closingTotal"),
  };

  return {
    rows,
    summary,
    reportStyle: "OLD_DMS_CLOSING_STOCK",
    source:
      "V2 Product FY opening + all valid FY Purchase Invoices + all valid FY Sales Invoices + uninvoiced Sales Orders",
    note:
      "Old-DMS Closing Stock layout rebuilt on V2 data. Financial-year cumulative formula: FY Opening Stock + all FY Purchase quantities - uninvoiced Stock In Order - all FY Sales Invoice quantities = Closing Stock. Every valid Purchase Invoice is Inward product-wise and every valid Sales Invoice is Outward product-wise, regardless of delivery workflow. Once an order quantity is invoiced it leaves Stock In Order, so the quantity is deducted once only. Closing Rate uses weighted stock cost from Opening + Inward; Stock In Order and Outward rates show their order/sales basic-rate averages.",
  };
}
