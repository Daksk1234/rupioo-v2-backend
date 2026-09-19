export function customerHealth(input = {}) {
  const weights = input.weights || { gst: 20, payment: 25, receipts: 15, bounce: 15, overdue: 15, relationship: 10 };
  const bounded = (n) => Math.max(0, Math.min(100, Number(n || 0)));
  const score = (
    bounded(input.gstScore) * weights.gst +
    bounded(input.paymentScore) * weights.payment +
    bounded(input.receiptScore) * weights.receipts +
    bounded(input.bounceScore) * weights.bounce +
    bounded(input.overdueScore) * weights.overdue +
    bounded(input.relationshipScore) * weights.relationship
  ) / Object.values(weights).reduce((a,b)=>a+b,0);
  const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "E";
  const color = score >= 85 ? "GREEN" : score >= 70 ? "BLUE" : score >= 55 ? "YELLOW" : score >= 40 ? "ORANGE" : "RED";
  return { score: Math.round(score * 10) / 10, grade, color };
}

export function companyHealth(metrics = {}) {
  const parts = {
    profitability: Number(metrics.profitability || 80),
    salesGrowth: Number(metrics.salesGrowth || 76),
    collections: Number(metrics.collections || 72),
    inventory: Number(metrics.inventory || 78),
    cashFlow: Number(metrics.cashFlow || 74),
    customerQuality: Number(metrics.customerQuality || 81),
    targetPerformance: Number(metrics.targetPerformance || 79),
    gstCompliance: Number(metrics.gstCompliance || 90)
  };
  const score = Object.values(parts).reduce((a,b)=>a+b,0) / Object.keys(parts).length;
  return { score: Math.round(score), parts };
}
