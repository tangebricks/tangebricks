import { expect } from "vitest";
import { createEmptyBlueprint, semanticHash } from "@poc/blueprint";
import { app as studioApp, ensureDefaultTestAuth } from "../src/index.ts";
import type { StudioApiEnv, StudioOrgRole } from "../src/index.ts";

// Story 0.15: a write's author is the verified caller, so a test that needs a human author signs a real person in (a Better
// Auth session) instead of sending a body `author`. The person is added to the default test org (`org_default`) with
// `role`, so they can work on the same projects as the seeded owner. `project`, when given, is registered in `org_default`
// first (as POST /api/orgs/:orgId/projects would), so the person's first write lands in that org, not their personal one.
export async function signInTestHuman(
  env: StudioApiEnv,
  label: string,
  role: StudioOrgRole = "owner",
  project?: string,
): Promise<{
  userId: string;
  orgId: string;
  headers: Record<string, string>;
  author: { type: "human"; id: string };
}> {
  const { orgId } = await ensureDefaultTestAuth(env);
  const email = `human-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const res = await studioApp.request(
    "/api/auth/signup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Password12345!", name: `Human ${label}` }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; user: { id: string } };
  await env.STUDIO_DB.prepare(
    "INSERT OR REPLACE INTO studio_org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(orgId, body.user.id, role, new Date().toISOString())
    .run();
  if (project) {
    await env.STUDIO_DB.prepare(
      `INSERT OR IGNORE INTO projects (project_id, org_id, current_revision, semantic_hash, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    )
      .bind(project, orgId, semanticHash(createEmptyBlueprint(project)), new Date().toISOString())
      .run();
  }
  return {
    userId: body.user.id,
    orgId,
    headers: { authorization: `Bearer ${body.token}` },
    author: { type: "human", id: body.user.id },
  };
}
