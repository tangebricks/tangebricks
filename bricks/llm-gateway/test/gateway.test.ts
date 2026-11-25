import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_llm_gateway.sql?raw";
import migration0002 from "../migrations/0002_billing_status.sql?raw";
import { createAiRoutes, LlmGatewayService, MockLlmAdapter } from "../src/index.ts";
import type { AiEnv } from "../src/routes.ts";

const db = env.DB as D1Like;
const WS_A = "ws_ai_alpha";
const WS_B = "ws_ai_beta";
const USER_A = "usr_alice";

async function resetDb(): Promise<void> {
  for (const table of ["ai_generation_logs", "ai_prompt_templates"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
  await applyMigration(db, migration0002);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("LLM Gateway & Prompt Router Core Logic", () => {
  it("hydrates prompt template variables correctly", () => {
    const service = new LlmGatewayService(db);
    const tmpl = "Translate into {{target_language}}: '{{text}}'";
    const hydrated = service.hydrateTemplate(tmpl, {
      target_language: "French",
      text: "Hello World",
    });
    expect(hydrated).toBe("Translate into French: 'Hello World'");
  });

  it("completes LLM generation, logs token metrics and computes credits in D1", async () => {
    const primary = new MockLlmAdapter("primary");
    const service = new LlmGatewayService(db, [primary], "primary", { billing: "none", models: "gpt-4o-mini:1:2,gpt-4o:5:15" });

    const tmplRes = await service.createTemplate(
      WS_A,
      "Summary Template",
      "Summarize the following document: {{doc}}",
      "gpt-4o"
    );
    expect(tmplRes.ok).toBe(true);
    if (!tmplRes.ok) return;

    // Complete with template
    const compRes = await service.complete(WS_A, USER_A, {
      templateId: tmplRes.template.id,
      variables: { doc: "ProjectX is a modular full-stack SaaS builder." },
    });

    expect(compRes.ok).toBe(true);
    if (!compRes.ok) return;

    expect(compRes.result.text).toContain("[primary:gpt-4o]");
    expect(compRes.result.promptTokens).toBeGreaterThan(0);
    expect(compRes.result.completionTokens).toBeGreaterThan(0);

    // Verify telemetry logged in D1
    const usage = await service.getUsageStats(WS_A);
    expect(usage.requestCount).toBe(1);
    expect(usage.totalPromptTokens).toBe(compRes.result.promptTokens);
    expect(usage.totalCompletionTokens).toBe(compRes.result.completionTokens);
  });

  it("falls back seamlessly to secondary provider when primary provider fails", async () => {
    const flakyPrimary = new MockLlmAdapter("flaky_openai", true); // will throw
    const reliableBackup = new MockLlmAdapter("backup_anthropic", false); // will succeed

    const service = new LlmGatewayService(db, [flakyPrimary, reliableBackup], "flaky_openai", { billing: "none", fallbackProviders: ["backup_anthropic"] });

    const compRes = await service.complete(WS_A, USER_A, {
      prompt: "Explain quantum computing simply",
    });

    expect(compRes.ok).toBe(true);
    if (!compRes.ok) return;

    // Output was served by the backup provider
    expect(compRes.result.provider).toBe("backup_anthropic");
    expect(compRes.result.text).toContain("[backup_anthropic:");
  });

  it("returns 502 error when all providers fail", async () => {
    const dead1 = new MockLlmAdapter("dead1", true);
    const dead2 = new MockLlmAdapter("dead2", true);

    const service = new LlmGatewayService(db, [dead1, dead2], "dead1", { billing: "none", fallbackProviders: "dead2" });

    const compRes = await service.complete(WS_A, USER_A, {
      prompt: "Test query",
    });

    expect(compRes.ok).toBe(false);
    if (compRes.ok) return;
    expect(compRes.code).toBe(502);
    // Story 1.13: the provider's own message (here "rate_limit_exceeded") is never returned.
    expect(compRes.errorCode).toBe("PROVIDER_ERROR");
    expect(compRes.error).toBe("The AI provider could not complete the request");
    expect(compRes.error).not.toMatch(/rate_limit|dead/);
  });

  it("enforces multi-tenant isolation: Workspace B cannot see Workspace A templates or telemetry", async () => {
    const service = new LlmGatewayService(db);
    const tmplRes = await service.createTemplate(WS_A, "Secret Template", "Secret prompt");
    if (!tmplRes.ok) return;

    expect(await service.getTemplate(WS_B, tmplRes.template.id)).toBeNull();
    const listB = await service.listTemplates(WS_B);
    expect(listB).toHaveLength(0);

    const statsB = await service.getUsageStats(WS_B);
    expect(statsB.requestCount).toBe(0);
  });
});

describe("AI Route Handlers (/api/ai/*)", () => {
  const adapter = new MockLlmAdapter("mock_router");

  const createApp = (wsId = WS_A, role: string | null = "member") => {
    const app = new Hono<AiEnv>();

    // Mock workspace & user context (role null = nobody signed in)
    app.use("*", async (c, next) => {
      if (role) {
        c.set("workspace", { id: wsId, role });
        c.set("user", { uid: USER_A, email: "alice@test.com" });
        c.set("ctx", Object.freeze({ userId: USER_A, workspaceId: wsId, role }));
      }
      await next();
    });

    app.route("/api", createAiRoutes({ adapters: [adapter], provider: "mock_router", billing: "none" }));
    return app;
  };

  it("POST /api/ai/generate -> generates completion and GET /api/ai/usage returns telemetry", async () => {
    const app = createApp(WS_A);

    const res = await app.fetch(
      new Request("http://localhost/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Hello AI Assistant" }),
      }),
      { DB: db }
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { text: string; promptTokens: number } };
    expect(json.result.text).toContain("[mock_router:");
    expect(json.result.promptTokens).toBeGreaterThan(0);

    // Check usage via GET /api/ai/usage
    const usageRes = await app.fetch(
      new Request("http://localhost/api/ai/usage"),
      { DB: db }
    );
    expect(usageRes.status).toBe(200);
    const usageJson = (await usageRes.json()) as { usage: { requestCount: number; totalPromptTokens: number } };
    expect(usageJson.usage.requestCount).toBe(1);
    expect(usageJson.usage.totalPromptTokens).toBe(json.result.promptTokens);
  });

  it("story 0.6: POST /api/ai/templates refuses no user (401) and a plain member (403, before validation); admin creates", async () => {
    const post = (app: Hono<AiEnv>, body: string) =>
      app.fetch(new Request("http://localhost/api/ai/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body }), { DB: db });
    const good = JSON.stringify({ name: "Greeting", templateText: "Hello {{name}}" });
    expect((await post(createApp(WS_A, null), good)).status).toBe(401);
    expect((await post(createApp(WS_A, "member"), good)).status).toBe(403);
    expect((await post(createApp(WS_A, "member"), "{bad")).status).toBe(403);
    expect(await new LlmGatewayService(db).listTemplates(WS_A)).toHaveLength(0);
    expect((await post(createApp(WS_A, "admin"), good)).status).toBe(201);
    expect((await post(createApp(WS_A, "owner"), JSON.stringify({ name: "Two", templateText: "x" }))).status).toBe(201);
    expect(await new LlmGatewayService(db).listTemplates(WS_A)).toHaveLength(2);
  });
});

describe("no provider configured (story 0.9, A5)", () => {
  it("LLM_NO_PROVIDER: the assembled wiring (provider workers-ai, no adapter) answers 503 NOT_CONFIGURED with no mock text and no usage logged", async () => {
    const app = new Hono<AiEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_A, role: "member" });
      c.set("user", { uid: USER_A });
      c.set("ctx", Object.freeze({ userId: USER_A, workspaceId: WS_A, role: "member" }));
      await next();
    });
    // As out/max-compatible mounts it: a provider name, no adapters.
    app.route("/api", createAiRoutes({ provider: "workers-ai" }));
    for (const body of [{ prompt: "Hello" }, { prompt: "Hello", fallbackProviders: ["mock"] }]) {
      const res = await app.fetch(
        new Request("http://localhost/api/ai/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        { DB: db },
      );
      expect(res.status).toBe(503);
      const json = (await res.json()) as { code: string; error: string; result?: unknown };
      expect(json.code).toBe("NOT_CONFIGURED");
      expect(json.result).toBeUndefined();
      expect(json.error).not.toMatch(/\[mock/);
    }
    expect((await new LlmGatewayService(db).getUsageStats(WS_A)).requestCount).toBe(0);
  });

  it("a service built with no adapters never falls back to the mock", async () => {
    const res = await new LlmGatewayService(db).complete(WS_A, USER_A, { prompt: "Hello" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(503);
      expect(res.errorCode).toBe("NOT_CONFIGURED");
    }
  });
});

describe("the test-only mock is refused in production (story 0.9)", () => {
  it("with PX_ENVIRONMENT=production an injected MockLlmAdapter is not used: 503 NOT_CONFIGURED", async () => {
    const app = new Hono<AiEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_A, role: "member" });
      c.set("user", { uid: USER_A });
      c.set("ctx", Object.freeze({ userId: USER_A, workspaceId: WS_A, role: "member" }));
      await next();
    });
    app.route("/api", createAiRoutes({ adapters: [new MockLlmAdapter("mock_router")], provider: "mock_router", billing: "none" }));
    const req = () =>
      new Request("http://localhost/api/ai/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Hello" }) });
    const prod = await app.fetch(req(), { DB: db, PX_ENVIRONMENT: "production" });
    expect(prod.status).toBe(503);
    expect(((await prod.json()) as { code: string }).code).toBe("NOT_CONFIGURED");
    expect((await app.fetch(req(), { DB: db, PX_ENVIRONMENT: "preview" })).status).toBe(200);
  });
});
