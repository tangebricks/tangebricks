import { inRange } from "./range.ts";
import type { Hypothesis } from "./schema.ts";

/** What a test run reports for one hypothesis. */
export interface Result {
  measured?: number;
  checks?: Record<string, boolean>;
}

export type VerdictName = "pass" | "fail" | "kill" | "pending";

export interface Outcome {
  verdict: VerdictName;
  reasons: string[];
}

/**
 * Turns a reported result into a verdict using only the committed thresholds.
 * kill beats fail beats pass; a hypothesis with no thresholds or no result is pending.
 */
export function verdict(h: Hypothesis, result: Result | undefined): Outcome {
  if (h.status === "pending") return { verdict: "pending", reasons: ["no thresholds committed yet"] };
  if (!result) return { verdict: "pending", reasons: ["no result recorded"] };

  const reasons: string[] = [];
  let killed = false;
  let failed = false;
  const checks = result.checks ?? {};

  for (const name of h.mustHold) {
    const value = checks[name];
    if (value === undefined) {
      failed = true;
      reasons.push(`check not reported: ${name}`);
    } else if (!value) {
      failed = true;
      reasons.push(`check false: ${name}`);
      if (h.killIfFalse.includes(name)) killed = true;
    }
  }

  // Extra evidence: it can overturn a verdict (false is a kill) but its absence changes nothing, except that the
  // scoreboard says so, so nobody mistakes "not run" for "run and fine".
  for (const name of h.killIfFalseWhenReported ?? []) {
    const value = checks[name];
    if (value === undefined) reasons.push(`extra check not yet run: ${name}`);
    else if (!value) {
      killed = true;
      reasons.push(`check false: ${name} (extra evidence)`);
    }
  }

  if (h.metric) {
    const measured = result.measured;
    if (measured === undefined) {
      failed = true;
      reasons.push(`${h.metric.name} not measured`);
    } else {
      if (h.kill && inRange(measured, h.kill)) {
        killed = true;
        reasons.push(`${h.metric.name}=${measured} is in the kill range`);
      }
      if (h.pass && !inRange(measured, h.pass)) {
        failed = true;
        reasons.push(`${h.metric.name}=${measured} is outside the pass range`);
      }
    }
  }

  return { verdict: killed ? "kill" : failed ? "fail" : "pass", reasons };
}

/**
 * A hypothesis whose own test file has a failing test cannot be reported as pass or pending, even if its
 * report test passed: another test in that file may be the only evidence for part of the claim. A kill or
 * fail already stands; this only downgrades.
 */
export function withFailedFile(outcome: Outcome, failedFile: string | undefined): Outcome {
  if (!failedFile || outcome.verdict === "kill" || outcome.verdict === "fail") return outcome;
  return { verdict: "fail", reasons: [`${failedFile} has a failing test or failed to load`] };
}
