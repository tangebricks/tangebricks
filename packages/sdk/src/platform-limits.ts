export interface LimitEntry {
  limit: number;
  source: string;
  date: string;
  kind: "documented" | "measured";
}

/** Cloudflare's limit on a Worker's uncompressed size, the same on the Free and Paid plans. Source: developers.cloudflare.com/workers/platform/limits, read 2026-10-21. */
export const WORKER_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/** A Worker must parse and run its top-level code within this long or the upload is refused. Source: developers.cloudflare.com/workers/platform/limits, read 2026-10-21. */
export const STARTUP_LIMIT_MS = 1000;

/** Default fan-out threshold per output port across workflow graphs. */
export const DEFAULT_FANOUT_LIMIT = 256;

export interface PlanPlatformLimits {
  subrequests: LimitEntry;
  d1BindParams: LimitEntry;
  d1MaxStatementBytes: LimitEntry;
  d1MaxRowBytes: LimitEntry;
  steps: LimitEntry;
  stepReturnBytes: LimitEntry;
  eventPayloadBytes: LimitEntry;
  retries: LimitEntry;
}

export interface WorkflowLimitsEvidence {
  maxStepsObserved: number;
  stepReturnBytesMax: number;
  eventPayloadBytesMax: number;
  subrequestsPerInvocation: number;
  retriesHonoured: number;
  measuredAt: string;
  gitSha: string;
  accountPlan: "free" | "paid";
}

export const PLATFORM_LIMITS: { free: PlanPlatformLimits; paid: PlanPlatformLimits } = {
  free: {
    subrequests: {
      limit: 50,
      source: "https://developers.cloudflare.com/workers/platform/limits/#subrequests",
      date: "2026-10-21",
      kind: "documented",
    },
    d1BindParams: {
      limit: 100,
      source: "https://developers.cloudflare.com/d1/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    d1MaxStatementBytes: {
      limit: 1_000_000,
      source: "https://developers.cloudflare.com/d1/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    d1MaxRowBytes: {
      limit: 2_097_152,
      source: "https://developers.cloudflare.com/d1/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    steps: {
      limit: 1024,
      source: "https://developers.cloudflare.com/workflows/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    stepReturnBytes: {
      limit: 1_048_576,
      source: "https://developers.cloudflare.com/workflows/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    eventPayloadBytes: {
      limit: 1_048_576,
      source: "https://developers.cloudflare.com/workflows/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    retries: {
      limit: 5,
      source: "https://developers.cloudflare.com/workflows/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
  },
  paid: {
    subrequests: {
      limit: 1000,
      source: "https://developers.cloudflare.com/workers/platform/limits/#subrequests",
      date: "2026-10-21",
      kind: "documented",
    },
    d1BindParams: {
      limit: 100,
      source: "https://developers.cloudflare.com/d1/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    d1MaxStatementBytes: {
      limit: 1_000_000,
      source: "https://developers.cloudflare.com/d1/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    d1MaxRowBytes: {
      limit: 2_097_152,
      source: "https://developers.cloudflare.com/d1/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    steps: {
      limit: 4096,
      source: "https://developers.cloudflare.com/workflows/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    stepReturnBytes: {
      limit: 1_048_576,
      source: "https://developers.cloudflare.com/workflows/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    eventPayloadBytes: {
      limit: 1_048_576,
      source: "https://developers.cloudflare.com/workflows/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
    retries: {
      limit: 5,
      source: "https://developers.cloudflare.com/workflows/platform/limits/",
      date: "2026-10-21",
      kind: "documented",
    },
  },
};

export function getPlatformLimits(plan: "free" | "paid" = "free", evidenceOverride?: WorkflowLimitsEvidence | null): PlanPlatformLimits {
  const base = PLATFORM_LIMITS[plan] ?? PLATFORM_LIMITS.free;
  // No file access here: this module is on the runtime path (no node: imports, rule C3). Node-side callers load
  // evidence/workflows-limits.json with scripts/lib/load-workflow-limits-evidence.ts and pass it in.
  const evidence = evidenceOverride ?? null;

  if (!evidence) {
    return { ...base };
  }

  const source = "evidence/workflows-limits.json";
  const date = evidence.measuredAt;

  return {
    ...base,
    steps: {
      limit: evidence.maxStepsObserved,
      source,
      date,
      kind: "measured",
    },
    stepReturnBytes: {
      limit: evidence.stepReturnBytesMax,
      source,
      date,
      kind: "measured",
    },
    eventPayloadBytes: {
      limit: evidence.eventPayloadBytesMax,
      source,
      date,
      kind: "measured",
    },
    subrequests: {
      limit: evidence.subrequestsPerInvocation,
      source,
      date,
      kind: "measured",
    },
    retries: {
      limit: evidence.retriesHonoured,
      source,
      date,
      kind: "measured",
    },
  };
}
