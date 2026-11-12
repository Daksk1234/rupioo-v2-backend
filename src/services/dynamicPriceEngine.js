/**
 * Inverse-safe price-list markup engine.
 * Basic/Minimum Sale Price -> fixed discounts -> variable discounts (smallest first)
 * -> grade discount -> GST -> MRP. In ADDITIVE_V2 mode discounts are
 * markups/reserves ADDED to basic when constructing MRP; they are removed
 * in reverse order (division, never a naive subtraction of percentage points)
 * when converting MRP back to basic.
 * Rates and intermediate values remain unrounded until the final display.
 */
const two = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const numeric = (n, label) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${label} must be a non-negative number`);
  return v;
};
const pct = (n, label) => {
  const v = numeric(n, label);
  if (v >= 100) throw new Error(`${label} must be below 100%`);
  return v;
};
export const orderedDiscounts = ({ gradePct = 0, rules = [], overrides = {}, pricingStyle = 'LEGACY' } = {}) => {
  const grade = { code: 'GRADE', name: 'Grade Discount', mode: 'FIXED', percent: pct(gradePct, 'Grade Discount') };
  const extras = (rules || []).filter(r => r.status !== 'INACTIVE').map(rule => {
    const override = overrides?.[rule.code] || {};
    const percent = pct(rule.mode === 'FIXED' ? (rule.defaultPct ?? 0) : (override.percent ?? rule.defaultPct ?? 0), `${rule.name || rule.code} discount`);
    return { code: String(rule.code), name: rule.name || rule.code, mode: rule.mode === 'VARIABLE' ? 'VARIABLE' : 'FIXED', percent, enabled: rule.mode !== 'VARIABLE' || override.enabled !== false };
  }).filter(x => x.enabled);
  const fixed = extras.filter(x => x.mode === 'FIXED').sort((a,b) => a.code.localeCompare(b.code));
  const variable = extras.filter(x => x.mode === 'VARIABLE').sort((a,b) => a.percent - b.percent || a.code.localeCompare(b.code));
  return pricingStyle === 'ADDITIVE_V2' ? [...fixed, ...variable, grade] : [grade, ...fixed, ...variable];
};
export function calculateDynamicPrice({ mode = 'SALE_TO_MRP', salePrice = 0, mrp = 0, gstRate = 0, gradePct = 0, rules = [], overrides = {}, pricingStyle = 'LEGACY' } = {}) {
  const gst = numeric(gstRate, 'GST');
  if (gst > 100) throw new Error('GST must be no greater than 100%');
  const additive = pricingStyle === 'ADDITIVE_V2';
  const steps = orderedDiscounts({gradePct,rules,overrides,pricingStyle});
  const factor = steps.reduce((a,step) => a * (additive ? (1+step.percent/100) : (1-step.percent/100)), 1);
  if (factor <= 0) throw new Error('Discounts leave no reversible sale value');
  const inputSale = numeric(salePrice, 'Minimum sale price');
  const inputMrp = numeric(mrp, 'MRP');
  const reverse = mode === 'MRP_TO_SALE';
  const exGstInput = inputMrp / (1 + gst / 100);
  const basic = reverse ? (additive ? exGstInput / factor : exGstInput * factor) : inputSale;
  const exGstMrp = additive ? basic * factor : basic / factor;
  let current = additive ? basic : exGstMrp;
  const trace = steps.map(step => {
    const before = current;
    current *= additive ? (1 + step.percent / 100) : (1 - step.percent / 100);
    return {...step, before:two(before), amount:two(Math.abs(current-before)), after:two(current)};
  });
  return {
    mode: reverse ? 'MRP_TO_SALE' : 'SALE_TO_MRP',
    pricingStyle: additive ? 'ADDITIVE_V2' : 'LEGACY',
    mrp: two(exGstMrp * (1 + gst / 100)),
    mrpExGst: two(exGstMrp),
    salePrice: two(basic),
    saleIncludingGst: two(basic * (1 + gst / 100)),
    gstRate: gst,
    discountFactor: factor,
    discountSteps: trace,
    totalDiscount: two(exGstMrp - basic),
    totalGst: two((additive ? exGstMrp : basic) * gst / 100),
  };
}
