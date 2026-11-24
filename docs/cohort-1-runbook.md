# Cohort-1 Design Partner Readiness Runbook (`epic-cp8-private-beta`)

This runbook defines the Cohort-1 design partner composition rules, provisioning workflow, moderated Time-to-First-Deploy (TTFD) session protocol, and `/api/admin/beta-metrics` evaluation for ProjectX Studio's private beta (`R46`, `R47`, Owner Decision `D1`).

---

## 1. Cohort-1 Partner Composition Rules (Owner Decision `D1`)

Cohort 1 consists of **5 design partners**, prioritizing technical builders first:
- **`>= 1` `"agency"` partner**: Cloud/SaaS agencies building multi-tenant client backends and Stripe/Discord/Slack automation.
- **`>= 1` `"mcp-first-dev"` partner**: Technical builders co-building primarily through Claude Code, Cursor, or Claude Desktop via `@poc/mcp-server` alongside the Studio canvas.
- **`"solo-founder"` partners**: Technical solo founders admitted after the initial Connect Cloudflare drop-off read confirms `dropOffRate <= 25%` (`cp9TriggerFired === false`).

### Default Cohort-1 Roster (`DEFAULT_COHORT_1_PARTNERS`)

| Partner Slug | Partner Type | Starter Template | Target Use Case |
| --- | --- | --- | --- |
| `northstar-agency` | `agency` | `stripe-discord-ops` | Client Stripe billing + Discord ops automation |
| `kestrel-cloud-studio` | `agency` | `b2b-workspace-app` | Multi-workspace SaaS starter for agency clients |
| `synthwave-ai-labs` | `mcp-first-dev` | `ai-credits-saas` | Claude Code + Cursor MCP co-building for AI credits backend |
| `hyperion-agentic` | `mcp-first-dev` | `stripe-discord-ops` | MCP-authored webhook + GitHub/Slack ops pipelines |
| `vela-marketplace` | `solo-founder` | `marketplace` | Two-sided marketplace ledger and payouts |

---

## 2. Provisioning & CLI Verification

### CLI Readiness Check
Run the Cohort-1 readiness gate from the repository root:
```bash
pnpm beta:readiness
```
This script:
1. Validates the Cohort-1 partner roster against Owner Decision `D1` (`validateCohort1Composition`).
2. Provisions the 5 partner organizations, owner accounts, and `inv_cohort-1_*` invite tokens in D1 (`studio_beta_cohort_partners`).
3. Replays the moderated onboarding and debugging telemetry across all 5 sessions.
4. Evaluates all 5 PRD §8 beta readiness metrics and writes `evidence/quarantine/cp8-beta-readiness.json` (simulated).

### Admin API Endpoints
- **`POST /api/admin/beta-cohort/provision`**:
  - Validates `partners` array (`partnerType: "agency" | "mcp-first-dev" | "solo-founder"`).
  - Returns HTTP `422` (`INVALID_COHORT_COMPOSITION`) if the cohort lacks at least 1 `"agency"` or at least 1 `"mcp-first-dev"` partner.
  - Records an immutable `beta_cohort.provision` entry in `studio_audit_logs`.
- **`GET /api/admin/beta-metrics?cohortId=cohort-1`**:
  - Returns the live `BetaReadinessReport` JSON across all provisioned partners in the cohort.

---

## 3. Moderated TTFD Session Protocol

During each moderated 45-minute onboarding session:
1. **Signup & Starter Selection (`T+0m` -> `T+2m`)**:
   - Partner signs in and selects one of the 4 production-only starter templates (`ai-credits-saas`, `b2b-workspace-app`, `marketplace`, `stripe-discord-ops`).
   - Studio records `signup_completed` and `project_created`.
2. **Blueprint Customization & Single-Node Rehearsal (`T+2m` -> `T+8m`)**:
   - Partner customizes an entity or workflow step (via Studio Canvas or MCP `apply_ops`) and runs a single-node **Test Step** (`POST /__px/rehearse`).
3. **Connect Cloudflare BYOC Wizard (`T+8m` -> `T+14m`)**:
   - Partner opens the Connect Cloudflare modal (`connect_cf_wizard_opened`), clicks the pre-filled Cloudflare API Token template URL (`connect_cf_token_link_clicked`), pastes the token (`connect_cf_token_submitted`), and completes preflight verification (`connect_cf_verified`).
   - If preflight fails due to a missing scope, Studio displays the exact missing permission and remediation link (`connect_cf_permission_check_failed`).
4. **First Preview Deploy (`T+14m` -> `T+20m`)**:
   - Partner reviews the Deploy Plan modal and deploys to `preview` (`first_preview_deploy_started` -> `first_preview_deploy_succeeded`).
   - Studio computes exact TTFD in minutes from `signup_completed` to `first_preview_deploy_succeeded`.
5. **Failing-Node Localization Drill (`T+20m` -> `T+25m`)**:
   - Facilitator triggers a seeded failing workflow run and measures the elapsed seconds from the error alert / failed run view to the partner opening the failing node in **Run Replay** (`meanTimeToLocateFailingNodeSec`, target `<= 120s`).

---

## 4. PRD §8 Success Metrics & CP9 Early Trigger Rule

| Metric | Target | Gate Field in `evidence/quarantine/cp8-beta-readiness.json` (simulated) |
| --- | --- | --- |
| **Partner Composition (`D1`)** | `>= 1` agency & `>= 1` MCP-first dev | `composition.d1CompositionPassed === true` |
| **Median TTFD** | `<= 30` minutes (including CF token setup) | `ttfd.passed === true` (`ttfd.medianTtfdMinutes <= 30`) |
| **Connect Cloudflare Drop-Off** | `<= 25%` (`> 25%` triggers CP9 managed preview early) | `connectCloudflare.cp9TriggerFired === false` |
| **CP10 Integration Adoption** | `>= 3` of 5 partners with `>= 1` integration in a deployed workflow | `integrationAdoption.passed === true` |
| **Failing Node Localization** | Mean time `<= 2` minutes (`<= 120` seconds) | `failingNodeLocalization.passed === true` |
| **Weekly Active @ 4 Weeks** | `>= 3` of 5 partners active | `weeklyActiveRetention.passed === true` |
