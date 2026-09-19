export function effectivePrice({ rate = 0, discountPct = 0, freeQty = 0, qty = 1 }) {
  const paidQty = Math.max(0, Number(qty));
  const totalQty = Math.max(1, paidQty + Math.max(0, Number(freeQty)));
  const discounted = Number(rate) * (1 - Number(discountPct || 0) / 100);
  return discounted * paidQty / totalQty;
}

export function profitMetrics({ landedCost = 0, effectiveSellingPrice = 0, bands = null, minimumProfitPct = 3 }) {
  const cost = Number(landedCost || 0);
  const sale = Number(effectiveSellingPrice || 0);
  const profit = sale - cost;
  const profitPct = cost > 0 ? (profit / cost) * 100 : 0;
  const minimumPrice = cost * (1 + Number(minimumProfitPct || 0) / 100);
  const ranges = bands || [
    { min: minimumProfitPct, max: 5, color: "RED", label: "Low profit" },
    { min: 5, max: 10, color: "BLUE", label: "Normal profit" },
    { min: 10, max: Infinity, color: "GREEN", label: "Good profit" }
  ];
  if (profitPct < minimumProfitPct) return { profit, profitPct, minimumPrice, allowed: false, color: "BLOCKED", label: "Below minimum" };
  const band = ranges.find((r) => profitPct >= r.min && profitPct < r.max) || ranges[ranges.length - 1];
  return { profit, profitPct, minimumPrice, allowed: true, color: band?.color || "GREEN", label: band?.label || "Good profit" };
}
