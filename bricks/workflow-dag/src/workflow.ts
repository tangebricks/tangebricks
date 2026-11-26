import { GraphWorkflow, validateGraph, toyExecutors, toyRegistry, scoped } from "@poc/sdk";
import type { D1Like, Executor, Graph, Registry } from "@poc/sdk";

export interface WorkflowRecord {
  id: string;
  workspace_id: string;
  name: string;
  graph: Graph;
  version: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  id: string;
  workspace_id: string;
  workflow_id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  trigger_type: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  error?: string | null;
  duration_ms?: number | null;
  started_at: string;
  finished_at?: string | null;
  created_at: string;
}

export interface StepLogRecord {
  id: string;
  run_id: string;
  node_id: string;
  node_type: string;
  status: "running" | "completed" | "failed" | "skipped";
  input?: unknown;
  output?: unknown;
  error?: string | null;
  duration_ms?: number | null;
  started_at: string;
  finished_at?: string | null;
}

export class WorkflowService {
  private readonly registry: Registry;
  private readonly executors: ReadonlyMap<string, Executor>;
  private readonly db: D1Like;

  constructor(
    db: D1Like,
    customRegistry?: Registry,
    customExecutors?: ReadonlyMap<string, Executor>
  ) {
    this.db = db;
    this.registry = customRegistry || toyRegistry;
    // px-stub: quarantined: runs in-process with the SDK toy executors, not durable Cloudflare Workflows
    this.executors = customExecutors || toyExecutors;
  }

  /**
   * Validates and creates a new workflow definition.
   */
  async createWorkflow(
    workspaceId: string,
    nameRaw: string,
    graph: Graph
  ): Promise<{ ok: true; workflow: WorkflowRecord } | { ok: false; error: string; code: number }> {
    const name = nameRaw.trim();
    if (!name || name.length > 100) {
      return { ok: false, error: "Workflow name must be between 1 and 100 characters", code: 400 };
    }

    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      return { ok: false, error: "Invalid workflow graph format", code: 400 };
    }

    // Verify all edges refer to existing nodes
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        return { ok: false, error: "Invalid workflow graph: edge references non-existent node", code: 400 };
      }
    }

    const validation = validateGraph(graph.nodes, graph.edges, this.registry);
    const errors = validation.issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      const reasons = errors.map((i) => `${i.code}: ${i.message}`).join("; ");
      return { ok: false, error: `Invalid workflow graph: ${reasons}`, code: 400 };
    }

    const id = `wf_${crypto.randomUUID().replace(/-/g, "")}`;
    const graphJson = JSON.stringify(graph);
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("wf_definitions", {
      id,
      name,
      graph_json: graphJson,
      version: 1,
      active: 1,
      created_at: now,
      updated_at: now,
    });

    return {
      ok: true,
      workflow: {
        id,
        workspace_id: workspaceId,
        name,
        graph,
        version: 1,
        active: true,
        created_at: now,
        updated_at: now,
      },
    };
  }

  /**
   * Retrieves a workflow by ID scoped to workspace.
   */
  async getWorkflow(workspaceId: string, workflowId: string): Promise<WorkflowRecord | null> {
    interface Row {
      id: string;
      workspace_id: string;
      name: string;
      graph_json: string;
      version: number;
      active: number;
      created_at: string;
      updated_at: string;
    }

    const row = await scoped(this.db, workspaceId).first<Row>(
      "wf_definitions",
      "id = ?",
      [workflowId]
    );

    if (!row) return null;
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      name: row.name,
      graph: JSON.parse(row.graph_json || '{"nodes":[],"edges":[]}'),
      version: row.version,
      active: row.active === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Lists workflows in a workspace.
   */
  async listWorkflows(workspaceId: string): Promise<WorkflowRecord[]> {
    interface Row {
      id: string;
      workspace_id: string;
      name: string;
      graph_json: string;
      version: number;
      active: number;
      created_at: string;
      updated_at: string;
    }

    const rows = await scoped(this.db, workspaceId).select<Row>(
      "wf_definitions",
      undefined,
      [],
      { orderBy: "updated_at DESC" }
    );

    return rows.map((r) => ({
      id: r.id,
      workspace_id: r.workspace_id,
      name: r.name,
      graph: JSON.parse(r.graph_json || '{"nodes":[],"edges":[]}'),
      version: r.version,
      active: r.active === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Executes a workflow DAG by interpreting its nodes, logging each step, and storing output in D1.
   */
  async executeWorkflow(
    workspaceId: string,
    workflowId: string,
    inputPayload: Record<string, unknown> = {},
    triggerType = "manual"
  ): Promise<{ ok: true; run: RunRecord; steps: StepLogRecord[] } | { ok: false; error: string; code: number }> {
    const wf = await this.getWorkflow(workspaceId, workflowId);
    if (!wf) return { ok: false, error: "Workflow not found", code: 404 };
    if (!wf.active) return { ok: false, error: "Workflow is deactivated", code: 400 };

    const runId = `run_${crypto.randomUUID().replace(/-/g, "")}`;
    const startTime = Date.now();
    const startedAtIso = new Date(startTime).toISOString();

    // Insert running record
    await scoped(this.db, workspaceId).insert("wf_runs", {
      id: runId,
      workflow_id: workflowId,
      status: "running",
      trigger_type: triggerType,
      input_json: JSON.stringify(inputPayload),
      started_at: startedAtIso,
      created_at: startedAtIso,
    });

    const nodeTypeMap = new Map(wf.graph.nodes.map((n) => [n.id, n.type]));
    const stepLogs: StepLogRecord[] = [];

    const runStep = async (nodeId: string, call: () => Promise<Record<string, unknown>>) => {
      const start = Date.now();
      const nodeType = nodeTypeMap.get(nodeId) || "unknown";
      try {
        const out = await call();
        const dur = Date.now() - start;
        stepLogs.push({
          id: `step_${crypto.randomUUID().replace(/-/g, "")}`,
          run_id: runId,
          node_id: nodeId,
          node_type: nodeType,
          status: "completed",
          output: out,
          duration_ms: dur,
          started_at: new Date(start).toISOString(),
          finished_at: new Date().toISOString(),
        });
        return out;
      } catch (err: unknown) {
        const dur = Date.now() - start;
        const errMsg = err instanceof Error ? err.message : String(err);
        stepLogs.push({
          id: `step_${crypto.randomUUID().replace(/-/g, "")}`,
          run_id: runId,
          node_id: nodeId,
          node_type: nodeType,
          status: "failed",
          error: errMsg,
          duration_ms: dur,
          started_at: new Date(start).toISOString(),
          finished_at: new Date().toISOString(),
        });
        throw err;
      }
    };

    let runStatus: "completed" | "failed" = "completed";
    let outputData: Record<string, unknown> | null = null;
    let errorText: string | null = null;

    try {
      const workflow = new GraphWorkflow(this.registry, this.executors);
      const result = await workflow.start({
        graph: wf.graph,
        // the workspace this run was started in (the route's verified context), never one from the payload
        workspaceId,
        payload: inputPayload,
        env: { DB: this.db },
        runStep,
      });

      if (result.ok) {
        outputData = result.outputs;
        runStatus = "completed";
      } else {
        runStatus = "failed";
        const failedNodes = Object.entries(result.failed).map(([k, v]) => `node ${k}: ${v}`).join("; ");
        errorText = failedNodes || "Graph execution failed";
      }
    } catch (err: unknown) {
      runStatus = "failed";
      errorText = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - startTime;
    const finishedAtIso = new Date().toISOString();

    // Persist step logs into D1
    if (stepLogs.length > 0) {
      const stmts = stepLogs.map((s) =>
        this.db.prepare(`
          INSERT INTO wf_step_logs (id, run_id, node_id, node_type, status, input_json, output_json, error_text, duration_ms, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          s.id,
          s.run_id,
          s.node_id,
          s.node_type,
          s.status,
          JSON.stringify(s.input || null),
          JSON.stringify(s.output || null),
          s.error || null,
          s.duration_ms,
          s.started_at,
          s.finished_at
        )
      );
      await this.db.batch(stmts);
    }

    // Update run status in D1
    await scoped(this.db, workspaceId).update(
      "wf_runs",
      {
        status: runStatus,
        output_json: outputData ? JSON.stringify(outputData) : null,
        error_text: errorText,
        duration_ms: durationMs,
        finished_at: finishedAtIso,
      },
      "id = ?",
      [runId]
    );

    const run: RunRecord = {
      id: runId,
      workspace_id: workspaceId,
      workflow_id: workflowId,
      status: runStatus,
      trigger_type: triggerType,
      input: inputPayload,
      output: outputData,
      error: errorText,
      duration_ms: durationMs,
      started_at: startedAtIso,
      finished_at: finishedAtIso,
      created_at: startedAtIso,
    };

    return { ok: true, run, steps: stepLogs };
  }

  /**
   * Retrieves a run and its step execution logs.
   */
  async getRun(workspaceId: string, runId: string): Promise<{ run: RunRecord; steps: StepLogRecord[] } | null> {
    interface RunRow {
      id: string;
      workspace_id: string;
      workflow_id: string;
      status: "queued" | "running" | "completed" | "failed" | "canceled";
      trigger_type: string;
      input_json: string;
      output_json: string | null;
      error_text: string | null;
      duration_ms: number | null;
      started_at: string;
      finished_at: string | null;
      created_at: string;
    }

    const row = await scoped(this.db, workspaceId).first<RunRow>(
      "wf_runs",
      "id = ?",
      [runId]
    );

    if (!row) return null;

    interface StepRow {
      id: string;
      run_id: string;
      node_id: string;
      node_type: string;
      status: "running" | "completed" | "failed" | "skipped";
      input_json: string | null;
      output_json: string | null;
      error_text: string | null;
      duration_ms: number | null;
      started_at: string;
      finished_at: string | null;
    }

    const stepRows = (await this.db.prepare(
      "SELECT id, run_id, node_id, node_type, status, input_json, output_json, error_text, duration_ms, started_at, finished_at FROM wf_step_logs WHERE run_id = ? ORDER BY started_at ASC"
    ).bind(runId).all<StepRow>()).results;

    const run: RunRecord = {
      id: row.id,
      workspace_id: row.workspace_id,
      workflow_id: row.workflow_id,
      status: row.status,
      trigger_type: row.trigger_type,
      input: JSON.parse(row.input_json || "{}"),
      output: row.output_json ? JSON.parse(row.output_json) : null,
      error: row.error_text,
      duration_ms: row.duration_ms,
      started_at: row.started_at,
      finished_at: row.finished_at,
      created_at: row.created_at,
    };

    const steps: StepLogRecord[] = stepRows.map((s) => ({
      id: s.id,
      run_id: s.run_id,
      node_id: s.node_id,
      node_type: s.node_type,
      status: s.status,
      input: s.input_json ? JSON.parse(s.input_json) : null,
      output: s.output_json ? JSON.parse(s.output_json) : null,
      error: s.error_text,
      duration_ms: s.duration_ms,
      started_at: s.started_at,
      finished_at: s.finished_at,
    }));

    return { run, steps };
  }
}
