# Integration Importer Contract & Import Reports

The integration importer (`packages/integrations/src/importer.ts`, a facade over the modules in section 11) converts upstream API specifications (OpenAPI 3.x, Swagger 2.0, Google Discovery v1) and companion curation configs into validated `IntegrationManifestFile` artifacts for the ProjectX catalog.

Starting in **UC2.1**, every import produces an explicit, byte-stable report detailing what elements were mapped faithfully, curated, normalized, approximated, or unsupported.

---

## 1. Import Report Vocabulary

Each import writes an `import-report.json` document adjacent to the generated `integration.json`:
- **File location**: `integrations/<app>/import-report.json`
- **Manifest stamp**: `integration.json` gains a `fidelity` block stamped with `specHash`, `importerVersion`, `level`, and projected `unsupported` issues.

### Top-Level Schema (`ImportReport`)
```ts
export interface ImportReport {
  readonly app: string;
  readonly format: string;
  readonly specHash: string; // sha256:<64 hex>
  readonly importerVersion: string; // exact semver, e.g. "2.0.0"
  readonly summary: Record<ImportReportStatus, number>;
  readonly excludedByCuration: number;
  readonly entries: ImportReportEntry[];
}
```

### Entry Schema (`ImportReportEntry`)
```ts
export interface ImportReportEntry {
  readonly op: string | null;
  readonly element: ImportReportElement;
  readonly pointer: string; // RFC 6901 pointer or "curation:#/..."
  readonly status: ImportReportStatus;
  readonly code: string; // ^[A-Z][A-Z0-9_]{2,63}$
  readonly from?: unknown;
  readonly to?: unknown;
  readonly reason?: string;
  readonly blocking: boolean;
}
```

---

## 2. Statuses & Elements

### Statuses (`ImportReportStatus`)
- **`mapped`**: The spec element was mapped byte-identical or structurally 1:1 into the manifest.
- **`normalized`**: Minor syntax/format normalizations were performed with no semantic loss (e.g., path casing, whitespace).
- **`curated`**: The element was supplied or overridden by `curation.config.json` rather than extracted directly from the upstream spec (e.g., auth configuration).
- **`approximated`**: The element could not be mapped with 100% precision and was approximated (e.g. types coerced to string or nested schemas flattened).
- **`unsupported`**: The spec declared an element or schema that the importer or runtime cannot currently represent or execute.

### Elements (`ImportReportElement`)
- `document`
- `operation`
- `param`
- `bodyField`
- `body`
- `contentType`
- `response`
- `auth`
- `server`
- `pagination`

### Blocking Semantics
- **`blocking: true`**: The loss or limitation would cause the runtime to issue a corrupted, invalid, or dangerous request (or fail execution).
- **`blocking: false`**: Non-blocking notice. The operation can still execute safely despite the loss (e.g., response schema ignored).

---

## 3. Fidelity Level Rule

The manifest `fidelity.level` is computed deterministically from the report summary:
1. **`exact`**: Every entry in the report is either `mapped` or `normalized` (zero curated, zero approximated, zero unsupported).
2. **`curated`**: At least one entry is `curated`, and zero entries are `approximated` or `unsupported`.
3. **`partial`**: At least one entry is `approximated` or `unsupported`.

The manifest's `fidelity.unsupported` array contains the projection of all `approximated` and `unsupported` entries (capped at 500 entries), validated so that every non-null `op` references an operation declared on the manifest.

---

## 4. CLI & Corpus Fidelity Commands

- **Import single spec**:
  ```bash
  pnpm openapi:import --spec <path> --format <openapi3|google-discovery> --curation <path> --out <path>
  ```
- **Import all committed integrations**:
  ```bash
  pnpm openapi:import --all
  ```
  Writes `integrations/{discord,github,google,slack,stripe}/import-report.json` and updates `integration.json`. Consecutive runs produce byte-identical output.
- **Measure corpus fidelity (report-aware)**:
  ```bash
  pnpm fidelity:measure --report-aware
  ```
  Runs `analyzeSpec` across the pinned real-spec corpus (Stripe, GitHub, Discord, Slack, Google Discovery) and cross-references analyzer defect classes against emitted report codes in `scripts/fidelity/class-map.json` to compute reported vs. silent defects.

---

## 5. Report Code Registry

The importer emits typed report codes classified by status and blocking severity. Every code is declared once in `packages/assembler/src/integration-fidelity-codes.ts` (`FIDELITY_CODES`: code, default status, blocking, owning UC3 story) and emitted as `FIDELITY_CODES.<NAME>.code`, so an unregistered code is a compile error. The table below is the human summary:

| Code | Status | Blocking | Description / Branch |
|---|---|---|---|
| `PARAM_LOCATION_UNSUPPORTED` | unsupported | yes if param is required | cookie / formData / body parameter skipped |
| `PARAM_ENUM_DROPPED` | approximated | no | parameter enum choices not retained |
| `PARAM_DEFAULT_DROPPED` | approximated | no | parameter default value not retained |
| `PARAM_ITEMS_TYPE_DROPPED` | approximated | no | array item schema type not retained |
| `PARAM_STYLE_UNHONOURED` | unsupported | yes | array/object/`style`/`explode` parameter serialized as `String()` |
| `BODY_FIELD_CAPPED` | unsupported | no | request body property cut by cap (beyond 6 fields in OpenAPI or 5 in Discovery) |
| `BODY_REQUIRED_FIELD_CAPPED` | unsupported | yes | required request body property cut by cap |
| `BODY_NESTED_FLATTENED` | approximated | no | nested object or array schema reduced to bare `object` or `array` |
| `SCHEMA_COMPOSITION_ERASED` | approximated | no | `oneOf`/`anyOf`/`allOf` composed schema erased to `string` |
| `BODY_COMPOSED_DROPPED` | unsupported | yes | composed request body dropped |
| `BODY_FREEFORM_DROPPED` | unsupported | yes | free-form body with no properties dropped |
| `BODY_TOPLEVEL_ARRAY_DROPPED` | unsupported | yes | top-level array body dropped |
| `BODY_REF_PROPERTY_UNRESOLVED` | approximated | no | Google Discovery property `$ref` typed `string` |
| `CONTENT_TYPE_UNSUPPORTED` | unsupported | yes | non-JSON/form request body content types fallen back to JSON |
| `MEDIA_UPLOAD_UNSUPPORTED` | unsupported | no | Google Discovery media upload capability ignored |
| `SWAGGER2_BODY_DROPPED` | unsupported | yes | Swagger 2.0 formData/body parameters lost |
| `PATH_RESERVED_EXPANSION_LOST` | unsupported | yes | Discovery `{+name}` reserved expansion rewritten |
| `REF_DEPTH_EXCEEDED` | approximated | no | JSON reference `$ref` chain exceeded depth 5 |
| `OPERATION_SKIPPED` | unsupported | no | `HEAD`/`OPTIONS`/`TRACE` method or unresolved path-item `$ref` skipped |
| `IDENTIFIER_NORMALIZED` | normalized | no | Parameter or body field raw name altered during identifier sanitization (exact raw wire name preserved via `wireName`) |
| `IDENTIFIER_COLLISION_DISAMBIGUATED` | normalized | no | Two distinct parameters or body fields mapped to identical clean name, disambiguated with `_${in}` or `_body` suffix |
| `IDENTIFIER_COLLISION` | unsupported | yes | Identifier collision could not be disambiguated |
| `OPERATION_ID_COLLISION` | normalized | no | Operation ID collision disambiguated by appending `__${method}` (and numeric suffix if needed) |
| `SPEC_VERSION_UNSUPPORTED` | unsupported | no | Upstream spec dialect (e.g. Swagger 2.0) unsupported; ops with body blocked |
| `BASEURL` | mapped | no | Spec server matches curation baseUrl |
| `BASEURL_CURATED` | curated | no | Curated baseUrl overrides or differs from spec declared server URL |
| `SERVER_VARIABLE_EXPANDED` | normalized | no | Server template variable expanded with default value |
| `OPERATION_SERVER_OVERRIDE` | unsupported | yes | Operation-level server override host or path differs from baseUrl |
| `ALLOWED_HOSTS_NARROWED` | curated | no | Spec server host excluded/narrowed from curation allowedHosts |
| `RESPONSE_SCHEMA` | mapped | no | Success response schema mapped to typed `response.outputs` (UC3.2) |
| `RESPONSE_EMPTY` | mapped | no | `204`/`205` response: no outputs (UC3.2) |
| `ERROR_SHAPE` | mapped | no | `response.errorShape` derived from a 4xx/5xx/`default` schema (UC3.2) |
| `RESPONSE_PROPERTY_NOT_PORT` | normalized | no | Response property whose name is not a port identifier, or is a reserved port (`out`, `status`, `body`, `data`); still reachable under `out` |
| `RESPONSE_SCHEMA_IGNORED` | unsupported | no | Non-JSON-only response content (UC3.6) |

---

## 6. Wire Names & Collision Rules (UC2.3)

### Wire Names (`wireName`)
Parameters (`IntegrationOperationParam`) and body fields (`IntegrationOperationBodyField`) have a sanitized `name` (valid JavaScript identifier used as graph port IDs) and an optional `wireName` (exact original wire parameter name from the upstream spec):
- **Preservation**: When `sanitizeIdentifier(raw) !== raw`, `wireName` is set to `raw` and an `IDENTIFIER_NORMALIZED` entry is emitted.
- **Runtime transmission**: The runtime integration executor sends `param.wireName ?? param.name` over HTTP for query parameters, request headers, JSON body keys, and form-urlencoded body keys. Input resolution continues to use `name` so workflow graph nodes and wiring remain unaffected.
- **Manifest validation**: `IntegrationManifestSchema` strictly rejects manifests where `wireName === name` (redundant `wireName` is disallowed).

### Collision Detection & Disambiguation Rules
1. **Parameter Deduplication by `${in}:${rawName}`**:
   - The importer dedupes parameters by location and raw name (`${in}:${rawName}`) rather than sanitized identifier.
   - An operation-level parameter with the same `${in}:${rawName}` as a path-level parameter overrides the path-level parameter and is reported `mapped`.
2. **Identifier Collision Disambiguation within an Operation**:
   - When two distinct raw names in the same operation (parameters plus request body fields) sanitize to the same identifier, the later element is suffixed with `_${in}` (parameters) or `_body` (body fields) and reported as `IDENTIFIER_COLLISION_DISAMBIGUATED`.
   - Its original wire name is preserved in `wireName`.
   - If the disambiguated name also collides, `IDENTIFIER_COLLISION` (`blocking: true`) is emitted.
3. **Operation ID Collision Disambiguation**:
   - Colliding sanitized operation IDs across an integration specification are detected before storing operations.
   - The first operation in spec order retains the base sanitized ID.
   - Subsequent operations receive `${id}__${method.toLowerCase()}` (or `__2`, `__3` for further collisions) and emit a normalized `OPERATION_ID_COLLISION` report entry recording the original `from` ID and pointer.
   - If a curation `includeOperations` lists an ambiguous operation ID (matching a collided raw ID or base ID), import fails immediately with `OPENAPI_IMPORT_AMBIGUOUS_OPERATION` listing the candidate candidate disambiguated IDs.

---

## 7. Spec Dialects, YAML Parsing & Servers Diff (UC2.4)

### Conformant YAML 1.2 Parser
Upstream API specs written in YAML are parsed using a conformant YAML 1.2 parser (`yaml` package pinned at dev time; runtime never imports it):
- Supports YAML anchors and aliases (`&anchor` and `*alias`), block scalars (`|`, `>`), quoted hashes in strings, and preserves version strings (`version: "1.10"`).
- Replaces the legacy hand-rolled `parseSimpleYaml` and `parseYamlScalar` functions.
- Prevents resource exhaustion attacks by capping alias resolution at `maxAliasCount: 100`. Alias bombs fail with `OPENAPI_IMPORT_PARSE_ERROR: <line>:<col> <message>`.

### Spec Dialect Detection & Format Mismatches
`detectSpecVersion(spec)` determines the exact dialect of input documents:
- `"openapi3.0"`: OpenAPI 3.0.x specs.
- `"openapi3.1"`: OpenAPI 3.1.x specs.
- `"swagger2"`: Swagger 2.0 specs.
- `"google-discovery"`: Google Discovery REST descriptions.

Spec dialect is verified against the import `--format` option:
- An incompatible combination (e.g. `--format openapi3` on a Discovery or Swagger 2 spec, or `--format google-discovery` on OpenAPI/Swagger) throws `OPENAPI_IMPORT_FORMAT_MISMATCH`.
- When `--format` is omitted, the CLI and importer auto-detect the dialect (`openapi3`, `google-discovery`, `swagger2`).
- Swagger 2.0 specs are converted to OpenAPI 3 via `swagger2ToOpenApi3` (UC3.7), emitting a document-level `SWAGGER2_UPCONVERTED` entry (`status: "normalized"`).

### Servers Diff & Variable Expansion
The importer reads root, path-level, and operation-level `servers` declarations (or `rootUrl + servicePath` for Discovery):
1. **Server Variable Expansion**: Server URL templates (e.g. `https://{env}.example.com:{port}/v1`) are expanded with declared variable defaults, emitting `SERVER_VARIABLE_EXPANDED` (`status: "normalized"`).
2. **Base URL Comparison**: Each distinct server in effect is compared against `curation.baseUrl`:
   - Matching server URL emits `BASEURL` (`status: "mapped"`).
   - Differing server URL emits `BASEURL_CURATED` (`status: "curated"`).
3. **Operation-Level Server Overrides**: An operation-level server whose host or path differs from `baseUrl` emits `OPERATION_SERVER_OVERRIDE` (`status: "unsupported"`, `blocking: true`).
4. **Allowed Hosts Narrowing**: Any server host declared in the spec that is omitted from `curation.allowedHosts` emits `ALLOWED_HOSTS_NARROWED` (`status: "curated"`).

---

## 8. Strict Mode, Curation Acknowledge & Overlay Reporting (UC2.5)

### Strict Mode by Default
Starting in **UC2.5**, the importer runs in strict mode (`mode: "strict"`) by default:
- Any import with an unacknowledged `approximated` or `unsupported` loss fails immediately with `OPENAPI_IMPORT_UNACKNOWLEDGED_LOSS`, listing every offending `op`, `code`, and `pointer`.
- The `--lenient` CLI flag permits writing the report and manifest with unacknowledged losses, but is strictly forbidden (`OPENAPI_IMPORT_LENIENT_OUTPUT_FORBIDDEN`) when `--out` resolves inside `<repo>/integrations/`.

### Curation `acknowledge` List
When a provider spec requires an approximated or unsupported feature that cannot yet be represented without loss, the loss must be acknowledged in `curation.config.json`:
```json
{
  "acknowledge": [
    {
      "op": "createCustomer",
      "code": "BODY_FIELD_CAPPED",
      "pointer": "#/paths/~1v1~1customers/post/requestBody",
      "reason": "Optional fields beyond the 6-field cap deferred until UC3.1"
    }
  ]
}
```
- **Matching**: `op` can name an exact operation ID or `"*"` to match all operations. `code` is required. `pointer` is optional.
- **Reason**: `reason` must be at least 10 characters explaining why the loss is acceptable or citing the tracking story.
- **Stale acknowledgements**: An acknowledgement that does not match any actual loss entry in the import report throws `OPENAPI_IMPORT_STALE_ACKNOWLEDGEMENT`, guaranteeing that once a loss is fixed (e.g. in UC3), stale acknowledgements must be removed.
- **Acknowledged entries in report**: Acknowledged entries keep their status (`approximated` or `unsupported`), gain an `acknowledged: { reason }` record in `import-report.json`, and stay in `fidelity.unsupported`.

### Curation Configuration Validation (`CurationConfigSchema`)
Curation files are strictly validated against `CurationConfigSchema` (`packages/integrations/src/curation.ts`):
- Any unknown or misspelled top-level or overlay keys (for example, `"acknowlege"`) fail immediately with `OPENAPI_IMPORT_CURATION_INVALID`.

### Curation Overlay Reporting & Contradictions
The merge loop tracks and reports every overlay modification against spec baseline values:
1. **Contradictions with Spec**: An overlay specifying `method` or `path` that differs from the spec throws `OPENAPI_IMPORT_OVERLAY_CONTRADICTS_SPEC`.
2. **Curation-Only Operations**: An operation defined purely in curation with no base operation in the spec emits `curated` `OPERATION_CURATED_ONLY`.
3. **Overlay Additions (`OVERLAY_ADDED`)**: When an overlay defines a field not present in the spec (`pagination`, `rateLimit`, `errorMappings`, etc.), it emits `curated` `OVERLAY_ADDED` pointing to `curation:#/operations/<key>/<field>`.
4. **Overlay Overrides (`OVERLAY_OVERRIDE`)**: When an overlay modifies an existing spec value (e.g. `params`, `body`, `label`, `summary`), it emits `curated` `OVERLAY_OVERRIDE` recording both `from` (spec value) and `to` (curated value).
5. **Identical Overlays**: If the overlay value is canonically equal to the spec base value, no entry is emitted.

---

## 9. Pack Migration, Provenance, Mandatory Fidelity & Drift Gate (UC2.7)

### Pack Migration & `specProvenance`
The 5 committed packs (`discord`, `github`, `google`, `slack`, and `stripe`) use hand-trimmed fixture specifications rather than full upstream API specifications. To prevent overstating fidelity:
- **`specProvenance: "upstream" | "hand-trimmed"`**: Required on `CurationConfigSchema` (`packages/integrations/src/curation.ts`).
- **`SPEC_HAND_TRIMMED`**: When `specProvenance` is `"hand-trimmed"`, the importer emits a document-level entry:
  ```json
  {
    "op": null,
    "element": "document",
    "pointer": "curation:#/specProvenance",
    "status": "curated",
    "code": "SPEC_HAND_TRIMMED",
    "blocking": false,
    "reason": "Spec is a hand-trimmed fixture, not an upstream release; fidelity capped below exact"
  }
  ```
  Because of this `curated` entry, hand-trimmed specs cannot reach `level: exact` (they resolve to `curated` or `partial`).

### Upstream Mapping (`upstream`)
Each pack curation declares its mapping to the pinned upstream real-spec corpus in `curation.config.json`:
```json
{
  "specProvenance": "hand-trimmed",
  "upstream": {
    "corpusSpec": "stripe",
    "operationIds": {
      "createCustomer": "PostCustomers",
      "getCustomer": "GetCustomersCustomer"
    }
  }
}
```
This enables the harness to cross-check trimmed fixture coverage and losses against upstream provider specs.

### Mandatory `fidelity` Block
In `packages/assembler/src/schemas.ts`, `fidelity: IntegrationFidelitySchema` is a **required** property on `IntegrationManifestSchema`. Manifests missing `fidelity` fail schema validation.

### Manifest Conformance Verification (`scripts/check-manifests.ts`)
The catalog conformance suite checks every committed integration pack:
1. `import-report.json` must exist alongside `integration.json`.
2. `report.specHash === manifest.fidelity.specHash === sha256(spec file)`.
3. `report.importerVersion === manifest.fidelity.importerVersion === IMPORTER_VERSION`.
If any hash or version does not match, conformance fails on field `fidelity` with detail `stale import: run pnpm openapi:import --all`.

### Drift Gate (`--check`)
The importer CLI supports a `--check` flag:
```bash
pnpm openapi:import --all --check
```
When run with `--check`:
- The importer regenerates `integration.json` and `import-report.json` in memory without writing to disk.
- It compares the generated manifests and reports against the committed disk versions.
- If any discrepancy is found, it prints a unified diff and exits with code 1.
- `ci:cp10` in `package.json` includes `pnpm openapi:import --all --check` as a mandatory CI gate.

### Upstream Corpus Pack Verification (`pnpm fidelity:measure --packs`)
The UC0 fidelity harness includes a dedicated pack verification mode:
```bash
pnpm fidelity:measure --packs
```
For all 5 packs and all 61 curated operations, it imports each operation from the pinned upstream corpus spec and verifies that:
- Every pack carries a valid `fidelity` block (5/5).
- Any loss present upstream is honestly acknowledged in the pack's `curation.config.json`.
- Unacknowledged `pack_upstream_only_loss` entries must be exactly 0.

---

## 10. Response Outputs, `dataPath` & Error Shape (UC3.2)

- **Outputs.** The importer picks the lowest `2xx` response that has JSON content (falling back to `default` only when the operation declares no `2xx` and no `4xx`/`5xx`). It derefs `$ref` (cycle-safe via a visited-ref set, depth ≤ 8) and merges `allOf`, then maps top-level properties to `response.outputs`, required properties first, then spec order. Discovery resolves `method.response.$ref` against `schemas`. `response.status` records the chosen status.
- **Reserved or non-identifier names** (`out`, `status`, `body`, `data`, or names that are not valid port identifiers) are not emitted as ports (the executor treats those four ids specially). They stay reachable under `out`, and the importer reports `normalized` `RESPONSE_PROPERTY_NOT_PORT`.
- **`errorShape`.** The first `4xx`/`5xx` schema, then `default`, with `code`/`message`-like properties at depth ≤ 2 yields `{codePath, messagePath, typePath}`. Exact names only: `code`, `error` (when not an object), `message`, `error_description`, `type`. No fuzzy matching.
- **`dataPath` stays curation-only** (for example a Slack envelope). A curation `response` overlay is merged over the extracted response and reported `curated`.
- **Top-level `oneOf`/`anyOf`.** Outputs are the properties every variant declares (required only if required in every variant); a property whose type differs between variants gets type `any`. Reported `mapped` `RESPONSE_SCHEMA`; the full data still flows through `out`.
- **Not mapped.** Non-JSON-only content reports `unsupported` `RESPONSE_SCHEMA_IGNORED` until UC3.6.
- **Pack fixtures.** Regenerate response schemas in `integrations/*/openapi.json` and `integrations/google/discovery.json` with `pnpm fidelity:fetch && node scripts/generate-pack-responses.ts`, then `node packages/integrations/src/cli.ts --all` and `pnpm catalog:build` (the generator is idempotent).
- **Token budget.** Pack fixtures keep at most a few response properties per op so `get_node` stays ≤ 250 tokens; narrow further with a curation `response.outputs` overlay if needed.

## 11. Module Map (UC2.8)

`importer.ts` keeps the public API (`importIntegrationSpec`, `analyzeSpec`) and re-exports every symbol it used to export, so `index.ts` and all callers are unchanged. No file under `packages/integrations/src/` exceeds 400 lines (enforced by `packages/integrations/test/fidelity-codes-registry.node.test.ts`).

| Module | Responsibility |
|---|---|
| `importer.ts` | `importIntegrationSpec` / `analyzeSpec` orchestration, manifest assembly, facade re-exports |
| `types.ts` | `IMPORTER_VERSION`, `ImportSpecFormat`, `ImportIntegrationResult` |
| `util.ts` | JSON helpers, identifier sanitising, schema-to-port mapping, `$ref` deref, `parseSpecDocument`, `computeSpecHash` |
| `servers.ts` | spec dialect detection, `servers` / `baseUrl` diff |
| `security.ts` | `securitySchemes` and requirement parsing |
| `response.ts` | response outputs, `dataPath`, error shape (UC3.2) |
| `openapi3.ts` | OpenAPI 3 operation walk; helpers `openapi3-params.ts`, `openapi3-body.ts`, `openapi3-auth.ts` |
| `discovery.ts` | Google Discovery method walk; helpers `discovery-params.ts`, `discovery-body.ts`, `discovery-auth.ts` |
| `merge.ts` | curated operation selection and overlay merge (`OVERLAY_ADDED` / `OVERLAY_OVERRIDE`) |
| `acknowledge.ts` | `acknowledge` matching, stale-acknowledgement check, strict-mode rejection |
| `metrics.ts` | o200k token metrics |
| `report.ts`, `curation.ts` | report collector and curation schema (unchanged) |
| `swagger2.ts` | pure Swagger 2.0 to OpenAPI 3.0 converter (`swagger2ToOpenApi3`, `translatePointer`) |
| `fidelity/` | corpus defect measurement (`measure.ts` plus per-dialect `measure-openapi.ts`, `measure-discovery.ts`) |

`packages/integrations/test/report-golden.node.test.ts` pins the five packs' `import-report.json` and manifests and every `fixtures/report/*` `analyzeSpec` report byte-for-byte against `test/golden/`. A refactor that changes any report fails it.

## 12. Request Body Fidelity & FieldSchema (UC3.5)

- **`FieldSchema`:** Request body fields are captured as rich, typed schemas (`packages/assembler/src/schemas.ts`):
  ```ts
  export interface FieldSchema {
    readonly dataType: NodePortDataType | "object" | "array" | "any";
    readonly required?: readonly string[];
    readonly enum?: readonly (string | number | boolean)[];
    readonly default?: unknown;
    readonly properties?: Readonly<Record<string, FieldSchema>>;
    readonly items?: FieldSchema;
    readonly variants?: readonly FieldSchema[];
    readonly discriminator?: string;
    readonly additionalProperties?: boolean;
  }
  ```
- **Cycle & Recursion Bounds:** Schema mapping in `packages/integrations/src/schema-map.ts` dereferences `$ref` cycle-safely with a visited-ref set. Recursion is bounded to depth ≤ 8 (and max 200 nodes in Zod schema). Schemas exceeding depth 8 report `approximated` `SCHEMA_DEPTH_LIMIT` and fall back to pass-through `object` without dropping the operation.
- **Uncapped & Required-First:** The previous 5- and 6-field slices are eliminated. All body fields from the specification are mapped, sorted with all `required` fields first (in spec order), followed by optional fields (in spec order).
- **Body Root vs. Fields:** Operations declare either:
  - `body.fields`: Non-empty array of structured top-level properties (required-first), or
  - `body.root`: Structured top-level schema (`dataType: "array" | "object" | "any"`, with optional `schema: FieldSchema`) for top-level array bodies, composed/variant schemas (`oneOf`/`anyOf`/`allOf`), or free-form bodies.
- **Projection Rule:** In `projectIntegrationToNodes`, all `required` fields plus the first 12 optional fields are projected as node ports. Any remaining optional fields stay in the manifest and are accepted at runtime through the existing `in` object port. MCP tool budgets remain within 10,000 tokens.
- **Runtime Bracket Form Encoding:** For `application/x-www-form-urlencoded` payloads, nested objects and arrays are encoded using bracket notation (e.g. `collection_options[fields]=eventually_due` and `items[0][price]=p_1`) in accordance with the operation's `encoding` specification or standard form deepObject semantics.

## 13. Swagger 2.0 Import & Up-Conversion (UC3.7)

Swagger 2.0 specifications are faithfully imported by in-importer up-conversion (`swagger2ToOpenApi3` in `packages/integrations/src/swagger2.ts`) to OpenAPI 3.0 before operation extraction:
- **Automatic dialect detection**: When `--format` is omitted on CLI or in `importIntegrationSpec`, `detectSpecVersion` detects `"swagger2"` and routes the document through up-conversion. Specifying `--format openapi3` on a Swagger document strictly fails with `OPENAPI_IMPORT_FORMAT_MISMATCH` (AC2).
- **Document-level reporting**: Up-conversion emits a document-level `normalized` report entry with code `SWAGGER2_UPCONVERTED` (`from: "2.0"`, `to: "3.0"`, pointer `#/swagger`).
- **Pointer mapping**: `swagger2ToOpenApi3` builds a bidirectional `pointerMap` translating all generated OpenAPI 3 JSON pointers back to their source Swagger 2 paths, so report entries and error messages point to the original Swagger document.
- **Unsupported constructs**: Anything the conversion cannot express is reported as `unsupported` (e.g. `tsv` collection format -> `COLLECTION_FORMAT_UNSUPPORTED`) instead of dropped.

### Swagger 2.0 to OpenAPI 3 Conversion Table

| Swagger 2.0 | OpenAPI 3 | Conversion Notes |
|---|---|---|
| `host`, `basePath`, `schemes` | `servers` | `[{ url: "{scheme}://{host}{basePath}" }]` |
| `consumes` / `produces` | `content` types | Operation-level overrides root-level; mapped to request and response bodies |
| `in: body` | `requestBody` (JSON) | Body schema dereferenced and converted to `requestBody.content["application/json"].schema` |
| `in: formData` | `requestBody` (form or multipart) | Form parameters converted to object schema properties. Mapped to `multipart/form-data` if any parameter has `type: file` (`binary: true`), otherwise `application/x-www-form-urlencoded`. |
| `collectionFormat` csv/ssv/pipes/multi | `style` / `explode` | `csv` -> style `form` / `simple`, explode `false`; `ssv` -> `spaceDelimited`; `pipes` -> `pipeDelimited`; `multi` -> style `form`, explode `true`. `tsv` -> `unsupported` `COLLECTION_FORMAT_UNSUPPORTED` |
| `securityDefinitions` | `components.securitySchemes` | `basic` -> `http basic`; `apiKey` -> `apiKey`; `oauth2` -> `oauth2` with flows (`authorizationCode`, `implicit`, `password`, `clientCredentials`) |
| `#/definitions/` refs | `#/components/schemas/` | Rewritten recursively in all schemas and parameter items |
| response `schema` | response `content` | Converted to `responses[code].content[produceType].schema` |


