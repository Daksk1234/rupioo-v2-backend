import express from "express";
import multer from "multer";
import {
  requireRupioAuth,
  requireDatabaseAccess,
  requireUserAccount,
  requireSuperadminOrMaster,
} from "../middleware/rupioAuth.js";
import {
  beginOAuth,
  detectProvider,
  disconnect,
  googleCallback,
  masterOverview,
  microsoftCallback,
  saveSmtp,
  status,
  testConnection,
  updateSettings,
} from "../controller/mailConnection.controller.js";
import { outbox, retry, sendDocument } from "../controller/mailSend.controller.js";

const router = express.Router();
const upload = multer({
  dest: process.env.MAIL_INCOMING_DIR || "storage/mail-incoming",
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
});

// OAuth callbacks are public by necessity. Security is enforced by a signed, short-lived state token.
router.get("/oauth/google/callback", googleCallback);
router.get("/oauth/microsoft/callback", microsoftCallback);

router.use(requireRupioAuth);
router.use(requireUserAccount);

router.get("/detect-provider", detectProvider);
router.get("/master/overview", masterOverview);

router.get("/status/:database", requireDatabaseAccess, status);
router.post("/connect/:database", requireDatabaseAccess, requireSuperadminOrMaster, beginOAuth);
router.post("/connect-smtp/:database", requireDatabaseAccess, requireSuperadminOrMaster, saveSmtp);
router.post("/disconnect/:database", requireDatabaseAccess, requireSuperadminOrMaster, disconnect);
router.post("/test/:database", requireDatabaseAccess, requireSuperadminOrMaster, testConnection);
router.put("/settings/:database", requireDatabaseAccess, requireSuperadminOrMaster, updateSettings);
router.get("/outbox/:database", requireDatabaseAccess, outbox);
router.post("/outbox/:database/:id/retry", requireDatabaseAccess, retry);
router.post(
  "/send-document/:database",
  requireDatabaseAccess,
  upload.any(),
  sendDocument,
);

export default router;
