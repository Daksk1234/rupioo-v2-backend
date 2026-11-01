// ONE canonical stock-availability source: the DMS Closing Stock report.
// Use its financial-year transactional quantities, not Product.currentStock -
// Product.reservedStock, which can disagree with the DMS FY report.
import { financialModels } from "./accountingService.js";
import { buildClosingStockRows } from "./closingStockService.js";

export async function dmsAvailableStockMap({ tenantKey, financialYear, throughDate = null }) {
  const todayIndia = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const end = throughDate || todayIndia;
  const report = await buildClosingStockRows({
    tenantKey, financialYear, period: { to: end },
    models: financialModels(tenantKey, financialYear),
  });
  return new Map(report.rows.map(row => [String(row.productId), Number(row.closingQty)]));
}
