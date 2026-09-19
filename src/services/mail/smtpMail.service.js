import nodemailer from "nodemailer";
import { decryptSecret } from "./crypto.js";

const transporterFor = (connection) =>
  nodemailer.createTransport({
    host: connection.smtpHost,
    port: Number(connection.smtpPort || 587),
    secure: Boolean(connection.smtpSecure),
    auth: {
      user: connection.smtpUser || connection.email,
      pass: decryptSecret(connection.encryptedSmtpPassword),
    },
  });

export const verifySmtpConnection = async (connection) => {
  const transporter = transporterFor(connection);
  await transporter.verify();
  return true;
};

export const sendWithSmtp = async (connection, message) => {
  const transporter = transporterFor(connection);
  const result = await transporter.sendMail({
    from: {
      name: connection.fromName || connection.email,
      address: connection.email,
    },
    replyTo: connection.replyTo || undefined,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: (message.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.mimeType,
    })),
  });
  return { providerMessageId: String(result?.messageId || "") };
};
