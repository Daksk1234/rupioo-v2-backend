import { google } from "googleapis";
import { StorageConnection } from "../models/storageConnection.model.js";
import { StorageObject } from "../models/storageObject.model.js";
import { encryptSecret, decryptSecret } from "../services/storage/crypto.js";
import {
  ensureGoogleFolder,
  getGoogleOAuthClient,
  testGoogleDriveConnection,
} from "../services/storage/googleDrive.service.js";
import {
  createMsalClient,
  getOneDriveRedirectUri,
  getOneDriveScopes,
  getOneDriveProfile,
  getOneDriveAppRoot,
  ensureOneDriveFolder,
  testOneDriveConnection,
} from "../services/storage/oneDrive.service.js";

const encodeState = (obj) => encryptSecret(JSON.stringify(obj));
const decodeState = (value) => JSON.parse(decryptSecret(String(value || "")));

const validateState = (state, expectedProvider) => {
  const parsed = decodeState(state);
  if (!parsed.database || parsed.provider !== expectedProvider) {
    throw new Error("Invalid storage connection request");
  }
  if (Date.now() - Number(parsed.createdAt || 0) > 15 * 60 * 1000) {
    throw new Error("Storage connection request expired");
  }
  return parsed;
};

const popupSuccess = (provider) => `<!doctype html><html><body style="font-family:Arial;padding:30px"><h2>${provider} connected to Rupio V2</h2><p>You can close this window.</p><script>try{window.opener&&window.opener.postMessage({type:'RUPIO_STORAGE_CONNECTED'},'*')}catch(e){}setTimeout(()=>window.close(),900)</script></body></html>`;

const saveConnection = async ({
  database,
  superadminId,
  slot,
  provider,
  encryptedCredential,
  credentialType,
  accountHomeId = "",
  accountEmail = "",
  rootFolderId,
  consentVersion = "2.0",
}) =>
  StorageConnection.findOneAndUpdate(
    { database, slot },
    {
      database,
      superadminId,
      slot,
      provider,
      status: "connected",
      encryptedCredential,
      credentialType,
      accountHomeId,
      accountEmail,
      rootFolderId,
      consentAccepted: true,
      consentAcceptedAt: new Date(),
      consentVersion,
      lastHealthAt: new Date(),
      lastSuccessAt: new Date(),
      lastError: "",
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

export const getGoogleDriveConnectUrl = async (req, res) => {
  try {
    // Express 5 exposes req.query through a getter. Values injected into
    // req.query by middleware are not guaranteed to survive a later read.
    // The storage route therefore binds the authenticated company namespace
    // to req.storageKey; always prefer that signed value here.
    const database = String(
      req.storageKey || req.rupioAuth?.database || req.params?.database || req.query?.database || "",
    ).trim();
    const email = String(req.query.email || "").trim();
    if (!database) return res.status(400).json({ status: false, message: "database is required" });
    if (String(req.query.consentAccepted || "false") !== "true") {
      return res.status(400).json({ status: false, message: "Storage consent must be accepted first" });
    }

    const auth = getGoogleOAuthClient();
    const state = encodeState({
      database,
      provider: "google_drive",
      slot: "primary",
      superadminId: String(req.rupioAuth?.id || ""),
      consentVersion: String(req.query.consentVersion || "2.0"),
      createdAt: Date.now(),
    });

    const authUrl = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      login_hint: email || undefined,
      scope: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      state,
    });
    return res.json({ status: true, authUrl });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const googleDriveCallback = async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing Google OAuth code/state");
    const parsed = validateState(state, "google_drive");

    const auth = getGoogleOAuthClient();
    const { tokens } = await auth.getToken(String(code));
    if (!tokens.refresh_token) {
      return res.status(400).send("Google did not return a refresh token. Reconnect and approve access again.");
    }
    auth.setCredentials(tokens);
    const drive = google.drive({ version: "v3", auth });
    const oauth2 = google.oauth2({ version: "v2", auth });
    const me = await oauth2.userinfo.get();
    const rootFolderId = await ensureGoogleFolder(drive, "RUPIO DMS");

    await saveConnection({
      database: parsed.database,
      superadminId: parsed.superadminId || "",
      slot: "primary",
      provider: "google_drive",
      encryptedCredential: encryptSecret(tokens.refresh_token),
      credentialType: "google_refresh_token",
      accountEmail: me.data.email || "",
      rootFolderId,
      consentVersion: parsed.consentVersion,
    });
    return res.send(popupSuccess("Google Drive"));
  } catch (error) {
    console.error("[google drive callback]", error.message);
    return res.status(500).send("Google Drive connection failed. Return to Rupio and try again.");
  }
};

export const getOneDriveConnectUrl = async (req, res) => {
  try {
    // Use the company namespace bound from the signed Rupio session instead
    // of relying on a middleware-injected query-string value (Express 5).
    const database = String(
      req.storageKey || req.rupioAuth?.database || req.params?.database || req.query?.database || "",
    ).trim();
    const email = String(req.query.email || "").trim();
    if (!database) return res.status(400).json({ status: false, message: "database is required" });
    if (String(req.query.consentAccepted || "false") !== "true") {
      return res.status(400).json({ status: false, message: "Storage consent must be accepted first" });
    }

    const cca = createMsalClient();
    const state = encodeState({
      database,
      provider: "onedrive",
      slot: "backup",
      superadminId: String(req.rupioAuth?.id || ""),
      consentVersion: String(req.query.consentVersion || "2.0"),
      createdAt: Date.now(),
    });
    const authUrl = await cca.getAuthCodeUrl({
      scopes: getOneDriveScopes(),
      redirectUri: getOneDriveRedirectUri(),
      state,
      prompt: "select_account",
      loginHint: email || undefined,
    });
    return res.json({ status: true, authUrl });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const oneDriveCallback = async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing Microsoft OAuth code/state");
    const parsed = validateState(state, "onedrive");

    const cca = createMsalClient();
    const token = await cca.acquireTokenByCode({
      code: String(code),
      scopes: getOneDriveScopes(),
      redirectUri: getOneDriveRedirectUri(),
    });
    if (!token?.accessToken || !token?.account?.homeAccountId) {
      throw new Error("Microsoft did not return a usable OneDrive session");
    }

    const profile = await getOneDriveProfile(token.accessToken);
    const appRoot = await getOneDriveAppRoot(token.accessToken);
    const rootFolderId = await ensureOneDriveFolder(
      token.accessToken,
      "RUPIO DMS",
      appRoot.id,
    );
    const serializedCache = cca.getTokenCache().serialize();

    await saveConnection({
      database: parsed.database,
      superadminId: parsed.superadminId || "",
      slot: "backup",
      provider: "onedrive",
      encryptedCredential: encryptSecret(serializedCache),
      credentialType: "microsoft_msal_cache",
      accountHomeId: token.account.homeAccountId,
      accountEmail: profile.mail || profile.userPrincipalName || token.account.username || "",
      rootFolderId,
      consentVersion: parsed.consentVersion,
    });
    return res.send(popupSuccess("Microsoft OneDrive"));
  } catch (error) {
    console.error("[onedrive callback]", error.message);
    return res.status(500).send("Microsoft OneDrive connection failed. Return to Rupio and try again.");
  }
};

export const storageStatus = async (req, res) => {
  try {
    const database = req.params.database;
    const connections = await StorageConnection.find({ database }).lean();
    const pending = await StorageObject.countDocuments({
      database,
      replicationStatus: { $ne: "healthy" },
      deletedAt: { $exists: false },
    });
    const primary = connections.find((x) => x.slot === "primary") || null;
    const backup = connections.find((x) => x.slot === "backup") || null;
    return res.json({
      status: true,
      primary: primary
        ? {
            provider: primary.provider,
            connected: primary.status === "connected",
            status: primary.status,
            accountEmail: primary.accountEmail,
            lastHealthAt: primary.lastHealthAt,
            lastError: primary.lastError,
          }
        : { provider: "google_drive", connected: false, status: "disconnected" },
      backup: backup
        ? {
            provider: backup.provider,
            connected: backup.status === "connected",
            status: backup.status,
            accountEmail: backup.accountEmail,
            lastHealthAt: backup.lastHealthAt,
            lastError: backup.lastError,
          }
        : { provider: "onedrive", connected: false, status: "disconnected" },
      pendingReplication: pending,
      healthy:
        primary?.status === "connected" &&
        backup?.status === "connected" &&
        pending === 0,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const storageHealth = async (req, res) => {
  try {
    const database = req.params.database;
    const [primary, backup, pending] = await Promise.all([
      StorageConnection.findOne({ database, slot: "primary" }).lean(),
      StorageConnection.findOne({ database, slot: "backup" }).lean(),
      StorageObject.countDocuments({
        database,
        replicationStatus: { $ne: "healthy" },
        deletedAt: { $exists: false },
      }),
    ]);

    const primaryOk = primary?.status === "connected";
    const backupOk = backup?.status === "connected";
    let severity = "healthy";
    let message = "Storage healthy";
    if (!primaryOk && !backupOk) {
      severity = "critical";
      message = "BOTH CLOUD STORAGE PROVIDERS ARE DISCONNECTED";
    } else if (!primaryOk && backupOk) {
      severity = "danger";
      message = "PRIMARY GOOGLE DRIVE DISCONNECTED — BACKUP ONEDRIVE IS ACTIVE";
    } else if (primaryOk && !backupOk) {
      severity = "warning";
      message = "BACKUP ONEDRIVE DISCONNECTED — FILES ARE SAFE ON PRIMARY";
    } else if (pending > 0) {
      severity = "warning";
      message = `${pending} FILE(S) WAITING FOR DUAL-CLOUD BACKUP`;
    }

    return res.json({
      status: true,
      severity,
      message,
      pendingReplication: pending,
      primary: { connected: primaryOk, status: primary?.status || "disconnected", email: primary?.accountEmail || "" },
      backup: { connected: backupOk, status: backup?.status || "disconnected", email: backup?.accountEmail || "" },
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const testStorageConnection = async (req, res) => {
  try {
    const database = req.params.database;
    const slot = req.params.slot;
    if (slot === "primary") await testGoogleDriveConnection(database);
    else if (slot === "backup") await testOneDriveConnection(database);
    else return res.status(400).json({ status: false, message: "Invalid storage slot" });

    await StorageConnection.findOneAndUpdate(
      { database, slot },
      { status: "connected", lastHealthAt: new Date(), lastSuccessAt: new Date(), lastError: "" },
    );
    return res.json({ status: true, message: `${slot} storage connection is healthy` });
  } catch (error) {
    await StorageConnection.findOneAndUpdate(
      { database: req.params.database, slot: req.params.slot },
      { status: "error", lastHealthAt: new Date(), lastErrorAt: new Date(), lastError: error.message },
    );
    return res.status(503).json({ status: false, message: error.message });
  }
};

export const disconnectStorage = async (req, res) => {
  try {
    const { database, slot } = req.params;
    await StorageConnection.findOneAndUpdate(
      { database, slot },
      {
        status: "disconnected",
        encryptedCredential: "",
        accountHomeId: "",
        lastError: "Disconnected by administrator",
      },
    );
    return res.json({
      status: true,
      message: `${slot} cloud disconnected. Existing cloud files were not deleted.`,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};
