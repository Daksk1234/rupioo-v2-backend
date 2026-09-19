import crypto from "crypto";

const getKey = () => {
  const raw = String(process.env.STORAGE_TOKEN_ENCRYPTION_KEY || "");
  if (!raw) throw new Error("STORAGE_TOKEN_ENCRYPTION_KEY is required");
  return crypto.createHash("sha256").update(raw).digest();
};

export const encryptSecret = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
};

export const decryptSecret = (payload) => {
  const [ivText, tagText, dataText] = String(payload || "").split(".");
  if (!ivText || !tagText || !dataText) throw new Error("Invalid encrypted secret");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

// Binary fallback files are encrypted on disk while cloud replication is incomplete.
export const encryptBuffer = (buffer) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("RUPIO2"), iv, tag, encrypted]);
};

export const decryptBuffer = (payload) => {
  const input = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (input.subarray(0, 6).toString("utf8") !== "RUPIO2") {
    throw new Error("Invalid encrypted fallback file");
  }
  const iv = input.subarray(6, 18);
  const tag = input.subarray(18, 34);
  const encrypted = input.subarray(34);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
};
