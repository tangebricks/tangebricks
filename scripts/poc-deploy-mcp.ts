// The MCP endpoint deployed as its own Worker and database, and the measurement run against it (epic 5, story 9).
// The plan it follows is in H9's note in hypotheses.json, committed on 2026-10-21 before any code for it existed, after
// the owner chose a separate Worker to protect the evidence chain H10 to H12 and the hosted money check rely on.
//
// Run with credentials in the environment and the state folder from scripts/poc-deploy.ts:
//
//   node "--env-file=C:\cephlow minimalist version\env\.env" scripts/poc-deploy-mcp.ts --state-dir "C:\cephlow minimalist version\env\poc-state"
//
// THIS CREATES TWO EXTRA RESOURCES IN THE OWNER'S ACCOUNT: one Worker (projectx-poc-<suffix>-mcp) and one D1 database
// (-mcp-db). Both are recorded in the same ledger that holds the project's resources, and scripts/poc-teardown.ts removes
// all of them together. The project Worker (the one H10 to H12 describe) is verified before and after to have not changed.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDeployment } from "../packages/deploy/src/context.ts";
import { scanTreesForSecrets } from "../packages/deploy/src/leak-scan.ts";
import { MCP_TOKEN_BINDING, bundleMcpWorker, mcpMigration, mcpTokenRecords } from "../packages/deploy/src/mcp-bundle.ts";
import { WORKER_SIZE_LIMIT_BYTES } from "../packages/deploy/src/bundle.ts";
import { MEASURED_PROJECTS, REVIEWER_SURFACE_MISSING, SESSION_PROJECT, canonicalMcp, evaluateMcp, runMcpMeasurement } from "../packages/deploy/src/mcp-measure.ts";
import type { McpFacts, McpResult } from "../packages/deploy/src/mcp-measure.ts";
import { overTheNetwork } from "../packages/deploy/src/network.ts";
import {
  CredentialsError,
  createClient,
  createRedactor,
  deploy,
  fileKeyStore,
  fileStore,
  findSecrets,
  loadOrCreateAccessKey,
  mcpResourceNames,
  openLedger,
} from "../packages/deploy/src/provisioner/index.ts";

const root = resolve(import.meta.dirname, "..");
const planRepo = resolve(root, "..", "ProjectX");
// AD-V8: the session proposes the money brick and a human must accept it; the standalone MCP Worker has no reviewer
// surface, so a deployed run would stop at the build. Refuse before anything is uploaded rather than record a broken run.
const reviewerSurfaceMissing = (): boolean => true; // until the standalone MCP Worker has a reviewer surface
if (reviewerSurfaceMissing()) {
  console.error(REVIEWER_SURFACE_MISSING);
  process.exit(3);
}

const flag = process.argv.indexOf("--state-dir");
const stateArg = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!stateArg) {
  console.error("--state-dir <folder> is required");
  process.exit(2);
}
const stateDir = resolve(stateArg);

const printed: string[] = [];
const out = (line: string) => {
  printed.push(line);
  console.log(line);
};

let deployment;
try {
  deployment = loadDeployment({ root, planRepo, stateDir, env: process.env });
} catch (error) {
  console.error(error instanceof CredentialsError || error instanceof Error ? error.message : "could not load the deployment");
  process.exit(2);
}

const repeatsArg = process.argv.indexOf("--repeats");
const repeats = repeatsArg >= 0 ? Number(process.argv[repeatsArg + 1]) : undefined;
const ladderArg = process.argv.indexOf("--ladder-builds");
const ladderBuilds = ladderArg >= 0 ? Number(process.argv[ladderArg + 1]) : undefined;

const envArg = process.argv.indexOf("--env");
const mcpEnvironment = (envArg >= 0 ? process.argv[envArg + 1] : "dev") as "dev" | "preview" | "production";
if (!["dev", "preview", "production"].includes(mcpEnvironment)) {
  console.error("--env must be dev, preview or production");
  process.exit(2);
}

const { credentials } = deployment;
const mcpNames = mcpResourceNames(deployment.names.suffix);
const mcpToken = loadOrCreateAccessKey(fileKeyStore(join(stateDir, "mcp-token.txt")), (n) => randomBytes(n));
// Story 0.15: no shared bearer. Each measured project gets its own token, derived from the stored secret, and the Worker is given
// only their SHA-256 hashes, each bound to its one project.
const projectTokens: Record<string, string> = Object.fromEntries(
  MEASURED_PROJECTS.map((project) => [project, createHmac("sha256", mcpToken).update(`mcp-project-token:${project}`).digest("hex")]),
);
const tokenRecords = mcpTokenRecords(projectTokens);
const hide = createRedactor([credentials.token, credentials.accountId, deployment.accessKey, mcpToken, ...Object.values(projectTokens)]);

const ledgerPath = join(stateDir, "ledger.json");
const ledger = openLedger(fileStore(ledgerPath), () => deployment.names.suffix);

const client = createClient({
  credentials,
  fetch: overTheNetwork,
  now: () => performance.now(),
  alsoHide: [deployment.accessKey, mcpToken, ...Object.values(projectTokens)],
});

out(`MCP measurement for ${deployment.names.script}: deploying separate Worker ${mcpNames.script} and database ${mcpNames.database}`);

// 1. Verify the project Worker's versions before touching anything
let versionsBefore: string[] | null = null;
try {
  const v = await client.listVersions(deployment.names.script);
  versionsBefore = v ? v.map((item) => item.id) : null;
  out(`project Worker ${deployment.names.script} currently has ${versionsBefore?.length ?? 0} version(s); newest ${versionsBefore?.[0]?.slice(0, 8) ?? "none"}`);
} catch (err) {
  console.error(`could not read versions of ${deployment.names.script}: ${err instanceof Error ? err.message : String(err)}`);
}

// 2. Bundle the MCP worker and prepare migration
const bundle = await bundleMcpWorker();
const migration = mcpMigration();
out(`bundled MCP Worker: ${bundle.bytes} bytes (${bundle.gzipBytes} gzipped), ${bundle.limit.percentUsed}% of 64 MiB limit`);

// 3. Deploy the separate MCP Worker
let deployResult: Awaited<ReturnType<typeof deploy>> | undefined;
let uploadError: string | undefined;
try {
  deployResult = await deploy({
    client,
    ledger,
    names: mcpNames,
    bundle: { code: bundle.code, sha256: bundle.sha256 },
    compatibilityDate: "2026-10-01",
    accessKey: tokenRecords,
    secretBinding: MCP_TOKEN_BINDING,
    migrations: [migration],
    environment: mcpEnvironment,
  });
  out(`deployed ${mcpNames.script} to ${deployResult.url}`);
} catch (error) {
  uploadError = error instanceof Error ? error.message : String(error);
  out(`deploy failed: ${uploadError}`);
}

// 4. Wait for the deployed worker address to answer
let reachableAfterMs: number | null = null;
let mcpUrl = "";
if (deployResult) {
  mcpUrl = `${deployResult.url}/mcp`;
  out(`waiting for ${mcpUrl} to answer...`);
  const readyStart = performance.now();
  for (let i = 0; i < 60; i++) {
    try {
      const res = await overTheNetwork(
        new Request(mcpUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
          signal: AbortSignal.timeout(5000),
        }),
      );
      if (res.status > 0) {
        reachableAfterMs = Math.round(performance.now() - readyStart);
        out(`endpoint answered HTTP ${res.status} after ${reachableAfterMs} ms`);
        break;
      }
    } catch {
      // not yet reachable
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// 5. Query stored files from D1
const readStoredFiles = async (project: string): Promise<Record<string, string> | null> => {
  if (!deployResult) return null;
  try {
    const rows = await client.queryDatabase(deployResult.databaseId, [
      {
        sql: "SELECT path, content FROM mcp_files WHERE project = ? ORDER BY path",
        params: [project],
      },
    ]);
    const files: Record<string, string> = {};
    for (const row of rows[0]?.results ?? []) {
      if (typeof row.path === "string" && typeof row.content === "string") {
        files[row.path] = row.content;
      }
    }
    return files;
  } catch {
    return null;
  }
};

const deployFact: McpFacts["deploy"] = deployResult
  ? {
      bytes: bundle.bytes,
      gzipBytes: bundle.gzipBytes,
      sha256: bundle.sha256,
      percentOfLimit: bundle.limit.percentUsed,
      limitBytes: WORKER_SIZE_LIMIT_BYTES,
      startupTimeMs: deployResult.startupTimeMs ?? null,
      changes: deployResult.changes.map((c) => c.what),
      reachableAfterMs,
    }
  : null;

// 6. Run measurement
const { facts, result: first } = await runMcpMeasurement({
  url: deployResult ? deployResult.url : "https://unreachable.invalid",
  token: projectTokens[SESSION_PROJECT]!,
  tokenFor: (project) => projectTokens[project] ?? projectTokens[SESSION_PROJECT]!,
  fetchUrl: (url, init) => overTheNetwork(new Request(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) })),
  clock: () => performance.now(),
  nowIso: () => new Date().toISOString(),
  readStoredFiles,
  hide,
  log: out,
  deploy: deployFact,
  uploadError,
  projectWorkerBefore: versionsBefore,
  readProjectWorkerVersions: async () => {
    const v = await client.listVersions(deployment.names.script);
    return v ? v.map((item) => item.id) : null;
  },
  accountCalls: () => client.calls,
  ...(repeats !== undefined ? { repeats } : {}),
  ...(ladderBuilds !== undefined ? { ladderBuilds } : {}),
});

// 7. Write evidence with secret check
const secrets: Record<string, string> = {
  token: credentials.token,
  accountId: credentials.accountId,
  accessKey: deployment.accessKey,
  mcpToken,
  ...Object.fromEntries(Object.entries(projectTokens).map(([project, value]) => [`mcpToken:${project}`, value])),
};
const callsText = canonicalMcp(facts);
for (const [name, text] of [["mcp-calls.json", callsText], ["mcp-result.json", JSON.stringify(first, null, 2)]] as const) {
  const hits = findSecrets(text, secrets);
  if (hits.length > 0) {
    console.error(`refusing to write ${name}: it contains ${hits.join(" and ")}`);
    process.exit(4);
  }
}

const dir = join(root, "evidence", "deployed");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const name of ["mcp-calls.json", "mcp-result.json"]) {
  if (existsSync(join(dir, name))) {
    mkdirSync(join(dir, "attempts"), { recursive: true });
    renameSync(join(dir, name), join(dir, "attempts", `${stamp}-${name}`));
  }
}

writeFileSync(join(dir, "mcp-calls.json"), callsText);
writeFileSync(join(dir, "mcp-result.json"), `${JSON.stringify(first, null, 2)}\n`);

const scan = scanTreesForSecrets([root, ...(existsSync(planRepo) ? [planRepo] : [])], secrets);
const final: McpResult = { ...first, leakScan: scan };
const finalText = `${JSON.stringify(final, null, 2)}\n`;
const finalHits = findSecrets(finalText + printed.join("\n"), secrets);
if (finalHits.length > 0) {
  console.error(`refusing to write mcp-result.json: it or the console output contains ${finalHits.join(" and ")}`);
  process.exit(4);
}
writeFileSync(join(dir, "mcp-result.json"), finalText);

const attemptsPath = join(dir, "mcp-attempts.json");
const attempts = existsSync(attemptsPath) ? (JSON.parse(readFileSync(attemptsPath, "utf8")) as unknown[]) : [];
attempts.push({ startedAt: facts.commandStartedAt, completed: final.completed, stoppedBecause: final.stoppedBecause ?? null });
writeFileSync(attemptsPath, `${JSON.stringify(attempts, null, 2)}\n`);

const evaluation = evaluateMcp({ callsText, result: final });
out("");
out("MCP evaluation notes:");
for (const note of evaluation.notes) out(`  - ${note}`);
out(`leak scan: ${scan.filesScanned} files in the two repositories, ${scan.found.length === 0 ? "no secret found" : `FOUND: ${scan.found.join("; ")}`}`);
out(`attempt ${attempts.length} recorded; evidence in evidence/deployed/`);

process.exit(final.completed && scan.found.length === 0 ? 0 : 1);
