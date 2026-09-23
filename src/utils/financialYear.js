import { CompanyProfile } from "../models/index.js";

const FY_RE = /^(\d{4})-(\d{2}|\d{4})$/;

export function normalizeFinancialYear(value) {
  const raw = String(value ?? "").trim().replace(/^FY\s*/i, "");
  const match = FY_RE.exec(raw);
  if (!match) return "";
  return `${match[1]}-${match[2].length === 4 ? match[2].slice(-2) : match[2]}`;
}

export function currentFinancialYear(date = new Date()) {
  const year = date.getFullYear();
  const start = date.getMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function financialYearFromDate(value) {
  if (!value) return "";
  let year;
  let month;
  const text = String(value).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
  } else {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    year = date.getFullYear();
    month = date.getMonth() + 1;
  }
  if (!Number.isFinite(year) || month < 1 || month > 12) return "";
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function transactionDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error("Invalid transaction date"), { statusCode: 400 });
  return date;
}

export function financialYearBounds(value) {
  const financialYear = normalizeFinancialYear(value);
  if (!financialYear) return null;
  const startYear = Number(financialYear.slice(0, 4));
  return {
    start: new Date(startYear, 3, 1, 0, 0, 0, 0),
    end: new Date(startYear + 1, 2, 31, 23, 59, 59, 999),
  };
}

export async function configuredFinancialYear(tenantKey) {
  if (!tenantKey) return currentFinancialYear();
  const profile = await CompanyProfile.findOne({ tenantKey }).select("financialYear financialYears").lean();
  return normalizeFinancialYear(profile?.financialYear)
    || (Array.isArray(profile?.financialYears) ? profile.financialYears.map(normalizeFinancialYear).find(Boolean) : "")
    || currentFinancialYear();
}

export async function resolveFinancialYear({ tenantKey, date, requested } = {}) {
  const fromDate = financialYearFromDate(date);
  if (fromDate) return fromDate;
  const supplied = normalizeFinancialYear(requested);
  if (supplied) return supplied;
  return configuredFinancialYear(tenantKey);
}
