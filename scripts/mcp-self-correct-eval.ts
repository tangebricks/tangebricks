/**
 * Story 7.3 — Automated Agent Self-Correction Evaluation (`pnpm mcp:eval:self-correct`).
 *
 * Seeds 10 distinct failure scenarios across blueprint readiness/conflict/settings,
 * workflow graph validation, connection bindings, optimistic concurrency conflicts,
 * runtime step input mapping failures, and production deploy blockers.
 *
 * Runs a deterministic policy agent loop over MCP tools with MAX_TOOL_CALLS = 3 per scenario,
 * writes `evidence/mcp-self-correction-eval.json`, and exits 0 if >= 8/10 (>= 80%) reach a
 * repaired passing state within <= 3 MCP tool calls (exits 1 otherwise).
 */
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEvidenceDir, stampEvidence, writeEvidence } from "./lib/evidence-stamp.ts";
import { catalog } from "../packages/assembler/catalog.generated.ts";
import { createDirectMcpCaller, runSelfCorrectionEvalSuite } from "../packages/mcp-server/src/self-correction-eval.ts";
import { createInMemoryBlueprintClient } from "../packages/mcp-server/src/store.ts";
import type { D1Like, D1Result, D1Statement } from "../packages/sdk/src/index.ts";

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
  const db = createSqliteD1();
  const blueprint = createInMemoryBlueprintClient(catalog);
  const callMcp = createDirectMcpCaller({
    db,
    catalog,
    blueprint,
    // Standalone runs record an explicit, verified workspace (story 1.4); the eval names its own.
    workspaceId: "ws_eval",
    author: {
      type: "agent",
      id: "agent:self-correct-eval",
      client: "mcp-eval",
    },
  });

  const report = await runSelfCorrectionEvalSuite({
    callMcp,
    seedProject: async (project, state, revision = 1) => {
      await blueprint.seedProject!(project, state, revision);
    },
    // AD-V8: the eval plays the Studio reviewer through the blueprint client; no MCP tool can accept a proposal.
    review: async (project, proposalId) => {
      const accepted = await blueprint.acceptProposal!({
        project,
        proposalId,
        reviewer: { type: "human", id: "eval:studio-reviewer" },
      });
      if (!accepted.ok) throw new Error(`the reviewer could not accept ${proposalId}: ${accepted.error.message}`);
    },
  });

  const outPath = resolve(getEvidenceDir(), "mcp-self-correction-eval.json");
  const prov = stampEvidence("scripts/mcp-self-correct-eval.ts", "measured");
  writeEvidence(outPath, report, prov);

  console.log(
    `[mcp:eval:self-correct] Passed ${report.passedScenarios}/${report.totalScenarios} scenarios (${Math.round(report.passRate * 100)}%, min required: ${Math.round(report.minimumRequiredPassRate * 100)}%)`,
  );
  for (const s of report.scenarios) {
    console.log(
      `  [${s.passed ? "PASS" : "FAIL"}] #${s.id} ${s.code} — calls=${s.toolCallsUsed}/${s.maxToolCallsAllowed} path=${s.initialIssue.path} op=${s.initialIssue.remediationOp?.kind ?? "none"}`,
    );
  }
  console.log(`[mcp:eval:self-correct] Evidence written to ${outPath}`);

  if (!report.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[mcp:eval:self-correct] Fatal error:", err);
  process.exit(1);
});
