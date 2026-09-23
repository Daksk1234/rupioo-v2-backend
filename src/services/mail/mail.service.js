import { MailConnection } from "../../models/mailConnection.model.js";
import { sendWithGoogle, testGoogleConnection } from "./googleMail.service.js";
import {
  sendWithMicrosoft,
  testMicrosoftConnection,
} from "./microsoftMail.service.js";
import { sendWithSmtp, verifySmtpConnection } from "./smtpMail.service.js";

const cleanError = (error) =>
  String(
    error?.response?.data?.error?.message ||
      error?.response?.data?.error_description ||
      error?.response?.data?.message ||
      error?.message ||
      "Mail provider error",
  ).slice(0, 1000);

const markSuccess = async (connection) => {
  connection.status = "connected";
  connection.lastHealthAt = new Date();
  connection.lastSuccessfulSendAt = new Date();
  connection.lastError = "";
  await connection.save();
};

const markError = async (connection, error) => {
  const message = cleanError(error);
  connection.lastHealthAt = new Date();
  connection.lastErrorAt = new Date();
  connection.lastError = message;
  const statusCode = Number(error?.response?.status || error?.code || 0);
  if ([400, 401, 403].includes(statusCode) || /invalid_grant|revoked|authorization|token/i.test(message)) {
    connection.status = "error";
  }
  await connection.save();
  return message;
};

export const getMailConnection = async (database) =>
  MailConnection.findOne({ database: String(database || "").trim() });

export const sendCompanyMail = async ({ database, ...message }) => {
  const connection = await getMailConnection(database);
  if (!connection || connection.status !== "connected") {
    const error = new Error("Company email is not connected");
    error.code = "MAIL_NOT_CONNECTED";
    throw error;
  }

  try {
    let result;
    if (connection.provider === "google") {
      result = await sendWithGoogle(connection, message);
    } else if (connection.provider === "microsoft") {
      result = await sendWithMicrosoft(connection, message);
    } else if (connection.provider === "smtp") {
      result = await sendWithSmtp(connection, message);
    } else {
      throw new Error("Unsupported company email provider");
    }
    await markSuccess(connection);
    return { ...result, provider: connection.provider };
  } catch (error) {
    await markError(connection, error);
    throw error;
  }
};

export const testCompanyMailConnection = async (database) => {
  const connection = await getMailConnection(database);
  if (!connection || connection.status !== "connected") {
    throw new Error("Company email is not connected");
  }

  try {
    let actualEmail = connection.email;
    if (connection.provider === "google") {
      actualEmail = await testGoogleConnection(connection);
    } else if (connection.provider === "microsoft") {
      actualEmail = await testMicrosoftConnection(connection);
    } else if (connection.provider === "smtp") {
      await verifySmtpConnection(connection);
    }

    connection.lastHealthAt = new Date();
    connection.status = "connected";
    connection.lastError = "";
    await connection.save();
    return { actualEmail, provider: connection.provider };
  } catch (error) {
    await markError(connection, error);
    throw error;
  }
};
