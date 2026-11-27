// Studio's project-confined telemetry reads (story 1.4), shared by the studio-api routes and the Studio web tests that
// stand in for them, so both exercise the same code.
import type { D1Like } from "@poc/sdk";
import { handleTelemetryLogsPullRequest, signControlPlaneRequest } from "@poc/telemetry";

/**
 * Reads a project's structured logs the way the logs route does: the caller's query is forwarded to the in-process
 * `/__px/logs` handler, signed with the control-plane scheme (PX_TELEMETRY_SECRET), and confined to `project`. A
 * workspace the caller names narrows the read inside the project; "all" (or none) means the whole project.
 */
export async function readProjectLogs(params: {
  db: D1Like;
  project: string;
  envName: string;
  /** The caller's query string ("?level=error&..." or ""). */
  search: string;
  telemetrySecret: string;
}): Promise<Response | null> {
  const workerUrl = new URL(`http://env.worker.internal/__px/logs${params.search}`);
  if (!workerUrl.searchParams.has("env")) {
    workerUrl.searchParams.set("env", params.envName);
  }
  if (workerUrl.searchParams.get("workspaceId") === "all") {
    workerUrl.searchParams.delete("workspaceId");
  }
  const workerReq = new Request(workerUrl.toString(), {
    method: "GET",
    headers: await signControlPlaneRequest(params.telemetrySecret, "GET", workerUrl),
  });
  return handleTelemetryLogsPullRequest(workerReq, {
    db: params.db,
    telemetrySecret: params.telemetrySecret,
    projectId: params.project,
    pxEnv: params.envName,
  });
}

/**
 * The request Studio's data browser forwarder hands the in-process `/__px/data/*` handler (story 1.4): a mutation's
 * workspace, which a Studio client names in the body, is carried into the query (the worker takes the workspace from
 * the signed query and refuses a body that names another one), and the request is signed with the control-plane scheme
 * over method, path with query, time and body.
 */
export async function signedDataBrowserRequest(params: {
  method: string;
  /** "/__px/data/..." with its query string. */
  workerPathAndQuery: string;
  rawBody?: string;
  signingSecret: string;
  origin?: string;
}): Promise<Request> {
  const workerUrl = new URL(`${params.origin ?? "http://env.worker.internal"}${params.workerPathAndQuery}`);
  if (!workerUrl.searchParams.get("workspaceId") && params.rawBody) {
    try {
      const parsedBody = JSON.parse(params.rawBody) as { workspaceId?: unknown; workspace_id?: unknown };
      const bodyWorkspace =
        typeof parsedBody?.workspaceId === "string" ? parsedBody.workspaceId : typeof parsedBody?.workspace_id === "string" ? parsedBody.workspace_id : "";
      if (bodyWorkspace.trim()) workerUrl.searchParams.set("workspaceId", bodyWorkspace.trim());
    } catch {
      // not JSON: the worker answers INVALID_JSON
    }
  }
  // Story 1.17: every signed write carries a fresh one-time requestId in its (signed) query string.
  // A client-supplied requestId is never kept: Studio always mints the id it signs.
  if (params.method.toUpperCase() !== "GET") {
    workerUrl.searchParams.delete("requestId");
    workerUrl.searchParams.set("requestId", crypto.randomUUID());
  }
  return new Request(workerUrl.toString(), {
    method: params.method,
    headers: {
      ...(params.rawBody ? { "content-type": "application/json" } : {}),
      ...(await signControlPlaneRequest(params.signingSecret, params.method, workerUrl, params.rawBody ?? "")),
    },
    ...(params.rawBody ? { body: params.rawBody } : {}),
  });
}
