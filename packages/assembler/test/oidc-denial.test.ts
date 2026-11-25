import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { assemble } from "../src/assemble.ts";
import { catalog } from "../catalog.generated.ts";
import { createOidcMiddleware } from "../../../bricks/oidc-verify/src/index.ts";
import { workspaceMiddleware } from "../../../bricks/multi-workspace/src/middleware.ts";
import { createWorkspaceRoutes } from "../../../bricks/multi-workspace/src/routes.ts";
import { createWalletRoutes } from "../../../bricks/credit-wallet/src/routes.ts";
import { applyMigration, type D1Like } from "@poc/sdk";
import { Hono } from "hono";

// Key generation and JWT signing helper for denial test suite
async function generateRsaKeyPair() {
  return await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

function base64UrlEncode(bytes: Uint8Array | string): string {
  const binary =
    typeof bytes === "string"
      ? btoa(bytes)
      : btoa(String.fromCharCode(...bytes));
  return binary.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type CryptoKeyType = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: CryptoKeyType,
): Promise<string> {
  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${encHeader}.${encPayload}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  const encSignature = base64UrlEncode(new Uint8Array(signature));
  return `${encHeader}.${encPayload}.${encSignature}`;
}

describe("Story UC9.6 / AC3: Blueprint assembly and denial suite with identity 'oidc-verify'", () => {
  test("AC3: assemble() succeeds with identity: 'oidc-verify' and mounts oidcMiddleware on /api/*", () => {
    const blueprint = {
      project: "oidc-app",
      identity: "oidc-verify",
      bricks: [
        "oidc-verify",
        "multi-workspace",
        "credit-wallet",
      ],
    };

    const res = assemble(blueprint, catalog);
    expect(res.ok, res.ok ? "" : (res as any).errors.join("\n")).toBe(true);
    if (!res.ok) return;

    const mainSource = res.files["src/index.ts"];
    expect(mainSource).toBeDefined();
    expect(mainSource).toContain('import { oidcMiddleware } from "@poc/oidc-verify";');
    expect(mainSource).toContain('app.use("/api/*", oidcMiddleware);');
  });

  test("AC3: H6-style denial suite passes using bearer OIDC tokens instead of x-test-user", async () => {
    const db = env.DB as D1Like;

    // Reset database schema
    for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "mw_members", "mw_workspaces"]) {
      await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }

    // Apply migrations from catalog for multi-workspace and credit-wallet
    for (const brickId of ["multi-workspace", "credit-wallet"]) {
      const brick = catalog.bricks[brickId]!;
      for (const mig of brick.manifest.migrations) {
        const sql = brick.files[mig]!;
        await applyMigration(db, sql);
      }
    }

    const keyPair = await generateRsaKeyPair();
    const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as {
      kid?: string;
      use?: string;
      alg?: string;
      [k: string]: unknown;
    };
    publicJwk.kid = "test-oidc-key";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const issuer = "https://auth.company.com";
    const jwksUri = `${issuer}/jwks.json`;

    const fetcher = async (): Promise<Response> => {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      });
    };

    // Construct the assembled application pipeline matching brick guard paths
    const app = new Hono<{ Bindings: { DB: D1Like } }>();
    app.use(
      "/api/*",
      createOidcMiddleware(
        {
          issuer,
          audience: "oidc-app",
          jwksUri,
          algorithms: ["RS256"],
        },
        { fetcher },
      ),
    );
    app.use("/api/wallet", workspaceMiddleware as any);
    app.use("/api/wallet/*", workspaceMiddleware as any);
    app.use("/api/payments/*", workspaceMiddleware as any);
    app.route("/api", createWorkspaceRoutes() as any);
    app.route("/api", createWalletRoutes({ creditsPerUnit: 1, minOrderAmount: 1 } as any) as any);

    // Helpers to create signed bearer tokens
    const nowSec = Math.floor(Date.now() / 1000);
    const createToken = async (userId: string, expOffset = 3600) => {
      return await signJwt(
        { alg: "RS256", kid: "test-oidc-key" },
        {
          iss: issuer,
          aud: "oidc-app",
          sub: userId,
          exp: nowSec + expOffset,
        },
        keyPair.privateKey,
      );
    };

    const aliceToken = await createToken("alice");
    const bobToken = await createToken("bob");
    const malloryToken = await createToken("mallory");
    const expiredAliceToken = await createToken("alice", -600);

    const call = async (
      path: string,
      token: string | null,
      workspaceId: string | null,
      body?: unknown,
    ): Promise<{ status: number; body: any }> => {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      if (workspaceId) headers["x-workspace-id"] = workspaceId;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const res = await app.fetch(
        new Request(`http://localhost${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers,
          body: body === undefined ? null : JSON.stringify(body),
        }),
        { DB: db },
      );

      const resBody = await res.json().catch(() => null);
      return { status: res.status, body: resBody };
    };

    // Setup world: Alice creates workspace A, Bob creates workspace B
    const createResA = await call("/api/workspaces", aliceToken, null, { name: "Workspace A" });
    expect(createResA.status).toBe(201);
    const wsA = createResA.body.workspace.id as string;

    const createResB = await call("/api/workspaces", bobToken, null, { name: "Workspace B" });
    expect(createResB.status).toBe(201);
    const wsB = createResB.body.workspace.id as string;

    // Open wallets
    await call("/api/wallet", aliceToken, wsA);
    await call("/api/wallet", bobToken, wsB);

    // Seed balances
    await db.prepare("UPDATE credit_wallets SET balance_milli = 100000 WHERE workspace_id = ?").bind(wsA).run();
    await db.prepare("UPDATE credit_wallets SET balance_milli = 50000 WHERE workspace_id = ?").bind(wsB).run();

    // 1. Unauthenticated request without bearer token -> 401
    const unauthRes = await call("/api/wallet", null, wsA);
    expect(unauthRes.status).toBe(401);

    // 2. Expired bearer token -> 401
    const expiredRes = await call("/api/wallet", expiredAliceToken, wsA);
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.body?.error).toBe("token_expired");

    // 3. Alice can read her own workspace wallet
    const aliceOwnRes = await call("/api/wallet", aliceToken, wsA);
    expect(aliceOwnRes.status).toBe(200);
    expect(aliceOwnRes.body?.currentBalance).toBe(100);

    // 4. Alice attacking Bob's workspace wallet -> 403 Forbidden
    const aliceAttackRes = await call("/api/wallet", aliceToken, wsB);
    expect(aliceAttackRes.status).toBe(403);

    // 5. Alice trying to deduct from Bob's wallet -> 403 Forbidden, Bob's balance intact
    const deductAttackRes = await call("/api/wallet/deduct", aliceToken, wsB, { amount: 20 });
    expect(deductAttackRes.status).toBe(403);
    const bobBal = await db
      .prepare("SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?")
      .bind(wsB)
      .first<{ balance_milli: number }>();
    expect(bobBal?.balance_milli).toBe(50_000);

    // 6. Mallory (stranger with valid token but no memberships) attacked both -> 403 Forbidden
    expect((await call("/api/wallet", malloryToken, wsA)).status).toBe(403);
    expect((await call("/api/wallet", malloryToken, wsB)).status).toBe(403);
  });
});
