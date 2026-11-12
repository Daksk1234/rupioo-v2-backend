import { calculateDynamicPrice } from "./dynamicPriceEngine.js";
import { CustomerGrade, PriceDiscountRule, Product } from "../models/index.js";
import { financialModels } from "./accountingService.js";

export const round2 = (value) => Number((Number(value) || 0).toFixed(2));

export function mrpBasicExcludingGst(mrp = 0, gstRate = 0) {
  const gross = Math.max(0, Number(mrp || 0));
  const gst = Math.max(0, Number(gstRate || 0));
  if (!(gross > 0)) return 0;
  return round2(gross / (1 + gst / 100));
}

export function gradeBasicFromMrp(mrp = 0, gstRate = 0, gradeDiscountPct = 0) {
  const gross = Math.max(0, Number(mrp || 0));
  const gst = Math.max(0, Number(gstRate || 0));
  const discount = Math.min(100, Math.max(0, Number(gradeDiscountPct || 0)));
  if (!(gross > 0)) return 0;
  // Calculate from the unrounded ex-GST MRP and round only the final customer
  // basic rate. This keeps the grade percentage mathematically exact.
  const exGstMrp = gross / (1 + gst / 100);
  return round2(exGstMrp * (1 - discount / 100));
}

export function gradeSaleIncludingGstFromMrp(mrp = 0, gradeDiscountPct = 0) {
  const gross = Math.max(0, Number(mrp || 0));
  const discount = Math.min(100, Math.max(0, Number(gradeDiscountPct || 0)));
  return round2(gross * (1 - discount / 100));
}

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

  const gradeDiscountPct = Math.min(100, Math.max(0, Number(maxDiscount || 0)));
  // The highest grade must be able to reverse the MRP loading exactly.
  // If customerBasic = MRP(ex-GST) × (1 - grade%), then MRP(ex-GST) must be
  // targetSaleRate / (1 - highestGrade%).  The previous +grade% loading did
  // not reverse correctly (for example +15% followed by -15% leaves 97.75%).
  const gradeFactor = Math.max(0.000001, 1 - gradeDiscountPct / 100);
  const taxableMrpBase = round2(saleRate / gradeFactor);
  const gradeLoading = round2(taxableMrpBase - saleRate);
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
  const [products,grades,rules] = await Promise.all([
    Product.find({ tenantKey, status: "ACTIVE" }).lean(),
    CustomerGrade.find({tenantKey,status:"ACTIVE"}).lean(),
    PriceDiscountRule.find({tenantKey,status:"ACTIVE"}).lean(),
  ]);
  if (!products.length) return { updated: 0, maxDiscount };

  const ops = products.map((product) => {
    const config=product.priceListSettings;
    if(config?.enabled){
      const grade=grades.find(g=>String(g.code)===String(config.targetGradeCode))||grades.reduce((best,g)=>!best||g.discountPct>best.discountPct?g:best,null);
      const calculated=calculateDynamicPrice({mode:config.mode,salePrice:config.salePrice,mrp:config.mrp,gstRate:product.gstRate,gradePct:grade?.discountPct||0,rules,overrides:config.discountOverrides||{},pricingStyle:config.pricingStyle||"LEGACY"});
      return {updateOne:{filter:{_id:product._id,tenantKey},update:{$set:{mrp:calculated.mrp,salePrice:calculated.salePrice,"priceListSettings.mrp":calculated.mrp,"priceListSettings.salePrice":calculated.salePrice,maxGradeDiscountPct:maxDiscount}}}};
    }
    const cost = costBaseOf(product);
    const minimumProfit = Math.max(3, Number(product.minimumProfitPct || 3));
    const stored = Number(product.profitPercentage || 0);
    const profitPercentage = Number.isFinite(stored) && stored !== 0 ? stored : minimumProfit;
    // Product.salePrice remains the BASE sale rate. Recalculation must not
    // overwrite it with the profit-loaded rate, otherwise every grade change
    // compounds profit again the next time the price list is calculated.
    const baseSaleRate = Number(product.salePrice || 0) > 0
      ? Number(product.salePrice)
      : Number(cost || 0);
    const saleRateIncludingProfit = baseSaleRate > 0
      ? round2(baseSaleRate * (1 + profitPercentage / 100))
      : 0;
    const priced = priceFromOldDmsLogic(
      { ...product, salePrice: saleRateIncludingProfit, profitPercentage },
      maxDiscount,
      {
        costOverride: cost,
        saleRateOverride: saleRateIncludingProfit,
        profitOverride: profitPercentage,
      },
    );
    return {
      updateOne: {
        filter: { _id: product._id, tenantKey },
        update: {
          $set: {
            profitPercentage: priced.profitPercentage,
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
