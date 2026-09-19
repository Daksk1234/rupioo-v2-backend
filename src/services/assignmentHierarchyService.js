import { Department, PincodeAssignment, Role, User } from "../models/index.js";

const MASTER_DEPARTMENT_TENANT = "__MASTER_DEPARTMENTS__";

const cleanPin = (value) => String(value || "").replace(/\D/g, "").slice(0, 6);
const uniq = (values = []) => Array.from(new Set(values.map((x) => String(x || "")).filter(Boolean)));

async function roleForUser(user) {
  if (!user) return null;
  if (user.roleId) {
    const byId = await Role.findOne({ _id: user.roleId, tenantKey: user.tenantKey, status: "ACTIVE" }).lean();
    if (byId) return byId;
  }
  return Role.findOne({ tenantKey: user.tenantKey, code: String(user.role || "").toUpperCase(), status: "ACTIVE" }).lean();
}

async function departmentForUser(user, role) {
  const departmentId = user?.departmentId || role?.departmentId;
  if (!departmentId) return null;
  return Department.findOne({ _id: departmentId, tenantKey: { $in: [MASTER_DEPARTMENT_TENANT, user.tenantKey] }, status: "ACTIVE" }).lean();
}

async function bottomRoleForDepartment(tenantKey, departmentId) {
  return Role.findOne({ tenantKey, departmentId, status: "ACTIVE", hierarchyOrder: { $gt: 0 } })
    .sort({ hierarchyOrder: -1, name: 1 })
    .lean();
}

// Customer/lead pincode ownership is always assigned to the ranked
// SALES_PERSON Role. CUSTOMER is structural only and, when present, must sit
// immediately below SALES_PERSON. Other departments are never accidentally
// treated as customer-assignment departments merely because they have roles.
async function assignmentRoleForDepartment(tenantKey, departmentId) {
  const roles = await Role.find({ tenantKey, departmentId, status: "ACTIVE", hierarchyOrder: { $gt: 0 } })
    .sort({ hierarchyOrder: 1, createdAt: 1, name: 1 })
    .lean();
  if (!roles.length) return null;

  const salesPerson = roles.find((r) => String(r.code || "").toUpperCase() === "SALES_PERSON");
  if (!salesPerson) return null;

  const customer = roles.find((r) => String(r.code || "").toUpperCase() === "CUSTOMER");
  if (customer && Number(customer.hierarchyOrder) !== Number(salesPerson.hierarchyOrder) + 1) return null;
  return salesPerson;
}

async function descendantLeafUsers(tenantKey, rootUserId, targetRole) {
  const found = [];
  const seen = new Set([String(rootUserId)]);
  let frontier = [rootUserId];
  // Dynamic role hierarchies can have more than one level between a Head and
  // Sales Person, so walk assignedToUserId rather than assuming one fixed tier.
  while (frontier.length) {
    const children = await User.find({
      tenantKey,
      status: "ACTIVE",
      assignedToUserId: { $in: frontier },
    }).select("_id role roleId assignedToUserId").lean();
    frontier = [];
    for (const child of children) {
      const id = String(child._id);
      if (seen.has(id)) continue;
      seen.add(id);
      const isTarget = String(child.roleId || "") === String(targetRole._id) ||
        String(child.role || "").toUpperCase() === String(targetRole.code || "").toUpperCase();
      if (isTarget) found.push(child);
      else frontier.push(child._id);
    }
  }
  return found;
}

export async function getAssignmentOptions(tenantKey, rawPincode) {
  const pincode = cleanPin(rawPincode);
  if (pincode.length !== 6) {
    return { pincode, assignments: [], users: [], requiresSelection: false, autoUserId: "" };
  }

  const assignments = await PincodeAssignment.find({ tenantKey, pincode, status: "ACTIVE" })
    .populate("departmentId", "name code status")
    .populate("userIds", "name email loginEnabled role roleId departmentId status")
    .lean();

  const bottomRoleCache = new Map();
  const validAssignments = [];
  for (const assignment of assignments) {
    if (!assignment.departmentId || assignment.departmentId.status === "INACTIVE") continue;
    const departmentId = String(assignment.departmentId._id);
    let bottomRole = bottomRoleCache.get(departmentId);
    if (bottomRole === undefined) {
      bottomRole = await assignmentRoleForDepartment(tenantKey, assignment.departmentId._id);
      bottomRoleCache.set(departmentId, bottomRole || null);
    }
    if (!bottomRole) continue;
    const validUsers = (assignment.userIds || []).filter((u) =>
      u && u.status === "ACTIVE" &&
      (String(u.roleId || "") === String(bottomRole._id) || String(u.role || "").toUpperCase() === String(bottomRole.code || "").toUpperCase())
    );
    if (validUsers.length) validAssignments.push({ ...assignment, userIds: validUsers });
  }

  const userMap = new Map();
  for (const assignment of validAssignments) {
    for (const user of assignment.userIds) {
      userMap.set(String(user._id), {
        _id: String(user._id),
        name: user.name,
        email: user.loginEnabled === false ? "" : user.email,
        role: user.role,
        departmentId: String(assignment.departmentId._id),
        departmentName: assignment.departmentId.name,
      });
    }
  }

  const users = Array.from(userMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  return {
    pincode,
    assignments: validAssignments.map((a) => ({
      _id: String(a._id),
      departmentId: String(a.departmentId._id),
      departmentName: a.departmentId.name,
      users: a.userIds.map((u) => ({ _id: String(u._id), name: u.name, email: u.loginEnabled === false ? "" : u.email, role: u.role })),
    })),
    users,
    requiresSelection: users.length > 1,
    autoUserId: users.length === 1 ? users[0]._id : "",
  };
}

export async function resolveCustomerSalesperson({ tenantKey, pincode, requestedUserId = "", requireAssignment = false }) {
  const options = await getAssignmentOptions(tenantKey, pincode);
  if (!options.users.length) {
    if (requireAssignment) {
      const error = new Error(`Pincode ${options.pincode || cleanPin(pincode)} is not assigned to any Sales Person. Assign this pincode to a Sales Person first, then create the customer.`);
      error.statusCode = 409;
      error.assignmentOptions = options;
      throw error;
    }
    return { salespersonId: "", options };
  }

  const requested = String(requestedUserId || "");
  if (options.users.length === 1) {
    return { salespersonId: options.users[0]._id, options };
  }

  if (!requested) {
    const error = new Error(`Multiple salespersons are assigned to pincode ${options.pincode}. Select one salesperson.`);
    error.statusCode = 409;
    error.assignmentOptions = options;
    throw error;
  }

  if (!options.users.some((u) => u._id === requested)) {
    const error = new Error(`Selected salesperson is not assigned to pincode ${options.pincode}.`);
    error.statusCode = 409;
    error.assignmentOptions = options;
    throw error;
  }

  return { salespersonId: requested, options };
}

export async function hierarchyVisibilityForUser(auth) {
  if (!auth || auth.role === "MASTER" || auth.role === "SUPERADMIN") {
    return { unrestricted: true, userIds: [], pincodes: [], departmentId: "", isLeaf: false };
  }

  const user = await User.findOne({ _id: auth.sub, tenantKey: auth.tenantKey, status: "ACTIVE" }).lean();
  if (!user) return { unrestricted: false, userIds: [], pincodes: [], departmentId: "", isLeaf: true };

  const role = await roleForUser(user);
  const department = await departmentForUser(user, role);

  // Only a Department containing a valid ranked SALES_PERSON participates in
  // customer/lead pincode visibility. All other Departments remain unrestricted
  // by the assignment hierarchy; their access is controlled by Role permission.
  if (!department || !role) {
    return { unrestricted: true, userIds: [], pincodes: [], departmentId: "", isLeaf: false };
  }

  const bottomRole = await assignmentRoleForDepartment(user.tenantKey, department._id);
  if (!bottomRole) {
    return { unrestricted: true, userIds: [], pincodes: [], departmentId: String(department._id), isLeaf: false };
  }

  const roleOrder = Number(role.hierarchyOrder || 0);
  const bottomOrder = Number(bottomRole.hierarchyOrder || 0);
  const isLeaf = roleOrder > 0 && roleOrder >= bottomOrder;

  let visibleUserIds;
  if (isLeaf) {
    visibleUserIds = [String(user._id)];
  } else {
    // When more than one Sales Head exists, each Head must see only the Sales
    // Persons under their own reporting subtree, not every Sales Person in the company.
    const leafUsers = await descendantLeafUsers(user.tenantKey, user._id, bottomRole);
    visibleUserIds = leafUsers.map((u) => String(u._id));
  }

  const assignmentFilter = {
    tenantKey: user.tenantKey,
    departmentId: department._id,
    status: "ACTIVE",
  };
  if (isLeaf) assignmentFilter.userIds = user._id;
  else if (visibleUserIds.length) assignmentFilter.userIds = { $in: visibleUserIds };
  else assignmentFilter._id = { $exists: false };

  const assignments = await PincodeAssignment.find(assignmentFilter).select("pincode").lean();
  let pincodes = uniq(assignments.map((a) => cleanPin(a.pincode))).filter((p) => p.length === 6);
  // Sales Head coverage selected during User creation/management is an upper
  // geography ceiling. This keeps two or more Sales Heads isolated by territory.
  if (String(role.code || "").toUpperCase() === "SALES_HEAD" && Array.isArray(user.coveragePincodes) && user.coveragePincodes.length) {
    const coverage = new Set(user.coveragePincodes.map(cleanPin));
    pincodes = pincodes.filter((pin) => coverage.has(pin));
  }

  return {
    unrestricted: false,
    userIds: uniq(visibleUserIds),
    pincodes,
    departmentId: String(department._id),
    departmentName: department.name,
    roleId: String(role._id),
    roleCode: role.code,
    roleOrder,
    bottomRoleId: String(bottomRole._id),
    bottomRoleCode: bottomRole.code,
    isLeaf,
  };
}

export async function eligibleUsersForDepartment(tenantKey, departmentId) {
  const department = await Department.findOne({ _id: departmentId, tenantKey: { $in: [MASTER_DEPARTMENT_TENANT, tenantKey] }, status: "ACTIVE" }).lean();
  if (!department) return { department: null, role: null, users: [] };
  const role = await assignmentRoleForDepartment(tenantKey, departmentId);
  if (!role) return { department, role: null, users: [] };
  const users = await User.find({
    tenantKey,
    status: "ACTIVE",
    $or: [{ roleId: role._id }, { role: role.code }],
  }).select("name email role roleId departmentId").sort({ name: 1 }).lean();
  return { department, role, users };
}

export async function reconcilePincodeAssignmentsForDepartment(tenantKey, departmentId, CustomerLinkModel = null) {
  if (!tenantKey || !departmentId) return { assignments: 0, changed: 0 };
  const { role, users } = await eligibleUsersForDepartment(tenantKey, departmentId);
  const allowed = new Set(users.map((u) => String(u._id)));
  const rows = await PincodeAssignment.find({ tenantKey, departmentId, status: "ACTIVE" });
  let changed = 0;
  for (const row of rows) {
    const nextIds = (row.userIds || []).map(String).filter((id) => allowed.has(id));
    const currentIds = (row.userIds || []).map(String);
    if (currentIds.join("|") !== nextIds.join("|")) {
      row.userIds = nextIds;
      await row.save();
      changed += 1;
    }
    if (CustomerLinkModel) {
      const pinFilter = { tenantKey, "addresses.pincode": row.pincode };
      if (!role || nextIds.length === 0) {
        await CustomerLinkModel.updateMany(pinFilter, { $set: { salespersonId: "" } });
      } else if (nextIds.length === 1) {
        await CustomerLinkModel.updateMany(pinFilter, { $set: { salespersonId: nextIds[0] } });
      } else {
        await CustomerLinkModel.updateMany({ ...pinFilter, salespersonId: { $nin: nextIds } }, { $set: { salespersonId: "" } });
      }
    }
  }
  return { assignments: rows.length, changed };
}
