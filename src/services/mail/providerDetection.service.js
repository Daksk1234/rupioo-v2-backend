import dns from "dns/promises";

const GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT_DOMAINS = new Set([
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "office365.com",
]);

export const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

export const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));

export const detectMailProvider = async (email) => {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    return { provider: "", confidence: "none", reason: "Invalid email address" };
  }

  const domain = normalized.split("@")[1];
  if (GOOGLE_DOMAINS.has(domain)) {
    return { provider: "google", confidence: "high", reason: "Google domain" };
  }
  if (MICROSOFT_DOMAINS.has(domain)) {
    return { provider: "microsoft", confidence: "high", reason: "Microsoft domain" };
  }

  try {
    const records = await dns.resolveMx(domain);
    const exchanges = records.map((r) => String(r.exchange || "").toLowerCase());

    if (
      exchanges.some(
        (mx) =>
          mx.includes("google.com") ||
          mx.includes("googlemail.com") ||
          mx.includes("aspmx"),
      )
    ) {
      return {
        provider: "google",
        confidence: "high",
        reason: "Google Workspace MX records",
      };
    }

    if (
      exchanges.some(
        (mx) =>
          mx.includes("protection.outlook.com") ||
          mx.includes("outlook.com") ||
          mx.includes("microsoft.com"),
      )
    ) {
      return {
        provider: "microsoft",
        confidence: "high",
        reason: "Microsoft 365 MX records",
      };
    }

    return {
      provider: "smtp",
      confidence: "medium",
      reason: `Custom mail provider (${exchanges[0] || domain})`,
    };
  } catch {
    return {
      provider: "smtp",
      confidence: "low",
      reason: "Could not identify provider automatically",
    };
  }
};
