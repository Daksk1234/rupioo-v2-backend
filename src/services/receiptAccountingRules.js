/** One source of truth for whether a receipt is reflected in customer accounts.
 * Salesperson/collector receipt status POSTED denotes customer OTP verification,
 * NOT necessarily a posted financial journal. Legacy/DMS-direct POSTED receipts
 * retain their existing meaning. */
export function isReceiptLedgerPosted(receipt) {
  if (!receipt || String(receipt.status || '').toUpperCase() !== 'POSTED') return false;
  return String(receipt.collectionSource || '').toUpperCase() !== 'SALESPERSON_APP' || Boolean(receipt.ledgerPostedAt);
}
export function isValidReceiptBankDate(value, financialYear) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0,10) !== date) return false;
  const month = d.getUTCMonth() + 1, year = d.getUTCFullYear();
  const start = month < 4 ? year - 1 : year;
  return financialYear === `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
