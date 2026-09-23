import { env } from "../config/env.js";

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function serviceError(message, status = 502, details = undefined) {
  const error = new Error(message);
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

export function configurationStatus() {
  const missing = [];
  if (!env.gstLookup.keySecret) missing.push("key_secret");
  return {
    provider: "APPYFLOW",
    configured: missing.length === 0,
    missing,
    baseUrl: env.gstLookup.url,
  };
}

export function configured() {
  return configurationStatus().configured;
}

function assertConfigured() {
  const status = configurationStatus();
  if (!status.configured) {
    throw serviceError(
      `AppyFlow GST lookup is not configured. Missing: ${status.missing.join(", ")}. ` +
        "Add key_secret to backend/.env and restart the backend.",
      503,
    );
  }
}

function normalizeGstin(gstin) {
  return String(gstin || "").trim().toUpperCase();
}

function assertValidGstin(gstin) {
  const value = normalizeGstin(gstin);
  if (!GSTIN_RE.test(value)) {
    throw serviceError("Enter a valid 15-character GSTIN.", 400);
  }
  return value;
}

function providerMessage(payload) {
  if (!payload) return "Unknown AppyFlow error";
  if (typeof payload === "string") return payload;
  return (
    payload?.error?.message ||
    payload?.error ||
    payload?.message ||
    payload?.msg ||
    payload?.statusMessage ||
    "AppyFlow GST request failed"
  );
}

async function appyflowGet(gstin) {
  assertConfigured();
  const value = assertValidGstin(gstin);
  const url = new URL(env.gstLookup.url);
  url.searchParams.set("key_secret", env.gstLookup.keySecret);
  url.searchParams.set("gstNo", value);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw serviceError("AppyFlow GST request timed out after 15 seconds.", 504);
    }
    throw serviceError(`Unable to connect to AppyFlow: ${error.message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }

  if (!response.ok) {
    throw serviceError(
      `AppyFlow returned HTTP ${response.status}: ${providerMessage(payload)}`,
      response.status >= 500 ? 502 : 400,
    );
  }

  if (!payload?.taxpayerInfo) {
    throw serviceError(providerMessage(payload) || "GSTIN details were not found.", 404);
  }

  return payload;
}

function text(value) {
  return String(value ?? "").trim();
}

// The customer form uses this exact readable order:
// Floor, building/door no., street, building name, locality, location, district.
function addressToText(addr = {}) {
  return [
    addr.flno,
    addr.bno,
    addr.st,
    addr.bnm,
    addr.locality,
    addr.loc,
    addr.dst,
  ]
    .map(text)
    .filter(Boolean)
    .join(", ");
}

function firstCoordinate(...values) {
  for (const value of values) {
    if (value === null || value === undefined || String(value).trim() === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function geoFromAddress(addr = {}) {
  return {
    latitude: firstCoordinate(addr.lt, addr.lat, addr.latitude),
    longitude: firstCoordinate(addr.lg, addr.lng, addr.lon, addr.longitude),
  };
}

function normalizeTaxpayer(payload, requestedGstin) {
  const data = payload?.taxpayerInfo || {};
  const principalAddressRaw = data?.pradr?.addr || {};
  const additionalPlaces = Array.isArray(data?.adadr) ? data.adadr : [];
  const additionalAddressRaw = additionalPlaces[0]?.addr || {};
  const gstin = normalizeGstin(data?.gstin || requestedGstin);
  const natureOfBusiness = Array.isArray(data?.nba)
    ? data.nba.map(text).filter(Boolean)
    : data?.nba
      ? [text(data.nba)]
      : [];
  const filingFrequency = payload?.compliance?.filingFrequency ?? null;
  const principalGeo = geoFromAddress(principalAddressRaw);
  const additionalGeo = geoFromAddress(additionalAddressRaw);

  return {
    source: "APPYFLOW",
    gstin,
    pan: text(data?.panNo) || (gstin.length === 15 ? gstin.slice(2, 12) : ""),
    stateCode: gstin.slice(0, 2),

    // GST/legal identity
    legalName: text(data?.lgnm),
    ownerName: text(data?.lgnm),
    tradeName: text(data?.tradeNam),
    businessName: text(data?.tradeNam),
    status: text(data?.sts),
    taxpayerType: text(data?.dty),
    constitution: text(data?.ctb),
    registrationDate: text(data?.rgdt) || null,
    cancellationDate: text(data?.cxdt) || null,
    jurisdictionState: text(data?.stj),
    jurisdictionCentre: text(data?.ctj),
    jurisdictionStateCode: text(data?.stjCd),
    jurisdictionCentreCode: text(data?.ctjCd),
    natureOfBusiness,
    businessType: natureOfBusiness.join(", "),
    eInvoiceStatus: text(data?.einvoiceStatus),
    filingFrequency,

    // Principal/business address
    principalAddress: addressToText(principalAddressRaw),
    principalAddressRaw,
    principalGeo,
    businessLatitude: principalGeo.latitude,
    businessLongitude: principalGeo.longitude,

    // First additional place of business (the UI has one Additional Address box).
    additionalPlaces,
    additionalAddress: addressToText(additionalAddressRaw),
    additionalAddressRaw,
    additionalGeo,
    additionalLatitude: additionalGeo.latitude,
    additionalLongitude: additionalGeo.longitude,

    compliance: payload?.compliance || {},
    filing: Array.isArray(payload?.filing) ? payload.filing : [],
  };
}

export async function searchTaxpayer(gstin) {
  const value = assertValidGstin(gstin);
  const payload = await appyflowGet(value);
  const taxpayer = normalizeTaxpayer(payload, value);

  if (!taxpayer.legalName && !taxpayer.tradeName && !taxpayer.status) {
    throw serviceError("GSTIN lookup returned no taxpayer details.", 404);
  }
  return taxpayer;
}

// Kept for the existing customer GST-verification workflow.
// AppyFlow already returns compliance/filing data in the same GST response.
export async function getReturnFilingStatus(gstin) {
  const value = assertValidGstin(gstin);
  const payload = await appyflowGet(value);
  const frequency = payload?.compliance?.filingFrequency ?? null;
  return {
    source: "APPYFLOW",
    gstin: value,
    filingStatus: frequency || "UNKNOWN",
    filingFrequency: frequency,
    data: Array.isArray(payload?.filing) ? payload.filing : [],
  };
}

export async function searchHsn(query) {
  return {
    source: configured() ? "PROVIDER_ADAPTER_REQUIRED" : "NOT_CONFIGURED",
    query,
    items: [],
  };
}
