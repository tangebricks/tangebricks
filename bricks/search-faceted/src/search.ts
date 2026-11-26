import { scoped, type D1Like } from "@poc/sdk";

export interface SearchDocument {
  id: string;
  workspace_id: string;
  entity_type: string;
  entity_id: string;
  title: string;
  body: string;
  facets: Record<string, string | number>;
  created_at: string;
  updated_at: string;
}

export interface SearchResultItem {
  id: string;
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string;
  facets: Record<string, string | number>;
  rank: number;
}

export interface FacetBucket {
  value: string;
  count: number;
}

export interface SearchResponse {
  query: string;
  total: number;
  results: SearchResultItem[];
  facets: Record<string, FacetBucket[]>;
}

export interface TypeaheadItem {
  entity_id: string;
  entity_type: string;
  title: string;
}

export interface SearchOptions {
  entityType?: string;
  facetFilters?: Record<string, string | number>;
  limit?: number;
  offset?: number;
}

interface RawDocRow {
  id: string;
  workspace_id: string;
  entity_type: string;
  entity_id: string;
  title: string;
  body: string;
  facets_json: string;
  created_at: string;
  updated_at: string;
  rank?: number;
}

export class FacetedSearchService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  /**
   * Indexes a document into both standard storage and SQLite FTS5 inverted index.
   */
  async indexDocument(
    workspaceId: string,
    entityTypeRaw: string,
    entityIdRaw: string,
    titleRaw: string,
    bodyRaw: string,
    facets: Record<string, string | number> = {}
  ): Promise<SearchDocument> {
    const entityType = entityTypeRaw.trim().toLowerCase();
    const entityId = entityIdRaw.trim();
    const title = titleRaw.trim();
    const body = bodyRaw.trim();
    const id = `sdoc_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const facetsJson = JSON.stringify(facets);

    // 1. Check if document exists for entity
    const existing = await scoped(this.db, workspaceId).first<RawDocRow>(
      "search_documents",
      "entity_type = ? AND entity_id = ?",
      [entityType, entityId]
    );

    if (existing) {
      await scoped(this.db, workspaceId).delete("search_fts", "id = ?", [existing.id]);
      await scoped(this.db, workspaceId).update(
        "search_documents",
        {
          title,
          body,
          facets_json: facetsJson,
          updated_at: now,
        },
        "id = ?",
        [existing.id]
      );
    } else {
      await scoped(this.db, workspaceId).insert("search_documents", {
        id,
        entity_type: entityType,
        entity_id: entityId,
        title,
        body,
        facets_json: facetsJson,
        created_at: now,
        updated_at: now,
      });
    }

    const docId = existing?.id || id;

    // 2. Insert into FTS5 virtual table
    await scoped(this.db, workspaceId).insert("search_fts", {
      id: docId,
      title,
      body,
    });

    return {
      id: docId,
      workspace_id: workspaceId,
      entity_type: entityType,
      entity_id: entityId,
      title,
      body,
      facets,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Removes a document from the search index.
   */
  async deleteDocument(
    workspaceId: string,
    entityTypeRaw: string,
    entityIdRaw: string
  ): Promise<boolean> {
    const entityType = entityTypeRaw.trim().toLowerCase();
    const entityId = entityIdRaw.trim();

    const existing = await scoped(this.db, workspaceId).first<RawDocRow>(
      "search_documents",
      "entity_type = ? AND entity_id = ?",
      [entityType, entityId]
    );
    if (!existing) return false;

    await scoped(this.db, workspaceId).delete("search_fts", "id = ?", [existing.id]);
    const res = await scoped(this.db, workspaceId).delete(
      "search_documents",
      "id = ?",
      [existing.id]
    );

    return res.meta.changes > 0;
  }

  /**
   * Performs full-text search with BM25 ranking, snippet extraction, and faceted counts.
   */
  async search(
    workspaceId: string,
    queryRaw: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const query = queryRaw.trim();
    if (!query) {
      return { query, total: 0, results: [], facets: {} };
    }

    // Escape query for FTS5 syntax safety
    const ftsQuery = query.replace(/[^\w\s]/g, " ").trim();
    const matchExpr = ftsQuery.split(/\s+/).filter(Boolean).map((term) => `"${term}"*`).join(" OR ");

    // Query matched documents from FTS5
    interface FtsMatchRow {
      id: string;
      rank: number;
    }
    const ftsRows = (await scoped(this.db, workspaceId).raw(
      `SELECT id, bm25(search_fts) as rank FROM search_fts WHERE workspace_id = ? AND search_fts MATCH ? ORDER BY bm25(search_fts) ASC`,
      [workspaceId, matchExpr]
    ).all<FtsMatchRow>()).results;

    if (!ftsRows || ftsRows.length === 0) {
      return { query, total: 0, results: [], facets: {} };
    }

    const rankById = new Map<string, number>();
    for (const r of ftsRows) rankById.set(r.id, r.rank);

    const docPlaceholders = ftsRows.map(() => "?").join(",");
    const docRows = await scoped(this.db, workspaceId).select<RawDocRow>(
      "search_documents",
      `id IN (${docPlaceholders})`,
      ftsRows.map((r) => r.id)
    );

    const ftsOrder = new Map(ftsRows.map((r, idx) => [r.id, idx]));
    const rawRows = docRows
      .map((d) => ({
        ...d,
        rank: rankById.get(d.id) ?? 0,
      }))
      .sort((a, b) => (ftsOrder.get(a.id) ?? 0) - (ftsOrder.get(b.id) ?? 0));

    // Filter by entity type and facet filters in JS for flexibility
    let filtered = rawRows;

    if (options.entityType) {
      filtered = filtered.filter((r) => r.entity_type === options.entityType?.toLowerCase());
    }

    if (options.facetFilters) {
      filtered = filtered.filter((r) => {
        try {
          const docFacets = JSON.parse(r.facets_json || "{}");
          for (const [k, v] of Object.entries(options.facetFilters || {})) {
            if (String(docFacets[k]) !== String(v)) return false;
          }
          return true;
        } catch {
          return false;
        }
      });
    }

    // Compute dynamic facet distributions across matched documents
    const facetCounts: Record<string, Record<string, number>> = {};
    for (const r of filtered) {
      try {
        const docFacets = JSON.parse(r.facets_json || "{}");
        for (const [facetKey, facetVal] of Object.entries(docFacets)) {
          const valStr = String(facetVal);
          if (!facetCounts[facetKey]) facetCounts[facetKey] = {};
          facetCounts[facetKey][valStr] = (facetCounts[facetKey][valStr] || 0) + 1;
        }
      } catch {
        // ignore JSON parse error
      }
    }

    const formattedFacets: Record<string, FacetBucket[]> = {};
    for (const [key, valMap] of Object.entries(facetCounts)) {
      formattedFacets[key] = Object.entries(valMap).map(([value, count]) => ({
        value,
        count,
      })).sort((a, b) => b.count - a.count);
    }

    // Apply pagination
    const total = filtered.length;
    const offset = options.offset || 0;
    const limit = options.limit || 20;
    const paged = filtered.slice(offset, offset + limit);

    const results: SearchResultItem[] = paged.map((r) => {
      // Build snippet around matching query words
      let snippet = r.body.slice(0, 150);
      const lowerBody = r.body.toLowerCase();
      // split always returns at least one element.
      const firstWord = query.toLowerCase().split(/\s+/)[0] ?? "";
      const matchIdx = lowerBody.indexOf(firstWord);
      if (matchIdx > 30) {
        const start = Math.max(0, matchIdx - 30);
        snippet = `...${r.body.slice(start, start + 120)}...`;
      }

      return {
        id: r.id,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        title: r.title,
        snippet,
        facets: JSON.parse(r.facets_json || "{}"),
        rank: r.rank ?? 0,
      };
    });

    return {
      query,
      total,
      results,
      facets: formattedFacets,
    };
  }

  /**
   * Fast typeahead autocomplete suggestions based on title prefix.
   */
  async typeahead(workspaceId: string, prefixRaw: string, limit = 5): Promise<TypeaheadItem[]> {
    const prefix = prefixRaw.trim().toLowerCase();
    if (!prefix) return [];

    return scoped(this.db, workspaceId).select<TypeaheadItem>(
      "search_documents",
      "title LIKE ?",
      [`${prefix}%`],
      { orderBy: "title ASC", limit }
    );
  }
}
