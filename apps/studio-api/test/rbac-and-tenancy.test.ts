import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { app as studioApp, createStudioApiApp, ensureDefaultTestAuth, ensureStudioD1Schema } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";

const studioEnv = env as unknown as StudioApiEnv;

async function signupUser(
  email: string,
  name: string,
  _orgName: string,
): Promise<{
  sessionToken: string;
  cookie: string;
  userId: string;
  orgId: string;
}> {
  const res = await studioApp.request(
    "/api/auth/signup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Password123!",
        name,
      }),
    },
    studioEnv,
  );
  expect(res.status).toBe(201);
  const setCookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const body = (await res.json()) as {
    token: string;
    user: { id: string };
  };
  return {
    sessionToken: body.token,
    cookie: setCookie || `better-auth.session_token=${body.token}`,
    userId: body.user.id,
    orgId: `org_personal_${body.user.id}`,
  };
}

function materializeRoutePath(routePath: string): string {
  return routePath
    .replace(":orgId", "org_route_scan")
    .replace(":userId", "usr_route_scan")
    .replace(":tokenId", "tok_route_scan")
    .replace(":tokenRef", "cf_tok_route_scan")
    .replace(":project", "proj-route-scan")
    .replace(":proposalId", "prop_route_scan")
    .replace(":workflowId", "wf_route_scan")
    .replace(":nodeId", "node_route_scan")
    .replace(":runId", "run_route_scan")
    .replace(":key", "STRIPE_SECRET_KEY")
    .replace(":app", "slack")
    .replace(":ref", "conn_slack_default")
    .replace(":envName", "preview")
    .replace(":table", "users")
    .replace(":pk", "1");
}

function isIntentionallyPublicRoute(method: string, path: string): boolean {
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return true;
  if (method === "GET" && (path === "/api/catalog" || path === "/api/templates")) {
    return true;
  }
  if (path === "/api/integrations/:app/oauth/callback" || path === "/api/connections/oauth/:app/callback") {
    return true;
  }
  // Telemetry & log ingestion endpoints use x-px-telemetry-signature HMAC rather than session cookies
  if (method === "POST" && (path === "/api/projects/:project/telemetry" || path === "/api/projects/:project/environments/:envName/logs")) {
    return true;
  }
  return false;
}

describe("Story 8.2 — Cross-Org Isolation, Route Scanner & RBAC / MCP Scope Matrix (AC 1)", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioEnv.STUDIO_DB);
    await ensureDefaultTestAuth(studioEnv);
  });

  test("Automated route scanner: every control-plane route in apps/studio-api rejects unauthenticated callers with 401", async () => {
    const app = createStudioApiApp();
    const seen = new Set<string>();
    const checkedRoutes: string[] = [];

    for (const r of app.routes) {
      const method = r.method.toUpperCase();
      if (method === "ALL" || method === "OPTIONS" || method === "HEAD") {
        continue;
      }
      const key = `${method} ${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (isIntentionallyPublicRoute(method, r.path)) {
        continue;
      }

      const concretePath = materializeRoutePath(r.path);
      const init: RequestInit = { method };
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify({});
      }

      const res = await studioApp.request(concretePath, init, studioEnv);
      expect(res.status, `Expected 401 for unauthenticated ${key} (${concretePath}), got ${res.status}`).toBe(401);
      checkedRoutes.push(key);
    }

    expect(checkedRoutes.length).toBeGreaterThan(80);
  });

  test("Cross-org isolation: authenticated member of Org A is rejected (403 FORBIDDEN_ORG) on every Org B project, connection, secret, deploy token, environment, run, log, audit log, WebSocket, and MCP tool", async () => {
    const suffix = Date.now().toString(36);
    const userA = await signupUser(`alice-${suffix}@orga.example.com`, "Alice OrgA", `Org Alpha ${suffix}`);
    const userB = await signupUser(`bob-${suffix}@orgb.example.com`, "Bob OrgB", `Org Beta ${suffix}`);

    const projectB = `org-b-private-${suffix}`;

    // Org B initializes its project by mutating it
    const initBRes = await studioApp.request(
      `/api/projects/${projectB}/ops`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${userB.sessionToken}`,
          "x-org-id": userB.orgId,
        },
        body: JSON.stringify({
          ops: [{ opId: "b-1", type: "enable_brick", brickId: "multi-workspace" }],
        }),
      },
      studioEnv,
    );
    expect(initBRes.status).toBe(200);

    // Org B stores a secret and a connection
    const secretBRes = await studioApp.request(
      `/api/projects/${projectB}/secrets`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${userB.sessionToken}`,
          "x-org-id": userB.orgId,
        },
        body: JSON.stringify({
          ref: "stripe_secret_key",
          label: "Stripe Secret Key",
          value: "sk_test_org_b_secret_value_123456",
        }),
      },
      studioEnv,
    );
    expect([200, 201]).toContain(secretBRes.status);

    const connBRes = await studioApp.request(
      `/api/projects/${projectB}/connections`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${userB.sessionToken}`,
          "x-org-id": userB.orgId,
        },
        body: JSON.stringify({
          ref: "conn_slack_default",
          app: "slack",
          authType: "apiKey",
          value: "xox" + "b-org-b-secret-token-999999",
        }),
      },
      studioEnv,
    );
    expect([200, 201]).toContain(connBRes.status);

    // Org A member attempts to access Org B's resources across all surfaces
    const orgAHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${userA.sessionToken}`,
      "x-org-id": userA.orgId,
    };

    const crossOrgChecks: Array<{
      label: string;
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }> = [
      { label: "get project", method: "GET", path: `/api/projects/${projectB}` },
      {
        label: "apply ops",
        method: "POST",
        path: `/api/projects/${projectB}/ops`,
        body: { ops: [{ opId: "a-1", type: "disable_brick", brickId: "multi-workspace" }] },
      },
      {
        label: "list revisions",
        method: "GET",
        path: `/api/projects/${projectB}/revisions`,
      },
      {
        label: "list proposals",
        method: "GET",
        path: `/api/projects/${projectB}/proposals`,
      },
      {
        label: "list secrets",
        method: "GET",
        path: `/api/projects/${projectB}/secrets`,
      },
      {
        label: "put secret",
        method: "POST",
        path: `/api/projects/${projectB}/secrets`,
        body: {
          ref: "stripe_secret_key",
          label: "Stripe Secret Key",
          value: "sk_test_hijack_attempt",
        },
      },
      {
        label: "list connections",
        method: "GET",
        path: `/api/projects/${projectB}/connections`,
      },
      {
        label: "delete connection",
        method: "DELETE",
        path: `/api/projects/${projectB}/connections/conn_slack_default`,
      },
      {
        label: "list environments",
        method: "GET",
        path: `/api/projects/${projectB}/environments`,
      },
      {
        label: "deploy environment",
        method: "POST",
        path: `/api/projects/${projectB}/environments/preview/deploy`,
        body: {},
      },
      {
        label: "list runs",
        method: "GET",
        path: `/api/projects/${projectB}/runs`,
      },
      {
        label: "query logs",
        method: "GET",
        path: `/api/projects/${projectB}/environments/preview/logs`,
      },
      {
        label: "data browser tables",
        method: "GET",
        path: `/api/projects/${projectB}/environments/preview/data/tables`,
      },
      {
        label: "get retention settings",
        method: "GET",
        path: `/api/projects/${projectB}/settings/retention`,
      },
      {
        label: "update retention settings",
        method: "PUT",
        path: `/api/projects/${projectB}/settings/retention`,
        body: { runRetentionDays: 3 },
      },
      {
        label: "project audit logs",
        method: "GET",
        path: `/api/projects/${projectB}/audit-logs`,
      },
      {
        label: "org B audit logs",
        method: "GET",
        path: `/api/orgs/${userB.orgId}/audit-logs`,
      },
      {
        label: "org B details",
        method: "GET",
        path: `/api/orgs/${userB.orgId}`,
      },
      {
        label: "org B add member",
        method: "POST",
        path: `/api/orgs/${userB.orgId}/members`,
        body: { email: `intruder-${suffix}@orga.example.com`, role: "editor" },
      },
      {
        label: "org B cloudflare tokens",
        method: "GET",
        path: `/api/orgs/${userB.orgId}/cloudflare-tokens`,
      },
      {
        label: "org B delete",
        method: "DELETE",
        path: `/api/orgs/${userB.orgId}`,
      },
    ];

    for (const check of crossOrgChecks) {
      const res = await studioApp.request(
        check.path,
        {
          method: check.method,
          headers: orgAHeaders,
          ...(check.body ? { body: JSON.stringify(check.body) } : {}),
        },
        studioEnv,
      );
      expect(res.status, `Expected 403 for cross-org ${check.label} (${check.method} ${check.path}), got ${res.status}`).toBe(403);
    }

    // Cross-org WebSocket upgrade via studio-api and BlueprintDO directly
    const wsApiRes = await studioApp.request(
      `/api/projects/${projectB}/ws`,
      {
        headers: {
          Upgrade: "websocket",
          authorization: `Bearer ${userA.sessionToken}`,
          "x-org-id": userA.orgId,
        },
      },
      studioEnv,
    );
    expect(wsApiRes.status).toBe(403);

    const doStub = studioEnv.BLUEPRINT_DO.get(studioEnv.BLUEPRINT_DO.idFromName(projectB));
    const doCrossOrgRes = await doStub.fetch(`https://blueprint.internal/ws?project=${encodeURIComponent(projectB)}`, {
      headers: {
        Upgrade: "websocket",
        "x-studio-org-id": userA.orgId,
      },
    });
    expect(doCrossOrgRes.status).toBe(403);

    // Cross-org MCP tool call using an Org A MCP token against Org B's project. Story 0.15: the token is bound to Org A's
    // own project, so Org A initializes one first.
    const projectA = `org-a-own-${suffix}`;
    const initARes = await studioApp.request(
      `/api/projects/${projectA}/ops`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${userA.sessionToken}`,
          "x-org-id": userA.orgId,
        },
        body: JSON.stringify({
          ops: [{ opId: "a-1", type: "enable_brick", brickId: "multi-workspace" }],
        }),
      },
      studioEnv,
    );
    expect(initARes.status).toBe(200);
    const mcpTokenARes = await studioApp.request(
      `/api/orgs/${userA.orgId}/mcp-tokens`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${userA.sessionToken}`,
          "x-org-id": userA.orgId,
        },
        body: JSON.stringify({
          name: "org-a-agent",
          projectId: projectA,
          scopes: ["read", "edit", "deploy", "connect"],
        }),
      },
      studioEnv,
    );
    expect(mcpTokenARes.status).toBe(201);
    const { token: mcpTokenA } = (await mcpTokenARes.json()) as { token: string };

    const mcpCrossOrgRes = await studioApp.request(
      "/api/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${mcpTokenA}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_blueprint_summary",
            arguments: { project: projectB },
          },
        }),
      },
      studioEnv,
    );
    expect(mcpCrossOrgRes.status).toBe(403);
    const mcpCrossOrgBody = (await mcpCrossOrgRes.json()) as {
      error: { code?: string; data?: { code?: string } };
    };
    expect(mcpCrossOrgBody.error.code ?? mcpCrossOrgBody.error.data?.code).toBe("FORBIDDEN_ORG");
  });

  test("RBAC role matrix (owner, editor, builder, viewer) and MCP OAuth 2.1 scope enforcement (read, edit, deploy, connect)", async () => {
    const suffix = Date.now().toString(36);
    const owner = await signupUser(`owner-${suffix}@rbac.example.com`, "Owner User", `RBAC Org ${suffix}`);
    const editor = await signupUser(`editor-${suffix}@rbac.example.com`, "Editor User", `Personal Editor ${suffix}`);
    const builder = await signupUser(`builder-${suffix}@rbac.example.com`, "Builder User", `Personal Builder ${suffix}`);
    const viewer = await signupUser(`viewer-${suffix}@rbac.example.com`, "Viewer User", `Personal Viewer ${suffix}`);

    // Owner adds editor, builder, and viewer to owner.orgId
    for (const [email, role] of [
      [`editor-${suffix}@rbac.example.com`, "editor"],
      [`builder-${suffix}@rbac.example.com`, "builder"],
      [`viewer-${suffix}@rbac.example.com`, "viewer"],
    ] as const) {
      const addRes = await studioApp.request(
        `/api/orgs/${owner.orgId}/members`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${owner.sessionToken}`,
            "x-org-id": owner.orgId,
          },
          body: JSON.stringify({ email, role }),
        },
        studioEnv,
      );
      expect(addRes.status).toBe(201);
    }

    const project = `rbac-matrix-proj-${suffix}`;

    // 1. Owner initializes project
    const ownerOpsRes = await studioApp.request(
      `/api/projects/${project}/ops`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
          "x-org-id": owner.orgId,
        },
        body: JSON.stringify({
          ops: [
            { opId: "o-1", type: "enable_brick", brickId: "multi-workspace" },
            { opId: "o-2", type: "enable_brick", brickId: "dynamic-entities" },
          ],
        }),
      },
      studioEnv,
    );
    expect(ownerOpsRes.status).toBe(200);

    // 2. Editor and Builder can both mutate blueprints & retention settings
    const editorOpsRes = await studioApp.request(
      `/api/projects/${project}/ops`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${editor.sessionToken}`,
          "x-org-id": owner.orgId,
        },
        body: JSON.stringify({
          ops: [{ opId: "e-1", type: "configure_brick", brickId: "multi-workspace", config: {} }],
        }),
      },
      studioEnv,
    );
    expect(editorOpsRes.status).toBe(200);

    const builderRetentionRes = await studioApp.request(
      `/api/projects/${project}/settings/retention`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${builder.sessionToken}`,
          "x-org-id": owner.orgId,
        },
        body: JSON.stringify({
          runRetentionDays: 21,
          telemetryRetentionDays: 10,
          captureStepIoInProd: false,
          additionalRedactKeys: ["customer_ssn"],
        }),
      },
      studioEnv,
    );
    expect(builderRetentionRes.status).toBe(200);

    // 3. Editor cannot delete the organization or escalate a member to owner (403 FORBIDDEN_ROLE)
    const editorDeleteOrgRes = await studioApp.request(
      `/api/orgs/${owner.orgId}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${editor.sessionToken}`,
          "x-org-id": owner.orgId,
        },
      },
      studioEnv,
    );
    expect(editorDeleteOrgRes.status).toBe(403);

    const editorEscalateRes = await studioApp.request(
      `/api/orgs/${owner.orgId}/members/${viewer.userId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${editor.sessionToken}`,
          "x-org-id": owner.orgId,
        },
        body: JSON.stringify({ role: "owner" }),
      },
      studioEnv,
    );
    expect(editorEscalateRes.status).toBe(403);

    // 4. Viewer can read project, runs, retention settings, and audit logs, but is rejected (403 FORBIDDEN_ROLE) on all mutations
    const viewerHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${viewer.sessionToken}`,
      "x-org-id": owner.orgId,
    };

    const viewerGetProj = await studioApp.request(`/api/projects/${project}`, { headers: viewerHeaders }, studioEnv);
    expect(viewerGetProj.status).toBe(200);

    const viewerGetRetention = await studioApp.request(`/api/projects/${project}/settings/retention`, { headers: viewerHeaders }, studioEnv);
    expect(viewerGetRetention.status).toBe(200);

    const viewerGetAudit = await studioApp.request(`/api/projects/${project}/audit-logs`, { headers: viewerHeaders }, studioEnv);
    expect(viewerGetAudit.status).toBe(200);

    for (const mut of [
      {
        method: "POST",
        path: `/api/projects/${project}/ops`,
        body: { ops: [{ opId: "v-1", type: "disable_brick", brickId: "multi-workspace" }] },
      },
      {
        method: "POST",
        path: `/api/projects/${project}/secrets`,
        body: {
          ref: "stripe_secret_key",
          label: "Stripe Secret Key",
          value: "sk_test_viewer",
        },
      },
      {
        method: "PUT",
        path: `/api/projects/${project}/settings/retention`,
        body: { runRetentionDays: 5 },
      },
      {
        method: "POST",
        path: `/api/projects/${project}/environments/preview/deploy`,
        body: {},
      },
      {
        method: "DELETE",
        path: `/api/orgs/${owner.orgId}`,
      },
    ]) {
      const res = await studioApp.request(
        mut.path,
        {
          method: mut.method,
          headers: viewerHeaders,
          ...(mut.body ? { body: JSON.stringify(mut.body) } : {}),
        },
        studioEnv,
      );
      expect(res.status, `Expected 403 for viewer on ${mut.method} ${mut.path}`).toBe(403);
    }

    // 5. MCP OAuth 2.1 scope matrix: read vs edit vs deploy vs connect
    async function issueMcpToken(scopes: string[]): Promise<string> {
      const res = await studioApp.request(
        `/api/orgs/${owner.orgId}/mcp-tokens`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${owner.sessionToken}`,
            "x-org-id": owner.orgId,
          },
          body: JSON.stringify({
            name: `token-${scopes.join("-")}`,
            projectId: project,
            scopes,
          }),
        },
        studioEnv,
      );
      expect(res.status).toBe(201);
      const data = (await res.json()) as { token: string };
      return data.token;
    }

    async function callMcpWithToken(token: string, toolName: string, args: Record<string, unknown>): Promise<Response> {
      return studioApp.request(
        "/api/mcp",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: toolName, arguments: args },
          }),
        },
        studioEnv,
      );
    }

    const readOnlyToken = await issueMcpToken(["read"]);
    const editOnlyToken = await issueMcpToken(["read", "edit"]);
    const deployOnlyToken = await issueMcpToken(["read", "deploy"]);
    const connectOnlyToken = await issueMcpToken(["read", "connect"]);

    // readOnlyToken can read summary, cannot apply_ops, deploy_apply, or request_connection
    expect((await callMcpWithToken(readOnlyToken, "get_blueprint_summary", { project })).status).toBe(200);
    expect((await callMcpWithToken(readOnlyToken, "apply_ops", { project, ops: [] })).status).toBe(403);
    expect((await callMcpWithToken(readOnlyToken, "deploy_apply", { project, env: "preview" })).status).toBe(403);
    expect((await callMcpWithToken(readOnlyToken, "request_connection", { project, key: "STRIPE_SECRET_KEY" })).status).toBe(403);

    // editOnlyToken can apply_ops, cannot deploy_apply or request_connection
    expect(
      (
        await callMcpWithToken(editOnlyToken, "apply_ops", {
          project,
          ops: [{ opId: "mcp-e1", type: "configure_brick", brickId: "multi-workspace", config: {} }],
        })
      ).status,
    ).toBe(200);
    expect((await callMcpWithToken(editOnlyToken, "deploy_apply", { project, env: "preview" })).status).toBe(403);
    expect((await callMcpWithToken(editOnlyToken, "request_connection", { project, key: "STRIPE_SECRET_KEY" })).status).toBe(403);

    // deployOnlyToken can invoke deploy_apply (passes scope check), cannot apply_ops or request_connection
    expect((await callMcpWithToken(deployOnlyToken, "deploy_apply", { project, env: "preview" })).status).toBe(200);
    expect((await callMcpWithToken(deployOnlyToken, "apply_ops", { project, ops: [] })).status).toBe(403);
    expect((await callMcpWithToken(deployOnlyToken, "request_connection", { project, key: "STRIPE_SECRET_KEY" })).status).toBe(403);

    // connectOnlyToken can invoke request_connection, cannot apply_ops or deploy_apply
    expect((await callMcpWithToken(connectOnlyToken, "request_connection", { project, key: "STRIPE_SECRET_KEY" })).status).toBe(200);
    expect((await callMcpWithToken(connectOnlyToken, "apply_ops", { project, ops: [] })).status).toBe(403);
    expect((await callMcpWithToken(connectOnlyToken, "deploy_apply", { project, env: "preview" })).status).toBe(403);
  });
});
