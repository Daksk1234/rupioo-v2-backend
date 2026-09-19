import { CustomerLink, GlobalCustomer, User } from "../models/index.js";

const clean = (v) => String(v ?? "").trim();
const isObjectIdText = (v) => /^[a-fA-F0-9]{24}$/.test(clean(v));

async function loadPartyDirectory(tenantKey, refs = []) {
  const requested = [...new Set(refs.map(clean).filter(Boolean))];
  if (!requested.length) return new Map();

  const objectIds = requested.filter(isObjectIdText);
  const globals = await GlobalCustomer.find({
    $or: [
      { hiddenId: { $in: requested } },
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ],
  }).select("hiddenId legalName tradeName").lean();

  const expandedRefs = new Set(requested);
  for (const g of globals) {
    if (g.hiddenId) expandedRefs.add(String(g.hiddenId));
    if (g._id) expandedRefs.add(String(g._id));
  }

  const links = await CustomerLink.find({
    tenantKey,
    globalCustomerId: { $in: [...expandedRefs] },
  }).select("globalCustomerId localName displayIdentifier customerCode status").lean();

  const globalByRef = new Map();
  for (const g of globals) {
    if (g.hiddenId) globalByRef.set(String(g.hiddenId), g);
    if (g._id) globalByRef.set(String(g._id), g);
  }

  const linkByRef = new Map();
  for (const link of links) linkByRef.set(String(link.globalCustomerId), link);

  const result = new Map();
  for (const ref of requested) {
    const global = globalByRef.get(ref);
    const candidateRefs = [
      ref,
      global?.hiddenId ? String(global.hiddenId) : "",
      global?._id ? String(global._id) : "",
    ].filter(Boolean);
    const link = candidateRefs.map((x) => linkByRef.get(x)).find(Boolean);
    const linkedGlobal = global || (link ? globalByRef.get(String(link.globalCustomerId)) : null);
    const name = clean(
      link?.localName ||
      linkedGlobal?.tradeName ||
      linkedGlobal?.legalName ||
      link?.displayIdentifier ||
      ref
    );
    const canonicalId = clean(link?.globalCustomerId || linkedGlobal?.hiddenId || ref);
    const info = { name, canonicalId, link, global: linkedGlobal };
    for (const alias of candidateRefs) result.set(alias, info);
    if (canonicalId) result.set(canonicalId, info);
  }
  return result;
}

export async function resolvePartyDisplayMap(tenantKey, refs = []) {
  return loadPartyDirectory(tenantKey, refs);
}

export async function resolveUserDisplayMap(tenantKey, ids = []) {
  const requested = [...new Set(ids.map(clean).filter(isObjectIdText))];
  if (!requested.length) return new Map();
  const users = await User.find({
    _id: { $in: requested },
    $or: [{ tenantKey }, { role: "MASTER" }],
  }).select("name email").lean();
  return new Map(users.map((u) => [String(u._id), clean(u.name || u.email || u._id)]));
}

export async function enrichTransactionRows({
  tenantKey,
  rows = [],
  partyIdKey,
  partySnapshotKey,
  userIdKey = "createdBy",
  userSnapshotKey = "createdByNameSnapshot",
}) {
  const list = rows.map((r) => (typeof r?.toObject === "function" ? r.toObject() : { ...r }));
  const partyRefs = partyIdKey ? list.map((r) => r?.[partyIdKey]).filter(Boolean) : [];
  const userIds = userIdKey ? list.map((r) => r?.[userIdKey]).filter(Boolean) : [];
  const [partyMap, userMap] = await Promise.all([
    resolvePartyDisplayMap(tenantKey, partyRefs),
    resolveUserDisplayMap(tenantKey, userIds),
  ]);

  return list.map((row) => {
    const next = { ...row };
    if (partyIdKey) {
      const ref = clean(row?.[partyIdKey]);
      const info = partyMap.get(ref);
      const snapshot = clean(row?.[partySnapshotKey]);
      const display = clean(info?.name || snapshot || ref);
      next.partyNameDisplay = display;
      if (partySnapshotKey && !snapshot && display) next[partySnapshotKey] = display;
      if (info?.canonicalId) next.partyCanonicalId = info.canonicalId;
    }
    if (userIdKey) {
      const uid = clean(row?.[userIdKey]);
      next.userNameDisplay = clean(row?.[userSnapshotKey] || userMap.get(uid) || uid);
      if (userSnapshotKey && !clean(row?.[userSnapshotKey]) && next.userNameDisplay) next[userSnapshotKey] = next.userNameDisplay;
    }
    return next;
  });
}
