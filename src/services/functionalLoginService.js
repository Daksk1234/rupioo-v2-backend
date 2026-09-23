import crypto from "crypto";
import bcrypt from "bcryptjs";
import {
  CompanyProfile,
  Department,
  GenericRecord,
  Role,
  User,
} from "../models/index.js";
import { allPermissionCodes } from "../config/permissionCatalogue.js";

const MASTER_DEPARTMENT_TENANT = "__MASTER_DEPARTMENTS__";

const clean = (value) => String(value ?? "").trim();
const uniq = (values = []) => Array.from(new Set((values || []).filter(Boolean)));
const slug = (value) => clean(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 48) || "login";

const internalEmail = () => `functional-${crypto.randomUUID()}@system.rupio.invalid`;
export const isInternalLoginEmail = (value) => /@(system\.rupio|no-login\.rupio)\.invalid$/i.test(clean(value));
const randomSecret = () => crypto.randomBytes(32).toString("hex");

const warehouseFallbackPermissions = () => {
  const prefixes = [
    "dms.warehouse.",
    "dms.stock.",
    "dms.stock_reports.",
    "dms.sales.dispatch_details.",
    "dms.purchase.purchase_order.",
    "dms.purchase.purchase_pending.",
    "dms.purchase.purchase_complete.",
    "dms.purchase.purchase_invoice.",
    "dms.purchase.purchase_damage.",
    "dms.purchase.purchase_return.",
  ];
  return allPermissionCodes().filter((code) => prefixes.some((prefix) => code.startsWith(prefix)));
};

async function uniqueLoginId(baseValue, excludeId = "") {
  const base = slug(baseValue).replace(/-/g, ".").slice(0, 72) || "login";
  let candidate = base;
  let n = 2;
  while (await User.exists({
    loginId: candidate,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })) {
    candidate = `${base}.${n++}`;
  }
  return candidate;
}

const generatedLoginId = ({ tenantKey, scopeType, scopeName, scopeId }) => {
  const tenant = slug(tenantKey).slice(0, 24);
  const kind = scopeType === "WAREHOUSE" ? "wh" : "role";
  const suffix = slug(scopeName || scopeId).slice(0, 30);
  return `${tenant}.${kind}.${suffix}`;
};

async function uniqueGeneratedLoginId(args, excludeId = "") {
  return uniqueLoginId(generatedLoginId(args), excludeId);
}

/**
 * Final authentication policy:
 * - MASTER and SUPERADMIN authenticate with their own registered EMAIL + password.
 * - Operational Role/Warehouse accounts authenticate with functional Login ID + password.
 * - PERSON/LEDGER records never authenticate.
 * GSTIN, PAN, Aadhaar, mobile, employee ID and person names are never login identities.
 *
 * Function names are kept for backward compatibility with older route imports.
 */
export async function ensureMasterLoginIds() {
  const masters = await User.find({ role: "MASTER", status: "ACTIVE" }).sort({ createdAt: 1 });
  for (const user of masters) {
    user.loginKind = "MASTER";
    user.managedLogin = false;
    user.loginEnabled = true;
    user.passwordConfigured = true;
    user.loginId = undefined;
    await user.save();
  }
  return masters;
}

export async function ensureSuperadminLoginId(tenantKey, actorId = "SYSTEM") {
  const key = clean(tenantKey);
  if (!key) return null;
  const user = await User.findOne({ tenantKey: key, role: "SUPERADMIN", status: "ACTIVE" }).sort({ createdAt: 1 });
  if (!user) return null;
  user.loginKind = "SUPERADMIN";
  user.managedLogin = false;
  user.loginEnabled = true;
  user.passwordConfigured = true;
  user.loginId = undefined;
  void actorId;
  await user.save();
  return user;
}

async function tenantContext(tenantKey) {
  const [profile, superadmin] = await Promise.all([
    CompanyProfile.findOne({ tenantKey }).select("_id").lean(),
    User.findOne({ tenantKey, role: "SUPERADMIN", status: "ACTIVE" })
      .select("_id tenantId planCode")
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  return {
    tenantId: clean(superadmin?.tenantId || profile?._id),
    planCode: clean(superadmin?.planCode) || "COMPLETE",
  };
}

async function ensureFunctionalUser({
  tenantKey,
  tenantId,
  planCode,
  scopeType,
  scopeId,
  scopeName,
  role = null,
  department = null,
  warehouseId = "",
  permissions = [],
  apps = ["dms"],
  actorId = "SYSTEM",
}) {
  let user = await User.findOne({
    tenantKey,
    loginKind: "FUNCTIONAL",
    functionalScopeType: scopeType,
    functionalScopeId: clean(scopeId),
  });

  let created = false;
  if (!user) {
    created = true;
    const loginId = await uniqueGeneratedLoginId({ tenantKey, scopeType, scopeName, scopeId });
    user = new User({
      tenantKey,
      tenantId,
      name: scopeType === "WAREHOUSE" ? `Warehouse • ${scopeName}` : `${scopeName} Login`,
      email: internalEmail(),
      passwordHash: await bcrypt.hash(randomSecret(), 12),
      loginId,
      loginKind: "FUNCTIONAL",
      functionalScopeType: scopeType,
      functionalScopeId: clean(scopeId),
      functionalScopeName: clean(scopeName),
      managedLogin: true,
      passwordConfigured: false,
      loginEnabled: false,
      status: "ACTIVE",
      role: role?.code || (scopeType === "WAREHOUSE" ? "FUNCTIONAL_WAREHOUSE" : "FUNCTIONAL"),
      roleId: role?._id || undefined,
      departmentId: department?._id || role?.departmentId || undefined,
      department: department?.name || "",
      warehouseId: clean(warehouseId),
      apps: uniq(apps.length ? apps : ["dms"]),
      permissions: uniq(permissions),
      planCode,
      dataScope: scopeType === "WAREHOUSE" ? "WAREHOUSE" : (role?.dataScope || "DEPARTMENT"),
      approvalLimits: role?.approvalLimits || {},
      accountType: role?.name || scopeName,
      designation: "SYSTEM LOGIN",
      userOverrides: {},
    });
  } else {
    user.tenantId = tenantId || user.tenantId;
    user.planCode = planCode || user.planCode || "COMPLETE";
    user.name = scopeType === "WAREHOUSE" ? `Warehouse • ${scopeName}` : `${scopeName} Login`;
    user.functionalScopeName = clean(scopeName);
    user.managedLogin = true;
    user.status = "ACTIVE";
    user.role = role?.code || (scopeType === "WAREHOUSE" ? "FUNCTIONAL_WAREHOUSE" : user.role || "FUNCTIONAL");
    user.roleId = role?._id || undefined;
    user.departmentId = department?._id || role?.departmentId || undefined;
    user.department = department?.name || "";
    user.warehouseId = clean(warehouseId);
    user.apps = uniq(apps.length ? apps : ["dms"]);
    user.permissions = uniq(permissions);
    user.dataScope = scopeType === "WAREHOUSE" ? "WAREHOUSE" : (role?.dataScope || user.dataScope || "DEPARTMENT");
    user.approvalLimits = role?.approvalLimits || {};
    user.accountType = role?.name || scopeName;
  }

  if (!clean(user.loginId)) {
    user.loginId = await uniqueGeneratedLoginId({ tenantKey, scopeType, scopeName, scopeId }, String(user._id || ""));
  }

  await user.save();
  return { user, created, actorId };
}

export async function syncFunctionalLogins(tenantKey, actorId = "SYSTEM") {
  const key = clean(tenantKey);
  if (!key) throw new Error("TENANT_REQUIRED");

  await ensureSuperadminLoginId(key, actorId);
  const { tenantId, planCode } = await tenantContext(key);

  // Every PERSON/LEDGER record is data only. Old personal passwords/emails are
  // not accepted by auth even if they remain in historical documents.
  const personDisable = await User.updateMany(
    {
      tenantKey: key,
      role: { $nin: ["MASTER", "SUPERADMIN", "LEDGER_ACCOUNT"] },
      managedLogin: { $ne: true },
      $or: [
        { loginEnabled: { $ne: false } },
        { loginKind: { $ne: "PERSON" } },
      ],
    },
    { $set: { loginEnabled: false, loginKind: "PERSON", managedLogin: false, passwordConfigured: false }, $unset: { loginId: 1 } },
  );
  await User.updateMany(
    { tenantKey: key, role: "LEDGER_ACCOUNT" },
    { $set: { loginEnabled: false, loginKind: "LEDGER", managedLogin: false, passwordConfigured: false }, $unset: { loginId: 1 } },
  );

  const roles = await Role.find({
    tenantKey: key,
    status: "ACTIVE",
    code: { $nin: ["CUSTOMER"] },
  }).sort({ hierarchyOrder: 1, name: 1 }).lean();
  const departmentIds = uniq(roles.map((r) => clean(r.departmentId)));
  const departments = departmentIds.length
    ? await Department.find({
        _id: { $in: departmentIds },
        tenantKey: { $in: [MASTER_DEPARTMENT_TENANT, key] },
        status: "ACTIVE",
      }).lean()
    : [];
  const departmentById = new Map(departments.map((d) => [String(d._id), d]));

  const roleResults = [];
  for (const role of roles) {
    const department = departmentById.get(clean(role.departmentId)) || null;
    roleResults.push(await ensureFunctionalUser({
      tenantKey: key,
      tenantId,
      planCode,
      scopeType: "ROLE",
      scopeId: String(role._id),
      scopeName: role.name || role.code,
      role,
      department,
      permissions: role.permissions || [],
      apps: role.apps || ["dms"],
      actorId,
    }));
  }

  const warehouseRole = roles.find((r) => /warehouse|store|stores/i.test(`${r.code} ${r.name}`))
    || roles.find((r) => /dispatch/i.test(`${r.code} ${r.name}`))
    || null;
  const warehouseDepartment = warehouseRole
    ? departmentById.get(clean(warehouseRole.departmentId)) || null
    : null;
  const warehousePermissions = warehouseRole?.permissions?.length
    ? warehouseRole.permissions
    : warehouseFallbackPermissions();

  const warehouses = await GenericRecord.find({
    tenantKey: key,
    app: "dms",
    resource: "warehouses",
    status: "ACTIVE",
  }).select("_id title reference").sort({ title: 1 }).lean();

  const warehouseResults = [];
  for (const warehouse of warehouses) {
    warehouseResults.push(await ensureFunctionalUser({
      tenantKey: key,
      tenantId,
      planCode,
      scopeType: "WAREHOUSE",
      scopeId: String(warehouse._id),
      scopeName: warehouse.title || warehouse.reference || "Warehouse",
      role: warehouseRole,
      department: warehouseDepartment,
      warehouseId: String(warehouse._id),
      permissions: warehousePermissions,
      apps: warehouseRole?.apps || ["dms"],
      actorId,
    }));
  }

  const validScopeKeys = new Set([
    ...roles.map((r) => `ROLE:${r._id}`),
    ...warehouses.map((w) => `WAREHOUSE:${w._id}`),
  ]);
  const existing = await User.find({ tenantKey: key, loginKind: "FUNCTIONAL", managedLogin: true })
    .select("_id functionalScopeType functionalScopeId status loginEnabled")
    .lean();
  const staleIds = existing
    .filter((u) => !validScopeKeys.has(`${u.functionalScopeType}:${u.functionalScopeId}`))
    .map((u) => u._id);
  if (staleIds.length) {
    await User.updateMany({ _id: { $in: staleIds } }, { $set: { status: "INACTIVE", loginEnabled: false } });
  }

  return {
    created: roleResults.filter((x) => x.created).length + warehouseResults.filter((x) => x.created).length,
    roleLogins: roleResults.length,
    warehouseLogins: warehouseResults.length,
    staleDisabled: staleIds.length,
    personLoginsDisabled: Number(personDisable.modifiedCount || 0),
  };
}

export function publicFunctionalLogin(user = {}) {
  const doc = typeof user.toObject === "function" ? user.toObject() : { ...user };
  delete doc.passwordHash;
  delete doc.aadhaarHash;
  const kind = clean(doc.loginKind).toUpperCase();
  const isSuperadmin = kind === "SUPERADMIN" || clean(doc.role).toUpperCase() === "SUPERADMIN";
  return {
    id: String(doc._id || ""),
    _id: String(doc._id || ""),
    name: doc.name || "",
    loginId: doc.loginId || "",
    recoveryEmail: isInternalLoginEmail(doc.email) ? "" : (doc.email || ""),
    loginEmail: isInternalLoginEmail(doc.email) ? "" : (doc.email || ""), // backward UI compatibility
    loginKind: kind || "FUNCTIONAL",
    scopeType: isSuperadmin ? "SUPERADMIN" : (doc.functionalScopeType || ""),
    scopeId: isSuperadmin ? String(doc._id || "") : (doc.functionalScopeId || ""),
    scopeName: isSuperadmin ? "Company Superadmin" : (doc.functionalScopeName || ""),
    role: doc.role || "",
    roleId: clean(doc.roleId),
    departmentId: clean(doc.departmentId),
    department: doc.department || "",
    warehouseId: doc.warehouseId || "",
    status: doc.status || "ACTIVE",
    loginEnabled: doc.loginEnabled !== false,
    passwordConfigured: doc.passwordConfigured === true || isSuperadmin,
    passwordUpdatedAt: doc.passwordUpdatedAt || null,
    lastLoginAt: doc.lastLoginAt || null,
    loginCount: Number(doc.loginCount || 0),
    dataScope: doc.dataScope || "",
  };
}

export async function listCompanyLoginControl(tenantKey, actorId = "SYSTEM") {
  const sync = await syncFunctionalLogins(tenantKey, actorId);
  const rows = await User.find({
    tenantKey,
    status: { $ne: "DELETED" },
    $or: [
      { role: "SUPERADMIN" },
      { loginKind: "FUNCTIONAL", managedLogin: true },
    ],
  }).sort({ role: -1, functionalScopeType: 1, functionalScopeName: 1 }).lean();
  return { sync, items: rows.map(publicFunctionalLogin) };
}

export async function ensureWarehouseFunctionalLogin(tenantKey, warehouseId, actorId = "SYSTEM") {
  await syncFunctionalLogins(tenantKey, actorId);
  return User.findOne({
    tenantKey,
    loginKind: "FUNCTIONAL",
    functionalScopeType: "WAREHOUSE",
    functionalScopeId: String(warehouseId),
  }).lean();
}

export async function syncAllFunctionalLogins() {
  const masterRows = await ensureMasterLoginIds();
  const tenantKeys = await User.distinct("tenantKey", {
    role: "SUPERADMIN",
    status: "ACTIVE",
    tenantKey: { $nin: [null, ""] },
  });
  const results = [];
  for (const tenantKey of tenantKeys) {
    try {
      results.push({ tenantKey, ...(await syncFunctionalLogins(tenantKey, "SYSTEM_STARTUP")), ok: true });
    } catch (error) {
      results.push({ tenantKey, ok: false, error: error.message || "SYNC_FAILED" });
    }
  }
  results.masterLogins = masterRows.length;
  return results;
}
