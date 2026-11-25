// Story 1.17: one replay-resistant, domain-separated control-plane scheme; a separate webhook domain; per-project,
// per-purpose derived secrets; one-time request ids.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  CONTROL_REQUEST_RETENTION_MS,
  SIGNED_AT_HEADER,
  TELEMETRY_SIGNATURE_HEADER,
  admitExecutingControlRequest,
  checkControlPlaneSignature,
  claimControlRequest,
  controlPlaneCanonical,
  deriveProjectSecret,
  deriveProjectTelemetrySecret,
  signControlPlaneRequest,
  signTelemetryPayload,
  signTelemetryWebhook,
  verifyTelemetryWebhook,
} from "../src/index.ts";

const db = (env as unknown as { DB: D1Like }).DB;
const ROOT = "story-1-17-root-secret-0123456789";

describe("story 1.17: control-plane v1 signing", () => {
  test("the canonical string starts with the px-control-plane/v1 domain", () => {
    expect(controlPlaneCanonical("post", "/__px/runs", "123", "{}")).toBe("px-control-plane/v1\nPOST\n/__px/runs\n123\n{}");
  });

  test("a webhook signature never verifies as a control-plane request, and the reverse", async () => {
    const body = JSON.stringify({ requestId: crypto.randomUUID(), workspaceId: "ws_a" });
    const secret = await deriveProjectSecret(ROOT, "proj-a", "control-plane");

    // A webhook signature over the body, presented to a control-plane route with a fresh timestamp: refused.
    const webhookSig = await signTelemetryWebhook(body, secret);
    const asControl = new Request("http://w.invalid/__px/runs", {
      method: "POST",
      headers: { [SIGNED_AT_HEADER]: String(Math.floor(Date.now() / 1000)), [TELEMETRY_SIGNATURE_HEADER]: webhookSig },
      body,
    });
    expect((await checkControlPlaneSignature(asControl, { secret, body }))?.code).toBe("UNAUTHORIZED_TELEMETRY_SIGNATURE");

    // A control-plane signature presented as a webhook signature for the same body: refused.
    const control = await signControlPlaneRequest(secret, "POST", "/__px/runs", body);
    expect(await verifyTelemetryWebhook(body, control[TELEMETRY_SIGNATURE_HEADER], secret)).toBe(false);
    // A legacy body-only HMAC verifies as neither.
    const legacy = await signTelemetryPayload(body, secret);
    expect(await verifyTelemetryWebhook(body, legacy, secret)).toBe(false);
    expect(await verifyTelemetryWebhook(body, webhookSig, secret)).toBe(true);
  });

  test("derived secrets: per project and per purpose; the webhook purpose is byte-compatible with story 1.4", async () => {
    const legacyWebhook = (await signTelemetryPayload("telemetry-webhook:proj-a", ROOT)).slice("sha256=".length);
    expect(await deriveProjectSecret(ROOT, "proj-a", "telemetry-webhook")).toBe(legacyWebhook);
    expect(await deriveProjectTelemetrySecret(ROOT, "proj-a")).toBe(legacyWebhook);
    const controlA = await deriveProjectSecret(ROOT, "proj-a", "control-plane");
    const controlB = await deriveProjectSecret(ROOT, "proj-b", "control-plane");
    expect(new Set([controlA, controlB, legacyWebhook, ROOT]).size).toBe(4);
    await expect(deriveProjectSecret(ROOT, " ", "control-plane")).rejects.toThrow();
    await expect(deriveProjectSecret(ROOT, "proj-a", "other" as never)).rejects.toThrow();

    // Signed with project A's derived secret, refused by project B's verifier.
    const body = "{}";
    const signed = await signControlPlaneRequest(controlA, "POST", "/__px/runs", body);
    const req = new Request("http://w.invalid/__px/runs", { method: "POST", headers: signed, body });
    expect(await checkControlPlaneSignature(req, { secret: controlA, body })).toBeNull();
    expect((await checkControlPlaneSignature(req, { secret: controlB, body }))?.code).toBe("UNAUTHORIZED_TELEMETRY_SIGNATURE");
  });

  test("a request id is claimed once; old rows are pruned", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();
    expect(await claimControlRequest(db, { requestId: id, path: "/__px/runs", workspaceId: "ws_a", nowMs: now })).toBe(true);
    expect(await claimControlRequest(db, { requestId: id, path: "/__px/runs", workspaceId: "ws_a", nowMs: now })).toBe(false);
    expect(await claimControlRequest(db, { requestId: id.toUpperCase(), path: "/__px/rehearse", nowMs: now })).toBe(false);

    const old = crypto.randomUUID();
    await claimControlRequest(db, { requestId: old, path: "/__px/runs", nowMs: now - CONTROL_REQUEST_RETENTION_MS - 1000 });
    // Without a forced prune the old row may stay; a pruning claim removes it.
    await claimControlRequest(db, { requestId: crypto.randomUUID(), path: "/__px/runs", nowMs: now, prune: true });
    const row = await db.prepare("SELECT 1 AS hit FROM px_control_requests WHERE request_id = ?1").bind(old).first();
    expect(row).toBeNull();
  });

  test("admitExecutingControlRequest: signature, path, time, requestId and replay", async () => {
    const secret = await deriveProjectSecret(ROOT, "proj-a", "control-plane");
    const path = "/__px/runs";
    const make = async (body: string, headers: Record<string, string>) =>
      new Request(`http://w.invalid${path}`, { method: "POST", headers, body });

    const body = JSON.stringify({ requestId: crypto.randomUUID(), workspaceId: "ws_a" });
    const fresh = await admitExecutingControlRequest(await make(body, await signControlPlaneRequest(secret, "POST", path, body)), { secret, rawBody: body, db });
    expect(fresh.ok).toBe(true);
    const replay = await admitExecutingControlRequest(await make(body, await signControlPlaneRequest(secret, "POST", path, body)), { secret, rawBody: body, db });
    expect(replay.ok ? 200 : replay.response.status).toBe(409);
    if (!replay.ok) expect(((await replay.response.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE_REQUEST");

    const other = JSON.stringify({ requestId: crypto.randomUUID(), workspaceId: "ws_a" });
    const status = async (headers: Record<string, string>, rawBody = other) => {
      const r = await admitExecutingControlRequest(await make(rawBody, headers), { secret, rawBody, db });
      return r.ok ? 200 : r.response.status;
    };
    expect(await status(await signControlPlaneRequest(secret, "POST", "/__px/rehearse", other))).toBe(401); // another path
    expect(await status(await signControlPlaneRequest(secret, "POST", path, other, Date.now() - 301_000))).toBe(401); // stale
    expect(await status({ [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(other, secret) })).toBe(401); // legacy body-only
    const noId = JSON.stringify({ workspaceId: "ws_a" });
    expect(await status(await signControlPlaneRequest(secret, "POST", path, noId), noId)).toBe(400);
    const badId = JSON.stringify({ requestId: "not-a-uuid", workspaceId: "ws_a" });
    expect(await status(await signControlPlaneRequest(secret, "POST", path, badId), badId)).toBe(400);
    // The refused requests above recorded nothing: the fresh id still runs once.
    expect(await status(await signControlPlaneRequest(secret, "POST", path, other))).toBe(200);
  });
});
