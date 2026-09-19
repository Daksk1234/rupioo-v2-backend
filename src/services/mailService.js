import nodemailer from "nodemailer";
import { env } from "../config/env.js";

let transporter;

function getTransporter() {
  if (transporter) return transporter;

  if (!env.smtp.user || !env.smtp.pass) {
    throw new Error(
      "SMTP is not configured. Set SMTP_USER and SMTP_PASS in backend/.env"
    );
  }

  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: {
      user: env.smtp.user,
      pass: env.smtp.pass,
    },
  });

  return transporter;
}

export async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const mail = getTransporter();

  await mail.sendMail({
    from: env.smtp.from || env.smtp.user,
    to,
    subject: "Reset your Rupioo Global password",
    text: [
      `Hello ${name || "User"},`,
      "",
      "A password reset was requested for your Rupioo Global account.",
      `Reset your password: ${resetUrl}`,
      "",
      `This link expires in ${env.passwordResetTtlMinutes} minutes and can be used only once.`,
      "If you did not request this reset, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="font-family:Inter,Arial,sans-serif;background:#f6f7fb;padding:32px;color:#191a2d">
        <div style="max-width:560px;margin:auto;background:white;border:1px solid #e5e7f0;border-radius:18px;padding:30px">
          <div style="font-size:13px;font-weight:800;color:#6264ed;letter-spacing:.08em">RUPIOO GLOBAL</div>
          <h2 style="margin:16px 0 8px">Reset your password</h2>
          <p style="color:#74778b;line-height:1.7">Hello ${name || "User"}, a password reset was requested for your Rupioo Global account.</p>
          <a href="${resetUrl}" style="display:inline-block;margin:18px 0;background:linear-gradient(135deg,#6264ed,#8b5cf6);color:white;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Reset Password</a>
          <p style="color:#74778b;font-size:13px;line-height:1.7">This link expires in ${env.passwordResetTtlMinutes} minutes and can be used only once.</p>
          <p style="color:#9a9cac;font-size:12px">If you did not request this reset, no action is required.</p>
        </div>
      </div>
    `,
  });
}


export async function sendBusinessEmail({ to, cc, subject, text, html, attachments = [] }) {
  const mail = getTransporter();
  if (!to) throw new Error("Recipient email is required");
  return mail.sendMail({
    from: env.smtp.from || env.smtp.user,
    to,
    ...(cc ? { cc } : {}),
    subject,
    text,
    html,
    attachments,
  });
}
