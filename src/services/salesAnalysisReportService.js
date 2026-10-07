import { financialModels } from "./accountingService.js";
import { CompanyProfile, CustomerLink, User } from "../models/index.js";

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();
const MONTH_NAMES = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

function financialYearBounds(financialYear) {
  const startYear = Number(String(financialYear || "").slice(0, 4));
  if (!Number.isFinite(startYear)) throw Object.assign(new Error("Invalid financial year"), { statusCode: 400 });
  return {
    start: new Date(Date.UTC(startYear, 3, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(startYear + 1, 3, 1, 0, 0, 0, 0)),
  };
}

function clampRange(start, end, bounds) {
  const from = start > bounds.start ? start : bounds.start;
  const to = end < bounds.end ? end : bounds.end;
  if (from >= to) throw Object.assign(new Error("Selected period is outside the selected financial year"), { statusCode: 400 });
  return { start: from, end: to };
}

function utcDate(value, endExclusive = false) {
  const raw = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (endExclusive) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

export function resolveSalesReportRange({ financialYear, view = "MONTHLY", period = "", dateFrom = "", dateTo = "" }) {
  const bounds = financialYearBounds(financialYear);
  const mode = upper(view || "MONTHLY");
  const fyStartYear = bounds.start.getUTCFullYear();

  if (mode === "DATE_WISE") {
    const start = utcDate(dateFrom);
    const end = utcDate(dateTo || dateFrom, true);
    if (!start || !end) throw Object.assign(new Error("Select valid From and To dates"), { statusCode: 400 });
    if (start >= end) throw Object.assign(new Error("From date must be before or equal to To date"), { statusCode: 400 });
    return clampRange(start, end, bounds);
  }

  if (mode === "MONTHLY") {
    const month = Number(period);
    if (!Number.isInteger(month) || month < 1 || month > 12) return bounds;
    const year = month >= 4 ? fyStartYear : fyStartYear + 1;
    return clampRange(new Date(Date.UTC(year, month - 1, 1)), new Date(Date.UTC(year, month, 1)), bounds);
  }

  if (mode === "QUARTERLY") {
    const quarter = Math.min(4, Math.max(1, Number(String(period).replace(/\D/g, "")) || 1));
    const startMonthIndex = 3 + (quarter - 1) * 3;
    return clampRange(
      new Date(Date.UTC(fyStartYear, startMonthIndex, 1)),
      new Date(Date.UTC(fyStartYear, startMonthIndex + 3, 1)),
      bounds,
    );
  }

  if (mode === "HALF_YEARLY") {
    const second = upper(period) === "H2";
    const start = second ? new Date(Date.UTC(fyStartYear, 9, 1)) : bounds.start;
    const end = second ? bounds.end : new Date(Date.UTC(fyStartYear, 9, 1));
    return clampRange(start, end, bounds);
  }

  return bounds;
}

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

function invoiceItemTax(invoice) {
  return (invoice.items || []).reduce((acc, item) => {
    acc.cgst += Number(item.cgst || 0);
    acc.sgst += Number(item.sgst || 0);
    acc.igst += Number(item.igst || 0);
    return acc;
  }, { cgst: 0, sgst: 0, igst: 0 });
}

function taxSplit({ totalTax, cgst, sgst, igst, company, customer, gstin }) {
  const directCgst = Number(cgst || 0), directSgst = Number(sgst || 0), directIgst = Number(igst || 0);
  if (directCgst || directSgst || directIgst) return { cgst: money(directCgst), sgst: money(directSgst), igst: money(directIgst) };
  const total = Number(totalTax || 0);
  if (!total) return { cgst: 0, sgst: 0, igst: 0 };

  const companyGstin = upper(company?.gstin);
  const partyGstin = upper(gstin || customer?.displayIdentifier);
  let sameState = false;
  if (validGstin(companyGstin) && validGstin(partyGstin)) sameState = companyGstin.slice(0, 2) === partyGstin.slice(0, 2);
  else {
    const address = (customer?.addresses || []).find((x) => ["BILLING", "BUSINESS"].includes(upper(x?.type))) || customer?.addresses?.[0];
    const customerState = upper(address?.state || customer?.ownerState);
    sameState = Boolean(customerState && upper(company?.state) && customerState === upper(company?.state));
  }
  return sameState
    ? { cgst: money(total / 2), sgst: money(total / 2), igst: 0 }
    : { cgst: 0, sgst: 0, igst: money(total) };
}

function uniqueProductKeys(items = []) {
  const keys = new Set();
  for (const item of items || []) {
    const key = clean(item.productId || item.sku || item.nameSnapshot).toUpperCase();
    if (key) keys.add(key);
  }
  return [...keys];
}

function customerDistrict(customer) {
  if (!customer) return "UNASSIGNED DISTRICT";
  const addresses = Array.isArray(customer.addresses) ? customer.addresses : [];
  const preferred = addresses.find((x) => ["BILLING", "BUSINESS"].includes(upper(x?.type))) || addresses.find((x) => clean(x?.district)) || addresses[0];
  return clean(preferred?.district || customer.ownerDistrict) || "UNASSIGNED DISTRICT";
}

function registrationBucket({ partyName, gstin, customer }) {
  if (upper(partyName) === "CASH" || upper(customer?.localName) === "CASH") return "UNREGISTER";
  const registration = upper(customer?.registrationType);
  if (registration.includes("UNREG")) return "UNREGISTER";
  if (registration.includes("REGULAR") || registration === "REGISTERED") return "REGULAR";
  const customerGstin = validGstin(customer?.displayIdentifier) ? customer.displayIdentifier : "";
  return validGstin(gstin || customerGstin) ? "REGULAR" : "UNREGISTER";
}

function partyFilterKey({ customerGlobalId, partyName }) {
  const id = clean(customerGlobalId);
  if (id) return id;
  if (upper(partyName) === "CASH") return "__CASH__";
  return `NAME:${upper(partyName)}`;
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

function invoicePageTaxSplit(invoice) {
  const direct = invoiceItemTax(invoice);
  if (direct.cgst || direct.sgst || direct.igst) {
    return { cgst: money(direct.cgst), sgst: money(direct.sgst), igst: money(direct.igst) };
  }
  const numericTax = Number(invoice.taxTotal);
  const total = money(Number.isFinite(numericTax)
    ? numericTax
    : Math.max(0, Number(invoice.grandTotal || 0) - Number(invoice.taxableTotal ?? invoice.subtotal ?? 0)));
  if (upper(invoice.gstType) === "IGST") return { cgst: 0, sgst: 0, igst: total };
  return { cgst: money(total / 2), sgst: money(total / 2), igst: 0 };
}

function invoiceTaxType(invoice, resolvedTaxes = null) {
  const storedType = upper(invoice.gstType);
  if (storedType === "IGST") return "IGST";
  if (storedType.includes("CGST") || storedType.includes("SGST")) return "CGST_SGST";
  const taxes = resolvedTaxes || invoicePageTaxSplit(invoice);
  return Number(taxes.igst || 0) > 0 ? "IGST" : "CGST_SGST";
}

function salesInvoicePageCrossCheck(invoices = []) {
  const productKeys = new Set();
  const totals = invoices.reduce((acc, invoice) => {
    uniqueProductKeys(invoice.items).forEach((key) => productKeys.add(key));
    const tax = invoicePageTaxSplit(invoice);
    acc.records += 1;
    acc.packages += Number(invoice.delivery?.noOfPackages ?? invoice.noOfPackages ?? 0);
    acc.cgst += Number(tax.cgst || 0);
    acc.sgst += Number(tax.sgst || 0);
    acc.igst += Number(tax.igst || 0);
    acc.basicAmount += Number(invoice.subtotal ?? invoice.taxableTotal ?? 0);
    acc.taxableAmount += Number(invoice.taxableTotal ?? invoice.subtotal ?? 0);
    acc.roundOff += Number(invoice.roundOff || 0);
    acc.grandTotal += Number(invoice.grandTotal || 0);
    acc.netTotal += Number(invoice.netInvoiceAmount ?? (Number(invoice.grandTotal || 0) - Number(invoice.creditNoteAmount || 0)));
    return acc;
  }, { records: 0, products: 0, packages: 0, cgst: 0, sgst: 0, igst: 0, basicAmount: 0, taxableAmount: 0, roundOff: 0, grandTotal: 0, netTotal: 0 });
  totals.products = productKeys.size;
  for (const key of ["cgst", "sgst", "igst", "basicAmount", "taxableAmount", "roundOff", "grandTotal", "netTotal"]) totals[key] = money(totals[key]);
  return totals;
}

function salesProductRowCrossCheck(rows = []) {
  const totals = rows.reduce((acc, row) => {
    for (const key of ["quantity", "cgst", "sgst", "igst", "basicTotal", "discount", "charges", "taxableTotal", "roundOff", "grandTotal"]) {
      acc[key] += Number(row[key] || 0);
    }
    return acc;
  }, { quantity: 0, cgst: 0, sgst: 0, igst: 0, basicTotal: 0, discount: 0, charges: 0, taxableTotal: 0, roundOff: 0, grandTotal: 0 });
  Object.keys(totals).forEach((key) => { totals[key] = money(totals[key]); });
  return totals;
}

export function salesReportTotals(rows = []) {
  const productKeys = new Set();
  const result = rows.reduce((totals, row) => {
    totals.records += 1;
    (row.productKeys || []).forEach((key) => productKeys.add(key));
    totals.packages += Number(row.noOfPackages || 0);
    totals.cgst += Number(row.cgst || 0);
    totals.sgst += Number(row.sgst || 0);
    totals.igst += Number(row.igst || 0);
    totals.basicAmount += Number(row.basicAmount || 0);
    totals.taxableAmount += Number(row.taxableAmount || 0);
    totals.grandTotal += Number(row.grandTotal || 0);
    return totals;
  }, { records: 0, products: 0, packages: 0, cgst: 0, sgst: 0, igst: 0, basicAmount: 0, taxableAmount: 0, grandTotal: 0 });
  result.products = productKeys.size;
  return result;
}

export async function buildSalesAnalysisReport({
  tenantKey,
  financialYear,
  view,
  period,
  dateFrom,
  dateTo,
  partyType = "",
  salespersonId = "",
  district = "",
  partyId = "",
  productId = "",
  taxType = "",
}) {
  const range = resolveSalesReportRange({ financialYear, view, period, dateFrom, dateTo });
  const models = financialModels(tenantKey, financialYear);
  const dateFilter = { $gte: range.start, $lt: range.end };

  const [invoices, company, invoiceSalespersonIds, customerSalespersonIds] = await Promise.all([
    models.SalesInvoice.find({
      tenantKey,
      financialYear,
      date: dateFilter,
      status: { $nin: ["DELETED", "CANCELLED"] },
    })
      .select("_id date invoiceNo customerGlobalId customerNameSnapshot gstinSnapshot items subtotal taxableTotal taxTotal roundOff grandTotal noOfPackages delivery assignedTo gstType creditNoteAmount netInvoiceAmount")
      .sort({ date: 1, createdAt: 1 })
      .lean(),
    CompanyProfile.findOne({ tenantKey }).select("gstin state companyName").lean(),
    models.SalesInvoice.distinct("assignedTo", { tenantKey, financialYear }),
    CustomerLink.distinct("salespersonId", { tenantKey }),
  ]);

  const customerIds = [...new Set(invoices.map((row) => clean(row.customerGlobalId)).filter(Boolean))];
  const customers = customerIds.length
    ? await CustomerLink.find({ tenantKey, globalCustomerId: { $in: customerIds } })
      .select("globalCustomerId localName displayIdentifier registrationType salespersonId ownerDistrict ownerState addresses")
      .lean()
    : [];
  const customerMap = new Map(customers.map((row) => [clean(row.globalCustomerId), row]));

  const salespersonIds = [...new Set([
    ...invoiceSalespersonIds.map(clean),
    ...customerSalespersonIds.map(clean),
    ...invoices.map((row) => clean(row.assignedTo)),
    ...customers.map((row) => clean(row.salespersonId)),
  ].filter(Boolean))];
  const userObjectIds = salespersonIds.filter((id) => /^[0-9a-f]{24}$/i.test(id));
  const users = userObjectIds.length
    ? await User.find({ tenantKey, _id: { $in: userObjectIds } }).select("_id name email").lean()
    : [];
  const userMap = new Map(users.map((row) => [String(row._id), row]));

  const allRows = invoices.map((invoice) => {
    const customer = customerMap.get(clean(invoice.customerGlobalId)) || null;
    const partyName = invoice.customerNameSnapshot || customer?.localName || customer?.displayIdentifier || "CUSTOMER";
    const isCashParty = upper(partyName) === "CASH" || upper(customer?.localName) === "CASH";
    const resolvedSalespersonId = isCashParty ? "" : clean(invoice.assignedTo || customer?.salespersonId);
    const salesperson = userMap.get(resolvedSalespersonId);
    const itemTax = invoiceItemTax(invoice);
    const taxes = taxSplit({ totalTax: invoice.taxTotal, ...itemTax, company, customer, gstin: invoice.gstinSnapshot });
    const month = monthMeta(invoice.date);
    const productKeys = uniqueProductKeys(invoice.items);
    const districtName = customerDistrict(customer);
    const partyKey = partyFilterKey({ customerGlobalId: invoice.customerGlobalId, partyName });
    const taxTypeValue = invoiceTaxType(invoice, taxes);

    return {
      id: String(invoice._id),
      date: invoice.date,
      number: invoice.invoiceNo || "",
      partyName,
      partyKey,
      customerGlobalId: invoice.customerGlobalId || "",
      registrationType: registrationBucket({ partyName, gstin: invoice.gstinSnapshot, customer }),
      taxType: taxTypeValue,
      district: districtName,
      salespersonId: resolvedSalespersonId,
      salespersonName: salesperson?.name || (resolvedSalespersonId ? "UNMAPPED SALESPERSON" : "UNASSIGNED"),
      productKeys,
      noOfProducts: productKeys.length,
      noOfPackages: Number(invoice.delivery?.noOfPackages ?? invoice.noOfPackages ?? 0),
      cgst: taxes.cgst,
      sgst: taxes.sgst,
      igst: taxes.igst,
      basicAmount: money(invoice.subtotal ?? invoice.taxableTotal),
      taxableAmount: money(invoice.taxableTotal ?? invoice.subtotal),
      grandTotal: money(invoice.grandTotal),
      ...month,
    };
  });

  const salespersons = [...new Map(allRows
    .filter((row) => row.salespersonId)
    .map((row) => [row.salespersonId, { id: row.salespersonId, name: row.salespersonName || "UNMAPPED SALESPERSON" }]))
    .values()].sort((a, b) => a.name.localeCompare(b.name));

  const parties = [...new Map(allRows.map((row) => [row.partyKey, { id: row.partyKey, name: row.partyName || "CUSTOMER" }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const products = productOptionsFromInvoices(invoices);

  const wantedPartyType = upper(partyType);
  const wantedPartyId = clean(partyId);
  const wantedProductId = upper(productId);
  const wantedTaxType = upper(taxType);

  // Build the territory selector only from rows that can actually appear in
  // the current report. Do not pull extra districts from the full customer
  // master, otherwise the dropdown shows territories with no matching data.
  let territorySourceRows = allRows;
  if (["REGULAR", "UNREGISTER"].includes(wantedPartyType)) territorySourceRows = territorySourceRows.filter((row) => row.registrationType === wantedPartyType);
  if (clean(salespersonId)) territorySourceRows = territorySourceRows.filter((row) => row.salespersonId === clean(salespersonId));
  if (wantedPartyId) territorySourceRows = territorySourceRows.filter((row) => row.partyKey === wantedPartyId);
  if (wantedProductId) territorySourceRows = territorySourceRows.filter((row) => (row.productKeys || []).includes(wantedProductId));
  if (["IGST", "CGST_SGST"].includes(wantedTaxType)) territorySourceRows = territorySourceRows.filter((row) => row.taxType === wantedTaxType);

  const districts = [...new Set(territorySourceRows.map((row) => clean(row.district)).filter((value) => value && upper(value) !== "UNASSIGNED DISTRICT"))]
    .sort((a, b) => {
      if (a === "UNASSIGNED DISTRICT") return 1;
      if (b === "UNASSIGNED DISTRICT") return -1;
      return a.localeCompare(b);
    });

  let rows = territorySourceRows;
  if (clean(district)) rows = rows.filter((row) => upper(row.district) === upper(district));
  rows.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.number).localeCompare(String(b.number)));

  const filteredInvoiceIds = new Set(rows.map((row) => row.id));
  const crossCheckTotals = salesInvoicePageCrossCheck(invoices.filter((invoice) => filteredInvoiceIds.has(String(invoice._id))));
  const totals = salesReportTotals(rows);
  Object.keys(totals).forEach((key) => {
    if (!["records", "products", "packages"].includes(key)) totals[key] = money(totals[key]);
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
    salespersons,
    districts,
    totals,
    crossCheckTotals,
    rows,
  };
}


function allocateInvoiceItemRows(invoice, { customer, userMap }) {
  const partyName = invoice.customerNameSnapshot || customer?.localName || customer?.displayIdentifier || "CUSTOMER";
  const isCashParty = upper(partyName) === "CASH" || upper(customer?.localName) === "CASH";
  const salespersonId = isCashParty ? "" : clean(invoice.assignedTo || customer?.salespersonId);
  const salesperson = userMap.get(salespersonId);
  const salespersonName = salesperson?.name || (salespersonId ? "UNMAPPED SALESPERSON" : "UNASSIGNED");
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const itemBaseSubtotal = money(items.reduce((sum, item) => sum + Math.max(0, Number(item.taxable || 0)), 0));
  const invoiceSubtotal = money(Number(invoice.subtotal ?? itemBaseSubtotal));
  const billDiscount = Math.min(invoiceSubtotal, Math.max(0, Number(invoice.billDiscount || 0)));
  const otherCharges = Math.max(0, Number(invoice.otherCharges || 0));
  const taxableTarget = money(Number(invoice.taxableTotal ?? Math.max(0, invoiceSubtotal - billDiscount + otherCharges)));
  const taxTarget = money(Number(invoice.taxTotal || 0));
  const roundOffTarget = money(Number(invoice.roundOff || 0));
  const grandTarget = money(Number(invoice.grandTotal ?? taxableTarget + taxTarget + roundOffTarget));
  const month = monthMeta(invoice.date);
  const partyKey = partyFilterKey({ customerGlobalId: invoice.customerGlobalId, partyName });
  const invoiceTaxTypeValue = invoiceTaxType(invoice);

  let allocatedBillDiscount = 0;
  let allocatedCharges = 0;
  let allocatedTaxable = 0;
  let allocatedTax = 0;
  let allocatedRoundOff = 0;
  let allocatedGrand = 0;

  const prelim = items.map((item, index) => {
    const isLast = index === items.length - 1;
    const qty = Number(item.qty || 0);
    const rate = Number(item.rate || 0);
    const basicTotal = money(qty * rate);
    const lineTaxableBeforeBill = money(Math.max(0, Number(item.taxable ?? basicTotal)));
    const lineDiscount = money(Math.max(0, basicTotal - lineTaxableBeforeBill));
    const shareBase = itemBaseSubtotal > 0 ? lineTaxableBeforeBill / itemBaseSubtotal : (items.length ? 1 / items.length : 0);
    const billDiscountShare = isLast ? money(billDiscount - allocatedBillDiscount) : money(billDiscount * shareBase);
    const chargeShare = isLast ? money(otherCharges - allocatedCharges) : money(otherCharges * shareBase);
    const taxableTotal = isLast
      ? money(taxableTarget - allocatedTaxable)
      : money(Math.max(0, lineTaxableBeforeBill - billDiscountShare + chargeShare));

    allocatedBillDiscount = money(allocatedBillDiscount + billDiscountShare);
    allocatedCharges = money(allocatedCharges + chargeShare);
    allocatedTaxable = money(allocatedTaxable + taxableTotal);

    const gstRate = Math.max(0, Number(item.gstRateSnapshot || 0));
    const estimatedTax = money(taxableTotal * gstRate / 100);
    return {
      item, index, isLast, qty, rate, basicTotal,
      discount: money(lineDiscount + billDiscountShare),
      charges: chargeShare, taxableTotal, estimatedTax,
    };
  });

  const estimatedTaxTotal = prelim.reduce((sum, row) => sum + row.estimatedTax, 0);

  return prelim.map((row) => {
    const item = row.item;
    const taxShare = row.isLast
      ? money(taxTarget - allocatedTax)
      : money(estimatedTaxTotal > 0 ? taxTarget * (row.estimatedTax / estimatedTaxTotal) : (prelim.length ? taxTarget / prelim.length : 0));
    allocatedTax = money(allocatedTax + taxShare);

    const roundShareBase = taxableTarget > 0 ? row.taxableTotal / taxableTarget : (prelim.length ? 1 / prelim.length : 0);
    const roundOff = row.isLast
      ? money(roundOffTarget - allocatedRoundOff)
      : money(roundOffTarget * roundShareBase);
    allocatedRoundOff = money(allocatedRoundOff + roundOff);

    const beforeGrand = money(row.taxableTotal + taxShare + roundOff);
    const grandTotal = row.isLast ? money(grandTarget - allocatedGrand) : beforeGrand;
    allocatedGrand = money(allocatedGrand + grandTotal);

    const useIgst = invoiceTaxTypeValue === "IGST";
    const igst = useIgst ? taxShare : 0;
    const cgst = useIgst ? 0 : money(taxShare / 2);
    const sgst = useIgst ? 0 : money(taxShare - cgst);

    return {
      id: `${invoice._id}-${row.index}`,
      invoiceId: String(invoice._id),
      date: invoice.date,
      number: invoice.invoiceNo || "",
      warehouse: invoice.warehouseNameSnapshot || invoice.warehouseId || "UNASSIGNED",
      partyName,
      partyKey,
      customerGlobalId: invoice.customerGlobalId || "",
      registrationType: registrationBucket({ partyName, gstin: invoice.gstinSnapshot, customer }),
      taxType: invoiceTaxTypeValue,
      district: customerDistrict(customer),
      salespersonId,
      salespersonName,
      productName: item.nameSnapshot || item.sku || "PRODUCT",
      productKey: clean(item.productId || item.sku || item.nameSnapshot).toUpperCase(),
      productHsn: item.hsnSnapshot || "",
      quantity: row.qty,
      basicRate: money(row.rate),
      cgst, sgst, igst,
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

export async function buildSalesPartyProductReport({
  tenantKey,
  financialYear,
  view,
  period,
  dateFrom,
  dateTo,
  partyType = "",
  salespersonId = "",
  partyId = "",
  productId = "",
  taxType = "",
}) {
  const range = resolveSalesReportRange({ financialYear, view, period, dateFrom, dateTo });
  const models = financialModels(tenantKey, financialYear);
  const dateFilter = { $gte: range.start, $lt: range.end };

  const [invoices, customerSalespersonIds] = await Promise.all([
    models.SalesInvoice.find({
      tenantKey,
      financialYear,
      date: dateFilter,
      status: { $nin: ["DELETED", "CANCELLED"] },
    })
      .select("_id date invoiceNo customerGlobalId customerNameSnapshot gstinSnapshot items subtotal billDiscount otherCharges taxableTotal taxTotal roundOff grandTotal assignedTo warehouseId warehouseNameSnapshot gstType")
      .sort({ date: 1, createdAt: 1 })
      .lean(),
    CustomerLink.distinct("salespersonId", { tenantKey }),
  ]);

  const customerIds = [...new Set(invoices.map((row) => clean(row.customerGlobalId)).filter(Boolean))];
  const customers = customerIds.length
    ? await CustomerLink.find({ tenantKey, globalCustomerId: { $in: customerIds } })
      .select("globalCustomerId localName displayIdentifier registrationType salespersonId ownerDistrict ownerState addresses")
      .lean()
    : [];
  const customerMap = new Map(customers.map((row) => [clean(row.globalCustomerId), row]));

  const salespersonIds = [...new Set([
    ...customerSalespersonIds.map(clean),
    ...invoices.map((row) => clean(row.assignedTo)),
    ...customers.map((row) => clean(row.salespersonId)),
  ].filter(Boolean))];
  const userObjectIds = salespersonIds.filter((id) => /^[0-9a-f]{24}$/i.test(id));
  const users = userObjectIds.length
    ? await User.find({ tenantKey, _id: { $in: userObjectIds } }).select("_id name email").lean()
    : [];
  const userMap = new Map(users.map((row) => [String(row._id), row]));

  let rows = invoices.flatMap((invoice) => allocateInvoiceItemRows(invoice, {
    customer: customerMap.get(clean(invoice.customerGlobalId)) || null,
    userMap,
  }));

  const salespersons = [...new Map(rows
    .filter((row) => row.salespersonId)
    .map((row) => [row.salespersonId, { id: row.salespersonId, name: row.salespersonName || "UNMAPPED SALESPERSON" }]))
    .values()].sort((a, b) => a.name.localeCompare(b.name));

  const parties = [...new Map(rows.map((row) => [row.partyKey, { id: row.partyKey, name: row.partyName || "CUSTOMER" }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const products = productOptionsFromInvoices(invoices);

  const wantedPartyType = upper(partyType);
  const wantedPartyId = clean(partyId);
  const wantedProductId = upper(productId);
  const wantedTaxType = upper(taxType);
  if (["REGULAR", "UNREGISTER"].includes(wantedPartyType)) rows = rows.filter((row) => row.registrationType === wantedPartyType);
  if (clean(salespersonId)) rows = rows.filter((row) => row.salespersonId === clean(salespersonId));
  if (wantedPartyId) rows = rows.filter((row) => row.partyKey === wantedPartyId);
  if (wantedProductId) rows = rows.filter((row) => row.productKey === wantedProductId);
  if (["IGST", "CGST_SGST"].includes(wantedTaxType)) rows = rows.filter((row) => row.taxType === wantedTaxType);
  rows.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.number).localeCompare(String(b.number)) || String(a.productName).localeCompare(String(b.productName)));

  const totals = rows.reduce((acc, row) => {
    acc.quantity += Number(row.quantity || 0);
    acc.cgst += Number(row.cgst || 0);
    acc.sgst += Number(row.sgst || 0);
    acc.igst += Number(row.igst || 0);
    acc.basicTotal += Number(row.basicTotal || 0);
    acc.discount += Number(row.discount || 0);
    acc.charges += Number(row.charges || 0);
    acc.taxableTotal += Number(row.taxableTotal || 0);
    acc.roundOff += Number(row.roundOff || 0);
    acc.grandTotal += Number(row.grandTotal || 0);
    return acc;
  }, { quantity: 0, cgst: 0, sgst: 0, igst: 0, basicTotal: 0, discount: 0, charges: 0, taxableTotal: 0, roundOff: 0, grandTotal: 0 });
  Object.keys(totals).forEach((key) => { totals[key] = money(totals[key]); });
  const crossCheckTotals = salesProductRowCrossCheck(rows);

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
    salespersons,
    totals,
    crossCheckTotals,
    rows,
  };
}
