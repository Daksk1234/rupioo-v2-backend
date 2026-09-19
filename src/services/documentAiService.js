import { env } from "../config/env.js";
import { Pincode, Product, GlobalCustomer, CustomerLink, GenericRecord } from "../models/index.js";
import { getIfscMaster, ifscSnapshot, formatIfscContact } from "./ifscMasterService.js";
import { findHsnByCode } from "./hsnLookupService.js";
import { flattenedFields } from "../config/documentForms.js";

const clean = (v) => String(v ?? "").trim();
const digits = (v) => clean(v).replace(/\D/g, "");
const upper = (v) => clean(v).toUpperCase();


const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/i;
const DATE_RE = /\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[- ](?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[- ]\d{2,4})\b/i;
const COMMON_GST_RATES = [0, 3, 5, 12, 18, 28];

const moneyNumber = (value) => {
  const raw = clean(value).replace(/[₹,]/g, "").replace(/[^0-9.+-]/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

const compactLines = (text) => String(text || "")
  .replace(/\r/g, "\n")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
  .split(/\n+/)
  .map((line) => line.replace(/\s+/g, " ").trim())
  .filter(Boolean);

function normalizeInvoiceDate(value) {
  const raw = clean(value).replace(/\./g, "-");
  if (!raw) return "";
  let m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) { const mo=Number(m[2]), day=Number(m[3]); if (mo>=1 && mo<=12 && day>=1 && day<=31) return `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`; }
  m = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    const day=Number(m[1]), mo=Number(m[2]);
    if (day>=1 && day<=31 && mo>=1 && mo<=12) {
      let year = Number(m[3]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      return `${year}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;
    }
  }
  m = raw.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{2,4})$/);
  if (m) {
    const months = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
    const month = months[String(m[2]).toUpperCase()];
    let year = Number(m[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    if (month) return `${year}-${String(month).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0,10);
}

function lastMoneyForLabel(lines, labels) {
  const names = Array.isArray(labels) ? labels : [labels];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!names.some((label) => new RegExp(`^${label}\\b`, "i").test(lines[i]))) continue;
    const nums = lines[i].match(/[-+]?\d[\d,]*(?:\.\d+)?/g) || [];
    if (nums.length) return moneyNumber(nums[nums.length - 1]);
  }
  return 0;
}

function extractRoundOff(lines) {
  for (let i=lines.length-1;i>=0;i-=1) {
    const line=lines[i];
    if (!/ROUND\s*OFF|RoundOff/i.test(line)) continue;
    const nums=line.match(/\d[\d,]*(?:\.\d+)?/g)||[];
    if (!nums.length) continue;
    const amount=Math.abs(moneyNumber(nums[nums.length-1]));
    return /\bLESS\b|\(\s*-\s*\)/i.test(line) ? -amount : amount;
  }
  return 0;
}

function closestGstRate(rate) {
  const n = Number(rate || 0);
  return COMMON_GST_RATES.reduce((best, x) => Math.abs(x-n) < Math.abs(best-n) ? x : best, COMMON_GST_RATES[0]);
}

function buildHsnRateMap(lines) {
  const map = new Map();
  let headerMode = "";
  for (const line of lines) {
    if (/HSN\/SAC.*TAXABLE.*TAX RATE.*CGST/i.test(line)) headerMode = "TOTAL_RATE";
    else if (/HSN\/SAC.*CGST.*SGST/i.test(line)) headerMode = "SPLIT_RATE";
    const m = line.match(/^(\d{4,8})\s+(.+)$/);
    if (!m) continue;
    const percents = [...m[2].matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((x)=>Number(x[1]));
    if (!percents.length) continue;
    let rate = percents[0];
    if (headerMode === "SPLIT_RATE" && percents.length >= 2) rate = percents[0] + percents[1];
    map.set(m[1], closestGstRate(rate));
  }
  return map;
}

function candidateItemLines(lines) {
  const headerIndex = lines.findIndex((line) => /(?:S\.?NO|SL).*?(?:PARTICULARS|DESCRIPTION OF GOODS).*HSN\/SAC/i.test(line));
  if (headerIndex < 0) return [];
  const out = [];
  let current = "";
  const flush = () => { if (current) out.push(current.trim()); current = ""; };
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^(?:TOTAL:|OUTPUT\s+(?:CGST|SGST|IGST)|CGST\b|SGST\b|IGST\b|ROUND\s*OFF|LESS\s*:\s*ROUND|AMOUNT CHARGEABLE|HSN\/SAC\s+TAXABLE|HSN\/SAC\s+TOTAL)/i.test(line)) { flush(); break; }
    if (/^\d[\d,]*(?:\.\d+)?$/.test(line) && current) { flush(); break; }
    if (/^\d{1,3}\s+/.test(line)) { flush(); current = line; }
    else if (current) current += ` ${line}`;
  }
  flush();
  return out;
}

function parseOldDmsItem(line, hsnRates) {
  const m = line.match(/^(\d+)\s+(.+?)\s+(\d{4,8})\s+(\d{1,2}(?:\.\d+)?)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)$/);
  if (!m) return null;
  return {
    name: clean(m[2]),
    sku: "",
    hsnCode: m[3],
    gstRate: Number(m[4] || hsnRates.get(m[3]) || 0),
    qty: moneyNumber(m[5]),
    unit: "",
    rate: moneyNumber(m[6]),
    lineAmount: moneyNumber(m[7]),
    discountPct: 0,
  };
}

function parseTallyItem(line, hsnRates) {
  const first = line.match(/^(\d+)\s+(.+)$/);
  if (!first) return null;
  const body = first[2];
  const matches = [...body.matchAll(/\b(\d{4,8})\b/g)];
  if (!matches.length) return null;
  const firstHsn = matches[0];
  const lastHsn = matches[matches.length - 1];
  const name = clean(body.slice(0, firstHsn.index)).replace(/[()]+$/g, "").trim();
  const hsnCode = lastHsn[1];
  const rest = clean(body.slice((lastHsn.index || 0) + lastHsn[0].length));
  const rm = rest.match(/^([\d,.]+)\s+([A-Za-z.]+)\s+(.+?)\s+([A-Za-z.]+)\s+([\d,.]+)$/);
  if (!rm) return null;
  const middle = (rm[3].match(/[\d,.]+/g) || []).map(moneyNumber);
  if (!middle.length) return null;
  const basicRate = middle[middle.length - 1];
  const inclusiveRate = middle.length > 1 ? middle[0] : 0;
  let gstRate = Number(hsnRates.get(hsnCode) || 0);
  if (!gstRate && inclusiveRate > basicRate && basicRate > 0) gstRate = closestGstRate(((inclusiveRate / basicRate) - 1) * 100);
  return {
    name: name || `HSN ${hsnCode}`,
    sku: "",
    hsnCode,
    gstRate,
    qty: moneyNumber(rm[1]),
    unit: clean(rm[2]),
    rate: basicRate,
    lineAmount: moneyNumber(rm[5]),
    discountPct: 0,
  };
}

function extractInvoiceNumber(lines, text) {
  const direct = text.match(/INVOICE\s*NO\.?\s*:\s*([^\n]+?)(?:\s+DATE\s*:|\n|$)/i);
  if (direct) return clean(direct[1]).split(/\s{2,}/)[0];
  const idx = lines.findIndex((line)=>/Invoice\s*No\.?/i.test(line));
  if (idx >= 0) {
    for (let i=idx+1;i<Math.min(lines.length,idx+6);i+=1) {
      const line=lines[i];
      if (/^(?:Delivery Note|Reference No|Buyer|Dispatch|Dated|Mode\/Terms)/i.test(line)) continue;
      const token=line.match(/[A-Z0-9][A-Z0-9\/-]{2,}/i)?.[0];
      if (token) return token;
    }
  }
  return "";
}

function extractInvoiceDate(lines, text) {
  const direct = text.match(/INVOICE\s*NO\.?[^\n]*?DATE\s*:\s*([^\n]+)/i);
  if (direct) { const dm=direct[1].match(DATE_RE); if (dm) return normalizeInvoiceDate(dm[0]); }
  const idx = lines.findIndex((line)=>/Invoice\s*No\.?/i.test(line));
  if (idx >= 0) {
    for (let i=idx;i<Math.min(lines.length,idx+18);i+=1) {
      const dm=lines[i].match(DATE_RE);
      if (dm) { const normalized=normalizeInvoiceDate(dm[0]); if (normalized) return normalized; }
    }
  }
  return "";
}

function salesPartyFromText(lines, text) {
  const direct = text.match(/BILL\s+TO\s*:\s*([^\n]+)/i);
  if (direct) {
    const start = text.search(/BILL\s+TO\s*:/i);
    const endRel = text.slice(start).search(/SHIP\s+TO\s*:/i);
    const segment = endRel > 0 ? text.slice(start,start+endRel) : text.slice(start,start+800);
    return { name:clean(direct[1]), gstin:upper(segment.match(GSTIN_RE)?.[0] || "") };
  }
  const idx = lines.findIndex((line)=>/Buyer\s*\(Bill to\)/i.test(line));
  if (idx >= 0) {
    const name=clean(lines[idx+1] || "");
    const segment=lines.slice(idx,Math.min(lines.length,idx+12)).join("\n");
    return {name,gstin:upper(segment.match(GSTIN_RE)?.[0] || "")};
  }
  return {name:"",gstin:""};
}

function purchasePartyFromText(lines, text) {
  const firstGstin = upper(text.match(GSTIN_RE)?.[0] || "");
  const holder = text.match(/A\/?c Holder(?:'|’)?s Name\s*:\s*([^\n]+)/i)?.[1];
  const taxIdx = lines.findIndex((line)=>/^Tax Invoice/i.test(line));
  let name="";
  if (taxIdx >= 0) {
    for (let i=taxIdx+1;i<Math.min(lines.length,taxIdx+16);i+=1) {
      const line=lines[i];
      if (/^(?:IRN|Ack No|Ack Date|e-Invoice|Invoice No|GSTIN|State Name|Consignee|Buyer)/i.test(line)) continue;
      if (/^[a-f0-9-]{24,}$/i.test(line)) continue;
      name=line; break;
    }
  }
  return {name:clean(name || holder || ""),gstin:firstGstin};
}

export function deterministicInvoiceExtractionFromText({ text, template }) {
  const lines = compactLines(text);
  const isSales = template.type === "SALES_INVOICE";
  const isInvoice = ["SALES_INVOICE","PURCHASE_INVOICE"].includes(template.type);
  if (!isInvoice) return null;
  const marker = /S\.?NO.*PARTICULARS.*HSN\/SAC.*QNTY.*PRICE.*AMOUNT/i.test(text) || /Description of Goods.*HSN\/SAC.*Quantity.*Rate/i.test(text);
  if (!marker) return null;
  const hsnRates=buildHsnRateMap(lines);
  const items=candidateItemLines(lines).map((line)=>parseOldDmsItem(line,hsnRates) || parseTallyItem(line,hsnRates)).filter(Boolean);
  const party=isSales?salesPartyFromText(lines,text):purchasePartyFromText(lines,text);
  const invoiceNo=extractInvoiceNumber(lines,text);
  const date=extractInvoiceDate(lines,text);
  const taxableFromLabel=lastMoneyForLabel(lines,["Taxable Value"]);
  const basicFromLabel=lastMoneyForLabel(lines,["Basic"]);
  const itemTaxable=items.reduce((sum,item)=>sum+Number(item.lineAmount||0),0);
  const cgst=lastMoneyForLabel(lines,["OUTPUT CGST","CGST"]);
  const sgst=lastMoneyForLabel(lines,["OUTPUT SGST","SGST"]);
  const igst=lastMoneyForLabel(lines,["OUTPUT IGST","IGST"]);
  const roundOff=extractRoundOff(lines);
  let invoiceValue=lastMoneyForLabel(lines,["Grand Total"]);
  if (!invoiceValue) {
    const totalCurrency=lines.find((line)=>/^Total\b/i.test(line) && /(?:₹|ī|Rs\.?)/i.test(line));
    if (totalCurrency) {
      const nums=totalCurrency.match(/\d[\d,]*(?:\.\d+)?/g)||[];
      invoiceValue=nums.length?moneyNumber(nums[nums.length-1]):0;
    }
  }
  const taxableValue=taxableFromLabel || basicFromLabel || itemTaxable;
  if (!invoiceValue && taxableValue) invoiceValue=taxableValue+cgst+sgst+igst+roundOff;
  const values={
    invoiceNo,date,remarks:"",
    taxableValue:String(Number(taxableValue||0).toFixed(2)),
    invoiceValue:String(Number(invoiceValue||0).toFixed(2)),
    cgstAmount:String(Number(cgst||0).toFixed(2)),
    sgstAmount:String(Number(sgst||0).toFixed(2)),
    igstAmount:String(Number(igst||0).toFixed(2)),
    roundOff:String(Number(roundOff||0).toFixed(2)),
    billDiscount:"0",otherCharges:"0",
  };
  if (isSales) { values.customerName=party.name; values.customerGstin=party.gstin; values.warehouseName=""; values.orderNo=""; values.arn=""; values.noOfPackages=""; }
  else { values.supplierName=party.name; values.supplierGstin=party.gstin; values.transportationCost="0";values.labourCost="0";values.localFreight="0";values.miscellaneousCost="0"; }
  const confidence=Object.fromEntries(Object.keys(values).map((key)=>[key,values[key]!==""?0.98:0]));
  const warnings=[];
  if (!invoiceNo) warnings.push("Invoice number was not found automatically.");
  if (!date) warnings.push("Invoice date was not found automatically.");
  if (!party.name && !party.gstin) warnings.push(`${isSales?"Buyer":"Supplier"} was not identified from the invoice.`);
  if (!items.length) warnings.push("Product rows could not be read automatically. Add them during review.");
  if (invoiceValue && taxableValue && items.length) {
    const calculated=items.reduce((sum,item)=>sum+(Number(item.qty||0)*Number(item.rate||0)*(1+Number(item.gstRate||0)/100)),0);
    if (calculated && Math.abs(calculated-invoiceValue)>Math.max(2,invoiceValue*0.02)) warnings.push(`Scanned invoice total is ${invoiceValue.toFixed(2)}. Check product rates/taxes before posting.`);
  }
  return {detectedDocumentType:template.type,formId:"",values,confidence,warnings,items,engine:"OLD_DMS_PDF"};
}

async function pdfText(file) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data:file.buffer });
  try {
    const result=await parser.getText();
    return clean(result?.text);
  } finally {
    await parser.destroy().catch(()=>{});
  }
}

export async function extractDocument({ file, template }) {
  const mime=String(file?.mimetype||"").toLowerCase();
  if (["SALES_INVOICE","PURCHASE_INVOICE"].includes(template?.type) && mime==="application/pdf") {
    try {
      const text=await pdfText(file);
      const local=deterministicInvoiceExtractionFromText({text,template});
      if (local && (local.values.invoiceNo || local.items.length || local.values.customerGstin || local.values.supplierGstin)) return local;
    } catch (error) {
      if (!env.openai?.apiKey) throw new Error(`Could not read this PDF locally: ${error.message}. Run npm install after applying the patch so pdf-parse is installed.`);
    }
  }
  if (env.openai?.apiKey) {
    const result=await extractWithOpenAI({file,template});
    return {...result,engine:"OPENAI"};
  }
  if (["SALES_INVOICE","PURCHASE_INVOICE"].includes(template?.type)) {
    throw new Error("This invoice is not a text-readable old-DMS PDF. Upload the original PDF generated by DMS, or configure OPENAI_API_KEY only for scanned/image invoices.");
  }
  throw new Error("OPENAI_API_KEY is not configured on the backend");
}

function jsonFromText(text) {
  const raw = clean(text);
  if (!raw) throw new Error("AI returned an empty response");
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(stripped); } catch {}
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
  throw new Error("AI response was not valid JSON");
}

function buildPrompt(template) {
  const fields = flattenedFields(template).map((x) => ({ key:x.key, label:x.label, type:x.type, required:Boolean(x.required), aliases:x.aliases || [] }));
  const table = template.table ? { key:template.table.key, columns:template.table.columns.map((x)=>({key:x.key,label:x.label,type:x.type,required:Boolean(x.required)})) } : null;
  return `You are the document extraction engine inside an Indian DMS/ERP. Read printed text and handwriting carefully. The uploaded document is expected to be ${template.title}.\n\nReturn ONLY valid JSON with this exact shape:\n{\n  "detectedDocumentType": "${template.type}",\n  "formId": "QR/form id if visible, else empty",\n  "values": { "fieldKey": "extracted value" },\n  "confidence": { "fieldKey": 0.0 },\n  "warnings": ["..."],\n  "items": []\n}\n\nAllowed scalar fields: ${JSON.stringify(fields)}\n${table ? `Line item table: ${JSON.stringify(table)}. Put rows in items.` : "No line items table."}\nRules:\n- Never invent a value. Use empty string when not visible.\n- Confidence is 0 to 1 for each extracted field.\n- Normalize Indian GSTIN/PAN/IFSC/barcodes to uppercase without spaces.\n- Keep account numbers as digits/text exactly as visible; do not mask them.\n- For handwritten content, lower confidence if unclear.\n- Dates should be YYYY-MM-DD when possible; datetime should be YYYY-MM-DDTHH:mm when possible.\n- Numbers must contain only the numeric value, no currency symbols or commas.\n- If the QR payload or printed Form ID is visible, copy it into formId.\n- Preserve full addresses and remarks.\n- For sales and purchase invoices, extract every visible product line into items.
- For invoice item rate, prefer the printed taxable/basic per-unit rate. Do not put a line total into rate.
- Keep invoice number exactly as printed, including prefix, slash, hyphen and suffix.`;
}

function extractionSchema(template) {
  const fields = flattenedFields(template);
  const valueProps = Object.fromEntries(fields.map((field) => [field.key, { type:"string" }]));
  const confidenceProps = Object.fromEntries(fields.map((field) => [field.key, { type:"number", minimum:0, maximum:1 }]));
  const itemCols = template.table?.columns || [];
  const itemProps = Object.fromEntries(itemCols.map((col) => [col.key, { type:"string" }]));
  return {
    type:"object",
    properties:{
      detectedDocumentType:{ type:"string", enum:[template.type] },
      formId:{ type:"string" },
      values:{ type:"object", properties:valueProps, required:fields.map((field)=>field.key), additionalProperties:false },
      confidence:{ type:"object", properties:confidenceProps, required:fields.map((field)=>field.key), additionalProperties:false },
      warnings:{ type:"array", items:{ type:"string" } },
      items:{
        type:"array",
        items:{ type:"object", properties:itemProps, required:itemCols.map((col)=>col.key), additionalProperties:false }
      }
    },
    required:["detectedDocumentType","formId","values","confidence","warnings","items"],
    additionalProperties:false
  };
}

export async function extractWithOpenAI({ file, template }) {
  if (!env.openai?.apiKey) throw new Error("OPENAI_API_KEY is not configured on the backend");
  const mime = file.mimetype || "application/octet-stream";
  const content = [{ type:"input_text", text: buildPrompt(template) }];
  if (mime.startsWith("image/")) {
    content.push({ type:"input_image", detail:env.openai?.detail || "original", image_url:`data:${mime};base64,${file.buffer.toString("base64")}` });
  } else {
    content.push({ type:"input_file", filename:file.originalname || "document.pdf", file_data:`data:${mime};base64,${file.buffer.toString("base64")}` });
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method:"POST",
    headers:{ "Authorization":`Bearer ${env.openai.apiKey}`, "Content-Type":"application/json" },
    body:JSON.stringify({
      model:env.openai.model,
      input:[{ role:"user", content }],
      max_output_tokens:6000,
      text:{ format:{ type:"json_schema", name:`rupio_${template.type.toLowerCase()}_scan`, strict:true, schema:extractionSchema(template) } }
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `AI extraction failed (${response.status})`);
  const text = payload.output_text || (payload.output || []).flatMap((x)=>x.content||[]).find((x)=>x.type==="output_text")?.text || "";
  return jsonFromText(text);
}

export async function enrichExtractedValues({ tenantKey, template, extraction }) {
  const values = { ...(extraction.values || {}) };
  const confidence = { ...(extraction.confidence || {}) };
  const warnings = Array.isArray(extraction.warnings) ? [...extraction.warnings] : [];

  for (const field of flattenedFields(template)) {
    if (values[field.key] === undefined || values[field.key] === null) values[field.key] = "";
  }

  if (values.mobile) values.mobile = digits(values.mobile).slice(-10);
  if (values.companyContactNumber) values.companyContactNumber = digits(values.companyContactNumber).slice(-10);
  if (values.ownerMobile) values.ownerMobile = digits(values.ownerMobile).slice(-10);
  if (values.whatsapp) values.whatsapp = digits(values.whatsapp).slice(-10);
  for (const key of ["gstin","supplierGstin","pan","ownerPan","ifsc","hsnCode","barcode"]) if (values[key]) values[key] = upper(values[key]).replace(/\s+/g, "");
  if (values.pincode) values.pincode = digits(values.pincode).slice(0,6);

  if (values.pincode?.length === 6) {
    const pin = await Pincode.findOne({ pincode:values.pincode }).lean();
    if (pin) {
      values.city = values.city || pin.city || pin.area || "";
      values.district = values.district || pin.district || "";
      values.state = values.state || pin.state || "";
      confidence.city = Math.max(Number(confidence.city || 0), 0.99);
      confidence.district = Math.max(Number(confidence.district || 0), 0.99);
      confidence.state = Math.max(Number(confidence.state || 0), 0.99);
    } else warnings.push(`Pincode ${values.pincode} was not found in Pincode MASTER.`);
  }

  if (values.ifsc) {
    try {
      const row = await getIfscMaster(values.ifsc);
      if (row) {
        const snap = ifscSnapshot(row);
        values.bankName = values.bankName || snap.bankName || "";
        values.bankBranchName = values.bankBranchName || snap.branchName || "";
        values.branchName = values.branchName || snap.branchName || "";
        values.bankAddress = values.bankAddress || snap.address || "";
        values.bankCity = values.bankCity || snap.city || "";
        values.bankState = values.bankState || snap.state || "";
        values.bankContactNo = values.bankContactNo || formatIfscContact(row) || "";
        ["bankName","bankBranchName","branchName","bankAddress","bankCity","bankState","bankContactNo"].forEach((k)=>{ if(values[k]) confidence[k]=0.99; });
      } else warnings.push(`IFSC ${values.ifsc} was not found in IFSC MASTER.`);
    } catch { warnings.push(`IFSC ${values.ifsc} could not be verified.`); }
  }

  if (values.hsnCode) {
    const h = await findHsnByCode(values.hsnCode).catch(()=>null);
    if (h) {
      values.hsnDescription = values.hsnDescription || h.description || h.name || "";
      if (values.gstRate === "" || values.gstRate === undefined) values.gstRate = h.gstRate ?? h.taxRate ?? "";
      confidence.hsnDescription = values.hsnDescription ? 0.99 : Number(confidence.hsnDescription || 0);
      if (values.gstRate !== "") confidence.gstRate = 0.99;
    }
  }

  if (["PURCHASE_INVOICE","SALES_INVOICE"].includes(template.type)) {
    const isSales = template.type === "SALES_INVOICE";
    const gstKey = isSales ? "customerGstin" : "supplierGstin";
    const nameKey = isSales ? "customerName" : "supplierName";
    const idKey = isSales ? "customerGlobalId" : "supplierGlobalId";
    const gstin = upper(values[gstKey]);
    const partyName = clean(values[nameKey]);

    let party = null;
    if (gstin) {
      party = await CustomerLink.findOne({ tenantKey, status:"ACTIVE", displayIdentifier:gstin })
        .select("globalCustomerId localName displayIdentifier")
        .lean()
        .catch(()=>null);
      if (!party) {
        const global = await GlobalCustomer.findOne({ "gstins.value":gstin }).select("hiddenId legalName").lean().catch(()=>null);
        if (global?.hiddenId) party = await CustomerLink.findOne({ tenantKey, status:"ACTIVE", globalCustomerId:global.hiddenId }).select("globalCustomerId localName displayIdentifier").lean().catch(()=>null);
      }
    }
    if (!party && partyName) {
      const safe = partyName.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      party = await CustomerLink.findOne({ tenantKey, status:"ACTIVE", localName:new RegExp(`^${safe}$`,"i") })
        .select("globalCustomerId localName displayIdentifier")
        .lean()
        .catch(()=>null);
    }
    if (party?.globalCustomerId) {
      values[idKey] = party.globalCustomerId;
      values[nameKey] = values[nameKey] || party.localName || "";
      if (!values[gstKey] && String(party.displayIdentifier||"").length === 15) values[gstKey] = upper(party.displayIdentifier);
      confidence[nameKey] = Math.max(Number(confidence[nameKey]||0),0.99);
    } else if (partyName || gstin) {
      warnings.push(`${isSales ? "Buyer" : "Supplier"} could not be matched automatically. Select the party during review.`);
    }

    if (isSales) {
      const warehouseName = clean(values.warehouseName);
      let warehouse = null;
      if (warehouseName) {
        const safeWh = warehouseName.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
        warehouse = await GenericRecord.findOne({ tenantKey, app:"dms", resource:"warehouses", status:"ACTIVE", $or:[{title:new RegExp(`^${safeWh}$`,"i")},{reference:new RegExp(`^${safeWh}$`,"i")}] }).lean().catch(()=>null);
      }
      if (!warehouse) {
        const rows = await GenericRecord.find({ tenantKey, app:"dms", resource:"warehouses", status:"ACTIVE" }).select("_id title reference").limit(2).lean().catch(()=>[]);
        if (rows.length === 1) warehouse = rows[0];
      }
      if (warehouse?._id) {
        values.warehouseId = String(warehouse._id);
        values.warehouseName = values.warehouseName || warehouse.title || warehouse.reference || "";
        confidence.warehouseName = Math.max(Number(confidence.warehouseName||0),0.99);
      }
    }

    const items = Array.isArray(extraction.items) ? extraction.items : [];
    extraction.items = await Promise.all(items.map(async (item)=>{
      const name = clean(item.name);
      const sku = clean(item.sku);
      let matches = [];
      if (sku) {
        matches = await Product.find({ tenantKey, status:"ACTIVE", sku:new RegExp(`^${sku.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}$`,"i") })
          .select("_id name sku hsnCode basicUnit gstRate mrp salePrice warehouseName")
          .limit(5).lean().catch(()=>[]);
      }
      if (!matches.length && name) {
        const safeName = name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
        const tokens = name.split(/\s+/).filter((x)=>x.length>2).slice(0,5);
        const ors = [{ name:new RegExp(`^${safeName}$`,"i") }, { name:new RegExp(safeName,"i") }, ...tokens.map((t)=>({name:new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i")}))];
        matches = await Product.find({ tenantKey, status:"ACTIVE", $or:ors }).select("_id name sku hsnCode basicUnit gstRate mrp salePrice warehouseName").limit(5).lean().catch(()=>[]);
      }
      const mapped = matches.map((p)=>({id:String(p._id),name:p.name,sku:p.sku,hsnCode:p.hsnCode,unit:p.basicUnit,gstRate:p.gstRate,mrp:p.mrp,salePrice:p.salePrice,warehouseName:p.warehouseName}));
      const exact = mapped.find((p)=>sku && upper(p.sku)===upper(sku)) || mapped.find((p)=>name && upper(p.name)===upper(name));
      return { ...item, ...(exact?{productId:exact.id,name:item.name||exact.name||"",hsnCode:item.hsnCode||exact.hsnCode||"",unit:item.unit||exact.unit||"",gstRate:Number(item.gstRate||exact.gstRate||0)}:{}), productMatches:mapped };
    }));
  }

  return { ...extraction, values, confidence, warnings };
}
