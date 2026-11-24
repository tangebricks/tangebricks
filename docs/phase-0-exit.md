# Phase 0 exit check

Phase 0 (trust fixes) closes with release `v0.3.0`. This page records the exit check: what was run, on which commit, and what each check returned. Checked 2026-11-24 on `main` at `3126497d8876b5ec50d26b1df23049bfdef6315a` (the merge of story 0.21).

## Exit criteria

| Criterion | How it was checked | Result |
|---|---|---|
| Attack suite: 0 failures across non-quarantined bricks, studio-api and MCP | `pnpm exec vitest run` on `packages/assembler/test/cross-tenant.fuzz.test.ts`, `rbac-escalation.attack.test.ts`, `cron-target.attack.test.ts`, `rate-limit.attack.test.ts`, `apps/studio-api/test/control-plane-attack.test.ts` and `packages/sdk/test/scoped-attacks.test.ts` | 6 files, 38 tests passed. Both known-failures registries (`packages/assembler/test/attack-suite.known-failures.json`, `apps/studio-api/test/control-plane-attack.known-failures.json`) hold 0 entries. |
| Tenant lint parses WHERE clauses and fails on a seeded leaky query | `pnpm lint:tenant`; `scripts/test/lint-tenant-queries.node.test.ts` (it seeds a leaky brick and expects the lint to fail) | 0 violations across 42 bricks (168 files). The 21 lint tests pass. |
| No fallback secret in source | A search of `apps/*/src`, `packages/*/src` and `bricks/*/src`, excluding tests, for `DEFAULT_*SECRET/KEY`, a secret or key variable with a literal `??`/`\|\|` default, and the strings "dev-secret", "change-me" and "insecure-default" | 0 matches. |
| Boot without secrets fails | `test/missing-secrets.test.ts` | 9 tests passed. Each missing secret fails with an error that names the variable. |
| Every MCP deploy path with no target returns an error | `packages/mcp-server/test/mcp.test.ts`: the no-target tests | Both pass: `deploy_apply` with no target, and production with no target, each return `NO_TARGET` with a remediation line. |
| CI green on `main`, with required checks | [CI run](https://github.com/tangebricks/tangebricks/actions/runs/45435296850) and [Security run](https://github.com/tangebricks/tangebricks/actions/runs/45435296878) on `3126497`; branch protection | Both green. Required checks: `cp0`, `gitleaks`, `osv-scanner`, `licenses`. Admins are included and force-push is off. |
| Honest README; evidence matches | `pnpm readme:check`, `pnpm proof:check`, `pnpm evidence:check`, `pnpm release:check --ref HEAD` | All exit 0. 12 of 12 hypotheses pass on the offline re-measurement. Live evidence older than the release is labelled stale in the README. |
| LICENSE present | `LICENSE` (Apache-2.0), `NOTICE`, `SECURITY.md` | Present. |
| No fake-success path | Story 0.9 removed the fabricated successes it found; tests that relied on them were moved to real nodes when the e2e suite was revived | No known fake-success path remains. Studio's test runs report wallet steps as `NOT_CONFIGURED`. |

## Kill or pivot

- **Rule 1:** "More than 3 critical findings open after 4 weeks: cut v1 to 8 bricks." The threat model lists 9 critical findings: audit 1–6, R-A, R-E and B1. Each is closed by a merged story or a quarantine:
  - audit 1: 0.4 (proved by 0.5);
  - audit 2, 3 and B1: 0.6;
  - audit 4: 0.6, plus admin-console quarantined in 0.11;
  - audit 5: 0.7;
  - audit 6: marketplace-splits quarantined in 0.11;
  - R-A: 0.8;
  - R-E: 0.15, which replaced 0.10.

  **Open criticals: 0. Not triggered.**
- **Rule 2:** "Isolation needs a data-model redesign in more than 5 bricks: rewrite those, drop the rest." Isolation was fixed with verified workspace context (0.4), scoped keys and lookups (0.7, forward migrations in a few bricks), and per-route authorisation (0.6). No brick needed a data-model redesign; 8 unsafe or stub bricks were quarantined instead (0.11). **Not triggered.**

## Carried into Phase 1

- **Hardening tickets filed from the threat model:** 1.9 metering, 1.10 workspace delete and suspension, 1.11 API keys, 1.12 feature-flags, 1.13 llm-gateway billing, 1.14 uploads, 1.15 OAuth, 1.16 studio-web test hooks. All of them come before the private-beta gate 1.8.
- **Payment and messaging adapter checks:** 2.3 (Cashfree, and Stripe's verification) and 2.4 (outbound messaging).
- **Stale live evidence:** the deployed halves of H5, H9, H10, H11 and H12 are from 2026-10-21 and are labelled stale. Phase 1 (1.2, 1.3) re-proves them on a live account.
