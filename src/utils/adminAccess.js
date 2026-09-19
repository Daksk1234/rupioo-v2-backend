const ADMIN_ROLES = new Set([
  "MASTER",
  "SUPERADMIN",
  "COMPANY_ADMIN",
  "DMS_ADMIN",
  "ADMIN",
  "ADMINISTRATOR",
]);

export const isAdminAuth = (auth = {}) =>
  ADMIN_ROLES.has(String(auth?.role || auth?.roleCode || "").trim().toUpperCase());

export default isAdminAuth;
