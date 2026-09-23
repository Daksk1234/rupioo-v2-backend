const activeTenantKeys = new Set();

const clean = (value) => String(value ?? "").trim();

export function beginTenantMigrationLock(tenantKey) {
  const key = clean(tenantKey);
  if (key) activeTenantKeys.add(key);
}

export function endTenantMigrationLock(tenantKey) {
  const key = clean(tenantKey);
  if (key) activeTenantKeys.delete(key);
}

export function isTenantMigrationActive(tenantKey) {
  const key = clean(tenantKey);
  return Boolean(key && activeTenantKeys.has(key));
}

export function migrationLockedTenantKeys() {
  return [...activeTenantKeys];
}
