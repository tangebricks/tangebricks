// Helpers shared by the attack suites that run against the assembled max-compatible app
// (cross-tenant.fuzz.test.ts and rbac-escalation.attack.test.ts): a clean, fully migrated database, a request
// builder for the stub identity (x-test-user) and workspace header, and joining a workspace through the invite flow.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";

export interface App {
  fetch(request: Request, env: unknown): Response | Promise<Response>;
}

/** Drops every table (three passes, so child tables go first), then applies the app's migrations in file order. */
export async function resetAndMigrate(db: D1Like, sql: Record<string, string>): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts_%'",
      )
      .all<{ name: string }>();
    if (tables.results.length === 0) break;
    for (const row of [...tables.results].reverse()) {
      try {
        await db.prepare(`DROP TABLE IF EXISTS "${row.name}"`).run();
      } catch {
        // Child tables dropped first on next pass
      }
    }
  }
  const migrations = Object.entries(sql).sort(([a], [b]) => a.localeCompare(b));
  for (const [, migSql] of migrations) {
    await applyMigration(db, migSql);
  }
}

/** One request as `user` (stub identity header) in workspace `ws`, with an optional JSON body. */
export async function call(
  target: App,
  method: string,
  path: string,
  opts: { user?: string; ws?: string; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.user) headers["x-test-user"] = opts.user;
  if (opts.ws) headers["x-workspace-id"] = opts.ws;
  const hasBody = opts.body !== undefined && method !== "GET" && method !== "HEAD";
  if (hasBody) headers["content-type"] = "application/json";
  const res = await target.fetch(
    new Request(`https://example.test${path}`, { method, headers, ...(hasBody ? { body: JSON.stringify(opts.body) } : {}) }),
    env,
  );
  return { status: res.status, text: await res.text() };
}

/** `user` joins workspace `ws` as a plain member through the real invite flow, invited by `owner`. */
export async function joinAsMember(target: App, ws: string, owner: string, user: string): Promise<void> {
  const invite = await call(target, "POST", `/api/workspaces/${ws}/invites`, { user: owner, body: { role: "member" } });
  expect(invite.status).toBe(201);
  const token = (JSON.parse(invite.text) as { token: string }).token;
  const accept = await call(target, "POST", `/api/workspaces/invites/${token}/accept`, { user });
  expect(accept.status).toBe(200);
}
