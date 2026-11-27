import { describe, expect, test } from "vitest";
import { toyRegistry } from "@poc/sdk";
import { GraphInvalidError, runGraph, toyExecutors } from "../src/index.ts";
import { node, wire } from "./graphs.ts";

describe("runGraph behaviour", () => {
  test("a failing node is reported, its downstream is skipped, an independent branch still runs", async () => {
    const graph = {
      nodes: [
        node("t", "trigger.manual"),
        node("bad", "util.boom"),
        node("after", "transform.pick", { path: "x" }),
        node("fine", "transform.pick", { path: "x" }),
      ],
      edges: [wire("t", "bad"), wire("bad", "after"), wire("t", "fine")],
    };
    const result = await runGraph(graph, toyRegistry, toyExecutors, { workspaceId: "ws_test", payload: { x: 1 } });
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual({ bad: "boom" });
    expect(result.skipped).toEqual(["after"]);
    expect(result.outputs.fine?.out).toBe(1);
  });

  test("an invalid graph is refused before anything runs, with the validator's issues", async () => {
    let called = false;
    const spy = new Map([
      ...toyExecutors,
      [
        "trigger.manual",
        () => {
          called = true;
          return { out: 1 };
        },
      ],
    ]);
    const cyclic = {
      nodes: [node("t", "trigger.manual"), node("p1", "transform.pick", { path: "a" }), node("p2", "transform.pick", { path: "a" })],
      edges: [wire("t", "p1"), wire("p1", "p2"), wire("p2", "p1")],
    };
    const error = await runGraph(cyclic, toyRegistry, spy, { workspaceId: "ws_test" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphInvalidError);
    expect((error as GraphInvalidError).issues.map((i) => i.code)).toContain("cycle");
    expect(called).toBe(false);
  });

  test("a node the trigger cannot reach is skipped, and that is not a failure", async () => {
    const graph = {
      nodes: [node("t", "trigger.manual"), node("p", "transform.pick", { path: "x" }), node("lonely", "transform.pick", { path: "x" })],
      edges: [wire("t", "p")],
    };
    const result = await runGraph(graph, toyRegistry, toyExecutors, { workspaceId: "ws_test", payload: { x: 2 } });
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(["lonely"]);
    expect(result.outputs.p?.out).toBe(2);
  });

  test("a brick with a manifest but no executor fails that node with a clear message", async () => {
    const withoutPick = new Map([...toyExecutors].filter(([type]) => type !== "transform.pick"));
    const graph = {
      nodes: [node("t", "trigger.manual"), node("p", "transform.pick", { path: "x" })],
      edges: [wire("t", "p")],
    };
    const result = await runGraph(graph, toyRegistry, withoutPick, { workspaceId: "ws_test", payload: {} });
    expect(result.failed).toEqual({ p: "no executor registered for transform.pick" });
  });

  test("two edges into one port arrive as an array in edge order", async () => {
    let seen: unknown;
    const executors = new Map([
      ...toyExecutors,
      [
        "transform.pick",
        ({ nodeId, inputs }: { nodeId: string; inputs: Record<string, unknown> }) => {
          if (nodeId === "c") seen = inputs.in;
          return { out: nodeId };
        },
      ],
    ]);
    const graph = {
      nodes: [
        node("t", "trigger.manual"),
        node("a", "transform.pick", { path: "v" }),
        node("b", "transform.pick", { path: "v" }),
        node("c", "transform.pick", { path: "v" }),
      ],
      edges: [wire("t", "a"), wire("t", "b"), wire("a", "c"), wire("b", "c")],
    };
    await runGraph(graph, toyRegistry, executors, { workspaceId: "ws_test", payload: {} });
    expect(seen).toEqual(["a", "b"]);
  });

  test("an executor that returns a rejected promise is a failure, not an unhandled rejection", async () => {
    const rejecting = new Map([...toyExecutors, ["util.boom", () => Promise.reject(new Error("async boom"))]]);
    const graph = { nodes: [node("t", "trigger.manual"), node("x", "util.boom")], edges: [wire("t", "x")] };
    const result = await runGraph(graph, toyRegistry, rejecting, { workspaceId: "ws_test", payload: {} });
    expect(result.failed).toEqual({ x: "async boom" });
  });
});
