// Story 0.20 (threat model B13): cron-alarms used the tenant-supplied `targetWorkflowId` as an env binding key, so a
// workspace admin could put any binding with `.create()` (another brick's Workflow) on a timer. Run against the
// assembled max-compatible app (the outermost surface) in workerd: the workspace owner names each of the app's own
// bindings, read from its wrangler config, as a schedule target. Every attempt must be refused with 400
// WORKFLOW_TARGET_NOT_ALLOWED and leave no row in cron_schedules or px_schedules, both with no CRON_WORKFLOW_TARGETS
// set (fail closed) and with an allowlist that names a different binding. The allowlisted name is still accepted.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { call, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

const entryLoaders = import.meta.glob("../../../out/max-compatible/src/index.ts") as Record<string, () => Promise<{ default: App }>>;
const app = (await Object.values(entryLoaders)[0]?.())?.default;
const sql = import.meta.glob("../../../out/max-compatible/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const wrangler = Object.values(
  import.meta.glob("../../../out/max-compatible/wrangler.jsonc", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0];
const db = env.DB as unknown as D1Like;

/** Every `"binding": "<name>"` the assembled app's wrangler config declares (D1, dispatch namespace, queues, ...). */
function appBindings(): string[] {
  return [...new Set([...(wrangler ?? "").matchAll(/"binding"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!))];
}

async function scheduleRows(ws: string): Promise<{ cron: number; px: number }> {
  const cron = await db.prepare("SELECT count(*) AS cnt FROM cron_schedules WHERE workspace_id = ?").bind(ws).first<{ cnt: number }>();
  const px = await db.prepare("SELECT count(*) AS cnt FROM px_schedules WHERE workspace_id = ?").bind(ws).first<{ cnt: number }>();
  return { cron: cron?.cnt ?? 0, px: px?.cnt ?? 0 };
}

describe("cron-alarms Workflow target allowlist on the assembled max-compatible app (story 0.20)", () => {
  test("a workspace owner cannot schedule one of the app's own bindings as a Workflow target", async () => {
    // test/support/global-setup.ts assembles out/max-compatible before the workers project runs.
    expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    const bindings = appBindings();
    expect(bindings, "bindings read from out/max-compatible/wrangler.jsonc").toContain("DB");
    await resetAndMigrate(db, sql);

    const created = await call(app!, "POST", "/api/workspaces", { user: "alice", body: { name: "Workspace A" } });
    expect(created.status).toBe(201);
    const wsA = (JSON.parse(created.text) as { workspace: { id: string } }).workspace.id;

    const allowlisted = { ...(env as unknown as Record<string, unknown>), CRON_WORKFLOW_TARGETS: "REPORTS_WF" };
    for (const [label, requestEnv] of [
      ["no CRON_WORKFLOW_TARGETS", undefined],
      ["CRON_WORKFLOW_TARGETS=REPORTS_WF", allowlisted],
    ] as const) {
      for (const target of [...bindings, "CRON_WORKFLOW_TARGETS", "GRAPH_RUNNER", "WORKFLOW"]) {
        const res = await call(app!, "POST", "/api/schedules", {
          user: "alice",
          ws: wsA,
          body: { cronExpression: "*/5 * * * *", targetWorkflowId: target },
          ...(requestEnv ? { env: requestEnv } : {}),
        });
        expect(res.status, `${label}: ${target}`).toBe(400);
        expect((JSON.parse(res.text) as { code: string }).code, `${label}: ${target}`).toBe("WORKFLOW_TARGET_NOT_ALLOWED");
      }
    }
    expect(await scheduleRows(wsA)).toEqual({ cron: 0, px: 0 });

    // The allowlisted name is still accepted, so the refusals above are the allowlist and not a broken route.
    const ok = await call(app!, "POST", "/api/schedules", {
      user: "alice",
      ws: wsA,
      body: { cronExpression: "*/5 * * * *", targetWorkflowId: "REPORTS_WF" },
      env: allowlisted,
    });
    expect(ok.status).toBe(201);
    expect(await scheduleRows(wsA)).toEqual({ cron: 1, px: 1 });
  }, 120_000);
});
