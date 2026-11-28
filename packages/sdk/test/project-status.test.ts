// Story 2.12: the opt-in project status endpoint. One case per row of the plan's I/O matrix, plus the acceptance
// checks (a refused request is indistinguishable from the same app without the endpoint, nothing outside the documented
// shape) and the review fixes (key length cap, single-flight and cached reporters, abort on timeout, timestamp checks).
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATUS_KEY_VARIABLE, DEFAULT_STATUS_PATH, MAX_STATUS_KEY_BYTES, constantTimeEqual, projectStatus } from "../src/index.ts";
import type { ProjectStatusBody, ProjectStatusOptions, ShadowReport } from "../src/index.ts";

const readBody = (res: Response) => res.json() as Promise<ProjectStatusBody>;

const KEY = "status-key-0123456789";
const auth = (key = KEY) => ({ Authorization: `Bearer ${key}` });
const keyed = { [DEFAULT_STATUS_KEY_VARIABLE]: KEY };

/** A bare app: only the endpoint, Hono's default not-found handler. */
function appWith(options: ProjectStatusOptions = {}): Hono {
  const app = new Hono();
  app.use(DEFAULT_STATUS_PATH, projectStatus(options));
  return app;
}

/**
 * A realistic app: global and route-scoped middleware, API routes and an SPA-style catch-all fallback. With
 * `mounted: false` it is the same app without the endpoint, the reference a refused request must match.
 */
function realisticApp(mounted: boolean, options: ProjectStatusOptions = {}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-App", "demo");
  });
  if (mounted) app.use(DEFAULT_STATUS_PATH, projectStatus(options));
  app.use("/_tangebricks/*", async (c, next) => {
    await next();
    c.res.headers.set("X-Scoped", "yes");
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.post("*", (c) => c.text("method fallback", 405));
  app.get("*", (c) => c.html(`<!doctype html><title>spa</title>${c.req.path}`));
  return app;
}

const report = (group: string, extra: Record<string, unknown> = {}): ShadowReport & Record<string, unknown> => ({
  group,
  exact: true,
  compared: 12,
  differing: 0,
  checkedAt: "2026-11-28T00:00:00.000Z",
  ...extra,
});

const okEntry = (group: string) => ({ group, exact: true, compared: 12, differing: 0, checkedAt: "2026-11-28T00:00:00.000Z" });

async function snapshot(res: Response) {
  return { status: res.status, body: await res.text(), headers: [...res.headers.entries()] };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("projectStatus: off by default (indistinguishable from not mounted)", () => {
  const refusals: Array<{ name: string; env: Record<string, unknown>; init: RequestInit }> = [
    { name: "no key configured, no auth", env: {}, init: {} },
    { name: "no key configured, a bearer", env: {}, init: { headers: auth() } },
    { name: "empty key configured, empty bearer", env: { [DEFAULT_STATUS_KEY_VARIABLE]: "" }, init: { headers: auth("") } },
    { name: "missing bearer", env: keyed, init: {} },
    { name: "wrong key", env: keyed, init: { headers: auth("wrong") } },
    { name: "key plus a character", env: keyed, init: { headers: auth(`${KEY}x`) } },
    { name: "key minus a character", env: keyed, init: { headers: auth(KEY.slice(0, -1)) } },
    { name: "no scheme", env: keyed, init: { headers: { Authorization: KEY } } },
    { name: "Basic scheme", env: keyed, init: { headers: { Authorization: `Basic ${KEY}` } } },
    { name: "trailing junk", env: keyed, init: { headers: { Authorization: `Bearer ${KEY} extra` } } },
    ...["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].map((method) => ({
      name: `${method} with the right key`,
      env: keyed,
      init: { method, headers: auth() },
    })),
  ];

  for (const { name, env, init } of refusals) {
    it(`realistic app with a catch-all: ${name}`, async () => {
      const expected = await snapshot(await realisticApp(false).request(DEFAULT_STATUS_PATH, init, env));
      expect(await snapshot(await realisticApp(true).request(DEFAULT_STATUS_PATH, init, env))).toEqual(expected);
    });
  }

  it("bare app: refused requests get the app's own 404", async () => {
    for (const { env, init } of refusals) {
      const unmounted = await snapshot(await new Hono().request(DEFAULT_STATUS_PATH, init, env));
      expect(unmounted.status).toBe(404);
      expect(await snapshot(await appWith().request(DEFAULT_STATUS_PATH, init, env))).toEqual(unmounted);
    }
  });

  it("with an app whose not-found is an empty 404, a refusal is an empty 404", async () => {
    const app = new Hono();
    app.notFound((c) => c.body(null, 404));
    app.use(DEFAULT_STATUS_PATH, projectStatus());
    const res = await app.request(DEFAULT_STATUS_PATH, { headers: auth() }, {});
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("answers only its exact path, even when mounted on a wider pattern", async () => {
    const app = new Hono();
    app.use("/_tangebricks/*", projectStatus());
    app.get("*", (c) => c.text("fallback"));
    for (const path of [`${DEFAULT_STATUS_PATH}/x`, `${DEFAULT_STATUS_PATH}/`, "/_tangebricks/other"]) {
      const res = await app.request(path, { headers: auth() }, keyed);
      expect(await res.text(), path).toBe("fallback");
    }
    expect((await app.request(DEFAULT_STATUS_PATH, { headers: auth() }, keyed)).status).toBe(200);
  });

  it("the realistic app still answers the right key with the status", async () => {
    const res = await realisticApp(true).request(DEFAULT_STATUS_PATH, { headers: auth() }, keyed);
    expect(res.status).toBe(200);
    expect((await readBody(res)).version).toBe(1);
  });

  it("reads the key from a configurable variable", async () => {
    const app = appWith({ keyVariable: "MY_STATUS_KEY" });
    expect((await app.request(DEFAULT_STATUS_PATH, { headers: auth() }, keyed)).status).toBe(404);
    expect((await app.request(DEFAULT_STATUS_PATH, { headers: auth() }, { MY_STATUS_KEY: KEY })).status).toBe(200);
  });

  it("treats a bearer longer than 512 bytes as no bearer, and never hashes more than 512 bytes of it", async () => {
    const atCap = "k".repeat(MAX_STATUS_KEY_BYTES);
    const overCap = "k".repeat(MAX_STATUS_KEY_BYTES + 1);
    expect((await appWith().request(DEFAULT_STATUS_PATH, { headers: auth(atCap) }, { [DEFAULT_STATUS_KEY_VARIABLE]: atCap })).status).toBe(200);
    expect((await appWith().request(DEFAULT_STATUS_PATH, { headers: auth(overCap) }, { [DEFAULT_STATUS_KEY_VARIABLE]: overCap })).status).toBe(404);

    const digest = vi.spyOn(crypto.subtle, "digest");
    const huge = "x".repeat(50_000);
    expect((await appWith().request(DEFAULT_STATUS_PATH, { headers: auth(huge) }, keyed)).status).toBe(404);
    expect(digest).toHaveBeenCalledTimes(2);
    for (const call of digest.mock.calls) expect((call[1] as Uint8Array).byteLength).toBeLessThanOrEqual(MAX_STATUS_KEY_BYTES);
  });

  it("does not hash anything for other paths", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const app = new Hono();
    app.use("*", projectStatus());
    app.get("*", (c) => c.text("ok"));
    await app.request("/elsewhere", { headers: auth() }, keyed);
    expect(digest).not.toHaveBeenCalled();
  });
});

describe("projectStatus: the right key", () => {
  it("answers 200 with the documented shape and headers, and nothing else", async () => {
    const app = appWith({
      project: "demo",
      bricks: [{ id: "credit-wallet", version: "1.2.0" }],
      shadow: [{ group: "wallet", report: async () => report("wallet") }],
    });
    const res = await app.request(DEFAULT_STATUS_PATH, { headers: auth() }, { ...keyed, ROUTE_SWITCH: "auth:brick", OTHER_SECRET: "s3cret" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect([...res.headers.keys()].some((h) => h.toLowerCase().startsWith("access-control-"))).toBe(false);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("s3cret");
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["bricks", "generatedAt", "project", "shadow", "switch", "version"]);
    expect(body.version).toBe(1);
    expect(body.project).toBe("demo");
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
    expect(body.bricks).toEqual([{ id: "credit-wallet", version: "1.2.0" }]);
    expect(body.switch).toEqual({ variable: "ROUTE_SWITCH", groups: { auth: "brick" } });
    expect(body.shadow).toEqual([okEntry("wallet")]);
  });

  it("leaves project out when none is given, and accepts a lower-case bearer scheme", async () => {
    const res = await appWith().request(DEFAULT_STATUS_PATH, { headers: { Authorization: `bearer ${KEY}` } }, keyed);
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect("project" in body).toBe(false);
    expect(body).toMatchObject({ bricks: [], shadow: [], switch: { variable: "ROUTE_SWITCH", groups: {} } });
  });

  it("parses the switch and ignores bad pairs", async () => {
    const res = await appWith().request(DEFAULT_STATUS_PATH, { headers: auth() }, { ...keyed, ROUTE_SWITCH: "auth:brick,wallet:shadow,bad" });
    expect((await readBody(res)).switch).toEqual({ variable: "ROUTE_SWITCH", groups: { auth: "brick", wallet: "shadow" } });
  });

  it("reads a custom switch variable", async () => {
    const res = await appWith({ switchVariable: "MIGRATION" }).request(
      DEFAULT_STATUS_PATH,
      { headers: auth() },
      { ...keyed, ROUTE_SWITCH: "auth:brick", MIGRATION: "health:brick" },
    );
    expect((await readBody(res)).switch).toEqual({ variable: "MIGRATION", groups: { health: "brick" } });
  });

  it("drops invalid brick entries and copies only id and version", async () => {
    const bricks = [
      { id: "core-auth", version: "2.0.1-beta.1", secret: "x" },
      { id: "Bad_Id", version: "1.0.0" },
      { id: "no-version", version: "latest" },
      { id: "-leading", version: "1.0.0" },
      null,
    ];
    const res = await appWith({ bricks: () => bricks as never }).request(DEFAULT_STATUS_PATH, { headers: auth() }, keyed);
    expect((await readBody(res)).bricks).toEqual([{ id: "core-auth", version: "2.0.1-beta.1" }]);
  });

  it("a bricks function that throws gives an empty list, not an error", async () => {
    const res = await appWith({
      bricks: () => {
        throw new Error("boom");
      },
    }).request(DEFAULT_STATUS_PATH, { headers: auth() }, keyed);
    expect(res.status).toBe(200);
    expect((await readBody(res)).bricks).toEqual([]);
  });

  it("passes the typed env to bricks and reporters", async () => {
    type Env = { TANGEBRICKS_STATUS_KEY: string; VERSION: string };
    const app = new Hono<{ Bindings: Env }>();
    app.use(
      DEFAULT_STATUS_PATH,
      projectStatus<Env>({
        bricks: (env) => [{ id: "core-auth", version: env.VERSION }],
        shadow: [{ group: "auth", report: async (env) => report("auth", { compared: env.VERSION.length }) }],
      }),
    );
    const body = await readBody(await app.request(DEFAULT_STATUS_PATH, { headers: auth() }, { ...keyed, VERSION: "3.1.4" }));
    expect(body.bricks).toEqual([{ id: "core-auth", version: "3.1.4" }]);
    expect(body.shadow).toEqual([{ ...okEntry("auth"), compared: 5 }]);
  });
});

describe("projectStatus: shadow reporters", () => {
  const get = (app: Hono) => app.request(DEFAULT_STATUS_PATH, { headers: auth() }, keyed);

  it("copies only the whitelisted fields, keeps a valid exactSince, and uses the configured group", async () => {
    const app = appWith({
      shadow: [
        {
          group: "wallet",
          report: async () => report("other-group", { rows: [{ tenantId: "t-1" }], tenantId: "t-1", exactSince: "2026-11-01T00:00:00.000Z" }),
        },
      ],
    });
    const body = await readBody(await get(app));
    expect(body.shadow).toEqual([{ ...okEntry("wallet"), exactSince: "2026-11-01T00:00:00.000Z" }]);
    expect(JSON.stringify(body)).not.toContain("t-1");
  });

  it("accepts only ISO-8601 UTC timestamps: a bad checkedAt is an error, a bad exactSince is dropped", async () => {
    const app = appWith({
      shadow: [
        { group: "a", report: async () => report("a", { checkedAt: "tenant-123" }) },
        { group: "b", report: async () => report("b", { checkedAt: "2026-11-28T00:00:00.000000Z" }) },
        { group: "c", report: async () => report("c", { checkedAt: "2026-11-28T00:00:00+05:30" }) },
        { group: "d", report: async () => report("d", { checkedAt: "2026-13-45T00:00:00Z" }) },
        { group: "e", report: async () => report("e", { exactSince: "user@example.com" }) },
        { group: "f", report: async () => report("f", { exactSince: "2026-11-01T00:00:00Z" }) },
      ],
    });
    expect((await readBody(await get(app))).shadow).toEqual([
      { group: "a", error: true },
      { group: "b", error: true },
      { group: "c", error: true },
      { group: "d", error: true },
      okEntry("e"),
      { ...okEntry("f"), exactSince: "2026-11-01T00:00:00Z" },
    ]);
  });

  it("drops exactSince when the report is not exact", async () => {
    const app = appWith({
      shadow: [{ group: "wallet", report: async () => report("wallet", { exact: false, differing: 1, exactSince: "2026-11-01T00:00:00.000Z" }) }],
    });
    expect((await readBody(await get(app))).shadow).toEqual([{ ...okEntry("wallet"), exact: false, differing: 1 }]);
  });

  it("a reporter that rejects, throws synchronously or returns junk becomes an error entry; the endpoint still answers 200", async () => {
    const app = appWith({
      shadow: [
        { group: "a", report: async () => Promise.reject(new Error("db down")) },
        {
          group: "b",
          report: () => {
            throw new Error("sync");
          },
        },
        { group: "c", report: async () => ({ exact: "yes" }) as never },
        { group: "d", report: async () => report("d") },
      ],
    });
    const res = await get(app);
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.shadow).toEqual([{ group: "a", error: true }, { group: "b", error: true }, { group: "c", error: true }, okEntry("d")]);
    expect(JSON.stringify(body)).not.toContain("db down");
  });

  it("a reporter that hangs times out (default 2 s), its signal is aborted, and the others run in parallel", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const app = appWith({
      shadow: [
        {
          group: "slow",
          report: (_env, options) => {
            signal = options.signal;
            return new Promise<never>(() => {});
          },
        },
        { group: "fast", report: async () => report("fast") },
      ],
    });
    const pending = get(app);
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void Promise.resolve(pending).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(signal?.aborted).toBe(true);
    expect(res.status).toBe(200);
    expect((await readBody(res)).shadow).toEqual([{ group: "slow", error: true }, okEntry("fast")]);
  });

  it("honours shadowTimeoutMs, and many hanging reporters still finish in one timeout", async () => {
    vi.useFakeTimers();
    const shadow = Array.from({ length: 20 }, (_, i) => ({ group: `g${i}`, report: () => new Promise<never>(() => {}) }));
    const pending = get(appWith({ shadow, shadowTimeoutMs: 50 }));
    await vi.advanceTimersByTimeAsync(50);
    const body = await readBody(await pending);
    expect(body.shadow).toHaveLength(20);
    expect(body.shadow.every((e) => "error" in e && e.error === true)).toBe(true);
  });

  it("clamps shadowTimeoutMs to 30 s and falls back to 2 s for invalid values", async () => {
    vi.useFakeTimers();
    const hang = [{ group: "slow", report: () => new Promise<never>(() => {}) }];
    const settledAfter = async (options: ProjectStatusOptions, ms: number) => {
      let settled = false;
      const pending = get(appWith({ ...options, shadow: hang }));
      void Promise.resolve(pending).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(ms - 1);
      const early = settled;
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      return { early, late: settled };
    };
    expect(await settledAfter({ shadowTimeoutMs: 2 ** 31 }, 30_000)).toEqual({ early: false, late: true });
    expect(await settledAfter({ shadowTimeoutMs: Number.POSITIVE_INFINITY }, 2000)).toEqual({ early: false, late: true });
    expect(await settledAfter({ shadowTimeoutMs: Number.NaN }, 2000)).toEqual({ early: false, late: true });
    expect(await settledAfter({ shadowTimeoutMs: -5 }, 2000)).toEqual({ early: false, late: true });
  });

  it("runs a reporter once for concurrent requests (single-flight)", async () => {
    let release: (r: ShadowReport) => void = () => {};
    const reporter = vi.fn(() => new Promise<ShadowReport>((resolve) => (release = resolve)));
    const app = appWith({ shadow: [{ group: "wallet", report: reporter }], shadowCacheMs: 0 });
    const both = Promise.all([get(app), get(app), get(app)]);
    await vi.waitFor(() => expect(reporter).toHaveBeenCalledTimes(1));
    release(report("wallet"));
    for (const res of await both) expect((await readBody(res)).shadow).toEqual([okEntry("wallet")]);
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it("reuses a result for shadowCacheMs (default 60 s), errors included; 0 disables the cache", async () => {
    vi.useFakeTimers();
    const reporter = vi.fn(async () => report("wallet"));
    const failing = vi.fn(async () => Promise.reject(new Error("down")));
    const app = appWith({
      shadow: [
        { group: "wallet", report: reporter },
        { group: "other", report: failing },
      ],
    });
    await get(app);
    await vi.advanceTimersByTimeAsync(59_999);
    await get(app);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await get(app);
    expect(reporter).toHaveBeenCalledTimes(2);
    expect(failing).toHaveBeenCalledTimes(2);

    const uncached = vi.fn(async () => report("wallet"));
    const noCache = appWith({ shadow: [{ group: "wallet", report: uncached }], shadowCacheMs: 0 });
    await get(noCache);
    await get(noCache);
    expect(uncached).toHaveBeenCalledTimes(2);
  });

  it("skips reporters with an invalid group name", async () => {
    const app = appWith({ shadow: [{ group: "Bad Group", report: async () => report("x") }] });
    expect((await readBody(await get(app))).shadow).toEqual([]);
  });

  it("does not run reporters for a refused request", async () => {
    const reporter = vi.fn(async () => report("wallet"));
    const app = appWith({ shadow: [{ group: "wallet", report: reporter }] });
    await app.request(DEFAULT_STATUS_PATH, { headers: auth("wrong") }, keyed);
    await app.request(DEFAULT_STATUS_PATH, { headers: auth() }, {});
    expect(reporter).not.toHaveBeenCalled();
  });
});

describe("constantTimeEqual", () => {
  it("is true only for equal strings", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
    expect(await constantTimeEqual("", "a")).toBe(false);
  });

  it("compares equal-length SHA-256 digests for inputs of different lengths", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    expect(await constantTimeEqual("short", "a much much longer key than the other one")).toBe(false);
    expect(digest).toHaveBeenCalledTimes(2);
    for (const call of digest.mock.calls) expect(call[0]).toBe("SHA-256");
    const lengths = await Promise.all(digest.mock.results.map(async (r) => ((await r.value) as ArrayBuffer).byteLength));
    expect(lengths).toEqual([32, 32]);
  });
});
