import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_scripting_sandbox.sql?raw";
import { ScriptingSandboxService, validateScriptSource, executeSandboxed, createScriptingRoutes } from "../src/index.ts";
import type { ScriptEnv } from "../src/middleware.ts";
import type { ScriptIsolate } from "../src/isolate.ts";
import type { ExecutionResult } from "../src/sandbox.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_scr_alpha";
const WS_BETA = "ws_scr_beta";

const testIsolate: ScriptIsolate = {
  async run(code: string, payload: unknown): Promise<ExecutionResult> {
    const startTime = Date.now();
    try {
      const cloned = JSON.parse(JSON.stringify(payload ?? {}));
      const runner = new Function(
        "payload",
        "Math",
        "JSON",
        "Date",
        "Number",
        "String",
        "Boolean",
        "Array",
        "Object",
        `
        "use strict";
        ${code}
        if (typeof main === 'function') {
          return main(payload);
        }
        return null;
        `,
      );
      const output = runner(cloned, Math, JSON, Date, Number, String, Boolean, Array, Object);
      return {
        status: "success",
        durationMs: Math.max(1, Date.now() - startTime),
        result: output,
        errorMessage: null,
      };
    } catch (err: any) {
      return {
        status: "error",
        durationMs: Math.max(1, Date.now() - startTime),
        result: null,
        errorMessage: err.message || "Script execution threw an error",
      };
    }
  },
};

const testLoader = {
  load: async () => ({
    fetch: async (req: Request) => {
      const body = (await req.json()) as any;
      const payload = body?.payload;
      if (payload?.text) {
        return new Response(JSON.stringify({ upper: payload.text.toUpperCase() }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (payload?.title) {
        return new Response(JSON.stringify({ slug: payload.title.toLowerCase().replace(/\s+/g, "-") }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(null), {
        headers: { "content-type": "application/json" },
      });
    },
  }),
};

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS scr_executions").run();
  await db.prepare("DROP TABLE IF EXISTS scr_scripts").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Scripting Sandbox Security & Validator", () => {
  it("enforces script size cap (<= 64 KiB) and structure requirements", () => {
    // Exceeds 64 KiB
    const oversized = "function main() { return '" + "x".repeat(65 * 1024) + "'; }";
    expect(validateScriptSource(oversized).valid).toBe(false);
    expect(validateScriptSource(oversized).error).toMatch(/exceeds maximum allowed size/i);

    // Missing main or return
    expect(validateScriptSource("const a = 1;").valid).toBe(false);
    expect(validateScriptSource("const a = 1;").error).toMatch(/must define a 'main/i);

    // Valid pure function
    expect(validateScriptSource("function main(p) { return { sum: p.a + p.b }; }").valid).toBe(true);
  });

  it("fails closed with SCRIPT_ISOLATION_UNAVAILABLE when no isolate is configured (AC4)", async () => {
    const res = await executeSandboxed("function main() { return 42; }", {});
    expect(res.status).toBe("error");
    expect(res.errorMessage).toBe("SCRIPT_ISOLATION_UNAVAILABLE");
  });

  it("safely evaluates pure mathematical calculations and data transformations with isolate", async () => {
    const code = `
      function main(payload) {
        const subtotal = payload.items.reduce((acc, it) => acc + (it.price * it.qty), 0);
        const tax = Math.round(subtotal * 0.08 * 100) / 100;
        return {
          subtotal,
          tax,
          total: subtotal + tax
        };
      }
    `;

    const res = await executeSandboxed(
      code,
      {
        items: [
          { price: 10, qty: 2 },
          { price: 25, qty: 1 },
        ],
      },
      testIsolate,
    );

    expect(res.status).toBe("success");
    expect(res.result).toEqual({
      subtotal: 45,
      tax: 3.6,
      total: 48.6,
    });
    expect(res.durationMs).toBeGreaterThanOrEqual(1);
  });

  it("prevents script from mutating caller payload reference", async () => {
    const code = `
      function main(payload) {
        payload.injected = "tampered";
        return payload;
      }
    `;
    const original = { initial: "value" };
    const res = await executeSandboxed(code, original, testIsolate);

    expect(res.status).toBe("success");
    expect((res.result as any).injected).toBe("tampered");
    expect((original as any).injected).toBeUndefined();
  });
});

describe("Scripting Sandbox Core Service", () => {
  it("fails closed with SCRIPT_ISOLATION_UNAVAILABLE when service lacks isolate binding (AC4)", async () => {
    const serviceNoIsolate = new ScriptingSandboxService(db);
    const script = await serviceNoIsolate.createScript({
      workspaceId: WS_ALPHA,
      name: "No Binding Test",
      triggerEvent: "test",
      sourceCode: "function main() { return 1; }",
    });

    const run = await serviceNoIsolate.executeScript(WS_ALPHA, script.id, {});
    expect(run.status).toBe("error");
    expect(run.error_message).toBe("SCRIPT_ISOLATION_UNAVAILABLE");
  });

  it("registers scripts, executes, and records execution audit logs", async () => {
    const service = new ScriptingSandboxService(db, testIsolate);

    const script = await service.createScript({
      workspaceId: WS_ALPHA,
      name: "Discount Calculator",
      triggerEvent: "checkout.calculate",
      sourceCode: `
        function main(payload) {
          if (payload.coupon === 'SAVE20') {
            return { discount: payload.total * 0.2 };
          }
          return { discount: 0 };
        }
      `,
    });

    expect(script.id).toMatch(/^scr_[a-f0-9]{32}$/);
    expect(script.is_enabled).toBe(true);

    // Run with coupon
    const run1 = await service.executeScript(WS_ALPHA, script.id, { total: 100, coupon: "SAVE20" });
    expect(run1.status).toBe("success");
    expect((run1.output_payload as any).discount).toBe(20);

    // Run without coupon
    const run2 = await service.executeScript(WS_ALPHA, script.id, { total: 50 });
    expect(run2.status).toBe("success");
    expect((run2.output_payload as any).discount).toBe(0);

    // Verify execution audit logs
    const logs = await service.getExecutionLogs(WS_ALPHA, script.id);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.status).toBe("success");

    // Disable script and verify execution failure
    await service.updateScript(WS_ALPHA, script.id, { isEnabled: false });
    await expect(service.executeScript(WS_ALPHA, script.id, { total: 100 })).rejects.toThrow("disabled");
  });

  it("enforces multi-tenant workspace isolation and cascade deletion", async () => {
    const service = new ScriptingSandboxService(db, testIsolate);

    const script = await service.createScript({
      workspaceId: WS_ALPHA,
      name: "Alpha Custom Logic",
      triggerEvent: "user.created",
      sourceCode: "function main(p) { return { ok: true }; }",
    });

    // Beta cannot view or execute Alpha script
    const betaList = await service.listScripts(WS_BETA);
    expect(betaList).toHaveLength(0);

    const crossGet = await service.getScript(WS_BETA, script.id);
    expect(crossGet).toBeNull();

    await expect(service.executeScript(WS_BETA, script.id, {})).rejects.toThrow("not found");

    // Deletion
    const deleted = await service.deleteScript(WS_ALPHA, script.id);
    expect(deleted).toBe(true);
  });
});

describe("Scripting Sandbox REST API", () => {
  function createApp(workspaceId: string = WS_ALPHA) {
    const app = new Hono<ScriptEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: workspaceId, role: "admin" });
      c.set("ctx", Object.freeze({ userId: "usr_script_admin", workspaceId, role: "admin" }));
      c.set("user", { uid: "usr_script_admin", name: "Script Dev" });
      await next();
    });
    app.route("/", createScriptingRoutes());
    return app;
  }

  it("fails closed with SCRIPT_ISOLATION_UNAVAILABLE when binding is absent (AC4)", async () => {
    const app = createApp();
    const testRes = await app.request(
      "http://localhost/scripts/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCode: "function main(p) { return { upper: p.text.toUpperCase() }; }",
          payload: { text: "hello edge" },
        }),
      },
      { DB: db },
    );
    expect(testRes.status).toBe(200);
    const testJson = (await testRes.json()) as any;
    expect(testJson.status).toBe("error");
    expect(testJson.errorMessage).toBe("SCRIPT_ISOLATION_UNAVAILABLE");
  });

  it("story 0.11 ID_GUESS: GET /scripts/:id/executions answers 404 for another workspace's script id, 200 for its own", async () => {
    const service = new ScriptingSandboxService(db, testIsolate);
    const script = await service.createScript({
      workspaceId: WS_ALPHA,
      name: "Alpha Only",
      triggerEvent: "user.created",
      sourceCode: "function main(p) { return { ok: true }; }",
    });

    const foreign = await createApp(WS_BETA).request(`http://localhost/scripts/${script.id}/executions`, { method: "GET" }, { DB: db });
    expect(foreign.status).toBe(404);

    const own = await createApp(WS_ALPHA).request(`http://localhost/scripts/${script.id}/executions`, { method: "GET" }, { DB: db });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { executions: unknown[] }).executions).toEqual([]);
  });

  it("creates, runs, dry-run tests, and retrieves logs via HTTP when loader binding is present", async () => {
    const app = createApp();

    // 1. Dry run test bench without saving
    const testRes = await app.request(
      "http://localhost/scripts/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCode: "function main(p) { return { upper: p.text.toUpperCase() }; }",
          payload: { text: "hello edge" },
        }),
      },
      { DB: db, SCRIPT_LOADER: testLoader },
    );
    expect(testRes.status).toBe(200);
    const testJson = (await testRes.json()) as any;
    expect(testJson.status).toBe("success");
    expect(testJson.result.upper).toBe("HELLO EDGE");

    // 2. Create script
    const createRes = await app.request(
      "http://localhost/scripts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Slugifier",
          triggerEvent: "article.publish",
          sourceCode: "function main(p) { return { slug: p.title.toLowerCase().replace(/\\s+/g, '-') }; }",
        }),
      },
      { DB: db, SCRIPT_LOADER: testLoader },
    );
    expect(createRes.status).toBe(201);
    const script = (await createRes.json()) as any;

    // 3. Execute script
    const runRes = await app.request(
      `http://localhost/scripts/${script.id}/run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: { title: "Next Generation Edge Architecture" },
        }),
      },
      { DB: db, SCRIPT_LOADER: testLoader },
    );
    expect(runRes.status).toBe(200);
    const runJson = (await runRes.json()) as any;
    expect(runJson.output_payload.slug).toBe("next-generation-edge-architecture");

    // 4. Get execution logs
    const logsRes = await app.request(`http://localhost/scripts/${script.id}/executions`, { method: "GET" }, { DB: db, SCRIPT_LOADER: testLoader });
    expect(logsRes.status).toBe(200);
    const logsJson = (await logsRes.json()) as any;
    expect(logsJson.executions).toHaveLength(1);

    // 5. Delete script
    const delRes = await app.request(`http://localhost/scripts/${script.id}`, { method: "DELETE" }, { DB: db, SCRIPT_LOADER: testLoader });
    expect(delRes.status).toBe(200);
  });

  it("rejects malicious script registration with 400 when invalid structure", async () => {
    const app = createApp();

    const badRes = await app.request(
      "http://localhost/scripts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Attacker Script",
          triggerEvent: "bad.event",
          sourceCode: "var x = 1;",
        }),
      },
      { DB: db },
    );
    expect(badRes.status).toBe(400);
  });
});
