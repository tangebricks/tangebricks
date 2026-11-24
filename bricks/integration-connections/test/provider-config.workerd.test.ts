import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migrationSql from "../migrations/0001_integration_connections.sql?raw";
import {
  createIntegrationConnectionsRoutes,
  resolveProviderConfig,
  IntegrationConnectionsError,
} from "../src/index.ts";
import type { IntegrationConnectionsEnv } from "../src/index.ts";

function createTestApp(options: Parameters<typeof createIntegrationConnectionsRoutes>[0] = {}) {
  const app = new Hono<IntegrationConnectionsEnv>();
  app.use("/api/*", async (c, next) => {
    const uid = c.req.header("x-test-user") ?? "test-user-1";
    const wsId = c.req.header("x-workspace-id") ?? "test-ws-1";
    c.set("user", { uid });
    c.set("workspace", { id: wsId, role: "owner", suspended: false });
    c.set("ctx", Object.freeze({ userId: uid, workspaceId: wsId, role: "owner" }));
    await next();
  });
  app.route("/api", createIntegrationConnectionsRoutes(options));
  return app;
}

describe("Story UC1.6 / Finding F-SEC-5 — OAuth provider config and manifest resolution", () => {
  const db = (env as unknown as { DB: D1Like }).DB;
  const pxConnKey = "uc16-test-master-conn-key";

  beforeEach(async () => {
    await applyMigration(db, migrationSql);
    await db.prepare("DELETE FROM int_connections").run();
    await db.prepare("DELETE FROM int_oauth_states").run();
  });

  describe("Task 1(a): resolveProviderConfig from integration manifest", () => {
    it("returns manifest authorizeUrl and tokenUrl for discord instead of discord.example.com", () => {
      const cfg = resolveProviderConfig("discord", { integrations: catalog.integrations });
      expect(cfg.authorizeUrl).toBe("https://discord.com/oauth2/authorize");
      expect(cfg.tokenUrl).toBe("https://discord.com/api/oauth2/token");
      expect(cfg.defaultScopes).toEqual(["bot", "identify", "guilds"]);
    });
  });

  describe("Task 1(b): unknown provider throws OAUTH_PROVIDER_UNKNOWN", () => {
    it("throws OAUTH_PROVIDER_UNKNOWN when resolving acme", () => {
      expect(() => resolveProviderConfig("acme")).toThrowError(
        expect.objectContaining({
          code: "OAUTH_PROVIDER_UNKNOWN",
          status: 404,
        }),
      );
    });
  });

  describe("Task 1(c) & AC3: unknown provider start route returns HTTP 404", () => {
    it("returns 404 with OAUTH_PROVIDER_UNKNOWN error before any redirect or state row is written", async () => {
      const app = createTestApp();
      const res = await app.fetch(
        new Request("https://app.example.test/api/integrations/acme/connect"),
        { DB: db, PX_CONN_KEY: pxConnKey },
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe("OAUTH_PROVIDER_UNKNOWN");

      // Verify no state row was written into DB
      const stateCount = await db
        .prepare("SELECT count(*) as cnt FROM int_oauth_states")
        .first<{ cnt: number }>();
      expect(stateCount?.cnt).toBe(0);
    });
  });

  describe("AC2: parametrized test over catalog integrations with auth.type: 'oauth2'", () => {
    const oauthIntegrations = Object.entries(catalog.integrations ?? {}).filter(
      ([, entry]) => entry.manifest.auth?.type === "oauth2",
    );

    it.each(oauthIntegrations)(
      "resolves exact manifest URLs for %s",
      (slug, entry) => {
        const manifestAuth = entry.manifest.auth;
        if (manifestAuth?.type !== "oauth2") return;

        const cfg = resolveProviderConfig(slug);
        expect(cfg.authorizeUrl).toBe(manifestAuth.authorizeUrl);
        expect(cfg.tokenUrl).toBe(manifestAuth.tokenUrl);
        expect(cfg.defaultScopes).toEqual(manifestAuth.scopes ?? []);
      },
    );
  });

  describe("URL validation and host restrictions", () => {
    it("rejects non-https URLs in operator config with INVALID_OAUTH_URL", () => {
      expect(() =>
        resolveProviderConfig("insecure", {
          providers: {
            insecure: {
              authorizeUrl: "http://auth.insecure.com/oauth/authorize",
              tokenUrl: "https://auth.insecure.com/oauth/token",
            },
          },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_OAUTH_URL",
        }),
      );
    });

    it("rejects forbidden host (localhost / loopback / private IP) in operator config with FORBIDDEN_OAUTH_HOST", () => {
      expect(() =>
        resolveProviderConfig("evil-local", {
          providers: {
            "evil-local": {
              authorizeUrl: "https://127.0.0.1/oauth/authorize",
              tokenUrl: "https://127.0.0.1/oauth/token",
            },
          },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "FORBIDDEN_OAUTH_HOST",
        }),
      );

      expect(() =>
        resolveProviderConfig("evil-metadata", {
          providers: {
            "evil-metadata": {
              authorizeUrl: "https://169.254.169.254/oauth/authorize",
              tokenUrl: "https://169.254.169.254/oauth/token",
            },
          },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "FORBIDDEN_OAUTH_HOST",
        }),
      );
    });

    it("allows explicit operator config with valid https URLs for unmanifested providers (e.g. notion)", () => {
      const cfg = resolveProviderConfig("notion", {
        providers: {
          notion: {
            displayName: "Notion Custom",
            authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
            tokenUrl: "https://api.notion.com/v1/oauth/token",
            defaultScopes: ["read_content"],
          },
        },
      });

      expect(cfg.authorizeUrl).toBe("https://api.notion.com/v1/oauth/authorize");
      expect(cfg.tokenUrl).toBe("https://api.notion.com/v1/oauth/token");
      expect(cfg.displayName).toBe("Notion Custom");
      expect(cfg.defaultScopes).toEqual(["read_content"]);
    });
  });
});
