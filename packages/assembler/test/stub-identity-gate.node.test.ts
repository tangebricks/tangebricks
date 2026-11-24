import { describe, expect, test } from "vitest";
import { assemble } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";

const blueprint = { project: "invoice-flow", identity: "stub", bricks: ["multi-workspace", "credit-wallet"] };

describe("UC9.8 — stub identity is refused for production at assembly", () => {
  test("production + stub is refused with the documented message", () => {
    const result = assemble(blueprint, catalog, { environment: "production" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('identity "stub" is for tests only; choose core-auth or oidc-verify');
  });

  test.each(["dev", "preview", undefined] as const)("stub in %s still assembles and records the environment", (environment) => {
    const result = assemble(blueprint, catalog, environment ? { environment } : undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.files["project.json"]!).environment).toBe(environment ?? "dev");
    expect(result.files["src/identity.stub.ts"]).toBeDefined();
  });

  test("the emitted stub answers 503 when PX_ENVIRONMENT is production", async () => {
    const result = assemble(blueprint, catalog);
    if (!result.ok) throw new Error(result.errors.join("; "));
    const source = result.files["src/identity.stub.ts"]!;
    const stub = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).stubIdentity as (c: unknown, next: () => Promise<unknown>) => Promise<Response | unknown>;
    const ctx = (env: Record<string, string>) => ({
      env,
      req: { header: (n: string) => (n === "x-test-user" ? "mallory" : undefined) },
      set: () => {},
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    });
    const prod = (await stub(ctx({ PX_ENVIRONMENT: "production" }), async () => new Response("ok"))) as Response;
    expect(prod.status).toBe(503);
    const dev = (await stub(ctx({ PX_ENVIRONMENT: "dev" }), async () => new Response("ok"))) as Response;
    expect(dev.status).toBe(200);
  });
});
