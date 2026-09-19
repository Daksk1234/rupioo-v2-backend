import "dotenv/config";
import mongoose from "mongoose";
import { User } from "../model/user.model.js";
import { MailConnection } from "../model/mailConnection.model.js";
import { encryptSecret } from "../services/mail/crypto.js";

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) throw new Error("MONGO_URI/MONGODB_URI is required");

await mongoose.connect(uri);

const users = await User.find({
  email: { $type: "string", $ne: "" },
  appPassword: { $type: "string", $ne: "" },
  database: { $type: "string", $ne: "" },
}).lean();

let created = 0;
let skipped = 0;
for (const user of users) {
  const existing = await MailConnection.findOne({ database: user.database });
  if (existing) {
    skipped += 1;
    continue;
  }
  await MailConnection.create({
    database: user.database,
    superadminId: String(user._id),
    email: String(user.email).toLowerCase(),
    fromName: user.companyName || user.firstName || user.email,
    provider: "smtp",
    authMode: "smtp_legacy",
    status: "connected",
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: String(user.email).toLowerCase(),
    encryptedSmtpPassword: encryptSecret(user.appPassword),
    needsUpgrade: true,
    consentAccepted: true,
    consentAcceptedAt: new Date(),
    consentVersion: "legacy-import",
  });
  created += 1;
}

console.log(`Legacy mail migration complete. Created: ${created}, skipped: ${skipped}`);
await mongoose.disconnect();
