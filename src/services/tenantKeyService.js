import { TenantKeyAlias } from "../models/index.js";

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;
const MAX_ALIAS_HOPS = 12;

const clean = (value) => String(value ?? "").trim();

export function clearTenantKeyAliasCache(...keys) {
  if (!keys.length) {
    cache.clear();
    return;
  }
  for (const key of keys) cache.delete(clean(key));
}

export async function resolveTenantKeyAlias(value) {
  const original = clean(value);
  if (!original) return original;

  const cached = cache.get(original);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let current = original;
  const seen = new Set();

  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
    if (!current || seen.has(current)) break;
    seen.add(current);

    const row = await TenantKeyAlias.findOne({ oldTenantKey: current, status: "ACTIVE" })
      .select("newTenantKey")
      .lean();
    const next = clean(row?.newTenantKey);
    if (!next || next === current) break;
    current = next;
  }

  const result = current || original;
  const expiresAt = Date.now() + CACHE_MS;
  for (const key of seen) cache.set(key, { value: result, expiresAt });
  cache.set(original, { value: result, expiresAt });
  return result;
}

export async function isTenantKeyReserved(value, { companyProfileId = "" } = {}) {
  const key = clean(value);
  if (!key) return false;
  const filter = {
    status: "ACTIVE",
    $or: [{ oldTenantKey: key }, { newTenantKey: key }],
  };
  if (companyProfileId) filter.companyProfileId = { $ne: clean(companyProfileId) };
  return Boolean(await TenantKeyAlias.exists(filter));
}

export async function recordTenantKeyAlias({ oldTenantKey, newTenantKey, companyProfileId, oldGstin, newGstin, changedBy }) {
  const oldKey = clean(oldTenantKey);
  const newKey = clean(newTenantKey);
  if (!oldKey || !newKey || oldKey === newKey) return null;

  // Flatten older aliases (A -> B, then B -> C becomes A -> C and B -> C)
  // so legacy sessions and signed links continue to resolve in one hop.
  await TenantKeyAlias.updateMany(
    { newTenantKey: oldKey, status: "ACTIVE" },
    { $set: { newTenantKey: newKey, newGstin: clean(newGstin), changedBy: clean(changedBy), changedAt: new Date() } },
  );

  const row = await TenantKeyAlias.findOneAndUpdate(
    { oldTenantKey: oldKey },
    {
      $set: {
        newTenantKey: newKey,
        companyProfileId: clean(companyProfileId),
        oldGstin: clean(oldGstin) || oldKey,
        newGstin: clean(newGstin) || newKey,
        changedBy: clean(changedBy),
        changedAt: new Date(),
        status: "ACTIVE",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  clearTenantKeyAliasCache(oldKey, newKey);
  cache.set(oldKey, { value: newKey, expiresAt: Date.now() + CACHE_MS });
  return row;
}
