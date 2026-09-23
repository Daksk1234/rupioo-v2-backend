import bcrypt from "bcryptjs";
import { connectDb } from "../config/db.js";
import { User } from "../models/index.js";

const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || "");
if (!email || password.length < 8) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD (minimum 8 characters).");
  process.exit(1);
}
await connectDb();
const user = await User.findOne({ email, role: { $in: ["MASTER", "SUPERADMIN"] }, status: "ACTIVE" });
if (!user) { console.error("No active MASTER/SUPERADMIN found for that email."); process.exit(2); }
user.passwordHash = await bcrypt.hash(password, 12);
user.loginEnabled = true;
user.passwordUpdatedAt = new Date();
await user.save();
console.log(`Password reset successfully for ${user.role}: ${user.email}`);
process.exit(0);
