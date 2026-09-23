import { MailConnection } from "../../models/mailConnection.model.js";
import { testCompanyMailConnection } from "./mail.service.js";

let timer = null;
let busy = false;

export const runMailHealthCheckOnce = async () => {
  if (busy) return;
  busy = true;
  try {
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
    const rows = await MailConnection.find({
      status: "connected",
      $or: [
        { lastHealthAt: { $exists: false } },
        { lastHealthAt: null },
        { lastHealthAt: { $lte: staleBefore } },
      ],
    })
      .select("database")
      .limit(50)
      .lean();

    for (const row of rows) {
      try {
        await testCompanyMailConnection(row.database);
      } catch (error) {
        // testCompanyMailConnection stores the provider error/status itself.
        console.warn(
          `[RUPIO MAIL HEALTH] ${row.database}:`,
          error?.message || error,
        );
      }
    }
  } catch (error) {
    console.error("[RUPIO MAIL HEALTH WORKER]", error?.message || error);
  } finally {
    busy = false;
  }
};

export const startMailHealthWorker = () => {
  if (timer) return timer;
  const interval = Math.max(
    60 * 1000,
    Number(process.env.MAIL_HEALTH_WORKER_INTERVAL_MS || 5 * 60 * 1000),
  );
  timer = setInterval(runMailHealthCheckOnce, interval);
  timer.unref?.();
  setTimeout(runMailHealthCheckOnce, 10000).unref?.();
  return timer;
};
