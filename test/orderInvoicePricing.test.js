import test from 'node:test';
import assert from 'node:assert/strict';
import { orderItemInvoicePrice } from '../src/services/orderInvoicePricing.js';
const net = (row, qty = 1) => Number((row.basicRate * (1 - row.discountPct / 100) * qty).toFixed(2));

test('Customer app legacy order: 15% is Grade, Disc% is zero and existing net basic remains 1140.30', () => {
  const price = orderItemInvoicePrice({ qty:1, listRate:1341.53, rate:1140.30, discountPct:15, taxable:1140.30 });
  assert.equal(price.gradeDiscountPct, 15);
  assert.equal(price.discountPct, 0);
  assert.equal(price.basicRate, 1140.30);
  assert.equal(net(price), 1140.30);
  assert.ok(net(price) > 1072.92);
});

test('Salesperson app legacy order: grade is mapped even if listRate is missing', () => {
  const price = orderItemInvoicePrice({ qty:1, rate:1140.30, discountPct:15, taxable:1140.30 });
  assert.equal(price.gradeDiscountPct, 15);
  assert.equal(price.discountPct, 0);
  assert.equal(net(price),1140.30);
});

test('Legacy DMS order: saved price after grade is preserved for two units', () => {
  const price = orderItemInvoicePrice({ qty:2, rate:1140.30, discountPct:15, taxable:1938.51 });
  assert.equal(price.gradeDiscountPct, 15);
  assert.equal(price.discountPct, 0);
  assert.equal(net(price,2),1938.51);
});

test('New DMS order: grade and extra item discount stay in different columns', () => {
  const price = orderItemInvoicePrice({qty:1,listRate:1500,rate:1275,gradeDiscountPct:15,discountPct:5,taxable:1211.25});
  assert.equal(price.gradeDiscountPct, 15);
  assert.equal(price.discountPct, 5);
  assert.equal(price.basicRate, 1275);
  assert.equal(net(price),1211.25);
});

test('Explicit zero grade preserves a genuine additional Disc%', () => {
  const price = orderItemInvoicePrice({qty:2,listRate:100,rate:100,gradeDiscountPct:0,discountPct:10,taxable:180});
  assert.equal(price.gradeDiscountPct,0);
  assert.equal(price.discountPct,10);
  assert.equal(net(price,2),180);
});

test('No discount order stays unchanged', () => {
  const price = orderItemInvoicePrice({qty:2,rate:1140.3,discountPct:0,taxable:2280.6});
  assert.equal(price.gradeDiscountPct,0);
  assert.equal(price.discountPct,0);
  assert.equal(price.basicRate,1140.3);
});

test('Order price for quantity 10 retains order taxable and discount separation', () => {
  const price = orderItemInvoicePrice({qty:10,listRate:1341.53,rate:1140.30,discountPct:15,taxable:11403});
  assert.equal(price.gradeDiscountPct,15);
  assert.equal(price.discountPct,0);
  assert.equal(net(price,10),11403);
});
