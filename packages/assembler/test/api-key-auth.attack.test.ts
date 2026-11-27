// Story 1.11 (threat model audit 24, PROPOSED-4): API keys as a real identity in the assembled max-compatible app, in
// workerd. Alice owns workspace A, Bob owns workspace B. Alice mints keys for A through the session routes, then:
//
//   - a key for A authenticates on a brick route (the declared entity) and sees only A's rows;
//   - the same key naming B in x-workspace-id gets 403 WORKSPACE_MISMATCH;
//   - a revoked key and an unknown key get 401 INVALID_API_KEY, with no fallthrough to the session sent alongside;
//   - a member-role key is refused on an admin route; an admin-role key passes the role check;
//   - a key cannot mint, list or revoke keys, or create a workspace;
//   - a read key may GET but not write; Authorization: Bearer works like X-API-Key; two different keys get 401;
//   - expired keys and keys whose creator was demoted below the key's role get 401;
//   - outside the workspace-guarded paths a key header is ignored: /api/me/profile, /api/auth/me and webhook ingress
//     answer exactly as they do without it, and no profile row is created for the key;
//   - a session user whose id merely looks like a key's (apikey:…) still needs membership;
//   - a key whose creator was removed from A gets 401;
//   - a key for a suspended workspace gets 403 WORKSPACE_SUSPENDED;
//   - a key never reaches the platform operator routes (story 2.6);
//   - a request with no key still uses the session identity as before.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { call, joinAsMember, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

const entryLoaders = import.meta.glob("../../../out/max-compatible/src/index.ts") as Record<string, () => Promise<{ default: App }>>;
const app = (await Object.values(entryLoaders)[0]?.())?.default;
const sql = import.meta.glob("../../../out/max-compatible/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const db = env.DB as unknown as D1Like;

type Reply = { status: number; json: Record<string, unknown> };

async function api(
  method: string,
  path: string,
  opts: { user?: string; ws?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const { key, headers, ...rest } = opts;
  const { status, text } = await call(app!, method, path, { ...rest, headers: { ...headers, ...(key ? { "x-api-key": key } : {}) } });
  try {
    return { status, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status, json: { raw: text } };
  }
}

async function createWorkspace(owner: string): Promise<string> {
  const res = await api("POST", "/api/workspaces", { user: owner, body: { name: `${owner}'s workspace` } });
  expect(res.status).toBe(201);
  return (res.json.workspace as { id: string }).id;
}

async function mintKey(ws: string, user: string, body: Record<string, unknown> = {}): Promise<{ rawKey: string; id: string }> {
  const res = await api("POST", "/api/api-keys", { user, ws, body: { name: "integration", ...body } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { rawKey: res.json.rawKey as string, id: (res.json.key as { id: string }).id };
}

const codeOf = (r: Reply) => (typeof r.json.code === "string" ? r.json.code : (r.json.error as { code?: string } | undefined)?.code);

describe("API-key authentication on the assembled max-compatible app (story 1.11)", () => {
  test("a key acts only in its own workspace, at most at its creator's role, and bad keys never fall through", async () => {
    // test/support/global-setup.ts assembles out/max-compatible before the workers project runs.
    expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    await resetAndMigrate(db, sql);

    const wsA = await createWorkspace("alice");
    const wsB = await createWorkspace("bob");
    expect((await api("POST", "/api/records", { user: "alice", ws: wsA, body: { title: "alpha-row" } })).status).toBe(201);
    expect((await api("POST", "/api/records", { user: "bob", ws: wsB, body: { title: "beta-row" } })).status).toBe(201);

    const memberKey = await mintKey(wsA, "alice", { role: "member" });

    // 1. The key reads A's rows through a brick route, with or without naming A, and never B's.
    for (const ws of [undefined, wsA]) {
      const listed = await api("GET", "/api/records", { key: memberKey.rawKey, ...(ws ? { ws } : {}) });
      expect(listed.status, JSON.stringify(listed.json)).toBe(200);
      const titles = (listed.json.items as Array<{ title: string }>).map((i) => i.title);
      expect(titles).toEqual(["alpha-row"]);
    }
    expect((await api("POST", "/api/records", { key: memberKey.rawKey, body: { title: "via-key" } })).status).toBe(201);
    const bRows = await db.prepare("SELECT COUNT(*) AS n FROM ent_records WHERE workspace_id = ?").bind(wsB).first<{ n: number }>();
    expect(bRows?.n).toBe(1);

    // 2. Naming B is refused, even with Bob's session header alongside.
    const mismatch = await api("GET", "/api/records", { key: memberKey.rawKey, ws: wsB });
    expect(mismatch.status).toBe(403);
    expect(codeOf(mismatch)).toBe("WORKSPACE_MISMATCH");
    const mismatchWithSession = await api("GET", "/api/records", { key: memberKey.rawKey, ws: wsB, user: "bob" });
    expect(mismatchWithSession.status).toBe(403);

    // 3. Unknown and revoked keys: 401, and a valid session sent alongside does not rescue them.
    const unknown = await api("GET", "/api/records", { key: `sk_live_${"0".repeat(48)}`, user: "alice", ws: wsA });
    expect(unknown.status).toBe(401);
    expect(codeOf(unknown)).toBe("INVALID_API_KEY");
    const doomed = await mintKey(wsA, "alice");
    expect((await api("GET", "/api/records", { key: doomed.rawKey })).status).toBe(200);
    expect((await api("DELETE", `/api/api-keys/${doomed.id}`, { user: "alice", ws: wsA })).status).toBe(200);
    const revoked = await api("GET", "/api/records", { key: doomed.rawKey, user: "alice", ws: wsA });
    expect(revoked.status).toBe(401);
    expect(codeOf(revoked)).toBe("INVALID_API_KEY");

    // 4. A member key is refused on an admin route; an admin key gets past the role check (the flag does not exist).
    const memberOnAdmin = await api("POST", "/api/flags/beta/override", { key: memberKey.rawKey, body: { enabled: true } });
    expect(memberOnAdmin.status).toBe(403);
    const adminKey = await mintKey(wsA, "alice", { role: "admin" });
    const adminOnAdmin = await api("POST", "/api/flags/beta/override", { key: adminKey.rawKey, body: { enabled: true } });
    expect(adminOnAdmin.status).toBe(404);

    // 5. No owner keys, and a key can never manage keys or workspaces.
    expect((await api("POST", "/api/api-keys", { user: "alice", ws: wsA, body: { name: "x", role: "owner" } })).status).toBe(400);
    for (const [method, path] of [
      ["GET", "/api/api-keys"],
      ["POST", "/api/api-keys"],
      ["DELETE", `/api/api-keys/${memberKey.id}`],
    ] as const) {
      const res = await api(method, path, { key: adminKey.rawKey, ...(method === "POST" ? { body: { name: "child", role: "member" } } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(codeOf(res)).toBe("API_KEY_FORBIDDEN");
    }
    // Workspace routes are not guarded paths: the key header is ignored there, so the request is unauthenticated.
    const keyMakesWorkspace = await api("POST", "/api/workspaces", { key: adminKey.rawKey, body: { name: "escape" } });
    expect(keyMakesWorkspace.status).toBe(401);
    expect((await api("DELETE", `/api/workspaces/${wsA}`, { key: adminKey.rawKey })).status).toBe(401);
    // A member of A cannot mint keys at all.
    await joinAsMember(app!, wsA, "alice", "mia");
    expect((await api("POST", "/api/api-keys", { user: "mia", ws: wsA, body: { name: "x" } })).status).toBe(403);

    // 6. A key whose creator was removed from the workspace is dead.
    const invite = await api("POST", `/api/workspaces/${wsA}/invites`, { user: "alice", body: { role: "admin" } });
    expect(invite.status).toBe(201);
    expect((await api("POST", `/api/workspaces/invites/${invite.json.token as string}/accept`, { user: "carol" })).status).toBe(200);
    const carolsKey = await mintKey(wsA, "carol", { role: "admin" });
    expect((await api("GET", "/api/records", { key: carolsKey.rawKey })).status).toBe(200);
    expect((await api("DELETE", `/api/workspaces/${wsA}/members/carol`, { user: "alice" })).status).toBe(200);
    const orphan = await api("GET", "/api/records", { key: carolsKey.rawKey });
    expect(orphan.status).toBe(401);
    expect(codeOf(orphan)).toBe("INVALID_API_KEY");

    // 6b. Bearer works end to end; two different keys conflict; a read key cannot write; expired and
    // creator-demoted keys are dead.
    const bearer = await call(app!, "GET", "/api/records", { headers: { authorization: `Bearer ${memberKey.rawKey}` } });
    expect(bearer.status).toBe(200);
    const conflict = await api("GET", "/api/records", { key: memberKey.rawKey, headers: { authorization: `Bearer ${adminKey.rawKey}` } });
    expect(conflict.status).toBe(401);
    expect(codeOf(conflict)).toBe("INVALID_API_KEY");
    const readKey = await mintKey(wsA, "alice", { scopes: ["read"] });
    expect((await api("GET", "/api/records", { key: readKey.rawKey })).status).toBe(200);
    const readWrite = await api("POST", "/api/records", { key: readKey.rawKey, body: { title: "nope" } });
    expect(readWrite.status).toBe(403);
    expect(codeOf(readWrite)).toBe("API_KEY_SCOPE");
    const expiring = await mintKey(wsA, "alice", { expiresDays: 1 });
    await db
      .prepare("UPDATE key_api_keys SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), expiring.id)
      .run();
    expect((await api("GET", "/api/records", { key: expiring.rawKey })).status).toBe(401);
    const invite2 = await api("POST", `/api/workspaces/${wsA}/invites`, { user: "alice", body: { role: "admin" } });
    expect((await api("POST", `/api/workspaces/invites/${invite2.json.token as string}/accept`, { user: "dana" })).status).toBe(200);
    const danasKey = await mintKey(wsA, "dana", { role: "admin" });
    expect((await api("GET", "/api/records", { key: danasKey.rawKey })).status).toBe(200);
    await db.prepare("UPDATE mw_members SET role = 'member' WHERE workspace_id = ? AND user_id = 'dana'").bind(wsA).run();
    expect((await api("GET", "/api/records", { key: danasKey.rawKey })).status).toBe(401);

    // 6c. Outside the guarded paths the key header changes nothing.
    for (const [method, path, body] of [
      ["GET", "/api/me/profile", undefined],
      ["PATCH", "/api/me/profile", { displayName: "key" }],
      ["GET", "/api/auth/me", undefined],
      ["POST", "/api/webhooks/in/sub_unknown", { event: "x" }],
      ["POST", "/api/webhooks/ingress/unknown-slug", { event: "x" }],
    ] as const) {
      const without = await api(method, path, body ? { body } : {});
      const withKey = await api(method, path, { key: adminKey.rawKey, ...(body ? { body } : {}) });
      expect(withKey.status, `${method} ${path}`).toBe(without.status);
      const unrelated = await api(method, path, { headers: { "x-api-key": "unrelated-vendor-key" }, ...(body ? { body } : {}) });
      expect(unrelated.status, `${method} ${path} unrelated header`).toBe(without.status);
    }
    // Story 2.6: a key never reaches the platform operator routes: they are not guarded paths, so the key is no identity
    // there and the request is refused as unauthenticated, even with the key's creator listed as an operator (inside
    // the brick an API-key request is refused with API_KEY_FORBIDDEN as well).
    const operatorEnv = { ...(env as unknown as Record<string, unknown>), PX_PLATFORM_OPERATORS: "alice" };
    // Every one of the brick's 11 routes.
    for (const [method, path, body] of [
      ["GET", "/api/platform/workspaces", undefined],
      ["GET", `/api/platform/workspaces/${wsA}`, undefined],
      ["GET", "/api/platform/users?status=pending", undefined],
      ["GET", "/api/platform/audit/pending", undefined],
      ["POST", `/api/platform/workspaces/${wsA}/credits`, { amount: 5, reason: "via key", idempotencyKey: "k" }],
      ["POST", `/api/platform/workspaces/${wsA}/suspend`, { reason: "via key" }],
      ["POST", `/api/platform/workspaces/${wsA}/unsuspend`, { reason: "via key" }],
      ["PUT", `/api/platform/workspaces/${wsA}/flags/beta`, { enabled: true, reason: "via key" }],
      ["DELETE", `/api/platform/workspaces/${wsA}/flags/beta`, { reason: "via key" }],
      ["POST", "/api/platform/users/mallory/approve", { reason: "via key" }],
      ["POST", "/api/platform/users/mallory/reject", { reason: "via key" }],
    ] as const) {
      const { status } = await call(app!, method, path, { headers: { "x-api-key": adminKey.rawKey }, env: operatorEnv, ...(body ? { body } : {}) });
      expect(status, `${method} ${path}`).toBe(401);
    }
    expect(await db.prepare("SELECT suspended FROM mw_workspaces WHERE id = ?").bind(wsA).first<{ suspended: number }>()).toEqual({ suspended: 0 });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'platform.%'").first<{ n: number }>())?.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM pa_user_approvals").first<{ n: number }>())?.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM flag_overrides").first<{ n: number }>())?.n).toBe(0);

    const profiles = await db.prepare("SELECT COUNT(*) AS n FROM profile_users WHERE user_id LIKE 'apikey:%'").first<{ n: number }>();
    expect(profiles?.n).toBe(0);

    // 6d. A session user whose id looks like a key's gets no special path: membership is still required.
    const lookalike = await api("GET", "/api/records", { user: `apikey:${memberKey.id}`, ws: wsA });
    expect(lookalike.status).toBe(403);

    // 7. With no key, the session identity works exactly as before (and the session still sees A's rows).
    const session = await api("GET", "/api/records", { user: "alice", ws: wsA });
    expect(session.status).toBe(200);
    expect((session.json.items as Array<{ title: string }>).map((i) => i.title).sort()).toEqual(["alpha-row", "via-key"]);
    expect((await api("GET", "/api/records", { user: "bob", ws: wsA })).status).toBe(403);

    // 8. A suspended workspace's keys get 403 WORKSPACE_SUSPENDED; B is unaffected.
    const bKey = await mintKey(wsB, "bob");
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = ?").bind(wsA).run();
    const suspended = await api("GET", "/api/records", { key: memberKey.rawKey });
    expect(suspended.status).toBe(403);
    expect(codeOf(suspended)).toBe("WORKSPACE_SUSPENDED");
    const bListed = await api("GET", "/api/records", { key: bKey.rawKey });
    expect(bListed.status).toBe(200);
    expect((bListed.json.items as Array<{ title: string }>).map((i) => i.title)).toEqual(["beta-row"]);
  }, 60_000);
});
