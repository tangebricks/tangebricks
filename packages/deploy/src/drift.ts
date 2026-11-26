// Drift detection for a deployed environment, kept out of target.ts (refactor-sweep line budget, story 1.3).
import { DeployTargetSchema, MockCloudflareControlPlane, deriveEnvironmentResourceNames } from "./target.ts";
import type { CloudflareApiClient, DeployTarget, TokenResolver } from "./target.ts";

export interface OutOfBandDriftItem {
  resource: "worker" | "d1" | "queue" | "cron";
  expected: string;
  actual: string | null;
  message: string;
}

export interface BlueprintDriftReport {
  hasCodeDrift: boolean;
  hasGraphDrift: boolean;
  deployedRev: number;
  currentRev: number;
  deployedBuildHash?: string | null;
  currentBuildHash?: string;
  deployedCodeHash?: string | null;
  currentCodeHash?: string;
  deployedGraphHash?: string | null;
  currentGraphHash?: string;
}

export interface DriftReport {
  inSync: boolean;
  blueprintDrift: BlueprintDriftReport;
  outOfBandDrift: OutOfBandDriftItem[];
  checkedAt: string;
}

export interface ExpectedDeploymentState {
  project: string;
  deployedRev?: number | null;
  buildHash?: string | null;
  codeHash?: string | null;
  graphHash?: string | null;
  appliedMigrations?: string[];
  queues?: string[];
  cronTriggers?: string[];
  scriptName?: string;
  databaseName?: string;
  /** The hash of the Worker bundle actually uploaded (real client). When given, the account's Worker is compared against it instead of codeHash. */
  liveCodeHash?: string | null;
  /** Version ids Studio made itself (see GetScriptOptions). */
  trustedVersionIds?: readonly string[];
}

export interface CurrentBlueprintHashes {
  currentRev: number;
  buildHash?: string;
  codeHash: string;
  graphHash: string;
}

export async function checkEnvironmentDrift(
  rawTarget: DeployTarget,
  expectedDeployment: ExpectedDeploymentState,
  currentBlueprintHashes: CurrentBlueprintHashes,
  apiClient?: CloudflareApiClient,
  options?: {
    token?: string;
    resolveToken?: TokenResolver;
    actor?: string;
    deployId?: string;
  },
): Promise<DriftReport> {
  const target = DeployTargetSchema.parse(rawTarget);
  const { scriptName: defaultScriptName, databaseName: defaultDbName } =
    deriveEnvironmentResourceNames(expectedDeployment.project, target);
  const scriptName = expectedDeployment.scriptName ?? defaultScriptName;
  const databaseName = expectedDeployment.databaseName ?? defaultDbName;

  const hasBeenDeployed = Boolean(
    expectedDeployment.deployedRev !== null &&
      expectedDeployment.deployedRev !== undefined &&
      (expectedDeployment.buildHash || expectedDeployment.codeHash),
  );

  const deployedRev = expectedDeployment.deployedRev ?? 0;
  const currentRev = currentBlueprintHashes.currentRev;
  const expectedCodeHash =
    expectedDeployment.codeHash ?? expectedDeployment.buildHash ?? null;
  const expectedGraphHash = expectedDeployment.graphHash ?? null;

  const hasCodeDrift = hasBeenDeployed
    ? Boolean(
        expectedCodeHash &&
          expectedCodeHash !== currentBlueprintHashes.codeHash,
      )
    : false;
  const hasGraphDrift = hasBeenDeployed
    ? Boolean(
        expectedGraphHash &&
          expectedGraphHash !== currentBlueprintHashes.graphHash,
      )
    : false;

  const outOfBandDrift: OutOfBandDriftItem[] = [];

  if (apiClient && hasBeenDeployed && target.type === "byoc") {
    let token = options?.token ?? null;
    if (!token && options?.resolveToken) {
      token = await options.resolveToken(target.tokenRef, {
        actor: options.actor ?? "studio_drift_checker",
        deployId: options.deployId ?? "drift_check",
        action: "checkDrift",
      });
    }
    if (!token && apiClient instanceof MockCloudflareControlPlane) {
      token = apiClient.findActiveTokenForAccount(target.accountId);
    }

    if (token) {
      const liveScript = await apiClient.getScript(
        target.accountId,
        token,
        scriptName,
        expectedDeployment.trustedVersionIds ? { trustedVersionIds: expectedDeployment.trustedVersionIds } : undefined,
      );
      if (expectedCodeHash) {
        if (!liveScript) {
          outOfBandDrift.push({
            resource: "worker",
            expected: expectedCodeHash,
            actual: null,
            message: `Worker script "${scriptName}" was deleted or is missing in Cloudflare account (expected ${expectedCodeHash.slice(0, 12)}).`,
          });
        } else {
          const liveScriptHash = liveScript.codeHash ?? liveScript.sha256;
          const expectedLive = expectedDeployment.liveCodeHash ?? expectedCodeHash;
          if (
            liveScript.sha256 !== expectedLive &&
            liveScriptHash !== expectedLive
          ) {
            outOfBandDrift.push({
              resource: "worker",
              expected: expectedLive,
              actual: liveScript.sha256,
              message: `Worker script "${scriptName}" hash modified out-of-band in Cloudflare (expected ${expectedCodeHash.slice(0, 12)}, found ${liveScript.sha256.slice(0, 12)}).`,
            });
          }
        }
      }

      if (expectedDeployment.appliedMigrations !== undefined) {
        const liveDb = apiClient.getDatabase
          ? await apiClient.getDatabase(target.accountId, token, databaseName)
          : null;
        const expectedMigs = expectedDeployment.appliedMigrations;
        if (!liveDb && expectedMigs.length > 0) {
          outOfBandDrift.push({
            resource: "d1",
            expected: expectedMigs.join(", "),
            actual: null,
            message: `D1 database "${databaseName}" is missing in Cloudflare account.`,
          });
        } else if (liveDb) {
          const liveMigs = liveDb.appliedMigrations.map((m) => m.name);
          if (expectedMigs.join(",") !== liveMigs.join(",")) {
            outOfBandDrift.push({
              resource: "d1",
              expected: expectedMigs.join(", ") || "(none)",
              actual: liveMigs.join(", ") || null,
              message: `D1 _px_migrations state on "${databaseName}" drifted out-of-band (expected [${expectedMigs.join(", ")}], found [${liveMigs.join(", ")}]).`,
            });
          }
        }
      }

      if (
        expectedDeployment.queues &&
        expectedDeployment.queues.length > 0 &&
        apiClient.listQueues
      ) {
        const liveQueues = (
          await apiClient.listQueues(target.accountId, token)
        ).map((q) => q.queueName);
        const missingQueues = expectedDeployment.queues.filter(
          (q) => !liveQueues.includes(q),
        );
        if (missingQueues.length > 0) {
          outOfBandDrift.push({
            resource: "queue",
            expected: expectedDeployment.queues.join(", "),
            actual: liveQueues.length > 0 ? liveQueues.join(", ") : null,
            message: `Cloudflare Queue(s) missing out-of-band: ${missingQueues.join(", ")}.`,
          });
        }
      }

      if (
        expectedDeployment.cronTriggers &&
        expectedDeployment.cronTriggers.length > 0
      ) {
        const liveCrons =
          apiClient instanceof MockCloudflareControlPlane
            ? await apiClient.getCronTriggers(
                target.accountId,
                token,
                scriptName,
              )
            : (liveScript?.cronTriggers ?? []);
        const expectedSorted = [...expectedDeployment.cronTriggers]
          .sort()
          .join(", ");
        const actualSorted = [...liveCrons].sort().join(", ");
        if (expectedSorted !== actualSorted) {
          outOfBandDrift.push({
            resource: "cron",
            expected: expectedSorted,
            actual: actualSorted || null,
            message: `Cron triggers on "${scriptName}" drifted out-of-band (expected [${expectedSorted}], found [${actualSorted || "none"}]).`,
          });
        }
      }
    }
  }

  const inSync =
    !hasCodeDrift && !hasGraphDrift && outOfBandDrift.length === 0;

  return {
    inSync,
    blueprintDrift: {
      hasCodeDrift,
      hasGraphDrift,
      deployedRev,
      currentRev,
      deployedBuildHash: expectedDeployment.buildHash ?? null,
      currentBuildHash:
        currentBlueprintHashes.buildHash ?? currentBlueprintHashes.codeHash,
      deployedCodeHash: expectedDeployment.codeHash ?? null,
      currentCodeHash: currentBlueprintHashes.codeHash,
      deployedGraphHash: expectedDeployment.graphHash ?? null,
      currentGraphHash: currentBlueprintHashes.graphHash,
    },
    outOfBandDrift,
    checkedAt: new Date().toISOString(),
  };
}
