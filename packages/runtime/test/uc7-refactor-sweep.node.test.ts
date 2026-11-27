import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRegistry, type BrickManifest, type Executor } from "@poc/sdk";
import { runGraph } from "../src/run.ts";

describe("UC7.7 — Refactor sweep (UC7)", () => {
  it("AC1: grep -rn 'Math.random' packages/runtime/src/run.ts returns nothing", () => {
    const runTsPath = resolve(__dirname, "../src/run.ts");
    const source = readFileSync(runTsPath, "utf8");
    const matches = source.split("\n").filter((line) => line.includes("Math.random"));
    expect(matches).toEqual([]);
  });

  it("unifies stepRetries with stepPolicyFor: non-idempotent write node is never retried even if stepRetries requests it", async () => {
    let attempts = 0;
    const writeManifest: BrickManifest = {
      type: "test.write_op",
      category: "action",
      sideEffects: "write",
      inputs: [{ id: "in", dataType: "json" }],
      outputs: [{ id: "out", dataType: "json" }],
      configSchema: z.object({}),
      secrets: [],
    };
    const registry = createRegistry([
      {
        type: "trigger.manual",
        category: "trigger",
        inputs: [],
        outputs: [{ id: "out", dataType: "json" }],
        configSchema: z.object({}),
        secrets: [],
      },
      writeManifest,
    ]);

    const executors = new Map<string, Executor>([
      ["trigger.manual", () => ({ out: {} })],
      [
        "test.write_op",
        () => {
          attempts += 1;
          throw new Error("503 write failure");
        },
      ],
    ]);

    const graph = {
      nodes: [
        { id: "t", type: "trigger.manual", data: {} },
        { id: "w", type: "test.write_op", data: {} },
      ],
      edges: [{ id: "e1", source: "t", target: "w", sourceHandle: "out", targetHandle: "in" }],
    };

    const res = await runGraph(graph, registry, executors, {
      workspaceId: "ws_test",
      telemetry: {
        stepRetries: { limit: 3, delayMs: 0 },
      },
    });

    expect(res.ok).toBe(false);
    expect(res.failed.w).toContain("503 write failure");
    // stepPolicyFor says non-idempotent write has retries.limit = 0.
    // Therefore, exactly 1 attempt must have occurred, not 1 + 3 = 4 attempts.
    expect(attempts).toBe(1);
  });

  it("unifies stepRetries with stepPolicyFor: read node retry limit is capped at stepPolicyFor ceiling (4)", async () => {
    let attempts = 0;
    const readManifest: BrickManifest = {
      type: "test.read_op",
      category: "action",
      sideEffects: "read",
      inputs: [{ id: "in", dataType: "json" }],
      outputs: [{ id: "out", dataType: "json" }],
      configSchema: z.object({}),
      secrets: [],
    };
    const registry = createRegistry([
      {
        type: "trigger.manual",
        category: "trigger",
        inputs: [],
        outputs: [{ id: "out", dataType: "json" }],
        configSchema: z.object({}),
        secrets: [],
      },
      readManifest,
    ]);

    const executors = new Map<string, Executor>([
      ["trigger.manual", () => ({ out: {} })],
      [
        "test.read_op",
        () => {
          attempts += 1;
          throw new Error("503 read failure");
        },
      ],
    ]);

    const graph = {
      nodes: [
        { id: "t", type: "trigger.manual", data: {} },
        { id: "r", type: "test.read_op", data: {} },
      ],
      edges: [{ id: "e1", source: "t", target: "r", sourceHandle: "out", targetHandle: "in" }],
    };

    const res = await runGraph(graph, registry, executors, {
      workspaceId: "ws_test",
      telemetry: {
        stepRetries: { limit: 10, delayMs: 0 },
      },
    });

    expect(res.ok).toBe(false);
    expect(res.failed.r).toContain("503 read failure");
    // stepPolicyFor ceiling for read is 4 retries (5 attempts total).
    // Requested limit 10 must be capped at 4 retries = 5 attempts total.
    expect(attempts).toBe(5);
  });

  it("unifies stepRetries with stepPolicyFor: stepRetries: true derives retry policy from stepPolicyFor", async () => {
    let attempts = 0;
    const readManifest: BrickManifest = {
      type: "test.read_op_auto",
      category: "action",
      sideEffects: "read",
      inputs: [{ id: "in", dataType: "json" }],
      outputs: [{ id: "out", dataType: "json" }],
      configSchema: z.object({}),
      secrets: [],
    };
    const registry = createRegistry([
      {
        type: "trigger.manual",
        category: "trigger",
        inputs: [],
        outputs: [{ id: "out", dataType: "json" }],
        configSchema: z.object({}),
        secrets: [],
      },
      readManifest,
    ]);

    const executors = new Map<string, Executor>([
      ["trigger.manual", () => ({ out: {} })],
      [
        "test.read_op_auto",
        () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("transient");
          }
          return { out: { done: true } };
        },
      ],
    ]);

    const graph = {
      nodes: [
        { id: "t", type: "trigger.manual", data: {} },
        { id: "r", type: "test.read_op_auto", data: {} },
      ],
      edges: [{ id: "e1", source: "t", target: "r", sourceHandle: "out", targetHandle: "in" }],
    };

    const res = await runGraph(graph, registry, executors, {
      workspaceId: "ws_test",
      telemetry: {
        stepRetries: true,
      },
    });

    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it("platform-limits: single source of truth for platform and workflow limits", async () => {
    // Check that packages/sdk/src/platform-limits.ts exports WORKER_SIZE_LIMIT_BYTES, STARTUP_LIMIT_MS, and DEFAULT_FANOUT_LIMIT
    const sdkPlatformLimits = await import("@poc/sdk");
    expect((sdkPlatformLimits as unknown as Record<string, unknown>).DEFAULT_FANOUT_LIMIT).toBe(256);
    expect((sdkPlatformLimits as unknown as Record<string, unknown>).WORKER_SIZE_LIMIT_BYTES).toBe(64 * 1024 * 1024);
    expect((sdkPlatformLimits as unknown as Record<string, unknown>).STARTUP_LIMIT_MS).toBe(1000);

    // Check that packages/deploy/src/bundle.ts imports them from @poc/sdk rather than defining duplicated literals
    const bundleTsPath = resolve(__dirname, "../../deploy/src/bundle.ts");
    const bundleSrc = readFileSync(bundleTsPath, "utf8");
    expect(bundleSrc).toMatch(/import.*(?:WORKER_SIZE_LIMIT_BYTES|STARTUP_LIMIT_MS).*from "@poc\/sdk"/);
  });
});
