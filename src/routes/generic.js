import express from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import { GenericRecord } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { readRows, genericRowFromSpreadsheet, cleanText } from "../utils/bulkSpreadsheet.js";
import { warehouseReferenceDetails } from "../services/referenceIntegrityService.js";

const router = express.Router();
router.use(requireAuth);
router.use("/:module", (req, res, next) => {
  if (req.auth?.role === "MASTER" || (req.auth?.apps || []).includes(req.params.module)) return next();
  return fail(res, `${req.params.module} is not enabled for this user`, 403);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const valid = (v) => /^[a-z0-9-]+$/i.test(String(v || ""));
const baseFilter = (req) => ({ tenantKey: req.auth.tenantKey, app: req.params.module, resource: req.params.resource });
const standard = new Set(["title", "reference", "status", "date", "amount", "quantity", "assignedTo", "notes", "tags"]);

function normalizedPayload(body = {}) {
  const data = { ...(body.data || {}) };
  for (const [key, value] of Object.entries(body)) if (!standard.has(key) && key !== "data") data[key] = value;
  return {
    reference: body.reference,
    title: body.title || body.name,
    status: body.status,
    date: body.date,
    amount: body.amount === undefined ? undefined : Number(body.amount || 0),
    quantity: body.quantity === undefined ? undefined : Number(body.quantity || 0),
    assignedTo: body.assignedTo,
    notes: body.notes,
    tags: body.tags,
    data
  };
}

const warehouseRoute = (req) => req.params.module === "dms" && req.params.resource === "warehouses";
const isMain = (v) => v === true || String(v || "").toUpperCase() === "YES" || String(v || "").toLowerCase() === "true";
const managerAllowed = (req) => ["MASTER","SUPERADMIN"].includes(String(req.auth?.role || "").toUpperCase());
const publicWarehouse = (row) => {
  const obj = row?.toObject ? row.toObject() : { ...row };
  obj.data = { ...(obj.data || {}) };
  delete obj.data.passwordHash;
  delete obj.data.loginPassword;
  delete obj.data.password;
  return obj;
};
async function validateWarehouseWrite(req, payload, existing = null) {
  if (!warehouseRoute(req)) return;
  if (!managerAllowed(req)) throw Object.assign(new Error("Only Superadmin can manage warehouse credentials and the Main Warehouse"),{statusCode:403});
  const data = payload.data || {};
  const wantMain = isMain(data.isMainWarehouse);
  const wasMain = existing && isMain(existing.data?.isMainWarehouse);
  if (existing && wasMain && !wantMain) throw Object.assign(new Error("The permanent Main Warehouse cannot be unset"),{statusCode:409});
  if (existing && wasMain && String(payload.status || existing.status).toUpperCase() !== "ACTIVE") throw Object.assign(new Error("The permanent Main Warehouse cannot be deactivated"),{statusCode:409});
  if (wantMain && !wasMain) {
    const other = await GenericRecord.findOne({tenantKey:req.auth.tenantKey,app:"dms",resource:"warehouses","data.isMainWarehouse":true,_id:{$ne:existing?._id || null}}).lean();
    if (other) throw Object.assign(new Error(`Main Warehouse is permanently set to ${other.title}. It cannot be changed.`),{statusCode:409});
  }
  const pass = String(data.loginPassword || data.password || "");
  delete data.loginPassword; delete data.password;
  delete data.passwordHash; // Never accept a client-supplied hash.
  if (pass) {
    if (pass.length < 8) throw Object.assign(new Error("Warehouse password must be at least 8 characters"),{statusCode:400});
    data.passwordHash = await bcrypt.hash(pass,12);
  } else if (existing?.data?.passwordHash) data.passwordHash = existing.data.passwordHash;
  data.loginEmail = String(data.loginEmail || data.contactEmail || existing?.data?.loginEmail || "").trim().toLowerCase();
  if (!data.loginEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.loginEmail)) throw Object.assign(new Error("A valid warehouse app login email is required"),{statusCode:400});
  if (!data.passwordHash) throw Object.assign(new Error("Set an app login password for the warehouse"),{statusCode:400});
  if (wantMain) data.isMainWarehouse = true; else data.isMainWarehouse = false;
  const duplicate = await GenericRecord.findOne({app:"dms",resource:"warehouses","data.loginEmail":data.loginEmail,_id:{$ne:existing?._id || null}}).lean();
  if (duplicate) throw Object.assign(new Error("Warehouse app login email must be unique across all companies"),{statusCode:409});
}

function selectionFilter(req, selection = {}) {
  const ids = (selection.ids || []).filter(Boolean);
  const filter = { ...baseFilter(req) };
  if (ids.length) filter._id = { $in: ids };
  else if (selection.allFiltered) {
    const q = cleanText(selection.q);
    if (selection.status) filter.status = selection.status;
    if (q) filter.$or = [
      { title: new RegExp(q, "i") },
      { reference: new RegExp(q, "i") },
      { notes: new RegExp(q, "i") },
      { "data.name": new RegExp(q, "i") }
    ];
  } else return null;
  return filter;
}

router.get("/:module/:resource", async (req, res) => {
  if (!valid(req.params.module) || !valid(req.params.resource)) return fail(res, "Invalid module/resource");
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));
  const q = String(req.query.q || "").trim();
  const f = baseFilter(req);
  if (req.query.status) f.status = req.query.status;
  if (q) f.$or = [{ title: new RegExp(q, "i") }, { reference: new RegExp(q, "i") }, { notes: new RegExp(q, "i") }, { "data.name": new RegExp(q, "i") }];
  // Date-bearing generic-resource lists are filtered in MongoDB before pagination.
  // Do not apply a period to global master data or to pages without a Date field.
  if (req.query.fromDate || req.query.toDate) {
    const from = String(req.query.fromDate || "");
    const to = String(req.query.toDate || "");
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
      && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
      && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    if (!validDate(from) || !validDate(to) || from > to) return fail(res, "Invalid date range", 400);
    const end = new Date(`${to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const period = { $gte: new Date(`${from}T00:00:00.000Z`), $lt: end };
    f.$and = [{ $or: [
      { date: period },
      { date: null, createdAt: period }
    ] }];
  }
  const [items, total] = await Promise.all([
    GenericRecord.find(f).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    GenericRecord.countDocuments(f)
  ]);
  ok(res, { module: req.params.module, resource: req.params.resource, items: warehouseRoute(req) ? items.map(publicWarehouse) : items, meta: pageMeta(page, limit, total) });
});

router.post("/:module/:resource", async (req, res) => {
  if (!valid(req.params.module) || !valid(req.params.resource)) return fail(res, "Invalid module/resource");
  const title = String(req.body.title || req.body.name || req.body.reference || "").trim();
  if (!title) return fail(res, "Name / title is required");
  const p = normalizedPayload(req.body);
  try { await validateWarehouseWrite(req,p); } catch (e) { return fail(res,e.message,e.statusCode||500); }
  const item = await GenericRecord.create({
    tenantKey: req.auth.tenantKey,
    app: req.params.module,
    resource: req.params.resource,
    reference: p.reference || makeId(req.params.resource.slice(0, 5).toUpperCase()),
    title,
    status: p.status || "ACTIVE",
    date: p.date || undefined,
    amount: Number(p.amount || 0),
    quantity: Number(p.quantity || 0),
    assignedTo: p.assignedTo || "",
    notes: p.notes || "",
    tags: p.tags || [],
    data: p.data || {},
    createdBy: req.auth.sub,
    updatedBy: req.auth.sub
  });
  ok(res, warehouseRoute(req) ? publicWarehouse(item) : item, "Record created", 201);
});

// Generic spreadsheet import for all normal MASTER / DMS / HR / Production lists.
router.post("/:module/:resource/bulk-upload", upload.single("file"), async (req, res) => {
  if (warehouseRoute(req)) return fail(res,"Create warehouses using the secured form; bulk imports cannot set credentials or main status",403);
  if (!req.file?.buffer) return fail(res, "Excel/CSV file is required", 400);
  let rows;
  try { rows = readRows(req.file.buffer); } catch { return fail(res, "Unable to read Excel/CSV file", 400); }
  if (!rows.length) return fail(res, "Uploaded file has no rows", 400);

  let schema = [];
  try { schema = JSON.parse(req.body.schema || "[]"); } catch { return fail(res, "Invalid upload schema", 400); }
  if (!Array.isArray(schema) || !schema.length) return fail(res, "Upload schema is required", 400);

  const errors = [], prepared = [];
  for (let i = 0; i < rows.length; i++) {
    const value = genericRowFromSpreadsheet(rows[i], schema);
    const title = cleanText(value.title || value.name || value.reference);
    if (!title) {
      if (errors.length < 100) errors.push({ row: i + 2, error: "Name / Title or Reference is required" });
      continue;
    }
    const p = normalizedPayload({ ...value, title });
    prepared.push({
      tenantKey: req.auth.tenantKey,
      app: req.params.module,
      resource: req.params.resource,
      reference: cleanText(p.reference) || makeId(req.params.resource.slice(0, 5).toUpperCase()),
      title,
      status: cleanText(p.status) || "ACTIVE",
      date: p.date || undefined,
      amount: Number(p.amount || 0),
      quantity: Number(p.quantity || 0),
      assignedTo: cleanText(p.assignedTo),
      notes: cleanText(p.notes),
      tags: Array.isArray(p.tags) ? p.tags : [],
      data: p.data || {},
      createdBy: req.auth.sub,
      updatedBy: req.auth.sub
    });
  }
  if (!prepared.length) return fail(res, "No valid rows were found", 400, { errors });

  let inserted = 0, updated = 0;
  for (let i = 0; i < prepared.length; i += 1000) {
    const batch = prepared.slice(i, i + 1000);
    const result = await GenericRecord.bulkWrite(batch.map((row) => ({ updateOne: {
      filter: row.reference
        ? { tenantKey: row.tenantKey, app: row.app, resource: row.resource, reference: row.reference }
        : { tenantKey: row.tenantKey, app: row.app, resource: row.resource, title: row.title },
      update: { $set: { ...row, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      upsert: true
    } })), { ordered: false });
    inserted += result.upsertedCount || 0;
    updated += result.modifiedCount || 0;
  }
  return ok(res, { received: rows.length, valid: prepared.length, inserted, updated, invalid: rows.length - prepared.length, errors }, "Bulk upload completed");
});

router.post("/:module/:resource/bulk-edit", async (req, res) => {
  if (warehouseRoute(req)) return fail(res,"Warehouse changes must use the verified Warehouse form (main warehouse / credentials are protected)",403);
  const filter = selectionFilter(req, req.body.selection);
  if (!filter) return fail(res, "Select at least one record or choose all filtered records", 400);
  const raw = req.body.changes || {};
  const p = normalizedPayload(raw);
  const $set = { updatedBy: req.auth.sub };
  for (const key of ["reference", "title", "status", "date", "amount", "quantity", "assignedTo", "notes", "tags"]) {
    if (raw[key] !== undefined && raw[key] !== "") $set[key] = p[key];
  }
  for (const [key, value] of Object.entries(p.data || {})) if (value !== undefined && value !== "") $set[`data.${key}`] = value;
  if (Object.keys($set).length === 1) return fail(res, "Enter at least one value to change", 400);
  const result = await GenericRecord.updateMany(filter, { $set });
  return ok(res, { matched: result.matchedCount, updated: result.modifiedCount }, `${result.modifiedCount} record(s) updated`);
});

router.post("/:module/:resource/bulk-delete", async (req, res) => {
  if (warehouseRoute(req)) return fail(res,"Warehouse changes must use the verified Warehouse form (main warehouse / credentials are protected)",403);
  const filter = selectionFilter(req, req.body.selection);
  if (!filter) return fail(res, "Select at least one record or choose all filtered records", 400);
  if (req.params.module === "dms" && req.params.resource === "warehouses") {
    const rows = await GenericRecord.find(filter).select("_id title data").lean();
    for (const row of rows) {
      if (isMain(row.data?.isMainWarehouse)) return fail(res,"Main Warehouse cannot be deleted",409);
      const references = await warehouseReferenceDetails(req.auth.tenantKey, String(row._id));
      if (references.length) return fail(res, `${row.title || "Warehouse"} is already involved in ${references.slice(0,5).join(", ")} and cannot be deleted.`, 409);
    }
  }
  const result = await GenericRecord.deleteMany(filter);
  return ok(res, { deleted: result.deletedCount }, `${result.deletedCount} record(s) deleted`);
});

router.put("/:module/:resource/:id", async (req, res) => {
  const item = await GenericRecord.findOne({ _id: req.params.id, ...baseFilter(req) });
  if (!item) return fail(res, "Record not found", 404);
  const p = normalizedPayload(req.body);
  try { await validateWarehouseWrite(req,p,item); } catch (e) { return fail(res,e.message,e.statusCode||500); }
  const allowed = ["reference", "title", "status", "date", "amount", "quantity", "assignedTo", "notes", "tags", "data"];
  for (const k of allowed) if (p[k] !== undefined) item[k] = p[k];
  item.updatedBy = req.auth.sub;
  await item.save();
  ok(res, warehouseRoute(req) ? publicWarehouse(item) : item, "Record updated");
});

router.delete("/:module/:resource/:id", async (req, res) => {
  const filter = { _id: req.params.id, ...baseFilter(req) };
  const existing = await GenericRecord.findOne(filter).lean();
  if (!existing) return fail(res, "Record not found", 404);
  if (req.params.module === "dms" && req.params.resource === "warehouses") {
    if (isMain(existing?.data?.isMainWarehouse)) return fail(res,"Main Warehouse cannot be deleted",409);
    const references = await warehouseReferenceDetails(req.auth.tenantKey, String(existing._id));
    if (references.length) return fail(res, `${existing.title || "Warehouse"} is already involved in ${references.slice(0,5).join(", ")} and cannot be deleted.`, 409);
  }
  await GenericRecord.deleteOne(filter);
  ok(res, { deleted: true }, "Record deleted");
});

router.post("/:module/:resource/:id/status", async (req, res) => {
  const nextStatus = req.body.status || "ACTIVE";
  if (req.params.module === "dms" && req.params.resource === "warehouses" && String(nextStatus).toUpperCase() === "INACTIVE") {
    const existing = await GenericRecord.findOne({ _id: req.params.id, ...baseFilter(req) }).lean();
    if (!existing) return fail(res, "Record not found", 404);
    const references = await warehouseReferenceDetails(req.auth.tenantKey, String(existing._id));
    if (references.length) return fail(res, `${existing.title || "Warehouse"} is already involved in ${references.slice(0,5).join(", ")} and cannot be deactivated.`, 409);
  }
  if (warehouseRoute(req)) {
    const existingMain = await GenericRecord.findOne({ _id:req.params.id,...baseFilter(req) }).lean();
    if (isMain(existingMain?.data?.isMainWarehouse) && String(nextStatus).toUpperCase() !== "ACTIVE") return fail(res,"The permanent Main Warehouse cannot be deactivated",409);
  }
  const item = await GenericRecord.findOneAndUpdate({ _id: req.params.id, ...baseFilter(req) }, { status: nextStatus, updatedBy: req.auth.sub }, { new: true });
  if (!item) return fail(res, "Record not found", 404);
  ok(res, item, "Status updated");
});
export default router;
