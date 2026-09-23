import crypto from "crypto";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User, Plan, CompanyProfile, Role } from "../models/index.js";
import { PasswordResetToken } from "../models/passwordReset.model.js";
import { env } from "../config/env.js";
import { ok, fail } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { sendPasswordResetEmail } from "../services/mailService.js";
import { resolveEffectiveAccess } from "../services/accessResolutionService.js";
import { encodePermissions } from "../utils/authToken.js";
import { buildPageAccess, firstAllowedPath, reportAccessForPermissions } from "../config/permissionPageMap.js";
import { ensureSystemCashAccount } from "../services/systemCashAccountService.js";

const router = express.Router();

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signSessionToken({ user, tenantId = "", plan = null, effective }) {
  const apps = user.role === "MASTER" ? ["master"] : effective.apps || [];
  const permissions = user.role === "MASTER" ? ["*"] : effective.permissions || [];
  const encodedPermissions = encodePermissions(permissions);

  return jwt.sign(
    {
      sub: user._id.toString(),
      tenantId,
      tenantKey: user.tenantKey,
      email: user.email,
      name: user.name,
      warehouseId: user.warehouseId || "",
      dataScope: effective?.dataScope || user.dataScope || "SELF",
      departmentId: user.departmentId ? String(user.departmentId) : "",
      branchId: user.branchId ? String(user.branchId) : "",
      role: user.role,
      apps,
      ...encodedPermissions,
      planCode: user.planCode,
      addons: plan?.addons || {},
      tokenVersion: 3,
    },
    env.jwtSecret,
    { expiresIn: "12h" }
  );
}

router.post("/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!email || !password) {
    return fail(res, "Email and password are required", 400);
  }

  const user = await User.findOne({ email, status: "ACTIVE" });
  if (!user || user.loginEnabled === false || !(await bcrypt.compare(password, user.passwordHash))) {
    return fail(res, "Invalid email or password", 401);
  }

  const plan = user.role === "MASTER"
    ? null
    : await Plan.findOne({ code: user.planCode, status: "ACTIVE" }).lean();

  const companyProfile = user.role === "MASTER"
    ? null
    : await CompanyProfile.findOne({ tenantKey: user.tenantKey })
        .select("-aadhaarHash -stakeholders.aadhaarHash")
        .lean();

  if (companyProfile && (!Array.isArray(companyProfile.financialYears) || !companyProfile.financialYears.length) && companyProfile.financialYear) {
    companyProfile.financialYears = [companyProfile.financialYear];
  }

  if (user.role !== "MASTER" && companyProfile) {
    const companyStatus = String(companyProfile.status || "ACTIVE").toUpperCase();
    if (["SUSPENDED", "DELETED", "INACTIVE"].includes(companyStatus)) {
      return fail(
        res,
        companyStatus === "DELETED"
          ? "This company account has been deleted. Contact Rupioo MASTER."
          : "This company account is currently suspended. Contact Rupioo MASTER.",
        403
      );
    }
  }

  if (user.role === "SUPERADMIN") {
    try {
      await ensureSystemCashAccount({
        tenantKey: user.tenantKey,
        tenantId: String(user.tenantId || companyProfile?._id || ""),
        planCode: user.planCode,
        actorId: String(user._id),
      });
    } catch (error) {
      console.error("Unable to ensure system CASH account during Superadmin login", error?.message || error);
    }
  }

  const tenantId = user.role === "MASTER"
    ? ""
    : String(user.tenantId || companyProfile?._id || "");

  // Backfill tenantId for companies created before tenantId was introduced.
  if (user.role !== "MASTER" && tenantId && user.tenantId !== tenantId) {
    user.tenantId = tenantId;
  }

  user.lastLoginAt = new Date();
  user.lastLoginIp = String(req.ip || "").slice(0, 120);
  user.lastLoginUserAgent = String(req.get("user-agent") || "").slice(0, 500);
  user.loginCount = Number(user.loginCount || 0) + 1;
  await user.save();

  const effective = await resolveEffectiveAccess(user);
  // MASTER is intentionally restricted to MASTER UI after login.
  const apps = user.role === "MASTER" ? ["master"] : effective.apps;

  const effectivePermissions =
    user.role === "MASTER" ? ["*"] : effective.permissions;
  const pageAccess =
    user.role === "MASTER" ? {} : buildPageAccess(effectivePermissions);
  const reportAccess =
    user.role === "MASTER" ? {} : reportAccessForPermissions(effectivePermissions);
  const homePath =
    user.role === "MASTER" ? "/master/dashboard" : firstAllowedPath(pageAccess);

  const token = signSessionToken({ user, tenantId, plan, effective });

  const safeUser = user.toObject();
  delete safeUser.passwordHash;

  // Send the complete safe Superadmin/user session record. Password hashes,
  // Aadhaar hashes and provider secrets are never sent to the browser.
  const sessionUser = {
    ...safeUser,
    id: safeUser._id,
    tenantId,
    tenantKey: user.tenantKey,
    apps,
    permissions: effectivePermissions,
    allowedPermission: user.role === "MASTER" ? [] : effectivePermissions,
    pageAccess,
    reportAccess,
    homePath,
    dataScope: effective.dataScope || user.dataScope || "SELF",
    warehouseId: user.warehouseId || "",
    accessGroup: effective.accessGroup || null,
    companyProfile,
    plan,
  };

  return ok(
    res,
    { token, allowedPermission: user.role === "MASTER" ? [] : effectivePermissions, user: sessionUser },
    "Login successful"
  );
});


// Mobile Sales Person login. This deliberately has a separate endpoint so a
// MASTER, SUPERADMIN or any non-sales role cannot use the field app even when
// the same credentials are valid for the web DMS.
router.post("/app-login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!email || !password) return fail(res, "Email and password are required", 400);

  const user = await User.findOne({ email, status: "ACTIVE" });
  if (!user || user.loginEnabled === false || !(await bcrypt.compare(password, user.passwordHash))) {
    return fail(res, "Invalid email or password", 401);
  }
  const roleDoc = user.roleId
    ? await Role.findOne({ _id: user.roleId, tenantKey: user.tenantKey, status: "ACTIVE" }).lean()
    : await Role.findOne({ tenantKey: user.tenantKey, code: String(user.role || "").toUpperCase(), status: "ACTIVE" }).lean();
  const appRoleCode = String(roleDoc?.code || user.role || "").toUpperCase();
  const allowedMobileSalesRoles = new Set(["SALES_PERSON", "SALES_HEAD", "SALES_MANAGER"]);
  if (!allowedMobileSalesRoles.has(appRoleCode)) {
    return fail(res, "Only Sales Person, Sales Manager or Sales Head users created by the Superadmin can log in to this app.", 403);
  }
  if (!String(user.tenantKey || "").trim()) {
    return fail(res, "This Sales Person is not linked to a Superadmin company tenant.", 403);
  }

  const [plan, companyProfile] = await Promise.all([
    Plan.findOne({ code: user.planCode, status: "ACTIVE" }).lean(),
    CompanyProfile.findOne({ tenantKey: user.tenantKey })
      .select("-aadhaarHash -stakeholders.aadhaarHash")
      .lean(),
  ]);

  if (companyProfile && (!Array.isArray(companyProfile.financialYears) || !companyProfile.financialYears.length) && companyProfile.financialYear) {
    companyProfile.financialYears = [companyProfile.financialYear];
  }
  if (companyProfile) {
    const companyStatus = String(companyProfile.status || "ACTIVE").toUpperCase();
    if (["SUSPENDED", "DELETED", "INACTIVE"].includes(companyStatus)) {
      return fail(res, "This company account is not active. Contact your Superadmin.", 403);
    }
  }

  const tenantId = String(user.tenantId || companyProfile?._id || "");
  if (tenantId && user.tenantId !== tenantId) user.tenantId = tenantId;
  user.lastLoginAt = new Date();
  user.lastLoginIp = String(req.ip || "").slice(0, 120);
  user.lastLoginUserAgent = String(req.get("user-agent") || "").slice(0, 500);
  user.loginCount = Number(user.loginCount || 0) + 1;
  await user.save();

  const effective = await resolveEffectiveAccess(user);
  const permissions = effective.permissions || [];
  const apps = effective.apps || [];
  const pageAccess = buildPageAccess(permissions);
  const reportAccess = reportAccessForPermissions(permissions);
  const homePath = firstAllowedPath(pageAccess);
  const token = signSessionToken({ user, tenantId, plan, effective });

  const safeUser = user.toObject();
  delete safeUser.passwordHash;
  const sessionUser = {
    ...safeUser,
    id: safeUser._id,
    tenantId,
    tenantKey: user.tenantKey,
    apps,
    permissions,
    allowedPermission: permissions,
    pageAccess,
    reportAccess,
    homePath,
    dataScope: effective.dataScope || user.dataScope || "SELF",
    warehouseId: user.warehouseId || "",
    accessGroup: effective.accessGroup || null,
    appRoleCode,
    hierarchyOrder: Number(roleDoc?.hierarchyOrder || 0),
    companyProfile,
    plan,
  };

  return ok(res, { token, allowedPermission: permissions, user: sessionUser }, "Login successful");
});

router.post("/forgot-password", async (req, res, next) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    if (!email) return fail(res, "Email is required", 400);

    const genericMessage =
      "If this email is registered, a password reset link has been sent.";

    const user = await User.findOne({ email, status: "ACTIVE" });

    // Do not reveal whether an account exists.
    if (!user) return ok(res, { sent: true }, genericMessage);

    await PasswordResetToken.deleteMany({ userId: user._id, usedAt: null });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(
      Date.now() + env.passwordResetTtlMinutes * 60 * 1000
    );

    await PasswordResetToken.create({
      userId: user._id,
      tokenHash,
      expiresAt,
      requestedFromIp: req.ip,
    });

    const resetUrl = `${env.frontendUrl.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(rawToken)}`;

    try {
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl,
      });
    } catch (mailError) {
      await PasswordResetToken.deleteOne({ tokenHash });
      throw mailError;
    }

    return ok(res, { sent: true }, genericMessage);
  } catch (error) {
    next(error);
  }
});

router.post("/reset-password", async (req, res, next) => {
  try {
    const rawToken = String(req.body.token || "").trim();
    const password = String(req.body.password || "");

    if (!rawToken) return fail(res, "Reset token is required", 400);
    if (password.length < 8) {
      return fail(res, "Password must be at least 8 characters", 400);
    }

    const tokenHash = hashResetToken(rawToken);
    const resetRecord = await PasswordResetToken.findOne({
      tokenHash,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).select("+tokenHash");

    if (!resetRecord) {
      return fail(res, "This reset link is invalid or has expired", 400);
    }

    const user = await User.findOne({
      _id: resetRecord.userId,
      status: "ACTIVE",
    });

    if (!user) return fail(res, "This reset link is no longer valid", 400);

    user.passwordHash = await bcrypt.hash(password, 12);
    await user.save();

    resetRecord.usedAt = new Date();
    await resetRecord.save();

    // Invalidate every other outstanding reset link for this user.
    await PasswordResetToken.deleteMany({
      userId: user._id,
      _id: { $ne: resetRecord._id },
    });

    return ok(
      res,
      { reset: true },
      "Password reset successfully. You can now sign in."
    );
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findOne({ _id: req.auth.sub, status: "ACTIVE" });
  if (!user) return fail(res, "User session is no longer active", 401);

  const effective = await resolveEffectiveAccess(user);
  const permissions = user.role === "MASTER" ? ["*"] : effective.permissions || [];
  const apps = user.role === "MASTER" ? ["master"] : effective.apps || [];
  const pageAccess =
    user.role === "MASTER" ? {} : buildPageAccess(permissions);
  const reportAccess =
    user.role === "MASTER" ? {} : reportAccessForPermissions(permissions);
  const homePath =
    user.role === "MASTER" ? "/master/dashboard" : firstAllowedPath(pageAccess);
  const plan = user.role === "MASTER"
    ? null
    : await Plan.findOne({ code: user.planCode, status: "ACTIVE" }).lean();
  const tenantId = user.role === "MASTER" ? "" : String(user.tenantId || req.auth.tenantId || "");
  const sessionToken = signSessionToken({ user, tenantId, plan, effective });

  return ok(res, {
    sub: user._id.toString(),
    tenantId,
    tenantKey: user.tenantKey,
    email: user.email,
    name: user.name,
    role: user.role,
    roleId: user.roleId ? String(user.roleId) : "",
    departmentId: user.departmentId ? String(user.departmentId) : "",
    branchId: user.branchId ? String(user.branchId) : "",
    warehouseId: user.warehouseId || "",
    dataScope: effective.dataScope || user.dataScope || "SELF",
    hierarchyOrder: Number(effective.role?.hierarchyOrder || 0),
    planCode: user.planCode,
    apps,
    permissions,
    allowedPermission: user.role === "MASTER" ? [] : permissions,
    pageAccess,
    reportAccess,
    homePath,
    dataScope: effective.dataScope || user.dataScope || "SELF",
    warehouseId: user.warehouseId || "",
    accessGroup: effective.accessGroup || null,
    sessionToken,
  });
});

export default router;
