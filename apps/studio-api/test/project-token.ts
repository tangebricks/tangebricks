// Test-only MCP token fixtures (story 0.15). They mint full-scope tokens from values a reader of the source can compute, so
// they live with the tests and are never exported from the Worker module.
import { sha256Hex } from "@poc/assembler";
import { createEmptyBlueprint, semanticHash } from "@poc/blueprint";
import { STUDIO_MCP_SCOPES, ensureDefaultTestAuth } from "../src/auth.ts";
import type { StudioMcpScope } from "../src/auth.ts";
import type { StudioApiEnv } from "../src/index.ts";
/**
 * Seeds an MCP token bound to `project` (story 0.15) for the default test owner in `org_default`, and returns its bearer
 * headers. The seed token from ensureDefaultTestAuth is bound to `default-project` only; a test that works on another
 * project issues that project's own token here, exactly as a real client would.
 */
export async function ensureTestProjectToken(
  env: StudioApiEnv,
  project: string,
  options: { scopes?: readonly StudioMcpScope[]; clientName?: string } = {},
): Promise<{
  token: string;
  tokenId: string;
  userId: string;
  orgId: string;
  projectId: string;
  scopes: StudioMcpScope[];
  headers: Record<string, string>;
}> {
  const base = await ensureDefaultTestAuth(env);
  const scopes = [...(options.scopes ?? STUDIO_MCP_SCOPES)];
  const clientName = options.clientName ?? "studio-test";
  const key = `${project}|${scopes.join(",")}|${clientName}`;
  const token = `studio-test-project-token:${await sha256Hex(`px-test-project-token:${key}`)}`;
  const tokenId = `mcp_test_${(await sha256Hex(key)).slice(0, 24)}`;
  await env.STUDIO_DB.prepare(
    `INSERT OR IGNORE INTO studio_mcp_tokens (
      id, org_id, project_id, user_id, client_name, token_hash, scopes, revoked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(
      tokenId,
      base.orgId,
      project,
      base.userId,
      clientName,
      await sha256Hex(token),
      scopes.join(","),
      new Date().toISOString(),
    )
    .run();
  // A real token is only issued for a project with a row (story 16): register the project in the token's org, as
  // POST /api/orgs/:orgId/projects would, unless it already exists.
  await env.STUDIO_DB.prepare(
    `INSERT OR IGNORE INTO projects (project_id, org_id, current_revision, semantic_hash, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  )
    .bind(project, base.orgId, semanticHash(createEmptyBlueprint(project)), new Date().toISOString())
    .run();
  return {
    token,
    tokenId,
    userId: base.userId,
    orgId: base.orgId,
    projectId: project,
    scopes,
    headers: { authorization: `Bearer ${token}` },
  };
}

/**
 * Test headers for a Studio API path: a `/api/projects/:project/...` path gets that project's own MCP token
 * (ensureTestProjectToken); any other path gets the default seed token from ensureDefaultTestAuth.
 */
export async function ensureTestAuthForPath(
  env: StudioApiEnv,
  path: string,
): Promise<{ headers: Record<string, string>; userId: string; orgId: string }> {
  const match = /\/api\/projects\/([^/?#]+)/.exec(path);
  if (match?.[1]) {
    const scoped = await ensureTestProjectToken(env, decodeURIComponent(match[1]));
    return { headers: scoped.headers, userId: scoped.userId, orgId: scoped.orgId };
  }
  const base = await ensureDefaultTestAuth(env);
  return { headers: base.headers, userId: base.userId, orgId: base.orgId };
}
