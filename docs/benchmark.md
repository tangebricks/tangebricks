# Real-model benchmark (v0)

`scripts/agent-bench.ts` measures whether a real model can build an app through ProjectX MCP alone, end to end, and deploy
it to a real Cloudflare account. It is the input to Phase 1's kill rule:

> If the real model cannot build any brief end to end (deployed, ≥ 9/12 checks) after two fix iterations, pivot MCP toward
> "agent edits an existing template".

The harness evaluates the rule from the recorded numbers, judged as the owner decided on 2026-11-26 (rule version
`v0-applicable-lines (owner decision 2026-11-26)`, recorded in the result). The pivot decision is the owner's.

## What one run does

1. Boots Studio in-process (Studio's database on `node:sqlite`) on the **real** Cloudflare client. Every request to
   Cloudflare passes the live-deploy guard (`scripts/lib/live-studio.ts`): only `px-tangebricks-test-<8 hex>-*` names, one
   pinned account, D1, Workers and Workflows only (no KV, no R2). Every create is written to a ledger in `--state-dir`
   before it is sent.
2. Signs the owner up, creates the org and the project, connects the Cloudflare token with Studio's verify-and-save, and
   issues an MCP token bound to the project with the `read`, `edit` and `deploy` scopes.
3. Serves Studio on a loopback port and runs `claude -p` in an empty temporary folder with:
   `--output-format json --mcp-config <ProjectX only> --strict-mcp-config --tools "" --allowedTools mcp__projectx
   --permission-mode dontAsk --max-budget-usd <remaining budget> [--resume <session id>] [--model <id>]`. The first
   prompt (on stdin) is the brief and the owner's answers. The CLI uses your existing Claude Code login;
   `CLAUDE_CONFIG_DIR` is not changed. The deploy token and Studio's root secret are removed from the CLI's environment.
   Claude Code keeps the session under its config dir, keyed by the working folder; that folder is the run's own
   temporary folder, and the harness deletes its sessions after the run.
4. **Agent calls.** When a call ends without a live preview, the scripted owner does its human steps and replies, and
   the same session continues with `--resume`, up to `--max-agent-calls` calls (default 8). The reply is the answer
   under the `## <n>. <title>` heading of the brief's answers that a question in the agent's last message names,
   followed by "Please continue until the app is deployed to preview; the harness instructions win where they conflict
   with my answers."; with no such question, that line alone. The budget and the 45-minute wall cap are shared by all
   calls: each call gets the remaining budget and time. Calls are counted apart from turns.
5. **Secrets are the owner's step.** Between calls, for each brick secret the blueprint still needs
   (`UNBOUND_BRICK_SECRET`), the owner binds a fresh random 32-byte value through Studio's session secrets route with a
   bind target, as a person would. Only the names are recorded (`ownerReview.secretsBound`), never a value.
6. While the CLI runs, a scripted owner polls Studio as the signed-in owner, through the same session routes a person
4. While the CLI runs, a scripted owner polls Studio as the signed-in owner, through the same session routes a person
   uses. It accepts every pending proposal and approves every pending **preview** deploy approval. It rejects any other
   approval (a production deploy, a promotion), because the run is preview only, and the record lists each one it
   rejected. The approval gates are not changed. The record counts the reviews and the time each request waited.
7. When the agent is done (or stopped), the harness scores the twelve checks against what exists, then tears down exactly
   what the ledger lists and reads the account to confirm nothing is left. Teardown also runs when the run fails.

`--task change-live-app --from-run <run id>` stands a recorded run's final blueprint up again in a fresh project, deploys
it to preview as the owner, then asks the agent to add a 5-credit debit to the app's report workflow and to set the free
plan to 100 credits. The record keeps the time to live, the agent's redeploys and hot-applies, and each part's outcome.
The free-plan part is recorded `unsupported`: subscription-plans has no link from a plan to a credit grant.

## Running it

The briefs, the owner answers and the results are private. By default they live under
`_bmad-output/initiative-projectx-roadmap/benchmark/`. That folder must be git-ignored (in `.gitignore` or
`.git/info/exclude`): the harness runs `git check-ignore` and refuses an `--out` file or a brief folder inside the
repository that git does not ignore, and any `--out` at the top level of `evidence/`. No committed file holds brief text.
Each brief is a folder with `brief.md` and `answers.md`.

```sh
node scripts/agent-bench.ts --brief <id> --env-file <outside-repo>/.env --state-dir <outside-repo>/bench-state
node scripts/agent-bench.ts --task change-live-app --from-run <run id> --env-file <outside-repo>/.env --state-dir <outside-repo>/bench-state
node scripts/agent-bench.ts --teardown --env-file <outside-repo>/.env --state-dir <outside-repo>/bench-state
```

| Option | Default |
|---|---|
| `--briefs-dir <dir>` | the private briefs folder |
| `--out <file>` | the private `benchmark-v0.json` |
| `--model <id or alias>` | the CLI's default |
| `--max-budget-usd <n>` | 10 |
| `--iteration <n>` | 1: the owner's fix iteration this run belongs to |
| `--max-agent-calls <n>` | 8: `claude -p` calls in one run (the first, then one per owner reply) |
| `--claude-bin <path>` | see below |

`--claude-bin` is the Claude Code binary. Without it: `claude` on the PATH on macOS and Linux. On Windows a bare
`claude` cannot be started without a shell, so the harness looks for `claude.exe` on the PATH, then the native
`claude.exe` beside an npm `claude.cmd` shim (on the PATH or in `%APPDATA%
pm`), then the `claude.cmd` shim itself,
run through `cmd.exe` with every argument quoted (an argument holding `"`, `%`, `!` or a line break is refused). If
none is found, pass `--claude-bin <path to claude.exe>`.

The env file (outside the repository) holds `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (the scoped deploy token for the
test account) and `PX_TELEMETRY_SECRET`. The state folder must also be outside the repository. A run refuses to start
while its ledger lists anything not yet removed, or while the account holds `px-tangebricks-test-*` resources the ledger
does not list.

Each run is added to the results file by run id, and the kill rule is evaluated again over every recorded run.

## What is recorded

- The CLI version (`claude --version`) and the exact model ids from the CLI's JSON result (`modelUsage`, else `model`).
  No model name is hard-coded. A field the CLI did not report is listed under `missingFields`.
- `total_cost_usd`, `num_turns` and the CLI's duration, plus the harness's own wall time.
- **Cost caveat:** `costUsd` is Claude Code's client-side estimate (`costLabel: "client-estimated"`), not provider billing.
  Compare it with the billing console before quoting it.
- The owner's review count (proposals accepted, approvals given, secrets bound) and the total time requests waited for review.
- Each agent call: what prompted it (the brief, or the owner's reply and which answer it came from, never the reply
  text), whether it resumed, the CLI's numbers, the budget it was given, and its final message, redacted and cut to
  2000 characters. The run's totals add the calls up; `cli.agentCalls` counts them.
- The preview address with the account's workers.dev subdomain redacted, whether preview was deployed, and the code of
  the last refused preview deploy.
- The twelve checks, the final blueprint (so change-live-app can replay it), and the teardown result.
- A run is `incomplete`, with the reason, when the wall-time or budget cap stopped the CLI, the CLI failed, or teardown
  left something behind. It is still scored on what exists. `incompleteKind` says why: `infra` (the harness or the
  CLI process failed), `agent` (a cap, or the CLI's own error result) or `cleanup` (teardown).
- The iteration (`--iteration`).

## The twelve checks

The harness scores every line itself. Each line is `pass`, `partial`, `n/a` or `fail`, with evidence. A `partial` line
is never a pass.

| # | Line | How ProjectX is checked |
|---|---|---|
| 1 | landing copy | `n/a`: ProjectX deploys an API Worker; it generates no landing page or copy. |
| 2 | sign up / sign in | `partial` at best: the preview runs the stub identity (`x-test-user`), so there is no real sign-up. The probe (a stub user creating a workspace) is sent whenever the preview answers, whether or not the app has an entity. |
| 3 | password-reset mail | `n/a`: the stub identity has no password and the preview sends no mail. |
| 4, 9 | entity end to end | On the preview Worker, with the access key, a stub user and a new workspace: create, read, list, update and delete a row of the blueprint's first entity, then read it again (404). All of them is `pass`; create and read only is `partial`. |
| 5 | check and seed twice | `validate_blueprint` reports ready, and a second preview deploy by the owner reports `noop` with no write calls. When preview runs an older revision than the blueprint's latest, no redeploy is sent (it would ship the agent's undeployed changes) and the line fails with "latest revision never deployed". |
| 6 | commit per stage, nothing pushed | At least one revision for each stage the blueprint has (bricks, entities, workflows), read across every page of the revision history, and production never deployed. |
| 7 | build log | Studio's activity has the revisions and proposals, and its audit log has the agent's tool calls and a row for each approval the owner gave. |
| 8 | interview read-back | `n/a`: ProjectX has no interview; the answers are in the prompt. |
| 10 | preview answers | `GET /healthz` with the access key answers 200. |
| 11 | audit CLI | `n/a`: the line checks another tool's own CLI. |
| 12 | second agent via MCP | `partial` at best: a second plain HTTP client finds an entity's create route in the preview's `/openapi.json`, creates a row in its own workspace and reads it back. The app has no MCP server of its own. |

## Judging the kill rule

Rule version `v0-applicable-lines (owner decision 2026-11-26)`, recorded in the result as `killRule.ruleVersion`.

- **Primary verdict, per brief: passes over applicable lines.** A brief is met when a deployed run passes at least 75% of
  its applicable lines, the same bar as 9 of 12. The four `n/a` lines (1, 3, 8, 11) are listed in the result with their
  reasons and left out of the count.
- **Beside it: the literal score**, labelled "literal (as written)": passes against all 12 lines, met at 9 or more on a
  deployed run. Both are reported; the result does not choose between them.
- Partial lines never count as passes. Today a brief run can pass at most 6 of 12 lines, which is 6 of 8 applicable
  lines (75%): it can meet the primary bar but never the literal one.
- Iterations are the explicit `--iteration` numbers recorded on each run, never counted from repeat runs. Each iteration
  is judged on its own; a brief re-run in the same iteration shows its best run.
- Runs that are incomplete for infra reasons (`incompleteKind: "infra"`) are no evidence about the model: they are left
  out and listed under `excludedRuns`.
- The result reports whether each judgement is met in any iteration and the latest iteration recorded. Whether to pivot
  is the owner's decision.

## Offline tests

`scripts/test/agent-bench.node.test.ts` runs the whole flow with a fake CLI (it replays MCP calls through the official MCP
client against Studio's real `/mcp`), the fake Cloudflare API, and a simulated preview Worker. Nothing leaves the
machine: global `fetch` refuses every address but the loopback one. The tests also check that nothing under the private
folder is tracked and that no tracked file holds a private brief's text.
