import type { IntegrationManifestFile, IntegrationOperation } from "@poc/assembler";
import { IntegrationCallError } from "./errors.ts";
import { isPlainObject } from "./redaction.ts";
import { getByDotPath, setByDotPath } from "./request-build.ts";

export function parseLinkNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[2] === "next") {
      return match[1]!;
    }
  }
  return null;
}

export interface PaginationState {
  currentPageUrl: URL;
  targetUrl: URL;
  pagesFetched: number;
  maxPages: number;
  aggregatedItems: unknown[];
  finalBody: unknown;
  lastStatus: number;
  lastHeaders: Headers;
  truncated: boolean;
  nextCursor: string | null;
}

export function initPaginationState(
  operation: IntegrationOperation,
  targetUrl: URL,
): PaginationState {
  const pagination = operation.pagination;
  const maxPages = pagination ? Math.min(Math.max(1, pagination.maxPages), 100) : 1;
  const currentPageUrl = new URL(targetUrl.toString());

  if (pagination && pagination.style === "offset") {
    const offsetParam = pagination.paramName || "offset";
    if (!currentPageUrl.searchParams.has(offsetParam)) {
      currentPageUrl.searchParams.set(offsetParam, "0");
    }
    if (pagination.limitParam && pagination.pageSize && !currentPageUrl.searchParams.has(pagination.limitParam)) {
      currentPageUrl.searchParams.set(pagination.limitParam, String(pagination.pageSize));
    }
  }

  return {
    currentPageUrl,
    targetUrl: new URL(targetUrl.toString()),
    pagesFetched: 0,
    maxPages,
    aggregatedItems: [],
    finalBody: {},
    lastStatus: 200,
    lastHeaders: new Headers(),
    truncated: false,
    nextCursor: null,
  };
}

export function updatePaginationOnPage(
  state: PaginationState,
  manifest: IntegrationManifestFile,
  operation: IntegrationOperation,
  status: number,
  parsedBody: unknown,
  headers: Headers,
): boolean {
  state.lastStatus = status;
  state.lastHeaders = headers;
  state.pagesFetched += 1;
  state.finalBody = parsedBody;

  const pagination = operation.pagination;
  if (!pagination) {
    return false;
  }

  const pageIdx = state.pagesFetched;
  const pageItems = getByDotPath(parsedBody, pagination.responsePath);
  if (Array.isArray(pageItems)) {
    state.aggregatedItems.push(...pageItems);
  }

  if (pagination.style === "cursor") {
    const cursorVal = pagination.nextCursorPath
      ? getByDotPath(parsedBody, pagination.nextCursorPath)
      : undefined;
    if (typeof cursorVal === "string" && cursorVal.trim().length > 0) {
      if (pageIdx >= state.maxPages) {
        state.truncated = true;
        state.nextCursor = cursorVal.trim();
        return false;
      }
      state.currentPageUrl = new URL(state.targetUrl.toString());
      state.currentPageUrl.searchParams.set(
        pagination.paramName || "cursor",
        cursorVal.trim(),
      );
      return true;
    }
    return false;
  }

  if (pagination.style === "page") {
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      return false;
    }
    let hasMore = true;
    if (pagination.nextCursorPath) {
      hasMore = Boolean(getByDotPath(parsedBody, pagination.nextCursorPath));
      if (!hasMore) return false;
    }
    if (pageIdx >= state.maxPages && hasMore) {
      state.truncated = true;
      state.nextCursor = String(pageIdx + 1);
      return false;
    }
    state.currentPageUrl = new URL(state.targetUrl.toString());
    state.currentPageUrl.searchParams.set(
      pagination.paramName || "page",
      String(pageIdx + 1),
    );
    return true;
  }

  if (pagination.style === "link") {
    const nextLink = parseLinkNextUrl(headers.get("link"));
    if (!nextLink) return false;
    if (pageIdx >= state.maxPages) {
      state.truncated = true;
      state.nextCursor = nextLink;
      return false;
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(nextLink, state.targetUrl.origin);
    } catch {
      throw new IntegrationCallError(
        `INTEGRATION_HOST_FORBIDDEN: Invalid pagination Link URL "${nextLink}"`,
        { code: "INTEGRATION_HOST_FORBIDDEN" },
      );
    }
    if (!manifest.allowedHosts.includes(nextUrl.hostname)) {
      throw new IntegrationCallError(
        `INTEGRATION_HOST_FORBIDDEN: Pagination Link URL "${nextUrl.toString()}" violates allowedHosts [${manifest.allowedHosts.join(", ")}]`,
        { code: "INTEGRATION_HOST_FORBIDDEN" },
      );
    }
    state.currentPageUrl = nextUrl;
    return true;
  }

  if (pagination.style === "offset") {
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      return false;
    }
    let hasMore = true;
    if (pagination.hasMorePath) {
      const hasMoreVal = getByDotPath(parsedBody, pagination.hasMorePath);
      if (hasMoreVal !== undefined && !hasMoreVal) hasMore = false;
    } else if (pagination.pageSize && pageItems.length < pagination.pageSize) {
      hasMore = false;
    }
    if (!hasMore) {
      return false;
    }
    const nextOffset = state.aggregatedItems.length;
    if (pageIdx >= state.maxPages) {
      state.truncated = true;
      state.nextCursor = String(nextOffset);
      return false;
    }
    state.currentPageUrl = new URL(state.targetUrl.toString());
    state.currentPageUrl.searchParams.set(pagination.paramName || "offset", String(nextOffset));
    if (pagination.limitParam && pagination.pageSize) {
      state.currentPageUrl.searchParams.set(pagination.limitParam, String(pagination.pageSize));
    }
    return true;
  }

  if (pagination.style === "bodyNextUrl") {
    const nextUrlPath = pagination.nextUrlPath || pagination.nextCursorPath || "next";
    const nextUrlRaw = getByDotPath(parsedBody, nextUrlPath);
    if (typeof nextUrlRaw !== "string" || nextUrlRaw.trim().length === 0) {
      return false;
    }
    const nextUrlStr = nextUrlRaw.trim();
    if (pageIdx >= state.maxPages) {
      state.truncated = true;
      state.nextCursor = nextUrlStr;
      return false;
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(nextUrlStr, state.targetUrl.origin);
    } catch {
      throw new IntegrationCallError(
        `INTEGRATION_HOST_FORBIDDEN: Invalid pagination body URL "${nextUrlStr}"`,
        { code: "INTEGRATION_HOST_FORBIDDEN" },
      );
    }
    if (!manifest.allowedHosts.includes(nextUrl.hostname)) {
      throw new IntegrationCallError(
        `INTEGRATION_HOST_FORBIDDEN: Pagination URL "${nextUrl.toString()}" violates allowedHosts [${manifest.allowedHosts.join(", ")}]`,
        { code: "INTEGRATION_HOST_FORBIDDEN" },
      );
    }
    state.currentPageUrl = nextUrl;
    return true;
  }

  if (pagination.style === "headerToken") {
    const tokenHeader = (pagination.tokenHeader || "x-next-page-token").toLowerCase();
    let tokenVal: string | null = null;
    headers.forEach((v, k) => {
      if (k.toLowerCase() === tokenHeader) tokenVal = v;
    });
    if (typeof tokenVal !== "string" || (tokenVal as string).trim().length === 0) {
      return false;
    }
    const tokenStr = (tokenVal as string).trim();
    if (pageIdx >= state.maxPages) {
      state.truncated = true;
      state.nextCursor = tokenStr;
      return false;
    }
    state.currentPageUrl = new URL(state.targetUrl.toString());
    state.currentPageUrl.searchParams.set(pagination.paramName || "cursor", tokenStr);
    if (pagination.limitParam && pagination.pageSize) {
      state.currentPageUrl.searchParams.set(pagination.limitParam, String(pagination.pageSize));
    }
    return true;
  }

  if (pagination.style === "lastItemCursor") {
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      return false;
    }
    let hasMore = true;
    if (pagination.hasMorePath) {
      const hasMoreVal = getByDotPath(parsedBody, pagination.hasMorePath);
      if (hasMoreVal !== undefined && !hasMoreVal) hasMore = false;
    } else if (pagination.pageSize && pageItems.length < pagination.pageSize) {
      hasMore = false;
    }
    if (!hasMore) {
      return false;
    }
    const lastItem = pageItems[pageItems.length - 1];
    const itemIdPath = pagination.itemIdPath || "id";
    const cursorVal = isPlainObject(lastItem) ? getByDotPath(lastItem, itemIdPath) : undefined;
    if (cursorVal === undefined || cursorVal === null || String(cursorVal).trim().length === 0) {
      return false;
    }
    const cursorStr = String(cursorVal).trim();
    if (pageIdx >= state.maxPages) {
      state.truncated = true;
      state.nextCursor = cursorStr;
      return false;
    }
    state.currentPageUrl = new URL(state.targetUrl.toString());
    state.currentPageUrl.searchParams.set(pagination.paramName || "starting_after", cursorStr);
    if (pagination.limitParam && pagination.pageSize) {
      state.currentPageUrl.searchParams.set(pagination.limitParam, String(pagination.pageSize));
    }
    return true;
  }

  return false;
}

export function finalizePaginationResult(
  state: PaginationState,
  operation: IntegrationOperation,
): {
  finalBody: unknown;
  extractedData: unknown;
  headersRecord: Record<string, string>;
} {
  let finalBody = state.finalBody;
  const pagination = operation.pagination;

  if (pagination) {
    finalBody = setByDotPath(finalBody, pagination.responsePath, state.aggregatedItems);
    if (isPlainObject(finalBody)) {
      finalBody = {
        ...finalBody,
        pagesFetched: state.pagesFetched,
      };
    }
  }

  const extractedData = operation.response?.dataPath
    ? getByDotPath(finalBody, operation.response.dataPath)
    : finalBody;

  const headersRecord: Record<string, string> = {};
  state.lastHeaders.forEach((v, k) => {
    headersRecord[k.toLowerCase()] = v;
  });

  return { finalBody, extractedData, headersRecord };
}
