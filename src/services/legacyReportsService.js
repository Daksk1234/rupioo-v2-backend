// V2-native replacements for reports identified in the old DMS permission inventory.
// Intentionally read only documented V2 models. Missing historical costing data is
// never fabricated. All document reports apply tenant, FY, date and status at source.
import { financialModels } from './accountingService.js';
import { Product, CustomerLink } from '../models/index.js';
import { PurchaseOrder as PurchaseOrderAi } from '../models/purchaseAiModels.js';
import { inspectBankLedgerRows } from './bankLedgerIntegrityService.js';
import { buildClosingStockRows } from './closingStockService.js';

const descriptions = [
  ['Sales Reports','Sales Report and Amount','sales-doc'],
  ['Sales Reports','Product Wise Sale Report','sales-product'],
  ['Sales Reports','Party Wise and Product Wise Sale Report','sales-party-product'],
  ['Sales Reports','Sales Order Report','sales-order'],
  ['Sales Reports','Sales Pending Report','sales-pending'],
  ['Sales Reports','Sales Complete Order Report','sales-completed'],
  ['Sales Reports','Delivered Order Report','sales-delivered'],
  ['Sales Reports','Sales Dispatch Report','sales-dispatch'],
  ['Sales Reports','Sales Return Report','sales-return'],
  ['Purchase Reports','Purchase Report and Amount','purchase-doc'],
  ['Purchase Reports','Product Wise Purchase Report','purchase-product'],
  ['Purchase Reports','Party Wise and Product Wise Purchase Report','purchase-party-product'],
  ['Purchase Reports','Purchase Order Report','purchase-order'],
  ['Purchase Reports','Purchase Return Report','purchase-return'],
  ['Stock Reports','Inward Stock Report','stock-in'],
  ['Stock Reports','Outward Stock Report','stock-out'],
  ['Stock Reports','Stock Movement Report','stock-movement'],
  ['Stock Reports','Damage Reports','stock-damage'],
  ['Stock Reports','Warehouse Movement Report','warehouse-movement'],
  ['Stock Reports','Closing Stock Report (Live)','stock-live'],
  ['Stock Reports','Available Stock Report (Live)','stock-available'],
  ['Stock Reports','Low Stock Report (Live)','stock-low'],
  ['Stock Reports','Dead Stock Report (No Outward This FY)','stock-dead'],
  ['Finance Reports','Receipt Report','receipt'],
  ['Finance Reports','Payment Report','payment'],
  ['Finance Reports','Cashbook Report','cashbook'],
  ['Finance Reports','Bank Statement Report','bank-statement'],
  ['Finance Reports','Lock Party Report','locked-party'],
  ['Finance Reports','Trial Balance (Journal Movements)','trial-movement'],
  ['Finance Reports','Expense Report','expense'],
];

export const legacyReportCatalog = descriptions.map(([category,name,kind],i)=>({
  id:`OLD-${String(i+1).padStart(3,'0')}`,category,name,kind,
  formats:['SCREEN','EXCEL','PRINT'],implementation:'V2_NATIVE',
}));
const names = new Map(legacyReportCatalog.map(r=>[r.name.toLowerCase(),r]));
// Aliases for direct report pages already present in V2.
const aliases = new Map([
  ['sales by product','sales-product'],['sales by customer','sales-party'],
  ['sales summary','sales-doc'],['purchase summary','purchase-doc'],
  ['stock summary','stock-movement'],['warehouse stock','warehouse-movement'],
  ['closing stock','stock-live'],['dead stock','stock-dead'],
  ['expense analysis','expense'],['receipt & bounce','receipt'],
]);
export function legacyReportKind(name){return names.get(String(name||'').toLowerCase())?.kind||aliases.get(String(name||'').toLowerCase())||null;}
export function isLegacyProfitReport(name){return /(?:profit|margin|landed cost|profitability|trading|break-even|company health)/i.test(String(name||''));}
const n=v=>Number.isFinite(Number(v))?Number(v):0;
const m=v=>Math.round((n(v)+Number.EPSILON)*100)/100;
const str=v=>String(v??'').trim();
const key=v=>str(v)||'UNASSIGNED';
const MAX_ROWS=30000;
async function read(model,query,sort={date:-1}){
  const rows=await model.find(query).sort(sort).limit(MAX_ROWS+1).lean();
  if(rows.length>MAX_ROWS){const error=new Error(`More than ${MAX_ROWS} matching records. Select a shorter date range; this report will not silently omit records.`);error.statusCode=413;throw error;}
  return rows;
}
function group(rows,keys,numeric){
  const map=new Map();
  for(const row of rows){
    const id=keys.map(k=>key(row[k])).join('\u001f');
    if(!map.has(id))map.set(id,{...Object.fromEntries(keys.map(k=>[k,row[k]??''])),count:0,...Object.fromEntries(numeric.map(k=>[k,0]))});
    const current=map.get(id);current.count++;
    for(const k of numeric)current[k]+=n(row[k]);
  }
  return [...map.values()].map(row=>({...row,...Object.fromEntries(numeric.map(k=>[k,m(row[k])]))}));
}
const totals=(rows,fields)=>Object.fromEntries(fields.map(field=>[field,m(rows.reduce((s,row)=>s+n(row[field]),0))]));
export function invoiceLines(invoices,purchase=false){
  const rows=[];
  for(const inv of invoices){
    const items=inv.items||[];
    const itemBasic=it=>n(it.netTaxable??it.taxable??(n(it.effectiveRate??it.rate)*n(it.qty)));
    const sum=items.reduce((total,it)=>total+itemBasic(it),0);
    // Bill discount/charges must be allocated once across lines, with the
    // rounding remainder on the final item so totals still reconcile exactly.
    const invoiceTaxable=m(inv.taxableTotal??inv.subtotal);
    if(invoiceTaxable&&(!items.length||!sum)){
      throw Object.assign(new Error(`Invoice ${inv.invoiceNo||''} cannot be allocated to product lines without valid items`),{statusCode:422});
    }
    const factor=sum?invoiceTaxable/sum:0;
    let allocated=0;
    for(let index=0;index<items.length;index++){
      const it=items[index];
      const base=itemBasic(it);
      const qty=n(it.qty);
      const taxable=index===items.length-1?m(invoiceTaxable-allocated):m(base*factor);
      allocated+=taxable;
      rows.push({date:inv.date,invoiceNo:inv.invoiceNo,
        partyId:purchase?inv.supplierGlobalId:inv.customerGlobalId,
        party:purchase?(inv.supplierNameSnapshot||inv.supplierGlobalId):(inv.customerNameSnapshot||inv.customerGlobalId),
        sku:it.sku||'',product:it.nameSnapshot||it.sku||'UNKNOWN',hsn:it.hsnSnapshot||'',unit:it.unit||'',
        qty,taxable:m(taxable),rate:qty?m(taxable/qty):0,
        gstRate:n(it.gstRateSnapshot),productId:it.productId||''});
    }
  }
  return rows;
}
export function reportPeriod(financialYear,startDate,endDate){
  const fy=String(financialYear);
  const first=`${fy.slice(0,4)}-04-01`, last=`${Number(fy.slice(0,4))+1}-03-31`;
  const valid=v=>!v||/^\d{4}-\d{2}-\d{2}$/.test(v);
  if(!valid(startDate)||!valid(endDate))throw Object.assign(new Error('Use YYYY-MM-DD dates'),{statusCode:400});
  const from=startDate&&startDate>first?startDate:first;
  const to=endDate&&endDate<last?endDate:last;
  if(from>to)throw Object.assign(new Error('Date range is outside this FY'),{statusCode:400});
  const start=new Date(`${from}T00:00:00.000Z`);
  const end=new Date(`${to}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate()+1);
  const cutoff={ $gte:start,$lt:end };
  const ytd={ $gte:new Date(`${first}T00:00:00.000Z`),$lt:end };
  return {from,to,cutoff,ytd};
}
export function orderRows(orders,kind){
  const pending=new Set(['DRAFT','SUBMITTED','CREDIT_HOLD','APPROVED','PROCESSING','PENDING','OTP_PENDING','ORDER_PLACED','VERIFIED','STOCK_RESERVED','SENT_TO_WAREHOUSE','PICKING','PACKING','PACKED','SENT_TO_ORDER_DESK','INVOICED_PARTIAL','INVOICED','READY_FOR_DISPATCH','DELIVERY_ASSIGNED','OUT_FOR_DELIVERY','HANDED_TO_TRANSPORTER','DELIVERY_FAILED','RETURN_IN_TRANSIT','RETURNED_TO_WAREHOUSE','CREDIT_NOTE_PENDING']);
  const completed=new Set(['CONVERTED','COMPLETED','DELIVERED','CLOSED']);
  const subset=orders.filter(o=>{
    const s=str(o.status).toUpperCase(),w=str(o.workflowStatus).toUpperCase();
    if(kind==='sales-pending')return w?pending.has(w):pending.has(s);
    if(kind==='sales-completed')return w?completed.has(w):completed.has(s);
    if(kind==='sales-delivered')return w==='DELIVERED'||s==='DELIVERED';
    return true;
  });
  return subset.map(o=>({date:o.date,orderNo:o.orderNo,party:o.customerNameSnapshot||o.customerGlobalId,
    partyId:o.customerGlobalId,salesperson:o.salespersonId||'',status:o.status||'',workflowStatus:o.workflowStatus||'',
    taxable:m(o.subtotal),gst:m(o.taxTotal),amount:m(o.grandTotal),
    orderedQty:m((o.items||[]).reduce((s,it)=>s+n(it.qty),0)),
    invoicedQty:m((o.items||[]).reduce((s,it)=>s+n(it.invoicedQty),0))}));
}
export function stockRows(movements,products,kind){
  const productMap=new Map(products.map(p=>[String(p._id),p]));
  let source=movements;
  if(kind==='stock-damage')source=source.filter(x=>/(DAMAGE|WAST|REJECT|SCRAP)/i.test(str(x.type)));
  const output=source.map(x=>{
    const p=productMap.get(str(x.productId));
    return {date:x.date,sku:p?.sku||'',product:p?.name||x.productId||'',warehouse:x.warehouseId||p?.warehouseId||'',
      type:x.type||'',reference:x.referenceId||'',qtyIn:n(x.qtyIn),qtyOut:n(x.qtyOut),
      netQty:n(x.qtyIn)-n(x.qtyOut),landedValue:m((n(x.qtyIn)-n(x.qtyOut))*n(x.landedCost||p?.landedCost))};
  });
  if(kind==='stock-in')return group(output.filter(x=>x.qtyIn>0),['sku','product','warehouse'],['qtyIn']);
  if(kind==='stock-out')return group(output.filter(x=>x.qtyOut>0),['sku','product','warehouse'],['qtyOut']);
  if(kind==='stock-damage')return group(output,['sku','product','warehouse','type'],['qtyIn','qtyOut','netQty']);
  if(kind==='warehouse-movement')return group(output,['warehouse','sku','product'],['qtyIn','qtyOut','netQty']);
  return output;
}
function liveStockRows(products,kind,movements=[]){
  const movedOut=new Set(movements.filter(x=>n(x.qtyOut)>0).map(x=>str(x.productId)));
  return products.filter(p=>{
    if(kind==='stock-low')return n(p.minStockAlert)>0&&n(p.currentStock)<n(p.minStockAlert);
    if(kind==='stock-dead')return n(p.currentStock)>0&&!movedOut.has(str(p._id));
    return true;
  }).map(p=>({sku:p.sku,product:p.name,category:p.category||'',warehouse:p.warehouseId||'',
    currentQty:n(p.currentStock),reservedQty:n(p.reservedStock),
    availableQty:m(n(p.currentStock)-n(p.reservedStock)),minQty:n(p.minStockAlert),
    landedRate:m(p.landedCost),liveStockValue:m(n(p.currentStock)*n(p.landedCost))}));
}
export async function buildLegacyReport({name,tenantKey,financialYear,startDate='',endDate=''}){
  const kind=legacyReportKind(name);
  if(!kind)return null;
  const period=reportPeriod(financialYear,startDate,endDate);
  const f=financialModels(tenantKey,financialYear);
  const base={tenantKey,financialYear};
  let rows=[],summary={},note='';
  if(kind.startsWith('sales-')&&kind!=='sales-order'&&kind!=='sales-pending'&&kind!=='sales-completed'&&kind!=='sales-delivered'&&kind!=='sales-return'){
    const invoices=await read(f.SalesInvoice,{...base,date:period.cutoff,status:{$in:['POSTED','COMPLETED']}});
    if(kind==='sales-dispatch'){
      rows=invoices.filter(x=>/(DISPATCH|DELIVER|WAREHOUSE|TRANSIT)/i.test(str(x.workflowStatus)))
        .map(x=>({date:x.date,invoiceNo:x.invoiceNo,party:x.customerNameSnapshot,warehouse:x.warehouseNameSnapshot||x.warehouseId,
          transporter:x.transportAssignment?.transporterNameSnapshot||'',workflowStatus:x.workflowStatus,amount:m(x.grandTotal)}));
      summary={invoices:rows.length,...totals(rows,['amount'])};
      note='Period uses invoice date; dispatch/delivery workflow status reflects the current state.';
    }else if(kind==='sales-doc'){
      rows=invoices.map(x=>({date:x.date,invoiceNo:x.invoiceNo,party:x.customerNameSnapshot||x.customerGlobalId,
        partyId:x.customerGlobalId,taxable:m(x.taxableTotal??x.subtotal),gst:m(x.taxTotal),
        roundOff:m(x.roundOff),amount:m(x.grandTotal),status:x.status,workflowStatus:x.workflowStatus}));
      summary={invoices:rows.length,...totals(rows,['taxable','gst','roundOff','amount'])};
    }else if(kind==='sales-party'){
      rows=group(invoices.map(x=>({partyId:x.customerGlobalId,party:x.customerNameSnapshot||x.customerGlobalId,
        taxable:n(x.taxableTotal??x.subtotal),gst:n(x.taxTotal),amount:n(x.grandTotal)})),
        ['partyId','party'],['taxable','gst','amount']);
      summary={invoices:invoices.length,parties:rows.length,...totals(rows,['taxable','gst','amount'])};
    }else{
      const lines=invoiceLines(invoices);
      rows=group(lines,kind==='sales-product'?['sku','product','hsn','unit']:['partyId','party','sku','product','hsn','unit'],['qty','taxable']);
      summary={invoices:invoices.length,products:rows.length,...totals(rows,['qty','taxable'])};
    }
  }else if(['sales-order','sales-pending','sales-completed','sales-delivered'].includes(kind)){
    const orders=await read(f.SalesOrder,{...base,date:period.cutoff});
    rows=orderRows(orders,kind);
    summary={orders:rows.length,...totals(rows,['amount','orderedQty','invoicedQty'])};
    note='Period uses order date; order and delivery statuses reflect their current state.';
  }else if(['sales-return','purchase-return'].includes(kind)){
    const documentType=kind==='sales-return'?'CREDIT_NOTE':'DEBIT_NOTE';
    const notes=await read(f.CreditNote,{...base,date:period.cutoff,documentType,status:{$in:['ISSUED','RETURNED']}});
    rows=notes.map(x=>({date:x.date,documentNo:x.documentNo||x.creditNoteNo,againstInvoice:x.invoiceNo||x.referenceDocumentNo||'',
      party:x.partyNameSnapshot||x.customerNameSnapshot||x.partyGlobalId||x.customerGlobalId,
      reason:x.reason||x.reasonType||'',taxable:m(x.taxableTotal??x.subtotal),gst:m(x.taxTotal),amount:m(x.grandTotal),status:x.status}));
    summary={documents:rows.length,...totals(rows,['taxable','gst','amount'])};
    note=kind==='sales-return'
      ?'Includes all issued Credit Notes (returns and incentives); use the reason column to identify physical returns.'
      :'Includes all issued Debit Notes (returns and charges); use the reason column to identify physical returns.';
  }else if(kind.startsWith('purchase-')&&kind!=='purchase-order'){
    const invoices=await read(f.PurchaseInvoice,{...base,date:period.cutoff,status:{$in:['POSTED','COMPLETED']}});
    if(kind==='purchase-doc'){
      rows=invoices.map(x=>({date:x.date,invoiceNo:x.invoiceNo,party:x.supplierNameSnapshot||x.supplierGlobalId,
        partyId:x.supplierGlobalId,taxable:m(x.taxableTotal??x.subtotal),gst:m(x.taxTotal),amount:m(x.grandTotal),
        landedCharges:m(x.landedCharges),status:x.status}));
      summary={invoices:rows.length,...totals(rows,['taxable','gst','amount','landedCharges'])};
    }else{
      const lines=invoiceLines(invoices,true);
      rows=group(lines,kind==='purchase-product'?['sku','product','hsn','unit']:['partyId','party','sku','product','hsn','unit'],['qty','taxable']);
      summary={invoices:invoices.length,groups:rows.length,...totals(rows,['qty','taxable'])};
    }
  }else if(kind==='purchase-order'){
    // PO records live in the tenant master DB, unlike posted financial vouchers.
    const orders=await read(PurchaseOrderAi,{tenantKey,financialYear,createdAt:period.cutoff});
    rows=orders.map(x=>({date:x.createdAt,poNo:x.poNo,party:x.vendorName||x.vendorGlobalId,
      taxable:m(x.totalTaxable),gst:m(x.totalTax),amount:m(x.grandTotal),landedTotal:m(x.landedTotal),status:x.status}));
    summary={orders:rows.length,...totals(rows,['taxable','gst','amount','landedTotal'])};
    note='Purchase Order period is based on PO creation date.';
  }else if(kind.startsWith('stock-')||kind==='warehouse-movement'){
    const products=await read(Product,{tenantKey},{name:1});
    if(kind==='stock-live'){
      const closing=await buildClosingStockRows({tenantKey,financialYear,period,models:f});
      rows=closing.rows;
      summary=closing.summary;
      note=closing.note;
    }else if(['stock-available','stock-low','stock-dead'].includes(kind)){
      const moves=kind==='stock-dead'?await read(f.StockMovement,{...base,date:period.ytd}):[];
      rows=liveStockRows(products,kind,moves);
      summary={products:rows.length,...totals(rows,['currentQty','availableQty','liveStockValue'])};
      note=kind==='stock-dead'?'Live stocked products without an outward movement in the selected FY through the selected date; not a lifetime dead-stock determination.':
        'LIVE product-master stock, not historical month-end valuation. Stock movement history alone cannot reconstruct a certified prior-FY opening stock.';
    }else{
      const moves=await read(f.StockMovement,{...base,date:period.cutoff});
      rows=stockRows(moves,products,kind);
      summary={rows:rows.length,...totals(rows,kind==='stock-in'?['qtyIn']:kind==='stock-out'?['qtyOut']:['qtyIn','qtyOut','netQty'])};
      note='Movement quantities are the recorded physical movements in the selected period, including posted reversal movements. This is not a historical stock valuation.';
    }
  }else if(kind==='receipt'||kind==='payment'){
    const receipt=kind==='receipt';
    const docs=await read(receipt?f.Receipt:f.Payment,{...base,date:period.cutoff,status:'POSTED'});
    rows=docs.map(x=>({date:x.date,voucherNo:receipt?x.receiptNo:x.paymentNo,
      party:x.partyNameSnapshot|| (receipt?x.customerGlobalId:x.partyGlobalId),
      partyId:receipt?x.customerGlobalId:x.partyGlobalId,mode:x.mode||'',reference:x.reference||'',
      bank:x.bankNameSnapshot||'',amount:m(x.amount),remarks:x.remarks||''}));
    summary={vouchers:rows.length,...totals(rows,['amount'])};
  }else if(kind==='cashbook'){
    const [receipts,payments]=await Promise.all([
      read(f.Receipt,{...base,date:period.cutoff,status:'POSTED',mode:/^CASH$/i}),
      read(f.Payment,{...base,date:period.cutoff,status:'POSTED',mode:/^CASH$/i})]);
    rows=[...receipts.map(x=>({date:x.date,voucherNo:x.receiptNo,party:x.partyNameSnapshot||x.customerGlobalId,
      narration:x.remarks||'',receipt:m(x.amount),payment:0})),
      ...payments.map(x=>({date:x.date,voucherNo:x.paymentNo,party:x.partyNameSnapshot||x.partyGlobalId,
        narration:x.remarks||'',receipt:0,payment:m(x.amount)}))].sort((a,b)=>new Date(a.date)-new Date(b.date));
    summary={vouchers:rows.length,...totals(rows,['receipt','payment']),netMovement:m(rows.reduce((s,r)=>s+n(r.receipt)-n(r.payment),0))};
    note='Cash movement for the selected period. Opening cash balance is not inferred.';
  }else if(kind==='bank-statement'){
    const bankRows=await read(f.BankStatementRow,{...base,date:period.cutoff,
      classification:{$in:['POSTED','SUSPENSE','UNMATCHED']}});
    const seenBank=new Set();
    rows=bankRows.filter(x=>{const id=str(x.bankAccountId)+':'+str(x.postingFingerprint||x.fingerprint||x._id);if(seenBank.has(id))return false;seenBank.add(id);return true;})
      .map(x=>({date:x.date,bankAccountId:x.bankAccountId,remarks:x.remarks||'',
      party:x.matchedPartyName||x.partyName||'',receipt:m(x.credit),payment:m(x.debit),
      runningBalance:m(x.runningBalance),transactionId:x.transactionId||'',classification:x.classification||''}));
    summary={rows:rows.length,...totals(rows,['receipt','payment'])};
    note='Submitted bank statement rows only. Amounts are sourced once from statement rows; linked receipts/payments are not added again.';
  }else if(kind==='locked-party'){
    const parties=await read(CustomerLink,{tenantKey,status:{$in:['ON_HOLD','BLOCKED','INACTIVE','DEACTIVATED'] }},{localName:1});
    rows=parties.map(p=>({party:p.localName||p.displayIdentifier,partyId:p.globalCustomerId,
      status:p.status,creditLimit:m(p.creditLimit),paymentType:p.paymentType||''}));
    summary={parties:rows.length};note='Current master-data status; not a historical monthly snapshot.';
  }else if(kind==='trial-movement'){
    const raw=await read(f.LedgerEntry,{...base,date:period.cutoff,status:'POSTED'});
    const {rows:clean}=await inspectBankLedgerRows({tenantKey,financialYear,rows:raw});
    rows=group(clean.map(x=>({accountCode:x.accountCode||'',debit:n(x.debit),credit:n(x.credit)})),['accountCode'],['debit','credit']);
    rows=rows.map(r=>({...r,netDebit:m(Math.max(0,r.debit-r.credit)),netCredit:m(Math.max(0,r.credit-r.debit))}));
    summary={accounts:rows.length,...totals(rows,['debit','credit','netDebit','netCredit'])};
    note='Posted journal movements for the selected period, with duplicate bank-journal rows excluded. Master and previous-FY opening balances are not included; this is not a certified complete trial balance.';
  }else if(kind==='expense'){
    const expenses=await read(f.Expense,{...base,date:period.cutoff,status:'POSTED'});
    rows=group(expenses.map(x=>({accountCode:x.accountCode||'',nature:x.nature||'',amount:n(x.amount)})),['accountCode','nature'],['amount']);
    summary={vouchers:expenses.length,...totals(rows,['amount'])};
  }
  return {name,financialYear,startDate:period.from,endDate:period.to,generatedAt:new Date(),
    implementation:'V2_NATIVE',source:'V2 financial-year collections and master records',note,summary,rows,recordCount:rows.length,
    emptyReason:rows.length?null:`No matching source records for ${period.from} to ${period.to}. Try Full FY or select the period containing the transactions.`,branding:{footer:'This page is generated by the Rupioo Global System.'}};
}
