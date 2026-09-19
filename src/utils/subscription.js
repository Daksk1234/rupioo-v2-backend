const DAY_MS = 24 * 60 * 60 * 1000;

export const normalizeBillingCycle = (value) =>
  String(value || "YEARLY").toUpperCase() === "MONTHLY" ? "MONTHLY" : "YEARLY";

export const addBillingPeriod = (value, billingCycle = "YEARLY", periods = 1) => {
  const source = value ? new Date(value) : new Date();
  const date = Number.isNaN(source.getTime()) ? new Date() : new Date(source);
  const count = Math.max(1, Math.min(36, Number(periods || 1)));
  const originalDay = date.getDate();

  date.setDate(1);
  if (normalizeBillingCycle(billingCycle) === "MONTHLY") {
    date.setMonth(date.getMonth() + count);
  } else {
    date.setFullYear(date.getFullYear() + count);
  }

  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDay));
  return date;
};

export const subscriptionSnapshot = (profile = {}, nowValue = new Date()) => {
  const now = new Date(nowValue);
  const cycle = normalizeBillingCycle(profile.billingCycle);
  const startAt = profile.subscriptionStartAt
    ? new Date(profile.subscriptionStartAt)
    : profile.createdAt
      ? new Date(profile.createdAt)
      : new Date(now);
  const endAt = profile.subscriptionEndAt
    ? new Date(profile.subscriptionEndAt)
    : addBillingPeriod(startAt, cycle, 1);
  const renewalDate = profile.renewalDate ? new Date(profile.renewalDate) : endAt;
  const daysLeft = Math.ceil((endAt.getTime() - now.getTime()) / DAY_MS);

  const companyStatus = String(profile.status || "ACTIVE").toUpperCase();
  let status = "ACTIVE";
  if (companyStatus === "DELETED") status = "DELETED";
  else if (companyStatus === "SUSPENDED" || companyStatus === "INACTIVE") status = "SUSPENDED";
  else if (daysLeft < 0) status = "EXPIRED";
  else if (daysLeft <= 7) status = "EXPIRING";

  return {
    billingCycle: cycle,
    planCode: profile.planCode || "",
    startAt,
    endAt,
    renewalDate,
    daysLeft,
    status,
    autoRenew: Boolean(profile.autoRenew),
    graceDays: Number(profile.graceDays || 0),
  };
};
