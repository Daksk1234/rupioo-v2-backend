import bcrypt from "bcryptjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import { OtpChallenge } from "../models/index.js";
import { env } from "../config/env.js";
import { makeId } from "../utils/ids.js";

const customerOtpKey = () => createHash("sha256").update(`RUPIOO_ORDER_OTP:${env.jwtSecret}`).digest();
function secureCustomerOtp(code) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", customerOtpKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(code), "utf8"), cipher.final()]);
  return [iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),ciphertext.toString("base64url")].join(".");
}
function revealCustomerOtp(encrypted) {
  try {
    const [iv,tag,body] = String(encrypted || "").split(".");
    if (!iv || !tag || !body) return null;
    const decipher = createDecipheriv("aes-256-gcm", customerOtpKey(), Buffer.from(iv,"base64url"));
    decipher.setAuthTag(Buffer.from(tag,"base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body,"base64url")),decipher.final()]).toString("utf8");
  } catch { return null; }
}
export async function getActiveCustomerOrderOtp({ tenantKey, transactionId, recipientId, otpId, actionType = "ORDER_CUSTOMER_CONFIRM" }) {
  if (!otpId) return null;
  const challenge = await OtpChallenge.findOne({ otpId, tenantKey, transactionId,
    recipientId, actionType, status:"PENDING", expiresAt:{$gt:new Date()} }).lean();
  if (!challenge) return null;
  const code = revealCustomerOtp(challenge.context?.customerDisplayCodeEncrypted);
  return code ? { otp:code, otpId:challenge.otpId, expiresAt:challenge.expiresAt } : null;
}
export async function createOtp({ tenantKey, transactionId, actionType, recipientId, context = {}, ttlSeconds = null }) {
  const code = String(randomInt(100000, 1000000));
  const codeHash = await bcrypt.hash(code, 10);
  const challenge = await OtpChallenge.create({
    otpId: makeId("OTP"), tenantKey, transactionId, actionType, recipientId, codeHash,
    expiresAt: new Date(Date.now() + Math.max(60, Number(ttlSeconds || env.otpTtlSeconds || 300)) * 1000),
    context: ["ORDER_CUSTOMER_CONFIRM","ORDER_CANCEL_CONFIRM","DELIVERY_CUSTOMER_CONFIRM","SALESPERSON_CANCEL"].includes(actionType)
      ? { ...context, customerDisplayCodeEncrypted: secureCustomerOtp(code) } : context
  });
  return { otpId: challenge.otpId, code, expiresAt: challenge.expiresAt };
}

export async function verifyOtp({ otpId, code }) {
  const challenge = await OtpChallenge.findOne({ otpId }).select("+codeHash");
  if (!challenge || challenge.status !== "PENDING") return { ok: false, reason: "OTP not available" };
  if (challenge.expiresAt < new Date()) {
    challenge.status = "EXPIRED"; await challenge.save();
    return { ok: false, reason: "OTP expired" };
  }
  const valid = await bcrypt.compare(String(code), challenge.codeHash);
  if (!valid) return { ok: false, reason: "Invalid OTP" };
  challenge.status = "USED"; challenge.usedAt = new Date(); await challenge.save();
  return { ok: true, challenge };
}
