import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigration } from "@poc/sdk";
import { createSqliteD1 } from "../../credit-wallet/client/test/support/sqlite-d1.ts";
import { ScriptingSandboxService } from "../src/sandbox.ts";

const repoRoot = process.cwd();
const migrationSql = readFileSync(join(repoRoot, "bricks/scripting-sandbox/migrations/0001_scripting_sandbox.sql"), "utf8");

describe("Scripting Sandbox Escape Suite (UC6.6 Task 2)", () => {
  let db: ReturnType<typeof createSqliteD1>;
  let service: ScriptingSandboxService;

  beforeEach(async () => {
    db = createSqliteD1();
    await applyMigration(db, migrationSql);
    service = new ScriptingSandboxService(db);
  });

  afterAll(() => {
    db?.close();
  });

  it("Case 1: this.constructor.constructor('return globalThis')() must yield status error with no leak", async () => {
    const script = await service.createScript({
      workspaceId: "ws_escape",
      name: "escape-constructor",
      triggerEvent: "test",
      sourceCode: `
        function main() {
          const fn = (this?.["con"+"structor"] || ({}).constructor)["con"+"structor"];
          return fn("return globalThis")();
        }
      `,
    });

    const res = await service.executeScript("ws_escape", script.id, {});
    // Must yield status "error" with no globalThis leak
    expect(res.status).toBe("error");
    expect(res.output_payload).toBeNull();
  });

  it("Case 2: ({}).__lookupGetter__ must yield status error or sanitized result with no prototype leak", async () => {
    const script = await service.createScript({
      workspaceId: "ws_escape",
      name: "escape-lookup-getter",
      triggerEvent: "test",
      sourceCode: `
        function main() {
          const getter = ({}).__lookupGetter__?.("__proto__");
          return getter ? getter() : null;
        }
      `,
    });

    const res = await service.executeScript("ws_escape", script.id, {});
    if (res.status === "success") {
      expect(res.output_payload).toBeNull();
    } else {
      expect(res.status).toBe("error");
    }
  });

  it("Case 3: Reflect.getPrototypeOf(async function(){}).constructor must yield status error with no leak", async () => {
    const script = await service.createScript({
      workspaceId: "ws_escape",
      name: "escape-async-constructor",
      triggerEvent: "test",
      sourceCode: `
        function main() {
          const AsyncFn = Reflect.getPrototypeOf(async function(){})["con"+"structor"];
          return AsyncFn("return globalThis")();
        }
      `,
    });

    const res = await service.executeScript("ws_escape", script.id, {});
    expect(res.status).toBe("error");
    expect(res.output_payload).toBeNull();
  });

  it("Case 4: import('cloudflare:workers') must yield status error with no leak", async () => {
    const script = await service.createScript({
      workspaceId: "ws_escape",
      name: "escape-import",
      triggerEvent: "test",
      sourceCode: `
        async function main() {
          const mod = await import("cloudflare:workers");
          return mod;
        }
      `,
    });

    const res = await service.executeScript("ws_escape", script.id, {});
    expect(res.status).toBe("error");
    expect(res.output_payload).toBeNull();
  });

  it("Case 5: reading env/caches/fetch via computed keys must not leak host bindings, secrets, or fetch", async () => {
    const script = await service.createScript({
      workspaceId: "ws_escape",
      name: "escape-computed-keys",
      triggerEvent: "test",
      sourceCode: `
        function main() {
          const g = typeof globalThis !== "undefined" ? globalThis : {};
          const f = g["fe"+"tch"];
          const c = g["ca"+"ches"];
          const e = g["e"+"nv"] || g["process"]?.["e"+"nv"];
          return {
            hasFetch: typeof f === "function",
            hasCaches: typeof c !== "undefined",
            hasEnv: typeof e !== "undefined" && Object.keys(e).length > 0
          };
        }
      `,
    });

    const res = await service.executeScript("ws_escape", script.id, {});
    if (res.status === "success") {
      const out = res.output_payload as any;
      expect(out.hasFetch).toBe(false);
      expect(out.hasCaches).toBe(false);
      expect(out.hasEnv).toBe(false);
    } else {
      expect(res.status).toBe("error");
    }
  });

  it("Case 6: Atomics.wait must yield status error or cannot stall host", async () => {
    const script = await service.createScript({
      workspaceId: "ws_escape",
      name: "escape-atomics",
      triggerEvent: "test",
      sourceCode: `
        function main() {
          if (typeof Atomics !== "undefined" && typeof Atomics.wait === "function") {
            const sab = new SharedArrayBuffer(4);
            const int32 = new Int32Array(sab);
            Atomics.wait(int32, 0, 0, 100);
            return "waited";
          }
          throw new Error("Atomics.wait disallowed");
        }
      `,
    });

    const res = await service.executeScript("ws_escape", script.id, {});
    expect(res.status).toBe("error");
  });

  it("Case 7: prototype pollution of Object.prototype must not be visible to the next execution", async () => {
    // Tenant 1 tries to pollute Object.prototype
    const script1 = await service.createScript({
      workspaceId: "ws_tenant_1",
      name: "polluter",
      triggerEvent: "test",
      sourceCode: `
        function main() {
          Object.prototype.polluted_secret_token = "injected_leak_9876";
          return { done: true };
        }
      `,
    });
    await service.executeScript("ws_tenant_1", script1.id, {});

    // Tenant 2 executes clean script
    const script2 = await service.createScript({
      workspaceId: "ws_tenant_2",
      name: "victim",
      triggerEvent: "test",
      sourceCode: `
        function main() {
          const testObj = {};
          return { leaked: testObj["polluted_secret_token"] ?? null };
        }
      `,
    });
    const res2 = await service.executeScript("ws_tenant_2", script2.id, {});

    if (res2.status === "success") {
      expect((res2.output_payload as any).leaked).toBeNull();
    } else {
      expect(res2.status).toBe("error");
    }

    // Clean up host Object.prototype if today's implementation leaked it
    delete (Object.prototype as any).polluted_secret_token;
  });

  it("Case 8: setTimeout survival past the response must yield status error or no leakage", async () => {
    const script = await service.createScript({
      workspaceId: "ws_escape",
      name: "escape-timeout",
      triggerEvent: "test",
      sourceCode: `
        function main() {
          if (typeof setTimeout === "function") {
            setTimeout(() => {
              (Object.prototype as any).survived_timeout = true;
            }, 5);
            return { scheduled: true };
          }
          throw new Error("setTimeout not allowed");
        }
      `,
    });

    const res = await service.executeScript("ws_escape", script.id, {});
    expect(res.status).toBe("error");
  });
});
