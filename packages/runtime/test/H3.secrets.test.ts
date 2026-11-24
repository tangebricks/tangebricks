import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { record } from "@poc/harness";
import { createRegistry, toyRegistry } from "@poc/sdk";
import type { BrickManifest, ExecutionContext, Executor } from "@poc/sdk";
import { z } from "zod";
import { runGraph, toyExecutors } from "../src/index.ts";
import { node, wire } from "./graphs.ts";

const DECLARED = "POC_TEST_DECLARED";
const UNDECLARED = "POC_TEST_UNDECLARED";
const DECLARED_VALUE = String(env[DECLARED]);
const UNDECLARED_VALUE = String(env[UNDECLARED]);

const brick = (type: string, secrets: string[]): BrickManifest => ({
  type,
  category: "transform",
  inputs: [{ id: "in", dataType: "json" }],
  outputs: [{ id: "out", dataType: "json" }],
  configSchema: z.object({}),
  secrets,
});

// Test-only bricks: one that declares a secret, and two that declare nothing but try to get one.
const registry = createRegistry([
  ...toyRegistry.values(),
  brick("test.vault", [DECLARED]),
  brick("test.snoop", []),
  brick("test.unprovided", ["POC_NOT_IN_ENV"]),
  brick("test.hostile", []),
]);

/** Every primitive value and object reference reachable from `root` by property access, without calling anything. */
function reachable(root: unknown): { values: unknown[]; objects: Set<object> } {
  const objects = new Set<object>();
  const values: unknown[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "function") return; // a closure's contents cannot be inspected, and are not called
    if (typeof v !== "object" || v === null) {
      values.push(v);
      return;
    }
    if (objects.has(v)) return;
    objects.add(v);
    for (const key of Reflect.ownKeys(v)) visit((v as Record<PropertyKey, unknown>)[key]);
    visit(Object.getPrototypeOf(v));
  };
  visit(root);
  return { values, objects };
}

const executors = (extra: Record<string, Executor>): Map<string, Executor> => new Map([...toyExecutors, ...Object.entries(extra)]);
const run = (type: string, exec: Executor, payload: unknown = {}) =>
  runGraph({ nodes: [node("t", "trigger.manual"), node("x", type)], edges: [wire("t", "x")] }, registry, executors({ [type]: exec }), {
    payload,
    env,
  });

describe("H3 declared secrets", () => {
  test("a brick reads the secret its manifest declares", async () => {
    const result = await run("test.vault", (ctx) => ({ out: ctx.secret(DECLARED) }));
    expect(result.ok).toBe(true);
    expect(result.outputs.x?.out).toBe(DECLARED_VALUE);
  });

  test("a declared secret the host did not provide fails with a clear message", async () => {
    const result = await run("test.unprovided", (ctx) => ({ out: ctx.secret("POC_NOT_IN_ENV") }));
    expect(result.failed.x).toBe('secret "POC_NOT_IN_ENV" is declared by test.unprovided but was not provided');
  });
});

describe("H3 undeclared secrets", () => {
  test("reading an undeclared secret throws, and the error names it without revealing its value", async () => {
    const result = await run("test.snoop", (ctx) => ({ out: ctx.secret(UNDECLARED) }));
    expect(result.ok).toBe(false);
    expect(result.failed.x).toBe(`secret "${UNDECLARED}" is not declared by test.snoop`);
    expect(JSON.stringify(result)).not.toContain(UNDECLARED_VALUE);
  });

  test("a brick cannot read another brick's declared secret either", async () => {
    const result = await run("test.snoop", (ctx) => ({ out: ctx.secret(DECLARED) }));
    expect(result.failed.x).toContain("is not declared by test.snoop");
    expect(JSON.stringify(result)).not.toContain(DECLARED_VALUE);
  });

  test("nothing the runtime hands an executor reaches the env or any secret value", async () => {
    let seen: ExecutionContext | undefined;
    await run("test.snoop", (ctx) => {
      seen = ctx;
      return { out: 1 };
    });
    const { values, objects } = reachable(seen);
    expect(Object.keys(seen!).sort()).toEqual(["binding", "data", "idempotencyKey", "inputs", "nodeId", "payload", "runId", "secret"]);
    expect(objects.has(env)).toBe(false);
    expect(values).not.toContain(DECLARED_VALUE);
    expect(values).not.toContain(UNDECLARED_VALUE);
  });
});

describe("H3 attacks through graph data", () => {
  test("a payload that tries to name the secret is passed through as plain text, never resolved", async () => {
    const payload = { x: `{{$env.${UNDECLARED}}}`, y: `{{$secret.${DECLARED}}}` };
    const result = await runGraph(
      {
        nodes: [node("t", "trigger.manual"), node("p", "transform.pick", { path: "x" }), node("q", "transform.pick", { path: "y" })],
        edges: [wire("t", "p"), wire("t", "q")],
      },
      registry,
      toyExecutors,
      { payload, env },
    );
    expect(result.outputs.p?.out).toBe(`{{$env.${UNDECLARED}}}`);
    expect(JSON.stringify(result)).not.toContain(UNDECLARED_VALUE);
    expect(JSON.stringify(result)).not.toContain(DECLARED_VALUE);
  });

  test.each(["constructor", "__proto__", "toString", "constructor.constructor", `${UNDECLARED}`])(
    "path %j into the payload returns nothing, and never reaches inherited properties",
    async (path) => {
      const result = await runGraph(
        { nodes: [node("t", "trigger.manual"), node("p", "transform.pick", { path })], edges: [wire("t", "p")] },
        registry,
        toyExecutors,
        { payload: { a: 1 }, env },
      );
      expect(result.outputs.p?.out).toBeUndefined();
    },
  );
});

describe("H3 known limit: code in the same isolate", () => {
  // This documents what the design does NOT prevent. An executor is ordinary code running in the same
  // isolate as the host, and the Workers runtime lets any module import the global env. So the scoped
  // `ctx.secret()` stops graph authors and well-behaved bricks, not a hostile brick author. If this ever
  // starts failing, the limit has moved and the H3 caveat in hypotheses.json should be revisited.
  test("KNOWN LIMIT: a hostile executor can read an undeclared secret by importing env directly", async () => {
    const result = await run("test.hostile", () => ({ out: env[UNDECLARED] }));
    expect(result.ok).toBe(true);
    expect(result.outputs.x?.out).toBe(UNDECLARED_VALUE);
  });
});

test("H3 report", async ({ task }) => {
  const vault = await run("test.vault", (ctx) => ({ out: ctx.secret(DECLARED) }));
  const snoop = await run("test.snoop", (ctx) => ({ out: ctx.secret(UNDECLARED) }));
  let seen: ExecutionContext | undefined;
  await run("test.snoop", (ctx) => {
    seen = ctx;
    return { out: 1 };
  });
  const { values, objects } = reachable(seen);

  record(task, {
    id: "H3",
    checks: {
      declaredSecretReadable: vault.ok && vault.outputs.x?.out === DECLARED_VALUE,
      // Nothing about the undeclared secret leaks anywhere in the run result or the executor's context.
      undeclaredSecretAbsent:
        !JSON.stringify(snoop).includes(UNDECLARED_VALUE) && !values.includes(UNDECLARED_VALUE) && !values.includes(DECLARED_VALUE),
      undeclaredReadThrows: snoop.failed.x === `secret "${UNDECLARED}" is not declared by test.snoop`,
      // The env object is not reachable from anything the runtime hands the executor (see the known-limit test).
      rawEnvUnreachable: !objects.has(env) && seen !== undefined && !("env" in seen),
    },
  });
});
