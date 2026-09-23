import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { buildMasterSalesInvoicePdf } from '../src/services/masterInvoicePdfService.js';

const invoice = { invoiceNo: 'TEST-001', date: '2026-09-19', customerNameSnapshot: 'Test Buyer', grandTotal: 118, items: [] };
function assertPdf(buffer) {
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.match(buffer.subarray(-32).toString(), /%%EOF/);
}
for (const [name, bank] of [['null bank', null], ['omitted bank', undefined], ['bank without UPI', { bankName: 'Test Bank', accountNumber: '12345', ifsc: 'TEST0000001' }]]) {
  test(`invoice PDF renders with ${name} and does not create a payment QR`, async (t) => {
    const qr = t.mock.method(QRCode, 'toBuffer');
    assertPdf(await buildMasterSalesInvoicePdf({ invoice, company: { companyName: 'Test Company' }, bank }));
    assert.equal(qr.mock.callCount(), 0);
  });
}
test('missing optional company and customer records retain invoice snapshot and render', async () => {
  assertPdf(await buildMasterSalesInvoicePdf({ invoice, company: null, customer: null, bank: null }));
});
test('configured UPI still generates the correct payment QR and valid PDF', async (t) => {
  const qr = t.mock.method(QRCode, 'toBuffer');
  assertPdf(await buildMasterSalesInvoicePdf({ invoice, company: { companyName: 'Test & Company' }, bank: { upiId: 'test@bank', bankName: 'Test Bank' } }));
  assert.equal(qr.mock.callCount(), 1);
  const url = new URL(qr.mock.calls[0].arguments[0]);
  assert.equal(url.protocol, 'upi:');
  assert.equal(url.searchParams.get('pa'), 'test@bank');
  assert.equal(url.searchParams.get('pn'), 'Test & Company');
  assert.equal(url.searchParams.get('am'), '118.00');
  assert.equal(url.searchParams.get('tn'), 'Invoice TEST-001');
});
