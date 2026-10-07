import { financialModels } from "./accountingService.js";
import { CompanyProfile, CustomerLink, User } from "../models/index.js";
import { resolveSalesReportRange } from "./salesAnalysisReportService.js";

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();
const MONTH_NAMES = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

function monthMeta(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return { monthKey: "", monthLabel: "" };
  return {
    monthKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    monthLabel: `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
  };
}

function validGstin(value) {
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/i.test(clean(value));
}

function supplierDistrict(supplier) {
  if (!supplier) return "UNASSIGNED DISTRICT";
  const addresses = Array.isArray(supplier.addresses) ? supplier.addresses : [];
  const preferred = addresses.find((x) => ["BILLING", "BUSINESS", "REGISTERED"].includes(upper(x?.type)))
    || addresses.find((x) => clean(x?.district))
    || addresses[0];
  return clean(preferred?.district || supplier.ownerDistrict) || "UNASSIGNED DISTRICT";
}

function registrationBucket({ partyName, gstin, supplier }) {
  if (upper(partyName) === "CASH" || upper(supplier?.localName) === "CASH") return "UNREGISTER";
  const registration = upper(supplier?.registrationType);
  if (registration.includes("UNREG")) return "UNREGISTER";
  if (registration.includes("REGULAR") || registration === "REGISTERED") return "REGULAR";
  const supplierGstin = validGstin(supplier?.displayIdentifier) ? supplier.displayIdentifier : "";
  return validGstin(gstin || supplierGstin) ? "REGULAR" : "UNREGISTER";
}

function partyFilterKey({ supplierGlobalId, partyName }) {
  const id = clean(supplierGlobalId);
  if (id) return id;
  if (upper(partyName) === "CASH") return "__CASH__";
  return `NAME:${upper(partyName)}`;
}

function uniqueProductKeys(items = []) {
  const keys = new Set();
  for (const item of items || []) {
    const key = clean(item.productId || item.sku || item.nameSnapshot).toUpperCase();
    if (key) keys.add(key);
  }
  return [...keys];
}

function productOptionsFromInvoices(invoices = []) {
  const map = new Map();
  for (const invoice of invoices || []) {
    for (const item of invoice.items || []) {
      const id = clean(item.productId || item.sku || item.nameSnapshot).toUpperCase();
      if (!id || map.has(id)) continue;
      map.set(id, {
        id,
        name: clean(item.nameSnapshot || item.sku || item.productId) || "PRODUCT",
        hsn: clean(item.hsnSnapshot),
      });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function directItemTaxes(invoice) {
  return (invoice.items || []).reduce((acc, item) => {
    acc.cgst += Number(item.cgst || 0);
    acc.sgst += Number(item.sgst || 0);
    acc.igst += Number(item.igst || 0);
    return acc;
  }, { cgst: 0, sgst: 0, igst: 0 });
}

function purchaseInvoiceTaxSplit(invoice, company, supplier) {
  const direct = directItemTaxes(invoice);
  if (direct.cgst || direct.sgst || direct.igst) {
    return { cgst: money(direct.cgst), sgst: money(direct.sgst), igst: money(direct.igst) };
  }
  const total = money(invoice.taxTotal || 0);
  if (!total) return { cgst: 0, sgst: 0, igst: 0 };
  const companyGstin = upper(company?.gstin);
  const supplierGstin = upper(invoice.supplierGstinSnapshot || supplier?.displayIdentifier);
  let interstate = false;
  if (validGstin(companyGstin) && validGstin(supplierGstin)) {
    interstate = companyGstin.slice(0, 2) !== supplierGstin.slice(0, 2);
  } else {
    const addresses = Array.isArray(supplier?.addresses) ? supplier.addresses : [];
    const address = addresses.find((x) => ["BILLING", "BUSINESS", "REGISTERED"].includes(upper(x?.type))) || addresses[0];
    const supplierState = upper(address?.state || supplier?.ownerState);
    interstate = Boolean(supplierState && upper(company?.state) && supplierState !== upper(company?.state));
  }
  return interstate
    ? { cgst: 0, sgst: 0, igst: total }
    : { cgst: money(total / 2), sgst: money(total - money(total / 2)), igst: 0 };
}

function purchaseTaxType(invoice, company, supplier, taxes = null) {
  const resolved = taxes || purchaseInvoiceTaxSplit(invoice, company, supplier);
  return Number(resolved.igst || 0) > 0 ? "IGST" : "CGST_SGST";
}

function purchaseInvoicePageCrossCheck(invoices = [], company, supplierMap) {
  const productKeys = new Set();
  const totals = invoices.reduce((acc, invoice) => {
    uniqueProductKeys(invoice.items).forEach((key) => productKeys.add(key));
    const supplier = supplierMap.get(clean(invoice.supplierGlobalId)) || null;
    const tax = purchaseInvoiceTaxSplit(invoice, company, supplier);
    acc.records += 1;
    acc.cgst += Number(tax.cgst || 0);
    acc.sgst += Number(tax.sgst || 0);
    acc.igst += Number(tax.igst || 0);
    acc.basicAmount += Number(invoice.subtotal ?? invoice.taxableTotal ?? 0);
    acc.taxableAmount += Number(invoice.taxableTotal ?? invoice.subtotal ?? 0);
    acc.roundOff += Number(invoice.roundOff || 0);
    acc.grandTotal += Number(invoice.grandTotal || 0);
    acc.charges += Number(invoice.otherCharges || 0);
    acc.landedCharges += Number(invoice.landedCharges || 0);
    return acc;
  }, { records: 0, products: 0, cgst: 0, sgst: 0, igst: 0, basicAmount: 0, taxableAmount: 0, roundOff: 0, grandTotal: 0, charges: 0, landedCharges: 0 });
  totals.products = productKeys.size;
  for (const key of ["cgst", "sgst", "igst", "basicAmount", "taxableAmount", "roundOff", "grandTotal", "charges", "landedCharges"]) totals[key] = money(totals[key]);
  return totals;
}

function purchaseProductRowCrossCheck(rows = []) {
  const totals = rows.reduce((acc, row) => {
    for (const key of ["quantity", "cgst", "sgst", "igst", "basicTotal", "discount", "charges", "taxableTotal", "roundOff", "grandTotal"]) {
      acc[key] += Number(row[key] || 0);
    }
    return acc;
  }, { quantity: 0, cgst: 0, sgst: 0, igst: 0, basicTotal: 0, discount: 0, charges: 0, taxableTotal: 0, roundOff: 0, grandTotal: 0 });
  Object.keys(totals).forEach((key) => { totals[key] = money(totals[key]); });
  return totals;
}

export function purchaseReportTotals(rows = []) {
  const productKeys = new Set();
  const totals = rows.reduce((acc, row) => {
    (row.productKeys || []).forEach((key) => productKeys.add(key));
    acc.records += 1;
    acc.cgst += Number(row.cgst || 0);
    acc.sgst += Number(row.sgst || 0);
    acc.igst += Number(row.igst || 0);
    acc.basicAmount += Number(row.basicAmount || 0);
    acc.taxableAmount += Number(row.taxableAmount || 0);
    acc.grandTotal += Number(row.grandTotal || 0);
    return acc;
  }, { records: 0, products: 0, cgst: 0, sgst: 0, igst: 0, basicAmount: 0, taxableAmount: 0, grandTotal: 0 });
  totals.products = productKeys.size;
  return totals;
}

async function reportBaseData({ tenantKey, financialYear, range }) {
  const models = financialModels(tenantKey, financialYear);
  const invoices = await models.PurchaseInvoice.find({
    tenantKey,
    financialYear,
    date: { $gte: range.start, $lt: range.end },
    status: { $ne: "DELETED" },
  })
    .select("_id date invoiceNo supplierGlobalId supplierNameSnapshot supplierGstinSnapshot items subtotal billDiscount otherCharges taxableTotal taxTotal roundOff grandTotal landedCharges createdBy createdByNameSnapshot status")
    .sort({ date: 1, createdAt: 1 })
    .lean();

  const supplierIds = [...new Set(invoices.map((row) => clean(row.supplierGlobalId)).filter(Boolean))];
  const [suppliers, company] = await Promise.all([
    supplierIds.length
      ? CustomerLink.find({ tenantKey, globalCustomerId: { $in: supplierIds } })
        .select("globalCustomerId localName displayIdentifier registrationType ownerDistrict ownerState addresses partyType")
        .lean()
      : [],
    CompanyProfile.findOne({ tenantKey }).select("gstin state companyName").lean(),
  ]);
  const supplierMap = new Map(suppliers.map((row) => [clean(row.globalCustomerId), row]));

  const userIds = [...new Set(invoices.map((row) => clean(row.createdBy)).filter((id) => /^[0-9a-f]{24}$/i.test(id)))];
  const users = userIds.length
    ? await User.find({ tenantKey, _id: { $in: userIds } }).select("_id name email").lean()
    : [];
  const userMap = new Map(users.map((row) => [String(row._id), row]));
  return { invoices, suppliers, supplierMap, company, userMap };
}

export async function buildPurchaseAnalysisReport({
  tenantKey,
  financialYear,
  view,
  period,
  dateFrom,
  dateTo,
  partyType = "",
  userId = "",
  district = "",
  partyId = "",
  productId = "",
  taxType = "",
}) {
  const range = resolveSalesReportRange({ financialYear, view, period, dateFrom, dateTo });
  const { invoices, suppliers, supplierMap, company, userMap } = await reportBaseData({ tenantKey, financialYear, range });

  const allRows = invoices.map((invoice) => {
    const supplier = supplierMap.get(clean(invoice.supplierGlobalId)) || null;
    const partyName = invoice.supplierNameSnapshot || supplier?.localName || supplier?.displayIdentifier || "SUPPLIER";
    const createdById = clean(invoice.createdBy);
    const createdByUser = userMap.get(createdById);
    const taxes = purchaseInvoiceTaxSplit(invoice, company, supplier);
    const productKeys = uniqueProductKeys(invoice.items);
    const month = monthMeta(invoice.date);
    return {
      id: String(invoice._id),
      date: invoice.date,
      number: invoice.invoiceNo || "",
      partyName,
      partyKey: partyFilterKey({ supplierGlobalId: invoice.supplierGlobalId, partyName }),
      supplierGlobalId: invoice.supplierGlobalId || "",
      registrationType: registrationBucket({ partyName, gstin: invoice.supplierGstinSnapshot, supplier }),
      taxType: purchaseTaxType(invoice, company, supplier, taxes),
      district: supplierDistrict(supplier),
      userId: createdById,
      userName: invoice.createdByNameSnapshot || createdByUser?.name || (createdById ? "UNMAPPED USER" : "UNASSIGNED"),
      productKeys,
      noOfProducts: productKeys.length,
      cgst: taxes.cgst,
      sgst: taxes.sgst,
      igst: taxes.igst,
      basicAmount: money(invoice.subtotal ?? invoice.taxableTotal),
      taxableAmount: money(invoice.taxableTotal ?? invoice.subtotal),
      grandTotal: money(invoice.grandTotal),
      ...month,
    };
  });

  const parties = [...new Map(allRows.map((row) => [row.partyKey, { id: row.partyKey, name: row.partyName || "SUPPLIER" }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const products = productOptionsFromInvoices(invoices);
  const users = [...new Map(allRows.filter((row) => row.userId).map((row) => [row.userId, { id: row.userId, name: row.userName }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const wantedPartyType = upper(partyType);
  const wantedPartyId = clean(partyId);
  const wantedProductId = upper(productId);
  const wantedTaxType = upper(taxType);

  // Territory choices must come only from rows in the current purchase
  // report, not from every supplier in the master. This prevents unrelated
  // territories from appearing in the selector.
  let territorySourceRows = allRows;
  if (["REGULAR", "UNREGISTER"].includes(wantedPartyType)) territorySourceRows = territorySourceRows.filter((row) => row.registrationType === wantedPartyType);
  if (clean(userId)) territorySourceRows = territorySourceRows.filter((row) => row.userId === clean(userId));
  if (wantedPartyId) territorySourceRows = territorySourceRows.filter((row) => row.partyKey === wantedPartyId);
  if (wantedProductId) territorySourceRows = territorySourceRows.filter((row) => (row.productKeys || []).includes(wantedProductId));
  if (["IGST", "CGST_SGST"].includes(wantedTaxType)) territorySourceRows = territorySourceRows.filter((row) => row.taxType === wantedTaxType);

  const districts = [...new Set(territorySourceRows.map((row) => clean(row.district)).filter((value) => value && upper(value) !== "UNASSIGNED DISTRICT"))]
    .sort((a, b) => a === "UNASSIGNED DISTRICT" ? 1 : b === "UNASSIGNED DISTRICT" ? -1 : a.localeCompare(b));

  let rows = territorySourceRows;
  if (clean(district)) rows = rows.filter((row) => upper(row.district) === upper(district));
  rows.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.number).localeCompare(String(b.number)));

  const filteredIds = new Set(rows.map((row) => row.id));
  const crossCheckTotals = purchaseInvoicePageCrossCheck(invoices.filter((invoice) => filteredIds.has(String(invoice._id))), company, supplierMap);
  const totals = purchaseReportTotals(rows);
  Object.keys(totals).forEach((key) => {
    if (!['records', 'products'].includes(key)) totals[key] = money(totals[key]);
  });

  return {
    financialYear,
    view: upper(view || "MONTHLY"),
    period: clean(period),
    dateFrom: range.start.toISOString().slice(0, 10),
    dateTo: new Date(range.end.getTime() - 86400000).toISOString().slice(0, 10),
    generatedAt: new Date(),
    partyTypes: ["REGULAR", "UNREGISTER"],
    taxTypes: ["IGST", "CGST_SGST"],
    parties,
    products,
    users,
    districts,
    totals,
    crossCheckTotals,
    rows,
  };
}

function allocatePurchaseItemRows(invoice, { supplier, company, userMap }) {
  const partyName = invoice.supplierNameSnapshot || supplier?.localName || supplier?.displayIdentifier || "SUPPLIER";
  const partyKey = partyFilterKey({ supplierGlobalId: invoice.supplierGlobalId, partyName });
  const createdById = clean(invoice.createdBy);
  const createdByUser = userMap.get(createdById);
  const userName = invoice.createdByNameSnapshot || createdByUser?.name || (createdById ? "UNMAPPED USER" : "UNASSIGNED");
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const invoiceTaxes = purchaseInvoiceTaxSplit(invoice, company, supplier);
  const invoiceTaxTypeValue = purchaseTaxType(invoice, company, supplier, invoiceTaxes);
  const invoiceSubtotal = money(Number(invoice.subtotal ?? items.reduce((sum, item) => sum + Number(item.taxable || 0), 0)));
  const billDiscount = money(Math.max(0, Number(invoice.billDiscount || 0)));
  const otherCharges = money(Math.max(0, Number(invoice.otherCharges || 0)));
  const taxableTarget = money(Number(invoice.taxableTotal ?? Math.max(0, invoiceSubtotal - billDiscount + otherCharges)));
  const taxTarget = money(Number(invoice.taxTotal || 0));
  const roundOffTarget = money(Number(invoice.roundOff || 0));
  const grandTarget = money(Number(invoice.grandTotal ?? taxableTarget + taxTarget + roundOffTarget));
  const month = monthMeta(invoice.date);

  let discountAllocated = 0;
  let chargesAllocated = 0;
  let taxableAllocated = 0;
  let taxAllocated = 0;
  let roundAllocated = 0;
  let grandAllocated = 0;

  const basicPool = items.reduce((sum, item) => sum + Math.max(0, Number(item.taxable ?? (Number(item.qty || 0) * Number(item.rate || 0)))), 0);
  const prelim = items.map((item, index) => {
    const isLast = index === items.length - 1;
    const qty = Number(item.qty || 0);
    const rate = Number(item.rate || 0);
    const basicTotal = money(Number.isFinite(Number(item.taxable)) ? Number(item.taxable) : qty * rate);
    const share = basicPool > 0 ? basicTotal / basicPool : (items.length ? 1 / items.length : 0);
    const explicitDiscount = Number(item.billDiscountShare);
    const explicitCharge = Number(item.billChargeShare);
    const discount = isLast
      ? money(billDiscount - discountAllocated)
      : money(Number.isFinite(explicitDiscount) ? explicitDiscount : billDiscount * share);
    const charges = isLast
      ? money(otherCharges - chargesAllocated)
      : money(Number.isFinite(explicitCharge) ? explicitCharge : otherCharges * share);
    let taxableTotal = Number(item.netTaxable);
    if (!Number.isFinite(taxableTotal)) taxableTotal = Math.max(0, basicTotal - discount + charges);
    taxableTotal = isLast ? money(taxableTarget - taxableAllocated) : money(taxableTotal);
    discountAllocated = money(discountAllocated + discount);
    chargesAllocated = money(chargesAllocated + charges);
    taxableAllocated = money(taxableAllocated + taxableTotal);
    const directTax = money(Number(item.cgst || 0) + Number(item.sgst || 0) + Number(item.igst || 0));
    const estimatedTax = directTax || money(taxableTotal * Math.max(0, Number(item.gstRateSnapshot || 0)) / 100);
    return { item, index, isLast, qty, rate, basicTotal, discount, charges, taxableTotal, estimatedTax, directTax };
  });
  const estimatedTaxPool = prelim.reduce((sum, row) => sum + Number(row.estimatedTax || 0), 0);

  return prelim.map((row) => {
    const item = row.item;
    const taxShare = row.isLast
      ? money(taxTarget - taxAllocated)
      : money(estimatedTaxPool > 0 ? taxTarget * (row.estimatedTax / estimatedTaxPool) : (prelim.length ? taxTarget / prelim.length : 0));
    taxAllocated = money(taxAllocated + taxShare);
    const roundShare = taxableTarget > 0 ? row.taxableTotal / taxableTarget : (prelim.length ? 1 / prelim.length : 0);
    const roundOff = row.isLast ? money(roundOffTarget - roundAllocated) : money(roundOffTarget * roundShare);
    roundAllocated = money(roundAllocated + roundOff);
    const grandTotal = row.isLast ? money(grandTarget - grandAllocated) : money(row.taxableTotal + taxShare + roundOff);
    grandAllocated = money(grandAllocated + grandTotal);

    let cgst = Number(item.cgst || 0), sgst = Number(item.sgst || 0), igst = Number(item.igst || 0);
    const directTotal = cgst + sgst + igst;
    if (!directTotal || Math.abs(directTotal - taxShare) > 0.02) {
      if (invoiceTaxTypeValue === "IGST") { cgst = 0; sgst = 0; igst = taxShare; }
      else { cgst = money(taxShare / 2); sgst = money(taxShare - cgst); igst = 0; }
    }

    return {
      id: `${invoice._id}-${row.index}`,
      invoiceId: String(invoice._id),
      date: invoice.date,
      number: invoice.invoiceNo || "",
      partyName,
      partyKey,
      supplierGlobalId: invoice.supplierGlobalId || "",
      registrationType: registrationBucket({ partyName, gstin: invoice.supplierGstinSnapshot, supplier }),
      taxType: invoiceTaxTypeValue,
      userId: createdById,
      userName,
      district: supplierDistrict(supplier),
      productName: item.nameSnapshot || item.sku || "PRODUCT",
      productKey: clean(item.productId || item.sku || item.nameSnapshot).toUpperCase(),
      productHsn: item.hsnSnapshot || "",
      quantity: row.qty,
      basicRate: money(row.rate),
      cgst: money(cgst),
      sgst: money(sgst),
      igst: money(igst),
      basicTotal: row.basicTotal,
      discount: row.discount,
      charges: row.charges,
      taxableTotal: row.taxableTotal,
      roundOff,
      grandTotal,
      ...month,
    };
  });
}

export async function buildPurchasePartyProductReport({
  tenantKey,
  financialYear,
  view,
  period,
  dateFrom,
  dateTo,
  partyType = "",
  userId = "",
  partyId = "",
  productId = "",
  taxType = "",
}) {
  const range = resolveSalesReportRange({ financialYear, view, period, dateFrom, dateTo });
  const { invoices, supplierMap, company, userMap } = await reportBaseData({ tenantKey, financialYear, range });
  let rows = invoices.flatMap((invoice) => allocatePurchaseItemRows(invoice, {
    supplier: supplierMap.get(clean(invoice.supplierGlobalId)) || null,
    company,
    userMap,
  }));

  const parties = [...new Map(rows.map((row) => [row.partyKey, { id: row.partyKey, name: row.partyName || "SUPPLIER" }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const products = productOptionsFromInvoices(invoices);
  const users = [...new Map(rows.filter((row) => row.userId).map((row) => [row.userId, { id: row.userId, name: row.userName }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));

  const wantedPartyType = upper(partyType);
  const wantedPartyId = clean(partyId);
  const wantedProductId = upper(productId);
  const wantedTaxType = upper(taxType);
  if (["REGULAR", "UNREGISTER"].includes(wantedPartyType)) rows = rows.filter((row) => row.registrationType === wantedPartyType);
  if (clean(userId)) rows = rows.filter((row) => row.userId === clean(userId));
  if (wantedPartyId) rows = rows.filter((row) => row.partyKey === wantedPartyId);
  if (wantedProductId) rows = rows.filter((row) => row.productKey === wantedProductId);
  if (["IGST", "CGST_SGST"].includes(wantedTaxType)) rows = rows.filter((row) => row.taxType === wantedTaxType);
  rows.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.number).localeCompare(String(b.number)) || String(a.productName).localeCompare(String(b.productName)));

  const totals = rows.reduce((acc, row) => {
    for (const key of ["quantity", "cgst", "sgst", "igst", "basicTotal", "discount", "charges", "taxableTotal", "roundOff", "grandTotal"]) acc[key] += Number(row[key] || 0);
    return acc;
  }, { quantity: 0, cgst: 0, sgst: 0, igst: 0, basicTotal: 0, discount: 0, charges: 0, taxableTotal: 0, roundOff: 0, grandTotal: 0 });
  Object.keys(totals).forEach((key) => { totals[key] = money(totals[key]); });
  const crossCheckTotals = purchaseProductRowCrossCheck(rows);

  return {
    financialYear,
    view: upper(view || "MONTHLY"),
    period: clean(period),
    dateFrom: range.start.toISOString().slice(0, 10),
    dateTo: new Date(range.end.getTime() - 86400000).toISOString().slice(0, 10),
    generatedAt: new Date(),
    partyTypes: ["REGULAR", "UNREGISTER"],
    taxTypes: ["IGST", "CGST_SGST"],
    parties,
    products,
    users,
    totals,
    crossCheckTotals,
    rows,
  };
}
