import express from "express";
import { Group } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { sanitizePermissionCodes } from "../config/permissionCatalogue.js";

const router = express.Router();
router.use(requireAuth);

const normalizeCode = (value) => String(value || "")
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, "_")
  .replace(/^_|_$/g, "");

const cleanPermissions = (value = []) =>
  sanitizePermissionCodes(value).filter((code) => String(code).startsWith("dms."));

const tenantKeyFor = (req) => String(req.auth?.tenantKey || "demo");

const requireMaster = (req, res, next) => {
  if (req.auth?.role !== "MASTER") {
    return fail(res, "MASTER access required", 403);
  }
  return next();
};

router.use(requireMaster);

const payloadFrom = (body = {}, fallback = {}) => ({
  name: String(body.name ?? fallback.name ?? "").trim(),
  code: normalizeCode(body.code ?? fallback.code ?? body.name ?? fallback.name),
  description: String(body.description ?? fallback.description ?? "").trim(),
  permissions: cleanPermissions(body.permissions ?? fallback.permissions ?? []),
  status: String(body.status ?? fallback.status ?? "ACTIVE").toUpperCase() === "INACTIVE"
    ? "INACTIVE"
    : "ACTIVE"
});

const cleanedTenants = new Set();
const cleanupLegacyFields = async (tenantKey) => {
  if (cleanedTenants.has(tenantKey)) return;
  await Group.collection.updateMany(
    { tenantKey },
    { $unset: { groupType: "", parentGroupId: "", sortOrder: "" } }
  );
  cleanedTenants.add(tenantKey);
};

router.get("/", async (req, res) => {
  const tenantKey = tenantKeyFor(req);
  await cleanupLegacyFields(tenantKey);

  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const q = String(req.query.q || "").trim();
  const status = String(req.query.status || "").trim().toUpperCase();

  const filter = { tenantKey };
  if (["ACTIVE", "INACTIVE"].includes(status)) filter.status = status;

  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");
    filter.$or = [{ name: rx }, { code: rx }, { description: rx }];
  }

  const [items, total] = await Promise.all([
    Group.find(filter)
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Group.countDocuments(filter)
  ]);

  const cleanItems = items.map((row) => ({
    ...row,
    permissions: cleanPermissions(row.permissions || [])
  }));

  return ok(res, { items: cleanItems, meta: pageMeta(page, limit, total) });
});

router.get("/options", async (req, res) => {
  const tenantKey = tenantKeyFor(req);
  await cleanupLegacyFields(tenantKey);

  const rows = (await Group.find({ tenantKey, status: "ACTIVE" })
    .select("name code description permissions status")
    .sort({ name: 1 })
    .lean()).map((row) => ({
      ...row,
      permissions: cleanPermissions(row.permissions || [])
    }));

  return ok(res, rows);
});

router.post("/", async (req, res) => {
  const tenantKey = tenantKeyFor(req);
  await cleanupLegacyFields(tenantKey);

  const payload = payloadFrom(req.body);
  if (!payload.name || !payload.code) {
    return fail(res, "Group name and code are required", 400);
  }

  try {
    const row = await Group.create({
      ...payload,
      tenantKey,
      createdBy: String(req.auth?.sub || "")
    });

    return ok(res, row.toObject(), "Group created", 201);
  } catch (error) {
    if (error?.code === 11000) {
      return fail(res, "A group with this code already exists", 409);
    }
    throw error;
  }
});

router.put("/:id", async (req, res) => {
  const tenantKey = tenantKeyFor(req);
  await cleanupLegacyFields(tenantKey);

  const row = await Group.findOne({ _id: req.params.id, tenantKey });
  if (!row) return fail(res, "Group not found", 404);

  const payload = payloadFrom(req.body, row.toObject());
  if (!payload.name || !payload.code) {
    return fail(res, "Group name and code are required", 400);
  }

  try {
    Object.assign(row, payload, { updatedBy: String(req.auth?.sub || "") });
    await row.save();
    return ok(res, row.toObject(), "Group updated");
  } catch (error) {
    if (error?.code === 11000) {
      return fail(res, "A group with this code already exists", 409);
    }
    throw error;
  }
});

router.delete("/:id", async (req, res) => {
  const tenantKey = tenantKeyFor(req);
  await cleanupLegacyFields(tenantKey);

  const row = await Group.findOne({ _id: req.params.id, tenantKey });
  if (!row) return fail(res, "Group not found", 404);

  await row.deleteOne();
  return ok(res, { deleted: true }, "Group deleted");
});

export default router;
