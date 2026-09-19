import { sendDocument } from "./mailSend.controller.js";

/**
 * Compatibility bridge for the old /order/send-invoice endpoint.
 * IMPORTANT: email/appPassword sent by an old frontend are intentionally ignored.
 * The sender is always resolved from MailConnection for the logged-in company's database.
 */
export const invoicePartySendSmart = async (req, res) => {
  req.params ||= {};
  req.body ||= {};
  req.params.database = String(
    req.rupioAuth?.database || req.body.database || "",
  ).trim();
  req.body.type = "invoice";

  if (req.file) {
    req.files = [req.file];
  }

  // Never trust sender credentials from the browser anymore.
  delete req.body.email;
  delete req.body.appPassword;
  delete req.body.password;

  return sendDocument(req, res);
};
