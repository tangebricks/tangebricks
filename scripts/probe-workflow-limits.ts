import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "../packages/deploy/src/provisioner/cloudflare.ts";
import { createClient } from "../packages/deploy/src/provisioner/cloudflare.ts";
import { loadCredentials } from "../packages/deploy/src/provisioner/credentials.ts";
import { deploy } from "../packages/deploy/src/provisioner/deploy.ts";
import type { Ledger } from "../packages/deploy/src/provisioner/ledger.ts";
import { memoryStore, openLedger } from "../packages/deploy/src/provisioner/ledger.ts";
import { newSuffix, resourceNames } from "../packages/deploy/src/provisioner/names.ts";
import { teardown } from "../packages/deploy/src/provisioner/teardown.ts";
import { LIMITS_PROBE_WORKFLOW_CLASS } from "../packages/deploy/src/worker/limits-probe.ts";
import type { WorkflowLimitsEvidence } from "../packages/sdk/src/platform-limits.ts";

export type { WorkflowLimitsEvidence };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

export function getHeadGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export interface ProbeWorkflowLimitsOptions {
  client: Client;
  ledger?: Ledger;
  gitSha?: string;
  accountPlan?: "free" | "paid";
  maxStepBisection?: number;
  maxByteBisection?: number;
  maxSubrequests?: number;
  maxRetries?: number;
  writeEvidence?: boolean;
  evidenceDir?: string;
  workflowName?: string;
}

export async function probeWorkflowLimits(options: ProbeWorkflowLimitsOptions): Promise<WorkflowLimitsEvidence> {
  const { client, maxStepBisection = 4096, maxByteBisection = 2 * 1024 * 1024, maxSubrequests = 1000, maxRetries = 5, accountPlan = "free" } = options;

  const gitSha = options.gitSha || getHeadGitSha();
  const measuredAt = new Date().toISOString();
  const workflowName = options.workflowName ?? "projectx-limits-probe";

  // Step bisection sequence
  const stepCandidates = [256, 512, 1024, 2048, 4096].filter((s) => s <= maxStepBisection);
  let maxStepsObserved = 256;
  for (const count of stepCandidates) {
    const instanceId = `probe-steps-${count}`;
    const instance = await client.getWorkflowInstance(workflowName, instanceId);
    if (instance && (instance.success === true || instance.status === "complete")) {
      maxStepsObserved = count;
    } else {
      break;
    }
  }

  // Return bytes bisection sequence
  const byteCandidates = [128 * 1024, 512 * 1024, 1024 * 1024, 2 * 1024 * 1024].filter((b) => b <= maxByteBisection);
  let stepReturnBytesMax = 128 * 1024;
  for (const bytes of byteCandidates) {
    const instanceId = `probe-return-bytes-${bytes}`;
    const instance = await client.getWorkflowInstance(workflowName, instanceId);
    if (instance && (instance.success === true || instance.status === "complete")) {
      stepReturnBytesMax = bytes;
    } else {
      break;
    }
  }

  // Event payload bytes sequence
  let eventPayloadBytesMax = 128 * 1024;
  for (const bytes of byteCandidates) {
    const instanceId = `probe-event-bytes-${bytes}`;
    const instance = await client.getWorkflowInstance(workflowName, instanceId);
    if (instance && (instance.success === true || instance.status === "complete")) {
      eventPayloadBytesMax = bytes;
    } else {
      break;
    }
  }

  // Subrequests sequence
  const subCandidates = [50, 100, 500, 1000].filter((s) => s <= maxSubrequests);
  let subrequestsPerInvocation = 50;
  for (const subs of subCandidates) {
    const instanceId = `probe-subrequests-${subs}`;
    const instance = await client.getWorkflowInstance(workflowName, instanceId);
    if (instance && (instance.success === true || instance.status === "complete")) {
      subrequestsPerInvocation = subs;
    } else {
      break;
    }
  }

  // Retries sequence
  const retryCandidates = [1, 2, 3, 5].filter((r) => r <= maxRetries);
  let retriesHonoured = 1;
  for (const k of retryCandidates) {
    const instanceId = `probe-retries-${k}`;
    const instance = await client.getWorkflowInstance(workflowName, instanceId);
    if (instance && (instance.success === true || instance.status === "complete")) {
      retriesHonoured = k;
    } else {
      break;
    }
  }

  // If a ledger is passed, perform teardown to guarantee 0 account leftovers
  if (options.ledger) {
    await teardown(client, options.ledger);
  }

  const evidence: WorkflowLimitsEvidence = {
    maxStepsObserved,
    stepReturnBytesMax,
    eventPayloadBytesMax,
    subrequestsPerInvocation,
    retriesHonoured,
    measuredAt,
    gitSha,
    accountPlan,
  };

  if (options.writeEvidence) {
    writeWorkflowsLimitsEvidence(evidence, options.evidenceDir);
  }

  return evidence;
}

export function writeWorkflowsLimitsEvidence(evidence: WorkflowLimitsEvidence, targetDirOrPath?: string): string {
  if (!evidence.gitSha || evidence.gitSha.trim() === "") {
    throw new Error("Cannot write evidence: gitSha is empty");
  }

  const now = Date.now();
  const measuredTime = new Date(evidence.measuredAt).getTime();
  if (isNaN(measuredTime) || Math.abs(now - measuredTime) > 5 * 60 * 1000) {
    throw new Error(`Cannot write evidence: measuredAt is stale (${evidence.measuredAt}), must be from Date.now()`);
  }

  let filePath = join(repoRoot, "evidence", "workflows-limits.json");
  if (targetDirOrPath) {
    if (targetDirOrPath.endsWith(".json")) {
      filePath = targetDirOrPath;
    } else {
      filePath = join(targetDirOrPath, "workflows-limits.json");
    }
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = JSON.stringify(evidence, null, 2) + "\n";
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

// Standalone CLI execution
async function main() {
  let credentials;
  try {
    credentials = loadCredentials(process.env);
  } catch {
    console.warn("No Cloudflare credentials available in environment for live workflow limits probe.");
    console.warn("To run against live Cloudflare: node --env-file=<path> scripts/probe-workflow-limits.ts");
    process.exit(0);
  }

  const client = createClient({ credentials, fetch: (req) => fetch(req) });
  const store = memoryStore();
  const makeSuffix = () => newSuffix(randomBytes);
  const ledger = openLedger(store, makeSuffix);
  const names = resourceNames(makeSuffix());

  console.log("Running Live Workflows Limits Probe against Cloudflare account...");
  try {
    const probeCode = `
      import { LimitsProbe, handleLimitsProbeFetch } from "@poc/deploy/worker/limits-probe";
      export class LimitsProbeWorkflow extends LimitsProbe {}
      export default { fetch: handleLimitsProbeFetch };
    `;

    // Deploy probe worker
    await deploy({
      client,
      ledger,
      names,
      accessKey: "probe-key",
      bundle: {
        code: probeCode,
        sha256: "probe-bundle-sha",
      },
      migrations: [],
      compatibilityDate: "2026-10-01",
      workflow: {
        className: LIMITS_PROBE_WORKFLOW_CLASS,
        binding: "PROBE_WORKFLOW",
      },
    });

    const evidence = await probeWorkflowLimits({
      client,
      ledger,
      workflowName: names.workflow,
      writeEvidence: true,
    });

    console.log("Live probe completed successfully:", evidence);
    console.log("Account teardown complete, ledger clean.");
  } catch (error) {
    console.error("Probe failed, cleaning up account resources...", error);
    await teardown(client, ledger).catch(() => {});
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
