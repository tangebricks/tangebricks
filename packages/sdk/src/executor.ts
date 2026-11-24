export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogContext {
  runId?: string | null;
  workflowId?: string | null;
  revision?: number | null;
  nodeId?: string | null;
  brickId?: string | null;
  workspaceId?: string | null;
  requestId?: string | null;
}

export interface StructuredLogger {
  debug(message: string, fields?: Record<string, unknown>): void | Promise<unknown>;
  info(message: string, fields?: Record<string, unknown>): void | Promise<unknown>;
  warn(message: string, fields?: Record<string, unknown>): void | Promise<unknown>;
  error(
    message: string,
    fields?: Record<string, unknown> & { errorStack?: string | null; error?: unknown },
  ): void | Promise<unknown>;
  withContext?(extra: Partial<StructuredLogContext>): StructuredLogger;
}

export interface ConnectionLookupSelector {
  scope?: "project" | "workspace";
  ref?: string;
  app?: string;
  workspaceId?: string;
}

/** What an executor is given. Built by the runtime from the node and the manifest, never from the raw env. */
export interface ExecutionContext {
  nodeId: string;
  readonly runId: string;
  readonly idempotencyKey: string;
  /**
   * The run's verified workspace (AD-S19); never from inputs, payload or config. The runtime sets it from the run's
   * authenticated trigger and refuses a run without one, so an executor that acts for a tenant uses this and nothing else.
   */
  readonly workspaceId: string;
  /** The node's own settings, already checked against the brick's config schema by the validator. */
  data: Record<string, unknown>;
  /** One value per input port; a port fed by several edges gets an array in edge order. */
  inputs: Record<string, unknown>;
  /** What the run was started with (the trigger's payload). */
  payload: unknown;
  /**
   * Returns a secret this brick declared in its manifest. Throws for any other name, and for a
   * declared name the host did not provide. The error names the secret, never its value.
   */
  secret(name: string): string;
  /**
   * Returns a host binding this brick declared in `bindings`. Throws for any other name, and for a declared name the
   * host did not provide. Unlike a secret it is an object (for example a D1 database), so a brick that holds one can
   * do anything that object allows: the manifest scopes which bindings it may have, not what it does with them.
   */
  binding<T = unknown>(name: string): T;
  /**
   * Returns an authenticated connection object or credential bundle by name or selector when provided by the host.
   * Supports both synchronous in-memory connections and asynchronous D1 `px_connections` unsealing + OAuth2 auto-refresh.
   * Any string values inside the returned connection are automatically tracked for telemetry redaction.
   */
  connection?<T = Record<string, unknown>>(
    nameOrSelector: string | ConnectionLookupSelector,
  ): T;
  /**
   * Structured, secret-redacted logger automatically correlated to the active runId, workflowId,
   * revision, nodeId, brickId, workspaceId, and requestId.
   */
  log?: StructuredLogger;
}

/** A brick's behaviour. Returns one value per output port. */
export type Executor = (ctx: ExecutionContext) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type Executors = ReadonlyMap<string, Executor>;
