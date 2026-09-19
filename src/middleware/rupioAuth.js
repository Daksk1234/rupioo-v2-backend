import Jwt from "jsonwebtoken";
import { User } from "../model/user.model.js";
import { Customer } from "../model/customer.model.js";

const readBearer = (req) => {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
};

const databaseFromRequest = (req) =>
  String(
    req.params?.database || req.body?.database || req.query?.database || "",
  ).trim();

const getRoleName = (account) =>
  String(
    account?.rolename?.roleName ||
      account?.rolename?.name ||
      account?.rolename ||
      account?.roleName ||
      "",
  )
    .trim()
    .toUpperCase();

export const requireRupioAuth = async (req, res, next) => {
  try {
    const token = readBearer(req);
    if (!token) {
      return res.status(401).json({ status: false, message: "Login required" });
    }

    const decoded = Jwt.verify(token, process.env.TOKEN_SECRET_KEY);
    const email = String(decoded?.subject || decoded?.email || "").trim();
    if (!email) {
      return res.status(401).json({ status: false, message: "Invalid login token" });
    }

    let account = await User.findOne({ email, status: "Active" })
      .select("_id email database rolename roleName firstName lastName")
      .lean();
    let accountType = "user";

    if (!account) {
      account = await Customer.findOne({ email, status: "Active" })
        .select("_id email database rolename roleName CompanyName firstName lastName")
        .lean();
      accountType = "customer";
    }

    if (!account) {
      return res.status(401).json({ status: false, message: "Account not found" });
    }

    const roleName = getRoleName(account);
    req.rupioAuth = {
      id: String(account._id),
      email,
      database: String(account.database || ""),
      accountType,
      roleName,
      isMaster: accountType === "user" && roleName === "MASTER",
      isSuperadmin:
        accountType === "user" &&
        ["SUPERADMIN", "SUPER ADMIN", "SUPER-ADMIN"].includes(roleName),
    };
    return next();
  } catch (error) {
    return res.status(401).json({ status: false, message: "Invalid or expired login token" });
  }
};

export const requireDatabaseAccess = (req, res, next) => {
  const requested = databaseFromRequest(req);
  const allowed = String(req.rupioAuth?.database || "").trim();

  if (!requested) {
    return res.status(400).json({ status: false, message: "database is required" });
  }

  // MASTER can connect/test storage for any selected Superadmin database.
  if (req.rupioAuth?.isMaster) return next();

  if (!allowed || requested !== allowed) {
    return res.status(403).json({
      status: false,
      message: "This account cannot access the requested company database",
    });
  }
  return next();
};

export const requireUserAccount = (req, res, next) => {
  if (req.rupioAuth?.accountType !== "user") {
    return res.status(403).json({
      status: false,
      message: "User/Superadmin access required",
    });
  }
  return next();
};


export const requireSuperadminOrMaster = (req, res, next) => {
  if (req.rupioAuth?.isMaster || req.rupioAuth?.isSuperadmin) return next();
  return res.status(403).json({
    status: false,
    message: "MASTER or SUPERADMIN access required",
  });
};
