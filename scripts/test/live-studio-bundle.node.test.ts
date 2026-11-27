import { afterAll, describe, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createStudioApiApp, deriveWorkerAccessKey } from "../../apps/studio-api/src/index.ts";
import { createFakeCloudflare } from "../../packages/deploy/test/support/fake-cloudflare.ts";
import { KEY_HEADER } from "../../packages/deploy/src/worker/gate.ts";
import { LIVE_PROOF_BRICK_SECRETS, coreAuthProofOps, liveProofOps, nodeBundler } from "../live-studio-deploy.ts";
import { createNodeStudioEnv } from "../lib/studio-node-env.ts";
import { applyMigration } from "../../packages/sdk/src/index.ts";
import type { D1Like } from "../../packages/sdk/src/index.ts";
import { migrationsFrom } from "../../packages/deploy/src/provisioner/index.ts";

// Story R53, second review: the live script's REAL bundling path, offline. Studio assembles the live proof's blueprint (with
// oidc-verify identity), the live command's own bundler (nodeBundler: esbuild through bundleWorker) builds the Worker Studio uploads,
// and that exact text is started in a local workerd (Miniflare) and asked /healthz with and without the access key. Cloudflare
// is the fake; nothing here reaches the network.

const TOKEN = "cfut_R53BundleTokengggggggggggggggggggggggggggggggggggg";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ROOT = "bundle-root-secret-0123456789abcdef";
let mf: Miniflare | undefined;
let authMf: Miniflare | undefined;
afterAll(async () => {
  await mf?.dispose();
  await authMf?.dispose();
});

describe("the live script's real bundle", () => {
  test(
    "Studio's assembled files for the live blueprint bundle with esbuild, and the bundle answers /healthz behind the key in workerd",
    { timeout: 300_000 },
    async () => {
      const fake = createFakeCloudflare({
        token: TOKEN,
        accountId: ACCOUNT,
        tokenGroups: ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Queues Write"],
      });
      const built: Array<{ envName: string; code: string; bytes?: number; gzipBytes?: number }> = [];
      const app = createStudioApiApp({
        deploy: {
          fetch: fake.fetch,
          workerFetch: fake.fetch,
          sleep: async () => {},
          bundle: async (input) => {
            const bundle = await nodeBundler(input);
            built.push({ envName: input.envName, code: bundle.code, bytes: bundle.bytes, gzipBytes: bundle.gzipBytes });
            return bundle;
          },
        },
      });
      const studio = createNodeStudioEnv({ rootSecret: ROOT });
      try {
        const call = async (path: string, body: unknown, session?: string, orgId?: string) => {
          const res = await app.fetch(
            new Request(`https://studio.local${path}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(session ? { authorization: `Bearer ${session}` } : {}),
                ...(orgId ? { "x-org-id": orgId } : {}),
              },
              body: JSON.stringify(body),
            }),
            studio.env,
          );
          const text = await res.text();
          return { status: res.status, text, body: JSON.parse(text || "{}") as Record<string, unknown> };
        };
        const session = String((await call("/api/auth/signup", { email: "bundle@r53.test", password: "Password12345!", name: "B" })).body.token);
        const orgId = String((await call("/api/orgs", { name: "R53 B", slug: "r53-b" }, session)).body.id);
        const project = "tangebricks-test-0b0b0b0b";
        await call(`/api/orgs/${orgId}/projects`, { project }, session);
        expect(
          (await call(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: TOKEN, accountId: ACCOUNT, projectId: project }, session)).status,
        ).toBe(201);
        const ops = await call(`/api/projects/${project}/ops`, { summary: "live blueprint", ops: liveProofOps() }, session, orgId);
        expect(ops.status, ops.text.slice(0, 800)).toBe(200);
        for (const name of LIVE_PROOF_BRICK_SECRETS) {
          const sec = await call(
            `/api/projects/${project}/secrets`,
            {
              ref: `sec_${name.toLowerCase()}`,
              kind: "brick_secret",
              label: name,
              appOrBrick: "core-auth",
              value: `offline-${name.toLowerCase()}-0123456789`,
              bindTarget: { targetKind: "brick", targetId: "core-auth", secretName: name },
            },
            session,
            orgId,
          );
          expect(sec.status).toBe(200);
        }
        const dep = await call(`/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
        expect(dep.status, dep.text.slice(0, 600)).toBe(200);
        expect(built).toHaveLength(1);
        const bundle = built[0]!;
        console.log(
          `live proof bundle (preview, oidc-verify identity): ${((bundle.bytes ?? 0) / 1024).toFixed(1)} KiB, gzip ${((bundle.gzipBytes ?? 0) / 1024).toFixed(1)} KiB`,
        );
        expect(bundle.bytes).toBeGreaterThan(0);
        expect(bundle.code).toContain("GraphRunner");
        expect(fake.codeOf(`px-${project}-preview`)).toBe(bundle.code); // what Studio uploaded is exactly this bundle
        // story 1.19: no node:* import, so the upload metadata carries no compatibility flags, exactly as before
        expect(bundle.code).not.toMatch(/from "node:/);
        expect(fake.metadataOf(`px-${project}-preview`)).not.toHaveProperty("compatibility_flags");

        // the same text in a real workerd, with the bindings the upload gives it (D1, the derived access key, the environment)
        const accessKey = await deriveWorkerAccessKey(ROOT, project, "preview");
        mf = new Miniflare(
          convertV4MiniflareOptions({
            modules: true,
            script: bundle.code,
            compatibilityDate: "2026-10-01",
            d1Databases: ["DB"],
            bindings: { POC_ACCESS_KEY: accessKey, PX_ENVIRONMENT: "preview", PX_PROJECT_ID: project },
          }),
        );
        await mf.ready;
        const withKey = (await mf.dispatchFetch("http://deployed.invalid/healthz", { headers: { [KEY_HEADER]: accessKey } })) as unknown as Response;
        expect(withKey.status, await withKey.clone().text()).toBe(200);
        const without = (await mf.dispatchFetch("http://deployed.invalid/healthz")) as unknown as Response;
        expect(without.status).toBe(401);
      } finally {
        studio.close();
      }
    },
  );

  test(
    "story 1.19: a core-auth blueprint bundles (node:* external), uploads with nodejs_compat and the generated secret, and email sign-up then sign-in work in workerd",
    { timeout: 300_000 },
    async () => {
      const fake = createFakeCloudflare({
        token: TOKEN,
        accountId: ACCOUNT,
        tokenGroups: ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Queues Write"],
      });
      const built: Array<{ code: string; compatibilityFlags?: string[] }> = [];
      let files: Record<string, string> | null = null;
      const app = createStudioApiApp({
        deploy: {
          fetch: fake.fetch,
          workerFetch: fake.fetch,
          sleep: async () => {},
          bundle: async (input) => {
            files = input.files;
            const bundle = await nodeBundler(input);
            built.push(bundle);
            return bundle;
          },
        },
      });
      const studio = createNodeStudioEnv({ rootSecret: ROOT });
      const project = "tangebricks-test-0d0d0d0d";
      try {
        const call = async (path: string, body: unknown, session?: string, orgId?: string) => {
          const res = await app.fetch(
            new Request(`https://studio.local${path}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(session ? { authorization: `Bearer ${session}` } : {}),
                ...(orgId ? { "x-org-id": orgId } : {}),
              },
              body: JSON.stringify(body),
            }),
            studio.env,
          );
          const text = await res.text();
          return { status: res.status, text, body: JSON.parse(text || "{}") as Record<string, unknown> };
        };
        const session = String((await call("/api/auth/signup", { email: "core-auth@s119.test", password: "Password12345!", name: "C" })).body.token);
        const orgId = String((await call("/api/orgs", { name: "S119", slug: "s119-c" }, session)).body.id);
        await call(`/api/orgs/${orgId}/projects`, { project }, session);
        expect(
          (await call(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, { token: TOKEN, accountId: ACCOUNT, projectId: project }, session)).status,
        ).toBe(201);
        const ops = await call(`/api/projects/${project}/ops`, { summary: "core-auth blueprint", ops: coreAuthProofOps() }, session, orgId);
        expect(ops.status, ops.text.slice(0, 800)).toBe(200);
        // nobody stores a secret: the session deploy generates BETTER_AUTH_SECRET, and GitHub is optional
        const dep = await call(`/api/projects/${project}/environments/preview/deploy`, {}, session, orgId);
        expect(dep.status, dep.text.slice(0, 600)).toBe(200);
      } finally {
        studio.close();
      }
      expect(built).toHaveLength(1);
      const bundle = built[0]!;
      expect(bundle.code).toMatch(/from "node:crypto"/);
      expect(bundle.compatibilityFlags).toEqual(["nodejs_compat"]);
      const script = `px-${project}-preview`;
      expect(fake.codeOf(script)).toBe(bundle.code);
      expect(fake.metadataOf(script)).toMatchObject({ compatibility_flags: ["nodejs_compat"] });
      const authSecret = fake.secretOf(script, "BETTER_AUTH_SECRET");
      expect(authSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fake.secretOf(script, "GITHUB_CLIENT_ID")).toBeUndefined();

      // the uploaded text in a real workerd with nodejs_compat and the bindings the upload gave it
      const accessKey = await deriveWorkerAccessKey(ROOT, project, "preview");
      authMf = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: bundle.code,
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: { POC_ACCESS_KEY: accessKey, PX_ENVIRONMENT: "preview", PX_PROJECT_ID: project, BETTER_AUTH_SECRET: authSecret! },
        } as never),
      );
      await authMf.ready;
      const db = (await authMf.getD1Database("DB")) as unknown as D1Like;
      for (const m of migrationsFrom(files!)) await applyMigration(db, m.sql);
      const post = async (path: string, body: unknown) =>
        (await authMf!.dispatchFetch(`http://deployed.invalid${path}`, {
          method: "POST",
          headers: { [KEY_HEADER]: accessKey, "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", origin: "http://deployed.invalid" },
          body: JSON.stringify(body),
        } as never)) as unknown as Response;
      const signUp = await post("/api/auth/sign-up/email", { email: "user@s119.test", password: "correct-horse-battery-staple", name: "User" });
      expect(signUp.status, await signUp.clone().text()).toBe(200);
      const signIn = await post("/api/auth/sign-in/email", { email: "user@s119.test", password: "correct-horse-battery-staple" });
      expect(signIn.status, await signIn.clone().text()).toBe(200);
      expect(((await signIn.json()) as { user: { email: string } }).user.email).toBe("user@s119.test");
      const wrong = await post("/api/auth/sign-in/email", { email: "user@s119.test", password: "not-the-password" });
      expect(wrong.status).toBe(401);
    },
  );
});
