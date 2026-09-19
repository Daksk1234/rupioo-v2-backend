import { ConfidentialClientApplication } from "@azure/msal-node";
import { Readable } from "stream";
import { StorageConnection } from "../../model/storageConnection.model.js";
import { decryptSecret } from "./crypto.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ONEDRIVE_SCOPES = [
  "offline_access",
  "User.Read",
  "Files.ReadWrite.AppFolder",
];

const getMsalConfig = () => {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const tenant = process.env.MICROSOFT_TENANT || "common";
  if (!clientId || !clientSecret) {
    throw new Error("Microsoft OneDrive OAuth environment variables are not configured");
  }
  return {
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenant}`,
    },
  };
};

export const getOneDriveRedirectUri = () => {
  const uri = process.env.MICROSOFT_REDIRECT_URI;
  if (!uri) throw new Error("MICROSOFT_REDIRECT_URI is required");
  return uri;
};

export const getOneDriveScopes = () => ONEDRIVE_SCOPES;
export const createMsalClient = () => new ConfidentialClientApplication(getMsalConfig());

const graphFetch = async (url, accessToken, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body && !Buffer.isBuffer(options.body)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Microsoft Graph ${response.status}: ${text.slice(0, 400)}`);
  }
  return response;
};

export const acquireOneDriveToken = async (database) => {
  const connection = await StorageConnection.findOne({
    database,
    slot: "backup",
    provider: "onedrive",
    status: { $in: ["connected", "error"] },
  });
  if (!connection?.encryptedCredential || !connection?.accountHomeId) return null;

  const cca = createMsalClient();
  cca.getTokenCache().deserialize(decryptSecret(connection.encryptedCredential));
  const account = await cca.getTokenCache().getAccountByHomeId(connection.accountHomeId);
  if (!account) throw new Error("Microsoft account token cache is unavailable. Reconnect OneDrive.");

  const token = await cca.acquireTokenSilent({
    account,
    scopes: ONEDRIVE_SCOPES,
  });
  if (!token?.accessToken) throw new Error("Unable to acquire Microsoft OneDrive token");
  return { accessToken: token.accessToken, connection, account, cca };
};

export const getOneDriveProfile = async (accessToken) => {
  const response = await graphFetch(
    `${GRAPH}/me?$select=displayName,mail,userPrincipalName,id`,
    accessToken,
  );
  return response.json();
};

export const getOneDriveAppRoot = async (accessToken) => {
  const response = await graphFetch(
    `${GRAPH}/me/drive/special/approot?$select=id,name,webUrl`,
    accessToken,
  );
  return response.json();
};

const listChildren = async (accessToken, parentId) => {
  const response = await graphFetch(
    `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}/children?$select=id,name,folder&$top=200`,
    accessToken,
  );
  const json = await response.json();
  return Array.isArray(json?.value) ? json.value : [];
};

export const ensureOneDriveFolder = async (accessToken, name, parentId) => {
  const children = await listChildren(accessToken, parentId);
  const found = children.find(
    (item) => item?.folder && String(item.name || "").toLowerCase() === String(name).toLowerCase(),
  );
  if (found?.id) return found.id;

  const response = await graphFetch(
    `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}/children`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "rename",
      }),
    },
  );
  const created = await response.json();
  return created.id;
};

export const ensureOneDriveFolderPath = async ({ accessToken, rootFolderId, parts = [] }) => {
  let parent = rootFolderId;
  for (const part of parts.filter(Boolean)) {
    parent = await ensureOneDriveFolder(accessToken, String(part), parent);
  }
  return parent;
};

export const uploadBufferToOneDrive = async ({
  database,
  buffer,
  fileName,
  mimeType,
  folderParts = [],
}) => {
  const bundle = await acquireOneDriveToken(database);
  if (!bundle) throw new Error("Backup Microsoft OneDrive is not connected");
  const parentId = await ensureOneDriveFolderPath({
    accessToken: bundle.accessToken,
    rootFolderId: bundle.connection.rootFolderId,
    parts: folderParts,
  });

  const response = await graphFetch(
    `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(fileName)}:/content`,
    bundle.accessToken,
    {
      method: "PUT",
      body: buffer,
      headers: { "Content-Type": mimeType || "application/octet-stream" },
    },
  );
  const item = await response.json();
  return {
    slot: "backup",
    provider: "onedrive",
    fileId: item.id,
    fileName: item.name || fileName,
    mimeType: mimeType || "application/octet-stream",
    size: Number(item.size || buffer.length || 0),
  };
};

export const getOneDriveFileBuffer = async ({ database, fileId }) => {
  const bundle = await acquireOneDriveToken(database);
  if (!bundle) throw new Error("Backup Microsoft OneDrive is not connected");
  const response = await graphFetch(
    `${GRAPH}/me/drive/items/${encodeURIComponent(fileId)}/content`,
    bundle.accessToken,
  );
  return Buffer.from(await response.arrayBuffer());
};

export const getOneDriveFileStream = async ({ database, fileId }) => {
  const bundle = await acquireOneDriveToken(database);
  if (!bundle) throw new Error("Backup Microsoft OneDrive is not connected");
  const metaRes = await graphFetch(
    `${GRAPH}/me/drive/items/${encodeURIComponent(fileId)}?$select=name,size,file`,
    bundle.accessToken,
  );
  const meta = await metaRes.json();
  const response = await graphFetch(
    `${GRAPH}/me/drive/items/${encodeURIComponent(fileId)}/content`,
    bundle.accessToken,
  );
  return {
    stream: Readable.fromWeb(response.body),
    meta: {
      name: meta.name,
      size: meta.size,
      mimeType: meta?.file?.mimeType || "application/octet-stream",
    },
  };
};

export const testOneDriveConnection = async (database) => {
  const bundle = await acquireOneDriveToken(database);
  if (!bundle) throw new Error("Backup Microsoft OneDrive is not connected");
  await graphFetch(
    `${GRAPH}/me/drive/items/${encodeURIComponent(bundle.connection.rootFolderId)}?$select=id,name`,
    bundle.accessToken,
  );
  return true;
};
