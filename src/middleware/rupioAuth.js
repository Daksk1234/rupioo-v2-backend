import Jwt from "jsonwebtoken";
import { User } from "../models/index.js";

const readBearer = (req) => {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
};

const databaseFromRequest = (req) =>
  String(req.params?.database || req.body?.database || req.query?.database || "").trim();

/**
 * Compatibility auth bridge used by a few legacy mail/storage/product routes.
 * It now trusts only the signed V2 User id (JWT sub). It never resolves a user
 * from email/mobile/GST/PAN/Aadhaar/customer data.
 */
export const requireRupioAuth = async (req, res, next) => {
  try {
    const token = readBearer(req);
    if (!token) return res.status(401).json({ status: false, message: "Login required" });

    const secret = process.env.JWT_SECRET || process.env.TOKEN_SECRET_KEY || "";
    if (!secret) return res.status(500).json({ status: false, message: "JWT secret is not configured" });
    const decoded = Jwt.verify(token, secret);
    const userId = String(decoded?.sub || "").trim();
    if (!userId) return res.status(401).json({ status: false, message: "Invalid login token" });

    const account = await User.findOne({ _id: userId, status: "ACTIVE" })
      .select("_id tenantKey tenantId email role name")
      .lean();
    if (!account) return res.status(401).json({ status: false, message: "Account not found" });


    req.rupioAuth = {
      id: String(account._id),
      email: String(account.email || ""),
      database: String(account.tenantKey || ""),
      tenantKey: String(account.tenantKey || ""),
      tenantId: String(account.tenantId || ""),
      accountType: "user",
      roleName: String(account.role || "").toUpperCase(),
      isMaster: String(account.role || "").toUpperCase() === "MASTER",
      isSuperadmin: String(account.role || "").toUpperCase() === "SUPERADMIN",
    };
    return next();
  } catch (_error) {
    return res.status(401).json({ status: false, message: "Invalid or expired login token" });
  }
};

export const requireDatabaseAccess = (req, res, next) => {
  const requested = databaseFromRequest(req);
  const allowed = String(req.rupioAuth?.database || "").trim();

  if (!requested) return res.status(400).json({ status: false, message: "database is required" });
  if (req.rupioAuth?.isMaster) return next();
  if (!allowed || requested !== allowed) {
    return res.status(403).json({ status: false, message: "This account cannot access the requested company database" });
  }
  return next();
};

export const requireUserAccount = (req, res, next) => {
  if (req.rupioAuth?.accountType !== "user") {
    return res.status(403).json({ status: false, message: "User/Superadmin access required" });
  }
  return next();
};

export const requireSuperadminOrMaster = (req, res, next) => {
  if (req.rupioAuth?.isMaster || req.rupioAuth?.isSuperadmin) return next();
  return res.status(403).json({ status: false, message: "MASTER or SUPERADMIN access required" });
};
