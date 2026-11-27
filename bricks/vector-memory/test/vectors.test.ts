import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_vector_memory.sql?raw";
import { VectorMemoryService, cosineSimilarity, chunkText, createVectorRoutes } from "../src/index.ts";
import type { VectorEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_vec_alpha";
const WS_BETA = "ws_vec_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS vec_documents").run();
  await db.prepare("DROP TABLE IF EXISTS vec_indexes").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Vector Similarity & Chunking Math", () => {
  it("calculates exact cosine similarity values", () => {
    // Identical
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);

    // Orthogonal (perpendicular)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);

    // Opposite
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);

    // High similarity
    const high = cosineSimilarity([0.9, 0.1], [0.85, 0.15]);
    expect(high).toBeGreaterThan(0.95);
  });

  it("splits text into chunks respecting words and overlap", () => {
    const text = "ProjectX is an autonomous edge native engine for Cloudflare Workers. It provides 40 modular bricks for instant SaaS scaffolding.";
    const chunks = chunkText(text, 50, 10);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => {
      expect(c.length).toBeLessThanOrEqual(60);
    });
  });
});

describe("Vector Memory Service Core Logic", () => {
  it("creates index and rejects mismatched embedding dimensions", async () => {
    const service = new VectorMemoryService(db);
    const index = await service.createIndex(WS_ALPHA, "doc_embeddings", 3);

    expect(index.dimensions).toBe(3);

    // Attempting to upsert 2-dimensional vector should fail
    const failRes = await service.upsertChunks(WS_ALPHA, index.id, [{ text: "Too short", embedding: [0.1, 0.2] }]);
    expect(failRes.ok).toBe(false);
    expect(failRes.error).toContain("dimension mismatch");

    // Upserting 3-dimensional vector should succeed
    const okRes = await service.upsertChunks(WS_ALPHA, index.id, [{ text: "Exact length", embedding: [0.1, 0.2, 0.3] }]);
    expect(okRes.ok).toBe(true);
    expect(okRes.count).toBe(1);
  });

  it("indexes vectors and performs top-K ranked nearest neighbor search", async () => {
    const service = new VectorMemoryService(db);
    const index = await service.createIndex(WS_ALPHA, "knowledge_base", 3);

    // 3 documents:
    // A: oriented towards [1, 0, 0] (Billing)
    // B: oriented towards [0, 1, 0] (Auth)
    // C: oriented towards [0, 0, 1] (Webhooks)
    await service.upsertChunks(WS_ALPHA, index.id, [
      { text: "Invoices, taxes and subscriptions", embedding: [0.95, 0.05, 0.0], metadata: { topic: "billing" } },
      { text: "Passkeys, OAuth and session tokens", embedding: [0.05, 0.95, 0.0], metadata: { topic: "auth" } },
      { text: "HTTP callbacks and payload signatures", embedding: [0.0, 0.1, 0.9], metadata: { topic: "webhooks" } },
    ]);

    // Query for billing-oriented vector [1, 0, 0]
    const results = await service.search(WS_ALPHA, index.id, [1.0, 0.0, 0.0], 2);

    expect(results).toHaveLength(2);
    expect(results[0]?.text_content).toContain("Invoices");
    expect(results[0]?.score).toBeGreaterThan(0.9);
    expect(results[0]?.metadata).toEqual({ topic: "billing" });

    // Auth should be second
    expect(results[1]?.text_content).toContain("Passkeys");
  });

  it("strictly isolates vectors between workspaces", async () => {
    const service = new VectorMemoryService(db);
    const idxA = await service.createIndex(WS_ALPHA, "secrets_a", 2);
    const idxB = await service.createIndex(WS_BETA, "secrets_b", 2);

    await service.upsertChunks(WS_ALPHA, idxA.id, [{ text: "Alpha confidential", embedding: [1, 0] }]);
    await service.upsertChunks(WS_BETA, idxB.id, [{ text: "Beta confidential", embedding: [1, 0] }]);

    const searchAlpha = await service.search(WS_ALPHA, idxA.id, [1, 0]);
    expect(searchAlpha).toHaveLength(1);
    expect(searchAlpha[0]?.text_content).toBe("Alpha confidential");

    // Beta index queried with WS_ALPHA context returns nothing
    const searchLeak = await service.search(WS_ALPHA, idxB.id, [1, 0]);
    expect(searchLeak).toHaveLength(0);
  });
});

describe("Vector Memory HTTP API", () => {
  it("provides full HTTP workflow for vector index, upsert, and search", async () => {
    const app = new Hono<VectorEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createVectorRoutes());

    // 1. POST /vectors/indexes
    const createRes = await app.request(
      "/api/vectors/indexes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          name: "product_docs",
          dimensions: 3,
          metric: "cosine",
        }),
      },
      { DB: db },
    );
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as { index: { id: string } };
    const indexId = createJson.index.id;

    // 2. POST /vectors/indexes/:id/upsert
    const upsertRes = await app.request(
      `/api/vectors/indexes/${indexId}/upsert`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          chunks: [{ text: "Cloudflare D1 is SQLite at the edge", embedding: [0.8, 0.2, 0.1] }],
        }),
      },
      { DB: db },
    );
    expect(upsertRes.status).toBe(201);

    // 3. POST /vectors/indexes/:id/search
    const searchRes = await app.request(
      `/api/vectors/indexes/${indexId}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          vector: [0.8, 0.2, 0.1],
          topK: 1,
        }),
      },
      { DB: db },
    );
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as { results: Array<{ text_content: string; score: number }> };
    expect(searchJson.results).toHaveLength(1);
    expect(searchJson.results[0]?.text_content).toContain("SQLite at the edge");
    expect(searchJson.results[0]?.score).toBeCloseTo(1.0, 4);
  });

  // ID_READ_FOREIGN (story 0.7): another workspace's index id is "not found"; nothing can be written into it or read
  // through it.
  it("answers 404 for an index id that belongs to another workspace", async () => {
    const app = new Hono<VectorEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createVectorRoutes());

    const service = new VectorMemoryService(db);
    const idxB = await service.createIndex(WS_BETA, "secrets_b", 2);
    await service.upsertChunks(WS_BETA, idxB.id, [{ text: "Beta confidential", embedding: [1, 0] }]);
    const asAlpha = { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA };

    const upsert = await app.request(
      `/api/vectors/indexes/${idxB.id}/upsert`,
      {
        method: "POST",
        headers: asAlpha,
        body: JSON.stringify({ chunks: [{ text: "Alpha planted", embedding: [1, 0] }] }),
      },
      { DB: db },
    );
    expect(upsert.status).toBe(404);
    const search = await app.request(
      `/api/vectors/indexes/${idxB.id}/search`,
      {
        method: "POST",
        headers: asAlpha,
        body: JSON.stringify({ vector: [1, 0], topK: 5 }),
      },
      { DB: db },
    );
    expect(search.status).toBe(404);

    expect(await service.getIndex(WS_ALPHA, idxB.id)).toBeNull();
    expect(await service.upsertChunks(WS_ALPHA, idxB.id, [{ text: "x", embedding: [1, 0] }])).toMatchObject({ ok: false });
    const planted = await db
      .prepare("SELECT COUNT(*) AS n FROM vec_documents WHERE index_id = ? AND workspace_id = ?")
      .bind(idxB.id, WS_ALPHA)
      .first<{ n: number }>();
    expect(planted!.n).toBe(0);
  });
});
