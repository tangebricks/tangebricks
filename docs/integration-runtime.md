# Integration Runtime Refusal Layers and Error Codes

This document details the runtime and editing architecture for enforcing the **lossless-or-refuse** contract established in Epic UC2.

## Lossless-or-Refuse Principle

When an integration spec has structural losses during import (for example, required request body fields truncated by a cap, unsupported body content types, or missing parameters), allowing an operation to execute would send an incomplete, malformed, or unintended payload to a third-party API.

To protect user data and third-party account state, operations with **blocking fidelity losses** are refused across three independent layers:
1. **Graph edit time** (Blueprint editor)
2. **Catalog / MCP discovery** (Projected nodes & MCP server tools)
3. **Runtime execution** (Integration operation executor)

---

## 1. Multi-Layer Refusal Architecture

### Layer 1: Graph Edit Time (Blueprint Editor)
When an agent or user constructs or edits a workflow graph:
- `applyOp` with `add_node` or `update_node` inspects the target node type.
- If the node belongs to an integration operation carrying blocking fidelity losses (`blocking: true` in `manifest.fidelity.unsupported`), `applyOp` rejects the operation with error code `INTEGRATION_OPERATION_UNSUPPORTED`.
- The returned error provides:
  - `code`: `INTEGRATION_OPERATION_UNSUPPORTED`
  - `path`: `workflows.<workflowId>.nodes.<nodeId>`
  - `message`: names the integration operation and the blocking fidelity issues.
  - `suggestedFix`: lists every blocking code and instructs the user or agent to resolve the fidelity loss or pick an alternative operation.

### Layer 2: Projected Node Definition & MCP Discovery
Integration manifests are projected into standard workflow nodes via `projectIntegrationToNodes(manifest)`:
- Operations with blocking fidelity losses are marked with `availability: "unsupported"`.
- Operations without blocking fidelity losses (including those with only non-blocking entries) are marked with `availability: "available"`.
- In MCP Server tools (`packages/mcp-server/src/tools.ts`):
  - `get_node`: returns the `availability` attribute for the requested node.
  - `search_nodes`: by default filters out unsupported nodes (`availability === "unsupported"`) to prevent agents from choosing invalid operations. Passing `includeUnsupported: true` allows inspecting all nodes for diagnostic purposes.

### Layer 3: Runtime Execution (`integration-executor.ts`)
The final, immutable safety gate runs inside the executor returned by `createIntegrationOperationExecutor`:
- At the very top of the returned executor, before parameter parsing, secret tracking, connection resolution, or network I/O, the runtime inspects `manifest.fidelity?.unsupported`.
- If any entry matching the target `operation.operationId` (or document-level `op === null` / `op === "*"`) has `blocking: true`, the executor throws immediately:
  ```
  INTEGRATION_UNSUPPORTED_FEATURE: Integration "<app>" operation "<operationId>" cannot run faithfully: <CODE> at <POINTER>
  ```
- **Guarantees**:
  - Outbound fetch calls: **0**
  - Connection lookups (`ctx.connection`): **0**
  - Canary or secret unsealing: **0**

---

## 2. Blocking vs. Non-Blocking Losses

Fidelity entries in `manifest.fidelity.unsupported` declare whether a loss is blocking:

| Loss Type | `blocking` | Behavior |
|-----------|------------|----------|
| `BODY_REQUIRED_FIELD_CAPPED` | `true` | Refused at all 3 layers with `INTEGRATION_UNSUPPORTED_FEATURE` |
| `SWAGGER2_BODY_DROPPED` | `true` | Refused at all 3 layers with `INTEGRATION_UNSUPPORTED_FEATURE` |
| `CONTENT_TYPE_UNSUPPORTED` | `true` | Refused at all 3 layers with `INTEGRATION_UNSUPPORTED_FEATURE` |
| `PARAM_LOCATION_UNSUPPORTED` | `true` | Refused at all 3 layers with `INTEGRATION_UNSUPPORTED_FEATURE` |
| `BODY_FREEFORM_DROPPED` | `true` | Refused at all 3 layers with `INTEGRATION_UNSUPPORTED_FEATURE` |
| `PARAM_ENUM_DROPPED` | `false` | Non-blocking: operation executes normally |
| `RESPONSE_SCHEMA_IGNORED` | `false` | Non-blocking: output payload returned as `body` |
| `PARAM_DEFAULT_DROPPED` | `false` | Non-blocking: operation executes normally |

---

## 3. Error Codes Summary

- **`INTEGRATION_UNSUPPORTED_FEATURE`**: Thrown by `createIntegrationOperationExecutor` and `callOperation` when attempting to execute an operation carrying blocking fidelity defects.
- **`INTEGRATION_OPERATION_UNSUPPORTED`**: Blueprint validation code in `DOCUMENTED_ERROR_CODES` returned by `applyOp` (`add_node`, `update_node`).
- **`INTEGRATION_OPERATION_NOT_FOUND`**: Thrown by `callOperation` when the requested `operationId` is not present in `manifest.operations`.
- **`INTEGRATION_MISSING_PARAM`**: Thrown by `callOperation` when a required path parameter, header parameter, query parameter, or body field is omitted in `args`.
- **`INTEGRATION_CONNECTION_MISSING`**: Thrown when authentication is required by `manifest.auth` but no connection is provided in options.
- **`INTEGRATION_CONNECTION_MISMATCH`**: Thrown when connection credential `app` does not match `manifest.app`.

---

## 4. Standalone `callOperation()` API

As established in **UC3.1**, `callOperation()` exposes standalone operation execution outside a workflow node:

```ts
export async function callOperation(
  manifest: IntegrationManifestFile,
  operationId: string,
  args: Readonly<Record<string, unknown>>,
  options: CallOperationOptions,
): Promise<CallOperationResult>
```

### Options (`CallOperationOptions`)
- `connection: Record<string, unknown> | null`: Connection credentials (e.g. `accessToken`, `apiKey`, `basicToken`, etc.).
- `fetcher: IntegrationFetcher`: Outbound HTTP fetcher (wrapped automatically with `createHardenedFetch`).
- `blobStore?: BlobStore`: Binary store reference (consumed in UC3.6).
- `idempotencyKey?: string`: Optional idempotency key to attach to requests.
- `signal?: AbortSignal`: Cancellation signal.
- `maxSleepMs?: number`: Rate-limiting retry ceiling in milliseconds.
- `sleep?: (ms: number) => Promise<void>`: Pluggable sleep timer function.
- `now?: () => number`: Pluggable clock function.
- `resolveHost?: (host: string) => Promise<string[]>`: Custom host resolver for private address checking.

### Result (`CallOperationResult`)
- `ok: true`: Indicates successful execution.
- `status: number`: HTTP status code from provider response (e.g. 200).
- `data: unknown`: Extracted data payload (via `response.dataPath` or fallback).
- `body: unknown`: Decoded response body.
- `headers: Record<string, string>`: Normalized lowercase response headers.
- `pagesFetched: number`: Total number of pages fetched (≥ 1).
- `truncated: boolean`: True if pagination capped before exhausting results.
- `nextCursor: string | null`: Next pagination cursor if truncated, otherwise null.

### Idempotency Hook
- When an operation declares `idempotency: { header: string }`, and `options.idempotencyKey` is provided, `callOperation` injects that header on the initial request and all retries.
- The workflow node executor automatically generates `idempotencyKey = ${runId}:${nodeId}` when `ctx.runId` and `ctx.nodeId` are both present.
- If the op does not declare an idempotency header or no key is provided, no idempotency header is injected.

### Error Handling (`IntegrationCallError`)
Failures throw `IntegrationCallError extends Error`:
- `code: string`: The error code (e.g. `INTEGRATION_HTTP_ERROR`, `RATE_LIMITED`, `INTEGRATION_UNSUPPORTED_FEATURE`).
- `status?: number`: HTTP status code if the error was returned from the provider.
- `retryable?: boolean`: False for fatal errors.
- `providerCode?: string`: Provider error code, read through `operation.response.errorShape.codePath` (redacted, at most 300 characters).
- `providerMessage?: string`: Provider-specific error message.
- `body?: unknown`: Redacted provider error body. The egress `maxResponseBytes` cap (10 MB default) bounds the download; `error.body` itself is additionally capped at 16 KiB of JSON, beyond which it becomes `{truncated: true, text}`.
- `retryAfterMs?: number`: Delay in milliseconds if rate limited.
- `message`: Retains the standard `CODE: message` prefix.

---

## 5. Parameter Fidelity & Serialization Table (UC3.4)

Runtime parameter serialization in `callOperation()` (`packages/runtime/src/param-serialization.ts`) complies with the OpenAPI 3.1 parameter style specification:

| Location | Style | Explode | Input Type | Serialized Format | Example / Wire Output |
|---|---|---|---|---|---|
| `query` | `form` (default) | `true` (default) | Array | Separate key-value pairs | `ids=a&ids=b` |
| `query` | `form` (default) | `false` | Array | Comma-delimited | `ids=a,b` |
| `query` | `spaceDelimited` | `false` | Array | Space-delimited | `ids=a%20b` |
| `query` | `pipeDelimited` | `false` | Array | Pipe-delimited | `ids=a\|b` |
| `query` | `deepObject` | `true` | Object | Bracket notation | `filter[status]=paid&filter[created][gte]=1` |
| `query` | `deepObject` | `true` | Array | Normalized array convention | `expand[]=a&expand[]=b` |
| `path` | `simple` (default) | `false` / `true` | Array | Comma-delimited segment | `1,2,3` |
| `header` | `simple` (default) | `false` / `true` | Array | Comma-delimited string | `a,b` |
| `cookie` | `form` (default) | `true` / `false` | Primitive | Cookie name-value pair | Assembled into `Cookie: name=value` |
| Any | `label` / `matrix` | Any | Any | Unsupported | Throws `INTEGRATION_UNSUPPORTED_FEATURE` |

### Parameter Validation & Security Guardrails
1. **Enum Validation**: If a parameter declares `enum`, values outside the allowed set are rejected before fetch with `INTEGRATION_INVALID_PARAM` (0 network fetches made).
2. **Reserved Path Expansion (`allowReserved: true`)**: Discovery `{+name}` parameters allow path separators (`/`), while path traversal guards strictly reject directory traversal (`..`, `%2e%2e`), backslashes (`\`), and userinfo (`@`).
3. **Cookie Parameter Ingestion**: Cookie parameters are assembled into the outbound `Cookie` header. Cookie names are tracked in `secretFieldNames` only if they match an active authentication scheme.
4. **Enums > 256**: Enums with more than 256 options are truncated during import and reported as `approximated` `PARAM_ENUM_TRUNCATED`.

---

## 6. Auth Requirements Model, Composite Auth, & Default Headers (UC3.3)

### Auth Model & Security Requirements
Integration manifests represent upstream OpenAPI / Discovery security declarations faithfully:
- **`manifest.auth.schemes`**: Dictionary of declared schemes (`apiKey`, `http`, `oauth2`, `openIdConnect`, `mutualTLS`).
- **`manifest.auth.requirements`**: An array of arrays (an OR of ANDs). Each requirement specifies schemes that must be satisfied together (e.g., Cashfree requires `x-client-id`, `x-client-secret`, and `x-api-version`).
- **Operation-level overrides (`operation.security`)**: Operations can override the root security model. An operation with `security: []` declares public access.

### Composite Header Authentication (`type: "headers"`)
For APIs requiring multi-header credentials (e.g. Cashfree, Razorpay, or multi-key gateways):
- `manifest.auth.type` can be `"headers"`.
- `manifest.auth.headers` maps header names to template strings containing literals and `{{conn.<field>}}` placeholders (e.g. `{"x-client-id": "{{conn.clientId}}", "x-client-secret": "{{conn.clientSecret}}", "x-api-version": "2023-08-01"}`).
- Expressions outside `{{conn.<identifier>}}` grammar are rejected at schema validation time.
- All rendered values containing `conn.*` placeholders are added to `trackedSecrets`, and their header names are added to `secretFieldNames` for automatic error and log redaction.
- Missing required connection properties reject with `INTEGRATION_CONNECTION_INCOMPLETE: missing conn.<field>`.
- `auth.connectionFields` exposes the extracted connection field names in the catalog entry so connection widgets can build input forms without provider-specific logic.

### Static Default Headers & Header Precedence
1. **Manifest Default Headers**: Declared via `manifest.defaultHeaders` (e.g. `{"x-platform-source": "projectx"}`).
   - Forbidden headers: `authorization`, `cookie`, `host`, `content-length` (case-insensitive).
   - Templates (`{{`) are strictly forbidden.
2. **Execution Header Precedence**:
   1. `manifest.defaultHeaders` applied first to the outbound request.
   2. `auth` applied next (OAuth2 Bearer, Basic, API Key, or Composite Headers), unless the operation's effective security is `[]`.
   3. `param` headers applied last. If any header parameter collides with an active auth header, `callOperation` immediately rejects with `INTEGRATION_HEADER_CONFLICT`.
3. **Public Operations**: Operations with effective `security: []` skip authentication headers entirely. No auth headers are sent and no connection is required.

---

## 7. Response Outputs & Provider Error Shape (UC3.2)

- **Outputs.** `operation.response.outputs` become typed output ports. At run time each port is read from the extracted data (after `response.dataPath`), then from the raw body. `out`, `status`, `body` and `data` keep their fixed meaning.
- **`response.errorShape`** (`{codePath?, messagePath?, typePath?}`, dot paths into the error body). On a non-2xx response `callOperation` reads `providerCode` and `providerMessage` through it (string or number values only). The error message becomes `CODE: Integration "app" operation "op" failed with HTTP <status>: <providerCode>: <providerMessage>`.
- Without an `errorShape`, or when its paths find nothing, the message keeps the previous redacted 300-character body slice.
- Every provider field and `error.body` pass through the same redaction as the rest of the call (tracked connection secrets and secret field names).

---

## 8. Response Semantics: Predicates, Pagination Styles, & Truncation (UC3.8)

### Declarative Predicates (`errorWhen` / `successWhen`)

APIs such as Slack return HTTP 200 with an error envelope (e.g. `{ "ok": false, "error": "channel_not_found" }`). To prevent provider error payloads from being treated as successful executions, manifests support declarative predicates:

- **Manifest-level vs. Operation-level**:
  - `manifest.errorWhen` / `manifest.successWhen`: Default evaluation applied to every operation in the manifest.
  - `operation.errorWhen` / `operation.successWhen`: Operation-specific override or addition.
- **Fixed Vocabulary Schema (`PredicateSchema`)**:
  - Direct value check: `{ path: string, equals: string | number | boolean }`
  - Membership check: `{ path: string, in: Array<string | number | boolean> }`
  - Property existence check: `{ path: string, exists: boolean }`
  - Logical combinations: `{ all: Predicate[] }` or `{ any: Predicate[] }`
  - Nesting depth is strictly capped at `depth <= 2`.
  - Prototype injection keys (`__proto__`, `prototype`, `constructor`) and arbitrary expressions are forbidden.
- **Runtime Evaluation**:
  - Evaluated immediately after body parsing in `callOperation` and `integration-executor`.
  - If `errorWhen` matches `true`, or if `successWhen` matches `false`, execution immediately fails with:
    - `code`: `INTEGRATION_PROVIDER_ERROR`
    - `providerCode`: read from `operation.response.errorShape.codePath` or `body.error`
    - `providerMessage`: read from `operation.response.errorShape.messagePath` or `body.error`
    - `retryable`: `false`

### Pagination Styles

The runtime pagination loop (`IntegrationPaginationSchema`) supports 7 distinct pagination strategies (`style`):

1. **`cursor`**: Query parameter cursor update. Next cursor read from response body via `nextCursorPath` (e.g. `response_metadata.next_cursor`).
2. **`page`**: Incremental page number query parameter (e.g. `page=1, 2, 3...`).
3. **`link`**: RFC 5988 `Link: <url>; rel="next"` header navigation.
4. **`offset`**: Offset counter query parameter incremented by page item count (e.g. `offset=0, 20, 40...`).
5. **`bodyNextUrl`**: Next page URL extracted directly from response body via `nextUrlPath` (e.g. `@odata.nextLink` or `paging.next.link`). The extracted URL's host is strictly validated against `manifest.allowedHosts`; URLs pointing to unlisted hosts reject immediately with `INTEGRATION_HOST_FORBIDDEN`.
6. **`headerToken`**: Next page token extracted from a response header via `tokenHeader` (e.g. `X-Next-Page-Token`).
7. **`lastItemCursor`**: Last item ID extraction cursor (e.g. Stripe `starting_after`). Reads the ID of the last item in `responsePath` using `itemIdPath` (default `"id"`), continuing while `hasMorePath` (default `"has_more"`) evaluates to `true`.

### Truncation Guarantees (`truncated`, `nextCursor`)

- **Page Cap (`maxPages`)**: Configurable between 1 and 100 pages (default 5).
- **Explicit Truncation Signal**:
  - When the loop hits `maxPages` and more data remains available: returns `truncated: true` and `nextCursor: "<token>"`.
  - When all data is exhausted: returns `truncated: false` and `nextCursor: null`.
  - Node outputs in workflow blueprints expose `truncated` (`boolean`) and `nextCursor` (`string`) output ports alongside `data` and `pagesFetched`.

---

## 7. Content Types, Binary Payloads, Host `BlobStore`, and Streaming Caps (UC3.6)

### Content Type Selection & Preference Order
When an OpenAPI spec declares multiple request body media types, the importer selects the most capable type according to a deterministic preference hierarchy:
```
application/json > application/x-www-form-urlencoded > multipart/form-data > application/octet-stream > text/*
```
- Chosen media type is recorded as `mapped` with `CONTENT_TYPE_MAPPED` (`FIDELITY_CODES.CONTENT_TYPE_MAPPED`), recording non-selected alternatives in `from`.
- Specs declaring unsupported body formats (e.g. XML-only) are reported `unsupported` with `CONTENT_TYPE_UNSUPPORTED` and `blocking: true`.
- Google Discovery methods declaring `supportsMediaUpload` yield `<id>_upload` operations with `multipart/related` request bodies, reported `normalized` with `MEDIA_UPLOAD_VARIANT`.

### Request Body Serialization
- **`multipart/form-data`**: Encodes text and primitive fields into `FormData`. Body fields configured with `{ blobRef }` resolve binary streams from the host `BlobStore` and attach as `File` objects with part name, filename, and MIME type.
- **`application/octet-stream`**: Consumes `{ blobRef }` directly from the host `BlobStore`, streaming raw bytes to the target fetcher.
- **`multipart/related`**: Constructs a two-part body containing JSON metadata in Part 1 and binary media stream from `BlobStore` in Part 2 separated by a standard multipart boundary.
- **`text/plain`** / **`text/*`**: Encodes string arguments directly into the outbound request body.

### Binary Responses via Host `BlobStore`
- Response media types that are `text/*` return string values under output port `text`.
- Binary responses (`application/pdf`, `application/octet-stream`, `image/*`, `audio/*`, `video/*`, etc.) stream directly into the host `BlobStore` via `blobStore.put(body, { contentType, maxBytes })`.
- **Zero-Bytes-in-State Guarantee**: Workflow step outputs never serialize raw binary bytes (preventing Cloudflare Workflows state payload bloat and memory pressure). Step outputs carry strictly reference metadata:
  ```json
  {
    "blobRef": "blob_c56a4180-65aa-42ec-a945-5fd21dec0538",
    "contentType": "application/pdf",
    "size": 3145728
  }
  ```
- Executing an operation returning or uploading binary data when no `blobStore` is configured in `options` rejects immediately with `INTEGRATION_BLOBSTORE_MISSING`.

### Streaming Byte Caps (`maxBytes`)
- Configured per operation response in `operation.response.maxBytes` (default 10 MiB, maximum 100 MiB).
- Enforced while streaming chunk-by-chunk: if total bytes consumed exceed `maxBytes`, the stream reader cancels immediately and throws `INTEGRATION_PAYLOAD_TOO_LARGE` after reading at most `maxBytes + 64KiB`. Large payloads are never buffered into memory before refusal.

### R2 Storage Binding (`INTEGRATION_BLOBS`)
- In production Cloudflare Workers deployments, `createR2BlobStore(bucket, { workspaceId })` stores binary objects under key pattern:
  ```
  int-blobs/<workspaceId>/<uuid>
  ```
- **Conditional Binding Emission**: The assembler inspects the compiled workflow graph. The `INTEGRATION_BLOBS` R2 binding is emitted in `wrangler.json` / worker configuration **only** when at least one node in the graph executes an operation with binary request fields or a binary response (`isBinaryOperation`). Graphs without binary operations omit the R2 binding entirely.

---

## 8. Typed Gateway Adapter Pattern (UC3.9) <a id="typed-adapters"></a>

The **typed gateway adapter pattern** decouples domain bricks (like `credit-wallet`) from specific payment or SaaS integrations while enabling real third-party provider calls without importing runtime or provider-specific code into the brick.

### Pattern Principles
1. **Interface in the Brick**: The brick declares a clean, domain-specific interface (`PaymentGateway` in `bricks/credit-wallet/src/gateway.ts`) describing strictly what the brick requires (`createOrder`, `fetchOrder`) with domain types (`GatewayOrder { status, amount }`). The brick has **zero** imports of `@poc/runtime` or `integrations/*`.
2. **Adapter Outside the Brick**: Reference adapters live in dedicated adapter packages (e.g. `packages/gateway-adapters/src/stripe-payment-gateway.ts`). They depend on `@poc/runtime` and the type-only contract of the brick.
3. **`callOperation` Underneath**: The adapter contains **no HTTP or transport code**:
   - Zero `fetch(` calls
   - Zero `new URL(` or `URLSearchParams` construction
   - Zero manual header management
   All parameter serialization (bracket form encoding), authentication, egress fetch routing, error handling (`IntegrationCallError`), rate limits, and retries are delegated to `callOperation(manifest, op, args, options)`.
4. **Domain-Derived Idempotency Key**: For state-mutating operations like order creation, the adapter derives the provider idempotency key directly from the domain entity ID (e.g. `Idempotency-Key: wallet:${orderId}`). This guarantees at-most-once execution at the third-party provider without custom bookkeeping.
5. **Provider Status Normalization**: Provider-specific lifecycle states are mapped directly to domain status codes (e.g. Stripe `succeeded` -> domain `PAID`, with other states passed through).

---

## 9. Modular Integration Runtime Architecture (UC3.10) <a id="module-map"></a>

Following the UC3 refactor sweep, the integration runtime is organized into modular submodules under `packages/runtime/src/`:

```
packages/runtime/src/
├── call-operation.ts              # Core pipeline orchestrator for standalone and workflow calls
├── integration-executor.ts        # Thin workflow node executor wrapper, registry, and output port mapping (<= 300 lines)
├── param-serialization.ts         # Backward-compatibility re-export of integration/param-serialization.ts
└── integration/                   # Focused submodules (strictly <= 350 lines per file)
    ├── auth.ts                    # Connection resolution (resolveConnectionForOperation) & auth rendering (applyConnectionAuth)
    ├── param-serialization.ts     # OpenAPI 3.1 parameter style serialization (form, deepObject, space, pipe, simple, cookie)
    ├── body-encoding.ts           # Body formatting (JSON, bracket form-urlencoded, multipart, binary stream, schema variants)
    ├── pagination.ts              # 7-style pagination engine (cursor, page, link, offset, bodyNextUrl, headerToken, lastItemCursor)
    ├── response-decoding.ts       # Status validation, error mappings, semantic predicates (errorWhen/successWhen), binary decoding
    ├── request-build.ts           # URL construction against allowedHosts, template validation, and path substitution
    ├── retry.ts                   # Retry-After parsing, exponential backoff with jitter, and retryability checking
    ├── redaction.ts               # Secret value extraction, connection map secrets, and sensitive field tracking
    └── errors.ts                  # IntegrationCallError class with structured error codes
```

### Module Responsibilities and Invariants
- **Thin Wrapper (`integration-executor.ts`)**: Confined to registering catalog operations, mapping node context to operation parameters, dispatching to `callOperation()`, and mapping result outputs to workflow node ports. Strictly maintained under 300 lines.
- **Decomposed Submodules (`src/integration/*`)**: Each submodule encapsulates a single concern (authentication, parameter serialization, body encoding, pagination state machine, or response decoding). Every file in `packages/runtime/src/integration/*` is strictly maintained under 350 lines.
- **Byte-for-Byte Golden Parity**: Request generation across all 61 pack operations is verified via `packages/runtime/test/call-operation-golden.test.ts` against committed golden recordings.



