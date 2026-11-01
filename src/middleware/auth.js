import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { fail } from "../utils/http.js";
import { decodePermissions } from "../utils/authToken.js";
import { GenericRecord } from "../models/index.js";
import { resolveTenantKeyAlias } from "../services/tenantKeyService.js";
import { isTenantMigrationActive } from "../services/tenantMigrationLock.js";
import { ensureFinancialStorageTenantKey } from "../services/financialStorageTenantService.js";

async function authFromClaims(claims) {
  const originalTenantKey = String(claims?.tenantKey || "").trim();
  let tenantKey = originalTenantKey;
  if (originalTenantKey && String(claims?.role || "").toUpperCase() !== "MASTER") {
    try {
      tenantKey = await resolveTenantKeyAlias(originalTenantKey);
    } catch (error) {
      // Alias lookup must never make an otherwise-valid login unusable.
      // A fresh login will carry the new tenantKey after migration.
      console.warn("Tenant alias lookup warning:", error?.message || error);
    }
  }
  if (tenantKey && String(claims?.role || "").toUpperCase() !== "MASTER") {
    try {
      await ensureFinancialStorageTenantKey(tenantKey);
    } catch (error) {
      console.warn("Financial storage mapping warning:", error?.message || error);
    }
  }
  return {
    ...claims,
    tenantKey,
    originalTenantKey,
    permissions: decodePermissions(claims),
  };
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return fail(res, "Authentication required", 401);

  try {
    const claims = jwt.verify(token, env.jwtSecret);
    req.auth = await authFromClaims(claims);
    if (req.auth.role !== "MASTER" && isTenantMigrationActive(req.auth.originalTenantKey || req.auth.tenantKey)) {
      return fail(res, "Company GST/tenant migration is in progress. Please retry after it completes.", 423, { code: "TENANT_MIGRATION_RUNNING" });
    }

    if (String(req.auth.role || "").toUpperCase() === "WAREHOUSE") {
      if (!String(req.originalUrl || "").startsWith("/api/warehouse-app/")) return fail(res,"Warehouse session is restricted to the Warehouse App",403);
      const assignedWarehouse = await GenericRecord.exists({_id:req.auth.warehouseId,tenantKey:req.auth.tenantKey,app:"dms",resource:"warehouses",status:"ACTIVE"});
      if (!assignedWarehouse) return fail(res,"Warehouse login revoked or deactivated",401);
    }
    if (String(req.auth.role || "").toUpperCase()==="DELIVERY_BOY" && !String(req.originalUrl || "").startsWith("/api/sales-app/order-flow/phase2/")) {
      return fail(res,"Delivery Boy account is restricted to its dedicated delivery endpoints",403);
    }
    // Collection Executive accounts are mobile receipt/collection-only principals. Even
    // if a MASTER role template accidentally grants broad DMS permissions,
    // a collection executive JWT cannot call unrelated REST resources.
    if (["COLLECTION_EXECUTIVE", "COLLECTOR"].includes(String(req.auth.role || "").trim().toUpperCase()) && !String(req.originalUrl || "").startsWith("/api/sales-app/")) {
      return fail(res, "Collection Executive account is restricted to the Collection Executive app", 403);
    }

    // Company identity comes from the signed JWT. The optional browser header
    // is only a consistency check and can never override the token tenant.
    const headerTenantId = String(req.headers["x-tenant-id"] || "").trim();
    if (
      req.auth.role !== "MASTER" &&
      headerTenantId &&
      req.auth.tenantId &&
      headerTenantId !== String(req.auth.tenantId)
    ) {
      return fail(res, "Tenant session mismatch", 403);
    }

    return next();
  } catch {
    return fail(res, "Invalid or expired session", 401);
  }
}

export async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token) {
    try {
      const claims = jwt.verify(token, env.jwtSecret);
      req.auth = await authFromClaims(claims);
    } catch {
      // Public/optional-auth route continues without a session.
    }
  }
  next();
}
