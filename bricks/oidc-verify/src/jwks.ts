import { OidcVerificationError, type JsonWebKey } from "./types.ts";

export interface JwksCacheEntry {
  keys: JsonWebKey[];
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  lastUnknownKidRefetch: number;
}

const memoryJwksCache = new Map<string, JwksCacheEntry>();

export function clearJwksCacheForTest(): void {
  memoryJwksCache.clear();
}

export interface JwksFetchOptions {
  fetcher?: typeof fetch;
  now?: () => number;
}

export async function resolveJwksUri(issuer: string, configuredUri?: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (configuredUri && configuredUri.trim().length > 0) {
    return configuredUri.trim();
  }

  const cleanIssuer = issuer.replace(/\/+$/, "");
  const discoveryUrl = `${cleanIssuer}/.well-known/openid-configuration`;

  try {
    const res = await fetcher(discoveryUrl, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const data = (await res.json()) as { jwks_uri?: string };
      if (typeof data.jwks_uri === "string" && data.jwks_uri.length > 0) {
        return data.jwks_uri;
      }
    }
  } catch {
    // Fallback to standard well-known jwks.json path
  }

  return `${cleanIssuer}/.well-known/jwks.json`;
}

async function fetchJwksFromNetwork(jwksUri: string, fetcher: typeof fetch, now: number, existingEntry?: JwksCacheEntry): Promise<JwksCacheEntry> {
  let res: Response;
  try {
    res = await fetcher(jwksUri, {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    throw new OidcVerificationError("jwks_unavailable", `Failed to contact JWKS endpoint: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    throw new OidcVerificationError("jwks_unavailable", `JWKS endpoint returned HTTP status ${res.status}`);
  }

  let body: { keys?: JsonWebKey[] };
  try {
    body = (await res.json()) as { keys?: JsonWebKey[] };
  } catch (err) {
    throw new OidcVerificationError("jwks_unavailable", `Invalid JSON from JWKS endpoint: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!body || !Array.isArray(body.keys)) {
    throw new OidcVerificationError("jwks_unavailable", "JWKS endpoint response missing keys array");
  }

  // Parse Cache-Control header: clamp between min 60s and max 24h (86400s)
  const cc = res.headers?.get("cache-control") || "";
  const match = cc.match(/max-age=(\d+)/i);
  let maxAgeSec = match ? parseInt(match[1]!, 10) : 3600;
  if (!Number.isFinite(maxAgeSec) || maxAgeSec <= 0) {
    maxAgeSec = 3600;
  }
  maxAgeSec = Math.max(60, Math.min(86400, maxAgeSec));

  const expiresAt = now + maxAgeSec * 1000;
  const staleUntil = now + maxAgeSec * 2 * 1000;

  const entry: JwksCacheEntry = {
    keys: body.keys,
    fetchedAt: now,
    expiresAt,
    staleUntil,
    lastUnknownKidRefetch: existingEntry ? existingEntry.lastUnknownKidRefetch : 0,
  };

  memoryJwksCache.set(jwksUri, entry);

  // Store into Cache API if available in environment
  try {
    const globalCaches = (globalThis as unknown as { caches?: { default?: { put(req: Request, res: Response): Promise<void> } } }).caches;
    if (globalCaches?.default) {
      const cacheReq = new Request(jwksUri);
      const cacheRes = new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${maxAgeSec}`,
        },
      });
      await globalCaches.default.put(cacheReq, cacheRes);
    }
  } catch {
    // Non-fatal if Cache API is unavailable
  }

  return entry;
}

export async function getJwksKey(jwksUri: string, kid?: string, options: JwksFetchOptions = {}): Promise<JsonWebKey> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ? options.now() : Date.now();

  let entry = memoryJwksCache.get(jwksUri);

  // 1. Entry exists and is still fresh
  if (entry && now < entry.expiresAt) {
    if (kid) {
      const found = entry.keys.find((k) => k.kid === kid);
      if (found) return found;

      // Key unknown: check if we can attempt key rotation refetch (at most once per 30s)
      if (now - entry.lastUnknownKidRefetch < 30_000) {
        throw new OidcVerificationError("kid_unknown", `Key identifier "${kid}" not found in JWKS`);
      }

      entry.lastUnknownKidRefetch = now;
      try {
        entry = await fetchJwksFromNetwork(jwksUri, fetcher, now, entry);
        entry.lastUnknownKidRefetch = now;
        const refetched = entry.keys.find((k) => k.kid === kid);
        if (refetched) return refetched;
        throw new OidcVerificationError("kid_unknown", `Key identifier "${kid}" not found in refreshed JWKS`);
      } catch (err) {
        if (err instanceof OidcVerificationError) throw err;
        // If refetch fails, try serving stale if within window
        if (now < entry.staleUntil) {
          const staleFound = entry.keys.find((k) => k.kid === kid);
          if (staleFound) return staleFound;
          throw new OidcVerificationError("kid_unknown", `Key identifier "${kid}" not found in JWKS`);
        }
        throw new OidcVerificationError("jwks_unavailable", "JWKS endpoint unavailable");
      }
    } else {
      if (entry.keys.length > 0) return entry.keys[0]!;
      throw new OidcVerificationError("kid_unknown", "JWKS contains no keys");
    }
  }

  // 2. Cache is expired or empty: fetch fresh JWKS
  try {
    entry = await fetchJwksFromNetwork(jwksUri, fetcher, now, entry);
  } catch (err) {
    // If network fails, serve stale cached keys if within stale-while-revalidate window (max-age * 2)
    if (entry && now < entry.staleUntil) {
      if (kid) {
        const found = entry.keys.find((k) => k.kid === kid);
        if (found) return found;
        throw new OidcVerificationError("kid_unknown", `Key identifier "${kid}" not found in JWKS`);
      }
      if (entry.keys.length > 0) return entry.keys[0]!;
    }
    if (err instanceof OidcVerificationError) throw err;
    throw new OidcVerificationError("jwks_unavailable", "JWKS endpoint unavailable");
  }

  if (kid) {
    const found = entry.keys.find((k) => k.kid === kid);
    if (found) return found;
    throw new OidcVerificationError("kid_unknown", `Key identifier "${kid}" not found in JWKS`);
  }

  if (entry.keys.length > 0) return entry.keys[0]!;
  throw new OidcVerificationError("kid_unknown", "JWKS contains no keys");
}
