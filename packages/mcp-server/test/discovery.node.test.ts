import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BRICK_CATEGORIES, BRICK_MATURITIES } from "@poc/assembler";
import type { Catalog } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import { createSqliteD1 } from "../../../bricks/credit-wallet/client/test/support/sqlite-d1.ts";
import { countTokens } from "../../../test/support/tokens.ts";
import migration from "../migrations/0001_mcp_server.sql?raw";
import { createMcpApp } from "../src/index.ts";
import { testToken, testTokenVerifier } from "./support/test-verifier.ts";

const TOKEN = testToken("discovery");
const db = createSqliteD1();
const app = createMcpApp({ catalog, verifyToken: testTokenVerifier });

async function callMcpTool(name: string, args: Record<string, unknown> = {}, targetApp = app) {
  const res = await targetApp.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    { DB: db },
  );
  const body = (await res.json()) as {
    result?: { isError?: boolean; content: Array<{ type: string; text: string }> };
    error?: { code: number; message: string };
  };
  const text = body.result?.content[0]?.text ?? "";
  return {
    isError: body.result?.isError === true,
    text,
    json: () => JSON.parse(text),
    rawRpcText: JSON.stringify(body),
  };
}

beforeAll(async () => {
  await applyMigration(db, migration);
});

afterAll(() => {
  db.close();
});

/** Unsafe or stub bricks quarantined in story 0.11: experimental with a QUARANTINED: reason. */
const QUARANTINED = [
  "admin-console",
  "agent-sandbox",
  "custom-domains",
  "document-pdf",
  "marketplace-splits",
  "oauth-server",
  "realtime-presence",
  "workflow-dag",
];

describe("compact, paged discovery and get_brick (AC 1, AC 2, AC 3)", () => {
  test("every page of list_bricks across all non-experimental bricks is <= 400 tokens (gpt-tokenizer) and shows real maturity tiers (no unrated)", async () => {
    const collectedIds: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;

    do {
      const reply = await callMcpTool("list_bricks", cursor ? { cursor } : {});
      expect(reply.isError).toBe(false);
      const pageTokens = countTokens(reply.text);
      expect(pageTokens, `page ${pageCount} token count (${pageTokens}) must be <= 400`).toBeLessThanOrEqual(400);

      const page = reply.json() as {
        items: Array<{ id: string; summary: string; category: string; maturity: string }>;
        nextCursor: string | null;
      };
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(10);
      for (const item of page.items) {
        expect(item.id.length).toBeGreaterThan(0);
        expect(item.summary.length).toBeGreaterThan(0);
        expect(BRICK_CATEGORIES).toContain(item.category);
        expect(["production", "beta"]).toContain(item.maturity);
        expect(item.maturity).toBe(catalog.bricks[item.id]!.manifest.ui?.maturity);
        collectedIds.push(item.id);
      }
      cursor = page.nextCursor ?? undefined;
      pageCount += 1;
    } while (cursor);

    const expectedDefaultIds = Object.keys(catalog.bricks)
      .filter((id) => catalog.bricks[id]!.manifest.ui?.maturity !== "experimental")
      .sort();
    expect(pageCount).toBe(4);
    expect(collectedIds).toEqual(expectedDefaultIds);
  });

  test("every page of list_bricks across all categories, capabilities, maturities, queries, and limits is <= 400 tokens", async () => {
    for (const category of BRICK_CATEGORIES) {
      let cursor: string | undefined;
      do {
        const reply = await callMcpTool("list_bricks", { category, ...(cursor ? { cursor } : {}) });
        expect(reply.isError).toBe(false);
        expect(countTokens(reply.text)).toBeLessThanOrEqual(400);
        const page = reply.json() as { items: Array<{ category: string }>; nextCursor: string | null };
        expect(page.items.every((i) => i.category === category)).toBe(true);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }

    const capabilities = [
      ...new Set(
        Object.values(catalog.bricks)
          .filter((b) => b.manifest.ui?.maturity !== "experimental")
          .flatMap((b) => b.manifest.provides),
      ),
    ];
    for (const capability of capabilities) {
      const reply = await callMcpTool("list_bricks", { capability });
      expect(reply.isError).toBe(false);
      expect(countTokens(reply.text)).toBeLessThanOrEqual(400);
      const page = reply.json() as { items: Array<{ id: string }> };
      expect(page.items.length).toBeGreaterThanOrEqual(1);
    }

    for (const maturity of [...BRICK_MATURITIES, "unrated"] as const) {
      const reply = await callMcpTool("list_bricks", { maturity });
      expect(reply.isError).toBe(false);
      expect(countTokens(reply.text)).toBeLessThanOrEqual(400);
    }

    for (const query of ["workspace", "wallet", "auth", "webhook", "a", "e", "o"]) {
      let cursor: string | undefined;
      do {
        const reply = await callMcpTool("list_bricks", { query, ...(cursor ? { cursor } : {}) });
        expect(reply.isError).toBe(false);
        expect(countTokens(reply.text)).toBeLessThanOrEqual(400);
        cursor = (reply.json() as { nextCursor: string | null }).nextCursor ?? undefined;
      } while (cursor);
    }

    for (const limit of [1, 3, 5, 10]) {
      const reply = await callMcpTool("list_bricks", { limit });
      expect(reply.isError).toBe(false);
      expect(countTokens(reply.text)).toBeLessThanOrEqual(400);
      expect((reply.json() as { items: unknown[] }).items).toHaveLength(limit);
    }
  });

  test("experimental bricks are hidden by default and returned only when maturity='experimental' is requested, and no bricks are unrated", async () => {
    const defaultIds: string[] = [];
    let cursor: string | undefined;
    do {
      const reply = await callMcpTool("list_bricks", cursor ? { cursor } : {});
      const page = reply.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      defaultIds.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(defaultIds).not.toContain("scripting-sandbox");
    for (const id of QUARANTINED) expect(defaultIds, `${id} is quarantined`).not.toContain(id);
    expect(defaultIds).toHaveLength(34); // 43 bricks minus scripting-sandbox and the 8 quarantined (story 0.11)

    // LIST_EXPERIMENTAL: asked for explicitly, the quarantined bricks are listed (paged, max 10 per page), and each one's
    // QUARANTINED reason is in get_brick (list pages stay compact to keep the 400-token page budget).
    const expItems: Array<{ id: string; maturity: string }> = [];
    let expCursor: string | undefined;
    do {
      const page = (await callMcpTool("list_bricks", { maturity: "experimental", ...(expCursor ? { cursor: expCursor } : {}) })).json() as {
        items: Array<{ id: string; maturity: string }>;
        nextCursor: string | null;
      };
      expItems.push(...page.items);
      expCursor = page.nextCursor ?? undefined;
    } while (expCursor);
    expect(expItems.map((i) => i.id)).toEqual([...QUARANTINED, "scripting-sandbox"].sort());
    expect(expItems.every((i) => i.maturity === "experimental")).toBe(true);
    for (const id of QUARANTINED) {
      const brick = (await callMcpTool("get_brick", { id })).json() as { maturity: string; maturityReason?: string };
      expect(brick.maturity, id).toBe("experimental");
      expect(brick.maturityReason, id).toMatch(/^QUARANTINED: /);
    }

    const unratedReply = await callMcpTool("list_bricks", { maturity: "unrated" });
    const unratedPage = unratedReply.json() as { items: Array<{ id: string }> };
    expect(unratedPage.items).toEqual([]);
  });

  test("story 0.11 LIST_DEFAULT: search_bricks by query hides quarantined bricks unless maturity='experimental' is asked for", async () => {
    for (const [query, id] of [["splits", "marketplace-splits"], ["presence", "realtime-presence"], ["oauth", "oauth-server"], ["domain", "custom-domains"]] as const) {
      const hidden = (await callMcpTool("search_bricks", { query, limit: 10 })).json() as { items: Array<{ id: string }> };
      expect(hidden.items.map((i) => i.id), query).not.toContain(id);
      const shown = (await callMcpTool("search_bricks", { query, maturity: "experimental", limit: 10 })).json() as { items: Array<{ id: string }> };
      expect(shown.items.map((i) => i.id), query).toContain(id);
    }
  });

  test("cursor is rejected if malformed or if the catalog changed", async () => {
    const firstPage = (await callMcpTool("list_bricks", { limit: 5 })).json() as { nextCursor: string };
    expect(firstPage.nextCursor).toBeTruthy();

    const changedCatalog: Catalog = structuredClone(catalog);
    changedCatalog.bricks["admin-console"]!.manifest.version = "9.9.9";
    const changedApp = createMcpApp({ catalog: changedCatalog, verifyToken: testTokenVerifier });

    const staleReply = await callMcpTool("list_bricks", { cursor: firstPage.nextCursor }, changedApp);
    expect(staleReply.isError).toBe(true);
    expect(staleReply.text).toMatch(/invalid cursor: catalog changed/);

    const malformedReply = await callMcpTool("list_bricks", { cursor: "not-a-valid-cursor!!!" });
    expect(malformedReply.isError).toBe(true);
    expect(malformedReply.text).toMatch(/invalid cursor/);
  });

  test("get_brick returns provides, needs, settings, servesEntities, routes and conflicts, and errors on unknown id", async () => {
    const wallet = (await callMcpTool("get_brick", { id: "credit-wallet" })).json();
    expect(wallet).toEqual({
      id: "credit-wallet",
      summary: "Atomic double-entry credit ledger, balance invariant engine, and idempotency keys.",
      category: "billing",
      maturity: "beta",
      maturityReason: "NO_DEFAULT_ADAPTER: Provider adapters exist (@poc/gateway-adapters) but none is wired by default; payment routes answer 503 NOT_CONFIGURED until a host passes a gateway and a currency.",
      provides: ["credit-wallet"],
      needs: ["workspace-context"],
      settings: {
        creditsPerUnit: "whole number 1 to 1000000, default 1",
        minOrderAmount: "whole number 1 to 1000000000, default 1",
        paymentCurrency: 'text, e.g. INR, default ""',
        defaultActionCosts: 'text, e.g. email.send:0.2,message.send:0.5, default ""',
      },
      servesEntities: false,
      routes: ["wallet", "payments"],
      conflicts: [],
    });

    const docParsing = (await callMcpTool("get_brick", { id: "document-parsing" })).json();
    expect(docParsing.conflicts).toEqual([
      {
        brick: "document-pdf",
        reason: "Both export route factory createDocumentRoutes in the documents domain",
      },
    ]);

    const missing = await callMcpTool("get_brick", { id: "does-not-exist" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/unknown brick "does-not-exist"/);
  });
});
