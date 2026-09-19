import { google } from "googleapis";
import nodemailer from "nodemailer";
import { decryptSecret, encryptSecret } from "./crypto.js";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
];

const oauthClient = () =>
  new google.auth.OAuth2(
    process.env.GOOGLE_MAIL_CLIENT_ID,
    process.env.GOOGLE_MAIL_CLIENT_SECRET,
    process.env.GOOGLE_MAIL_REDIRECT_URI,
  );

export const getGoogleMailAuthUrl = ({ state, email }) => {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: SCOPES,
    state,
    login_hint: email || undefined,
  });
};

export const exchangeGoogleMailCode = async (code) => {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  return {
    email: String(profile?.data?.emailAddress || "").toLowerCase(),
    refreshToken: tokens.refresh_token || "",
    accessToken: tokens.access_token || "",
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  };
};

const getAuthorizedClient = async (connection) => {
  const client = oauthClient();
  client.setCredentials({
    refresh_token: decryptSecret(connection.encryptedRefreshToken),
  });
  const tokenResponse = await client.getAccessToken();
  const accessToken = String(tokenResponse?.token || "");
  if (!accessToken) throw new Error("Unable to refresh Google access token");
  return client;
};

const buildRawMessage = async ({ fromName, fromEmail, replyTo, to, cc, bcc, subject, text, html, attachments }) => {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: true,
  });
  const info = await transport.sendMail({
    from: { name: fromName || fromEmail, address: fromEmail },
    to,
    cc,
    bcc,
    replyTo: replyTo || undefined,
    subject,
    text,
    html,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.mimeType,
    })),
  });
  return Buffer.from(info.message).toString("base64url");
};

export const sendWithGoogle = async (connection, message) => {
  const auth = await getAuthorizedClient(connection);
  const gmail = google.gmail({ version: "v1", auth });
  const raw = await buildRawMessage({
    ...message,
    fromName: connection.fromName,
    fromEmail: connection.email,
    replyTo: connection.replyTo,
  });
  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return { providerMessageId: String(result?.data?.id || "") };
};

export const testGoogleConnection = async (connection) => {
  const auth = await getAuthorizedClient(connection);
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  return String(profile?.data?.emailAddress || "").toLowerCase();
};

export const googleCredentialFields = ({ refreshToken, accessToken, expiresAt }) => ({
  encryptedRefreshToken: encryptSecret(refreshToken),
  encryptedAccessToken: encryptSecret(accessToken),
  accessTokenExpiresAt: expiresAt || null,
});
