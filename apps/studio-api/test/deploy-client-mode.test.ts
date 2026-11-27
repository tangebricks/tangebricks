import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createStudioApiApp, getStudioControlPlane, getStudioFakeControlPlane, getStudioVerificationClient, studioDeployClientMode } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { MockCloudflareControlPlane } from "../../../packages/deploy/src/target.ts";

// Story R53 (1.2): Studio deploys through the real Cloudflare client unless a test explicitly asks for the fake, and a
// production Studio can never get the fake. The suite's own bindings set PX_DEPLOY_CLIENT=fake (vitest.workers.config.ts).

const rawEnv = env as unknown as StudioApiEnv;
const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("which Cloudflare client Studio uses", () => {
  it("the real HTTP client by default; the fake only when asked for with PX_ENVIRONMENT test or development", () => {
    expect(studioDeployClientMode({})).toBe("http");
    expect(studioDeployClientMode({ PX_DEPLOY_CLIENT: "http" })).toBe("http");
    expect(studioDeployClientMode({ PX_DEPLOY_CLIENT: "fake", PX_ENVIRONMENT: "test" })).toBe("fake");
    expect(studioDeployClientMode({ PX_DEPLOY_CLIENT: "fake", PX_ENVIRONMENT: "development" })).toBe("fake");
    expect(getStudioControlPlane(ACCOUNT, {})).not.toBeInstanceOf(MockCloudflareControlPlane);
    expect((getStudioControlPlane(ACCOUNT, {}) as { kind?: string }).kind).toBe("http");
    expect(getStudioControlPlane(ACCOUNT, { PX_DEPLOY_CLIENT: "fake", PX_ENVIRONMENT: "test" })).toBeInstanceOf(MockCloudflareControlPlane);
    // each call is a new real client: nothing it records or holds outlives the request
    expect(getStudioControlPlane(ACCOUNT, {})).not.toBe(getStudioControlPlane(ACCOUNT, {}));
  });

  it("the fake is refused everywhere else (production, preview, unset), not ignored", () => {
    for (const environment of ["production", "preview", "staging", undefined]) {
      const env = { PX_DEPLOY_CLIENT: "fake", ...(environment ? { PX_ENVIRONMENT: environment } : {}) };
      expect(() => studioDeployClientMode(env)).toThrow(/refused unless PX_ENVIRONMENT is "test" or "development"/);
      expect(() => getStudioControlPlane(ACCOUNT, env)).toThrow(/refused/);
      expect(() => getStudioVerificationClient(env)).toThrow(/refused/);
      expect(() => getStudioFakeControlPlane(ACCOUNT, env)).toThrow(/refused/);
    }
    expect(() => getStudioFakeControlPlane(ACCOUNT, { PX_ENVIRONMENT: "test" })).toThrow(/tests only/);
    expect(getStudioControlPlane(ACCOUNT, { PX_ENVIRONMENT: "production" })).not.toBeInstanceOf(MockCloudflareControlPlane);
    expect(() => studioDeployClientMode({ PX_DEPLOY_CLIENT: "mock", PX_ENVIRONMENT: "test" })).toThrow(/must be "http" or "fake"/);
  });

  it("Cloudflare unreachable at verify-and-save is 502, and a recheck never marks the token revoked on an unreachable answer", async () => {
    let mode: "ok" | "down" = "ok";
    const envelope = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200, headers: { "content-type": "application/json" } });
    const app = createStudioApiApp({
      deploy: {
        sleep: async () => {},
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/user/tokens/verify")) {
            return mode === "down"
              ? new Response(JSON.stringify({ success: false, errors: [{ code: 10013, message: "unavailable" }] }), { status: 503 })
              : envelope({ id: "user-token", status: "active" });
          }
          if (path.endsWith("/tokens/verify"))
            return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }), { status: 401 });
          if (path === `/client/v4/accounts/${ACCOUNT}`) return envelope({ id: ACCOUNT, name: "Owner" });
          if (path.endsWith("/workers/subdomain")) return envelope({ subdomain: "owner" });
          return envelope([]);
        },
      },
    });
    const liveEnv: StudioApiEnv = { ...rawEnv, PX_DEPLOY_CLIENT: undefined };
    const call = (path: string, body: unknown, token?: string) =>
      app.fetch(
        new Request(`https://studio.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        }),
        liveEnv,
      );
    const signup = await call("/api/auth/signup", { email: `r53u-${crypto.randomUUID().slice(0, 8)}@example.test`, password: "Password12345!", name: "R53 U" });
    const { token: session } = (await signup.json()) as { token: string };
    const org = await call("/api/orgs", { name: "R53 U", slug: `r53u-${crypto.randomUUID().slice(0, 8)}` }, session);
    const { id: orgId } = (await org.json()) as { id: string };

    // a user token, checked with reads: accepted, with the Edit scopes left to the first deploy
    const saved = await call(
      `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`,
      { token: "cfut_user_token_r53_0123456789abcdef", accountId: ACCOUNT },
      session,
    );
    expect(saved.status).toBe(201);
    const savedBody = (await saved.json()) as { tokenRef: string; verification: { verifiedBy: string; summaryMessage: string } };
    expect(savedBody.verification.verifiedBy).toBe("read-probe");
    expect(savedBody.verification.summaryMessage).toMatch(/confirmed by the first deploy/);

    mode = "down";
    const unreachable = await call(
      `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`,
      { token: "cfut_user_token_r53_0123456789abcdef", accountId: ACCOUNT },
      session,
    );
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as { error: { code: string } }).error.code).toBe("CLOUDFLARE_UNREACHABLE");

    const recheck = await call(`/api/orgs/${orgId}/cloudflare-tokens/${savedBody.tokenRef}/recheck`, {}, session);
    expect(recheck.status).toBe(502);
    const row = await rawEnv.STUDIO_DB.prepare("SELECT status FROM deploy_tokens WHERE token_ref = ?").bind(savedBody.tokenRef).first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("verify-and-save with the real client asks Cloudflare (with the account id from the request), and a fake-looking token is judged by Cloudflare's answer", async () => {
    const seen: Array<{ method: string; url: string; auth: string | null }> = [];
    const app = createStudioApiApp({
      deploy: {
        fetch: async (request) => {
          seen.push({ method: request.method, url: request.url, auth: request.headers.get("authorization") });
          return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }], messages: [], result: null }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    const liveEnv: StudioApiEnv = { ...rawEnv, PX_DEPLOY_CLIENT: undefined };
    const call = (path: string, body: unknown, token?: string) =>
      app.fetch(
        new Request(`https://studio.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        }),
        liveEnv,
      );
    const signup = await call("/api/auth/signup", {
      email: `r53-${crypto.randomUUID().slice(0, 8)}@example.test`,
      password: "Password12345!",
      name: "R53 Owner",
    });
    expect(signup.status).toBe(201);
    const { token: session } = (await signup.json()) as { token: string };
    const org = await call("/api/orgs", { name: "R53 Org", slug: `r53-${crypto.randomUUID().slice(0, 8)}` }, session);
    const { id: orgId } = (await org.json()) as { id: string };

    const noAccount = await call(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: "cf_scoped_valid_token_least_privilege" }, session);
    expect(noAccount.status).toBe(400);
    expect(((await noAccount.json()) as { error: { code: string } }).error.code).toBe("ACCOUNT_ID_REQUIRED");
    expect(seen).toHaveLength(0);

    const res = await call(
      `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`,
      { token: "cf_scoped_valid_token_least_privilege", accountId: ACCOUNT },
      session,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string }; verification: { status: string } };
    expect(body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");
    expect(body.verification.status).toBe("invalid");
    // account endpoint first, then the user-token endpoint; both refuse
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      `GET /client/v4/accounts/${ACCOUNT}/tokens/verify`,
      "GET /client/v4/user/tokens/verify",
    ]);
    expect(seen[0]!.auth).toBe("Bearer cf_scoped_valid_token_least_privilege");
  });
});
