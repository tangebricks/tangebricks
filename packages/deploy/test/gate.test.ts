import { describe, expect, test, vi } from "vitest";
import { DEMO_PATH, KEY_HEADER, MIN_KEY_LENGTH, createGatedWorker, sameSecret } from "../src/worker/gate.ts";
import { computeDeployPlan, validateDeployPlan } from "../src/index.ts";

// The access-key gate that wraps a deployed project. Run in workerd, where the gate runs when deployed.

const KEY = "correct-horse-battery-staple-0123";
const DEMO = "<!doctype html><p>demo page, no data</p>";

function setup() {
  const app = { fetch: vi.fn(async (request: Request, _env: unknown, _ctx: unknown) => new Response(JSON.stringify({ reached: new URL(request.url).pathname }), { status: 200, headers: { "content-type": "application/json" } })) };
  const worker = createGatedWorker({ app, demoHtml: DEMO });
  const call = (path: string, init: RequestInit = {}, env: Record<string, unknown> = { POC_ACCESS_KEY: KEY, DB: "a-binding" }) => worker.fetch(new Request(`https://x.example${path}`, init), env, {});
  return { app, call };
}
const withKey = (value: string): RequestInit => ({ headers: { [KEY_HEADER]: value } });

describe("the demo page", () => {
  test("is served without a key, exactly as given, with headers that keep it inert", async () => {
    const { app, call } = setup();
    const res = await call(DEMO_PATH);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DEMO);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(res.headers.get("content-security-policy")).toMatch(/connect-src 'self'/);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(app.fetch).not.toHaveBeenCalled();
  });

  test("a query string does not change what is served or open anything else", async () => {
    const { app, call } = setup();
    expect((await call(`${DEMO_PATH}?x=1`)).status).toBe(200);
    expect((await call(`${DEMO_PATH}?path=/api/wallet`)).status).toBe(200);
    expect(app.fetch).not.toHaveBeenCalled();
  });

  test("is served even when no access key is configured, because it holds nothing", async () => {
    const { call } = setup();
    expect((await call(DEMO_PATH, {}, {})).status).toBe(200);
  });

  test.each([
    ["a trailing slash", "/demo/"],
    ["a different case", "/Demo"],
    ["a doubled slash", "//demo"],
    ["a file under it", "/demo.js"],
    ["a path under it", "/demo/extra"],
  ])("%s is not the demo page and needs the key", async (_label, path) => {
    const { app, call } = setup();
    expect((await call(path)).status).toBe(401);
    expect(app.fetch).not.toHaveBeenCalled();
  });

  test.each(["POST", "PUT", "DELETE", "PATCH", "HEAD"])("%s to the demo path is not the page and needs the key", async (method) => {
    const { app, call } = setup();
    expect((await call(DEMO_PATH, { method })).status).toBe(401);
    expect(app.fetch).not.toHaveBeenCalled();
  });
});

describe("everything else needs the key", () => {
  test.each(["/", "/api/wallet", "/api/invoices", "/api/workspaces", "/api/invoices/123", "/health", "/anything/else"])("%s without a key is 401 and never reaches the project", async (path) => {
    const { app, call } = setup();
    const res = await call(path);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(app.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ["an empty key", ""],
    ["the start of the right key", KEY.slice(0, 20)],
    ["the right key with a character added", KEY + "x"],
    ["the right key with a character changed", KEY.slice(0, -1) + "4"],
    ["the right key in upper case", KEY.toUpperCase()],
    ["the right key with a space before", " " + KEY],
    ["the right key with a space after", KEY + " "],
    ["a different key of the same length", "x".repeat(KEY.length)],
    ["a much longer key", KEY.repeat(50)],
    ["a key in non-ASCII text", "ключ-доступа-0123456789-abcdef"],
  ])("%s is 401", async (_label, value) => {
    const { app, call } = setup();
    // a header with a space at either end is trimmed by the Headers class, so those two are really the right key
    const trimmed = value.trim() === KEY;
    const res = await call("/api/wallet", withKey(value));
    expect(res.status).toBe(trimmed ? 200 : 401);
    expect(app.fetch).toHaveBeenCalledTimes(trimmed ? 1 : 0);
  });

  test("the key in the wrong place does not count: Authorization, a cookie, the query string", async () => {
    const { app, call } = setup();
    expect((await call("/api/wallet", { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(401);
    expect((await call("/api/wallet", { headers: { cookie: `${KEY_HEADER}=${KEY}` } })).status).toBe(401);
    expect((await call(`/api/wallet?${KEY_HEADER}=${KEY}&key=${KEY}`)).status).toBe(401);
    expect((await call("/api/wallet", { headers: { "x-test-user": KEY, "x-workspace-id": KEY } })).status).toBe(401);
    expect(app.fetch).not.toHaveBeenCalled();
  });

  test("the right key lets the request through untouched, with the environment and context", async () => {
    const { app, call } = setup();
    const res = await call("/api/wallet", { method: "POST", headers: { [KEY_HEADER]: KEY, "x-test-user": "alice" }, body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: "/api/wallet" });
    expect(app.fetch).toHaveBeenCalledTimes(1);
    const [request, env] = app.fetch.mock.calls[0]!;
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-test-user")).toBe("alice");
    expect(env).toMatchObject({ DB: "a-binding" });
  });

  test("the key works for every method", async () => {
    const { app, call } = setup();
    for (const method of ["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"]) expect((await call("/api/x", { method, headers: { [KEY_HEADER]: KEY } })).status, method).toBe(200);
    expect(app.fetch).toHaveBeenCalledTimes(6);
  });
});

describe("a deployment with no usable key refuses everyone", () => {
  test.each([
    ["no binding", {}],
    ["an empty key", { POC_ACCESS_KEY: "" }],
    ["a key that is too short", { POC_ACCESS_KEY: "short" }],
    ["a key one character under the minimum", { POC_ACCESS_KEY: "x".repeat(MIN_KEY_LENGTH - 1) }],
    ["a key that is not text", { POC_ACCESS_KEY: 1234567890123456 }],
    ["a key that is null", { POC_ACCESS_KEY: null }],
    ["a key that is an object", { POC_ACCESS_KEY: { toString: () => "x".repeat(40) } }],
  ])("%s is 503 for a caller with the matching header, an empty one, and none", async (_label, env) => {
    const { app, call } = setup();
    const guess = typeof (env as { POC_ACCESS_KEY?: unknown }).POC_ACCESS_KEY === "string" ? ((env as { POC_ACCESS_KEY: string }).POC_ACCESS_KEY) : "";
    for (const init of [withKey(guess), withKey(""), {}]) expect((await call("/api/wallet", init, env)).status).toBe(503);
    expect(app.fetch).not.toHaveBeenCalled();
  });

  test("a key of exactly the minimum length is accepted", async () => {
    const { call } = setup();
    const minimal = "k".repeat(MIN_KEY_LENGTH);
    expect((await call("/api/wallet", withKey(minimal), { POC_ACCESS_KEY: minimal })).status).toBe(200);
  });
});

describe("nothing the gate says contains the key", () => {
  test("401 and 503 bodies and headers do not echo the configured or the given key", async () => {
    const { call } = setup();
    // a configured value that is too short to be a key is still a secret: it must not come back either
    const SHORT = "identifiable-12";
    expect(SHORT.length).toBeLessThan(MIN_KEY_LENGTH);
    const texts: string[] = [];
    for (const res of [await call("/api/wallet", withKey("a-wrong-but-recognisable-key-0000")), await call("/api/wallet"), await call("/api/wallet", withKey(SHORT), { POC_ACCESS_KEY: SHORT })]) {
      texts.push(await res.text(), JSON.stringify([...res.headers]));
    }
    expect(texts).toHaveLength(6);
    for (const text of texts) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("a-wrong-but-recognisable-key-0000");
      expect(text).not.toContain(SHORT);
    }
  });

  test("the demo page given to the gate is returned as it is; a page that held the key would be the page author's mistake, so the build is tested for that separately", async () => {
    const { call } = setup();
    expect(await (await call(DEMO_PATH)).text()).not.toContain(KEY);
  });
});

describe("sameSecret", () => {
  test("equal strings match and any difference does not", async () => {
    expect(await sameSecret(KEY, KEY)).toBe(true);
    expect(await sameSecret(KEY, KEY.slice(0, -1))).toBe(false);
    expect(await sameSecret(KEY.slice(0, -1) + "x", KEY)).toBe(false);
    expect(await sameSecret("", KEY)).toBe(false);
    expect(await sameSecret(KEY, "")).toBe(false);
    expect(await sameSecret("ключ", "ключ")).toBe(true);
    expect(await sameSecret("ключ", "ключи")).toBe(false);
  });

  test("a difference in the first byte and in the last byte are both found", async () => {
    expect(await sameSecret("a" + KEY.slice(1), KEY)).toBe(false);
    expect(await sameSecret(KEY.slice(0, -1) + "z", KEY)).toBe(false);
  });
});

describe("deploy plan validation refuses unsigned webhooks in production (UC1.7)", () => {
  test("refuses a production environment plan that sets PX_WEBHOOK_ALLOW_UNSIGNED=dev with DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION", () => {
    const prodTarget = {
      type: "byoc" as const,
      accountId: "0123456789abcdef0123456789abcdef",
      tokenRef: "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab",
      envName: "production" as const,
    };

    const blockedPlan = computeDeployPlan(prodTarget, {
      project: "acme-saas",
      buildHash: "sha256_build_prod_unsigned",
      identity: "core-auth",
      vars: {
        PX_WEBHOOK_ALLOW_UNSIGNED: "dev",
      },
    });

    const blocker = blockedPlan.blockers.find((b) => b.code === "DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION");
    expect(blocker).toBeDefined();
    expect(blocker?.code).toBe("DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION");
    expect(() => validateDeployPlan(blockedPlan)).toThrowError(/DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION/);

    // Preview target allows PX_WEBHOOK_ALLOW_UNSIGNED=dev
    const previewTarget = {
      type: "byoc" as const,
      accountId: "0123456789abcdef0123456789abcdef",
      tokenRef: "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab",
      envName: "preview" as const,
    };
    const previewPlan = computeDeployPlan(previewTarget, {
      project: "acme-saas",
      buildHash: "sha256_build_preview_unsigned",
      identity: "core-auth",
      vars: {
        PX_WEBHOOK_ALLOW_UNSIGNED: "dev",
      },
    });
    expect(previewPlan.blockers.some((b) => b.code === "DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION")).toBe(false);
  });
});
