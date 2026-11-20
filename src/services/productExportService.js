import mongoose from "mongoose";
import XLSX from "xlsx";

const MAX_CELL_TEXT = 32767;
const MAX_SHEET_ROWS = 1048575; // Header occupies the remaining Excel row.
const MAX_SHEET_COLUMNS = 16384;
const {EJSON} = mongoose.mongo.BSON;

export function productListFilter(tenantKey, query = {}) {
  const filter = {tenantKey};
  if (query.status) filter.status = query.status;
  if (query.category) filter.category = query.category;
  const search = String(query.q || "").trim();
  if (search) filter.$or = ["name", "sku", "category", "hsnCode", "hsnDescription", "barcode"]
    .map(key => ({[key]: new RegExp(search, "i")}));
  return filter;
}

function cellValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return value.toISOString();
  if (value?._bsontype === "ObjectId") return value.toHexString();
  if (["Decimal128", "Long", "Int32", "Double"].includes(value?._bsontype)) return value.toString();
  if (typeof value === "number") {
    // Excel keeps only 15 significant digits; store longer numbers as text.
    return !Number.isFinite(value) || Number(value.toPrecision(15)) !== value ||
      (Number.isInteger(value) && Math.abs(value) >= 1e15) ? String(value) : value;
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return String(value);
  return EJSON.stringify(value, {relaxed: false});
}

const keyPath = (parent, key) => /^[A-Za-z_$][\w$]*$/.test(key)
  ? (parent ? `${parent}.${key}` : key)
  : `${parent}[${JSON.stringify(key)}]`;

export function flattenProductDocument(document) {
  const cells = new Map();
  const put = (path, value) => {
    const result = cellValue(value);
    if (typeof result !== "string" || result.length <= MAX_CELL_TEXT) {
      cells.set(path, result);
      return;
    }
    // Keep long descriptions/source data intact using adjacent continuation
    // columns instead of silently truncating them at Excel's cell limit.
    let offset = 0, part = 1;
    while (offset < result.length) {
      let end = Math.min(offset + MAX_CELL_TEXT, result.length);
      if (end < result.length && /[\uD800-\uDBFF]/.test(result[end - 1])) end--;
      cells.set(part === 1 ? path : `${path} [part ${part}]`, result.slice(offset, end));
      offset = end;
      part++;
    }
  };
  const visit = (path, value) => {
    put(path, value);
    if (!value || typeof value !== "object" || value instanceof Date ||
      value._bsontype || Buffer.isBuffer(value) || value instanceof RegExp) return;
    if (Array.isArray(value)) value.forEach((item, index) => visit(`${path}[${index}]`, item));
    else Object.entries(value).forEach(([key, item]) => visit(keyPath(path, key), item));
  };
  Object.entries(document).forEach(([key, value]) => visit(keyPath("", key), value));
  return cells;
}

export function createProductExportWorkbook(documents) {
  const rows = documents.map(flattenProductDocument);
  const keys = new Set(rows.flatMap(row => [...row.keys()]));
  const priority = new Map(["_id", "sku", "name"].map((key, index) => [key, index]));
  const headers = [...keys].sort((left, right) =>
    (priority.get(left) ?? 3) - (priority.get(right) ?? 3) || left.localeCompare(right));
  if (!headers.length) headers.push("_id");
  const book = XLSX.utils.book_new();
  const otherHeaders = headers.filter(key => key !== "_id");
  const hasId = headers.includes("_id");
  const columnLimit = MAX_SHEET_COLUMNS - (hasId ? 1 : 0);
  const columnGroups = Math.max(1, Math.ceil(otherHeaders.length / columnLimit));
  const rowGroups = Math.max(1, Math.ceil(rows.length / MAX_SHEET_ROWS));
  for (let columnGroup = 0; columnGroup < columnGroups; columnGroup++) {
    const columns = [
      ...(hasId ? ["_id"] : []),
      ...otherHeaders.slice(columnGroup * columnLimit, (columnGroup + 1) * columnLimit),
    ];
    for (let rowGroup = 0; rowGroup < rowGroups; rowGroup++) {
      const records = rows.slice(rowGroup * MAX_SHEET_ROWS, (rowGroup + 1) * MAX_SHEET_ROWS);
      const sheet = XLSX.utils.aoa_to_sheet([
        columns, ...records.map(record => columns.map(key => record.get(key))),
      ]);
      sheet["!cols"] = columns.map(key => ({wch: Math.min(45, Math.max(18, key.length + 2))}));
      sheet["!autofilter"] = {ref: sheet["!ref"]};
      const name = rowGroups === 1 && columnGroups === 1 ? "Products" : `Products ${rowGroup + 1}-${columnGroup + 1}`;
      XLSX.utils.book_append_sheet(book, sheet, name);
    }
  }
  return book;
}
