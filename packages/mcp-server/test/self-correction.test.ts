import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ActionableIssueSchema, type BlueprintState } from "@poc/blueprint";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import {
  createDurableObjectBlueprintClient,
} from "../src/index.ts";
import {
  MAX_SELF_CORRECTION_TOOL_CALLS,
  runSelfCorrectionEvalSuite,
  type SelfCorrectionScenarioResult,
} from "../src/self-correction-eval.ts";
import mcpMigrationSql from "../migrations/0001_mcp_server.sql?raw";
import {
  app as studioApp,
  type StudioApiEnv,
} from "../../../apps/studio-api/src/index.ts";
import { ensureTestProjectToken } from "../../../apps/studio-api/test/project-token.ts";
import { acceptProposalAsOwner } from "../../../apps/studio-api/test/human-session.ts";

const studioEnv = env as unknown as StudioApiEnv;
const db = (env as unknown as { DB: D1Like }).DB;

let rpcId = 1;

async function callStudioMcp(
  name: string,
  args: Record<string, unknown>,
) {
  // Story 0.15: each scenario's project has its own MCP token.
  const project = typeof args.project === "string" ? args.project : "default-project";
  const { headers: authHeaders } = await ensureTestProjectToken(studioEnv, project, {
    clientName: "self-correct-test",
  });
  const res = await studioApp.request(
    "http://localhost/mcp",
    {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/json",
        "x-mcp-client-id": "agent:self-correct-test",
        "x-mcp-client-name": "self-correct-test",
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

describe("Story 7.3 — Automated Agent Self-Correction Evaluation over MCP in workerd (AC 1, AC 2, AC 3)", () => {
  beforeEach(async () => {
    await applyMigration(db, mcpMigrationSql);
  });

  it("repairs all 10 seeded failure scenarios within <= 3 MCP tool calls using ActionableIssueSchema payloads", async () => {
    const doClient = createDurableObjectBlueprintClient(studioEnv.BLUEPRINT_DO);

    const report = await runSelfCorrectionEvalSuite({
      callMcp: callStudioMcp,
      seedProject: async (project: string, state: BlueprintState, revision = 1) => {
        await doClient.seedProject!(project, state, revision);
      },
      // AD-V8: the test is the Studio editor who accepts each proposal the agent makes.
      review: async (project: string, proposalId: string) => {
        const accepted = await acceptProposalAsOwner(studioEnv, project, proposalId);
        expect(accepted.status, await accepted.clone().text()).toBe(200);
      },
    });

    expect(report.totalScenarios).toBe(10);
    expect(report.passedScenarios).toBeGreaterThanOrEqual(8);
    expect(report.passedScenarios).toBe(10);
    expect(report.passRate).toBeGreaterThanOrEqual(0.8);
    expect(report.ok).toBe(true);

    const expectedCodes = [
      "MISSING_CAPABILITY_PROVIDER",
      "BRICK_CONFLICT",
      "PORT_TYPE_MISMATCH",
      "GRAPH_CYCLE",
      "UNREACHABLE_NODE",
      "UNBOUND_CONNECTION",
      "INVALID_SETTING_VALUE",
      "STALE_BASE_REV",
      "RUN_STEP_MISSING_INPUT",
      "DEPLOY_STUB_IDENTITY_REFUSED",
    ];

    expect(report.scenarios.map((s: SelfCorrectionScenarioResult) => s.code)).toEqual(expectedCodes);

    for (const scenario of report.scenarios) {
      expect(
        scenario.passed,
        `Scenario #${scenario.id} (${scenario.code}) failed: ${JSON.stringify(scenario.trace)}`,
      ).toBe(true);
      expect(scenario.toolCallsUsed).toBeLessThanOrEqual(
        MAX_SELF_CORRECTION_TOOL_CALLS,
      );
      expect(scenario.schemaValid).toBe(true);
      expect(
        ActionableIssueSchema.safeParse(scenario.initialIssue).success,
      ).toBe(true);
      expect(scenario.initialIssue.path).toMatch(/^(\/[^/]+)+$/);
      expect(scenario.initialIssue.suggestedFix.length).toBeGreaterThan(0);
      expect(scenario.initialIssue.remediationOp).toBeDefined();
      expect(scenario.finalReady).toBe(true);
    }
  });
});
