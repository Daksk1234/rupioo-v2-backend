export function buildInsights(payload = {}) {
  const k = payload.kpis || {};
  const insights = [];
  if ((k.redSalesPct || 0) > 10) insights.push({ severity: "high", title: "Low-margin sales rising", text: `${k.redSalesPct}% of sales are in the red margin band. Review pricing and approvals.` });
  if ((k.collectionAchievement || 100) < 80) insights.push({ severity: "medium", title: "Collections behind target", text: `Collection achievement is ${k.collectionAchievement || 0}%. Prioritise overdue recovery.` });
  if ((k.greenSalesPct || 0) >= 60) insights.push({ severity: "good", title: "Healthy profit mix", text: `${k.greenSalesPct}% of sales are in the green band.` });
  if ((k.deadStockValue || 0) > 0) insights.push({ severity: "medium", title: "Dead stock opportunity", text: `₹${Number(k.deadStockValue).toLocaleString("en-IN")} of dead stock should be considered in next target allocation.` });
  if (!insights.length) insights.push({ severity: "good", title: "Business operating normally", text: "No major exception crossed the current alert thresholds." });
  return insights;
}
