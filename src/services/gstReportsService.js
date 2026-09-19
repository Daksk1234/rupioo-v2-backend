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

async function context(tenantKey, financialYear, startDate, endDate) {
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

export async function buildGstr1({ tenantKey, financialYear, startDate, endDate }) {
  const ctx = await context(tenantKey, financialYear, startDate, endDate);
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

export async function buildGstr2b({ tenantKey, financialYear, startDate, endDate }) {
  const ctx = await context(tenantKey, financialYear, startDate, endDate);
  const rows = ctx.purchases.map((inv, i) => {
    const party = partyMeta(inv, ctx.linkMap, "purchase");
    const inter = isInterState({ company: ctx.company, party });
    const groups = allocateByRate(inv, inter);
    const totals = invoiceTotalsFromRateGroups(groups, inv);
    const rates = groups.map((x) => x.rate).filter((v, idx, a) => a.indexOf(v) === idx).sort((a, b) => a - b);
    const reverseCharge = N(inv.transportationCost) > 0 || upper(inv.purchaseType).includes("REVERSE");
    return {
      srNo: i + 1, purchaseId: String(inv._id), supplierGSTIN: party.gstin || "-", supplierName: party.name,
      invoiceNo: text(inv.invoiceNo) || "-", invoiceDate: iso(inv.date), invoiceValue: r2(inv.grandTotal), taxableValue: r2(totals.taxable),
      placeOfSupply: party.state || (party.stateCode ? party.stateCode : "-"), reverseCharge: reverseCharge ? "Y" : "N",
      gstRate: rates.map((x) => `${r2(x)}%`).join(", ") || "-", igstAmount: totals.igst, cgstAmount: totals.cgst, sgstAmount: totals.sgst,
      eligibleITC: N(inv.taxTotal) > 0 ? "Yes" : "No", reasonForIneligibility: "-", month: monthLabel(inv.date), registrationType: upper(party.link?.registrationType),
    };
  }).filter((r) => r.supplierGSTIN !== "-" && r.registrationType === "REGULAR").map(({ registrationType, ...row }) => row);
  const totals = rows.reduce((a, r) => ({ invoiceValue:r2(a.invoiceValue+r.invoiceValue), taxableValue:r2(a.taxableValue+r.taxableValue), igst:r2(a.igst+r.igstAmount), cgst:r2(a.cgst+r.cgstAmount), sgst:r2(a.sgst+r.sgstAmount) }), { invoiceValue:0, taxableValue:0, igst:0, cgst:0, sgst:0 });
  return { report: "GSTR2B", financialYear, generatedAt: new Date(), rows, totals };
}

export async function buildGstr3b({ tenantKey, financialYear, startDate, endDate }) {
  const ctx = await context(tenantKey, financialYear, startDate, endDate);
  let s = { taxable:0, igst:0, cgst:0, sgst:0 }, p = { taxable:0, igst:0, cgst:0, sgst:0 };
  for (const inv of ctx.sales) {
    const party = partyMeta(inv, ctx.linkMap, "sales");
    const groups = allocateByRate(inv, isInterState({ company:ctx.company, party, explicitGstType:inv.gstType }));
    const t = invoiceTotalsFromRateGroups(groups, inv);
    s = { taxable:r2(s.taxable+t.taxable), igst:r2(s.igst+t.igst), cgst:r2(s.cgst+t.cgst), sgst:r2(s.sgst+t.sgst) };
  }
  for (const inv of ctx.purchases) {
    const party = partyMeta(inv, ctx.linkMap, "purchase");
    const groups = allocateByRate(inv, isInterState({ company:ctx.company, party }));
    const t = invoiceTotalsFromRateGroups(groups, inv);
    p = { taxable:r2(p.taxable+t.taxable), igst:r2(p.igst+t.igst), cgst:r2(p.cgst+t.cgst), sgst:r2(p.sgst+t.sgst) };
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

export async function buildHsnReport({ tenantKey, financialYear, startDate, endDate }) {
  const ctx=await context(tenantKey,financialYear,startDate,endDate);const buckets={Regular:new Map(),UnRegister:new Map()};
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

export async function buildInputOutput({ tenantKey, financialYear, startDate, endDate }) {
  const ctx=await context(tenantKey,financialYear,startDate,endDate);const rows=[];
  for(const inv of ctx.purchases){const party=partyMeta(inv,ctx.linkMap,"purchase"),g=allocateByRate(inv,isInterState({company:ctx.company,party})),t=invoiceTotalsFromRateGroups(g,inv),totalInput=r2(t.cgst+t.sgst+t.igst);rows.push({type:"INPUT",partyName:party.name,invoiceNo:inv.invoiceNo,date:iso(inv.date),invoiceValue:r2(inv.grandTotal),taxableValue:t.taxable,cgstInput:t.cgst,sgstInput:t.sgst,igstInput:t.igst,totalInput,cgstOutput:0,sgstOutput:0,igstOutput:0,totalOutput:0,availableGST:totalInput});}
  for(const inv of ctx.sales){const party=partyMeta(inv,ctx.linkMap,"sales"),g=allocateByRate(inv,isInterState({company:ctx.company,party,explicitGstType:inv.gstType})),t=invoiceTotalsFromRateGroups(g,inv),totalOutput=r2(t.cgst+t.sgst+t.igst);rows.push({type:"OUTPUT",partyName:party.name,invoiceNo:inv.invoiceNo,date:iso(inv.date),invoiceValue:r2(inv.grandTotal),taxableValue:t.taxable,cgstInput:0,sgstInput:0,igstInput:0,totalInput:0,cgstOutput:t.cgst,sgstOutput:t.sgst,igstOutput:t.igst,totalOutput,availableGST:r2(-totalOutput)});}
  rows.sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.invoiceNo).localeCompare(String(b.invoiceNo)));
  const totals=rows.reduce((a,r)=>{for(const k of ["invoiceValue","taxableValue","cgstInput","sgstInput","igstInput","totalInput","cgstOutput","sgstOutput","igstOutput","totalOutput"])a[k]=r2(a[k]+N(r[k]));return a;},{invoiceValue:0,taxableValue:0,cgstInput:0,sgstInput:0,igstInput:0,totalInput:0,cgstOutput:0,sgstOutput:0,igstOutput:0,totalOutput:0});totals.availableGST=r2(totals.totalInput-totals.totalOutput);
  return {report:"GST_INPUT_OUTPUT",financialYear,generatedAt:new Date(),rows,totals};
}

export async function buildTaxReport({ tenantKey, financialYear, startDate, endDate }) {
  const io=await buildInputOutput({tenantKey,financialYear,startDate,endDate});
  return {report:"TAX",financialYear,generatedAt:new Date(),rows:[{totalTaxInput:r2(io.totals.totalInput),totalTaxOut:r2(io.totals.totalOutput),BalanceTax:r2(io.totals.availableGST)}]};
}

export async function buildGstReport(kind,args){
  const key=upper(kind).replace(/[^A-Z0-9]/g,"");
  if(key==="GSTR1")return buildGstr1(args);
  if(key==="GSTR2B")return buildGstr2b(args);
  if(key==="GSTR3B")return buildGstr3b(args);
  if(key==="HSN"||key==="HSNWISE")return buildHsnReport(args);
  if(key==="INPUTOUTPUT"||key==="GSTINPUTOUTPUT")return buildInputOutput(args);
  if(key==="TAX")return buildTaxReport(args);
  throw Object.assign(new Error("Unknown GST report"),{statusCode:404});
}
