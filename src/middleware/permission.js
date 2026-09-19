import { fail } from "../utils/http.js";
import { isMasterOnlyPermission } from "../config/securityPolicy.js";

export const requirePermission = (permission) => (req, res, next) => {
  if (req.auth?.role === "MASTER") return next();
  if (isMasterOnlyPermission(permission)) return fail(res, "MASTER access required", 403);
  const permissions = new Set(req.auth?.permissions || []);
  if (permissions.has(permission)) return next();
  // `*` is accepted only for non-MASTER capabilities.  MASTER-only powers are
  // blocked above even when a company Superadmin has broad company access.
  if (permissions.has("*")) return next();
  return fail(res, `Missing permission: ${permission}`, 403);
};

export const requireAnyPermission = (...required) => (req,res,next) => {
  if (req.auth?.role === "MASTER") return next();
  const permissions = new Set(req.auth?.permissions || []);
  const allowed = required.some((permission) => !isMasterOnlyPermission(permission) && (permissions.has(permission) || permissions.has("*")));
  if (allowed) return next();
  return fail(res, `Missing required permission`, 403);
};

export const requireApp = (appKey) => (req, res, next) => {
  const apps = new Set(req.auth?.apps || []);
  if (req.auth?.role === "MASTER" || apps.has(appKey)) return next();
  return fail(res, `${appKey} is not enabled for this plan`, 403);
};

export const requireMaster = (req, res, next) => {
  if (req.auth?.role === "MASTER") return next();
  return fail(res, "MASTER access required", 403);
};

export const requireWorkflowTransition = (entityType, getTransition) => (req,res,next) => {
  if (req.auth?.role === "MASTER" || req.auth?.role === "SUPERADMIN") return next();
  const transition = typeof getTransition === "function" ? getTransition(req) : String(getTransition || "");
  const allowed = req.auth?.workflowTransitions?.[entityType] || [];
  if (allowed.includes(transition)) return next();
  return fail(res, `Workflow transition not allowed: ${transition}`, 403);
};

export const maskRestrictedFields = (entityType) => (req,res,next) => {
  req.securityFieldAccess = req.auth?.fieldAccess?.[entityType] || null;
  next();
};
