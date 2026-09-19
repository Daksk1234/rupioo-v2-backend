import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getGoogleDriveConnectUrl,
  googleDriveCallback,
  getOneDriveConnectUrl,
  oneDriveCallback,
  storageStatus,
  storageHealth,
  testStorageConnection,
  disconnectStorage,
} from "../controller/storageConnection.controller.js";
import { startStorageSyncWorker } from "../services/storage/storageSync.worker.js";

const router = express.Router();
startStorageSyncWorker();

const allowedRole = (req, res, next) => {
  if (["MASTER", "SUPERADMIN"].includes(String(req.auth?.role || "").toUpperCase())) return next();
  return res.status(403).json({ status: false, message: "MASTER or SUPERADMIN access required" });
};

const bindStorageIdentity = (req, res, next) => {
  const role = String(req.auth?.role || "").toUpperCase();
  const requested = String(req.query?.tenantKey || req.body?.tenantKey || "").trim();
  const ownTenantKey = String(req.auth?.tenantKey || "").trim();
  const storageKey = role === "MASTER" ? requested : ownTenantKey;

  if (!storageKey) {
    return res.status(400).json({
      status: false,
      message: role === "MASTER" ? "Select/enter a Superadmin tenant key first" : "Company tenant key is missing from this session",
    });
  }

  req.rupioAuth = {
    id: String(req.auth?.sub || ""),
    email: String(req.auth?.email || ""),
    database: storageKey,
    accountType: "user",
    roleName: role,
    isMaster: role === "MASTER",
    isSuperadmin: role === "SUPERADMIN",
  };

  // The storage implementation historically calls this value `database`.
  // In current V2 it is the signed company tenantKey, which is the stable
  // company storage namespace.
  req.storageKey = storageKey;
  // Keep the authenticated namespace on a dedicated request property.
  // Express 5 req.query is getter-backed, so mutating it is not reliable.
  req.body = req.body || {};
  req.body.database = storageKey;
  next();
};

// Provider callbacks are public because the provider redirects back without
// the Rupio Authorization header. The encrypted state binds the callback to
// the original company, provider and 15-minute connection attempt.
router.get("/google/callback", googleDriveCallback);
router.get("/onedrive/callback", oneDriveCallback);

router.use(requireAuth, allowedRole, bindStorageIdentity);

const withStorageKey = (handler) => (req, res, next) => {
  req.params.database = req.storageKey;
  return handler(req, res, next);
};

router.get("/google/connect", getGoogleDriveConnectUrl);
router.get("/onedrive/connect", getOneDriveConnectUrl);
router.get("/status", withStorageKey(storageStatus));
router.get("/health", withStorageKey(storageHealth));
router.post("/test/:slot", withStorageKey(testStorageConnection));
router.post("/disconnect/:slot", withStorageKey(disconnectStorage));

export default router;
