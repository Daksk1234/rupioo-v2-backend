import { Plan, Role, DesignationTemplate, Group, Department } from "../models/index.js";
import { sanitizePermissionCodes } from "../config/permissionCatalogue.js";
import { MASTER_DESIGNATION_TENANT } from "../config/defaultDesignationTemplates.js";
import { isMasterOnlyPermission, normalizeScope } from "../config/securityPolicy.js";

const MASTER_DEPARTMENT_TENANT = "__MASTER_DEPARTMENTS__";

const uniq = (values = []) => Array.from(new Set(values.filter(Boolean)));
const appOfPermission = (code) => String(code || "").split(".")[0];
const OPERATIONAL_PERMISSION_APPS = new Set(["dms", "hr", "production"]);

const filterForApps = (permissions, apps) => {
  const set = new Set(apps || []);
  const dmsEnabled = set.has("dms");
  return uniq(permissions).filter((code) => {
    const app = appOfPermission(code);
    // DMS V2 uses one operational application. Historical hr.* and
    // production.* permission namespaces remain valid functional permissions
    // under DMS instead of separate application gates.
    if (OPERATIONAL_PERMISSION_APPS.has(app)) return dmsEnabled;
    if (app === "master") return set.has("master");
    return true; // legacy/internal capability code
  });
};

const denyMasterOnly = (permissions, role) =>
  role === "MASTER"
    ? uniq(permissions)
    : uniq(permissions).filter((code) => !isMasterOnlyPermission(code));

const intersect = (a = [], b = []) => {
  const right = new Set(b || []);
  if ((a || []).includes("*") && (b || []).includes("*")) return ["*"];
  if ((a || []).includes("*")) return uniq(b);
  if ((b || []).includes("*")) return uniq(a);
  return uniq(a).filter((x) => right.has(x));
};

const mapObject = (value) => {
  if (!value) return {};
  if (typeof value.toObject === "function") return value.toObject();
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return { ...value };
};

async function resolvePlanGroup(plan) {
  const code = String(plan?.groupCode || "").trim().toUpperCase();
  if (!code) return null;

  // MASTER groups are created in the platform tenant ("demo" in the shipped
  // seed). Prefer that record so a company-created group with the same code can
  // never become the Plan ceiling accidentally. The fallback keeps older
  // installations working if their MASTER tenant key was customised.
  return (
    (await Group.findOne({ tenantKey: "demo", code, status: "ACTIVE" }).lean()) ||
    (await Group.findOne({ code, status: "ACTIVE" }).sort({ createdAt: 1 }).lean())
  );
}

export async function resolveEffectiveAccess(user) {
  if (!user) {
    return {
      apps: [],
      permissions: [],
      dataScope: "SELF",
      fieldAccess: {},
      workflowTransitions: {},
      approvalLimits: {},
      accessGroup: null,
    };
  }

  if (user.role === "MASTER") {
    return {
      apps: ["master"],
      permissions: ["*"],
      dataScope: "ALL",
      fieldAccess: {},
      workflowTransitions: {},
      approvalLimits: {
        discountPct: 999,
        creditAmount: Number.MAX_SAFE_INTEGER,
        orderAmount: Number.MAX_SAFE_INTEGER,
      },
      accessGroup: null,
    };
  }

  const plan = await Plan.findOne({ code: user.planCode, status: "ACTIVE" }).lean();
  const planGroup = await resolvePlanGroup(plan);

  // HR and Production are intentionally disabled in the current UI/product.
  // DMS is the only operational application exposed to a company account.
  const planApps = plan && plan?.apps?.dms !== false ? ["dms"] : [];
  const userApps = (user.apps || []).includes("dms") ? planApps : [];

  // The Group attached to the Plan is the hard permission ceiling for the
  // entire company. No group (or an inactive/missing group) means no DMS page
  // access instead of silently falling back to the full application.
  const planPermissions = denyMasterOnly(
    filterForApps(sanitizePermissionCodes(planGroup?.permissions || []), planApps),
    user.role
  );
  const accessGroup = planGroup
    ? { id: String(planGroup._id), code: planGroup.code, name: planGroup.name }
    : plan?.groupCode
      ? { code: String(plan.groupCode).toUpperCase(), name: "" }
      : null;

  if (user.role === "SUPERADMIN") {
    // These are internal capabilities used by backend workflows. They are NOT
    // page permissions and therefore do not create extra tabs/subtabs.
    const internalCapabilities = [
      "dms.users.manage",
      "company.manage",
      "customers.approve",
      "accounts.view",
      "accounts.post",
      "accounts.approve",
      "reports.view",
      "reports.company",
    ];

    return {
      apps: userApps,
      permissions: uniq([...planPermissions, ...internalCapabilities]),
      dataScope: "COMPANY",
      fieldAccess: {},
      workflowTransitions: {},
      approvalLimits: {
        discountPct: 100,
        creditAmount: 999999999,
        orderAmount: 999999999,
      },
      accessGroup,
    };
  }

  const [roleDoc, designation] = await Promise.all([
    Role.findOne({
      tenantKey: user.tenantKey,
      status: "ACTIVE",
      $or: [
        ...(user.roleId ? [{ _id: user.roleId }] : []),
        { code: String(user.role || "").toUpperCase() },
      ],
    }).lean(),
    user.designationCode
      ? DesignationTemplate.findOne({
          tenantKey: MASTER_DESIGNATION_TENANT,
          code: String(user.designationCode).toUpperCase(),
          status: "ACTIVE",
        }).lean()
      : null,
  ]);

  const department = roleDoc?.departmentId
    ? await Department.findOne({
        _id: roleDoc.departmentId,
        tenantKey: { $in: [MASTER_DEPARTMENT_TENANT, user.tenantKey] },
        status: "ACTIVE",
      }).lean()
    : null;

  const roleApps = roleDoc?.apps?.length ? roleDoc.apps : userApps;
  const apps = userApps.filter((app) => roleApps.includes(app));

  // Final company-user permission chain:
  // Superadmin Plan/Group ceiling -> Superadmin-created Role -> MASTER Department ceiling.
  // Department permissionConfigured=false is treated as a legacy/unconfigured
  // Department and does not clamp until MASTER uploads its first matrix.
  let permissions = intersect(
    sanitizePermissionCodes(roleDoc?.permissions || []),
    planPermissions
  );
  if (department?.permissionConfigured === true) {
    permissions = intersect(
      permissions,
      sanitizePermissionCodes(department.permissions || [])
    );
  }
  permissions = filterForApps(permissions, apps);
  permissions = denyMasterOnly(permissions, user.role);

  // User overrides may only REMOVE access. `true` never adds a permission that
  // role/designation/plan-group did not already grant.
  const overrides = mapObject(user.userOverrides);
  permissions = permissions.filter((code) => overrides[code] !== false);

  const allowedScopes = designation?.allowedScopes?.length
    ? designation.allowedScopes
    : [designation?.dataScope || roleDoc?.dataScope || "SELF"];
  const requestedScope = normalizeScope(
    user.dataScope || designation?.dataScope || roleDoc?.dataScope || "SELF"
  );
  const dataScope = allowedScopes.includes(requestedScope)
    ? requestedScope
    : normalizeScope(designation?.dataScope || roleDoc?.dataScope || "SELF");

  const limits = {
    discountPct: Math.min(
      Number(roleDoc?.approvalLimits?.discountPct || 0),
      Number(
        designation?.approvalLimits?.discountPct ??
          roleDoc?.approvalLimits?.discountPct ??
          0
      )
    ),
    creditAmount: Math.min(
      Number(roleDoc?.approvalLimits?.creditAmount || 0),
      Number(
        designation?.approvalLimits?.creditAmount ??
          roleDoc?.approvalLimits?.creditAmount ??
          0
      )
    ),
    orderAmount: Math.min(
      Number(roleDoc?.approvalLimits?.orderAmount || 0),
      Number(
        designation?.approvalLimits?.orderAmount ??
          roleDoc?.approvalLimits?.orderAmount ??
          0
      )
    ),
  };

  return {
    apps,
    permissions: uniq(permissions),
    dataScope,
    fieldAccess: designation?.fieldAccess || user.fieldAccess || {},
    workflowTransitions:
      designation?.workflowTransitions || user.workflowTransitions || {},
    approvalLimits: limits,
    designation: designation
      ? {
          code: designation.code,
          name: designation.name,
          department: designation.department,
        }
      : null,
    department: department
      ? { id: String(department._id), code: department.code, name: department.name }
      : null,
    accessGroup,
  };
}
