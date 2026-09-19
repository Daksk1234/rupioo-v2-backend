import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import { BankAccount, CustomerLink, CustomerVisit, GenericRecord, GlobalCustomer, Lead, Product, SalesCompetitorIntel, SalesCrmActivity, SalespersonTrip, SalesRoutePlan, Target, User } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { financialModels, postBalancedEntries } from "../services/accountingService.js";
import { hierarchyVisibilityForUser } from "../services/assignmentHierarchyService.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { getDocumentTemplate } from "../config/documentForms.js";
import { extractDocument, enrichExtractedValues } from "../services/documentAiService.js";
import { saveUploadedFile } from "../services/storageService.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.use(requireAuth);

const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const escapeRx = (v) => clean(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const objectIdText = (v) => /^[a-fA-F0-9]{24}$/.test(clean(v));
const currentFY = (date = new Date()) => {
  const d = new Date(date);
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
};
const fyOf = (req) => clean(req.query.financialYear || req.body?.financialYear) || currentFY();
const startOfDay = (value = new Date()) => {
  const d = new Date(value); d.setHours(0, 0, 0, 0); return d;
};
const addDays = (value, days) => {
  const d = new Date(value); d.setDate(d.getDate() + Math.max(0, Number(days || 0))); return d;
};
const daysBetween = (a, b) => Math.floor((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000);
const primaryContact = (c = {}) => (c.contacts || []).find((x) => x?.primary && x?.active !== false) || (c.contacts || []).find((x) => x?.active !== false) || (c.contacts || [])[0] || {};
const billingAddress = (c = {}) => (c.addresses || []).find((x) => upper(x?.type) === "BILLING") || (c.addresses || [])[0] || {};
const customerName = (c = {}) => clean(c.localName || c.displayIdentifier || "Customer");
const customerMobile = (c = {}) => clean(c.companyContactNumber || c.ownerMobile || primaryContact(c).mobile);
const customerEmail = (c = {}) => clean(primaryContact(c).email);

async function visibility(req) {
  return hierarchyVisibilityForUser(req.auth);
}

async function visibleCustomerFilter(req, extra = {}) {
  const filter = { tenantKey: req.auth.tenantKey, status: { $nin: ["INACTIVE", "DEACTIVATED"] }, ...extra };
  const scope = await visibility(req);
  if (!scope.unrestricted) filter.salespersonId = { $in: scope.userIds };
  return { filter, scope };
}

async function requireVisibleCustomer(req, globalId, { activeOnly = true } = {}) {
  const { filter } = await visibleCustomerFilter(req, { globalCustomerId: clean(globalId) });
  if (activeOnly) filter.status = "ACTIVE";
  const customer = await CustomerLink.findOne(filter).lean();
  if (!customer) {
    const err = new Error("Customer not found or is outside your assigned sales hierarchy");
    err.statusCode = 404;
    throw err;
  }
  return customer;
}

async function globalsFor(ids = []) {
  const unique = [...new Set(ids.map(clean).filter(Boolean))];
  const objectIds = unique.filter(objectIdText);
  if (!unique.length) return new Map();
  const rows = await GlobalCustomer.find({
    $or: [
      { hiddenId: { $in: unique } },
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ],
  }).select("hiddenId legalName tradeName registeredAddress gstins pan mobiles emails globalHealth gstProfile").lean();
  const map = new Map();
  for (const row of rows) {
    map.set(clean(row.hiddenId), row);
    map.set(String(row._id), row);
  }
  return map;
}

function shapeCustomer(c, global = null, financial = {}) {
  const address = billingAddress(c);
  const contact = primaryContact(c);
  const gstin = clean(global?.gstins?.find?.((x) => x?.active !== false)?.value || (clean(c.displayIdentifier).length === 15 ? c.displayIdentifier : ""));
  return {
    id: c.globalCustomerId,
    globalCustomerId: c.globalCustomerId,
    name: customerName(c),
    CompanyName: customerName(c),
    displayIdentifier: c.displayIdentifier,
    gstin,
    gstNumber: gstin,
    pan: clean(global?.pan),
    mobile: customerMobile(c),
    contactNumber: customerMobile(c),
    email: customerEmail(c),
    ownerName: c.ownerName || contact.name || "",
    address: address.address || global?.registeredAddress || "",
    address2: c.address2 || "",
    area: address.area || "",
    city: address.city || "",
    district: address.district || "",
    state: address.state || "",
    pincode: address.pincode || "",
    pinCode: address.pincode || "",
    paymentType: c.paymentType,
    creditDays: num(c.creditDays || c.approvedTerms?.creditDays),
    creditLimit: num(c.creditLimit || c.approvedTerms?.creditLimit),
    graceDays: num(c.graceDays || c.approvedTerms?.graceDays),
    salespersonId: c.salespersonId || "",
    gradeCode: c.gradeCode || "",
    gradeDiscountPct: num(c.gradeDiscountPct),
    status: c.status,
    financial: {
      sales: money(financial.sales),
      invoiceCount: num(financial.invoiceCount),
      receipts: money(financial.receipts),
      outstanding: money(financial.outstanding),
      openPromiseAmount: money(financial.openPromiseAmount),
      lastInvoiceAt: financial.lastInvoiceAt || null,
      lastReceiptAt: financial.lastReceiptAt || null,
    },
  };
}

function openingSigned(customer, financialYear) {
  const p = customer?.accountingProfile || {};
  if (!num(p.openingBalance)) return 0;
  if (clean(p.financialYear) && clean(p.financialYear) !== clean(financialYear)) return 0;
  return upper(p.openingBalanceType) === "CR" ? -num(p.openingBalance) : num(p.openingBalance);
}

async function receivableMap({ tenantKey, financialYear, customerIds }) {
  const ids = [...new Set((customerIds || []).map(clean).filter(Boolean))];
  if (!ids.length) return new Map();
  const { LedgerEntry } = financialModels(tenantKey, financialYear);
  const rows = await LedgerEntry.aggregate([
    { $match: { tenantKey, financialYear, partyGlobalId: { $in: ids }, accountCode: "SYS_SUNDRY_DEBTORS", status: "POSTED" } },
    { $group: { _id: "$partyGlobalId", debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), num(r.debit) - num(r.credit)]));
}

async function markBrokenPromises(PromiseToPay, tenantKey, financialYear, customerIds = null) {
  const filter = {
    tenantKey,
    financialYear,
    status: { $in: ["OPEN", "PARTIAL"] },
    promiseDate: { $lt: startOfDay(new Date()) },
    $expr: { $lt: ["$fulfilledAmount", "$amount"] },
  };
  if (Array.isArray(customerIds) && customerIds.length) filter.customerGlobalId = { $in: customerIds };
  await PromiseToPay.updateMany(filter, { $set: { status: "BROKEN", lastActionAt: new Date() } }).catch(() => {});
}

function allocateReceiptsToInvoices(invoices = [], totalReceipts = 0, creditDays = 0) {
  let available = Math.max(0, num(totalReceipts));
  const today = startOfDay(new Date());
  const oldestFirst = [...invoices].sort((a, b) => new Date(a.date) - new Date(b.date));
  return oldestFirst.map((inv) => {
    const total = Math.max(0, num(inv.grandTotal));
    const applied = Math.min(total, available);
    available = money(available - applied);
    const outstanding = money(total - applied);
    const dueDate = addDays(inv.date, creditDays);
    const diff = daysBetween(today, dueDate);
    const overdueDays = outstanding > 0 && diff > 0 ? diff : 0;
    const dueInDays = outstanding > 0 && diff < 0 ? Math.abs(diff) : 0;
    return {
      _id: String(inv._id),
      invoiceNo: inv.invoiceNo,
      date: inv.date,
      dueDate,
      total: money(total),
      paidAllocated: money(applied),
      outstanding,
      overdueDays,
      dueInDays,
      status: outstanding <= 0 ? "PAID" : overdueDays > 0 ? "OVERDUE" : diff === 0 ? "DUE_TODAY" : "UPCOMING",
      workflowStatus: inv.workflowStatus || inv.status,
    };
  });
}

async function invoiceOutstandingForCustomer({ tenantKey, financialYear, customer, onlyOpen = false }) {
  const { SalesInvoice, Receipt } = financialModels(tenantKey, financialYear);
  const [invoices, receiptAgg] = await Promise.all([
    SalesInvoice.find({ tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" })
      .select("invoiceNo date grandTotal workflowStatus status")
      .sort({ date: 1, createdAt: 1 }).lean(),
    Receipt.aggregate([
      { $match: { tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);
  const bills = allocateReceiptsToInvoices(invoices, receiptAgg[0]?.total || 0, customer.creditDays || customer.approvedTerms?.creditDays || 0);
  return onlyOpen ? bills.filter((x) => x.outstanding > 0) : bills;
}

async function productSuggestions({ tenantKey, financialYear, customerGlobalId, limit = 20 }) {
  const { SalesInvoice, SalesOrder } = financialModels(tenantKey, financialYear);
  const [invoices, lastOrder] = await Promise.all([
    SalesInvoice.find({ tenantKey, financialYear, customerGlobalId, status: "POSTED" })
      .select("date items invoiceNo").sort({ date: -1 }).limit(20).lean(),
    SalesOrder.findOne({ tenantKey, financialYear, customerGlobalId, status: { $nin: ["CANCELLED", "REJECTED"] } })
      .sort({ date: -1, createdAt: -1 }).lean(),
  ]);

  const stat = new Map();
  for (const invoice of invoices) {
    for (const item of invoice.items || []) {
      const id = clean(item.productId);
      if (!id) continue;
      const row = stat.get(id) || { productId: id, name: item.nameSnapshot || "", sku: item.sku || "", quantities: [], dates: [], rate: item.rate || item.effectiveRate || 0, count: 0 };
      row.quantities.push(num(item.qty)); row.dates.push(new Date(invoice.date)); row.rate = num(item.rate || item.effectiveRate || row.rate); row.count += 1;
      stat.set(id, row);
    }
  }
  if (!stat.size && lastOrder) {
    for (const item of lastOrder.items || []) {
      const id = clean(item.productId); if (!id) continue;
      stat.set(id, { productId: id, name: item.nameSnapshot || "", sku: item.sku || "", quantities: [num(item.qty)], dates: [new Date(lastOrder.date)], rate: num(item.rate), count: 1 });
    }
  }
  const ids = [...stat.keys()];
  const products = ids.length ? await Product.find({ tenantKey, _id: { $in: ids.filter(objectIdText) }, status: "ACTIVE" }).lean() : [];
  const pm = new Map(products.map((p) => [String(p._id), p]));
  const now = new Date();
  return [...stat.values()].map((row) => {
    row.dates.sort((a, b) => b - a);
    const gaps = [];
    for (let i = 0; i < row.dates.length - 1; i += 1) gaps.push(Math.max(1, daysBetween(row.dates[i], row.dates[i + 1])));
    const avgGapDays = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 30;
    const daysSinceLast = row.dates[0] ? Math.max(0, daysBetween(now, row.dates[0])) : 0;
    const averageQty = row.quantities.length ? Math.max(1, Math.round((row.quantities.reduce((a, b) => a + b, 0) / row.quantities.length) * 100) / 100) : 1;
    const p = pm.get(row.productId) || {};
    const dueRatio = avgGapDays ? daysSinceLast / avgGapDays : 0;
    return {
      productId: row.productId,
      sku: p.sku || row.sku,
      name: p.name || row.name || "Product",
      hsnCode: p.hsnCode || "",
      gstRate: num(p.gstRate),
      unit: p.basicUnit || p.unit || "PCS",
      packingUnit: p.packingUnit || "",
      qtyInBag: num(p.qtyInBag || 1),
      currentStock: num(p.currentStock),
      listRate: num(p.salePrice || row.rate),
      suggestedQty: averageQty,
      lastQty: row.quantities[0] || averageQty,
      purchaseCount: row.count,
      avgGapDays,
      daysSinceLast,
      reorderDue: daysSinceLast >= Math.max(1, avgGapDays),
      score: Math.round((row.count * 12 + Math.min(60, dueRatio * 25)) * 10) / 10,
    };
  }).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, Number(limit || 20))));
}



const validCoord = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;
const customerCoordinates = (customer = {}) => {
  const candidates = [customer.location, ...(customer.addresses || [])];
  for (const row of candidates) {
    const latitude = Number(row?.latitude), longitude = Number(row?.longitude);
    if (validCoord(latitude, longitude)) return { latitude, longitude, accuracy: num(row?.accuracy) || null };
  }
  return null;
};
const haversine = (a, b) => {
  if (!a || !b) return Infinity;
  const lat1 = Number(a.latitude ?? a.lat), lon1 = Number(a.longitude ?? a.lng);
  const lat2 = Number(b.latitude ?? b.lat), lon2 = Number(b.longitude ?? b.lng);
  if (!validCoord(lat1, lon1) || !validCoord(lat2, lon2)) return Infinity;
  const r = 6371000, rad = (v) => v * Math.PI / 180;
  const dLat = rad(lat2-lat1), dLon = rad(lon2-lon1);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*r*Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
};
const routePoint = (raw = {}) => {
  const lat = Number(raw.lat ?? raw.latitude), lng = Number(raw.lng ?? raw.longitude);
  if (!validCoord(lat, lng)) return null;
  return { lat, lng, accuracy: Number.isFinite(Number(raw.accuracy)) ? Number(raw.accuracy) : null, speed: Number.isFinite(Number(raw.speed)) ? Number(raw.speed) : null, heading: Number.isFinite(Number(raw.heading)) ? Number(raw.heading) : null, ts: clean(raw.ts || raw.timestamp) || new Date().toISOString() };
};
const polylineDistance = (points = []) => points.reduce((sum, point, i) => i ? sum + (Number.isFinite(haversine(points[i-1], point)) ? haversine(points[i-1], point) : 0) : sum, 0);
const addDateDays = (date, delta) => { const d = new Date(date); d.setDate(d.getDate()+Number(delta||0)); return d; };
const avg = (rows = []) => rows.length ? rows.reduce((s, x) => s + num(x), 0) / rows.length : 0;
const median = (rows = []) => { const a = rows.map(num).sort((x,y)=>x-y); if (!a.length) return 0; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };

async function customerSalesIntelligence({ tenantKey, financialYear, customer, includeCrossSell = true }) {
  const { SalesInvoice } = financialModels(tenantKey, financialYear);
  const invoices = await SalesInvoice.find({ tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" })
    .select("date grandTotal items invoiceNo").sort({ date: 1, createdAt: 1 }).lean();
  if (!invoices.length) return { lifecycle: { status: "NEW", invoiceCount: 0, confidence: 0 }, reorder: [], upsell: [], crossSell: [], averageOrderValue: 0 };

  const dates = invoices.map((x) => new Date(x.date)).filter((x) => !Number.isNaN(x.getTime()));
  const gaps = [];
  for (let i=1;i<dates.length;i+=1) gaps.push(Math.max(1, daysBetween(dates[i], dates[i-1])));
  const normalGapDays = gaps.length ? Math.max(1, Math.round(median(gaps))) : 30;
  const lastInvoiceAt = dates[dates.length-1];
  const daysSinceLast = Math.max(0, daysBetween(new Date(), lastInvoiceAt));
  const expectedNextAt = addDateDays(lastInvoiceAt, normalGapDays);
  const lateDays = Math.max(0, daysBetween(new Date(), expectedNextAt));
  const variability = gaps.length > 1 ? Math.sqrt(avg(gaps.map((x)=>(x-avg(gaps))**2))) / Math.max(1, avg(gaps)) : .5;
  const confidence = Math.max(30, Math.min(96, Math.round(48 + Math.min(36, invoices.length*6) - Math.min(22, variability*22))));
  let lifecycleStatus = "ACTIVE";
  if (invoices.length >= 2 && daysSinceLast >= Math.max(45, Math.round(normalGapDays*2.2))) lifecycleStatus = "LOST";
  else if (invoices.length >= 2 && daysSinceLast >= Math.max(30, Math.round(normalGapDays*1.5))) lifecycleStatus = "AT_RISK";
  else if (daysSinceLast >= Math.max(7, Math.round(normalGapDays*.9))) lifecycleStatus = "REORDER_DUE";

  const byProduct = new Map();
  for (const invoice of invoices) {
    for (const item of invoice.items || []) {
      const productId=clean(item.productId); if(!productId) continue;
      const row=byProduct.get(productId)||{productId,name:item.nameSnapshot||"Product",sku:item.sku||"",dates:[],qtys:[],rates:[],values:[]};
      row.dates.push(new Date(invoice.date)); row.qtys.push(num(item.qty)); row.rates.push(num(item.rate||item.effectiveRate)); row.values.push(num(item.lineTotal||item.taxable)); byProduct.set(productId,row);
    }
  }
  const productIds=[...byProduct.keys()];
  const prodDocs=productIds.length?await Product.find({tenantKey,_id:{$in:productIds.filter(objectIdText)},status:"ACTIVE"}).select("name sku salePrice basicUnit packingUnit gstRate").lean():[];
  const prodMap=new Map(prodDocs.map((p)=>[String(p._id),p]));
  const reorder=[]; const upsell=[];
  for(const row of byProduct.values()){
    row.dates.sort((a,b)=>a-b);
    const pg=[]; for(let i=1;i<row.dates.length;i+=1)pg.push(Math.max(1,daysBetween(row.dates[i],row.dates[i-1])));
    const gap=pg.length?Math.max(1,Math.round(median(pg))):normalGapDays;
    const last=row.dates[row.dates.length-1], since=Math.max(0,daysBetween(new Date(),last)), next=addDateDays(last,gap), late=Math.max(0,daysBetween(new Date(),next));
    const p=prodMap.get(row.productId)||{}; const averageQty=Math.max(1,Math.round(avg(row.qtys)*100)/100), lastQty=row.qtys[row.qtys.length-1]||averageQty;
    const recent=row.qtys.slice(-3), prior=row.qtys.slice(Math.max(0,row.qtys.length-6),Math.max(0,row.qtys.length-3));
    const growth=prior.length?avg(recent)/Math.max(.01,avg(prior)):1;
    const base={productId:row.productId,name:p.name||row.name,sku:p.sku||row.sku,unit:p.basicUnit||"PCS",purchaseCount:row.dates.length,lastPurchasedAt:last,daysSinceLast:since,avgGapDays:gap,predictedNextAt:next,lateDays:late,averageQty,lastQty,rate:money(p.salePrice||row.rates[row.rates.length-1]||0),gstRate:num(p.gstRate),confidence:Math.max(35,Math.min(96,Math.round(45+Math.min(40,row.dates.length*8)-Math.min(15,(pg.length?Math.abs(avg(pg)-median(pg))/Math.max(1,avg(pg)):0)*30))))};
    if(row.dates.length>=2 && since>=Math.max(5,Math.round(gap*.8))) reorder.push({...base,suggestedQty:averageQty,expectedValue:money(averageQty*base.rate),status:late>0?"OVERDUE":"DUE_SOON",score:Math.round((row.dates.length*10+Math.min(50,since/gap*30)+Math.min(30,late))*10)/10});
    if(row.dates.length>=3 && growth>=1.08) upsell.push({...base,suggestedQty:Math.max(lastQty,Math.ceil(averageQty*1.15)),growthPct:Math.round((growth-1)*1000)/10,reason:"Purchase quantity is trending upward",score:Math.round((growth*35+row.dates.length*5)*10)/10});
  }
  reorder.sort((a,b)=>b.score-a.score); upsell.sort((a,b)=>b.score-a.score);

  const crossSell=[];
  if(includeCrossSell && productIds.length){
    const anchorIds=new Set(productIds); const recentTenant=await SalesInvoice.find({tenantKey,financialYear,status:"POSTED",customerGlobalId:{$ne:customer.globalCustomerId},"items.productId":{$in:productIds}}).select("items").sort({date:-1}).limit(1200).lean();
    let matchingBaskets=0; const co=new Map();
    for(const inv of recentTenant){
      const basket=[...new Set((inv.items||[]).map((i)=>clean(i.productId)).filter(Boolean))];
      if(!basket.some((id)=>anchorIds.has(id))) continue; matchingBaskets+=1;
      for(const item of inv.items||[]){const id=clean(item.productId);if(!id||anchorIds.has(id))continue;const r=co.get(id)||{productId:id,name:item.nameSnapshot||"Product",sku:item.sku||"",count:0,rate:num(item.rate||item.effectiveRate)};r.count+=1;co.set(id,r);}
    }
    const candidateIds=[...co.values()].sort((a,b)=>b.count-a.count).slice(0,20).map((x)=>x.productId);
    const docs=candidateIds.length?await Product.find({tenantKey,_id:{$in:candidateIds.filter(objectIdText)},status:"ACTIVE"}).select("name sku salePrice basicUnit gstRate").lean():[]; const dm=new Map(docs.map((x)=>[String(x._id),x]));
    for(const row of [...co.values()].sort((a,b)=>b.count-a.count).slice(0,10)){const p=dm.get(row.productId)||{};const support=matchingBaskets?row.count/matchingBaskets:0;if(row.count<2||support<.08)continue;crossSell.push({productId:row.productId,name:p.name||row.name,sku:p.sku||row.sku,unit:p.basicUnit||"PCS",rate:money(p.salePrice||row.rate),gstRate:num(p.gstRate),similarCustomerCount:row.count,confidence:Math.min(95,Math.round(support*100)),reason:`Bought by ${row.count} similar customer orders`,suggestedQty:1,score:Math.round((row.count*10+support*100)*10)/10});}
  }
  return {
    lifecycle:{status:lifecycleStatus,invoiceCount:invoices.length,lastInvoiceAt,daysSinceLast,normalGapDays,expectedNextAt,lateDays,confidence,averageOrderValue:money(avg(invoices.map((x)=>x.grandTotal)))},
    reorder:reorder.slice(0,10),upsell:upsell.slice(0,8),crossSell:crossSell.sort((a,b)=>b.score-a.score).slice(0,8),averageOrderValue:money(avg(invoices.map((x)=>x.grandTotal))),
  };
}

function dynamicCustomerActions({ summary = {}, intelligence = {}, visit = null }) {
  const actions=[]; const overdue=num(summary.overdueAmount), outstanding=num(summary.outstanding), creditLimit=num(summary.creditLimit), available=num(summary.availableCredit);
  if(overdue>0) actions.push({key:"COLLECT",label:"Collect Payment",icon:"cash-plus",priority:130,reason:`₹${money(overdue).toLocaleString("en-IN")} overdue`});
  if(num(summary.openPromiseAmount)>0) actions.push({key:"PROMISE",label:"Payment Promise",icon:"handshake-outline",priority:120,reason:"Open payment promise"});
  if(intelligence.lifecycle?.status==="LOST") actions.push({key:"VISIT",label:"Recover Customer",icon:"account-reactivate-outline",priority:115,reason:`No order for ${intelligence.lifecycle.daysSinceLast} days`});
  else if(intelligence.lifecycle?.status==="AT_RISK") actions.push({key:"VISIT",label:"Reconnect Customer",icon:"account-alert-outline",priority:108,reason:`Buying cycle is slipping • ${intelligence.lifecycle.daysSinceLast} days since order`});
  if((intelligence.reorder||[]).length) actions.push({key:"ORDER",label:"Reorder Now",icon:"cart-arrow-down",priority:105,reason:`${intelligence.reorder.length} products predicted due`});
  if((intelligence.crossSell||[]).length || (intelligence.upsell||[]).length) actions.push({key:"GROW",label:"Grow Customer",icon:"chart-line",priority:92,reason:`${(intelligence.crossSell||[]).length} cross-sell • ${(intelligence.upsell||[]).length} upsell suggestions`});
  const daysSinceVisit=visit?.startedAt?Math.max(0,daysBetween(new Date(),visit.startedAt)):999;
  if(daysSinceVisit>=21) actions.push({key:"VISIT",label:"Visit Customer",icon:"map-marker-check-outline",priority:88,reason:visit?`Last visit ${daysSinceVisit} days ago`:"No V2 visit recorded"});
  if(creditLimit>0&&available<=Math.max(0,creditLimit*.1)) actions.push({key:"COLLECT",label:"Collect Before Order",icon:"credit-card-alert-outline",priority:125,reason:"Credit nearly exhausted"});
  actions.push({key:"VOICE",label:"Voice Update",icon:"microphone-outline",priority:65,reason:"Speak visit/follow-up notes"});
  if(!actions.some((x)=>x.key==="ORDER")) actions.push({key:"ORDER",label:"Take Order",icon:"cart-plus",priority:60,reason:"Create sales order"});
  if(outstanding<=0&&!actions.some((x)=>x.key==="VISIT")) actions.push({key:"VISIT",label:"Visit",icon:"map-marker-outline",priority:55,reason:"Build relationship"});
  return actions.sort((a,b)=>b.priority-a.priority).slice(0,6);
}

function parseFollowUpDate(text) {
  const t=clean(text).toLowerCase(), now=startOfDay(new Date());
  if(/\btomorrow\b/.test(t)) return addDateDays(now,1);
  const after=t.match(/\b(?:after|in)\s+(\d{1,3})\s+days?\b/); if(after)return addDateDays(now,Number(after[1]));
  const slash=t.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/); if(slash){let y=Number(slash[3]);if(y<100)y+=2000;const d=new Date(y,Number(slash[2])-1,Number(slash[1]));if(!Number.isNaN(d.getTime()))return d;}
  const weekdayNames=["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  for(let i=0;i<weekdayNames.length;i+=1)if(new RegExp(`\\b${weekdayNames[i]}\\b`).test(t)){const d=new Date(now);let delta=(i-d.getDay()+7)%7;if(delta===0)delta=7;d.setDate(d.getDate()+delta);return d;}
  return null;
}

async function parseVoiceCrm({ tenantKey, transcript }) {
  const text=clean(transcript), lower=text.toLowerCase(); if(!text)return {transcript:"",outcome:"",nextFollowUpAt:null,products:[],amount:null,quantity:null,rate:null,tags:[]};
  const products=await Product.find({tenantKey,status:"ACTIVE"}).select("_id name sku salePrice basicUnit").limit(1500).lean();
  const mentions=products.filter((p)=>{const n=clean(p.name).toLowerCase(),sku=clean(p.sku).toLowerCase();return (n.length>=4&&lower.includes(n))||(sku.length>=3&&lower.includes(sku));}).slice(0,10).map((p)=>({productId:String(p._id),name:p.name,sku:p.sku,rate:num(p.salePrice),unit:p.basicUnit||"PCS"}));
  const amountMatch=lower.match(/(?:₹|rs\.?|rupees?|payment|pay|collect(?:ion)?)[\s:,-]*(\d[\d,]*(?:\.\d+)?)/i);
  const rateMatch=lower.match(/(?:rate|price|at)[\s:₹rs.-]*(\d[\d,]*(?:\.\d+)?)/i);
  const qtyMatch=lower.match(/(\d+(?:\.\d+)?)\s*(pcs?|pieces?|boxes?|cartons?|packs?|kg|kgs|reams?)/i);
  let outcome="FOLLOW_UP"; if(/not interested|reject|refused|no requirement/.test(lower))outcome="NOT_INTERESTED";else if(/order|book|confirm|purchase/.test(lower))outcome="ORDER_INTEREST";else if(/payment|pay|collect|cheque|cash/.test(lower))outcome="PAYMENT_FOLLOW_UP";else if(/interested|sample|quotation|quote|price/.test(lower))outcome="INTERESTED";
  const tags=[]; if(mentions.length)tags.push("PRODUCT"); if(amountMatch)tags.push("AMOUNT"); if(qtyMatch)tags.push("QUANTITY"); if(/competitor|supplier|buying from/.test(lower))tags.push("COMPETITOR");
  return {transcript:text,outcome,nextFollowUpAt:parseFollowUpDate(text),products:mentions,amount:amountMatch?money(String(amountMatch[1]).replace(/,/g,"")):null,quantity:qtyMatch?num(qtyMatch[1]):null,quantityUnit:qtyMatch?upper(qtyMatch[2]):"",rate:rateMatch?money(String(rateMatch[1]).replace(/,/g,"")):null,tags};
}

const localDateKey = (value = new Date()) => {
  const d = new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const monthKey = (value = new Date()) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const endOfDay = (value = new Date()) => {
  const d = startOfDay(value); d.setDate(d.getDate() + 1); return d;
};
const collectionOwnerFilter = (userId) => ({
  $or: [
    { collectedBySalespersonId: clean(userId) },
    { collectedBySalespersonId: { $in: [null, ""] }, createdBy: clean(userId) },
    { collectedBySalespersonId: { $exists: false }, createdBy: clean(userId) },
  ],
});
const effectiveCashStatus = { $in: ["POSTED", "APPROVED"] };

async function collectionTargetForUser({ tenantKey, financialYear, userId, at = new Date() }) {
  const target = await Target.findOne({ tenantKey, financialYear, level: "USER", entityId: clean(userId), status: { $ne: "CANCELLED" } }).lean();
  const mk = monthKey(at);
  const monthNo = String(new Date(at).getMonth() + 1).padStart(2, "0");
  const fullMonth = new Date(at).toLocaleString("en-US", { month: "long" });
  const shortMonth = new Date(at).toLocaleString("en-US", { month: "short" });
  const monthRow = (target?.monthly || []).find((x) => {
    const key = clean(x?.month).toLowerCase();
    return [mk, monthNo, fullMonth, shortMonth].map((x) => x.toLowerCase()).includes(key);
  });
  const targetAmount = money(num(monthRow?.collection) || (num(target?.annual?.collection) > 0 ? num(target.annual.collection) / 12 : 0));
  const from = new Date(at.getFullYear(), at.getMonth(), 1);
  const to = new Date(at.getFullYear(), at.getMonth() + 1, 1);
  const { Receipt } = financialModels(tenantKey, financialYear);
  const [row] = await Receipt.aggregate([
    { $match: { tenantKey, financialYear, status: "POSTED", date: { $gte: from, $lt: to }, ...collectionOwnerFilter(userId) } },
    { $group: { _id: null, achieved: { $sum: "$amount" } } },
  ]);
  const achieved = money(row?.achieved || 0);
  const remaining = money(Math.max(0, targetAmount - achieved));
  const pct = targetAmount > 0 ? Math.round(Math.min(999, achieved / targetAmount * 100) * 10) / 10 : 0;
  return { month: mk, target: targetAmount, achieved, remaining, achievementPct: pct, configured: targetAmount > 0 };
}

async function cashSummaryForUser({ tenantKey, financialYear, salespersonId, at = new Date() }) {
  const { SalespersonCashMovement } = financialModels(tenantKey, financialYear);
  const userId = clean(salespersonId);
  const dayStart = startOfDay(at), dayEnd = endOfDay(at), key = localDateKey(at);
  const [effective, today, pending] = await Promise.all([
    SalespersonCashMovement.aggregate([
      { $match: { tenantKey, financialYear, salespersonId: userId, status: effectiveCashStatus } },
      { $group: { _id: "$direction", total: { $sum: "$amount" } } },
    ]),
    SalespersonCashMovement.find({ tenantKey, financialYear, salespersonId: userId, date: { $gte: dayStart, $lt: dayEnd }, status: effectiveCashStatus }).sort({ date: -1, createdAt: -1 }).lean(),
    SalespersonCashMovement.find({ tenantKey, financialYear, salespersonId: userId, status: "PENDING", type: { $in: ["HANDOVER", "BANK_DEPOSIT"] } }).sort({ date: -1, createdAt: -1 }).lean(),
  ]);
  const em = new Map(effective.map((x) => [String(x._id), num(x.total)]));
  const cashInHand = money(num(em.get("IN")) - num(em.get("OUT")));
  const sumType = (type, direction = null) => money(today.filter((x) => x.type === type && (!direction || x.direction === direction)).reduce((s, x) => s + num(x.amount), 0));
  const pendingHandover = money(pending.filter((x) => x.type === "HANDOVER").reduce((s, x) => s + num(x.amount), 0));
  const pendingBankDeposit = money(pending.filter((x) => x.type === "BANK_DEPOSIT").reduce((s, x) => s + num(x.amount), 0));
  const openingRows = await SalespersonCashMovement.aggregate([
    { $match: { tenantKey, financialYear, salespersonId: userId, status: effectiveCashStatus, date: { $lt: dayStart } } },
    { $group: { _id: "$direction", total: { $sum: "$amount" } } },
  ]);
  const om = new Map(openingRows.map((x) => [String(x._id), num(x.total)]));
  const openingCash = money(num(om.get("IN")) - num(om.get("OUT")));
  return {
    dayKey: key,
    openingCash,
    cashCollectedToday: sumType("COLLECTION", "IN"),
    handoverApprovedToday: sumType("HANDOVER", "OUT"),
    bankDepositApprovedToday: sumType("BANK_DEPOSIT", "OUT"),
    shortageApprovedToday: sumType("SHORTAGE", "OUT"),
    excessApprovedToday: sumType("EXCESS", "IN"),
    adjustmentsInToday: sumType("ADJUSTMENT_IN", "IN"),
    adjustmentsOutToday: sumType("ADJUSTMENT_OUT", "OUT"),
    cashInHand,
    pendingHandover,
    pendingBankDeposit,
    pendingTotal: money(pendingHandover + pendingBankDeposit),
    recentToday: today.slice(0, 10),
  };
}

async function fulfillPromisesFromReceipt({ tenantKey, financialYear, customerGlobalId, receiptId, amount }) {
  const { PromiseToPay } = financialModels(tenantKey, financialYear);
  let remaining = Math.max(0, num(amount));
  if (!remaining) return [];
  await markBrokenPromises(PromiseToPay, tenantKey, financialYear, [customerGlobalId]);
  const promises = await PromiseToPay.find({ tenantKey, financialYear, customerGlobalId, status: { $in: ["OPEN", "PARTIAL", "BROKEN"] } }).sort({ promiseDate: 1, createdAt: 1 });
  const updated = [];
  for (const promise of promises) {
    if (remaining <= 0) break;
    const open = Math.max(0, num(promise.amount) - num(promise.fulfilledAmount));
    if (!open) continue;
    const applied = Math.min(open, remaining);
    promise.fulfilledAmount = money(num(promise.fulfilledAmount) + applied);
    promise.fulfilledByReceiptIds = [...new Set([...(promise.fulfilledByReceiptIds || []), String(receiptId)])];
    promise.status = promise.fulfilledAmount >= num(promise.amount) ? "FULFILLED" : "PARTIAL";
    promise.lastActionAt = new Date();
    await promise.save();
    updated.push({ promiseNo: promise.promiseNo, applied: money(applied), status: promise.status });
    remaining = money(remaining - applied);
  }
  return updated;
}

async function collectionPriorityItems({ tenantKey, financialYear, customers }) {
  const ids = customers.map((x) => x.globalCustomerId);
  if (!ids.length) return [];
  const { SalesInvoice, Receipt, PromiseToPay } = financialModels(tenantKey, financialYear);
  await markBrokenPromises(PromiseToPay, tenantKey, financialYear, ids);
  const [invoices, receiptAgg, balanceMap, promises] = await Promise.all([
    SalesInvoice.find({ tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" }).select("customerGlobalId invoiceNo date grandTotal").sort({ date: 1 }).lean(),
    Receipt.aggregate([{ $match: { tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" } }, { $group: { _id: "$customerGlobalId", total: { $sum: "$amount" }, lastReceiptAt: { $max: "$date" } } }]),
    receivableMap({ tenantKey, financialYear, customerIds: ids }),
    PromiseToPay.find({ tenantKey, financialYear, customerGlobalId: { $in: ids }, status: { $in: ["OPEN", "PARTIAL", "BROKEN"] } }).lean(),
  ]);
  const im = new Map();
  for (const inv of invoices) { if (!im.has(inv.customerGlobalId)) im.set(inv.customerGlobalId, []); im.get(inv.customerGlobalId).push(inv); }
  const rm = new Map(receiptAgg.map((x) => [String(x._id), x]));
  const pm = new Map();
  for (const p of promises) { if (!pm.has(p.customerGlobalId)) pm.set(p.customerGlobalId, []); pm.get(p.customerGlobalId).push(p); }
  const today = startOfDay(new Date());
  return customers.map((c) => {
    const r = rm.get(c.globalCustomerId) || {};
    const bills = allocateReceiptsToInvoices(im.get(c.globalCustomerId) || [], r.total || 0, c.creditDays || 0).filter((x) => x.outstanding > 0);
    const overdueAmount = money(bills.filter((x) => x.overdueDays > 0).reduce((s, x) => s + x.outstanding, 0));
    const dueToday = money(bills.filter((x) => x.status === "DUE_TODAY").reduce((s, x) => s + x.outstanding, 0));
    const customerPromises = pm.get(c.globalCustomerId) || [];
    const broken = customerPromises.filter((x) => x.status === "BROKEN");
    const todayPromise = customerPromises.filter((x) => ["OPEN", "PARTIAL"].includes(x.status) && daysBetween(x.promiseDate, today) === 0);
    const promisedToday = money(todayPromise.reduce((s, x) => s + Math.max(0, num(x.amount) - num(x.fulfilledAmount)), 0));
    const brokenPromiseAmount = money(broken.reduce((s, x) => s + Math.max(0, num(x.amount) - num(x.fulfilledAmount)), 0));
    const maxOverdueDays = bills.reduce((m, x) => Math.max(m, x.overdueDays), 0);
    const outstanding = money(num(balanceMap.get(c.globalCustomerId)) + openingSigned(c, financialYear));
    const score = Math.round((Math.min(50, overdueAmount / 2000) + Math.min(35, maxOverdueDays) + (promisedToday > 0 ? 25 : 0) + (broken.length ? 30 : 0) + (dueToday > 0 ? 12 : 0)) * 10) / 10;
    return {
      customer: shapeCustomer(c, null, { outstanding }), outstanding, overdueAmount, dueToday,
      promisedToday, brokenPromiseAmount, maxOverdueDays, openBills: bills.length,
      priorityScore: score,
      priority: broken.length || maxOverdueDays > 30 ? "CRITICAL" : promisedToday > 0 || overdueAmount > 0 ? "HIGH" : dueToday > 0 ? "MEDIUM" : "NORMAL",
      nextPromise: [...customerPromises].sort((a, b) => new Date(a.promiseDate) - new Date(b.promiseDate))[0] || null,
    };
  }).filter((x) => x.outstanding > 0 || x.promisedToday > 0 || x.brokenPromiseAmount > 0).sort((a, b) => b.priorityScore - a.priorityScore);
}

async function opportunityItemsForUser({ req, financialYear, limit = 50, customers: providedCustomers = null, priority: providedPriority = null }) {
  let customers = providedCustomers;
  if (!customers) {
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    customers = await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses creditDays creditLimit accountingProfile salespersonId").lean();
  }
  const ids = customers.map((x) => x.globalCustomerId);
  const customerMap = new Map(customers.map((c) => [c.globalCustomerId, c]));
  const priority = providedPriority || await collectionPriorityItems({ tenantKey: req.auth.tenantKey, financialYear, customers });
  const { SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
  const invoiceStats = ids.length ? await SalesInvoice.aggregate([
    { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" } },
    { $sort: { date: 1, createdAt: 1 } },
    { $group: { _id: "$customerGlobalId", firstDate: { $first: "$date" }, lastDate: { $last: "$date" }, count: { $sum: 1 }, sales: { $sum: "$grandTotal" }, lastInvoiceNo: { $last: "$invoiceNo" }, lastItems: { $last: "$items" } } },
  ]) : [];
  const out = [];
  for (const row of priority.slice(0, 25)) {
    const c = row.customer;
    const amount = row.brokenPromiseAmount || row.promisedToday || row.overdueAmount || row.outstanding;
    out.push({
      id: `COL-${c.id}`,
      type: row.brokenPromiseAmount > 0 ? "BROKEN_PROMISE" : row.promisedToday > 0 ? "PROMISE_TODAY" : "COLLECTION",
      score: 120 + row.priorityScore,
      title: row.brokenPromiseAmount > 0 ? "Broken payment promise" : row.promisedToday > 0 ? "Payment promised today" : "Collection opportunity",
      subtitle: `${c.name} • ${money(amount).toLocaleString("en-IN")} ${row.maxOverdueDays ? `• ${row.maxOverdueDays}d overdue` : ""}`,
      customerGlobalId: c.id,
      customerName: c.name,
      amount,
      action: "COLLECT",
      priority: row.priority,
    });
  }
  const today = startOfDay(new Date());
  for (const st of invoiceStats) {
    const c = customerMap.get(String(st._id)); if (!c) continue;
    const count = num(st.count), span = Math.max(0, daysBetween(st.lastDate, st.firstDate));
    const avgGap = count > 1 ? Math.max(1, Math.round(span / (count - 1))) : 30;
    const daysSince = Math.max(0, daysBetween(today, st.lastDate));
    if (daysSince < Math.max(7, Math.round(avgGap * 0.9))) continue;
    const topItem = [...(st.lastItems || [])].sort((a, b) => num(b.lineTotal) - num(a.lineTotal))[0];
    const overdueBy = Math.max(0, daysSince - avgGap);
    const recovery = count >= 2 && daysSince >= Math.max(30, Math.round(avgGap * 1.8));
    out.push({
      id: `${recovery ? "RECOVERY" : "REORDER"}-${st._id}`,
      type: recovery ? "CUSTOMER_RECOVERY" : "REORDER_DUE",
      score: (recovery ? 108 : 80) + Math.min(40, overdueBy) + Math.min(30, num(st.sales) / 10000),
      title: recovery ? "Recover inactive customer" : "Reorder likely due",
      subtitle: `${customerName(c)} • Last order ${daysSince}d ago • Normal gap ~${avgGap}d${topItem?.nameSnapshot ? ` • ${topItem.nameSnapshot}` : ""}`,
      customerGlobalId: c.globalCustomerId,
      customerName: customerName(c),
      amount: money(num(st.sales) / Math.max(1, count)),
      action: recovery ? "CUSTOMER" : "ORDER",
      orderMode: "SUGGESTED",
      lifecycleStatus: recovery ? "LOST" : "REORDER_DUE",
      predictedNextAt: addDateDays(st.lastDate, avgGap),
      lateDays: overdueBy,
      confidence: Math.max(35, Math.min(95, 45 + count * 7)),
      priority: recovery || overdueBy > 20 ? "HIGH" : "MEDIUM",
    });
  }

  // Growth recommendations are intentionally limited to the strongest active
  // accounts so the Opportunity screen stays quick even with thousands of customers.
  const growthCandidates = [...invoiceStats].sort((a,b)=>num(b.sales)-num(a.sales)).slice(0,6);
  const growthResults = await Promise.all(growthCandidates.map(async (st) => {
    const customer = customerMap.get(String(st._id));
    if (!customer) return null;
    const intelligence = await customerSalesIntelligence({ tenantKey: req.auth.tenantKey, financialYear, customer, includeCrossSell: true });
    const topUpsell = intelligence.upsell?.[0], topCross = intelligence.crossSell?.[0];
    const best = topCross && (!topUpsell || num(topCross.score) >= num(topUpsell.score)) ? { kind:"CROSS_SELL", row:topCross } : topUpsell ? { kind:"UPSELL", row:topUpsell } : null;
    if (!best) return null;
    return {
      id: `${best.kind}-${customer.globalCustomerId}-${best.row.productId}`,
      type: best.kind,
      score: 76 + Math.min(45, num(best.row.score)),
      title: best.kind === "CROSS_SELL" ? "Cross-sell opportunity" : "Upsell opportunity",
      subtitle: `${customerName(customer)} • ${best.row.name} • ${best.kind === "CROSS_SELL" ? best.row.reason : `Suggested qty ${best.row.suggestedQty}`}`,
      customerGlobalId: customer.globalCustomerId, customerName: customerName(customer), productId: best.row.productId,
      amount: money(num(best.row.rate) * num(best.row.suggestedQty || 1)), action: "ORDER", orderMode: "GROW", priority: "MEDIUM",
    };
  }));
  out.push(...growthResults.filter(Boolean));

  const leadScope = await visibility(req);
  const leadFilter = { tenantKey: req.auth.tenantKey, deletedAt: { $exists: false }, stage: { $in: ["NEW", "ASSIGNED", "FOLLOW_UP"] } };
  if (leadScope.isLeaf) leadFilter.assignedUserId = req.auth.sub;
  else if (!leadScope.unrestricted) leadFilter.assignedUserId = { $in: leadScope.userIds || [] };
  const leads = await Lead.find(leadFilter)
    .select("leadId companyName contactPerson mobile pincode priority nextFollowUpAt stage updatedAt assignedUserId").sort({ nextFollowUpAt: 1, updatedAt: 1 }).limit(60).lean();
  for (const lead of leads) {
    const followDue = lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) <= new Date();
    const priorityScore = upper(lead.priority) === "HIGH" ? 35 : upper(lead.priority) === "URGENT" ? 45 : 10;
    out.push({
      id: `LEAD-${lead._id}`,
      type: followDue ? "LEAD_FOLLOW_UP" : "LEAD",
      score: 70 + priorityScore + (followDue ? 25 : 0),
      title: followDue ? "Lead follow-up due" : "Lead opportunity",
      subtitle: `${lead.companyName || lead.contactPerson || "Lead"}${lead.pincode ? ` • ${lead.pincode}` : ""}`,
      leadId: String(lead._id),
      businessLeadId: lead.leadId,
      amount: 0,
      action: "LEAD",
      priority: followDue || priorityScore >= 35 ? "HIGH" : "NORMAL",
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(200, Number(limit || 50))));
}


const normalizeWords = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const digits10 = (v) => clean(v).replace(/\D/g, "").slice(-10);
const tokenSimilarity = (a, b) => {
  const left = new Set(normalizeWords(a).split(/\s+/).filter(Boolean));
  const right = new Set(normalizeWords(b).split(/\s+/).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let common = 0; for (const x of left) if (right.has(x)) common += 1;
  return common / Math.max(left.size, right.size);
};
const duplicateRisk = (score) => score >= 90 ? "BLOCK" : score >= 58 ? "WARN" : "CLEAR";

async function duplicateMatches(req, payload = {}) {
  const companyName = clean(payload.companyName || payload.legalName || payload.name);
  const mobile = digits10(payload.mobile || payload.companyContactNumber || payload.ownerMobile);
  const gstin = upper(payload.gstin);
  const pan = upper(payload.pan || payload.ownerPan);
  const pincode = clean(payload.pincode).replace(/\D/g, "").slice(0, 6);
  const address = clean(payload.address);
  const excludeLeadId = clean(payload.excludeLeadId);
  const excludeCustomerGlobalId = clean(payload.excludeCustomerGlobalId);
  const out = [];

  const leadOr = [];
  if (mobile.length === 10) leadOr.push({ mobile });
  if (companyName) leadOr.push({ companyName: new RegExp(escapeRx(companyName), "i") });
  if (pincode) leadOr.push({ pincode });
  if (leadOr.length) {
    const leadFilter = { tenantKey: req.auth.tenantKey, deletedAt: { $exists: false }, stage: { $nin: ["DELETED", "CANCELLED"] }, $or: leadOr };
    if (objectIdText(excludeLeadId)) leadFilter._id = { $ne: new mongoose.Types.ObjectId(excludeLeadId) };
    const leads = await Lead.find(leadFilter).select("leadId companyName mobile pincode address city state assignedUserId stage").limit(30).lean();
    for (const row of leads) {
      let score = 0; const reasons = [];
      if (mobile && digits10(row.mobile) === mobile) { score += 72; reasons.push("Same mobile number"); }
      const nameSim = tokenSimilarity(companyName, row.companyName);
      if (nameSim >= .95) { score += 38; reasons.push("Same company name"); }
      else if (nameSim >= .65) { score += 22; reasons.push("Similar company name"); }
      if (pincode && clean(row.pincode) === pincode) { score += 14; reasons.push("Same pincode"); }
      if (address && tokenSimilarity(address, row.address) >= .65) { score += 18; reasons.push("Similar address"); }
      score = Math.min(100, score);
      if (score >= 35) out.push({ type:"LEAD", id:String(row._id), publicId:row.leadId, name:row.companyName, mobile:row.mobile, pincode:row.pincode, city:row.city, state:row.state, stage:row.stage, score, risk:duplicateRisk(score), reasons });
    }
  }

  const globalClauses = [];
  if (gstin) globalClauses.push({ "gstins.value": gstin });
  if (pan) globalClauses.push({ pan });
  if (mobile.length === 10) globalClauses.push({ "mobiles.value": mobile });
  const globalRows = globalClauses.length ? await GlobalCustomer.find({ $or: globalClauses }).select("hiddenId legalName tradeName gstins pan mobiles registeredAddress").limit(30).lean() : [];
  const globalIds = globalRows.map((x)=>clean(x.hiddenId)).filter((id)=>id && id !== excludeCustomerGlobalId);
  const linkOr = [];
  if (mobile.length === 10) linkOr.push({ $or: [{ companyContactNumber: mobile }, { ownerMobile: mobile }, { "contacts.mobile": mobile }] });
  if (companyName) linkOr.push({ localName: new RegExp(escapeRx(companyName), "i") });
  if (pincode) linkOr.push({ "addresses.pincode": pincode });
  if (globalIds.length) linkOr.push({ globalCustomerId: { $in: globalIds } });
  if (linkOr.length) {
    const cFilter = { tenantKey: req.auth.tenantKey, status: { $nin: ["INACTIVE", "DEACTIVATED"] }, $or: linkOr };
    if (excludeCustomerGlobalId) cFilter.globalCustomerId = { $ne: excludeCustomerGlobalId };
    const links = await CustomerLink.find(cFilter).select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses status salespersonId").limit(40).lean();
    const gm = await globalsFor(links.map((x)=>x.globalCustomerId));
    for (const row of links) {
      const g = gm.get(row.globalCustomerId) || {};
      const rowMobile = digits10(customerMobile(row));
      const rowGstin = upper(g?.gstins?.find?.((x)=>x?.active !== false)?.value || (clean(row.displayIdentifier).length===15 ? row.displayIdentifier : ""));
      const rowPan = upper(g?.pan);
      let score = 0; const reasons = [];
      if (gstin && rowGstin === gstin) { score += 100; reasons.push("Same GSTIN"); }
      if (pan && rowPan === pan) { score += 92; reasons.push("Same PAN"); }
      if (mobile && rowMobile === mobile) { score += 72; reasons.push("Same mobile number"); }
      const nameSim = tokenSimilarity(companyName, row.localName || g.legalName || g.tradeName);
      if (nameSim >= .95) { score += 38; reasons.push("Same company name"); }
      else if (nameSim >= .65) { score += 22; reasons.push("Similar company name"); }
      const addr = billingAddress(row);
      if (pincode && clean(addr.pincode) === pincode) { score += 14; reasons.push("Same pincode"); }
      if (address && tokenSimilarity(address, addr.address || g.registeredAddress) >= .65) { score += 18; reasons.push("Similar address"); }
      score = Math.min(100, score);
      if (score >= 35) out.push({ type:"CUSTOMER", id:row.globalCustomerId, name:row.localName || g.legalName || "Customer", mobile:rowMobile, gstin:rowGstin, pan:rowPan, pincode:addr.pincode || "", city:addr.city || "", state:addr.state || "", status:row.status, score, risk:duplicateRisk(score), reasons });
    }
  }
  const dedup = new Map();
  for (const row of out.sort((a,b)=>b.score-a.score)) { const key=`${row.type}:${row.id}`; if(!dedup.has(key)) dedup.set(key,row); }
  return [...dedup.values()].slice(0,20);
}

function notificationFromOpportunity(item) {
  const severity = item.priority === "CRITICAL" ? "CRITICAL" : item.priority === "HIGH" ? "HIGH" : "NORMAL";
  return { id:`OPP:${item.id}`, type:item.type, severity, title:item.title, body:item.subtitle, action:item.action, customerGlobalId:item.customerGlobalId || "", leadId:item.leadId || "", amount:num(item.amount), createdAt:new Date().toISOString() };
}

async function roleScope(req) {
  const scope = await visibility(req);
  const user = await User.findOne({_id:req.auth.sub,tenantKey:req.auth.tenantKey,status:"ACTIVE"}).select("_id name role roleId designation department").lean();
  return { scope, user };
}


router.post("/duplicates/check", async (req,res)=>{
  try {
    const matches=await duplicateMatches(req,req.body||{});
    const highest=matches[0]?.score||0;
    return ok(res,{risk:duplicateRisk(highest),score:highest,matches,blocked:highest>=90});
  } catch(error){ return fail(res,error.message,error.statusCode||500); }
});

router.post("/ocr/extract", upload.single("document"), async(req,res)=>{
  try {
    if(!req.file) return fail(res,"Take a photo or choose an image/PDF first",400);
    const documentType=upper(req.body.documentType||"LEAD");
    if(!["LEAD","CUSTOMER","EXPENSE","DELIVERY_PROOF"].includes(documentType)) return fail(res,"Unsupported mobile Scan & Fill document type",400);
    const template=getDocumentTemplate(documentType); if(!template) return fail(res,"Document template not configured",404);
    const allowed=["application/pdf","image/jpeg","image/png","image/webp"];
    if(!allowed.includes(String(req.file.mimetype||"").toLowerCase())) return fail(res,"Use PDF, JPG, PNG or WEBP",400);
    const scanId=makeId("MSCAN");
    const fileMeta=await saveUploadedFile({file:req.file,tenantKey:req.auth.tenantKey,module:"sales-app",entityType:documentType,entityId:scanId,uploadedBy:req.auth.sub,access:"PRIVATE"});
    const raw=await extractDocument({file:req.file,template});
    const extraction=await enrichExtractedValues({tenantKey:req.auth.tenantKey,template,extraction:raw});
    await GenericRecord.create({tenantKey:req.auth.tenantKey,app:"dms",resource:"mobile_document_scan",reference:scanId,title:`${documentType} • ${req.file.originalname||"mobile capture"}`,status:"EXTRACTED",createdBy:req.auth.sub,data:{documentType,fileId:fileMeta.fileId,extraction}});
    const duplicateInput={ companyName:extraction?.values?.legalName||extraction?.values?.companyName, legalName:extraction?.values?.legalName, mobile:extraction?.values?.companyContactNumber||extraction?.values?.ownerMobile||extraction?.values?.mobile, gstin:extraction?.values?.gstin, pan:extraction?.values?.pan||extraction?.values?.ownerPan, pincode:extraction?.values?.pincode, address:extraction?.values?.address };
    const duplicates=await duplicateMatches(req,duplicateInput);
    return ok(res,{scanId,fileId:fileMeta.fileId,documentType,template,extraction,duplicateRisk:duplicateRisk(duplicates[0]?.score||0),duplicates},"Document read. Review all extracted fields before using them.",201);
  }catch(error){ return fail(res,error.message,error.statusCode||400); }
});

router.get("/competitors", async(req,res)=>{
  try{
    const q=clean(req.query.q),customerGlobalId=clean(req.query.customerGlobalId),limit=Math.min(200,Math.max(10,Number(req.query.limit||80)));
    const scope=await visibility(req); const filter={tenantKey:req.auth.tenantKey};
    if(customerGlobalId){ await requireVisibleCustomer(req,customerGlobalId); filter.customerGlobalId=customerGlobalId; }
    if(scope.isLeaf) filter.salespersonId=req.auth.sub; else if(!scope.unrestricted&&scope.userIds?.length) filter.salespersonId={$in:scope.userIds};
    if(q){const rx=new RegExp(escapeRx(q),"i");filter.$or=[{competitorName:rx},{productName:rx},{customerNameSnapshot:rx},{notes:rx}];}
    const rows=await SalesCompetitorIntel.find(filter).sort({capturedAt:-1,createdAt:-1}).limit(limit).lean();
    return ok(res,{items:rows.map(x=>({...x,id:String(x._id)}))});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/competitors", async(req,res)=>{
  try{
    const body=req.body||{}; const competitorName=clean(body.competitorName); if(!competitorName)return fail(res,"Competitor name is required",400);
    const customerGlobalId=clean(body.customerGlobalId); let customer=null;
    if(customerGlobalId) customer=await requireVisibleCustomer(req,customerGlobalId);
    const clientMutationId=clean(body.clientMutationId);
    if(clientMutationId){const existing=await SalesCompetitorIntel.findOne({tenantKey:req.auth.tenantKey,clientMutationId}).lean();if(existing)return ok(res,existing,"Already synced");}
    const me=await User.findOne({_id:req.auth.sub,tenantKey:req.auth.tenantKey}).select("name").lean();
    const doc=await SalesCompetitorIntel.create({tenantKey:req.auth.tenantKey,competitorId:makeId("COMP"),clientMutationId:clientMutationId||undefined,salespersonId:req.auth.sub,salespersonNameSnapshot:me?.name||req.auth.name||"",customerGlobalId,customerNameSnapshot:customer?customerName(customer):clean(body.customerName),leadObjectId:objectIdText(body.leadId)?body.leadId:undefined,competitorName,productId:clean(body.productId),productName:clean(body.productName),quotedRate:money(body.quotedRate),scheme:clean(body.scheme),creditDays:num(body.creditDays),reasonCustomerPrefers:clean(body.reasonCustomerPrefers),strengths:clean(body.strengths),weaknesses:clean(body.weaknesses),notes:clean(body.notes),source:["VOICE","OCR"].includes(upper(body.source))?upper(body.source):"MANUAL",capturedAt:body.capturedAt?new Date(body.capturedAt):new Date(),location:body.location||{},createdBy:req.auth.sub});
    return ok(res,doc,"Competitor intelligence saved",201);
  }catch(error){if(error?.code===11000&&req.body?.clientMutationId){const row=await SalesCompetitorIntel.findOne({tenantKey:req.auth.tenantKey,clientMutationId:req.body.clientMutationId}).lean();if(row)return ok(res,row,"Already synced");}return fail(res,error.message,error.statusCode||400);}
});

router.get("/competitors/summary", async(req,res)=>{
  try{
    const scope=await visibility(req); const match={tenantKey:req.auth.tenantKey};
    if(scope.isLeaf)match.salespersonId=req.auth.sub;else if(!scope.unrestricted&&scope.userIds?.length)match.salespersonId={$in:scope.userIds};
    const rows=await SalesCompetitorIntel.aggregate([{$match:match},{$group:{_id:"$competitorName",mentions:{$sum:1},avgQuotedRate:{$avg:"$quotedRate"},customers:{$addToSet:"$customerGlobalId"},lastSeenAt:{$max:"$capturedAt"}}},{$sort:{mentions:-1}},{$limit:30}]);
    return ok(res,{items:rows.map(x=>({competitorName:x._id,mentions:x.mentions,avgQuotedRate:money(x.avgQuotedRate),customerCount:(x.customers||[]).filter(Boolean).length,lastSeenAt:x.lastSeenAt}))});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/notifications", async(req,res)=>{
  try{
    const financialYear=fyOf(req); const opportunities=await opportunityItemsForUser({req,financialYear,limit:80});
    const notifications=opportunities.slice(0,40).map(notificationFromOpportunity);
    const { SalespersonCashMovement, SalespersonDayClosing, SalesOrder }=financialModels(req.auth.tenantKey,financialYear);
    const [cashPending,closingReview,creditHolds]=await Promise.all([
      SalespersonCashMovement.countDocuments({tenantKey:req.auth.tenantKey,financialYear,salespersonId:req.auth.sub,status:"PENDING"}),
      SalespersonDayClosing.countDocuments({tenantKey:req.auth.tenantKey,financialYear,salespersonId:req.auth.sub,status:"REVIEW_REQUIRED"}),
      SalesOrder.countDocuments({tenantKey:req.auth.tenantKey,financialYear,salespersonId:req.auth.sub,status:"CREDIT_HOLD"}),
    ]);
    if(cashPending)notifications.unshift({id:"CASH:PENDING",type:"CASH_CONTROL",severity:"HIGH",title:"Cash verification pending",body:`${cashPending} cash handover/deposit item(s) are waiting for verification.`,action:"CASH",createdAt:new Date().toISOString()});
    if(closingReview)notifications.unshift({id:"CASH:CLOSING_REVIEW",type:"DAY_CLOSING",severity:"CRITICAL",title:"Day closing needs review",body:`${closingReview} closing variance case(s) are still open.`,action:"CASH",createdAt:new Date().toISOString()});
    if(creditHolds)notifications.unshift({id:"ORDER:CREDIT_HOLD",type:"CREDIT_HOLD",severity:"HIGH",title:"Orders on credit hold",body:`${creditHolds} order(s) are waiting for credit approval.`,action:"ORDERS",createdAt:new Date().toISOString()});
    const counts=notifications.reduce((a,x)=>{a[x.severity]=(a[x.severity]||0)+1;return a;},{});
    return ok(res,{items:notifications.slice(0,60),counts,generatedAt:new Date()});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/ai/next-best-action", async(req,res)=>{
  try{
    const financialYear=fyOf(req); const items=await opportunityItemsForUser({req,financialYear,limit:12}); const best=items[0]||null;
    const signals=items.slice(0,6).map(x=>({type:x.type,score:x.score,priority:x.priority,amount:x.amount||0,customerName:x.customerName||""}));
    const recommendation=best?{...best,why:[best.priority&&`Priority: ${best.priority}`,num(best.amount)>0&&`Commercial value: ₹${money(best.amount).toLocaleString("en-IN")}`,best.type&&`Signal: ${best.type.replaceAll("_"," ")}`].filter(Boolean),confidence:Math.max(55,Math.min(98,Math.round(55+Math.min(43,num(best.score)/4))))}:{title:"No urgent action",subtitle:"No high-priority sales or collection action is waiting.",action:"NONE",confidence:90,why:["Current priority queue is clear"]};
    return ok(res,{engine:"RUPIO_DECISION_ENGINE_V2",financialYear,recommendation,signals,generatedAt:new Date()});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/team/intelligence", async(req,res)=>{
  try{
    const financialYear=fyOf(req), now=new Date(), monthStart=new Date(now.getFullYear(),now.getMonth(),1), monthEnd=new Date(now.getFullYear(),now.getMonth()+1,1);
    const {scope,user}=await roleScope(req);
    if(scope.isLeaf)return fail(res,"Team intelligence is available to Sales Head / Sales Manager roles",403);
    const userIds=scope.unrestricted?[]:(scope.userIds||[]);
    const userFilter={tenantKey:req.auth.tenantKey,status:"ACTIVE"}; if(userIds.length)userFilter._id={$in:userIds}; else if(!scope.unrestricted)userFilter._id={$exists:false};
    const members=await User.find(userFilter).select("_id name email mobile role roleId assignedToUserId coveragePincodes").sort({name:1}).lean();
    const memberIds=members.map(x=>String(x._id));
    const customers=memberIds.length?await CustomerLink.find({tenantKey:req.auth.tenantKey,status:"ACTIVE",salespersonId:{$in:memberIds}}).select("globalCustomerId salespersonId accountingProfile").lean():[];
    const customerIds=customers.map(x=>x.globalCustomerId); const ownerByCustomer=new Map(customers.map(x=>[x.globalCustomerId,String(x.salespersonId||"")]));
    const {SalesInvoice,Receipt}=financialModels(req.auth.tenantKey,financialYear);
    const [invoiceRows,receiptRows,visitRows,leadRows,balanceMap,targets]=await Promise.all([
      customerIds.length?SalesInvoice.aggregate([{$match:{tenantKey:req.auth.tenantKey,financialYear,customerGlobalId:{$in:customerIds},status:"POSTED",date:{$gte:monthStart,$lt:monthEnd}}},{$group:{_id:"$customerGlobalId",sales:{$sum:"$grandTotal"},invoices:{$sum:1}}}]):[],
      memberIds.length?Receipt.aggregate([{$match:{tenantKey:req.auth.tenantKey,financialYear,status:"POSTED",date:{$gte:monthStart,$lt:monthEnd},collectedBySalespersonId:{$in:memberIds}}},{$group:{_id:"$collectedBySalespersonId",collections:{$sum:"$amount"},receipts:{$sum:1}}}]):[],
      memberIds.length ? CustomerVisit.aggregate([
        {
          $match: {
            tenantKey: req.auth.tenantKey,
            salespersonId: { $in: memberIds },
            startedAt: { $gte: monthStart, $lt: monthEnd },
          },
        },
        {
          $group: {
            _id: "$salespersonId",
            visits: { $sum: 1 },
            autoVisits: {
              $sum: {
                $cond: [{ $eq: ["$source", "AUTO_DETECTED"] }, 1, 0],
              },
            },
          },
        },
      ]) : [],
      memberIds.length ? Lead.aggregate([
        {
          $match: {
            tenantKey: req.auth.tenantKey,
            assignedUserId: { $in: memberIds },
            deletedAt: { $exists: false },
          },
        },
        {
          $group: {
            _id: "$assignedUserId",
            leads: { $sum: 1 },
            openLeads: {
              $sum: {
                $cond: [{ $in: ["$stage", ["NEW", "ASSIGNED", "FOLLOW_UP"]] }, 1, 0],
              },
            },
            converted: {
              $sum: {
                $cond: [{ $eq: ["$stage", "CUSTOMER"] }, 1, 0],
              },
            },
          },
        },
      ]) : [],
      receivableMap({tenantKey:req.auth.tenantKey,financialYear,customerIds}),
      Target.find({tenantKey:req.auth.tenantKey,financialYear,level:"USER",entityId:{$in:memberIds},status:{$ne:"CANCELLED"}}).lean(),
    ]);
    const agg=new Map(members.map(m=>[String(m._id),{userId:String(m._id),name:m.name,role:m.role,customers:0,sales:0,invoices:0,collections:0,receipts:0,visits:0,autoVisits:0,leads:0,openLeads:0,converted:0,outstanding:0,target:0}]));
    for(const c of customers){const id=ownerByCustomer.get(c.globalCustomerId);const a=agg.get(id);if(a){a.customers+=1;a.outstanding+=num(balanceMap.get(c.globalCustomerId))+openingSigned(c,financialYear);}}
    for(const r of invoiceRows){const a=agg.get(ownerByCustomer.get(String(r._id)));if(a){a.sales+=num(r.sales);a.invoices+=num(r.invoices);}}
    for(const r of receiptRows){const a=agg.get(String(r._id));if(a){a.collections+=num(r.collections);a.receipts+=num(r.receipts);}}
    for(const r of visitRows){const a=agg.get(String(r._id));if(a){a.visits+=num(r.visits);a.autoVisits+=num(r.autoVisits);}}
    for(const r of leadRows){const a=agg.get(String(r._id));if(a){a.leads+=num(r.leads);a.openLeads+=num(r.openLeads);a.converted+=num(r.converted);}}
    const mk=monthKey(now).toLowerCase(); for(const t of targets){const a=agg.get(String(t.entityId));if(!a)continue;const row=(t.monthly||[]).find(x=>clean(x.month).toLowerCase()===mk);a.target=num(row?.sales)||(num(t.annual?.sales)>0?num(t.annual.sales)/12:0);}
    const rows=[...agg.values()].map(a=>({...a,sales:money(a.sales),collections:money(a.collections),outstanding:money(Math.max(0,a.outstanding)),target:money(a.target),achievementPct:a.target>0?Math.round(a.sales/a.target*1000)/10:0,conversionPct:a.leads>0?Math.round(a.converted/a.leads*1000)/10:0,collectionToSalesPct:a.sales>0?Math.round(a.collections/a.sales*1000)/10:0})).sort((a,b)=>b.sales-a.sales);
    const totals=rows.reduce((x,r)=>({members:x.members+1,customers:x.customers+r.customers,sales:x.sales+r.sales,collections:x.collections+r.collections,outstanding:x.outstanding+r.outstanding,visits:x.visits+r.visits,openLeads:x.openLeads+r.openLeads,converted:x.converted+r.converted,target:x.target+r.target}),{members:0,customers:0,sales:0,collections:0,outstanding:0,visits:0,openLeads:0,converted:0,target:0});
    totals.achievementPct=totals.target>0?Math.round(totals.sales/totals.target*1000)/10:0;
    const attention=rows.filter(r=>r.openLeads>10||r.outstanding>0||(r.target>0&&r.achievementPct<70)).sort((a,b)=>(b.outstanding-a.outstanding)||(a.achievementPct-b.achievementPct)).slice(0,12);
    return ok(res,{role:user?.role||req.auth.role,totals,team:rows,attention,financialYear,month:monthKey(now)});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/customers", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(10, Number(req.query.limit || 50)));
    const q = clean(req.query.q);
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    if (q) {
      const rx = new RegExp(escapeRx(q), "i");
      filter.$or = [{ localName: rx }, { displayIdentifier: rx }, { companyContactNumber: rx }, { ownerMobile: rx }, { "contacts.mobile": rx }, { "addresses.pincode": rx }, { "addresses.city": rx }];
    }
    const [customers, total] = await Promise.all([
      CustomerLink.find(filter).sort({ localName: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      CustomerLink.countDocuments(filter),
    ]);
    const ids = customers.map((x) => x.globalCustomerId);
    const { SalesInvoice, Receipt, PromiseToPay } = financialModels(req.auth.tenantKey, financialYear);
    await markBrokenPromises(PromiseToPay, req.auth.tenantKey, financialYear, ids);
    const [gm, sales, receipts, balances, promises] = await Promise.all([
      globalsFor(ids),
      SalesInvoice.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" } },
        { $group: { _id: "$customerGlobalId", sales: { $sum: "$grandTotal" }, invoiceCount: { $sum: 1 }, lastInvoiceAt: { $max: "$date" } } },
      ]),
      Receipt.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" } },
        { $group: { _id: "$customerGlobalId", receipts: { $sum: "$amount" }, lastReceiptAt: { $max: "$date" } } },
      ]),
      receivableMap({ tenantKey: req.auth.tenantKey, financialYear, customerIds: ids }),
      PromiseToPay.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: { $in: ["OPEN", "PARTIAL", "BROKEN"] } } },
        { $group: { _id: "$customerGlobalId", openPromiseAmount: { $sum: { $cond: [{ $gt: [{ $subtract: ["$amount", "$fulfilledAmount"] }, 0] }, { $subtract: ["$amount", "$fulfilledAmount"] }, 0] } } } },
      ]),
    ]);
    const sm = new Map(sales.map((x) => [String(x._id), x]));
    const rm = new Map(receipts.map((x) => [String(x._id), x]));
    const pm = new Map(promises.map((x) => [String(x._id), x]));
    const items = customers.map((c) => {
      const s = sm.get(c.globalCustomerId) || {}, r = rm.get(c.globalCustomerId) || {}, p = pm.get(c.globalCustomerId) || {};
      return shapeCustomer(c, gm.get(c.globalCustomerId), { ...s, ...r, ...p, outstanding: num(balances.get(c.globalCustomerId)) + openingSigned(c, financialYear) });
    });
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/360", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const customer = await requireVisibleCustomer(req, req.params.globalId);
    const { SalesInvoice, Receipt, SalesOrder, PromiseToPay } = financialModels(req.auth.tenantKey, financialYear);
    await markBrokenPromises(PromiseToPay, req.auth.tenantKey, financialYear, [customer.globalCustomerId]);
    const [gm, salesAgg, receiptAgg, balanceMap, recentInvoices, recentReceipts, recentOrders, promises, dueBills, suggestions, recentCrmActivities] = await Promise.all([
      globalsFor([customer.globalCustomerId]),
      SalesInvoice.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" } }, { $group: { _id: null, sales: { $sum: "$grandTotal" }, invoiceCount: { $sum: 1 }, lastInvoiceAt: { $max: "$date" } } }]),
      Receipt.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" } }, { $group: { _id: null, receipts: { $sum: "$amount" }, receiptCount: { $sum: 1 }, lastReceiptAt: { $max: "$date" } } }]),
      receivableMap({ tenantKey: req.auth.tenantKey, financialYear, customerIds: [customer.globalCustomerId] }),
      SalesInvoice.find({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" }).select("invoiceNo date grandTotal workflowStatus items").sort({ date: -1 }).limit(5).lean(),
      Receipt.find({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" }).select("receiptNo date amount mode reference").sort({ date: -1 }).limit(5).lean(),
      SalesOrder.find({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId }).sort({ date: -1, createdAt: -1 }).limit(5).lean(),
      PromiseToPay.find({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: { $ne: "CANCELLED" } }).sort({ promiseDate: 1, createdAt: -1 }).limit(10).lean(),
      invoiceOutstandingForCustomer({ tenantKey: req.auth.tenantKey, financialYear, customer, onlyOpen: true }),
      productSuggestions({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, limit: 8 }),
      SalesCrmActivity.find({ tenantKey: req.auth.tenantKey, customerGlobalId: customer.globalCustomerId, status: "SAVED" }).select("activityId channel transcript structured outcome nextFollowUpAt createdAt salespersonNameSnapshot").sort({ createdAt: -1 }).limit(5).lean(),
    ]);
    const sales = salesAgg[0] || {}, receipts = receiptAgg[0] || {};
    const outstanding = money(num(balanceMap.get(customer.globalCustomerId)) + openingSigned(customer, financialYear));
    const overdueAmount = money(dueBills.filter((x) => x.overdueDays > 0).reduce((s, x) => s + x.outstanding, 0));
    const dueToday = money(dueBills.filter((x) => x.status === "DUE_TODAY").reduce((s, x) => s + x.outstanding, 0));
    const openPromiseAmount = money(promises.filter((x) => ["OPEN", "PARTIAL", "BROKEN"].includes(x.status)).reduce((s, x) => s + Math.max(0, num(x.amount) - num(x.fulfilledAmount)), 0));
    const pendingOrderAgg = await SalesOrder.aggregate([
      { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: { $in: ["SUBMITTED", "CREDIT_HOLD", "APPROVED", "PROCESSING"] } } },
      { $group: { _id: null, total: { $sum: "$grandTotal" }, count: { $sum: 1 } } },
    ]);
    const pendingOrderExposure = money(pendingOrderAgg[0]?.total || 0);
    const creditLimit = money(customer.creditLimit || customer.approvedTerms?.creditLimit || 0);
    const availableCredit = creditLimit > 0 ? money(Math.max(0, creditLimit - Math.max(0, outstanding) - pendingOrderExposure)) : 0;
    const creditUsedPct = creditLimit > 0 ? Math.round(Math.min(999, (Math.max(0, outstanding) + pendingOrderExposure) / creditLimit * 100) * 10) / 10 : 0;
    const [intelligence, lastVisit] = await Promise.all([
      customerSalesIntelligence({ tenantKey: req.auth.tenantKey, financialYear, customer, includeCrossSell: true }),
      CustomerVisit.findOne({ tenantKey: req.auth.tenantKey, customerGlobalId: customer.globalCustomerId, status: "COMPLETED" }).sort({ startedAt: -1 }).lean(),
    ]);
    const actionSummary = { outstanding, overdueAmount, dueToday, creditLimit, availableCredit, pendingOrderExposure, creditUsedPct, openPromiseAmount };
    const dynamicActions = dynamicCustomerActions({ summary: actionSummary, intelligence, visit: lastVisit });
    return ok(res, {
      customer: shapeCustomer(customer, gm.get(customer.globalCustomerId), { ...sales, ...receipts, outstanding, openPromiseAmount }),
      summary: {
        sales: money(sales.sales), invoiceCount: num(sales.invoiceCount), receipts: money(receipts.receipts), receiptCount: num(receipts.receiptCount),
        outstanding, overdueAmount, dueToday, openBills: dueBills.length, creditLimit, availableCredit,
        pendingOrderExposure, pendingOrderCount: num(pendingOrderAgg[0]?.count), creditUsedPct,
        openPromiseAmount, lastInvoiceAt: sales.lastInvoiceAt || null, lastReceiptAt: receipts.lastReceiptAt || null,
      },
      recentInvoices, recentReceipts, recentOrders, promises, dueBills: dueBills.slice(0, 10), suggestions, recentCrmActivities,
      intelligence, dynamicActions, lastVisit,
      financialYear,
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});


router.get("/customers/:globalId/intelligence", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const customer = await requireVisibleCustomer(req, req.params.globalId);
    const intelligence = await customerSalesIntelligence({ tenantKey: req.auth.tenantKey, financialYear, customer, includeCrossSell: true });
    return ok(res, { intelligence, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/invoices", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId);
    const page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
    const { SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
    const filter = { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: { $ne: "DELETED" } };
    const [items, total] = await Promise.all([
      SalesInvoice.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SalesInvoice.countDocuments(filter),
    ]);
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/ledger", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId, { activeOnly: false });
    const page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(200, Math.max(20, Number(req.query.limit || 100)));
    const { LedgerEntry } = financialModels(req.auth.tenantKey, financialYear);
    const all = await LedgerEntry.find({ tenantKey: req.auth.tenantKey, financialYear, partyGlobalId: customer.globalCustomerId, status: "POSTED" })
      .select("transactionId transactionType date accountCode debit credit narration createdAt").sort({ date: 1, createdAt: 1 }).lean();
    let running = openingSigned(customer, financialYear);
    const rows = all.map((row) => {
      if (row.accountCode === "SYS_SUNDRY_DEBTORS") running += num(row.debit) - num(row.credit);
      return { ...row, runningBalance: money(running), balanceType: running >= 0 ? "DR" : "CR" };
    });
    const desc = [...rows].reverse(); const total = desc.length; const items = desc.slice((page - 1) * limit, page * limit);
    const totalDebit = all.reduce((s, x) => s + num(x.debit), 0), totalCredit = all.reduce((s, x) => s + num(x.credit), 0);
    return ok(res, {
      customer: { id: customer.globalCustomerId, name: customerName(customer) },
      items,
      summary: { openingBalance: money(Math.abs(openingSigned(customer, financialYear))), openingBalanceType: openingSigned(customer, financialYear) >= 0 ? "DR" : "CR", totalDebit: money(totalDebit), totalCredit: money(totalCredit), closingBalance: money(Math.abs(running)), closingBalanceType: running >= 0 ? "DR" : "CR" },
      meta: pageMeta(page, limit, total), financialYear,
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/due-bills", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId);
    const bills = await invoiceOutstandingForCustomer({ tenantKey: req.auth.tenantKey, financialYear, customer, onlyOpen: upper(req.query.all) !== "TRUE" });
    const outstanding = money(bills.reduce((s, x) => s + x.outstanding, 0));
    const overdue = money(bills.filter((x) => x.overdueDays > 0).reduce((s, x) => s + x.outstanding, 0));
    return ok(res, { customer: { id: customer.globalCustomerId, name: customerName(customer), creditDays: num(customer.creditDays), creditLimit: num(customer.creditLimit || customer.approvedTerms?.creditLimit) }, items: bills.sort((a, b) => (b.overdueDays - a.overdueDays) || (new Date(a.dueDate) - new Date(b.dueDate))), summary: { outstanding, overdue, openBills: bills.filter((x) => x.outstanding > 0).length }, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/collection-priority", async (req, res) => {
  try {
    const financialYear = fyOf(req); const limit = Math.min(200, Math.max(10, Number(req.query.limit || 75))); const q = clean(req.query.q);
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    if (q) { const rx = new RegExp(escapeRx(q), "i"); filter.$or = [{ localName: rx }, { displayIdentifier: rx }, { companyContactNumber: rx }, { ownerMobile: rx }, { "addresses.pincode": rx }]; }
    const customers = await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses creditDays creditLimit accountingProfile salespersonId").lean();
    const ids = customers.map((x) => x.globalCustomerId); const { SalesInvoice, Receipt, PromiseToPay } = financialModels(req.auth.tenantKey, financialYear);
    await markBrokenPromises(PromiseToPay, req.auth.tenantKey, financialYear, ids);
    const [invoices, receiptAgg, balanceMap, promises] = await Promise.all([
      SalesInvoice.find({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" }).select("customerGlobalId invoiceNo date grandTotal").sort({ date: 1 }).lean(),
      Receipt.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED" } }, { $group: { _id: "$customerGlobalId", total: { $sum: "$amount" }, lastReceiptAt: { $max: "$date" } } }]),
      receivableMap({ tenantKey: req.auth.tenantKey, financialYear, customerIds: ids }),
      PromiseToPay.find({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: { $in: ["OPEN", "PARTIAL", "BROKEN"] } }).lean(),
    ]);
    const im = new Map(); for (const inv of invoices) { if (!im.has(inv.customerGlobalId)) im.set(inv.customerGlobalId, []); im.get(inv.customerGlobalId).push(inv); }
    const rm = new Map(receiptAgg.map((x) => [String(x._id), x])); const pm = new Map(); for (const p of promises) { if (!pm.has(p.customerGlobalId)) pm.set(p.customerGlobalId, []); pm.get(p.customerGlobalId).push(p); }
    const today = startOfDay(new Date());
    const items = customers.map((c) => {
      const r = rm.get(c.globalCustomerId) || {}; const bills = allocateReceiptsToInvoices(im.get(c.globalCustomerId) || [], r.total || 0, c.creditDays || 0).filter((x) => x.outstanding > 0);
      const overdueAmount = money(bills.filter((x) => x.overdueDays > 0).reduce((s, x) => s + x.outstanding, 0)); const dueToday = money(bills.filter((x) => x.status === "DUE_TODAY").reduce((s, x) => s + x.outstanding, 0));
      const customerPromises = pm.get(c.globalCustomerId) || []; const broken = customerPromises.filter((x) => x.status === "BROKEN"); const todayPromise = customerPromises.filter((x) => ["OPEN", "PARTIAL"].includes(x.status) && daysBetween(x.promiseDate, today) === 0);
      const promisedToday = money(todayPromise.reduce((s, x) => s + Math.max(0, num(x.amount) - num(x.fulfilledAmount)), 0)); const brokenPromiseAmount = money(broken.reduce((s, x) => s + Math.max(0, num(x.amount) - num(x.fulfilledAmount)), 0));
      const maxOverdueDays = bills.reduce((m, x) => Math.max(m, x.overdueDays), 0); const outstanding = money(num(balanceMap.get(c.globalCustomerId)) + openingSigned(c, financialYear));
      const score = Math.round((Math.min(50, overdueAmount / 2000) + Math.min(35, maxOverdueDays) + (promisedToday > 0 ? 25 : 0) + (broken.length ? 30 : 0) + (dueToday > 0 ? 12 : 0)) * 10) / 10;
      return { customer: shapeCustomer(c, null, { outstanding }), outstanding, overdueAmount, dueToday, promisedToday, brokenPromiseAmount, maxOverdueDays, openBills: bills.length, priorityScore: score, priority: broken.length || maxOverdueDays > 30 ? "CRITICAL" : promisedToday > 0 || overdueAmount > 0 ? "HIGH" : dueToday > 0 ? "MEDIUM" : "NORMAL", nextPromise: customerPromises.sort((a, b) => new Date(a.promiseDate) - new Date(b.promiseDate))[0] || null };
    }).filter((x) => x.outstanding > 0 || x.promisedToday > 0 || x.brokenPromiseAmount > 0).sort((a, b) => b.priorityScore - a.priorityScore).slice(0, limit);
    return ok(res, { items, financialYear, total: items.length });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/products", async (req, res) => {
  try {
    const q = clean(req.query.q), page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 50)));
    const filter = { tenantKey: req.auth.tenantKey, status: "ACTIVE" }; if (q) { const rx = new RegExp(escapeRx(q), "i"); filter.$or = [{ name: rx }, { sku: rx }, { category: rx }, { hsnCode: rx }]; }
    const [rows, total] = await Promise.all([Product.find(filter).select("sku name category subCategory hsnCode gstRate basicUnit packingUnit qtyInBag currentStock mrp salePrice").sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(), Product.countDocuments(filter)]);
    const items = rows.map((p) => ({ productId: String(p._id), sku: p.sku, name: p.name, category: p.category, subCategory: p.subCategory, hsnCode: p.hsnCode, gstRate: num(p.gstRate), unit: p.basicUnit || "PCS", packingUnit: p.packingUnit || "", qtyInBag: num(p.qtyInBag || 1), currentStock: num(p.currentStock), mrp: num(p.mrp), listRate: num(p.salePrice) }));
    return ok(res, { items, meta: pageMeta(page, limit, total) });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/orders", async (req, res) => {
  try {
    const financialYear = fyOf(req), page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
    const { SalesOrder } = financialModels(req.auth.tenantKey, financialYear); const { filter: customerFilter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    const visible = await CustomerLink.find(customerFilter).select("globalCustomerId").lean(); const ids = visible.map((x) => x.globalCustomerId);
    const filter = { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids } }; if (req.query.customerGlobalId) filter.customerGlobalId = clean(req.query.customerGlobalId); if (req.query.status) filter.status = upper(req.query.status);
    const [items, total] = await Promise.all([SalesOrder.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SalesOrder.countDocuments(filter)]);
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/orders/last/:globalId", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId); const { SalesOrder, SalesInvoice } = financialModels(req.auth.tenantKey, financialYear);
    const order = await SalesOrder.findOne({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: { $nin: ["CANCELLED", "REJECTED"] } }).sort({ date: -1, createdAt: -1 }).lean();
    if (order) return ok(res, { source: "ORDER", order });
    const invoice = await SalesInvoice.findOne({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: "POSTED" }).sort({ date: -1, createdAt: -1 }).lean();
    return ok(res, { source: invoice ? "INVOICE" : "NONE", invoice: invoice || null });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/orders/suggestions/:globalId", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId); const items = await productSuggestions({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, limit: Number(req.query.limit || 20) });
    return ok(res, { items, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/orders", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.body.customerGlobalId); const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rawItems.length) return fail(res, "Add at least one product to the order", 400);
    const ids = [...new Set(rawItems.map((x) => clean(x.productId)).filter(objectIdText))]; const products = await Product.find({ tenantKey: req.auth.tenantKey, _id: { $in: ids }, status: "ACTIVE" }).lean(); const pm = new Map(products.map((p) => [String(p._id), p]));
    const items = []; let subtotal = 0, discountTotal = 0, taxTotal = 0, grandTotal = 0;
    for (const row of rawItems) {
      const p = pm.get(clean(row.productId)); if (!p) return fail(res, `Product ${row.productId || ""} is not available`, 400); const qty = num(row.qty); if (qty <= 0) continue;
      const listRate = num(p.salePrice); const rate = row.rate === undefined || row.rate === null || row.rate === "" ? listRate : Math.max(0, num(row.rate)); const discountPct = Math.min(100, Math.max(0, num(row.discountPct))); const gross = qty * rate; const discount = gross * discountPct / 100; const taxable = money(gross - discount); const gstRate = num(p.gstRate); const tax = money(taxable * gstRate / 100); const lineTotal = money(taxable + tax);
      subtotal += gross; discountTotal += discount; taxTotal += tax; grandTotal += lineTotal;
      items.push({ productId: String(p._id), sku: p.sku, nameSnapshot: p.name, hsnSnapshot: p.hsnCode, qty, unit: p.basicUnit || "PCS", packingUnit: p.packingUnit || "", qtyInBag: num(p.qtyInBag || 1), listRate, rate, discountPct, taxable, gstRateSnapshot: gstRate, tax, lineTotal });
    }
    if (!items.length) return fail(res, "Enter quantity for at least one product", 400);
    const { SalesOrder } = financialModels(req.auth.tenantKey, financialYear);
    const [balanceMap, pendingAgg] = await Promise.all([
      receivableMap({ tenantKey: req.auth.tenantKey, financialYear, customerIds: [customer.globalCustomerId] }),
      SalesOrder.aggregate([
        { $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, status: { $in: ["SUBMITTED", "CREDIT_HOLD", "APPROVED", "PROCESSING"] } } },
        { $group: { _id: null, total: { $sum: "$grandTotal" } } },
      ]),
    ]);
    const receivableBeforeOrder = money(num(balanceMap.get(customer.globalCustomerId)) + openingSigned(customer, financialYear));
    const pendingOrderExposure = money(pendingAgg[0]?.total || 0);
    const creditLimit = money(customer.creditLimit || customer.approvedTerms?.creditLimit || 0);
    const projectedExposure = money(Math.max(0, receivableBeforeOrder) + pendingOrderExposure + grandTotal);
    const availableBeforeOrder = creditLimit > 0 ? money(Math.max(0, creditLimit - Math.max(0, receivableBeforeOrder) - pendingOrderExposure)) : 0;
    const exceededBy = creditLimit > 0 ? money(Math.max(0, projectedExposure - creditLimit)) : 0;
    const creditHold = creditLimit > 0 && exceededBy > 0;
    let orderNo = clean(req.body.orderNo) || makeId("SO");
    while (await SalesOrder.exists({ tenantKey: req.auth.tenantKey, financialYear, orderNo })) orderNo = makeId("SO");
    const order = await SalesOrder.create({
      tenantKey: req.auth.tenantKey,
      financialYear,
      orderNo,
      date: req.body.date ? new Date(req.body.date) : new Date(),
      customerGlobalId: customer.globalCustomerId,
      customerNameSnapshot: customerName(customer),
      salespersonId: clean(customer.salespersonId || req.auth.sub),
      source: ["MANUAL", "REPEAT", "SUGGESTED"].includes(upper(req.body.source)) ? upper(req.body.source) : "MANUAL",
      repeatFromOrderNo: clean(req.body.repeatFromOrderNo),
      repeatFromInvoiceNo: clean(req.body.repeatFromInvoiceNo),
      items,
      subtotal: money(subtotal), discountTotal: money(discountTotal), taxTotal: money(taxTotal), grandTotal: money(grandTotal),
      remarks: clean(req.body.remarks),
      status: creditHold ? "CREDIT_HOLD" : "SUBMITTED",
      creditControl: {
        creditLimit,
        receivableBeforeOrder,
        pendingOrderExposure,
        availableBeforeOrder,
        orderAmount: money(grandTotal),
        projectedExposure,
        exceededBy,
        holdReason: creditHold ? `Credit limit exceeded by ₹${exceededBy.toLocaleString("en-IN")}` : "",
        checkedAt: new Date(),
      },
      createdBy: req.auth.sub,
      createdByNameSnapshot: req.auth.name || "",
    });
    return ok(res, order, creditHold ? "Order saved on credit hold for approval" : "Sales order submitted", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/orders/:id/credit-decision", async (req, res) => {
  try {
    if (!isAdminAuth(req.auth)) return fail(res, "Administrator approval is required", 403);
    const financialYear = fyOf(req);
    const { SalesOrder } = financialModels(req.auth.tenantKey, financialYear);
    const order = await SalesOrder.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!order) return fail(res, "Sales order not found", 404);
    if (order.status !== "CREDIT_HOLD") return ok(res, order, `Order is already ${order.status}`);
    const action = upper(req.body.action || "APPROVE");
    if (!["APPROVE", "REJECT"].includes(action)) return fail(res, "Action must be APPROVE or REJECT", 400);
    order.status = action === "APPROVE" ? "APPROVED" : "REJECTED";
    order.creditControl = {
      ...(order.creditControl?.toObject?.() || order.creditControl || {}),
      decision: action,
      decisionBy: req.auth.sub,
      decisionByNameSnapshot: req.auth.name || "",
      decisionAt: new Date(),
      decisionRemark: clean(req.body.remarks),
    };
    await order.save();
    return ok(res, order, action === "APPROVE" ? "Credit hold approved" : "Credit hold rejected");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/customers/:globalId/promises", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId); const { PromiseToPay } = financialModels(req.auth.tenantKey, financialYear); await markBrokenPromises(PromiseToPay, req.auth.tenantKey, financialYear, [customer.globalCustomerId]);
    const items = await PromiseToPay.find({ tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: customer.globalCustomerId }).sort({ promiseDate: -1, createdAt: -1 }).limit(200).lean(); return ok(res, { items, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/customers/:globalId/promises", async (req, res) => {
  try {
    const financialYear = fyOf(req); const customer = await requireVisibleCustomer(req, req.params.globalId); const amount = money(req.body.amount); if (amount <= 0) return fail(res, "Promise amount must be greater than zero", 400); const promiseDate = new Date(req.body.promiseDate); if (Number.isNaN(promiseDate.getTime())) return fail(res, "Promise date is required", 400);
    const { PromiseToPay } = financialModels(req.auth.tenantKey, financialYear); let promiseNo = makeId("PTP"); while (await PromiseToPay.exists({ tenantKey: req.auth.tenantKey, financialYear, promiseNo })) promiseNo = makeId("PTP");
    const promise = await PromiseToPay.create({ tenantKey: req.auth.tenantKey, financialYear, promiseNo, customerGlobalId: customer.globalCustomerId, customerNameSnapshot: customerName(customer), salespersonId: clean(customer.salespersonId || req.auth.sub), amount, promiseDate, invoiceNos: Array.isArray(req.body.invoiceNos) ? req.body.invoiceNos.map(clean).filter(Boolean) : [], remarks: clean(req.body.remarks), status: "OPEN", fulfilledAmount: 0, lastActionAt: new Date(), createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "" });
    return ok(res, promise, "Promise to pay saved", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/promises/:id", async (req, res) => {
  try {
    const financialYear = fyOf(req); const { PromiseToPay } = financialModels(req.auth.tenantKey, financialYear); const promise = await PromiseToPay.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear }); if (!promise) return fail(res, "Promise not found", 404); await requireVisibleCustomer(req, promise.customerGlobalId);
    if (req.body.amount !== undefined) { const v = money(req.body.amount); if (v <= 0) return fail(res, "Promise amount must be greater than zero", 400); promise.amount = v; }
    if (req.body.promiseDate !== undefined) { const d = new Date(req.body.promiseDate); if (Number.isNaN(d.getTime())) return fail(res, "Invalid promise date", 400); promise.promiseDate = d; }
    if (req.body.remarks !== undefined) promise.remarks = clean(req.body.remarks);
    if (req.body.fulfilledAmount !== undefined) promise.fulfilledAmount = Math.max(0, money(req.body.fulfilledAmount));
    if (req.body.status !== undefined) { const status = upper(req.body.status); if (!["OPEN", "PARTIAL", "FULFILLED", "BROKEN", "CANCELLED"].includes(status)) return fail(res, "Invalid promise status", 400); promise.status = status; }
    if (promise.fulfilledAmount >= promise.amount && promise.amount > 0) promise.status = "FULFILLED"; else if (promise.fulfilledAmount > 0 && promise.status !== "CANCELLED") promise.status = "PARTIAL"; promise.lastActionAt = new Date(); await promise.save(); return ok(res, promise, "Promise updated");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});


// ---------------------------
// V2 Sales Person cash system
// ---------------------------
router.get("/cash/receivers", async (req, res) => {
  try {
    const items = await User.find({
      tenantKey: req.auth.tenantKey,
      status: "ACTIVE",
      _id: { $ne: req.auth.sub },
    }).select("name role accountType departmentId mobile").sort({ name: 1 }).limit(500).lean();
    return ok(res, { items: items.map((x) => ({ id: String(x._id), name: x.name || "User", role: x.role || x.accountType || "", mobile: x.mobile || "" })) });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/verification-inbox", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const admin = isAdminAuth(req.auth);
    const { SalespersonCashMovement, SalespersonDayClosing, SalesOrder } = financialModels(req.auth.tenantKey, financialYear);
    const movementFilter = { tenantKey: req.auth.tenantKey, financialYear, status: "PENDING", type: { $in: ["HANDOVER", "BANK_DEPOSIT"] } };
    if (!admin) movementFilter.recipientUserId = clean(req.auth.sub);
    const [movements, closings, creditHolds] = await Promise.all([
      SalespersonCashMovement.find(movementFilter).sort({ date: -1, createdAt: -1 }).limit(200).lean(),
      admin ? SalespersonDayClosing.find({ tenantKey: req.auth.tenantKey, financialYear, status: "REVIEW_REQUIRED" }).sort({ closingDate: -1 }).limit(200).lean() : Promise.resolve([]),
      admin ? SalesOrder.find({ tenantKey: req.auth.tenantKey, financialYear, status: "CREDIT_HOLD" }).sort({ date: -1, createdAt: -1 }).limit(200).lean() : Promise.resolve([]),
    ]);
    return ok(res, { movements, dayClosings: closings, creditHolds, admin, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/banks", async (req, res) => {
  try {
    const items = await BankAccount.find({ tenantKey: req.auth.tenantKey, status: "ACTIVE" })
      .select("bankAccountId bankName branchName accountHolderName accountNumber ifsc upiId isPrimary ledgerId")
      .sort({ isPrimary: -1, bankName: 1 }).lean();
    return ok(res, { items });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/customers/:globalId/cash-collection", async (req, res) => {
  let receipt = null, movement = null, ledgerPosted = false;
  try {
    const financialYear = fyOf(req);
    const customer = await requireVisibleCustomer(req, req.params.globalId);
    const amount = money(req.body.amount);
    if (amount <= 0) return fail(res, "Cash collection amount must be greater than zero", 400);
    const date = req.body.date ? new Date(req.body.date) : new Date();
    if (Number.isNaN(date.getTime())) return fail(res, "Invalid collection date", 400);
    const tenantKey = req.auth.tenantKey;
    const { Receipt, SalespersonCashMovement } = financialModels(tenantKey, financialYear);
    let receiptNo = clean(req.body.receiptNo) || makeId("RCT");
    while (await Receipt.exists({ tenantKey, financialYear, receiptNo })) receiptNo = makeId("RCT");
    let movementNo = makeId("CASH");
    while (await SalespersonCashMovement.exists({ tenantKey, financialYear, movementNo })) movementNo = makeId("CASH");
    receipt = await Receipt.create({
      tenantKey, financialYear, receiptNo, date,
      customerGlobalId: customer.globalCustomerId,
      partyNameSnapshot: customerName(customer),
      amount, mode: "CASH", reference: clean(req.body.reference), remarks: clean(req.body.remarks),
      bounceStatus: "CLEAR",
      collectedBySalespersonId: req.auth.sub,
      collectionSource: "SALESPERSON_APP",
      createdBy: req.auth.sub,
      createdByNameSnapshot: req.auth.name || "",
      status: "PENDING_POSTING",
    });
    movement = await SalespersonCashMovement.create({
      tenantKey, financialYear, movementNo, salespersonId: req.auth.sub,
      salespersonNameSnapshot: req.auth.name || "", date, dayKey: localDateKey(date),
      type: "COLLECTION", direction: "IN", amount,
      customerGlobalId: customer.globalCustomerId, customerNameSnapshot: customerName(customer),
      receiptId: String(receipt._id), receiptNo, reference: clean(req.body.reference), remarks: clean(req.body.remarks),
      status: "PENDING", createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "",
    });
    await postBalancedEntries({
      tenantKey, financialYear, transactionId: receiptNo, transactionType: "RECEIPT", date,
      partyGlobalId: customer.globalCustomerId,
      narration: clean(req.body.remarks) || `Cash collection ${receiptNo}`,
      entries: [
        { accountCode: "SYS_CASH", debit: amount },
        { accountCode: "SYS_SUNDRY_DEBTORS", credit: amount },
      ],
    });
    ledgerPosted = true;
    receipt.status = "POSTED";
    receipt.cashCustodyMovementId = String(movement._id);
    await receipt.save();
    movement.status = "POSTED";
    movement.accountingTransactionId = receiptNo;
    await movement.save();
    const promiseApplications = await fulfillPromisesFromReceipt({
      tenantKey, financialYear, customerGlobalId: customer.globalCustomerId, receiptId: receipt._id, amount,
    });
    const balanceMap = await receivableMap({ tenantKey, financialYear, customerIds: [customer.globalCustomerId] });
    const outstanding = money(num(balanceMap.get(customer.globalCustomerId)) + openingSigned(customer, financialYear));
    const cash = await cashSummaryForUser({ tenantKey, financialYear, salespersonId: req.auth.sub });
    return ok(res, { receipt: receipt.toObject(), movement: movement.toObject(), outstanding, cashInHand: cash.cashInHand, promiseApplications }, "Cash collection posted", 201);
  } catch (error) {
    if (!ledgerPosted) {
      if (receipt?._id && receipt.status === "PENDING_POSTING") await receipt.deleteOne().catch(() => {});
      if (movement?._id && movement.status === "PENDING") await movement.deleteOne().catch(() => {});
    } else {
      // Once accounting is posted, never remove the audit documents. Best-effort align their status instead.
      if (receipt?._id && receipt.status !== "POSTED") {
        receipt.status = "POSTED";
        if (movement?._id) receipt.cashCustodyMovementId = String(movement._id);
        await receipt.save().catch(() => {});
      }
      if (movement?._id && movement.status !== "POSTED") {
        movement.status = "POSTED";
        movement.accountingTransactionId = receipt?.receiptNo || movement.accountingTransactionId || "";
        await movement.save().catch(() => {});
      }
    }
    return fail(res, error.message, error.statusCode || 500);
  }
});

router.get("/cash/summary", async (req, res) => {
  try {
    const financialYear = fyOf(req);
    const at = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(at.getTime())) return fail(res, "Invalid date", 400);
    const [summary, target] = await Promise.all([
      cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, at }),
      collectionTargetForUser({ tenantKey: req.auth.tenantKey, financialYear, userId: req.auth.sub, at }),
    ]);
    const { SalespersonCashMovement, SalespersonDayClosing } = financialModels(req.auth.tenantKey, financialYear);
    const [recent, closing] = await Promise.all([
      SalespersonCashMovement.find({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub }).sort({ date: -1, createdAt: -1 }).limit(25).lean(),
      SalespersonDayClosing.findOne({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, dayKey: localDateKey(at) }).lean(),
    ]);
    return ok(res, { ...summary, collectionTarget: target, recentMovements: recent, dayClosing: closing || null, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/movements", async (req, res) => {
  try {
    const financialYear = fyOf(req), page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 50)));
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const filter = { tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub };
    if (req.query.type) filter.type = upper(req.query.type);
    if (req.query.status) filter.status = upper(req.query.status);
    const [items, total] = await Promise.all([
      SalespersonCashMovement.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SalespersonCashMovement.countDocuments(filter),
    ]);
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cash/handover", async (req, res) => {
  try {
    const financialYear = fyOf(req), amount = money(req.body.amount);
    if (amount <= 0) return fail(res, "Handover amount must be greater than zero", 400);
    const summary = await cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub });
    const available = money(Math.max(0, summary.cashInHand - summary.pendingTotal));
    if (amount > available) return fail(res, `Only ₹${available.toLocaleString("en-IN")} is available for a new handover/deposit request`, 409, { cashInHand: summary.cashInHand, pendingTotal: summary.pendingTotal, available });
    const recipientUserId = clean(req.body.recipientUserId);
    if (!objectIdText(recipientUserId)) return fail(res, "Select a valid V2 cashier / receiver", 400);
    const receiver = await User.findOne({ _id: recipientUserId, tenantKey: req.auth.tenantKey, status: "ACTIVE" }).select("name role").lean();
    if (!receiver) return fail(res, "Selected cashier / receiver is not active", 400);
    const recipientName = clean(receiver.name) || clean(req.body.recipientName) || "Receiver";
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    let movementNo = makeId("HND"); while (await SalespersonCashMovement.exists({ tenantKey: req.auth.tenantKey, financialYear, movementNo })) movementNo = makeId("HND");
    const movement = await SalespersonCashMovement.create({
      tenantKey: req.auth.tenantKey, financialYear, movementNo, salespersonId: req.auth.sub, salespersonNameSnapshot: req.auth.name || "",
      date: new Date(), dayKey: localDateKey(), type: "HANDOVER", direction: "OUT", amount,
      recipientUserId, recipientName, reference: clean(req.body.reference), remarks: clean(req.body.remarks),
      status: "PENDING", createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "",
    });
    return ok(res, movement, "Cash handover submitted for verification", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cash/bank-deposit", async (req, res) => {
  try {
    const financialYear = fyOf(req), amount = money(req.body.amount);
    if (amount <= 0) return fail(res, "Deposit amount must be greater than zero", 400);
    const summary = await cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub });
    const available = money(Math.max(0, summary.cashInHand - summary.pendingTotal));
    if (amount > available) return fail(res, `Only ₹${available.toLocaleString("en-IN")} is available for a new handover/deposit request`, 409, { cashInHand: summary.cashInHand, pendingTotal: summary.pendingTotal, available });
    const bank = await BankAccount.findOne({ tenantKey: req.auth.tenantKey, bankAccountId: clean(req.body.bankAccountId), status: "ACTIVE" }).lean();
    if (!bank) return fail(res, "Select a valid company bank account", 400);
    const reference = clean(req.body.reference);
    if (!reference) return fail(res, "Bank deposit reference / slip number is required", 400);
    const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    let movementNo = makeId("DEP"); while (await SalespersonCashMovement.exists({ tenantKey: req.auth.tenantKey, financialYear, movementNo })) movementNo = makeId("DEP");
    const movement = await SalespersonCashMovement.create({
      tenantKey: req.auth.tenantKey, financialYear, movementNo, salespersonId: req.auth.sub, salespersonNameSnapshot: req.auth.name || "",
      date: new Date(), dayKey: localDateKey(), type: "BANK_DEPOSIT", direction: "OUT", amount,
      bankAccountId: bank.bankAccountId, bankNameSnapshot: bank.bankName, reference, proofReference: clean(req.body.proofReference), remarks: clean(req.body.remarks),
      status: "PENDING", createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "",
    });
    return ok(res, movement, "Bank deposit submitted for verification", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/cash/movements/:id/cancel", async (req, res) => {
  try {
    const financialYear = fyOf(req); const { SalespersonCashMovement } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, type: { $in: ["HANDOVER", "BANK_DEPOSIT"] } });
    if (!movement) return fail(res, "Cash movement not found", 404);
    if (movement.status !== "PENDING") return fail(res, "Only pending handover/deposit requests can be cancelled", 409);
    movement.status = "CANCELLED"; movement.remarks = [movement.remarks, clean(req.body.remarks)].filter(Boolean).join(" | "); await movement.save();
    return ok(res, movement, "Request cancelled");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/cash/movements/:id/verify", async (req, res) => {
  try {
    const financialYear = fyOf(req); const { SalespersonCashMovement, LedgerEntry } = financialModels(req.auth.tenantKey, financialYear);
    const movement = await SalespersonCashMovement.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, type: { $in: ["HANDOVER", "BANK_DEPOSIT"] } });
    if (!movement) return fail(res, "Cash movement not found", 404);
    const receiverMatch = clean(movement.recipientUserId) && clean(movement.recipientUserId) === clean(req.auth.sub);
    if (!isAdminAuth(req.auth) && !receiverMatch) return fail(res, "Only the assigned receiver or an administrator can verify this movement", 403);
    if (movement.status !== "PENDING") return ok(res, movement, `Movement is already ${movement.status}`);
    const action = upper(req.body.action || "APPROVE");
    if (!['APPROVE','REJECT'].includes(action)) return fail(res, "Action must be APPROVE or REJECT", 400);
    if (action === "REJECT") {
      movement.status = "REJECTED"; movement.rejectionReason = clean(req.body.remarks || req.body.reason); movement.verifiedBy = req.auth.sub; movement.verifiedByNameSnapshot = req.auth.name || ""; movement.verifiedAt = new Date(); await movement.save();
      return ok(res, movement, "Cash movement rejected");
    }
    if (movement.type === "BANK_DEPOSIT") {
      const bank = await BankAccount.findOne({ tenantKey: req.auth.tenantKey, bankAccountId: movement.bankAccountId, status: "ACTIVE" }).lean();
      if (!bank) return fail(res, "The selected company bank account is no longer active", 409);
      const transactionId = `CASHDEP-${movement.movementNo}`;
      const exists = await LedgerEntry.exists({ tenantKey: req.auth.tenantKey, financialYear, transactionId, status: "POSTED" });
      if (!exists) await postBalancedEntries({
        tenantKey: req.auth.tenantKey, financialYear, transactionId, transactionType: "SALESPERSON_BANK_DEPOSIT", date: movement.date,
        narration: movement.remarks || `Cash deposited to ${bank.bankName}`,
        entries: [
          { accountCode: "SYS_BANK_ACCOUNT", ledgerId: bank.ledgerId || "", bankAccountId: bank.bankAccountId, debit: num(movement.amount) },
          { accountCode: "SYS_CASH", credit: num(movement.amount) },
        ],
      });
      movement.accountingTransactionId = transactionId;
    }
    movement.status = "APPROVED"; movement.verifiedBy = req.auth.sub; movement.verifiedByNameSnapshot = req.auth.name || ""; movement.verifiedAt = new Date(); await movement.save();
    return ok(res, movement, movement.type === "HANDOVER" ? "Cash handover verified" : "Bank deposit verified");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/day-closing/preview", async (req, res) => {
  try {
    const financialYear = fyOf(req), at = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(at.getTime())) return fail(res, "Invalid closing date", 400);
    const summary = await cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, at });
    return ok(res, { ...summary, expectedClosing: summary.cashInHand, date: localDateKey(at), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/cash/day-closing", async (req, res) => {
  try {
    const financialYear = fyOf(req), at = req.body.date ? new Date(req.body.date) : new Date();
    if (Number.isNaN(at.getTime())) return fail(res, "Invalid closing date", 400);
    const declaredClosing = money(req.body.declaredClosing);
    if (declaredClosing < 0) return fail(res, "Declared cash cannot be negative", 400);
    const summary = await cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, at });
    const expectedClosing = money(summary.cashInHand), variance = money(declaredClosing - expectedClosing);
    const varianceType = Math.abs(variance) <= 0.01 ? "NONE" : variance < 0 ? "SHORTAGE" : "EXCESS";
    if (varianceType !== "NONE" && !clean(req.body.remarks)) return fail(res, "A remark is required when declared cash differs from expected cash", 400);
    const { SalespersonDayClosing } = financialModels(req.auth.tenantKey, financialYear);
    const key = localDateKey(at);
    const existing = await SalespersonDayClosing.findOne({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, dayKey: key });
    if (existing && ["APPROVED", "REVIEW_REQUIRED"].includes(existing.status)) return fail(res, `Day closing for ${key} is already ${existing.status}`, 409);
    let closingNo = existing?.closingNo || makeId("CLOSE"); while (!existing && await SalespersonDayClosing.exists({ tenantKey: req.auth.tenantKey, financialYear, closingNo })) closingNo = makeId("CLOSE");
    const payload = {
      tenantKey: req.auth.tenantKey, financialYear, closingNo, salespersonId: req.auth.sub, salespersonNameSnapshot: req.auth.name || "",
      dayKey: key, closingDate: at,
      openingCash: summary.openingCash, cashCollected: summary.cashCollectedToday,
      approvedHandover: summary.handoverApprovedToday, approvedBankDeposit: summary.bankDepositApprovedToday,
      approvedAdjustmentsIn: money(summary.excessApprovedToday + summary.adjustmentsInToday),
      approvedAdjustmentsOut: money(summary.shortageApprovedToday + summary.adjustmentsOutToday),
      expectedClosing, declaredClosing, variance, varianceType, remarks: clean(req.body.remarks),
      status: varianceType === "NONE" ? "CLOSED" : "REVIEW_REQUIRED",
      createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "",
    };
    const closing = existing ? await SalespersonDayClosing.findByIdAndUpdate(existing._id, { $set: payload }, { new: true }) : await SalespersonDayClosing.create(payload);
    return ok(res, closing, varianceType === "NONE" ? "Day closed successfully" : `${varianceType} recorded and sent for review`, existing ? 200 : 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/cash/day-closings", async (req, res) => {
  try {
    const financialYear = fyOf(req), page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
    const { SalespersonDayClosing } = financialModels(req.auth.tenantKey, financialYear);
    const filter = { tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub };
    const [items, total] = await Promise.all([
      SalespersonDayClosing.find(filter).sort({ closingDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SalespersonDayClosing.countDocuments(filter),
    ]);
    return ok(res, { items, meta: pageMeta(page, limit, total), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/cash/day-closings/:id/review", async (req, res) => {
  try {
    if (!isAdminAuth(req.auth)) return fail(res, "Administrator approval is required", 403);
    const financialYear = fyOf(req); const { SalespersonDayClosing, SalespersonCashMovement, LedgerEntry } = financialModels(req.auth.tenantKey, financialYear);
    const closing = await SalespersonDayClosing.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!closing) return fail(res, "Day closing not found", 404);
    if (closing.status !== "REVIEW_REQUIRED") return ok(res, closing, `Day closing is already ${closing.status}`);
    const action = upper(req.body.action || "APPROVE");
    if (!['APPROVE','REJECT'].includes(action)) return fail(res, "Action must be APPROVE or REJECT", 400);
    if (action === "REJECT") {
      closing.status = "REJECTED"; closing.reviewRemark = clean(req.body.remarks); closing.reviewedBy = req.auth.sub; closing.reviewedByNameSnapshot = req.auth.name || ""; closing.reviewedAt = new Date(); await closing.save();
      return ok(res, closing, "Day closing rejected for correction");
    }
    const variance = num(closing.variance);
    if (Math.abs(variance) > 0.01 && !closing.varianceMovementId) {
      const isExcess = variance > 0, amount = money(Math.abs(variance));
      let movementNo = makeId(isExcess ? "EXC" : "SHT"); while (await SalespersonCashMovement.exists({ tenantKey: req.auth.tenantKey, financialYear, movementNo })) movementNo = makeId(isExcess ? "EXC" : "SHT");
      const transactionId = `CASHVAR-${closing.closingNo}`;
      const exists = await LedgerEntry.exists({ tenantKey: req.auth.tenantKey, financialYear, transactionId, status: "POSTED" });
      if (!exists) await postBalancedEntries({
        tenantKey: req.auth.tenantKey, financialYear, transactionId, transactionType: isExcess ? "CASH_EXCESS" : "CASH_SHORTAGE", date: closing.closingDate,
        narration: closing.reviewRemark || closing.remarks || `${closing.varianceType} at day closing`,
        entries: isExcess
          ? [{ accountCode: "SYS_CASH", debit: amount }, { accountCode: "SYS_INDIRECT_INCOME", credit: amount }]
          : [{ accountCode: "SYS_INDIRECT_EXPENSE", debit: amount }, { accountCode: "SYS_CASH", credit: amount }],
      });
      const movement = await SalespersonCashMovement.create({
        tenantKey: req.auth.tenantKey, financialYear, movementNo, salespersonId: closing.salespersonId, salespersonNameSnapshot: closing.salespersonNameSnapshot,
        date: closing.closingDate, dayKey: closing.dayKey, type: isExcess ? "EXCESS" : "SHORTAGE", direction: isExcess ? "IN" : "OUT", amount,
        sourceDayClosingId: String(closing._id), remarks: closing.remarks, status: "APPROVED",
        verifiedBy: req.auth.sub, verifiedByNameSnapshot: req.auth.name || "", verifiedAt: new Date(), accountingTransactionId: transactionId,
        createdBy: closing.createdBy, createdByNameSnapshot: closing.createdByNameSnapshot,
      });
      closing.varianceMovementId = String(movement._id);
    }
    closing.status = "APPROVED"; closing.reviewRemark = clean(req.body.remarks); closing.reviewedBy = req.auth.sub; closing.reviewedByNameSnapshot = req.auth.name || ""; closing.reviewedAt = new Date(); await closing.save();
    return ok(res, closing, "Day closing variance approved and adjusted");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});


// ---------------- V2 FIELD ROUTE / VISIT SYSTEM ----------------
const routePriorityWeight = (priority = "") => ({ CRITICAL: 70, HIGH: 45, MEDIUM: 24, NORMAL: 8 }[upper(priority)] || 8);
const routeActionServiceMinutes = (action = "") => ({ COLLECT: 16, ORDER: 22, CUSTOMER: 18, LEAD: 15 }[upper(action)] || 18);
const routeRoadMeters = (a, b) => {
  const direct = haversine({ latitude: a?.lat ?? a?.latitude, longitude: a?.lng ?? a?.longitude }, { latitude: b?.lat ?? b?.latitude, longitude: b?.lng ?? b?.longitude });
  return Number.isFinite(direct) ? Math.round(direct * 1.22) : 0;
};
const routeTravelMinutes = (meters) => Math.max(1, Math.round((Math.max(0, num(meters)) / 1000) / 24 * 60));

function orderRouteCandidates(items = [], startLocation, maxStops = 12) {
  const remaining = [...items].filter((x) => validCoord(x.latitude, x.longitude));
  const ordered = [];
  let cursor = { lat: Number(startLocation?.lat ?? startLocation?.latitude), lng: Number(startLocation?.lng ?? startLocation?.longitude) };
  while (remaining.length && ordered.length < Math.max(1, Math.min(30, Number(maxStops || 12)))) {
    let bestIndex = 0, bestUtility = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const row = remaining[i];
      const distanceMeters = routeRoadMeters(cursor, { lat: row.latitude, lng: row.longitude });
      const distancePenalty = Math.min(85, distanceMeters / 700);
      const valueBoost = Math.min(35, num(row.amount) / 4000);
      const utility = num(row.score) + routePriorityWeight(row.priority) + valueBoost - distancePenalty;
      if (utility > bestUtility) { bestUtility = utility; bestIndex = i; }
    }
    const row = remaining.splice(bestIndex, 1)[0];
    const legMeters = routeRoadMeters(cursor, { lat: row.latitude, lng: row.longitude });
    ordered.push({ ...row, legMeters, travelMinutes: routeTravelMinutes(legMeters) });
    cursor = { lat: row.latitude, lng: row.longitude };
  }
  return ordered;
}

function buildRouteStops(items = [], startLocation, startAt = new Date()) {
  let eta = new Date(startAt);
  return items.map((row, index) => {
    eta = new Date(eta.getTime() + num(row.travelMinutes) * 60000);
    const stop = {
      stopId: makeId("STOP"), sequence: index + 1, customerGlobalId: row.customerGlobalId,
      customerNameSnapshot: row.customerName, mobileSnapshot: row.mobile, addressSnapshot: row.address,
      citySnapshot: row.city, pincodeSnapshot: row.pincode, location: { lat: row.latitude, lng: row.longitude },
      priority: row.priority, score: num(row.score), opportunityType: row.opportunityType, recommendedAction: row.recommendedAction,
      reason: row.reason, opportunityAmount: money(row.amount), collectionAmount: upper(row.recommendedAction) === "COLLECT" ? money(row.amount) : 0,
      status: "PENDING", estimatedDistanceFromPreviousMeters: num(row.legMeters), estimatedTravelMinutes: num(row.travelMinutes), estimatedArrivalAt: new Date(eta),
    };
    eta = new Date(eta.getTime() + routeActionServiceMinutes(row.recommendedAction) * 60000);
    return stop;
  });
}

function recomputeRoutePlan(plan) {
  const stops = Array.isArray(plan.stops) ? plan.stops : [];
  plan.completedStops = stops.filter((x) => x.status === "COMPLETED").length;
  plan.skippedStops = stops.filter((x) => x.status === "SKIPPED").length;
  plan.estimatedDistanceMeters = money(stops.reduce((s, x) => s + num(x.estimatedDistanceFromPreviousMeters), 0));
  plan.estimatedTravelMinutes = Math.round(stops.reduce((s, x) => s + num(x.estimatedTravelMinutes), 0));
  plan.estimatedWorkMinutes = Math.round(stops.reduce((s, x) => s + num(x.estimatedTravelMinutes) + routeActionServiceMinutes(x.recommendedAction), 0));
  plan.totalOpportunityAmount = money(stops.reduce((s, x) => s + num(x.opportunityAmount), 0));
  plan.totalCollectionAmount = money(stops.reduce((s, x) => s + num(x.collectionAmount), 0));
  const terminal = stops.length > 0 && stops.every((x) => ["COMPLETED", "SKIPPED"].includes(x.status));
  if (terminal && plan.status !== "CANCELLED") { plan.status = "COMPLETED"; plan.completedAt = plan.completedAt || new Date(); }
  return plan;
}

async function completeRouteStopFromVisit({ tenantKey, salespersonId, customerGlobalId, visit, distanceMeters = null }) {
  const dateKey = localDateKey(visit?.startedAt || new Date());
  const plan = await SalesRoutePlan.findOne({ tenantKey, salespersonId: String(salespersonId), dateKey, status: { $in: ["READY", "IN_PROGRESS"] }, "stops.customerGlobalId": customerGlobalId }).sort({ updatedAt: -1 });
  if (!plan) return null;
  const stop = (plan.stops || []).find((x) => x.customerGlobalId === customerGlobalId && !["COMPLETED", "SKIPPED"].includes(x.status));
  if (!stop) return plan;
  stop.status = "COMPLETED"; stop.completedAt = visit?.endedAt || new Date(); stop.arrivedAt = stop.arrivedAt || visit?.startedAt || new Date(); stop.outcome = clean(visit?.outcome) || "VISIT_COMPLETED"; stop.visitId = String(visit?._id || visit?.visitId || "");
  if (Number.isFinite(Number(distanceMeters))) stop.actualDistanceOnArrivalMeters = money(distanceMeters);
  if (plan.status === "READY") { plan.status = "IN_PROGRESS"; plan.startedAt = plan.startedAt || visit?.startedAt || new Date(); }
  recomputeRoutePlan(plan); plan.updatedBy = salespersonId; await plan.save(); return plan;
}

async function routePlanAccessFilter(req, salespersonId = "") {
  const scope = await visibility(req); const requested = clean(salespersonId);
  if (!requested) return { salespersonId: req.auth.sub, scope };
  if (requested === String(req.auth.sub)) return { salespersonId: requested, scope };
  if (scope.unrestricted || (scope.userIds || []).map(String).includes(requested)) return { salespersonId: requested, scope };
  const err = new Error("Salesperson is outside your assigned sales hierarchy"); err.statusCode = 403; throw err;
}

router.get("/field/customers", async (req, res) => {
  try {
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    const rows = await CustomerLink.find(filter)
      .select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses location salespersonId")
      .lean();
    const items = rows.map((c) => {
      const geo = customerCoordinates(c); if (!geo) return null;
      const address = billingAddress(c);
      return {
        _id: c.globalCustomerId, id: c.globalCustomerId, globalCustomerId: c.globalCustomerId,
        CompanyName: customerName(c), name: customerName(c), mobile: customerMobile(c),
        CompanyAddress: address.address || "", address: address.address || "", City: address.city || "", State: address.state || "", Pincode: address.pincode || "",
        city: address.city || "", state: address.state || "", pincode: address.pincode || "",
        latitude: geo.latitude, longitude: geo.longitude, accuracy: geo.accuracy,
        geotagging: `${geo.latitude},${geo.longitude}`,
      };
    }).filter(Boolean);
    return ok(res, { items, total: items.length });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/visits", async (req, res) => {
  try {
    const page=Math.max(1,Number(req.query.page||1)), limit=Math.min(200,Math.max(10,Number(req.query.limit||100)));
    const filter={tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,status:{$ne:"CANCELLED"}};
    if(clean(req.query.customerGlobalId)) filter.customerGlobalId=clean(req.query.customerGlobalId);
    if(clean(req.query.from)){const d=new Date(req.query.from);if(!Number.isNaN(d.getTime()))filter.startedAt={$gte:startOfDay(d)};}
    if(clean(req.query.to)){const d=new Date(req.query.to);if(!Number.isNaN(d.getTime()))filter.startedAt={...(filter.startedAt||{}),$lt:endOfDay(d)};}
    const [items,total]=await Promise.all([CustomerVisit.find(filter).sort({startedAt:-1}).skip((page-1)*limit).limit(limit).lean(),CustomerVisit.countDocuments(filter)]);
    return ok(res,{items,meta:pageMeta(page,limit,total)});
  } catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/customers/:globalId/visits", async (req, res) => {
  try {
    const customer=await requireVisibleCustomer(req,req.params.globalId), geo=customerCoordinates(customer);
    if(!geo)return fail(res,"Customer has no saved geolocation",400);
    const lat=Number(req.body.latitude??req.body.lat), lng=Number(req.body.longitude??req.body.lng), accuracy=num(req.body.accuracy??req.body.gpsAccuracy);
    if(!validCoord(lat,lng))return fail(res,"Valid current GPS location is required",400);
    if(accuracy>30)return fail(res,`GPS accuracy is too low (${Math.round(accuracy)} m). Move to an open area and try again.`,400);
    const distance=haversine({latitude:lat,longitude:lng},geo);
    if(!Number.isFinite(distance)||distance>10)return fail(res,`Visit can only be created within 10 m of the customer. Current distance is about ${Math.round(distance)} m.`,400,{distanceMeters:distance});
    const clientMutationId=clean(req.body.clientMutationId);
    if(clientMutationId){const existing=await CustomerVisit.findOne({tenantKey:req.auth.tenantKey,clientMutationId}).lean();if(existing)return ok(res,{visit:existing,deduplicated:true},"Visit already synced");}
    let visitId=makeId("VIS");while(await CustomerVisit.exists({visitId}))visitId=makeId("VIS");
    const now=new Date();
    const visit=await CustomerVisit.create({tenantKey:req.auth.tenantKey,visitId,clientMutationId:clientMutationId||undefined,financialYear:fyOf(req),customerGlobalId:customer.globalCustomerId,customerNameSnapshot:customerName(customer),salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",tripId:clean(req.body.tripId),visitType:"MANUAL",status:"COMPLETED",startedAt:now,endedAt:now,durationSeconds:0,outcome:clean(req.body.outcome),note:clean(req.body.note),nextFollowUpAt:req.body.nextFollowUpAt?new Date(req.body.nextFollowUpAt):null,startLocation:{latitude:lat,longitude:lng,accuracy},endLocation:{latitude:lat,longitude:lng,accuracy},customerLocation:{latitude:geo.latitude,longitude:geo.longitude},minDistanceMeters:money(distance),gpsVerified:true,autoDetected:false,createdBy:req.auth.sub});
    const routePlan=await completeRouteStopFromVisit({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,customerGlobalId:customer.globalCustomerId,visit,distanceMeters:distance});
    return ok(res,{visit,distanceMeters:money(distance),routePlan:routePlan?{_id:routePlan._id,status:routePlan.status,completedStops:routePlan.completedStops,skippedStops:routePlan.skippedStops}:null},"Visit created",201);
  } catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/visits/auto-detect", async (req, res) => {
  try {
    const customer=await requireVisibleCustomer(req,req.body.customerGlobalId), geo=customerCoordinates(customer); if(!geo)return fail(res,"Customer has no saved geolocation",400);
    const enteredAt=new Date(req.body.enteredAt), leftAt=new Date(req.body.leftAt||new Date()); if(Number.isNaN(enteredAt.getTime())||Number.isNaN(leftAt.getTime()))return fail(res,"Valid enter/leave time is required",400);
    const durationSeconds=Math.max(0,Math.round((leftAt-enteredAt)/1000)), minDistance=num(req.body.minDistanceMeters);
    if(durationSeconds<90)return fail(res,"Automatic visit requires at least 90 seconds near the customer",400);
    if(minDistance>20)return fail(res,"Automatic visit was not close enough to the customer",400);
    const clientMutationId=clean(req.body.clientMutationId);
    if(clientMutationId){const synced=await CustomerVisit.findOne({tenantKey:req.auth.tenantKey,clientMutationId}).lean();if(synced)return ok(res,{visit:synced,deduplicated:true},"Visit already synced");}
    const recent=await CustomerVisit.findOne({tenantKey:req.auth.tenantKey,customerGlobalId:customer.globalCustomerId,salespersonId:req.auth.sub,startedAt:{$gte:new Date(Date.now()-30*60*1000)},status:{$ne:"CANCELLED"}}).lean();
    if(recent)return ok(res,{visit:recent,deduplicated:true},"Visit already recorded");
    let visitId=makeId("AVIS");while(await CustomerVisit.exists({visitId}))visitId=makeId("AVIS");
    const start=routePoint(req.body.startLocation||{}), end=routePoint(req.body.endLocation||{});
    const visit=await CustomerVisit.create({tenantKey:req.auth.tenantKey,visitId,clientMutationId:clientMutationId||undefined,financialYear:fyOf(req),customerGlobalId:customer.globalCustomerId,customerNameSnapshot:customerName(customer),salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",tripId:clean(req.body.tripId),visitType:"AUTO_DETECTED",status:"COMPLETED",startedAt:enteredAt,endedAt:leftAt,durationSeconds,outcome:"AUTO_DETECTED_VISIT",note:clean(req.body.note)||"Automatically detected from verified proximity and dwell time",startLocation:start?{latitude:start.lat,longitude:start.lng,accuracy:start.accuracy}:undefined,endLocation:end?{latitude:end.lat,longitude:end.lng,accuracy:end.accuracy}:undefined,customerLocation:{latitude:geo.latitude,longitude:geo.longitude},minDistanceMeters:money(minDistance),gpsVerified:true,autoDetected:true,createdBy:req.auth.sub});
    const routePlan=await completeRouteStopFromVisit({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,customerGlobalId:customer.globalCustomerId,visit,distanceMeters:minDistance});
    return ok(res,{visit,deduplicated:false,routePlan:routePlan?{_id:routePlan._id,status:routePlan.status,completedStops:routePlan.completedStops,skippedStops:routePlan.skippedStops}:null},"Automatic visit recorded",201);
  } catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/route/trips", async (req,res)=>{
  try{const limit=Math.min(200,Math.max(10,Number(req.query.limit||100)));const items=await SalespersonTrip.find({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}).sort({startedAt:-1}).limit(limit).lean();return ok(res,{trips:items});}catch(error){return fail(res,error.message,500);}
});
router.get("/route/trips/:id", async (req,res)=>{
  try{const trip=await SalespersonTrip.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}).lean();if(!trip)return fail(res,"Trip not found",404);return ok(res,{trip});}catch(error){return fail(res,error.message,500);}
});
router.post("/route/trips/start", async (req,res)=>{
  try{
    const dateKey=clean(req.body.dateKey)||localDateKey();
    const plan=await SalesRoutePlan.findOne({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,dateKey,status:{$in:["READY","IN_PROGRESS"]}}).sort({updatedAt:-1});
    const active=await SalespersonTrip.findOne({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,status:"active"}).sort({startedAt:-1});
    if(active){if(plan&&!active.routePlanId){active.routePlanId=String(plan._id);await active.save();plan.tripId=String(active._id);plan.status="IN_PROGRESS";plan.startedAt=plan.startedAt||active.startedAt||new Date();await plan.save();}return ok(res,{trip:active,routePlan:plan||null},"Active trip resumed");}
    const point=routePoint(req.body.startLocation||{});if(!point)return fail(res,"Valid start location is required",400);let tripId=makeId("TRIP");while(await SalespersonTrip.exists({tripId}))tripId=makeId("TRIP");
    const trip=await SalespersonTrip.create({tenantKey:req.auth.tenantKey,tripId,salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",dateKey,status:"active",startedAt:new Date(),startLocation:point,routePoints:[point],pointCount:1,distanceMeters:0,routePlanId:plan?String(plan._id):"",createdBy:req.auth.sub});
    if(plan){plan.tripId=String(trip._id);plan.status="IN_PROGRESS";plan.startedAt=plan.startedAt||trip.startedAt;plan.currentLocation=point;plan.updatedBy=req.auth.sub;await plan.save();}
    return ok(res,{trip,routePlan:plan||null},"Trip started",201);
  }catch(error){return fail(res,error.message,500);}
});
router.post("/route/trips/:id/points", async (req,res)=>{
  try{
    const trip=await SalespersonTrip.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,status:"active"});if(!trip)return fail(res,"Active trip not found",404);
    const incoming=(Array.isArray(req.body.points)?req.body.points:[]).map(routePoint).filter(Boolean);const known=new Set((trip.routePoints||[]).map((p)=>clean(p.ts)));for(const p of incoming)if(!known.has(clean(p.ts))){trip.routePoints.push(p);known.add(clean(p.ts));}
    if(trip.routePoints.length>5000)trip.routePoints=trip.routePoints.slice(-5000);if(Array.isArray(req.body.pauseEvents))trip.pauseEvents=[...(trip.pauseEvents||[]),...req.body.pauseEvents.slice(-100)].slice(-300);
    trip.pointCount=trip.routePoints.length;trip.distanceMeters=money(polylineDistance(trip.routePoints));trip.durationSeconds=Math.max(0,Math.round((Date.now()-new Date(trip.startedAt).getTime())/1000));trip.updatedBy=req.auth.sub;await trip.save();
    if(trip.routePlanId){const last=trip.routePoints?.[trip.routePoints.length-1];await SalesRoutePlan.updateOne({_id:trip.routePlanId,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub},{$set:{currentLocation:last||undefined,lastGpsAt:new Date(),actualDistanceMeters:trip.distanceMeters,actualDurationSeconds:trip.durationSeconds,updatedBy:req.auth.sub}});}
    return ok(res,{trip:{_id:trip._id,tripId:trip.tripId,status:trip.status,pointCount:trip.pointCount,distanceMeters:trip.distanceMeters,durationSeconds:trip.durationSeconds,routePlanId:trip.routePlanId||""}});
  }catch(error){return fail(res,error.message,500);}
});
router.patch("/route/trips/:id/stop", async (req,res)=>{
  try{const trip=await SalespersonTrip.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub});if(!trip)return fail(res,"Trip not found",404);if(trip.status!=="active")return ok(res,{trip},"Trip already stopped");const p=routePoint(req.body.endLocation||{});trip.status="completed";trip.endedAt=req.body.endedAt?new Date(req.body.endedAt):new Date();trip.endLocation=p||trip.routePoints?.[trip.routePoints.length-1];trip.distanceMeters=money(polylineDistance(trip.routePoints||[]));trip.pointCount=(trip.routePoints||[]).length;trip.durationSeconds=Math.max(0,Math.round((trip.endedAt-new Date(trip.startedAt))/1000));trip.stoppedReason=clean(req.body.reason)||"manual";trip.updatedBy=req.auth.sub;await trip.save();if(trip.routePlanId){await SalesRoutePlan.updateOne({_id:trip.routePlanId,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub},{$set:{currentLocation:trip.endLocation||undefined,lastGpsAt:new Date(),actualDistanceMeters:trip.distanceMeters,actualDurationSeconds:trip.durationSeconds,updatedBy:req.auth.sub}});}return ok(res,{trip},"Trip stopped");}catch(error){return fail(res,error.message,500);}
});

async function priorityRouteItems({req,financialYear,latitude,longitude,radiusMeters=50000,limit=30}){
  const {filter}=await visibleCustomerFilter(req,{status:"ACTIVE"});
  const customers=await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses location creditDays creditLimit accountingProfile salespersonId").lean();
  const located=customers.map((c)=>({customer:c,geo:customerCoordinates(c)})).filter((x)=>x.geo).map((x)=>({...x,distanceMeters:haversine({latitude,longitude},x.geo)})).filter((x)=>Number.isFinite(x.distanceMeters)&&x.distanceMeters<=radiusMeters);
  if(!located.length)return [];
  const subset=located.map((x)=>x.customer), priority=await collectionPriorityItems({tenantKey:req.auth.tenantKey,financialYear,customers:subset});
  const opportunity=await opportunityItemsForUser({req,financialYear,limit:200,customers:subset,priority});
  const oppMap=new Map();for(const o of opportunity){if(!o.customerGlobalId)continue;const curr=oppMap.get(o.customerGlobalId);if(!curr||num(o.score)>num(curr.score))oppMap.set(o.customerGlobalId,o);}
  const prMap=new Map(priority.map((x)=>[x.customer.id,x]));
  const rows=located.map(({customer:c,geo,distanceMeters})=>{const o=oppMap.get(c.globalCustomerId),pr=prMap.get(c.globalCustomerId);const distanceKm=distanceMeters/1000;const businessScore=num(o?.score)||(pr?70+num(pr.priorityScore):25);const routeScore=Math.round((businessScore-Math.min(55,distanceKm*2))*10)/10;return {customerGlobalId:c.globalCustomerId,customerName:customerName(c),mobile:customerMobile(c),address:billingAddress(c).address||"",city:billingAddress(c).city||"",pincode:billingAddress(c).pincode||"",latitude:geo.latitude,longitude:geo.longitude,distanceMeters:Math.round(distanceMeters),distanceKm:Math.round(distanceKm*10)/10,score:routeScore,priority:o?.priority||pr?.priority||"NORMAL",opportunityType:o?.type||"VISIT",reason:o?.subtitle||"Customer relationship visit",amount:num(o?.amount),recommendedAction:o?.action||"CUSTOMER"};}).sort((a,b)=>b.score-a.score||a.distanceMeters-b.distanceMeters).slice(0,Math.max(1,Math.min(100,limit)));
  return rows.map((x,i)=>({...x,rank:i+1}));
}


router.get("/route/plans/today", async(req,res)=>{
  try{
    const dateKey=clean(req.query.dateKey)||localDateKey(), access=await routePlanAccessFilter(req,req.query.salespersonId);
    const plan=await SalesRoutePlan.findOne({tenantKey:req.auth.tenantKey,salespersonId:access.salespersonId,dateKey}).lean();
    return ok(res,{plan:plan||null,dateKey});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/route/plans/history", async(req,res)=>{
  try{
    const access=await routePlanAccessFilter(req,req.query.salespersonId), page=Math.max(1,Number(req.query.page||1)),limit=Math.min(60,Math.max(10,Number(req.query.limit||20)));
    const filter={tenantKey:req.auth.tenantKey,salespersonId:access.salespersonId}; if(clean(req.query.status))filter.status=upper(req.query.status);
    const [items,total]=await Promise.all([SalesRoutePlan.find(filter).sort({dateKey:-1,createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),SalesRoutePlan.countDocuments(filter)]);
    return ok(res,{items,meta:pageMeta(page,limit,total)});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/route/plans/generate", async(req,res)=>{
  try{
    const point=routePoint(req.body.currentLocation||req.body.startLocation||{}); if(!point)return fail(res,"Valid current location is required to generate a route",400);
    const dateKey=clean(req.body.dateKey)||localDateKey(), maxStops=Math.min(25,Math.max(3,Number(req.body.maxStops||12))),radiusKm=Math.min(100,Math.max(1,Number(req.body.radiusKm||40)));
    let existing=await SalesRoutePlan.findOne({tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub,dateKey});
    if(existing?.status==="IN_PROGRESS")return fail(res,"Today's route is already in progress. Use Re-plan Remaining instead.",409,{plan:existing});
    if(existing?.status==="COMPLETED")return fail(res,"Today's route is already completed and is locked in route history.",409,{plan:existing});
    const candidates=await priorityRouteItems({req,financialYear:fyOf(req),latitude:point.lat,longitude:point.lng,radiusMeters:radiusKm*1000,limit:Math.max(maxStops*4,40)});
    if(!candidates.length)return fail(res,"No geotagged customers/opportunities are available for today's route",404);
    const ordered=orderRouteCandidates(candidates,point,maxStops),stops=buildRouteStops(ordered,point,new Date());
    let planNo=existing?.planNo||makeId("ROUTE"); while(!existing&&await SalesRoutePlan.exists({planNo}))planNo=makeId("ROUTE");
    const payload={tenantKey:req.auth.tenantKey,planNo,financialYear:fyOf(req),dateKey,salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",status:"READY",generatedBy:existing?"REPLAN":"AUTO",routeVersion:num(existing?.routeVersion)+1||1,startLocation:point,currentLocation:point,maxStops,radiusMeters:radiusKm*1000,stops,createdBy:existing?.createdBy||req.auth.sub,updatedBy:req.auth.sub,startedAt:null,completedAt:null,tripId:""};
    if(existing){existing.set(payload);recomputeRoutePlan(existing);await existing.save();}
    else{existing=new SalesRoutePlan(payload);recomputeRoutePlan(existing);await existing.save();}
    return ok(res,{plan:existing,candidateCount:candidates.length},"Daily sales route generated",201);
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.patch("/route/plans/:id/start", async(req,res)=>{
  try{
    const plan=await SalesRoutePlan.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}); if(!plan)return fail(res,"Route plan not found",404);
    if(["COMPLETED","CANCELLED"].includes(plan.status))return fail(res,`Cannot start a ${plan.status.toLowerCase()} route`,400);
    const point=routePoint(req.body.currentLocation||{}); if(point)plan.currentLocation=point; plan.startLocation=plan.startLocation||point; plan.status="IN_PROGRESS"; plan.startedAt=plan.startedAt||new Date(); plan.updatedBy=req.auth.sub; await plan.save();
    return ok(res,{plan},"Daily route started");
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.patch("/route/plans/:id/stops/:stopId", async(req,res)=>{
  try{
    const plan=await SalesRoutePlan.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}); if(!plan)return fail(res,"Route plan not found",404);
    const stop=(plan.stops||[]).find(x=>x.stopId===req.params.stopId); if(!stop)return fail(res,"Route stop not found",404);
    const action=upper(req.body.action); if(["COMPLETED","SKIPPED"].includes(stop.status)&&action!=="RESTORE")return ok(res,{plan,stop},"Route stop is already closed");
    const now=new Date(),point=routePoint(req.body.currentLocation||{});
    if(point)plan.currentLocation=point;
    if(action==="START") { stop.status="STARTED"; stop.startedAt=stop.startedAt||now; if(plan.status==="READY"){plan.status="IN_PROGRESS";plan.startedAt=plan.startedAt||now;} }
    else if(action==="ARRIVE") {
      if(!point)return fail(res,"Current location is required to mark arrival",400);
      const d=haversine({latitude:point.lat,longitude:point.lng},{latitude:stop.location?.lat,longitude:stop.location?.lng}); if(!Number.isFinite(d)||d>250)return fail(res,`You are about ${Math.round(d)} m from this stop. Arrival can be marked within 250 m.`,400,{distanceMeters:d});
      stop.status="ARRIVED"; stop.arrivedAt=now; stop.actualDistanceOnArrivalMeters=money(d); stop.startedAt=stop.startedAt||now; if(plan.status==="READY"){plan.status="IN_PROGRESS";plan.startedAt=plan.startedAt||now;}
    }
    else if(action==="SKIP") { const reason=clean(req.body.reason); if(!reason)return fail(res,"Skip reason is required",400); stop.status="SKIPPED"; stop.skippedAt=now; stop.skipReason=reason; }
    else if(action==="RESTORE") { stop.status="PENDING"; stop.skippedAt=null; stop.skipReason=""; stop.completedAt=null; stop.visitId=""; plan.completedAt=null; if(plan.status==="COMPLETED")plan.status="IN_PROGRESS"; }
    else return fail(res,"Action must be START, ARRIVE, SKIP or RESTORE",400);
    recomputeRoutePlan(plan); plan.updatedBy=req.auth.sub; await plan.save(); return ok(res,{plan,stop},"Route stop updated");
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.post("/route/plans/:id/replan", async(req,res)=>{
  try{
    const plan=await SalesRoutePlan.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}); if(!plan)return fail(res,"Route plan not found",404);
    if(["COMPLETED","CANCELLED"].includes(plan.status))return fail(res,"Closed route cannot be re-planned",400);
    const point=routePoint(req.body.currentLocation||{}); if(!point)return fail(res,"Current location is required to re-plan",400);
    const fixed=(plan.stops||[]).filter(x=>["COMPLETED","SKIPPED"].includes(x.status)).sort((a,b)=>a.sequence-b.sequence), open=(plan.stops||[]).filter(x=>!["COMPLETED","SKIPPED"].includes(x.status));
    const asItems=open.map(x=>({customerGlobalId:x.customerGlobalId,customerName:x.customerNameSnapshot,mobile:x.mobileSnapshot,address:x.addressSnapshot,city:x.citySnapshot,pincode:x.pincodeSnapshot,latitude:x.location?.lat,longitude:x.location?.lng,score:x.score,priority:x.priority,opportunityType:x.opportunityType,reason:x.reason,amount:x.opportunityAmount,recommendedAction:x.recommendedAction}));
    const ordered=orderRouteCandidates(asItems,point,open.length), rebuilt=buildRouteStops(ordered,point,new Date());
    const preservedByCustomer=new Map(open.map(x=>[x.customerGlobalId,x]));
    rebuilt.forEach((x,i)=>{const prev=preservedByCustomer.get(x.customerGlobalId);x.stopId=prev?.stopId||x.stopId;x.status=prev?.status==="ARRIVED"?"ARRIVED":prev?.status==="STARTED"?"STARTED":"PENDING";x.startedAt=prev?.startedAt;x.arrivedAt=prev?.arrivedAt;x.actualDistanceOnArrivalMeters=prev?.actualDistanceOnArrivalMeters;x.sequence=fixed.length+i+1;});
    fixed.forEach((x,i)=>{x.sequence=i+1;}); plan.stops=[...fixed,...rebuilt]; plan.currentLocation=point; plan.generatedBy="REPLAN"; plan.routeVersion=num(plan.routeVersion)+1; recomputeRoutePlan(plan); plan.updatedBy=req.auth.sub; await plan.save();
    return ok(res,{plan},"Remaining route re-planned from current location");
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});


router.post("/route/plans/:id/stops", async(req,res)=>{
  try{
    const plan=await SalesRoutePlan.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,salespersonId:req.auth.sub}); if(!plan)return fail(res,"Route plan not found",404);
    if(["COMPLETED","CANCELLED"].includes(plan.status))return fail(res,"Closed route cannot accept new stops",400);
    const customer=await requireVisibleCustomer(req,req.body.customerGlobalId), geo=customerCoordinates(customer); if(!geo)return fail(res,"Customer has no saved geolocation",400);
    if((plan.stops||[]).some(x=>x.customerGlobalId===customer.globalCustomerId&&x.status!=="SKIPPED"))return fail(res,"Customer is already on today's route",409);
    const priority=await collectionPriorityItems({tenantKey:req.auth.tenantKey,financialYear:plan.financialYear||fyOf(req),customers:[customer]});
    const opportunities=await opportunityItemsForUser({req,financialYear:plan.financialYear||fyOf(req),limit:20,customers:[customer],priority});
    const best=opportunities.find(x=>x.customerGlobalId===customer.globalCustomerId), cursor=routePoint(req.body.currentLocation||{})||plan.currentLocation||plan.startLocation||{lat:geo.latitude,lng:geo.longitude};
    const item={customerGlobalId:customer.globalCustomerId,customerName:customerName(customer),mobile:customerMobile(customer),address:billingAddress(customer).address||"",city:billingAddress(customer).city||"",pincode:billingAddress(customer).pincode||"",latitude:geo.latitude,longitude:geo.longitude,score:num(best?.score)||40,priority:best?.priority||"NORMAL",opportunityType:best?.type||"AD_HOC_VISIT",reason:best?.subtitle||"Added during field route",amount:num(best?.amount),recommendedAction:best?.action||"CUSTOMER"};
    const leg=routeRoadMeters(cursor,{lat:geo.latitude,lng:geo.longitude}), built=buildRouteStops([{...item,legMeters:leg,travelMinutes:routeTravelMinutes(leg)}],cursor,new Date())[0]; built.sequence=Math.max(0,...(plan.stops||[]).map(x=>num(x.sequence)))+1;
    plan.stops.push(built); plan.maxStops=Math.max(num(plan.maxStops),plan.stops.length); recomputeRoutePlan(plan); plan.updatedBy=req.auth.sub; await plan.save(); return ok(res,{plan,stop:built},"Customer added to today's route",201);
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/route/team/today", async(req,res)=>{
  try{
    const {scope}=await roleScope(req); if(scope.isLeaf)return fail(res,"Team route monitoring is available to Sales Head / Sales Manager roles",403);
    const dateKey=clean(req.query.dateKey)||localDateKey(); const ids=scope.unrestricted?null:(scope.userIds||[]).map(String); const userFilter={tenantKey:req.auth.tenantKey,status:"ACTIVE"}; if(ids)userFilter._id={$in:ids};
    const members=await User.find(userFilter).select("_id name role mobile").sort({name:1}).lean(), memberIds=members.map(x=>String(x._id));
    const plans=memberIds.length?await SalesRoutePlan.find({tenantKey:req.auth.tenantKey,dateKey,salespersonId:{$in:memberIds}}).lean():[]; const pm=new Map(plans.map(x=>[String(x.salespersonId),x]));
    const items=members.map(m=>{const p=pm.get(String(m._id));const stops=p?.stops||[];const next=stops.find(x=>!["COMPLETED","SKIPPED"].includes(x.status));return {salespersonId:String(m._id),name:m.name,role:m.role,mobile:m.mobile||"",planId:p?String(p._id):"",status:p?.status||"NOT_PLANNED",totalStops:stops.length,completedStops:p?.completedStops||0,skippedStops:p?.skippedStops||0,progressPct:stops.length?Math.round((num(p?.completedStops)+num(p?.skippedStops))/stops.length*100):0,opportunityAmount:money(p?.totalOpportunityAmount),collectionAmount:money(p?.totalCollectionAmount),estimatedDistanceMeters:num(p?.estimatedDistanceMeters),actualDistanceMeters:num(p?.actualDistanceMeters),actualDurationSeconds:num(p?.actualDurationSeconds),currentLocation:p?.currentLocation||null,lastGpsAt:p?.lastGpsAt||null,startedAt:p?.startedAt||null,nextStop:next?{customerName:next.customerNameSnapshot,reason:next.reason,status:next.status}:null};});
    const totals=items.reduce((a,x)=>({people:a.people+1,planned:a.planned+(x.planId?1:0),inProgress:a.inProgress+(x.status==="IN_PROGRESS"?1:0),completed:a.completed+(x.status==="COMPLETED"?1:0),stops:a.stops+x.totalStops,done:a.done+x.completedStops,opportunity:a.opportunity+x.opportunityAmount,collection:a.collection+x.collectionAmount}),{people:0,planned:0,inProgress:0,completed:0,stops:0,done:0,opportunity:0,collection:0});
    totals.opportunity=money(totals.opportunity);totals.collection=money(totals.collection);return ok(res,{dateKey,items,totals});
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/route/priority", async(req,res)=>{
  try{const lat=Number(req.query.lat),lng=Number(req.query.lng);if(!validCoord(lat,lng))return fail(res,"Current latitude and longitude are required",400);const radiusKm=Math.min(100,Math.max(.2,Number(req.query.radiusKm||25))),limit=Math.min(100,Math.max(3,Number(req.query.limit||30)));const items=await priorityRouteItems({req,financialYear:fyOf(req),latitude:lat,longitude:lng,radiusMeters:radiusKm*1000,limit});return ok(res,{items,current:{latitude:lat,longitude:lng},radiusKm});}catch(error){return fail(res,error.message,error.statusCode||500);}
});
router.get("/route/nearby", async(req,res)=>{
  try{const lat=Number(req.query.lat),lng=Number(req.query.lng);if(!validCoord(lat,lng))return fail(res,"Current latitude and longitude are required",400);const radiusMeters=Math.min(10000,Math.max(50,Number(req.query.radiusMeters||1500)));const items=await priorityRouteItems({req,financialYear:fyOf(req),latitude:lat,longitude:lng,radiusMeters,limit:50});return ok(res,{items,radiusMeters});}catch(error){return fail(res,error.message,error.statusCode||500);}
});

// ---------------- VOICE TO CRM ----------------
router.post("/voice/parse", async(req,res)=>{
  try{const parsed=await parseVoiceCrm({tenantKey:req.auth.tenantKey,transcript:req.body.transcript});if(!parsed.transcript)return fail(res,"Transcript is required",400);return ok(res,{parsed});}catch(error){return fail(res,error.message,500);}
});
router.post("/voice/customer/:globalId", async(req,res)=>{
  try{
    const customer=await requireVisibleCustomer(req,req.params.globalId);const parsed=req.body.structured&&typeof req.body.structured==="object"?req.body.structured:await parseVoiceCrm({tenantKey:req.auth.tenantKey,transcript:req.body.transcript});const transcript=clean(req.body.transcript||parsed.transcript);if(!transcript)return fail(res,"Transcript is required",400);
    const clientMutationId=clean(req.body.clientMutationId);if(clientMutationId){const existing=await SalesCrmActivity.findOne({tenantKey:req.auth.tenantKey,clientMutationId}).lean();if(existing)return ok(res,{activity:existing,parsed:existing.structured||parsed},"CRM activity already synced");}
    let activityId=makeId("CRM");while(await SalesCrmActivity.exists({activityId}))activityId=makeId("CRM");const next=parsed.nextFollowUpAt?new Date(parsed.nextFollowUpAt):null;
    const activity=await SalesCrmActivity.create({tenantKey:req.auth.tenantKey,activityId,clientMutationId:clientMutationId||undefined,salespersonId:req.auth.sub,salespersonNameSnapshot:req.auth.name||"",customerGlobalId:customer.globalCustomerId,customerNameSnapshot:customerName(customer),channel:upper(req.body.channel)==="TEXT"?"TEXT":"VOICE",transcript,structured:parsed,outcome:clean(parsed.outcome),nextFollowUpAt:next&&!Number.isNaN(next.getTime())?next:null,status:"SAVED",createdBy:req.auth.sub});return ok(res,{activity,parsed},"CRM activity saved",201);
  }catch(error){return fail(res,error.message,error.statusCode||500);}
});
router.get("/voice/customer/:globalId", async(req,res)=>{
  try{await requireVisibleCustomer(req,req.params.globalId);const items=await SalesCrmActivity.find({tenantKey:req.auth.tenantKey,customerGlobalId:clean(req.params.globalId),status:"SAVED"}).sort({createdAt:-1}).limit(50).lean();return ok(res,{items});}catch(error){return fail(res,error.message,error.statusCode||500);}
});

router.get("/collection-target", async (req, res) => {
  try {
    const financialYear = fyOf(req), at = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(at.getTime())) return fail(res, "Invalid date", 400);
    return ok(res, { ...(await collectionTargetForUser({ tenantKey: req.auth.tenantKey, financialYear, userId: req.auth.sub, at })), financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/opportunities", async (req, res) => {
  try {
    const financialYear = fyOf(req), limit = Math.min(200, Math.max(10, Number(req.query.limit || 60)));
    const items = await opportunityItemsForUser({ req, financialYear, limit });
    const counts = items.reduce((acc, item) => { acc[item.type] = (acc[item.type] || 0) + 1; return acc; }, {});
    return ok(res, { items, counts, financialYear });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/home", async (req, res) => {
  try {
    const financialYear = fyOf(req), now = new Date();
    const { filter } = await visibleCustomerFilter(req, { status: "ACTIVE" });
    const customers = await CustomerLink.find(filter).select("globalCustomerId localName displayIdentifier companyContactNumber ownerMobile contacts addresses creditDays creditLimit accountingProfile salespersonId").lean();
    const ids = customers.map((x) => x.globalCustomerId);
    const { SalesInvoice, SalesOrder, Receipt } = financialModels(req.auth.tenantKey, financialYear);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1), monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1), todayStart = startOfDay(now), todayEnd = endOfDay(now);
    const [priority, cash, collectionTarget, monthSalesAgg, todayOrdersAgg, todayCollectionsAgg, targetDoc] = await Promise.all([
      collectionPriorityItems({ tenantKey: req.auth.tenantKey, financialYear, customers }),
      cashSummaryForUser({ tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, at: now }),
      collectionTargetForUser({ tenantKey: req.auth.tenantKey, financialYear, userId: req.auth.sub, at: now }),
      ids.length ? SalesInvoice.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, customerGlobalId: { $in: ids }, status: "POSTED", date: { $gte: monthStart, $lt: monthEnd } } }, { $group: { _id: null, sales: { $sum: "$grandTotal" }, invoices: { $sum: 1 } } }]) : [],
      SalesOrder.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, salespersonId: req.auth.sub, date: { $gte: todayStart, $lt: todayEnd }, status: { $nin: ["CANCELLED", "REJECTED"] } } }, { $group: { _id: null, sales: { $sum: "$grandTotal" }, orders: { $sum: 1 } } }]),
      Receipt.aggregate([{ $match: { tenantKey: req.auth.tenantKey, financialYear, status: "POSTED", date: { $gte: todayStart, $lt: todayEnd }, ...collectionOwnerFilter(req.auth.sub) } }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      Target.findOne({ tenantKey: req.auth.tenantKey, financialYear, level: "USER", entityId: req.auth.sub, status: { $ne: "CANCELLED" } }).lean(),
    ]);
    const opportunities = await opportunityItemsForUser({ req, financialYear, limit: 20, customers, priority });
    const salesMonth = money(monthSalesAgg[0]?.sales || 0), invoicesMonth = num(monthSalesAgg[0]?.invoices), todayOrderSales = money(todayOrdersAgg[0]?.sales || 0), todayOrders = num(todayOrdersAgg[0]?.orders);
    const todayCollections = money(todayCollectionsAgg[0]?.amount || 0), todayReceiptCount = num(todayCollectionsAgg[0]?.count);
    const monthlyNames = [monthKey(now), String(now.getMonth()+1).padStart(2,"0"), now.toLocaleString("en-US",{month:"long"}), now.toLocaleString("en-US",{month:"short"})].map((x)=>x.toLowerCase());
    const salesMonthRow = (targetDoc?.monthly || []).find((x) => monthlyNames.includes(clean(x?.month).toLowerCase()));
    const salesTarget = money(num(salesMonthRow?.sales) || (num(targetDoc?.annual?.sales) > 0 ? num(targetDoc.annual.sales) / 12 : 0));
    const salesRemaining = money(Math.max(0, salesTarget - salesMonth));
    const salesAchievementPct = salesTarget > 0 ? Math.round(Math.min(999, salesMonth / salesTarget * 100) * 10) / 10 : 0;
    const overdue = money(priority.reduce((s, x) => s + num(x.overdueAmount), 0));
    const promisedToday = money(priority.reduce((s, x) => s + num(x.promisedToday), 0));
    const outstanding = money(priority.reduce((s, x) => s + Math.max(0, num(x.outstanding)), 0));
    const brokenPromises = priority.filter((x) => x.brokenPromiseAmount > 0).length;
    const top = opportunities[0] || null;
    const headline = top ? top.title : "You're caught up";
    const headlineSub = top ? top.subtitle : "No urgent sales or collection action is waiting right now.";
    return ok(res, {
      financialYear,
      today: { orderSales: todayOrderSales, orders: todayOrders, collections: todayCollections, receipts: todayReceiptCount, promisedToday, cashInHand: cash.cashInHand },
      month: { sales: salesMonth, invoices: invoicesMonth, salesTarget, salesRemaining, salesAchievementPct, collectionTarget },
      receivables: { outstanding, overdue, priorityCustomers: priority.length, brokenPromises },
      cash,
      nextBestAction: top ? { ...top, headline, headlineSub } : { headline, headlineSub },
      opportunities: opportunities.slice(0, 10),
      opportunityCount: opportunities.length,
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

export default router;
