import mongoose from "mongoose";
import { CompanyProfile, GlobalCustomer, TenantMigration } from "../models/index.js";
import { getTenantDbName } from "../config/db.js";
import { makeId } from "../utils/ids.js";
import { isTenantKeyReserved, recordTenantKeyAlias } from "./tenantKeyService.js";
import { beginTenantMigrationLock, endTenantMigrationLock } from "./tenantMigrationLock.js";
import {
  clearFinancialStorageTenantKey,
  setFinancialStorageTenantKey,
} from "./financialStorageTenantService.js";

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EXCLUDED_MASTER_COLLECTIONS = new Set(["tenantkeyaliases", "tenantmigrations"]);
const BATCH_SIZE = 500;
const FY_SUFFIX_RE = /^20\d{2}-\d{2}$/;

const clean = (value) => String(value ?? "").trim();
export const normalizeCompanyGstin = (value) => clean(value).toUpperCase();
export const validCompanyGstin = (value) => GSTIN_RE.test(normalizeCompanyGstin(value));

const httpError = (message, status = 400, code = "") => {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
};

async function collectionExists(name) {
  try {
    return await mongoose.connection.db.listCollections({ name }, { nameOnly: true }).hasNext();
  } catch {
    return false;
  }
}

async function migrationAuditAvailable() {
  return collectionExists(TenantMigration.collection.name);
}

function memoryMigration(data) {
  return {
    ...data,
    _auditPersisted: false,
    async save() { return this; },
  };
}

async function createMigrationAudit(data) {
  if (!(await migrationAuditAvailable())) return memoryMigration(data);
  return TenantMigration.create(data);
}

export function gstChangeConfirmation(profile, nextGstin) {
  const oldGstin = normalizeCompanyGstin(profile?.gstin || profile?.tenantKey);
  const newGstin = normalizeCompanyGstin(nextGstin);
  return {
    code: "GST_CHANGE_CONFIRMATION_REQUIRED",
    oldGstin,
    newGstin,
    oldTenantKey: clean(profile?.tenantKey),
    newTenantKey: newGstin,
    question: "GST Number changed. Do you want to move all company data to the new GST tenantKey?",
    choices: {
      yes: "Set migrateTenantData=true. Tenant identity and all tenantKey values move to the new GSTIN without creating duplicate FY collections.",
      no: "Set migrateTenantData=false to change only the company GSTIN and keep the existing tenantKey/data location.",
    },
  };
}

function replaceTenantKeys(value, oldKey, newKey) {
  if (Array.isArray(value)) return value.map((item) => replaceTenantKeys(item, oldKey, newKey));
  if (!value || typeof value !== "object" || value instanceof Date || Buffer.isBuffer(value)) return value;
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

async function discoverFinancialDatabases(storageTenantKey, financialYears = []) {
  const client = mongoose.connection.getClient();
  const base = getTenantDbName(storageTenantKey);
  const discovered = new Set();
  let listed = false;

  try {
    const result = await client.db().admin().listDatabases({ nameOnly: true });
    listed = true;
    for (const row of result?.databases || []) {
      const name = clean(row?.name);
      if (!name.startsWith(`${base}_`)) continue;
      const suffix = name.slice(base.length + 1);
      if (FY_SUFFIX_RE.test(suffix)) discovered.add(name);
    }
  } catch (error) {
    console.warn("[tenant migration] listDatabases unavailable; using financialYears fallback:", error?.message || error);
  }

  if (!listed) {
    for (const fy of Array.isArray(financialYears) ? financialYears : []) {
      const normalized = clean(fy).replace(/[^0-9-]/g, "");
      if (FY_SUFFIX_RE.test(normalized)) discovered.add(`${base}_${normalized}`);
    }
  }
  return [...discovered].sort();
}

async function rollbackFailedMasterResidue(mainDb, oldKey, newKey, companyProfileId) {
  if (!(await migrationAuditAvailable())) return [];
  const failed = await TenantMigration.exists({
    companyProfileId: String(companyProfileId),
    oldTenantKey: oldKey,
    newTenantKey: newKey,
    status: "FAILED",
  });
  if (!failed) return [];

  const collectionInfos = await mainDb.listCollections({}, { nameOnly: true }).toArray();
  const repaired = [];
  for (const { name } of collectionInfos) {
    if (name.startsWith("system.") || EXCLUDED_MASTER_COLLECTIONS.has(name)) continue;
    const collection = mainDb.collection(name);
    const matched = await collection.countDocuments({ tenantKey: newKey });
    if (!matched) continue;
    const outcome = await collection.updateMany({ tenantKey: newKey }, { $set: { tenantKey: oldKey } });
    repaired.push({ name, matched, modified: Number(outcome.modifiedCount || 0) });
  }
  return repaired;
}

async function preflightMasterTarget(mainDb, newKey, companyProfileId) {
  const duplicateProfile = await CompanyProfile.findOne({
    _id: { $ne: companyProfileId },
    $or: [{ tenantKey: newKey }, { gstin: newKey }, { previousTenantKeys: newKey }],
  }).select("_id tenantKey gstin companyName").lean();
  if (duplicateProfile) {
    throw httpError("The new GSTIN/tenantKey is already used or reserved by another company", 409, "TENANT_KEY_ALREADY_EXISTS");
  }

  if (await isTenantKeyReserved(newKey, { companyProfileId })) {
    throw httpError("The new GSTIN is reserved by an existing tenant identity/history", 409, "TENANT_KEY_RESERVED");
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
    for (const name of changedCollections.reverse()) {
      await mainDb.collection(name).updateMany({ tenantKey: newKey }, { $set: { tenantKey: oldKey } }).catch(() => {});
    }
    throw error;
  }

  return results;
}

async function remapCollectionInPlace(collection, oldKey, newKey) {
  const total = await collection.countDocuments({});
  const matched = await collection.countDocuments({ tenantKey: oldKey });
  if (!matched) return { total, matched: 0, modified: 0 };

  let modified = 0;
  let batch = [];
  const cursor = collection.find({ tenantKey: oldKey }, { batchSize: BATCH_SIZE });
  for await (const doc of cursor) {
    batch.push({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: replaceTenantKeys(doc, oldKey, newKey),
      },
    });
    if (batch.length >= BATCH_SIZE) {
      const result = await collection.bulkWrite(batch, { ordered: true });
      modified += Number(result.modifiedCount || result.matchedCount || batch.length);
      batch = [];
    }
  }
  if (batch.length) {
    const result = await collection.bulkWrite(batch, { ordered: true });
    modified += Number(result.modifiedCount || result.matchedCount || batch.length);
  }

  const remaining = await collection.countDocuments({ tenantKey: oldKey }, { limit: 1 });
  if (remaining) {
    throw httpError(`Old tenantKey remained in FY collection ${collection.namespace}`, 500, "TENANT_MIGRATION_FY_VERIFY_FAILED");
  }
  return { total, matched, modified };
}

async function remapFinancialDatabasesInPlace({ sourceNames, oldKey, newKey }) {
  const client = mongoose.connection.getClient();
  const rows = [];

  try {
    for (const sourceName of sourceNames) {
      const db = client.db(sourceName);
      const collectionNames = (await db.listCollections({}, { nameOnly: true }).toArray())
        .map((row) => row.name)
        .filter((name) => !name.startsWith("system."));
      if (!collectionNames.length) continue;

      let sourceDocuments = 0;
      let changedDocuments = 0;
      for (const name of collectionNames) {
        const result = await remapCollectionInPlace(db.collection(name), oldKey, newKey);
        sourceDocuments += result.total;
        changedDocuments += result.modified;
      }

      rows.push({
        source: sourceName,
        target: sourceName,
        sourceDocuments,
        copiedDocuments: changedDocuments,
        collections: collectionNames.length,
        sourceDropped: false,
        backupRetained: true,
        error: "",
        collectionNames,
        strategy: "IN_PLACE_ZERO_COLLECTION_GROWTH",
      });
    }
    return rows;
  } catch (error) {
    error.financialRows = rows;
    throw error;
  }
}

async function rollbackFinancialDatabasesInPlace(sourceNames, fromKey, toKey) {
  const client = mongoose.connection.getClient();
  for (const sourceName of sourceNames) {
    const db = client.db(sourceName);
    const collectionNames = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((row) => row.name)
      .filter((name) => !name.startsWith("system."));
    for (const name of collectionNames) {
      await remapCollectionInPlace(db.collection(name), fromKey, toKey).catch(() => {});
    }
  }
}

async function cleanupKnownFailedTargetDatabases({ companyProfileId, oldKey, newKey, sourceNames }) {
  // Previous copy-based builds may have left partial rupioo_<NEWGST>_<FY>
  // databases. Drop only those exact FY targets when a FAILED migration record
  // proves they came from this same company/GST change. No arbitrary DB is touched.
  if (!(await migrationAuditAvailable())) return [];
  const failed = await TenantMigration.exists({
    companyProfileId: String(companyProfileId),
    oldTenantKey: oldKey,
    newTenantKey: newKey,
    status: "FAILED",
  });
  if (!failed) return [];

  const client = mongoose.connection.getClient();
  const newBase = getTenantDbName(newKey);
  const dropped = [];
  for (const sourceName of sourceNames) {
    const suffix = sourceName.split("_").pop();
    if (!FY_SUFFIX_RE.test(suffix)) continue;
    const target = `${newBase}_${suffix}`;
    if (target === sourceName) continue;
    try {
      const exists = await client.db().admin().listDatabases({ nameOnly: true });
      if ((exists?.databases || []).some((row) => row.name === target)) {
        await client.db(target).dropDatabase();
        dropped.push(target);
      }
    } catch (error) {
      console.warn(`[tenant migration] unable to clean failed target ${target}:`, error?.message || error);
    }
  }
  return dropped;
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

  if (await migrationAuditAvailable()) {
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
  }

  const migration = await createMigrationAudit({
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
  const physicalStorageKey = clean(profile.financialStorageTenantKey) || oldKey;
  let financialRows = [];
  let masterRows = [];
  let sourceNames = [];

  try {
    migration.phase = "REPAIR_FAILED_MASTER_RESIDUE";
    await migration.save();
    const repairedMasterResidue = await rollbackFailedMasterResidue(mainDb, oldKey, newKey, String(profile._id));
    if (repairedMasterResidue.length) migration.repairedMasterResidue = repairedMasterResidue;

    migration.phase = "PREFLIGHT";
    await migration.save();
    await preflightMasterTarget(mainDb, newKey, String(profile._id));

    migration.phase = "DISCOVER_FINANCIAL_DATABASES";
    await migration.save();
    sourceNames = await discoverFinancialDatabases(
      physicalStorageKey,
      profile.financialYears?.length ? profile.financialYears : [profile.financialYear].filter(Boolean),
    );

    // Reclaim namespaces left by the older copy-based migration before doing
    // anything else. The new strategy never creates replacement FY databases.
    const removedFailedTargets = await cleanupKnownFailedTargetDatabases({
      companyProfileId: String(profile._id), oldKey, newKey, sourceNames,
    });
    if (removedFailedTargets.length) migration.removedFailedTargets = removedFailedTargets;

    migration.phase = "REMAP_FINANCIAL_DATA_IN_PLACE";
    await migration.save();
    financialRows = await remapFinancialDatabasesInPlace({ sourceNames, oldKey, newKey });
    migration.financialDatabases = financialRows;
    await migration.save();

    migration.phase = "MOVE_MASTER_COLLECTIONS";
    await migration.save();
    masterRows = await migrateMasterCollections(mainDb, oldKey, newKey);
    migration.masterCollections = masterRows;
    await migration.save();

    // Persist the physical FY storage mapping immediately after the logical
    // tenant switch. This is what prevents financialModels(newGST, FY) from
    // creating a new GST-named database/collection on a full Atlas cluster.
    migration.phase = "SET_FINANCIAL_STORAGE_MAPPING";
    await migration.save();
    await CompanyProfile.updateOne(
      { _id: profile._id, tenantKey: newKey },
      {
        $set: {
          gstin: newKey,
          tenantKey: newKey,
          financialStorageTenantKey: physicalStorageKey,
        },
        $addToSet: { previousTenantKeys: oldKey },
      },
    );
    clearFinancialStorageTenantKey(oldKey, newKey);
    setFinancialStorageTenantKey(newKey, physicalStorageKey);
    setFinancialStorageTenantKey(oldKey, physicalStorageKey);

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

    const persistedProfile = await CompanyProfile.findById(profile._id)
      .select("tenantKey gstin financialStorageTenantKey previousTenantKeys")
      .lean();
    if (
      !persistedProfile ||
      clean(persistedProfile.tenantKey) !== newKey ||
      normalizeCompanyGstin(persistedProfile.gstin) !== newKey ||
      clean(persistedProfile.financialStorageTenantKey) !== physicalStorageKey
    ) {
      throw httpError("Company tenant/storage identity was not persisted after migration", 500, "TENANT_IDENTITY_VERIFY_FAILED");
    }

    migration.phase = "UPDATE_GLOBAL_LINKS";
    await migration.save();
    await migrateGlobalCustomerLinks(oldKey, newKey);

    migration.status = "COMPLETED";
    migration.phase = "COMPLETED";
    migration.financialDatabases = financialRows;
    migration.masterCollections = masterRows;
    migration.sourceDatabasesRetained = true;
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
      sourceDatabasesRetained: true,
      financialStorageTenantKey: physicalStorageKey,
      storageStrategy: "IN_PLACE_ZERO_COLLECTION_GROWTH",
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

    const switched = await CompanyProfile.exists({ _id: profile._id, tenantKey: newKey });
    if (!switched) {
      // No master switch: restore any FY documents already changed in place.
      if (sourceNames.length) await rollbackFinancialDatabasesInPlace(sourceNames, newKey, oldKey);
      clearFinancialStorageTenantKey(oldKey, newKey);
      setFinancialStorageTenantKey(oldKey, physicalStorageKey);
      throw error;
    }

    // Master switch already happened. Keep the new logical identity, repair the
    // storage mapping/alias, and return with warnings rather than risking a
    // second migration against an already-switched tenant.
    const warnings = [error?.message || "A post-migration cleanup step failed"];
    await CompanyProfile.updateOne(
      { _id: profile._id },
      {
        $set: { tenantKey: newKey, gstin: newKey, financialStorageTenantKey: physicalStorageKey },
        $addToSet: { previousTenantKeys: oldKey },
      },
    ).catch((repairError) => warnings.push(`Company/storage repair: ${repairError?.message || repairError}`));
    clearFinancialStorageTenantKey(oldKey, newKey);
    setFinancialStorageTenantKey(newKey, physicalStorageKey);
    setFinancialStorageTenantKey(oldKey, physicalStorageKey);
    await recordTenantKeyAlias({
      oldTenantKey: oldKey,
      newTenantKey: newKey,
      companyProfileId: String(profile._id),
      oldGstin: profile.gstin || oldKey,
      newGstin: newKey,
      changedBy: actorId,
    }).catch((repairError) => warnings.push(`Alias repair: ${repairError?.message || repairError}`));

    migration.status = "COMPLETED";
    migration.phase = "COMPLETED_WITH_WARNINGS";
    migration.error = warnings.join(" | ");
    migration.completedAt = new Date();
    migration.sourceDatabasesRetained = true;
    await migration.save().catch(() => {});
    return {
      changed: true,
      migrationId: migration.migrationId,
      oldTenantKey: oldKey,
      newTenantKey: newKey,
      newGstin: newKey,
      masterCollections: masterRows,
      financialDatabases: financialRows,
      sourceDatabasesRetained: true,
      financialStorageTenantKey: physicalStorageKey,
      storageStrategy: "IN_PLACE_ZERO_COLLECTION_GROWTH",
      sessionAliasCreated: true,
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

  // A profile can already have the new GSTIN while still carrying the old
  // tenantKey after an older failed save. Do not treat that split state as
  // 'nothing changed'; the caller may still need a tenant migration.
  const sameGstin = newGstin === normalizeCompanyGstin(profile.gstin);
  const sameTenant = newGstin === clean(profile.tenantKey);
  if (sameGstin && sameTenant) return { changed: false, newGstin };

  const duplicate = await CompanyProfile.findOne({
    _id: { $ne: profile._id },
    $or: [{ gstin: newGstin }, { tenantKey: newGstin }, { previousTenantKeys: newGstin }],
  }).select("_id companyName gstin tenantKey").lean();
  if (duplicate) throw httpError("This GSTIN is already assigned/reserved by another company", 409, "GSTIN_ALREADY_EXISTS");

  if (await isTenantKeyReserved(newGstin, { companyProfileId: String(profile._id) })) {
    throw httpError("This GSTIN is an old tenant identity reserved by migration history", 409, "GSTIN_RESERVED_BY_MIGRATION");
  }
  return { changed: true, newGstin };
}
