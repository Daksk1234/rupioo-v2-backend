import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { createFullGstWorkbook } from '../src/services/gstReportExportService.js';
import { gstReportPeriod } from '../src/utils/gstReportPeriod.js';

const period = {financialYear:'2026-27',startDate:'2026-11-01',endDate:'2026-11-30'};
function fixture() {
  return {
    gstr1:{sections:{B2B:Array.from({length:121},(_,index)=>({invoiceNo:`INV-${index}`,taxableValue:900,cgst:81,sgst:81,roundOff:-0.1,grandTotal:1061.9})),B2CS:[],B2CL:[],CDNR:[{noteNumber:'CN-1',noteValue:100}],CDNUR:[]}},
    gstr2b:{rows:[{invoiceNo:'PUR-1',invoiceValue:118,taxableValue:100,cgstAmount:9,sgstAmount:9}]},
    gstr3b:{natureOfSupplies:[{label:'Outward',taxableValue:900}],eligibleITC:[{label:'All Other ITC',centralTax:9}]},
    hsn:{regular:[{HSN_Code:'0012',taxableAmount:900}],unregister:[{HSN_Code:'0013',taxableAmount:100}],reconciliation:{hsn:{taxable:1000},sales:{taxable:1000}}},
    inputOutput:{rows:[{type:'INPUT',invoiceNo:'PUR-1',totalInput:18},{type:'OUTPUT',invoiceNo:'INV-1',totalOutput:162}]},
    tax:{rows:[{totalTaxInput:18,totalTaxOut:162,BalanceTax:-144}]},
  };
}
const grid = (book,name) => XLSX.utils.sheet_to_json(book.Sheets[name],{header:1,defval:''});

test('full workbook round-trips ten sheets, a shared period, and all invoices beyond the first page', () => {
  const workbook=createFullGstWorkbook(fixture(),period);
  const decoded=XLSX.read(XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),{type:'buffer',cellNF:true});
  assert.deepEqual(decoded.SheetNames,['B2B','B2CS','B2CL','CDNR','CDNUR','GSTR2B','GSTR3B','HSN Wise','GST Input Output','Tax']);
  for(const name of decoded.SheetNames) assert.deepEqual(grid(decoded,name)[1].slice(0,6),['Financial Year','2026-27','From','2026-11-01','To','2026-11-30']);
  const invoices=grid(decoded,'B2B').filter(row=>String(row[0]).startsWith('INV-'));
  assert.equal(invoices.length,121);
  assert.equal(invoices.at(-1)[0],'INV-120');
  assert.equal(typeof invoices[0][6],'number');
  assert.equal(invoices[0][10],-0.1);
  assert.equal(decoded.Sheets.B2B.K6.t,'n');
  assert.match(decoded.Sheets.B2B.K6.z,/0\.00/);
});

test('empty sheets retain headers and both multi-table reports retain all sections', () => {
  const workbook=createFullGstWorkbook(fixture(),period);
  assert.ok(grid(workbook,'B2CS')[4].includes('Taxable Value'));
  assert.ok(grid(workbook,'B2CS')[5][0].includes('No records'));
  const g3=grid(workbook,'GSTR3B').flat();
  assert.ok(g3.includes('3.1 Nature of Supplies')&&g3.includes('4. Eligible ITC')&&g3.includes('All Other ITC'));
  const hsn=grid(workbook,'HSN Wise').flat();
  assert.ok(hsn.includes('0012')&&hsn.includes('0013')&&hsn.includes('HSN vs Sales Reconciliation'));
  assert.ok(grid(workbook,'GST Input Output').flat().includes('OUTPUT'));
  assert.ok(grid(workbook,'Tax').flat().includes(-144));
});

test('exported user text stays text and internal fields stay out of the workbook', () => {
  const data=fixture();
  data.gstr1.sections.B2B=[{invoiceNo:'=1+1',partyName:'@TEST',invoiceId:'private-id',taxableValue:100}];
  const workbook=createFullGstWorkbook(data,period);
  assert.equal(workbook.Sheets.B2B.A6.t,'s');
  assert.equal(workbook.Sheets.B2B.A6.f,undefined);
  assert.ok(!grid(workbook,'B2B').flat().includes('private-id'));
});

test('GST periods validate dates and respect financial year boundaries', () => {
  assert.deepEqual(gstReportPeriod('2026-27'),{startDate:'2026-04-01',endDate:'2027-03-31'});
  assert.deepEqual(gstReportPeriod('2026-27',period.startDate,period.endDate),{startDate:period.startDate,endDate:period.endDate});
  for (const [start,end] of [['2026-02-30','2026-11-30'],['2026-11-30','2026-11-01'],['2026-03-31','2026-11-30'],['2026-11-01','2027-04-01'],['wrong','2026-11-30']]) {
    assert.throws(()=>gstReportPeriod('2026-27',start,end),error=>error.statusCode===400);
  }
});
