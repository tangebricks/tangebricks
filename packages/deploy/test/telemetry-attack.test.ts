import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  SIGNED_AT_HEADER,
  TELEMETRY_SIGNATURE_HEADER,
  controlPlaneCanonical,
  ensureTelemetryTables,
  insertStepEvent,
  insertStructuredLog,
  signControlPlaneRequest,
  signTelemetryPayload,
  upsertHttpRollup,
  upsertQueueMetrics,
  upsertRunRecord,
} from "@poc/telemetry";
import { createProofRoutes } from "../src/worker/proof-routes.ts";

// Story 1.4 attack suite for the deployed Worker's read routes: /__px/events, /__px/logs, /__px/metrics and /__px/data/*.
// Every one of them takes only the control-plane signature made with PX_TELEMETRY_SECRET (method, path with the whole
// query, x-px-signed-at within 300 s, body). The shared access key, the old body-only / pathname-only signatures, a
// signature replayed with another workspace in the query and a stale signature are all refused; a valid request signed
// for workspace A never returns a row of workspace B.

const db = env.DB as D1Like;
const SECRET = "px_telemetry_attack_secret_0123456789";
const ACCESS_KEY = "poc_shared_access_key_0123456789abcd";
const WS_A = "ws_attack_a";
const WS_B = "ws_attack_b";
/** Every row seeded for workspace B carries this, so a leak shows up in any response body. */
const B_MARKER = "B_LEAK_MARKER";
const NOW = new Date().toISOString();

const workerEnv = {
  DB: db,
  PX_TELEMETRY_SECRET: SECRET,
  POC_ACCESS_KEY: ACCESS_KEY,
  PX_ENV: "preview",
  PX_DECLARED_ENTITIES: ["invoices"],
};

const routes = createProofRoutes();

async function call(url: URL, headers: Record<string, string>, init: { method?: string; body?: string } = {}, routeEnv = workerEnv) {
  const res = await routes(
    new Request(url.toString(), {
      method: init.method ?? "GET",
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
    routeEnv,
  );
  if (!res) throw new Error(`route not handled: ${url.pathname}`);
  return res;
}

/** The read routes, each for one workspace. */
const READ_ROUTES = [
  { name: "events", path: "/__px/events?after=0&limit=100" },
  { name: "logs", path: "/__px/logs?env=preview&limit=100" },
  { name: "metrics", path: "/__px/metrics?window=24h&env=preview" },
  { name: "data rows", path: "/__px/data/tables/invoices/rows?limit=100" },
  { name: "data ledger", path: "/__px/data/ledger?limit=100" },
  { name: "data tables", path: "/__px/data/tables" },
] as const;

const routeUrl = (path: string, workspaceId: string) => {
  const url = new URL(`http://deployed.invalid${path}`);
  url.searchParams.set("workspaceId", workspaceId);
  return url;
};

async function seedWorkspace(workspaceId: string, marker: string) {
  await upsertRunRecord(db, {
    runId: `run_${marker}`,
    workflowId: `wf_${marker}`,
    revision: 1,
    triggerType: "manual",
    workspaceId,
    status: "failed",
    durationMs: 5,
    retries: 0,
    errorStack: `Error: ${marker}`,
    startedAt: NOW,
    endedAt: NOW,
  });
  await insertStepEvent(db, {
    eventId: `run_${marker}:n:failed:1`,
    runId: `run_${marker}`,
    workflowId: `wf_${marker}`,
    revision: 1,
    workspaceId,
    nodeId: `node_${marker}`,
    status: "failed",
    durationMs: 5,
    retries: 0,
    inputPreview: JSON.stringify({ marker }),
    outputPreview: "{}",
    errorStack: `Error: ${marker}`,
    createdAt: NOW,
  });
  await insertStructuredLog(db, {
    level: "error",
    message: `log line ${marker}`,
    runId: `run_${marker}`,
    workspaceId,
    brickId: `brick_${marker}`,
    envName: "preview",
  });
  await upsertHttpRollup(db, {
    workspaceId,
    bucketMinute: NOW,
    routePrefix: `/route_${marker}`,
    brickId: `brick_${marker}`,
    requestCount: 3,
    error5xxCount: 1,
    envName: "preview",
  });
  await upsertQueueMetrics(db, { workspaceId, queueName: `queue_${marker}`, depth: 4, dlqCount: 1, updatedAt: NOW, envName: "preview" });
  await db
    .prepare("INSERT INTO ent_invoices (id, workspace_id, invoice_number, amount) VALUES (?1, ?2, ?3, ?4)")
    .bind(`inv_${marker}`, workspaceId, `INV_${marker}`, 100)
    .run();
  await db
    .prepare(
      "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount, balance_after, reason, idempotency_key, created_at) VALUES (?1, ?2, 'u', 'topup', 10, 10, ?3, ?4, ?5)",
    )
    .bind(`led_${marker}`, workspaceId, `reason_${marker}`, `idem_${marker}`, NOW)
    .run();
  await db.prepare("INSERT INTO credit_wallets (workspace_id, balance, created_at) VALUES (?1, 10, ?2)").bind(workspaceId, NOW).run();
}

describe("story 1.4 — deployed Worker telemetry and data routes: signing, workspace scope, replay", () => {
  beforeAll(async () => {
    await ensureTelemetryTables(db);
    await db.batch([
      db.prepare("DELETE FROM px_step_events"),
      db.prepare("DELETE FROM px_runs"),
      db.prepare("DELETE FROM px_logs"),
      db.prepare("DELETE FROM px_http_rollups"),
      db.prepare("DELETE FROM px_queue_metrics"),
      db.prepare("DROP TABLE IF EXISTS ent_invoices"),
      db.prepare("DROP TABLE IF EXISTS credit_ledger"),
      db.prepare("DROP TABLE IF EXISTS credit_wallets"),
      db.prepare(
        "CREATE TABLE ent_invoices (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, invoice_number TEXT NOT NULL, amount INTEGER NOT NULL)",
      ),
      db.prepare(
        "CREATE TABLE credit_ledger (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL, metadata TEXT, idempotency_key TEXT, created_at TEXT NOT NULL)",
      ),
      db.prepare("CREATE TABLE credit_wallets (workspace_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"),
    ]);
    await seedWorkspace(WS_A, "A_ROW_MARKER");
    await seedWorkspace(WS_B, B_MARKER);
  });

  for (const route of READ_ROUTES) {
    describe(`GET ${route.name}`, () => {
      it("WORKER_SHARED_KEY: the shared access key alone (or a signature made with it) is 401", async () => {
        const url = routeUrl(route.path, WS_A);
        expect((await call(url, { "x-poc-key": ACCESS_KEY })).status).toBe(401);
        expect((await call(url, { "x-poc-key": ACCESS_KEY, ...(await signControlPlaneRequest(ACCESS_KEY, "GET", url)) })).status).toBe(401);
      });

      it("WORKER_PATH_ONLY_SIG and legacy schemes: pathname-only, body-only, GET:<path?query> and query-less control-plane signatures are 401", async () => {
        const url = routeUrl(route.path, WS_A);
        const signedAt = String(Math.floor(Date.now() / 1000));
        const legacyPayloads = [
          url.pathname,
          `${url.pathname}${url.search}`,
          `GET:${url.pathname}${url.search}`,
          `GET ${url.pathname}${url.search}\n`,
          "",
        ];
        for (const payload of legacyPayloads) {
          const sig = await signTelemetryPayload(payload, SECRET);
          expect((await call(url, { [TELEMETRY_SIGNATURE_HEADER]: sig })).status).toBe(401);
          expect((await call(url, { [TELEMETRY_SIGNATURE_HEADER]: sig, [SIGNED_AT_HEADER]: signedAt })).status).toBe(401);
        }
        // The 1.1 canonical over the pathname alone (no query) does not cover the workspace, so it does not verify here.
        const pathOnly = await signTelemetryPayload(controlPlaneCanonical("GET", url.pathname, signedAt, ""), SECRET);
        expect((await call(url, { [TELEMETRY_SIGNATURE_HEADER]: pathOnly, [SIGNED_AT_HEADER]: signedAt })).status).toBe(401);
      });

      it("WORKER_QUERY_SWAP: a signature for workspaceId=A replayed with B is 401", async () => {
        const signedForA = await signControlPlaneRequest(SECRET, "GET", routeUrl(route.path, WS_A));
        const res = await call(routeUrl(route.path, WS_B), signedForA);
        expect(res.status).toBe(401);
        expect(await res.text()).not.toContain(B_MARKER);
        // Appending a second workspaceId to the signed query is a different query too.
        const appended = routeUrl(route.path, WS_A);
        appended.searchParams.append("workspaceId", WS_B);
        expect((await call(appended, signedForA)).status).toBe(401);
      });

      it("WORKER_STALE: a signature older (or newer) than 300 s is 401", async () => {
        const url = routeUrl(route.path, WS_A);
        expect((await call(url, await signControlPlaneRequest(SECRET, "GET", url, "", Date.now() - 301_000))).status).toBe(401);
        expect((await call(url, await signControlPlaneRequest(SECRET, "GET", url, "", Date.now() + 301_000))).status).toBe(401);
      });

      it("WORKER_SCOPED: a valid request signed for A returns A's rows and none of B's", async () => {
        const url = routeUrl(route.path, WS_A);
        const res = await call(url, await signControlPlaneRequest(SECRET, "GET", url));
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).not.toContain(B_MARKER);
        expect(text).not.toContain(WS_B);
        if (route.name !== "data tables") expect(text).toContain("A_ROW_MARKER");
      });
    });
  }

  it("a signed read that names no workspace is 400 WORKSPACE_ID_REQUIRED (events, logs, metrics, rows, ledger)", async () => {
    for (const route of READ_ROUTES.filter((r) => r.name !== "data tables")) {
      const url = new URL(`http://deployed.invalid${route.path}`);
      const res = await call(url, await signControlPlaneRequest(SECRET, "GET", url));
      expect(res.status, route.name).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code, route.name).toBe("WORKSPACE_ID_REQUIRED");
    }
  });

  it("GET /__px/data/tables without a workspace lists the schema only: no rows and no counts of any workspace", async () => {
    const url = new URL("http://deployed.invalid/__px/data/tables");
    const res = await call(url, await signControlPlaneRequest(SECRET, "GET", url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: Array<{ rowCount?: number }> };
    expect(body.tables.length).toBeGreaterThan(0);
    expect(body.tables.every((t) => t.rowCount === undefined)).toBe(true);
  });

  it("GET /__px/data/workspaces lists workspaces only to a signed caller", async () => {
    const url = new URL("http://deployed.invalid/__px/data/workspaces");
    expect((await call(url, { "x-poc-key": ACCESS_KEY })).status).toBe(401);
    expect((await call(url, { [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(url.pathname, SECRET) })).status).toBe(401);
    const res = await call(url, await signControlPlaneRequest(SECRET, "GET", url));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workspaces: string[] }).workspaces).toEqual(expect.arrayContaining([WS_A, WS_B]));
  });

  it("a data mutation's signature covers its body and query: a changed body or workspace is 401, a body naming another workspace is 400", async () => {
    const url = routeUrl("/__px/data/tables/invoices/rows", WS_A);
    const body = JSON.stringify({ confirmWrite: true, row: { id: "inv_new_A", invoice_number: "INV_NEW", amount: 1 } });
    const signed = await signControlPlaneRequest(SECRET, "POST", url, body);

    const tampered = body.replace("INV_NEW", "INV_EVIL");
    expect((await call(url, signed, { method: "POST", body: tampered })).status).toBe(401);
    expect((await call(routeUrl("/__px/data/tables/invoices/rows", WS_B), signed, { method: "POST", body })).status).toBe(401);
    // The old body-only signature is refused for writes too.
    expect((await call(url, { [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(body, SECRET) }, { method: "POST", body })).status).toBe(401);

    const crossBody = JSON.stringify({ workspaceId: WS_B, confirmWrite: true, row: { id: "inv_cross", invoice_number: "X", amount: 1 } });
    const crossRes = await call(url, await signControlPlaneRequest(SECRET, "POST", url, crossBody), { method: "POST", body: crossBody });
    expect(crossRes.status).toBe(400);
    expect(((await crossRes.json()) as { error: { code: string } }).error.code).toBe("WORKSPACE_MISMATCH");

    const ok = await call(url, signed, { method: "POST", body });
    expect(ok.status).toBe(201);
    const row = await db.prepare("SELECT workspace_id FROM ent_invoices WHERE id = 'inv_new_A'").first<{ workspace_id: string }>();
    expect(row?.workspace_id).toBe(WS_A);
    const cross = await db.prepare("SELECT COUNT(*) AS c FROM ent_invoices WHERE id = 'inv_cross'").first<{ c: number }>();
    expect(Number(cross?.c ?? 0)).toBe(0);
  });

  it("a deployment without PX_TELEMETRY_SECRET (only the shared key) reads nothing: 503 whatever the request carries", async () => {
    const keyOnlyEnv = { DB: db, POC_ACCESS_KEY: ACCESS_KEY, PX_ENV: "preview" };
    for (const route of READ_ROUTES) {
      const url = routeUrl(route.path, WS_A);
      const res = await call(url, { "x-poc-key": ACCESS_KEY, ...(await signControlPlaneRequest(ACCESS_KEY, "GET", url)) }, {}, keyOnlyEnv as typeof workerEnv);
      expect(res.status, route.name).toBe(503);
      expect(await res.text()).not.toContain(B_MARKER);
    }
    // A PX_TELEMETRY_SECRET equal to the access key is no signing secret either.
    const sameEnv = { ...workerEnv, PX_TELEMETRY_SECRET: ACCESS_KEY };
    const url = routeUrl("/__px/events?after=0&limit=10", WS_A);
    expect((await call(url, await signControlPlaneRequest(ACCESS_KEY, "GET", url), {}, sameEnv)).status).toBe(503);
  });
});
