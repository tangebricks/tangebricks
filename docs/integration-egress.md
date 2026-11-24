# Integration Egress Security Policy

All outbound integration network traffic in the ProjectX runtime passes through a hardened egress wrapper (`createHardenedFetch`) defined in `@poc/runtime`.

The wrapper protects Worker execution environments and internal resources against Server-Side Request Forgery (SSRF), DNS rebinding, internal network scanning, memory exhaustion DoS, and credential leakage across redirect boundaries.

---

## 1. Security Controls & Enforcements

### Manual Redirect Handling
Outbound HTTP requests are made with `redirect: "manual"`. The runtime never follows redirects implicitly.
For each redirect hop (HTTP 301, 302, 303, 307, 308):
- The `Location` header is parsed and resolved against the current request URL.
- The destination must use `https:`, specify default port (443), contain no credentials (userinfo), and be in the manifest's `allowedHosts` list.
- If the redirect target is not allowed, the runtime throws `INTEGRATION_REDIRECT_FORBIDDEN`.
- A maximum of 5 redirects (`maxRedirects`) is allowed; exceeding this throws `INTEGRATION_TOO_MANY_REDIRECTS`.

### Cross-Host Credential Stripping
- **Same-Host Redirects**: When a redirect points to the same hostname (case-insensitive), sensitive authentication headers (`Authorization`, `Cookie`, API keys) are preserved.
- **Cross-Host Redirects**: When a redirect points to a different allowed host, all credential headers (`authorization`, `cookie`, `x-api-key`, `api-key`, and the manifest `auth.headerName`) are automatically stripped before forwarding.

### Method Rewriting
Per RFC 9110 / RFC 7231, when receiving a 303 (See Other) or receiving a 301/302 on a POST request, the request method is rewritten to `GET`, the request body is cleared, and `Content-Type` / `Content-Length` headers are removed.

### Private IP & DNS Rebinding Protection
Every destination hostname is resolved to IP addresses via DNS-over-HTTPS (`https://cloudflare-dns.com/dns-query` querying `A` and `AAAA` records) and checked with `isPrivateAddress()`.
The request is immediately refused with `INTEGRATION_PRIVATE_ADDRESS` if any resolved address falls within:
- **IPv4 Private / Reserved**:
  - `0.0.0.0/8` (Current network)
  - `10.0.0.0/8` (RFC 1918 Private)
  - `100.64.0.0/10` (RFC 6598 Shared Address Space / CGNAT)
  - `127.0.0.0/8` (Loopback)
  - `169.254.0.0/16` (Link-local / Cloud metadata `169.254.169.254`)
  - `172.16.0.0/12` (RFC 1918 Private)
  - `192.0.0.0/24` (IETF Protocol Assignments) & `192.0.2.0/24` (TEST-NET-1)
  - `192.168.0.0/16` (RFC 1918 Private)
  - `198.18.0.0/15` (Benchmarking) & `198.51.100.0/24` (TEST-NET-2)
  - `203.0.113.0/24` (TEST-NET-3)
  - `224.0.0.0/4` (Multicast) & `240.0.0.0/4` (Reserved / Broadcast)
- **IPv6 Private / Reserved**:
  - `::1` (Loopback) & `::` (Unspecified)
  - `::ffff:0:0/96` (IPv4-mapped IPv6, checked against IPv4 rules)
  - `fc00::/7` (Unique Local Addresses / ULA)
  - `fe80::/10` (Link-local)
  - `ff00::/8` (Multicast)
  - `2001:db8::/32` (Documentation) & `100::/64` (Discard)

DNS resolutions are cached in-isolate according to the DNS record TTL (minimum 10 seconds). In test environments, `resolveHost: undefined` can be specified to disable live DNS lookups.

### Request Timeout
Outbound calls combine any caller `AbortSignal` with an internal timeout signal. If a response is not received within `timeoutMs`, the request aborts with error code `INTEGRATION_TIMEOUT`.

### Response Size Capping
To prevent memory exhaustion and DoS:
- Responses with a `Content-Length` header exceeding `maxResponseBytes` immediately throw `INTEGRATION_RESPONSE_TOO_LARGE`.
- Streaming response bodies are piped through a byte-counting `TransformStream`. If bytes read exceed `maxResponseBytes`, the stream errors with `INTEGRATION_RESPONSE_TOO_LARGE`.

---

## 2. Policy Defaults & Manifest Overrides

| Parameter | Default | Manifest Override | Limits / Allowed Values |
|-----------|---------|-------------------|-------------------------|
| `timeoutMs` | 15,000 ms (15 s) | `operation.timeoutMs` | 1,000 – 120,000 ms |
| `maxResponseBytes` | 10,485,760 bytes (10 MB) | `operation.maxResponseBytes` | 1 – 52,428,800 bytes (≤ 50 MB) |
| `maxRedirects` | 5 hops | N/A | Fixed platform maximum |
| `allowedHosts` | Enforced from manifest | `manifest.allowedHosts` | Valid HTTPS hostnames only |

---

## 3. Error Codes Reference

All egress errors extend `IntegrationEgressError` and set `error.code`:

- `INTEGRATION_HOST_FORBIDDEN`: Initial target host is not in manifest `allowedHosts` or is an illegal hostname.
- `INTEGRATION_REDIRECT_FORBIDDEN`: A redirect hop targeted a host outside `allowedHosts`, used a non-HTTPS scheme, or specified credentials.
- `INTEGRATION_TOO_MANY_REDIRECTS`: The request exceeded the redirect limit (`maxRedirects`).
- `INTEGRATION_TIMEOUT`: The upstream server failed to respond within `timeoutMs`.
- `INTEGRATION_RESPONSE_TOO_LARGE`: Response body or `Content-Length` exceeded `maxResponseBytes`.
- `INTEGRATION_PRIVATE_ADDRESS`: Target hostname resolved to an internal, private, loopback, link-local, or cloud metadata IP address.

All error messages identify the offending host or limit and **never** include tokens, cookies, passwords, or secret connection values.

---

## 4. Retry Policy & Idempotency Contract

Integration operations hitting transient upstream errors (`HTTP 429 Too Many Requests` or `HTTP 503 Service Unavailable`) are governed by strict safety and idempotency rules in `createIntegrationOperationExecutor`.

### Safe vs. Unsafe Operations
- **Retryable Operations**:
  - HTTP methods `GET`, `HEAD`, `OPTIONS`.
  - Operations with `sideEffects: "none"` or `sideEffects: "read"`.
  - Operations declaring an idempotency contract (`operation.idempotency: { header: string }`).
- **Non-Retryable Operations**:
  - Non-idempotent write operations (e.g., `POST`, `PUT`, `PATCH`, `DELETE` with `sideEffects: "write"` without declared idempotency).
  - On receiving 429 or 503, non-idempotent operations make **exactly one** network attempt, failing immediately with `retryable: false` and the HTTP status. Customers are never double-charged or double-messaged.

### Idempotency Key Injection
For declared-idempotent operations:
- An idempotency key is generated once before the request loop begins:
  `options.idempotencyKey?.(ctx) ?? crypto.randomUUID()`
- The same key is sent on the declared header (e.g. `Idempotency-Key`) across every retry attempt.

### Rate-Limit Headers & Backoff
When retrying:
- **`Retry-After` Header**:
  - Parsed as delta seconds (e.g. `Retry-After: 30`) or IMF-fixdate HTTP-date (e.g. `Wed, 21 Oct 2026 07:28:00 GMT`).
- **`x-ratelimit-reset` Header**:
  - Numeric values $\ge 10^9$ are parsed as epoch seconds and converted to milliseconds relative to `now()`.
  - Values $< 10^9$ are parsed as delta seconds.
- **Ceiling Enforcement (`maxRetryAfterMs`)**:
  - Configurable in `operation.rateLimit.maxRetryAfterMs` (default 30,000 ms, max 300,000 ms) or `options.maxSleepMs`.
  - If a server asks to wait longer than the configured ceiling (e.g. `Retry-After: 600`), the executor fails fast with code `RATE_LIMITED`, `retryable: false`, and `retryAfterMs: <delayMs>` without sleeping.
  - Production code paths never use a ceiling below 1,000 ms for server-provided delay hints.

