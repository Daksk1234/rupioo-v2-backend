import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import { Lead, LeadCreationRequest, LeadVisit, Pincode, PincodeAssignment, User } from "../models/index.js";
import { makeId } from "../utils/ids.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { getAssignmentOptions, hierarchyVisibilityForUser } from "../services/assignmentHierarchyService.js";
import { buildLeadAssignmentPlan, chooseLeadAssignee, takeLeadAssignee, reassignOpenLeadsForPincodes, OPEN_STAGES } from "../services/leadAssignmentService.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.auth?.role === "MASTER" || (req.auth?.apps || []).includes("dms")) return next();
  return fail(res, "DMS access required", 403);
});

const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const digits = (v) => clean(v).replace(/\D/g, "");
const cleanPin = (v) => digits(v).slice(0, 6);
const cleanMobile = (v) => digits(v).slice(-10);
const normal = (v) => clean(v).toLowerCase().replace(/\s+/g, " ");
const terminalStages = new Set(["CUSTOMER", "CANCELLED", "DELETED"]);
const isAdmin = (req) => ["MASTER", "SUPERADMIN"].includes(upper(req.auth?.role)) || (req.auth?.permissions || []).includes("*");
const isSuperadmin = (req) => upper(req.auth?.role) === "SUPERADMIN";
const isSalesPerson = (req) => upper(req.auth?.role) === "SALES_PERSON";

const headerKey = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, "");
const aliases = {
  companyName: ["companyname", "company", "firmname", "shopname", "partyname", "party", "customername", "customer", "leadname", "name"],
  contactPerson: ["contactperson", "ownername", "proprietor", "personname", "contactname"],
  mobile: ["mobilenumber", "mobile", "contactnumber", "contactno", "phone", "phonenumber"],
  whatsapp: ["whatsapp", "whatsappnumber", "whatsappno"],
  email: ["email", "emailid", "mail"],
  address: ["address", "fulladdress", "location", "shopaddress"],
  pincode: ["pincode", "pin", "postalcode", "zipcode", "zip"],
  city: ["city", "town"],
  state: ["state"],
  source: ["source", "leadsource", "reference", "refsource"],
  sourceReference: ["sourcereference", "referenceid", "refno", "sourceref"],
  productInterest: ["productinterest", "products", "product", "interestedin", "requirement"],
  priority: ["priority", "leadpriority"],
  note: ["remark", "remarks", "note", "notes", "comment", "comments"],
};
function valueFromRow(row, names) {
  const mapped = new Map(Object.entries(row || {}).map(([k, v]) => [headerKey(k), v]));
  for (const key of names) if (mapped.has(key)) return mapped.get(key);
  return "";
}
function duplicateKey(data) {
  return JSON.stringify([normal(data.companyName), cleanMobile(data.mobile), normal(data.address), cleanPin(data.pincode)]);
}
function productArray(v) {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  return clean(v).split(/[,;|]/).map(clean).filter(Boolean);
}
function leadPrefill(lead) {
  return {
    sourceLeadId: lead.leadId,
    legalName: lead.companyName || "",
    ownerName: lead.contactPerson || "",
    ownerMobile: lead.mobile || "",
    mobile: lead.mobile || "",
    email: lead.email || "",
    address: lead.address || "",
    pincode: lead.pincode || "",
    city: lead.city || "",
    state: lead.state || "",
    salespersonId: lead.assignedUserId || "",
    dealsInProducts: (lead.productInterest || []).join(", "),
    remarks: `Converted from Sales Lead ${lead.leadId}`,
  };
}

async function visibleLeadFilter(req, base = {}) {
  const visibility = await hierarchyVisibilityForUser(req.auth);
  if (visibility.unrestricted) return { filter: base, visibility };
  const userIds = visibility.userIds || [];
  if (visibility.isLeaf) return { filter: { ...base, assignedUserId: String(req.auth.sub) }, visibility };
  const scoped = [];
  if (userIds.length) scoped.push({ assignedUserId: { $in: userIds } });
  if ((visibility.pincodes || []).length) scoped.push({ assignedUserId: { $in: ["", null] }, pincode: { $in: visibility.pincodes } });
  return { filter: scoped.length ? { ...base, $and: [...(base.$and || []), { $or: scoped }] } : { ...base, _id: { $exists: false } }, visibility };
}
async function findVisibleLead(req, id) {
  const idFilter = /^[0-9a-fA-F]{24}$/.test(String(id)) ? { $or: [{ _id: id }, { leadId: id }] } : { leadId: id };
  const { filter } = await visibleLeadFilter(req, { tenantKey: req.auth.tenantKey, ...idFilter });
  return Lead.findOne(filter);
}
async function fillGeo(data) {
  const pin = cleanPin(data.pincode);
  if (!pin) return { ...data, pincode: "" };
  const pd = await Pincode.findOne({ pincode: pin }).lean();
  return { ...data, pincode: pin, city: clean(data.city) || clean(pd?.city), state: clean(data.state) || clean(pd?.state) };
}
function pushAnd(base, condition) {
  base.$and = [...(base.$and || []), condition];
}

const APP_PAGE_SIZE = 50;
const APP_MAX_PAGE_SIZE = 100;
const REQUESTED_CONVERSION_STATUSES = ["PENDING_VERIFICATION", "HOLD", "SENT_BACK", "REJECTED", "BLOCKED"];
const CONVERTED_CONVERSION_STATUSES = ["ACTIVE", "APPROVED"];

function escapeRegex(value) {
  return clean(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mobileBucketForValues(stageValue, conversionValue) {
  const stage = upper(stageValue);
  const conversion = upper(conversionValue);
  if (stage === "CUSTOMER" || CONVERTED_CONVERSION_STATUSES.includes(conversion)) return "converted";
  if (stage === "REJECTED") return "rejected";
  if (stage === "PENDING_VERIFICATION" || REQUESTED_CONVERSION_STATUSES.includes(conversion)) return "requested";
  if (stage === "FOLLOW_UP") return "followup";
  return "leads";
}

function mobileBucketCondition(bucketValue) {
  const bucket = clean(bucketValue).toLowerCase();
  if (bucket === "converted") {
    return { $or: [{ stage: "CUSTOMER" }, { "conversion.status": { $in: CONVERTED_CONVERSION_STATUSES } }] };
  }
  if (bucket === "rejected") {
    return {
      stage: "REJECTED",
      "conversion.status": { $nin: CONVERTED_CONVERSION_STATUSES },
    };
  }
  if (bucket === "requested") {
    return {
      stage: { $nin: ["REJECTED", "CUSTOMER"] },
      "conversion.status": { $nin: CONVERTED_CONVERSION_STATUSES },
      $or: [
        { stage: "PENDING_VERIFICATION" },
        { "conversion.status": { $in: REQUESTED_CONVERSION_STATUSES } },
      ],
    };
  }
  if (bucket === "followup") {
    return {
      stage: "FOLLOW_UP",
      "conversion.status": { $nin: [...CONVERTED_CONVERSION_STATUSES, ...REQUESTED_CONVERSION_STATUSES] },
    };
  }
  // Default/mobile "Leads" tab: everything that does not belong to the
  // Converted, Rejected, Requested or Follow Up buckets.
  return {
    stage: { $nin: ["CUSTOMER", "REJECTED", "PENDING_VERIFICATION", "FOLLOW_UP"] },
    "conversion.status": { $nin: [...CONVERTED_CONVERSION_STATUSES, ...REQUESTED_CONVERSION_STATUSES] },
  };
}

function addMobileLeadFilters(filter, req) {
  const q = clean(req.query.q);
  const pincode = clean(req.query.pincode);
  const city = clean(req.query.city);
  const state = clean(req.query.state);

  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    pushAnd(filter, {
      $or: [
        { companyName: rx },
        { contactPerson: rx },
        { mobile: rx },
        { address: rx },
        { email: rx },
        { leadId: rx },
        { pincode: rx },
        { city: rx },
        { state: rx },
        { "activities.note": rx },
        { "activities.outcome": rx },
      ],
    });
  }
  if (pincode) pushAnd(filter, { pincode: new RegExp(escapeRegex(pincode), "i") });
  if (city) pushAnd(filter, { city: new RegExp(escapeRegex(city), "i") });
  if (state) pushAnd(filter, { state: new RegExp(escapeRegex(state), "i") });
  return filter;
}

async function mobileLeadSummary(req) {
  const base = {
    tenantKey: req.auth.tenantKey,
    assignedUserId: String(req.auth.sub),
    stage: { $ne: "DELETED" },
  };

  const [groups, creationRequests] = await Promise.all([
    Lead.aggregate([
      { $match: base },
      {
        $group: {
          _id: {
            stage: "$stage",
            conversionStatus: "$conversion.status",
          },
          count: { $sum: 1 },
        },
      },
    ]),
    LeadCreationRequest.countDocuments({
      tenantKey: req.auth.tenantKey,
      requestedBy: req.auth.sub,
    }),
  ]);

  const summary = { leads: 0, followup: 0, requested: 0, converted: 0, rejected: 0 };
  for (const row of groups) {
    const bucket = mobileBucketForValues(row?._id?.stage, row?._id?.conversionStatus);
    summary[bucket] += Number(row.count || 0);
  }
  summary.requested += Number(creationRequests || 0);
  return summary;
}

function requiredLeadDataMissing(data) {
  const missing = [];
  if (!clean(data.companyName)) missing.push("Party Name");
  if (!clean(data.address)) missing.push("Address");
  if (cleanMobile(data.mobile).length !== 10) missing.push("Mobile No.");
  if (cleanPin(data.pincode).length !== 6) missing.push("Pincode");
  return missing;
}

router.get("/stats", async (req, res) => {
  const { filter } = await visibleLeadFilter(req, { tenantKey: req.auth.tenantKey, stage: { $ne: "DELETED" } });
  const rows = await Lead.aggregate([
    { $match: filter },
    { $group: { _id: "$stage", count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(rows.map((x) => [x._id || "UNKNOWN", x.count]));
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const [overdue, dueToday, unassigned, missingMobile, missingAddress, total] = await Promise.all([
    Lead.countDocuments({ ...filter, stage: { $in: OPEN_STAGES }, nextFollowUpAt: { $lt: now } }),
    Lead.countDocuments({ ...filter, stage: { $in: OPEN_STAGES }, nextFollowUpAt: { $gte: start, $lt: end } }),
    Lead.countDocuments({ ...filter, stage: { $in: OPEN_STAGES }, $or: [{ assignedUserId: "" }, { assignedUserId: null }, { assignedUserId: { $exists: false } }] }),
    Lead.countDocuments({ ...filter, stage: { $in: OPEN_STAGES }, $or: [{ mobile: "" }, { mobile: null }, { mobile: { $exists: false } }] }),
    Lead.countDocuments({ ...filter, stage: { $in: OPEN_STAGES }, $or: [{ address: "" }, { address: null }, { address: { $exists: false } }] }),
    Lead.countDocuments(filter),
  ]);
  return ok(res, { counts, overdue, dueToday, unassigned, missingMobile, missingAddress, total, open: OPEN_STAGES.reduce((n, s) => n + Number(counts[s] || 0), 0) });
});

router.get("/my", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(APP_MAX_PAGE_SIZE, Math.max(10, Number(req.query.limit || APP_PAGE_SIZE)));
    const bucket = clean(req.query.bucket || "leads").toLowerCase();
    const includeSummary = String(req.query.includeSummary || "1") !== "0";

    const filter = {
      tenantKey: req.auth.tenantKey,
      assignedUserId: String(req.auth.sub),
      stage: { $ne: "DELETED" },
    };
    pushAnd(filter, mobileBucketCondition(bucket));
    addMobileLeadFilters(filter, req);

    // The mobile list only needs the latest activity, not the entire activity
    // history for every row. This keeps each 50-lead response small even when
    // a lead has months of follow-up history. Full history remains in MongoDB.
    const projection = {
      leadId: 1, companyName: 1, contactPerson: 1, mobile: 1, whatsapp: 1, email: 1,
      address: 1, pincode: 1, city: 1, state: 1, source: 1, sourceReference: 1,
      productInterest: 1, assignedUserId: 1, stage: 1, priority: 1, nextFollowUpAt: 1,
      lastActivityAt: 1, conversion: 1, createdAt: 1, updatedAt: 1,
      activities: { $slice: -1 },
    };

    const tasks = [
      Lead.find(filter, projection)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Lead.countDocuments(filter),
    ];
    if (includeSummary) tasks.push(mobileLeadSummary(req));

    const [items, total, summary] = await Promise.all(tasks);
    return ok(res, {
      items,
      meta: pageMeta(page, limit, total),
      ...(includeSummary ? { summary } : {}),
    });
  } catch (e) {
    return fail(res, e.message, 400);
  }
});

router.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));
  const q = clean(req.query.q);
  const base = { tenantKey: req.auth.tenantKey, stage: { $ne: "DELETED" } };
  if (req.query.stage) base.stage = upper(req.query.stage);
  if (req.query.priority) base.priority = upper(req.query.priority);
  if (req.query.assignedUserId) base.assignedUserId = clean(req.query.assignedUserId);
  if (req.query.pincode) base.pincode = cleanPin(req.query.pincode);
  const quality = upper(req.query.quality);
  if (quality === "MISSING_MOBILE") pushAnd(base, { $or: [{ mobile: "" }, { mobile: null }, { mobile: { $exists: false } }] });
  if (quality === "MISSING_ADDRESS") pushAnd(base, { $or: [{ address: "" }, { address: null }, { address: { $exists: false } }] });
  if (quality === "INCOMPLETE") pushAnd(base, { $or: [{ mobile: "" }, { mobile: null }, { mobile: { $exists: false } }, { address: "" }, { address: null }, { address: { $exists: false } }] });
  if (quality === "COMPLETE") { pushAnd(base, { mobile: { $regex: /\d/ } }); pushAnd(base, { address: { $regex: /\S/ } }); }
  const due = upper(req.query.due);
  if (due) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start); end.setDate(end.getDate() + 1);
    if (due === "OVERDUE") { base.stage = { $in: OPEN_STAGES }; base.nextFollowUpAt = { $lt: now }; }
    if (due === "TODAY") { base.stage = { $in: OPEN_STAGES }; base.nextFollowUpAt = { $gte: start, $lt: end }; }
    if (due === "UPCOMING") { base.stage = { $in: OPEN_STAGES }; base.nextFollowUpAt = { $gte: end }; }
    if (due === "NO_FOLLOWUP") { base.stage = { $in: OPEN_STAGES }; pushAnd(base, { $or: [{ nextFollowUpAt: null }, { nextFollowUpAt: { $exists: false } }] }); }
  }
  if (q) pushAnd(base, { $or: [
    { companyName: new RegExp(q, "i") },
    { contactPerson: new RegExp(q, "i") },
    { mobile: new RegExp(q, "i") },
    { address: new RegExp(q, "i") },
    { email: new RegExp(q, "i") },
    { leadId: new RegExp(q, "i") },
    { pincode: new RegExp(q, "i") },
    { city: new RegExp(q, "i") },
  ] });
  const { filter } = await visibleLeadFilter(req, base);
  const [items, total] = await Promise.all([
    Lead.find(filter).sort({ nextFollowUpAt: 1, updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Lead.countDocuments(filter),
  ]);
  const userIds = Array.from(new Set(items.map((x) => String(x.assignedUserId || "")).filter(Boolean)));
  const users = userIds.length ? await User.find({ _id: { $in: userIds }, tenantKey: req.auth.tenantKey }).select("_id name mobile email role").lean() : [];
  const um = new Map(users.map((u) => [String(u._id), u]));
  return ok(res, { items: items.map((x) => ({ ...x, assignedUser: um.get(String(x.assignedUserId || "")) || null })), meta: pageMeta(page, limit, total) });
});


router.get("/follow-up-salespersons", async (req, res) => {
  try {
    const visibility = await hierarchyVisibilityForUser(req.auth);
    let userIds = [];
    if (visibility.unrestricted) {
      const [visitIds, leadIds] = await Promise.all([
        LeadVisit.distinct("salespersonId", { tenantKey: req.auth.tenantKey }),
        Lead.distinct("assignedUserId", { tenantKey: req.auth.tenantKey, assignedUserId: { $nin: ["", null] } }),
      ]);
      userIds = Array.from(new Set([...visitIds, ...leadIds].map(String).filter(Boolean)));
    } else if (visibility.isLeaf) {
      userIds = [String(req.auth.sub)];
    } else {
      userIds = Array.from(new Set((visibility.userIds || []).map(String).filter(Boolean)));
    }
    if (!userIds.length) return ok(res, { items: [] });
    const users = await User.find({
      _id: { $in: userIds },
      tenantKey: req.auth.tenantKey,
      status: "ACTIVE",
    }).select("_id name mobile email role").sort({ name: 1 }).lean();
    return ok(res, { items: users.map((u) => ({
      _id: String(u._id), name: u.name, mobile: u.mobile || "", email: u.email || "", role: u.role || ""
    })) });
  } catch (e) { return fail(res, e.message, 400); }
});

router.get("/follow-up-register", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    const requestedSalespersonId = clean(req.query.salespersonId);
    const type = upper(req.query.type);
    const q = clean(req.query.q);
    const visibility = await hierarchyVisibilityForUser(req.auth);
    let allowedIds = [];
    if (!visibility.unrestricted) {
      allowedIds = visibility.isLeaf ? [String(req.auth.sub)] : (visibility.userIds || []).map(String);
      if (requestedSalespersonId && !allowedIds.includes(requestedSalespersonId)) {
        return fail(res, "Selected Sales Person is outside your reporting hierarchy", 403);
      }
    }

    const filter = { tenantKey: req.auth.tenantKey };
    if (requestedSalespersonId) filter.salespersonId = requestedSalespersonId;
    else if (!visibility.unrestricted) filter.salespersonId = { $in: allowedIds.length ? allowedIds : ["__NONE__"] };
    if (type) filter.type = type;

    const fromTs = req.query.fromTs ? new Date(String(req.query.fromTs)) : null;
    const toTs = req.query.toTs ? new Date(String(req.query.toTs)) : null;
    if ((fromTs && !Number.isNaN(fromTs.getTime())) || (toTs && !Number.isNaN(toTs.getTime()))) {
      filter.visitAt = {};
      if (fromTs && !Number.isNaN(fromTs.getTime())) filter.visitAt.$gte = fromTs;
      if (toTs && !Number.isNaN(toTs.getTime())) filter.visitAt.$lt = toTs;
    }

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const leads = await Lead.find({ tenantKey: req.auth.tenantKey, $or: [
        { companyName: rx }, { address: rx }, { mobile: rx }, { leadId: rx }, { pincode: rx }, { city: rx },
      ] }).select("_id").lean();
      filter.leadObjectId = { $in: leads.map((x) => x._id) };
    }

    const [items, total, grouped] = await Promise.all([
      LeadVisit.find(filter).sort({ visitAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      LeadVisit.countDocuments(filter),
      LeadVisit.aggregate([{ $match: filter }, { $group: { _id: "$type", count: { $sum: 1 } } }]),
    ]);

    const leadIds = Array.from(new Set(items.map((x) => String(x.leadObjectId || "")).filter(Boolean)));
    const salespersonIds = Array.from(new Set(items.map((x) => String(x.salespersonId || "")).filter(Boolean)));
    const [leads, users] = await Promise.all([
      leadIds.length ? Lead.find({ _id: { $in: leadIds }, tenantKey: req.auth.tenantKey }).select("_id leadId companyName address mobile pincode city state stage").lean() : [],
      salespersonIds.length ? User.find({ _id: { $in: salespersonIds }, tenantKey: req.auth.tenantKey }).select("_id name mobile email role").lean() : [],
    ]);
    const lm = new Map(leads.map((x) => [String(x._id), x]));
    const um = new Map(users.map((x) => [String(x._id), x]));
    const counts = Object.fromEntries(grouped.map((x) => [x._id || "OTHER", x.count]));
    return ok(res, {
      items: items.map((v) => {
        const lead = lm.get(String(v.leadObjectId || ""));
        const salesperson = um.get(String(v.salespersonId || ""));
        return {
          _id: String(v._id),
          visitAt: v.visitAt,
          type: v.type,
          outcome: v.outcome || "",
          remarks: v.note || "",
          nextVisitAt: v.nextFollowUpAt || null,
          gpsVerified: Boolean(v.gpsVerified),
          otpVerified: Boolean(v.otpVerified),
          location: v.location || {},
          distanceMeters: v.distanceMeters || null,
          salesperson: salesperson ? { _id: String(salesperson._id), name: salesperson.name, mobile: salesperson.mobile || "", role: salesperson.role || "" } : null,
          party: lead ? { _id: String(lead._id), leadId: lead.leadId, name: lead.companyName, address: lead.address || "", mobile: lead.mobile || "", pincode: lead.pincode || "", city: lead.city || "", state: lead.state || "", stage: lead.stage || "" } : null,
        };
      }),
      meta: pageMeta(page, limit, total),
      summary: {
        total,
        physicalVisits: Number(counts.PHYSICAL_VISIT || 0),
        calls: Number(counts.CALL || 0),
        whatsapp: Number(counts.WHATSAPP || 0),
        followUps: Number(counts.FOLLOW_UP || 0),
        other: Number(counts.OTHER || 0),
      },
    });
  } catch (e) { return fail(res, e.message, 400); }
});


// The mobile app checks pincode ownership before allowing a Sales Person to
// create a lead. No tenant/database value is accepted from the client; every
// lookup is pinned to the tenantKey contained in the signed login token.
router.get("/pincode-access/:pincode", async (req, res) => {
  try {
    if (!isSalesPerson(req) && !isSuperadmin(req)) return fail(res, "Sales Person access required", 403);
    const pincode = cleanPin(req.params.pincode);
    if (pincode.length !== 6) return fail(res, "Enter a valid 6-digit pincode", 400);
    const geo = await Pincode.findOne({ pincode }).select("pincode area city district state").lean();
    if (!geo) return fail(res, `Pincode ${pincode} does not exist in MASTER Pincode`, 404);

    const options = await getAssignmentOptions(req.auth.tenantKey, pincode);
    const currentUserId = String(req.auth.sub || "");
    const mine = options.users.find((u) => String(u._id) === currentUserId);
    if (mine) {
      return ok(res, { pincode, geo, allowed: true, canRequest: false, owner: mine, owners: options.users });
    }
    if (options.users.length) {
      const first = options.users[0];
      const owner = await User.findOne({ _id: first._id, tenantKey: req.auth.tenantKey })
        .select("_id name mobile email role")
        .lean();
      return ok(res, {
        pincode, geo, allowed: false, canRequest: false,
        owner: owner || first, owners: options.users,
        message: `${pincode} is already assigned to ${(owner || first).name}`,
      });
    }
    return ok(res, { pincode, geo, allowed: false, canRequest: true, owner: null, owners: [], message: `${pincode} is not assigned to any Sales Person` });
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.get("/creation-requests/mine", async (req, res) => {
  if (!isSalesPerson(req)) return fail(res, "Sales Person access required", 403);
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(APP_MAX_PAGE_SIZE, Math.max(10, Number(req.query.limit || APP_PAGE_SIZE)));
    const filter = { tenantKey: req.auth.tenantKey, requestedBy: req.auth.sub };
    if (req.query.status) filter.status = upper(req.query.status);

    const q = clean(req.query.q);
    const pincode = clean(req.query.pincode);
    const city = clean(req.query.city);
    const state = clean(req.query.state);
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [
        { companyName: rx }, { mobile: rx }, { address: rx }, { pincode: rx },
        { city: rx }, { state: rx }, { requestId: rx }, { reviewRemark: rx },
      ];
    }
    if (pincode) filter.pincode = new RegExp(escapeRegex(pincode), "i");
    if (city) filter.city = new RegExp(escapeRegex(city), "i");
    if (state) filter.state = new RegExp(escapeRegex(state), "i");

    const [items, total] = await Promise.all([
      LeadCreationRequest.find(filter)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      LeadCreationRequest.countDocuments(filter),
    ]);
    return ok(res, { items, meta: pageMeta(page, limit, total) });
  } catch (e) {
    return fail(res, e.message, 400);
  }
});

router.post("/creation-requests", async (req, res) => {
  try {
    if (!isSalesPerson(req)) return fail(res, "Only a Sales Person can request a new lead", 403);
    const data = await fillGeo({
      ...req.body,
      companyName: clean(req.body.companyName),
      mobile: cleanMobile(req.body.mobile),
      email: clean(req.body.email).toLowerCase(),
    });
    const missing = requiredLeadDataMissing(data);
    if (missing.length) return fail(res, `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`, 400);

    const options = await getAssignmentOptions(req.auth.tenantKey, data.pincode);
    const otherOwners = options.users.filter((u) => String(u._id) !== String(req.auth.sub));
    if (otherOwners.length) return fail(res, `${data.pincode} is already assigned to ${otherOwners[0].name}`, 409, { owner: otherOwners[0] });
    if (options.users.some((u) => String(u._id) === String(req.auth.sub))) {
      return fail(res, `${data.pincode} is already assigned to you. Create the lead directly.`, 409);
    }

    const duplicatePending = await LeadCreationRequest.findOne({
      tenantKey: req.auth.tenantKey, requestedBy: req.auth.sub, pincode: data.pincode,
      companyName: data.companyName, mobile: data.mobile, status: "PENDING",
    }).lean();
    if (duplicatePending) return fail(res, "This lead creation request is already pending", 409);

    const requester = await User.findOne({ _id: req.auth.sub, tenantKey: req.auth.tenantKey, status: "ACTIVE" }).select("name").lean();
    const request = await LeadCreationRequest.create({
      tenantKey: req.auth.tenantKey,
      requestId: makeId("LREQ"),
      requestedBy: req.auth.sub,
      requestedByName: requester?.name || req.auth.name || "",
      pincode: data.pincode,
      companyName: data.companyName,
      mobile: data.mobile,
      address: data.address,
      city: data.city,
      state: data.state,
      contactPerson: clean(req.body.contactPerson),
      whatsapp: cleanMobile(req.body.whatsapp),
      email: data.email,
      source: clean(req.body.source),
      sourceReference: clean(req.body.sourceReference),
      productInterest: productArray(req.body.productInterest),
      priority: upper(req.body.priority || "NORMAL"),
      note: clean(req.body.note || req.body.remarks),
      status: "PENDING",
    });
    return ok(res, { request }, "Lead creation request sent to Superadmin", 201);
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.put("/creation-requests/:id", async (req, res) => {
  if (!isSalesPerson(req)) return fail(res, "Sales Person access required", 403);
  const request = await LeadCreationRequest.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, requestedBy: req.auth.sub });
  if (!request) return fail(res, "Creation request not found", 404);
  if (request.status !== "PENDING") return fail(res, "Only a pending request can be edited", 409);
  for (const key of ["companyName","address","city","state","contactPerson","email","source","sourceReference","note"]) {
    if (req.body[key] !== undefined) request[key] = clean(req.body[key]);
  }
  if (req.body.mobile !== undefined) request.mobile = cleanMobile(req.body.mobile);
  if (req.body.whatsapp !== undefined) request.whatsapp = cleanMobile(req.body.whatsapp);
  if (req.body.productInterest !== undefined) request.productInterest = productArray(req.body.productInterest);
  if (req.body.priority !== undefined) request.priority = upper(req.body.priority);
  await request.save();
  return ok(res, { request }, "Creation request updated");
});

router.post("/creation-requests/:id/review", async (req, res) => {
  try {
    if (!isSuperadmin(req)) return fail(res, "Only Superadmin can review lead creation requests", 403);
    const action = upper(req.body.action);
    if (!["APPROVE", "REJECT"].includes(action)) return fail(res, "Action must be APPROVE or REJECT", 400);
    const request = await LeadCreationRequest.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey });
    if (!request) return fail(res, "Creation request not found", 404);
    if (request.status !== "PENDING") return fail(res, `Request is already ${request.status.toLowerCase()}`, 409);

    if (action === "REJECT") {
      request.status = "REJECTED";
      request.reviewedBy = req.auth.sub;
      request.reviewedAt = new Date();
      request.reviewRemark = clean(req.body.remark);
      await request.save();
      return ok(res, { request }, "Lead creation request rejected");
    }

    const requester = await User.findOne({ _id: request.requestedBy, tenantKey: req.auth.tenantKey, status: "ACTIVE" });
    if (!requester || upper(requester.role) !== "SALES_PERSON" || !requester.departmentId) {
      return fail(res, "Requesting Sales Person or department is no longer active", 409);
    }
    const options = await getAssignmentOptions(req.auth.tenantKey, request.pincode);
    const otherOwners = options.users.filter((u) => String(u._id) !== String(requester._id));
    if (otherOwners.length) return fail(res, `${request.pincode} is already assigned to ${otherOwners[0].name}`, 409);
    const pinExists = await Pincode.exists({ pincode: request.pincode });
    if (!pinExists) return fail(res, `Pincode ${request.pincode} does not exist in MASTER Pincode`, 409);

    await PincodeAssignment.findOneAndUpdate(
      { tenantKey: req.auth.tenantKey, departmentId: requester.departmentId, pincode: request.pincode },
      { $set: { userIds: [requester._id], status: "ACTIVE", updatedBy: req.auth.sub }, $setOnInsert: { createdBy: req.auth.sub } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const dup = await Lead.find({ tenantKey: req.auth.tenantKey, pincode: request.pincode, stage: { $nin: ["CANCELLED","DELETED"] } }).select("companyName mobile address pincode").lean();
    const candidate = { companyName: request.companyName, mobile: request.mobile, address: request.address, pincode: request.pincode };
    if (dup.some((x) => duplicateKey(x) === duplicateKey(candidate))) return fail(res, "A matching lead already exists", 409);

    const now = new Date();
    const lead = await Lead.create({
      tenantKey: req.auth.tenantKey,
      leadId: makeId("LEAD"),
      companyName: request.companyName,
      contactPerson: request.contactPerson,
      mobile: request.mobile,
      whatsapp: request.whatsapp,
      email: request.email,
      address: request.address,
      pincode: request.pincode,
      city: request.city,
      state: request.state,
      source: request.source || "SALESPERSON_REQUEST",
      sourceReference: request.sourceReference || request.requestId,
      productInterest: request.productInterest || [],
      priority: request.priority || "NORMAL",
      assignedUserId: String(requester._id),
      assignedAt: now,
      assignmentMode: "CREATION_REQUEST",
      assignmentHistory: [{ fromUserId: "", toUserId: String(requester._id), at: now, by: req.auth.sub, reason: "LEAD_CREATION_REQUEST_APPROVED" }],
      stage: "ASSIGNED",
      lastActivityAt: now,
    });

    request.status = "APPROVED";
    request.reviewedBy = req.auth.sub;
    request.reviewedAt = now;
    request.reviewRemark = clean(req.body.remark);
    request.approvedLeadId = lead.leadId;
    request.approvedLeadObjectId = lead._id;
    request.assignedPincodeAt = now;
    await request.save();
    return ok(res, { request, lead }, `Request approved. Pincode ${request.pincode} assigned to ${requester.name} and lead created.`);
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.post("/auto-assign", async (req, res) => {
  try {
    if (!isSuperadmin(req)) return fail(res, "Only Superadmin can auto assign leads", 403);
    const pincodes = await Lead.distinct("pincode", { tenantKey: req.auth.tenantKey, stage: { $in: OPEN_STAGES }, pincode: { $regex: /^\\d{6}$/ } });
    const result = await reassignOpenLeadsForPincodes(req.auth.tenantKey, pincodes, req.auth.sub);
    return ok(res, { ...result, pincodesChecked: pincodes.length }, `Auto assignment completed for ${result.matched} open lead(s)`);
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.get("/:id/conversion-prefill", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (["CANCELLED","DELETED"].includes(lead.stage)) return fail(res, `${lead.stage} lead cannot be converted`, 409);
  return ok(res, { lead: lead.toObject(), prefill: leadPrefill(lead) });
});

router.get("/:id", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  const [visits, assignedUser] = await Promise.all([
    LeadVisit.find({ tenantKey: req.auth.tenantKey, leadObjectId: lead._id }).sort({ visitAt: -1 }).lean(),
    lead.assignedUserId ? User.findOne({ _id: lead.assignedUserId, tenantKey: req.auth.tenantKey }).select("_id name mobile email role designation").lean() : null,
  ]);
  return ok(res, { lead: lead.toObject(), visits, assignedUser, prefill: leadPrefill(lead) });
});

router.post("/", async (req, res) => {
  try {
    let data = await fillGeo({ ...req.body, companyName: clean(req.body.companyName), mobile: cleanMobile(req.body.mobile), email: clean(req.body.email).toLowerCase() });
    const missing = requiredLeadDataMissing(data);
    if (missing.length) return fail(res, `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`, 400);
    const existing = await Lead.find({ tenantKey: req.auth.tenantKey, pincode: data.pincode, stage: { $ne: "CANCELLED" } }).select("companyName mobile address pincode").lean();
    if (existing.some((x) => duplicateKey(x) === duplicateKey(data))) return fail(res, "Duplicate lead: Company, Mobile, Address and Pincode already exist", 409);
    let assignee = null;
    if (isSalesPerson(req)) {
      const options = await getAssignmentOptions(req.auth.tenantKey, data.pincode);
      const mine = options.users.find((u) => String(u._id) === String(req.auth.sub));
      const other = options.users.find((u) => String(u._id) !== String(req.auth.sub));
      if (other) return fail(res, `${data.pincode} is already assigned to ${other.name}`, 409, { owner: other });
      if (!mine) return fail(res, `Pincode ${data.pincode} is not assigned to you. Send a lead creation request to Superadmin.`, 409);
      assignee = await User.findOne({ _id: req.auth.sub, tenantKey: req.auth.tenantKey, status: "ACTIVE" }).select("_id name mobile email role").lean();
    } else {
      assignee = await chooseLeadAssignee(req.auth.tenantKey, data.pincode);
    }
    const now = new Date();
    const lead = await Lead.create({
      ...data,
      tenantKey: req.auth.tenantKey,
      leadId: req.body.leadId || makeId("LEAD"),
      assignedUserId: assignee ? String(assignee._id) : "",
      assignedAt: assignee ? now : undefined,
      assignmentMode: assignee ? "AUTO_PINCODE" : "UNASSIGNED",
      assignmentHistory: assignee ? [{ fromUserId: "", toUserId: String(assignee._id), at: now, by: req.auth.sub, reason: "PINCODE_AUTO_ASSIGN" }] : [],
      stage: assignee ? "ASSIGNED" : "NEW",
      priority: upper(req.body.priority || "NORMAL"),
      productInterest: productArray(req.body.productInterest),
      lastActivityAt: now,
    });
    return ok(res, { lead, assignedUser: assignee || null }, assignee ? `Lead created and assigned to ${assignee.name}` : "Lead created but pincode has no Sales Person assignment", 201);
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  if (!req.file) return fail(res, "Excel/CSV file required", 400);
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  } catch { return fail(res, "Unable to read Excel/CSV file", 400); }
  if (!rows.length) return fail(res, "Uploaded file has no lead rows", 400);

  const parsed = [];
  const invalidRows = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const companyName = clean(valueFromRow(r, aliases.companyName));
    const pincode = cleanPin(valueFromRow(r, aliases.pincode));
    const mobile = cleanMobile(valueFromRow(r, aliases.mobile));
    const address = clean(valueFromRow(r, aliases.address));
    if (!companyName || !address || pincode.length !== 6) {
      const reason = !companyName ? "Party Name missing" : !address ? "Address missing" : "Valid 6-digit pincode missing";
      invalidRows.push({ row: i + 2, companyName, address, mobile, pincode, reason });
      continue;
    }
    parsed.push({
      rowNo: i + 2,
      companyName,
      contactPerson: clean(valueFromRow(r, aliases.contactPerson)),
      mobile,
      whatsapp: cleanMobile(valueFromRow(r, aliases.whatsapp)),
      email: clean(valueFromRow(r, aliases.email)).toLowerCase(),
      address,
      pincode,
      city: clean(valueFromRow(r, aliases.city)),
      state: clean(valueFromRow(r, aliases.state)),
      source: clean(valueFromRow(r, aliases.source)) || "Bulk Upload",
      sourceReference: clean(valueFromRow(r, aliases.sourceReference)),
      productInterest: productArray(valueFromRow(r, aliases.productInterest)),
      priority: upper(valueFromRow(r, aliases.priority) || "NORMAL"),
      note: clean(valueFromRow(r, aliases.note)),
      bulkData: r,
    });
  }
  if (!parsed.length) return ok(res, { received: rows.length, inserted: 0, invalid: invalidRows.length, invalidRows, duplicates: [], unassigned: [], autoAssigned: [] }, "No valid lead rows found");

  const pins = Array.from(new Set(parsed.map((x) => x.pincode)));
  const [plan, pdocs, existing] = await Promise.all([
    buildLeadAssignmentPlan(req.auth.tenantKey, pins),
    Pincode.find({ pincode: { $in: pins } }).lean(),
    Lead.find({ tenantKey: req.auth.tenantKey, pincode: { $in: pins }, stage: { $ne: "CANCELLED" } }).select("companyName mobile address pincode").lean(),
  ]);
  const pm = new Map(pdocs.map((p) => [String(p.pincode), p]));
  const existingKeys = new Set(existing.map(duplicateKey));
  const batchKeys = new Set();
  const docs = [], duplicates = [], autoAssigned = [], unassigned = [], incompleteRows = [];
  const batchId = makeId("LBULK");
  const now = new Date();
  for (const row of parsed) {
    const key = duplicateKey(row);
    if (existingKeys.has(key) || batchKeys.has(key)) {
      duplicates.push({ row: row.rowNo, companyName: row.companyName, pincode: row.pincode, reason: "Duplicate Company + Mobile + Address + Pincode" });
      continue;
    }
    batchKeys.add(key);
    const pd = pm.get(row.pincode);
    const assignee = takeLeadAssignee(plan, row.pincode);
    const doc = {
      tenantKey: req.auth.tenantKey,
      leadId: makeId("LEAD"),
      companyName: row.companyName,
      contactPerson: row.contactPerson,
      mobile: row.mobile,
      whatsapp: row.whatsapp,
      email: row.email,
      address: row.address,
      pincode: row.pincode,
      city: row.city || clean(pd?.city),
      state: row.state || clean(pd?.state),
      source: row.source,
      sourceReference: row.sourceReference,
      productInterest: row.productInterest,
      priority: row.priority,
      bulkData: { ...row.bulkData, bulkBatchId: batchId, sourceRow: row.rowNo },
      assignedUserId: assignee ? String(assignee._id) : "",
      assignedAt: assignee ? now : undefined,
      assignmentMode: assignee ? "AUTO_PINCODE" : "UNASSIGNED",
      assignmentHistory: assignee ? [{ fromUserId: "", toUserId: String(assignee._id), at: now, by: req.auth.sub, reason: "BULK_PINCODE_AUTO_ASSIGN" }] : [],
      stage: assignee ? "ASSIGNED" : "NEW",
      lastActivityAt: now,
      activities: row.note ? [{ type: "IMPORT_NOTE", outcome: "", note: row.note, at: now, userId: req.auth.sub }] : [],
    };
    docs.push(doc);
    if (cleanMobile(row.mobile).length !== 10) incompleteRows.push({ row: row.rowNo, companyName: row.companyName, pincode: row.pincode, reason: "Mobile No. required before conversion" });
    if (assignee) autoAssigned.push({ row: row.rowNo, companyName: row.companyName, pincode: row.pincode, salesPersonId: String(assignee._id), salesPerson: assignee.name });
    else unassigned.push({ row: row.rowNo, companyName: row.companyName, pincode: row.pincode, reason: `Pincode ${row.pincode} has no active Sales Person assignment` });
  }
  if (docs.length) await Lead.insertMany(docs, { ordered: false });
  return ok(res, {
    received: rows.length,
    totalRows: rows.length,
    inserted: docs.length,
    autoAssigned: autoAssigned.length,
    unassigned: unassigned.length,
    duplicates: duplicates.length,
    invalid: invalidRows.length,
    incomplete: incompleteRows.length,
    incompleteRows,
    batchId,
    assignedRows: autoAssigned,
    unassignedRows: unassigned,
    duplicateRows: duplicates,
    invalidRows,
    rejectedRows: [
      ...invalidRows.map(x => ({ row:x.row, "Company Name":x.companyName||"", "Mobile":"", "Pincode":x.pincode||"", error:x.reason })),
      ...duplicates.map(x => ({ row:x.row, "Company Name":x.companyName||"", "Mobile":"", "Pincode":x.pincode||"", error:x.reason })),
    ],
  }, `Bulk upload completed: ${docs.length} inserted, ${autoAssigned.length} assigned by pincode${incompleteRows.length ? `, ${incompleteRows.length} need Mobile No. completion` : ""}`);
});

router.post("/bulk-edit", async (req, res) => {
  const ids = Array.isArray(req.body?.selection?.ids) ? req.body.selection.ids.filter(Boolean) : [];
  if (!ids.length) return fail(res, "Select at least one lead", 400);
  const allowed = {};
  if (req.body?.changes?.priority) allowed.priority = upper(req.body.changes.priority);
  if (req.body?.changes?.nextFollowUpAt) allowed.nextFollowUpAt = new Date(req.body.changes.nextFollowUpAt);
  if (req.body?.changes?.source !== undefined) allowed.source = clean(req.body.changes.source);
  if (!Object.keys(allowed).length) return fail(res, "Enter Priority, Next Follow-up or Source to update", 400);
  const { filter } = await visibleLeadFilter(req, { tenantKey: req.auth.tenantKey, _id: { $in: ids }, stage: { $in: OPEN_STAGES } });
  const result = await Lead.updateMany(filter, { $set: { ...allowed, lastActivityAt: new Date() } });
  return ok(res, { matched: result.matchedCount, updated: result.modifiedCount }, `${result.modifiedCount} lead(s) updated`);
});

router.post("/bulk-delete", async (req, res) => {
  const ids = Array.isArray(req.body?.selection?.ids) ? req.body.selection.ids.filter(Boolean) : [];
  if (!ids.length) return fail(res, "Select at least one lead", 400);
  const { filter } = await visibleLeadFilter(req, { tenantKey: req.auth.tenantKey, _id: { $in: ids }, stage: { $nin: ["CUSTOMER", "PENDING_VERIFICATION", "CANCELLED"] } });
  const now = new Date();
  const result = await Lead.updateMany(filter, { $set: { stage: "CANCELLED", cancellation: { reason: "BULK_CANCELLED", note: "Cancelled from Lead Master", cancelledAt: now, cancelledBy: req.auth.sub }, nextFollowUpAt: null, lastActivityAt: now } });
  return ok(res, { deleted: 0, cancelled: result.modifiedCount }, `${result.modifiedCount} lead(s) marked Cancelled. Lead history was retained.`);
});

router.put("/:id", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (terminalStages.has(lead.stage)) return fail(res, `${lead.stage} lead cannot be edited. Keep it for audit history.`, 409);
  const oldPin = lead.pincode;
  for (const key of ["companyName","contactPerson","email","address","city","state","source","sourceReference","priority","nextFollowUpAt"]) if (req.body[key] !== undefined) lead[key] = req.body[key];
  if (req.body.mobile !== undefined) lead.mobile = cleanMobile(req.body.mobile);
  if (req.body.whatsapp !== undefined) lead.whatsapp = cleanMobile(req.body.whatsapp);
  if (req.body.productInterest !== undefined) lead.productInterest = productArray(req.body.productInterest);
  if (req.body.pincode !== undefined) lead.pincode = cleanPin(req.body.pincode);
  if (lead.pincode !== oldPin) {
    let assignee = null;
    if (isSalesPerson(req)) {
      const options = await getAssignmentOptions(req.auth.tenantKey, lead.pincode);
      const mine = options.users.find((u) => String(u._id) === String(req.auth.sub));
      const other = options.users.find((u) => String(u._id) !== String(req.auth.sub));
      if (other) return fail(res, `${lead.pincode} is already assigned to ${other.name}`, 409, { owner: other });
      if (!mine) return fail(res, `Pincode ${lead.pincode} is not assigned to you`, 409);
      assignee = await User.findOne({ _id: req.auth.sub, tenantKey: req.auth.tenantKey, status: "ACTIVE" }).select("_id name role").lean();
    } else {
      assignee = await chooseLeadAssignee(req.auth.tenantKey, lead.pincode);
    }
    const nextId = assignee ? String(assignee._id) : "";
    lead.assignmentHistory.push({ fromUserId: String(lead.assignedUserId || ""), toUserId: nextId, at: new Date(), by: req.auth.sub, reason: "PINCODE_CHANGED" });
    lead.assignedUserId = nextId;
    lead.assignedAt = nextId ? new Date() : undefined;
    lead.assignmentMode = nextId ? "AUTO_PINCODE" : "UNASSIGNED";
  }
  lead.lastActivityAt = new Date();
  await lead.save();
  return ok(res, lead, "Lead updated");
});

router.post("/:id/activity", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (terminalStages.has(lead.stage)) return fail(res, `${lead.stage} lead is closed`, 409);
  const now = new Date();
  const next = req.body.nextFollowUpAt ? new Date(req.body.nextFollowUpAt) : undefined;
  const type = upper(req.body.type || "FOLLOW_UP");
  lead.activities.push({ type, outcome: clean(req.body.outcome), note: clean(req.body.note || req.body.outcome), at: now, userId: req.auth.sub, nextFollowUpAt: next });
  lead.stage = upper(req.body.stage || "FOLLOW_UP");
  lead.nextFollowUpAt = next;
  lead.lastActivityAt = now;
  await lead.save();
  if (["CALL","WHATSAPP","FOLLOW_UP","OTHER"].includes(type)) {
    await LeadVisit.create({
      tenantKey: req.auth.tenantKey, leadObjectId: lead._id, leadId: lead.leadId,
      salespersonId: String(req.auth.sub), type, visitAt: now,
      outcome: clean(req.body.outcome), note: clean(req.body.note || req.body.outcome),
      nextFollowUpAt: next, createdBy: req.auth.sub
    });
  }
  return ok(res, lead, "Activity saved");
});

router.post("/:id/follow-up", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (terminalStages.has(lead.stage)) return fail(res, `${lead.stage} lead is closed`, 409);
  const now = new Date();
  const next = req.body.nextFollowUpAt ? new Date(req.body.nextFollowUpAt) : undefined;
  const type = upper(req.body.type || "FOLLOW_UP");
  const outcome = clean(req.body.outcome);
  const note = clean(req.body.note);
  const stage = upper(req.body.stage || (type === "CALL" ? "CONTACTED" : "FOLLOW_UP"));
  lead.activities.push({ type, outcome, note, at: now, userId: req.auth.sub, nextFollowUpAt: next });
  lead.stage = stage;
  lead.nextFollowUpAt = next;
  lead.lastActivityAt = now;
  await lead.save();
  if (["CALL","WHATSAPP","FOLLOW_UP","OTHER"].includes(type)) await LeadVisit.create({ tenantKey: req.auth.tenantKey, leadObjectId: lead._id, leadId: lead.leadId, salespersonId: String(req.auth.sub), type, visitAt: now, outcome, note, nextFollowUpAt: next, createdBy: req.auth.sub });
  return ok(res, lead, "Follow-up saved");
});

router.post("/:id/visit", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (terminalStages.has(lead.stage)) return fail(res, `${lead.stage} lead is closed`, 409);
  const now = req.body.visitAt ? new Date(req.body.visitAt) : new Date();
  const lat = Number(req.body.latitude), lng = Number(req.body.longitude), accuracy = Number(req.body.accuracy || 0);
  const next = req.body.nextFollowUpAt ? new Date(req.body.nextFollowUpAt) : undefined;
  const gpsVerified = Number.isFinite(lat) && Number.isFinite(lng);
  const visit = await LeadVisit.create({
    tenantKey: req.auth.tenantKey,
    leadObjectId: lead._id,
    leadId: lead.leadId,
    salespersonId: String(req.auth.sub),
    type: "PHYSICAL_VISIT",
    visitAt: now,
    outcome: clean(req.body.outcome),
    note: clean(req.body.note),
    nextFollowUpAt: next,
    location: gpsVerified ? { latitude: lat, longitude: lng, accuracy } : {},
    customerLocation: { latitude: Number(req.body.customerLatitude) || undefined, longitude: Number(req.body.customerLongitude) || undefined },
    distanceMeters: Number(req.body.distanceMeters || 0) || undefined,
    gpsVerified,
    otpVerified: Boolean(req.body.otpVerified),
    photoFileIds: Array.isArray(req.body.photoFileIds) ? req.body.photoFileIds : [],
    createdBy: req.auth.sub,
  });
  lead.activities.push({ type: "VISIT", outcome: visit.outcome, note: visit.note, at: now, userId: req.auth.sub, nextFollowUpAt: next, otpVerified: visit.otpVerified, gpsVerified });
  lead.stage = upper(req.body.stage || "VISITED");
  lead.lastVisitAt = now;
  lead.lastActivityAt = now;
  lead.visitCount = Number(lead.visitCount || 0) + 1;
  lead.nextFollowUpAt = next;
  await lead.save();
  return ok(res, { lead, visit }, "Visit saved");
});


router.post("/:id/reject", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (["CUSTOMER","PENDING_VERIFICATION","DELETED"].includes(lead.stage)) return fail(res, "This lead cannot be rejected now", 409);
  const reason = clean(req.body.reason || req.body.note || "Rejected");
  const now = new Date();
  lead.stage = "REJECTED";
  lead.activities.push({ type: "REJECTED", outcome: reason, note: clean(req.body.note), at: now, userId: req.auth.sub });
  lead.nextFollowUpAt = undefined;
  lead.lastActivityAt = now;
  await lead.save();
  return ok(res, lead, "Lead moved to Rejected");
});

router.post("/:id/cancel", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (lead.stage === "CUSTOMER") return fail(res, "Converted customer lead cannot be cancelled", 409);
  if (lead.stage === "PENDING_VERIFICATION") return fail(res, "Customer verification is already pending. Send back/reject the customer first before cancelling the lead.", 409);
  const reason = clean(req.body.reason);
  if (!reason) return fail(res, "Cancellation reason is required", 400);
  const now = new Date();
  lead.stage = "CANCELLED";
  lead.cancellation = { reason, note: clean(req.body.note), cancelledAt: now, cancelledBy: req.auth.sub };
  lead.activities.push({ type: "CANCELLED", outcome: reason, note: clean(req.body.note), at: now, userId: req.auth.sub });
  lead.nextFollowUpAt = undefined;
  lead.lastActivityAt = now;
  await lead.save();
  return ok(res, lead, "Lead cancelled and retained in history");
});

router.post("/:id/start-conversion", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (["CANCELLED","DELETED"].includes(lead.stage)) return fail(res, `${lead.stage} lead cannot be converted`, 409);
  if (lead.stage === "CUSTOMER") return fail(res, "Lead is already an active customer", 409);
  const now = new Date();
  lead.stage = "CONVERSION_IN_PROGRESS";
  lead.conversion = { ...(lead.conversion?.toObject?.() || lead.conversion || {}), status: "DRAFT", startedAt: lead.conversion?.startedAt || now, startedBy: req.auth.sub };
  lead.activities.push({ type: "CONVERSION_STARTED", outcome: "CUSTOMER_ONBOARDING", note: clean(req.body.note), at: now, userId: req.auth.sub });
  lead.lastActivityAt = now;
  await lead.save();
  return ok(res, { lead, prefill: leadPrefill(lead), customerUrl: `/dms/customers?leadId=${encodeURIComponent(lead.leadId)}` }, "Customer onboarding started");
});

router.post("/:id/reassign", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (terminalStages.has(lead.stage)) return fail(res, "Closed lead cannot be reassigned", 409);
  const userId = clean(req.body.userId);
  if (!userId) return fail(res, "Sales Person is required", 400);
  const user = await User.findOne({ _id: userId, tenantKey: req.auth.tenantKey, status: "ACTIVE" }).select("_id name role").lean();
  if (!user) return fail(res, "Sales Person not found", 404);
  lead.assignmentHistory.push({ fromUserId: String(lead.assignedUserId || ""), toUserId: String(user._id), at: new Date(), by: req.auth.sub, reason: clean(req.body.reason) || "MANUAL_REASSIGN" });
  lead.assignedUserId = String(user._id);
  lead.assignedAt = new Date();
  lead.assignmentMode = "MANUAL";
  if (lead.stage === "NEW") lead.stage = "ASSIGNED";
  await lead.save();
  return ok(res, lead, `Lead assigned to ${user.name}`);
});

router.delete("/all", async (req, res) => {
  try {
    if (!isSuperadmin(req)) return fail(res, "Only Superadmin can delete all leads", 403);

    const tenantKey = req.auth.tenantKey;

    // Intentionally no stage/status filter: this removes NEW, ASSIGNED,
    // FOLLOW_UP, REJECTED, CUSTOMER, CANCELLED, DELETED and every other
    // lead stage belonging to this Superadmin tenant. Customer records
    // themselves are stored separately and are not deleted here.
    const [visitResult, leadResult] = await Promise.all([
      LeadVisit.deleteMany({ tenantKey }),
      Lead.deleteMany({ tenantKey }),
    ]);

    return ok(
      res,
      {
        deleted: true,
        deletedLeads: leadResult.deletedCount || 0,
        deletedVisits: visitResult.deletedCount || 0,
      },
      `Deleted ${leadResult.deletedCount || 0} lead(s) from all statuses`
    );
  } catch (e) {
    return fail(res, e.message, e.statusCode || 400);
  }
});

router.delete("/:id", async (req, res) => {
  const lead = await findVisibleLead(req, req.params.id);
  if (!lead) return fail(res, "Lead not found", 404);
  if (["CUSTOMER","PENDING_VERIFICATION"].includes(lead.stage)) {
    return fail(res, "Converted or conversion-pending leads cannot be deleted", 409);
  }

  // Keep the old hard-delete behaviour for an untouched Admin-created NEW
  // lead; every worked lead is soft-deleted so its audit history is preserved.
  const visitCount = await LeadVisit.countDocuments({ tenantKey: req.auth.tenantKey, leadObjectId: lead._id });
  if (isAdmin(req) && !visitCount && !(lead.activities || []).length && lead.stage === "NEW") {
    await lead.deleteOne();
    return ok(res, { deleted: true, hardDeleted: true }, "Unused lead deleted");
  }

  const now = new Date();
  lead.activities.push({ type: "DELETED", outcome: "REMOVED_FROM_APP", note: clean(req.body?.reason), at: now, userId: req.auth.sub });
  lead.stage = "DELETED";
  lead.nextFollowUpAt = undefined;
  lead.lastActivityAt = now;
  await lead.save();
  return ok(res, { deleted: true, hardDeleted: false }, "Lead removed. Audit history retained.");
});

export default router;
