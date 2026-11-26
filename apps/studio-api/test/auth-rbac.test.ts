import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { applyMigration, sha256HexString } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import aiCreditsPresetRaw from "../../../presets/ai-credits-saas.blueprint.json?raw";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import { app as studioApp } from "../src/index.ts";
import type { ProjectStatePayload, StudioApiEnv } from "../src/index.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  GITHUB_CLIENT_ID: "studio-gh-test-client-id",
  GITHUB_CLIENT_SECRET: "studio-gh-test-client-secret",
};

interface CallOptions {
  method?: string;
  token?: string;
  cookie?: string;
  orgId?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function callStudio(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  // Story 0.14: a cookie-authenticated write must come from an allowed Origin (CSRF guard); this is the same origin.
  if (options.cookie && !headers.has("origin")) headers.set("origin", "https://example.test");
  if (options.orgId) headers.set("x-org-id", options.orgId);

  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    rawBody = JSON.stringify(options.body);
  }

  return studioApp.fetch(
    new Request(`https://example.test${path}`, {
      method: options.method ?? (rawBody !== undefined ? "POST" : "GET"),
      headers,
      body: rawBody,
    }),
    TEST_ENV,
  );
}

let mcpRpcId = 1;
async function callStudioMcp(
  toolName: string,
  args: Record<string, unknown>,
  options: { token?: string; cookie?: string } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await callStudio("/mcp", {
    method: "POST",
    ...(options.token ? { token: options.token } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
    body: {
      jsonrpc: "2.0",
      id: mcpRpcId++,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    },
  });
  const body = (await res.json()) as Record<string, any>;
  return { status: res.status, body };
}

beforeEach(async () => {
  for (const table of [
    "studio_audit_log",
    "studio_mcp_tokens",
    "studio_org_members",
    "studio_orgs",
    "studio_builds",
    "projects",
    "session",
    "account",
    "verification",
    "user",
  ]) {
    await studioDb.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  }
  await applyMigration(studioDb, studioAuthOrgsSql);
});

describe("Story 2.1 — Studio Better Auth login, organizations, roles, and audit log (tracer bullet)", () => {
  test("1. sign-up, sign-in, GitHub OAuth, org creation, project creation, session cookie auth, and scoped MCP token auth with author attribution (AC 1, AC 2, AC 3, AC 4, AC 5)", async () => {
    // 1a. Sign up Alice via Better Auth email+password
    const signUpRes = await callStudio("/api/auth/sign-up/email", {
      body: {
        email: "alice@studio.test",
        password: "alice-strong-password-123",
        name: "Alice Builder",
      },
    });
    expect(signUpRes.status).toBe(200);
    const signUpData = (await signUpRes.json()) as {
      token: string;
      user: { id: string; email: string; name: string };
    };
    expect(signUpData.user.email).toBe("alice@studio.test");

    // Sign in Alice to obtain HttpOnly session cookie
    const signInRes = await callStudio("/api/auth/sign-in/email", {
      body: {
        email: "alice@studio.test",
        password: "alice-strong-password-123",
      },
    });
    expect(signInRes.status).toBe(200);
    const setCookieHeader = signInRes.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("better-auth.session_token=");
    expect(setCookieHeader.toLowerCase()).toContain("httponly");
    const aliceCookie = setCookieHeader.split(";")[0]!;

    // 1b. Create Organization via POST /api/orgs using Alice's session cookie
    const createOrgRes = await callStudio("/api/orgs", {
      cookie: aliceCookie,
      body: {
        name: "Acme Cloud Studio",
        slug: "acme-cloud",
      },
    });
    expect(createOrgRes.status).toBe(201);
    const orgBody = (await createOrgRes.json()) as {
      id: string;
      slug: string;
      name: string;
      role: string;
    };
    expect(orgBody.slug).toBe("acme-cloud");
    expect(orgBody.role).toBe("owner");
    const acmeOrgId = orgBody.id;

    // List orgs via GET /api/orgs
    const listOrgsRes = await callStudio("/api/orgs", { cookie: aliceCookie });
    expect(listOrgsRes.status).toBe(200);
    const listOrgsBody = (await listOrgsRes.json()) as {
      orgs: Array<{ id: string; slug: string; role: string }>;
    };
    expect(listOrgsBody.orgs).toHaveLength(1);
    expect(listOrgsBody.orgs[0]?.id).toBe(acmeOrgId);
    expect(listOrgsBody.orgs[0]?.role).toBe("owner");

    // 1c. Create project in Acme Org via POST /api/orgs/:orgId/projects
    const projectSlug = "acme-billing-saas";
    const createProjRes = await callStudio(`/api/orgs/${acmeOrgId}/projects`, {
      cookie: aliceCookie,
      body: { project: projectSlug },
    });
    expect(createProjRes.status).toBe(201);
    const createdProj = (await createProjRes.json()) as {
      project: string;
      orgId: string;
      revision: number;
    };
    expect(createdProj.project).toBe(projectSlug);
    expect(createdProj.orgId).toBe(acmeOrgId);
    expect(createdProj.revision).toBe(0);

    // Mutate project via human session cookie (omitting explicit author -> resolved from session cookie)
    const humanOpsRes = await callStudio(`/api/projects/${projectSlug}/ops`, {
      cookie: aliceCookie,
      body: {
        summary: "Enable multi-workspace via Studio session",
        ops: [
          {
            opId: "auth-t1-op-1",
            type: "enable_brick",
            brickId: "multi-workspace",
          },
        ],
      },
    });
    expect(humanOpsRes.status).toBe(200);
    const rev1 = (await humanOpsRes.json()) as ProjectStatePayload;
    expect(rev1.revision).toBe(1);
    expect(rev1.author).toEqual({
      type: "human",
      id: signUpData.user.id,
    });

    // 1d. Issue a scoped MCP token for Alice in Acme Org and mutate via MCP token
    const issueTokenRes = await callStudio(`/api/orgs/${acmeOrgId}/mcp-tokens`, {
      cookie: aliceCookie,
      body: {
        clientName: "claude-code",
        projectId: projectSlug,
        scopes: ["read", "edit"],
      },
    });
    expect(issueTokenRes.status).toBe(201);
    const issuedTokenBody = (await issueTokenRes.json()) as {
      token: string;
      id: string;
      clientName: string;
      scopes: string[];
    };
    expect(issuedTokenBody.token.startsWith("px_mcp_")).toBe(true);
    expect(issuedTokenBody.clientName).toBe("claude-code");
    expect(issuedTokenBody.scopes).toEqual(["read", "edit"]);

    // Mutate project via POST /api/projects/:project/ops using Bearer MCP token
    const agentOpsRes = await callStudio(`/api/projects/${projectSlug}/ops`, {
      token: issuedTokenBody.token,
      body: {
        baseRevision: 1,
        summary: "Enable credit-wallet via MCP token",
        ops: [
          {
            opId: "auth-t1-op-2",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: { creditsPerUnit: 20, minOrderAmount: 50 },
          },
        ],
      },
    });
    // AD-V8: an MCP token's edit is a proposal by default (and a money brick could not be applied directly anyway);
    // Alice reviews it in Studio and accepts it, which commits revision 2 authored by the agent on her behalf.
    expect(agentOpsRes.status).toBe(200);
    const proposed = (await agentOpsRes.json()) as { status?: string; proposalId?: string; revision: number };
    expect(proposed.status).toBe("pending");
    expect(proposed.revision).toBe(1);
    const acceptRes = await callStudio(
      `/api/projects/${projectSlug}/proposals/${proposed.proposalId}/accept`,
      { cookie: aliceCookie, body: {} },
    );
    expect(acceptRes.status).toBe(200);
    const rev2 = (await acceptRes.json()) as ProjectStatePayload;
    expect(rev2.revision).toBe(2);
    expect(rev2.author).toEqual({
      type: "agent",
      id: issuedTokenBody.id,
      client: "claude-code",
      onBehalfOf: signUpData.user.id,
    });

    // Verify GitHub OAuth start route is mounted and configured on /api/auth/sign-in/social
    const ghStartRes = await callStudio("/api/auth/sign-in/social", {
      body: {
        provider: "github",
        callbackURL: "https://example.test/studio",
      },
    });
    expect(ghStartRes.status).toBe(200);
    const ghStartBody = (await ghStartRes.json()) as { url: string; redirect: boolean };
    expect(ghStartBody.redirect).toBe(true);
    expect(ghStartBody.url).toContain("github.com/login/oauth/authorize");
    expect(ghStartBody.url).toContain("client_id=studio-gh-test-client-id");

    // Verify studio_audit_log recorded org.create, project.create, org.mcp_token.create, and 2 project.ops mutations
    const auditRows = await studioDb
      .prepare(
        "SELECT action, actor_type, actor_id, status FROM studio_audit_log WHERE org_id = ? ORDER BY created_at ASC",
      )
      .bind(acmeOrgId)
      .all<{ action: string; actor_type: string; actor_id: string; status: string }>();
    const actions = (auditRows.results ?? []).map((r) => `${r.action}:${r.status}`);
    expect(actions).toEqual([
      "org.create:succeeded",
      "project.create:succeeded",
      "project.ops:succeeded",
      "org.mcp_token.create:succeeded",
      // AD-V8: the token's edit is a proposal, which Alice then accepts in Studio.
      "project.proposal.create:succeeded",
      "project.proposal.accept:succeeded",
    ]);
  });

  test("2. unauthenticated requests, forged/expired session cookies, and revoked MCP tokens return 401 Unauthorized (AC 2, AC 3, AC 5)", async () => {
    // Unauthenticated requests to /api/projects and /api/orgs return 401
    expect((await callStudio("/api/projects")).status).toBe(401);
    expect((await callStudio("/api/projects/any-project")).status).toBe(401);
    expect((await callStudio("/api/orgs")).status).toBe(401);
    expect((await callStudioMcp("list_bricks", {})).status).toBe(401);

    // Sign up Bob and create an org + MCP token
    const bobSignUp = await callStudio("/api/auth/signup", {
      body: {
        email: "bob@studio.test",
        password: "bob-password-12345",
        displayName: "Bob",
      },
    });
    expect(bobSignUp.status).toBe(201);
    const bobCookie = (bobSignUp.headers.get("set-cookie") ?? "").split(";")[0]!;
    const bobData = (await bobSignUp.json()) as { token: string; user: { id: string } };

    const orgRes = await callStudio("/api/orgs", {
      cookie: bobCookie,
      body: { name: "Bob Org", slug: "bob-org" },
    });
    expect(orgRes.status).toBe(201);
    const bobOrgId = ((await orgRes.json()) as { id: string }).id;

    // Issue MCP token (bound to Bob's project, story 0.15)
    const bobProjRes = await callStudio(`/api/orgs/${bobOrgId}/projects`, {
      cookie: bobCookie,
      body: { project: "bob-proj" },
    });
    expect(bobProjRes.status).toBe(201);
    const mcpTokenRes = await callStudio(`/api/orgs/${bobOrgId}/mcp-tokens`, {
      cookie: bobCookie,
      body: { clientName: "cursor", projectId: "bob-proj" },
    });
    expect(mcpTokenRes.status).toBe(201);
    const mcpTokenData = (await mcpTokenRes.json()) as { token: string; id: string };

    // Valid MCP token works before revocation
    expect((await callStudio("/api/orgs", { token: mcpTokenData.token })).status).toBe(200);

    // Forged session cookie returns 401
    const forgedCookie = `${bobCookie.slice(0, -6)}FORGED`;
    expect((await callStudio("/api/orgs", { cookie: forgedCookie })).status).toBe(401);
    expect((await callStudio("/api/projects/bob-proj", { cookie: forgedCookie })).status).toBe(401);

    // Forged MCP token returns 401
    expect(
      (await callStudio("/api/projects/bob-proj", { token: "px_mcp_00000000000000000000" })).status,
    ).toBe(401);
    expect(
      (await callStudioMcp("list_bricks", {}, { token: "px_mcp_00000000000000000000" })).status,
    ).toBe(401);

    // Revoke MCP token via DELETE /api/orgs/:orgId/mcp-tokens/:tokenId -> subsequent calls return 401
    const revokeRes = await callStudio(
      `/api/orgs/${bobOrgId}/mcp-tokens/${mcpTokenData.id}`,
      {
        method: "DELETE",
        cookie: bobCookie,
      },
    );
    expect(revokeRes.status).toBe(200);

    expect((await callStudio("/api/orgs", { token: mcpTokenData.token })).status).toBe(401);
    expect(
      (await callStudio("/api/projects/bob-proj", { token: mcpTokenData.token })).status,
    ).toBe(401);
    expect(
      (
        await callStudioMcp(
          "apply_ops",
          {
            project: "bob-proj",
            ops: [{ opId: "revoked-1", type: "enable_brick", brickId: "multi-workspace" }],
          },
          { token: mcpTokenData.token },
        )
      ).status,
    ).toBe(401);

    // Expire Bob's session in D1 -> session cookie and bearer token both return 401
    // (story 0.14: the session row holds sha256(token), not the token)
    const expired = await studioDb
      .prepare('UPDATE "session" SET "expiresAt" = ? WHERE "token" = ?')
      .bind("2000-01-01T00:00:00.000Z", await sha256HexString(bobData.token))
      .run();
    expect(expired.meta.changes).toBe(1);

    expect((await callStudio("/api/orgs", { cookie: bobCookie })).status).toBe(401);
    expect((await callStudio("/api/orgs", { token: bobData.token })).status).toBe(401);
    expect((await callStudio("/api/projects/bob-proj", { cookie: bobCookie })).status).toBe(401);
  });

  test("3. user in Org A cannot read, subscribe to WebSocket, or mutate a project in Org B (403/404) with zero cross-org leakage (AC 3, AC 4, AC 5)", async () => {
    // Sign up Org A user (Alice) and Org B user (Bob)
    const aliceRes = await callStudio("/api/auth/signup", {
      body: { email: "alice-orga@studio.test", password: "password-alice-123" },
    });
    const aliceToken = ((await aliceRes.json()) as { token: string }).token;

    const bobRes = await callStudio("/api/auth/signup", {
      body: { email: "bob-orgb@studio.test", password: "password-bob-123" },
    });
    const bobToken = ((await bobRes.json()) as { token: string }).token;

    // Create Org A and Org B
    const orgARes = await callStudio("/api/orgs", {
      token: aliceToken,
      body: { name: "Org Alpha", slug: "org-alpha" },
    });
    const orgAId = ((await orgARes.json()) as { id: string }).id;

    const orgBRes = await callStudio("/api/orgs", {
      token: bobToken,
      body: { name: "Org Beta", slug: "org-beta" },
    });
    const orgBId = ((await orgBRes.json()) as { id: string }).id;

    // Bob creates and populates project "beta-secret-app" in Org B
    const createBetaProj = await callStudio(`/api/orgs/${orgBId}/projects`, {
      token: bobToken,
      body: { project: "beta-secret-app" },
    });
    expect(createBetaProj.status).toBe(201);

    const bobMutate = await callStudio("/api/projects/beta-secret-app/ops", {
      token: bobToken,
      body: {
        ops: [
          { opId: "beta-op-1", type: "enable_brick", brickId: "multi-workspace" },
          { opId: "beta-op-2", type: "enable_brick", brickId: "credit-wallet" },
        ],
      },
    });
    expect(bobMutate.status).toBe(200);

    // Issue MCP token in Org A for Alice, bound to Org A's own project (story 0.15)
    const alphaProjRes = await callStudio(`/api/orgs/${orgAId}/projects`, {
      token: aliceToken,
      body: { project: "alpha-own-app" },
    });
    expect(alphaProjRes.status).toBe(201);
    const orgAMcpRes = await callStudio(`/api/orgs/${orgAId}/mcp-tokens`, {
      token: aliceToken,
      body: { clientName: "claude-code", projectId: "alpha-own-app" },
    });
    expect(orgAMcpRes.status).toBe(201);
    const orgAMcpToken = ((await orgAMcpRes.json()) as { token: string }).token;

    // Alice (Org A) cannot see Org B's project in GET /api/projects
    const aliceListRes = await callStudio("/api/projects", { token: aliceToken });
    expect(aliceListRes.status).toBe(200);
    // Only Org A's own project is listed; nothing of Org B's.
    expect(
      ((await aliceListRes.json()) as { projects: Array<{ project: string }> }).projects.map(
        (p) => p.project,
      ),
    ).toEqual(["alpha-own-app"]);

    // Alice (Org A) cannot read state, revisions, diff, or export of Org B's project -> 403/404
    for (const readPath of [
      "/api/projects/beta-secret-app",
      "/api/projects/beta-secret-app/revisions",
      "/api/projects/beta-secret-app/revisions/1",
      "/api/projects/beta-secret-app/diff?from=0&to=1",
      "/api/projects/beta-secret-app/export",
      "/api/projects/beta-secret-app/snapshots",
    ]) {
      const res = await callStudio(readPath, { token: aliceToken });
      expect([403, 404]).toContain(res.status);
    }

    // Alice (Org A) cannot subscribe to WebSocket of Org B's project -> 403/404
    const aliceWsRes = await callStudio("/api/projects/beta-secret-app/ws", {
      token: aliceToken,
      headers: { Upgrade: "websocket" },
    });
    expect([403, 404]).toContain(aliceWsRes.status);

    // Alice (Org A) cannot mutate Org B's project via POST /ops, /revert, /import, /build, or MCP apply_ops -> 403/404
    const aliceOpsRes = await callStudio("/api/projects/beta-secret-app/ops", {
      token: aliceToken,
      body: {
        ops: [{ opId: "intrude-1", type: "remove_brick", brickId: "credit-wallet" }],
      },
    });
    expect([403, 404]).toContain(aliceOpsRes.status);

    const aliceRevertRes = await callStudio("/api/projects/beta-secret-app/revert", {
      token: aliceToken,
      body: { targetRevision: 0 },
    });
    expect([403, 404]).toContain(aliceRevertRes.status);

    const aliceImportRes = await callStudio("/api/projects/beta-secret-app/import", {
      token: aliceToken,
      body: { bundle: JSON.parse(aiCreditsPresetRaw) },
    });
    expect([403, 404]).toContain(aliceImportRes.status);

    const aliceBuildRes = await callStudio("/api/projects/beta-secret-app/build", {
      method: "POST",
      token: aliceToken,
    });
    expect([403, 404]).toContain(aliceBuildRes.status);

    const aliceMcpMutate = await callStudioMcp(
      "apply_ops",
      {
        project: "beta-secret-app",
        ops: [{ opId: "intrude-mcp", type: "remove_brick", brickId: "credit-wallet" }],
      },
      { token: orgAMcpToken },
    );
    expect([403, 404]).toContain(aliceMcpMutate.status);

    // Verify Org B's project is still untouched at revision 1
    const bobCheckRes = await callStudio("/api/projects/beta-secret-app", { token: bobToken });
    expect(bobCheckRes.status).toBe(200);
    expect(((await bobCheckRes.json()) as ProjectStatePayload).revision).toBe(1);
  });

  test("4. viewer member can read project state and subscribe to WebSocket, but POST /ops, POST /revert, POST /import, and MCP apply_ops return 403 Forbidden (FORBIDDEN_ROLE) and write an audit-log entry (AC 3, AC 4, AC 5)", async () => {
    // Sign up Owner (Olivia), Builder (Ben, invited as 'editor' alias -> mapped to 'builder'), and Viewer (Vera)
    const oliviaRes = await callStudio("/api/auth/signup", {
      body: { email: "olivia@studio.test", password: "olivia-password-123" },
    });
    const olivia = (await oliviaRes.json()) as { token: string; user: { id: string } };

    const benRes = await callStudio("/api/auth/signup", {
      body: { email: "ben@studio.test", password: "ben-password-123" },
    });
    const ben = (await benRes.json()) as { token: string; user: { id: string } };

    const veraRes = await callStudio("/api/auth/signup", {
      body: { email: "vera@studio.test", password: "vera-password-123" },
    });
    const vera = (await veraRes.json()) as { token: string; user: { id: string } };
    const veraCookie = (veraRes.headers.get("set-cookie") ?? "").split(";")[0]!;

    // Olivia creates Org
    const createOrgRes = await callStudio("/api/orgs", {
      token: olivia.token,
      body: { name: "RBAC Studio Org", slug: "rbac-studio" },
    });
    expect(createOrgRes.status).toBe(201);
    const orgId = ((await createOrgRes.json()) as { id: string }).id;

    // Olivia invites Ben as "editor" (verified mapped to "builder") and Vera as "viewer"
    const addBenRes = await callStudio(`/api/orgs/${orgId}/members`, {
      token: olivia.token,
      body: { userId: ben.user.id, role: "editor" },
    });
    expect(addBenRes.status).toBe(201);
    expect(((await addBenRes.json()) as { role: string }).role).toBe("builder");

    const addVeraRes = await callStudio(`/api/orgs/${orgId}/members`, {
      token: olivia.token,
      body: { userId: vera.user.id, role: "viewer" },
    });
    expect(addVeraRes.status).toBe(201);
    expect(((await addVeraRes.json()) as { role: string }).role).toBe("viewer");

    // Ben (builder) creates project "rbac-workflow-app" and applies revision 1 and revision 2
    const createProjRes = await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ben.token,
      body: { project: "rbac-workflow-app" },
    });
    expect(createProjRes.status).toBe(201);

    // Olivia issues a scoped MCP token on behalf of Vera (the viewer), bound to this project (story 0.15)
    const veraMcpTokenRes = await callStudio(`/api/orgs/${orgId}/mcp-tokens`, {
      token: olivia.token,
      body: {
        userId: vera.user.id,
        clientName: "claude-code",
        projectId: "rbac-workflow-app",
        scopes: ["read", "edit"],
      },
    });
    expect(veraMcpTokenRes.status).toBe(201);
    const veraMcp = (await veraMcpTokenRes.json()) as { token: string; id: string };

    const benRev1 = await callStudio("/api/projects/rbac-workflow-app/ops", {
      token: ben.token,
      body: {
        summary: "Enable multi-workspace",
        ops: [{ opId: "rbac-1", type: "enable_brick", brickId: "multi-workspace" }],
      },
    });
    expect(benRev1.status).toBe(200);

    const benRev2 = await callStudio("/api/projects/rbac-workflow-app/ops", {
      token: ben.token,
      body: {
        summary: "Enable credit-wallet",
        ops: [{ opId: "rbac-2", type: "enable_brick", brickId: "credit-wallet" }],
      },
    });
    expect(benRev2.status).toBe(200);

    // Vera (viewer) CAN read project state, revisions, diff, and export (200 OK)
    const veraGetState = await callStudio("/api/projects/rbac-workflow-app", {
      cookie: veraCookie,
    });
    expect(veraGetState.status).toBe(200);
    const veraStateBody = (await veraGetState.json()) as ProjectStatePayload;
    expect(veraStateBody.revision).toBe(2);

    const veraGetRevs = await callStudio("/api/projects/rbac-workflow-app/revisions", {
      cookie: veraCookie,
    });
    expect(veraGetRevs.status).toBe(200);

    const veraGetDiff = await callStudio(
      "/api/projects/rbac-workflow-app/diff?from=1&to=2",
      { cookie: veraCookie },
    );
    expect(veraGetDiff.status).toBe(200);

    // Vera (viewer) CAN subscribe to WebSocket (/api/projects/:project/ws -> 101 Switching Protocols)
    const veraWsRes = await callStudio("/api/projects/rbac-workflow-app/ws", {
      cookie: veraCookie,
      headers: { Upgrade: "websocket" },
    });
    expect(veraWsRes.status).toBe(101);
    expect(veraWsRes.webSocket).toBeDefined();
    veraWsRes.webSocket?.accept();
    veraWsRes.webSocket?.close(1000, "done");

    // Count audit log entries before Vera's forbidden mutation attempts
    const beforeAudit = await studioDb
      .prepare("SELECT COUNT(*) AS n FROM studio_audit_log WHERE org_id = ?")
      .bind(orgId)
      .first<{ n: number }>();
    const countBefore = Number(beforeAudit?.n ?? 0);

    // 4a. Vera (viewer) attempting POST /ops -> 403 Forbidden with FORBIDDEN_ROLE
    const veraOpsRes = await callStudio("/api/projects/rbac-workflow-app/ops", {
      cookie: veraCookie,
      body: {
        ops: [{ opId: "vera-forbidden-op", type: "remove_brick", brickId: "credit-wallet" }],
      },
    });
    expect(veraOpsRes.status).toBe(403);
    expect(await veraOpsRes.json()).toEqual({
      error: {
        code: "FORBIDDEN_ROLE",
        message: "Viewer role cannot mutate project",
      },
    });

    // 4b. Vera (viewer) attempting POST /revert -> 403 Forbidden with FORBIDDEN_ROLE
    const veraRevertRes = await callStudio("/api/projects/rbac-workflow-app/revert", {
      cookie: veraCookie,
      body: { targetRevision: 1 },
    });
    expect(veraRevertRes.status).toBe(403);
    expect(await veraRevertRes.json()).toEqual({
      error: {
        code: "FORBIDDEN_ROLE",
        message: "Viewer role cannot mutate project",
      },
    });

    // 4c. Vera (viewer) attempting POST /import -> 403 Forbidden with FORBIDDEN_ROLE
    const veraImportRes = await callStudio("/api/projects/rbac-workflow-app/import", {
      cookie: veraCookie,
      body: { bundle: JSON.parse(aiCreditsPresetRaw), mode: "replace" },
    });
    expect(veraImportRes.status).toBe(403);
    expect(await veraImportRes.json()).toEqual({
      error: {
        code: "FORBIDDEN_ROLE",
        message: "Viewer role cannot mutate project",
      },
    });

    // 4d. Vera (viewer) attempting MCP apply_ops (via her scoped MCP token) -> 403 Forbidden with FORBIDDEN_ROLE
    const veraMcpApply = await callStudioMcp(
      "apply_ops",
      {
        project: "rbac-workflow-app",
        ops: [{ opId: "vera-mcp-forbidden", type: "remove_brick", brickId: "credit-wallet" }],
      },
      { token: veraMcp.token },
    );
    expect(veraMcpApply.status).toBe(403);
    expect(veraMcpApply.body.error).toEqual({
      code: "FORBIDDEN_ROLE",
      message: "Viewer role cannot mutate project",
    });

    // Verify all 4 forbidden mutation attempts wrote entries to studio_audit_log
    const forbiddenLogs = await studioDb
      .prepare(
        `SELECT project_id, actor_type, actor_id, action, status, details_json
         FROM studio_audit_log
         WHERE org_id = ? AND status = 'forbidden'
         ORDER BY rowid ASC`,
      )
      .bind(orgId)
      .all<{
        project_id: string;
        actor_type: string;
        actor_id: string;
        action: string;
        status: string;
        details_json: string;
      }>();

    const rows = forbiddenLogs.results ?? [];
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.action)).toEqual([
      "project.ops",
      "project.revert",
      "project.import",
      "mcp.apply_ops",
    ]);
    expect(rows[0]).toMatchObject({
      project_id: "rbac-workflow-app",
      actor_type: "human",
      actor_id: vera.user.id,
      action: "project.ops",
      status: "forbidden",
    });
    expect(rows[3]).toMatchObject({
      project_id: "rbac-workflow-app",
      actor_type: "agent",
      actor_id: veraMcp.id,
      action: "mcp.apply_ops",
      status: "forbidden",
    });

    const afterAudit = await studioDb
      .prepare("SELECT COUNT(*) AS n FROM studio_audit_log WHERE org_id = ?")
      .bind(orgId)
      .first<{ n: number }>();
    expect(Number(afterAudit?.n ?? 0)).toBe(countBefore + 4);

    // Verify project state was not modified by any of Vera's attempts (still at revision 2)
    const finalStateRes = await callStudio("/api/projects/rbac-workflow-app", {
      cookie: veraCookie,
    });
    expect(finalStateRes.status).toBe(200);
    const finalState = (await finalStateRes.json()) as ProjectStatePayload;
    expect(finalState.revision).toBe(2);
    expect(finalState.state.bricks.map((b) => b.id)).toEqual([
      "credit-wallet",
      "multi-workspace",
    ]);
  });
});
