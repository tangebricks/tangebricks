import { scoped, type D1Like } from "@poc/sdk";
import { createScriptIsolate, type ScriptIsolate } from "./isolate.ts";

export interface ScriptRecord {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  trigger_event: string;
  source_code: string;
  is_enabled: boolean;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
}

export interface ExecutionRecord {
  id: string;
  script_id: string;
  workspace_id: string;
  trigger_event: string;
  status: "success" | "error" | "timeout";
  duration_ms: number;
  input_payload: Record<string, unknown>;
  output_payload: unknown | null;
  error_message: string | null;
  created_at: string;
}

export interface CreateScriptInput {
  workspaceId: string;
  name: string;
  description?: string;
  triggerEvent: string;
  sourceCode: string;
  timeoutMs?: number;
}

export interface ExecutionResult {
  status: "success" | "error" | "timeout";
  durationMs: number;
  result: unknown | null;
  errorMessage: string | null;
}

/**
 * Validates script source code size and structure.
 */
export function validateScriptSource(code: string): { valid: boolean; error?: string } {
  if (typeof code !== "string") {
    return { valid: false, error: "Script source must be a string" };
  }
  if (new TextEncoder().encode(code).length > 64 * 1024) {
    return { valid: false, error: "Script source exceeds maximum allowed size of 64 KiB" };
  }

  // Must define a main function or return an expression
  if (!code.includes("main") && !code.includes("return")) {
    return { valid: false, error: "Script must define a 'main(payload)' function or return a value" };
  }

  return { valid: true };
}

/**
 * Isolated script execution runner.
 * Delegates to the provided or default ScriptIsolate.
 */
export async function executeSandboxed(
  sourceCode: string,
  payload: Record<string, unknown>,
  isolate?: ScriptIsolate,
): Promise<ExecutionResult> {
  const runner = isolate ?? createScriptIsolate(null);
  return runner.run(sourceCode, payload, {
    cpuMs: 2000,
    wallMs: 2000,
    maxOutputBytes: 1024 * 1024,
  });
}

export class ScriptingSandboxService {
  private readonly db: D1Like;
  readonly isolate?: ScriptIsolate;

  constructor(db: D1Like, isolate?: ScriptIsolate) {
    this.db = db;
    this.isolate = isolate;
  }

  /**
   * Registers a customer-written plugin script.
   */
  async createScript(input: CreateScriptInput): Promise<ScriptRecord> {
    const check = validateScriptSource(input.sourceCode);
    if (!check.valid) {
      throw new Error(`Invalid script: ${check.error}`);
    }

    const id = `scr_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const timeout = Math.min(10000, Math.max(100, input.timeoutMs ?? 2000));

    await scoped(this.db, input.workspaceId).insert("scr_scripts", {
      id,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      trigger_event: input.triggerEvent.trim(),
      source_code: input.sourceCode.trim(),
      is_enabled: 1,
      timeout_ms: timeout,
      created_at: now,
      updated_at: now,
    });

    return {
      id,
      workspace_id: input.workspaceId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      trigger_event: input.triggerEvent.trim(),
      source_code: input.sourceCode.trim(),
      is_enabled: true,
      timeout_ms: timeout,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Retrieves a script record.
   */
  async getScript(workspaceId: string, scriptId: string): Promise<ScriptRecord | null> {
    const row = await scoped(this.db, workspaceId).first<{
      id: string;
      workspace_id: string;
      name: string;
      description: string | null;
      trigger_event: string;
      source_code: string;
      is_enabled: number;
      timeout_ms: number;
      created_at: string;
      updated_at: string;
    }>("scr_scripts", "id = ?", [scriptId]);

    if (!row) return null;

    return {
      ...row,
      is_enabled: row.is_enabled === 1,
    };
  }

  /**
   * Updates an existing script.
   */
  async updateScript(
    workspaceId: string,
    scriptId: string,
    updates: { name?: string; description?: string; sourceCode?: string; isEnabled?: boolean }
  ): Promise<ScriptRecord | null> {
    const existing = await this.getScript(workspaceId, scriptId);
    if (!existing) return null;

    let source = existing.source_code;
    if (updates.sourceCode !== undefined) {
      const check = validateScriptSource(updates.sourceCode);
      if (!check.valid) {
        throw new Error(`Invalid script: ${check.error}`);
      }
      source = updates.sourceCode.trim();
    }

    const name = updates.name?.trim() || existing.name;
    const desc = updates.description !== undefined ? updates.description?.trim() || null : existing.description;
    const isEnabled = updates.isEnabled !== undefined ? (updates.isEnabled ? 1 : 0) : (existing.is_enabled ? 1 : 0);
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).update(
      "scr_scripts",
      {
        name,
        description: desc,
        source_code: source,
        is_enabled: isEnabled,
        updated_at: now,
      },
      "id = ?",
      [scriptId]
    );

    return this.getScript(workspaceId, scriptId);
  }

  /**
   * Executes a script and records execution metrics & audit trail.
   */
  async executeScript(
    workspaceId: string,
    scriptId: string,
    payload: Record<string, unknown>
  ): Promise<ExecutionRecord> {
    const script = await this.getScript(workspaceId, scriptId);
    if (!script) {
      throw new Error(`Script ${scriptId} not found`);
    }

    if (!script.is_enabled) {
      throw new Error(`Script ${script.name} is disabled`);
    }

    const execResult = this.isolate
      ? await this.isolate.run(script.source_code, payload, {
          cpuMs: script.timeout_ms,
          wallMs: script.timeout_ms,
          maxOutputBytes: 1024 * 1024,
        })
      : await executeSandboxed(script.source_code, payload);

    const execId = `exec_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("scr_executions", {
      id: execId,
      script_id: scriptId,
      trigger_event: script.trigger_event,
      status: execResult.status,
      duration_ms: execResult.durationMs,
      input_payload_json: JSON.stringify(payload),
      output_payload_json: execResult.result !== undefined ? JSON.stringify(execResult.result) : null,
      error_message: execResult.errorMessage,
      created_at: now,
    });

    return {
      id: execId,
      script_id: scriptId,
      workspace_id: workspaceId,
      trigger_event: script.trigger_event,
      status: execResult.status,
      duration_ms: execResult.durationMs,
      input_payload: payload,
      output_payload: execResult.result,
      error_message: execResult.errorMessage,
      created_at: now,
    };
  }

  /**
   * Lists all scripts for workspace.
   */
  async listScripts(workspaceId: string): Promise<ScriptRecord[]> {
    const rows = await scoped(this.db, workspaceId).select<{
      id: string;
      workspace_id: string;
      name: string;
      description: string | null;
      trigger_event: string;
      source_code: string;
      is_enabled: number;
      timeout_ms: number;
      created_at: string;
      updated_at: string;
    }>("scr_scripts", undefined, [], { orderBy: "created_at DESC" });

    return rows.map((r) => ({
      ...r,
      is_enabled: r.is_enabled === 1,
    }));
  }

  /**
   * Retrieves execution audit logs for a script.
   */
  async getExecutionLogs(workspaceId: string, scriptId: string): Promise<ExecutionRecord[]> {
    const rows = await scoped(this.db, workspaceId).select<{
      id: string;
      script_id: string;
      workspace_id: string;
      trigger_event: string;
      status: "success" | "error" | "timeout";
      duration_ms: number;
      input_payload_json: string;
      output_payload_json: string | null;
      error_message: string | null;
      created_at: string;
    }>("scr_executions", "script_id = ?", [scriptId], {
      orderBy: "created_at DESC",
      limit: 50,
    });

    return rows.map((r) => ({
      id: r.id,
      script_id: r.script_id,
      workspace_id: r.workspace_id,
      trigger_event: r.trigger_event,
      status: r.status,
      duration_ms: r.duration_ms,
      input_payload: JSON.parse(r.input_payload_json || "{}"),
      output_payload: r.output_payload_json ? JSON.parse(r.output_payload_json) : null,
      error_message: r.error_message,
      created_at: r.created_at,
    }));
  }

  /**
   * Deletes a script.
   */
  async deleteScript(workspaceId: string, scriptId: string): Promise<boolean> {
    const res = await scoped(this.db, workspaceId).delete(
      "scr_scripts",
      "id = ?",
      [scriptId]
    );

    return res.meta.changes > 0;
  }
}
