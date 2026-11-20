import {GlobalCustomer, CustomerLink} from "../models/index.js";
import {searchTaxpayer} from "./gstService.js";

const asRows = value => Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
const firstValue = rows => asRows(rows).find(row => row.primary && row.active !== false)?.value ||
  asRows(rows).find(row => row.active !== false)?.value || "";

export async function lookupCustomerGst(rawGstin, {tenantKey, lookupTaxpayer = searchTaxpayer} = {}) {
  const gstin = String(rawGstin || "").trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    throw Object.assign(new Error("Enter a valid 15-character GSTIN."), {status:400});
  }
  const global = await GlobalCustomer.findOne({"gstins.value":gstin})
    .select("hiddenId legalName tradeName pan gstins registeredAddress gstProfile mobiles emails").lean();
  if (!global || (!global.legalName && !global.tradeName && !global.registeredAddress)) {
    return lookupTaxpayer(gstin);
  }
  // Only this company's profile may supplement the shared registry identity.
  // Another tenant's commercial, owner, bank or login data is never searched.
  const company = tenantKey && global.hiddenId ? await CustomerLink.findOne({tenantKey, globalCustomerId:global.hiddenId, status:{$ne:"DELETED"}})
    .select("localName tradeName ownerName ownerMobile companyContactNumber businessType firmType gstStatus gstRange eInvoiceStatus filingFrequency addresses address2").lean() : null;
  const addresses = asRows(company?.addresses);
  const billing = addresses.find(address => address.type === "BILLING") || addresses[0] || {};
  const gstRecord = asRows(global.gstins).find(row => row.value === gstin) || {};
  const geo = {pncd:billing.pincode || "",locality:billing.area || "",loc:billing.city || "",dst:billing.district || "",stcd:billing.state || ""};
  return {
    source:"GLOBAL_CUSTOMER_REGISTRY", gstin, globalCustomerId:global.hiddenId,
    verified:gstRecord.status === "VERIFIED" || Boolean(gstRecord.verifiedAt),
    legalName:global.legalName || "",tradeName:global.tradeName || company?.tradeName || "",
    businessName:company?.localName || global.tradeName || global.legalName || "",
    pan:global.pan || gstin.slice(2,12), ownerName:company?.ownerName || "",
    ownerMobile:company?.ownerMobile || "",email:firstValue(global.emails),
    companyContactNumber:company?.companyContactNumber || firstValue(global.mobiles),
    taxpayerType:global.gstProfile?.taxpayerType || "",
    constitution:company?.firmType || global.gstProfile?.constitution || "",
    businessType:company?.businessType || "",status:company?.gstStatus || gstRecord.status || "",
    jurisdictionCentre:company?.gstRange || "",eInvoiceStatus:company?.eInvoiceStatus || "",
    filingFrequency:company?.filingFrequency || global.gstProfile?.filingStatus || "",
    principalAddress:billing.address || global.registeredAddress || "",principalAddressRaw:geo,
    principalGeo:{latitude:billing.latitude ?? "",longitude:billing.longitude ?? ""},
    additionalAddress:company?.address2 || "",additionalAddressRaw:{},additionalPlaces:[],
  };
}
