# Real-Spec Fidelity Corpus

This directory houses the manifests, snapshots, and tooling for the pinned upstream API specification corpus. It provides a reproducible, tamper-evident suite of real-world OpenAPI 3, Swagger 2, and Google Discovery specifications used to measure and benchmark integration importer fidelity (epics UC0, UC2, and UC3).

## Manifest Contract (`manifest.json`)

Each spec in `manifest.json` defines:
- `id`: Provider identifier (e.g. `stripe`, `github`, `discord`, `slack`, `google-calendar`).
- `format`: Specification format (`openapi3`, `swagger2`, or `google-discovery`).
- `url`: Canonical upstream URL pinned to a 40-hex Git commit SHA for Git repositories, or the Discovery REST URL for Google APIs. Branch names (e.g. `main`, `master`) are prohibited.
- `sha256`: SHA-256 hex digest of the uncompressed specification payload.
- `bytes`: Exact byte length of the uncompressed specification payload.
- `snapshot` (optional): Path to committed gzip-compressed snapshot (`snapshots/*.json.gz`) for unversioned APIs (e.g., Google Discovery).

## Providers, Sources & Licences

| Provider | Format | Source Repository / Endpoint | Upstream Licence | Notes |
|---|---|---|---|---|
| `stripe` | `openapi3` | `stripe/openapi` (`openapi/spec3.json`) | Apache-2.0 | Pinned commit `bcfd59f49dcac84a84d63d304c62793dff6e5916` (~8.3 MB) |
| `github` | `openapi3` | `github/rest-api-description` (`descriptions/api.github.com/api.github.com.json`) | MIT | Pinned commit `e85aa3d17265bc8a2dd9c1e5357705ee206e9d71` (~13.9 MB) |
| `discord` | `openapi3` | `discord/discord-api-spec` (`specs/openapi.json`) | MIT | Pinned commit `4e75626a4cedfbc397d66f5491c79a9a62a71fd5` (~1.2 MB) |
| `slack` | `swagger2` | `slackapi/slack-api-specs` (`web-api/slack_web_openapi_v2.json`) | MIT | Pinned commit `dfea73e06d146c368d7f94b52ac90796dc4e27e1` (~1.2 MB) |
| `google-calendar` | `google-discovery` | `https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest` | Creative Commons Attribution 3.0 / Google APIs Terms | Committed snapshot `snapshots/google-calendar.json.gz` |
| `google-gmail` | `google-discovery` | `https://gmail.googleapis.com/$discovery/rest?version=v1` | Creative Commons Attribution 3.0 / Google APIs Terms | Committed snapshot `snapshots/google-gmail.json.gz` |
| `google-drive` | `google-discovery` | `https://www.googleapis.com/discovery/v1/apis/drive/v3/rest` | Creative Commons Attribution 3.0 / Google APIs Terms | Committed snapshot `snapshots/google-drive.json.gz` |
| `google-sheets` | `google-discovery` | `https://sheets.googleapis.com/$discovery/rest?version=v4` | Creative Commons Attribution 3.0 / Google APIs Terms | Committed snapshot `snapshots/google-sheets.json.gz` |

## Usage

### Fetching Specifications

To populate the local cache (`corpus/real-specs/.cache/`), run:

```bash
pnpm fidelity:fetch
```

- On the first run, it fetches GitHub specs over HTTPS and extracts Google Discovery snapshots from `corpus/real-specs/snapshots/`.
- Every spec is strictly validated against its pinned `sha256` and byte count.
- If any byte does not match, the process exits non-zero with `CORPUS_HASH_MISMATCH: <id>`.
- Subsequent runs are idempotent: when cache matches manifest, nothing is fetched (`8 cached, 0 fetched`).

### Re-pinning a Specification

To update and re-pin a specification to a new version:

```bash
node scripts/fetch-real-specs.ts --update <id>
```

The script will:
1. Download the latest version of `<id>` from its upstream URL.
2. Compute new SHA-256 and byte size.
3. Print old and new hashes for review.
4. Update `manifest.json` (and update `snapshots/<id>.json.gz` if applicable).
5. Refresh the local `.cache/<id>.json`.
