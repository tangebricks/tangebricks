/**
 * Outbound-request guards shared by every package that fetches a URL it did not write itself.
 *
 * Two layers live here:
 * - address and host classification (private/loopback/link-local/CGNAT/metadata IPs, forbidden host names), which the
 *   runtime's integration egress (`createHardenedFetch`) and the assembler's manifest validation reuse; and
 * - `createPublicUrlFetch`, a fetch wrapper for tenant-supplied URLs (outbound webhooks, cron targets, the HTTP request
 *   node): http/https only, no credentials in the URL, no private or metadata destinations, and every redirect hop is
 *   checked again before it is followed.
 *
 * Refusals throw `EgressForbiddenError` with a stable `code`; callers record that code, never upstream response text.
 */

export type IPv4Octets = [number, number, number, number];

export function parseIPv4(ip: string): IPv4Octets | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isPrivateIPv4(octets: IPv4Octets): boolean {
  const [a, b, c] = octets;
  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC 1918 Private)
  if (a === 10) return true;
  // 100.64.0.0/10 (RFC 6598 Shared Address Space / CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local / Cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC 1918 Private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments) and 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  // 192.168.0.0/16 (RFC 1918 Private)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast) and 240.0.0.0/4 (Reserved / Broadcast)
  if (a >= 224) return true;
  return false;
}

export function parseIPv6(ip: string): number[] | null {
  let str = ip.toLowerCase();
  const zoneIndex = str.indexOf("%");
  if (zoneIndex !== -1) {
    str = str.slice(0, zoneIndex);
  }

  // Handle embedded IPv4
  const lastColon = str.lastIndexOf(":");
  if (lastColon !== -1) {
    const possibleIpv4 = str.slice(lastColon + 1);
    if (possibleIpv4.includes(".")) {
      const ipv4 = parseIPv4(possibleIpv4);
      if (!ipv4) return null;
      const hexPart1 = ((ipv4[0] << 8) | ipv4[1]).toString(16);
      const hexPart2 = ((ipv4[2] << 8) | ipv4[3]).toString(16);
      str = `${str.slice(0, lastColon)}:${hexPart1}:${hexPart2}`;
    }
  }

  const doubleColonCount = (str.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let words: number[];
  if (doubleColonCount === 1) {
    const [head, tail] = str.split("::");
    const headWords = head && head.length > 0 ? head.split(":").map((h) => parseInt(h, 16)) : [];
    const tailWords = tail && tail.length > 0 ? tail.split(":").map((t) => parseInt(t, 16)) : [];
    if (headWords.some(isNaN) || tailWords.some(isNaN)) return null;
    const missing = 8 - (headWords.length + tailWords.length);
    if (missing < 1) return null;
    words = [...headWords, ...Array(missing).fill(0), ...tailWords];
  } else {
    words = str.split(":").map((w) => parseInt(w, 16));
    if (words.length !== 8 || words.some(isNaN)) return null;
  }
  return words;
}

function embeddedIPv4(high: number, low: number): IPv4Octets {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

function isPrivateIPv6(words: number[]): boolean {
  const firstFiveZero =
    words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0;
  // Loopback ::1
  if (firstFiveZero && words[5] === 0 && words[6] === 0 && words[7] === 1) return true;
  // Unspecified ::
  if (words.every((w) => w === 0)) return true;
  // IPv4-mapped IPv6 ::ffff:0:0/96
  if (firstFiveZero && words[5] === 0xffff) return isPrivateIPv4(embeddedIPv4(words[6]!, words[7]!));
  // IPv4-compatible ::a.b.c.d (deprecated, still routed by some stacks)
  if (firstFiveZero && words[5] === 0) return isPrivateIPv4(embeddedIPv4(words[6]!, words[7]!));
  // NAT64 well-known prefix 64:ff9b::/96
  if (
    words[0] === 0x64 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0
  ) {
    return isPrivateIPv4(embeddedIPv4(words[6]!, words[7]!));
  }
  // 6to4 2002::/16 carries the IPv4 address in bits 16-47
  if (words[0] === 0x2002) return isPrivateIPv4(embeddedIPv4(words[1]!, words[2]!));
  // ULA fc00::/7 (fc00:: - fdff::)
  if ((words[0]! & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10
  if ((words[0]! & 0xffc0) === 0xfe80) return true;
  // Multicast ff00::/8
  if ((words[0]! & 0xff00) === 0xff00) return true;
  // Documentation 2001:db8::/32
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
  // Discard-only 100::/64
  if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true;
  return false;
}

/** True for private, loopback, link-local (incl. cloud metadata), CGNAT, reserved and multicast IPv4/IPv6 addresses. */
export function isPrivateAddress(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed) return true;

  const ipv4 = parseIPv4(trimmed);
  if (ipv4) return isPrivateIPv4(ipv4);

  const ipv6 = parseIPv6(trimmed);
  if (ipv6) return isPrivateIPv6(ipv6);

  return false;
}

/** Strips IPv6 brackets and a trailing root dot so a URL hostname can be classified. */
function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** True when the host is an IPv4 or IPv6 literal (brackets allowed). */
export function isIpLiteral(host: string): boolean {
  const h = normalizeHostname(host);
  return parseIPv4(h) !== null || (h.includes(":") && parseIPv6(h) !== null);
}

/** Host names that always point at the local machine, the local network, or a cloud metadata service. */
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/**
 * True for host names that resolve to the local machine or network: `localhost`, `*.localhost`, `*.local` (mDNS).
 * Shared by the integration allow-list rules and the public-URL guard.
 */
export function isLocalHostname(host: string): boolean {
  const h = normalizeHostname(host);
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local");
}

/** True for host names a tenant-supplied URL may never target (local, internal, cloud metadata). */
export function isForbiddenPublicHostname(host: string): boolean {
  const h = normalizeHostname(host);
  if (!h) return true;
  if (isLocalHostname(h)) return true;
  if (h === "internal" || h.endsWith(".internal")) return true;
  if (METADATA_HOSTNAMES.has(h)) return true;
  return false;
}

const HOSTNAME_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IPV4_LITERAL_REGEX = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Rules for an integration's declared `allowedHosts` entry: a plain public DNS name only (no wildcards, schemes, paths,
 * credentials, ports, IP literals, or local names).
 */
export function isForbiddenIntegrationHost(host: string): boolean {
  const trimmed = host.trim();
  if (!trimmed) return true;
  if (trimmed.includes("*")) return true;
  if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("@")) {
    return true;
  }
  if (trimmed.includes(":") || trimmed.startsWith("[") || trimmed.endsWith("]")) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (isLocalHostname(lower)) {
    return true;
  }
  if (IPV4_LITERAL_REGEX.test(lower) || /^\d+$/.test(lower)) {
    return true;
  }
  return !HOSTNAME_REGEX.test(lower);
}

export type HostResolver = (host: string) => Promise<string[]>;

interface DnsAnswerRecord {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DnsResponse {
  Status: number;
  Answer?: DnsAnswerRecord[];
}

const DOH_TIMEOUT_MS = 5_000;

const dnsCache = new Map<string, { ips: string[]; expiresAt: number }>();

/** Resolves A/AAAA records over DNS-over-HTTPS. Returns [] when resolution fails (the fetch itself will then fail). */
export async function defaultResolveHost(host: string): Promise<string[]> {
  const trimmed = normalizeHostname(host);
  if (parseIPv4(trimmed) || parseIPv6(trimmed)) {
    return [trimmed];
  }

  const now = Date.now();
  const cached = dnsCache.get(trimmed);
  if (cached && cached.expiresAt > now) {
    return cached.ips;
  }

  const ips: string[] = [];
  let minTtl = 60;

  for (const qType of ["A", "AAAA"]) {
    try {
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(trimmed)}&type=${qType}`;
      const res = await fetch(url, {
        headers: { Accept: "application/dns-json" },
        // A DoH lookup must never hang the caller; a timed-out lookup yields no addresses.
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as DnsResponse;
        if (data.Answer) {
          for (const ans of data.Answer) {
            if (ans.type === 1 || ans.type === 28) {
              if (ans.data) ips.push(ans.data.trim());
              if (typeof ans.TTL === "number" && ans.TTL > 0) {
                minTtl = Math.min(minTtl, ans.TTL);
              }
            }
          }
        }
      }
    } catch {
      // Offline / network failure / timeout: no addresses. The public-URL guard refuses an empty answer.
    }
  }

  if (ips.length > 0) {
    const ttlMs = Math.max(minTtl, 10) * 1000;
    dnsCache.set(trimmed, { ips, expiresAt: now + ttlMs });
  }
  return ips;
}

export type EgressErrorCode = "EGRESS_FORBIDDEN" | "EGRESS_TOO_MANY_REDIRECTS" | "EGRESS_TIMEOUT";

/** A refused or aborted outbound request. `message` is written by the guard and never contains upstream text. */
export class EgressForbiddenError extends Error {
  readonly code: EgressErrorCode;
  constructor(code: EgressErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "EgressForbiddenError";
    this.code = code;
  }
}

export function isEgressForbiddenError(err: unknown): err is EgressForbiddenError {
  return err instanceof EgressForbiddenError;
}

/**
 * Throws `EgressForbiddenError` unless the URL is an http(s) URL without credentials whose host is neither a forbidden
 * name nor (directly or once resolved) a private address.
 */
export async function assertPublicUrl(target: URL, resolveHost: HostResolver | null = defaultResolveHost): Promise<void> {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new EgressForbiddenError("EGRESS_FORBIDDEN", `scheme "${target.protocol}" is not allowed (http or https only)`);
  }
  if (target.username !== "" || target.password !== "") {
    throw new EgressForbiddenError("EGRESS_FORBIDDEN", "URLs with embedded credentials are not allowed");
  }
  const host = normalizeHostname(target.hostname);
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) {
      throw new EgressForbiddenError("EGRESS_FORBIDDEN", `address "${host}" is private, loopback, link-local or reserved`);
    }
    return;
  }
  if (isForbiddenPublicHostname(host)) {
    throw new EgressForbiddenError("EGRESS_FORBIDDEN", `host "${host}" is a local, internal or metadata host`);
  }
  if (!resolveHost) return;
  let ips: string[];
  try {
    ips = await resolveHost(host);
  } catch {
    throw new EgressForbiddenError("EGRESS_FORBIDDEN", `host "${host}" could not be resolved`);
  }
  // Fail closed: a name we cannot resolve (intranet-only names, DoH outage) is never fetched, because the platform's
  // own lookup at fetch time could still land on an internal address.
  if (ips.length === 0) {
    throw new EgressForbiddenError("EGRESS_FORBIDDEN", `host "${host}" does not resolve to any address`);
  }
  for (const ip of ips) {
    if (isPrivateAddress(ip)) {
      throw new EgressForbiddenError("EGRESS_FORBIDDEN", `host "${host}" resolves to a private address`);
    }
  }
}

export interface PublicUrlFetchOptions {
  /** Host resolver; tests inject one to stay offline. Defaults to DNS-over-HTTPS. `null` skips resolution checks. */
  readonly resolveHost?: HostResolver | null;
  /** Redirect hops followed (each re-validated) before giving up. Default 5. */
  readonly maxRedirects?: number;
  /** Whole-request timeout including redirects. Default 15 s. */
  readonly timeoutMs?: number;
}

export type BaseFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type PublicUrlFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie", "proxy-authorization", "x-api-key", "api-key", "apikey"];

/**
 * Wraps a fetch so it only reaches public http(s) destinations. Redirects are followed manually and every hop is
 * validated again, so a public URL cannot bounce the request to an internal address.
 */
export function createPublicUrlFetch(base: BaseFetcher, options: PublicUrlFetchOptions = {}): PublicUrlFetcher {
  const resolveHost = options.resolveHost === undefined ? defaultResolveHost : options.resolveHost;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let currentUrl: URL;
    try {
      currentUrl = new URL(typeof input === "string" ? input : input.toString());
    } catch {
      throw new EgressForbiddenError("EGRESS_FORBIDDEN", "target is not a valid absolute URL");
    }

    let method = (init?.method ?? "GET").toUpperCase();
    // The caller's headers are passed through untouched on the first hop; they are only copied (and trimmed) when a
    // redirect has to drop credentials or the body.
    let headers: RequestInit["headers"] = init?.headers;
    let body = init?.body;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("EGRESS_TIMEOUT"));
    }, timeoutMs);
    const callerSignal = init?.signal;
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason));
    }
    // Host validation (including DNS resolution) runs inside the same deadline as the request itself.
    const deadline = new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(
          timedOut
            ? new EgressForbiddenError("EGRESS_TIMEOUT", `request to "${currentUrl.hostname}" timed out after ${timeoutMs}ms`)
            : controller.signal.reason,
        );
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort);
    });
    deadline.catch(() => {});
    const validate = (target: URL) => Promise.race([assertPublicUrl(target, resolveHost), deadline]);

    try {
      await validate(currentUrl);
      for (let hop = 0; ; hop += 1) {
        let response: Response;
        try {
          response = await base(currentUrl.toString(), {
            ...init,
            method,
            ...(headers !== undefined ? { headers } : {}),
            body,
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (err) {
          if (timedOut) {
            throw new EgressForbiddenError("EGRESS_TIMEOUT", `request to "${currentUrl.hostname}" timed out after ${timeoutMs}ms`);
          }
          throw err;
        }

        if (!REDIRECT_STATUSES.has(response.status)) return response;
        const location = response.headers.get("location");
        if (!location) return response;

        if (hop + 1 > maxRedirects) {
          throw new EgressForbiddenError("EGRESS_TOO_MANY_REDIRECTS", `more than ${maxRedirects} redirects`);
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new EgressForbiddenError("EGRESS_FORBIDDEN", "redirect Location is not a valid URL");
        }
        try {
          await validate(nextUrl);
        } catch (err) {
          if (err instanceof EgressForbiddenError) {
            throw new EgressForbiddenError(err.code, `redirect refused: ${err.message.replace(/^[A-Z_]+: /, "")}`);
          }
          throw err;
        }
        // Drain the redirect body so the connection can be reused.
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }

        const nextHeaders = new Headers(headers);
        if (nextUrl.origin !== currentUrl.origin) {
          for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) nextHeaders.delete(name);
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = method === "HEAD" ? "HEAD" : "GET";
          body = undefined;
          nextHeaders.delete("content-type");
          nextHeaders.delete("content-length");
        }
        headers = nextHeaders;
        currentUrl = nextUrl;
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
