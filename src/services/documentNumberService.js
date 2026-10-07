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

export function suffixForFinancialYear(configured, financialYear) {
  const suffix = clean(configured);
  const year = Number(clean(financialYear).slice(0, 4));
  if (!suffix || !Number.isInteger(year) || year < 2000 || year > 2200) return suffix;
  const next = String(year + 1).slice(-2);
  const y = String(year);
  const short = y.slice(-2);
  // A FY-shaped configured suffix is a pattern; substitute the selected date's
  // FY rather than putting 2026-27's suffix on a 2025-26 invoice.
  if (/^\d{6}$/.test(suffix) && Number(suffix.slice(0, 4)) + 1 === 2000 + Number(suffix.slice(4))) return `${y}${next}`;
  if (/^\d{4}$/.test(suffix) && (Number(suffix.slice(0, 2)) + 1) % 100 === Number(suffix.slice(2))) return `${short}${next}`;
  if (/^\d{2}-\d{2}$/.test(suffix) && (Number(suffix.slice(0, 2)) + 1) % 100 === Number(suffix.slice(-2))) return `${short}-${next}`;
  if (/^\d{4}-\d{2}$/.test(suffix) && (Number(suffix.slice(0, 4)) + 1) % 100 === Number(suffix.slice(-2))) return `${y}-${next}`;
  return suffix; // Non-FY custom suffixes remain exactly as configured.
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
  const suffix = suffixForFinancialYear(configuredSuffix || compactFinancialYear(financialYear), financialYear).replace(/[^0-9A-Za-z]/g, "");

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

export function isRegisteredParty(party = {}) {
  // Explicit unregistered/CASH classification must override stale or inherited
  // GST fields in imported CustomerLink records. A system CASH customer can
  // never consume a registered Sales Invoice number.
  if (isSystemCashParty(party)) return false;
  const registration = clean(party.registrationType || party.gstRegistrationType || "").toUpperCase();
  if (/^(UNREGISTERED|UNREGISTER|UNREG|CASH|URD)$/.test(registration)) return false;
  // Search every possible GSTIN location, not only the display identifier.
  return [party.gstin, party.gstNumber, party.gstNo, party.displayIdentifier,
    ...(party.global?.gstins || []).map((entry) => entry?.value)]
    .some((value) => /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(clean(value).toUpperCase()));
}

function noteMarker(type, registered = true) {
  const marker = NOTE_MARKERS[type];
  // Keep the existing DLN numbering. Only CN and DN have registered/C series.
  return marker && !registered && type !== "DELIVERY_NOTE" ? `${marker}C` : marker;
}

function serialFromNumber(number, { prefix, marker = "", suffix }) {
  const pattern = new RegExp(`^${escapeRegex(prefix)}${escapeRegex(marker)}(\\d{3,})${escapeRegex(suffix)}$`, "i");
  const match = clean(number).match(pattern);
  return match ? Number(match[1]) || 0 : 0;
}

function formatNumber({ prefix, marker = "", serial, suffix }) {
  return `${prefix}${marker}${paddedSerial(serial)}${suffix}`;
}

export async function nextDocumentNoteNumber({ tenantKey, financialYear, type, registered = true }) {
  const marker = noteMarker(type, registered);
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

export async function allocateDocumentNoteNumber({ tenantKey, financialYear, type, registered = true }) {
  const marker = noteMarker(type, registered);
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

function cashSerialInfo(number, { prefix, suffix }) {
  const pattern = new RegExp(`^${escapeRegex(prefix)}C(\\d+)${escapeRegex(suffix)}$`, "i");
  const match = clean(number).match(pattern);
  if (!match) return null;
  return {
    serial: Number(match[1]) || 0,
    serialText: match[1],
  };
}

function cashSerialText(serial, width = 3) {
  const value = String(Math.max(1, Math.trunc(Number(serial) || 1)));
  return Number(width || 0) > 0 ? value.padStart(Number(width), "0") : value;
}

function cashNumber({ prefix, serialText, suffix }) {
  return `${prefix}C${serialText}${suffix}`;
}

function latestCashPadding(existing = []) {
  const latest = [...existing]
    .filter((row) => row?.info)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0];
  if (!latest?.info?.serialText) return 3; // preserve the previous CASH default for a brand-new series
  return /^0\d+$/.test(latest.info.serialText) ? latest.info.serialText.length : 0;
}

async function cashInvoiceSeriesState({ tenantKey, financialYear, customerGlobalId = "" }) {
  const { prefix, suffix } = await companySeries(tenantKey, financialYear);
  const { SalesInvoice } = financialModels(tenantKey, financialYear);
  // Match any numeric width so a user's 1 / 01 / 001 choice continues naturally.
  const regex = new RegExp(`^${escapeRegex(prefix)}C\\d+${escapeRegex(suffix)}$`, "i");
  // A genuinely deleted test invoice does not consume the active C series;
  // CANCELLED/issued documents retain their number permanently.
  const filter = { tenantKey, financialYear, status: { $ne: "DELETED" }, invoiceNo: { $regex: regex } };
  // All unregistered parties share ONE FY-scoped C series, not a separate series per customer.
  void customerGlobalId;
  const rows = await SalesInvoice.find(filter)
    .select("invoiceNo createdAt")
    .lean();
  const existing = rows.map((row) => ({
    ...row,
    info: cashSerialInfo(row.invoiceNo, { prefix, suffix }),
  })).filter((row) => row.info);
  const maxSerial = existing.reduce((max, row) => Math.max(max, row.info.serial), 0);
  return { prefix, suffix, SalesInvoice, filter, existing, maxSerial, paddingWidth: latestCashPadding(existing) };
}

export async function nextCashInvoiceNumber({ tenantKey, financialYear, customerGlobalId = "" }) {
  const state = await cashInvoiceSeriesState({ tenantKey, financialYear, customerGlobalId });
  const serial = state.maxSerial + 1;
  return cashNumber({
    prefix: state.prefix,
    serialText: cashSerialText(serial, state.paddingWidth),
    suffix: state.suffix,
  });
}

export async function allocateCashInvoiceNumber({ tenantKey, financialYear, customerGlobalId = "" }) {
  const state = await cashInvoiceSeriesState({ tenantKey, financialYear, customerGlobalId });
  let serial = state.maxSerial + 1;
  for (let attempt = 0; attempt < 100; attempt += 1, serial += 1) {
    const invoiceNo = cashNumber({
      prefix: state.prefix,
      serialText: cashSerialText(serial, state.paddingWidth),
      suffix: state.suffix,
    });
    const exists = await state.SalesInvoice.exists({ tenantKey, financialYear, invoiceNo, status: { $ne: "DELETED" } });
    if (!exists) return invoiceNo;
  }
  throw Object.assign(new Error("Could not allocate unregistered invoice number"), { statusCode: 409 });
}

export async function cashInvoiceNumberFromSerial({ tenantKey, financialYear, serialText }) {
  const raw = clean(serialText);
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw Object.assign(new Error("Invoice Number must contain digits only and be 1 or more"), { statusCode: 400 });
  }
  const { prefix, suffix } = await companySeries(tenantKey, financialYear);
  return cashNumber({ prefix, serialText: raw, suffix });
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
