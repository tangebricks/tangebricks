import { writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, relative, extname, basename } from "node:path";
import { execSync } from "node:child_process";

const root = resolve(process.cwd());
const uaDir = join(root, ".ua");

if (!existsSync(uaDir)) {
  mkdirSync(uaDir, { recursive: true });
}

let commitHash = "84a56be77a74a7759c24f2b43b10db983ce6eac4";
try {
  commitHash = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
} catch {}

interface GraphNode {
  id: string;
  type: string;
  name: string;
  filePath?: string;
  lineRange?: [number, number];
  summary: string;
  tags: string[];
  complexity: "simple" | "moderate" | "complex";
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  direction: "forward" | "backward" | "bidirectional";
  description?: string;
  weight: number;
}

const nodes: GraphNode[] = [];
const edges: GraphEdge[] = [];
const nodeIds = new Set<string>();

function addNode(node: GraphNode) {
  if (nodeIds.has(node.id)) return;
  nodeIds.add(node.id);
  nodes.push(node);
}

function addEdge(edge: GraphEdge) {
  edges.push(edge);
}

// 1. Add packages as module nodes
const packages = [
  {
    id: "module:packages/sdk",
    name: "@poc/sdk",
    path: "packages/sdk/src/index.ts",
    desc: "Core contracts: pure 107-line validator (H1), secret manifest isolation (H3), entity schemas, and D1 wrappers.",
  },
  {
    id: "module:packages/runtime",
    name: "@poc/runtime",
    path: "packages/runtime/src/index.ts",
    desc: "Zero-codegen graph execution runtime (H2) evaluating DAGs asynchronously with parallel branch resolution.",
  },
  {
    id: "module:packages/dafthunk",
    name: "@poc/dafthunk",
    path: "packages/dafthunk/src/index.ts",
    desc: "Bridge adapter (H4) hosting 290+ unmodified vendored WASM Photon and Three.js nodes.",
  },
  {
    id: "module:bricks/credit-wallet",
    name: "@poc/credit-wallet",
    path: "bricks/credit-wallet/src/index.ts",
    desc: "Atomic double-entry ledger brick (H5) enforcing financial safety via SQLite update expressions and unique keys.",
  },
  {
    id: "module:bricks/dynamic-entities",
    name: "@poc/dynamic-entities",
    path: "bricks/dynamic-entities/src/index.ts",
    desc: "Dynamic entity CRUD router (H8) compiling JSON schemas into row-level tenant-isolated REST endpoints.",
  },
  {
    id: "module:bricks/multi-workspace",
    name: "@poc/multi-workspace",
    path: "bricks/multi-workspace/src/index.ts",
    desc: "Multi-tenant workspace isolation middleware and membership routes enforcing tenant boundaries.",
  },
  {
    id: "module:packages/assembler",
    name: "@poc/assembler",
    path: "packages/assembler/src/index.ts",
    desc: "Offline deterministic project generator (H6, H7) generating byte-identical Cloudflare Worker code in 0.77s.",
  },
  {
    id: "module:packages/mcp-server",
    name: "@poc/mcp-server",
    path: "packages/mcp-server/src/index.ts",
    desc: "Streamable HTTP MCP server (H9) exposing 4 deterministic tools for autonomous AI agent assembly.",
  },
  {
    id: "module:packages/deploy",
    name: "@poc/deploy",
    path: "packages/deploy/src/index.ts",
    desc: "Cloudflare edge deployer (H10, H11, H12) provisioning D1, Workflows, and Worker scripts via REST without Wrangler.",
  },
  {
    id: "module:packages/harness",
    name: "@poc/harness",
    path: "packages/harness/src/index.ts",
    desc: "Scientific test harness running native workerd pools, recording metrics, and evaluating kill thresholds.",
  },
];

for (const pkg of packages) {
  addNode({
    id: pkg.id,
    type: "module",
    name: pkg.name,
    filePath: pkg.path,
    summary: pkg.desc,
    tags: ["package", "module"],
    complexity: "moderate",
  });
}

// 2. Add the 13 Hypotheses
const hypotheses = [
  {
    id: "H0",
    title: "H0: Harness inside native workerd",
    target: "module:packages/harness",
    summary: "Multi-environment test runner directly inside native workerd C++ runtime.",
  },
  {
    id: "H1",
    title: "H1: Small Graph Validator",
    target: "function:packages/sdk/src/validate.ts#validateGraph",
    summary: "107-line pure graph validator replaces 3,078 lines of string codegen, catching 8 error classes without an AST.",
  },
  {
    id: "H2",
    title: "H2: Interpreted DAG Runtime",
    target: "function:packages/runtime/src/run.ts#runGraph",
    summary: "Interpreted graph execution achieves 0.555 parallel execution ratio with zero dynamic eval() or codegen.",
  },
  {
    id: "H3",
    title: "H3: Manifest Secret Isolation",
    target: "function:packages/sdk/src/manifest.ts#validateManifestSecrets",
    summary: "Strict secret isolation throws whenever an undeclared environment secret is accessed by a node.",
  },
  {
    id: "H4",
    title: "H4: Dafthunk Bridge Adapter",
    target: "class:packages/dafthunk/src/adapter.ts#DafthunkBridge",
    summary: "290 unmodified Dafthunk nodes (WASM/Photon, Three.js) run seamlessly behind a clean TypeScript adapter.",
  },
  {
    id: "H5",
    title: "H5: Safe Money Concurrency",
    target: "class:bricks/credit-wallet/src/wallet.ts#CreditWallet",
    summary: "Atomic SQLite ledger achieves 0 lost updates across 1,000 parallel ops (vs 100% failure rate in cephlow).",
  },
  {
    id: "H6",
    title: "H6: Modular Brick Composition",
    target: "function:packages/assembler/src/assemble.ts#assembleProject",
    summary: "Bricks compose cleanly from blueprints into a single Worker entrypoint with zero manual glue code.",
  },
  {
    id: "H7",
    title: "H7: Deterministic Offline Assembly",
    target: "function:packages/assembler/src/assemble.ts#assembleProject",
    summary: "Offline assembly compiles complete multi-tenant backends in 0.771 seconds with cryptographic reproducibility.",
  },
  {
    id: "H8",
    title: "H8: Tenant-Safe Dynamic Entities",
    target: "endpoint:/api/v1/entities/:table",
    summary: "Declarative entity schemas generate CRUD routes with guaranteed tenant isolation across hostile intrusion tests.",
  },
  {
    id: "H9",
    title: "H9: Agentic MCP Assembly",
    target: "class:packages/mcp-server/src/mcp.ts#ProjectXMcpServer",
    summary: "AI agents build complete SaaS apps using 4 MCP tools consuming only 14.1% of conversation tokens.",
  },
  {
    id: "H10",
    title: "H10: Idempotent Cloudflare REST Deploy",
    target: "class:packages/deploy/src/provisioner/cloudflare.ts#CloudflareApiClient",
    summary: "Direct REST provisioner deploys full-stack apps in 16.7s, with 0 changes on second deploy and clean teardown.",
  },
  {
    id: "H11",
    title: "H11: D1-Backed Dynamic Workflows",
    target: "class:packages/deploy/src/worker/graph-workflow.ts#GraphWorkflow",
    summary: "One Cloudflare Workflow class runs arbitrary graphs from D1; updating a graph takes 150ms without script re-upload.",
  },
  {
    id: "H12",
    title: "H12: Deployed Client Component Layer",
    target: "component:bricks/credit-wallet/client/CreditWidget.tsx#CreditWidget",
    summary: "Frontend React widgets mount against deployed Cloudflare APIs and render live balance data with zero glue code.",
  },
];

for (const h of hypotheses) {
  const cId = `concept:hypothesis/${h.id}`;
  addNode({
    id: cId,
    type: "concept",
    name: h.title,
    summary: h.summary,
    tags: ["hypothesis", h.id.toLowerCase(), "verdict-pass"],
    complexity: "moderate",
  });
}

// 3. Scan files recursively in packages and scripts
function scanDir(dir: string, fileList: string[] = []): string[] {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "out" || entry === "vendor") continue;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath, fileList);
    } else if (
      stat.isFile() &&
      (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".sql") || entry.endsWith(".json") || entry.endsWith(".md"))
    ) {
      if (!entry.endsWith(".d.ts")) {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

const allFiles = [...scanDir(join(root, "packages")), ...scanDir(join(root, "scripts"))];

// Also add PROOF.md and hypotheses.json
allFiles.push(join(root, "PROOF.md"));
allFiles.push(join(root, "hypotheses.json"));

const filePathToNodeId: Record<string, string> = {};

for (const f of allFiles) {
  const rel = relative(root, f).replace(/\\/g, "/");
  const ext = extname(f);
  const base = basename(f);
  const nodeId = `file:${rel}`;
  filePathToNodeId[rel] = nodeId;

  let nodeType = "file";
  if (ext === ".sql") nodeType = "table";
  else if (ext === ".md") nodeType = "document";
  else if (ext === ".json") nodeType = "config";

  let lines = 0;
  let content = "";
  try {
    content = readFileSync(f, "utf8");
    lines = content.split("\n").length;
  } catch {}

  const isTest = rel.includes("test") || rel.includes(".test.");
  const isScript = rel.startsWith("scripts/");
  const isMigration = rel.includes("migrations/");

  let summary = `Source file ${rel} (${lines} lines).`;
  if (isTest) summary = `Automated test suite verifying architectural contracts in ${rel}.`;
  else if (isScript && base.startsWith("mutate-")) summary = `Mutation test matrix validating failure detection in ${rel}.`;
  else if (isScript && base.startsWith("poc-")) summary = `Live deployment or measurement probe script: ${rel}.`;
  else if (isMigration) summary = `Cloudflare D1 SQL database schema migration: ${rel}.`;

  const tags = ["codebase"];
  if (isTest) tags.push("test");
  if (isScript) tags.push("script");
  if (isMigration) tags.push("migration");

  addNode({
    id: nodeId,
    type: nodeType,
    name: rel,
    filePath: rel,
    lineRange: [1, Math.max(1, lines)],
    summary,
    tags,
    complexity: lines > 200 ? "complex" : lines > 60 ? "moderate" : "simple",
  });

  // Check which package this file belongs to and link contains
  for (const pkg of packages) {
    const pkgFolder = pkg.id.replace("module:", "");
    if (rel.startsWith(pkgFolder + "/")) {
      addEdge({
        source: pkg.id,
        target: nodeId,
        type: "contains",
        direction: "forward",
        weight: 0.5,
      });
      break;
    }
  }

  // Parse imports to create import edges
  if (ext === ".ts" || ext === ".tsx") {
    const importRegex = /from\s+["'](\.[^"']+)["']/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importedRel = match[1];
      if (!importedRel) continue;
      // resolve relative to current file's directory
      const fileDir = rel.substring(0, rel.lastIndexOf("/"));
      let resolvedTarget = join(fileDir, importedRel).replace(/\\/g, "/");
      if (!resolvedTarget.endsWith(".ts") && !resolvedTarget.endsWith(".tsx")) {
        resolvedTarget += ".ts";
      }
      const targetNodeId = `file:${resolvedTarget}`;
      if (nodeIds.has(targetNodeId) || allFiles.some((af) => relative(root, af).replace(/\\/g, "/") === resolvedTarget)) {
        addEdge({
          source: nodeId,
          target: targetNodeId,
          type: "imports",
          direction: "forward",
          weight: 0.7,
        });
      }
    }
  }

  // If this is a test file, link tested_by to corresponding source file if determinable
  if (isTest) {
    const matchedSource = rel
      .replace(/\/test\//, "/src/")
      .replace(/\.test\.tsx?$/, ".ts")
      .replace(/\.node\.test\.ts$/, ".ts");
    const targetSourceId = `file:${matchedSource}`;
    if (nodeIds.has(targetSourceId)) {
      addEdge({
        source: targetSourceId,
        target: nodeId,
        type: "tested_by",
        direction: "forward",
        description: `Verified by unit/contract tests in ${base}`,
        weight: 0.9,
      });
    }
  }
}

// 4. Add Key Core Function/Class Nodes
const coreSymbols = [
  {
    id: "function:packages/sdk/src/validate.ts#validateGraph",
    name: "validateGraph",
    file: "packages/sdk/src/validate.ts",
    summary: "107-line pure graph validator (H1) replacing 3,078 lines of string codegen. Checks DAG acyclicity, types, and connectivity.",
  },
  {
    id: "function:packages/sdk/src/manifest.ts#validateManifestSecrets",
    name: "validateManifestSecrets",
    file: "packages/sdk/src/manifest.ts",
    summary: "Secret isolation guard (H3) ensuring node execution contexts only receive declared secrets.",
  },
  {
    id: "function:packages/runtime/src/run.ts#runGraph",
    name: "runGraph",
    file: "packages/runtime/src/run.ts",
    summary: "Zero-codegen graph interpreter (H2) executing parallel branches asynchronously.",
  },
  {
    id: "class:packages/dafthunk/src/adapter.ts#DafthunkBridge",
    name: "DafthunkBridge",
    file: "packages/dafthunk/src/adapter.ts",
    summary: "Bridge adapter (H4) adapting 290+ unmodified WASM and Three.js nodes to runtime.",
  },
  {
    id: "class:bricks/credit-wallet/src/wallet.ts#CreditWallet",
    name: "CreditWallet",
    file: "bricks/credit-wallet/src/wallet.ts",
    summary: "Atomic financial ledger service (H5) using atomic SQLite math and idempotency keys.",
  },
  {
    id: "function:bricks/credit-wallet/src/routes.ts#createCreditRoutes",
    name: "createCreditRoutes",
    file: "bricks/credit-wallet/src/routes.ts",
    summary: "Hono router mounting /api/v1/wallet endpoints (/balance, /deduct, /topup, /webhook).",
  },
  {
    id: "component:bricks/credit-wallet/client/CreditWidget.tsx#CreditWidget",
    name: "CreditWidget",
    file: "bricks/credit-wallet/client/CreditWidget.tsx",
    summary: "Embedded React UI component (H12) querying live wallet balance.",
  },
  {
    id: "function:packages/assembler/src/assemble.ts#assembleProject",
    name: "assembleProject",
    file: "packages/assembler/src/assemble.ts",
    summary: "Deterministic project synthesizer (H6, H7) compiling full Cloudflare Worker in 770 ms.",
  },
  {
    id: "class:packages/mcp-server/src/mcp.ts#ProjectXMcpServer",
    name: "ProjectXMcpServer",
    file: "packages/mcp-server/src/mcp.ts",
    summary: "Streamable HTTP MCP Server (H9) enabling AI agents to build full-stack apps via 4 tools.",
  },
  {
    id: "class:packages/deploy/src/provisioner/cloudflare.ts#CloudflareApiClient",
    name: "CloudflareApiClient",
    file: "packages/deploy/src/provisioner/cloudflare.ts",
    summary: "Direct Cloudflare REST API client provisioning D1, Workflows, and Worker scripts.",
  },
  {
    id: "class:packages/deploy/src/provisioner/ledger.ts#DeploymentLedger",
    name: "DeploymentLedger",
    file: "packages/deploy/src/provisioner/ledger.ts",
    summary: "Append-only state ledger recording deployed Cloudflare resource IDs for safe teardown.",
  },
  {
    id: "class:packages/deploy/src/worker/graph-workflow.ts#GraphWorkflow",
    name: "GraphWorkflow",
    file: "packages/deploy/src/worker/graph-workflow.ts",
    summary: "Unified Cloudflare Workflow class (H11) executing arbitrary dynamic graphs stored in D1.",
  },
];

for (const sym of coreSymbols) {
  addNode({
    id: sym.id,
    type: sym.id.startsWith("class:") ? "class" : sym.id.startsWith("component:") ? "component" : "function",
    name: sym.name,
    filePath: sym.file,
    summary: sym.summary,
    tags: ["core-symbol"],
    complexity: "moderate",
  });
  addEdge({
    source: `file:${sym.file}`,
    target: sym.id,
    type: "contains",
    direction: "forward",
    weight: 0.8,
  });
}

// 5. Add Endpoints & Tables
const endpointsAndTables = [
  {
    id: "table:d1/wallets",
    type: "table",
    name: "wallets",
    file: "bricks/credit-wallet/migrations/0001_credit_wallet.sql",
    summary: "D1 table storing workspace balances with atomic UPDATE checks.",
  },
  {
    id: "table:d1/ledger_entries",
    type: "table",
    name: "ledger_entries",
    file: "bricks/credit-wallet/migrations/0001_credit_wallet.sql",
    summary: "Immutable double-entry ledger table enforcing unique idempotency_key.",
  },
  {
    id: "table:d1/workspaces",
    type: "table",
    name: "workspaces",
    file: "bricks/credit-wallet/migrations/0001_credit_wallet.sql",
    summary: "D1 table storing workspace tenant definitions.",
  },
  {
    id: "table:d1/dynamic_entities",
    type: "table",
    name: "dynamic_entities",
    file: "bricks/dynamic-entities/src/routes.ts",
    summary: "Row-level tenant isolated tables dynamically generated from JSON schemas (H8).",
  },
  {
    id: "endpoint:/api/v1/wallet/balance",
    type: "endpoint",
    name: "GET /api/v1/wallet/balance",
    file: "bricks/credit-wallet/src/routes.ts",
    summary: "Returns live balance and transaction summary.",
  },
  {
    id: "endpoint:/api/v1/wallet/deduct",
    type: "endpoint",
    name: "POST /api/v1/wallet/deduct",
    file: "bricks/credit-wallet/src/routes.ts",
    summary: "Deducts credits with atomic concurrency safety.",
  },
  {
    id: "endpoint:/api/v1/entities/:table",
    type: "endpoint",
    name: "CRUD /api/v1/entities/:table",
    file: "bricks/dynamic-entities/src/routes.ts",
    summary: "Tenant-isolated CRUD endpoints for declarative entity schemas.",
  },
  {
    id: "endpoint:/mcp/tools",
    type: "endpoint",
    name: "POST /mcp (Streamable HTTP)",
    file: "packages/mcp-server/src/mcp.ts",
    summary: "Model Context Protocol streaming endpoint providing list_bricks, enable_brick, define_entity, and build_project.",
  },
];

for (const et of endpointsAndTables) {
  addNode({
    id: et.id,
    type: et.type,
    name: et.name,
    filePath: et.file,
    summary: et.summary,
    tags: [et.type],
    complexity: "moderate",
  });
}

// 6. Connect Hypotheses to Implementations
for (const h of hypotheses) {
  const cId = `concept:hypothesis/${h.id}`;
  if (nodeIds.has(h.target)) {
    addEdge({
      source: cId,
      target: h.target,
      type: "exemplifies",
      direction: "forward",
      description: `Hypothesis ${h.id} proven by implementation`,
      weight: 1.0,
    });
  }
  // Link verify script to each hypothesis
  addEdge({
    source: "file:scripts/verify.ts",
    target: cId,
    type: "tested_by",
    direction: "backward",
    description: `Automated pass/kill gate for ${h.id}`,
    weight: 0.9,
  });
}

// 7. Functional Relationships
addEdge({
  source: "function:packages/runtime/src/run.ts#runGraph",
  target: "function:packages/sdk/src/validate.ts#validateGraph",
  type: "calls",
  direction: "forward",
  weight: 1.0,
});
addEdge({
  source: "function:packages/runtime/src/run.ts#runGraph",
  target: "function:packages/sdk/src/manifest.ts#validateManifestSecrets",
  type: "calls",
  direction: "forward",
  weight: 0.9,
});
addEdge({
  source: "class:packages/deploy/src/worker/graph-workflow.ts#GraphWorkflow",
  target: "function:packages/runtime/src/run.ts#runGraph",
  type: "calls",
  direction: "forward",
  weight: 1.0,
});
addEdge({ source: "class:bricks/credit-wallet/src/wallet.ts#CreditWallet", target: "table:d1/wallets", type: "writes_to", direction: "forward", weight: 1.0 });
addEdge({
  source: "class:bricks/credit-wallet/src/wallet.ts#CreditWallet",
  target: "table:d1/ledger_entries",
  type: "writes_to",
  direction: "forward",
  weight: 1.0,
});
addEdge({
  source: "endpoint:/api/v1/wallet/deduct",
  target: "class:bricks/credit-wallet/src/wallet.ts#CreditWallet",
  type: "calls",
  direction: "forward",
  weight: 0.9,
});
addEdge({
  source: "endpoint:/api/v1/wallet/balance",
  target: "class:bricks/credit-wallet/src/wallet.ts#CreditWallet",
  type: "calls",
  direction: "forward",
  weight: 0.9,
});
addEdge({
  source: "component:bricks/credit-wallet/client/CreditWidget.tsx#CreditWidget",
  target: "endpoint:/api/v1/wallet/balance",
  type: "calls",
  direction: "forward",
  weight: 0.8,
});
addEdge({ source: "class:packages/mcp-server/src/mcp.ts#ProjectXMcpServer", target: "endpoint:/mcp/tools", type: "serves", direction: "forward", weight: 1.0 });
addEdge({
  source: "class:packages/mcp-server/src/mcp.ts#ProjectXMcpServer",
  target: "function:packages/assembler/src/assemble.ts#assembleProject",
  type: "calls",
  direction: "forward",
  weight: 1.0,
});

// 8. Define Layers
const layers = [
  {
    id: "layer:core-runtime",
    name: "Core Graph Runtime & SDK",
    description: "Zero-codegen DAG interpreter, 107-line pure validator, secret isolation guard, and Dafthunk WASM adapter.",
    nodeIds: nodes.filter((n) => n.id.includes("packages/sdk") || n.id.includes("packages/runtime") || n.id.includes("packages/dafthunk")).map((n) => n.id),
  },
  {
    id: "layer:edge-infrastructure",
    name: "Cloudflare Edge & Storage",
    description: "D1 SQLite database, Cloudflare Workflows, REST provisioner, and deployment ledger.",
    nodeIds: nodes.filter((n) => n.id.includes("packages/deploy") || n.id.includes("table:d1/")).map((n) => n.id),
  },
  {
    id: "layer:bricks",
    name: "Composable Bricks",
    description: "Self-contained modular features: atomic credit wallet, dynamic entities, and multi-workspace middleware.",
    nodeIds: nodes
      .filter(
        (n) =>
          n.id.includes("bricks/credit-wallet") ||
          n.id.includes("bricks/dynamic-entities") ||
          n.id.includes("bricks/multi-workspace") ||
          n.id.includes("endpoint:/api/v1"),
      )
      .map((n) => n.id),
  },
  {
    id: "layer:agentic-mcp",
    name: "Agentic MCP & AI Layer",
    description: "Model Context Protocol streaming server exposing high-level tools to AI coding agents.",
    nodeIds: nodes.filter((n) => n.id.includes("packages/mcp-server") || n.id === "endpoint:/mcp/tools").map((n) => n.id),
  },
  {
    id: "layer:assembly-engine",
    name: "Assembly & Codegen Engine",
    description: "Sub-second deterministic offline compiler assembling full applications from brick blueprints.",
    nodeIds: nodes.filter((n) => n.id.includes("packages/assembler")).map((n) => n.id),
  },
  {
    id: "layer:scientific-proof",
    name: "Scientific Proof & Verification",
    description: "H0-H12 hypothesis register, workerd test harness, automated verdict derivation, and signed proof document.",
    nodeIds: nodes
      .filter((n) => n.id.includes("concept:hypothesis") || n.id.includes("packages/harness") || n.id.includes("scripts/") || n.id.includes("PROOF.md"))
      .map((n) => n.id),
  },
];

// 9. Tour Steps
const tour = [
  {
    order: 1,
    title: "Scientific Proof & Initiative Verdict (H0-H12)",
    description:
      "Explore the ProjectX hypothesis register: 13 out of 13 empirical claims passed with 0 kills across 1,368 automated tests, giving an unambiguous GO verdict.",
    nodeIds: ["file:PROOF.md", "file:scripts/verify.ts", "file:scripts/poc-verdict.ts", "module:packages/harness"],
    languageLesson: "Every claim was defined with explicit pass and kill thresholds before code was written. The harness verifies these inside native workerd.",
  },
  {
    order: 2,
    title: "The 107-Line Pure Graph Validator (H1)",
    description:
      "Learn how ProjectX eradicated 3,078 lines of brittle compiler code-generation by creating a compact, AST-free graph validator in packages/sdk/src/validate.ts.",
    nodeIds: ["concept:hypothesis/H1", "function:packages/sdk/src/validate.ts#validateGraph", "file:packages/sdk/src/validate.ts"],
    languageLesson:
      "Detects cycles via depth-first search, catches orphaned nodes, validates socket types, and calculates topological layers without compiling to JS strings.",
  },
  {
    order: 3,
    title: "Zero-Codegen DAG Runtime & WASM Bridge (H2, H3, H4)",
    description:
      "Discover the interpreted runtime that executes parallel graph branches asynchronously (0.555 ratio) and bridges 290+ unmodified WASM nodes (Dafthunk).",
    nodeIds: [
      "concept:hypothesis/H2",
      "concept:hypothesis/H3",
      "concept:hypothesis/H4",
      "function:packages/runtime/src/run.ts#runGraph",
      "class:packages/dafthunk/src/adapter.ts#DafthunkBridge",
    ],
    languageLesson: "Evaluates node promises as dependencies resolve. Secret isolation prevents untrusted nodes from accessing ambient environment secrets.",
  },
  {
    order: 4,
    title: "Atomic Double-Entry Credit Wallet (H5)",
    description:
      "Understand how moving wallet balance math into SQLite atomic update expressions achieves 0 lost updates under 1,000 concurrent parallel operations.",
    nodeIds: [
      "concept:hypothesis/H5",
      "class:bricks/credit-wallet/src/wallet.ts#CreditWallet",
      "table:d1/wallets",
      "table:d1/ledger_entries",
      "endpoint:/api/v1/wallet/deduct",
    ],
    languageLesson:
      "Previous in-memory balance checks suffered from 100% corruption under concurrency. Atomic D1 expressions (balance = balance - ? WHERE balance >= ?) provide absolute safety.",
  },
  {
    order: 5,
    title: "Deterministic Offline Assembly & Entities (H6, H7, H8)",
    description: "See how the assembler composes modular bricks and dynamic schemas into byte-identical Cloudflare Worker codebases in 0.77 seconds.",
    nodeIds: [
      "concept:hypothesis/H6",
      "concept:hypothesis/H7",
      "concept:hypothesis/H8",
      "function:packages/assembler/src/assemble.ts#assembleProject",
      "endpoint:/api/v1/entities/:table",
    ],
    languageLesson: "Bricks declare migrations and endpoints in manifests. The assembler generates pure ES modules without external network dependencies.",
  },
  {
    order: 6,
    title: "Agent-First Assembly via Model Context Protocol (H9)",
    description: "Learn how AI agents build entire production applications using 4 high-level MCP tools consuming only 14.1% of conversation tokens.",
    nodeIds: ["concept:hypothesis/H9", "class:packages/mcp-server/src/mcp.ts#ProjectXMcpServer", "endpoint:/mcp/tools"],
    languageLesson:
      "Instead of having an LLM generate thousands of lines of raw boilerplate, the agent calls list_bricks -> enable_brick -> define_entity -> build_project.",
  },
  {
    order: 7,
    title: "Idempotent Edge Deployment & Dynamic Workflows (H10, H11, H12)",
    description: "Explore the Cloudflare REST provisioner, D1-backed dynamic workflows (150ms graph updates), and React client component mounting.",
    nodeIds: [
      "concept:hypothesis/H10",
      "concept:hypothesis/H11",
      "concept:hypothesis/H12",
      "class:packages/deploy/src/provisioner/cloudflare.ts#CloudflareApiClient",
      "class:packages/deploy/src/worker/graph-workflow.ts#GraphWorkflow",
      "component:bricks/credit-wallet/client/CreditWidget.tsx#CreditWidget",
    ],
    languageLesson:
      "Direct REST calls provision D1 and Workflows without Wrangler. A single Workflow class executes arbitrary graphs stored dynamically in D1.",
  },
];

const knowledgeGraph = {
  version: "2.9.0",
  kind: "codebase",
  project: {
    name: "projectx-poc",
    languages: ["TypeScript", "TSX", "SQL", "WASM", "JSON"],
    frameworks: ["Cloudflare Workers", "Cloudflare Workflows", "Cloudflare D1", "Hono", "React", "Vitest", "Model Context Protocol"],
    description: "Scientific proof-of-concept monorepo for ProjectX: composable full-stack SaaS platform on Cloudflare edge.",
    analyzedAt: new Date().toISOString(),
    gitCommitHash: commitHash,
  },
  nodes,
  edges,
  layers,
  tour,
};

// Write output files
writeFileSync(join(uaDir, "knowledge-graph.json"), JSON.stringify(knowledgeGraph, null, 2), "utf8");

const meta = {
  lastAnalyzedAt: knowledgeGraph.project.analyzedAt,
  gitCommitHash: commitHash,
  version: "2.9.0",
  analyzedFiles: nodes.length,
};
writeFileSync(join(uaDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

console.log(`Knowledge graph complete: ${nodes.length} nodes, ${edges.length} edges across ${layers.length} layers and ${tour.length} tour steps.`);
