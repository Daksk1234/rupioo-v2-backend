/**
 * Validate Cashbook bulk-void selections before touching any financial-year
 * documents. This accepts only DIRECT receipt/payment document identifiers.
 * The endpoint must separately check the original voucher and its journal.
 */
export function normalizeCashbookBulkVoidSelection(items, max = 100) {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('Select at least one Cashbook entry'), { statusCode: 400 });
  }
  if (items.length > max) {
    throw Object.assign(new Error(`Select no more than ${max} entries at once`), { statusCode: 400 });
  }
  const unique = new Set();
  return items.map((item, index) => {
    const kind = String(item?.kind || '').trim().toLowerCase();
    const id = String(item?.id || '').trim();
    if (!['receipts', 'payments'].includes(kind) || !/^[0-9a-f]{24}$/i.test(id)) {
      throw Object.assign(new Error(`Invalid Cashbook voucher at selection ${index + 1}`), { statusCode: 400 });
    }
    const key = `${kind}:${id.toLowerCase()}`;
    if (unique.has(key)) {
      throw Object.assign(new Error('Duplicate voucher selected; refresh the page'), { statusCode: 400 });
    }
    unique.add(key);
    return { kind, id };
  });
}
