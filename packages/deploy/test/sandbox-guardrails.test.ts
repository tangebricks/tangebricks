import { describe, expect, it } from "vitest";
import { assemble, computeBuildHash, computeCodeHash, computeGraphHash } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import aiCreditsSaasJson from "../../../presets/ai-credits-saas.blueprint.json";
import {
  HostedSandboxTarget,
  PlatformSandboxDeployTargetSchema,
  SANDBOX_D1_MAX_BYTES,
  SANDBOX_D1_MAX_ROWS,
  SANDBOX_DAILY_REQUEST_LIMIT,
  SANDBOX_OUTBOUND_RPM_LIMIT,
  SANDBOX_TTL_MS,
  SandboxDispatchPlatform,
  SandboxGuardrailError,
  assertNoLivePaymentCredential,
  createSandboxDispatcher,
  createSandboxOutboundFetch,
} from "../src/index.ts";
import type { DeployBuildArtifactInput } from "../src/index.ts";

async function buildPresetArtifact(): Promise<DeployBuildArtifactInput> {
  const assembled = assemble(aiCreditsSaasJson, catalog);
  if (!assembled.ok) {
    throw new Error(`Failed to assemble preset: ${assembled.errors.join("; ")}`);
  }
  const buildHash = await computeBuildHash(assembled.files);
  const codeHash = await computeCodeHash(assembled.files);
  const graphHash = await computeGraphHash(assembled.files);
  const migrations: Array<{ name: string; sql: string; sha256: string }> = [];
  for (const [filePath, sql] of Object.entries(assembled.files)) {
    if (filePath.startsWith("migrations/") && filePath.endsWith(".sql")) {
      const name = filePath.slice("migrations/".length);
      migrations.push({ name, sql, sha256: `sha256_${name}` });
    }
  }
  const graphs: Record<string, string> = {};
  for (const wf of aiCreditsSaasJson.workflows ?? []) {
    graphs[wf.id] = JSON.stringify(wf);
  }
  return {
    project: aiCreditsSaasJson.project,
    buildHash,
    codeHash,
    graphHash,
    bundle: {
      code: assembled.files["src/index.ts"] ?? "export default {};",
      sha256: codeHash,
    },
    migrations,
    graphs,
    identity: "core-auth",
  };
}

describe("Story 9.2 — Sandbox quotas, 7-day TTL expiry, and abuse/SSRF/live-payment guardrails", () => {
  it("AC 1: Per-sandbox daily request quota (10,000 req/day) returns HTTP 429 SANDBOX_QUOTA_EXCEEDED on the 10,001st request and resets on next UTC day", async () => {
    let clockMs = Date.parse("2026-11-01T10:00:00.000Z");
    const platform = new SandboxDispatchPlatform({
      now: () => clockMs,
    });
    const sandboxTarget = new HostedSandboxTarget({ platform });
    const target = PlatformSandboxDeployTargetSchema.parse({
      type: "platform-sandbox",
      sandboxId: "sbx-quota-10k",
      dispatchNamespace: "px-sandbox-preview",
      projectId: "ai-credits-saas",
    });
    const artifact = await buildPresetArtifact();
    await sandboxTarget.apply(artifact, target);

    const dispatcher = createSandboxDispatcher(platform);

    // Seed 9,999 requests and run the 10,000th request via dispatcher
    platform.setDailyRequestCount("sbx-quota-10k", SANDBOX_DAILY_REQUEST_LIMIT - 1, clockMs);

    const req10000 = await dispatcher.fetch(new Request("https://sbx-quota-10k.sandbox.projectx.dev/health"));
    expect(req10000.status).toBe(200);
    expect(platform.getDailyRequestCount("sbx-quota-10k", clockMs)).toBe(SANDBOX_DAILY_REQUEST_LIMIT);

    // 10,001st request must fail with 429 SANDBOX_QUOTA_EXCEEDED + upgrade CTA
    const req10001 = await dispatcher.fetch(new Request("https://sbx-quota-10k.sandbox.projectx.dev/health"));
    expect(req10001.status).toBe(429);
    const body10001 = (await req10001.json()) as {
      error: {
        code: string;
        message: string;
        upgradeCta: string;
        dailyLimit: number;
      };
    };
    expect(body10001.error.code).toBe("SANDBOX_QUOTA_EXCEEDED");
    expect(body10001.error.dailyLimit).toBe(10_000);
    expect(body10001.error.upgradeCta).toBe("Move to my Cloudflare account");

    // Advancing clock to next UTC day resets the counter
    clockMs = Date.parse("2026-11-02T00:01:00.000Z");
    const nextDayRes = await dispatcher.fetch(new Request("https://sbx-quota-10k.sandbox.projectx.dev/health"));
    expect(nextDayRes.status).toBe(200);
  });

  it("AC 2: D1 storage cap (10,000 rows or 25 MB) rejects INSERT and UPDATE with 403 SANDBOX_STORAGE_CAP_EXCEEDED while allowing SELECT and DELETE", async () => {
    const platform = new SandboxDispatchPlatform();
    const sandboxTarget = new HostedSandboxTarget({ platform });
    const target = PlatformSandboxDeployTargetSchema.parse({
      type: "platform-sandbox",
      sandboxId: "sbx-storage-cap",
      dispatchNamespace: "px-sandbox-preview",
      projectId: "ai-credits-saas",
    });
    const artifact = await buildPresetArtifact();
    await sandboxTarget.apply(artifact, target);

    const dbRecord = platform.getDatabase("sbx-storage-cap");
    expect(dbRecord).not.toBeNull();
    if (!dbRecord) return;

    const guardedD1 = dbRecord.d1Binding;
    await guardedD1.prepare("CREATE TABLE IF NOT EXISTS sample_items (id TEXT PRIMARY KEY, name TEXT)").run();

    // Insert 1 initial row before cap is reached
    await guardedD1.prepare("INSERT INTO sample_items (id, name) VALUES (?, ?)").bind("row_1", "Alpha").run();
    const initialStats = await guardedD1.getStorageStats();
    expect(initialStats.totalRows).toBeGreaterThanOrEqual(1);

    // Simulate reaching 10,000 rows cap
    guardedD1.setSimulatedStorageStats({ totalRows: SANDBOX_D1_MAX_ROWS });

    // INSERT must fail with 403 SANDBOX_STORAGE_CAP_EXCEEDED
    await expect(guardedD1.prepare("INSERT INTO sample_items (id, name) VALUES (?, ?)").bind("row_overflow", "Blocked").run()).rejects.toMatchObject({
      code: "SANDBOX_STORAGE_CAP_EXCEEDED",
      status: 403,
    });

    // UPDATE must also fail with 403 SANDBOX_STORAGE_CAP_EXCEEDED
    await expect(guardedD1.prepare("UPDATE sample_items SET name = ? WHERE id = ?").bind("Updated", "row_1").run()).rejects.toMatchObject({
      code: "SANDBOX_STORAGE_CAP_EXCEEDED",
      status: 403,
    });

    // SELECT succeeds even when storage cap is reached
    const selectRes = await guardedD1.prepare("SELECT * FROM sample_items").all();
    expect(selectRes.success).toBe(true);
    expect(selectRes.results.length).toBeGreaterThanOrEqual(1);

    // DELETE succeeds so user can free space
    const deleteRes = await guardedD1.prepare("DELETE FROM sample_items WHERE id = ?").bind("row_1").run();
    expect(deleteRes.success).toBe(true);

    // Also verify 25 MB byte cap blocks INSERT/UPDATE via dispatcher HTTP response (403 SANDBOX_STORAGE_CAP_EXCEEDED)
    guardedD1.setSimulatedStorageStats({
      totalRows: 5,
      totalBytes: SANDBOX_D1_MAX_BYTES,
    });
    const dispatcher = createSandboxDispatcher(platform);
    const writeRes = await dispatcher.fetch(
      new Request("https://sbx-storage-cap.sandbox.projectx.dev/data/sample_items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "row_bytes_overflow", name: "TooBig" }),
      }),
    );
    expect(writeRes.status).toBe(403);
    const writeErrBody = (await writeRes.json()) as {
      error: { code: string; maxBytes: number; maxRows: number };
    };
    expect(writeErrBody.error.code).toBe("SANDBOX_STORAGE_CAP_EXCEEDED");
    expect(writeErrBody.error.maxRows).toBe(10_000);
    expect(writeErrBody.error.maxBytes).toBe(25 * 1024 * 1024);

    // GET (SELECT) and DELETE via dispatcher still succeed at 25 MB cap
    const readRes = await dispatcher.fetch(new Request("https://sbx-storage-cap.sandbox.projectx.dev/data/sample_items"));
    expect(readRes.status).toBe(200);
  });

  it("AC 3: 7-day TTL expiry returns HTTP 410 SANDBOX_EXPIRED when simulated clock advances past 7 days", async () => {
    const startMs = Date.parse("2026-11-01T12:00:00.000Z");
    let clockMs = startMs;
    const platform = new SandboxDispatchPlatform({
      now: () => clockMs,
    });
    const sandboxTarget = new HostedSandboxTarget({ platform });
    const target = PlatformSandboxDeployTargetSchema.parse({
      type: "platform-sandbox",
      sandboxId: "sbx-ttl-7d",
      dispatchNamespace: "px-sandbox-preview",
      projectId: "ai-credits-saas",
    });
    const artifact = await buildPresetArtifact();
    await sandboxTarget.apply(artifact, target);

    const dispatcher = createSandboxDispatcher(platform);

    // Before expiry (6 days later): returns 200 OK
    clockMs = startMs + 6 * 24 * 60 * 60 * 1000;
    const activeRes = await dispatcher.fetch(new Request("https://sbx-ttl-7d.sandbox.projectx.dev/health"));
    expect(activeRes.status).toBe(200);

    // Past 7-day TTL: returns 410 SANDBOX_EXPIRED
    clockMs = startMs + SANDBOX_TTL_MS + 1000;
    const expiredRes = await dispatcher.fetch(new Request("https://sbx-ttl-7d.sandbox.projectx.dev/health"));
    expect(expiredRes.status).toBe(410);
    const expiredBody = (await expiredRes.json()) as {
      error: { code: string; message: string };
    };
    expect(expiredBody.error.code).toBe("SANDBOX_EXPIRED");
  });

  it("AC 4: Outbound rate limit (60 req/min) rejects 61st call with 429 SANDBOX_OUTBOUND_RATE_LIMITED and blocks private IP / localhost / metadata / non-HTTPS SSRF targets with 403 SANDBOX_SSRF_BLOCKED", async () => {
    let clockMs = Date.parse("2026-11-01T15:00:00.000Z");
    const guardedFetch = createSandboxOutboundFetch({
      sandboxId: "sbx-outbound-test",
      now: () => clockMs,
      baseFetch: async (input) =>
        new Response(JSON.stringify({ ok: true, url: String(input) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    // 1. SSRF and non-HTTPS targets are blocked immediately with 403 SANDBOX_SSRF_BLOCKED
    const blockedUrls = [
      "http://api.example.com/v1/insecure",
      "https://localhost/admin",
      "https://127.0.0.1:8080/internal",
      "https://10.0.0.42/private",
      "https://172.16.5.4/vpc",
      "https://192.168.1.1/router",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/loopback",
      "https://internal.service.local/secret",
    ];
    for (const badUrl of blockedUrls) {
      const res = await guardedFetch(badUrl);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SANDBOX_SSRF_BLOCKED");
    }

    // 2. 60 HTTPS requests in 1 minute succeed
    for (let i = 0; i < SANDBOX_OUTBOUND_RPM_LIMIT; i += 1) {
      const res = await guardedFetch(`https://api.github.com/zen?call=${i}`);
      expect(res.status).toBe(200);
    }

    // 3. 61st outbound fetch in the same minute fails with 429 SANDBOX_OUTBOUND_RATE_LIMITED
    const res61 = await guardedFetch("https://api.github.com/zen?call=61");
    expect(res61.status).toBe(429);
    const body61 = (await res61.json()) as { error: { code: string } };
    expect(body61.error.code).toBe("SANDBOX_OUTBOUND_RATE_LIMITED");

    // 4. Advancing clock by 61 seconds allows outbound requests again
    clockMs += 61_000;
    const afterWindowRes = await guardedFetch("https://api.github.com/zen?call=after");
    expect(afterWindowRes.status).toBe(200);
  });

  it("AC 5: Live-payment credentials (sk_live_*, rk_live_*, whsec_live_*) and live payment charge endpoints fail with 403 SANDBOX_LIVE_PAYMENTS_BLOCKED, while test-mode credentials (sk_test_*) succeed", async () => {
    const platform = new SandboxDispatchPlatform();
    const sandboxTarget = new HostedSandboxTarget({ platform });
    const target = PlatformSandboxDeployTargetSchema.parse({
      type: "platform-sandbox",
      sandboxId: "sbx-payments-guard",
      dispatchNamespace: "px-sandbox-preview",
      projectId: "ai-credits-saas",
    });
    const artifact = await buildPresetArtifact();
    await sandboxTarget.apply(artifact, target);

    // 1. Binding sk_live_12345 on HostedSandboxTarget fails with 403 SANDBOX_LIVE_PAYMENTS_BLOCKED
    await expect(sandboxTarget.putSecret(target, "STRIPE_SECRET_KEY", "sk_live_12345")).rejects.toMatchObject({
      code: "SANDBOX_LIVE_PAYMENTS_BLOCKED",
      status: 403,
    });

    // 2. Direct helper check for sk_live_*, rk_live_*, whsec_live_*
    expect(() => assertNoLivePaymentCredential("STRIPE_SECRET_KEY", "sk_live_12345")).toThrowError(SandboxGuardrailError);
    expect(() => assertNoLivePaymentCredential("STRIPE_RESTRICTED_KEY", "rk_live_98765")).toThrowError(SandboxGuardrailError);
    expect(() => assertNoLivePaymentCredential("STRIPE_WEBHOOK_SECRET", "whsec_live_abcdef")).toThrowError(SandboxGuardrailError);

    // 3. Binding sk_test_12345 succeeds cleanly
    const testSecret = await sandboxTarget.putSecret(target, "STRIPE_SECRET_KEY", "sk_test_12345");
    expect(testSecret.secretName).toBe("STRIPE_SECRET_KEY");

    // 4. Outbound fetch to Stripe /v1/charges or /v1/payment_intents with sk_live_* or without test key fails with 403 SANDBOX_LIVE_PAYMENTS_BLOCKED
    const guardedFetch = createSandboxOutboundFetch({
      sandboxId: "sbx-payments-guard",
      baseFetch: async () =>
        new Response(JSON.stringify({ id: "ch_test_ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const liveChargeRes = await guardedFetch("https://api.stripe.com/v1/charges", {
      method: "POST",
      headers: { authorization: "Bearer sk_live_12345" },
    });
    expect(liveChargeRes.status).toBe(403);
    const liveChargeBody = (await liveChargeRes.json()) as {
      error: { code: string };
    };
    expect(liveChargeBody.error.code).toBe("SANDBOX_LIVE_PAYMENTS_BLOCKED");

    const noTestKeyIntentRes = await guardedFetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(noTestKeyIntentRes.status).toBe(403);
    const noTestKeyIntentBody = (await noTestKeyIntentRes.json()) as {
      error: { code: string };
    };
    expect(noTestKeyIntentBody.error.code).toBe("SANDBOX_LIVE_PAYMENTS_BLOCKED");

    // 5. Outbound fetch to Stripe /v1/charges with Bearer sk_test_12345 succeeds
    const testChargeRes = await guardedFetch("https://api.stripe.com/v1/charges", {
      method: "POST",
      headers: { authorization: "Bearer sk_test_12345" },
    });
    expect(testChargeRes.status).toBe(200);
  });
});
