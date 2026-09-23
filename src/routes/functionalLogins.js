import express from "express";
import bcrypt from "bcryptjs";
import { Role, User } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
import {
  publicFunctionalLogin,
  syncFunctionalLogins,
} from "../services/functionalLoginService.js";

const router = express.Router();
router.use(requireAuth);

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const isSuperadmin = (req) => String(req.auth?.role || "").toUpperCase() === "SUPERADMIN";

router.use((req, res, next) => {
  if (!isSuperadmin(req)) return fail(res, "Superadmin access required", 403);
  next();
});

async function rowFor(req, id) {
  return User.findOne({
    _id: id,
    tenantKey: req.auth.tenantKey,
    loginKind: "FUNCTIONAL",
    managedLogin: true,
  });
}

router.get("/", async (req, res) => {
  try {
    const sync = await syncFunctionalLogins(req.auth.tenantKey, req.auth.sub);
    const items = await User.find({
      tenantKey: req.auth.tenantKey,
      loginKind: "FUNCTIONAL",
      managedLogin: true,
    }).sort({ functionalScopeType: 1, functionalScopeName: 1 }).lean();
    return ok(res, {
      items: items.map(publicFunctionalLogin),
      sync,
      rule: "MASTER/SUPERADMIN use their registered email + password. Users under Superadmin use functional Role/Warehouse Login ID + password. Individual person records cannot authenticate.",
    });
  } catch (error) {
    return fail(res, error.message || "Unable to load functional logins", 500);
  }
});

router.post("/sync", async (req, res) => {
  try {
    const sync = await syncFunctionalLogins(req.auth.tenantKey, req.auth.sub);
    return ok(res, sync, "Functional logins synchronized");
  } catch (error) {
    return fail(res, error.message || "Unable to synchronize logins", 500);
  }
});

router.put("/:id/login-id", async (req, res) => {
  const loginId = lower(req.body.loginId);
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(loginId)) {
    return fail(res, "Login ID must be 3-80 characters using letters, numbers, dot, dash or underscore", 400);
  }
  const user = await rowFor(req, req.params.id);
  if (!user) return fail(res, "Functional login not found", 404);
  if (await User.exists({ _id: { $ne: user._id }, loginId })) {
    return fail(res, "This Login ID is already in use", 409);
  }
  user.loginId = loginId;
  await user.save();
  return ok(res, publicFunctionalLogin(user), "Login ID updated");
});

router.put("/:id/email", async (req, res) => {
  const email = lower(req.body.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail(res, "Enter a valid recovery/contact email", 400);
  }
  if (/@system\.rupio\.invalid$/i.test(email)) {
    return fail(res, "Use a real/company recovery/contact email, not the internal system address", 400);
  }
  const user = await rowFor(req, req.params.id);
  if (!user) return fail(res, "Functional login not found", 404);
  if (await User.exists({ _id: { $ne: user._id }, email })) {
    return fail(res, "This recovery/contact email is already in use", 409);
  }
  user.email = email;
  await user.save();
  return ok(res, publicFunctionalLogin(user), "Recovery/contact email updated");
});

router.put("/:id/password", async (req, res) => {
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");
  if (password.length < 8) return fail(res, "Password must contain at least 8 characters", 400);
  if (confirmPassword && confirmPassword !== password) return fail(res, "Password confirmation does not match", 400);
  const user = await rowFor(req, req.params.id);
  if (!user) return fail(res, "Functional login not found", 404);
  if (user.functionalScopeType === "ROLE") {
    const role = user.roleId ? await Role.findOne({ _id: user.roleId, tenantKey: req.auth.tenantKey, status: "ACTIVE" }).lean() : null;
    if (!role || !role.departmentId || Number(role.hierarchyOrder || 0) <= 0) {
      return fail(res, "Assign and rank this Role in Department Role Assignment before activating its login", 409);
    }
  }
  user.passwordHash = await bcrypt.hash(password, 12);
  user.passwordConfigured = true;
  user.passwordUpdatedAt = new Date();
  user.loginEnabled = user.status === "ACTIVE";
  await user.save();
  return ok(res, publicFunctionalLogin(user), "Password changed. Functional login is ready to use.");
});

router.put("/:id/status", async (req, res) => {
  const user = await rowFor(req, req.params.id);
  if (!user) return fail(res, "Functional login not found", 404);
  const enabled = req.body.enabled !== false;
  if (enabled && user.passwordConfigured !== true) {
    return fail(res, "Set a password from Login Control before enabling this login", 409);
  }
  if (enabled && user.functionalScopeType === "ROLE") {
    const role = user.roleId ? await Role.findOne({ _id: user.roleId, tenantKey: req.auth.tenantKey, status: "ACTIVE" }).lean() : null;
    if (!role || !role.departmentId || Number(role.hierarchyOrder || 0) <= 0) {
      return fail(res, "Assign and rank this Role in Department Role Assignment before enabling its login", 409);
    }
  }
  user.loginEnabled = enabled;
  user.status = enabled ? "ACTIVE" : "INACTIVE";
  await user.save();
  return ok(res, publicFunctionalLogin(user), enabled ? "Login enabled" : "Login disabled");
});

export default router;
