// Shared server-side identity guards for Collector/Salesperson receipt actions.
// A displayed name is not a database key. We bind both the GlobalCustomer ID
// and (for the Collector App) the tenant-specific CustomerLink record ID.
const clean = (value) => String(value ?? "").trim();
const name = (value) => clean(value).replace(/\s+/g, " ").toLocaleLowerCase("en");
function reject(message) { const error = new Error(message); error.statusCode = 409; throw error; }

export function assertReceiptCustomerLink(customer, { globalId = "", linkId = "", expectedName = "" } = {}) {
  if (!customer || clean(customer.globalCustomerId) !== clean(globalId)) {
    reject("Selected party and resolved customer differ. Receipt was not created.");
  }
  if (linkId && String(customer._id) !== clean(linkId)) {
    reject("Selected party record differs from the resolved customer. Receipt was not created.");
  }
  if (expectedName && name(customer.localName || customer.displayIdentifier || "Customer") !== name(expectedName)) {
    reject("Selected party name no longer matches the customer master. Refresh the customer list before creating a receipt.");
  }
  return true;
}

export function assertReceiptOtpParty(receipt, { expectedGlobalId = "", expectedLinkId = "", expectedName = "" } = {}) {
  if (expectedGlobalId && clean(receipt?.customerGlobalId) !== clean(expectedGlobalId)) {
    reject("This OTP receipt belongs to a different customer. No verification was performed.");
  }
  if (expectedLinkId && clean(receipt?.customerLinkId) !== clean(expectedLinkId)) {
    reject("This OTP receipt belongs to a different customer record. No verification was performed.");
  }
  if (expectedName && name(receipt?.partyNameSnapshot) !== name(expectedName)) {
    reject("This receipt belongs to a different party name. No OTP verification was performed.");
  }
  return true;
}
