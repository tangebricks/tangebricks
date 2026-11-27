import { collectSecretStringsFromValue } from "@poc/telemetry";

export const DEFAULT_SECRET_HEADER_AND_FIELD_NAMES = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "api_key",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "client_secret",
  "clientsecret",
  "secret",
  "token",
  "password",
  "authheader",
];

export const NON_SECRET_CONNECTION_METADATA_KEYS = new Set([
  "app",
  "scope",
  "type",
  "headerName",
  "prefix",
  "in",
  "queryParam",
  "expiresAt",
  "workspaceId",
  "ref",
  "id",
  "status",
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectConnectionSecretValues(conn: Record<string, unknown>, trackedSecrets: Set<string>): void {
  for (const [key, val] of Object.entries(conn)) {
    if (NON_SECRET_CONNECTION_METADATA_KEYS.has(key)) continue;
    if (typeof val === "string" && val.trim().length >= 3) {
      trackedSecrets.add(val);
      trackedSecrets.add(val.trim());
    } else if (isPlainObject(val) || Array.isArray(val)) {
      collectSecretStringsFromValue(val, trackedSecrets);
    }
  }
}

export function collectConnectionsMapSecrets(connections: Readonly<Record<string, Record<string, unknown>>> | undefined, trackedSecrets: Set<string>): void {
  if (!connections) return;
  for (const conn of Object.values(connections)) {
    if (isPlainObject(conn)) {
      collectConnectionSecretValues(conn, trackedSecrets);
    }
  }
}

export function trackSecretValue(val: unknown, trackedSecrets: Set<string>): void {
  if (val === undefined || val === null) return;
  const strVal =
    typeof val === "string" ? val : typeof val === "number" || typeof val === "boolean" ? String(val) : typeof val === "object" ? JSON.stringify(val) : null;
  if (strVal && strVal.trim().length >= 3) {
    trackedSecrets.add(strVal);
    trackedSecrets.add(strVal.trim());
  } else if (isPlainObject(val) || Array.isArray(val)) {
    collectSecretStringsFromValue(val, trackedSecrets);
  }
}
