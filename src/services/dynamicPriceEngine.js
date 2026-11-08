/** Reversible, deterministic per-unit price-list calculator. All rates are EX GST until the final step. */
const two = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const numeric = (n, label) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${label} must be a non-negative number`);
  return v;
};
const pct = (n, label) => {
  const v = numeric(n, label);
  if (v >= 100) throw new Error(`${label} must be below 100% for reversible MRP pricing`);
  return v;
};
export const orderedDiscounts = ({ gradePct = 0, rules = [], overrides = {} } = {}) => {
  const grade = [{ code: 'GRADE', name: 'Grade Discount', mode: 'FIXED', percent: pct(gradePct, 'Grade Discount') }];
  const extras = (rules || []).filter(r => r.status !== 'INACTIVE').map(rule => {
    const override = overrides?.[rule.code] || {};
    const percent = pct(rule.mode === "FIXED" ? (rule.defaultPct ?? 0) : (override.percent ?? rule.defaultPct ?? 0), `${rule.name || rule.code} discount`);
    return { code: String(rule.code), name: rule.name || rule.code, mode: rule.mode === 'VARIABLE' ? 'VARIABLE' : 'FIXED', percent, enabled: rule.mode !== 'VARIABLE' || override.enabled !== false };
  }).filter(x => x.enabled);
  const fixed = extras.filter(x => x.mode === 'FIXED').sort((a,b) => a.code.localeCompare(b.code));
  const variable = extras.filter(x => x.mode === 'VARIABLE').sort((a,b) => a.percent - b.percent || a.code.localeCompare(b.code));
  return [...grade, ...fixed, ...variable];
};
export function calculateDynamicPrice({ mode = 'SALE_TO_MRP', salePrice = 0, mrp = 0, gstRate = 0, gradePct = 0, rules = [], overrides = {} } = {}) {
  const gst = numeric(gstRate, 'GST');
  if (gst > 100) throw new Error('GST must be no greater than 100%');
  const steps = orderedDiscounts({gradePct,rules,overrides});
  const factor = steps.reduce((a,x) => a * (1 - x.percent/100), 1);
  if (factor <= 0) throw new Error('Discounts leave no reversible sale value');
  const saleTarget = numeric(salePrice, 'Sale price');
  const mrpTarget = numeric(mrp, 'MRP');
  const reverse = mode === 'MRP_TO_SALE';
  const baseExGst = reverse ? mrpTarget / (1 + gst/100) : saleTarget / factor;
  let current = baseExGst;
  const trace = steps.map(s => { const before = current; current *= (1-s.percent/100); return {...s, before:two(before), amount:two(before-current), after:two(current)}; });
  return {
    mode: reverse ? 'MRP_TO_SALE' : 'SALE_TO_MRP',
    mrp:two(baseExGst*(1+gst/100)),
    mrpExGst:two(baseExGst),
    salePrice:two(baseExGst*factor),
    saleIncludingGst:two(baseExGst*factor*(1+gst/100)),
    gstRate:gst, discountFactor:factor,
    discountSteps:trace,
    totalDiscount:two(baseExGst*(1-factor)),
    totalGst:two(baseExGst*factor*gst/100),
  };
}
