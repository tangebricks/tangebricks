import { describe, expect, test } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import {
  PLACEHOLDER_BRICK_EXECUTOR_MODULES,
  assertNoPlaceholderExecutors,
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  isNotConfiguredExecutor,
  isPlaceholderExecutor,
  runGraph,
} from "../src/index.ts";

// Story 0.9 (R-B): brick action nodes never default to placeholder executors.
describe("brick action executors: no placeholder default", () => {
  const brickNodeTypes = Object.values(catalog.bricks ?? {}).flatMap((b) =>
    (b.manifest.nodes ?? []).map((n) => n.type),
  );

  test("PLACEHOLDER_DEFAULT: with no executors configured, a brick action node fails NOT_CONFIGURED (no arithmetic fake)", async () => {
    const executors = buildExecutorsFromCatalog(catalog);
    const result = await runGraph(
      {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          { id: "debit", type: "credit-wallet.debit", data: { amount: 35 } },
        ],
        edges: [{ id: "e1", source: "trig", sourceHandle: "out", target: "debit", targetHandle: "in" }],
      },
      buildRegistryFromCatalog(catalog),
      executors,
      { payload: { balance: 250, workspaceId: "ws_a" } },
    );
    expect(result.ok).toBe(false);
    expect(result.outputs.debit).toBeUndefined();
    expect(result.failed.debit).toMatch(/^NOT_CONFIGURED: credit-wallet\.debit/);
  });

  test("the default composition wires no placeholder executor for any brick node", () => {
    const executors = buildExecutorsFromCatalog(catalog);
    expect(brickNodeTypes.length).toBeGreaterThan(0);
    for (const type of brickNodeTypes) {
      const fn = executors.get(type);
      expect(isPlaceholderExecutor(fn), type).toBe(false);
    }
    expect(isNotConfiguredExecutor(executors.get("credit-wallet.debit"))).toBe(true);
    expect(isNotConfiguredExecutor(executors.get("omnichannel-outbound.send_message"))).toBe(true);
  });

  test("a test can inject the placeholders explicitly", () => {
    const executors = buildExecutorsFromCatalog(catalog, PLACEHOLDER_BRICK_EXECUTOR_MODULES);
    expect(isPlaceholderExecutor(executors.get("credit-wallet.debit"))).toBe(true);
  });

  test("PLACEHOLDER_PROD: loading placeholder executors when PX_ENVIRONMENT is production is refused at load", () => {
    expect(() =>
      buildExecutorsFromCatalog(catalog, PLACEHOLDER_BRICK_EXECUTOR_MODULES, { environment: "production" }),
    ).toThrow(/^NOT_CONFIGURED: placeholder executor .* refused/);
    // Not production: the explicit injection still loads (tests, local rehearsal).
    expect(() =>
      buildExecutorsFromCatalog(catalog, PLACEHOLDER_BRICK_EXECUTOR_MODULES, { environment: "preview" }),
    ).not.toThrow();
  });

  test("PLACEHOLDER_PROD: a placeholder passed as base executors, or in a ready map, is refused by identity in production", () => {
    const withFakes = buildExecutorsFromCatalog(catalog, PLACEHOLDER_BRICK_EXECUTOR_MODULES);
    expect(() => buildExecutorsFromCatalog(catalog, {}, withFakes, { environment: "production" })).toThrow(
      /^NOT_CONFIGURED: placeholder executor for .* refused/,
    );
    expect(() => assertNoPlaceholderExecutors(withFakes, "production")).toThrow(/^NOT_CONFIGURED: placeholder executor/);
    expect(() => assertNoPlaceholderExecutors(withFakes, "preview")).not.toThrow();
    expect(() => assertNoPlaceholderExecutors(buildExecutorsFromCatalog(catalog), "production")).not.toThrow();
  });

  test("brick trigger nodes keep their default executors: a trigger-started workflow still runs its trigger step", async () => {
    const executors = buildExecutorsFromCatalog(catalog);
    for (const type of ["webhook-gateway.inbound_webhook", "dynamic-entities.record_created"]) {
      expect(isNotConfiguredExecutor(executors.get(type)), type).toBe(false);
      expect(isPlaceholderExecutor(executors.get(type)), type).toBe(false);
    }
    const result = await runGraph(
      {
        nodes: [
          { id: "tr", type: "dynamic-entities.record_created", data: { entity: "tasks" } },
          { id: "np", type: "core.noop", data: {} },
        ],
        edges: [{ id: "e1", source: "tr", sourceHandle: "out", target: "np", targetHandle: "in" }],
      },
      buildRegistryFromCatalog(catalog),
      executors,
      { payload: { id: "rec_1" } },
    );
    expect(result.ok).toBe(true);
    expect(result.outputs.tr?.out).toEqual({ entity: "tasks", record: { id: "rec_1" } });
  });
});
