import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { fail } from "../utils/http.js";
import { decodePermissions } from "../utils/authToken.js";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return fail(res, "Authentication required", 401);

  try {
    const claims = jwt.verify(token, env.jwtSecret);
    req.auth = {
      ...claims,
      permissions: decodePermissions(claims),
    };

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

export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token) {
    try {
      const claims = jwt.verify(token, env.jwtSecret);
      req.auth = {
        ...claims,
        permissions: decodePermissions(claims),
      };
    } catch {
      // Public/optional-auth route continues without a session.
    }
  }
  next();
}
