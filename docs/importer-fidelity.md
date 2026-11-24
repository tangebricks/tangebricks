# Importer Fidelity Measurement & Baseline Protocol

This document outlines the measurement harness, baseline registry, and workflow for tracking and lowering integration importer defects across real-world API specifications (epics UC0, UC2, and UC3).

## Overview

ProjectX measures integration importer fidelity against a pinned corpus of upstream API specifications:
- **Stripe** (OpenAPI 3.0, ~8.3 MB)
- **GitHub** (OpenAPI 3.0, ~13.9 MB)
- **Discord** (OpenAPI 3.1, ~1.2 MB)
- **Slack** (Swagger 2.0, ~1.2 MB)
- **Google** (Discovery v1: Calendar, Gmail, Drive, Sheets)

The harness categorizes structural losses (erased types, lost enums/defaults, dropped body fields, missing required fields, altered parameter/header names, collapsed nested schemas) and evaluates per-operation importability.

## Commands

```bash
# 1. Fetch & verify pinned specs into corpus/real-specs/.cache/
pnpm fidelity:fetch

# 2. Measure current importer fidelity and write evidence/importer-fidelity.json
pnpm fidelity:measure

# 3. Check current importer output against committed baseline (fails if defects increase)
pnpm fidelity:check

# 4. Update committed baseline (run by UC2/UC3 stories when fixing defects)
node scripts/measure-importer-fidelity.ts --baseline
```

## Baseline Regression Contract

The committed baseline is stored at:
[`evidence/importer-fidelity.baseline.json`](../evidence/importer-fidelity.baseline.json)

During `pnpm fidelity:check` (and in the GitHub Actions `fidelity` CI job), the current importer is run across all 5 providers and compared against the baseline:
1. **Defect counts cannot increase**: If any `classes[c]` count or `opsWithStructuralDefect` increases for any provider, the gate exits 1 and displays a tabular regression report.
2. **Importable operations cannot decrease**: If `importableOps` drops for any provider, the gate exits 1.

## How UC2 / UC3 Stories Lower the Baseline

When a story fixes an importer fidelity defect (e.g. UC2.3 lifting the 6-property body cap, UC3.1 preserving response schemas, UC2.5 Swagger 2 body recovery):

1. **Implement the fix and tests**: Write the Red test first, implement the fix in the owning module under `packages/integrations/src/` (see the module map in `docs/integration-importer.md`), and show test passes.
2. **Re-measure and inspect**: Run `pnpm fidelity:measure`. Observe the decrease in the targeted defect class and `opsWithStructuralDefect`.
3. **Re-generate the baseline**: In the same branch/commit as the fix, run:
   ```bash
   node scripts/measure-importer-fidelity.ts --baseline
   ```
   This updates `evidence/importer-fidelity.baseline.json` and stamps provenance.
4. **Verify non-regression**: Run `pnpm fidelity:check` to ensure the new baseline is verified and passes cleanly.
5. **Reviewer check**:
   The reviewer checks `git diff evidence/importer-fidelity.baseline.json`:
   - Verify that **only** the defect classes targeted by the story decreased.
   - Verify that **no** defect classes or defect totals increased.
   - Verify that no untargeted providers shifted unexpectedly.
