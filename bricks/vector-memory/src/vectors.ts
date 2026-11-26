import type { D1Like } from "@poc/sdk";
import { scoped } from "@poc/sdk";

export type VectorMetric = "cosine" | "euclidean" | "dot";

export interface VectorIndex {
  id: string;
  workspace_id: string;
  name: string;
  dimensions: number;
  metric: VectorMetric;
  created_at: string;
}

export interface DocumentChunkInput {
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  chunk_index: number;
  text_content: string;
  score: number;
  metadata: Record<string, unknown>;
}

/**
 * Calculates cosine similarity between two numeric vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [i, x] of a.entries()) {
    // a and b have the same length (checked above); a hole in b gives NaN, exactly as before the strict index check.
    const y = b[i] ?? Number.NaN;
    dotProduct += x * y;
    normA += x * x;
    normB += y * y;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

/**
 * Splits text into overlapping chunks respecting sentence or whitespace boundaries.
 */
export function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= chunkSize) return [trimmed];

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    let end = start + chunkSize;

    if (end < trimmed.length) {
      // Find nearest space or period before end to avoid cutting words
      const lastSpace = trimmed.lastIndexOf(" ", end);
      if (lastSpace > start + chunkSize / 2) {
        end = lastSpace;
      }
    } else {
      end = trimmed.length;
    }

    const chunk = trimmed.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= trimmed.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

export class VectorMemoryService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  /**
   * Creates a vector index.
   */
  async createIndex(
    workspaceId: string,
    nameRaw: string,
    dimensions = 384,
    metric: VectorMetric = "cosine"
  ): Promise<VectorIndex> {
    const id = `idx_${crypto.randomUUID().replace(/-/g, "")}`;
    const name = nameRaw.trim();
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("vec_indexes", {
      id,
      name,
      dimensions,
      metric,
      created_at: now,
    });

    return {
      id,
      workspace_id: workspaceId,
      name,
      dimensions,
      metric,
      created_at: now,
    };
  }

  /**
   * Retrieves an index by ID, in the given workspace only: another workspace's index id is "not found".
   */
  async getIndex(workspaceId: string, indexId: string): Promise<VectorIndex | null> {
    return await scoped(this.db, workspaceId).first<VectorIndex>("vec_indexes", "id = ?", [indexId]);
  }

  /**
   * Lists vector indexes for a workspace.
   */
  async listIndexes(workspaceId: string): Promise<VectorIndex[]> {
    return scoped(this.db, workspaceId).select<VectorIndex>(
      "vec_indexes",
      undefined,
      [],
      { orderBy: "name ASC" },
    );
  }

  /**
   * Upserts document chunks with embeddings into the index.
   */
  async upsertChunks(
    workspaceId: string,
    indexId: string,
    chunks: DocumentChunkInput[]
  ): Promise<{ ok: boolean; count: number; error?: string }> {
    const index = await this.getIndex(workspaceId, indexId);
    if (!index) return { ok: false, count: 0, error: "Vector index not found" };

    const now = new Date().toISOString();

    for (const [i, c] of chunks.entries()) {
      if (c.embedding.length !== index.dimensions) {
        return {
          ok: false,
          count: 0,
          error: `Embedding dimension mismatch: expected ${index.dimensions}, got ${c.embedding.length}`,
        };
      }

      const docId = `vdoc_${crypto.randomUUID().replace(/-/g, "")}`;
      const meta = c.metadata ? JSON.stringify(c.metadata) : null;

      await scoped(this.db, workspaceId).insert("vec_documents", {
        id: docId,
        index_id: indexId,
        chunk_index: i,
        text_content: c.text.slice(0, 8192),
        embedding_json: JSON.stringify(c.embedding),
        metadata_json: meta,
        created_at: now,
      });
    }

    return { ok: true, count: chunks.length };
  }

  /**
   * Queries top-K nearest neighbors using cosine similarity.
   */
  async search(
    workspaceId: string,
    indexId: string,
    queryVector: number[],
    topK = 5,
    minScore = 0.0
  ): Promise<SearchResult[]> {
    interface RawDoc {
      id: string;
      chunk_index: number;
      text_content: string;
      embedding_json: string;
      metadata_json: string | null;
    }

    const rows = await scoped(this.db, workspaceId).select<RawDoc>(
      "vec_documents",
      "index_id = ?",
      [indexId],
    );

    const scored: SearchResult[] = [];

    for (const r of rows) {
      let emb: number[] = [];
      try {
        emb = JSON.parse(r.embedding_json);
      } catch {
        continue;
      }

      const score = cosineSimilarity(queryVector, emb);
      if (score >= minScore) {
        let meta = {};
        try {
          meta = r.metadata_json ? JSON.parse(r.metadata_json) : {};
        } catch {
          meta = {};
        }

        scored.push({
          id: r.id,
          chunk_index: r.chunk_index,
          text_content: r.text_content,
          score,
          metadata: meta,
        });
      }
    }

    // Sort descending by similarity score
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
  }
}
