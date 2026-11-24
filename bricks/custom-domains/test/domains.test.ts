import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_custom_domains.sql?raw";
import {
  CustomDomainService,
  isValidHostname,
  createCustomDomainRoutes,
} from "../src/index.ts";
import type { CustomDomainEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_dom_alpha";
const WS_BETA = "ws_dom_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS dom_domains").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Custom Domains Utility & Validation", () => {
  it("validates FQDN hostname syntax strictly", () => {
    expect(isValidHostname("app.customer.com")).toBe(true);
    expect(isValidHostname("shop.store.co.uk")).toBe(true);
    expect(isValidHostname("client-portal.sub.domain.org")).toBe(true);

    // Invalid hostnames
    expect(isValidHostname("192.168.1.1")).toBe(false);
    expect(isValidHostname("http://app.customer.com")).toBe(false);
    expect(isValidHostname("invalid_host_with_underscores.com")).toBe(false);
    expect(isValidHostname("")).toBe(false);
    expect(isValidHostname("localhost")).toBe(false);
  });
});

describe("Custom Domain Service Core", () => {
  it("registers domain, provides DNS instructions, and verifies SSL", async () => {
    const service = new CustomDomainService(db, "cname.ourplatform.app");

    // 1. Add first domain -> should automatically become primary
    const dom1 = await service.addDomain({
      workspaceId: WS_ALPHA,
      hostname: "portal.acme.com",
      verificationType: "cname",
    });

    expect(dom1.id).toMatch(/^dom_[a-f0-9]{32}$/);
    expect(dom1.is_primary).toBe(true);
    expect(dom1.dns_status).toBe("pending");
    expect(dom1.ssl_status).toBe("pending");
    expect(dom1.dns_instructions).toHaveLength(1);
    expect(dom1.dns_instructions[0]).toEqual({
      type: "CNAME",
      name: "portal.acme.com",
      value: "cname.ourplatform.app",
    });

    // 2. Add second domain as secondary
    const dom2 = await service.addDomain({
      workspaceId: WS_ALPHA,
      hostname: "store.acme.com",
      verificationType: "txt",
      isPrimary: false,
    });
    expect(dom2.is_primary).toBe(false);
    expect(dom2.dns_instructions).toHaveLength(2);

    // 3. Promote second domain to primary -> demotes first
    await service.setPrimaryDomain(WS_ALPHA, dom2.id);
    const updatedDom1 = await service.getDomain(WS_ALPHA, dom1.id);
    const updatedDom2 = await service.getDomain(WS_ALPHA, dom2.id);
    expect(updatedDom1!.is_primary).toBe(false);
    expect(updatedDom2!.is_primary).toBe(true);

    // 4. Verify domain -> transitions to verified and active SSL
    const verified = await service.verifyDomain(WS_ALPHA, dom1.id);
    expect(verified.dns_status).toBe("verified");
    expect(verified.ssl_status).toBe("active");
    expect(verified.verified_at).not.toBeNull();

    // 5. Hostname resolution for incoming HTTP edge routing
    const resolved = await service.resolveHostname("portal.acme.com");
    expect(resolved).not.toBeNull();
    expect(resolved!.workspaceId).toBe(WS_ALPHA);
    expect(resolved!.sslStatus).toBe("active");
  });

  it("rejects duplicate hostname registration across tenants", async () => {
    const service = new CustomDomainService(db);

    await service.addDomain({
      workspaceId: WS_ALPHA,
      hostname: "unique.saas.io",
    });

    await expect(
      service.addDomain({
        workspaceId: WS_BETA,
        hostname: "unique.saas.io",
      })
    ).rejects.toThrow("already registered");
  });

  it("enforces multi-tenant workspace isolation and domain deletion", async () => {
    const service = new CustomDomainService(db);

    const dom = await service.addDomain({
      workspaceId: WS_ALPHA,
      hostname: "alpha.client.com",
    });

    const betaList = await service.listDomains(WS_BETA);
    expect(betaList).toHaveLength(0);

    const crossGet = await service.getDomain(WS_BETA, dom.id);
    expect(crossGet).toBeNull();

    const crossDelete = await service.deleteDomain(WS_BETA, dom.id);
    expect(crossDelete).toBe(false);

    // Successful delete
    const deleted = await service.deleteDomain(WS_ALPHA, dom.id);
    expect(deleted).toBe(true);

    const afterDelete = await service.getDomain(WS_ALPHA, dom.id);
    expect(afterDelete).toBeNull();
  });
});

describe("Custom Domain REST API Endpoints", () => {
  function createApp(workspaceId: string = WS_ALPHA) {
    const app = new Hono<CustomDomainEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: workspaceId, role: "admin" });
      c.set("ctx", Object.freeze({ userId: "usr_domain_admin", workspaceId, role: "admin" }));
      c.set("user", { uid: "usr_domain_admin", name: "Domain Manager" });
      await next();
    });
    app.route("/", createCustomDomainRoutes());
    return app;
  }

  it("handles complete domain provisioning cycle via HTTP API", async () => {
    const app = createApp();

    // 1. Add domain
    const addRes = await app.request(
      "http://localhost/domains",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: "dashboard.bigcorp.com",
          verificationType: "cname",
        }),
      },
      { DB: db }
    );
    expect(addRes.status).toBe(201);
    const dom = (await addRes.json()) as any;
    expect(dom.id).toBeDefined();
    expect(dom.is_primary).toBe(true);

    // 2. List domains
    const listRes = await app.request(
      "http://localhost/domains",
      { method: "GET" },
      { DB: db }
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.domains).toHaveLength(1);

    // 3. Verify domain
    const verifyRes = await app.request(
      `http://localhost/domains/${dom.id}/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      { DB: db }
    );
    expect(verifyRes.status).toBe(200);
    const verifyJson = (await verifyRes.json()) as any;
    expect(verifyJson.ssl_status).toBe("active");

    // 4. Resolve domain
    const resolveRes = await app.request(
      "http://localhost/domains/resolve/dashboard.bigcorp.com",
      { method: "GET" },
      { DB: db }
    );
    expect(resolveRes.status).toBe(200);
    const resolveJson = (await resolveRes.json()) as any;
    expect(resolveJson.workspaceId).toBe(WS_ALPHA);

    // 5. Delete domain
    const delRes = await app.request(
      `http://localhost/domains/${dom.id}`,
      { method: "DELETE" },
      { DB: db }
    );
    expect(delRes.status).toBe(200);
  });

  it("returns 400 on malformed hostname and 404 on unrecognized domain", async () => {
    const app = createApp();

    const badReq = await app.request(
      "http://localhost/domains",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: "invalid:format:hostname" }),
      },
      { DB: db }
    );
    expect(badReq.status).toBe(400);

    const notFound = await app.request(
      "http://localhost/domains/resolve/unknown.domain.net",
      { method: "GET" },
      { DB: db }
    );
    expect(notFound.status).toBe(404);
  });
});
