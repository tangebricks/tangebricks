import { ActionableIssueSchema, createEmptyBlueprint } from "@poc/blueprint";
import type { ActionableIssue, BlueprintState } from "@poc/blueprint";
import type { ToolContext } from "./tools.ts";
import { TOOLS } from "./tools.ts";

export const MAX_SELF_CORRECTION_TOOL_CALLS = 3;

export interface SelfCorrectionStepLog {
  callIndex: number;
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  detectedIssue?: ActionableIssue;
}

export interface SelfCorrectionScenarioResult {
  id: number;
  code: string;
  name: string;
  project: string;
  passed: boolean;
  toolCallsUsed: number;
  maxToolCallsAllowed: number;
  initialIssue: ActionableIssue;
  schemaValid: boolean;
  finalReady: boolean;
  finalVerificationStatus: string;
  trace: SelfCorrectionStepLog[];
}

export interface SelfCorrectionEvalReport {
  suite: "mcp-self-correction-eval";
  story: "story-structured-error-remediation-and-self-correction-eval";
  maxToolCallsPerScenario: number;
  totalScenarios: number;
  passedScenarios: number;
  passRate: number;
  minimumRequiredPassRate: number;
  ok: boolean;
  scenarios: SelfCorrectionScenarioResult[];
}

export type McpCallFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{
  isError: boolean;
  text: string;
  json: <T = Record<string, unknown>>() => T;
}>;

export function createDirectMcpCaller(ctx: ToolContext): McpCallFn {
  return async (toolName: string, args: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) {
      return {
        isError: true,
        text: JSON.stringify({ error: parsed.error.issues }),
        json: <T = Record<string, unknown>>() =>
          ({ error: parsed.error.issues }) as unknown as T,
      };
    }
    const res = await tool.run(ctx, parsed.data as never);
    return {
      isError: res.isError === true,
      text: res.text,
      json: <T = Record<string, unknown>>() => JSON.parse(res.text) as T,
    };
  };
}

/**
 * Deterministic policy agent that inspects structured ActionableIssue payloads
 * (`code`, `path`, `suggestedFix`, `remediationOp`) and repairs the blueprint
 * within <= MAX_SELF_CORRECTION_TOOL_CALLS MCP tool calls.
 */
export async function runSelfCorrectionEvalSuite(params: {
  callMcp: McpCallFn;
  seedProject: (
    project: string,
    state: BlueprintState,
    revision?: number,
  ) => Promise<void>;
}): Promise<SelfCorrectionEvalReport> {
  const { callMcp, seedProject } = params;
  const scenarios: SelfCorrectionScenarioResult[] = [];

  // Helper to run a tracked MCP tool call within a scenario's budget
  const createScenarioTracker = () => {
    const trace: SelfCorrectionStepLog[] = [];
    const invoke = async (
      tool: string,
      args: Record<string, unknown>,
    ): Promise<{
      isError: boolean;
      text: string;
      json: <T = Record<string, unknown>>() => T;
    }> => {
      if (trace.length >= MAX_SELF_CORRECTION_TOOL_CALLS) {
        throw new Error(
          `Exceeded MAX_SELF_CORRECTION_TOOL_CALLS (${MAX_SELF_CORRECTION_TOOL_CALLS})`,
        );
      }
      const res = await callMcp(tool, args);
      trace.push({
        callIndex: trace.length + 1,
        tool,
        args,
        isError: res.isError,
      });
      return res;
    };
    return { trace, invoke };
  };

  // --- Scenario 1: MISSING_CAPABILITY_PROVIDER ---
  {
    const project = "eval-s1-missing-cap";
    await seedProject(
      project,
      createEmptyBlueprint(project, {
        bricks: [{ id: "credit-wallet", config: { creditsPerUnit: 10 } }],
      }),
    );
    const { trace, invoke } = createScenarioTracker();

    // Call 1: validate_blueprint
    const v1 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();
    const issue = v1.issues.find(
      (i) => i.code === "MISSING_CAPABILITY_PROVIDER",
    )!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: apply_ops using issue.remediationOp
    await invoke("apply_ops", {
      project,
      ops: [
        {
          opId: "fix-s1",
          type: issue.remediationOp!.kind,
          ...issue.remediationOp!.payloadExample,
        },
      ],
    });

    // Call 3: validate_blueprint
    const v2 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();

    scenarios.push({
      id: 1,
      code: "MISSING_CAPABILITY_PROVIDER",
      name: "credit-wallet enabled without multi-workspace",
      project,
      passed:
        schemaValid &&
        v2.ready &&
        v2.issues.length === 0 &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: v2.ready,
      finalVerificationStatus: v2.ready ? "ready" : "failed",
      trace,
    });
  }

  // --- Scenario 2: BRICK_CONFLICT ---
  {
    const project = "eval-s2-brick-conflict";
    await seedProject(
      project,
      createEmptyBlueprint(project, {
        bricks: [
          { id: "multi-workspace", config: {} },
          { id: "document-parsing", config: {} },
          { id: "document-pdf", config: {} },
        ],
      }),
    );
    const { trace, invoke } = createScenarioTracker();

    // Call 1: validate_blueprint
    const v1 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();
    const issue = v1.issues.find((i) => i.code === "BRICK_CONFLICT")!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: apply_ops using issue.remediationOp (remove_brick)
    await invoke("apply_ops", {
      project,
      ops: [
        {
          opId: "fix-s2",
          type: issue.remediationOp!.kind,
          ...issue.remediationOp!.payloadExample,
        },
      ],
    });

    // Call 3: validate_blueprint
    const v2 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();

    scenarios.push({
      id: 2,
      code: "BRICK_CONFLICT",
      name: "conflicting bricks document-parsing and document-pdf enabled together",
      project,
      passed:
        schemaValid &&
        v2.ready &&
        v2.issues.length === 0 &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: v2.ready,
      finalVerificationStatus: v2.ready ? "ready" : "failed",
      trace,
    });
  }

  // --- Scenario 3: PORT_TYPE_MISMATCH ---
  {
    const project = "eval-s3-port-mismatch";
    await seedProject(
      project,
      createEmptyBlueprint(project, {
        bricks: [{ id: "multi-workspace", config: {} }],
        workflows: [
          {
            id: "wf_1",
            name: "Port Mismatch Workflow",
            trigger: { kind: "manual" },
            nodes: [
              { id: "t_1", type: "core.webhook", data: {} },
              {
                id: "n_str",
                type: "core.format_template",
                data: { template: "hello" },
              },
              {
                id: "n_math",
                type: "core.math",
                data: { operation: "add", operand: 5 },
              },
            ],
            edges: [
              {
                id: "e_1",
                source: "t_1",
                target: "n_str",
                sourceHandle: "out",
                targetHandle: "in",
              },
              {
                id: "e_valid",
                source: "t_1",
                target: "n_math",
                sourceHandle: "out",
                targetHandle: "in",
              },
              {
                id: "e_bad_wire",
                source: "n_str",
                target: "n_math",
                sourceHandle: "out",
                targetHandle: "number",
              },
            ],
          },
        ],
      }),
    );
    const { trace, invoke } = createScenarioTracker();

    // Call 1: validate_blueprint
    const v1 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();
    const issue = v1.issues.find((i) => i.code === "PORT_TYPE_MISMATCH")!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: apply_ops (disconnect_edge)
    await invoke("apply_ops", {
      project,
      ops: [
        {
          opId: "fix-s3",
          type: issue.remediationOp!.kind,
          ...issue.remediationOp!.payloadExample,
        },
      ],
    });

    // Call 3: validate_blueprint
    const v2 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();

    scenarios.push({
      id: 3,
      code: "PORT_TYPE_MISMATCH",
      name: "string output port wired to number input port",
      project,
      passed:
        schemaValid &&
        v2.ready &&
        v2.issues.length === 0 &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: v2.ready,
      finalVerificationStatus: v2.ready ? "ready" : "failed",
      trace,
    });
  }

  // --- Scenario 4: GRAPH_CYCLE ---
  {
    const project = "eval-s4-graph-cycle";
    await seedProject(
      project,
      createEmptyBlueprint(project, {
        bricks: [{ id: "multi-workspace", config: {} }],
        workflows: [
          {
            id: "wf_1",
            name: "Cycle Workflow",
            trigger: { kind: "manual" },
            nodes: [
              { id: "t_1", type: "trigger.manual", data: {} },
              { id: "n_1", type: "core.noop", data: {} },
              { id: "n_2", type: "core.noop", data: {} },
            ],
            edges: [
              {
                id: "e_start",
                source: "t_1",
                target: "n_1",
                sourceHandle: "out",
                targetHandle: "in",
              },
              {
                id: "e_forward",
                source: "n_1",
                target: "n_2",
                sourceHandle: "out",
                targetHandle: "in",
              },
              {
                id: "e_cycle_back",
                source: "n_2",
                target: "n_1",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        ],
      }),
    );
    const { trace, invoke } = createScenarioTracker();

    // Call 1: validate_blueprint
    const v1 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();
    const issue = v1.issues.find((i) => i.code === "GRAPH_CYCLE")!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: apply_ops (disconnect_edge)
    await invoke("apply_ops", {
      project,
      ops: [
        {
          opId: "fix-s4",
          type: issue.remediationOp!.kind,
          ...issue.remediationOp!.payloadExample,
        },
      ],
    });

    // Call 3: validate_blueprint
    const v2 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();

    scenarios.push({
      id: 4,
      code: "GRAPH_CYCLE",
      name: "directed cycle outside a loop node",
      project,
      passed:
        schemaValid &&
        v2.ready &&
        v2.issues.length === 0 &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: v2.ready,
      finalVerificationStatus: v2.ready ? "ready" : "failed",
      trace,
    });
  }

  // --- Scenario 5: UNREACHABLE_NODE ---
  {
    const project = "eval-s5-unreachable-node";
    await seedProject(
      project,
      createEmptyBlueprint(project, {
        bricks: [{ id: "multi-workspace", config: {} }],
        workflows: [
          {
            id: "wf_1",
            name: "Orphan Workflow",
            trigger: { kind: "manual" },
            nodes: [
              { id: "t_1", type: "trigger.manual", data: {} },
              { id: "n_orphan", type: "core.noop", data: {} },
            ],
            edges: [],
          },
        ],
      }),
    );
    const { trace, invoke } = createScenarioTracker();

    // Call 1: validate_blueprint
    const v1 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();
    const issue = v1.issues.find((i) => i.code === "UNREACHABLE_NODE")!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: apply_ops (connect_edges)
    await invoke("apply_ops", {
      project,
      ops: [
        {
          opId: "fix-s5",
          type: issue.remediationOp!.kind,
          ...issue.remediationOp!.payloadExample,
        },
      ],
    });

    // Call 3: validate_blueprint
    const v2 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();

    scenarios.push({
      id: 5,
      code: "UNREACHABLE_NODE",
      name: "action node with no incoming path from trigger",
      project,
      passed:
        schemaValid &&
        v2.ready &&
        v2.issues.length === 0 &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: v2.ready,
      finalVerificationStatus: v2.ready ? "ready" : "failed",
      trace,
    });
  }

  // --- Scenario 6: UNBOUND_CONNECTION ---
  {
    const project = "eval-s6-unbound-conn";
    await seedProject(
      project,
      createEmptyBlueprint(project, {
        bricks: [{ id: "multi-workspace", config: {} }],
        secretRefs: [
          {
            ref: "sec_stripe_live",
            targetKind: "brick",
            targetId: "multi-workspace",
            secretName: "STRIPE_API_KEY",
          },
        ],
        workflows: [
          {
            id: "wf_1",
            name: "Connection Workflow",
            trigger: { kind: "manual" },
            nodes: [
              { id: "t_1", type: "trigger.manual", data: {} },
              {
                id: "n_2",
                type: "core.noop",
                data: { connectionRef: "sec_unbound_missing" },
              },
            ],
            edges: [
              {
                id: "e_1",
                source: "t_1",
                target: "n_2",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        ],
      }),
    );
    const { trace, invoke } = createScenarioTracker();

    // Call 1: validate_blueprint
    const v1 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();
    const issue = v1.issues.find((i) => i.code === "UNBOUND_CONNECTION")!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: list_connections to discover valid connectionRef
    const connList = (await invoke("list_connections", { project })).json<{
      connections: Array<{ ref: string }>;
    }>();
    const validRef = connList.connections[0]?.ref ?? "sec_stripe_live";

    // Call 3: apply_ops (update_node setting data.connectionRef = validRef)
    const applied = (
      await invoke("apply_ops", {
        project,
        ops: [
          {
            opId: "fix-s6",
            type: "update_node",
            workflowId: "wf_1",
            nodeId: "n_2",
            patch: {
              data: {
                connectionRef: validRef,
              },
            },
          },
        ],
      })
    ).json<{ ready: boolean }>();

    // Out-of-band harness check that validate_blueprint is now clean
    const finalCheck = (await callMcp("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();

    scenarios.push({
      id: 6,
      code: "UNBOUND_CONNECTION",
      name: "node referencing unbound connectionRef resolved via list_connections",
      project,
      passed:
        schemaValid &&
        applied.ready &&
        finalCheck.ready &&
        finalCheck.issues.length === 0 &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: finalCheck.ready,
      finalVerificationStatus: finalCheck.ready ? "ready" : "failed",
      trace,
    });
  }

  // --- Scenario 7: INVALID_SETTING_VALUE ---
  {
    const project = "eval-s7-invalid-setting";
    await seedProject(
      project,
      createEmptyBlueprint(project, {
        bricks: [
          { id: "multi-workspace", config: {} },
          { id: "credit-wallet", config: { creditsPerUnit: 0 } },
        ],
      }),
    );
    const { trace, invoke } = createScenarioTracker();

    // Call 1: validate_blueprint
    const v1 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();
    const issue = v1.issues.find((i) => i.code === "INVALID_SETTING_VALUE")!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: apply_ops (configure_brick with valid value)
    await invoke("apply_ops", {
      project,
      ops: [
        {
          opId: "fix-s7",
          type: issue.remediationOp!.kind,
          ...issue.remediationOp!.payloadExample,
        },
      ],
    });

    // Call 3: validate_blueprint
    const v2 = (await invoke("validate_blueprint", { project })).json<{
      ready: boolean;
      issues: ActionableIssue[];
    }>();

    scenarios.push({
      id: 7,
      code: "INVALID_SETTING_VALUE",
      name: "brick configured with out-of-range setting value (creditsPerUnit: 0)",
      project,
      passed:
        schemaValid &&
        v2.ready &&
        v2.issues.length === 0 &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: v2.ready,
      finalVerificationStatus: v2.ready ? "ready" : "failed",
      trace,
    });
  }

  // --- Scenario 8: STALE_BASE_REV ---
  {
    const project = "eval-s8-stale-rev";
    // Initialize project through apply_ops so rev 1 and rev 2 have committed target history on wf_1/n_2
    await callMcp("apply_ops", {
      project,
      baseRev: 0,
      ops: [
        { opId: "init-s8-1", type: "enable_brick", brickId: "multi-workspace" },
        {
          opId: "init-s8-2",
          type: "add_workflow",
          workflow: {
            id: "wf_1",
            name: "Concurrent Flow",
            trigger: { kind: "manual" },
            nodes: [
              { id: "t_1", type: "trigger.manual", data: {} },
              { id: "n_2", type: "core.noop", data: { stepNote: "v1" } },
            ],
            edges: [
              {
                id: "e_1",
                source: "t_1",
                target: "n_2",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        },
      ],
    });
    // Concurrent edit advances project to rev 2 on n_2
    await callMcp("apply_ops", {
      project,
      baseRev: 1,
      ops: [
        {
          opId: "concurrent-s8",
          type: "update_node",
          workflowId: "wf_1",
          nodeId: "n_2",
          patch: { data: { stepNote: "v2-concurrent" } },
        },
      ],
    });

    const { trace, invoke } = createScenarioTracker();

    // Call 1: Agent submits apply_ops with stale baseRev: 1 on n_2 -> 409 STALE_BASE_REV
    const staleAttempt = await invoke("apply_ops", {
      project,
      baseRev: 1,
      ops: [
        {
          opId: "agent-s8-stale",
          type: "update_node",
          workflowId: "wf_1",
          nodeId: "n_2",
          patch: { data: { stepNote: "v3-agent" } },
        },
      ],
    });
    const conflictJson = staleAttempt.json<{
      issues: ActionableIssue[];
    }>();
    const issue = conflictJson.issues.find((i) => i.code === "STALE_BASE_REV")!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: Agent calls get_blueprint_slice to refresh rev & slice
    const sliceRes = (
      await invoke("get_blueprint_slice", {
        project,
        workflowId: "wf_1",
      })
    ).json<{ rev: number }>();

    // Call 3: Agent retries apply_ops with refreshed baseRev
    const retryRes = (
      await invoke("apply_ops", {
        project,
        baseRev: sliceRes.rev,
        ops: [
          {
            opId: "agent-s8-retry",
            type: "update_node",
            workflowId: "wf_1",
            nodeId: "n_2",
            patch: { data: { stepNote: "v3-agent-rebased" } },
          },
        ],
      })
    ).json<{ rev: number; ready: boolean }>();

    scenarios.push({
      id: 8,
      code: "STALE_BASE_REV",
      name: "apply_ops with outdated baseRev refreshes slice and retries cleanly",
      project,
      passed:
        schemaValid &&
        retryRes.rev === 3 &&
        retryRes.ready &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: retryRes.ready,
      finalVerificationStatus: retryRes.ready ? "ready" : "failed",
      trace,
    });
  }

  // --- Scenario 9: RUN_STEP_MISSING_INPUT ---
  {
    const project = "eval-s9-missing-input";
    await seedProject(
      project,
      createEmptyBlueprint(project, {
        bricks: [{ id: "multi-workspace", config: {} }],
        workflows: [
          {
            id: "wf_1",
            name: "Customer Lookup Flow",
            trigger: { kind: "manual" },
            nodes: [
              { id: "t_1", type: "trigger.manual", data: {} },
              {
                id: "n_2",
                type: "core.noop",
                data: {
                  customerId: "{{steps.t_1.output.non_existent_customer_id}}",
                },
              },
            ],
            edges: [
              {
                id: "e_1",
                source: "t_1",
                target: "n_2",
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        ],
      }),
    );

    // Trigger initial failing workflow run in setup so the agent can inspect get_run_trace + query_logs
    const initialRun = (
      await callMcp("test_workflow", {
        project,
        workflowId: "wf_1",
        input: { customer_id: "cust_999" },
      })
    ).json<{ runId: string; status: string }>();

    const { trace, invoke } = createScenarioTracker();

    // Call 1: get_run_trace
    const traceRes = (
      await invoke("get_run_trace", {
        project,
        runId: initialRun.runId,
      })
    ).json<{
      issues: ActionableIssue[];
    }>();
    const issue = traceRes.issues.find(
      (i) => i.code === "RUN_STEP_MISSING_INPUT",
    )!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: query_logs correlated by runId
    await invoke("query_logs", {
      project,
      runId: initialRun.runId,
      level: "error",
    });

    // Call 3: apply_ops (update_node using remediationOp from RUN_STEP_MISSING_INPUT)
    await invoke("apply_ops", {
      project,
      ops: [
        {
          opId: "fix-s9",
          type: issue.remediationOp!.kind,
          ...issue.remediationOp!.payloadExample,
        },
      ],
    });

    // Harness verification: re-run test_workflow and validate_blueprint
    const verifyRun = (
      await callMcp("test_workflow", {
        project,
        workflowId: "wf_1",
        input: { customer_id: "cust_999" },
      })
    ).json<{ status: string; issues?: ActionableIssue[] }>();
    const verifyBlueprint = (
      await callMcp("validate_blueprint", { project })
    ).json<{ ready: boolean }>();

    scenarios.push({
      id: 9,
      code: "RUN_STEP_MISSING_INPUT",
      name: "workflow step 2 fails on missing upstream field; repaired after get_run_trace + query_logs",
      project,
      passed:
        schemaValid &&
        verifyRun.status === "succeeded" &&
        verifyBlueprint.ready &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: verifyBlueprint.ready,
      finalVerificationStatus: verifyRun.status,
      trace,
    });
  }

  // --- Scenario 10: DEPLOY_STUB_IDENTITY_REFUSED ---
  {
    const project = "eval-s10-deploy-stub";
    await seedProject(
      project,
      createEmptyBlueprint(project, {
        identity: "stub",
        bricks: [{ id: "multi-workspace", config: {} }],
        secretRefs: [
          {
            ref: "sec_better_auth",
            targetKind: "brick",
            targetId: "core-auth",
            secretName: "BETTER_AUTH_SECRET",
          },
          {
            ref: "sec_gh_id",
            targetKind: "brick",
            targetId: "core-auth",
            secretName: "GITHUB_CLIENT_ID",
          },
          {
            ref: "sec_gh_secret",
            targetKind: "brick",
            targetId: "core-auth",
            secretName: "GITHUB_CLIENT_SECRET",
          },
        ],
      }),
    );
    const { trace, invoke } = createScenarioTracker();

    // Call 1: deploy_plan({ env: "production" }) while identity is "stub"
    const plan1 = (
      await invoke("deploy_plan", {
        project,
        env: "production",
      })
    ).json<{
      action: string;
      blockers: ActionableIssue[];
      issues: ActionableIssue[];
    }>();
    const issue = (plan1.issues ?? plan1.blockers).find(
      (i) => i.code === "DEPLOY_STUB_IDENTITY_REFUSED",
    )!;
    trace[0]!.detectedIssue = issue;
    const schemaValid = ActionableIssueSchema.safeParse(issue).success;

    // Call 2: apply_ops to enable core-auth and set identity to "core-auth"
    await invoke("apply_ops", {
      project,
      ops: [
        { opId: "fix-s10-enable", type: "enable_brick", brickId: "core-auth" },
        {
          opId: "fix-s10-identity",
          type: issue.remediationOp!.kind,
          ...issue.remediationOp!.payloadExample,
        },
      ],
    });

    // Call 3: deploy_plan({ env: "production" }) -> green ("apply", 0 blockers)
    const plan2 = (
      await invoke("deploy_plan", {
        project,
        env: "production",
      })
    ).json<{
      action: string;
      blockers: ActionableIssue[];
    }>();
    const verifyBp = (await callMcp("validate_blueprint", { project })).json<{
      ready: boolean;
    }>();

    scenarios.push({
      id: 10,
      code: "DEPLOY_STUB_IDENTITY_REFUSED",
      name: "production deploy_plan refuses stub identity and guides switching to core-auth",
      project,
      passed:
        schemaValid &&
        plan2.action === "apply" &&
        plan2.blockers.length === 0 &&
        verifyBp.ready &&
        trace.length <= MAX_SELF_CORRECTION_TOOL_CALLS,
      toolCallsUsed: trace.length,
      maxToolCallsAllowed: MAX_SELF_CORRECTION_TOOL_CALLS,
      initialIssue: issue,
      schemaValid,
      finalReady: verifyBp.ready,
      finalVerificationStatus: plan2.action,
      trace,
    });
  }

  const passedScenarios = scenarios.filter((s) => s.passed).length;
  const passRate = passedScenarios / scenarios.length;

  return {
    suite: "mcp-self-correction-eval",
    story: "story-structured-error-remediation-and-self-correction-eval",
    maxToolCallsPerScenario: MAX_SELF_CORRECTION_TOOL_CALLS,
    totalScenarios: scenarios.length,
    passedScenarios,
    passRate,
    minimumRequiredPassRate: 0.8,
    ok: passedScenarios >= 8,
    scenarios,
  };
}
