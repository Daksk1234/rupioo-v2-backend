import { Hsn } from "../models/index.js";

const CODE_FIELDS = [
  "code",
  "hsnCode",
  "hsn",
  "hsnNo",
  "hsnNumber",
  "reference",
  "HSN",
  "HSNCode",
  "HSN No",
  "HSN CODE",
  "hsn_code",
];

const DESCRIPTION_FIELDS = [
  "description",
  "title",
  "productDescription",
  "commodityDescription",
  "details",
  "name",
  "hsnDescription",
  "HSN Description",
  "Product Description",
];

const RATE_FIELDS = [
  "gstRate",
  "igstRate",
  "taxRate",
  "taxPercent",
  "gst",
  "gstPercent",
  "gstPercentage",
  "rate",
  "GST",
  "GST %",
  "GST Rate",
  "IGST",
  "IGST %",
];

const cleanText = (value) => String(value ?? "").trim();

export const normalizeHsnLookupCode = (value) =>
  cleanText(value)
    .replace(/^'+/, "")
    .replace(/\.0+$/, "")
    .replace(/[^0-9A-Za-z]/g, "")
    .toUpperCase();

const parseRate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[% ,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const firstText = (row, fields) => {
  for (const field of fields) {
    const value = cleanText(row?.[field]);
    if (value) return value;
  }
  return "";
};

export const resolveHsnTaxRate = (row = {}) => {
  const primaryRates = RATE_FIELDS.map((field) => parseRate(row?.[field])).filter(
    (value) => value !== null,
  );

  const positivePrimary = primaryRates.find((value) => value > 0);
  if (positivePrimary !== undefined) return positivePrimary;

  const cgst = parseRate(row?.cgstRate ?? row?.cgst ?? row?.CGST);
  const sgst = parseRate(row?.sgstRate ?? row?.sgst ?? row?.SGST);
  if (cgst !== null || sgst !== null) {
    const total = Number(cgst || 0) + Number(sgst || 0);
    if (total > 0) return total;
  }

  if (primaryRates.length) return primaryRates[0];
  if (cgst !== null || sgst !== null) return Number(cgst || 0) + Number(sgst || 0);
  return 0;
};

export const normalizeHsnRecord = (row = {}, requestedCode = "") => {
  const storedCode = firstText(row, CODE_FIELDS);
  const code = normalizeHsnLookupCode(storedCode || requestedCode);
  return {
    ...row,
    code,
    description: firstText(row, DESCRIPTION_FIELDS),
    gstRate: resolveHsnTaxRate(row),
    cgstRate: parseRate(row?.cgstRate ?? row?.cgst ?? row?.CGST) ?? undefined,
    sgstRate: parseRate(row?.sgstRate ?? row?.sgst ?? row?.SGST) ?? undefined,
    igstRate: parseRate(row?.igstRate ?? row?.igst ?? row?.IGST) ?? undefined,
    cessRate: parseRate(row?.cessRate ?? row?.cess ?? row?.CESS) ?? 0,
  };
};

const exactConditions = (normalizedCode) => {
  const values = [normalizedCode];
  if (/^\d+$/.test(normalizedCode)) values.push(Number(normalizedCode));
  return CODE_FIELDS.flatMap((field) => values.map((value) => ({ [field]: value })));
};

const flexibleCodeRegex = (normalizedCode) => {
  const escapedChars = normalizedCode
    .split("")
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Accept stored formats such as 3924 10 90, 3924.10.90, '39241090 and 39241090.0.
  return new RegExp(
    `^[^0-9A-Za-z]*${escapedChars.join("[^0-9A-Za-z]*")}(?:\\.0+)?[^0-9A-Za-z]*$`,
    "i",
  );
};

const isInactive = (row) => {
  const status = cleanText(row?.status).toUpperCase();
  return status === "INACTIVE" || row?.active === false || row?.isActive === false;
};

export async function findHsnByCode(value) {
  const normalizedCode = normalizeHsnLookupCode(value);
  if (!normalizedCode) return null;

  // Use the raw collection so lookups remain compatible with HSN documents
  // created by older Rupio/DMS versions that used different field names.
  let row = await Hsn.collection.findOne({ $or: exactConditions(normalizedCode) });

  if (!row) {
    const regex = flexibleCodeRegex(normalizedCode);
    row = await Hsn.collection.findOne({
      $or: CODE_FIELDS.map((field) => ({ [field]: regex })),
    });
  }

  if (!row || isInactive(row)) return null;
  return normalizeHsnRecord(row, normalizedCode);
}
