import mongoose from "mongoose";
import { CompanyProfile, GlobalCustomer, TenantKeyAlias, TenantMigration } from "../models/index.js";
import { getTenantDbName } from "../config/db.js";
import { makeId } from "../utils/ids.js";
import { isTenantKeyReserved, recordTenantKeyAlias } from "./tenantKeyService.js";
import { beginTenantMigrationLock, endTenantMigrationLock } from "./tenantMigrationLock.js";

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EXCLUDED_MASTER_COLLECTIONS = new Set(["tenantkeyaliases", "tenantmigrations"]);
const BATCH_SIZE = 500;

const clean = (value) => String(value ?? "").trim();
export const normalizeCompanyGstin = (value) => clean(value).toUpperCase();
export const validCompanyGstin = (value) => GSTIN_RE.test(normalizeCompanyGstin(value));

const httpError = (message, status = 400, code = "") => {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
};

export function gstChangeConfirmation(profile, nextGstin) {
  const oldGstin = normalizeCompanyGstin(profile?.gstin || profile?.tenantKey);
  const newGstin = normalizeCompanyGstin(nextGstin);
  return {
    code: "GST_CHANGE_CONFIRMATION_REQUIRED",
    oldGstin,
    newGstin,
    oldTenantKey: clean(profile?.tenantKey),
    newTenantKey: newGstin,
    question: "GST Number changed. Do you want to move all company data from the old tenantKey to the new GST tenantKey?",
    choices: {
      yes: "Set migrateTenantData=true to move master data and every financial-year database to the new tenantKey.",
      no: "Set migrateTenantData=false to change only the company GSTIN and keep the existing tenantKey/data location.",
    },
  };
}

function replaceTenantKeys(value, oldKey, newKey) {
  if (Array.isArray(value)) return value.map((item) => replaceTenantKeys(item, oldKey, newKey));
  if (!value || typeof value !== "object" || value instanceof Date || Buffer.isBuffer(value)) return value;
  // Preserve BSON values such as ObjectId, Decimal128, Binary and Timestamp.
  if (value._bsontype) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto && proto !== Object.prototype) return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "tenantKey" && clean(item) === oldKey) output[key] = newKey;
    else output[key] = replaceTenantKeys(item, oldKey, newKey);
  }
  return output;
}

function indexKeyForCreate(index = {}) {
  const key = index?.key || {};
  // MongoDB listIndexes represents text indexes internally as _fts/_ftsx.
  // Recreate them from the public weights map instead of using internal keys.
  if (key._fts === "text" && index.weights && typeof index.weights === "object") {
    return Object.fromEntries(Object.keys(index.weights).map((field) => [field, "text"]));
  }
  return key;
}

function safeIndexOptions(index = {}, oldKey = "", newKey = "") {
  const options = {};
  for (const key of [
    "name", "unique", "sparse", "expireAfterSeconds", "partialFilterExpression", "collation",
    "weights", "default_language", "language_override", "textIndexVersion", "2dsphereIndexVersion",
    "bits", "min", "max", "wildcardProjection", "hidden",
  ]) {
    if (index[key] !== undefined) options[key] = index[key];
  }
  return oldKey && newKey ? replaceTenantKeys(options, oldKey, newKey) : options;
}

async function copyCollection({ sourceDb, targetDb, name, oldKey, newKey }) {
  const source = sourceDb.collection(name);
  const target = targetDb.collection(name);
  let copied = 0;
  let batch = [];

  const cursor = source.find({}, { batchSize: BATCH_SIZE });
  for await (const doc of cursor) {
    batch.push(replaceTenantKeys(doc, oldKey, newKey));
    if (batch.length >= BATCH_SIZE) {
      await target.insertMany(batch, { ordered: true });
      copied += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await target.insertMany(batch, { ordered: true });
    copied += batch.length;
  }

  // Preserve all non-_id indexes after the documents are copied.
  // This avoids index-maintenance overhead while copying large FY databases.
  const indexes = await source.indexes().catch(() => []);
  for (const index of indexes) {
    if (index.name === "_id_" || !index.key) continue;
    await target.createIndex(indexKeyForCreate(index), safeIndexOptions(index, oldKey, newKey));
  }

  const targetCount = await target.countDocuments({});
  if (targetCount !== copied) {
    throw httpError(`Verification failed while copying ${sourceDb.databaseName}.${name}: expected ${copied}, found ${targetCount}`, 500, "TENANT_MIGRATION_COPY_VERIFY_FAILED");
  }
  if (await target.countDocuments({ tenantKey: oldKey }, { limit: 1 })) {
    throw httpError(`Old tenantKey remained in copied collection ${targetDb.databaseName}.${name}`, 500, "TENANT_MIGRATION_TENANT_VERIFY_FAILED");
  }
  return copied;
}

async function databaseHasDocuments(db) {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    if (await db.collection(name).countDocuments({}, { limit: 1 })) return true;
  }
  return false;
}

async function discoverFinancialDatabases(oldKey, financialYears = []) {
  const client = mongoose.connection.getClient();
  const oldBase = getTenantDbName(oldKey);
  const discovered = new Set();

  try {
    const result = await client.db().admin().listDatabases({ nameOnly: true });
    for (const row of result?.databases || []) {
      const name = clean(row?.name);
      if (name.startsWith(`${oldBase}_`)) discovered.add(name);
    }
  } catch (error) {
    // Some managed MongoDB users cannot list every database. Fall back to the
    // company's enabled FY list, which is the normal source of truth.
    console.warn("[tenant migration] listDatabases unavailable; using financialYears fallback:", error?.message || error);
  }

  for (const fy of Array.isArray(financialYears) ? financialYears : []) {
    const normalized = clean(fy).replace(/[^0-9-]/g, "");
    if (normalized) discovered.add(`${oldBase}_${normalized}`);
  }
  return [...discovered].sort();
}

async function preflightMasterTarget(mainDb, newKey, companyProfileId) {
  const duplicateProfile = await CompanyProfile.findOne({
    _id: { $ne: companyProfileId },
    $or: [{ tenantKey: newKey }, { gstin: newKey }],
  }).select("_id tenantKey gstin companyName").lean();
  if (duplicateProfile) {
    throw httpError("The new GSTIN/tenantKey is already used by another company", 409, "TENANT_KEY_ALREADY_EXISTS");
  }

  if (await isTenantKeyReserved(newKey, { companyProfileId })) {
    throw httpError("The new GSTIN is reserved by an existing tenant migration history", 409, "TENANT_KEY_RESERVED");
  }

  const collectionInfos = await mainDb.listCollections({}, { nameOnly: true }).toArray();
  const conflicts = [];
  for (const { name } of collectionInfos) {
    if (name.startsWith("system.") || EXCLUDED_MASTER_COLLECTIONS.has(name)) continue;
    const count = await mainDb.collection(name).countDocuments({ tenantKey: newKey }, { limit: 1 });
    if (count) conflicts.push(name);
  }
  if (conflicts.length) {
    throw httpError(`The target tenantKey already has data in: ${conflicts.join(", ")}`, 409, "TENANT_TARGET_DATA_EXISTS");
  }
}

async function migrateGlobalCustomerLinks(oldKey, newKey) {
  let changed = 0;
  const cursor = GlobalCustomer.find({ "linkedTenants.tenantKey": oldKey }).cursor();
  for await (const customer of cursor) {
    const rows = Array.isArray(customer.linkedTenants) ? customer.linkedTenants : [];
    const existingNew = rows.find((row) => clean(row?.tenantKey) === newKey);
    let keptNew = false;
    const next = [];
    for (const row of rows) {
      const key = clean(row?.tenantKey);
      if (key === oldKey || key === newKey) {
        if (!keptNew) {
          next.push({ tenantKey: newKey, linkedAt: existingNew?.linkedAt || row?.linkedAt || new Date() });
          keptNew = true;
        }
      } else {
        next.push(row);
      }
    }
    customer.linkedTenants = next;
    await customer.save();
    changed += 1;
  }
  return changed;
}

async function migrateMasterCollections(mainDb, oldKey, newKey) {
  const collectionInfos = await mainDb.listCollections({}, { nameOnly: true }).toArray();
  const results = [];
  const changedCollections = [];

  try {
    for (const { name } of collectionInfos) {
      if (name.startsWith("system.") || EXCLUDED_MASTER_COLLECTIONS.has(name)) continue;
      const collection = mainDb.collection(name);
      const matched = await collection.countDocuments({ tenantKey: oldKey });
      if (!matched) continue;
      const outcome = await collection.updateMany({ tenantKey: oldKey }, { $set: { tenantKey: newKey } });
      const modified = Number(outcome.modifiedCount || 0);
      results.push({ name, matched, modified });
      changedCollections.push(name);

      const remaining = await collection.countDocuments({ tenantKey: oldKey }, { limit: 1 });
      if (remaining) throw httpError(`Old tenantKey remained in master collection ${name}`, 500, "TENANT_MIGRATION_MASTER_VERIFY_FAILED");
    }
  } catch (error) {
    // The target was verified empty before migration, so reversing only the
    // collections changed in this attempt is safe and prevents a split tenant.
    for (const name of changedCollections.reverse()) {
      await mainDb.collection(name).updateMany({ tenantKey: newKey }, { $set: { tenantKey: oldKey } }).catch(() => {});
    }
    throw error;
  }

  return results;
}

async function copyFinancialDatabases({ sourceNames, oldKey, newKey, allowTargetCleanup = false }) {
  const client = mongoose.connection.getClient();
  const oldBase = getTenantDbName(oldKey);
  const newBase = getTenantDbName(newKey);
  const results = [];

  for (const sourceName of sourceNames) {
    if (!sourceName.startsWith(`${oldBase}_`)) continue;
    const suffix = sourceName.slice(oldBase.length);
    const targetName = `${newBase}${suffix}`;
    const sourceDb = client.db(sourceName);
    const targetDb = client.db(targetName);

    if (await databaseHasDocuments(targetDb)) {
      if (!allowTargetCleanup) {
        throw httpError(`Target financial-year database already contains data: ${targetName}`, 409, "TENANT_TARGET_FY_DATA_EXISTS");
      }
      // A previous failed/stale migration for the same old->new tenant pair may
      // leave a partial target copy. Preflight already proved the new tenant is
      // not active in MASTER data, so this orphan target is safe to rebuild.
      await targetDb.dropDatabase();
    } else {
      // Remove empty/stale target collections/indexes from an earlier aborted attempt.
      await targetDb.dropDatabase().catch(() => {});
    }

    const collections = (await sourceDb.listCollections({}, { nameOnly: true }).toArray())
      .map((row) => row.name)
      .filter((name) => !name.startsWith("system."));

    let sourceDocuments = 0;
    let copiedDocuments = 0;
    for (const name of collections) {
      const count = await sourceDb.collection(name).countDocuments({});
      sourceDocuments += count;
      copiedDocuments += await copyCollection({ sourceDb, targetDb, name, oldKey, newKey });
    }

    if (sourceDocuments !== copiedDocuments) {
      throw httpError(`Financial-year database verification failed for ${sourceName}`, 500, "TENANT_MIGRATION_FY_VERIFY_FAILED");
    }
    results.push({ source: sourceName, target: targetName, sourceDocuments, copiedDocuments, collections: collections.length, sourceDropped: false, backupRetained: true, error: "" });
  }
  return results;
}

async function dropSourceFinancialDatabases(rows) {
  const client = mongoose.connection.getClient();
  let retained = false;
  for (const row of rows) {
    try {
      await client.db(row.source).dropDatabase();
      row.sourceDropped = true;
      row.backupRetained = false;
    } catch (error) {
      // The new tenant is already active and verified. A failure to remove an
      // old source DB is non-fatal; keep it as a rollback backup and report it.
      row.sourceDropped = false;
      row.backupRetained = true;
      row.error = error?.message || "Unable to remove old FY database";
      retained = true;
    }
  }
  return retained;
}

export async function migrateCompanyTenantKey({ companyProfileId, oldTenantKey, newGstin, actorId = "", actorRole = "" }) {
  const oldKey = clean(oldTenantKey);
  const newKey = normalizeCompanyGstin(newGstin);
  if (!oldKey) throw httpError("Current tenantKey is missing", 409, "TENANT_KEY_MISSING");
  if (!validCompanyGstin(newKey)) throw httpError("Enter a valid 15-character GSTIN", 400, "INVALID_GSTIN");
  if (oldKey === newKey) return { changed: false, oldTenantKey: oldKey, newTenantKey: newKey };

  const profile = await CompanyProfile.findById(companyProfileId).lean();
  if (!profile) throw httpError("Company profile not found", 404, "COMPANY_NOT_FOUND");
  if (clean(profile.tenantKey) !== oldKey) {
    throw httpError("Company tenantKey changed before this migration started. Reload and try again.", 409, "TENANT_CHANGED_CONCURRENTLY");
  }

  const running = await TenantMigration.findOne({ oldTenantKey: oldKey, status: "RUNNING" }).sort({ createdAt: -1 });
  if (running) {
    const ageMs = Date.now() - new Date(running.startedAt || running.createdAt || 0).getTime();
    if (ageMs < 30 * 60 * 1000) {
      throw httpError("A tenant migration is already running for this company", 423, "TENANT_MIGRATION_RUNNING");
    }
    running.status = "FAILED";
    running.phase = "STALE_PROCESS_INTERRUPTED";
    running.error = "Previous migration was marked stale after 30 minutes without completion";
    running.completedAt = new Date();
    await running.save();
  }

  const priorFailedMigration = await TenantMigration.exists({
    oldTenantKey: oldKey, newTenantKey: newKey, status: "FAILED",
  });

  const migration = await TenantMigration.create({
    migrationId: makeId("TNM"),
    companyProfileId: String(profile._id),
    oldTenantKey: oldKey,
    newTenantKey: newKey,
    oldGstin: normalizeCompanyGstin(profile.gstin || oldKey),
    newGstin: newKey,
    requestedBy: clean(actorId),
    requestedByRole: clean(actorRole),
    status: "RUNNING",
    phase: "PREFLIGHT",
    startedAt: new Date(),
  });

  beginTenantMigrationLock(oldKey);
  const mainDb = mongoose.connection.db;
  let financialRows = [];
  let masterRows = [];
  try {
    await preflightMasterTarget(mainDb, newKey, String(profile._id));

    migration.phase = "DISCOVER_FINANCIAL_DATABASES";
    await migration.save();
    const sourceNames = await discoverFinancialDatabases(oldKey, profile.financialYears?.length ? profile.financialYears : [profile.financialYear].filter(Boolean));

    migration.phase = "COPY_FINANCIAL_DATABASES";
    await migration.save();
    financialRows = await copyFinancialDatabases({ sourceNames, oldKey, newKey, allowTargetCleanup: Boolean(priorFailedMigration) });
    migration.financialDatabases = financialRows;
    await migration.save();

    migration.phase = "MOVE_MASTER_COLLECTIONS";
    await migration.save();
    masterRows = await migrateMasterCollections(mainDb, oldKey, newKey);
    migration.masterCollections = masterRows;
    await migration.save();

    // Create the compatibility alias immediately after the master switch.
    // This keeps already-issued JWTs and signed vendor links working even if
    // a later non-critical cleanup step encounters an error.
    migration.phase = "CREATE_ALIAS";
    await migration.save();
    await recordTenantKeyAlias({
      oldTenantKey: oldKey,
      newTenantKey: newKey,
      companyProfileId: String(profile._id),
      oldGstin: profile.gstin || oldKey,
      newGstin: newKey,
      changedBy: actorId,
    });

    // Make the legal GST identity explicit even though tenantKey has already
    // been moved by the generic master-collection migration.
    await CompanyProfile.updateOne(
      { _id: profile._id, tenantKey: newKey },
      { $set: { gstin: newKey, tenantKey: newKey } },
    );

    migration.phase = "UPDATE_GLOBAL_LINKS";
    await migration.save();
    await migrateGlobalCustomerLinks(oldKey, newKey);

    migration.phase = "REMOVE_OLD_FINANCIAL_DATABASES";
    await migration.save();
    const sourceDatabasesRetained = await dropSourceFinancialDatabases(financialRows);

    migration.status = "COMPLETED";
    migration.phase = "COMPLETED";
    migration.financialDatabases = financialRows;
    migration.masterCollections = masterRows;
    migration.sourceDatabasesRetained = sourceDatabasesRetained;
    migration.completedAt = new Date();
    migration.error = "";
    await migration.save();
    return {
      changed: true,
      migrationId: migration.migrationId,
      oldTenantKey: oldKey,
      newTenantKey: newKey,
      oldGstin: normalizeCompanyGstin(profile.gstin || oldKey),
      newGstin: newKey,
      masterCollections: masterRows,
      financialDatabases: financialRows,
      sourceDatabasesRetained,
      sessionAliasCreated: true,
    };
  } catch (error) {
    migration.status = "FAILED";
    migration.phase = migration.phase || "FAILED";
    migration.error = error?.message || "Tenant migration failed";
    migration.financialDatabases = financialRows;
    migration.masterCollections = masterRows;
    migration.completedAt = new Date();
    await migration.save().catch(() => {});

    // If the master tenant switch never completed, target FY databases are only
    // copies and can be removed safely to leave the old tenant fully intact.
    const switched = await CompanyProfile.exists({ _id: profile._id, tenantKey: newKey });
    if (!switched) {
      const client = mongoose.connection.getClient();
      for (const row of financialRows) await client.db(row.target).dropDatabase().catch(() => {});
      throw error;
    }

    // If the MASTER switch already happened, the active tenant is the new key.
    // Do not report a hard failure that could tempt the caller to retry the move
    // against an already-migrated company. Repair critical identity pieces and
    // return a completed-with-warning result instead.
    const warnings = [error?.message || "A post-migration cleanup step failed"];
    let sessionAliasCreated = true;
    await recordTenantKeyAlias({
      oldTenantKey: oldKey, newTenantKey: newKey, companyProfileId: String(profile._id),
      oldGstin: profile.gstin || oldKey, newGstin: newKey, changedBy: actorId,
    }).catch((repairError) => { sessionAliasCreated = false; warnings.push(`Alias repair: ${repairError?.message || repairError}`); });
    await CompanyProfile.updateOne({ _id: profile._id }, { $set: { tenantKey: newKey, gstin: newKey } })
      .catch((repairError) => warnings.push(`Company identity repair: ${repairError?.message || repairError}`));

    migration.status = "COMPLETED";
    migration.phase = "COMPLETED_WITH_WARNINGS";
    migration.error = warnings.join(" | ");
    migration.completedAt = new Date();
    migration.financialDatabases = financialRows;
    migration.masterCollections = masterRows;
    migration.sourceDatabasesRetained = true;
    await migration.save().catch(() => {});
    return {
      changed: true,
      migrationId: migration.migrationId,
      oldTenantKey: oldKey,
      newTenantKey: newKey,
      oldGstin: normalizeCompanyGstin(profile.gstin || oldKey),
      newGstin: newKey,
      masterCollections: masterRows,
      financialDatabases: financialRows,
      sourceDatabasesRetained: true,
      sessionAliasCreated,
      warnings,
    };
  } finally {
    endTenantMigrationLock(oldKey);
  }
}

export async function validateGstinChangeTarget({ profile, nextGstin }) {
  const newGstin = normalizeCompanyGstin(nextGstin);
  if (!validCompanyGstin(newGstin)) throw httpError("Enter a valid 15-character GSTIN", 400, "INVALID_GSTIN");
  if (!profile) throw httpError("Company profile not found", 404, "COMPANY_NOT_FOUND");
  if (newGstin === normalizeCompanyGstin(profile.gstin)) return { changed: false, newGstin };

  const duplicate = await CompanyProfile.findOne({
    _id: { $ne: profile._id },
    $or: [{ gstin: newGstin }, { tenantKey: newGstin }],
  }).select("_id companyName gstin tenantKey").lean();
  if (duplicate) throw httpError("This GSTIN is already assigned to another company", 409, "GSTIN_ALREADY_EXISTS");

  if (await TenantKeyAlias.exists({ oldTenantKey: newGstin, status: "ACTIVE" })) {
    throw httpError("This GSTIN is an old tenant identity reserved by migration history", 409, "GSTIN_RESERVED_BY_MIGRATION");
  }
  return { changed: true, newGstin };
}
