import { google } from "googleapis";
import { Readable } from "stream";
import { decryptSecret } from "./crypto.js";
import { StorageConnection } from "../../model/storageConnection.model.js";

const oauthClient = () => {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google Drive OAuth environment variables are not configured");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

export const getGoogleOAuthClient = oauthClient;

export const getGoogleConnection = async (database) =>
  StorageConnection.findOne({
    database,
    slot: "primary",
    provider: "google_drive",
    status: { $in: ["connected", "error"] },
  });

export const getDriveForDatabase = async (database) => {
  const connection = await getGoogleConnection(database);
  if (!connection?.encryptedCredential) return null;

  const auth = oauthClient();
  auth.setCredentials({
    refresh_token: decryptSecret(connection.encryptedCredential),
  });
  return {
    drive: google.drive({ version: "v3", auth }),
    connection,
  };
};

export const ensureGoogleFolder = async (drive, name, parentId = null) => {
  const escaped = String(name).replace(/'/g, "\\'");
  const q = [
    `name='${escaped}'`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    parentId ? `'${parentId}' in parents` : null,
  ]
    .filter(Boolean)
    .join(" and ");

  const found = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive",
    pageSize: 1,
  });
  if (found.data.files?.[0]?.id) return found.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: "id",
  });
  return created.data.id;
};

export const ensureGoogleFolderPath = async ({ drive, rootFolderId, parts = [] }) => {
  let parent = rootFolderId;
  for (const part of parts.filter(Boolean)) {
    parent = await ensureGoogleFolder(drive, String(part), parent);
  }
  return parent;
};

export const uploadBufferToGoogleDrive = async ({
  database,
  buffer,
  fileName,
  mimeType,
  folderParts = [],
}) => {
  const bundle = await getDriveForDatabase(database);
  if (!bundle) throw new Error("Primary Google Drive is not connected");
  const { drive, connection } = bundle;
  const parentId = await ensureGoogleFolderPath({
    drive,
    rootFolderId: connection.rootFolderId,
    parts: folderParts,
  });
  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id,name,mimeType,size",
  });
  return {
    slot: "primary",
    provider: "google_drive",
    fileId: response.data.id,
    fileName: response.data.name,
    mimeType: response.data.mimeType || mimeType,
    size: Number(response.data.size || buffer.length || 0),
  };
};

export const getGoogleDriveFileBuffer = async ({ database, fileId }) => {
  const bundle = await getDriveForDatabase(database);
  if (!bundle) throw new Error("Primary Google Drive is not connected");
  const response = await bundle.drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(response.data);
};

export const getGoogleDriveFileStream = async ({ database, fileId }) => {
  const bundle = await getDriveForDatabase(database);
  if (!bundle) throw new Error("Primary Google Drive is not connected");
  const meta = await bundle.drive.files.get({
    fileId,
    fields: "name,mimeType,size",
  });
  const response = await bundle.drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" },
  );
  return { stream: response.data, meta: meta.data };
};

export const testGoogleDriveConnection = async (database) => {
  const bundle = await getDriveForDatabase(database);
  if (!bundle) throw new Error("Primary Google Drive is not connected");
  await bundle.drive.files.get({
    fileId: bundle.connection.rootFolderId,
    fields: "id,name,trashed",
  });
  return true;
};
