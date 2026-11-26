// Control-plane attack suite (story 0.15; story 16 extends it to every studio-api route). It attacks the Studio MCP
// endpoint (POST /api/mcp) once per tool, for every tool the server registers (ALL_TOOLS plus get_history), and the MCP
// token issue and revoke routes, with these attack classes:
//
//   TOKEN_OTHER_PROJECT  a token bound to P1 names P2 (same org)                    -> 403, P2 unchanged
//   TOKEN_OTHER_ORG      a token of org A names org B's project                      -> 403, PB unchanged
//   NO_PROJECT_ARG       a token bound to P1 omits `project`                         -> runs on P1 only
//   SCOPE_ESCALATION     a read-only token calls a write tool on its own project     -> 403, P1 unchanged
//   ORG_HEADER_FORWARD   a token bound to P1 sends x-org-id: <org B>                 -> ignored, nothing of B seen or changed;
//                        and a tool's internal Studio call never receives the client's x-org-id
//   LEGACY_TOKEN         a stored token with no project                              -> 401, "issue a project token"
//   UNAUTH               no credentials                                              -> 401
//   HEADER_AUTHOR        x-mcp-client-* headers or a body `author`                   -> the author is the verified caller
//   TOKEN_OWN_PROJECT    a read+edit token applies ops on its own project            -> succeeds, agent on behalf of the user
//   TOKEN_MINTS_TOKEN    an admin-owned MCP token issues or revokes a token          -> 403
//   BAD_SCOPE            issuing `*`, `write`, an empty list or a mixed list         -> 400
//   FOREIGN_PROJECT_ISSUE issuing for another org's project, or none                 -> 403/404, or 400
//   TOKEN_CREATES_PROJECT a token creates a new project in its org                    -> 403, nothing created
//
// Violations are compared with control-plane-attack.known-failures.json through the shared registry helper
// (test/support/attack-registry.ts): any violation not listed is a NEW_FAILURE, any listed entry that no longer fails is a
// STALE_ENTRY. The registry is empty: this suite passes with 0 failures.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, test } from "vitest";
import { sha256Hex } from "@poc/assembler";
import { ALL_TOOLS } from "@poc/mcp-server";
import {
  deriveProjectTelemetrySecret,
  insertStepEvent,
  insertStructuredLog,
  signTelemetryWebhook,
  TELEMETRY_SIGNATURE_HEADER,
  upsertHttpRollup,
  upsertQueueMetrics,
  upsertRunRecord,
} from "@poc/telemetry";
import { compareWithRegistry, describeComparison, registryKeyOf } from "../../../test/support/attack-registry.ts";
import type { RegistryEntry, RegistryViolation } from "../../../test/support/attack-registry.ts";
import { app, createStudioApiApp, ensureStudioD1Schema } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import knownFailuresFile from "./control-plane-attack.known-failures.json";
import { activateTestSandbox } from "./sandbox-data-store.ts";

const studioEnv = env as unknown as StudioApiEnv;
const REGISTRY_FILE = "control-plane-attack.known-failures.json";
const registry: RegistryEntry[] = (knownFailuresFile as { entries: RegistryEntry[] }).entries;

const MCP_ATTACKS = [
  "TOKEN_OTHER_PROJECT",
  "TOKEN_OTHER_ORG",
  "NO_PROJECT_ARG",
  "SCOPE_ESCALATION",
  "ORG_HEADER_FORWARD",
  "LEGACY_TOKEN",
  "UNAUTH",
] as const;
const ROUTE_ATTACKS = ["TOKEN_MINTS_TOKEN", "TOKEN_CREATES_PROJECT", "BAD_SCOPE", "FOREIGN_PROJECT_ISSUE", "UNAUTH"] as const;
const ALL_ATTACKS: readonly string[] = [
  ...MCP_ATTACKS,
  ...ROUTE_ATTACKS,
  "HEADER_AUTHOR",
  "TOKEN_OWN_PROJECT",
  // Story 16: the route matrix over every studio-api route (see the second describe block).
  "PROJECT_B",
  "ORG_HEADER_B",
  "CLAIM_UNOWNED",
  "READ_UNKNOWN",
  "VIEWER_MUTATE",
  "ORG_B",
  "TOKEN_ORG_ROUTE",
  "ADMIN_ROUTES",
  "ADMIN_OPERATOR",
  "BODY_ORG_B",
  "LIST_TOKEN",
  "LIST_SESSION",
  "CONN_DEFAULT",
  "CONN_REF_OTHER",
  "GLOBAL_HEALTH_RESET",
  "GLOBAL_RUN_PRUNE",
  "SEED_CONTROL_PLANE",
  // Story 1.4: telemetry keyed by project.
  "TELEMETRY_CROSS_RUN",
  "TELEMETRY_CROSS_RERUN",
  "TELEMETRY_LISTS",
  "WEBHOOK_PROJECT",
  "RECONCILE_TARGET",
];

/** Every tool name the Studio MCP endpoint answers: the registered tools plus get_history (handled in place). */
const TOOL_NAMES = [...new Set([...ALL_TOOLS.map((t) => t.name), "get_history"])];
const WRITE_TOOLS = new Set(ALL_TOOLS.filter((t) => !t.readOnly).map((t) => t.name));

interface Person {
  userId: string;
  orgId: string;
  token: string;
}

interface World {
  alice: Person;
  bob: Person;
  p1: string;
  p2: string;
  pb: string;
  markers: { p1: string; p2: string; pb: string };
  full: { token: string; id: string };
  readOnly: { token: string; id: string };
  legacy: string;
}

let world: World;

async function call(
  path: string,
  init: { method?: string; bearer?: string | null; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; text: string; json: () => any }> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(
    path,
    {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    studioEnv,
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    json: () => JSON.parse(text),
  };
}

let rpcId = 1;
function callTool(
  bearer: string | null,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return call("/api/mcp", {
    bearer,
    headers,
    body: { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } },
  });
}

async function signUp(label: string): Promise<Person> {
  const res = await call("/api/auth/signup", {
    body: {
      email: `cp-attack-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`,
      password: "Password12345!",
      name: `Attack ${label}`,
    },
  });
  expect(res.status).toBe(201);
  const body = res.json() as { token: string; user: { id: string } };
  return { userId: body.user.id, orgId: `org_personal_${body.user.id}`, token: body.token };
}

async function createProject(owner: Person, project: string, marker: string): Promise<void> {
  const created = await call(`/api/orgs/${owner.orgId}/projects`, {
    bearer: owner.token,
    body: { project },
  });
  expect(created.status, created.text).toBe(201);
  const seeded = await call(`/api/projects/${project}/ops`, {
    bearer: owner.token,
    body: {
      ops: [
        { opId: `${project}-mw`, type: "enable_brick", brickId: "multi-workspace" },
        { opId: `${project}-meta`, type: "set_metadata", metadata: { displayName: marker } },
      ],
    },
  });
  expect(seeded.status, seeded.text).toBe(200);
}

async function issueToken(
  owner: Person,
  projectId: string,
  scopes: string[],
): Promise<{ token: string; id: string }> {
  const res = await call(`/api/orgs/${owner.orgId}/mcp-tokens`, {
    bearer: owner.token,
    body: { clientName: "attack-suite", projectId, scopes },
  });
  expect(res.status, res.text).toBe(201);
  const body = res.json() as { token: string; id: string };
  return { token: body.token, id: body.id };
}

/** A project's revision and semantic hash, read by its owner; any change shows as a different string. */
async function stateOf(owner: Person, project: string): Promise<string> {
  const res = await call(`/api/projects/${project}`, { bearer: owner.token });
  expect(res.status, res.text).toBe(200);
  const body = res.json() as { revision: number; semanticHash: string };
  return `${body.revision}:${body.semanticHash}`;
}

/** The minimal arguments a tool needs to get past its schema, when a test wants it to actually run. */
function argsFor(tool: string, project?: string): Record<string, unknown> {
  const p = project === undefined ? {} : { project };
  switch (tool) {
    case "get_brick":
      return { ...p, id: "credit-wallet" };
    case "get_node":
      return { ...p, type: "trigger.manual" };
    case "apply_ops":
      // AD-V8: a preview-safe edit an agent may apply directly (without mode it would only be a proposal).
      return { ...p, mode: "apply", ops: [{ opId: `attack-${crypto.randomUUID()}`, type: "set_metadata", metadata: { displayName: "attacked" } }] };
    case "enable_brick":
      return { ...p, bricks: ["credit-wallet"] };
    case "define_entity":
      return { ...p, entities: [{ name: "attacked", fields: [{ name: "title", type: "text" }] }] };
    case "revert_to_revision":
      return { ...p, targetRevision: 0 };
    case "request_connection":
      return { ...p, app: "slack", reason: "attack" };
    case "deploy_apply":
    case "deploy_plan":
      return { ...p, env: "preview" };
    case "get_run_trace":
      return { ...p, runId: "run_attack" };
    case "test_workflow":
      return { ...p, workflowId: "wf_attack" };
    default:
      return p;
  }
}

const isRefused = (status: number, allowed: number[]) => allowed.includes(status);

beforeAll(async () => {
  await ensureStudioD1Schema(studioEnv.STUDIO_DB);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const alice = await signUp("alice");
  const bob = await signUp("bob");
  const p1 = `cpa-p1-${suffix}`;
  const p2 = `cpa-p2-${suffix}`;
  const pb = `cpa-pb-${suffix}`;
  const markers = { p1: `MARKER-P1-${suffix}`, p2: `MARKER-P2-${suffix}`, pb: `MARKER-PB-${suffix}` };
  await createProject(alice, p1, markers.p1);
  await createProject(alice, p2, markers.p2);
  await createProject(bob, pb, markers.pb);
  const full = await issueToken(alice, p1, ["read", "edit", "deploy", "connect"]);
  const readOnly = await issueToken(alice, p1, ["read"]);

  // A token stored before story 0.15: no project.
  const legacy = `px_mcp_legacy_${suffix}_0123456789abcdef`;
  await studioEnv.STUDIO_DB.prepare(
    `INSERT INTO studio_mcp_tokens (id, org_id, project_id, user_id, client_name, token_hash, scopes, revoked_at, created_at)
     VALUES (?, ?, NULL, ?, 'legacy', ?, 'read,edit,deploy,connect', NULL, ?)`,
  )
    .bind(`mcp_legacy_${suffix}`, alice.orgId, alice.userId, await sha256Hex(legacy), new Date().toISOString())
    .run();

  world = { alice, bob, p1, p2, pb, markers, full, readOnly, legacy };
}, 120_000);

/** Runs every MCP attack against every tool and returns the violations. */
async function runMcpAttacks(): Promise<{ violations: RegistryViolation[]; cases: number }> {
  const w = world;
  const violations: RegistryViolation[] = [];
  let cases = 0;
  const flag = (route: string, attack: string, detail: string) =>
    violations.push({ method: "MCP", route, attack, detail });

  for (const tool of TOOL_NAMES) {
    // TOKEN_OTHER_PROJECT: P1's token names P2 in the same org.
    {
      cases += 1;
      const before = await stateOf(w.alice, w.p2);
      const res = await callTool(w.full.token, tool, argsFor(tool, w.p2));
      const after = await stateOf(w.alice, w.p2);
      if (!isRefused(res.status, [403])) flag(tool, "TOKEN_OTHER_PROJECT", `status ${res.status}, expected 403`);
      if (res.text.includes(w.markers.p2)) flag(tool, "TOKEN_OTHER_PROJECT", "answer contains P2's data");
      if (before !== after) flag(tool, "TOKEN_OTHER_PROJECT", `P2 changed (${before} -> ${after})`);
    }
    // TOKEN_OTHER_ORG: org A's token names org B's project.
    {
      cases += 1;
      const before = await stateOf(w.bob, w.pb);
      const res = await callTool(w.full.token, tool, argsFor(tool, w.pb));
      const after = await stateOf(w.bob, w.pb);
      if (!isRefused(res.status, [403])) flag(tool, "TOKEN_OTHER_ORG", `status ${res.status}, expected 403`);
      if (res.text.includes(w.markers.pb)) flag(tool, "TOKEN_OTHER_ORG", "answer contains org B's data");
      if (before !== after) flag(tool, "TOKEN_OTHER_ORG", `PB changed (${before} -> ${after})`);
    }
    // NO_PROJECT_ARG: P1's token omits `project`; the call is authorised for, and runs on, P1 only.
    {
      cases += 1;
      const before2 = await stateOf(w.alice, w.p2);
      const beforeB = await stateOf(w.bob, w.pb);
      const res = await callTool(w.full.token, tool, argsFor(tool));
      if (res.status !== 200) flag(tool, "NO_PROJECT_ARG", `status ${res.status}, expected 200 on the token's own project`);
      if (res.text.includes(w.markers.p2) || res.text.includes(w.markers.pb))
        flag(tool, "NO_PROJECT_ARG", "answer contains another project's data");
      if ((await stateOf(w.alice, w.p2)) !== before2) flag(tool, "NO_PROJECT_ARG", "P2 changed");
      if ((await stateOf(w.bob, w.pb)) !== beforeB) flag(tool, "NO_PROJECT_ARG", "PB changed");
    }
    // SCOPE_ESCALATION: a read-only token calls a write tool on its own project.
    if (WRITE_TOOLS.has(tool)) {
      cases += 1;
      const before = await stateOf(w.alice, w.p1);
      const res = await callTool(w.readOnly.token, tool, argsFor(tool, w.p1));
      const after = await stateOf(w.alice, w.p1);
      if (!isRefused(res.status, [403])) flag(tool, "SCOPE_ESCALATION", `status ${res.status}, expected 403`);
      if (before !== after) flag(tool, "SCOPE_ESCALATION", `P1 changed (${before} -> ${after})`);
    }
    // ORG_HEADER_FORWARD: P1's token sends x-org-id naming org B; it is ignored and nothing of B is seen or changed.
    {
      cases += 1;
      const beforeB = await stateOf(w.bob, w.pb);
      const res = await callTool(w.full.token, tool, argsFor(tool, w.p1), { "x-org-id": w.bob.orgId });
      if (res.status !== 200) flag(tool, "ORG_HEADER_FORWARD", `status ${res.status}, expected 200 on the token's own project`);
      if (res.text.includes(w.markers.pb)) flag(tool, "ORG_HEADER_FORWARD", "answer contains org B's data");
      if ((await stateOf(w.bob, w.pb)) !== beforeB) flag(tool, "ORG_HEADER_FORWARD", "PB changed");
    }
    // LEGACY_TOKEN: a stored token with no project is refused, and told what to do.
    {
      cases += 1;
      const before = await stateOf(w.alice, w.p1);
      const res = await callTool(w.legacy, tool, argsFor(tool, w.p1));
      if (res.status !== 401) flag(tool, "LEGACY_TOKEN", `status ${res.status}, expected 401`);
      if (!/issue a project token/i.test(res.text)) flag(tool, "LEGACY_TOKEN", "the refusal does not say to issue a project token");
      if ((await stateOf(w.alice, w.p1)) !== before) flag(tool, "LEGACY_TOKEN", "P1 changed");
    }
    // UNAUTH: no credentials at all.
    {
      cases += 1;
      const res = await callTool(null, tool, argsFor(tool, w.p1));
      if (res.status !== 401) flag(tool, "UNAUTH", `status ${res.status}, expected 401`);
      if (res.text.includes(w.markers.p1)) flag(tool, "UNAUTH", "answer contains P1's data");
    }
  }

  // ORG_HEADER_FORWARD, internal calls: tools reach internal Studio routes (studioRequest), and those routes take an
  // explicit org from x-org-id when the project has no row yet. Carol is a member of her own org and of org B; she calls
  // request_connection on a project with no row while naming org B in x-org-id. The internal route must not see the header,
  // so the connection request it records belongs to Carol's own org, never to org B.
  {
    cases += 1;
    const carol = await signUp("carol");
    await studioEnv.STUDIO_DB.prepare(
      "INSERT INTO studio_org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'builder', ?)",
    )
      .bind(w.bob.orgId, carol.userId, new Date().toISOString())
      .run();
    const rowless = `cpa-norow-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const res = await callTool(carol.token, "request_connection", argsFor("request_connection", rowless), {
      "x-org-id": w.bob.orgId,
    });
    if (res.status !== 200) flag("request_connection", "ORG_HEADER_FORWARD", `status ${res.status}, expected 200`);
    const rows =
      (
        await studioEnv.STUDIO_DB.prepare("SELECT org_id FROM studio_connection_requests WHERE project_id = ?")
          .bind(rowless)
          .all<{ org_id: string }>()
      ).results ?? [];
    if (rows.length === 0) flag("request_connection", "ORG_HEADER_FORWARD", "the internal request was not made");
    if (rows.some((r) => r.org_id === w.bob.orgId))
      flag("request_connection", "ORG_HEADER_FORWARD", "the internal route used the forwarded x-org-id (org B)");
    if (rows.some((r) => r.org_id !== carol.orgId))
      flag("request_connection", "ORG_HEADER_FORWARD", `recorded under ${rows.map((r) => r.org_id).join(",")}, expected Carol's org`);
  }
  return { violations, cases };
}

/** Attacks the MCP token issue and revoke routes and returns the violations. */
async function runTokenRouteAttacks(): Promise<{ violations: RegistryViolation[]; cases: number }> {
  const w = world;
  const violations: RegistryViolation[] = [];
  let cases = 0;
  const ISSUE = "/api/orgs/:orgId/mcp-tokens";
  const REVOKE = "/api/orgs/:orgId/mcp-tokens/:tokenId";
  const flag = (method: string, route: string, attack: string, detail: string) =>
    violations.push({ method, route, attack, detail });
  const tokenCount = async () =>
    (await studioEnv.STUDIO_DB.prepare("SELECT COUNT(*) AS n FROM studio_mcp_tokens WHERE org_id = ?")
      .bind(w.alice.orgId)
      .first<{ n: number }>())!.n;

  // TOKEN_MINTS_TOKEN: Alice owns her org, so her MCP tokens are admin-owned; none of them may issue or revoke.
  for (const bearer of [w.full.token, w.readOnly.token]) {
    cases += 1;
    const before = await tokenCount();
    const res = await call(`/api/orgs/${w.alice.orgId}/mcp-tokens`, {
      bearer,
      body: { clientName: "minted", projectId: w.p1, scopes: ["read", "edit", "deploy", "connect"] },
    });
    if (res.status !== 403) flag("POST", ISSUE, "TOKEN_MINTS_TOKEN", `status ${res.status}, expected 403`);
    if ((await tokenCount()) !== before) flag("POST", ISSUE, "TOKEN_MINTS_TOKEN", "a token was created");

    cases += 1;
    const revoke = await call(`/api/orgs/${w.alice.orgId}/mcp-tokens/${w.readOnly.id}`, { method: "DELETE", bearer });
    if (revoke.status !== 403) flag("DELETE", REVOKE, "TOKEN_MINTS_TOKEN", `status ${revoke.status}, expected 403`);
    const row = await studioEnv.STUDIO_DB.prepare("SELECT revoked_at FROM studio_mcp_tokens WHERE id = ?")
      .bind(w.readOnly.id)
      .first<{ revoked_at: string | null }>();
    if (row?.revoked_at !== null) flag("DELETE", REVOKE, "TOKEN_MINTS_TOKEN", "the token was revoked");
  }

  // BAD_SCOPE: only read, edit, deploy and connect exist.
  for (const scopes of [["*"], ["write"], [], ["read", "*"], ["read", "admin"], "read,*"]) {
    cases += 1;
    const before = await tokenCount();
    const res = await call(`/api/orgs/${w.alice.orgId}/mcp-tokens`, {
      bearer: w.alice.token,
      body: { clientName: "bad-scope", projectId: w.p1, scopes },
    });
    if (res.status !== 400) flag("POST", ISSUE, "BAD_SCOPE", `scopes ${JSON.stringify(scopes)}: status ${res.status}, expected 400`);
    if ((await tokenCount()) !== before) flag("POST", ISSUE, "BAD_SCOPE", `scopes ${JSON.stringify(scopes)}: a token was created`);
  }

  // FOREIGN_PROJECT_ISSUE: a project of another org, an unknown project, or none at all.
  for (const [projectId, allowed] of [
    [w.pb, [403, 404]],
    [`cpa-none-${crypto.randomUUID().slice(0, 8)}`, [403, 404]],
    [undefined, [400]],
  ] as const) {
    cases += 1;
    const before = await tokenCount();
    const res = await call(`/api/orgs/${w.alice.orgId}/mcp-tokens`, {
      bearer: w.alice.token,
      body: { clientName: "foreign", scopes: ["read"], ...(projectId ? { projectId } : {}) },
    });
    if (!isRefused(res.status, [...allowed]))
      flag("POST", ISSUE, "FOREIGN_PROJECT_ISSUE", `projectId ${projectId ?? "(none)"}: status ${res.status}, expected ${allowed.join("/")}`);
    if ((await tokenCount()) !== before) flag("POST", ISSUE, "FOREIGN_PROJECT_ISSUE", "a token was created");
  }
  // ...and Alice cannot issue in Bob's org for Bob's project either.
  cases += 1;
  {
    const res = await call(`/api/orgs/${w.bob.orgId}/mcp-tokens`, {
      bearer: w.alice.token,
      body: { clientName: "foreign", projectId: w.pb, scopes: ["read"] },
    });
    if (res.status !== 403) flag("POST", ISSUE, "FOREIGN_PROJECT_ISSUE", `issuing in another org: status ${res.status}, expected 403`);
  }

  // TOKEN_CREATES_PROJECT: a token is bound to one project and cannot create another in its org.
  for (const bearer of [w.full.token, w.readOnly.token]) {
    cases += 1;
    const project = `cpa-new-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const res = await call(`/api/orgs/${w.alice.orgId}/projects`, { bearer, body: { project } });
    if (res.status !== 403) flag("POST", "/api/orgs/:orgId/projects", "TOKEN_CREATES_PROJECT", `status ${res.status}, expected 403`);
    const row = await studioEnv.STUDIO_DB.prepare("SELECT project_id FROM projects WHERE project_id = ?")
      .bind(project)
      .first();
    if (row) flag("POST", "/api/orgs/:orgId/projects", "TOKEN_CREATES_PROJECT", "the project was created");
  }

  // UNAUTH on both routes.
  cases += 2;
  {
    const res = await call(`/api/orgs/${w.alice.orgId}/mcp-tokens`, { body: { projectId: w.p1, scopes: ["read"] } });
    if (res.status !== 401) flag("POST", ISSUE, "UNAUTH", `status ${res.status}, expected 401`);
    const revoke = await call(`/api/orgs/${w.alice.orgId}/mcp-tokens/${w.readOnly.id}`, { method: "DELETE" });
    if (revoke.status !== 401) flag("DELETE", REVOKE, "UNAUTH", `status ${revoke.status}, expected 401`);
  }
  return { violations, cases };
}

describe("control-plane attack suite: Studio MCP and MCP token routes (story 0.15)", () => {
  test("TOKEN_OWN_PROJECT: a read+edit token applies ops on its own project, authored as the agent on behalf of its user", async () => {
    const w = world;
    const own = await issueToken(w.alice, w.p1, ["read", "edit"]);
    const before = await stateOf(w.alice, w.p1);
    const res = await callTool(own.token, "apply_ops", argsFor("apply_ops", w.p1));
    expect(res.status, res.text).toBe(200);
    const body = res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError, body.result.content[0]?.text).not.toBe(true);
    expect(await stateOf(w.alice, w.p1)).not.toBe(before);
    const history = await call(`/api/projects/${w.p1}/revisions`, { bearer: w.alice.token });
    expect(history.status).toBe(200);
    const latest = await call(
      `/api/projects/${w.p1}/revisions/${Number((await stateOf(w.alice, w.p1)).split(":")[0])}`,
      { bearer: w.alice.token },
    );
    expect(latest.json().author).toMatchObject({ type: "agent", id: own.id, onBehalfOf: w.alice.userId });
  });

  test("HEADER_AUTHOR: x-mcp-client-* headers and a body author never set the author; it is the verified caller", async () => {
    const w = world;
    const evilHeaders = { "x-mcp-client-id": "evil", "x-mcp-client-name": "evil-client", "x-client-id": "evil" };
    const latestAuthor = async () => {
      const rev = Number((await stateOf(w.alice, w.p1)).split(":")[0]);
      return (await call(`/api/projects/${w.p1}/revisions/${rev}`, { bearer: w.alice.token })).json().author;
    };

    // A session caller over MCP: the author is the session user.
    const viaMcp = await callTool(
      w.alice.token,
      "apply_ops",
      { ...argsFor("apply_ops", w.p1), author: { type: "agent", id: "evil" } },
      evilHeaders,
    );
    expect(viaMcp.status, viaMcp.text).toBe(200);
    expect(await latestAuthor()).toEqual({ type: "human", id: w.alice.userId });

    // A session caller over HTTP with a body author: the author is the session user.
    const viaHttp = await call(`/api/projects/${w.p1}/ops`, {
      bearer: w.alice.token,
      headers: evilHeaders,
      body: {
        author: { type: "agent", id: "evil", client: "evil" },
        ops: [{ opId: `hdr-${crypto.randomUUID()}`, type: "set_metadata", metadata: { displayName: "hdr" } }],
      },
    });
    expect(viaHttp.status, viaHttp.text).toBe(200);
    expect(viaHttp.json().author).toEqual({ type: "human", id: w.alice.userId });

    // A token caller with a body author and headers: the author is the token.
    const viaToken = await call(`/api/projects/${w.p1}/ops`, {
      bearer: w.full.token,
      headers: evilHeaders,
      body: {
        author: { type: "human", id: "evil" },
        ops: [{ opId: `hdr-${crypto.randomUUID()}`, type: "set_metadata", metadata: { displayName: "hdr2" } }],
      },
    });
    expect(viaToken.status, viaToken.text).toBe(200);
    expect(viaToken.json().author).toMatchObject({ type: "agent", id: w.full.id, onBehalfOf: w.alice.userId });
  });

  test("the oracle catches a seeded violation (a 200 where a refusal is due) and reports it as a NEW_FAILURE", () => {
    const seeded: RegistryViolation = {
      method: "MCP",
      route: "get_blueprint_summary",
      attack: "TOKEN_OTHER_PROJECT",
      detail: "status 200, expected 403",
    };
    const lines = describeComparison(compareWithRegistry([seeded], registry), REGISTRY_FILE);
    expect(lines).toEqual(["NEW_FAILURE MCP get_blueprint_summary TOKEN_OTHER_PROJECT: status 200, expected 403"]);
    const stale = describeComparison(
      compareWithRegistry([], [{ method: "MCP", route: "apply_ops", attack: "UNAUTH", story: "16", reason: "fixture" }]),
      REGISTRY_FILE,
    );
    expect(stale).toEqual([`STALE_ENTRY remove fixed entry MCP apply_ops UNAUTH (story 16) from ${REGISTRY_FILE}`]);
  });

  test("registry entries are well formed (and the registry is empty)", () => {
    const seen = new Set<string>();
    for (const e of registry) {
      const where = registryKeyOf(e);
      expect(ALL_ATTACKS, where).toContain(e.attack);
      expect(e.reason.trim().length, where).toBeGreaterThan(0);
      expect(seen.has(where), `${where} is listed twice`).toBe(false);
      seen.add(where);
    }
    expect(registry).toEqual([]);
  });

  test(
    "every MCP tool and both token routes, under every attack class: 0 failures against the registry",
    async () => {
      const mcp = await runMcpAttacks();
      const routes = await runTokenRouteAttacks();
      const violations = [...mcp.violations, ...routes.violations];
      const problems = describeComparison(compareWithRegistry(violations, registry), REGISTRY_FILE);

      // Coverage: every tool the endpoint answers was attacked with every MCP attack class that applies to it.
      expect(TOOL_NAMES.length).toBeGreaterThanOrEqual(ALL_TOOLS.length);
      const expectedMcpCases = TOOL_NAMES.length * 6 + TOOL_NAMES.filter((t) => WRITE_TOOLS.has(t)).length + 1;
      expect(mcp.cases).toBe(expectedMcpCases);
      expect(routes.cases).toBeGreaterThanOrEqual(15);
      expect(problems, problems.join("\n")).toEqual([]);
    },
    600_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Story 16: every studio-api route. createStudioApiApp().routes is enumerated (method + path, deduped, middleware
// entries dropped) and every route is attacked with each matrix class that applies to it:
//
//   UNAUTH               no credentials                                              -> 401 (public routes excepted)
//   PROJECT_B            Alice (org A) on org B's project PB                         -> 403/404, PB and org B unchanged
//   TOKEN_OTHER_PROJECT  token(A, P1) on P2 (same org)                               -> 403, P2 unchanged
//   TOKEN_OTHER_ORG      token(A, P1) on PB                                          -> 403/404, PB unchanged
//   ORG_HEADER_B         Alice on her own P1 with x-org-id, ?orgId and body orgId = B -> behaves as org A: never refused
//                                                                                       as a non-member of B, nothing of B
//                                                                                       seen, written or changed
//   CLAIM_UNOWNED        Alice writes to an unused slug while selecting org B        -> refused, no projects row in B
//   READ_UNKNOWN         Alice reads a project with no row                           -> 404, no row created
//   VIEWER_MUTATE        a viewer of org A calls a mutating route on A's project     -> 403, the project unchanged
//   ORG_B                Alice on org B's org-level route (/api/orgs/B/...)          -> 403, org B unchanged
//   TOKEN_ORG_ROUTE      token(A, P1) on org A's own org-level route                 -> 403
//   ADMIN_ROUTES         a non-operator session, or any MCP token, on /api/admin/*   -> 403
//   ADMIN_OPERATOR       a caller listed in PX_PLATFORM_OPERATORS on /api/admin/*    -> allowed
// plus the targeted rows BODY_ORG_B, LIST_TOKEN, LIST_SESSION, CONN_DEFAULT, CONN_REF_OTHER, and the three global writes a
// project builder must not reach: GLOBAL_HEALTH_RESET (health seed `reset`), GLOBAL_RUN_PRUNE (runs/prune) and
// SEED_CONTROL_PLANE (data/seed into control-plane tables or with raw DDL).
// Story 1.4 adds the telemetry rows. PB's runs, step events, logs, health rollups, queue metrics, data and ledger rows sit
// in the same STUDIO_DB (and the same workspace) as P1's; a caller authorised only for P1 (Alice's session or her P1
// token) on P1's own routes:
//   TELEMETRY_CROSS_RUN    reads PB's run by id                                       -> 404 RUN_NOT_FOUND, nothing of PB
//   TELEMETRY_CROSS_RERUN  reruns PB's run                                            -> 404, no run started
//   TELEMETRY_LISTS        runs list, events, logs, health, metrics, activity, data   -> no PB row (P1's own rows present)
//   WEBHOOK_PROJECT        a signed webhook on P1's URL whose payload names PB, or none -> 400/401, nothing written;
//                          a payload signed with P1's derived secret posted to PB's URL  -> 401, nothing written
//   RECONCILE_TARGET       reconcile with a body workerUrl                                  -> refused, nothing written;
//                          P1 reconciles PB's workspace id from its own target (PB's ids) -> 409, nothing written, unreadable
// The data and ledger rows of each project live in that project's own data store (its active sandbox database).
// ---------------------------------------------------------------------------------------------------------------------

const ROUTE_MATRIX_ATTACKS = [
  "UNAUTH",
  "PROJECT_B",
  "TOKEN_OTHER_PROJECT",
  "TOKEN_OTHER_ORG",
  "ORG_HEADER_B",
  "CLAIM_UNOWNED",
  "READ_UNKNOWN",
  "VIEWER_MUTATE",
  "ORG_B",
  "TOKEN_ORG_ROUTE",
  "ADMIN_ROUTES",
  "ADMIN_OPERATOR",
  "BODY_ORG_B",
  "LIST_TOKEN",
  "LIST_SESSION",
  "CONN_DEFAULT",
  "CONN_REF_OTHER",
  "GLOBAL_HEALTH_RESET",
  "GLOBAL_RUN_PRUNE",
  "SEED_CONTROL_PLANE",
  "TELEMETRY_CROSS_RUN",
  "TELEMETRY_CROSS_RERUN",
  "TELEMETRY_LISTS",
  "WEBHOOK_PROJECT",
  "RECONCILE_TARGET",
] as const;

interface RouteWorld {
  alice: Person;
  bob: Person;
  viewer: Person;
  dana: Person;
  operator: Person;
  p1: string;
  p2: string;
  pb: string;
  pv: string;
  markers: { p1: string; p2: string; pb: string; pv: string };
  token: { token: string; id: string };
  connA: string;
  connB: string;
}

let rw: RouteWorld;

/** Public routes: sign-in, the catalog, OAuth callbacks (state-bound) and the HMAC-signed telemetry webhook. */
function isPublicRoute(method: string, path: string): boolean {
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return true;
  if (method === "GET" && (path === "/api/catalog" || path === "/api/templates")) return true;
  if (path === "/api/connections/oauth/:app/callback") return true;
  if (method === "POST" && path === "/api/projects/:project/telemetry/webhook") return true;
  return false;
}

/** Every route the Studio API registers, once per method + path. Middleware (`ALL`) entries are dropped. */
function enumerateRoutes(): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; path: string }> = [];
  for (const r of createStudioApiApp().routes) {
    const method = r.method.toUpperCase();
    if (method === "ALL" || method === "OPTIONS" || method === "HEAD") continue;
    const key = `${method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method, path: r.path });
  }
  return out;
}

function materialize(
  path: string,
  ids: { project?: string; orgId?: string; ref?: string; userId?: string },
): string {
  return path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    switch (name) {
      case "project":
        return ids.project ?? "cpa-none";
      case "orgId":
        return ids.orgId ?? "org_none";
      case "ref":
        return ids.ref ?? "conn_none";
      case "userId":
        return ids.userId ?? "usr_none";
      case "app":
        return "slack";
      case "envName":
        return "preview";
      case "revision":
        return "1";
      case "tableName":
        return "users";
      case "rowId":
        return "1";
      default:
        return `${name}_cpa`;
    }
  });
}

const isWrite = (method: string) => method !== "GET";
const isProjectRoute = (path: string) => path.startsWith("/api/projects/:project");
const isOrgRoute = (path: string) => path.startsWith("/api/orgs/:orgId");
const isAdminRoute = (path: string) => path.startsWith("/api/admin/");
const isMcpRoute = (path: string) => path === "/mcp" || path === "/api/mcp";

/** Every row of every Studio table that carries this project's (or org's) id, as one string: any write shows up. */
async function fingerprint(project: string, orgId: string): Promise<string> {
  const parts: string[] = [];
  const dbs = [studioEnv.STUDIO_DB, studioEnv.DB].filter(Boolean) as Array<StudioApiEnv["STUDIO_DB"]>;
  for (const db of dbs) {
    const tables =
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
          )
          .all<{ name: string }>()
      ).results ?? [];
    for (const { name } of tables) {
      // Refusals are recorded in the project org's audit trail by design; that is not a change to the org's state.
      if (name === "studio_audit_log" || name === "studio_audit_logs") continue;
      const cols = ((await db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>()).results ?? []).map(
        (c) => c.name,
      );
      const where: string[] = [];
      const binds: string[] = [];
      if (cols.includes("project_id")) {
        where.push("project_id = ?");
        binds.push(project);
      }
      if (cols.includes("org_id")) {
        where.push("org_id = ?");
        binds.push(orgId);
      }
      if (where.length === 0) continue;
      const rows =
        (await db.prepare(`SELECT * FROM "${name}" WHERE ${where.join(" OR ")}`).bind(...binds).all()).results ?? [];
      const stable = rows
        .map((r) => JSON.stringify(r))
        .sort()
        .join("\n");
      parts.push(`${name}:${rows.length}:${stable}`);
    }
  }
  return parts.join("\n");
}

async function hit(
  method: string,
  path: string,
  bearer: string | null,
  extra: { headers?: Record<string, string>; body?: Record<string, unknown>; env?: Partial<StudioApiEnv> } = {},
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { ...extra.headers };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "DELETE") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(extra.body ?? {});
  }
  const res = await app.request(path, init, extra.env ? { ...studioEnv, ...extra.env } : studioEnv);
  const text = await res.text();
  return { status: res.status, text };
}

async function rowOrg(project: string): Promise<string | null> {
  const row = await studioEnv.STUDIO_DB.prepare("SELECT org_id FROM projects WHERE project_id = ?")
    .bind(project)
    .first<{ org_id: string }>();
  return row?.org_id ?? null;
}

async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await studioEnv.STUDIO_DB.prepare(
    "INSERT OR REPLACE INTO studio_org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(orgId, userId, role, new Date().toISOString())
    .run();
}

async function seedConnection(owner: Person, project: string, ref: string): Promise<void> {
  const res = await call(`/api/projects/${project}/connections`, {
    bearer: owner.token,
    body: { ref, app: "slack", authType: "apiKey", value: `xoxb-${ref}-secret-value-123456` },
  });
  expect([200, 201], res.text).toContain(res.status);
}

const pxRow = async (ref: string): Promise<string> => {
  const envDb = studioEnv.DB ?? studioEnv.STUDIO_DB;
  return JSON.stringify(await envDb.prepare("SELECT * FROM px_connections WHERE ref = ?").bind(ref).first());
};

/** Runs every matrix class against every route it applies to, and returns the violations. */
async function runRouteMatrix(): Promise<{ violations: RegistryViolation[]; cases: Map<string, number> }> {
  const w = rw;
  const violations: RegistryViolation[] = [];
  const cases = new Map<string, number>();
  const count = (attack: string) => cases.set(attack, (cases.get(attack) ?? 0) + 1);
  const flag = (method: string, route: string, attack: string, detail: string) =>
    violations.push({ method, route, attack, detail });
  const leaks = (text: string, ...markers: string[]) => markers.some((m) => text.includes(m));
  const isOk = (s: number) => s >= 200 && s < 300;
  const slugOf = (prefix: string) => `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

  for (const { method, path } of enumerateRoutes()) {
    if (isPublicRoute(method, path)) continue;

    // UNAUTH: every non-public route.
    {
      count("UNAUTH");
      const res = await hit(method, materialize(path, { project: w.p1, orgId: w.alice.orgId, ref: w.connA }), null);
      if (res.status !== 401) flag(method, path, "UNAUTH", `status ${res.status}, expected 401`);
      if (leaks(res.text, w.markers.p1)) flag(method, path, "UNAUTH", "answer contains P1's data");
    }
    if (isMcpRoute(path)) continue; // the MCP endpoint is attacked per tool by runMcpAttacks

    if (isProjectRoute(path)) {
      const onB = materialize(path, { project: w.pb, orgId: w.bob.orgId, ref: w.connB, userId: w.bob.userId });

      // PROJECT_B: Alice on org B's project.
      {
        count("PROJECT_B");
        const before = await fingerprint(w.pb, w.bob.orgId);
        const res = await hit(method, onB, w.alice.token, { body: { orgId: w.alice.orgId } });
        const after = await fingerprint(w.pb, w.bob.orgId);
        if (res.status !== 403 && res.status !== 404)
          flag(method, path, "PROJECT_B", `status ${res.status}, expected 403/404`);
        if (leaks(res.text, w.markers.pb)) flag(method, path, "PROJECT_B", "answer contains PB's data");
        if (before !== after) flag(method, path, "PROJECT_B", "PB / org B state changed");
      }
      // TOKEN_OTHER_ORG: token(A, P1) on PB.
      {
        count("TOKEN_OTHER_ORG");
        const before = await fingerprint(w.pb, w.bob.orgId);
        const res = await hit(method, onB, w.token.token);
        const after = await fingerprint(w.pb, w.bob.orgId);
        if (res.status !== 403 && res.status !== 404)
          flag(method, path, "TOKEN_OTHER_ORG", `status ${res.status}, expected 403/404`);
        if (leaks(res.text, w.markers.pb)) flag(method, path, "TOKEN_OTHER_ORG", "answer contains PB's data");
        if (before !== after) flag(method, path, "TOKEN_OTHER_ORG", "PB / org B state changed");
      }
      // TOKEN_OTHER_PROJECT: token(A, P1) on P2.
      {
        count("TOKEN_OTHER_PROJECT");
        const onP2 = materialize(path, { project: w.p2, orgId: w.alice.orgId, ref: w.connA, userId: w.alice.userId });
        const before = await fingerprint(w.p2, "org_none");
        const res = await hit(method, onP2, w.token.token);
        const after = await fingerprint(w.p2, "org_none");
        if (res.status !== 403) flag(method, path, "TOKEN_OTHER_PROJECT", `status ${res.status}, expected 403`);
        if (leaks(res.text, w.markers.p2)) flag(method, path, "TOKEN_OTHER_PROJECT", "answer contains P2's data");
        if (before !== after) flag(method, path, "TOKEN_OTHER_PROJECT", "P2 state changed");
      }
      // ORG_HEADER_B: Alice on her own project P1, naming org B in every place a client can.
      {
        count("ORG_HEADER_B");
        const onP1 = materialize(path, { project: w.p1, orgId: w.alice.orgId, ref: w.connA, userId: w.alice.userId });
        const sep = onP1.includes("?") ? "&" : "?";
        const before = await fingerprint(w.pb, w.bob.orgId);
        const res = await hit(method, `${onP1}${sep}orgId=${encodeURIComponent(w.bob.orgId)}`, w.alice.token, {
          headers: { "x-org-id": w.bob.orgId },
          body: { orgId: w.bob.orgId },
        });
        const after = await fingerprint(w.pb, w.bob.orgId);
        if (res.status === 403 && /FORBIDDEN_ORG/.test(res.text))
          flag(method, path, "ORG_HEADER_B", "the client-sent org was used (refused as a non-member of org B)");
        if (leaks(res.text, w.markers.pb)) flag(method, path, "ORG_HEADER_B", "answer contains org B's data");
        if (before !== after) flag(method, path, "ORG_HEADER_B", "org B state changed");
        if ((await rowOrg(w.p1)) !== w.alice.orgId) flag(method, path, "ORG_HEADER_B", "P1 moved out of org A");
      }
      if (isWrite(method)) {
        // CLAIM_UNOWNED: Alice writes to a slug with no row while selecting org B.
        {
          count("CLAIM_UNOWNED");
          const slug = slugOf("cpa-claim");
          const target = materialize(path, { project: slug, orgId: w.bob.orgId, ref: `conn_${slug.replace(/-/g, "_")}` });
          const sep = target.includes("?") ? "&" : "?";
          const res = await hit(method, `${target}${sep}orgId=${encodeURIComponent(w.bob.orgId)}`, w.alice.token, {
            headers: { "x-org-id": w.bob.orgId },
            body: { orgId: w.bob.orgId },
          });
          if ((await rowOrg(slug)) === w.bob.orgId)
            flag(method, path, "CLAIM_UNOWNED", "a projects row was created in org B");
          if (isOk(res.status)) flag(method, path, "CLAIM_UNOWNED", `status ${res.status}, expected a refusal`);
        }
        // VIEWER_MUTATE: a viewer of org A on A's project PV.
        {
          count("VIEWER_MUTATE");
          const onPv = materialize(path, { project: w.pv, orgId: w.alice.orgId, ref: w.connA, userId: w.alice.userId });
          const before = await fingerprint(w.pv, "org_none");
          // The body asks for the route's write path where it has a read one (check-drift's simulated out-of-band change).
          const res = await hit(method, onPv, w.viewer.token, {
            body: { simulateOutOfBand: { deleteWorker: true } },
          });
          const after = await fingerprint(w.pv, "org_none");
          if (res.status !== 403) flag(method, path, "VIEWER_MUTATE", `status ${res.status}, expected 403`);
          if (before !== after) flag(method, path, "VIEWER_MUTATE", "PV changed");
        }
      } else {
        // READ_UNKNOWN: a read of a project with no row.
        count("READ_UNKNOWN");
        const slug = slugOf("cpa-unknown");
        const res = await hit(method, materialize(path, { project: slug, orgId: w.alice.orgId }), w.alice.token);
        if (res.status !== 404) flag(method, path, "READ_UNKNOWN", `status ${res.status}, expected 404`);
        if ((await rowOrg(slug)) !== null) flag(method, path, "READ_UNKNOWN", "a read created a projects row");
      }
      continue;
    }

    if (isOrgRoute(path)) {
      const body = (project: string, userId: string) => ({
        project: slugOf("cpa-org"),
        projectId: project,
        userId,
        role: "owner",
        scopes: ["read"],
        accountId: "0123456789abcdef0123456789abcdef",
        token: "cf_attack_token_0123456789",
      });
      // ORG_B: Alice on org B's org-level route.
      {
        count("ORG_B");
        const before = await fingerprint(w.pb, w.bob.orgId);
        const res = await hit(
          method,
          materialize(path, { orgId: w.bob.orgId, userId: w.bob.userId, project: w.pb }),
          w.alice.token,
          { body: body(w.pb, w.alice.userId) },
        );
        const after = await fingerprint(w.pb, w.bob.orgId);
        if (res.status !== 403) flag(method, path, "ORG_B", `status ${res.status}, expected 403`);
        if (leaks(res.text, w.markers.pb)) flag(method, path, "ORG_B", "answer contains org B's data");
        if (before !== after) flag(method, path, "ORG_B", "org B state changed");
      }
      // TOKEN_ORG_ROUTE: token(A, P1) on org A's own org-level route.
      {
        count("TOKEN_ORG_ROUTE");
        const res = await hit(
          method,
          materialize(path, { orgId: w.alice.orgId, userId: w.alice.userId, project: w.p1 }),
          w.token.token,
          { body: body(w.p1, w.alice.userId) },
        );
        if (res.status !== 403) flag(method, path, "TOKEN_ORG_ROUTE", `status ${res.status}, expected 403`);
      }
      continue;
    }

    if (isAdminRoute(path)) {
      const target = materialize(path, {});
      count("ADMIN_ROUTES");
      for (const [who, bearer, env] of [
        ["non-operator session", w.alice.token, undefined],
        ["MCP token", w.token.token, undefined],
        // An MCP token whose owner is a listed operator is still a token, and is refused.
        ["operator-owned MCP token", w.token.token, { PX_PLATFORM_OPERATORS: w.alice.userId }],
      ] as const) {
        const res = await hit(method, target, bearer, env ? { env } : {});
        if (res.status !== 403) flag(method, path, "ADMIN_ROUTES", `${who}: status ${res.status}, expected 403`);
      }
      count("ADMIN_OPERATOR");
      const res = await hit(method, target, w.operator.token, { env: { PX_PLATFORM_OPERATORS: w.operator.userId } });
      if (res.status === 401 || res.status === 403)
        flag(method, path, "ADMIN_OPERATOR", `status ${res.status}, expected allowed`);
      continue;
    }
  }

  // BODY_ORG_B: Alice creates a project naming org B (body, query or header): 403 and nothing created.
  for (const where of ["body", "query", "header"] as const) {
    count("BODY_ORG_B");
    const slug = slugOf("cpa-bodyb");
    const res = await hit("POST", where === "query" ? `/api/projects?orgId=${w.bob.orgId}` : "/api/projects", w.alice.token, {
      body: { project: slug, ...(where === "body" ? { orgId: w.bob.orgId } : {}) },
      ...(where === "header" ? { headers: { "x-org-id": w.bob.orgId } } : {}),
    });
    if (res.status !== 403) flag("POST", "/api/projects", "BODY_ORG_B", `${where}: status ${res.status}, expected 403`);
    if ((await rowOrg(slug)) !== null) flag("POST", "/api/projects", "BODY_ORG_B", `${where}: a project was created`);
  }
  // ...and a promote naming org B in its body acts on org A's own project only, never on org B.
  {
    count("BODY_ORG_B");
    const route = "/api/projects/:project/environments/:envName/promote";
    const before = await fingerprint(w.pb, w.bob.orgId);
    const res = await hit("POST", `/api/projects/${w.p1}/environments/production/promote`, w.alice.token, {
      body: { orgId: w.bob.orgId },
    });
    if (res.status === 403 && /FORBIDDEN_ORG/.test(res.text)) flag("POST", route, "BODY_ORG_B", "the body org was used");
    if ((await fingerprint(w.pb, w.bob.orgId)) !== before) flag("POST", route, "BODY_ORG_B", "org B state changed");
  }

  // LIST_TOKEN: token(A, P1) lists only P1, whatever org it names.
  for (const suffix of ["", `?orgId=${w.bob.orgId}`, `?orgId=${w.alice.orgId}`]) {
    count("LIST_TOKEN");
    const res = await hit("GET", `/api/projects${suffix}`, w.token.token, { headers: { "x-org-id": w.bob.orgId } });
    const listed =
      res.status === 200
        ? (JSON.parse(res.text) as { projects: Array<{ project: string }> }).projects.map((p) => p.project)
        : null;
    if (JSON.stringify(listed) !== JSON.stringify([w.p1]))
      flag(
        "GET",
        "/api/projects",
        "LIST_TOKEN",
        `${suffix || "(no org)"}: status ${res.status}, listed ${JSON.stringify(listed)}, expected [P1]`,
      );
  }
  // LIST_SESSION: Dana (orgs A and B) selecting A sees only A's projects; an org the caller is not in is 403.
  {
    type Listed = { projects: Array<{ project: string; orgId: string }> };
    count("LIST_SESSION");
    const res = await hit("GET", `/api/projects?orgId=${w.alice.orgId}`, w.dana.token);
    const listed = res.status === 200 ? (JSON.parse(res.text) as Listed).projects : [];
    if (res.status !== 200) flag("GET", "/api/projects", "LIST_SESSION", `status ${res.status}, expected 200`);
    if (listed.some((p) => p.orgId !== w.alice.orgId))
      flag("GET", "/api/projects", "LIST_SESSION", "listed a project of another org");
    if (!listed.some((p) => p.project === w.p1)) flag("GET", "/api/projects", "LIST_SESSION", "org A's project missing");

    count("LIST_SESSION");
    const viaHeader = await hit("GET", "/api/projects", w.dana.token, { headers: { "x-org-id": w.alice.orgId } });
    const headerListed = viaHeader.status === 200 ? (JSON.parse(viaHeader.text) as Listed).projects : [];
    if (headerListed.some((p) => p.orgId !== w.alice.orgId))
      flag("GET", "/api/projects", "LIST_SESSION", "x-org-id A listed another org's project");

    count("LIST_SESSION");
    const all = await hit("GET", "/api/projects", w.alice.token);
    const allListed = all.status === 200 ? (JSON.parse(all.text) as Listed).projects : [];
    if (allListed.some((p) => p.orgId !== w.alice.orgId))
      flag("GET", "/api/projects", "LIST_SESSION", "Alice's unfiltered list includes another org's project");

    count("LIST_SESSION");
    const foreign = await hit("GET", `/api/projects?orgId=${w.bob.orgId}`, w.alice.token);
    if (foreign.status !== 403)
      flag("GET", "/api/projects", "LIST_SESSION", `non-member org: status ${foreign.status}, expected 403`);
  }

  // CONN_DEFAULT: a connection stored under the 'default' project is never one of P1's.
  {
    const defaultRef = `conn_default_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const envDb = studioEnv.DB ?? studioEnv.STUDIO_DB;
    await envDb
      .prepare(
        `INSERT INTO px_connections (ref, project_id, env_name, workspace_id, app, auth_type, label, scopes_json,
           ciphertext_b64, iv_b64, key_hint, status, updated_at)
         VALUES (?, 'default', 'preview', 'default', 'slack', 'apiKey', 'DEFAULT-CONN-MARKER', '[]', 'AAAA', 'AAAA', 'hint', 'connected', ?)`,
      )
      .bind(defaultRef, new Date().toISOString())
      .run();
    for (const route of ["/api/projects/:project/connections", "/api/projects/:project/secrets"]) {
      count("CONN_DEFAULT");
      const res = await hit("GET", materialize(route, { project: w.p1 }), w.alice.token);
      if (res.status !== 200) flag("GET", route, "CONN_DEFAULT", `status ${res.status}, expected 200`);
      if (res.text.includes(defaultRef) || res.text.includes("DEFAULT-CONN-MARKER"))
        flag("GET", route, "CONN_DEFAULT", "P1's answer includes the 'default' project's connection");
    }
  }

  // CONN_REF_OTHER: Alice deletes / updates / tests Bob's connection ref through her own project: 404, row unchanged.
  for (const [method, route] of [
    ["DELETE", "/api/projects/:project/connections/:ref"],
    ["POST", "/api/projects/:project/connections/:ref/reauthorize"],
    ["POST", "/api/projects/:project/connections/:ref/test"],
    ["DELETE", "/api/projects/:project/secrets/:ref"],
  ] as const) {
    count("CONN_REF_OTHER");
    const before = await pxRow(w.connB);
    const res = await hit(method, materialize(route, { project: w.p1, ref: w.connB }), w.alice.token, {
      body: { value: "xox" + "b-hijacked-value-123456", app: "slack", authType: "apiKey" },
    });
    const after = await pxRow(w.connB);
    if (before === "null") flag(method, route, "CONN_REF_OTHER", "fixture: Bob's connection row is missing");
    if (before !== after) flag(method, route, "CONN_REF_OTHER", "Bob's connection row changed");
    if (res.status !== 404)
      flag(method, route, "CONN_REF_OTHER", `status ${res.status}, expected 404`);
  }
  // ...and creating a connection under a ref another project holds is refused (409), never an overwrite.
  {
    count("CONN_REF_OTHER");
    const route = "/api/projects/:project/connections";
    const before = await pxRow(w.connB);
    const res = await hit("POST", `/api/projects/${w.p1}/connections`, w.alice.token, {
      body: { ref: w.connB, app: "slack", authType: "apiKey", value: "xox" + "b-hijacked-value-123456" },
    });
    if (res.status !== 409) flag("POST", route, "CONN_REF_OTHER", `status ${res.status}, expected 409`);
    if ((await pxRow(w.connB)) !== before) flag("POST", route, "CONN_REF_OTHER", "Bob's connection row changed");
  }

  // GLOBAL_HEALTH_RESET: the health reset stays operator-only (since story 1.4 it deletes only the project's own rows).
  // Alice (owner of P1) is refused, and another project's health rows survive; a platform operator may reset.
  {
    count("GLOBAL_HEALTH_RESET");
    const route = "/api/projects/:project/environments/:envName/health/seed";
    const marker = `/cpa-health-${crypto.randomUUID().slice(0, 8)}`;
    await studioEnv.STUDIO_DB.prepare(
      "INSERT INTO px_http_rollups (bucket_minute, route_prefix, brick_id, env_name, workspace_id, project_id) VALUES (?, ?, 'runtime', 'preview', 'ws_default', ?)",
    )
      .bind(new Date().toISOString().slice(0, 16), marker, w.pb)
      .run();
    const survives = async () =>
      (await studioEnv.STUDIO_DB.prepare("SELECT COUNT(*) AS n FROM px_http_rollups WHERE route_prefix = ?")
        .bind(marker)
        .first<{ n: number }>())!.n > 0;
    for (const bearer of [w.alice.token, w.token.token]) {
      const res = await hit("POST", `/api/projects/${w.p1}/environments/preview/health/seed`, bearer, {
        body: { reset: true },
      });
      if (res.status !== 403) flag("POST", route, "GLOBAL_HEALTH_RESET", `status ${res.status}, expected 403`);
      if (!(await survives())) flag("POST", route, "GLOBAL_HEALTH_RESET", "another project's health rows were wiped");
    }
  }

  // GLOBAL_RUN_PRUNE: runs/prune is global by design (retention spans every org). Alice is refused and an expired run of
  // another org survives.
  {
    count("GLOBAL_RUN_PRUNE");
    const route = "/api/projects/:project/runs/prune";
    const runId = `run_cpa_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await studioEnv.STUDIO_DB.prepare(
      `INSERT INTO px_runs (run_id, workflow_id, workspace_id, project_id, status, started_at, ended_at) VALUES (?, 'wf_other_org', 'ws_default', ?, 'succeeded', ?, ?)`,
    )
      .bind(runId, w.pb, "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:01.000Z")
      .run();
    for (const bearer of [w.alice.token, w.token.token]) {
      const res = await hit("POST", `/api/projects/${w.p1}/runs/prune`, bearer, { body: { retentionDays: 1 } });
      if (res.status !== 403) flag("POST", route, "GLOBAL_RUN_PRUNE", `status ${res.status}, expected 403`);
      const row = await studioEnv.STUDIO_DB.prepare("SELECT run_id FROM px_runs WHERE run_id = ?").bind(runId).first();
      if (!row) flag("POST", route, "GLOBAL_RUN_PRUNE", "another org's run was pruned");
    }
  }

  // Story 1.4: telemetry keyed by project (TELEMETRY_CROSS_RUN, TELEMETRY_CROSS_RERUN, TELEMETRY_LISTS, WEBHOOK_PROJECT).
  {
    const db = studioEnv.STUDIO_DB;
    const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const pbMarker = `TEL-PB-${tag}`;
    const p1Marker = `TEL-P1-${tag}`;
    const pbRun = `run_pb_${tag}`;
    const p1Run = `run_p1_${tag}`;
    // The same workspace in both projects: only the project keeps their telemetry apart.
    const ws = "ws_default";
    const now = new Date().toISOString();
    for (const [project, runId, marker] of [
      [w.pb, pbRun, pbMarker],
      [w.p1, p1Run, p1Marker],
    ] as const) {
      const stamp = { projectId: project };
      await upsertRunRecord(
        db,
        { runId, workflowId: `wf_${marker}`, revision: 0, triggerType: "manual", workspaceId: ws, status: "failed", durationMs: 1, retries: 0, errorStack: `Error: ${marker}`, startedAt: now, endedAt: now },
        stamp,
      );
      await insertStepEvent(
        db,
        { eventId: `${runId}:n1:failed:1`, runId, workflowId: `wf_${marker}`, revision: 0, workspaceId: ws, nodeId: "n1", status: "failed", durationMs: 1, retries: 0, inputPreview: JSON.stringify({ marker }), outputPreview: "{}", errorStack: `Error: ${marker}`, createdAt: now },
        stamp,
      );
      await insertStructuredLog(db, { level: "error", message: `log ${marker}`, runId, workspaceId: ws, envName: "preview" }, {}, stamp);
      await upsertHttpRollup(db, { workspaceId: ws, bucketMinute: now, routePrefix: `/${marker}`, brickId: `brick_${marker}`, requestCount: 2, error5xxCount: 1, envName: "preview" }, stamp);
      await upsertQueueMetrics(db, { workspaceId: ws, queueName: `queue_${marker}`, depth: 3, dlqCount: 1, envName: "preview" }, stamp);
    }
    // P1's and PB's data and ledger rows, each in its project's own data store (the active sandbox database that
    // resolveProjectDataStore reads), under the same workspace.
    for (const [project, orgId, marker] of [
      [w.p1, w.alice.orgId, p1Marker],
      [w.pb, w.bob.orgId, pbMarker],
    ] as const) {
      const store = await activateTestSandbox(db, { project, orgId });
      await store.rawD1.batch([
        store.rawD1.prepare("CREATE TABLE IF NOT EXISTS cpa_items (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, label TEXT)"),
        store.rawD1
          .prepare(
            "CREATE TABLE IF NOT EXISTS credit_ledger (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL, metadata TEXT, idempotency_key TEXT, created_at TEXT NOT NULL)",
          ),
        store.rawD1.prepare("CREATE TABLE IF NOT EXISTS credit_wallets (workspace_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"),
        store.rawD1.prepare("INSERT INTO cpa_items (id, workspace_id, label) VALUES (?, ?, ?)").bind(`item_${marker}`, ws, marker),
        store.rawD1
          .prepare(
            "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, idempotency_key, created_at) VALUES (?, ?, 'u', 'topup', 10, 10, ?, ?, ?)",
          )
          .bind(`led_${marker}`, ws, `reason ${marker}`, `idem_${marker}`, now),
        store.rawD1.prepare("INSERT OR REPLACE INTO credit_wallets (workspace_id, balance, created_at) VALUES (?, 10, ?)").bind(ws, now),
      ]);
    }
    // Test Step's input falls back to the last recorded output of the upstream node: that read is this project's only.
    // P1 and PB both have a run of the same workflow and node ids; PB's is the newer one.
    const sharedWf = `wf_shared_${tag}`;
    for (const [project, marker] of [
      [w.p1, p1Marker],
      [w.pb, pbMarker],
    ] as const) {
      await insertStepEvent(
        db,
        { eventId: `ev_up_${marker}`, runId: `run_up_${marker}`, workflowId: sharedWf, revision: 0, workspaceId: ws, nodeId: "n_up", status: "succeeded", durationMs: 1, retries: 0, inputPreview: "{}", outputPreview: JSON.stringify({ out: { upstream: marker } }), errorStack: null, createdAt: now },
        { projectId: project },
      );
    }
    const addWf = await hit("POST", `/api/projects/${w.p1}/ops`, w.alice.token, {
      body: {
        ops: [
          {
            opId: `op-wf-${tag}`,
            type: "add_workflow",
            workflow: {
              id: sharedWf,
              name: "Shared ids",
              trigger: "core.webhook",
              nodes: [
                { id: "n_up", type: "core.webhook", label: "Up", data: { path: "/up", method: "post" } },
                { id: "n_down", type: "core.noop", label: "Down", data: {} },
              ],
              edges: [{ id: "e1", source: "n_up", sourceHandle: "out", target: "n_down", targetHandle: "in" }],
            },
          },
        ],
      },
    });
    if (addWf.status !== 200) flag("POST", "/api/projects/:project/ops", "TELEMETRY_LISTS", `fixture: add_workflow status ${addWf.status}`);

    const callers = [
      ["session", w.alice.token],
      ["P1 token", w.token.token],
    ] as const;
    const startedFrom = async (sourceRunId: string) =>
      Number(
        (await db.prepare("SELECT COUNT(*) AS c FROM px_runs WHERE retry_of_run_id = ?").bind(sourceRunId).first<{ c: number }>())?.c ?? 0,
      );

    for (const [who, bearer] of callers) {
      // TELEMETRY_CROSS_RUN
      count("TELEMETRY_CROSS_RUN");
      const route = "/api/projects/:project/runs/:runId";
      const detail = await hit("GET", `/api/projects/${w.p1}/runs/${pbRun}`, bearer);
      if (detail.status !== 404 || !/RUN_NOT_FOUND/.test(detail.text))
        flag("GET", route, "TELEMETRY_CROSS_RUN", `${who}: status ${detail.status}, expected 404 RUN_NOT_FOUND`);
      // (The 404 message echoes the id the caller sent; PB's run data is what must not appear.)
      if (leaks(detail.text, pbMarker)) flag("GET", route, "TELEMETRY_CROSS_RUN", `${who}: answer contains PB's run`);
      const own = await hit("GET", `/api/projects/${w.p1}/runs/${p1Run}`, bearer);
      if (own.status !== 200 || !own.text.includes(p1Marker))
        flag("GET", route, "TELEMETRY_CROSS_RUN", `${who}: fixture: P1's own run not readable (status ${own.status})`);

      // TELEMETRY_CROSS_RERUN
      count("TELEMETRY_CROSS_RERUN");
      const rerunRoute = "/api/projects/:project/runs/:runId/rerun";
      const before = await fingerprint(w.pb, w.bob.orgId);
      const rerun = await hit("POST", `/api/projects/${w.p1}/runs/${pbRun}/rerun`, bearer, { body: { fromNodeId: "n1" } });
      if (rerun.status !== 404) flag("POST", rerunRoute, "TELEMETRY_CROSS_RERUN", `${who}: status ${rerun.status}, expected 404`);
      if (leaks(rerun.text, pbMarker)) flag("POST", rerunRoute, "TELEMETRY_CROSS_RERUN", `${who}: answer contains PB's run`);
      if ((await startedFrom(pbRun)) !== 0) flag("POST", rerunRoute, "TELEMETRY_CROSS_RERUN", `${who}: a run was started from PB's run`);
      if ((await fingerprint(w.pb, w.bob.orgId)) !== before) flag("POST", rerunRoute, "TELEMETRY_CROSS_RERUN", `${who}: PB state changed`);

      // TELEMETRY_LISTS: every telemetry read of P1, with and without naming the shared workspace or PB's run id.
      for (const [listRoute, path, mustShowP1] of [
        ["/api/projects/:project/runs", `/api/projects/${w.p1}/runs?limit=200`, true],
        ["/api/projects/:project/runs", `/api/projects/${w.p1}/runs?workspaceId=${ws}&limit=200`, true],
        ["/api/projects/:project/telemetry/events", `/api/projects/${w.p1}/telemetry/events?limit=500`, true],
        ["/api/projects/:project/telemetry/events", `/api/projects/${w.p1}/telemetry/events?runId=${pbRun}`, false],
        ["/api/projects/:project/environments/:envName/logs", `/api/projects/${w.p1}/environments/preview/logs?limit=500`, true],
        ["/api/projects/:project/environments/:envName/logs", `/api/projects/${w.p1}/environments/preview/logs?workspaceId=all&runId=${pbRun}`, false],
        ["/api/projects/:project/environments/:envName/data/logs", `/api/projects/${w.p1}/environments/preview/data/logs?workspaceId=${ws}`, true],
        ["/api/projects/:project/environments/:envName/health", `/api/projects/${w.p1}/environments/preview/health?window=24h`, true],
        ["/api/projects/:project/environments/:envName/metrics", `/api/projects/${w.p1}/environments/preview/metrics?window=24h&workspaceId=${ws}`, true],
        ["/api/projects/:project/activity", `/api/projects/${w.p1}/activity`, true],
        ["/api/projects/:project/environments/:envName/data/tables", `/api/projects/${w.p1}/environments/preview/data/tables?workspaceId=${ws}`, false],
        ["/api/projects/:project/environments/:envName/data/tables/:tableName/rows", `/api/projects/${w.p1}/environments/preview/data/tables/cpa_items/rows?workspaceId=${ws}`, true],
        ["/api/projects/:project/environments/:envName/data/ledger", `/api/projects/${w.p1}/environments/preview/data/ledger?workspaceId=${ws}`, true],
      ] as const) {
        count("TELEMETRY_LISTS");
        const res = await hit("GET", path, bearer);
        if (leaks(res.text.split(path).join(""), pbMarker, pbRun))
          flag("GET", listRoute, "TELEMETRY_LISTS", `${who}: ${path} contains PB's telemetry`);
        if (mustShowP1 && (res.status !== 200 || !(res.text.includes(p1Marker) || res.text.includes(p1Run))))
          flag("GET", listRoute, "TELEMETRY_LISTS", `${who}: fixture: ${path} does not show P1's own rows (status ${res.status})`);
      }
    }

    // TELEMETRY_LISTS (Test Step): the upstream input it reads is P1's last output, never PB's newer one.
    {
      count("TELEMETRY_LISTS");
      const route = "/api/projects/:project/workflows/:workflowId/nodes/:nodeId/test-step";
      const res = await hit("POST", `/api/projects/${w.p1}/workflows/${sharedWf}/nodes/n_down/test-step`, w.alice.token, { body: {} });
      if (leaks(res.text, pbMarker)) flag("POST", route, "TELEMETRY_LISTS", "Test Step read PB's upstream output");
      if (res.status !== 200 || !res.text.includes(p1Marker))
        flag("POST", route, "TELEMETRY_LISTS", `fixture: Test Step did not use P1's own upstream output (status ${res.status})`);
    }

    // RECONCILE_TARGET: Studio signs the pull, so it never goes to a caller-chosen address. Story 1.17: reconcile accepts
    // any valid tenant workspace id, so P1 now has a registered deploy target and reconciles PB's workspace id. The pull
    // goes only to P1's own target, and whatever comes back naming ids PB holds is refused (409 ID_COLLISION): nothing is
    // written, and P1's reads of that workspace show none of PB's rows.
    {
      const route = "/api/projects/:project/telemetry/reconcile";
      const pbOnlyWs = `ws_pb_only_${tag}`;
      const pbRunId = `run_pbws_${tag}`;
      const pbRunMarker = `PB-RECONCILE-MARKER-${tag}`;
      const pbRun = { runId: pbRunId, workflowId: "wf_pbws", revision: 0, triggerType: "manual", workspaceId: pbOnlyWs, status: "succeeded" as const, durationMs: 1, retries: 0, errorStack: pbRunMarker, startedAt: now };
      await upsertRunRecord(db, pbRun, { projectId: w.pb });
      const p1Target = `https://p1-target-${tag}.example`;
      await db
        .prepare(
          `INSERT INTO project_deployments (deploy_id, project_id, org_id, env_name, revision, build_hash, code_hash, graph_hash, action, worker_url, version_id, database_id, actor_id, state_json, created_at)
           VALUES (?, ?, ?, 'preview', 1, 'b', 'c', 'g', 'deploy', ?, 'v', 'd', 'a', '{}', ?)`,
        )
        .bind(`dep_${crypto.randomUUID()}`, w.p1, w.alice.orgId, p1Target, now)
        .run();
      const p1Rows = async () =>
        Number((await db.prepare("SELECT COUNT(*) AS c FROM px_runs WHERE project_id = ?").bind(w.p1).first<{ c: number }>())?.c ?? 0);
      const pulledFrom: string[] = [];
      const realFetch = globalThis.fetch;
      // P1's target answers with PB's run (as a compromised or confused worker might): its id is PB's.
      globalThis.fetch = (async (input: string | URL | Request) => {
        pulledFrom.push(String(input instanceof Request ? input.url : input));
        return Response.json({ runs: [pbRun], events: [] });
      }) as typeof fetch;
      try {
        for (const [label, body] of [
          ["body workerUrl", { workspaceId: ws, workerUrl: "https://attacker.example" }],
          ["PB's workspace", { workspaceId: pbOnlyWs }],
        ] as const) {
          count("RECONCILE_TARGET");
          const before = await p1Rows();
          const res = await hit("POST", `/api/projects/${w.p1}/telemetry/reconcile`, w.alice.token, { body });
          if (isOk(res.status)) flag("POST", route, "RECONCILE_TARGET", `${label}: status ${res.status}, expected a refusal`);
          if (label === "PB's workspace" && (res.status !== 409 || !/ID_COLLISION/.test(res.text)))
            flag("POST", route, "RECONCILE_TARGET", `${label}: status ${res.status}, expected 409 ID_COLLISION`);
          if ((await p1Rows()) !== before) flag("POST", route, "RECONCILE_TARGET", `${label}: rows were written`);
        }
      } finally {
        globalThis.fetch = realFetch;
      }
      if (pulledFrom.length !== 1 || !pulledFrom[0]!.startsWith(`${p1Target}/__px/events?workspaceId=${pbOnlyWs}`))
        flag("POST", route, "RECONCILE_TARGET", `the pull did not go (only) to P1's own target: ${JSON.stringify(pulledFrom)}`);
      const owner = await db.prepare("SELECT project_id FROM px_runs WHERE run_id = ?").bind(pbRunId).first<{ project_id: string }>();
      if (owner?.project_id !== w.pb) flag("POST", route, "RECONCILE_TARGET", "PB's run changed project");
      const p1View = await hit("GET", `/api/projects/${w.p1}/runs?workspaceId=${pbOnlyWs}&limit=200`, w.alice.token);
      if (p1View.text.includes(pbRunId) || p1View.text.includes(pbRunMarker))
        flag("GET", "/api/projects/:project/runs", "RECONCILE_TARGET", "P1's read of PB's workspace shows PB's run");
    }

    // WEBHOOK_PROJECT: a correctly signed payload posted to P1's URL that names PB (or no project) writes nothing.
    {
      const route = "/api/projects/:project/telemetry/webhook";
      const secret = await deriveProjectTelemetrySecret(studioEnv.PX_TELEMETRY_SECRET!, w.p1);
      const runId = `run_wh_${tag}`;
      const payload = (project?: string) =>
        JSON.stringify({
          ...(project ? { project } : {}),
          run: { runId, workflowId: "wf_wh", revision: 0, triggerType: "manual", workspaceId: ws, status: "succeeded", durationMs: 1, retries: 0, startedAt: now },
          events: [],
        });
      for (const [label, body, project] of [
        ["names PB", payload(w.pb), w.p1],
        ["names no project", payload(), w.p1],
      ] as const) {
        count("WEBHOOK_PROJECT");
        const res = await app.request(
          `/api/projects/${project}/telemetry/webhook`,
          {
            method: "POST",
            headers: { "content-type": "application/json", [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryWebhook(body, secret) },
            body,
          },
          studioEnv,
        );
        // Story 1.17: correctly signed (webhook domain, P1's derived secret), so the refusal is the project check's 400.
        if (res.status !== 400) flag("POST", route, "WEBHOOK_PROJECT", `${label}: status ${res.status}, expected 400`);
        const written = await db.prepare("SELECT COUNT(*) AS c FROM px_runs WHERE run_id = ?").bind(runId).first<{ c: number }>();
        if (Number(written?.c ?? 0) !== 0) flag("POST", route, "WEBHOOK_PROJECT", `${label}: a run was written`);
      }
      // A body naming PB, signed with P1's derived secret, posted to PB's URL: P1's key does not sign for PB.
      count("WEBHOOK_PROJECT");
      const forPb = payload(w.pb);
      const res = await app.request(
        `/api/projects/${w.pb}/telemetry/webhook`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryWebhook(forPb, secret) },
          body: forPb,
        },
        studioEnv,
      );
      if (res.status !== 401) flag("POST", route, "WEBHOOK_PROJECT", `P1-signed on PB's URL: status ${res.status}, expected 401`);
      const written = await db.prepare("SELECT COUNT(*) AS c FROM px_runs WHERE run_id = ?").bind(runId).first<{ c: number }>();
      if (Number(written?.c ?? 0) !== 0) flag("POST", route, "WEBHOOK_PROJECT", "P1-signed on PB's URL: a run was written");
    }
  }

  // SEED_CONTROL_PLANE: Alice may not seed control-plane tables or run raw DDL (story 17: data/seed now writes only to
  // the project's own data store, but the guards still refuse these before any store lookup).
  {
    const route = "/api/projects/:project/environments/:envName/data/seed";
    const snapshot = async () =>
      JSON.stringify([
        (await studioEnv.STUDIO_DB.prepare("SELECT * FROM studio_org_members WHERE org_id = ? ORDER BY user_id")
          .bind(w.bob.orgId)
          .all()).results,
        (await studioEnv.STUDIO_DB.prepare("SELECT * FROM projects WHERE project_id = ?").bind(w.pb).first()),
      ]);
    for (const [label, body] of [
      ["studio_org_members", { tables: { studio_org_members: [{ org_id: w.bob.orgId, user_id: w.alice.userId, role: "owner", created_at: "2026-01-01" }] } }],
      ["projects", { tables: { projects: [{ project_id: w.pb, org_id: w.alice.orgId, current_revision: 0, semantic_hash: "x", updated_at: "2026-01-01" }] } }],
      ["rows[] into projects", { rows: [{ table: "projects", values: { project_id: w.pb, org_id: w.alice.orgId, current_revision: 0, semantic_hash: "x" } }] }],
      ["raw ddl", { ddl: ["DROP TABLE IF EXISTS studio_org_members_shadow"] }],
    ] as const) {
      count("SEED_CONTROL_PLANE");
      const before = await snapshot();
      const res = await hit("POST", `/api/projects/${w.p1}/environments/preview/data/seed`, w.alice.token, {
        body: body as Record<string, unknown>,
      });
      if (res.status !== 400 && res.status !== 403)
        flag("POST", route, "SEED_CONTROL_PLANE", `${label}: status ${res.status}, expected 400/403`);
      if ((await snapshot()) !== before) flag("POST", route, "SEED_CONTROL_PLANE", `${label}: control-plane rows changed`);
    }
  }

  return { violations, cases };
}

describe("control-plane attack suite: every studio-api route (story 16)", () => {
  beforeAll(async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const alice = await signUp("r-alice");
    const bob = await signUp("r-bob");
    const viewer = await signUp("r-viewer");
    const dana = await signUp("r-dana");
    const operator = await signUp("r-operator");
    const p1 = `cpr-p1-${suffix}`;
    const p2 = `cpr-p2-${suffix}`;
    const pb = `cpr-pb-${suffix}`;
    const pv = `cpr-pv-${suffix}`;
    const markers = {
      p1: `MARKER-RP1-${suffix}`,
      p2: `MARKER-RP2-${suffix}`,
      pb: `MARKER-RPB-${suffix}`,
      pv: `MARKER-RPV-${suffix}`,
    };
    await createProject(alice, p1, markers.p1);
    await createProject(alice, p2, markers.p2);
    await createProject(alice, pv, markers.pv);
    await createProject(bob, pb, markers.pb);
    await addMember(alice.orgId, viewer.userId, "viewer");
    await addMember(alice.orgId, dana.userId, "builder");
    await addMember(bob.orgId, dana.userId, "builder");
    const connA = `conn_ra_${suffix}`;
    const connB = `conn_rb_${suffix}`;
    await seedConnection(alice, p1, connA);
    await seedConnection(bob, pb, connB);
    const token = await issueToken(alice, p1, ["read", "edit", "deploy", "connect"]);
    rw = { alice, bob, viewer, dana, operator, p1, p2, pb, pv, markers, token, connA, connB };
  }, 120_000);

  test("the route list is the app's own: every registered route is enumerated once, with no middleware entries", () => {
    const routes = enumerateRoutes();
    expect(routes.length).toBeGreaterThan(80);
    expect(routes.some((r) => r.method === "ALL")).toBe(false);
    expect(new Set(routes.map((r) => `${r.method} ${r.path}`)).size).toBe(routes.length);
    for (const attack of ROUTE_MATRIX_ATTACKS) expect(ALL_ATTACKS, attack).toContain(attack);
  });

  test(
    "every studio-api route under every applicable matrix class: 0 failures against the registry",
    async () => {
      const { violations, cases } = await runRouteMatrix();
      const problems = describeComparison(compareWithRegistry(violations, registry), REGISTRY_FILE);
      const routes = enumerateRoutes().filter((r) => !isPublicRoute(r.method, r.path));
      const projectRoutes = routes.filter((r) => isProjectRoute(r.path));
      // Coverage: each class ran once for every route it applies to.
      expect(cases.get("UNAUTH")).toBe(routes.length);
      expect(cases.get("PROJECT_B")).toBe(projectRoutes.length);
      expect(cases.get("TOKEN_OTHER_ORG")).toBe(projectRoutes.length);
      expect(cases.get("TOKEN_OTHER_PROJECT")).toBe(projectRoutes.length);
      expect(cases.get("ORG_HEADER_B")).toBe(projectRoutes.length);
      expect(cases.get("CLAIM_UNOWNED")).toBe(projectRoutes.filter((r) => isWrite(r.method)).length);
      expect(cases.get("VIEWER_MUTATE")).toBe(projectRoutes.filter((r) => isWrite(r.method)).length);
      expect(cases.get("READ_UNKNOWN")).toBe(projectRoutes.filter((r) => !isWrite(r.method)).length);
      expect(cases.get("ORG_B")).toBe(routes.filter((r) => isOrgRoute(r.path)).length);
      expect(cases.get("TOKEN_ORG_ROUTE")).toBe(routes.filter((r) => isOrgRoute(r.path)).length);
      expect(cases.get("ADMIN_ROUTES")).toBe(4);
      expect(cases.get("ADMIN_OPERATOR")).toBe(4);
      for (const attack of ROUTE_MATRIX_ATTACKS) expect(cases.get(attack) ?? 0, attack).toBeGreaterThan(0);
      expect(problems, problems.join("\n")).toEqual([]);
    },
    900_000,
  );
});
