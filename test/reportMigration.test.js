import test from 'node:test';
import assert from 'node:assert/strict';
import { reportPeriod, invoiceLines, legacyReportCatalog, legacyReportKind,
  orderRows, stockRows } from '../src/services/legacyReportsService.js';

test('old-DMS inventory has 30 V2-native reports with unique names',()=>{
  assert.equal(legacyReportCatalog.length,30);
  assert.equal(new Set(legacyReportCatalog.map(r=>r.name)).size,30);
  for(const report of legacyReportCatalog)assert.equal(legacyReportKind(report.name),report.kind);
});
test('FY/month boundaries clamp at April and March inclusively',()=>{
  const p=reportPeriod('2025-26','2026-03-01','2026-03-31');
  assert.equal(p.from,'2026-03-01');assert.equal(p.to,'2026-03-31');
  assert.equal(p.cutoff.$lt.toISOString(),'2026-04-01T00:00:00.000Z');
  assert.equal(p.ytd.$gte.toISOString(),'2025-04-01T00:00:00.000Z');
});
test('report requested outside the selected FY is rejected',()=>{
  assert.throws(()=>reportPeriod('2025-26','2026-04-01','2026-04-30'),/outside this FY/);
});
test('single-item purchase basic 460800 allocates net taxable 436677.12',()=>{
  const lines=invoiceLines([{invoiceNo:'P1',taxableTotal:436677.12,items:[
    {sku:'A',nameSnapshot:'Board',qty:100,taxable:460800}
  ]}],true);
  assert.equal(lines[0].taxable,436677.12);
  assert.equal(lines[0].rate,4366.77);
});
test('multi-item taxable allocation preserves round-off to last item',()=>{
  const lines=invoiceLines([{invoiceNo:'P2',taxableTotal:436677.12,items:[
    {sku:'A',qty:10,taxable:200000}, {sku:'B',qty:20,taxable:260800}
  ]}],true);
  assert.equal(lines.reduce((sum,row)=>sum+row.taxable,0),436677.12);
});
test('item calculations refuse incomplete invoice instead of fabricating products',()=>{
  assert.throws(()=>invoiceLines([{invoiceNo:'P3',taxableTotal:100,items:[]}]),/cannot be allocated/);
});
test('sales order pending and delivered do not overlap',()=>{
  const sample=[{orderNo:'P',status:'SUBMITTED',items:[]},{orderNo:'D',status:'CONVERTED',workflowStatus:'DELIVERED',items:[]}];
  assert.deepEqual(orderRows(sample,'sales-pending').map(x=>x.orderNo),['P']);
  assert.deepEqual(orderRows(sample,'sales-delivered').map(x=>x.orderNo),['D']);
});
test('stock movement summary nets recorded reversal movements',()=>{
  const products=[{_id:'p1',sku:'SKU1',name:'Item',landedCost:10}];
  const moves=[{date:new Date(),productId:'p1',warehouseId:'W',type:'SALE',qtyOut:10},
    {date:new Date(),productId:'p1',warehouseId:'W',type:'SALE_DELETE_REVERSAL',qtyIn:10}];
  const result=stockRows(moves,products,'warehouse-movement');
  assert.equal(result.length,1);assert.equal(result[0].netQty,0);
});
