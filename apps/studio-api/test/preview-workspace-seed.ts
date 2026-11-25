// Story 1.17: a Studio run, `/run` or Test Step may name only one of the project's own preview workspaces. These tests
// run Studio on a shared `env.DB` (every project's rows in one database), which is not the project's own data store and
// is never consulted; there, a named workspace counts only when the project's own runs already name it. A test that
// runs in a named workspace first records an earlier run of the project in that workspace.
import type { D1Like } from "@poc/sdk";
import { upsertRunRecord } from "@poc/telemetry";

export async function seedPreviewWorkspace(studioDb: D1Like, project: string, ...workspaceIds: string[]): Promise<void> {
  for (const workspaceId of workspaceIds) {
    await upsertRunRecord(
      studioDb,
      {
        runId: `run_seed_${project}_${workspaceId}_${crypto.randomUUID().slice(0, 8)}`,
        workflowId: "wf_preview_workspace_seed",
        revision: 0,
        triggerType: "manual",
        workspaceId,
        status: "succeeded",
        durationMs: 0,
        retries: 0,
        startedAt: new Date().toISOString(),
      },
      { projectId: project },
    );
  }
}
