# Catalog Maturity Tiers & CI Derivation Policy

## Overview

Maturity tiers (`production`, `beta`, `experimental`) communicate the stability, verification state, and production readiness of catalog items (bricks and integrations).

Historically, maturity labels were declared by hand in manifest files (`ui.maturity`). Under Story **UC5.6**, maturity tiers are **strictly derived from CI evidence**. A manifest may not declare a tier higher than what current CI test and verification runs prove.

If a brick or integration declares a tier that outruns its proof, `pnpm catalog:conformance` fails closed with:
```
<id>: ui.maturity: declared <declaredTier>, derived <derivedTier>: <blockers>
```

---

## Tier Definitions

| Tier | Description | Requirements Summary |
|---|---|---|
| **`production`** | Full production readiness; suitable for production workloads without caveat. | Passing behaviour test (≥20 assertions), conformance kit passed, no fake adapter defaults, live canary pass within 7 days (integrations), zero unacknowledged fidelity losses (integrations). |
| **`beta`** | Functional and tested, with known caveats, synthetic provider adapters, or pending live credentials. | Passing behaviour test (≥5 assertions), explicit `ui.maturityReason` detailing caveats, import report present (integrations). |
| **`experimental`** | Early preview or unverified against live/workerd runtime. | Any item with unexecuted or failing tests, or fewer than 5 assertions. Must have `ui.maturityReason`. |

---

## Policy Configuration (`scripts/tier-policy.json`)

The derivation thresholds are configured centrally in `scripts/tier-policy.json`:

```json
{
  "minAssertions": {
    "production": 20,
    "beta": 5
  },
  "requireConformanceKit": {
    "production": true
  },
  "liveVerifiedMaxAgeDays": 7,
  "integrationFidelity": {
    "production": "zero-unacknowledged",
    "beta": "report-present"
  }
}
```

---

## Blocker Codes

When an item does not meet the criteria for a higher tier, `deriveTier` attaches machine-readable blocker codes:

| Blocker Code | Description | Remediated By |
|---|---|---|
| `BEHAVIOUR_TEST_NOT_EXECUTED` | The declared `ui.behaviourTest` was not run during the test suite. | Running the test suite (`pnpm test` / vitest) so evidence is recorded. |
| `BEHAVIOUR_TEST_FAILED` | The declared behaviour test failed execution. | Fixing failing tests in the behaviour test suite. |
| `ASSERTIONS_BELOW_MIN` | Behaviour test executed, but assertion count is below required minimum (20 for production, 5 for beta). | Adding rigorous assertions to verify item invariants. |
| `CONFORMANCE_KIT_MISSING` | The brick did not execute the shared brick conformance kit. | Adding `runBrickConformanceKit` to the brick's test suite or documenting skips. |
| `DEFAULT_ADAPTER_FAKE` | Manifest defines `adapters.<name>.default: "fake"`. | Providing a real provider adapter as default, or downgrading to `beta`. |
| `FIDELITY_UNACKNOWLEDGED_LOSS` | Integration OpenAPI/Discovery import resulted in unsupported or approximated features not acknowledged in `curation.config.json`. | Adding explicit curation acknowledgements with rationales in `curation.config.json`. |
| `LIVE_CANARY_STALE` | Live provider canary run is older than 7 days, missing, or failed. | Running live canary against provider test endpoint (`pnpm canary:run <app>`). |

---

## Evidence Generation & Gating Flow

1. **Test Execution**: `pnpm test` runs vitest with `reporters/evidence-reporter.ts`, recording executed behaviour test files, pass/fail status, and assertion counts into `.evidence-run/tier-evidence.json`.
2. **Catalog Conformance**: `pnpm catalog:conformance` (`scripts/check-manifests.ts`) inspects every brick and integration manifest, evaluates `deriveTier()`, and asserts that `TIER_RANK[declaredTier] <= TIER_RANK[derivedTier]`.
3. **Evidence Artifacts**: `pnpm catalog:tiers` (`scripts/catalog-tiers.ts`) writes `evidence/brick-tiers.json` with `declaredTier`, `derivedTier`, `blockers`, and provenance (`evidence.gitSha`, `runAt`, `assertionCount`, `liveVerifiedAt`, `fidelity`).
4. **CI Pipeline (`ci:cp0`)**: Reordered to ensure `pnpm test` runs before `pnpm catalog:conformance`, allowing freshly recorded evidence to inform the conformance gate.
