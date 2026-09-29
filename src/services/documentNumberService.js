import { CompanyProfile } from "../models/index.js";
import { financialModels } from "./accountingService.js";

const clean = (value) => String(value ?? "").trim();
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const NOTE_MARKERS = {
  CREDIT_NOTE: "CN",
  DEBIT_NOTE: "DN",
  DELIVERY_NOTE: "DLN",
};

function paddedSerial(value) {
  return String(Math.max(1, Math.trunc(Number(value) || 1))).padStart(3, "0");
}

function compactFinancialYear(financialYear) {
  return clean(financialYear).replace(/[^0-9A-Za-z]/g, "");
}

async function companySeries(tenantKey, financialYear) {
  const company = await CompanyProfile.findOne({ tenantKey })
    .select("salesInvoicePrefix salesInvoiceSuffix")
    .lean();
  if (!company) throw Object.assign(new Error("Company profile not found for this tenant"), { statusCode: 404 });

  // Document-note numbering always uses the company's invoice prefix. For the
  // suffix, keep the configured value when present; otherwise derive it from
  // the selected FY (2026-27 -> 202627). Strip separators so numbers remain
  // compact, e.g. PECN001202627.
  const prefix = clean(company.salesInvoicePrefix).replace(/\s+/g, "");
  const configuredSuffix = clean(company.salesInvoiceSuffix);
  const suffix = (configuredSuffix || compactFinancialYear(financialYear)).replace(/[^0-9A-Za-z]/g, "");

  if (!prefix) {
    throw Object.assign(
      new Error("Sales Invoice Prefix is blank. Set the prefix in Super Admin Profile before generating CN/DN/DLN numbers."),
      { statusCode: 409 },
    );
  }
  if (!suffix) {
    throw Object.assign(
      new Error("Could not determine the document-number suffix. Set Sales Invoice Suffix or select a valid Financial Year."),
      { statusCode: 409 },
    );
  }
  return { prefix, suffix };
}

function serialFromNumber(number, { prefix, marker = "", suffix }) {
  const pattern = new RegExp(`^${escapeRegex(prefix)}${escapeRegex(marker)}(\\d{3,})${escapeRegex(suffix)}$`, "i");
  const match = clean(number).match(pattern);
  return match ? Number(match[1]) || 0 : 0;
}

function formatNumber({ prefix, marker = "", serial, suffix }) {
  return `${prefix}${marker}${paddedSerial(serial)}${suffix}`;
}

export async function nextDocumentNoteNumber({ tenantKey, financialYear, type }) {
  const marker = NOTE_MARKERS[type];
  if (!marker) throw Object.assign(new Error("Unsupported document type"), { statusCode: 400 });
  const { prefix, suffix } = await companySeries(tenantKey, financialYear);
  const { CreditNote } = financialModels(tenantKey, financialYear);
  const regex = new RegExp(`^${escapeRegex(prefix)}${escapeRegex(marker)}\\d{3,}${escapeRegex(suffix)}$`, "i");
  const existing = await CreditNote.find({ tenantKey, financialYear, creditNoteNo: { $regex: regex } })
    .select("creditNoteNo")
    .lean();
  const maxSerial = existing.reduce(
    (max, row) => Math.max(max, serialFromNumber(row.creditNoteNo, { prefix, marker, suffix })),
    0,
  );
  return formatNumber({ prefix, marker, serial: maxSerial + 1, suffix });
}

export async function allocateDocumentNoteNumber({ tenantKey, financialYear, type }) {
  const marker = NOTE_MARKERS[type];
  if (!marker) throw Object.assign(new Error("Unsupported document type"), { statusCode: 400 });
  const { prefix, suffix } = await companySeries(tenantKey, financialYear);
  const { CreditNote } = financialModels(tenantKey, financialYear);
  const regex = new RegExp(`^${escapeRegex(prefix)}${escapeRegex(marker)}\\d{3,}${escapeRegex(suffix)}$`, "i");
  const existing = await CreditNote.find({ tenantKey, financialYear, creditNoteNo: { $regex: regex } })
    .select("creditNoteNo")
    .lean();
  let serial = existing.reduce(
    (max, row) => Math.max(max, serialFromNumber(row.creditNoteNo, { prefix, marker, suffix })),
    0,
  ) + 1;
  for (let attempt = 0; attempt < 100; attempt += 1, serial += 1) {
    const documentNo = formatNumber({ prefix, marker, serial, suffix });
    const exists = await CreditNote.exists({ tenantKey, financialYear, creditNoteNo: documentNo });
    if (!exists) return documentNo;
  }
  throw Object.assign(new Error("Could not allocate document number"), { statusCode: 409 });
}

export async function nextCashInvoiceNumber({ tenantKey, financialYear, customerGlobalId = "" }) {
  const { prefix, suffix } = await companySeries(tenantKey, financialYear);
  const { SalesInvoice } = financialModels(tenantKey, financialYear);
  const regex = new RegExp(`^${escapeRegex(prefix)}\\d{3,}${escapeRegex(suffix)}$`, "i");
  const filter = { tenantKey, financialYear, invoiceNo: { $regex: regex } };
  if (clean(customerGlobalId)) filter.customerGlobalId = clean(customerGlobalId);
  const existing = await SalesInvoice.find(filter)
    .select("invoiceNo")
    .lean();
  const maxSerial = existing.reduce(
    (max, row) => Math.max(max, serialFromNumber(row.invoiceNo, { prefix, suffix })),
    0,
  );
  return formatNumber({ prefix, serial: maxSerial + 1, suffix });
}

export async function allocateCashInvoiceNumber({ tenantKey, financialYear, customerGlobalId = "" }) {
  const { prefix, suffix } = await companySeries(tenantKey, financialYear);
  const { SalesInvoice } = financialModels(tenantKey, financialYear);
  const regex = new RegExp(`^${escapeRegex(prefix)}\\d{3,}${escapeRegex(suffix)}$`, "i");
  const filter = { tenantKey, financialYear, invoiceNo: { $regex: regex } };
  if (clean(customerGlobalId)) filter.customerGlobalId = clean(customerGlobalId);
  const existing = await SalesInvoice.find(filter)
    .select("invoiceNo")
    .lean();
  let serial = existing.reduce(
    (max, row) => Math.max(max, serialFromNumber(row.invoiceNo, { prefix, suffix })),
    0,
  ) + 1;
  for (let attempt = 0; attempt < 100; attempt += 1, serial += 1) {
    const invoiceNo = formatNumber({ prefix, serial, suffix });
    const exists = await SalesInvoice.exists({ tenantKey, financialYear, invoiceNo });
    if (!exists) return invoiceNo;
  }
  throw Object.assign(new Error("Could not allocate CASH invoice number"), { statusCode: 409 });
}

export function isSystemCashParty(customer) {
  if (!customer) return false;
  const values = [
    customer.systemKey,
    customer.customerCode,
    customer.displayIdentifier,
    customer.localName,
  ].map((value) => String(value || "").trim().toUpperCase());
  return values.includes("CASH");
}
