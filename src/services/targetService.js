export function generateNextMonthTarget({ annualTarget = 0, achieved = 0, remainingMonths = 1, seasonalityFactor = 1 }) {
  const remaining = Math.max(0, Number(annualTarget) - Number(achieved));
  const base = remainingMonths > 0 ? remaining / remainingMonths : 0;
  const suggested = base * Number(seasonalityFactor || 1);
  return { annualTarget, achieved, remaining, remainingMonths, baseMonthlyRunRate: base, suggested };
}

export function weightedAchievement(values = {}, weights = {}) {
  const defaults = { sales: 30, grossProfit: 25, collection: 20, productMix: 10, marginQuality: 5, newCustomers: 5, leadsVisits: 5 };
  const w = { ...defaults, ...weights };
  const sum = Object.values(w).reduce((a,b)=>a+Number(b||0),0) || 1;
  const score = Object.entries(w).reduce((acc,[key,weight]) => acc + Math.min(150, Number(values[key] || 0)) * Number(weight || 0), 0) / sum;
  return Math.round(score * 10) / 10;
}
