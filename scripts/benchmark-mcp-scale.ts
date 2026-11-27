import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getEvidenceDir, stampEvidence, writeEvidence } from "./lib/evidence-stamp.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { catalog } from "../packages/assembler/catalog.generated.ts";
import { createInMemoryBlueprintClient, createMcpApp, createStaticTokenVerifier, projectHash } from "../packages/mcp-server/src/index.ts";
import { createSqliteD1 } from "../bricks/credit-wallet/client/test/support/sqlite-d1.ts";
import { applyMigration } from "../packages/sdk/src/index.ts";
import { TOKENIZER, countTokens, firstPartySource } from "../test/support/tokens.ts";

const root = process.cwd();
const TOKEN = "benchmark-token-0123456789abcdef";

interface ScaleTier {
  name: string;
  bricks: string[];
  entities: Array<{ name: string; fields: Array<{ name: string; type: "text" | "number" | "boolean" | "enum"; values?: string[]; required?: boolean }> }>;
}

const ENTITY_INVOICES = {
  name: "invoices",
  fields: [
    { name: "title", type: "text" as const, required: true },
    { name: "amount", type: "number" as const, required: true },
    { name: "status", type: "enum" as const, values: ["draft", "issued", "paid"] },
  ],
};

const ENTITY_CLIENTS = {
  name: "clients",
  fields: [
    { name: "name", type: "text" as const, required: true },
    { name: "email", type: "text" as const, required: true },
    { name: "status", type: "enum" as const, values: ["active", "inactive"] },
  ],
};

const ENTITY_PROJECTS = {
  name: "projects",
  fields: [
    { name: "name", type: "text" as const, required: true },
    { name: "budget", type: "number" as const },
    { name: "active", type: "boolean" as const },
  ],
};

const ENTITY_RECEIPTS = {
  name: "receipts",
  fields: [
    { name: "vendor", type: "text" as const, required: true },
    { name: "amount", type: "number" as const, required: true },
    { name: "tax", type: "number" as const },
  ],
};

const TIERS: ScaleTier[] = [
  {
    name: "Tier 1: Baseline (3 Bricks, 1 Table)",
    bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"],
    entities: [ENTITY_INVOICES],
  },
  {
    name: "Tier 2: Medium SaaS (7 Bricks, 2 Tables)",
    bricks: ["multi-workspace", "credit-wallet", "dynamic-entities", "core-auth", "audit-trail", "feature-flags", "checkout-gateway"],
    entities: [ENTITY_INVOICES, ENTITY_CLIENTS],
  },
  {
    name: "Tier 3: 10-Brick App (10 Bricks, 2 Tables)",
    bricks: [
      "multi-workspace",
      "credit-wallet",
      "dynamic-entities",
      "core-auth",
      "audit-trail",
      "feature-flags",
      "checkout-gateway",
      "binary-assets",
      "public-api-keys",
      "rbac-policy",
    ],
    entities: [ENTITY_INVOICES, ENTITY_CLIENTS],
  },
  {
    name: "Tier 4: Enterprise Backend (12 Bricks, 4 Tables)",
    bricks: [
      "multi-workspace",
      "credit-wallet",
      "dynamic-entities",
      "core-auth",
      "audit-trail",
      "feature-flags",
      "checkout-gateway",
      "binary-assets",
      "public-api-keys",
      "rbac-policy",
      "webhook-gateway",
      "in-app-notifications",
    ],
    entities: [ENTITY_INVOICES, ENTITY_CLIENTS, ENTITY_PROJECTS, ENTITY_RECEIPTS],
  },
  {
    name: "Tier 5: Scaled SaaS / Sub-4% Threshold (16 Bricks, 4 Tables)",
    bricks: [
      "multi-workspace",
      "credit-wallet",
      "dynamic-entities",
      "core-auth",
      "audit-trail",
      "feature-flags",
      "checkout-gateway",
      "binary-assets",
      "public-api-keys",
      "rbac-policy",
      "webhook-gateway",
      "in-app-notifications",
      "llm-gateway",
      "omnichannel-outbound",
      "subscription-plans",
      "workflow-dag",
    ],
    entities: [ENTITY_INVOICES, ENTITY_CLIENTS, ENTITY_PROJECTS, ENTITY_RECEIPTS],
  },
  {
    name: "Tier 6: Cephlow-Scale Suite (25 Bricks, 4 Tables)",
    bricks: [
      "multi-workspace",
      "credit-wallet",
      "dynamic-entities",
      "core-auth",
      "audit-trail",
      "feature-flags",
      "checkout-gateway",
      "binary-assets",
      "public-api-keys",
      "rbac-policy",
      "webhook-gateway",
      "in-app-notifications",
      "llm-gateway",
      "omnichannel-outbound",
      "subscription-plans",
      "workflow-dag",
      "cron-alarms",
      "custom-domains",
      "data-privacy-gdpr",
      "document-parsing",
      "metered-usage",
      "edge-traffic-armor",
      "oauth-server",
      "live-chat",
      "marketplace-splits",
    ],
    entities: [ENTITY_INVOICES, ENTITY_CLIENTS, ENTITY_PROJECTS, ENTITY_RECEIPTS],
  },
  {
    name: "Tier 7: Max-Compatible Platform Suite (38 Bricks, 4 Tables)",
    bricks: Object.keys(catalog.bricks)
      // oidc-verify provides user-identity like core-auth, so the two cannot be enabled together (UC9.6);
      // identity-federation requires oidc-verifier, which only oidc-verify provides (UC9.7), so it is left out too
      .filter((id) => id !== "document-pdf" && id !== "outbound-webhooks" && id !== "oidc-verify" && id !== "identity-federation")
      .sort(),
    entities: [ENTITY_INVOICES, ENTITY_CLIENTS, ENTITY_PROJECTS, ENTITY_RECEIPTS],
  },
];

async function runMcpBenchmark(tier: ScaleTier) {
  const db = createSqliteD1();
  const mcpSql = readFileSync(join(root, "packages", "mcp-server", "migrations", "0001_mcp_server.sql"), "utf8");
  await applyMigration(db, mcpSql);

  // Story 0.15: the token is bound to the one project this tier builds.
  // AD-V8: the benchmark keeps the blueprint client so it can accept the agent's proposals as the Studio reviewer would.
  const blueprintClient = createInMemoryBlueprintClient(catalog);
  const app = createMcpApp({
    catalog,
    blueprintClient,
    verifyToken: createStaticTokenVerifier([{ token: TOKEN, userId: "user:benchmark", projectId: `proj-${tier.bricks.length}`, scopes: ["read", "edit"] }]),
    // Standalone runs record an explicit, verified workspace (story 1.4); the benchmark names its own.
    standaloneWorkspaceId: "ws_benchmark",
  });
  const exchanges: Array<{ req: string; res: string; reqTokens: number; resTokens: number }> = [];

  const recordingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const requestBody = await request.clone().text();
    const response = await app.fetch(request, { DB: db });
    const responseBody = await response.clone().text();
    exchanges.push({
      req: requestBody,
      res: responseBody,
      reqTokens: countTokens(requestBody),
      resTokens: countTokens(responseBody),
    });
    return response;
  };

  const client = new Client({ name: `benchmark-${tier.bricks.length}`, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: recordingFetch,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );

  // 1. Tool listing
  await client.listTools();

  // 2. Discover catalog
  const listResult = await client.callTool({ name: "list_bricks", arguments: {} });
  if (listResult.isError) throw new Error(`list_bricks failed: ${JSON.stringify(listResult)}`);

  // 3. Enable bricks in chunks of <= 20
  const projectName = `proj-${tier.bricks.length}`;
  const chunkSize = 20;
  for (let i = 0; i < tier.bricks.length; i += chunkSize) {
    const chunk = tier.bricks.slice(i, i + chunkSize);
    // AD-V8: the tiers include money bricks, so the agent proposes them and the reviewer (outside MCP) accepts.
    const proposeResult = await client.callTool({
      name: "apply_ops",
      arguments: { project: projectName, ops: chunk.map((brickId) => ({ opId: `enable-${brickId}`, type: "enable_brick", brickId })) },
    });
    if (proposeResult.isError) throw new Error(`apply_ops failed: ${JSON.stringify(proposeResult)}`);
    const proposed = JSON.parse((proposeResult.content as Array<{ text: string }>)[0]!.text) as { proposalId: string; status: string };
    if (proposed.status !== "pending") throw new Error(`expected a pending proposal, got ${proposed.status}`);
    const accepted = await blueprintClient.acceptProposal!({
      project: projectName,
      proposalId: proposed.proposalId,
      reviewer: { type: "human", id: "benchmark:reviewer" },
    });
    if (!accepted.ok) throw new Error(`the reviewer could not accept ${proposed.proposalId}: ${accepted.error.message}`);
  }

  // 4. Declare entities
  if (tier.entities.length > 0) {
    const entityResult = await client.callTool({
      name: "define_entity",
      arguments: { project: projectName, entities: tier.entities },
    });
    if (entityResult.isError) throw new Error(`define_entity failed: ${JSON.stringify(entityResult)}`);
  }

  // 5. Build project
  const buildResult = await client.callTool({
    name: "build_project",
    arguments: { project: projectName },
  });
  if (buildResult.isError) throw new Error(`build_project failed: ${JSON.stringify(buildResult)}`);

  await client.close();

  // Read stored files from D1
  const rows = (await db.prepare("SELECT path, content FROM mcp_files ORDER BY path").all<{ path: string; content: string }>()).results;
  const storedFiles: Record<string, string> = Object.fromEntries(rows.map((r) => [r.path, r.content]));

  // Calculate Conversation Tokens
  const totalConversationTokens = exchanges.reduce((sum, e) => sum + e.reqTokens + e.resTokens, 0);

  // Calculate First-Party Source Tokens
  const packageDirs = tier.bricks.map((b) => `bricks/${b}`);
  const sourceCount = firstPartySource({ packageDirs, generated: storedFiles, root });

  const ratioPercent = (totalConversationTokens / sourceCount.total) * 100;
  const pHash = await projectHash(storedFiles);

  return {
    tier: tier.name,
    bricksCount: tier.bricks.length,
    entitiesCount: tier.entities.length,
    filesCount: Object.keys(storedFiles).length,
    conversationTokens: totalConversationTokens,
    firstPartySourceTokens: sourceCount.total,
    generatedFilesOnlyTokens: sourceCount.generatedOnly,
    ratioPercent: Math.round(ratioPercent * 10) / 10,
    projectHash: pHash,
    status: ratioPercent <= 4.0 ? "SUB-4% REACHED" : "PASS",
  };
}

async function main() {
  console.log("===============================================================");
  console.log("   PROJECTX-POC: EMPIRICAL MCP TOKEN SCALING BENCHMARK");
  console.log(`   Tokenizer: ${TOKENIZER}`);
  console.log("===============================================================\n");

  const results = [];
  for (const tier of TIERS) {
    process.stdout.write(`Running benchmark for ${tier.name}... `);
    const res = await runMcpBenchmark(tier);
    console.log(`DONE: ${res.ratioPercent}% (conv: ${res.conversationTokens}, source: ${res.firstPartySourceTokens}, files: ${res.filesCount})`);
    results.push(res);
  }

  const tenBrickSession = results.find((r) => r.bricksCount === 10)!;
  const outPath = join(getEvidenceDir(), "mcp-scaling-benchmark.json");
  let timestamp = new Date().toISOString();
  if (existsSync(outPath)) {
    try {
      const existing = JSON.parse(readFileSync(outPath, "utf8")) as {
        tokenizer?: string;
        timestamp?: string;
        tenBrickSessionRatioPercent?: number;
        results?: unknown;
      };
      if (
        typeof existing.timestamp === "string" &&
        existing.tokenizer === TOKENIZER &&
        existing.tenBrickSessionRatioPercent === tenBrickSession.ratioPercent &&
        JSON.stringify(existing.results) === JSON.stringify(results)
      ) {
        timestamp = existing.timestamp;
      }
    } catch {
      // Regenerate timestamp on parse error.
    }
  }
  const prov = stampEvidence("scripts/benchmark-mcp-scale.ts", "measured");
  writeEvidence(
    outPath,
    {
      tokenizer: TOKENIZER,
      timestamp,
      tenBrickSessionRatioPercent: tenBrickSession.ratioPercent,
      tenBrickSession,
      results,
    },
    prov,
  );
  console.log(
    `\n10-Brick Session Ratio: ${tenBrickSession.ratioPercent}% (${tenBrickSession.conversationTokens} conversation tokens / ${tenBrickSession.firstPartySourceTokens} first-party source tokens)`,
  );
  console.log(`Evidence written to: ${outPath}`);

  console.log("\nSummary Table:");
  console.table(
    results.map((r) => ({
      Tier: r.tier,
      Bricks: r.bricksCount,
      "Generated Files": r.filesCount,
      "Conv Tokens": r.conversationTokens,
      "Source Tokens": r.firstPartySourceTokens,
      "Token Ratio": `${r.ratioPercent}%`,
      Status: r.status,
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
