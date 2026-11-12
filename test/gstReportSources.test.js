import test from 'node:test';
import assert from 'node:assert/strict';
import { GenericRecord } from '../src/models/index.js';
import { buildGstr1, buildGstr2b, buildGstr3b, buildHsnReport, buildInputOutput, buildTaxReport } from '../src/services/gstReportsService.js';

test('all workbook builders reuse supplied invoices and retain discounted taxable values', async t => {
  t.mock.method(GenericRecord,'find',()=>({sort:()=>({lean:async()=>[]})}));
  const reportContext={
    sales:[{_id:'s1',invoiceNo:'INV-1',date:'2026-11-01',gstType:'IGST',items:[{taxable:1000,gstRateSnapshot:18,hsnSnapshot:'0012',qty:1}],billDiscount:100,otherCharges:50,taxableTotal:950,taxTotal:171,roundOff:0.1,grandTotal:1121.1}],
    purchases:[],company:{},linkMap:new Map(),
  };
  const args={tenantKey:'test',financialYear:'2026-27',startDate:'2026-11-01',endDate:'2026-11-30',reportContext};
  const g1=await buildGstr1(args),g2=await buildGstr2b(args),g3=await buildGstr3b(args),hsn=await buildHsnReport(args),io=await buildInputOutput(args),tax=await buildTaxReport(args);
  assert.equal(g1.sections.B2CS[0].taxableValue,950);
  assert.equal(g1.sections.B2CS[0].igst,171);
  assert.equal(g2.rows.length,0);
  assert.equal(g3.sourceTotals.sales.taxable,950);
  assert.equal(hsn.totals.all.taxableAmount,950);
  assert.equal(io.rows[0].taxableValue,950);
  assert.equal(io.rows[0].roundOff,0.1);
  assert.equal(tax.rows[0].totalTaxOut,171);
});

test('GSTR 2B serial numbers stay consecutive after purchase filtering', async () => {
  const purchase=id=>({_id:id,invoiceNo:id,supplierGlobalId:id,supplierGstinSnapshot:'27ABCDE1234F1Z5',items:[{taxable:100,gstRateSnapshot:18}],taxTotal:18,grandTotal:118});
  const result=await buildGstr2b({reportContext:{sales:[],purchases:[purchase('skip'),purchase('keep1'),purchase('keep2')],company:{},linkMap:new Map([
    ['skip',{registrationType:'UNREGISTERED'}],['keep1',{registrationType:'REGULAR'}],['keep2',{registrationType:'REGULAR'}],
  ])}});
  assert.deepEqual(result.rows.map(row=>row.srNo),[1,2]);
  assert.deepEqual(result.rows.map(row=>row.invoiceNo),['keep1','keep2']);
  assert.equal(result.totals.taxableValue,200);
});
