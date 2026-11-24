import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalog } from "../../packages/assembler/catalog.generated.ts";
import type { IntegrationManifestFile } from "../../packages/assembler/src/schemas.ts";
import {
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  rehearseStep,
} from "../../packages/runtime/src/index.ts";
import type { Executor, Executors } from "../../packages/sdk/src/index.ts";
import { redactTelemetryPayload } from "../../packages/telemetry/src/index.ts";
import {
  getEvidenceDir,
  getGitSha,
  stampEvidence,
  writeEvidence,
} from "./evidence-stamp.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface CanaryOperationSpec {
  operationId: string;
  inputs?: Record<string, unknown>;
  expect?: {
    status?: number;
    jsonPath?: string;
  };
  sandboxOnly?: boolean;
}

export interface CanaryWebhookSpec {
  trigger: string;
  sendVia: "provider-test-endpoint" | "skip";
}

export interface CanaryPlan {
  app: string;
  secretEnv: string;
  operations: CanaryOperationSpec[];
  webhook?: CanaryWebhookSpec;
}

export interface CanaryOperationResult {
  operationId: string;
  httpStatus: number;
  durationMs: number;
  error?: string;
}

export interface CanaryResult {
  app: string;
  status: "pass" | "fail" | "skipped";
  reason?: string;
  verifiedAt?: string;
  gitSha?: string;
  operations: CanaryOperationResult[];
  provenance?: unknown;
}

export interface CanaryRunOptions {
  env?: Record<string, string | undefined>;
  evidenceDir?: string;
  planPath?: string;
  plan?: CanaryPlan;
  fetcher?: typeof fetch;
  executors?: Executors;
  log?: (msg: string) => void;
}

export interface IsLiveVerifiedOptions {
  evidenceDir?: string;
  policyPath?: string;
}

export const LIVE_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk)_live_[A-Za-z0-9]+/i,
  /\bwhsec_live_[A-Za-z0-9]+/i,
  /\blive_secret_[A-Za-z0-9]+/i,
];

/**
 * Throws CANARY_LIVE_CREDENTIAL_REFUSED if the secret matches known live production key patterns.
 */
export function refuseLiveCredentials(secret: string): void {
  if (!secret || typeof secret !== "string") return;
  for (const pattern of LIVE_CREDENTIAL_PATTERNS) {
    if (pattern.test(secret)) {
      throw new Error(
        `CANARY_LIVE_CREDENTIAL_REFUSED: Secret matches live production credential pattern (${pattern.source})`,
      );
    }
  }
}

/**
 * Validates a canary plan against safety rules:
 * - Read-only or sandbox-safe operations only.
 * - Any operation with sideEffects: "write" MUST declare sandboxOnly: true.
 */
export function validateCanaryPlan(
  plan: CanaryPlan,
  manifest?: IntegrationManifestFile,
): void {
  if (!plan.app) throw new Error("CanaryPlan must define 'app'");
  if (!plan.secretEnv) throw new Error("CanaryPlan must define 'secretEnv'");
  if (!Array.isArray(plan.operations)) {
    throw new Error("CanaryPlan must define 'operations' array");
  }

  for (const op of plan.operations) {
    if (!op.operationId) {
      throw new Error("Canary operation must define 'operationId'");
    }

    let isWrite = false;
    if (manifest) {
      const found = manifest.operations.find((o) => o.operationId === op.operationId);
      if (found) {
        isWrite =
          found.sideEffects === "write" ||
          ["POST", "PUT", "PATCH", "DELETE"].includes(found.method.toUpperCase());
      }
    } else {
      if (/^(create|update|delete|cancel|confirm|send|insert|patch|post|put)/i.test(op.operationId)) {
        isWrite = true;
      }
    }

    if (isWrite && op.sandboxOnly !== true) {
      throw new Error(
        `Canary plan operation '${op.operationId}' has write sideEffects but lacks 'sandboxOnly: true'`,
      );
    }
  }
}

/**
 * Returns true only if the app's evidence file exists, status is "pass", and verifiedAt is within the policy window.
 */
export function isLiveVerified(
  app: string,
  now: Date | string = new Date(),
  options: IsLiveVerifiedOptions = {},
): boolean {
  const evidenceDir = options.evidenceDir ?? resolve(repoRoot, "evidence/live-canary");
  const evidencePath = join(evidenceDir, `${app}.json`);
  if (!existsSync(evidencePath)) return false;

  let content: any;
  try {
    content = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch {
    return false;
  }

  if (content.status !== "pass") return false;
  if (!content.verifiedAt || typeof content.verifiedAt !== "string") return false;

  const verifiedAtTime = Date.parse(content.verifiedAt);
  if (isNaN(verifiedAtTime)) return false;

  const nowDate = typeof now === "string" ? new Date(now) : now;
  const nowTime = nowDate.getTime();

  let maxAgeDays = 7;
  const policyPath = options.policyPath ?? resolve(repoRoot, "scripts/tier-policy.json");
  if (existsSync(policyPath)) {
    try {
      const policy = JSON.parse(readFileSync(policyPath, "utf8"));
      if (typeof policy.liveVerifiedMaxAgeDays === "number") {
        maxAgeDays = policy.liveVerifiedMaxAgeDays;
      }
    } catch {}
  }

  const ageDays = (nowTime - verifiedAtTime) / (1000 * 60 * 60 * 24);
  if (ageDays > maxAgeDays || ageDays < 0) {
    return false;
  }

  return true;
}

function saveCanaryEvidence(
  evidenceDir: string,
  app: string,
  result: CanaryResult,
): void {
  mkdirSync(evidenceDir, { recursive: true });
  const targetPath = join(evidenceDir, `${app}.json`);
  let prov;
  try {
    prov = stampEvidence("scripts/integrations-live-canary.ts", "measured");
  } catch {
    prov = {
      generatedAt: new Date().toISOString(),
      gitSha: result.gitSha ?? "0000000000000000000000000000000000000000",
      gitDirty: false,
      generator: "scripts/integrations-live-canary.ts",
      inputKind: "measured" as const,
    };
  }

  writeEvidence(targetPath, result, prov);
}

/**
 * Runs a single integration's live canary plan.
 */
export async function runAppCanary(
  app: string,
  options: CanaryRunOptions = {},
): Promise<CanaryResult> {
  const env = options.env ?? process.env;
  const evidenceDir = options.evidenceDir ?? resolve(repoRoot, "evidence/live-canary");
  const planPath = options.planPath ?? resolve(repoRoot, "integrations", app, "canary.json");

  let plan: CanaryPlan;
  if (options.plan) {
    plan = options.plan;
  } else {
    if (!existsSync(planPath)) {
      throw new Error(`Canary plan not found for app '${app}' at ${planPath}`);
    }
    plan = JSON.parse(readFileSync(planPath, "utf8")) as CanaryPlan;
  }

  const manifestEntry = catalog.integrations?.[app];
  validateCanaryPlan(plan, manifestEntry?.manifest);

  const secret = env[plan.secretEnv]?.trim();
  if (!secret) {
    const skippedResult: CanaryResult = {
      app,
      status: "skipped",
      reason: "CANARY_SECRET_MISSING",
      operations: [],
    };
    saveCanaryEvidence(evidenceDir, app, skippedResult);
    return skippedResult;
  }

  refuseLiveCredentials(secret);

  const registry = buildRegistryFromCatalog(catalog);
  const executors =
    options.executors ??
    (options.fetcher
      ? buildExecutorsFromCatalog(catalog, { integration: { fetcher: options.fetcher } })
      : buildExecutorsFromCatalog(catalog));

  const opResults: CanaryOperationResult[] = [];
  let allPassed = true;

  for (const op of plan.operations) {
    const t0 = performance.now();
    const nodeType = `int:${app}.${op.operationId}`;
    let httpStatus = 500;
    let error: string | undefined;

    try {
      const res = await rehearseStep(
        {
          nodeId: `canary_${app}_${op.operationId}`,
          nodeType,
          config: {},
          input: op.inputs ?? {},
        },
        {
          registry,
          executors,
          connections: {
            [app]: {
              app,
              accessToken: secret,
            },
          },
        },
      );

      httpStatus = Number(res.output?.status ?? (res.ok ? 200 : 500));
      const expectedStatus = op.expect?.status ?? 200;
      const statusMatches =
        expectedStatus >= 200 && expectedStatus < 300
          ? httpStatus >= 200 && httpStatus < 300
          : httpStatus === expectedStatus;

      if (!res.ok || !statusMatches) {
        allPassed = false;
        error = res.error?.message ?? `Expected HTTP ${expectedStatus}, got ${httpStatus}`;
      }
    } catch (err: any) {
      allPassed = false;
      error = err.message ?? String(err);
    }

    const durationMs = Math.round((performance.now() - t0) * 100) / 100;
    opResults.push({
      operationId: op.operationId,
      httpStatus,
      durationMs,
      ...(error ? { error } : {}),
    });
  }

  let gitSha: string;
  try {
    gitSha = getGitSha();
  } catch {
    gitSha = "0000000000000000000000000000000000000000";
  }
  const verifiedAt = new Date().toISOString();

  const rawResult: CanaryResult = {
    app,
    status: allPassed ? "pass" : "fail",
    verifiedAt,
    gitSha,
    operations: opResults,
  };

  // Scrub any secret values using UC1.5 telemetry redaction
  const sanitizedResult = redactTelemetryPayload(rawResult, {
    secretValues: [secret],
  }) as CanaryResult;

  saveCanaryEvidence(evidenceDir, app, sanitizedResult);
  return sanitizedResult;
}

/**
 * Runs canaries for all registered integrations.
 */
export async function runAllCanaries(
  options: CanaryRunOptions = {},
): Promise<Record<string, CanaryResult>> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const results: Record<string, CanaryResult> = {};
  const apps = Object.keys(catalog.integrations ?? {}).sort();

  for (const app of apps) {
    log(`[live-canary] Running canary for ${app}...`);
    try {
      const res = await runAppCanary(app, options);
      results[app] = res;
      log(`[live-canary] ${app}: ${res.status.toUpperCase()} ${res.reason ? `(${res.reason})` : ""}`);
    } catch (err: any) {
      log(`[live-canary] ${app} ERROR: ${err.message}`);
      throw err;
    }
  }

  return results;
}
