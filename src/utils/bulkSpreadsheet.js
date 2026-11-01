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

export function readRows(buffer, options = {}) {
  const preserveText = Boolean(options?.preserveText);
  // CSV parsers can otherwise auto-convert ambiguous values such as
  // 03-04-2025 to March 4, 2025 before the module-specific date parser
  // gets a chance to apply DD-MM-YYYY rules.  preserveText keeps CSV
  // cell values exactly as supplied by the user.
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: false,
    ...(preserveText ? { raw: true } : {}),
    ...(options?.formattedDates ? { cellNF: true } : {}),
  });
  const first = workbook.Sheets[workbook.SheetNames[0]];
  if (!first) return [];
  const rows = XLSX.utils.sheet_to_json(first, {
    defval: "",
    raw: preserveText ? true : false,
  });
  if (options?.formattedDates) {
    // Excel dates are numeric internally. Only accept a number if the cell
    // actually has an Excel date number-format; use exactly what Excel shows.
    // CSV values remain untouched, including DD-MM-YYYY ambiguity.
    const headers = XLSX.utils.sheet_to_json(first, {header:1,raw:true})[0] || [];
    const columnMap = headers.map((key,index)=>({key,col:index}));
    rows.forEach((row,index)=>{
      columnMap.forEach(({key,col})=>{
        const address=XLSX.utils.encode_cell({r:Number.isInteger(row.__rowNum__)?row.__rowNum__:index+1,c:col});
        const cell=first[address];
        if (cell?.t==="n" && typeof cell.z==="string" && XLSX.SSF.is_date(cell.z))
          row[key]=XLSX.utils.format_cell(cell);
      });
    });
  }
  return rows;
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
