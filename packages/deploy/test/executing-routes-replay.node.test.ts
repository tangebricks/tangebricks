// Story 1.17: the routes that execute bricks inline (/__px/rehearse, /__px/runs, /__px/runs/rerun) take the control-plane
// signature (domain, method, path, time, body) and a one-time requestId recorded in px_control_requests before anything
// runs. A captured signed request replayed to any of them gets 409 DUPLICATE_REQUEST and debits once; a wrong path, a
// stale time, a missing requestId, a legacy body-only signature, a webhook signature or another project's signature is
// refused and executes nothing.
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  SIGNED_AT_HEADER,
  TELEMETRY_SIGNATURE_HEADER,
  deriveProjectSecret,
  signControlPlaneRequest,
  signTelemetryPayload,
  signTelemetryWebhook,
} from "@poc/telemetry";
import { createRegistry, toyRegistry } from "@poc/sdk";
import type { BrickManifest, Executor } from "@poc/sdk";
import { toyExecutors } from "@poc/runtime";
import { createProofRoutes } from "../src/worker/proof-routes.ts";
import { sqliteD1 } from "../../../test/support/sqlite-d1.ts";

const ROOT = "story-1-17-studio-root-secret-0123456789";
const WS = "ws_replay";
const DEBIT = 25;

const debitManifest: BrickManifest = {
  type: "probe.debit",
  category: "action",
  inputs: [{ id: "in", dataType: "json" }],
  outputs: [{ id: "out", dataType: "json" }],
  configSchema: z.object({}),
  secrets: [],
};

let world: ReturnType<typeof sqliteD1>;
let secretA: string;
let secretB: string;

const balance = () => (world.db.prepare("SELECT balance FROM probe_wallet WHERE id = 1").get() as { balance: number }).balance;

function routes() {
  const debit: Executor = async () => {
    await world.d1.prepare("UPDATE probe_wallet SET balance = balance - ?1 WHERE id = 1").bind(DEBIT).run();
    return { out: { debited: DEBIT } };
  };
  return createProofRoutes({
    registry: createRegistry([...toyRegistry.values(), debitManifest]),
    executors: new Map<string, Executor>([...toyExecutors, ["probe.debit", debit]]),
  });
}

const graph = {
  nodes: [
    { id: "t", type: "trigger.manual", data: {} },
    { id: "d", type: "probe.debit", data: {} },
  ],
  edges: [{ id: "e1", source: "t", target: "d", sourceHandle: "out", targetHandle: "in" }],
};

const bodies: Record<string, () => Record<string, unknown>> = {
  "/__px/rehearse": () => ({ workflowId: "wf_replay", nodeId: "d", nodeType: "probe.debit", input: {}, workspaceId: WS }),
  "/__px/runs": () => ({ runId: `run_${crypto.randomUUID()}`, workflowId: "wf_replay", workspaceId: WS, graph }),
  "/__px/runs/rerun": () => ({
    runId: `run_${crypto.randomUUID()}`,
    sourceRunId: "run_source",
    fromNodeId: "d",
    seededOutputs: { t: { out: {} } },
    workflowId: "wf_replay",
    workspaceId: WS,
    graph,
  }),
};

async function send(path: string, body: string, headers: Record<string, string>) {
  const env = { DB: world.d1, PX_TELEMETRY_SECRET: secretA, PX_ENV: "preview" };
  return (await routes()(
    new Request(`http://deployed.invalid${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }),
    env,
  ))!;
}

describe("story 1.17: executing control-plane routes are replay-resistant", () => {
  beforeEach(async () => {
    world = sqliteD1();
    world.db.exec("CREATE TABLE probe_wallet (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL); INSERT INTO probe_wallet VALUES (1, 1000);");
    // The worker holds project A's derived control-plane secret, never the root.
    secretA = await deriveProjectSecret(ROOT, "proj-a", "control-plane");
    secretB = await deriveProjectSecret(ROOT, "proj-b", "control-plane");
  });

  for (const path of Object.keys(bodies)) {
    test(`${path}: a replayed signed request gets 409 DUPLICATE_REQUEST and debits once`, async () => {
      const body = JSON.stringify({ requestId: crypto.randomUUID(), ...bodies[path]!() });
      const headers = await signControlPlaneRequest(secretA, "POST", path, body);

      const first = await send(path, body, headers);
      expect(first.status).toBe(200);
      expect(balance()).toBe(1000 - DEBIT);

      // The very same captured request (same headers, inside the 300 s window), sent again.
      const replay = await send(path, body, headers);
      expect(replay.status).toBe(409);
      expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE_REQUEST");
      // Re-signed with a fresh time but the same requestId: still refused.
      const resigned = await send(path, body, await signControlPlaneRequest(secretA, "POST", path, body));
      expect(resigned.status).toBe(409);
      expect(balance()).toBe(1000 - DEBIT);
      const recorded = world.db.prepare("SELECT path, workspace_id FROM px_control_requests").all();
      expect(recorded).toEqual([{ path, workspace_id: WS }]);
    });

    test(`${path}: a wrong path, stale time, missing requestId, legacy, webhook or cross-project signature is refused`, async () => {
      const body = JSON.stringify({ requestId: crypto.randomUUID(), ...bodies[path]!() });
      const otherPath = path === "/__px/runs" ? "/__px/rehearse" : "/__px/runs";
      const status = async (headers: Record<string, string>, b = body) => (await send(path, b, headers)).status;

      expect(await status(await signControlPlaneRequest(secretA, "POST", otherPath, body))).toBe(401);
      const stale = await send(path, body, await signControlPlaneRequest(secretA, "POST", path, body, Date.now() - 301_000));
      expect(stale.status).toBe(401);
      expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("STALE_OR_MISSING_SIGNED_AT");
      expect(await status(await signControlPlaneRequest(secretA, "GET", path, body))).toBe(401);
      // Legacy body-only signature (the pre-1.17 scheme), with or without a timestamp header.
      const legacy = await signTelemetryPayload(body, secretA);
      expect(await status({ [TELEMETRY_SIGNATURE_HEADER]: legacy })).toBe(401);
      expect(await status({ [TELEMETRY_SIGNATURE_HEADER]: legacy, [SIGNED_AT_HEADER]: String(Math.floor(Date.now() / 1000)) })).toBe(401);
      // A telemetry webhook signature over the same body (cross-purpose).
      expect(
        await status({ [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryWebhook(body, secretA), [SIGNED_AT_HEADER]: String(Math.floor(Date.now() / 1000)) }),
      ).toBe(401);
      // Signed with project B's derived secret, or with Studio's root secret: refused by project A's worker.
      expect(await status(await signControlPlaneRequest(secretB, "POST", path, body))).toBe(401);
      expect(await status(await signControlPlaneRequest(ROOT, "POST", path, body))).toBe(401);
      // A body without a requestId, or with one that is not a UUID.
      const noId = JSON.stringify(bodies[path]!());
      expect(await status(await signControlPlaneRequest(secretA, "POST", path, noId), noId)).toBe(400);
      const badId = JSON.stringify({ requestId: "run-1", ...bodies[path]!() });
      expect(await status(await signControlPlaneRequest(secretA, "POST", path, badId), badId)).toBe(400);

      expect(balance()).toBe(1000);
      // None of the refused requests used up the id: the genuine request still runs, once.
      expect(await status(await signControlPlaneRequest(secretA, "POST", path, body))).toBe(200);
      expect(balance()).toBe(1000 - DEBIT);
    });
  }
});
