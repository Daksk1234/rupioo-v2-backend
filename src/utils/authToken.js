import { allPermissionCodes } from "../config/permissionCatalogue.js";

// Permission lists can contain more than 1,000 strings. Putting the raw list
// inside a JWT makes the Authorization header tens of kilobytes and can cause
// Node/proxies to reject the request with HTTP 431. Encode catalogue
// permissions as a compact bitset and keep only genuinely non-catalogue
// permissions as strings.
const permissionCodes = allPermissionCodes();
const permissionIndex = new Map(
  permissionCodes.map((code, index) => [code, index])
);
const permissionByteLength = Math.ceil(permissionCodes.length / 8);

export function encodePermissions(permissions = []) {
  const unique = Array.from(
    new Set((Array.isArray(permissions) ? permissions : []).filter(Boolean))
  );

  if (unique.includes("*")) {
    return { permissionBits: "*", permissionExtras: [] };
  }

  const bits = Buffer.alloc(permissionByteLength);
  const extras = [];

  for (const code of unique) {
    const index = permissionIndex.get(code);
    if (index === undefined) {
      extras.push(code);
      continue;
    }
    bits[index >> 3] |= 1 << (index & 7);
  }

  return {
    permissionBits: bits.toString("base64url"),
    permissionExtras: extras,
  };
}

export function decodePermissions(claims = {}) {
  // Backward compatibility for already-issued small legacy JWTs.
  if (Array.isArray(claims.permissions)) {
    return Array.from(new Set(claims.permissions.filter(Boolean)));
  }

  const extras = Array.isArray(claims.permissionExtras)
    ? claims.permissionExtras.filter(Boolean)
    : [];

  if (claims.permissionBits === "*") {
    return Array.from(new Set(["*", ...extras]));
  }

  if (!claims.permissionBits) {
    return Array.from(new Set(extras));
  }

  try {
    const bits = Buffer.from(String(claims.permissionBits), "base64url");
    const decoded = [];

    for (let index = 0; index < permissionCodes.length; index += 1) {
      const byte = bits[index >> 3];
      if (byte !== undefined && (byte & (1 << (index & 7)))) {
        decoded.push(permissionCodes[index]);
      }
    }

    return Array.from(new Set([...decoded, ...extras]));
  } catch {
    return Array.from(new Set(extras));
  }
}
