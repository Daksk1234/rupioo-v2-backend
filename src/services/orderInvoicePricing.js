/**
 * Invoice pricing for an already-placed order.
 *
 * Legacy Customer/Salesperson (and legacy DMS) order rows kept the CUSTOMER
 * GRADE percentage in `discountPct`. That field is NOT the invoice's optional
 * Disc %, and it must not be applied a second time on invoice creation.
 *
 * New orders keep `gradeDiscountPct` separately and reserve `discountPct`
 * for an *additional* item discount. We preserve the order's saved taxable
 * amount instead of repricing old orders from today's Customer Grade master.
 *
 * `basicRate` in DMS invoice rows means the net-of-grade, ex-GST Basic price;
 * the UI displays the already-applied grade % as a separate read-only field.
 */
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const percent = (value) => Math.min(100, Math.max(0, number(value)));
const round2 = (value) => Number(number(value).toFixed(2));
const round6 = (value) => Number(number(value).toFixed(6));

export function orderItemInvoicePrice(item = {}) {
  // Mongoose doesn't give this optional field a default, allowing legacy
  // records to be differentiated from newly saved explicit grade/Disc rows.
  const hasGradeSnapshot = item.gradeDiscountPct !== undefined && item.gradeDiscountPct !== null;
  const gradeDiscountPct = percent(hasGradeSnapshot ? item.gradeDiscountPct : item.discountPct);
  const discountPct = hasGradeSnapshot ? percent(item.discountPct) : 0;
  const qty = number(item.qty);
  const savedTaxable = item.taxable == null ? null : Number(item.taxable);
  const savedNetUnit = savedTaxable !== null && Number.isFinite(savedTaxable) && qty > 0
    ? savedTaxable / qty : null;
  const listRate = number(item.listRate);
  const storedRate = number(item.rate);
  const gradeFactor = 1 - gradeDiscountPct / 100;
  const extraFactor = 1 - discountPct / 100;
  // The order's saved taxable is authoritative, including manually entered
  // order basic prices and historical rounding. Undo *only* genuine extra
  // discount; the grade has already been applied to the invoice basic price.
  let basicRate;
  if (savedNetUnit !== null && extraFactor > 0) {
    basicRate = savedNetUnit / extraFactor;
  } else if (listRate > 0) {
    basicRate = round2(listRate * gradeFactor);
  } else if (hasGradeSnapshot) {
    // New explicit DMS rows save `rate` after grade.
    basicRate = storedRate;
  } else {
    // Legacy DMS rows have undiscounted rate; legacy apps with listRate are
    // handled in the branch above.
    basicRate = round2(storedRate * gradeFactor);
  }
  // Use sufficient precision to keep a saved taxable such as 1938.51 for
  // two units rather than converting a 969.255 unit to 969.25 too early.
  basicRate = round6(basicRate);
  const gradeBaseRate = listRate > 0 ? listRate : gradeFactor > 0 ? round6(basicRate / gradeFactor) : 0;
  return { basicRate, gradeDiscountPct, discountPct, gradeBaseRate };
}
