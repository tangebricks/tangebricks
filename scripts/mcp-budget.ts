/**
 * Story 7.4 — CI Token Budget Enforcement (`pnpm mcp:budget`).
 *
 * Evaluates three hard token-budget gates using the H9 tokenizer (`gpt-tokenizer 4.1.0, o200k_base` per D9):
 *   1. Per-page ceiling: every default-limit page (`limit = 10`) of `search_bricks`, `search_nodes`,
 *      `list_runs`, `query_logs`, plus `get_blueprint_summary`, is <= 400 tokens.
 *   2. Session A (3-brick H9 reference session): <= 5 tool calls and token ratio <= 15.0% of emitted source tokens.
 *   3. Session B (10-brick + 20-node scale session): combined `tools/list` definition tokens + all tool call
 *      request/response tokens across the session <= 8,000 tokens.
 *
 * Writes `evidence/mcp-token-budget.json` and exits 0 if all gates hold, or exits 1 with a table of offending tools.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getEvidenceDir, stampEvidence, writeEvidence } from "./lib/evidence-stamp.ts";
import { catalog } from "../packages/assembler/catalog.generated.ts";
import {
  formatMcpTokenBudgetSummary,
  runMcpTokenBudgetSuite,
} from "../packages/mcp-server/src/token-budget.ts";
import { applyMigration } from "../packages/sdk/src/index.ts";
import type { D1Like, D1Result, D1Statement } from "../packages/sdk/src/index.ts";
import { measureH9EmittedSourceTokens } from "../test/support/h9-emitted-source.ts";

function createSqliteD1(): D1Like {
  const sqlite = new DatabaseSync(":memory:");

  const makeStatement = (sql: string, boundValues: unknown[] = []): D1Statement => ({
    bind(...values: unknown[]): D1Statement {
      return makeStatement(sql, values);
    },
    async first<Row = Record<string, unknown>>(): Promise<Row | null> {
      const stmt = sqlite.prepare(sql);
      const row = stmt.get(...(boundValues as never[])) as Row | undefined;
      return row ?? null;
    },
    async run(): Promise<D1Result> {
      const stmt = sqlite.prepare(sql);
      const res = stmt.run(...(boundValues as never[]));
      return {
        results: [],
        success: true,
        meta: { changes: Number(res.changes ?? 0) },
      };
    },
    async all<Row = Record<string, unknown>>(): Promise<D1Result<Row>> {
      const stmt = sqlite.prepare(sql);
      const rows = stmt.all(...(boundValues as never[])) as Row[];
      return {
        results: rows,
        success: true,
        meta: { changes: rows.length },
      };
    },
  });

  return {
    prepare(sql: string): D1Statement {
      return makeStatement(sql);
    },
    async batch(statements: D1Statement[]): Promise<D1Result[]> {
      const out: D1Result[] = [];
      for (const s of statements) {
        out.push(await s.run());
      }
      return out;
    },
    async exec(sql: string): Promise<unknown> {
      sqlite.exec(sql);
      return { ok: true };
    },
  };
}

async function main() {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const migrationPath = resolve(
    rootDir,
    "packages",
    "mcp-server",
    "migrations",
    "0001_mcp_server.sql",
  );
  const migrationSql = readFileSync(migrationPath, "utf8");

  const db = createSqliteD1();
  await applyMigration(db, migrationSql);

  // The same measurement the workerd tests use (test/support/h9-emitted-source.ts).
  const report = await runMcpTokenBudgetSuite({
    db,
    catalog,
    sessionAEmittedTokens: measureH9EmittedSourceTokens(rootDir),
  });

  const outPath = resolve(getEvidenceDir(), "mcp-token-budget.json");
  const prov = stampEvidence("scripts/mcp-budget.ts", "measured");
  writeEvidence(outPath, report, prov);

  console.log(formatMcpTokenBudgetSummary(report));
  console.log(`[mcp:budget] Evidence written to ${outPath}`);

  if (!report.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[mcp:budget] Fatal error:", err);
  process.exit(1);
});
