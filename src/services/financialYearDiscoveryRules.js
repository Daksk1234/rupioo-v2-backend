/** Pure, side-effect-free rules for identifying a company's financial years. */
const FY=/^(\d{4})-(\d{2})$/;
export const validFY=value=>{
  const match=FY.exec(String(value||''));
  return !!match && Number(match[2])===(Number(match[1])+1)%100;
};
export const normalizeYears=years=>[...new Set((years||[]).filter(validFY))].sort();
export const fiscalYearCandidates=({configured=[],discovered=[],opening=''}={})=>
  normalizeYears([...configured,...discovered,opening]);
export const firstDataYear=({discovered=[],configured=[]}={})=>
  normalizeYears(discovered)[0]||normalizeYears(configured)[0]||'';
