import { CompanyProfile } from "../models/index.js";

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;
const clean = (value) => String(value ?? "").trim();

function put(logicalTenantKey, physicalTenantKey) {
  const logical = clean(logicalTenantKey);
  const physical = clean(physicalTenantKey) || logical;
  if (!logical) return physical;
  cache.set(logical, { value: physical, expiresAt: Date.now() + CACHE_MS });
  return physical;
}

export function setFinancialStorageTenantKey(logicalTenantKey, physicalTenantKey) {
  return put(logicalTenantKey, physicalTenantKey);
}

export function clearFinancialStorageTenantKey(...keys) {
  if (!keys.length) return cache.clear();
  for (const key of keys) cache.delete(clean(key));
}

export function resolveFinancialStorageTenantKeySync(logicalTenantKey) {
  const logical = clean(logicalTenantKey);
  if (!logical) return logical;
  const row = cache.get(logical);
  if (row && row.expiresAt > Date.now()) return row.value;
  return logical;
}

export async function ensureFinancialStorageTenantKey(logicalTenantKey) {
  const logical = clean(logicalTenantKey);
  if (!logical) return logical;
  const existing = cache.get(logical);
  if (existing && existing.expiresAt > Date.now()) return existing.value;

  const profile = await CompanyProfile.findOne({
    $or: [{ tenantKey: logical }, { previousTenantKeys: logical }],
    status: { $ne: "DELETED" },
  }).select("tenantKey financialStorageTenantKey previousTenantKeys").lean();

  if (!profile) return put(logical, logical);
  const current = clean(profile.tenantKey) || logical;
  const physical = clean(profile.financialStorageTenantKey) || current;
  put(current, physical);
  for (const previous of Array.isArray(profile.previousTenantKeys) ? profile.previousTenantKeys : []) {
    put(previous, physical);
  }
  put(logical, physical);
  return physical;
}

export async function warmFinancialStorageTenantKeyCache() {
  const profiles = await CompanyProfile.find({ status: { $ne: "DELETED" } })
    .select("tenantKey financialStorageTenantKey previousTenantKeys")
    .lean();
  for (const profile of profiles) {
    const logical = clean(profile.tenantKey);
    if (!logical) continue;
    const physical = clean(profile.financialStorageTenantKey) || logical;
    put(logical, physical);
    for (const previous of Array.isArray(profile.previousTenantKeys) ? profile.previousTenantKeys : []) {
      put(previous, physical);
    }
  }
  return profiles.length;
}
