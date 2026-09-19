import { CompanyProfile, Pincode } from "../models/index.js";

const clean = (value) => String(value ?? "").trim();
const normalizeCity = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const digits = (value) => String(value || "").replace(/\D/g, "");

async function cityFromPincode(pincode) {
  const pin = digits(pincode).slice(0, 6);
  if (pin.length !== 6) return "";
  const row = await Pincode.findOne({ pincode: pin, status: { $ne: "INACTIVE" } })
    .sort({ area: 1 })
    .select("city area")
    .lean();
  return clean(row?.city || row?.area);
}

export function customerDeliveryAddress(customer = {}) {
  const addresses = Array.isArray(customer?.addresses) ? customer.addresses : [];
  return addresses.find((row) => String(row?.type || "BILLING").toUpperCase() === "BILLING") || addresses[0] || {};
}

export async function resolveFirmDeliveryLocation(tenantKey) {
  const company = await CompanyProfile.findOne({ tenantKey })
    .select("companyName tradeName city state pincode gstin")
    .lean();
  if (!company) throw Object.assign(new Error("Company profile not found"), { statusCode: 409 });
  let city = clean(company.city);
  if (!city) city = await cityFromPincode(company.pincode);
  return {
    company,
    city,
    normalizedCity: normalizeCity(city),
    state: clean(company.state),
    pincode: digits(company.pincode).slice(0, 6),
  };
}

export async function resolveCustomerDeliveryMode({ tenantKey, customer }) {
  const firm = await resolveFirmDeliveryLocation(tenantKey);
  const destination = customerDeliveryAddress(customer);
  let customerCity = clean(destination.city || customer?.city);
  if (!customerCity) customerCity = await cityFromPincode(destination.pincode || customer?.pincode);
  if (!firm.normalizedCity) {
    throw Object.assign(new Error("Set the firm's city in Company Profile before creating customers or invoices"), { statusCode: 409 });
  }
  if (!normalizeCity(customerCity)) {
    throw Object.assign(new Error("Customer delivery city is required to determine Local vs Transport delivery"), { statusCode: 400 });
  }
  const local = firm.normalizedCity === normalizeCity(customerCity);
  return {
    mode: local ? "LOCAL" : "OUTSIDE",
    requiresTransport: !local,
    firmCity: firm.city,
    firmState: firm.state,
    firmPincode: firm.pincode,
    customerCity,
    customerState: clean(destination.state || customer?.state),
    customerPincode: digits(destination.pincode || customer?.pincode).slice(0, 6),
    destination,
  };
}

export function gstTypeFromLocations({ companyGstin = "", customerGstin = "", companyState = "", customerState = "", requested = "CGST_SGST" } = {}) {
  const companyCode = clean(companyGstin).toUpperCase().match(/^\d{2}/)?.[0] || "";
  const customerCode = clean(customerGstin).toUpperCase().match(/^\d{2}/)?.[0] || "";
  if (companyCode && customerCode) return companyCode === customerCode ? "CGST_SGST" : "IGST";
  const companyStateKey = clean(companyState).toLowerCase();
  const customerStateKey = clean(customerState).toLowerCase();
  if (companyStateKey && customerStateKey) return companyStateKey === customerStateKey ? "CGST_SGST" : "IGST";
  return String(requested || "CGST_SGST").toUpperCase() === "IGST" ? "IGST" : "CGST_SGST";
}
