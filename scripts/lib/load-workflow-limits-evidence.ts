import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkflowLimitsEvidence } from "../../packages/sdk/src/platform-limits.ts";

/**
 * Reads evidence/workflows-limits.json (written by `pnpm poc:probe:workflows`) when it exists. Node-only, so it lives here
 * and not in packages/sdk (the runtime path must not import node: modules). Pass the result to `getPlatformLimits(plan, evidence)`.
 */
export function loadWorkflowLimitsEvidence(repoRoot: string = process.cwd()): WorkflowLimitsEvidence | null {
  const evidencePath = resolve(repoRoot, "evidence", "workflows-limits.json");
  if (!existsSync(evidencePath)) return null;
  return JSON.parse(readFileSync(evidencePath, "utf8")) as WorkflowLimitsEvidence;
}
