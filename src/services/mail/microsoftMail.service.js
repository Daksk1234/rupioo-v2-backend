import axios from "axios";
import { decryptSecret, encryptSecret } from "./crypto.js";

const AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access openid profile email User.Read Mail.Send";

export const getMicrosoftMailAuthUrl = ({ state, email }) => {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_MAIL_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: process.env.MICROSOFT_MAIL_REDIRECT_URI || "",
    response_mode: "query",
    scope: SCOPES,
    state,
    prompt: "select_account",
  });
  if (email) params.set("login_hint", email);
  return `${AUTH_BASE}/authorize?${params.toString()}`;
};

const tokenRequest = async (params) => {
  const body = new URLSearchParams({
    client_id: process.env.MICROSOFT_MAIL_CLIENT_ID || "",
    client_secret: process.env.MICROSOFT_MAIL_CLIENT_SECRET || "",
    redirect_uri: process.env.MICROSOFT_MAIL_REDIRECT_URI || "",
    scope: SCOPES,
    ...params,
  });
  const response = await axios.post(`${AUTH_BASE}/token`, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  });
  return response.data || {};
};

const getMe = async (accessToken) => {
  const response = await axios.get(`${GRAPH_BASE}/me?$select=mail,userPrincipalName,displayName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 20000,
  });
  return response.data || {};
};

export const exchangeMicrosoftMailCode = async (code) => {
  const tokens = await tokenRequest({ code, grant_type: "authorization_code" });
  const me = await getMe(tokens.access_token);
  return {
    email: String(me.mail || me.userPrincipalName || "").toLowerCase(),
    displayName: String(me.displayName || ""),
    refreshToken: String(tokens.refresh_token || ""),
    accessToken: String(tokens.access_token || ""),
    expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000),
  };
};

const refreshAccess = async (connection) => {
  const refreshToken = decryptSecret(connection.encryptedRefreshToken);
  if (!refreshToken) throw new Error("Microsoft refresh token is missing");
  const tokens = await tokenRequest({
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return {
    accessToken: String(tokens.access_token || ""),
    refreshToken: String(tokens.refresh_token || refreshToken),
    expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000),
  };
};

export const refreshMicrosoftConnectionTokens = async (connection) => {
  const refreshed = await refreshAccess(connection);
  connection.encryptedAccessToken = encryptSecret(refreshed.accessToken);
  connection.encryptedRefreshToken = encryptSecret(refreshed.refreshToken);
  connection.accessTokenExpiresAt = refreshed.expiresAt;
  await connection.save();
  return refreshed.accessToken;
};

const toRecipients = (items = []) =>
  items.filter(Boolean).map((address) => ({ emailAddress: { address } }));

export const sendWithMicrosoft = async (connection, message) => {
  const accessToken = await refreshMicrosoftConnectionTokens(connection);
  const attachments = (message.attachments || []).map((a) => ({
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.filename,
    contentType: a.mimeType || "application/octet-stream",
    contentBytes: Buffer.from(a.content).toString("base64"),
  }));

  await axios.post(
    `${GRAPH_BASE}/me/sendMail`,
    {
      message: {
        subject: message.subject,
        body: {
          contentType: message.html ? "HTML" : "Text",
          content: message.html || message.text || "",
        },
        toRecipients: toRecipients(message.to),
        ccRecipients: toRecipients(message.cc),
        bccRecipients: toRecipients(message.bcc),
        replyTo: connection.replyTo
          ? [{ emailAddress: { address: connection.replyTo } }]
          : [],
        attachments,
      },
      saveToSentItems: true,
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
      maxBodyLength: 15 * 1024 * 1024,
    },
  );
  return { providerMessageId: "" };
};

export const testMicrosoftConnection = async (connection) => {
  const accessToken = await refreshMicrosoftConnectionTokens(connection);
  const me = await getMe(accessToken);
  return String(me.mail || me.userPrincipalName || "").toLowerCase();
};

export const microsoftCredentialFields = ({ refreshToken, accessToken, expiresAt }) => ({
  encryptedRefreshToken: encryptSecret(refreshToken),
  encryptedAccessToken: encryptSecret(accessToken),
  accessTokenExpiresAt: expiresAt || null,
});
