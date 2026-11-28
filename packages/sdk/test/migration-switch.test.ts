// Story 2.11: the strangler route switch and its telemetry. Ported from the first app that used the switch: its
// parseRouteSwitch and resolveRouteTarget cases unchanged, and its routeSwitch middleware cases with the app's own Hono
// env type replaced by plain `Hono`. Its cases against its own health route stay with that app (story 2.13). The rest
// cover the plan's I/O matrix and the review fixes.
import { Hono } from "hono";
import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_ROUTE_GROUP_LENGTH,
  ROUTE_HANDLERS_VAR,
  ROUTE_HANDLER_HEADER,
  isRouteGroupName,
  migrationTelemetry,
  notedRouteHandlers,
  noteRouteHandler,
  parseRouteSwitch,
  resolveRouteTarget,
  routeSwitch,
} from "../src/index.ts";
import type { AnalyticsEngineLike } from "../src/index.ts";

type Point = { blobs?: string[]; doubles?: number[]; indexes?: string[] };

function fakeDataset(): AnalyticsEngineLike & { points: Point[] } {
  const points: Point[] = [];
  return { points, writeDataPoint: (p) => void points.push(p) };
}

describe("parseRouteSwitch (ported)", () => {
  it("reads group:target pairs and ignores junk", () => {
    const t = parseRouteSwitch(" health:brick, wallet:app,bad,x:other,Upper:brick,a:b:c, :brick");
    expect([...t.entries()]).toEqual([
      ["health", "brick"],
      ["wallet", "app"],
    ]);
  });

  it("treats unset or empty as no switches", () => {
    expect(parseRouteSwitch(undefined).size).toBe(0);
    expect(parseRouteSwitch("").size).toBe(0);
  });

  it("reads shadow and ignores an unknown target, a bad group and an extra colon", () => {
    const t = parseRouteSwitch(" health:brick , wallet:shadow,bad:x,Upper:app,a:b:c,admin:app");
    expect(Object.fromEntries(t)).toEqual({ health: "brick", wallet: "shadow", admin: "app" });
  });
});

describe("group name length cap", () => {
  it("accepts 64 characters and ignores or refuses 65", () => {
    const ok = "a".repeat(MAX_ROUTE_GROUP_LENGTH);
    const long = "a".repeat(MAX_ROUTE_GROUP_LENGTH + 1);
    expect(MAX_ROUTE_GROUP_LENGTH).toBe(64);
    expect(isRouteGroupName(ok)).toBe(true);
    expect(isRouteGroupName(long)).toBe(false);
    expect(Object.fromEntries(parseRouteSwitch(`${ok}:brick,${long}:brick`))).toEqual({ [ok]: "brick" });
    expect(() => routeSwitch(ok)).not.toThrow();
    expect(() => routeSwitch(long)).toThrow();
  });
});

describe("resolveRouteTarget", () => {
  it("falls back to app when no brick router is registered (ported)", () => {
    expect(resolveRouteTarget("health:brick", "health", false)).toBe("app");
    expect(resolveRouteTarget("health:brick", "health", true)).toBe("brick");
    expect(resolveRouteTarget("wallet:brick", "health", true)).toBe("app");
  });

  it("resolves brick only with a brick", () => {
    expect(resolveRouteTarget("auth:brick", "auth", { hasBrick: true })).toBe("brick");
    expect(resolveRouteTarget("auth:brick", "auth", { hasBrick: false })).toBe("app");
  });

  it("resolves shadow only when the caller opted in", () => {
    expect(resolveRouteTarget("wallet:shadow", "wallet", { hasBrick: true })).toBe("app");
    expect(resolveRouteTarget("wallet:shadow", "wallet", { hasBrick: true, allowShadow: true })).toBe("shadow");
    expect(resolveRouteTarget("wallet:shadow", "wallet", true)).toBe("app");
    expect(resolveRouteTarget("wallet:brick", "wallet", { hasBrick: false, allowShadow: true })).toBe("app");
  });
});

describe("routeSwitch middleware (ported)", () => {
  it("rejects invalid group names at mount time", () => {
    expect(() => routeSwitch("Bad Name")).toThrow();
  });

  it("keeps group middleware ahead of whichever handler answers", async () => {
    const brick = new Hono().basePath("/api");
    brick.get("/thing", (c) => c.text("brick"));
    const host = new Hono();
    host.use("/api/thing", async (c, next) => {
      if (c.req.header("Authorization") !== "ok") return c.text("denied", 401);
      return next();
    });
    host.use("/api/thing", routeSwitch("thing", brick));
    host.get("/api/thing", (c) => c.text("app"));

    const env = { ROUTE_SWITCH: "thing:brick" };
    expect((await host.request("/api/thing", {}, env)).status).toBe(401);
    const res = await host.request("/api/thing", { headers: { Authorization: "ok" } }, env);
    expect(await res.text()).toBe("brick");
    expect(res.headers.get(ROUTE_HANDLER_HEADER)).toBe("brick:thing");
  });

  it("reads a configured variable name", async () => {
    const brick = new Hono();
    brick.get("/x", (c) => c.text("brick"));
    const host = new Hono();
    host.use("/x", routeSwitch("x", brick, { variable: "MY_SWITCH" }));
    host.get("/x", (c) => c.text("app"));
    expect(await (await host.request("/x", {}, { ROUTE_SWITCH: "x:brick" })).text()).toBe("app");
    expect(await (await host.request("/x", {}, { MY_SWITCH: "x:brick" })).text()).toBe("brick");
  });
});

/** An app with telemetry at the root, a whole-router group `g` and inline groups noted by handlers. */
function telemetryApp(dataset: AnalyticsEngineLike | undefined, withTelemetry = true) {
  const brick = new Hono();
  brick.post("/g", (c) => c.json({ from: "brick" }, 201));
  const app = new Hono<{ Bindings: { ROUTE_SWITCH?: string } }>();
  if (withTelemetry) app.use("*", migrationTelemetry({ dataset: () => dataset }));
  app.use("/g", routeSwitch("g", brick));
  app.post("/g", (c) => c.json({ from: "app" }, 404));
  app.get("/inline", (c) => {
    noteRouteHandler(c as unknown as Context, "auth", "brick");
    return c.text("boom", 500);
  });
  app.get("/two", (c) => {
    noteRouteHandler(c as unknown as Context, "auth", "app");
    noteRouteHandler(c as unknown as Context, "workspaces", "brick");
    noteRouteHandler(c as unknown as Context, "auth", "brick");
    return c.text("ok");
  });
  app.get("/throws", (c) => {
    noteRouteHandler(c as unknown as Context, "audit", "app");
    throw new Error("handler failed");
  });
  app.get("/none", (c) => c.text("no group"));
  return app;
}

describe("whole-router group with telemetry", () => {
  it("via brick: the brick's response, header brick:g, one data point", async () => {
    const ds = fakeDataset();
    const res = await telemetryApp(ds).request("/g", { method: "POST" }, { ROUTE_SWITCH: "g:brick" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ from: "brick" });
    expect(res.headers.get(ROUTE_HANDLER_HEADER)).toBe("brick:g");
    expect(ds.points).toEqual([{ indexes: ["g"], blobs: ["g", "brick", "2xx"], doubles: [1] }]);
  });

  it("flipped back with an explicit g:app while a brick is registered: the app answers", async () => {
    const ds = fakeDataset();
    const res = await telemetryApp(ds).request("/g", { method: "POST" }, { ROUTE_SWITCH: "g:app" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ from: "app" });
    expect(res.headers.get(ROUTE_HANDLER_HEADER)).toBe("app:g");
    expect(ds.points).toEqual([{ indexes: ["g"], blobs: ["g", "app", "4xx"], doubles: [1] }]);
  });

  it("via app: header app:g, data point 4xx", async () => {
    const ds = fakeDataset();
    const res = await telemetryApp(ds).request("/g", { method: "POST" }, {});
    expect(res.status).toBe(404);
    expect(res.headers.get(ROUTE_HANDLER_HEADER)).toBe("app:g");
    expect(ds.points).toEqual([{ indexes: ["g"], blobs: ["g", "app", "4xx"], doubles: [1] }]);
  });
});

describe("inline groups", () => {
  it("a noted handler is recorded with the response's status class", async () => {
    const ds = fakeDataset();
    const res = await telemetryApp(ds).request("/inline", {}, {});
    expect(res.status).toBe(500);
    expect(res.headers.get(ROUTE_HANDLER_HEADER)).toBeNull();
    expect(ds.points).toEqual([{ indexes: ["auth"], blobs: ["auth", "brick", "5xx"], doubles: [1] }]);
  });

  it("two groups get two data points; a group noted twice counts once with the last handler", async () => {
    const ds = fakeDataset();
    await telemetryApp(ds).request("/two", {}, {});
    expect(ds.points).toEqual([
      { indexes: ["auth"], blobs: ["auth", "brick", "2xx"], doubles: [1] },
      { indexes: ["workspaces"], blobs: ["workspaces", "brick", "2xx"], doubles: [1] },
    ]);
  });

  it("a request that notes no group writes nothing", async () => {
    const ds = fakeDataset();
    await telemetryApp(ds).request("/none", {}, {});
    expect(ds.points).toEqual([]);
  });
});

describe("status classes and the read accessor", () => {
  it("a 101 is counted as 1xx", async () => {
    const ds = fakeDataset();
    const app = new Hono();
    app.use("*", migrationTelemetry({ dataset: () => ds }));
    app.get("/ws", (c) => {
      noteRouteHandler(c, "realtime", "app");
      // A Response cannot carry 101 outside workerd's WebSocket upgrade, so set the status the handler reports.
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, "status", { value: 101 });
      return res;
    });
    await app.request("/ws");
    expect(ds.points).toEqual([{ indexes: ["realtime"], blobs: ["realtime", "app", "1xx"], doubles: [1] }]);
  });

  it("notedRouteHandlers reads without setting the variable", async () => {
    const app = new Hono();
    app.get("/x", (c) => {
      const before = notedRouteHandlers(c);
      const unset = (c as unknown as { get(k: string): unknown }).get(ROUTE_HANDLERS_VAR) === undefined;
      noteRouteHandler(c, "x", "brick");
      return c.json({ before: before.size, unset, after: Object.fromEntries(notedRouteHandlers(c)) });
    });
    expect(await (await app.request("/x")).json()).toEqual({ before: 0, unset: true, after: { x: "brick" } });
  });
});

describe("errors", () => {
  it("a handler that throws after noting records error, and the error goes on as before", async () => {
    const ds = fakeDataset();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const withT = await telemetryApp(ds).request("/throws", {}, {});
    const without = await telemetryApp(undefined, false).request("/throws", {}, {});
    errors.mockRestore();
    expect(withT.status).toBe(without.status);
    expect(await withT.text()).toBe(await without.text());
    expect(ds.points).toEqual([{ indexes: ["audit"], blobs: ["audit", "app", "error"], doubles: [1] }]);
  });

  it("an error thrown through the telemetry middleware records error and is rethrown", async () => {
    const ds = fakeDataset();
    const mw = migrationTelemetry({ dataset: () => ds });
    const c = { env: {}, error: undefined, vars: new Map<string, unknown>() } as unknown as Record<string, unknown>;
    (c as { get: (k: string) => unknown }).get = (k) => (c.vars as Map<string, unknown>).get(k);
    (c as { set: (k: string, v: unknown) => void }).set = (k, v) => void (c.vars as Map<string, unknown>).set(k, v);
    const failure = new Error("downstream");
    await expect(
      mw(c as unknown as Context, async () => {
        noteRouteHandler(c as unknown as Context, "wallet", "shadow");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(ds.points).toEqual([{ indexes: ["wallet"], blobs: ["wallet", "shadow", "error"], doubles: [1] }]);
  });
});

describe("telemetry never changes the response", () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ["POST", "/g", { ROUTE_SWITCH: "g:brick" }],
    ["POST", "/g", {}],
    ["GET", "/inline", {}],
    ["GET", "/two", {}],
    ["GET", "/none", {}],
  ];

  async function snapshot(res: Response) {
    return { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
  }

  it("is byte-identical to running without telemetry", async () => {
    for (const [method, path, env] of cases) {
      const ds = fakeDataset();
      const a = await snapshot(await telemetryApp(ds).request(path, { method }, env));
      const b = await snapshot(await telemetryApp(undefined, false).request(path, { method }, env));
      expect(a).toEqual(b);
    }
  });

  it("with no dataset, writes nothing and the response is identical", async () => {
    for (const [method, path, env] of cases) {
      const a = await snapshot(await telemetryApp(undefined).request(path, { method }, env));
      const b = await snapshot(await telemetryApp(undefined, false).request(path, { method }, env));
      expect(a).toEqual(b);
    }
  });

  it("a dataset that throws is swallowed, logged once, and the response is identical", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing: AnalyticsEngineLike = {
      writeDataPoint: () => {
        throw new Error("analytics engine down");
      },
    };
    const app = telemetryApp(throwing);
    const a1 = await snapshot(await app.request("/inline", {}, {}));
    const a2 = await snapshot(await app.request("/two", {}, {}));
    const b1 = await snapshot(await telemetryApp(undefined, false).request("/inline", {}, {}));
    const b2 = await snapshot(await telemetryApp(undefined, false).request("/two", {}, {}));
    const calls = errors.mock.calls.length;
    errors.mockRestore();
    expect(a1).toEqual(b1);
    expect(a2).toEqual(b2);
    expect(calls).toBe(1);
  });

  it("a binding that throws for one group still writes the others, and logs each distinct message once", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const points: Point[] = [];
    const picky: AnalyticsEngineLike = {
      writeDataPoint: (p) => {
        if (p.indexes?.[0] === "b") throw new Error("index rejected");
        points.push(p);
      },
    };
    const app = new Hono();
    app.use("*", migrationTelemetry({ dataset: () => picky }));
    app.get("/x", (c) => {
      for (const g of ["a", "b", "c"]) noteRouteHandler(c, g, "app");
      return c.text("ok");
    });
    const res = await app.request("/x");
    await app.request("/x");
    const calls = errors.mock.calls.length;
    errors.mockRestore();
    expect(await res.text()).toBe("ok");
    expect(points.map((p) => p.indexes![0])).toEqual(["a", "c", "a", "c"]);
    expect(calls).toBe(1);
  });

  it("a dataset accessor that throws is swallowed too", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono();
    app.use(
      "*",
      migrationTelemetry({
        dataset: () => {
          throw new Error("no binding");
        },
      }),
    );
    app.get("/x", (c) => {
      noteRouteHandler(c, "x", "app");
      return c.text("fine");
    });
    const res = await app.request("/x");
    errors.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fine");
  });

  it("data points carry only group, handler and status class", async () => {
    const ds = fakeDataset();
    await telemetryApp(ds).request("/two?tenant=ws-secret&user=u-1", { headers: { "cf-connecting-ip": "203.0.113.9" } }, {});
    const serialized = JSON.stringify(ds.points);
    for (const leak of ["ws-secret", "u-1", "/two", "tenant", "203.0.113.9"]) expect(serialized).not.toContain(leak);
    for (const p of ds.points) {
      expect(Object.keys(p).sort()).toEqual(["blobs", "doubles", "indexes"]);
      expect(p.blobs).toHaveLength(3);
    }
  });
});
