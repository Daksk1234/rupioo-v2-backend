const id = value => String(value?._id || value || "");
const active = user => String(user.status || "ACTIVE").toUpperCase() === "ACTIVE";
const independent = role => ["COLLECTION_EXECUTIVE", "COLLECTOR"].includes(String(role.code || "").toUpperCase());

export const MASTER_DEPARTMENT_TENANT = "__MASTER_DEPARTMENTS__";

export function canDeleteCompanyDepartment(auth, department) {
  return auth?.role === "SUPERADMIN" && Boolean(auth.tenantKey) &&
    department?.tenantKey === auth.tenantKey && department.tenantKey !== MASTER_DEPARTMENT_TENANT &&
    !department.sourceTemplateCode;
}

// Build the entire reporting change before writing roles or users. Users keep
// their Role identity; only the immediate reporting parent changes with rank.
export function planDepartmentReporting(orderedRoles, users) {
  const roleById = new Map(orderedRoles.map(role => [id(role), role]));
  const roleByCode = new Map(orderedRoles.map(role => [role.code, role]));
  const roleFor = user => user.roleId ? roleById.get(id(user.roleId)) : roleByCode.get(user.role);
  const scoped = users.filter(user => user.status !== "DELETED" && roleFor(user));
  const byId = new Map(scoped.map(user => [id(user), user]));
  const byRole = new Map(orderedRoles.map(role => [id(role), []]));
  for (const user of scoped) byRole.get(id(roleFor(user))).push(user);
  for (const rows of byRole.values()) rows.sort((a,b) => id(a).localeCompare(id(b)));
  const changes = [], load = new Map();
  const ancestors = user => {
    const result = [], seen = new Set([id(user)]);
    let parent = byId.get(id(user.assignedToUserId));
    while (parent && !seen.has(id(parent))) {
      seen.add(id(parent)); result.push(id(parent)); parent = byId.get(id(parent.assignedToUserId));
    }
    return result;
  };
  const ancestry = new Map(scoped.map(user => [id(user), ancestors(user)]));

  for (let rank = 0; rank < orderedRoles.length; rank++) {
    const role = orderedRoles[rank], rows = byRole.get(id(role));
    const candidates = rank ? byRole.get(id(orderedRoles[rank - 1])).filter(active) : [];
    if (rank && !independent(role) && !candidates.length && rows.some(active)) {
      const error = new Error(`Create an active ${orderedRoles[rank - 1].name} user before placing ${role.name} at rank ${rank + 1}. Existing users need an immediate reporting parent.`);
      error.statusCode = 409;
      throw error;
    }
    const validIds = new Set(candidates.map(id));
    // Reserve valid existing links before balancing users that need a new one.
    for (const user of rows) {
      const current = id(user.assignedToUserId);
      if (rank && !independent(role) && validIds.has(current)) load.set(current, (load.get(current) || 0) + 1);
    }
    for (const user of rows) {
      const current = id(user.assignedToUserId);
      let parent = "";
      if (rank && !independent(role) && candidates.length) {
        if (validIds.has(current)) parent = current;
        else {
          const oldAncestors = ancestry.get(id(user));
          const ancestor = oldAncestors.find(value => validIds.has(value));
          if (ancestor) parent = ancestor;
          else {
            // Prefer a person from the old reporting subtree when ranks swap,
            // then the same branch, then the least-loaded eligible parent.
            const related = candidates.filter(candidate => ancestry.get(id(candidate)).includes(id(user)) || ancestry.get(id(candidate)).some(value => oldAncestors.includes(value)));
            const pool = related.length ? related : candidates;
            const sameBranch = pool.filter(candidate => id(user.branchId) && id(candidate.branchId) === id(user.branchId));
            const eligible = sameBranch.length ? sameBranch : pool;
            parent = id([...eligible].sort((a,b) => (load.get(id(a)) || 0) - (load.get(id(b)) || 0) || id(a).localeCompare(id(b)))[0]);
          }
          load.set(parent, (load.get(parent) || 0) + 1);
        }
      }
      if (parent !== current) changes.push({userId: id(user), parentUserId: parent});
    }
  }
  return changes;
}
