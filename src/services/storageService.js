import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { env } from "../config/env.js";
import { FileMeta } from "../models/index.js";
import { makeId } from "../utils/ids.js";

const root = path.resolve(process.cwd(), env.nasRoot || env.storageRoot);

export async function saveUploadedFile({ file, tenantKey, module, entityType, entityId, uploadedBy, access = "PRIVATE" }) {
  const fileId = makeId("FIL");
  const ext = path.extname(file.originalname || "") || "";
  const key = path.join("tenant", tenantKey || "demo", module || "misc", entityType || "files", `${fileId}${ext}`);
  const full = path.join(root, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, file.buffer);
  const checksum = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const meta = await FileMeta.create({ fileId, tenantKey, module, entityType, entityId, originalName: file.originalname, mimeType: file.mimetype, size: file.size, storageKey: key, access, checksum, uploadedBy });
  return meta;
}

export async function readFile(fileId) {
  const meta = await FileMeta.findOne({ fileId });
  if (!meta) return null;
  return { meta, buffer: await fs.readFile(path.join(root, meta.storageKey)) };
}
