// Story 0.19 (threat model B4-B6): grant-escalation attacks on rbac-policy, run against the assembled max-compatible app
// (the outermost surface) in workerd. Alice owns workspace A and makes Carol, a plain member, a delegate holding only
// `roles:assign` and `roles:write`. Carol then tries to escalate: create a `*:*` role, assign a `*:*` role, assign any
// role to herself, and assign a role to someone outside the workspace. Every attempt must be refused and leave the
// rbac tables of A unchanged. The broad cross-tenant suite (cross-tenant.fuzz.test.ts) still covers every route.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { call, joinAsMember, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

const entryLoaders = import.meta.glob("../../../out/max-compatible/src/index.ts") as Record<string, () => Promise<{ default: App }>>;
const app = (await Object.values(entryLoaders)[0]?.())?.default;
const sql = import.meta.glob("../../../out/max-compatible/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const db = env.DB as unknown as D1Like;

/** The shared request builder, with the JSON body parsed (or `{ raw }` when it is not JSON). */
async function api(
  method: string,
  path: string,
  opts: { user?: string; ws?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { status, text } = await call(app!, method, path, opts);
  try {
    return { status, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status, json: { raw: text } };
  }
}

async function createRole(ws: string, user: string, name: string, permissions: string[]): Promise<{ status: number; json: Record<string, unknown> }> {
  return api("POST", "/api/roles", {
    user,
    ws,
    body: { name, permissions: permissions.map((p) => ({ resource: p.split(":")[0], action: p.split(":")[1] })) },
  });
}

/** The rbac rows of one workspace, to prove a refused attempt wrote nothing. */
async function rbacSnapshot(ws: string): Promise<string> {
  const roles = await db.prepare("SELECT id, name FROM rbac_roles WHERE workspace_id = ? ORDER BY id").bind(ws).all();
  const assignments = await db.prepare("SELECT user_id, role_id FROM rbac_role_assignments WHERE workspace_id = ? ORDER BY user_id, role_id").bind(ws).all();
  return JSON.stringify({ roles: roles.results, assignments: assignments.results });
}

describe("rbac-policy grant escalation on the assembled max-compatible app (story 0.19)", () => {
  test("a roles:assign + roles:write member cannot create or assign *:*, self-assign, or assign to a non-member", async () => {
    // test/support/global-setup.ts assembles out/max-compatible before the workers project runs.
    expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    await resetAndMigrate(db, sql);

    const created = await api("POST", "/api/workspaces", { user: "alice", body: { name: "Workspace A" } });
    expect(created.status).toBe(201);
    const wsA = (created.json.workspace as { id: string }).id;
    await joinAsMember(app!, wsA, "alice", "carol");
    await joinAsMember(app!, wsA, "alice", "dave");

    // Alice (owner) makes Carol a delegate holding only roles:assign and roles:write, and creates a *:* admin role.
    const delegate = await createRole(wsA, "alice", "Delegate", ["roles:assign", "roles:write"]);
    expect(delegate.status).toBe(201);
    const delegateId = (delegate.json.role as { id: string }).id;
    const admin = await createRole(wsA, "alice", "Admin", ["*:*"]);
    expect(admin.status).toBe(201);
    const adminId = (admin.json.role as { id: string }).id;
    const toCarol = await api("POST", "/api/roles/assign", { user: "alice", ws: wsA, body: { userId: "carol", roleId: delegateId } });
    expect(toCarol.status).toBe(200);

    const before = await rbacSnapshot(wsA);

    // Wildcard role creation by a roles:write holder.
    for (const perms of [["*:*"], ["billing:refund"], ["roles:read"]]) {
      const res = await createRole(wsA, "carol", `Escalate ${perms.join(",")}`, perms);
      expect(res.status, `create ${perms.join(",")}`).toBe(403);
      expect(res.json.code).toBe("GRANT_EXCEEDS_CALLER");
    }

    // Assigning the *:* role to another member.
    const toDave = await api("POST", "/api/roles/assign", { user: "carol", ws: wsA, body: { userId: "dave", roleId: adminId } });
    expect(toDave.status).toBe(403);
    expect(toDave.json.code).toBe("GRANT_EXCEEDS_CALLER");
    expect(toDave.json.missing).toContain("*:*");

    // Self-escalation: any role, including one within her own grants.
    for (const roleId of [adminId, delegateId]) {
      const self = await api("POST", "/api/roles/assign", { user: "carol", ws: wsA, body: { userId: "carol", roleId } });
      expect(self.status).toBe(403);
      expect(self.json.code).toBe("SELF_ASSIGNMENT_FORBIDDEN");
    }

    // Revoking a role she could not grant.
    const revokeAdmin = await api("POST", "/api/roles/revoke", { user: "carol", ws: wsA, body: { userId: "alice", roleId: adminId } });
    expect(revokeAdmin.status).toBe(403);

    // Assignment to someone outside the workspace (Bob, who owns another workspace, and a made-up id), even by the owner.
    await api("POST", "/api/workspaces", { user: "bob", body: { name: "Workspace B" } });
    for (const [caller, target] of [
      ["carol", "bob"],
      ["alice", "bob"],
      ["alice", "mallory"],
    ] as const) {
      const res = await api("POST", "/api/roles/assign", { user: caller, ws: wsA, body: { userId: target, roleId: delegateId } });
      expect(res.status, `${caller} -> ${target}`).toBe(404);
      expect(res.json.code).toBe("USER_NOT_IN_WORKSPACE");
    }

    expect(await rbacSnapshot(wsA)).toBe(before);

    // The legitimate paths still work: Carol may hand her own delegate role to another member.
    const legit = await api("POST", "/api/roles/assign", { user: "carol", ws: wsA, body: { userId: "dave", roleId: delegateId } });
    expect(legit.status).toBe(200);
  }, 120_000);
});
