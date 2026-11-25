// Story 2.6: platform-admin's opt-in user approval gate in a real assembled app (test/support/blueprints.ts
// APPROVAL_GATE_BLUEPRINT, requireUserApproval: true), in workerd. The assembler mounts the gate on every
// workspace-guarded path, after the identity step: a signed-in user nobody has approved gets 403 USER_NOT_APPROVED there,
// shows up as pending for the operators, and passes once an operator approves them; operators exempt themselves.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { call, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

const entryLoaders = import.meta.glob("../../../out/approval-gate/src/index.ts") as Record<string, () => Promise<{ default: App }>>;
const app = (await Object.values(entryLoaders)[0]?.())?.default;
const sql = import.meta.glob("../../../out/approval-gate/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const db = env.DB as unknown as D1Like;

const OPERATOR = "olivia-operator";
const operatorEnv = { ...(env as unknown as Record<string, unknown>), PX_PLATFORM_OPERATORS: OPERATOR };

type Reply = { status: number; json: Record<string, any> };
async function api(method: string, path: string, opts: { user?: string; ws?: string; body?: unknown } = {}): Promise<Reply> {
  const res = await call(app!, method, path, { ...opts, env: operatorEnv });
  return { status: res.status, json: JSON.parse(res.text || "{}") as Record<string, any> };
}

describe("user approval gate in an assembled app (story 2.6)", () => {
  test("unapproved users are refused on workspace routes until an operator approves them; rejection refuses again", async () => {
    expect(app, "out/approval-gate/src/index.ts was not assembled").toBeDefined();
    await resetAndMigrate(db, sql);

    // Creating a workspace is not a workspace-guarded route, so it still works; using it does not.
    const created = await api("POST", "/api/workspaces", { user: "alice", body: { name: "A" } });
    expect(created.status).toBe(201);
    const wsA = created.json.workspace.id as string;
    const refused = await api("GET", "/api/wallet", { user: "alice", ws: wsA });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("USER_NOT_APPROVED");
    // The gate runs before the workspace guard: even without a workspace header the answer is the same.
    expect((await api("GET", "/api/wallet", { user: "bob" })).json.code).toBe("USER_NOT_APPROVED");
    // No session at all is still the guard's 401.
    expect((await api("GET", "/api/wallet", { ws: wsA })).status).toBe(401);

    const pending = await api("GET", "/api/platform/users?status=pending", { user: OPERATOR });
    expect(pending.status).toBe(200);
    expect(pending.json.approvalGate).toBe(true);
    expect(pending.json.users.map((u: { userId: string }) => u.userId).sort()).toEqual(["alice", "bob"]);

    // A user cannot approve themselves, whatever their workspace role.
    const self = await api("POST", "/api/platform/users/alice/approve", { user: "alice", body: { reason: "me" } });
    expect(self.status).toBe(403);
    expect(self.json.code).toBe("NOT_PLATFORM_OPERATOR");

    expect((await api("POST", "/api/platform/users/alice/approve", { user: OPERATOR, body: { reason: "verified" } })).status).toBe(200);
    expect((await api("GET", "/api/wallet", { user: "alice", ws: wsA })).status).toBe(200);
    expect((await api("GET", "/api/audit/events", { user: "alice", ws: wsA })).status).toBe(200);
    expect((await api("GET", "/api/wallet", { user: "bob" })).json.code).toBe("USER_NOT_APPROVED");

    expect((await api("POST", "/api/platform/users/alice/reject", { user: OPERATOR, body: { reason: "fraud" } })).status).toBe(200);
    expect((await api("GET", "/api/wallet", { user: "alice", ws: wsA })).json.code).toBe("USER_NOT_APPROVED");

    // The operator is exempt from the gate in their own workspace.
    const opWs = (await api("POST", "/api/workspaces", { user: OPERATOR, body: { name: "Ops" } })).json.workspace.id as string;
    expect((await api("GET", "/api/wallet", { user: OPERATOR, ws: opWs })).status).toBe(200);

    // API keys are judged by their creator: an approved creator's key works; once the creator is rejected, it is refused.
    expect((await api("POST", "/api/platform/users/bob/approve", { user: OPERATOR, body: { reason: "verified" } })).status).toBe(200);
    const wsB = (await api("POST", "/api/workspaces", { user: "bob", body: { name: "B" } })).json.workspace.id as string;
    const minted = await api("POST", "/api/api-keys", { user: "bob", ws: wsB, body: { name: "integration", role: "admin" } });
    expect(minted.status, JSON.stringify(minted.json)).toBe(201);
    const key = minted.json.rawKey as string;
    const viaKey = async () => {
      const res = await call(app!, "GET", "/api/wallet", { headers: { "x-api-key": key }, env: operatorEnv });
      return { status: res.status, code: (JSON.parse(res.text || "{}") as { code?: string }).code };
    };
    expect(await viaKey()).toMatchObject({ status: 200 });
    expect((await api("POST", "/api/platform/users/bob/reject", { user: OPERATOR, body: { reason: "fraud" } })).status).toBe(200);
    expect(await viaKey()).toEqual({ status: 403, code: "USER_NOT_APPROVED" });

    const decisions = (
      await db.prepare("SELECT actor_id, action, target_id FROM audit_events WHERE workspace_id = '_platform' ORDER BY rowid").all<{ actor_id: string; action: string; target_id: string }>()
    ).results;
    expect(decisions).toEqual([
      { actor_id: OPERATOR, action: "platform.user.approve", target_id: "alice" },
      { actor_id: OPERATOR, action: "platform.user.reject", target_id: "alice" },
      { actor_id: OPERATOR, action: "platform.user.approve", target_id: "bob" },
      { actor_id: OPERATOR, action: "platform.user.reject", target_id: "bob" },
    ]);
  });
});
