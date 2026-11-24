import type { BrickManifest } from "@poc/sdk";

/**
 * The retry and timeout policy of one node step in a durable run (UC7.2). It is derived from what the node declares, so
 * a builder never has to choose it:
 *
 *   sideEffects   retries                                  timeout
 *   none          5, 1 second, exponential                 30 seconds
 *   read          4, 2 seconds, exponential                60 seconds
 *   write         3, 5 seconds, exponential, ONLY when     60 seconds
 *                 the node is idempotent; otherwise 0
 *
 * A node with no declared `sideEffects` is treated as a write, the safe reading. A node may lower the limit with
 * `retry.limit`, but nothing raises a non-idempotent write above 0 and nothing raises a limit above the default.
 */
export interface StepPolicy {
  retries: { limit: number; delay: number | string; backoff?: "constant" | "linear" | "exponential" };
  timeout: string;
}

export function stepPolicyFor(manifest: Pick<BrickManifest, "sideEffects" | "retry">, opts: { idempotent: boolean }): StepPolicy {
  const sideEffects = manifest.sideEffects ?? "write";
  let policy: StepPolicy;
  if (sideEffects === "none") {
    policy = { retries: { limit: 5, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" };
  } else if (sideEffects === "read") {
    policy = { retries: { limit: 4, delay: "2 seconds", backoff: "exponential" }, timeout: "60 seconds" };
  } else if (opts.idempotent) {
    policy = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "60 seconds" };
  } else {
    return { retries: { limit: 0, delay: 0 }, timeout: "60 seconds" };
  }
  const lowered = manifest.retry?.limit;
  if (typeof lowered === "number" && Number.isInteger(lowered) && lowered >= 0 && lowered < policy.retries.limit) {
    policy.retries.limit = lowered;
  }
  return policy;
}

/** Parses duration strings like "1 second", "2 seconds", "500ms" to milliseconds. */
export function parseDurationMs(delay: string | number): number {
  if (typeof delay === "number") return delay;
  const match = delay.match(/^(\d+(?:\.\d+)?)\s*(s|sec|second|seconds|ms|m|min|minute|minutes)$/i);
  if (!match) return 0;
  const val = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("s")) return Math.round(val * 1000);
  if (unit.startsWith("m") && !unit.startsWith("ms")) return Math.round(val * 60 * 1000);
  return Math.round(val);
}
