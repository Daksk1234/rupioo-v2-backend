import XLSX from "xlsx";

export const cleanText = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

export function normalizeHeader(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[%()]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function safeKey(value) {
  const words = normalizeHeader(value).split(" ").filter(Boolean);
  if (!words.length) return "field";
  return words[0] + words.slice(1).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join("");
}

export function readRows(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const first = workbook.Sheets[workbook.SheetNames[0]];
  if (!first) return [];
  return XLSX.utils.sheet_to_json(first, { defval: "", raw: false });
}

export function resolveColumns(firstRow = {}, fields = []) {
  const actual = Object.keys(firstRow);
  const normalized = new Map(actual.map((key) => [normalizeHeader(key), key]));
  const result = {};

  for (const field of fields) {
    const candidates = [field.key, field.label, ...(field.aliases || [])]
      .map(normalizeHeader)
      .filter(Boolean);
    result[field.key] = candidates.map((x) => normalized.get(x)).find(Boolean) || null;
  }
  return result;
}

export function valueFor(row, column, type = "text") {
  if (!column) return undefined;
  const raw = row[column];
  if (type === "number") {
    const n = Number(String(raw ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "date" || type === "datetime-local" || type === "month") {
    const text = cleanText(raw);
    if (!text) return undefined;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? text : date;
  }
  return cleanText(raw);
}

export function genericRowFromSpreadsheet(row, schema = []) {
  const columns = resolveColumns(row, schema);
  const out = {};
  for (const field of schema) {
    const value = valueFor(row, columns[field.key], field.type);
    if (value !== undefined && value !== "") out[field.key] = value;
  }
  return out;
}

export function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
