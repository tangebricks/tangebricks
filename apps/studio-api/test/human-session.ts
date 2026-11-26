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

const ownerSessions = new WeakMap<object, Record<string, string>>();

/**
 * AD-V8: a Studio session for the default test owner (`user_cp1_default_owner`, the user every test MCP token acts for),
 * so a test can play the human reviewer who accepts an agent's proposal or approves its request in Studio. A session row
 * is written with a raw token (the hashed-session adapter rewrites it to its digest on first use, as for any older row),
 * and the bearer header carries that token, exactly as a signed-in Studio tab would.
 */
export async function defaultOwnerSessionHeaders(env: StudioApiEnv): Promise<Record<string, string>> {
  const cached = ownerSessions.get(env as object);
  if (cached) return cached;
  const { userId } = await ensureDefaultTestAuth(env);
  const token = `owner-session-${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date();
  await env.STUDIO_DB.prepare(
    `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
    .bind(
      `sess_${crypto.randomUUID()}`,
      new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(),
      token,
      now.toISOString(),
      now.toISOString(),
      userId,
    )
    .run();
  const headers = { authorization: `Bearer ${token}` };
  ownerSessions.set(env as object, headers);
  return headers;
}

/**
 * AD-V8: the human review step. Accepts a pending proposal as the default test owner in Studio and returns the commit
 * (the agent stays the author, on behalf of the owner, as before the gate).
 */
export async function acceptProposalAsOwner(
  env: StudioApiEnv,
  project: string,
  proposalId: string,
  opIds?: string[],
): Promise<Response> {
  const headers = await defaultOwnerSessionHeaders(env);
  return studioApp.request(
    `/api/projects/${encodeURIComponent(project)}/proposals/${encodeURIComponent(proposalId)}/accept`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(opIds ? { opIds } : {}),
    },
    env,
  );
}

/** AD-V8: approves a pending approval request as the default test owner in Studio. */
export async function approveAsOwner(env: StudioApiEnv, project: string, approvalId: string): Promise<Response> {
  const headers = await defaultOwnerSessionHeaders(env);
  return studioApp.request(
    `/api/projects/${encodeURIComponent(project)}/approvals/${encodeURIComponent(approvalId)}/approve`,
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" },
    env,
  );
}

/**
 * AD-V8 test churn: an MCP token's POST /ops. A body without `mode` is sent with mode "apply" (the preview-safe direct
 * edit an agent may still make); when Studio answers 403 PROPOSAL_REQUIRED (money brick, destructive op, brick upgrade
 * or live production), it is sent again as a proposal and the default owner accepts it in Studio, as a reviewer would.
 * A body that names `mode` is sent as written.
 */
export async function postOpsWithReview(
  env: StudioApiEnv,
  project: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  const send = (payload: Record<string, unknown>) =>
    studioApp.request(
      `/api/projects/${encodeURIComponent(project)}/ops`,
      { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(payload) },
      env,
    );
  if (body.mode !== undefined) return send(body);
  const direct = await send({ ...body, mode: "apply" });
  if (direct.status !== 403) return direct;
  const refusal = (await direct.clone().json().catch(() => ({}))) as { error?: { code?: string } };
  if (refusal.error?.code !== "PROPOSAL_REQUIRED") return direct;
  const proposed = await send({ ...body, mode: "propose" });
  if (proposed.status !== 200) return proposed;
  const pending = (await proposed.clone().json()) as { proposalId?: string; status?: string };
  // The same opIds again are answered as already committed (idempotent): there is nothing to review.
  if (pending.status !== "pending" || !pending.proposalId) return proposed;
  return acceptProposalAsOwner(env, project, pending.proposalId);
}

/**
 * AD-V8 test churn: a destructive action (deploy, promote, rollback, revert, sandbox deploy, promote-to-BYOC) sent with an
 * MCP token. `send` is called without an approval first; on 403 APPROVAL_REQUIRED the default owner approves the request
 * in Studio and `send` is called again with the approval id. Any other answer is returned as it is.
 */
export async function sendWithOwnerApproval(
  env: StudioApiEnv,
  project: string,
  send: (approvalId?: string) => Promise<Response>,
): Promise<Response> {
  const first = await send();
  if (first.status !== 403) return first;
  const refusal = (await first.clone().json().catch(() => ({}))) as { error?: { code?: string; approvalId?: string } };
  if (refusal.error?.code !== "APPROVAL_REQUIRED" || !refusal.error.approvalId) return first;
  const approved = await approveAsOwner(env, project, refusal.error.approvalId);
  if (approved.status !== 200) return approved;
  return send(refusal.error.approvalId);
}

/** Adds `approvalId` to a JSON request body (an empty or missing body becomes `{ approvalId }`). */
export function withApprovalId<B>(body: B, approvalId: string | undefined): B | string {
  if (!approvalId) return body;
  let parsed: Record<string, unknown> = {};
  if (typeof body === "string" && body.trim().length > 0) parsed = JSON.parse(body) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, approvalId });
}

/** True for the Studio routes AD-V8 gates for an MCP token. */
export function isApprovalGatedPath(path: string): boolean {
  return /\/api\/projects\/[^/]+\/(revert|import|environments\/[^/]+\/(deploy|promote|rollback)|sandbox\/(deploy|promote-to-byoc))(\?|$)/.test(path);
}
