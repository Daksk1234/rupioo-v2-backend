// Live V2 reports that previously appeared as labels or fell through to broad
// regex handlers. Always query the authenticated tenant and selected FY.
import { financialModels } from './accountingService.js';
import { CustomerLink, Product, Lead, Employee, GenericRecord, Transporter } from '../models/index.js';
import { buildGstReport } from './gstReportsService.js';
import { inspectBankLedgerRows } from './bankLedgerIntegrityService.js';
import { reportPeriod } from './legacyReportsService.js';

const N = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const R = v => Math.round((N(v) + Number.EPSILON) * 100) / 100;
const T = v => String(v ?? '').trim();
const LIMIT = 30000;
async function read(model, query, sort = { date: -1 }) {
  const rows = await model.find(query).sort(sort).limit(LIMIT + 1).lean();
  if (rows.length > LIMIT) throw Object.assign(new Error(`Report exceeds ${LIMIT} source documents; select a shorter period.`), { statusCode: 413 });
  return rows;
}
const sum = (rows, fields) => Object.fromEntries(fields.map(field => [field, R(rows.reduce((a, x) => a + N(x[field]), 0))]));
function group(rows, keys, nums) {
  const map = new Map();
  for (const row of rows) {
    const id = keys.map(k => T(row[k])).join('\u001f');
    if (!map.has(id)) map.set(id, { ...Object.fromEntries(keys.map(k => [k, row[k] ?? ''])), count: 0, ...Object.fromEntries(nums.map(k => [k, 0])) });
    const item = map.get(id); item.count++;
    for (const k of nums) item[k] += N(row[k]);
  }
  return Array.from(map.values()).map(item => ({ ...item, ...Object.fromEntries(nums.map(k => [k, R(item[k])])) }));
}
// Explicit mappings: avoid silently presenting a Sales list as a GST report or
// movement-only trial balance as a certified balance sheet.
const mappings = [
  ['Sales Reports','Sales by Salesperson','salesperson'],
  ['Sales Reports','Sales by Territory','territory'],
  ['Sales Reports','Dead Parties Report (No Sales in FY)','dead-parties'],
  ['Purchase Reports','Supplier Performance','supplier'],
  ['Purchase Reports','Landed Cost Analysis','landed'],
  ['Finance Reports','Party-wise Ledger Movements','party-ledger'],
  ['Finance Reports','Due / Outstanding Movements','outstanding'],
  ['Finance Reports','Bank Statement (All Submitted Rows)','bank-all'],
  ['Finance Reports','Receipts and Payments Summary','cash-flow'],
  ['Customer Reports','Customer Health (Current)','customer-health'],
  ['Customer Reports','Customer Credit Exposure (FY Movements)','customer-credit'],
  ['Customer Reports','Customer Master Report','customers'],
  ['Sales Reports','Lead Funnel (Current)','lead-funnel'],
  ['Logistics Reports','Transporter Network (Current)','transporters'],
  ['Product Reports','Product Master and Price List (Current)','products'],
  ['Product Reports','Barcode Registry (Current)','barcodes'],
  ['HR Reports','Staff List (Current)','staff'],
  ['HR Reports','HR Attendance','hr-attendance'],
  ['HR Reports','HR Payroll','hr-payroll'],
  ['HR Reports','HR Leave','hr-leave'],
  ['Production Reports','Production Execution','prod-execution'],
  ['Production Reports','Production WIP','prod-wip'],
  ['Production Reports','Production Quality Control','prod-quality'],
  ['Production Reports','Machine Maintenance','prod-maintenance'],
  ['GST Reports','GSTR-1','gst-GSTR1'],
  ['GST Reports','GSTR-2B','gst-GSTR2B'],
  ['GST Reports','GSTR-3B','gst-GSTR3B'],
  ['GST Reports','HSN Wise Report','gst-HSN'],
  ['GST Reports','GST Input / Output','gst-INPUTOUTPUT'],
  ['GST Reports','Tax Report','gst-TAX'],
];
export const v2LiveReportCatalog = mappings.map(([category,name,kind],i) => ({
  id:`LIVE-${String(i+1).padStart(3,'0')}`,category,name,kind,implementation:'V2_LIVE',formats:['SCREEN','EXCEL','PRINT']
}));
const kinds = new Map(mappings.map(([,name,kind]) => [name.toLowerCase(),kind]));
const aliases = new Map([
  ['sales by customer','customer-sales'],['customer report','customers'],
  ['sales by salesperson','salesperson'],['sales by territory','territory'],
  ['supplier performance','supplier'],['landed cost analysis','landed'],
  ['lead funnel','lead-funnel'],['customer health','customer-health'],
  ['customer credit exposure','customer-credit'],['transporter network','transporters'],
  ['barcode registry','barcodes'],['hr attendance','hr-attendance'],
  ['hr payroll','hr-payroll'],['hr leave','hr-leave'],['wip','prod-wip'],
  ['qc & rejection','prod-quality'],['machine downtime','prod-maintenance'],
  ['production efficiency','prod-execution'],['production plan vs actual','prod-execution'],
  ['gstr-1 reconciliation','gst-GSTR1'],['gstr-2b reconciliation','gst-GSTR2B'],
  ['gstr-3b reconciliation','gst-GSTR3B'],['gst compliance health','gst-INPUTOUTPUT'],
]);
export function v2LiveReportKind(name) { const s = T(name).toLowerCase(); return kinds.get(s) || aliases.get(s) || null; }
const gstRows = data => {
  if (data.sections) return Object.entries(data.sections).flatMap(([section,rows]) => (rows||[]).map(row => ({section,...row})));
  if (data.natureOfSupplies) return [
    ...data.natureOfSupplies.map(row => ({section:'Nature of Supplies',...row})),
    ...(data.eligibleITC||[]).map(row => ({section:'Eligible ITC',...row}))
  ];
  if (data.regular || data.unregister) return [
    ...(data.regular||[]).map(row => ({section:'Registered',...row})),
    ...(data.unregister||[]).map(row => ({section:'Unregistered',...row}))
  ];
  return data.rows || [];
};
export async function buildV2LiveReport({ name, tenantKey, financialYear, startDate='', endDate='', models, masters }) {
  const kind = v2LiveReportKind(name);
  if (!kind) return null;
  const period = reportPeriod(financialYear,startDate,endDate);
  const f = models || financialModels(tenantKey,financialYear);
  const src = masters || { CustomerLink, Product, Lead, Employee, GenericRecord, Transporter };
  const base = { tenantKey,financialYear };
  let rows=[],summary={},note='',source='';
  if (kind.startsWith('gst-')) {
    const type = kind.slice(4);
    const data = await buildGstReport(type,{tenantKey,financialYear,startDate:period.from,endDate:period.to});
    rows = gstRows(data);
    summary = data.totals || data.sourceTotals || { records:rows.length };
    source = `GST ${type} calculation from posted invoices`;
    note = 'Generated from V2 posted invoices. GSTR-2B is V2 purchase-register data, not an imported government GSTR-2B statement; reconcile externally before filing.';
  } else if (['salesperson','territory','customer-sales'].includes(kind)) {
    const [invoices, links] = await Promise.all([
      read(f.SalesInvoice,{...base,date:period.cutoff,status:{$in:['POSTED','COMPLETED']} }),
      read(src.CustomerLink,{tenantKey},{localName:1})
    ]);
    const map = new Map(links.map(link => [T(link.globalCustomerId),link]));
    rows = group(invoices.map(x => {
      const link = map.get(T(x.customerGlobalId)) || {};
      return { salesperson:T(x.assignedTo||link.salespersonId)||'UNASSIGNED',
        territory:T(link.territoryId)||'UNASSIGNED',
        partyId:T(x.customerGlobalId),party:x.customerNameSnapshot||link.localName||x.customerGlobalId||'UNKNOWN',
        invoices:1,taxable:N(x.taxableTotal??x.subtotal),gst:N(x.taxTotal),amount:N(x.grandTotal) };
    }), kind==='salesperson'?['salesperson']:kind==='territory'?['territory']:['partyId','party'], ['invoices','taxable','gst','amount']);
    summary = { invoices:invoices.length, groups:rows.length,...sum(rows,['taxable','gst','amount']) };
    source = 'Posted SalesInvoice + CustomerLink';
  } else if (kind === 'dead-parties') {
    const [links,invoices] = await Promise.all([
      read(src.CustomerLink,{tenantKey,status:'ACTIVE'},{localName:1}),
      read(f.SalesInvoice,{...base,date:period.ytd,status:{$in:['POSTED','COMPLETED']}})
    ]);
    const sold = new Set(invoices.map(x=>T(x.customerGlobalId)));
    rows = links.filter(x=>!sold.has(T(x.globalCustomerId))).map(x=>({party:x.localName||x.displayIdentifier,
      partyId:x.globalCustomerId,salesperson:x.salespersonId||'',territory:x.territoryId||'',status:x.status }));
    summary={parties:rows.length};source='CustomerLink + FY-to-date SalesInvoice';
    note='Active customers with no posted sale during this FY through the selected period, not a lifetime inactivity classification.';
  } else if (kind==='supplier'||kind==='landed') {
    const invoices = await read(f.PurchaseInvoice,{...base,date:period.cutoff,status:{$in:['POSTED','COMPLETED']}});
    const data = invoices.map(x => ({date:x.date,invoiceNo:x.invoiceNo,partyId:x.supplierGlobalId,
      supplier:x.supplierNameSnapshot||x.supplierGlobalId||'UNKNOWN',basic:N(x.subtotal),discount:N(x.billDiscount),
      charges:N(x.otherCharges),taxable:N(x.taxableTotal??x.subtotal),gst:N(x.taxTotal),invoiceTotal:N(x.grandTotal),
      landedCharges:N(x.landedCharges),landedTotal:R(N(x.taxableTotal??x.subtotal)+N(x.landedCharges)) }));
    rows = kind==='supplier' ? group(data,['partyId','supplier'],['basic','discount','charges','taxable','gst','invoiceTotal','landedCharges','landedTotal']) : data;
    summary = {invoices:invoices.length,...sum(data,['basic','discount','charges','taxable','gst','invoiceTotal','landedCharges','landedTotal'])};
    source='Posted PurchaseInvoice';
    note='Landed total shows taxable purchase value plus stored landedCharges. GST treatment depends on reclaimability; this is not a certified inventory valuation.';
  } else if (kind==='bank-all') {
    const docs=await read(f.BankStatementRow,{...base,date:period.cutoff,classification:{$in:['POSTED','SUSPENSE','UNMATCHED']} });
    const dedup = new Map();
    for(const x of docs) { const id=T(x.bankAccountId)+':'+T(x.postingFingerprint||x.fingerprint||x._id);if(!dedup.has(id))dedup.set(id,x); }
    rows = [...dedup.values()].map(x=>({date:x.date,bankAccountId:x.bankAccountId,rowNo:x.rowNo,
      party:x.matchedPartyName||x.partyName||'',remarks:x.remarks||'',receipt:R(x.credit),payment:R(x.debit),
      runningBalance:R(x.runningBalance),classification:x.classification,transactionId:x.transactionId||''}));
    summary={transactions:rows.length,...sum(rows,['receipt','payment'])};source='BankStatementRow';
    note='Each submitted bank row appears once. An unmatched row is displayed but is not a posted Receipt or Payment.';
  } else if (kind==='party-ledger'||kind==='outstanding') {
    const original = await read(f.LedgerEntry,{...base,date:period.cutoff,status:'POSTED'});
    const {rows:verified} = await inspectBankLedgerRows({tenantKey,financialYear,rows:original});
    const party = verified.filter(x=>T(x.partyGlobalId) && x.accountCode && /DEBTORS|CREDITORS|RECEIVABLE|PAYABLE/.test(x.accountCode.toUpperCase()));
    rows = kind==='party-ledger' ? party.map(x=>({date:x.date,partyId:x.partyGlobalId,accountCode:x.accountCode,
      voucher:x.transactionId,transactionType:x.transactionType,narration:x.narration,debit:R(x.debit),credit:R(x.credit)}))
      :group(party.map(x=>({partyId:x.partyGlobalId,accountCode:x.accountCode,debit:N(x.debit),credit:N(x.credit)})),['partyId','accountCode'],['debit','credit']).map(x=>({...x,netMovement:R(x.debit-x.credit)}));
    summary={rows:rows.length,...sum(rows,['debit','credit'])};source='Verified LedgerEntry';
    note='Selected-period verified journal movements only. Historical outstanding requires the authoritative opening balances and prior-period allocation; net movement is NOT full outstanding.';
  } else if(kind==='cash-flow') {
    const [receipts,payments]=await Promise.all([
      read(f.Receipt,{...base,date:period.cutoff,status:'POSTED'}),
      read(f.Payment,{...base,date:period.cutoff,status:'POSTED'})
    ]);
    rows=[...receipts.map(x=>({date:x.date,voucher:x.receiptNo,type:'RECEIPT',party:x.partyNameSnapshot||x.customerGlobalId,
      mode:x.mode||'',receipt:R(x.amount),payment:0})),
      ...payments.map(x=>({date:x.date,voucher:x.paymentNo,type:'PAYMENT',party:x.partyNameSnapshot||x.partyGlobalId,
        mode:x.mode||'',receipt:0,payment:R(x.amount)}))].sort((a,b)=>new Date(b.date)-new Date(a.date));
    summary={receipts:receipts.length,payments:payments.length,...sum(rows,['receipt','payment']),netMovement:R(rows.reduce((s,x)=>s+x.receipt-x.payment,0))};
    source='Posted Receipt and Payment';
  } else if (['customers','customer-health','customer-credit'].includes(kind)) {
    const links = await read(src.CustomerLink,{tenantKey},{localName:1});
    let movement=new Map();
    if(kind==='customer-credit') {
      const raw=await read(f.LedgerEntry,{...base,date:period.ytd,status:'POSTED',accountCode:'SYS_SUNDRY_DEBTORS'});
      const clean=(await inspectBankLedgerRows({tenantKey,financialYear,rows:raw})).rows;
      for(const x of clean){const id=T(x.partyGlobalId);movement.set(id,R(N(movement.get(id))+N(x.debit)-N(x.credit)));}
    }
    rows=links.map(x=>({party:x.localName||x.displayIdentifier,partyId:x.globalCustomerId,status:x.status,
      salesperson:x.salespersonId||'',paymentType:x.paymentType,creditDays:N(x.creditDays),creditLimit:R(x.creditLimit),
      ...(kind==='customer-health'?{grade:x.gradeCode||'',gstStatus:x.gstStatus||'',registrationType:x.registrationType||''}:{}),
      ...(kind==='customer-credit'?{fyToDateReceivableMovement:R(movement.get(T(x.globalCustomerId))||0)}:{}) }));
    summary={parties:rows.length,...sum(rows,kind==='customer-credit'?['creditLimit','fyToDateReceivableMovement']:['creditLimit'])};
    source=kind==='customer-credit'?'CustomerLink + posted debtor journal':'CustomerLink';
    note=kind==='customer-credit'?'FY-to-date receivable movement excludes prior-FY opening balances; do not treat it as final total credit exposure.':'Current master data, not a historical monthly snapshot.';
  } else if(kind==='lead-funnel') {
    const leads=await read(src.Lead,{tenantKey},{createdAt:-1});
    rows=group(leads.map(x=>({stage:x.stage||'NEW',priority:x.priority||'NORMAL',salesperson:x.assignedUserId||'',countLead:1})),['stage','priority','salesperson'],['countLead']);
    summary={leads:leads.length,groups:rows.length};source='Lead';note='Current lead stages, not a historical month-end snapshot.';
  } else if(kind==='transporters') {
    const docs=await read(src.Transporter,{tenantKey},{name:1});
    rows=docs.map(x=>({name:x.name||x.transporterName||x.globalTransporterId||'',
      id:x.globalTransporterId||String(x._id),status:x.status||'',city:x.city||'',gstin:x.gstin||''}));
    summary={transporters:rows.length};source='Transporter';note='Current transporter directory.';
  } else if(['products','barcodes'].includes(kind)) {
    const docs=await read(src.Product,{tenantKey},{name:1});
    rows=docs.filter(x=>kind!=='barcodes'||T(x.barcode)).map(x=>({sku:x.sku,product:x.name,barcode:x.barcode||'',
      category:x.category,warehouse:x.warehouseId,currentQty:N(x.currentStock),availableQty:R(N(x.currentStock)-N(x.reservedStock)),
      averagePurchaseRate:R(x.averagePurchasePrice),landedRate:R(x.landedCost),salePrice:R(x.salePrice),status:x.status}));
    summary={products:rows.length,...sum(rows,['currentQty','availableQty'])};source='Product';note='Current product master, not a historical stock snapshot.';
  } else if(kind==='staff') {
    const docs=await read(src.Employee,{tenantKey},{name:1});
    rows=docs.map(x=>({employeeId:x.employeeId,name:x.name,department:x.department,designation:x.designation,
      branch:x.branch,joiningDate:x.joiningDate,status:x.status}));
    summary={staff:rows.length};source='Employee';note='Current staff directory; salary and bank details excluded.';
  } else if(kind.startsWith('hr-')||kind.startsWith('prod-')) {
    const app=kind.startsWith('hr-')?'hr':'production';
    const resource=kind.startsWith('hr-') ? kind.slice(3) : kind.slice(5);
    const resourceAlternatives = {payroll:['payroll','salary','payslip'],attendance:['attendance'],leave:['leave','leaves'],
      execution:['execution','production-execution','production'],wip:['wip','work-in-progress'],
      quality:['quality','qc','rejection'],maintenance:['maintenance','downtime','machine-downtime']};
    const docs=await read(src.GenericRecord,{tenantKey,app,resource:{$in:resourceAlternatives[resource]||[resource]},
      $or:[{date:period.cutoff},{date:null,createdAt:period.cutoff}]},{date:-1});
    rows=docs.map(x=>({date:x.date||x.createdAt,reference:x.reference||'',title:x.title||'',status:x.status||'',
      amount:R(x.amount),quantity:N(x.quantity),assignedTo:x.assignedTo||'',...Object.fromEntries(Object.entries(x.data||{}).filter(([k])=>!/password|secret|token|aadhaar|bank/i.test(k) && !['date','amount','quantity','status','reference','title','assignedTo'].includes(k)))}));
    summary={records:rows.length,...sum(rows,['amount','quantity'])};source=`GenericRecord ${app}/${resource}`;
    note='Shows V2 generic module records recorded for this period; it does not invent unrecorded attendance, machine or production values.';
  }
  return {name,financialYear,startDate:period.from,endDate:period.to,generatedAt:new Date(),source,
    implementation:'V2_LIVE',note,summary,rows,recordCount:rows.length,
    emptyReason:rows.length?null:`No matching ${source||name} records for ${period.from} to ${period.to}. Check Full FY, another month or the source module.`,
    branding:{footer:'This page is generated by the Rupioo Global System.'}};
}
