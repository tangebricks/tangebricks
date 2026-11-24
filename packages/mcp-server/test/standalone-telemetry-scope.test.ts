import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_mcp_server.sql?raw";
import { createMcpApp } from "../src/index.ts";
import type { StudioRequestFn } from "../src/index.ts";
import { testToken, testTokenVerifier } from "./support/test-verifier.ts";

// Story 1.4: the MCP server's standalone telemetry (no Studio configured) is keyed by project. A token pinned to PA never
// sees PB's runs, traces or logs, and a Studio error is returned as the error, never answered from the local tables.

const db = env.DB as D1Like;
const PA = "standalone-pa";
const PB = "standalone-pb";

async function callTool(name: string, args: Record<string, unknown>, studioRequest?: StudioRequestFn) {
  const app = createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier, ...(studioRequest ? { studioRequest } : {}) });
  const res = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${testToken(String(args.project))}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    { DB: db },
  );
  const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: body.result.content[0]!.text, isError: body.result.isError === true };
}

describe("standalone MCP telemetry is keyed by the token's project", () => {
  beforeAll(async () => {
    for (const table of ["mcp_files", "mcp_builds", "mcp_projects", "mcp_rate"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    await applyMigration(db, migration);
    for (const table of ["px_runs", "px_step_events", "px_logs"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    await callTool("list_runs", { project: PA }); // creates the standalone tables, with project_id
    for (const [project, marker] of [
      [PA, "MARK_PA"],
      [PB, "MARK_PB"],
      [null, "MARK_LEGACY"],
    ] as const) {
      const runId = `run_${marker}`;
      await db.batch([
        db
          .prepare(
            "INSERT INTO px_runs (run_id, workflow_id, status, started_at, output_json, project_id) VALUES (?, ?, 'failed', '2026-11-01T00:00:00.000Z', ?, ?)",
          )
          .bind(runId, `wf_${marker}`, JSON.stringify({ marker }), project),
        db
          .prepare(
            "INSERT INTO px_step_events (step_id, run_id, workflow_id, node_id, node_type, status, started_at, output_json, project_id) VALUES (?, ?, ?, 'n1', 'core.noop', 'succeeded', '2026-11-01T00:00:00.000Z', ?, ?)",
          )
          .bind(`step_${marker}`, runId, `wf_${marker}`, JSON.stringify({ marker }), project),
        db
          .prepare(
            "INSERT INTO px_logs (id, timestamp, level, message, run_id, workspace_id, px_env, project_id) VALUES (?, '2026-11-01T00:00:00.000Z', 'error', ?, ?, 'ws_shared', 'preview', ?)",
          )
          .bind(`log_${marker}`, `log ${marker}`, runId, project),
      ]);
    }
  });

  it("list_runs, get_run_trace and query_logs for PA never return PB's (or unattributed) rows", async () => {
    const runs = await callTool("list_runs", { project: PA });
    expect(runs.text).toContain("run_MARK_PA");
    expect(runs.text).not.toContain("MARK_PB");
    expect(runs.text).not.toContain("MARK_LEGACY");

    const ownTrace = await callTool("get_run_trace", { project: PA, runId: "run_MARK_PA" });
    expect(ownTrace.isError).toBe(false);
    expect(ownTrace.text).toContain("MARK_PA");
    const crossTrace = await callTool("get_run_trace", { project: PA, runId: "run_MARK_PB" });
    expect(crossTrace.isError).toBe(true);
    // (the refusal echoes the id that was asked for; PB's stored data must not appear)
    expect(crossTrace.text).not.toContain("wf_MARK_PB");
    expect(crossTrace.text).not.toContain('"marker"');

    const logs = await callTool("query_logs", { project: PA, workspaceId: "ws_shared" });
    expect(logs.text).toContain("MARK_PA");
    expect(logs.text).not.toContain("MARK_PB");
    expect(logs.text).not.toContain("MARK_LEGACY");
    const crossLogs = await callTool("query_logs", { project: PA, runId: "run_MARK_PB" });
    expect(crossLogs.text).not.toContain("log MARK_PB");
  });

  it("a Studio error is returned as the error; the local tables are never read instead", async () => {
    const failing: StudioRequestFn = async () =>
      new Response(JSON.stringify({ error: { code: "STUDIO_DOWN" } }), { status: 500, headers: { "content-type": "application/json" } });
    for (const [tool, args] of [
      ["list_runs", { project: PA }],
      ["get_run_trace", { project: PA, runId: "run_MARK_PA" }],
      ["query_logs", { project: PA }],
    ] as const) {
      const res = await callTool(tool, args, failing);
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toContain("STUDIO_DOWN");
      expect(res.text, tool).not.toContain("MARK_PA");
    }
  });

  it("standalone test_workflow without a verified workspace runs nothing", async () => {
    const before = await db.prepare("SELECT COUNT(*) AS c FROM px_runs").first<{ c: number }>();
    const res = await callTool("test_workflow", { project: PA, workflowId: "wf_missing" });
    expect(res.isError).toBe(true);
    const after = await db.prepare("SELECT COUNT(*) AS c FROM px_runs").first<{ c: number }>();
    expect(after?.c).toBe(before?.c);
  });
});
