# Evidence Provenance Contract

## Overview

ProjectX enforces strict empirical provenance for every evidence artifact published under `evidence/`.
Per finding **F-TRUST-3**, evidence files must reflect real measurements from executable test suites or verified scripts, stamped with actual wall-clock time and the exact Git commit SHA that produced them.

Hardcoded timestamps (such as `2026-11-01T00:00:00.000Z`) and literal `true` boolean constants standing in for live verification are strictly rejected.

## Provenance Schema

Every JSON file in `evidence/` (recursive, excluding historical runs in `evidence/deployed/**`) must include a `provenance` object adhering to this schema:

```json
{
  "provenance": {
    "generatedAt": "2026-11-02T16:54:45.341Z",
    "gitSha": "2332f00dffff021194402b12c77a9c9e46a5a8f4",
    "gitDirty": false,
    "generator": "scripts/catalog-tiers.ts",
    "inputKind": "measured"
  }
}
```

### Fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `generatedAt` | `string` | ISO 8601 timestamp generated at execution time. Must NOT equal `2026-11-01T00:00:00.000Z`. |
| `gitSha` | `string` | Exactly 40 lowercase hexadecimal characters returned by `git rev-parse HEAD`. Must NOT be an all-zero SHA (`0000000000000000000000000000000000000000`). |
| `gitDirty` | `boolean` | `true` if working directory had uncommitted changes at execution, `false` otherwise. |
| `generator` | `string` | Relative path or identifier of the script/reporter that wrote the file. |
| `inputKind` | `"measured" \| "simulated"` | Whether inputs were dynamically measured during execution or simulated from model/fixture data. |
| `quarantined` | `boolean` | Optional. Required to be `true` for any file under `evidence/quarantine/`. |
| `reason` | `string` | Optional. Human-readable explanation of why an artifact was quarantined. |
| `quarantinedAt` | `string` | Optional. ISO 8601 timestamp when quarantine was applied. |

## The Helper API (`scripts/lib/evidence-stamp.ts`)

### `stampEvidence`

```typescript
function stampEvidence(
  generator: string,
  inputKind: "measured" | "simulated" = "measured"
): EvidenceProvenance
```
Queries git runtime status (`git rev-parse HEAD` and `git status --porcelain`), captures the current wall clock (`new Date().toISOString()`), and returns the `EvidenceProvenance` object. Both `getGitSha()` and `isGitDirty()` throw descriptive errors (`GIT_REV_PARSE_FAILED`, `GIT_STATUS_FAILED`) on failure; fake fallbacks (such as all-zero SHAs or default booleans) are strictly forbidden.

### `writeEvidence`

```typescript
function writeEvidence(
  targetPath: string,
  body: unknown,
  provenance: EvidenceProvenance
): void
```
Writes formatted JSON payload to `targetPath`, automatically embedding the `provenance` metadata.
Enforces safety invariants:
- If `provenance.inputKind === "simulated"`, `targetPath` must reside under `evidence/simulated/` or `evidence/quarantine/`. Any attempt to write simulated evidence outside these directories throws `EVIDENCE_SIMULATED_OUTSIDE_QUARANTINE`.
- If either the body or provenance carries the legacy constant `generatedAt: "2026-11-01T00:00:00.000Z"`, throws `EVIDENCE_HARDCODED_TIMESTAMP` loudly instead of silently replacing it.

## Quarantined Evidence (`evidence/quarantine/`)

Historical artifacts that relied on hardcoded timestamps or unverified constant fixtures are relocated to `evidence/quarantine/`:
- `evidence/quarantine/cp8-beta-readiness.json`
- `evidence/quarantine/cp9-sandbox-verification.json`

Quarantined files carry `"inputKind": "simulated"` and `"quarantined": true`. They are preserved for auditability and must not be used as proof of platform readiness.

## Beta Cohort Export Format (`scripts/beta-readiness.ts`)

Per story **UC0.2**, `pnpm beta:readiness` requires `--cohort <path>` (a JSON export of real partner rows from `STUDIO_DB`) or `--simulate`.
Default/seeded partner IDs (such as `org_cohort1_agency_northstar` or `DEFAULT_COHORT_1_PARTNERS`) are strictly rejected with `BETA_READINESS_SEEDED_INPUT`.
Executing `node scripts/beta-readiness.ts` without `--cohort` exits non-zero with `BETA_READINESS_NO_REAL_COHORT`.

### Cohort Export JSON Schema

The cohort export JSON file can be a JSON array of partner records or an object `{ cohortId?: string, partners: [...] }`:

```json
[
  {
    "orgId": "org_real_partner_uuid",
    "orgName": "Partner Company Name",
    "orgSlug": "partner-company-slug",
    "partnerType": "agency",
    "ownerEmail": "owner@partner.example.com",
    "ownerName": "Jane Doe",
    "ownerUserId": "usr_real_partner_uuid",
    "sessionTelemetry": {
      "projectId": "partner-project-id",
      "templateId": "ai-credits-saas",
      "ttfdMinutes": 18.5,
      "connectCfCompleted": true,
      "deployedIntegrationWorkflows": 2,
      "meanTimeToLocateFailingNodeSec": 45,
      "weeklyActiveSessionsW4": 5
    },
    "metadata": {
      "useCase": "Production integration workflow automation"
    }
  }
]
```

### Required Fields & Invariants
- `orgName`: Display name of the design partner organization.
- `orgSlug`: Lowercase slug (`/^[a-z0-9-]+$/`).
- `partnerType`: One of `"agency"`, `"mcp-first-dev"`, or `"solo-founder"`. Under Owner Decision D1, the cohort must include $\ge 1$ `"agency"` partner and $\ge 1$ `"mcp-first-dev"` partner.
- `ownerEmail`: Valid email address of the partner account owner.
- Seeded partner IDs / slugs from `DEFAULT_COHORT_1_PARTNERS` are rejected.

When executed with `--simulate`, output lands in `evidence/simulated/cp8-beta-readiness.json` with `inputKind: "simulated"`.
When executed with valid `--cohort <path>`, output lands in `evidence/cp8-beta-readiness.json` with `inputKind: "measured"`.

## Verification & CI Gate

Run the provenance conformance check across all evidence files:

```bash
pnpm evidence:check
```

This gate runs in CI as part of `ci:cp0`. It verifies that every file in `evidence/` has valid provenance, non-empty generator, valid git SHA, valid date, and no hardcoded values.

## Test Run Isolation & Evidence Refresh (`pnpm evidence:refresh`)

Per story **UC0.7**, running automated tests (`pnpm test` or `vitest run`) does not touch tracked files under `evidence/`.
- Test runners and the Vitest `EvidenceReporter` write raw results and test attachments into `.evidence-run/` (an untracked directory ignored in `.gitignore`), or into `POC_EVIDENCE_DIR` if specified.
- Tracked files under `evidence/` change ONLY when explicitly regenerated via:
  ```bash
  pnpm evidence:refresh
  ```
- `pnpm evidence:refresh` enforces that the working tree is clean (`git status --porcelain` must be empty, otherwise exits 1 with `EVIDENCE_REFRESH_DIRTY_TREE`). It stamps all files once with the clean commit SHA and `gitDirty: false`, runs all generators into the staging directory, copies them into `evidence/` in a single pass, and verifies them with `pnpm evidence:check`.
- Tracked evidence changes must be committed with an explanation of why the evidence was refreshed.

