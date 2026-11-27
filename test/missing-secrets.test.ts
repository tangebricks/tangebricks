import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { D1Like } from "@poc/sdk";
import { createBetterAuth } from "../bricks/core-auth/src/auth.ts";
import { sealWorkspaceCredentials, unsealWorkspaceCredentials } from "../bricks/integration-connections/src/index.ts";
import { unsealPxConnectionSecret } from "../bricks/webhook-gateway/src/index.ts";
import { deriveConnectionVaultKey, sealConnectionCredentials } from "../packages/runtime/src/index.ts";
import { createStudioBetterAuth, deriveAesGcmVaultKey, encryptSecretValue, requireTelemetrySecret, sealDeployToken } from "../apps/studio-api/src/index.ts";
import type { StudioApiEnv } from "../apps/studio-api/src/blueprint-do.ts";

// Story 0.8: no secret falls back to a value written in source. Each SECRET_MISSING_* row of the plan's matrix is
// checked here: the error names the env var and never carries a secret value.

const db = env.DB as unknown as D1Like;

async function errorOf(fn: () => unknown): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw");
}

function expectMissing(err: Error, name: string): void {
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toBe(`Missing required secret ${name}`);
}

describe("SECRET_MISSING_AUTH", () => {
  it("core-auth refuses to build Better Auth without BETTER_AUTH_SECRET", async () => {
    expectMissing(await errorOf(() => createBetterAuth({ DB: db })), "BETTER_AUTH_SECRET");
    expectMissing(await errorOf(() => createBetterAuth({ DB: db, BETTER_AUTH_SECRET: "   " })), "BETTER_AUTH_SECRET");
  });

  it("studio auth refuses to build Better Auth without BETTER_AUTH_SECRET", async () => {
    const studioEnv = { STUDIO_DB: env.STUDIO_DB } as unknown as StudioApiEnv;
    expectMissing(await errorOf(() => createStudioBetterAuth(studioEnv)), "BETTER_AUTH_SECRET");
  });

  it("SECRET_PRESENT + GITHUB_UNSET: builds with the secret and leaves GitHub sign-in unconfigured", () => {
    const auth = createBetterAuth({ DB: db, BETTER_AUTH_SECRET: "test-only-secret-0123456789abcdef0123" });
    expect(auth.options.socialProviders).toEqual({});
    const withGithub = createBetterAuth({
      DB: db,
      BETTER_AUTH_SECRET: "test-only-secret-0123456789abcdef0123",
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
    });
    expect(Object.keys(withGithub.options.socialProviders ?? {})).toEqual(["github"]);
    const studio = createStudioBetterAuth({
      STUDIO_DB: env.STUDIO_DB,
      BETTER_AUTH_SECRET: "test-only-secret-0123456789abcdef0123",
    } as unknown as StudioApiEnv);
    expect(studio.options.socialProviders).toEqual({});
  });
});

describe("SECRET_MISSING_VAULT", () => {
  it("studio secrets vault refuses to derive a key without PX_VAULT_KEY", async () => {
    expectMissing(await errorOf(() => deriveAesGcmVaultKey(undefined)), "PX_VAULT_KEY");
    expectMissing(await errorOf(() => encryptSecretValue("sk_live_value", "")), "PX_VAULT_KEY");
    await expect(encryptSecretValue("sk_live_value", "test-only-vault-key")).resolves.toHaveProperty("ciphertextB64");
  });
});

describe("SECRET_MISSING_CONN", () => {
  it("runtime connections refuse to derive a key without PX_CONN_KEY", async () => {
    expectMissing(await errorOf(() => deriveConnectionVaultKey(undefined)), "PX_CONN_KEY");
    expectMissing(await errorOf(() => sealConnectionCredentials({ app: "stripe", authType: "api_key", apiKey: "sk_test_x" } as never)), "PX_CONN_KEY");
  });

  it("integration-connections refuses to seal or unseal without PX_CONN_KEY", async () => {
    expectMissing(await errorOf(() => sealWorkspaceCredentials({ provider: "github", accessToken: "gho_x" } as never, "ws_1")), "PX_CONN_KEY");
    expectMissing(await errorOf(() => unsealWorkspaceCredentials(JSON.stringify({ iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }), "ws_1")), "PX_CONN_KEY");
  });

  it("webhook-gateway refuses to unseal without PX_CONN_KEY", async () => {
    expectMissing(await errorOf(() => unsealPxConnectionSecret("AAAA", "AAAA")), "PX_CONN_KEY");
  });
});

describe("SECRET_MISSING_TOKEN_KEK", () => {
  it("studio token vault refuses to seal a deploy token without PX_TOKEN_KEK", async () => {
    const input = { orgId: "org_1", accountId: "acct_1", plaintextToken: "cf_token_value", createdBy: "usr_1" };
    const studioDb = env.STUDIO_DB as unknown as D1Like;
    expectMissing(await errorOf(() => sealDeployToken(studioDb, input)), "PX_TOKEN_KEK");
    expectMissing(await errorOf(() => sealDeployToken(studioDb, input, { STUDIO_DB: studioDb } as unknown as StudioApiEnv)), "PX_TOKEN_KEK");
    expectMissing(await errorOf(() => sealDeployToken(studioDb, input, { currentKekVersion: 2 })), "PX_TOKEN_KEK");
  });
});

describe("SECRET_MISSING_TELEMETRY", () => {
  it("studio-api refuses to sign or verify telemetry without PX_TELEMETRY_SECRET", async () => {
    expectMissing(await errorOf(() => requireTelemetrySecret({})), "PX_TELEMETRY_SECRET");
    expectMissing(await errorOf(() => requireTelemetrySecret({ PX_TELEMETRY_SECRET: " " })), "PX_TELEMETRY_SECRET");
    expect(requireTelemetrySecret({ PX_TELEMETRY_SECRET: "test-only-telemetry" })).toBe("test-only-telemetry");
  });
});
