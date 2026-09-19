import { CustomerGrade, Product } from "../models/index.js";
import { financialModels } from "./accountingService.js";

export const round2 = (value) => Number((Number(value) || 0).toFixed(2));

export function purchaseRateOf(product = {}) {
  const avg = Number(product.averagePurchasePrice || 0);
  const last = Number(product.lastPurchasePrice || 0);
  const opening = Number(product.openingRate || 0);
  if (avg > 0) return avg;
  if (last > 0) return last;
  return opening > 0 ? opening : 0;
}

export function costBaseOf(product = {}) {
  return Math.max(purchaseRateOf(product), Number(product.landedCost || 0), 0);
}

export function actualProfitPct({ cost = 0, saleRate = 0 } = {}) {
  const c = Number(cost || 0);
  const s = Number(saleRate || 0);
  return c > 0 ? round2(((s - c) / c) * 100) : 0;
}

export function storedProfitPct(product = {}) {
  const cost = costBaseOf(product);
  const stored = Number(product.profitPercentage);
  if (Number.isFinite(stored) && stored !== 0) return stored;
  const fromSale = actualProfitPct({ cost, saleRate: product.salePrice });
  if (fromSale !== 0) return fromSale;
  return Number(product.minimumProfitPct || 0);
}

export function priceFromOldDmsLogic(product = {}, maxDiscount = 0, options = {}) {
  const cost = Number(options.costOverride || 0) > 0 ? Number(options.costOverride) : costBaseOf(product);
  let profitPct = Number.isFinite(Number(options.profitOverride))
    ? Number(options.profitOverride)
    : storedProfitPct(product);
  let saleRate = Number(options.saleRateOverride || product.salePrice || 0);

  if (!(saleRate > 0)) {
    const minimumProfit = Math.max(3, Number(product.minimumProfitPct || 3));
    profitPct = Math.max(minimumProfit, Number(profitPct || 0));
    saleRate = round2(cost * (1 + profitPct / 100));
  }

  const gradeDiscountPct = Number(maxDiscount || 0);
  const gradeLoading = round2((saleRate * gradeDiscountPct) / 100);
  const taxableMrpBase = round2(saleRate + gradeLoading);
  const gstRate = Number(product.gstRate || 0);
  const tax = round2((taxableMrpBase * gstRate) / 100);
  const mrp = round2(taxableMrpBase + tax);

  return {
    purchaseRate: purchaseRateOf(product),
    costBase: cost,
    profitPercentage: round2(profitPct),
    saleRate: round2(saleRate),
    maxGradeDiscountPct: gradeDiscountPct,
    gradeLoading,
    gstRate,
    tax,
    mrp,
    lossStatus: saleRate < cost,
    belowMinimum: cost > 0 && saleRate < round2(cost * (1 + Math.max(3, Number(product.minimumProfitPct || 3)) / 100)),
  };
}

/**
 * Simple arithmetic mean of historical invoice line rates.
 * Each posted invoice line counts as one observation irrespective of quantity,
 * matching the requested old-DMS average-rate behaviour.
 */
export async function historicalAverageRates({ tenantKey, financialYear, productIds = [] }) {
  const { SalesInvoice, PurchaseInvoice } = financialModels(tenantKey, financialYear);
  const idFilter = Array.isArray(productIds) && productIds.length
    ? { "items.productId": { $in: productIds.map(String) } }
    : {};

  const [saleRows, purchaseRows] = await Promise.all([
    SalesInvoice.aggregate([
      { $match: { tenantKey, financialYear, status: "POSTED", ...idFilter } },
      { $unwind: "$items" },
      ...(productIds.length ? [{ $match: { "items.productId": { $in: productIds.map(String) } } }] : []),
      { $match: { "items.productId": { $nin: [null, ""] }, "items.effectiveRate": { $gt: 0 } } },
      {
        $group: {
          _id: "$items.productId",
          averageRate: { $avg: "$items.effectiveRate" },
          observations: { $sum: 1 },
        },
      },
    ]),
    PurchaseInvoice.aggregate([
      { $match: { tenantKey, financialYear, status: "POSTED", ...idFilter } },
      { $unwind: "$items" },
      ...(productIds.length ? [{ $match: { "items.productId": { $in: productIds.map(String) } } }] : []),
      { $match: { "items.productId": { $nin: [null, ""] }, "items.effectiveRate": { $gt: 0 } } },
      {
        $group: {
          _id: "$items.productId",
          averageRate: { $avg: "$items.effectiveRate" },
          observations: { $sum: 1 },
        },
      },
    ]),
  ]);

  const sales = new Map(
    saleRows.map((row) => [
      String(row._id),
      { averageRate: round2(row.averageRate), observations: Number(row.observations || 0) },
    ]),
  );
  const purchases = new Map(
    purchaseRows.map((row) => [
      String(row._id),
      { averageRate: round2(row.averageRate), observations: Number(row.observations || 0) },
    ]),
  );

  return { sales, purchases };
}

export async function getMaxActiveGradeDiscount(tenantKey) {
  const row = await CustomerGrade.findOne({ tenantKey, status: "ACTIVE" })
    .sort({ discountPct: -1 })
    .select("discountPct")
    .lean();
  return Number(row?.discountPct || 0);
}

export async function recalculateAllProductsForGrades(tenantKey) {
  const maxDiscount = await getMaxActiveGradeDiscount(tenantKey);
  const products = await Product.find({ tenantKey, status: "ACTIVE" }).lean();
  if (!products.length) return { updated: 0, maxDiscount };

  const ops = products.map((product) => {
    const cost = costBaseOf(product);
    const minimumProfit = Math.max(3, Number(product.minimumProfitPct || 3));
    const stored = Number(product.profitPercentage || 0);
    const profitPercentage = Number.isFinite(stored) && stored !== 0 ? stored : minimumProfit;
    const saleRate = Number(product.salePrice || 0) > 0
      ? Number(product.salePrice)
      : round2(cost * (1 + Math.max(minimumProfit, profitPercentage) / 100));
    const priced = priceFromOldDmsLogic(
      { ...product, salePrice: saleRate, profitPercentage },
      maxDiscount,
    );
    return {
      updateOne: {
        filter: { _id: product._id, tenantKey },
        update: {
          $set: {
            profitPercentage: priced.profitPercentage,
            salePrice: priced.saleRate,
            mrp: priced.mrp,
            maxGradeDiscountPct: priced.maxGradeDiscountPct,
            profitColorCode: profitColor(priced.profitPercentage),
          },
        },
      },
    };
  });

  const result = await Product.bulkWrite(ops, { ordered: false });
  return { updated: result.modifiedCount || 0, maxDiscount };
}

export function profitColor(profitPct) {
  const p = Number(profitPct || 0);
  if (p >= 15) return "GREEN";
  if (p >= 10) return "ORANGE";
  if (p >= 5) return "BLUE";
  return "RED";
}
