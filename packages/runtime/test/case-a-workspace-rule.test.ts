// Story 1.17: the Case-A connection workspace rule. A px_connections row is usable by a run only when its workspace_id is
// the run's own workspace or the project-shared "default", and (when the runtime knows it) its project_id is the run's
// project. Ref lookups and the app fallback apply the same filter; another workspace's row is never found.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { signControlPlaneRequest } from "@poc/telemetry";
import {
  buildRegistryFromCatalog,
  ensureConnectionsTable,
  handleWorkflowRunRequest,
  isTenantWorkspaceId,
  resolveCaseAConnection,
  toyExecutors,
  upsertSealedConnection,
} from "../src/index.ts";

const db = (env as unknown as { DB: D1Like }).DB;
const CONN_KEY = "case-a-workspace-rule-conn-key-2026";

async function seed(ref: string, app: string, workspaceId: string, projectId: string, token: string) {
  await upsertSealedConnection(
    db,
    { ref, app, workspaceId, projectId, envName: "preview", authType: "apiKey", credentials: { apiKey: token } },
    CONN_KEY,
  );
}

const resolve = (selector: Parameters<typeof resolveCaseAConnection>[0], workspaceId: string, projectId?: string) =>
  resolveCaseAConnection(selector, {
    db,
    connKey: CONN_KEY,
    workspaceId,
    envName: "preview",
    ...(projectId ? { projectId } : {}),
  });

describe("story 1.17: Case-A connections are confined to the run's workspace or the project-shared default", () => {
  beforeEach(async () => {
    await ensureConnectionsTable(db);
    await db.prepare("DELETE FROM px_connections").run();
  });

  test("another workspace's connection is not found by ref or by app", async () => {
    await seed("conn_b_ref", "acme", "ws_b", "proj-1", "token-of-workspace-b");
    await expect(resolve("conn_b_ref", "ws_a", "proj-1")).rejects.toThrow(/was not found in px_connections/);
    await expect(resolve({ ref: "conn_b_ref" }, "ws_a", "proj-1")).rejects.toThrow(/was not found/);
    await expect(resolve({ app: "acme" }, "ws_a", "proj-1")).rejects.toThrow(/was not found/);
    // The owning workspace still resolves it.
    expect((await resolve("conn_b_ref", "ws_b", "proj-1")).apiKey).toBe("token-of-workspace-b");
  });

  test("the run's own workspace and the shared default are allowed; the app fallback prefers the run's workspace", async () => {
    await seed("conn_shared", "acme", "default", "proj-1", "token-shared");
    await seed("conn_own", "acme", "ws_a", "proj-1", "token-own");
    await seed("conn_other", "acme", "ws_c", "proj-1", "token-other");

    expect((await resolve("conn_shared", "ws_a", "proj-1")).apiKey).toBe("token-shared");
    expect((await resolve("conn_own", "ws_a", "proj-1")).apiKey).toBe("token-own");
    expect((await resolve({ app: "acme" }, "ws_a", "proj-1")).apiKey).toBe("token-own");
    // A workspace with no row of its own falls back to the shared default, never to ws_c's.
    expect((await resolve({ app: "acme" }, "ws_z", "proj-1")).apiKey).toBe("token-shared");
    await expect(resolve("conn_other", "ws_a", "proj-1")).rejects.toThrow(/was not found/);
  });

  test("when the project is known, another project's connection is not used", async () => {
    await seed("conn_p2", "acme", "default", "proj-2", "token-project-2");
    await expect(resolve("conn_p2", "ws_a", "proj-1")).rejects.toThrow(/was not found/);
    await expect(resolve({ app: "acme" }, "ws_a", "proj-1")).rejects.toThrow(/was not found/);
    expect((await resolve("conn_p2", "ws_a", "proj-2")).apiKey).toBe("token-project-2");
  });

  test("`default` is reserved: no tenant workspace may be named it, so none shares the project-wide bucket", async () => {
    expect(isTenantWorkspaceId("default")).toBe(false);
    expect(isTenantWorkspaceId("DEFAULT")).toBe(false);
    expect(isTenantWorkspaceId("ws_default")).toBe(true); // Studio's preview workspace stays usable
    expect(isTenantWorkspaceId("ws_a")).toBe(true);

    // Runtime admission: a correctly signed run naming `default` is refused before anything runs.
    const secret = "case-a-reserved-default-signing-secret";
    const body = JSON.stringify({
      requestId: crypto.randomUUID(),
      workspaceId: "default",
      graph: { nodes: [{ id: "t", type: "trigger.manual", data: {} }], edges: [] },
    });
    const res = await handleWorkflowRunRequest(
      new Request("http://w.invalid/__px/runs", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await signControlPlaneRequest(secret, "POST", "/__px/runs", body)) },
        body,
      }),
      { registry: buildRegistryFromCatalog(), executors: toyExecutors, db, telemetrySecret: secret },
    );
    expect(res?.status).toBe(400);
    expect(((await res!.json()) as { error: { code: string } }).error.code).toBe("BAD_WORKSPACE");
  });
});
