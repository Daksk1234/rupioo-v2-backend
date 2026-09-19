import bcrypt from "bcryptjs";
import { OtpChallenge } from "../models/index.js";
import { env } from "../config/env.js";
import { makeId } from "../utils/ids.js";

export async function createOtp({ tenantKey, transactionId, actionType, recipientId, context = {} }) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  const challenge = await OtpChallenge.create({
    otpId: makeId("OTP"), tenantKey, transactionId, actionType, recipientId, codeHash,
    expiresAt: new Date(Date.now() + env.otpTtlSeconds * 1000), context
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
