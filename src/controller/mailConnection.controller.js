import Jwt from "jsonwebtoken";
import { MailConnection } from "../models/mailConnection.model.js";
import { MailQueue } from "../models/mailQueue.model.js";
import { detectMailProvider, normalizeEmail, isValidEmail } from "../services/mail/providerDetection.service.js";
import {
  exchangeGoogleMailCode,
  getGoogleMailAuthUrl,
  googleCredentialFields,
} from "../services/mail/googleMail.service.js";
import {
  exchangeMicrosoftMailCode,
  getMicrosoftMailAuthUrl,
  microsoftCredentialFields,
} from "../services/mail/microsoftMail.service.js";
import { encryptSecret } from "../services/mail/crypto.js";
import { verifySmtpConnection } from "../services/mail/smtpMail.service.js";
import { testCompanyMailConnection } from "../services/mail/mail.service.js";
import { enqueueAndTryMail } from "../services/mail/mailQueue.service.js";

const stateSecret = () =>
  process.env.MAIL_OAUTH_STATE_SECRET || process.env.TOKEN_SECRET_KEY || "";

const signState = (payload) => {
  const secret = stateSecret();
  if (!secret) throw new Error("MAIL_OAUTH_STATE_SECRET is required");
  return Jwt.sign(payload, secret, { expiresIn: "10m" });
};

const verifyState = (token) => Jwt.verify(token, stateSecret());

const appOrigin = () => String(process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");

const oauthResultHtml = ({ ok, message }) => `<!doctype html>
<html><body style="font-family:Arial;padding:30px;text-align:center">
<h2>${ok ? "Email connected" : "Email connection failed"}</h2>
<p>${String(message || "")}</p>
<script>
(function(){
  var payload=${JSON.stringify({ type: "rupio-mail-oauth", ok, message })};
  try { if (window.opener) window.opener.postMessage(payload, ${JSON.stringify(appOrigin())}); } catch(e) {}
  setTimeout(function(){ window.close(); }, 900);
})();
</script>
</body></html>`;

const baseStatus = async (database) => {
  const connection = await MailConnection.findOne({ database }).lean();
  const [pending, failed] = await Promise.all([
    MailQueue.countDocuments({ database, status: { $in: ["queued", "retry", "sending"] } }),
    MailQueue.countDocuments({ database, status: "failed" }),
  ]);
  return {
    connected: connection?.status === "connected",
    connection: connection
      ? {
          email: connection.email,
          fromName: connection.fromName,
          replyTo: connection.replyTo,
          signatureHtml: connection.signatureHtml || "",
          provider: connection.provider,
          authMode: connection.authMode,
          status: connection.status,
          needsUpgrade: Boolean(connection.needsUpgrade),
          lastHealthAt: connection.lastHealthAt,
          lastSuccessfulSendAt: connection.lastSuccessfulSendAt,
          lastError: connection.lastError,
          automation: connection.automation || {},
        }
      : null,
    pending,
    failed,
  };
};

export const detectProvider = async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email || req.body?.email);
    const result = await detectMailProvider(email);
    return res.json({ status: true, email, ...result });
  } catch (error) {
    return res.status(400).json({ status: false, message: error.message });
  }
};

export const status = async (req, res) => {
  try {
    return res.json({ status: true, ...(await baseStatus(req.params.database)) });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const beginOAuth = async (req, res) => {
  try {
    const database = String(req.params.database || "").trim();
    const email = normalizeEmail(req.body?.email || req.query?.email);
    const provider = String(req.body?.provider || req.query?.provider || "").trim();
    const fromName = String(req.body?.fromName || req.query?.fromName || "").trim();

    if (!database) return res.status(400).json({ status: false, message: "database is required" });
    if (!isValidEmail(email)) return res.status(400).json({ status: false, message: "Valid email is required" });
    if (!["google", "microsoft"].includes(provider)) {
      return res.status(400).json({ status: false, message: "Google or Microsoft provider is required" });
    }

    const state = signState({
      database,
      email,
      provider,
      fromName,
      superadminId: req.rupioAuth?.id || "",
      nonce: Math.random().toString(36).slice(2),
    });

    const authUrl =
      provider === "google"
        ? getGoogleMailAuthUrl({ state, email })
        : getMicrosoftMailAuthUrl({ state, email });

    await MailConnection.findOneAndUpdate(
      { database },
      {
        $set: {
          database,
          superadminId: req.rupioAuth?.id || "",
          email,
          fromName,
          provider,
          status: "pending",
          lastError: "",
        },
      },
      { upsert: true, new: true },
    );

    return res.json({ status: true, provider, authUrl });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

const saveOAuthConnection = async ({ statePayload, actualEmail, credentials, displayName = "" }) => {
  const requestedEmail = normalizeEmail(statePayload.email);
  const verifiedEmail = normalizeEmail(actualEmail);
  if (!verifiedEmail || verifiedEmail !== requestedEmail) {
    throw new Error(`Authorized mailbox ${verifiedEmail || "unknown"} does not match ${requestedEmail}`);
  }

  const credentialFields =
    statePayload.provider === "google"
      ? googleCredentialFields(credentials)
      : microsoftCredentialFields(credentials);

  return MailConnection.findOneAndUpdate(
    { database: statePayload.database },
    {
      $set: {
        database: statePayload.database,
        superadminId: statePayload.superadminId || "",
        email: verifiedEmail,
        fromName: statePayload.fromName || displayName || verifiedEmail,
        provider: statePayload.provider,
        authMode: "oauth",
        status: "connected",
        needsUpgrade: false,
        consentAccepted: true,
        consentAcceptedAt: new Date(),
        consentVersion: "3.0",
        encryptedSmtpPassword: "",
        smtpHost: "",
        smtpUser: "",
        lastHealthAt: new Date(),
        lastError: "",
        ...credentialFields,
      },
    },
    { upsert: true, new: true },
  );
};

export const googleCallback = async (req, res) => {
  try {
    const payload = verifyState(String(req.query.state || ""));
    if (payload.provider !== "google") throw new Error("Invalid Google OAuth state");
    const data = await exchangeGoogleMailCode(String(req.query.code || ""));
    await saveOAuthConnection({
      statePayload: payload,
      actualEmail: data.email,
      credentials: data,
    });
    return res.type("html").send(oauthResultHtml({ ok: true, message: `${data.email} connected successfully.` }));
  } catch (error) {
    return res.status(400).type("html").send(oauthResultHtml({ ok: false, message: error.message }));
  }
};

export const microsoftCallback = async (req, res) => {
  try {
    const payload = verifyState(String(req.query.state || ""));
    if (payload.provider !== "microsoft") throw new Error("Invalid Microsoft OAuth state");
    const data = await exchangeMicrosoftMailCode(String(req.query.code || ""));
    await saveOAuthConnection({
      statePayload: payload,
      actualEmail: data.email,
      displayName: data.displayName,
      credentials: data,
    });
    return res.type("html").send(oauthResultHtml({ ok: true, message: `${data.email} connected successfully.` }));
  } catch (error) {
    return res.status(400).type("html").send(oauthResultHtml({ ok: false, message: error.message }));
  }
};

export const saveSmtp = async (req, res) => {
  try {
    const database = String(req.params.database || "").trim();
    const email = normalizeEmail(req.body.email);
    const host = String(req.body.host || "").trim();
    const port = Number(req.body.port || 587);
    const secureRaw = req.body.secure;
    const secure =
      secureRaw === true ||
      String(secureRaw || "").toLowerCase() === "true" ||
      port === 465;
    const username = String(req.body.username || email).trim();
    const password = String(req.body.password || "");
    const fromName = String(req.body.fromName || "").trim();

    if (!isValidEmail(email) || !host || !password) {
      return res.status(400).json({ status: false, message: "Email, SMTP host and app password are required" });
    }

    const row = await MailConnection.findOneAndUpdate(
      { database },
      {
        $set: {
          database,
          superadminId: req.rupioAuth?.id || "",
          email,
          fromName,
          provider: "smtp",
          authMode: "smtp",
          status: "pending",
          smtpHost: host,
          smtpPort: port,
          smtpSecure: secure,
          smtpUser: username,
          encryptedSmtpPassword: encryptSecret(password),
          encryptedRefreshToken: "",
          encryptedAccessToken: "",
          accessTokenExpiresAt: null,
          needsUpgrade: false,
          consentAccepted: true,
          consentAcceptedAt: new Date(),
          lastError: "",
        },
      },
      { upsert: true, new: true },
    );

    await verifySmtpConnection(row);
    row.status = "connected";
    row.lastHealthAt = new Date();
    await row.save();
    return res.json({ status: true, message: "SMTP email connected", connection: { email, provider: "smtp" } });
  } catch (error) {
    await MailConnection.findOneAndUpdate(
      { database: String(req.params.database || "") },
      { $set: { status: "error", lastError: String(error.message || error), lastErrorAt: new Date() } },
    ).catch(() => {});
    return res.status(400).json({ status: false, message: error.message });
  }
};

export const disconnect = async (req, res) => {
  try {
    await MailConnection.findOneAndUpdate(
      { database: req.params.database },
      {
        $set: {
          status: "disconnected",
          encryptedRefreshToken: "",
          encryptedAccessToken: "",
          encryptedSmtpPassword: "",
          accessTokenExpiresAt: null,
          lastError: "Disconnected by user",
          lastErrorAt: new Date(),
        },
      },
    );
    return res.json({ status: true, message: "Company email disconnected" });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const testConnection = async (req, res) => {
  try {
    const database = req.params.database;
    const connection = await MailConnection.findOne({ database });
    if (!connection) return res.status(404).json({ status: false, message: "Email connection not found" });

    await testCompanyMailConnection(database);
    const queue = await enqueueAndTryMail({
      database,
      requestedBy: req.rupioAuth?.id || "",
      type: "test",
      to: [connection.email],
      subject: "Rupio V2 - Email Connection Test",
      html: `<p>Your Rupio V2 company email connection is working correctly.</p><p>Provider: <strong>${connection.provider}</strong></p>`,
      metadata: { source: "email-settings-test" },
    });

    return res.json({
      status: true,
      message: queue.status === "sent" ? "Test email sent successfully" : "Connection is valid; test email queued",
      mailStatus: queue.status,
      queueId: queue._id,
    });
  } catch (error) {
    return res.status(400).json({ status: false, message: error.message });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const allowed = {
      fromName: String(req.body.fromName || "").trim(),
      replyTo: normalizeEmail(req.body.replyTo),
      signatureHtml: String(req.body.signatureHtml || "").slice(0, 10000),
      automation: {
        invoiceAfterDelivery: Boolean(req.body.automation?.invoiceAfterDelivery),
        receiptAfterPayment: Boolean(req.body.automation?.receiptAfterPayment),
        reminderBeforeDueDays: Number(req.body.automation?.reminderBeforeDueDays || 0),
        reminderOnDueDate: Boolean(req.body.automation?.reminderOnDueDate),
        reminderEveryDaysAfterDue: Number(req.body.automation?.reminderEveryDaysAfterDue || 0),
      },
    };
    const row = await MailConnection.findOneAndUpdate(
      { database: req.params.database },
      { $set: allowed },
      { new: true },
    );
    if (!row) return res.status(404).json({ status: false, message: "Email connection not found" });
    return res.json({ status: true, message: "Email settings updated" });
  } catch (error) {
    return res.status(400).json({ status: false, message: error.message });
  }
};

export const masterOverview = async (req, res) => {
  try {
    if (!req.rupioAuth?.isMaster) return res.status(403).json({ status: false, message: "MASTER access required" });
    const rows = await MailConnection.find({}).sort({ database: 1 }).lean();
    const queueAgg = await MailQueue.aggregate([
      { $match: { status: { $in: ["queued", "retry", "sending", "failed"] } } },
      { $group: { _id: { database: "$database", status: "$status" }, count: { $sum: 1 } } },
    ]);
    const counts = {};
    queueAgg.forEach((x) => {
      counts[x._id.database] ||= { pending: 0, failed: 0 };
      if (x._id.status === "failed") counts[x._id.database].failed += x.count;
      else counts[x._id.database].pending += x.count;
    });
    return res.json({
      status: true,
      rows: rows.map((r) => ({
        database: r.database,
        email: r.email,
        provider: r.provider,
        authMode: r.authMode,
        connectionStatus: r.status,
        needsUpgrade: r.needsUpgrade,
        lastHealthAt: r.lastHealthAt,
        lastSuccessfulSendAt: r.lastSuccessfulSendAt,
        lastError: r.lastError,
        pending: counts[r.database]?.pending || 0,
        failed: counts[r.database]?.failed || 0,
      })),
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};
