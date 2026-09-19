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
  if (!env.masterGst.email) missing.push("MASTERGST_EMAIL");
  if (!env.masterGst.clientId) missing.push("MASTERGST_CLIENT_ID");
  if (!env.masterGst.clientSecret) missing.push("MASTERGST_CLIENT_SECRET");
  return {
    configured: missing.length === 0,
    missing,
    baseUrl: env.masterGst.baseUrl
  };
}

export function configured() {
  return configurationStatus().configured;
}

function assertConfigured() {
  const status = configurationStatus();
  if (!status.configured) {
    throw serviceError(
      `MasterGST is not configured. Missing: ${status.missing.join(", ")}. ` +
      "If you use Docker, rebuild/restart after updating backend/.env.",
      503
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

function maybeParseJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return value;
  if (!(text.startsWith("{") || text.startsWith("["))) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function unwrapData(payload) {
  let current = payload;
  for (let i = 0; i < 4; i += 1) {
    if (!current || typeof current !== "object") break;
    if (!("data" in current)) break;
    const next = maybeParseJson(current.data);
    if (next === undefined || next === null || next === "") break;
    current = next;
  }
  return maybeParseJson(current);
}

function providerMessage(payload) {
  if (!payload) return "Unknown MasterGST error";
  if (typeof payload === "string") return payload;
  return (
    payload?.error?.message ||
    payload?.error?.desc ||
    payload?.message ||
    payload?.status_desc ||
    payload?.statusDesc ||
    "MasterGST request failed"
  );
}

async function publicGet(pathname, query) {
  assertConfigured();

  const url = new URL(pathname, env.masterGst.baseUrl);
  url.searchParams.set("email", env.masterGst.email);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        client_id: env.masterGst.clientId,
        client_secret: env.masterGst.clientSecret
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw serviceError("MasterGST request timed out after 15 seconds.", 504);
    }
    throw serviceError(`Unable to connect to MasterGST: ${error.message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }

  if (!response.ok) {
    throw serviceError(
      `MasterGST returned HTTP ${response.status}: ${providerMessage(payload)}`,
      response.status >= 500 ? 502 : 400
    );
  }

  // MasterGST can return HTTP 200 while reporting a provider-level error.
  const hasUsefulData = payload?.data !== undefined && payload?.data !== null && payload?.data !== "";
  if (payload?.error && !hasUsefulData) {
    throw serviceError(providerMessage(payload), 400);
  }

  return payload;
}

function addressToText(addr) {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  const ordered = [
    addr.bno, addr.bnm, addr.flno, addr.st, addr.loc, addr.dst,
    addr.city, addr.stcd, addr.pncd
  ];
  return ordered.filter(Boolean).join(", ");
}

function normalizeTaxpayer(rawPayload, requestedGstin) {
  const data = unwrapData(rawPayload) || {};
  const principalAddress = data?.pradr?.addr || data?.principalAddress || data?.address || null;
  const additionalPlaces = Array.isArray(data?.adadr) ? data.adadr : [];
  const gstin = normalizeGstin(data?.gstin || data?.gstinNo || data?.gstinno || requestedGstin);

  return {
    source: "MASTERGST",
    gstin,
    pan: gstin.length === 15 ? gstin.slice(2, 12) : "",
    stateCode: gstin.slice(0, 2),
    legalName: data?.lgnm || data?.legalName || data?.legal_name || data?.taxpayerName || "",
    tradeName: data?.tradeNam || data?.tradeName || data?.trade_name || "",
    status: data?.sts || data?.status || data?.gstStatus || "",
    taxpayerType: data?.dty || data?.taxpayerType || data?.taxpayer_type || "",
    constitution: data?.ctb || data?.constitution || data?.constitutionOfBusiness || "",
    registrationDate: data?.rgdt || data?.registrationDate || data?.registration_date || null,
    cancellationDate: data?.cxdt || data?.cancellationDate || data?.cancellation_date || null,
    jurisdictionState: data?.stj || data?.stateJurisdiction || "",
    jurisdictionCentre: data?.ctj || data?.centreJurisdiction || "",
    natureOfBusiness: data?.nba || data?.natureOfBusiness || [],
    principalAddress: addressToText(principalAddress),
    principalAddressRaw: principalAddress,
    additionalPlaces,
    eInvoiceStatus: data?.einvoiceStatus || data?.einvStatus || null,
    rawStatusCode: rawPayload?.status_cd ?? rawPayload?.statusCode ?? null,
    rawStatusDescription: rawPayload?.status_desc ?? rawPayload?.statusDesc ?? null
  };
}

export async function searchTaxpayer(gstin) {
  const value = assertValidGstin(gstin);
  const payload = await publicGet("/public/search", { gstin: value });
  const taxpayer = normalizeTaxpayer(payload, value);

  if (!taxpayer.legalName && !taxpayer.tradeName && !taxpayer.status) {
    const msg = providerMessage(payload);
    throw serviceError(`GSTIN lookup returned no taxpayer details${msg ? `: ${msg}` : ""}`, 404);
  }

  return taxpayer;
}

export async function getReturnFilingStatus(gstin) {
  const value = assertValidGstin(gstin);
  const payload = await publicGet("/public/rettrack", { gstin: value });
  const data = unwrapData(payload);
  return {
    source: "MASTERGST",
    gstin: value,
    filingStatus: data?.filingStatus || data?.status || data?.returnStatus || "UNKNOWN",
    data,
    rawStatusCode: payload?.status_cd ?? payload?.statusCode ?? null,
    rawStatusDescription: payload?.status_desc ?? payload?.statusDesc ?? null
  };
}

export async function searchHsn(query) {
  return {
    source: configured() ? "PROVIDER_ADAPTER_REQUIRED" : "NOT_CONFIGURED",
    query,
    items: []
  };
}
