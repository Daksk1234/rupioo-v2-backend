export const MASTER_ONLY_PERMISSION_PREFIXES = [
  "master.",
  "platform.superadmin.",
  "platform.branch.",
  "platform.plan.",
  "platform.role_template.",
  "platform.accounting_framework.",
];

export const MASTER_ONLY_CAPABILITIES = new Set([
  "platform.superadmin.create",
  "platform.superadmin.update",
  "platform.superadmin.delete",
  "platform.branch.create",
  "platform.branch.update",
  "platform.branch.delete",
  "platform.plan.create",
  "platform.plan.update",
  "platform.plan.delete",
  "platform.role_template.create",
  "platform.role_template.update",
  "platform.role_template.delete",
]);

export const isMasterOnlyPermission = (permission) => {
  const value = String(permission || "");
  if (MASTER_ONLY_CAPABILITIES.has(value)) return true;
  return MASTER_ONLY_PERMISSION_PREFIXES.some((prefix) => value.startsWith(prefix));
};

export const DATA_SCOPE_ORDER = [
  "SELF",
  "ASSIGNED",
  "TEAM",
  "TERRITORY",
  "WAREHOUSE",
  "BRANCH",
  "DEPARTMENT",
  "COMPANY",
  "ALL",
];

export const normalizeScope = (value, fallback="SELF") => {
  const scope = String(value || fallback).toUpperCase();
  return DATA_SCOPE_ORDER.includes(scope) ? scope : fallback;
};
