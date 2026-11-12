import { createHash } from 'node:crypto';

// File AND original row identify an upload, never date/amount/party. Both
// upload endpoints share this namespace, so switching screens cannot repost it.
export function cashbookImportVoucherNo(tenantKey, importId, rowNo, kind) {
  if (!/^[a-f0-9]{64}$/.test(importId) || !Number.isSafeInteger(rowNo) || rowNo < 2)
    throw new Error('Invalid cash upload identity');
  const serial = createHash('sha256').update(`${tenantKey}:${importId}:${rowNo}`)
    .digest('hex').slice(0,20).toUpperCase();
  return `CB-${kind === 'PAYMENT' ? 'P' : 'R'}-${serial}`;
}
