import { financialModels } from "./accountingService.js";
import { CompanyProfile, CustomerLink, GenericRecord } from "../models/index.js";

const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (v) => Math.round(N(v) * 100) / 100;
const text = (v) => String(v ?? "").trim();
const upper = (v) => text(v).toUpperCase();
const iso = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};
const monthLabel = (v) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
};
const gstStateCode = (gstin) => (/^\d{2}[A-Z0-9]{13}$/.test(upper(gstin)) ? upper(gstin).slice(0, 2) : "");

function dateQuery(startDate, endDate) {
  const out = {};
  if (startDate) {
    const d = new Date(`${startDate}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) out.$gte = d;
  }
  if (endDate) {
    const d = new Date(`${endDate}T23:59:59.999Z`);
    if (!Number.isNaN(d.getTime())) out.$lte = d;
  }
  return Object.keys(out).length ? out : null;
}

function statusQuery() {
  // V2's accounting equivalent of the old-DMS "Completed" invoice is POSTED.
  return { $in: ["POSTED", "COMPLETED"] };
}

function partyAddressState(link = {}) {
  const addresses = Array.isArray(link?.addresses) ? link.addresses : [];
  const billing = addresses.find((x) => upper(x?.type) === "BILLING") || addresses[0] || {};
  return text(billing?.state || link?.ownerState);
}

async function context(tenantKey, financialYear, startDate, endDate, reportContext) {
  if (reportContext) return reportContext;
  const { SalesInvoice, PurchaseInvoice } = financialModels(tenantKey, financialYear);
  const dq = dateQuery(startDate, endDate);
  const invoiceFilter = { tenantKey, financialYear, status: statusQuery(), ...(dq ? { date: dq } : {}) };
  const [sales, purchases, company] = await Promise.all([
    SalesInvoice.find(invoiceFilter).sort({ date: 1, invoiceNo: 1 }).lean(),
    PurchaseInvoice.find(invoiceFilter).sort({ date: 1, invoiceNo: 1 }).lean(),
    CompanyProfile.findOne({ tenantKey }).lean(),
  ]);
  const ids = Array.from(new Set([
    ...sales.map((x) => text(x.customerGlobalId)),
    ...purchases.map((x) => text(x.supplierGlobalId)),
  ].filter(Boolean)));
  const links = ids.length ? await CustomerLink.find({ tenantKey, globalCustomerId: { $in: ids } }).lean() : [];
  const linkMap = new Map(links.map((x) => [text(x.globalCustomerId), x]));
  return { sales, purchases, company: company || {}, linkMap };
}

function partyMeta(inv, linkMap, side = "sales") {
  const id = text(side === "sales" ? inv.customerGlobalId : inv.supplierGlobalId);
  const link = linkMap.get(id) || {};
  const gstin = upper(side === "sales" ? inv.gstinSnapshot : inv.supplierGstinSnapshot) || (text(link.displayIdentifier).length === 15 ? upper(link.displayIdentifier) : "");
  const name = text(side === "sales" ? inv.customerNameSnapshot : inv.supplierNameSnapshot) || text(link.localName) || "-";
  const state = partyAddressState(link);
  const reg = upper(link.registrationType);
  const registered = gstin.length === 15 && !["UNREGISTERED", "URD", "NONE"].includes(reg);
  return { id, link, gstin, name, state, stateCode: gstStateCode(gstin), registered };
}

function isInterState({ company, party, explicitGstType = "" }) {
  if (upper(explicitGstType) === "IGST") return true;
  const companyCode = gstStateCode(company?.gstin);
  if (companyCode && party?.stateCode) return companyCode !== party.stateCode;
  const companyState = upper(company?.state);
  const partyState = upper(party?.state);
  return Boolean(companyState && partyState && companyState !== partyState);
}

function allocateByRate(inv, interState) {
  const items = Array.isArray(inv?.items) ? inv.items : [];
  const subtotal = r2(items.reduce((s, x) => s + Math.max(0, N(x?.taxable)), 0));
  const discount = Math.min(subtotal, Math.max(0, N(inv?.billDiscount)));
  const charges = Math.max(0, N(inv?.otherCharges));
  let maxRate = 0;
  const groups = new Map();
  for (const it of items) {
    const rate = Math.max(0, N(it?.gstRateSnapshot));
    const base = Math.max(0, N(it?.taxable));
    maxRate = Math.max(maxRate, rate);
    const share = subtotal > 0 ? base / subtotal : 0;
    const taxable = r2(Math.max(0, base - discount * share));
    const key = String(rate);
    const row = groups.get(key) || { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    row.taxable = r2(row.taxable + taxable);
    groups.set(key, row);
  }
  if (charges > 0) {
    const key = String(maxRate);
    const row = groups.get(key) || { rate: maxRate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    row.taxable = r2(row.taxable + charges);
    groups.set(key, row);
  }
  for (const row of groups.values()) {
    const tax = r2(row.taxable * row.rate / 100);
    if (interState) row.igst = tax;
    else {
      row.cgst = r2(tax / 2);
      row.sgst = r2(tax - row.cgst);
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.rate - b.rate);
}

function invoiceTotalsFromRateGroups(groups = [], inv = {}) {
  return {
    taxable: r2(groups.reduce((s, x) => s + N(x.taxable), 0)),
    cgst: r2(groups.reduce((s, x) => s + N(x.cgst), 0)),
    sgst: r2(groups.reduce((s, x) => s + N(x.sgst), 0)),
    igst: r2(groups.reduce((s, x) => s + N(x.igst), 0)),
    roundOff: r2(inv?.roundOff),
    grand: r2(inv?.grandTotal),
  };
}

async function creditDebitNotes(tenantKey, startDate, endDate, linkMap, company) {
  const dq = dateQuery(startDate, endDate);
  const docs = await GenericRecord.find({ tenantKey, app: "dms", resource: { $in: ["credit-notes", "debit-notes"] }, ...(dq ? { date: dq } : {}) }).sort({ date: 1 }).lean();
  return docs.map((x) => {
    const d = x?.data || {};
    const globalId = text(d.customerGlobalId || d.partyGlobalId || d.supplierGlobalId);
    const link = linkMap.get(globalId) || {};
    const gstin = upper(d.gstin || d.gstNumber || (text(link.displayIdentifier).length === 15 ? link.displayIdentifier : ""));
    const state = text(d.state || partyAddressState(link));
    const party = { gstin, state, stateCode: gstStateCode(gstin) };
    const registered = gstin.length === 15;
    return {
      id: String(x._id),
      noteCategory: registered ? "CDNR" : "CDNUR",
      urType: registered ? "" : "B2CL",
      recipientGSTIN: gstin,
      receiverName: text(d.partyName || d.customerName || link.localName || x.title) || "-",
      noteNumber: text(x.reference) || String(x._id),
      noteDate: iso(x.date || x.createdAt),
      noteType: upper(d.noteType) === "D" || x.resource === "debit-notes" ? "D" : "C",
      placeOfSupply: gstin ? `${gstStateCode(gstin)}-${state}` : state || "-",
      noteValue: r2(d.grandTotal ?? x.amount),
      rate: r2(d.gstRate ?? d.rate),
      taxableValue: r2(d.taxableValue ?? d.taxable ?? x.amount),
      isInterState: isInterState({ company, party }),
    };
  });
}

export async function buildGstr1({ tenantKey, financialYear, startDate, endDate, reportContext }) {
  const ctx = await context(tenantKey, financialYear, startDate, endDate, reportContext);
  const sections = { B2B: [], B2CL: [], B2CS: [], CDNR: [], CDNUR: [] };
  for (const inv of ctx.sales) {
    const party = partyMeta(inv, ctx.linkMap, "sales");
    const inter = isInterState({ company: ctx.company, party, explicitGstType: inv.gstType });
    const rateRows = allocateByRate(inv, inter);
    const category = party.registered ? "B2B" : N(inv.grandTotal) > 50000 ? "B2CL" : "B2CS";
    const totals = invoiceTotalsFromRateGroups(rateRows, inv);
    rateRows.forEach((g, index) => sections[category].push({
      rowId: `${inv._id}-${g.rate}-${index}`,
      invoiceId: String(inv._id), invoiceNo: text(inv.invoiceNo), invoiceDate: iso(inv.date),
      partyName: party.name, gstin: party.gstin, placeOfSupply: party.gstin ? `${party.stateCode}-${party.state || ""}` : party.state || "-",
      rate: r2(g.rate), taxableValue: r2(g.taxable), cgst: r2(g.cgst), sgst: r2(g.sgst), igst: r2(g.igst),
      roundOff: index === 0 ? totals.roundOff : 0, grandTotal: index === 0 ? totals.grand : 0,
      invoiceValue: index === 0 ? r2(inv.grandTotal) : 0, month: monthLabel(inv.date),
    }));
  }
  const notes = await creditDebitNotes(tenantKey, startDate, endDate, ctx.linkMap, ctx.company);
  sections.CDNR = notes.filter((x) => x.noteCategory === "CDNR");
  sections.CDNUR = notes.filter((x) => x.noteCategory === "CDNUR");
  return { report: "GSTR1", financialYear, generatedAt: new Date(), sections };
}

export async function buildGstr2b({ tenantKey, financialYear, startDate, endDate, reportContext }) {
  const ctx = await context(tenantKey, financialYear, startDate, endDate, reportContext);
  const rows = ctx.purchases.map((inv, i) => {
    const party = partyMeta(inv, ctx.linkMap, "purchase");
    const inter = isInterState({ company: ctx.company, party });
    const groups = allocateByRate(inv, inter);
    const totals = invoiceTotalsFromRateGroups(groups, inv);
    const rates = groups.map((x) => x.rate).filter((v, idx, a) => a.indexOf(v) === idx).sort((a, b) => a - b);
    const reverseCharge = N(inv.transportationCost) > 0 || upper(inv.purchaseType).includes("REVERSE");
    return {
      srNo: i + 1, purchaseId: String(inv._id), supplierGSTIN: party.gstin || "-", supplierName: party.name,
      invoiceNo: text(inv.invoiceNo) || "-", invoiceDate: iso(inv.date), invoiceValue: r2(inv.grandTotal), roundOff: totals.roundOff, taxableValue: r2(totals.taxable),
      placeOfSupply: party.state || (party.stateCode ? party.stateCode : "-"), reverseCharge: reverseCharge ? "Y" : "N",
      gstRate: rates.map((x) => `${r2(x)}%`).join(", ") || "-", igstAmount: totals.igst, cgstAmount: totals.cgst, sgstAmount: totals.sgst,
      eligibleITC: N(inv.taxTotal) > 0 ? "Yes" : "No", reasonForIneligibility: "-", month: monthLabel(inv.date), registrationType: upper(party.link?.registrationType),
    };
  }).filter((r) => r.supplierGSTIN !== "-" && r.registrationType === "REGULAR").map(({ registrationType, ...row }, index) => ({ ...row, srNo:index+1 }));
  const totals = rows.reduce((a, r) => ({ invoiceValue:r2(a.invoiceValue+r.invoiceValue), taxableValue:r2(a.taxableValue+r.taxableValue), igst:r2(a.igst+r.igstAmount), cgst:r2(a.cgst+r.cgstAmount), sgst:r2(a.sgst+r.sgstAmount) }), { invoiceValue:0, taxableValue:0, igst:0, cgst:0, sgst:0 });
  return { report: "GSTR2B", financialYear, generatedAt: new Date(), rows, totals };
}

export async function buildGstr3b({ tenantKey, financialYear, startDate, endDate, reportContext }) {
  const ctx = await context(tenantKey, financialYear, startDate, endDate, reportContext);
  let s = { taxable:0, igst:0, cgst:0, sgst:0, roundOff:0, grand:0 }, p = { taxable:0, igst:0, cgst:0, sgst:0, roundOff:0, grand:0 };
  for (const inv of ctx.sales) {
    const party = partyMeta(inv, ctx.linkMap, "sales");
    const groups = allocateByRate(inv, isInterState({ company:ctx.company, party, explicitGstType:inv.gstType }));
    const t = invoiceTotalsFromRateGroups(groups, inv);
    s = { taxable:r2(s.taxable+t.taxable), igst:r2(s.igst+t.igst), cgst:r2(s.cgst+t.cgst), sgst:r2(s.sgst+t.sgst), roundOff:r2(s.roundOff+t.roundOff), grand:r2(s.grand+t.grand) };
  }
  for (const inv of ctx.purchases) {
    const party = partyMeta(inv, ctx.linkMap, "purchase");
    const groups = allocateByRate(inv, isInterState({ company:ctx.company, party }));
    const t = invoiceTotalsFromRateGroups(groups, inv);
    p = { taxable:r2(p.taxable+t.taxable), igst:r2(p.igst+t.igst), cgst:r2(p.cgst+t.cgst), sgst:r2(p.sgst+t.sgst), roundOff:r2(p.roundOff+t.roundOff), grand:r2(p.grand+t.grand) };
  }
  const natureOfSupplies = [
    ["Outward Taxable Supplies (other than zero-rated, nil-rated, and exempted)",s],
    ["Outward Taxable Supplies (zero-rated)",{}],
    ["Other Outward Taxable Supplies (Nil-rated, exempted)",{}],
    ["Inward Supplies (liable to reverse charge)",p],
    ["Non-GST Outward Supplies",{}],
  ].map(([label,x])=>({label,taxableValue:r2(x.taxable),integratedTax:r2(x.igst),centralTax:r2(x.cgst),stateTax:r2(x.sgst),cess:0}));
  natureOfSupplies.push({ label:"Total", taxableValue:r2(s.taxable+p.taxable), integratedTax:r2(s.igst+p.igst), centralTax:r2(s.cgst+p.cgst), stateTax:r2(s.sgst+p.sgst), cess:0 });
  // Preserve old-DMS structure: Eligible ITC existed as a separate table and its rows were zeroed.
  const eligibleITC = ["Import of Goods","Import of Services","Inward Supplies liable to reverse charge (other than 1 & 2 above)","Inward Supplies from ISD","All Other ITC","Total"].map(label=>({label,taxableValue:0,integratedTax:0,centralTax:0,stateTax:0,cess:0}));
  return { report:"GSTR3B", financialYear, generatedAt:new Date(), natureOfSupplies, eligibleITC, sourceTotals:{ sales:s, purchases:p } };
}

function hsnBucketForInvoice(inv, party, company, side = "sales") {
  const inter = side === "sales" ? isInterState({ company, party, explicitGstType:inv.gstType }) : isInterState({ company, party });
  const items = Array.isArray(inv.items) ? inv.items : [];
  const subtotal = r2(items.reduce((s,x)=>s+Math.max(0,N(x.taxable)),0));
  const discount = Math.min(subtotal,Math.max(0,N(inv.billDiscount)));
  const map = new Map();
  let maxRate=0;
  for (const it of items) {
    const rate=Math.max(0,N(it.gstRateSnapshot)),base=Math.max(0,N(it.taxable)); maxRate=Math.max(maxRate,rate);
    const adjusted=r2(Math.max(0,base-(subtotal>0?discount*(base/subtotal):0)));
    const tax=r2(adjusted*rate/100); const hsn=text(it.hsnSnapshot)||"-",uqc=text(it.unit)||"",key=`${hsn}|${rate}|${uqc}`;
    const row=map.get(key)||{HSN_Code:hsn,Product_Desc:text(it.nameSnapshot),uqc,gstPercentage:rate,qty:0,taxableAmount:0,cgstAmt:0,sgstAmt:0,igstAmt:0,cessAmount:0,grandTotal:0};
    row.qty=r2(row.qty+N(it.qty)); row.taxableAmount=r2(row.taxableAmount+adjusted);
    if(inter) row.igstAmt=r2(row.igstAmt+tax); else {const c=r2(tax/2);row.cgstAmt=r2(row.cgstAmt+c);row.sgstAmt=r2(row.sgstAmt+(tax-c));}
    row.grandTotal=r2(row.taxableAmount+row.cgstAmt+row.sgstAmt+row.igstAmt); map.set(key,row);
  }
  const charges=Math.max(0,N(inv.otherCharges));
  if(charges>0){const key=`CHARGES|${maxRate}|`;const tax=r2(charges*maxRate/100);const row={HSN_Code:`CHARGES @ ${r2(maxRate)}%`,Product_Desc:"OTHER CHARGES",uqc:"",gstPercentage:maxRate,qty:0,taxableAmount:r2(charges),cgstAmt:0,sgstAmt:0,igstAmt:0,cessAmount:0,grandTotal:0};if(inter)row.igstAmt=tax;else{row.cgstAmt=r2(tax/2);row.sgstAmt=r2(tax-row.cgstAmt);}row.grandTotal=r2(charges+tax);map.set(key,row);}
  return Array.from(map.values());
}

export async function buildHsnReport({ tenantKey, financialYear, startDate, endDate, reportContext }) {
  const ctx=await context(tenantKey,financialYear,startDate,endDate,reportContext);const buckets={Regular:new Map(),UnRegister:new Map()};
  const salesMonthMap=new Map();
  for(const inv of ctx.sales){
    const party=partyMeta(inv,ctx.linkMap,"sales"),bucket=party.registered?"Regular":"UnRegister",rows=hsnBucketForInvoice(inv,party,ctx.company,"sales");
    for(const row of rows){const key=`${row.HSN_Code}|${row.gstPercentage}|${row.uqc}`,prev=buckets[bucket].get(key)||{...row,qty:0,taxableAmount:0,cgstAmt:0,sgstAmt:0,igstAmt:0,cessAmount:0,grandTotal:0};for(const k of ["qty","taxableAmount","cgstAmt","sgstAmt","igstAmt","cessAmount","grandTotal"])prev[k]=r2(prev[k]+N(row[k]));buckets[bucket].set(key,prev);}
    const ml=monthLabel(inv.date),g=allocateByRate(inv,isInterState({company:ctx.company,party,explicitGstType:inv.gstType})),t=invoiceTotalsFromRateGroups(g,inv),m=salesMonthMap.get(ml)||{month:ml,taxable:0,cgst:0,sgst:0,igst:0,roundOff:0,grand:0};for(const k of ["taxable","cgst","sgst","igst","roundOff","grand"])m[k]=r2(m[k]+N(t[k]));salesMonthMap.set(ml,m);
  }
  const regular=Array.from(buckets.Regular.values()).sort((a,b)=>String(a.HSN_Code).localeCompare(String(b.HSN_Code))||a.gstPercentage-b.gstPercentage);
  const unregister=Array.from(buckets.UnRegister.values()).sort((a,b)=>String(a.HSN_Code).localeCompare(String(b.HSN_Code))||a.gstPercentage-b.gstPercentage);
  const totalsOf=(rows)=>rows.reduce((a,r)=>{for(const k of ["qty","taxableAmount","cgstAmt","sgstAmt","igstAmt","cessAmount","grandTotal"])a[k]=r2(a[k]+N(r[k]));return a;},{qty:0,taxableAmount:0,cgstAmt:0,sgstAmt:0,igstAmt:0,cessAmount:0,grandTotal:0});
  const all=[...regular,...unregister],allTotals=totalsOf(all),invoiceRoundOff=r2(ctx.sales.reduce((s,x)=>s+N(x.roundOff),0)),invoiceGrand=r2(ctx.sales.reduce((s,x)=>s+N(x.grandTotal),0));
  return {report:"HSN",financialYear,generatedAt:new Date(),regular,unregister,totals:{regular:totalsOf(regular),unregister:totalsOf(unregister),all:{...allTotals,roundOff:invoiceRoundOff,invoiceGrand}},reconciliation:{hsn:{taxable:allTotals.taxableAmount,cgst:allTotals.cgstAmt,sgst:allTotals.sgstAmt,igst:allTotals.igstAmt,roundOff:invoiceRoundOff,grand:r2(allTotals.grandTotal+invoiceRoundOff)},sales:{taxable:r2(ctx.sales.reduce((s,x)=>s+N(x.taxableTotal),0)),cgst:r2(Array.from(salesMonthMap.values()).reduce((s,x)=>s+x.cgst,0)),sgst:r2(Array.from(salesMonthMap.values()).reduce((s,x)=>s+x.sgst,0)),igst:r2(Array.from(salesMonthMap.values()).reduce((s,x)=>s+x.igst,0)),roundOff:invoiceRoundOff,grand:invoiceGrand},months:Array.from(salesMonthMap.values())}};
}

export async function buildInputOutput({ tenantKey, financialYear, startDate, endDate, reportContext }) {
  const ctx=await context(tenantKey,financialYear,startDate,endDate,reportContext);const rows=[];
  for(const inv of ctx.purchases){const party=partyMeta(inv,ctx.linkMap,"purchase"),g=allocateByRate(inv,isInterState({company:ctx.company,party})),t=invoiceTotalsFromRateGroups(g,inv),totalInput=r2(t.cgst+t.sgst+t.igst);rows.push({type:"INPUT",partyName:party.name,invoiceNo:inv.invoiceNo,date:iso(inv.date),invoiceValue:r2(inv.grandTotal),roundOff:t.roundOff,taxableValue:t.taxable,cgstInput:t.cgst,sgstInput:t.sgst,igstInput:t.igst,totalInput,cgstOutput:0,sgstOutput:0,igstOutput:0,totalOutput:0,availableGST:totalInput});}
  for(const inv of ctx.sales){const party=partyMeta(inv,ctx.linkMap,"sales"),g=allocateByRate(inv,isInterState({company:ctx.company,party,explicitGstType:inv.gstType})),t=invoiceTotalsFromRateGroups(g,inv),totalOutput=r2(t.cgst+t.sgst+t.igst);rows.push({type:"OUTPUT",partyName:party.name,invoiceNo:inv.invoiceNo,date:iso(inv.date),invoiceValue:r2(inv.grandTotal),roundOff:t.roundOff,taxableValue:t.taxable,cgstInput:0,sgstInput:0,igstInput:0,totalInput:0,cgstOutput:t.cgst,sgstOutput:t.sgst,igstOutput:t.igst,totalOutput,availableGST:r2(-totalOutput)});}
  rows.sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.invoiceNo).localeCompare(String(b.invoiceNo)));
  const totals=rows.reduce((a,r)=>{for(const k of ["roundOff","invoiceValue","taxableValue","cgstInput","sgstInput","igstInput","totalInput","cgstOutput","sgstOutput","igstOutput","totalOutput"])a[k]=r2(a[k]+N(r[k]));return a;},{roundOff:0,invoiceValue:0,taxableValue:0,cgstInput:0,sgstInput:0,igstInput:0,totalInput:0,cgstOutput:0,sgstOutput:0,igstOutput:0,totalOutput:0});totals.availableGST=r2(totals.totalInput-totals.totalOutput);
  return {report:"GST_INPUT_OUTPUT",financialYear,generatedAt:new Date(),rows,totals};
}

export async function buildTaxReport({ tenantKey, financialYear, startDate, endDate, reportContext }) {
  const io=await buildInputOutput({tenantKey,financialYear,startDate,endDate,reportContext});
  return {report:"TAX",financialYear,generatedAt:new Date(),filterTotals:{taxableValue:io.totals.taxableValue,cgst:r2(io.totals.cgstInput+io.totals.cgstOutput),sgst:r2(io.totals.sgstInput+io.totals.sgstOutput),igst:r2(io.totals.igstInput+io.totals.igstOutput),roundOff:io.totals.roundOff,grandTotal:io.totals.invoiceValue},rows:[{totalTaxInput:r2(io.totals.totalInput),totalTaxOut:r2(io.totals.totalOutput),BalanceTax:r2(io.totals.availableGST)}]};
}

function annualRange(financialYear) {
  const y = Number(String(financialYear || "").slice(0, 4));
  if (!Number.isFinite(y) || y < 2017) throw Object.assign(new Error("Invalid financial year"), { statusCode: 400 });
  return { startDate: `${y}-04-01`, endDate: `${y + 1}-03-31` };
}

function addTax(target, taxable = 0, cgst = 0, sgst = 0, igst = 0, invoiceValue = 0) {
  target.taxableValue = r2(N(target.taxableValue) + N(taxable));
  target.cgst = r2(N(target.cgst) + N(cgst));
  target.sgst = r2(N(target.sgst) + N(sgst));
  target.igst = r2(N(target.igst) + N(igst));
  target.totalTax = r2(N(target.cgst) + N(target.sgst) + N(target.igst));
  target.invoiceValue = r2(N(target.invoiceValue) + N(invoiceValue));
  return target;
}

function mergeHsnRows(target, rows = []) {
  for (const row of rows) {
    const key = `${text(row.HSN_Code) || "-"}|${N(row.gstPercentage)}|${text(row.uqc)}`;
    const prev = target.get(key) || {
      HSN_Code: text(row.HSN_Code) || "-", Product_Desc: text(row.Product_Desc), uqc: text(row.uqc), gstPercentage: r2(row.gstPercentage),
      qty: 0, taxableAmount: 0, cgstAmt: 0, sgstAmt: 0, igstAmt: 0, cessAmount: 0, grandTotal: 0,
    };
    for (const k of ["qty","taxableAmount","cgstAmt","sgstAmt","igstAmt","cessAmount","grandTotal"]) prev[k] = r2(N(prev[k]) + N(row[k]));
    target.set(key, prev);
  }
}

function reconRow(particular, sourceA, sourceB, sourceALabel = "Books", sourceBLabel = "GST Report") {
  const a = r2(sourceA), b = r2(sourceB), difference = r2(a - b);
  return { particular, sourceALabel, sourceA:a, sourceBLabel, sourceB:b, difference, status: Math.abs(difference) <= 0.01 ? "MATCH" : "REVIEW" };
}

export async function buildGstr9({ tenantKey, financialYear }) {
  const { startDate, endDate } = annualRange(financialYear);
  const ctx = await context(tenantKey, financialYear, startDate, endDate);
  const outward = {
    b2b: { particular: "4A/4B - Registered taxable outward supplies", taxableValue:0,cgst:0,sgst:0,igst:0,totalTax:0,invoiceValue:0 },
    b2c: { particular: "4A/4B - Unregistered taxable outward supplies", taxableValue:0,cgst:0,sgst:0,igst:0,totalTax:0,invoiceValue:0 },
    zero: { particular: "5 - Zero/Nil rated outward supplies (0% rate in books)", taxableValue:0,cgst:0,sgst:0,igst:0,totalTax:0,invoiceValue:0 },
  };
  const salesBooks = { taxableValue:0,cgst:0,sgst:0,igst:0,totalTax:0,invoiceValue:0 };
  const outwardHsn = new Map();
  for (const inv of ctx.sales) {
    const party = partyMeta(inv, ctx.linkMap, "sales");
    const inter = isInterState({ company: ctx.company, party, explicitGstType: inv.gstType });
    const groups = allocateByRate(inv, inter);
    const totals = invoiceTotalsFromRateGroups(groups, inv);
    addTax(salesBooks, totals.taxable, totals.cgst, totals.sgst, totals.igst, inv.grandTotal);
    let invoiceValueAllocated = false;
    for (const group of groups) {
      const bucket = N(group.rate) === 0 ? outward.zero : (party.registered ? outward.b2b : outward.b2c);
      addTax(bucket, group.taxable, group.cgst, group.sgst, group.igst, invoiceValueAllocated ? 0 : inv.grandTotal);
      invoiceValueAllocated = true;
    }
    mergeHsnRows(outwardHsn, hsnBucketForInvoice(inv, party, ctx.company, "sales"));
  }

  const notes = await creditDebitNotes(tenantKey, startDate, endDate, ctx.linkMap, ctx.company);
  const noteRows = notes.map((note) => {
    const tax = r2(N(note.taxableValue) * N(note.rate) / 100);
    const sign = upper(note.noteType) === "C" ? -1 : 1;
    const igst = note.isInterState ? r2(tax * sign) : 0;
    const cgst = note.isInterState ? 0 : r2((tax / 2) * sign);
    const sgst = note.isInterState ? 0 : r2((tax - tax / 2) * sign);
    return {
      noteType: upper(note.noteType) === "C" ? "CREDIT NOTE" : "DEBIT NOTE", noteNumber: note.noteNumber, noteDate: note.noteDate,
      partyName: note.receiverName, taxableValue: r2(N(note.taxableValue) * sign), cgst, sgst, igst, totalTax: r2(cgst + sgst + igst), noteValue: r2(N(note.noteValue) * sign),
    };
  });
  const noteTotals = noteRows.reduce((a, row) => addTax(a, row.taxableValue, row.cgst, row.sgst, row.igst, row.noteValue), { taxableValue:0,cgst:0,sgst:0,igst:0,totalTax:0,invoiceValue:0 });

  const purchaseBooks = { taxableValue:0,cgst:0,sgst:0,igst:0,totalTax:0,invoiceValue:0 };
  const gstr2bLike = { taxableValue:0,cgst:0,sgst:0,igst:0,totalTax:0,invoiceValue:0 };
  const inwardHsn = new Map();
  for (const inv of ctx.purchases) {
    const party = partyMeta(inv, ctx.linkMap, "purchase");
    const groups = allocateByRate(inv, isInterState({ company: ctx.company, party }));
    const totals = invoiceTotalsFromRateGroups(groups, inv);
    addTax(purchaseBooks, totals.taxable, totals.cgst, totals.sgst, totals.igst, inv.grandTotal);
    if (party.registered) addTax(gstr2bLike, totals.taxable, totals.cgst, totals.sgst, totals.igst, inv.grandTotal);
    mergeHsnRows(inwardHsn, hsnBucketForInvoice(inv, party, ctx.company, "purchase"));
  }

  const netTaxableTurnover = r2(salesBooks.taxableValue + noteTotals.taxableValue);
  const outputCgst = r2(salesBooks.cgst + noteTotals.cgst);
  const outputSgst = r2(salesBooks.sgst + noteTotals.sgst);
  const outputIgst = r2(salesBooks.igst + noteTotals.igst);
  const outputTax = r2(outputCgst + outputSgst + outputIgst);
  const purchaseItc = r2(purchaseBooks.cgst + purchaseBooks.sgst + purchaseBooks.igst);
  const twoBItc = r2(gstr2bLike.cgst + gstr2bLike.sgst + gstr2bLike.igst);

  const sections = {
    "Outward Supplies": [outward.b2b, outward.b2c, outward.zero, {
      particular: "TOTAL OUTWARD SUPPLIES", taxableValue: netTaxableTurnover, cgst: outputCgst, sgst: outputSgst, igst: outputIgst,
      totalTax: outputTax, invoiceValue: r2(salesBooks.invoiceValue + noteTotals.invoiceValue),
    }],
    "Credit Debit Notes": noteRows,
    "ITC Summary": [
      { particular: "Purchase books input tax", taxableValue: purchaseBooks.taxableValue, cgst: purchaseBooks.cgst, sgst: purchaseBooks.sgst, igst: purchaseBooks.igst, totalTax: purchaseItc },
      { particular: "GSTR-2B-like eligible registered purchases", taxableValue: gstr2bLike.taxableValue, cgst: gstr2bLike.cgst, sgst: gstr2bLike.sgst, igst: gstr2bLike.igst, totalTax: twoBItc },
      { particular: "ITC difference requiring review", taxableValue: r2(purchaseBooks.taxableValue-gstr2bLike.taxableValue), cgst:r2(purchaseBooks.cgst-gstr2bLike.cgst), sgst:r2(purchaseBooks.sgst-gstr2bLike.sgst), igst:r2(purchaseBooks.igst-gstr2bLike.igst), totalTax:r2(purchaseItc-twoBItc) },
    ],
    "Tax Liability": [
      { taxType:"CGST", liability:outputCgst }, { taxType:"SGST", liability:outputSgst }, { taxType:"IGST", liability:outputIgst }, { taxType:"TOTAL", liability:outputTax },
    ],
    "HSN Outward": Array.from(outwardHsn.values()).sort((a,b)=>String(a.HSN_Code).localeCompare(String(b.HSN_Code))||N(a.gstPercentage)-N(b.gstPercentage)),
    "HSN Inward": Array.from(inwardHsn.values()).sort((a,b)=>String(a.HSN_Code).localeCompare(String(b.HSN_Code))||N(a.gstPercentage)-N(b.gstPercentage)),
    "Annual Reconciliation": [
      reconRow("Taxable turnover", salesBooks.taxableValue, netTaxableTurnover, "Sales Books", "GSTR-9"),
      reconRow("CGST output", salesBooks.cgst, outputCgst, "Sales Books", "GSTR-9"),
      reconRow("SGST output", salesBooks.sgst, outputSgst, "Sales Books", "GSTR-9"),
      reconRow("IGST output", salesBooks.igst, outputIgst, "Sales Books", "GSTR-9"),
      reconRow("Input tax / ITC", purchaseItc, twoBItc, "Purchase Books", "GSTR-2B"),
    ],
  };
  return {
    report:"GSTR9", financialYear, generatedAt:new Date(), period:{startDate,endDate},
    company:{gstin:text(ctx.company?.gstin), legalName:text(ctx.company?.companyName), tradeName:text(ctx.company?.tradeName)},
    summary:{ salesInvoiceCount:ctx.sales.length, purchaseInvoiceCount:ctx.purchases.length, invoiceValue:salesBooks.invoiceValue, taxableTurnover:netTaxableTurnover, cgst:outputCgst, sgst:outputSgst, igst:outputIgst, outputTax, purchaseBooksITC:purchaseItc, gstr2bITC:twoBItc, itcDifference:r2(purchaseItc-twoBItc) },
    sections,
    reviewNotes:[
      "This report is generated from V2 books for annual reconciliation and filing preparation.",
      "ITC reversal/reclaim and tax-payment/challan details require dedicated source records before they can be auto-populated as filed values.",
    ],
  };
}

async function ledgerTaxBooks({ tenantKey, financialYear, startDate, endDate }) {
  const { LedgerEntry } = financialModels(tenantKey, financialYear);
  const dq = dateQuery(startDate, endDate);
  const base = { tenantKey, financialYear, status:"POSTED", ...(dq ? { date:dq } : {}) };
  const rows = await LedgerEntry.aggregate([
    { $match: { ...base, $or:[
      { accountCode:"SYS_SALES", transactionType:{ $in:["SALES_INVOICE","SALES_CREDIT_NOTE"] } },
      { accountCode:"SYS_DUTIES_TAXES", transactionType:{ $in:["SALES_INVOICE","SALES_CREDIT_NOTE","PURCHASE_INVOICE","PURCHASE_DEBIT_NOTE"] } },
    ] } },
    { $group:{ _id:{ accountCode:"$accountCode", transactionType:"$transactionType" }, debit:{ $sum:{ $ifNull:["$debit",0] } }, credit:{ $sum:{ $ifNull:["$credit",0] } } } },
  ]);
  const value = (accountCode, types, side="credit") => r2(rows.filter(x=>x._id.accountCode===accountCode && types.includes(x._id.transactionType)).reduce((s,x)=>s + (side==="credit" ? N(x.credit)-N(x.debit) : N(x.debit)-N(x.credit)),0));
  return {
    salesTurnover:value("SYS_SALES",["SALES_INVOICE","SALES_CREDIT_NOTE"],"credit"),
    outputTax:value("SYS_DUTIES_TAXES",["SALES_INVOICE","SALES_CREDIT_NOTE"],"credit"),
    inputTax:value("SYS_DUTIES_TAXES",["PURCHASE_INVOICE","PURCHASE_DEBIT_NOTE"],"debit"),
  };
}

export async function buildGstr9c({ tenantKey, financialYear }) {
  const { startDate, endDate } = annualRange(financialYear);
  const [g9, books] = await Promise.all([
    buildGstr9({ tenantKey, financialYear }),
    ledgerTaxBooks({ tenantKey, financialYear, startDate, endDate }),
  ]);
  const turnoverDifference = r2(g9.summary.taxableTurnover - books.salesTurnover);
  const taxDifference = r2(g9.summary.outputTax - books.outputTax);
  const itcDifference = r2(g9.summary.gstr2bITC - books.inputTax);
  const statusOf = (v) => Math.abs(N(v)) <= 0.01 ? "MATCH" : "REVIEW";
  const sections = {
    "Turnover Reconciliation": [
      { particular:"Taxable turnover", books:books.salesTurnover, gstr9:g9.summary.taxableTurnover, difference:turnoverDifference, status:statusOf(turnoverDifference) },
    ],
    "Tax Reconciliation": [
      { particular:"Output tax liability", books:books.outputTax, gstr9:g9.summary.outputTax, difference:taxDifference, status:statusOf(taxDifference) },
      { particular:"CGST as per GSTR-9", books:g9.summary.cgst, gstr9:g9.summary.cgst, difference:0, status:"MATCH" },
      { particular:"SGST as per GSTR-9", books:g9.summary.sgst, gstr9:g9.summary.sgst, difference:0, status:"MATCH" },
      { particular:"IGST as per GSTR-9", books:g9.summary.igst, gstr9:g9.summary.igst, difference:0, status:"MATCH" },
    ],
    "ITC Reconciliation": [
      { particular:"Input tax in purchase ledger vs GSTR-2B-like ITC", books:books.inputTax, gstr9:g9.summary.gstr2bITC, difference:itcDifference, status:statusOf(itcDifference) },
      { particular:"Purchase books ITC vs GSTR-2B-like ITC", books:g9.summary.purchaseBooksITC, gstr9:g9.summary.gstr2bITC, difference:g9.summary.itcDifference, status:statusOf(g9.summary.itcDifference) },
    ],
    "Review Items": [
      { area:"Turnover", difference:turnoverDifference, status:statusOf(turnoverDifference) },
      { area:"Tax Liability", difference:taxDifference, status:statusOf(taxDifference) },
      { area:"ITC", difference:itcDifference, status:statusOf(itcDifference) },
    ],
  };
  return {
    report:"GSTR9C", financialYear, generatedAt:new Date(), period:{startDate,endDate}, company:g9.company,
    summary:{ booksTurnover:books.salesTurnover, gstr9Turnover:g9.summary.taxableTurnover, turnoverDifference, booksOutputTax:books.outputTax, gstr9OutputTax:g9.summary.outputTax, taxDifference, booksInputTax:books.inputTax, gstr2bITC:g9.summary.gstr2bITC, itcDifference, overallStatus:[turnoverDifference,taxDifference,itcDifference].every(x=>Math.abs(N(x))<=0.01)?"MATCH":"REVIEW" },
    sections,
    reviewNotes:[
      "GSTR-9C is presented as an internal reconciliation between posted V2 ledgers and the annual GSTR-9 report.",
      "Manual statutory adjustments (for example unbilled revenue, advances, valuation/foreign-exchange adjustments) are not invented by the system; differences remain visible for review.",
    ],
  };
}

export async function buildGstReport(kind,args){
  const key=upper(kind).replace(/[^A-Z0-9]/g,"");
  if(key==="GSTR1")return buildGstr1(args);
  if(key==="GSTR2B")return buildGstr2b(args);
  if(key==="GSTR3B")return buildGstr3b(args);
  if(key==="HSN"||key==="HSNWISE")return buildHsnReport(args);
  if(key==="INPUTOUTPUT"||key==="GSTINPUTOUTPUT")return buildInputOutput(args);
  if(key==="TAX")return buildTaxReport(args);
  if(key==="GSTR9")return buildGstr9(args);
  if(key==="GSTR9C")return buildGstr9c(args);
  throw Object.assign(new Error("Unknown GST report"),{statusCode:404});
}

// All sheets use one source snapshot and exactly the same period.
export async function buildGstReportBundle(args) {
  const reportContext=await context(args.tenantKey,args.financialYear,args.startDate,args.endDate);
  const shared={...args,reportContext};
  const [gstr1,gstr2b,gstr3b,hsn,inputOutput,tax]=await Promise.all([
    buildGstr1(shared),buildGstr2b(shared),buildGstr3b(shared),buildHsnReport(shared),buildInputOutput(shared),buildTaxReport(shared),
  ]);
  return {gstr1,gstr2b,gstr3b,hsn,inputOutput,tax};
}
