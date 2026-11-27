import { describe, expect, it } from "vitest";
import {
  ByocDeployTargetSchema,
  DeployTargetSchema,
  MockCloudflareControlPlane,
  TokenResolverContextSchema,
  createByocProvisioner,
  deriveEnvironmentResourceNames,
} from "../src/index.ts";
import type { DeployTarget, TokenResolverContext } from "../src/index.ts";
import { scanSourceForForbiddenDeployEnvReads } from "../../../scripts/lint-deploy-target.ts";

describe("Story 5.1 — Abstract DeployTarget & DeployProvisioner (packages/deploy)", () => {
  const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  const TOKEN_REF = "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab";
  const PLAINTEXT_TOKEN = "cf_live_token_secret_canary_99887766";
  const BUNDLE = {
    code: "export default { fetch() { return new Response('ok'); } };",
    sha256: "sha256_bundle_v1",
  };

  it("validates DeployTarget = { type: 'byoc', accountId, tokenRef, envName } via Zod", () => {
    const validPreview = DeployTargetSchema.parse({
      type: "byoc",
      accountId: ACCOUNT_ID,
      tokenRef: TOKEN_REF,
      envName: "preview",
    });
    expect(validPreview).toEqual({
      type: "byoc",
      accountId: ACCOUNT_ID,
      tokenRef: TOKEN_REF,
      envName: "preview",
    });

    const validProd = ByocDeployTargetSchema.parse({
      type: "byoc",
      accountId: ACCOUNT_ID.toUpperCase(),
      tokenRef: TOKEN_REF,
      envName: "production",
    });
    expect(validProd.accountId).toBe(ACCOUNT_ID);

    expect(
      DeployTargetSchema.safeParse({
        type: "platform-sandbox",
        accountId: ACCOUNT_ID,
        tokenRef: TOKEN_REF,
        envName: "preview",
      }).success,
    ).toBe(false);

    expect(
      DeployTargetSchema.safeParse({
        type: "byoc",
        accountId: "not-a-valid-32-char-hex-account",
        tokenRef: TOKEN_REF,
        envName: "preview",
      }).success,
    ).toBe(false);

    expect(
      DeployTargetSchema.safeParse({
        type: "byoc",
        accountId: ACCOUNT_ID,
        tokenRef: "raw_token_without_tok_prefix",
        envName: "preview",
      }).success,
    ).toBe(false);

    expect(
      DeployTargetSchema.safeParse({
        type: "byoc",
        accountId: ACCOUNT_ID,
        tokenRef: TOKEN_REF,
        envName: "staging",
      }).success,
    ).toBe(false);
  });

  it("executes plan, apply, putGraph, putSecret, promote, and destroy using TokenResolver only at the HTTP transport boundary", async () => {
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: PLAINTEXT_TOKEN,
      accountId: ACCOUNT_ID,
      accountName: "Acme BYOC Account",
    });

    const resolvedCalls: Array<{
      tokenRef: string;
      context: TokenResolverContext;
    }> = [];

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: async (tokenRef, context) => {
        const validatedCtx = TokenResolverContextSchema.parse(context);
        resolvedCalls.push({ tokenRef, context: validatedCtx });
        return PLAINTEXT_TOKEN;
      },
    });

    const previewTarget: DeployTarget = {
      type: "byoc",
      accountId: ACCOUNT_ID,
      tokenRef: TOKEN_REF,
      envName: "preview",
    };

    const planResult = await provisioner.plan({
      target: previewTarget,
      project: "billing-app",
      actor: "user_owner_1",
      deployId: "dep_plan_01",
      buildHash: "sha256_build_v1",
      graphHash: "sha256_graph_v1",
      bundle: BUNDLE,
      migrations: [
        {
          name: "0001_init.sql",
          sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY);",
          sha256: "chk_0001",
        },
      ],
      queues: ["px-billing-app-preview-events"],
      cronTriggers: ["*/15 * * * *"],
      workflows: [{ name: "px-billing-app-preview-wf", className: "GraphRunner" }],
      requiredSecrets: ["STRIPE_API_KEY"],
      configuredSecrets: ["STRIPE_API_KEY"],
    });

    expect(planResult.noChanges).toBe(false);
    expect(planResult.actions.some((a) => a.kind === "worker_script" && a.action === "create")).toBe(true);
    expect(JSON.stringify(planResult)).not.toContain(PLAINTEXT_TOKEN);

    const applyResult = await provisioner.apply({
      target: previewTarget,
      project: "billing-app",
      actor: "user_owner_1",
      deployId: "dep_apply_01",
      buildHash: "sha256_build_v1",
      graphHash: "sha256_graph_v1",
      bundle: BUNDLE,
      migrations: [
        {
          name: "0001_init.sql",
          sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY);",
          sha256: "chk_0001",
        },
      ],
      queues: ["px-billing-app-preview-events"],
      cronTriggers: ["*/15 * * * *"],
      workflows: [{ name: "px-billing-app-preview-wf", className: "GraphRunner" }],
      secrets: { STRIPE_API_KEY: "sk_test_12345" },
    });

    const expectedPreviewNames = deriveEnvironmentResourceNames("billing-app", "preview");
    expect(applyResult.scriptName).toBe(expectedPreviewNames.scriptName);
    expect(applyResult.appliedActions.some((a) => a.kind === "d1_migration" && a.name === "0001_init.sql")).toBe(true);
    expect(applyResult.appliedActions.some((a) => a.kind === "secret" && a.name === "STRIPE_API_KEY")).toBe(true);
    expect(JSON.stringify(applyResult)).not.toContain(PLAINTEXT_TOKEN);

    // Repeat plan against deployed preview state should report noChanges === true
    const repeatPlan = await provisioner.plan({
      target: previewTarget,
      project: "billing-app",
      actor: "user_owner_1",
      deployId: "dep_plan_02",
      buildHash: "sha256_build_v1",
      graphHash: "sha256_graph_v1",
      bundle: BUNDLE,
      migrations: [
        {
          name: "0001_init.sql",
          sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY);",
          sha256: "chk_0001",
        },
      ],
      queues: ["px-billing-app-preview-events"],
      cronTriggers: ["*/15 * * * *"],
      workflows: [{ name: "px-billing-app-preview-wf", className: "GraphRunner" }],
      requiredSecrets: ["STRIPE_API_KEY"],
      configuredSecrets: ["STRIPE_API_KEY"],
    });
    expect(repeatPlan.noChanges).toBe(true);

    // Hot-apply graph update via putGraph
    const putGraphResult = await provisioner.putGraph({
      target: previewTarget,
      project: "billing-app",
      actor: "user_owner_1",
      deployId: "dep_graph_01",
      graphId: "wf_main",
      graphJson: JSON.stringify({ nodes: [], edges: [] }),
      graphHash: "sha256_graph_v2",
    });
    expect(putGraphResult.graphHash).toBe("sha256_graph_v2");
    expect(putGraphResult.rebuiltWorker).toBe(false);

    // Bind secret via putSecret
    const putSecretResult = await provisioner.putSecret({
      target: previewTarget,
      project: "billing-app",
      actor: "user_owner_1",
      deployId: "dep_sec_01",
      secretName: "WEBHOOK_SIGNING_SECRET",
      secretValue: "whsec_live_999",
    });
    expect(putSecretResult.secretName).toBe("WEBHOOK_SIGNING_SECRET");

    // Promote from preview to production
    const prodTarget: DeployTarget = {
      type: "byoc",
      accountId: ACCOUNT_ID,
      tokenRef: TOKEN_REF,
      envName: "production",
    };
    const promoteResult = await provisioner.promote({
      sourceTarget: previewTarget,
      destinationTarget: prodTarget,
      project: "billing-app",
      actor: "user_owner_1",
      deployId: "dep_promote_01",
      buildHash: "sha256_build_v1",
      graphHash: "sha256_graph_v2",
      bundle: BUNDLE,
      migrations: [
        {
          name: "0001_init.sql",
          sql: "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY);",
          sha256: "chk_0001",
        },
      ],
    });
    expect(promoteResult.reusedArtifactBuildHash).toBe("sha256_build_v1");
    expect(promoteResult.promotedFromEnv).toBe("preview");

    // Destroy preview environment
    const destroyResult = await provisioner.destroy({
      target: previewTarget,
      project: "billing-app",
      actor: "user_owner_1",
      deployId: "dep_destroy_01",
    });
    expect(destroyResult.removedResources).toContain(expectedPreviewNames.scriptName);
    expect(destroyResult.removedResources).toContain(expectedPreviewNames.databaseName);

    expect(resolvedCalls.map((c) => c.context.action)).toEqual(["plan", "apply", "plan", "putGraph", "putSecret", "promote", "destroy"]);
  });

  it("aborts plan and apply immediately with zero Cloudflare API requests when TokenResolver throws TOKEN_REVOKED", async () => {
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: PLAINTEXT_TOKEN,
      accountId: ACCOUNT_ID,
    });

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: async (tokenRef) => {
        const err = new Error(`TOKEN_REVOKED: Token ${tokenRef} has been revoked`);
        (err as Error & { code: string }).code = "TOKEN_REVOKED";
        throw err;
      },
    });

    const target: DeployTarget = {
      type: "byoc",
      accountId: ACCOUNT_ID,
      tokenRef: TOKEN_REF,
      envName: "preview",
    };

    await expect(
      provisioner.plan({
        target,
        project: "revoked-app",
        actor: "user_owner_1",
        deployId: "dep_revoked_plan",
        buildHash: "sha256_build_v1",
        graphHash: "sha256_graph_v1",
        bundle: BUNDLE,
      }),
    ).rejects.toThrow(/TOKEN_REVOKED/);

    await expect(
      provisioner.apply({
        target,
        project: "revoked-app",
        actor: "user_owner_1",
        deployId: "dep_revoked_apply",
        buildHash: "sha256_build_v1",
        graphHash: "sha256_graph_v1",
        bundle: BUNDLE,
      }),
    ).rejects.toThrow(/TOKEN_REVOKED/);

    expect(controlPlane.calls).toHaveLength(0);
  });

  it("static lint scanner flags forbidden process.env / Worker env CLOUDFLARE_* reads and hard-coded accountIds", () => {
    const badProcessEnv = `
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env["CLOUDFLARE_API_TOKEN"];
    `;
    const issues1 = scanSourceForForbiddenDeployEnvReads(badProcessEnv, "packages/deploy/src/bad.ts");
    expect(issues1).toHaveLength(2);
    expect(issues1[0]?.rule).toBe("FORBIDDEN_CLOUDFLARE_ENV_READ");
    expect(issues1[1]?.rule).toBe("FORBIDDEN_CLOUDFLARE_ENV_READ");

    const badWorkerEnv = `
      export function deployFromWorker(c: Context) {
        return c.env.CLOUDFLARE_API_TOKEN;
      }
    `;
    const issues2 = scanSourceForForbiddenDeployEnvReads(badWorkerEnv, "apps/studio-api/src/bad-route.ts");
    expect(issues2).toHaveLength(1);
    expect(issues2[0]?.rule).toBe("FORBIDDEN_CLOUDFLARE_ENV_READ");

    const badHardcodedAccount = `
      const target = { accountId: "0123456789abcdef0123456789abcdef" };
    `;
    const issues3 = scanSourceForForbiddenDeployEnvReads(badHardcodedAccount, "packages/deploy/src/hardcoded.ts");
    expect(issues3).toHaveLength(1);
    expect(issues3[0]?.rule).toBe("FORBIDDEN_HARDCODED_ACCOUNT_ID");

    const cleanSource = `
      import type { DeployTarget } from "./target.ts";
      export function getAccountId(target: DeployTarget): string {
        return target.accountId;
      }
    `;
    expect(scanSourceForForbiddenDeployEnvReads(cleanSource, "packages/deploy/src/clean.ts")).toHaveLength(0);
  });
});
