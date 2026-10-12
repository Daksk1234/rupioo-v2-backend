import { CompanyProfile, GlobalTransporterStation, Pincode, Transporter } from "../models/index.js";

const cleanText = (value) => String(value ?? "").trim();
const digits = (value) => String(value ?? "").replace(/\D/g, "");
const sameText = (a, b) =>
  cleanText(a).localeCompare(cleanText(b), undefined, { sensitivity: "accent" }) === 0 ||
  cleanText(a).toLowerCase() === cleanText(b).toLowerCase();

async function resolveDestination({ pincode = "", city = "" } = {}) {
  const pin = digits(pincode).slice(0, 6);
  let resolvedCity = cleanText(city);

  // Pincode Master is authoritative for the destination city wherever possible.
  // This is also what makes the city fallback work when customer and transporter
  // use different pincodes of the same city.
  if (pin.length === 6) {
    const geo = await Pincode.findOne({
      pincode: pin,
      status: { $ne: "INACTIVE" },
    })
      .sort({ area: 1 })
      .select("pincode city area district state")
      .lean();
    resolvedCity = cleanText(geo?.city || geo?.area || resolvedCity);
  }

  return { pincode: pin, city: resolvedCity };
}

function normalizedServicePins(station = {}) {
  const explicit = Array.isArray(station.servicePincodes)
    ? station.servicePincodes
        .map((value) => digits(value).slice(0, 6))
        .filter((value) => value.length === 6)
    : [];

  // Legacy fallback only. In the new model station.pincode is the Superadmin
  // BASE STATION and must not be considered a service pincode.
  if (explicit.length) return [...new Set(explicit)];
  return [];
}

function normalizedServiceCities(station = {}) {
  return [
    ...new Set(
      (Array.isArray(station.serviceCities) ? station.serviceCities : [])
        .map(cleanText)
        .filter(Boolean),
    ),
  ];
}

function stationToMatch(station, local, destination, matchType, companyBase = {}) {
  const servicePins = normalizedServicePins(station);
  const serviceCities = normalizedServiceCities(station);
  const pinIndex = destination.pincode
    ? servicePins.findIndex((pin) => pin === destination.pincode)
    : -1;

  return {
    transporterId: String(local._id),
    localTransporterId: String(local._id),
    globalTransporterId: cleanText(local.globalTransporterId),
    name: cleanText(local.name),
    gstin: cleanText(local.gstin),
    matchType,
    stationId: "",
    // Source/base station always belongs to the Superadmin/company, regardless
    // of which destination service pincode matched this transporter.
    baseStationName: cleanText(companyBase.name || station.name),
    baseStationPincode: digits(companyBase.pincode || station.pincode).slice(0, 6),
    baseStationCity: cleanText(companyBase.city || station.city),
    servicePincode:
      matchType === "PINCODE"
        ? destination.pincode
        : pinIndex >= 0
          ? servicePins[pinIndex]
          : "",
    serviceCity:
      matchType === "CITY"
        ? destination.city
        : pinIndex >= 0
          ? cleanText(serviceCities[pinIndex] || destination.city)
          : destination.city,
  };
}

function uniqueTransporterMatches(rows = []) {
  const seen = new Set();
  return rows
    .filter((row) => {
      const key = cleanText(row.transporterId);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * AUTO CUSTOMER -> TRANSPORTER MATCHING
 *
 * Priority is strict:
 *   1. Exact customer pincode in Transporter.servicePincodes
 *   2. ONLY when no exact-pincode transporter exists, match the customer's
 *      Pincode-Master city against Transporter.serviceCities
 *
 * All matches are returned, so a customer may be mapped to 1, 2, 3... transporters.
 * Coverage is read from the CURRENT SUPERADMIN'S local Transporter List, not from
 * the shared Global Transporter Master.
 */
export async function matchCustomerTransporters({
  tenantKey,
  pincode = "",
  city = "",
  invoiceCityOnly = false,
} = {}) {
  const destination = await resolveDestination({ pincode, city });

  const company = await CompanyProfile.findOne({ tenantKey })
    .select("pincode city state")
    .lean();
  const companyPin = digits(company?.pincode).slice(0, 6);
  let companyCity = cleanText(company?.city);
  if (companyPin.length === 6 && !companyCity) {
    const baseGeo = await Pincode.findOne({
      pincode: companyPin,
      status: { $ne: "INACTIVE" },
    })
      .sort({ area: 1 })
      .select("city area")
      .lean();
    companyCity = cleanText(baseGeo?.city || baseGeo?.area);
  }
  const companyBase = {
    pincode: companyPin,
    city: companyCity,
    name: [companyCity, companyPin].filter(Boolean).join(" - "),
  };

  const localTransporters = await Transporter.find({
    tenantKey,
    status: { $ne: "INACTIVE" },
  })
    .select("_id globalTransporterId name gstin status stations")
    .lean();

  if (!localTransporters.length) {
    return { matchType: "NONE", destination, items: [] };
  }

  // Compatibility bridge for transporter rows saved before local service-area
  // fields were added to the Transporter schema. The previous version saved
  // those service areas in GlobalTransporterStation. We only borrow the global
  // station whose BASE PINCODE matches this Superadmin's local base station, so
  // another tenant's station is not mixed into this company's coverage.
  const legacyRows = localTransporters.filter((local) =>
    !(local.stations || []).some(
      (station) =>
        normalizedServicePins(station).length ||
        normalizedServiceCities(station).length,
    ),
  );
  if (legacyRows.length) {
    const gids = [...new Set(legacyRows.map((row) => cleanText(row.globalTransporterId)).filter(Boolean))];
    const legacyGlobalStations = gids.length
      ? await GlobalTransporterStation.find({
          globalTransporterId: { $in: gids },
          status: "ACTIVE",
        }).lean()
      : [];

    for (const local of legacyRows) {
      const localBase = (local.stations || [])[0] || {};
      const basePin = digits(localBase.pincode).slice(0, 6);
      const candidates = legacyGlobalStations.filter(
        (station) => cleanText(station.globalTransporterId) === cleanText(local.globalTransporterId),
      );
      const source =
        candidates.find(
          (station) => digits(station.pincode).slice(0, 6) === basePin,
        ) || (candidates.length === 1 ? candidates[0] : null);
      if (!source) continue;

      local.stations = [{
        ...localBase,
        city: cleanText(localBase.city || source.city),
        state: cleanText(localBase.state || source.state),
        servicePincodes: Array.isArray(source.servicePincodes) ? source.servicePincodes : [],
        serviceCities: Array.isArray(source.serviceCities) ? source.serviceCities : [],
        serviceStates: Array.isArray(source.serviceStates) ? source.serviceStates : [],
      }];
    }
  }

  // SALES INVOICE RULE (2026-10-08):
  // Show every transporter serving the customer's CITY, but explicitly EXCLUDE
  // any transporter whose service-area list contains the customer's exact pincode.
  // Customer Create/Edit keeps using the normal exact-pincode-first mapping below.
  if (invoiceCityOnly) {
    if (!destination.city) {
      return {
        matchType: "NONE",
        rule: "CITY_ONLY_EXACT_EXCLUDED",
        destination,
        items: [],
      };
    }

    const cityRows = [];
    for (const local of localTransporters) {
      const stations = local.stations || [];
      const servesExactPincode = Boolean(
        destination.pincode &&
          stations.some((station) =>
            normalizedServicePins(station).includes(destination.pincode),
          ),
      );
      if (servesExactPincode) continue;

      const cityStation = stations.find((station) =>
        normalizedServiceCities(station).some((serviceCity) =>
          sameText(serviceCity, destination.city),
        ),
      );
      if (!cityStation) continue;

      cityRows.push(
        stationToMatch(
          cityStation,
          local,
          destination,
          "CITY",
          companyBase,
        ),
      );
    }

    return {
      matchType: cityRows.length ? "CITY" : "NONE",
      rule: "CITY_ONLY_EXACT_EXCLUDED",
      destination,
      items: uniqueTransporterMatches(cityRows),
    };
  }

  // 1) EXACT PINCODE. If even one transporter serves this exact pincode,
  // city fallback must NOT add any extra transporter.
  if (destination.pincode.length === 6) {
    const exactRows = [];
    for (const local of localTransporters) {
      const station = (local.stations || []).find((st) =>
        normalizedServicePins(st).includes(destination.pincode),
      );
      if (station) {
        exactRows.push(
          stationToMatch(station, local, destination, "PINCODE", companyBase),
        );
      }
    }

    const exact = uniqueTransporterMatches(exactRows);
    if (exact.length) {
      return { matchType: "PINCODE", destination, items: exact };
    }
  }

  // 2) CITY FALLBACK. This runs only when exact pincode produced zero matches.
  if (destination.city) {
    const cityRows = [];
    for (const local of localTransporters) {
      const station = (local.stations || []).find((st) =>
        normalizedServiceCities(st).some((serviceCity) =>
          sameText(serviceCity, destination.city),
        ),
      );
      if (station) {
        cityRows.push(stationToMatch(station, local, destination, "CITY", companyBase));
      }
    }

    const cityMatches = uniqueTransporterMatches(cityRows);
    if (cityMatches.length) {
      return { matchType: "CITY", destination, items: cityMatches };
    }
  }

  return { matchType: "NONE", destination, items: [] };
}


/**
 * Sales Invoice transporter options.
 * Keeps customer-master mapping unchanged while applying the invoice-only rule:
 * CITY matches are allowed, exact customer-pincode transporters are excluded.
 */
export async function matchInvoiceCityTransporters(args = {}) {
  return matchCustomerTransporters({ ...args, invoiceCityOnly: true });
}
