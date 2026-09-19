import { MailQueue } from "../../model/mailQueue.model.js";
import { processMailQueueItem } from "./mailQueue.service.js";

let timer = null;
let busy = false;

export const runMailQueueOnce = async () => {
  if (busy) return;
  busy = true;
  try {
    // Recover messages left in "sending" if the process crashed mid-send.
    await MailQueue.updateMany(
      {
        status: "sending",
        lastAttemptAt: { $lte: new Date(Date.now() - 15 * 60 * 1000) },
      },
      { $set: { status: "retry", nextAttemptAt: new Date() } },
    );

    const rows = await MailQueue.find({
      status: { $in: ["queued", "retry"] },
      nextAttemptAt: { $lte: new Date() },
    })
      .sort({ nextAttemptAt: 1 })
      .limit(20)
      .select("_id")
      .lean();

    for (const row of rows) {
      await processMailQueueItem(row._id);
    }
  } catch (error) {
    console.error("[RUPIO MAIL WORKER]", error?.message || error);
  } finally {
    busy = false;
  }
};

export const startMailQueueWorker = () => {
  if (timer) return timer;
  const interval = Math.max(
    15000,
    Number(process.env.MAIL_QUEUE_WORKER_INTERVAL_MS || 60000),
  );
  timer = setInterval(runMailQueueOnce, interval);
  timer.unref?.();
  setTimeout(runMailQueueOnce, 3000).unref?.();
  return timer;
};
