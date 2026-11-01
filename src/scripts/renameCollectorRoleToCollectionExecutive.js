// One-time, idempotent role rename; dry-run by default.
// Run from the backend project root: node src/scripts/renameCollectorRoleToCollectionExecutive.js
// Apply only after taking a database backup:
// node src/scripts/renameCollectorRoleToCollectionExecutive.js --apply
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Role, User, DesignationTemplate, Plan } from "../models/index.js";

const OLD = "COLLECTOR";
const NEW = "COLLECTION_EXECUTIVE";
const NAME = "Collection Executive";
const apply = process.argv.includes("--apply");

await mongoose.connect(env.mongoUri);
try {
  const oldRoles = await Role.find({ code: OLD }).select("_id tenantKey code name sourceTemplateCode").lean();
  const oldTemplates = await DesignationTemplate.find({ code: OLD }).select("_id tenantKey code name").lean();
  const collisions = [];
  for (const role of oldRoles) {
    const match = await Role.findOne({ tenantKey: role.tenantKey, code: NEW }).select("_id").lean();
    if (match) collisions.push(`roles tenant ${role.tenantKey}: ${role._id} and ${match._id}`);
  }
  for (const template of oldTemplates) {
    const match = await DesignationTemplate.findOne({ tenantKey: template.tenantKey, code: NEW }).select("_id").lean();
    if (match) collisions.push(`designationTemplates tenant ${template.tenantKey}: ${template._id} and ${match._id}`);
  }
  if (collisions.length) throw new Error(`New role already exists alongside old one. Resolve without merging permissions or assignments:\n${collisions.join("\n")}`);

  const counts = {
    roles: oldRoles.length,
    designationTemplates: oldTemplates.length,
    users: await User.countDocuments({ role: OLD }),
    plans: await Plan.countDocuments({ roleTemplateCodes: OLD }),
    leftoverTemplateRoleReferences: await Role.countDocuments({ sourceTemplateCode: OLD }),
  };
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${OLD} -> ${NEW}`, counts);
  if (apply) {
    await Role.updateMany({ code: OLD }, { $set: { code: NEW, name: NAME } });
    await Role.updateMany({ sourceTemplateCode: OLD }, { $set: { sourceTemplateCode: NEW } });
    await DesignationTemplate.updateMany({ code: OLD }, { $set: { code: NEW, name: NAME } });
    // Assigned party IDs, roleId ObjectIds, permissions, OTP and receipts are untouched.
    await User.updateMany({ role: OLD }, { $set: { role: NEW } });
    await Plan.collection.updateMany({ roleTemplateCodes: OLD }, { $set: { "roleTemplateCodes.$[value]": NEW } }, { arrayFilters: [{ "value": OLD }] });
    // If the role already exists under the new code but a legacy display name remains, align it.
    await Role.updateMany({ code: NEW, name: "Collector" }, { $set: { name: NAME } });
    await DesignationTemplate.updateMany({ code: NEW, name: "Collector" }, { $set: { name: NAME } });
    console.log("Role rename applied. Restart backend and log in again to refresh role claims.");
  } else {
    console.log("No data changed. Add --apply to perform this migration after a backup.");
  }
} finally {
  await mongoose.disconnect();
}
