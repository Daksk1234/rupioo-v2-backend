import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClosingStockRows, closingStockFormula } from '../src/services/closingStockService.js';

function fakeModel(rows = []) {
  return {
    find() {
      return {
        sort() {
          return {
            limit() {
              return { lean: async () => structuredClone(rows) };
            },
          };
        },
      };
    },
  };
}

const product = {
  _id: 'P1', tenantKey: 'T1', sku: 'SKU1', name: 'Product 1', category: 'CAT', hsnCode: '4819',
  unit: 'PCS', openingStock: 100, openingRate: 8, currentStock: 90, reservedStock: 0,
  averagePurchasePrice: 10, landedCost: 10, salePrice: 15, warehouseId: 'W1', status: 'ACTIVE',
};
const purchase = {
  date: new Date('2026-10-03T00:00:00.000Z'), status: 'POSTED',
  items: [{ productId: 'P1', qty: 20, netRate: 10, netTaxable: 200 }],
};
const baseOrder = {
  _id: 'O1', orderNo: 'SO-1', date: new Date('2026-10-04T00:00:00.000Z'), status: 'PROCESSING', workflowStatus: 'READY_FOR_DISPATCH',
  items: [{ productId: 'P1', qty: 10, rate: 15, taxable: 150, cancelledQty: 0, returnedQty: 0 }],
};
const period = { from: '2026-10-01', to: '2026-10-31' };

async function run({ sales = [], orders = [baseOrder], purchases = [purchase] } = {}) {
  return buildClosingStockRows({
    tenantKey: 'T1', financialYear: '2026-27', period,
    models: {
      PurchaseInvoice: fakeModel(purchases), SalesInvoice: fakeModel(sales), SalesOrder: fakeModel(orders),
    },
    ProductModel: fakeModel([product]), WarehouseModel: fakeModel([{ _id: 'W1', title: 'MAIN WAREHOUSE' }]),
  });
}

test('closing stock formula follows opening + purchase - stock in order - outward', () => {
  assert.deepEqual(closingStockFormula({ fyOpening: 100, purchase: 20, stockInOrder: 10, outward: 5 }), {
    openingStock: 100, physicalStock: 115, closingStock: 105,
  });
});

test('old-DMS style row contains all required stock sections', async () => {
  const { rows } = await run();
  const row = rows[0];
  for (const key of [
    'financialYear','warehouse','product','hsn',
    'openingQty','openingRate','openingTotal','openingSource',
    'inwardQty','inwardRate','inwardTotal',
    'stockInOrderQty','stockInOrderRate','stockInOrderTotal',
    'outwardQty','outwardRate','outwardTotal',
    'closingQty','closingRate','closingTotal',
  ]) assert.ok(Object.hasOwn(row, key), `missing ${key}`);
  assert.equal(row.hsn, '4819');
  assert.equal(row.warehouse, 'MAIN WAREHOUSE');
});

test('placed order remains Stock In Order until it is invoiced', async () => {
  const result = await run();
  const row = result.rows[0];
  assert.equal(row.inwardQty, 20);
  assert.equal(row.inwardRate, 10);
  assert.equal(row.inwardTotal, 200);
  assert.equal(row.stockInOrderQty, 10);
  assert.equal(row.stockInOrderRate, 15);
  assert.equal(row.stockInOrderTotal, 150);
  assert.equal(row.outwardQty, 0);
  assert.equal(row.closingQty, 110);
});

test('creating a sales invoice moves order quantity from Stock In Order to Outward immediately', async () => {
  const result = await run({ sales: [{
    sourceOrderId: 'O1', date: new Date('2026-10-05T00:00:00.000Z'), status: 'POSTED', workflowStatus: 'READY_FOR_DISPATCH',
    items: [{ productId: 'P1', qty: 10, effectiveRate: 15, taxable: 150 }],
  }] });
  const row = result.rows[0];
  assert.equal(row.stockInOrderQty, 0);
  assert.equal(row.outwardQty, 10);
  assert.equal(row.outwardTotal, 150);
  assert.equal(row.closingQty, 110);
});

test('delivery status does not change Outward because the sale was already counted at invoice creation', async () => {
  const result = await run({ sales: [{
    sourceOrderId: 'O1', date: new Date('2026-10-05T00:00:00.000Z'), status: 'POSTED', workflowStatus: 'DELIVERED',
    delivery: { deliveredAt: new Date('2026-10-10T00:00:00.000Z') },
    items: [{ productId: 'P1', qty: 10, effectiveRate: 15, taxable: 150 }],
  }] });
  const row = result.rows[0];
  assert.equal(row.stockInOrderQty, 0);
  assert.equal(row.outwardQty, 10);
  assert.equal(row.outwardRate, 15);
  assert.equal(row.outwardTotal, 150);
  assert.equal(row.closingQty, 110);
});

test('partial invoicing splits quantity between Stock In Order and Outward', async () => {
  const result = await run({ sales: [{
    sourceOrderId: 'O1', date: new Date('2026-10-05T00:00:00.000Z'), status: 'POSTED', workflowStatus: 'DELIVERED',
    delivery: { deliveredAt: new Date('2026-10-10T00:00:00.000Z') },
    items: [{ productId: 'P1', qty: 4, effectiveRate: 15, taxable: 60 }],
  }] });
  const row = result.rows[0];
  assert.equal(row.stockInOrderQty, 6);
  assert.equal(row.stockInOrderTotal, 90);
  assert.equal(row.outwardQty, 4);
  assert.equal(row.outwardTotal, 60);
  assert.equal(row.closingQty, 110);
});


test('all FY purchases are Inward and all FY sales invoices are Outward product-wise', async () => {
  const result = await run({
    purchases: [
      { date: new Date('2026-04-10T00:00:00.000Z'), status: 'POSTED', items: [{ productId: 'P1', qty: 5, netRate: 9, netTaxable: 45 }] },
      { date: new Date('2026-10-03T00:00:00.000Z'), status: 'POSTED', items: [{ productId: 'P1', qty: 20, netRate: 10, netTaxable: 200 }] },
    ],
    sales: [
      { date: new Date('2026-05-01T00:00:00.000Z'), status: 'POSTED', workflowStatus: 'READY_FOR_DISPATCH', items: [{ productId: 'P1', qty: 3, effectiveRate: 15, taxable: 45 }] },
      { date: new Date('2026-10-05T00:00:00.000Z'), status: 'POSTED', workflowStatus: 'DELIVERED', items: [{ productId: 'P1', qty: 2, effectiveRate: 15, taxable: 30 }] },
    ],
    orders: [],
  });
  const row = result.rows[0];
  assert.equal(row.openingQty, 100);
  assert.equal(row.inwardQty, 25);
  assert.equal(row.outwardQty, 5);
  assert.equal(row.stockInOrderQty, 0);
  assert.equal(row.closingQty, 120);
});

test('closing rate follows old-DMS weighted stock-cost method', async () => {
  const result = await run();
  const row = result.rows[0];
  // Opening 100 @ 8 = 800; inward 20 @ 10 = 200; weighted rate = 1000/120 = 8.33.
  assert.equal(row.closingRate, 8.33);
  assert.equal(row.closingTotal, 916.3); // 110 * 8.33
});
