import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  assemble,
  computeBuildHash,
  computeCodeHash,
  computeGraphHash,
  generateOpenApiSpec,
  hashFiles,
} from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";
import aiCreditsPreset from "../../../presets/ai-credits-saas.blueprint.json";
import b2bWorkspacePreset from "../../../presets/b2b-workspace-app.blueprint.json";
import marketplacePreset from "../../../presets/marketplace.blueprint.json";
import studioApiApp from "../../../apps/studio-api/src/index.ts";

interface WorkerFetcher {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
  routes?: Array<{ path: string; method: string }>;
}

const emittedEntries = import.meta.glob("../../../out/*/src/index.ts", {
  eager: true,
}) as Record<string, { default: WorkerFetcher }>;
const emittedSpecs = import.meta.glob("../../../out/*/openapi.json", {
  eager: true,
}) as Record<string, { default: Record<string, unknown> }>;

function getEmittedWorker(project: string): WorkerFetcher {
  const mod = emittedEntries[`../../../out/${project}/src/index.ts`];
  if (!mod?.default) {
    throw new Error(`Missing emitted worker for ${project}`);
  }
  return mod.default;
}

function getEmittedOpenApi(project: string): Record<string, unknown> {
  const mod = emittedSpecs[`../../../out/${project}/openapi.json`];
  if (!mod?.default) {
    throw new Error(`Missing emitted openapi.json for ${project}`);
  }
  return mod.default;
}

describe("Story 10.5 — Outbound OpenAPI 3.1.0 spec generation and /openapi.json publishing", () => {
  test("AC 1: assembling the 3 CP0 presets and custom entity + webhook blueprints emits valid OpenAPI 3.1.0 specs", () => {
    for (const preset of [aiCreditsPreset, b2bWorkspacePreset, marketplacePreset]) {
      const res = assemble(preset, catalog);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;

      expect(res.files["openapi.json"]).toBeDefined();
      const spec = JSON.parse(res.files["openapi.json"]!) as {
        openapi: string;
        info: { title: string; version: string };
        paths: Record<string, Record<string, unknown>>;
        components: {
          schemas: Record<string, Record<string, unknown>>;
          securitySchemes: Record<string, Record<string, unknown>>;
        };
      };

      expect(spec.openapi).toBe("3.1.0");
      expect(spec.info.title).toBe(preset.project);
      expect(spec.components.securitySchemes.BearerAuth).toEqual({
        description: "Bearer token authentication",
        scheme: "bearer",
        type: "http",
      });
      expect(spec.components.securitySchemes.SessionCookie).toEqual({
        description: "Session cookie authentication",
        in: "cookie",
        name: "px_session",
        type: "apiKey",
      });
      expect(spec.components.securitySchemes.WorkspaceHeader).toEqual({
        description: "Active workspace identifier header",
        in: "header",
        name: "X-Workspace-Id",
        type: "apiKey",
      });

      // Every enabled brick's routePrefixes must appear in paths with tags and x-px-brick
      for (const brickEntry of preset.bricks as Array<string | { id: string }>) {
        const brickId = typeof brickEntry === "string" ? brickEntry : brickEntry.id;
        const manifest = catalog.bricks[brickId]!.manifest;
        for (const prefix of manifest.routePrefixes) {
          const routePath = `/api/${prefix}`;
          expect(spec.paths[routePath]).toBeDefined();
          expect(spec.paths[routePath]!["x-px-brick"]).toBe(brickId);
        }
      }
    }

    // Custom blueprint with declared entities and webhook trigger
    const customBlueprint = {
      project: "crm-webhooks",
      bricks: ["multi-workspace", "dynamic-entities", "webhook-gateway"],
      entities: [
        {
          name: "customers",
          fields: [
            { name: "email", type: "text", required: true, maxLength: 320 },
            { name: "lifetime_value", type: "number", required: false, min: 0 },
            { name: "vip", type: "boolean", required: true },
            { name: "tier", type: "enum", required: true, values: ["free", "pro", "enterprise"] },
          ],
        },
      ],
      workflows: [
        {
          id: "wf_inbound_stripe",
          name: "Inbound Stripe Webhook",
          trigger: { kind: "webhook", path: "/webhooks/stripe" },
          nodes: [
            {
              id: "trigger_1",
              type: "int:stripe.payment_intent_succeeded",
              role: "trigger",
              data: {},
            },
          ],
          edges: [],
        },
      ],
    };

    const customRes = assemble(customBlueprint, catalog);
    expect(customRes.ok).toBe(true);
    if (!customRes.ok) return;

    const customSpec = JSON.parse(customRes.files["openapi.json"]!) as ReturnType<typeof generateOpenApiSpec>;
    expect(customSpec.openapi).toBe("3.1.0");
    expect(customSpec.components.schemas.Customers).toBeDefined();
    expect(customSpec.components.schemas.CustomersCreate).toBeDefined();
    expect(customSpec.components.schemas.CustomersUpdate).toBeDefined();

    // Entity CRUD paths
    expect(customSpec.paths["/api/customers"]).toBeDefined();
    expect(customSpec.paths["/api/customers"]!.get).toBeDefined();
    expect(customSpec.paths["/api/customers"]!.post).toBeDefined();
    expect(customSpec.paths["/api/customers/{id}"]).toBeDefined();
    expect(customSpec.paths["/api/customers/{id}"]!.get).toBeDefined();
    expect(customSpec.paths["/api/customers/{id}"]!.patch).toBeDefined();
    expect(customSpec.paths["/api/customers/{id}"]!.delete).toBeDefined();

    // Inbound webhook endpoint
    const webhookPath = customSpec.paths["/api/webhooks/in/{subscriptionId}"];
    expect(webhookPath).toBeDefined();
    expect(webhookPath!.post).toBeDefined();
    const postOp = webhookPath!.post as { parameters: Array<{ name: string; in: string }> };
    expect(postOp.parameters.some((p) => p.name === "subscriptionId" && p.in === "path")).toBe(true);
    expect(postOp.parameters.some((p) => p.name === "X-Hub-Signature-256" && p.in === "header")).toBe(true);
    expect(postOp.parameters.some((p) => p.name === "Stripe-Signature" && p.in === "header")).toBe(true);
  });

  test("AC 1 & 4: assembling twice produces byte-identical openapi.json and identical buildHash", async () => {
    const bpA = {
      project: "deterministic-openapi",
      bricks: ["credit-wallet", "dynamic-entities", "multi-workspace"],
      entities: [
        {
          name: "orders",
          fields: [
            { name: "sku", type: "text", required: true },
            { name: "total_cents", type: "number", required: true, min: 0 },
          ],
        },
        {
          name: "accounts",
          fields: [{ name: "title", type: "text", required: true }],
        },
      ],
    };

    const bpB = {
      project: "deterministic-openapi",
      bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"],
      entities: [
        {
          name: "accounts",
          fields: [{ name: "title", type: "text", required: true }],
        },
        {
          name: "orders",
          fields: [
            { name: "sku", type: "text", required: true },
            { name: "total_cents", type: "number", required: true, min: 0 },
          ],
        },
      ],
    };

    const first = assemble(bpA, catalog);
    const second = assemble(bpB, catalog);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.files["openapi.json"]).toBe(second.files["openapi.json"]);
    expect(await hashFiles(first.files)).toEqual(await hashFiles(second.files));
    const codeHashA = await computeCodeHash(first.files);
    const codeHashB = await computeCodeHash(second.files);
    const graphHash = await computeGraphHash([]);
    expect(await computeBuildHash({ codeHash: codeHashA, graphHash })).toBe(
      await computeBuildHash({ codeHash: codeHashB, graphHash }),
    );
  });

  test("AC 2 & 3: booted Worker in workerd serves GET /openapi.json with 200, Cache-Control, and 100% route prefix coverage", async () => {
    const cases: Array<{
      name: string;
      worker: WorkerFetcher;
      expectedSpec: Record<string, unknown>;
      blueprint: { bricks: Array<string | { id: string }>; entities?: Array<{ name: string }> };
    }> = [
      {
        name: "two-brick",
        worker: getEmittedWorker("two-brick"),
        expectedSpec: getEmittedOpenApi("two-brick"),
        blueprint: { bricks: ["multi-workspace", "credit-wallet"] },
      },
      {
        name: "invoice-flow",
        worker: getEmittedWorker("invoice-flow"),
        expectedSpec: getEmittedOpenApi("invoice-flow"),
        blueprint: {
          bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"],
          entities: [{ name: "invoices" }],
        },
      },
      {
        name: "ai-credits-saas",
        worker: getEmittedWorker("ai-credits-saas"),
        expectedSpec: getEmittedOpenApi("ai-credits-saas"),
        blueprint: aiCreditsPreset as { bricks: Array<string | { id: string }> },
      },
      {
        name: "b2b-workspace-app",
        worker: getEmittedWorker("b2b-workspace-app"),
        expectedSpec: getEmittedOpenApi("b2b-workspace-app"),
        blueprint: b2bWorkspacePreset as { bricks: Array<string | { id: string }> },
      },
      {
        name: "marketplace",
        worker: getEmittedWorker("marketplace"),
        expectedSpec: getEmittedOpenApi("marketplace"),
        blueprint: marketplacePreset as { bricks: Array<string | { id: string }> },
      },
    ];

    for (const item of cases) {
      const res = await item.worker.fetch(new Request("https://worker.local/openapi.json"), env);
      expect(res.status, `${item.name} GET /openapi.json status`).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");

      const body = (await res.json()) as {
        openapi: string;
        paths: Record<string, unknown>;
      };
      expect(body).toEqual(item.expectedSpec);
      expect(body.openapi).toBe("3.1.0");

      // Verify every route prefix mounted by the blueprint's bricks and entities is in openapi.json.paths
      for (const b of item.blueprint.bricks) {
        const brickId = typeof b === "string" ? b : b.id;
        const manifest = catalog.bricks[brickId]!.manifest;
        for (const prefix of manifest.routePrefixes) {
          expect(body.paths[`/api/${prefix}`], `${item.name} missing /api/${prefix}`).toBeDefined();
        }
      }
      for (const ent of item.blueprint.entities ?? []) {
        expect(body.paths[`/api/${ent.name}`], `${item.name} missing /api/${ent.name}`).toBeDefined();
        expect(body.paths[`/api/${ent.name}/{id}`], `${item.name} missing /api/${ent.name}/{id}`).toBeDefined();
      }

      // If the worker is a plain Hono app with .routes, verify every mounted /api/<prefix> route is covered
      if (Array.isArray(item.worker.routes)) {
        const mountedApiPrefixes = new Set<string>();
        for (const r of item.worker.routes) {
          if (!r.path.startsWith("/api/")) continue;
          if (r.path === "/api/*") continue;
          const seg = r.path.split("/")[2];
          if (seg && seg !== "*") {
            mountedApiPrefixes.add(`/api/${seg}`);
          }
        }
        for (const prefixPath of mountedApiPrefixes) {
          expect(body.paths[prefixPath], `${item.name} Hono route prefix ${prefixPath}`).toBeDefined();
        }
      }
    }
  });

  test("AC 2: Studio API GET /api/projects/:project/openapi.json returns downloadable OpenAPI 3.1.0 spec", async () => {
    const testEnv = {
      ...(env as Record<string, unknown>),
      BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
      PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
    };
    const signUpRes = await studioApiApp.fetch(
      new Request("https://studio.local/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "OpenAPI Tester",
          email: "openapi-tester@example.com",
          password: "Password123!",
        }),
      }),
      testEnv as never,
    );
    const cookie = signUpRes.headers.get("set-cookie") ?? "";

    // Story 16: a read of a project with no row is 404, so the tester creates the project (in their own org) first.
    const createRes = await studioApiApp.fetch(
      new Request("https://studio.local/api/projects", {
        method: "POST",
        // Story 0.14: a cookie-authenticated write carries its (same) Origin, or the CSRF guard refuses it.
        headers: { cookie, origin: "https://studio.local", "content-type": "application/json" },
        body: JSON.stringify({ project: "invoice-flow" }),
      }),
      testEnv as never,
    );
    expect([200, 201]).toContain(createRes.status);

    const res = await studioApiApp.fetch(
      new Request("https://studio.local/api/projects/invoice-flow/openapi.json", {
        headers: {
          cookie,
        },
      }),
      testEnv as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain(
      'attachment; filename="invoice-flow-openapi.json"',
    );
    const spec = (await res.json()) as { openapi: string; info: { title: string } };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("invoice-flow");
  });
});
