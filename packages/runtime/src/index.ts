import { catalog as defaultCatalog } from "@poc/assembler/catalog";
import { projectIntegrationToNodes } from "@poc/assembler";
import type { Catalog } from "@poc/assembler";
import { coreNodeExecutors } from "@poc/core-nodes";
import * as coreNodeExports from "@poc/core-nodes";
import { NotConfiguredError, catalogNodeToBrickManifest, isProductionEnvironment, toyRegistry } from "@poc/sdk";
import type { BrickManifest, ExecutionContext, Executor, Executors, Registry } from "@poc/sdk";
import {
  assertNoReservedDataKeys,
  callOperation,
  createIntegrationOperationExecutor,
  executeIntegrationOperation,
  getRegisteredIntegrationOperation,
  getRegisteredTokenUrlsByApp,
  IntegrationCallError,
  isRetryable,
  parseRetryDelayMs,
  projectCatalogIntegrations,
  registerCatalogIntegrations,
  registerIntegrationManifest,
  validateAndBuildTargetUrl,
} from "./integration-executor.ts";
import type {
  CallOperationOptions,
  CallOperationResult,
  IntegrationExecutorOptions,
  IntegrationFetcher,
  ParseRetryDelayResult,
} from "./integration-executor.ts";
import {
  createHardenedFetch,
  isPrivateAddress,
} from "./egress.ts";
import type { EgressPolicy } from "./egress.ts";
import {
  PX_CONNECTIONS_MIGRATION_SQL,
  computeConnectionKeyHint,
  deriveConnectionVaultKey,
  ensureConnectionsTable,
  ensurePxConnectionsTable,
  resetConnectionRefreshLocksForTest,
  resolveCaseAConnection,
  resolveCaseBWorkspaceConnection,
  sealConnectionCredentials,
  sealWorkspaceCredentialsWithAad,
  unsealConnectionCredentials,
  unsealWorkspaceCredentialsWithAad,
  upsertSealedConnection,
} from "./connections.ts";
import type {
  CaseAAuthType,
  CaseAConnectionStatus,
  ConnectionMetadataRecord,
  PxConnectionRow,
  ResolveCaseAConnectionOptions,
  SealedConnectionCredentials,
  UpsertSealedConnectionInput,
} from "./connections.ts";
import { toyExecutors } from "./toy-executors.ts";

export {
  assertNoReservedDataKeys,
  callOperation,
  createHardenedFetch,
  isPrivateAddress,
  PX_CONNECTIONS_MIGRATION_SQL,
  computeConnectionKeyHint,
  createIntegrationOperationExecutor,
  deriveConnectionVaultKey,
  ensureConnectionsTable,
  ensurePxConnectionsTable,
  executeIntegrationOperation,
  getRegisteredIntegrationOperation,
  getRegisteredTokenUrlsByApp,
  IntegrationCallError,
  isRetryable,
  parseRetryDelayMs,
  projectCatalogIntegrations,
  registerCatalogIntegrations,
  registerIntegrationManifest,
  resetConnectionRefreshLocksForTest,
  resolveCaseAConnection,
  resolveCaseBWorkspaceConnection,
  sealConnectionCredentials,
  sealWorkspaceCredentialsWithAad,
  unsealConnectionCredentials,
  unsealWorkspaceCredentialsWithAad,
  upsertSealedConnection,
  validateAndBuildTargetUrl,
};
export type {
  CallOperationOptions,
  CallOperationResult,
  CaseAAuthType,
  CaseAConnectionStatus,
  ConnectionMetadataRecord,
  EgressPolicy,
  IntegrationExecutorOptions,
  IntegrationFetcher,
  ParseRetryDelayResult,
  PxConnectionRow,
  ResolveCaseAConnectionOptions,
  SealedConnectionCredentials,
  UpsertSealedConnectionInput,
};

export {
  GraphInvalidError,
  RunRefusedError,
  isValidRunWorkspaceId,
  isTenantWorkspaceId,
  RuntimeGraphWorkflow,
  RuntimeGraphWorkflow as GraphWorkflow,
  computeDownstreamSubgraph,
  computeStrictUpstreamAncestors,
  normalizeNodePortOutput,
  runGraph,
} from "./run.ts";
export type {
  Graph,
  RunGraphOptions,
  RunResult,
  RunStep,
  StepRetryPolicy,
  TelemetryRunOptions,
} from "./run.ts";
export { parseDurationMs, stepPolicyFor } from "./step-policy.ts";
export type { StepPolicy } from "./step-policy.ts";
export {
  StepRehearsalRequestSchema,
  UpstreamOutputUnavailableError,
  WorkflowRerunRequestSchema,
  WorkflowRunRequestSchema,
  executeWorkflowRerun,
  executeWorkflowRun,
  handleStepRehearsalRequest,
  handleWorkflowRerunRequest,
  handleWorkflowRunRequest,
  rehearseStep,
} from "./rehearse.ts";
export type {
  ExecuteWorkflowRunOptions,
  RehearseStepOptions,
  StepRehearsalInput,
  StepRehearsalRequest,
  StepRehearsalResult,
  StructuredRehearsalError,
  WorkflowRerunInput,
  WorkflowRerunRequest,
  WorkflowRunInput,
  WorkflowRunRequest,
  WorkflowRunResponse,
} from "./rehearse.ts";
export {
  HealthWindowSchema,
  PX_TELEMETRY_MIGRATION,
  PX_TELEMETRY_MIGRATION_SQL,
  TELEMETRY_SIGNATURE_HEADER,
  canonicalEventsCursorPayload,
  canonicalLogsQueryPayload,
  canonicalMetricsQueryPayload,
  computeLatencyQuantiles,
  createStructuredLogger,
  handleTelemetryEventsPullRequest,
  handleTelemetryLogsPullRequest,
  handleTelemetryMetricsRequest,
  insertStructuredLog,
  queryEnvironmentMetrics,
  queryStructuredLogs,
  reconcileCloudflareAnalyticsWithD1Metrics,
  recordHttpRequestSamples,
  redactStructuredLogEntry,
  signTelemetryPayload,
  verifyTelemetrySignature,
  toMinuteBucketIso,
  upsertHttpRollup,
  upsertQueueMetrics,
} from "@poc/telemetry";
export type {
  BoundStructuredLogger,
  BrickHealthMetric,
  CloudflareAnalyticsSnapshot,
  CreateStructuredLoggerOptions,
  EnvironmentHealthSummary,
  HealthTimeSeriesBucket,
  HealthWindow,
  HttpRequestSampleInput,
  HttpRollupInput,
  LogLevel,
  LogWsFrame,
  QueueHealthMetric,
  QueueMetricInput,
  RawStructuredLogInput,
  StructuredLogEntry,
  StructuredLogQueryFilters,
  StructuredLogQueryPage,
  TopFailingWorkflowMetric,
} from "@poc/telemetry";
export { toyExecutors } from "./toy-executors.ts";
export {
  extractStepExpressionPills,
  extractTemplatePlaceholders,
  hasForbiddenSegment,
  isSafePropertySegment,
  resolveStepExpressions,
  traverseSafePropertyPath,
  validateStepExpression,
} from "./expressions.ts";
export type {
  ParsedPillExpression,
  StepExpressionValidationResult,
} from "./expressions.ts";

/**
 * TEST-ONLY placeholder executors for brick action nodes (story 0.9, R-B).
 *
 * They do no real work: the wallet debit is arithmetic on its input, the
 * outbound send reports `dispatched: true` without sending anything. They are
 * never wired by default; a test that wants them passes this object as the
 * package exports to `buildExecutorsFromCatalog`, and that call refuses them
 * when `environment` is "production".
 */
const placeholderBrickExecutorModules: Readonly<Record<string, Readonly<Record<string, Executor>>>> = {
  "@poc/credit-wallet": {
    executeWalletDebit: async (ctx) => {
      const rawAmount = typeof ctx.data.amount === "number" ? ctx.data.amount : 1;
      const amount = Math.max(1, Math.trunc(rawAmount));
      const input =
        ctx.inputs.in !== null && typeof ctx.inputs.in === "object" && !Array.isArray(ctx.inputs.in)
          ? (ctx.inputs.in as Record<string, unknown>)
          : {};
      const balanceBefore = typeof input.balance === "number" ? input.balance : 100;
      const workspaceId = ctx.workspaceId;
      if (balanceBefore < amount) {
        throw new Error(`credit-wallet.debit (${ctx.nodeId}): insufficient balance (${balanceBefore} < ${amount})`);
      }
      await ctx.log?.info(`Debited ${amount} credits from workspace wallet`, {
        operation: "debit",
        debited: amount,
        balanceBefore,
        balanceAfter: balanceBefore - amount,
        workspaceId,
      });
      return {
        out: {
          operation: "debit",
          debited: amount,
          balanceAfter: balanceBefore - amount,
          workspaceId,
        },
      };
    },
    executeWalletCredit: async (ctx) => {
      const rawAmount = typeof ctx.data.amount === "number" ? ctx.data.amount : 1;
      const amount = Math.max(1, Math.trunc(rawAmount));
      const input =
        ctx.inputs.in !== null && typeof ctx.inputs.in === "object" && !Array.isArray(ctx.inputs.in)
          ? (ctx.inputs.in as Record<string, unknown>)
          : {};
      const balanceBefore = typeof input.balance === "number" ? input.balance : 0;
      const workspaceId = ctx.workspaceId;
      await ctx.log?.info(`Credited ${amount} credits to workspace wallet`, {
        operation: "credit",
        credited: amount,
        balanceBefore,
        balanceAfter: balanceBefore + amount,
        workspaceId,
      });
      return {
        out: {
          operation: "credit",
          credited: amount,
          balanceAfter: balanceBefore + amount,
          workspaceId,
        },
      };
    },
  },
  "@poc/dynamic-entities": {
    executeEntityCreateRecord: async (ctx) => {
      const record =
        ctx.inputs.in !== null && typeof ctx.inputs.in === "object" && !Array.isArray(ctx.inputs.in)
          ? (ctx.inputs.in as Record<string, unknown>)
          : {};
      return {
        out: {
          entity: typeof ctx.data.entity === "string" ? ctx.data.entity : "record",
          created: true,
          record: { ...record },
        },
      };
    },
  },
  "@poc/in-app-notifications": {
    executeSendInAppNotification: async (ctx) => ({
      out: {
        delivered: true,
        notification: ctx.inputs.in ?? null,
      },
    }),
  },
  "@poc/omnichannel-outbound": {
    executeSendOutboundMessage: async (ctx) => ({
      out: {
        dispatched: true,
        channel: typeof ctx.data.channel === "string" ? ctx.data.channel : "email",
        message: ctx.inputs.in ?? null,
      },
    }),
  },
  "@poc/scripting-sandbox": {
    executeRunSandboxScript: async (ctx) => ({
      out: {
        scriptId: typeof ctx.data.scriptId === "string" ? ctx.data.scriptId : "default",
        output: ctx.inputs.in ?? null,
      },
    }),
  },
};

/**
 * Default executors for brick trigger nodes (story 0.9 keeps them wired by default). A trigger only hands
 * its payload to the workflow; it reports no action as done.
 */
const defaultBrickTriggerExecutors: Readonly<Record<string, Readonly<Record<string, Executor>>>> = {
  "@poc/dynamic-entities": {
    executeEntityRecordCreatedTrigger: async (ctx) => {
      const record =
        ctx.payload !== null && typeof ctx.payload === "object" && !Array.isArray(ctx.payload)
          ? (ctx.payload as Record<string, unknown>)
          : { value: ctx.payload ?? null };
      return {
        out: {
          entity: typeof ctx.data.entity === "string" ? ctx.data.entity : "record",
          record,
        },
      };
    },
  },
  "@poc/webhook-gateway": {
    executeInboundWebhookTrigger: async (ctx) => {
      const event =
        ctx.payload !== null && typeof ctx.payload === "object" && !Array.isArray(ctx.payload)
          ? (ctx.payload as Record<string, unknown>)
          : { payload: ctx.payload ?? null };
      await ctx.log?.info("Received inbound webhook trigger", {
        verified: true,
        eventKeys: Object.keys(event),
      });
      return {
        out: {
          verified: true,
          event,
        },
      };
    },
  },
};

const placeholderExecutorFns = new WeakSet<object>();
for (const mod of Object.values(placeholderBrickExecutorModules)) {
  for (const fn of Object.values(mod)) placeholderExecutorFns.add(fn);
}

/** TEST-ONLY: the placeholder brick executor modules, for a test to inject explicitly. */
export const PLACEHOLDER_BRICK_EXECUTOR_MODULES = placeholderBrickExecutorModules;

/** True when `fn` is one of the test-only placeholder brick executors. */
export function isPlaceholderExecutor(fn: unknown): boolean {
  return typeof fn === "function" && placeholderExecutorFns.has(fn);
}

/**
 * Story 0.9: refuses placeholder executors when the environment switch (`PX_ENVIRONMENT`) is production.
 * Checks by identity, so a placeholder passed in any way (package exports, base executors, a ready map) is caught.
 */
export function assertNoPlaceholderExecutors(executors: Executors, environment: string | undefined | null): void {
  if (!isProductionEnvironment(environment)) return;
  for (const [nodeType, fn] of executors) {
    if (isPlaceholderExecutor(fn)) {
      throw new NotConfiguredError(
        `placeholder executor for ${nodeType} refused: placeholder executors are test-only and cannot load when PX_ENVIRONMENT is production`,
      );
    }
  }
}

const notConfiguredExecutorFns = new WeakSet<object>();

/** True when `fn` is the explicit NOT_CONFIGURED executor wired for a brick node with no real executor. */
export function isNotConfiguredExecutor(fn: unknown): boolean {
  return typeof fn === "function" && notConfiguredExecutorFns.has(fn);
}

function notConfiguredBrickExecutor(nodeType: string, packageName: string): Executor {
  const fn: Executor = async (ctx) => {
    throw new NotConfiguredError(
      `${nodeType} (${ctx.nodeId}): no executor is configured for this brick action (package ${packageName}); nothing was done.`,
    );
  };
  notConfiguredExecutorFns.add(fn);
  return fn;
}

export function buildRegistryFromCatalog(
  catalog: Catalog = defaultCatalog,
  baseRegistry: Registry = toyRegistry,
): Registry {
  registerCatalogIntegrations(catalog);
  const merged = new Map<string, BrickManifest>(baseRegistry);
  for (const packEntry of Object.values(catalog.nodePacks ?? {})) {
    for (const node of packEntry.manifest.nodes ?? []) {
      if (!merged.has(node.type)) {
        merged.set(node.type, catalogNodeToBrickManifest(node));
      }
    }
  }
  for (const brickEntry of Object.values(catalog.bricks ?? {})) {
    for (const node of brickEntry.manifest.nodes ?? []) {
      if (!merged.has(node.type)) {
        merged.set(node.type, catalogNodeToBrickManifest(node));
      }
    }
  }
  for (const integrationEntry of Object.values(catalog.integrations ?? {})) {
    const nodes =
      integrationEntry.nodes ?? projectIntegrationToNodes(integrationEntry.manifest);
    for (const node of nodes) {
      if (!merged.has(node.type)) {
        merged.set(node.type, catalogNodeToBrickManifest(node));
      }
    }
  }
  return merged;
}

export interface BuildExecutorsFromCatalogOptions {
  readonly integration?: IntegrationExecutorOptions;
  /**
   * The deploy environment switch (`PX_ENVIRONMENT`). When it is "production",
   * placeholder executors passed as package exports are refused at load.
   */
  readonly environment?: string;
}

export function buildExecutorsFromCatalog(
  catalog: Catalog = defaultCatalog,
  packageExportsOrOptions:
    | Readonly<Record<string, Readonly<Record<string, unknown>>>>
    | BuildExecutorsFromCatalogOptions = {},
  baseExecutorsOrOptions: Executors | BuildExecutorsFromCatalogOptions = toyExecutors,
  optionsArg?: BuildExecutorsFromCatalogOptions,
): Executors {
  let packageExportsByPackage: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {};
  let baseExecutors: Executors = toyExecutors;
  let options: BuildExecutorsFromCatalogOptions | undefined = optionsArg;

  if (
    packageExportsOrOptions &&
    ("integration" in packageExportsOrOptions || "environment" in packageExportsOrOptions)
  ) {
    options = packageExportsOrOptions as BuildExecutorsFromCatalogOptions;
  } else if (packageExportsOrOptions) {
    packageExportsByPackage = packageExportsOrOptions as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }

  if (baseExecutorsOrOptions instanceof Map) {
    baseExecutors = baseExecutorsOrOptions;
  } else if (
    baseExecutorsOrOptions &&
    ("integration" in baseExecutorsOrOptions || "environment" in baseExecutorsOrOptions)
  ) {
    options = baseExecutorsOrOptions as BuildExecutorsFromCatalogOptions;
  }

  registerCatalogIntegrations(catalog);
  const merged = new Map<string, Executor>(baseExecutors);
  const genericExecutor: Executor = async (ctx) => {
    assertNoReservedDataKeys(ctx);
    const ctxWithMeta = ctx as ExecutionContext & { nodeType?: string };
    const nodeType =
      ctxWithMeta.nodeType ??
      (typeof ctx.data.nodeType === "string" ? ctx.data.nodeType : undefined) ??
      (typeof ctx.data.app === "string" && typeof ctx.data.operationId === "string"
        ? `int:${ctx.data.app}.${ctx.data.operationId}`
        : undefined);

    if (nodeType) {
      const reg = getRegisteredIntegrationOperation(nodeType);
      if (reg) {
        const bound = createIntegrationOperationExecutor(reg.manifest, reg.operation, options?.integration);
        return bound(ctx);
      }
    }

    throw new Error(
      `INTEGRATION_OPERATION_NOT_FOUND: No registered integration operation found for node "${ctx.nodeId}"${nodeType ? ` (${nodeType})` : ""}`,
    );
  };
  merged.set("integration.operation", genericExecutor);
  for (const [nodeType, fn] of coreNodeExecutors.entries()) {
    merged.set(nodeType, fn);
  }
  const allModules: Record<string, Readonly<Record<string, unknown>>> = {
    "@poc/core-nodes": coreNodeExports,
    ...packageExportsByPackage,
  };
  for (const packEntry of Object.values(catalog.nodePacks ?? {})) {
    const mod = allModules[packEntry.manifest.package];
    if (!mod) continue;
    for (const node of packEntry.manifest.nodes ?? []) {
      const candidate = mod[node.executor];
      if (typeof candidate === "function") {
        merged.set(node.type, candidate as Executor);
      }
    }
  }
  for (const brickEntry of Object.values(catalog.bricks ?? {})) {
    const pkg = brickEntry.manifest.worker.package;
    const mod = allModules[pkg];
    for (const node of brickEntry.manifest.nodes ?? []) {
      const isTrigger = (node as { role?: string }).role === "trigger";
      const candidate = mod?.[node.executor] ?? (isTrigger ? defaultBrickTriggerExecutors[pkg]?.[node.executor] : undefined);
      if (typeof candidate === "function") {
        merged.set(node.type, candidate as Executor);
      } else if (!isTrigger && !merged.has(node.type)) {
        // Story 0.9 (R-B): no real executor was supplied for this brick action, so the step fails
        // NOT_CONFIGURED instead of falling back to a placeholder that reports success.
        merged.set(node.type, notConfiguredBrickExecutor(node.type, pkg));
      }
    }
  }
  for (const integrationEntry of Object.values(catalog.integrations ?? {})) {
    for (const operation of integrationEntry.manifest.operations ?? []) {
      const nodeType = `int:${integrationEntry.manifest.app}.${operation.operationId}`;
      if (!merged.has(nodeType)) {
        merged.set(
          nodeType,
          createIntegrationOperationExecutor(
            integrationEntry.manifest,
            operation,
            options?.integration,
          ),
        );
      }
    }
  }
  assertNoPlaceholderExecutors(merged, options?.environment);
  return merged;
}
