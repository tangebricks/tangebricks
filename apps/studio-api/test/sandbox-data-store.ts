// Test-only sandbox data store (story 17). A generated app's entity and brick tables live in the project's own data
// store, never in STUDIO_DB; for preview that is the active sandbox D1. Tests that need fixture rows activate a sandbox
// for the project here (a `studio_sandboxes` row plus the platform's sandbox database) and write the fixtures straight
// to that database, as an operator would.
import type { D1Like } from "@poc/sdk";
import { getStudioSandboxPlatform } from "../src/index.ts";

export interface TestSandboxDataStore {
  sandboxId: string;
  /** The sandbox database as the platform holds it (the raw D1 the data routes read and write). */
  rawD1: D1Like;
}

export async function activateTestSandbox(
  studioDb: D1Like,
  options: { project: string; orgId: string; sandboxId?: string },
): Promise<TestSandboxDataStore> {
  const sandboxId =
    options.sandboxId ?? `sbx_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await studioDb
    .prepare(
      `INSERT INTO studio_sandboxes (
         sandbox_id, project_id, org_id, dispatch_namespace, build_hash, code_hash, graph_hash,
         deployed_rev, preview_url, status, created_at, expires_at
       ) VALUES (?, ?, ?, 'px-sandboxes', 'test_build', 'test_code', 'test_graph', 1, ?, 'active', ?, ?)`,
    )
    .bind(
      sandboxId,
      options.project,
      options.orgId,
      `https://${sandboxId}.sandbox.projectx.dev`,
      nowIso,
      expiresIso,
    )
    .run();
  const record = await getStudioSandboxPlatform().ensureDatabase(sandboxId);
  return { sandboxId, rawD1: record.rawD1 };
}

/** Every table name in a database (sqlite_master), sorted; used to prove a route created no table there. */
export async function listTableNames(db: D1Like): Promise<string[]> {
  const res = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name).sort();
}

/** Drops every non-internal table in a real D1 that stands in for a sandbox database, so each test starts empty. */
export async function dropAllTables(db: D1Like): Promise<void> {
  for (const name of await listTableNames(db)) {
    if (name.startsWith("sqlite_") || name.startsWith("_cf_")) continue;
    await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
}
