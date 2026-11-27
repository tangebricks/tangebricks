import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { TOOLS } from "../src/index.ts";
import mcpMigrationSql from "../migrations/0001_mcp_server.sql?raw";
import { app as studioApp, encryptSecretValue, type StudioApiEnv } from "../../../apps/studio-api/src/index.ts";
import { ensureTestProjectToken } from "../../../apps/studio-api/test/project-token.ts";
import { acceptProposalAsOwner } from "../../../apps/studio-api/test/human-session.ts";

const studioEnv = env as unknown as StudioApiEnv;
const db = (env as unknown as { DB: D1Like }).DB;
const studioDb = studioEnv.STUDIO_DB as D1Like;

let rpcId = 1;

async function callStudioMcp(name: string, args: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  // Story 0.15: every MCP token is bound to one project; the call presents the token for the project it names.
  const project = typeof args.project === "string" ? args.project : "default-project";
  const { headers: authHeaders } = await ensureTestProjectToken(studioEnv, project);
  const res = await studioApp.request(
    "http://localhost/mcp",
    {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/json",
        "x-mcp-client-id": "agent:claude-code",
        "x-mcp-client-name": "claude-code",
        ...extraHeaders,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    },
    studioEnv,
  );
  expect(res.status).toBe(200);
  const rpc = (await res.json()) as {
    error?: { code: number; message: string };
    result?: {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
  };
  expect(rpc.error).toBeUndefined();
  const text = rpc.result?.content?.[0]?.text ?? "";
  return {
    isError: rpc.result?.isError === true,
    text,
    json: <T = Record<string, unknown>>() => JSON.parse(text) as T,
  };
}

describe("Story 7.1 — Evolved MCP Tool Surface & Dual-Surface Contract (AC 1, AC 2, AC 3, AC 5)", () => {
  beforeEach(async () => {
    await applyMigration(db, mcpMigrationSql);
  });

  it("registers and executes all 16 evolved AD-S13 MCP tools (AC 1, AC 2)", async () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "search_bricks",
      "get_brick",
      "search_nodes",
      "get_node",
      "get_blueprint_summary",
      "get_blueprint_slice",
      "validate_blueprint",
      "apply_ops",
      "request_connection",
      "list_connections",
      "test_workflow",
      "list_runs",
      "get_run_trace",
      "query_logs",
      "deploy_plan",
      "deploy_apply",
    ]);

    // 1. Discovery: search_bricks (paged <= 10, filters) & get_brick
    const bricksPage = (
      await callStudioMcp("search_bricks", {
        category: "billing",
        limit: 5,
      })
    ).json<{
      items: Array<{ id: string; summary: string; category: string; maturity: string }>;
      nextCursor: string | null;
    }>();
    expect(bricksPage.items.length).toBeGreaterThan(0);
    expect(bricksPage.items.length).toBeLessThanOrEqual(5);
    expect(bricksPage.items.map((b) => b.id)).toContain("credit-wallet");

    const brickDetail = (await callStudioMcp("get_brick", { id: "credit-wallet" })).json<{ id: string; provides: string[]; needs: string[] }>();
    expect(brickDetail.id).toBe("credit-wallet");
    expect(brickDetail.needs).toContain("workspace-context");

    // 2. Discovery: search_nodes (paged <= 10, filters) & get_node
    const nodesPage = (
      await callStudioMcp("search_nodes", {
        source: "core",
        limit: 5,
      })
    ).json<{
      items: Array<{
        type: string;
        name: string;
        role: string;
        source: string;
        app: string;
      }>;
      nextCursor: string | null;
    }>();
    expect(nodesPage.items.length).toBeGreaterThan(0);
    expect(nodesPage.items.length).toBeLessThanOrEqual(5);
    expect(nodesPage.items.every((n) => n.source === "core")).toBe(true);

    const firstNodeType = nodesPage.items[0]!.type;
    const nodeDetail = (await callStudioMcp("get_node", { type: firstNodeType })).json<{
      type: string;
      role: string;
      source: string;
      inputs: unknown[];
      outputs: unknown[];
    }>();
    expect(nodeDetail.type).toBe(firstNodeType);
    expect(Array.isArray(nodeDetail.inputs)).toBe(true);

    // 3. Blueprint mutate: apply_ops with safety annotations & metadata
    const project = "cp7-surface-p1";
    const applyReply = await callStudioMcp("apply_ops", {
      project,
      expectedRev: 0,
      summary: "Enable bricks, entity, and workflow",
      ops: [
        { opId: "op-1", type: "enable_brick", brickId: "multi-workspace" },
        {
          opId: "op-2",
          type: "enable_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 10 },
        },
        { opId: "op-3", type: "enable_brick", brickId: "dynamic-entities" },
        {
          opId: "op-4",
          type: "add_entity",
          entity: {
            name: "invoices",
            fields: [
              { name: "client_name", type: "text", required: true },
              { name: "amount", type: "number", required: true },
            ],
          },
        },
        {
          opId: "op-5",
          type: "add_workflow",
          workflow: {
            id: "wf_invoice",
            name: "Invoice Workflow",
            trigger: { kind: "manual" },
            nodes: [
              {
                id: "n_trigger",
                type: "trigger.manual",
                data: {},
              },
              {
                id: "n_transform",
                type: "transform.pick",
                data: { path: "amount" },
              },
            ],
            edges: [
              {
                id: "e1",
                source: "n_trigger",
                target: "n_transform",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        },
        {
          opId: "op-6",
          type: "bind_secret_ref",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "STRIPE_API_KEY",
          ref: "sec_stripe_live",
        },
      ],
    });
    expect(applyReply.isError, applyReply.text).toBe(false);
    const applied = applyReply.json<{
      project: string;
      revision: number;
      status?: string;
      proposalId?: string;
      safety: {
        destructiveHint: boolean;
        moneyAffectingHint: boolean;
        moneyAffectingOps: string[];
      };
    }>();

    expect(applied.project).toBe(project);
    expect(applied.safety.moneyAffectingHint).toBe(true);
    expect(applied.safety.moneyAffectingOps).toContain("enable_brick:credit-wallet");
    // AD-V8: the agent's edit is a pending proposal (the live blueprint stays at 0) until a person accepts it in Studio.
    expect(applied.status).toBe("pending");
    expect(applied.revision).toBe(0);
    const acceptedRes = await acceptProposalAsOwner(studioEnv, project, applied.proposalId!);
    expect(acceptedRes.status).toBe(200);
    expect(((await acceptedRes.json()) as { revision: number }).revision).toBe(1);

    // 4. Blueprint read & validate: get_blueprint_summary, get_blueprint_slice, validate_blueprint
    const summary = (await callStudioMcp("get_blueprint_summary", { project })).json<{
      rev: number;
      bricks: string[];
      entities: string[];
      workflows: Array<{ id: string; nodeCount: number; edgeCount: number }>;
      needs: unknown[];
    }>();
    expect(summary.rev).toBe(1);
    expect(summary.bricks).toEqual(["credit-wallet", "dynamic-entities", "multi-workspace"]);
    expect(summary.entities).toEqual(["invoices"]);
    expect(summary.workflows).toEqual([
      {
        id: "wf_invoice",
        name: "Invoice Workflow",
        nodeCount: 2,
        edgeCount: 1,
      },
    ]);

    const slice = (
      await callStudioMcp("get_blueprint_slice", {
        project,
        workflowId: "wf_invoice",
        entityName: "invoices",
      })
    ).json<{
      rev: number;
      slice: {
        workflow: { id: string };
        entity: { name: string };
      };
    }>();
    expect(slice.rev).toBe(1);
    expect(slice.slice.workflow.id).toBe("wf_invoice");
    expect(slice.slice.entity.name).toBe("invoices");

    const validation = (await callStudioMcp("validate_blueprint", { project })).json<{
      rev: number;
      ready: boolean;
      needs: unknown[];
      issues: string[];
    }>();
    expect(validation.rev).toBe(1);
    expect(validation.issues).toEqual([]);
  });

  it("never accepts raw secret values in any MCP tool and scrubs planted credentials from list_connections, test_workflow, get_run_trace, and query_logs (AC 3)", async () => {
    const project = "cp7-secret-guard";
    const plantedStripeKey = "sk_" + "live_51PlantedSecretCredential999999999";
    const plantedWebhookSecret = "whs" + "ec_PlantedWebhookSecretValue888888888";

    const { headers: authHeaders, orgId, userId } = await ensureTestProjectToken(studioEnv, project);

    // Verify MCP token is also forbidden from calling POST /api/projects/:project/secrets directly (AD-S12)
    const directAgentAttempt = await studioApp.request(
      `/api/projects/${project}/secrets`,
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          ref: "sec_stripe_key",
          kind: "api_key",
          label: "Stripe Live Key",
          appOrBrick: "stripe",
          envScope: "all",
          value: plantedStripeKey,
        }),
      },
      studioEnv,
    );
    expect(directAgentAttempt.status).toBe(403);

    // Seed sealed secret in studio_secret_vault as a human owner would via Studio Connections Center
    const sealed = await encryptSecretValue(plantedStripeKey, studioEnv.PX_VAULT_KEY ?? studioEnv.BETTER_AUTH_SECRET);
    await studioDb
      .prepare(
        `INSERT OR REPLACE INTO studio_secret_vault (
           id, org_id, project_id, ref, kind, label, app_or_brick, env_scope,
           ciphertext_b64, iv_b64, key_hint, status, created_by, updated_at
         ) VALUES (?, ?, ?, 'sec_stripe_key', 'api_key', 'Stripe Live Key', 'stripe', 'all', ?, ?, ?, 'valid', ?, datetime('now'))`,
      )
      .bind(`vault_${project}_sec_stripe_key`, orgId, project, sealed.ciphertextB64, sealed.ivB64, sealed.keyHint, userId)
      .run();

    // Agent attempts to pass a raw secret to request_connection -> rejected by strict schema
    const rejectedRawSecret = await callStudioMcp("request_connection", {
      project,
      app: "stripe",
      kind: "api_key",
      secretName: "STRIPE_SECRET_KEY",
      value: plantedStripeKey,
    });
    expect(rejectedRawSecret.isError).toBe(true);
    expect(rejectedRawSecret.text).toMatch(/Invalid arguments/i);

    // Valid request_connection returns a Studio consent URL and never accepts/returns raw secret values
    const consent = (
      await callStudioMcp("request_connection", {
        project,
        app: "stripe",
        kind: "api_key",
        secretName: "STRIPE_SECRET_KEY",
        suggestedRef: "sec_stripe_key",
      })
    ).json<{
      project: string;
      ref: string;
      status: string;
      consentUrl: string;
    }>();
    expect(consent.project).toBe(project);
    expect(consent.ref).toBe("sec_stripe_key");
    expect(consent.status).toBe("awaiting_human_consent");
    expect(consent.consentUrl).toContain(`/projects/${project}/connections/consent?`);
    expect(JSON.stringify(consent)).not.toContain(plantedStripeKey);

    // list_connections returns metadata and ref handle, never the sealed secret value
    const listedConnections = await callStudioMcp("list_connections", {
      project,
    });
    expect(listedConnections.isError).toBe(false);
    expect(listedConnections.text).not.toContain(plantedStripeKey);
    const connJson = listedConnections.json<{
      connections: Array<{ ref: string; status: string }>;
    }>();
    expect(connJson.connections.map((c) => c.ref)).toContain("sec_stripe_key");

    // Set up a workflow and run it with planted secret strings in payload and logs
    const setupReply = await callStudioMcp("apply_ops", {
      project,
      expectedRev: 0,
      mode: "apply", // AD-V8: a preview-safe edit an agent may apply directly
      ops: [
        { opId: "s1", type: "enable_brick", brickId: "multi-workspace" },
        {
          opId: "s2",
          type: "add_workflow",
          workflow: {
            id: "wf_sec",
            name: "Secret Scan Workflow",
            trigger: { kind: "manual" },
            nodes: [
              {
                id: "n_in",
                type: "trigger.manual",
                data: {},
              },
            ],
            edges: [],
          },
        },
      ],
    });
    expect(setupReply.isError, setupReply.text).toBe(false);

    const testRun = await callStudioMcp("test_workflow", {
      project,
      workflowId: "wf_sec",
      input: {
        apiKey: plantedStripeKey,
        webhookSecret: plantedWebhookSecret,
        note: `Authorization: Bearer ${plantedStripeKey}`,
      },
    });
    expect(testRun.isError, testRun.text).toBe(false);
    expect(testRun.text).not.toContain(plantedStripeKey);
    expect(testRun.text).not.toContain(plantedWebhookSecret);
    const runData = testRun.json<{ runId: string }>();

    // Ingest a log containing planted secrets and query via query_logs
    await studioApp.request(
      `/api/projects/${project}/environments/preview/logs`,
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              level: "error",
              message: `Upstream failure with key ${plantedStripeKey} and ${plantedWebhookSecret}`,
              runId: runData.runId,
              workflowId: "wf_sec",
              // Story 1.4: every log line names its workspace.
              workspaceId: "ws_default",
              nodeId: "n_in",
              fields: {
                authorization: `Bearer ${plantedStripeKey}`,
                secret: plantedWebhookSecret,
              },
            },
          ],
        }),
      },
      studioEnv,
    );

    const traceReply = await callStudioMcp("get_run_trace", {
      project,
      runId: runData.runId,
    });
    expect(traceReply.isError, traceReply.text).toBe(false);
    expect(traceReply.text).not.toContain(plantedStripeKey);
    expect(traceReply.text).not.toContain(plantedWebhookSecret);
    expect(traceReply.text).toContain("[REDACTED]");

    const logsReply = await callStudioMcp("query_logs", {
      project,
      runId: runData.runId,
    });
    expect(logsReply.isError, logsReply.text).toBe(false);
    expect(logsReply.text).not.toContain(plantedStripeKey);
    expect(logsReply.text).not.toContain(plantedWebhookSecret);
    expect(logsReply.text).toContain("[REDACTED]");
  });

  it("runs an identical build-test-deploy-inspect script via Studio HTTP API and via MCP tools, producing identical blueprintRev, buildHash, run trace, and log query results (AC 5)", async () => {
    const sharedProject = "cp7-dual-parity";
    const { headers: authHeaders } = await ensureTestProjectToken(studioEnv, sharedProject);

    const opsBatch = [
      { opId: "d1", type: "enable_brick", brickId: "multi-workspace" },
      {
        opId: "d2",
        type: "enable_brick",
        brickId: "credit-wallet",
        config: { creditsPerUnit: 5 },
      },
      { opId: "d3", type: "enable_brick", brickId: "dynamic-entities" },
      {
        opId: "d4",
        type: "add_entity",
        entity: {
          name: "orders",
          fields: [
            { name: "customer", type: "text", required: true },
            { name: "total", type: "number", required: true },
          ],
        },
      },
      {
        opId: "d5",
        type: "add_workflow",
        workflow: {
          id: "wf_order",
          name: "Order Pipeline",
          trigger: { kind: "manual" },
          nodes: [
            {
              id: "n_start",
              type: "trigger.manual",
              data: {},
            },
          ],
          edges: [],
        },
      },
    ];

    // Step 1: Apply ops via MCP and read via HTTP to verify identical blueprintRev
    const mcpApplyReply = await callStudioMcp("apply_ops", {
      project: sharedProject,
      expectedRev: 0,
      summary: "Initialize order pipeline",
      ops: opsBatch,
    });
    expect(mcpApplyReply.isError, mcpApplyReply.text).toBe(false);
    // AD-V8: the money brick makes this a proposal; a person accepts it in Studio, which commits revision 1.
    const mcpProposal = mcpApplyReply.json<{ status: string; proposalId: string }>();
    expect(mcpProposal.status).toBe("pending");
    const mcpAcceptRes = await acceptProposalAsOwner(studioEnv, sharedProject, mcpProposal.proposalId);
    expect(mcpAcceptRes.status).toBe(200);
    const mcpApply = (await mcpAcceptRes.json()) as {
      revision: number;
      semanticHash: string;
    };

    const httpStateRes = await studioApp.request(`/api/projects/${sharedProject}`, { method: "GET", headers: authHeaders }, studioEnv);
    expect(httpStateRes.status).toBe(200);
    const httpState = (await httpStateRes.json()) as {
      revision: number;
      semanticHash: string;
    };

    const mcpSummary = (await callStudioMcp("get_blueprint_summary", { project: sharedProject })).json<{ rev: number; semanticHash: string }>();

    expect(mcpApply.revision).toBe(1);
    expect(httpState.revision).toBe(mcpApply.revision);
    expect(mcpSummary.rev).toBe(httpState.revision);
    expect(mcpSummary.semanticHash).toBe(httpState.semanticHash);

    // Step 2: Build / Plan / Deploy via HTTP and via MCP -> assert identical buildHash
    const httpBuildRes = await studioApp.request(`/api/projects/${sharedProject}/build`, { method: "POST", headers: authHeaders }, studioEnv);
    expect(httpBuildRes.status).toBe(200);
    const httpBuild = (await httpBuildRes.json()) as {
      revision: number;
      buildHash: string;
    };

    const mcpPlan = (
      await callStudioMcp("deploy_plan", {
        project: sharedProject,
        env: "preview",
      })
    ).json<{ planId: string; rev: number; buildHash: string }>();

    // Story 0.9 (R-F): no Cloudflare target is connected in this test, so
    // deploy_apply must refuse with NO_TARGET + remediation instead of
    // reporting a fabricated "deployed" status and workers.dev URL.
    const mcpDeployReply = await callStudioMcp("deploy_apply", {
      project: sharedProject,
      env: "preview",
      planId: mcpPlan.planId,
    });
    expect(mcpDeployReply.isError).toBe(true);
    const mcpDeploy = mcpDeployReply.json<{
      error: { code: string; remediation: string };
      status?: string;
      workerUrl?: string;
    }>();
    expect(mcpDeploy.error.code).toBe("NO_TARGET");
    expect(mcpDeploy.error.remediation).toMatch(/Connect a Cloudflare target first/);
    expect(mcpDeploy.status).toBeUndefined();
    expect(mcpDeploy.workerUrl).toBeUndefined();

    expect(mcpPlan.rev).toBe(httpBuild.revision);
    expect(mcpPlan.buildHash).toBe(httpBuild.buildHash);

    // Step 3: Run workflow via MCP test_workflow and inspect via both HTTP and MCP
    const mcpTestReply = await callStudioMcp("test_workflow", {
      project: sharedProject,
      workflowId: "wf_order",
      input: { orderId: "ord_100", amount: 42 },
    });
    expect(mcpTestReply.isError, mcpTestReply.text).toBe(false);
    const mcpTestRun = mcpTestReply.json<{
      runId: string;
      status: string;
      revision: number;
    }>();
    expect(mcpTestRun.status).toBe("succeeded");

    // Ingest a structured log for this run
    await studioApp.request(
      `/api/projects/${sharedProject}/environments/preview/logs`,
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              level: "info",
              message: "Order processed in preview",
              runId: mcpTestRun.runId,
              workflowId: "wf_order",
              // Story 1.4: every log line names its workspace.
              workspaceId: "ws_default",
              nodeId: "n_start",
              fields: { orderId: "ord_100" },
            },
          ],
        }),
      },
      studioEnv,
    );

    // Compare list_runs (MCP vs HTTP)
    const mcpRuns = (
      await callStudioMcp("list_runs", {
        project: sharedProject,
        workflowId: "wf_order",
      })
    ).json<{ items: Array<{ runId: string; status: string }> }>();

    const httpRunsRes = await studioApp.request(`/api/projects/${sharedProject}/runs?workflowId=wf_order`, { method: "GET", headers: authHeaders }, studioEnv);
    const httpRuns = (await httpRunsRes.json()) as {
      runs: Array<{ runId: string; status: string }>;
    };
    expect(mcpRuns.items.map((r) => r.runId)).toContain(mcpTestRun.runId);
    expect(httpRuns.runs.map((r) => r.runId)).toContain(mcpTestRun.runId);

    // Compare get_run_trace (MCP vs HTTP)
    const mcpTrace = (
      await callStudioMcp("get_run_trace", {
        project: sharedProject,
        runId: mcpTestRun.runId,
      })
    ).json<{
      run: { runId: string; status: string; workflowId: string };
      stepEvents: Array<{ nodeId: string; status: string }>;
    }>();

    const httpTraceRes = await studioApp.request(`/api/projects/${sharedProject}/runs/${mcpTestRun.runId}`, { method: "GET", headers: authHeaders }, studioEnv);
    const httpTrace = (await httpTraceRes.json()) as {
      run: { runId: string; status: string; workflowId: string };
      stepEvents: Array<{ nodeId: string; status: string }>;
    };

    expect(mcpTrace.run.runId).toBe(httpTrace.run.runId);
    expect(mcpTrace.run.status).toBe(httpTrace.run.status);
    expect(mcpTrace.stepEvents.map((s) => s.nodeId)).toEqual(httpTrace.stepEvents.map((s) => s.nodeId));

    // Compare query_logs (MCP vs HTTP)
    const mcpLogs = (
      await callStudioMcp("query_logs", {
        project: sharedProject,
        runId: mcpTestRun.runId,
      })
    ).json<{ items: Array<{ message: string; runId: string }> }>();

    const httpLogsRes = await studioApp.request(
      `/api/projects/${sharedProject}/environments/preview/logs?runId=${mcpTestRun.runId}`,
      { method: "GET", headers: authHeaders },
      studioEnv,
    );
    const httpLogs = (await httpLogsRes.json()) as {
      logs: Array<{ message: string; runId: string }>;
    };

    expect(mcpLogs.items.length).toBe(httpLogs.logs.length);
    expect(mcpLogs.items[0]?.message).toBe("Order processed in preview");
    expect(mcpLogs.items[0]?.message).toBe(httpLogs.logs[0]?.message);
  });
});
