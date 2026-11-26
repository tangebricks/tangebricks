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
4. While the CLI runs, the scripted owner polls Studio as the signed-in owner, through the same session routes a person
   uses (see [The scripted owner](#the-scripted-owner)).
5. **Agent calls.** When a call ends without a live preview, the owner does its human steps and replies, and the same
   session continues with `--resume`, up to `--max-agent-calls` calls (default 8). The budget and the 45-minute wall cap
   are shared by all calls: each call gets the remaining budget and time. Calls are counted apart from turns.
6. When the agent is done (or stopped), the harness scores the twelve checks against what exists, then tears down exactly
   what the ledger lists and reads the account to confirm nothing is left. Teardown also runs when the run fails.

`--task change-live-app` stands a recorded run's final blueprint up again in a fresh project, deploys it to preview as the
owner, then asks the agent to add a 5-credit debit to the app's report workflow and to set the free plan to 100 credits.
The recorded run is `--from-run <run id>`, or, without it, the latest deployed run of the brief named by
`CHANGE_LIVE_APP_BRIEF` (one of the default briefs). The owner reviews the change's proposals against that brief's review
file. The record keeps the time to live, the agent's redeploys and hot-applies, and each part's outcome. The free-plan
part is recorded `unsupported`: subscription-plans has no link from a plan to a credit grant.

## The scripted owner

The owner acts as a person would in Studio. It never touches the approval gates, and it never gives the agent a secret
value.

**Proposals are reviewed against the brief.** Each brief may have a private `review.json` beside it:

| Field | Meaning |
|---|---|
| `bricks` | The brick ids the brief needs. |
| `entities` | The entity names the brief needs. A trailing `*` matches a prefix (`invoice*`). |
| `allowOps` | Optional op kinds that may touch anything (for example `set_metadata`). |
| `decisions` | `[{ match, reply }]`: the owner's explicit decisions. `match` is a lowercase phrase, or `/regex/`, looked for in the agent's message. |

The file is read at run time and validated (every brick id must be in the catalog); a malformed one stops the run before
anything is created. A proposal is
accepted when every op touches only listed bricks and entities (a workflow node counts as touching the brick its type
belongs to, such as `credit-wallet.debit`), or is an `allowOps` kind. An op kind the owner does not know is outside the
brief. Otherwise the owner rejects it through Studio's reject
route, with a reason naming the first op outside the brief. A reject the route refuses is counted and tried again on the
next poll, and the refused click is recorded (`reject-failed`). Without a `review.json`, every proposal is accepted and recorded as `accept-unreviewed`.

**Approvals.** The owner approves every pending **preview** deploy approval and rejects any other (a production deploy, a
promotion), because the run is preview only.

**Secrets.** Between calls, for each brick secret the blueprint still needs (`UNBOUND_BRICK_SECRET`) that a person must
supply, the owner binds a fresh random 32-byte value through Studio's session secrets route with a bind target. A secret
the brick generates is made by Studio when the owner approves the preview deploy, and an optional one is left unset.

**Replies to a blocked agent**, in this order, each followed by "Please continue until the app is deployed to preview;
the harness instructions win where they conflict with my answers.":

1. The agent names a secret after `MISSING_REQUIRED_SECRETS` or `UNBOUND_BRICK_SECRET`: "I added <NAME> in Studio" when
   the owner bound it for every brick that needs that name; for a generated secret, that the approved preview deploy generates it; for an optional one, that
   it can stay unset.
2. `APPROVAL_REQUIRED` or `APPROVAL_PENDING`: the owner reviews pending approvals at once, then says what it actually
   did since the agent's last call started: approved it; did not approve it (not a preview deploy, and why); Studio
   refused the click; or no approval was waiting.
3. A review decision whose phrase the message contains: its reply.
4. A question naming a `## <n>. <title>` heading of the brief's answers: the answer under that heading.
5. Otherwise the generic line alone.

**Stopping when stuck.** The owner sends the same reply at most twice to an agent that has made no progress since (no new
revision of its own, no new preview deploy; revisions the owner's session makes, such as a secret bind, do not count). Instead of a third, it stops the run: the run is `incomplete` with
`incompleteKind: "owner-stalled"`, scored on what exists, and torn down like any other incomplete run.

## Running it

The briefs, the owner answers, the review files and the results are private. By default they live under
`_bmad-output/initiative-projectx-roadmap/benchmark/`. That folder must be git-ignored (in `.gitignore` or
`.git/info/exclude`): the harness runs `git check-ignore` and refuses an `--out` file or a brief folder inside the
repository that git does not ignore, and any `--out` at the top level of `evidence/`. No committed file holds brief text.
Each brief is a folder with `brief.md`, `answers.md` and (optionally) `review.json`.

The default brief set is `DEFAULT_BRIEF_IDS`: three briefs we wrote for our segment, credit- or usage-billed AI SaaS.
Each describes workspaces with teams, email sign-in, credits charged per AI action, a free plan with credits, records with
relations and money or date fields, and one workflow. Older briefs stay on disk but are not run by default.

```sh
node scripts/agent-bench.ts --env-file <outside-repo>/.env --state-dir <outside-repo>/bench-state               # the default set
node scripts/agent-bench.ts --brief <id> --env-file <outside-repo>/.env --state-dir <outside-repo>/bench-state  # one brief
node scripts/agent-bench.ts --task change-live-app [--from-run <run id>] --env-file <outside-repo>/.env --state-dir <outside-repo>/bench-state
node scripts/agent-bench.ts --teardown --env-file <outside-repo>/.env --state-dir <outside-repo>/bench-state
```

Without `--brief`, the default briefs run one after another, each in a fresh project with a fresh ledger. A run that
leaves anything behind stops the set.

| Option | Default |
|---|---|
| `--brief <id>` | every id in `DEFAULT_BRIEF_IDS` |
| `--briefs-dir <dir>` | the private briefs folder |
| `--out <file>` | the private `benchmark-v0.json` |
| `--model <id or alias>` | the CLI's default |
| `--max-budget-usd <n>` | 10 |
| `--iteration <n>` | 1: the owner's fix iteration this run belongs to |
| `--max-agent-calls <n>` | 8: `claude -p` calls in one run (the first, then one per owner reply) |
| `--claude-bin <path>` | see below |

`--claude-bin` is the Claude Code binary. Without it: `claude` on the PATH on macOS and Linux. On Windows a bare
`claude` cannot be started without a shell, so the harness looks for `claude.exe` on the PATH, then the native
`claude.exe` beside an npm `claude.cmd` shim (on the PATH or in `%APPDATA%\npm`), then the `claude.cmd` shim itself,
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
- The owner's review count (proposals accepted and rejected, approvals given, secrets bound) and the total time requests
  waited for review.
- `ownerActions`: every owner action in order, `{ at, kind, detail }`, where `kind` is `accept`, `reject`,
  `accept-unreviewed`, `approve`, `bind-secret`, `reply` or `stop`, or `accept-failed`, `reject-failed` or
  `approve-failed` when Studio refused the owner's click (the detail holds the HTTP status and the id). Details hold proposal and approval ids, a reject's
  reason, secret names and which reply rule answered; never a secret value, never a reply's text.
- Each agent call: what prompted it (the brief, or the owner's reply and the rule it came from, never the reply text),
  whether it resumed, the CLI's numbers, the budget it was given, and its final message, redacted and cut to 2000
  characters. The run's totals add the calls up; `cli.agentCalls` counts them.
- The preview address with the account's workers.dev subdomain redacted, whether preview was deployed, and the code of
  the last refused preview deploy.
- The twelve checks, the final blueprint (so change-live-app can replay it), and the teardown result.
- A run is `incomplete`, with the reason, when the wall-time or budget cap stopped the CLI, the CLI failed, the owner
  stopped a stalled agent, or teardown left something behind. It is still scored on what exists. `incompleteKind` says
  why: `infra` (the harness or the CLI process failed), `agent` (a cap, or the CLI's own error result), `owner-stalled`
  (two identical replies with no progress) or `cleanup` (teardown).
- The iteration (`--iteration`).

Older result files are upgraded when loaded: a record without `ownerActions` gets an empty list and zero rejected
proposals (the owner of that time accepted every proposal), and its `schemaNote` says so.

## The twelve checks

These twelve lines are our definition of "built end to end": what a team would check before calling a generated SaaS
MVP usable. The harness scores every line itself, from what exists, never from the agent's word. Each line is `pass`,
`partial`, `n/a` or `fail`, with evidence. A `partial` line is never a pass.

| # | Line | What it asks, and how ProjectX is checked |
|---|---|---|
| 1 | landing copy | A first page that says what the product is. `n/a`: ProjectX deploys an API Worker and writes no page or copy. |
| 2 | sign up / sign in | A new person can get in. `partial` at best: the preview runs the stub identity (`x-test-user`), so there is no real sign-up. The probe (a stub user creating a workspace) is sent whenever the preview answers, whether or not the app has an entity. |
| 3 | password-reset mail | A person who forgot their password can get back in. `n/a`: the stub identity has no password and the preview sends no mail. |
| 4, 9 | entity end to end | A record the product is about can be created, read, listed, changed and deleted. On the preview Worker, with the access key, a stub user and a new workspace: create, read, list, update and delete a row of the blueprint's first entity, then read it again (404). All of them is `pass`; create and read only is `partial`. |
| 5 | check and seed twice | The build checks itself, and running it again changes nothing. `validate_blueprint` reports ready, and a second preview deploy by the owner reports `noop` with no write calls. When preview runs an older revision than the blueprint's latest, no redeploy is sent (it would ship the agent's undeployed changes) and the line fails with "latest revision never deployed". |
| 6 | commit per stage, nothing pushed | Work is saved step by step and nothing reaches production unasked. At least one revision for each stage the blueprint has (bricks, entities, workflows), read across every page of the revision history, and production never deployed. |
| 7 | build log | There is a trail of what was done and who approved it. Studio's activity has the revisions and every proposal the owner reviewed (accepted or rejected), and its audit log has the agent's tool calls, a row for each approval the owner gave and a row for each proposal it rejected. |
| 8 | interview read-back | The builder confirms what it understood before building. `n/a`: ProjectX has no interview; the answers are in the prompt. |
| 10 | preview answers | The app is live somewhere a person can reach. `GET /healthz` with the access key answers 200. |
| 11 | audit CLI | The built app can be audited from the command line. `n/a`: ProjectX ships no command-line tool for the apps it builds; its build log is line 7. |
| 12 | second agent via MCP | Another agent can use the app. `partial` at best: a second plain HTTP client finds an entity's create route in the preview's `/openapi.json`, creates a row in its own workspace and reads it back. The app has no MCP server of its own. |

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
  out and listed under `excludedRuns`. An `owner-stalled` run is evidence and counts.
- The result reports whether each judgement is met in any iteration and the latest iteration recorded. Whether to pivot
  is the owner's decision.

## Offline tests

`scripts/test/agent-bench.node.test.ts` runs the whole flow with a fake CLI (it replays MCP calls through the official MCP
client against Studio's real `/mcp`), the fake Cloudflare API, and a simulated preview Worker. Nothing leaves the
machine: global `fetch` refuses every address but the loopback one. The tests cover the owner's review (an on-brief
proposal accepted, a stray probe rejected with its reason, a refused reject retried, no review file), the reply order,
a named secret bound once and the stop after two identical replies, and the upgrade of older records. They also check
that nothing under the private folder is tracked and that no tracked file holds a private brief's, answers' or review
file's text.
