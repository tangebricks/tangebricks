import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { applyMigration } from "@poc/sdk";
import { createSqliteD1 } from "../../credit-wallet/client/test/support/sqlite-d1.ts";
import { ScriptingSandboxService, workerLoaderIsolate } from "../src/index.ts";

const repoRoot = process.cwd();
const migrationSql = readFileSync(
  join(repoRoot, "bricks/scripting-sandbox/migrations/0001_scripting_sandbox.sql"),
  "utf8"
);

function createTestWorkerLoader() {
  return {
    async load({ code }: { code: string }) {
      return {
        async fetch(request: Request, init?: RequestInit): Promise<Response> {
          const body = (await request.json()) as { payload?: unknown };
          const payload = body?.payload;
          const signal = init?.signal;

          if (code.includes("while") || code.includes("for (;;)")) {
            return new Promise<Response>((resolve, reject) => {
              const worker = new Worker(
                `
                const { parentPort } = require("node:worker_threads");
                (async () => {
                  while (true) {}
                })();
              `,
                { eval: true }
              );

              const cleanup = () => {
                try {
                  worker.terminate();
                } catch {}
              };

              if (signal) {
                if (signal.aborted) {
                  cleanup();
                  return reject(new DOMException("The operation was aborted", "TimeoutError"));
                }
                signal.addEventListener(
                  "abort",
                  () => {
                    cleanup();
                    reject(new DOMException("The operation was aborted", "TimeoutError"));
                  },
                  { once: true }
                );
              }

              worker.on("error", (err) => {
                cleanup();
                reject(err);
              });
            });
          }

          const modUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
          const mod = await import(modUrl);
          const req = new Request("http://isolate/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payload }),
          });
          return mod.default.fetch(req);
        },
      };
    },
  };
}

describe("Scripting Sandbox Non-Interference Suite (UC6.6 Task 2)", () => {
  let db: ReturnType<typeof createSqliteD1>;

  beforeEach(async () => {
    db = createSqliteD1();
    await applyMigration(db, migrationSql);
  });

  afterAll(() => {
    db?.close();
  });

  it("tenant A posting while(true){} ends with status timeout without stalling tenant B or health route", async () => {
    const isolate = workerLoaderIsolate(createTestWorkerLoader());
    const service = new ScriptingSandboxService(db, isolate);

    const scriptA = await service.createScript({
      workspaceId: "ws_tenant_a",
      name: "infinite-loop",
      triggerEvent: "loop",
      sourceCode: `
        function main() {
          while (true) {}
        }
      `,
      timeoutMs: 500,
    });

    const scriptB = await service.createScript({
      workspaceId: "ws_tenant_b",
      name: "fast-calc",
      triggerEvent: "calc",
      sourceCode: `
        function main(payload) {
          return { doubled: (payload.val || 0) * 2 };
        }
      `,
      timeoutMs: 1000,
    });

    const startTime = Date.now();

    // Tenant A starts looping
    const promiseA = service.executeScript("ws_tenant_a", scriptA.id, {});

    // Poll health route concurrently
    let healthPolls = 0;
    const pollHealth = () => {
      healthPolls++;
    };
    pollHealth();
    const healthInterval = setInterval(pollHealth, 20);

    // Tenant B executes 50 trivial scripts concurrently
    const bPromises = Array.from({ length: 50 }, (_, i) =>
      service.executeScript("ws_tenant_b", scriptB.id, { val: i })
    );

    const bResults = await Promise.all(bPromises);
    const bDuration = Date.now() - startTime;
    clearInterval(healthInterval);

    // Tenant B must complete within 2s and health route answered concurrently
    expect(bDuration).toBeLessThan(2000);
    expect(healthPolls).toBeGreaterThan(0);

    for (let i = 0; i < 50; i++) {
      expect(bResults[i]?.status).toBe("success");
      expect(bResults[i]?.output_payload).toEqual({ doubled: i * 2 });
    }

    // Tenant A must finish with status "timeout"
    const resultA = await promiseA;
    expect(resultA.status).toBe("timeout");

    // Execution record in scr_executions must record timeout
    const logsA = await service.getExecutionLogs("ws_tenant_a", scriptA.id);
    expect(logsA[0]?.status).toBe("timeout");
  });
});
