import express from "express";
import {
  CustomerDamageClaim,
  CustomerLink,
  CustomerPromotion,
  CustomerSupportTicket,
  GlobalCustomer,
  User,
} from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { isAdminAuth } from "../utils/adminAccess.js";

const router = express.Router();
const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
router.use(requireAuth);

router.get("/registrations", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));
    const filter = {
      tenantKey: req.auth.tenantKey,
      registrationSource: "SELF_APP",
      status: { $in: ["PENDING_APPROVAL", "ON_HOLD", "ACTIVE", "REJECTED"] },
    };
    if (req.query.status) filter.status = upper(req.query.status);
    const [links, total] = await Promise.all([
      CustomerLink.find(filter).sort({ registrationRequestedAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      CustomerLink.countDocuments(filter),
    ]);
    const ids = links.map((x) => x.globalCustomerId).filter(Boolean);
    const salesIds = links.map((x) => x.salespersonId).filter(Boolean);
    const [globals, sales] = await Promise.all([
      GlobalCustomer.find({ hiddenId: { $in: ids } }).select("hiddenId legalName tradeName gstins pan mobiles emails registeredAddress").lean(),
      salesIds.length ? User.find({ tenantKey: req.auth.tenantKey, _id: { $in: salesIds } }).select("_id name mobile email").lean() : [],
    ]);
    const gm = new Map(globals.map((x) => [x.hiddenId, x]));
    const sm = new Map(sales.map((x) => [String(x._id), x]));
    return ok(res, { items: links.map((link) => ({ ...link, global: gm.get(link.globalCustomerId) || null, salesperson: sm.get(String(link.salespersonId || "")) || null })), meta: pageMeta(page, limit, total) });
  } catch (error) { return fail(res, error.message, 500); }
});

router.get("/tickets", async (req, res) => {
  const filter = { tenantKey: req.auth.tenantKey };
  if (req.query.status) filter.status = upper(req.query.status);
  if (req.query.type) filter.type = upper(req.query.type);
  const items = await CustomerSupportTicket.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  return ok(res, { items });
});
router.patch("/tickets/:id", async (req, res) => {
  const ticket = await CustomerSupportTicket.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey });
  if (!ticket) return fail(res, "Complaint not found", 404);
  if (req.body.status) ticket.status = upper(req.body.status);
  if (req.body.resolution !== undefined) ticket.resolution = clean(req.body.resolution);
  if (req.body.reply) ticket.replies.push({ byType: "DMS", byId: req.auth.sub, byName: req.auth.name || "DMS", message: clean(req.body.reply), at: new Date() });
  if (["RESOLVED", "CLOSED"].includes(ticket.status)) ticket.resolvedAt = new Date();
  await ticket.save();
  return ok(res, ticket, "Complaint updated");
});

router.get("/damage-claims", async (req, res) => {
  const filter = { tenantKey: req.auth.tenantKey };
  if (req.query.status) filter.status = upper(req.query.status);
  const items = await CustomerDamageClaim.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  return ok(res, { items });
});
router.patch("/damage-claims/:id", async (req, res) => {
  const claim = await CustomerDamageClaim.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey });
  if (!claim) return fail(res, "Damage claim not found", 404);
  if (req.body.status) claim.status = upper(req.body.status);
  if (req.body.resolution !== undefined) claim.resolution = clean(req.body.resolution);
  if (req.body.approvedAmount !== undefined) claim.approvedAmount = Number(req.body.approvedAmount || 0);
  claim.reviewedBy = req.auth.sub; claim.reviewedByName = req.auth.name || ""; claim.reviewedAt = new Date();
  await claim.save();
  return ok(res, claim, "Damage claim updated");
});

router.get("/promotions", async (req, res) => {
  const items = await CustomerPromotion.find({ tenantKey: req.auth.tenantKey }).sort({ createdAt: -1 }).limit(500).lean();
  return ok(res, { items });
});
router.post("/promotions", async (req, res) => {
  if (!isAdminAuth(req.auth)) return fail(res, "Admin permission required", 403);
  const title = clean(req.body.title); if (!title) return fail(res, "Promotion title is required", 400);
  const doc = await CustomerPromotion.create({
    tenantKey: req.auth.tenantKey, promotionId: makeId("PROMO"), title, subtitle: clean(req.body.subtitle), description: clean(req.body.description), terms: clean(req.body.terms), bannerUrl: clean(req.body.bannerUrl), bannerFileId: clean(req.body.bannerFileId), startAt: req.body.startAt ? new Date(req.body.startAt) : new Date(), endAt: req.body.endAt ? new Date(req.body.endAt) : null, status: ["DRAFT", "ACTIVE", "PAUSED", "EXPIRED"].includes(upper(req.body.status)) ? upper(req.body.status) : "DRAFT", audience: ["ALL", "GRADE", "CUSTOMERS"].includes(upper(req.body.audience)) ? upper(req.body.audience) : "ALL", gradeCodes: Array.isArray(req.body.gradeCodes) ? req.body.gradeCodes.map(upper).filter(Boolean) : [], customerGlobalIds: Array.isArray(req.body.customerGlobalIds) ? req.body.customerGlobalIds.map(clean).filter(Boolean) : [], scheme: req.body.scheme || {}, createdBy: req.auth.sub,
  });
  return ok(res, doc, "Promotion created", 201);
});
router.patch("/promotions/:id", async (req, res) => {
  if (!isAdminAuth(req.auth)) return fail(res, "Admin permission required", 403);
  const doc = await CustomerPromotion.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey }); if (!doc) return fail(res, "Promotion not found", 404);
  for (const key of ["title", "subtitle", "description", "terms", "bannerUrl", "bannerFileId"]) if (req.body[key] !== undefined) doc[key] = clean(req.body[key]);
  if (req.body.status) doc.status = upper(req.body.status); if (req.body.audience) doc.audience = upper(req.body.audience); if (req.body.startAt !== undefined) doc.startAt = req.body.startAt ? new Date(req.body.startAt) : null; if (req.body.endAt !== undefined) doc.endAt = req.body.endAt ? new Date(req.body.endAt) : null; if (Array.isArray(req.body.gradeCodes)) doc.gradeCodes = req.body.gradeCodes.map(upper).filter(Boolean); if (Array.isArray(req.body.customerGlobalIds)) doc.customerGlobalIds = req.body.customerGlobalIds.map(clean).filter(Boolean); if (req.body.scheme !== undefined) doc.scheme = req.body.scheme || {}; doc.updatedBy = req.auth.sub; await doc.save(); return ok(res, doc, "Promotion updated");
});

export default router;
