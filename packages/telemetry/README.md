# @poc/telemetry

Runtime telemetry, structured logging, run retention, and secret redaction for ProjectX workers and workflows.

## Value-Pattern Secret Scrubbing (UC9.3)

Telemetry and logs employ a two-tier redaction architecture:

1. **Key-Name Redaction**: Sensitive object fields matching `SECRET_KEY_REGEX`, manifest `widget: "secret"` configurations, or caller-provided `additionalRedactKeys` are redacted at the field level, producing `[REDACTED]`.
2. **Value-Pattern Scrubbing**: Strings in free text (error messages, stack traces, request URLs, unkeyed log fields) are scanned against `VALUE_PATTERNS` (`packages/telemetry/src/value-patterns.ts`) to redact sensitive tokens into type-tagged placeholders (`[REDACTED:<kind>]`).

### Supported Value Patterns

| Kind | Target Secret Format | Pattern / Prefix | Redaction Placeholder |
|---|---|---|---|
| `bearer` | HTTP Bearer authentication credentials | `\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b` | `[REDACTED:bearer]` |
| `jwt` | JSON Web Tokens | `\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b` | `[REDACTED:jwt]` |
| `stripe` | Stripe API keys & webhook secrets | `\b(?:sk\|rk)_(?:live\|test)_[A-Za-z0-9]+\b`, `\bwhsec_[A-Za-z0-9]+\b` | `[REDACTED:stripe]` |
| `github` | GitHub PATs & fine-grained tokens | `\bgh[pousr]_[A-Za-z0-9]{36,}\b`, `\bgithub_pat_[A-Za-z0-9_]{22,}\b` | `[REDACTED:github]` |
| `slack` | Slack bot and user tokens | `\bxox[abposr]-[A-Za-z0-9-]+\b` | `[REDACTED:slack]` |
| `aws` | AWS Access Key IDs | `\bAKIA[0-9A-Z]{16}\b` | `[REDACTED:aws]` |
| `google` | Google / Firebase API keys | `\bAIza[0-9A-Za-z_-]{35}\b` | `[REDACTED:google]` |
| `pem` | PEM Private Key blocks | `-----BEGIN [A-Z ]*PRIVATE KEY-----...` | `[REDACTED:pem]` |
| `url_query` | Sensitive query parameters | `[?&](?:key\|token\|sig\|signature\|access_token)=<value>` | `?<param>=[REDACTED:url_query]` |

### Negative Controls (Preserved Values)

Ordinary non-secret operational identifiers are preserved without false-positive redaction:
- Standard UUIDs (e.g. `9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d`)
- ISO 8601 timestamps (e.g. `2026-11-06T13:07:42.123Z`)
- 40-hex / 64-hex SHA hashes (git commit SHAs, build hashes)
- Non-sensitive URL query parameters (e.g. `?build=...&id=...`)

### Additive Integration Patterns

Custom value patterns can be supplied at call time via `RedactTelemetryOptions.valuePatterns`:

```ts
import { redactTelemetryString, type ValuePattern } from "@poc/telemetry";

const customPatterns: ValuePattern[] = [
  {
    kind: "internal_id",
    regex: /\bACME-[0-9]{6}\b/g,
    pattern: /\bACME-[0-9]{6}\b/g,
  },
];

const cleaned = redactTelemetryString("Customer ACME-123456 placed order", {
  valuePatterns: customPatterns,
});
// Result: "Customer [REDACTED:internal_id] placed order"
```

### Performance

Scrubbing operates linearly using single-pass regex evaluation with fast prefix checks (`fastCheck`) for high-throughput string pipelines:
- Typical overhead on 1 MB payloads: `< 20 ms` (tested under 100 ms limit to prevent CI jitter).
