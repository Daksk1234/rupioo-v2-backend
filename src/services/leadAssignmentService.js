import { Department, Lead, PincodeAssignment, Role, User } from "../models/index.js";

const MASTER_DEPARTMENT_TENANT = "__MASTER_DEPARTMENTS__";
const cleanPin = (value) => String(value || "").replace(/\D/g, "").slice(0, 6);
const OPEN_STAGES = ["NEW","ASSIGNED","CONTACTED","FOLLOW_UP","VISIT_DUE","VISITED","INTERESTED","HOT","CONVERSION_IN_PROGRESS","PENDING_VERIFICATION"];

async function salesDepartmentAndRole(tenantKey) {
  const role = await Role.findOne({ tenantKey, code: "SALES_PERSON", status: "ACTIVE" }).lean();
  if (!role) return { department: null, role: null };
  const department = await Department.findOne({
    _id: role.departmentId,
    tenantKey: { $in: [MASTER_DEPARTMENT_TENANT, tenantKey] },
    status: "ACTIVE",
  }).lean();
  return { department, role };
}

export async function buildLeadAssignmentPlan(tenantKey, rawPincodes = []) {
  const pincodes = Array.from(new Set(rawPincodes.map(cleanPin).filter((pin) => pin.length === 6)));
  const result = new Map();
  if (!pincodes.length) return result;

  const { department, role } = await salesDepartmentAndRole(tenantKey);
  if (!department || !role) {
    pincodes.forEach((pin) => result.set(pin, { users: [], cursor: 0, counts: new Map() }));
    return result;
  }

  const assignments = await PincodeAssignment.find({
    tenantKey,
    departmentId: department._id,
    pincode: { $in: pincodes },
    status: "ACTIVE",
  }).select("pincode userIds").lean();

  const allUserIds = Array.from(new Set(assignments.flatMap((a) => (a.userIds || []).map(String))));
  const activeUsers = allUserIds.length ? await User.find({
    _id: { $in: allUserIds },
    tenantKey,
    status: "ACTIVE",
    $or: [{ roleId: role._id }, { role: role.code }],
  }).select("_id name email mobile role roleId assignedToUserId").lean() : [];
  const userMap = new Map(activeUsers.map((u) => [String(u._id), u]));

  const counts = allUserIds.length ? await Lead.aggregate([
    { $match: { tenantKey, pincode: { $in: pincodes }, assignedUserId: { $in: allUserIds }, stage: { $in: OPEN_STAGES } } },
    { $group: { _id: { pincode: "$pincode", assignedUserId: "$assignedUserId" }, count: { $sum: 1 } } },
  ]) : [];
  const countMap = new Map(counts.map((x) => [`${x._id.pincode}|${x._id.assignedUserId}`, Number(x.count || 0)]));

  for (const pin of pincodes) {
    const assignment = assignments.find((a) => String(a.pincode) === pin);
    const users = (assignment?.userIds || []).map(String).map((id) => userMap.get(id)).filter(Boolean)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const perUser = new Map(users.map((u) => [String(u._id), countMap.get(`${pin}|${u._id}`) || 0]));
    result.set(pin, { users, counts: perUser });
  }
  return result;
}

export function takeLeadAssignee(plan, pincode) {
  const pin = cleanPin(pincode);
  const entry = plan.get(pin);
  if (!entry?.users?.length) return null;
  const sorted = [...entry.users].sort((a, b) => {
    const ca = entry.counts.get(String(a._id)) || 0;
    const cb = entry.counts.get(String(b._id)) || 0;
    if (ca !== cb) return ca - cb;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  const chosen = sorted[0];
  const id = String(chosen._id);
  entry.counts.set(id, (entry.counts.get(id) || 0) + 1);
  return chosen;
}

export async function chooseLeadAssignee(tenantKey, pincode) {
  const plan = await buildLeadAssignmentPlan(tenantKey, [pincode]);
  return takeLeadAssignee(plan, pincode);
}

export async function reassignOpenLeadsForPincodes(tenantKey, rawPincodes = [], actorId = "SYSTEM") {
  const pincodes = Array.from(new Set(rawPincodes.map(cleanPin).filter((pin) => pin.length === 6)));
  if (!pincodes.length) return { matched: 0, reassigned: 0, unassigned: 0 };
  const plan = await buildLeadAssignmentPlan(tenantKey, pincodes);
  const leads = await Lead.find({ tenantKey, pincode: { $in: pincodes }, stage: { $in: OPEN_STAGES } }).sort({ createdAt: 1 });
  let reassigned = 0, unassigned = 0;
  for (const lead of leads) {
    const assignee = takeLeadAssignee(plan, lead.pincode);
    const nextId = assignee ? String(assignee._id) : "";
    if (String(lead.assignedUserId || "") !== nextId) {
      lead.assignmentHistory = lead.assignmentHistory || [];
      lead.assignmentHistory.push({
        fromUserId: String(lead.assignedUserId || ""),
        toUserId: nextId,
        at: new Date(),
        by: actorId,
        reason: "PINCODE_REALLOCATION",
      });
      lead.assignedUserId = nextId;
      lead.assignedAt = nextId ? new Date() : undefined;
      lead.assignmentMode = nextId ? "AUTO_PINCODE" : "UNASSIGNED";
      if (lead.stage === "NEW" && nextId) lead.stage = "ASSIGNED";
      await lead.save();
      reassigned += 1;
    }
    if (!nextId) unassigned += 1;
  }
  return { matched: leads.length, reassigned, unassigned };
}

export { OPEN_STAGES };
