import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import studioAuthOrgsSql from "../migrations/0001_studio_auth_orgs.sql?raw";
import studioSecretVaultSql from "../migrations/0002_studio_secret_vault.sql?raw";
import cp5DeployTokensSql from "../migrations/0003_cp5_deploy_tokens.sql?raw";
import {
  CLOUDFLARE_API_TOKENS_DASHBOARD_URL,
  DeployTokenVaultError,
  app as studioApp,
  createStudioTokenResolver,
  decryptToken,
  listDeployTokenAuditLog,
  rotateDeployTokenKek,
  sealDeployToken,
} from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import {
  MockCloudflareControlPlane,
  createByocProvisioner,
} from "../../../packages/deploy/src/target.ts";
import type { DeployTarget } from "../../../packages/deploy/src/target.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;

const KEK_V1 = "studio-cp5-test-master-kek-v1-256bit-key-material-0001";
const KEK_V2 = "studio-cp5-test-master-kek-v2-256bit-key-material-0002";

const TEST_ENV: StudioApiEnv = {
  ...rawEnv,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
  PX_TOKEN_KEK: KEK_V1,
  PX_TOKEN_KEK_VERSION: "1",
  GITHUB_CLIENT_ID: "studio-gh-test-client-id",
  GITHUB_CLIENT_SECRET: "studio-gh-test-client-secret",
};

interface CallOptions {
  method?: string;
  token?: string;
  cookie?: string;
  headers?: Record<string, string>;
  body?: unknown;
  envOverride?: StudioApiEnv;
}

async function callStudio(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  // Story 0.14: a cookie-authenticated write must come from an allowed Origin (CSRF guard); this is the same origin.
  if (options.cookie && !headers.has("origin")) headers.set("origin", "https://example.test");

  let rawBody: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    rawBody = JSON.stringify(options.body);
  }

  return studioApp.fetch(
    new Request(`https://example.test${path}`, {
      method: options.method ?? (rawBody !== undefined ? "POST" : "GET"),
      headers,
      body: rawBody,
    }),
    options.envOverride ?? TEST_ENV,
  );
}

function flipFirstCiphertextBitBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  let mutatedBinary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    mutatedBinary += String.fromCharCode(bytes[i]!);
  }
  return btoa(mutatedBinary);
}

describe("Story 5.1 — Token Vault AES-256-GCM Envelope Encryption, Audit Log & Immediate Revocation", () => {
  beforeEach(async () => {
    await applyMigration(studioDb, studioAuthOrgsSql);
    await applyMigration(studioDb, studioSecretVaultSql);
    await applyMigration(studioDb, cp5DeployTokensSql);
    await studioDb.batch([
      studioDb.prepare("DELETE FROM deploy_token_audit_log"),
      studioDb.prepare("DELETE FROM deploy_tokens"),
      studioDb.prepare("DELETE FROM studio_audit_log"),
      studioDb.prepare("DELETE FROM studio_mcp_tokens"),
      studioDb.prepare("DELETE FROM studio_org_members"),
      studioDb.prepare("DELETE FROM studio_orgs"),
      studioDb.prepare('DELETE FROM "session"'),
      studioDb.prepare('DELETE FROM "account"'),
      studioDb.prepare('DELETE FROM "verification"'),
      studioDb.prepare('DELETE FROM "user"'),
    ]);
  });

  test("seals Cloudflare token with AES-256-GCM envelope encryption, returns tok_<uuidv7> metadata, and logs every decrypt", async () => {
    const accountId = "abcdef0123456789abcdef0123456789";
    const canaryToken = "cf_token_secret_canary_alpha_77889900";

    const metadata = await sealDeployToken(
      studioDb,
      {
        orgId: "org_acme",
        accountId,
        accountName: "Acme Production Account",
        plaintextToken: canaryToken,
        scopes: [
          "workers_scripts:write",
          "d1:write",
          "queues:write",
          "account:read",
        ],
        createdBy: "user_owner_1",
      },
      TEST_ENV,
    );

    expect(metadata.tokenRef).toMatch(
      /^tok_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(metadata.accountId).toBe(accountId);
    expect(metadata.accountName).toBe("Acme Production Account");
    expect(metadata.tokenLast4).toBe("9900");
    expect(metadata.status).toBe("active");
    expect(metadata.kekVersion).toBe(1);
    expect(JSON.stringify(metadata)).not.toContain(canaryToken);

    // Inspect raw D1 row: ciphertext and wrapped_dek must not contain plaintext token
    const rawRow = await studioDb
      .prepare(
        "SELECT ciphertext, iv, wrapped_dek, dek_iv, kek_version, status FROM deploy_tokens WHERE token_ref = ?",
      )
      .bind(metadata.tokenRef)
      .first<{
        ciphertext: string;
        iv: string;
        wrapped_dek: string;
        dek_iv: string;
        kek_version: number;
        status: string;
      }>();

    expect(rawRow).not.toBeNull();
    expect(rawRow!.status).toBe("active");
    expect(rawRow!.kek_version).toBe(1);
    expect(rawRow!.ciphertext).not.toContain(canaryToken);
    expect(rawRow!.wrapped_dek).not.toContain(canaryToken);
    // 96-bit IVs decode to 12 bytes
    expect(atob(rawRow!.iv).length).toBe(12);
    expect(atob(rawRow!.dek_iv).length).toBe(12);

    // Round-trip decryptToken and verify audit log
    const decrypted1 = await decryptToken(
      studioDb,
      metadata.tokenRef,
      {
        actor: "user_owner_1",
        deployId: "dep_001",
        action: "plan",
      },
      TEST_ENV,
    );
    expect(decrypted1).toBe(canaryToken);

    const decrypted2 = await decryptToken(
      studioDb,
      metadata.tokenRef,
      {
        actor: "user_owner_1",
        deployId: "dep_001",
        action: "apply",
      },
      TEST_ENV,
    );
    expect(decrypted2).toBe(canaryToken);

    const auditEntries = await listDeployTokenAuditLog(studioDb, {
      tokenRef: metadata.tokenRef,
    });
    expect(auditEntries).toHaveLength(2);
    expect(auditEntries[0]).toMatchObject({
      tokenRef: metadata.tokenRef,
      orgId: "org_acme",
      actor: "user_owner_1",
      deployId: "dep_001",
      action: "plan",
    });
    expect(auditEntries[1]).toMatchObject({
      tokenRef: metadata.tokenRef,
      orgId: "org_acme",
      actor: "user_owner_1",
      deployId: "dep_001",
      action: "apply",
    });
  });

  test("detects tampering when a bit is flipped in ciphertext or wrapped_dek", async () => {
    const accountId = "abcdef0123456789abcdef0123456789";
    const canaryToken = "cf_token_tamper_test_secret_11223344";

    const metadata = await sealDeployToken(
      studioDb,
      {
        orgId: "org_acme",
        accountId,
        plaintextToken: canaryToken,
        createdBy: "user_owner_1",
      },
      TEST_ENV,
    );

    const originalRow = await studioDb
      .prepare(
        "SELECT ciphertext, wrapped_dek FROM deploy_tokens WHERE token_ref = ?",
      )
      .bind(metadata.tokenRef)
      .first<{ ciphertext: string; wrapped_dek: string }>();

    // 1. Flip a bit in ciphertext
    const tamperedCiphertext = flipFirstCiphertextBitBase64(
      originalRow!.ciphertext,
    );
    await studioDb
      .prepare("UPDATE deploy_tokens SET ciphertext = ? WHERE token_ref = ?")
      .bind(tamperedCiphertext, metadata.tokenRef)
      .run();

    await expect(
      decryptToken(
        studioDb,
        metadata.tokenRef,
        { actor: "user_owner_1", deployId: "dep_tamper_1", action: "plan" },
        TEST_ENV,
      ),
    ).rejects.toMatchObject({
      name: "DeployTokenVaultError",
      code: "TOKEN_TAMPERED",
    });

    // Restore ciphertext and flip a bit in wrapped_dek
    const tamperedWrappedDek = flipFirstCiphertextBitBase64(
      originalRow!.wrapped_dek,
    );
    await studioDb
      .prepare(
        "UPDATE deploy_tokens SET ciphertext = ?, wrapped_dek = ? WHERE token_ref = ?",
      )
      .bind(originalRow!.ciphertext, tamperedWrappedDek, metadata.tokenRef)
      .run();

    await expect(
      decryptToken(
        studioDb,
        metadata.tokenRef,
        { actor: "user_owner_1", deployId: "dep_tamper_2", action: "plan" },
        TEST_ENV,
      ),
    ).rejects.toMatchObject({
      name: "DeployTokenVaultError",
      code: "TOKEN_TAMPERED",
    });

    // Failed tamper attempts must not produce successful decrypt audit entries
    const auditEntries = await listDeployTokenAuditLog(studioDb, {
      tokenRef: metadata.tokenRef,
    });
    expect(auditEntries).toHaveLength(0);
  });

  test("rotates KEK from kekVersion 1 to kekVersion 2 by re-wrapping DEKs without losing tokens", async () => {
    const accountId = "11223344556677889900aabbccddeeff";
    const tokenA = "cf_token_rotate_alpha_secret_1001";
    const tokenB = "cf_token_rotate_bravo_secret_2002";

    const metaA = await sealDeployToken(
      studioDb,
      {
        orgId: "org_rotate",
        accountId,
        plaintextToken: tokenA,
        createdBy: "user_owner_1",
      },
      { currentKek: KEK_V1, currentKekVersion: 1 },
    );

    const metaB = await sealDeployToken(
      studioDb,
      {
        orgId: "org_rotate",
        accountId,
        plaintextToken: tokenB,
        createdBy: "user_owner_1",
      },
      { currentKek: KEK_V1, currentKekVersion: 1 },
    );

    const beforeRowA = await studioDb
      .prepare(
        "SELECT ciphertext, wrapped_dek, kek_version FROM deploy_tokens WHERE token_ref = ?",
      )
      .bind(metaA.tokenRef)
      .first<{ ciphertext: string; wrapped_dek: string; kek_version: number }>();
    expect(beforeRowA!.kek_version).toBe(1);

    const rotation = await rotateDeployTokenKek(studioDb, {
      fromKekVersion: 1,
      fromKek: KEK_V1,
      toKekVersion: 2,
      toKek: KEK_V2,
      orgId: "org_rotate",
    });

    expect(rotation.rotatedCount).toBe(2);
    expect(rotation.rotatedTokenRefs.sort()).toEqual(
      [metaA.tokenRef, metaB.tokenRef].sort(),
    );

    const afterRowA = await studioDb
      .prepare(
        "SELECT ciphertext, wrapped_dek, kek_version FROM deploy_tokens WHERE token_ref = ?",
      )
      .bind(metaA.tokenRef)
      .first<{ ciphertext: string; wrapped_dek: string; kek_version: number }>();

    expect(afterRowA!.kek_version).toBe(2);
    // Envelope encryption keeps token ciphertext untouched while re-wrapping the DEK
    expect(afterRowA!.ciphertext).toBe(beforeRowA!.ciphertext);
    expect(afterRowA!.wrapped_dek).not.toBe(beforeRowA!.wrapped_dek);

    const rotatedEnv: StudioApiEnv = {
      ...TEST_ENV,
      PX_TOKEN_KEK: KEK_V2,
      PX_TOKEN_KEK_VERSION: "2",
    };

    const decryptedA = await decryptToken(
      studioDb,
      metaA.tokenRef,
      { actor: "user_owner_1", deployId: "dep_rot_1", action: "plan" },
      rotatedEnv,
    );
    const decryptedB = await decryptToken(
      studioDb,
      metaB.tokenRef,
      { actor: "user_owner_1", deployId: "dep_rot_2", action: "apply" },
      rotatedEnv,
    );

    expect(decryptedA).toBe(tokenA);
    expect(decryptedB).toBe(tokenB);
  });

  test("DELETE /api/orgs/:orgId/cloudflare-tokens/:tokenRef enforces role >= editor & connect scope, nulls ciphertext & wrapped_dek, logs audit, and blocks subsequent decrypt or provisioner calls", async () => {
    // 1. Sign up owner, builder (editor), and viewer users
    const ownerSignup = await callStudio("/api/auth/signup", {
      body: {
        email: "owner-cp5@example.com",
        password: "OwnerPassword123!",
        displayName: "Owner CP5",
      },
    });
    expect(ownerSignup.status).toBe(201);
    const ownerData = (await ownerSignup.json()) as {
      token: string;
      user: { id: string };
    };

    const builderSignup = await callStudio("/api/auth/signup", {
      body: {
        email: "builder-cp5@example.com",
        password: "BuilderPassword123!",
        displayName: "Builder CP5",
      },
    });
    expect(builderSignup.status).toBe(201);
    const builderData = (await builderSignup.json()) as {
      token: string;
      user: { id: string };
    };

    const viewerSignup = await callStudio("/api/auth/signup", {
      body: {
        email: "viewer-cp5@example.com",
        password: "ViewerPassword123!",
        displayName: "Viewer CP5",
      },
    });
    expect(viewerSignup.status).toBe(201);
    const viewerData = (await viewerSignup.json()) as {
      token: string;
      user: { id: string };
    };

    // 2. Create organization and add builder + viewer
    const createOrgRes = await callStudio("/api/orgs", {
      token: ownerData.token,
      body: { name: "CP5 Security Org", slug: "cp5-security-org" },
    });
    expect(createOrgRes.status).toBe(201);
    const orgData = (await createOrgRes.json()) as { id: string };
    const orgId = orgData.id;

    await callStudio(`/api/orgs/${orgId}/members`, {
      token: ownerData.token,
      body: { userId: builderData.user.id, role: "editor" },
    });
    await callStudio(`/api/orgs/${orgId}/members`, {
      token: ownerData.token,
      body: { userId: viewerData.user.id, role: "viewer" },
    });

    // 3. Issue two MCP tokens for builder: one without 'connect' scope, one with 'connect' scope. Story 0.15: each is
    // bound to a project of the org.
    const tokenProjRes = await callStudio(`/api/orgs/${orgId}/projects`, {
      token: ownerData.token,
      body: { project: "cp5-security-proj" },
    });
    expect(tokenProjRes.status).toBe(201);
    const mcpNoConnectRes = await callStudio(`/api/orgs/${orgId}/mcp-tokens`, {
      token: ownerData.token,
      body: {
        userId: builderData.user.id,
        clientName: "cursor-read-edit",
        projectId: "cp5-security-proj",
        scopes: ["read", "edit"],
      },
    });
    const mcpNoConnect = (await mcpNoConnectRes.json()) as { token: string };

    const mcpWithConnectRes = await callStudio(`/api/orgs/${orgId}/mcp-tokens`, {
      token: ownerData.token,
      body: {
        userId: builderData.user.id,
        clientName: "claude-connect",
        projectId: "cp5-security-proj",
        scopes: ["read", "edit", "connect"],
      },
    });
    const mcpWithConnect = (await mcpWithConnectRes.json()) as { token: string };

    // 4. Create Cloudflare token via POST /api/orgs/:orgId/cloudflare-tokens. Story 16: org-level routes refuse every
    // MCP token (they are project-bound), even one with the 'connect' scope; the builder signs in to do it.
    const accountId = "fedcba9876543210fedcba9876543210";
    const liveToken = "cf_live_token_to_be_revoked_55667788";

    const mcpCreateRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens`, {
      token: mcpWithConnect.token,
      body: { accountId, accountName: "CP5 BYOC Account", token: liveToken },
    });
    expect(mcpCreateRes.status).toBe(403);
    expect(((await mcpCreateRes.json()) as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN_TOKEN_CALLER",
    );

    const createTokenRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens`,
      {
        token: builderData.token,
        body: {
          accountId,
          accountName: "CP5 BYOC Account",
          token: liveToken,
        },
      },
    );
    expect(createTokenRes.status).toBe(201);
    const createdBody = (await createTokenRes.json()) as {
      tokenRef: string;
      tokenLast4: string;
      status: string;
    };
    const tokenRef = createdBody.tokenRef;
    expect(tokenRef).toMatch(/^tok_/);
    expect(createdBody.tokenLast4).toBe("7788");
    expect(createdBody.status).toBe("active");

    // 5. Viewer cannot revoke (403 FORBIDDEN_ROLE)
    const viewerDeleteRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens/${tokenRef}`,
      {
        method: "DELETE",
        token: viewerData.token,
      },
    );
    expect(viewerDeleteRes.status).toBe(403);

    // 6. MCP token without 'connect' scope cannot revoke (403; story 16: no MCP token may use an org-level route)
    const mcpNoScopeDeleteRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens/${tokenRef}`,
      {
        method: "DELETE",
        token: mcpNoConnect.token,
      },
    );
    expect(mcpNoScopeDeleteRes.status).toBe(403);
    const noScopeErr = (await mcpNoScopeDeleteRes.json()) as {
      error: { code: string };
    };
    expect(noScopeErr.error.code).toBe("FORBIDDEN_TOKEN_CALLER");

    // ...nor can the 'connect'-scoped MCP token (story 16).
    const mcpConnectDeleteRes = await callStudio(`/api/orgs/${orgId}/cloudflare-tokens/${tokenRef}`, {
      method: "DELETE",
      token: mcpWithConnect.token,
    });
    expect(mcpConnectDeleteRes.status).toBe(403);

    // 7. Verify provisioner works BEFORE revocation
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: liveToken,
      accountId,
      accountName: "CP5 BYOC Account",
    });

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: createStudioTokenResolver(studioDb, TEST_ENV),
    });

    const target: DeployTarget = {
      type: "byoc",
      accountId,
      tokenRef,
      envName: "preview",
    };

    const preRevokePlan = await provisioner.plan({
      target,
      project: "cp5-service",
      actor: builderData.user.id,
      deployId: "dep_before_revoke",
      buildHash: "sha256_v1",
      graphHash: "sha256_graph_v1",
      bundle: {
        code: "export default { fetch() { return new Response('ok'); } };",
        sha256: "sha256_v1",
      },
    });
    expect(preRevokePlan.noChanges).toBe(false);
    expect(controlPlane.calls.length).toBeGreaterThan(0);

    // 8. The builder (signed in; role >= editor) revokes the token via DELETE /api/orgs/:orgId/cloudflare-tokens/:tokenRef
    const revokeRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens/${tokenRef}`,
      {
        method: "DELETE",
        token: builderData.token,
      },
    );
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as {
      ok: boolean;
      tokenRef: string;
      orgId: string;
      status: string;
      revokedAt: string;
      cloudflareDashboardUrl: string;
    };
    expect(revokeBody.ok).toBe(true);
    expect(revokeBody.tokenRef).toBe(tokenRef);
    expect(revokeBody.orgId).toBe(orgId);
    expect(revokeBody.status).toBe("revoked");
    expect(revokeBody.cloudflareDashboardUrl).toBe(
      CLOUDFLARE_API_TOKENS_DASHBOARD_URL,
    );

    // 9. Verify D1 row has status = 'revoked' and ciphertext + wrapped_dek overwritten with NULL
    const revokedRow = await studioDb
      .prepare(
        "SELECT status, ciphertext, iv, wrapped_dek, dek_iv, revoked_at FROM deploy_tokens WHERE token_ref = ?",
      )
      .bind(tokenRef)
      .first<{
        status: string;
        ciphertext: string | null;
        iv: string | null;
        wrapped_dek: string | null;
        dek_iv: string | null;
        revoked_at: string | null;
      }>();
    expect(revokedRow).toEqual({
      status: "revoked",
      ciphertext: null,
      iv: null,
      wrapped_dek: null,
      dek_iv: null,
      revoked_at: revokeBody.revokedAt,
    });

    // 10. Clear mock Cloudflare call log and verify subsequent decryptToken and provisioner.plan/apply fail immediately with TOKEN_REVOKED and 0 outbound calls
    controlPlane.clearCalls();

    let caughtError: unknown;
    try {
      await decryptToken(
        studioDb,
        tokenRef,
        {
          actor: builderData.user.id,
          deployId: "dep_after_revoke",
          action: "plan",
        },
        TEST_ENV,
      );
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(DeployTokenVaultError);
    expect((caughtError as DeployTokenVaultError).code).toBe("TOKEN_REVOKED");

    await expect(
      provisioner.plan({
        target,
        project: "cp5-service",
        actor: builderData.user.id,
        deployId: "dep_after_revoke_plan",
        buildHash: "sha256_v1",
        graphHash: "sha256_graph_v1",
        bundle: {
          code: "export default {};",
          sha256: "sha256_v1",
        },
      }),
    ).rejects.toThrow(/TOKEN_REVOKED/);

    await expect(
      provisioner.apply({
        target,
        project: "cp5-service",
        actor: builderData.user.id,
        deployId: "dep_after_revoke_apply",
        buildHash: "sha256_v1",
        graphHash: "sha256_graph_v1",
        bundle: {
          code: "export default {};",
          sha256: "sha256_v1",
        },
      }),
    ).rejects.toThrow(/TOKEN_REVOKED/);

    expect(controlPlane.calls).toHaveLength(0);

    // 11. Verify deploy_token_audit_log has both the pre-revoke 'plan' decrypt and the 'revoke' entry
    const auditRes = await callStudio(
      `/api/orgs/${orgId}/cloudflare-tokens/${tokenRef}/audit`,
      {
        method: "GET",
        token: ownerData.token,
      },
    );
    expect(auditRes.status).toBe(200);
    const auditData = (await auditRes.json()) as {
      entries: Array<{
        auditId: string;
        tokenRef: string;
        orgId: string;
        actor: string;
        deployId: string;
        action: string;
        createdAt: string;
      }>;
    };
    expect(auditData.entries).toHaveLength(2);
    expect(auditData.entries[0]?.action).toBe("plan");
    expect(auditData.entries[0]?.deployId).toBe("dep_before_revoke");
    expect(auditData.entries[1]?.action).toBe("revoke");
    expect(auditData.entries[1]?.deployId).toBe("revoke");
  });
});
