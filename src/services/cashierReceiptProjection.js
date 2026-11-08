/**
 * Cashier custody documents deliberately preserve historical handover snapshots.
 * Those snapshots are NOT proof that the source Receipt still exists: a manual
 * database deletion (or an application void) must not resurrect a receipt in
 * Pending Handover, Cashier Cashbook or a cashier close amount.
 *
 * This is a read-only projection. It never silently deletes a custody record or
 * reverses an already-posted accounting journal; those need audited correction.
 */
const str = v => String(v ?? '').trim();
const upper = v => str(v).toUpperCase();
const money = v => Math.round((Number(v) || 0) * 100) / 100;
const cheque = r => ['CHEQUE', 'CHECK', 'CHQ'].includes(upper(r?.receiptType)) || ['CHEQUE', 'CHECK', 'CHQ'].includes(upper(r?.mode));

export function isLiveCashierReceipt(receipt) {
  return !!receipt && upper(receipt.status) === 'POSTED' && upper(receipt.customerOtpStatus) === 'VERIFIED' &&
    upper(receipt.collectionSource) === 'SALESPERSON_APP';
}

export function cashierReceiptMatchesRow(row, receipt) {
  if (!isLiveCashierReceipt(receipt) || !row) return false;
  if (str(row.receiptId) && str(row.receiptId) !== str(receipt._id)) return false;
  if (!str(row.receiptNo) || str(row.receiptNo) !== str(receipt.receiptNo)) return false;
  if (str(row.customerGlobalId) && str(receipt.customerGlobalId) !== str(row.customerGlobalId)) return false;
  if (Math.abs(Number(row.amount) - Number(receipt.amount)) > 0.009 || !Number.isFinite(Number(row.amount))) return false;
  const expectedChannel = upper(row.mode);
  if (expectedChannel !== (cheque(receipt) ? 'CHEQUE' : upper(receipt.mode) === 'CASH' ? 'CASH' : 'ONLINE')) return false;
  return expectedChannel === 'CASH' || expectedChannel === 'CHEQUE';
}

/** Receipt IDs must be authoritative. Older legacy rows with no receiptId can
 * be resolved by receiptNo only when the party, amount and channel also match. */
export function indexCashierReceipts(receipts = []) {
  return {
    byId: new Map(receipts.map(r => [str(r._id), r])),
    byNo: new Map(receipts.filter(isLiveCashierReceipt).map(r => [str(r.receiptNo), r])),
  };
}
export function projectCashierHandover(movement, receipts) {
  const {byId, byNo} = Array.isArray(receipts) ? indexCashierReceipts(receipts) : receipts;
  const original = Array.isArray(movement.receiptBreakdown) ? movement.receiptBreakdown : [];
  const included = [], missing = [];
  for (const row of original) {
    const receipt = str(row.receiptId) ? byId.get(str(row.receiptId)) : byNo.get(str(row.receiptNo));
    if (!cashierReceiptMatchesRow(row, receipt)) {
      missing.push({receiptId: str(row.receiptId), receiptNo: str(row.receiptNo)});
      continue;
    }
    included.push({...row, receiptId: str(receipt._id)});
  }
  const cashAmount = money(included.filter(r => upper(r.mode) === 'CASH').reduce((s,r) => s + Number(r.amount), 0));
  const chequeAmount = money(included.filter(r => upper(r.mode) === 'CHEQUE').reduce((s,r) => s + Number(r.amount), 0));
  return {
    rows: included,
    missingReceiptCount: missing.length,
    // Do not expose deleted customer's identifying data in active screen rows.
    missingReceiptIds: missing.map(r => r.receiptId).filter(Boolean),
    cashAmount,
    chequeAmount,
    amount: money(cashAmount + chequeAmount),
  };
}
