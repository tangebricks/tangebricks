import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_search_faceted.sql?raw";
import { FacetedSearchService, createSearchRoutes } from "../src/index.ts";
import type { SearchEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_search_alpha";
const WS_BETA = "ws_search_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS search_fts").run();
  await db.prepare("DROP TABLE IF EXISTS search_documents").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Faceted Full-Text Search Core Logic", () => {
  it("indexes documents and performs full-text search with stemming and snippets", async () => {
    const service = new FacetedSearchService(db);

    await service.indexDocument(
      WS_ALPHA,
      "article",
      "art_1",
      "Getting Started with Cloudflare Workers",
      "Deploy scalable serverless edge applications running worldwide within milliseconds.",
      { category: "engineering", status: "published" },
    );

    await service.indexDocument(
      WS_ALPHA,
      "article",
      "art_2",
      "Advanced D1 Database Optimization",
      "Optimize SQLite queries and manage relational tables on edge infrastructure.",
      { category: "database", status: "published" },
    );

    // Search query: "serverless application"
    const res = await service.search(WS_ALPHA, "serverless application");

    expect(res.total).toBe(1);
    expect(res.results[0]?.title).toBe("Getting Started with Cloudflare Workers");
    expect(res.results[0]?.snippet).toContain("serverless");
    expect(res.results[0]?.facets).toEqual({ category: "engineering", status: "published" });

    // Verify dynamic facets distribution
    expect(res.facets["category"]).toBeDefined();
    expect(res.facets["category"]?.[0]?.value).toBe("engineering");
    expect(res.facets["category"]?.[0]?.count).toBe(1);
  });

  it("calculates multi-value facet distributions and filters by facets", async () => {
    const service = new FacetedSearchService(db);

    // Index 3 products
    await service.indexDocument(WS_ALPHA, "product", "p1", "MacBook Pro M3", "High performance laptop", { category: "laptops", brand: "Apple" });
    await service.indexDocument(WS_ALPHA, "product", "p2", "Dell XPS 15", "Ultra portable laptop", { category: "laptops", brand: "Dell" });
    await service.indexDocument(WS_ALPHA, "product", "p3", "iPad Air", "Portable tablet device", { category: "tablets", brand: "Apple" });

    // Search "laptop" without facet filter -> matches p1 and p2
    const allLaptops = await service.search(WS_ALPHA, "laptop");
    expect(allLaptops.total).toBe(2);
    expect(allLaptops.facets["brand"]).toEqual([
      { value: "Apple", count: 1 },
      { value: "Dell", count: 1 },
    ]);

    // Search "laptop" filtered by brand = "Apple" -> matches only p1
    const appleLaptops = await service.search(WS_ALPHA, "laptop", {
      facetFilters: { brand: "Apple" },
    });
    expect(appleLaptops.total).toBe(1);
    expect(appleLaptops.results[0]?.title).toBe("MacBook Pro M3");
  });

  it("provides typeahead autocomplete suggestions", async () => {
    const service = new FacetedSearchService(db);
    await service.indexDocument(WS_ALPHA, "customer", "c1", "Acme Corporation", "Enterprise customer");
    await service.indexDocument(WS_ALPHA, "customer", "c2", "Action Sports Ltd", "Retail customer");
    await service.indexDocument(WS_ALPHA, "customer", "c3", "Wayne Enterprises", "Gotham customer");

    const suggestions = await service.typeahead(WS_ALPHA, "Ac");
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.title)).toEqual(["Acme Corporation", "Action Sports Ltd"]);
  });

  it("deletes documents from both FTS and storage", async () => {
    const service = new FacetedSearchService(db);
    await service.indexDocument(WS_ALPHA, "doc", "d1", "Secret Protocol", "Classified text");

    expect((await service.search(WS_ALPHA, "Protocol")).total).toBe(1);

    const deleted = await service.deleteDocument(WS_ALPHA, "doc", "d1");
    expect(deleted).toBe(true);

    expect((await service.search(WS_ALPHA, "Protocol")).total).toBe(0);
  });

  it("strictly isolates search documents between workspaces", async () => {
    const service = new FacetedSearchService(db);
    await service.indexDocument(WS_ALPHA, "note", "n1", "Quarterly Alpha Notes", "Confidential to Alpha");
    await service.indexDocument(WS_BETA, "note", "n2", "Quarterly Beta Notes", "Confidential to Beta");

    const alphaRes = await service.search(WS_ALPHA, "Quarterly");
    const betaRes = await service.search(WS_BETA, "Quarterly");

    expect(alphaRes.total).toBe(1);
    expect(alphaRes.results[0]?.title).toBe("Quarterly Alpha Notes");
    expect(betaRes.total).toBe(1);
    expect(betaRes.results[0]?.title).toBe("Quarterly Beta Notes");
  });
});

describe("Faceted Search HTTP API", () => {
  it("provides full HTTP workflow for indexing, searching, and typeahead", async () => {
    const app = new Hono<SearchEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createSearchRoutes());

    // 1. POST /search/index
    const idxRes = await app.request(
      "/api/search/index",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          entityType: "kb",
          entityId: "kb_101",
          title: "How to configure Webhooks",
          body: "Navigate to developer settings and add your endpoint URL with HMAC secret.",
          facets: { topic: "developer" },
        }),
      },
      { DB: db },
    );
    expect(idxRes.status).toBe(201);

    // 2. GET /search?q=configure
    const searchRes = await app.request("/api/search?q=configure", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as { total: number; results: Array<{ title: string }> };
    expect(searchJson.total).toBe(1);
    expect(searchJson.results[0]?.title).toBe("How to configure Webhooks");

    // 3. GET /search/typeahead?prefix=How
    const suggRes = await app.request("/api/search/typeahead?prefix=How", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(suggRes.status).toBe(200);
    const suggJson = (await suggRes.json()) as { suggestions: Array<{ title: string }> };
    expect(suggJson.suggestions).toHaveLength(1);
    expect(suggJson.suggestions[0]?.title).toBe("How to configure Webhooks");

    // 4. DELETE /search/index/kb/kb_101
    const delRes = await app.request(
      "/api/search/index/kb/kb_101",
      {
        method: "DELETE",
        headers: { "x-workspace-id": WS_ALPHA },
      },
      { DB: db },
    );
    expect(delRes.status).toBe(200);
  });
});
