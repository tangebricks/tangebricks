// The live proof of Studio's one real deploy path (story R53 / 1.2). It runs Studio's own API in-process (app.fetch) with
// the REAL Cloudflare client and a local Studio database, and drives Studio's own routes against the owner's account:
//
//   node --env-file=<path-outside-repo>/.env scripts/live-studio-deploy.ts --state-dir <path-outside-repo>/studio-state [--revoked-token-env CF_REVOKED_TOKEN]
//   (pnpm live:studio-deploy -- --state-dir ... is the same command when the variables are already in the environment)
//   pnpm live:studio-deploy -- --state-dir <same folder> --teardown     removes what an interrupted run left, from its ledger
//
// Env (from an env file OUTSIDE the repositories, never printed): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (the scoped
// deploy token), PX_TELEMETRY_SECRET (Studio's root secret; the Workers get only values derived from it).
//
// THIS CREATES THINGS IN THE ACCOUNT, all named px-tangebricks-test-<8 hex>-...: per environment (preview, production) one
// D1 database, one Worker with its workers.dev address switched on, one Workflow. Before anything is created the script
// refuses to run if the account already holds px-tangebricks-test-* resources its ledger does not list. Every write Studio or
// this script sends passes a guard that refuses any name without this run's own prefix, and every create is written to the
// ledger before it is sent. At the end (and on failure) it tears down exactly what the ledger lists, and checks nothing is left.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWorkerAccessKey } from "../apps/studio-api/src/index.ts";
import type { StudioDeployOptions } from "../apps/studio-api/src/index.ts";
import {
  STUDIO_TEST_NAME_POLICY,
  createClient,
  createRedactor,
  fileStore,
  findSecrets,
  findUnledgered,
  CloudflareApiError,
  isCloudflareError,
  openLedger,
  studioTestProject,
} from "../packages/deploy/src/provisioner/index.ts";
import type { Client, LedgerStore, RequestBudget } from "../packages/deploy/src/provisioner/index.ts";
import { KEY_HEADER } from "../packages/deploy/src/worker/gate.ts";
import { WORKFLOW_RUNS_PATH } from "../packages/deploy/src/worker/proof-routes.ts";
import { deriveProjectSecret, signControlPlaneRequest } from "../packages/telemetry/src/index.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../test/support/blueprints.ts";
import { GLOBAL_API_KEY, LiveProofRefusal, connectStudioOwner, nodeBundler, openGuardedStudio, runTeardownOnly, teardownAndVerify } from "./lib/live-studio.ts";
import type { CallLine, TeardownRecord } from "./lib/live-studio.ts";
import { recordLiveIntegrity } from "./lib/live-evidence.ts";
import { redactWorkersDevSubdomains } from "./lib/redact-subdomain.ts";

// Shared with scripts/agent-bench.ts (story R55); re-exported for the callers and tests that import them from here.
export { LiveProofRefusal, createGuardedFetch, nodeBundler, runTeardownOnly } from "./lib/live-studio.ts";
export type { CallLine } from "./lib/live-studio.ts";

export const RESULT_FILE = "studio-deploy-result.json";
export const CALLS_FILE = "studio-deploy-calls.json";
export const GRAPH_ID = "wf-debit";
export const DEBIT_AMOUNT = 5;
export const FUNDED_MILLI = 100_000;

/**
 * The live proof's blueprint as Studio ops: INVOICE_FLOW_BLUEPRINT (multi-workspace, credit-wallet, dynamic-entities and its
 * invoices entity), oidc-verify as the identity (production refuses the stub), and the graph trigger.manual -> credit-wallet.debit.
 *
 * Not core-auth: it pulls in better-auth, whose password helpers import node:crypto, and the Worker bundler refuses every
 * Node-only import (it targets Workers without nodejs_compat; scripts/test/live-studio-bundle.node.test.ts showed the build
 * failing on it). oidc-verify depends only on the SDK, the runtime and hono, and needs no brick secret.
 */
export function liveProofOps(): Array<Record<string, unknown>> {
  return [
    ...INVOICE_FLOW_BLUEPRINT.bricks.map((brickId, i) => ({ opId: `op_brick_${i}`, type: "enable_brick", brickId, config: {} })),
    { opId: "op_brick_auth", type: "enable_brick", brickId: "oidc-verify", config: {} },
    { opId: "op_identity", type: "set_identity", identity: "oidc-verify" },
    ...INVOICE_FLOW_BLUEPRINT.entities.map((entity, i) => ({ opId: `op_entity_${i}`, type: "add_entity", entity: { ...entity, fields: entity.fields.map((f) => ({ ...f })) } })),
    {
      opId: "op_graph",
      type: "add_workflow",
      workflow: {
        id: GRAPH_ID,
        name: "Debit on manual trigger",
        nodes: [
          { id: "trigger", type: "trigger.manual", label: "Manual", data: {} },
          { id: "debit", type: "credit-wallet.debit", label: "Debit", data: { amount: DEBIT_AMOUNT } },
        ],
        edges: [{ id: "e1", source: "trigger", target: "debit", sourceHandle: "out", targetHandle: "in" }],
      },
    },
  ];
}
/** Who the proof's debit is charged as: credit-wallet.debit records a user on every ledger row and requires one. */
export const LIVE_PROOF_USER_ID = "tangebricks-live-proof";
/**
 * The payload of the signed run that must debit the funded workspace. credit-wallet.debit takes its user from the run's input
 * and refuses a run without one ("invalid input: userId"); live run 1 sent only { workspaceId }, so the Workflow completed with
 * the debit node failed and nothing was charged. The workspace itself comes from the signed body, never from this payload.
 */
export function liveProofRunPayload(workspaceId: string): Record<string, unknown> {
  return { userId: LIVE_PROOF_USER_ID, workspaceId };
}

/** Brick secrets the live blueprint needs in Studio's vault before the deploy: none for oidc-verify. */
export const LIVE_PROOF_BRICK_SECRETS: readonly string[] = [];


export interface LiveStudioDeployDeps {
  credentials: { token: string; accountId: string };
  /** Studio's root PX_TELEMETRY_SECRET. */
  rootSecret: string;
  /** A token the owner revoked, to show it is refused (step 6). */
  revokedToken?: string;
  /** How requests reach Cloudflare's API. */
  cloudflareFetch: (request: Request) => Promise<Response>;
  /** How requests reach the deployed workers.dev addresses. */
  workerFetch: (request: Request) => Promise<Response>;
  /** Builds the uploaded Worker from the assembled project (bundleWorker in the CLI). */
  bundle: NonNullable<StudioDeployOptions["bundle"]>;
  ledgerStore: LedgerStore;
  randomHex: (bytes: number) => string;
  /** The repository root the evidence is written under (evidence/deployed). */
  root: string;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  budget?: RequestBudget;
  /** How long to wait for a new address to answer and a run to debit. */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface LiveStudioDeployResult {
  commandStartedAt: string;
  finishedAt: string;
  completed: boolean;
  stoppedBecause: string | null;
  project: string;
  prefix: string;
  steps: Record<string, unknown>;
  teardown: TeardownRecord | null;
  writesDuringRedeploy: number;
}

export async function runLiveStudioDeploy(deps: LiveStudioDeployDeps): Promise<LiveStudioDeployResult> {
  const commandStartedAt = new Date().toISOString();
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollTimeoutMs = deps.pollTimeoutMs ?? 120_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 3_000;
  const { token, accountId } = deps.credentials;
  // Before anything is sent anywhere: a Global API Key is never used, and the "revoked" token must be a different token.
  if (GLOBAL_API_KEY.test(token.trim())) throw new LiveProofRefusal("CLOUDFLARE_API_TOKEN looks like a Global API Key (37 hex characters): use a scoped API token; nothing was sent");
  if (deps.revokedToken !== undefined) {
    if (GLOBAL_API_KEY.test(deps.revokedToken.trim())) throw new LiveProofRefusal("the revoked token looks like a Global API Key: nothing was sent");
    if (deps.revokedToken.trim() === token.trim()) throw new LiveProofRefusal("the revoked token is CLOUDFLARE_API_TOKEN itself: step 6 needs a different, revoked token; nothing was sent");
  }
  if (typeof deps.rootSecret !== "string" || deps.rootSecret.trim().length < 16) throw new LiveProofRefusal("PX_TELEMETRY_SECRET (Studio's root secret, 16+ characters) is required");

  const ledger = openLedger(deps.ledgerStore, () => deps.randomHex(4), () => new Date(), STUDIO_TEST_NAME_POLICY);
  const live = ledger.entries().filter((e) => e.status !== "removed");
  if (live.length > 0) throw new LiveProofRefusal(`the ledger lists ${live.length} resource(s) not yet removed (${live.map((e) => e.name).join(", ")}): run with --teardown first`);
  const project = studioTestProject(ledger.suffix);
  const ownPrefix = `px-${project}-`;

  const accessKeys = { preview: await deriveWorkerAccessKey(deps.rootSecret, project, "preview"), production: await deriveWorkerAccessKey(deps.rootSecret, project, "production") };
  const controlPlaneSecret = await deriveProjectSecret(deps.rootSecret, project, "control-plane");
  const webhookSecret = await deriveProjectSecret(deps.rootSecret, project, "telemetry-webhook");
  const secrets: Record<string, string> = {
    token,
    accountId,
    rootSecret: deps.rootSecret,
    accessKeyPreview: accessKeys.preview,
    accessKeyProduction: accessKeys.production,
    controlPlaneSecret,
    webhookSecret,
    ...(deps.revokedToken ? { revokedToken: deps.revokedToken } : {}),
  };
  // secrets grows (brick secrets are generated below), so the redactor is rebuilt from it each time
  const hide = (text: string) => createRedactor(Object.values(secrets))(text);
  const say = (line: string) => log(hide(line));

  let phase = "preflight";
  const calls: CallLine[] = [];
  const guarded = openGuardedStudio({ credentials: deps.credentials, cloudflareFetch: deps.cloudflareFetch, workerFetch: deps.workerFetch, bundle: deps.bundle, rootSecret: deps.rootSecret, ownPrefix, ledger, calls, phase: () => phase, sleep, ...(deps.budget ? { budget: deps.budget } : {}), alsoHide: Object.values(secrets) });
  const { budget, guardedFetch, rest } = guarded;

  const steps: Record<string, unknown> = {};
  const result: LiveStudioDeployResult = { commandStartedAt, finishedAt: "", completed: false, stoppedBecause: null, project, prefix: ownPrefix, steps, teardown: null, writesDuringRedeploy: -1 };

  // ---- safety: nothing of ours may already exist outside the ledger
  const unledgered = await findUnledgered(rest, ledger, STUDIO_TEST_NAME_POLICY);
  if (unledgered.length > 0) {
    throw new LiveProofRefusal(`the account already holds ${unledgered.length} px-tangebricks-test-* resource(s) this ledger does not list (${unledgered.map((u) => `${u.kind} ${u.name}`).join(", ")}); nothing was created. Remove them yourself or point --state-dir at the ledger that made them.`);
  }

  const { studio, call } = guarded.boot();
  const must = (what: string, ok: boolean, detail: unknown) => {
    if (!ok) throw new LiveProofRefusal(`${what} failed: ${hide(JSON.stringify(detail)).slice(0, 1200)}`);
  };
  const workerCall = async (url: string, init: RequestInit) => {
    const res = await deps.workerFetch(new Request(url, init));
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { text: text.slice(0, 200) };
    }
    return { status: res.status, body: json };
  };

  try {
    // ---- 1. connect the token through Studio's verify-and-save
    phase = "connect";
    const owner = await connectStudioOwner({ call, suffix: ledger.suffix, project, token, accountId, randomHex: deps.randomHex, name: "Tangebricks Live Proof", must, onConnect: (connect) => (steps.connect = connect) });
    const { session, orgId } = owner;
    say(`1. token verified by Cloudflare through Studio: ${owner.connect.status}, ${(owner.connect.permissions ?? []).length} permissions granted`);

    // ---- 2. the project: INVOICE_FLOW_BLUEPRINT with credit-wallet, a real identity, and a stored graph trigger.manual -> credit-wallet.debit
    phase = "blueprint";
    const ops = liveProofOps();
    const opsRes = await call("POST", `/api/projects/${project}/ops`, { summary: "Live Studio deploy proof (R53)", ops }, session, orgId);
    must("applying the blueprint ops", opsRes.status === 200, opsRes);
    for (const name of LIVE_PROOF_BRICK_SECRETS) {
      const value = deps.randomHex(24);
      secrets[`brick_${name}`] = value;
      const sec = await call("POST", `/api/projects/${project}/secrets`, { ref: `sec_${name.toLowerCase()}`, kind: "brick_secret", label: name, appOrBrick: "core-auth", value, bindTarget: { targetKind: "brick", targetId: "core-auth", secretName: name } }, session, orgId);
      must(`storing the ${name} brick secret`, sec.status === 200, sec);
    }
    say(`2. project ${project}: ${INVOICE_FLOW_BLUEPRINT.bricks.join(", ")}, oidc-verify identity, graph ${GRAPH_ID}`);

    // ---- 3. plan and deploy preview, then production
    const deployed: Record<string, { url: string; action: string }> = {};
    for (const envName of ["preview", "production"] as const) {
      phase = `deploy-${envName}`;
      const plan = await call("POST", `/api/projects/${project}/environments/${envName}/plan`, {}, session, orgId);
      must(`planning ${envName}`, plan.status === 200, plan);
      const route = envName === "preview" ? "deploy" : "promote";
      const dep = await call("POST", `/api/projects/${project}/environments/${envName}/${route}`, {}, session, orgId);
      must(`deploying ${envName}`, dep.status === 200 && dep.body.ok === true, dep);
      const url = String((dep.body.deployment as { url?: string } | undefined)?.url ?? "");
      deployed[envName] = { url, action: String(dep.body.action) };
      // the new address may take a little while to answer
      let health = { status: 0, body: {} as Record<string, unknown> };
      for (const started = Date.now(); Date.now() - started < pollTimeoutMs; await sleep(pollIntervalMs)) {
        health = await workerCall(`${url}/healthz`, { headers: { [KEY_HEADER]: accessKeys[envName] } }).catch(() => ({ status: 0, body: {} }));
        if (health.status === 200) break;
      }
      steps[`deploy_${envName}`] = { planAction: plan.body.action, action: dep.body.action, workerUrl: url, healthzStatus: health.status, mutatingCallCount: dep.body.mutatingCallCount };
      must(`${envName} /healthz`, health.status === 200, health);
      say(`3. ${envName}: ${String(dep.body.action)} -> ${url} (/healthz ${health.status})`);
    }

    // ---- 4. redeploy both: nothing changes, nothing is written
    phase = "redeploy";
    const redeploys: Record<string, unknown> = {};
    for (const envName of ["preview", "production"] as const) {
      const route = envName === "preview" ? "deploy" : "promote";
      const again = await call("POST", `/api/projects/${project}/environments/${envName}/${route}`, {}, session, orgId);
      redeploys[envName] = { httpStatus: again.status, action: again.body.action, noChanges: again.body.noChanges, changes: again.body.appliedActions, mutatingCallCount: again.body.mutatingCallCount };
      must(`redeploying ${envName} unchanged`, again.status === 200 && again.body.action === "noop" && Array.isArray(again.body.appliedActions) && (again.body.appliedActions as unknown[]).length === 0 && again.body.mutatingCallCount === 0, again);
    }
    result.writesDuringRedeploy = calls.filter((c) => c.phase === "redeploy" && c.write).length;
    steps.redeploy = { ...redeploys, writeCalls: result.writesDuringRedeploy };
    must("redeploy without write calls", result.writesDuringRedeploy === 0, calls.filter((c) => c.phase === "redeploy" && c.write));
    say(`4. redeploy: changes [] on both, ${result.writesDuringRedeploy} write calls`);

    // ---- 5. the 1.1 live proof on production: a signed run debits a funded workspace once; no/bad workspace is refused
    phase = "wallet";
    const dbName = `${ownPrefix}production-db`;
    const db = (await rest.listDatabases(dbName)).find((d) => d.name === dbName);
    must("finding the production database", Boolean(db), { dbName });
    const workspaceId = `ws_live_${ledger.suffix}`;
    await rest.queryDatabase(db!.uuid, [{ sql: "INSERT INTO credit_wallets (workspace_id, balance_milli) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET balance_milli = excluded.balance_milli", params: [workspaceId, FUNDED_MILLI] }]);
    const readWallet = async () => {
      const [balance, ledgerRows] = await rest.queryDatabase(db!.uuid, [
        { sql: "SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?", params: [workspaceId] },
        { sql: "SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ? AND type = 'deduction'", params: [workspaceId] },
      ]);
      return { balanceMilli: Number(balance?.results[0]?.balance_milli ?? NaN), deductions: Number(ledgerRows?.results[0]?.n ?? NaN) };
    };
    const before = await readWallet();
    const runUrl = `${deployed.production!.url}${WORKFLOW_RUNS_PATH}`;
    const signedRun = async (payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload);
      const signature = await signControlPlaneRequest(controlPlaneSecret, "POST", WORKFLOW_RUNS_PATH, body);
      return workerCall(runUrl, { method: "POST", headers: { "content-type": "application/json", [KEY_HEADER]: accessKeys.production, ...signature }, body });
    };
    const runId = randomUUID();
    const started = await signedRun({ requestId: runId, graphId: GRAPH_ID, workspaceId, payload: liveProofRunPayload(workspaceId) });
    must("starting the signed run", started.status === 202, started);
    let after = before;
    for (const t0 = Date.now(); Date.now() - t0 < pollTimeoutMs; await sleep(pollIntervalMs)) {
      after = await readWallet();
      if (after.deductions >= 1) break;
    }
    // When the debit did not land, say why: Cloudflare's own record of the Workflow run (status, error, the failed nodes and
    // each step), read with one GET on the pinned account, redacted.
    let instance: Record<string, unknown> | undefined;
    if (after.deductions < 1) {
      instance = await describeWorkflowRun(rest, `${ownPrefix}production-graphs`, String((started.body as { id?: unknown }).id ?? runId), hide);
    }
    const noWorkspace = await signedRun({ requestId: randomUUID(), graphId: GRAPH_ID, payload: {} });
    const badWorkspace = await signedRun({ requestId: randomUUID(), graphId: GRAPH_ID, workspaceId: "ws__not_a_tenant", payload: {} });
    await sleep(Math.min(pollIntervalMs * 2, 10_000));
    const final = await readWallet();
    const codeOf = (r: { body: Record<string, unknown> }) => (r.body.error as { code?: string } | undefined)?.code;
    steps.wallet = {
      workspaceId,
      fundedMilli: FUNDED_MILLI,
      before,
      afterRun: after,
      runStatus: started.status,
      ...(instance ? { instance } : {}),
      noWorkspace: { status: noWorkspace.status, code: codeOf(noWorkspace) },
      badWorkspace: { status: badWorkspace.status, code: codeOf(badWorkspace) },
      final,
    };
    must("the signed run debited the workspace exactly once", after.deductions === 1 && after.balanceMilli < before.balanceMilli, steps.wallet);
    must("a run with no workspace is refused (400 NO_WORKSPACE)", noWorkspace.status === 400 && codeOf(noWorkspace) === "NO_WORKSPACE", noWorkspace);
    must("a run with a bad workspace is refused (400 BAD_WORKSPACE)", badWorkspace.status === 400 && codeOf(badWorkspace) === "BAD_WORKSPACE", badWorkspace);
    must("the refused runs debited nothing", final.deductions === 1 && final.balanceMilli === after.balanceMilli, steps.wallet);
    say(`5. wallet: ${before.balanceMilli} -> ${after.balanceMilli} milli-credits, 1 deduction; no workspace ${noWorkspace.status}, bad workspace ${badWorkspace.status}, nothing more debited`);

    // ---- 6. a revoked token is refused by Studio, and a deploy with it is refused by Cloudflare
    if (deps.revokedToken) {
      phase = "revoked";
      const refused = await call("POST", `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: deps.revokedToken, accountId, projectId: project }, session);
      const refusedStatus = (refused.body.verification as { status?: string } | undefined)?.status;
      const revokedClient = createClient({ credentials: { token: deps.revokedToken, accountId }, fetch: guardedFetch, sleep, budget, alsoHide: Object.values(secrets) });
      // Before any upload: Cloudflare itself must refuse the token at both verify endpoints (or report it not active).
      let directVerify: string;
      try {
        const answer = await revokedClient.verifyToken();
        directVerify = `${answer.kind} endpoint says ${answer.status}`;
        if (answer.status === "active") {
          steps.revoked = { verifyHttpStatus: refused.status, verifyStatus: refusedStatus, directVerify };
          throw new LiveProofRefusal(`the "revoked" token is ACTIVE at Cloudflare (${directVerify}): step 6 stopped and nothing was uploaded with it; revoke it first`);
        }
      } catch (error) {
        if (error instanceof LiveProofRefusal) throw error;
        if (!(error instanceof CloudflareApiError)) throw error; // unreachable is not a refusal
        directVerify = `refused at both endpoints (HTTP ${error.status})`;
      }
      let deployRefused = false;
      let deployRefusal = "";
      try {
        await revokedClient.uploadScript(`${ownPrefix}revoked`, { mainModule: "worker.mjs", code: "export default { fetch() { return new Response('must not exist'); } };", metadata: { compatibility_date: "2026-10-01" } });
      } catch (error) {
        deployRefused = isCloudflareError(error) && "status" in error && ((error as { status: number }).status === 401 || (error as { status: number }).status === 403);
        deployRefusal = hide(error instanceof Error ? error.message : String(error));
      }
      steps.revoked = { verifyHttpStatus: refused.status, verifyStatus: refusedStatus, errorCode: (refused.body.error as { code?: string } | undefined)?.code, directVerify, deployRefused, deployRefusal };
      must("the revoked token is refused by verify-and-save", refused.status === 422 && refusedStatus !== "active", refused);
      must("a deploy with the revoked token is refused", deployRefused, steps.revoked);
      say(`6. revoked token: verify-and-save ${refused.status} (${refusedStatus}); upload refused by Cloudflare`);
    }
    result.completed = true;
  } catch (error) {
    result.stoppedBecause = hide(error instanceof Error ? error.message : String(error));
    say(`stopped: ${result.stoppedBecause}`);
  } finally {
    // ---- 7. teardown: exactly what the ledger lists, then a read that nothing of ours is left
    phase = "teardown";
    try {
      result.teardown = await teardownAndVerify(rest, ledger);
      if (result.teardown.leftBehind.length > 0) {
        result.completed = false;
        result.stoppedBecause = result.stoppedBecause ?? `teardown left ${result.teardown.leftBehind.length} resource(s) behind`;
      }
      say(`7. teardown: ${result.teardown.removed.length} removed, ${result.teardown.alreadyGone.length} already gone, ${result.teardown.leftBehind.length} left behind`);
    } catch (error) {
      result.completed = false;
      result.stoppedBecause = `${result.stoppedBecause ? `${result.stoppedBecause}; ` : ""}teardown failed: ${hide(error instanceof Error ? error.message : String(error))} (run again with --teardown)`;
      say(result.stoppedBecause);
    }
    studio.close();
  }

  // ---- 8. evidence (after the teardown, so it records what was left): checked for secrets in memory, then the integrity record
  result.finishedAt = new Date().toISOString();
  // The account's workers.dev subdomain never reaches the evidence: both files are redacted before any hash is taken.
  const callsText = `${JSON.stringify(redactWorkersDevSubdomains({ commandStartedAt, project, calls }), null, 2)}\n`;
  // The calls file is covered by the integrity record through its hash in the result file (only *-result.json are recorded).
  const resultText = `${JSON.stringify({ ...redactWorkersDevSubdomains(result), callsFile: CALLS_FILE, callsSha256: createHash("sha256").update(callsText).digest("hex") }, null, 2)}\n`;
  for (const [name, text] of [[RESULT_FILE, resultText], [CALLS_FILE, callsText]] as const) {
    const hits = findSecrets(text, secrets);
    if (hits.length > 0) throw new LiveProofRefusal(`refusing to write ${name}: it contains ${hits.join(" and ")}`);
  }
  const dir = join(deps.root, "evidence", "deployed");
  const attempts = join(dir, "attempts");
  mkdirSync(attempts, { recursive: true });
  const stampOf = (iso: string) => iso.replace(/[:.]/g, "-");
  if (result.completed) {
    // A pass becomes the canonical result; the previous canonical pair moves to attempts/ under its own run's time.
    const previous = join(dir, RESULT_FILE);
    if (existsSync(previous)) {
      let previousStart = commandStartedAt;
      try {
        previousStart = String((JSON.parse(readFileSync(previous, "utf8")) as { commandStartedAt?: string }).commandStartedAt ?? commandStartedAt);
      } catch {
        // unreadable: filed under this run's time
      }
      for (const name of [RESULT_FILE, CALLS_FILE]) if (existsSync(join(dir, name))) renameSync(join(dir, name), join(attempts, `${stampOf(previousStart)}-${name}`));
    }
    writeFileSync(join(dir, RESULT_FILE), resultText);
    writeFileSync(join(dir, CALLS_FILE), callsText);
  } else {
    // A failure never replaces a passing canonical result: it is kept as an attempt only.
    writeFileSync(join(attempts, `${stampOf(commandStartedAt)}-${RESULT_FILE}`), resultText);
    writeFileSync(join(attempts, `${stampOf(commandStartedAt)}-${CALLS_FILE}`), callsText);
  }
  const integrity = recordLiveIntegrity(deps.root);
  if (!integrity.ok) {
    result.completed = false;
    say(`evidence:record-live refused: ${integrity.errors.join("; ")}`);
  } else say(`8. evidence written to evidence/deployed/${result.completed ? RESULT_FILE : `attempts/${stampOf(commandStartedAt)}-${RESULT_FILE}`} and recorded in integrity.json`);
  return result;
}

/**
 * Cloudflare's record of one Workflow run (GET /accounts/{id}/workflows/{name}/instances/{id}), reduced to what explains an
 * outcome: its status, its error, the nodes the graph reported failed, and each step's name and success. Every text goes
 * through hide(). A read that fails is reported, never thrown: this only explains a failure already found.
 */
export async function describeWorkflowRun(client: Client, workflowName: string, instanceId: string, hide: (text: string) => string): Promise<Record<string, unknown>> {
  try {
    const record = await client.getWorkflowInstance(workflowName, instanceId);
    if (record === null) return { found: false };
    const output = record.output as { ok?: unknown; failed?: Record<string, unknown> } | null;
    return JSON.parse(
      hide(
        JSON.stringify({
          found: true,
          status: record.status,
          success: record.success,
          error: record.error,
          ...(output && typeof output === "object" ? { ok: output.ok ?? null, failed: output.failed ?? {} } : {}),
          steps: record.steps.map((step) => ({ name: step.name, success: step.success })),
        }),
      ),
    ) as Record<string, unknown>;
  } catch (error) {
    return { found: null, readError: hide(error instanceof Error ? error.message : String(error)) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The command. Only this part reads the environment and the network.

const repoRoot = resolve(import.meta.dirname, "..");

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const { CredentialsError, loadCredentials } = await import("../packages/deploy/src/provisioner/index.ts");
  let credentials;
  try {
    credentials = loadCredentials(process.env);
  } catch (error) {
    if (error instanceof CredentialsError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const stateArg = arg("--state-dir");
  if (!stateArg) {
    console.error("--state-dir <folder> is required: the ledger is kept there, outside the repositories");
    return 2;
  }
  const stateDir = resolve(stateArg);
  const inside = (child: string, parent: string) => (child + sep).toLowerCase().startsWith((resolve(parent) + sep).toLowerCase());
  if (inside(stateDir, repoRoot)) {
    console.error("the state folder must be outside the repository");
    return 2;
  }
  mkdirSync(stateDir, { recursive: true });
  const ledgerStore = fileStore(join(stateDir, "studio-ledger.json"));
  // No redirect is ever followed: a redirected API answer is an error, not a new destination.
  const realFetch = (request: Request) => fetch(new Request(request, { signal: AbortSignal.timeout(60_000), redirect: "error" }));

  if (argv.includes("--teardown")) {
    const res = await runTeardownOnly({ credentials, cloudflareFetch: realFetch, ledgerStore });
    console.log(`teardown: removed ${res.removed.length}, already gone ${res.alreadyGone.length}, unledgered ${res.unledgered.length}`);
    for (const u of res.unledgered) console.log(`  not in the ledger (left alone): ${u.kind} ${u.name}`);
    return res.unledgered.length === 0 ? 0 : 1;
  }

  // A finished ledger is kept beside a new one, so every run gets its own suffix.
  const ledgerPath = join(stateDir, "studio-ledger.json");
  const previous = ledgerStore.read();
  if (previous && previous.entries.every((e) => e.status === "removed")) renameSync(ledgerPath, `${ledgerPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.done`);

  const revokedEnv = arg("--revoked-token-env");
  const revokedToken = revokedEnv ? process.env[revokedEnv]?.trim() : undefined;
  if (revokedEnv && !revokedToken) {
    console.error(`--revoked-token-env ${revokedEnv}: that variable is not set`);
    return 2;
  }
  const rootSecret = process.env.PX_TELEMETRY_SECRET?.trim() ?? "";
  const result = await runLiveStudioDeploy({
    credentials,
    rootSecret,
    ...(revokedToken ? { revokedToken } : {}),
    cloudflareFetch: realFetch,
    workerFetch: realFetch,
    bundle: nodeBundler,
    ledgerStore,
    randomHex: (n) => randomBytes(n).toString("hex"),
    root: repoRoot,
  });
  console.log(result.completed ? "live Studio deploy proof: PASSED" : `live Studio deploy proof: FAILED (${result.stoppedBecause})`);
  return result.completed ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}

