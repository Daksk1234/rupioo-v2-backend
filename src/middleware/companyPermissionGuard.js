import { fail } from "../utils/http.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { isTenantMigrationActive } from "../services/tenantMigrationLock.js";
import {
  canPageAction,
  REPORT_PERMISSION_MAP,
  canScreenAction,
  GENERIC_RESOURCE_PAGE_MAP
} from "../config/permissionPageMap.js";

const actionForRequest = (req) => {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || req.originalUrl || "").toLowerCase();
  if (method === "GET" || method === "HEAD") return "view";
  if (path.includes("bulk-upload")) return "create";
  if (path.includes("bulk-edit")) return "edit";
  if (path.includes("bulk-delete")) return "delete";
  if (/(cancel|reverse)/i.test(path)) return "delete";
  if (/(approve|reject|hold|block|status|activity|convert|assign|verify|renew)/i.test(path)) return "edit";
  if (method === "DELETE") return "delete";
  if (method === "PUT" || method === "PATCH") return "edit";
  if (method === "POST") return "create";
  return "view";
};

function mappedPageForApi(req) {
  const path = String(req.path || "");

  if (path.startsWith("/products")) return "/dms/products";
  if (path.startsWith("/customers")) return "/dms/customers";
  if (path.startsWith("/leads")) return "/dms/leads";
  if (path.startsWith("/targets")) return "/dms/targets";
  if (path.startsWith("/employees")) return "/hr/employees";
  if (path.startsWith("/recruitment")) return "/hr/recruitment";
  if (path.startsWith("/company")) return "/dms/company-settings";
  if (path.startsWith("/banks/transactions") || path.includes("/statement-preview") || path.includes("/statement-submit") || path.includes("/statement-imports")) return "/dms/banking";
  if (path.startsWith("/banks")) return "/dms/bank-accounts";

  if (path.startsWith("/catalog/units") || path.startsWith("/catalog/master-units")) return "/dms/units";
  if (path.startsWith("/catalog/grades")) return "/dms/customer-grades";
  if (path.startsWith("/catalog/categories")) return "/dms/product-categories";
  if (path.startsWith("/catalog/price-lists")) return "/dms/price-list";

  if (path.startsWith("/operations/territories")) return "/dms/territories";
  if (path.startsWith("/operations/transporters")) return "/dms/transporters";

  if (path.startsWith("/purchase-ai/grns") || path.startsWith("/purchase-ai/incoming") || path.includes("/qc-complete") || path.includes("/inward") || /^\/purchase-ai\/purchase-orders\/[^/]+\/grn/.test(path)) return "/dms/grn";
  if (path.startsWith("/purchase-ai/complaints")) return "/dms/purchase-returns";
  if (path.startsWith("/purchase-ai/accounts")) return "/dms/purchase-invoices";
  if (path.startsWith("/purchase-ai")) return "/dms/purchase-orders";

  if (path.startsWith("/transactions/sales-invoices")) return "/dms/sales-invoices";
  if (path.startsWith("/transactions/purchase-invoices")) return "/dms/purchase-invoices";
  if (path.startsWith("/transactions/receipts")) return "/dms/receipts";
  if (path.startsWith("/transactions/payments")) return "/dms/payments";
  if (path.startsWith("/transactions/expenses")) return "/dms/expenses";

  if (path.startsWith("/access/users")) return "/dms/users";
  if (path.startsWith("/access/roles")) return "/dms/roles";
  if (path.startsWith("/access/hierarchy")) return "/hr/hierarchy";

  if (path.startsWith("/dashboard")) {
    const app = String(req.query?.app || "dms").toLowerCase();
    if (app === "hr") return "/hr/dashboard";
    if (app === "production") return "/production/dashboard";
    return "/dms/dashboard";
  }

  const generic = path.match(/^\/modules\/([^/]+)\/([^/?]+)/i);
  if (generic) return GENERIC_RESOURCE_PAGE_MAP[`${generic[1]}:${generic[2]}`] || null;

  return null;
}

function reportKeysForName(name) {
  return REPORT_PERMISSION_MAP[String(name || "").trim()] || [];
}

export function companyPermissionGuard(req, res, next) {
  if (req.auth && req.auth.role !== "MASTER" && isTenantMigrationActive(req.auth.originalTenantKey || req.auth.tenantKey)) {
    return fail(res, "Company GST/tenant migration is in progress. Please retry after it completes.", 423, { code: "TENANT_MIGRATION_RUNNING" });
  }
  // Authentication routes and public registration are mounted before this
  // middleware. Supporting lookups/files/OTP are intentionally left to their
  // own route security; this guard controls business-page operations.
  if (!req.auth || req.auth.role === "MASTER") return next();

  const permissions = req.auth.permissions || [];
  const path = String(req.path || "");

  if (path.startsWith("/reports/catalog")) {
    const anyReport = Object.keys(REPORT_PERMISSION_MAP).some((name) =>
      canScreenAction(permissions, reportKeysForName(name), "view")
    );
    return anyReport ? next() : fail(res, "No report permission assigned by your Plan Group", 403);
  }

  if (path.startsWith("/reports/run")) {
    const keys = reportKeysForName(req.query?.name);
    if (!keys.length) return fail(res, "This report is not included in the configured permission catalogue", 403);
    return canScreenAction(permissions, keys, "view")
      ? next()
      : fail(res, `View permission required for ${req.query?.name || "report"}`, 403);
  }

  const pagePath = mappedPageForApi(req);
  if (!pagePath) return next();

  // Profit/margin configuration is sensitive management data, irrespective of page-group permissions.
  if (pagePath === "/dms/price-management" && !isAdminAuth(req.auth)) {
    return fail(res, "Price/profit management is restricted to Admin users", 403);
  }

  const action = actionForRequest(req);

  // The Sales Person mobile app intentionally exposes Delete for the logged-in
  // salesperson's own/visible leads. The leads route performs the ownership
  // scope check again and soft-deletes worked leads to preserve audit history.
  // Keep this exception narrow so it does not grant delete rights on any other
  // DMS page or entity.
  if (
    pagePath === "/dms/leads" &&
    action === "delete" &&
    String(req.method || "").toUpperCase() === "DELETE" &&
    String(req.auth?.role || "").toUpperCase() === "SALES_PERSON"
  ) return next();

  // GET endpoints such as Products/Customers/Catalogues are reused as lookup
  // sources inside invoices and other permitted pages. Navigation View access
  // is enforced in the frontend route guard; here we keep shared lookup GETs
  // usable and enforce View only for generic page APIs/dashboard/reports.
  if (action === "view" && !path.startsWith("/modules/") && !path.startsWith("/dashboard")) return next();
  if (canPageAction(permissions, pagePath, action)) return next();

  return fail(res, `${action.replace("_", " ")} permission required for ${pagePath}`, 403);
}
