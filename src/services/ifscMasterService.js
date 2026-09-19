import { IfscMaster } from "../models/index.js";

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const normalizeIfsc = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, "");
const clean = (value) => String(value ?? "").trim();

export function formatIfscContact(row = {}) {
  const std = clean(row.stdCode).replace(/\.0$/, "");
  const phone = clean(row.phone).replace(/\.0$/, "");
  if (!phone) return "";
  if (!std) return phone;
  const dial = std.startsWith("0") ? std : `0${std}`;
  return `${dial}-${phone}`;
}

export async function getIfscMaster(ifsc) {
  const code = normalizeIfsc(ifsc);
  if (!IFSC_PATTERN.test(code)) {
    const error = new Error("Enter a valid 11-character IFSC code");
    error.statusCode = 400;
    throw error;
  }
  const row = await IfscMaster.findOne({ ifsc: code, status: { $ne: "INACTIVE" } }).lean();
  if (!row) {
    const error = new Error(`IFSC ${code} not found in MASTER IFSC database`);
    error.statusCode = 404;
    throw error;
  }
  return row;
}

export function ifscSnapshot(row = {}, extras = {}) {
  return {
    ifsc: normalizeIfsc(row.ifsc),
    bankName: clean(row.bank),
    branchName: clean(row.branch),
    branchArea: clean(row.branch),
    bankAddress: clean(row.address),
    city: clean(row.city),
    state: clean(row.state),
    stdCode: clean(row.stdCode),
    phone: clean(row.phone),
    contactNo: formatIfscContact(row),
    ...extras,
  };
}

export async function resolveBankDetails(input = {}, { optional = true } = {}) {
  const hasAny = [
    input.ifsc, input.bankName, input.branchName, input.bankAddress, input.city,
    input.state, input.accountNumber, input.accountName, input.accountHolderName,
  ].some((value) => clean(value));
  if (!hasAny && optional) return null;

  const ifsc = normalizeIfsc(input.ifsc);
  if (!ifsc) {
    const error = new Error("IFSC code is mandatory for bank details");
    error.statusCode = 400;
    throw error;
  }
  const master = await getIfscMaster(ifsc);
  return ifscSnapshot(master, {
    ...(input.accountNumber !== undefined ? { accountNumber: clean(input.accountNumber) } : {}),
    ...(input.accountName !== undefined ? { accountName: clean(input.accountName) } : {}),
    ...(input.accountHolderName !== undefined ? { accountHolderName: clean(input.accountHolderName) } : {}),
  });
}
