import { createHash } from "node:crypto";
import type { ProjectLock } from "@poc/assembler";
import { describePlan, planLockChanges, planMigrations } from "./plan-core.ts";
import type { PlannedBrick, PlannedMigration, PlannedSetting } from "./plan-core.ts";
import { DEPLOY_HISTORY_TABLE, DEPLOY_TABLE, MIGRATIONS_TABLE, fingerprintOf, readAccountState, uploadMetadata } from "./deploy.ts";
import type { DeployInput } from "./deploy.ts";

// A read-only preview of what deploy() would change: every call made here is a GET or a SELECT (isWriteCall is false for all
// of them), so a plan can be shown to the owner, or refused, before anything in the account is touched. deploy() calls it first
// whenever it is given the project's lock, and refuses what the plan lists as blocking.

export type { BrickChangeKind, PlannedBrick, PlannedMigration, PlannedSetting } from "./plan-core.ts";
/** Why the Worker would be uploaded again. "new" = no Worker yet; "drift" = Cloudflare's newest version is not the one this tool recorded. */
export type WorkerReason = "new" | "bundle" | "bindings" | "config" | "drift";
export interface DeployPlan {
  migrations: PlannedMigration[];
  bricks: PlannedBrick[];
  settings: PlannedSetting[];
  settingsUpgrade?: { errors: string[]; warnings: string[] };
  worker: { changed: boolean; reasons: WorkerReason[] };
  workflow: { action: "none" | "register" | "update" };
  /** The version a rollback would return to: the one live now. Null when nothing is deployed yet. */
  rollbackTo: string | null;
  /** What deploy() refuses to do without being told otherwise: destructive migrations, unacknowledged major bumps, settings errors. */
  blocking: string[];
  empty: boolean;
}
export type DeployPlanInput = DeployInput & { lock: ProjectLock };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The lock stored with the deploy that is live now (or, failing that, the newest successful one); null when none was stored. */
export async function readDeployedLock(client: DeployInput["client"], databaseId: string, liveVersionId: string | null): Promise<ProjectLock | null> {
  const [table] = await client.queryDatabase(databaseId, [{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", params: [DEPLOY_HISTORY_TABLE] }]);
  if (table!.results.length === 0) return null;
  const [columns] = await client.queryDatabase(databaseId, [{ sql: `SELECT name FROM pragma_table_info('${DEPLOY_HISTORY_TABLE}') WHERE name = 'lock_json'` }]);
  if (columns!.results.length === 0) return null;
  const select = `SELECT lock_json FROM ${DEPLOY_HISTORY_TABLE} WHERE lock_json IS NOT NULL AND status = 'success'`;
  if (liveVersionId) {
    const [row] = await client.queryDatabase(databaseId, [{ sql: `${select} AND to_version_id = ? ORDER BY started_at DESC LIMIT 1`, params: [liveVersionId] }]);
    if (row!.results[0]) return JSON.parse(String(row!.results[0].lock_json)) as ProjectLock;
  }
  const [latest] = await client.queryDatabase(databaseId, [{ sql: `${select} ORDER BY started_at DESC LIMIT 1` }]);
  return latest!.results[0] ? (JSON.parse(String(latest!.results[0].lock_json)) as ProjectLock) : null;
}

export async function planDeploy(input: DeployPlanInput): Promise<DeployPlan> {
  const { client, names, lock } = input;
  const blocking: string[] = [];
  const state = await readAccountState(client, names);
  const databaseId = state.databaseId;

  // what the live deploy recorded
  let recorded: { upload_sha256?: string; version_id?: string; last_good_version_id?: string } | undefined;
  if (databaseId) {
    const [table] = await client.queryDatabase(databaseId, [{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", params: [DEPLOY_TABLE] }]);
    if (table!.results.length > 0) {
      const [row] = await client.queryDatabase(databaseId, [{ sql: `SELECT upload_sha256, version_id, last_good_version_id FROM ${DEPLOY_TABLE} WHERE id = 1` }]);
      recorded = row!.results[0] as typeof recorded;
    }
  }
  const deployedLock = databaseId ? await readDeployedLock(client, databaseId, recorded?.version_id ?? null) : null;

  // migrations: what is pending, and what each is
  const applied = new Map<string, string | null>();
  if (databaseId && state.appliedMigrations.length > 0) {
    const [rows] = await client.queryDatabase(databaseId, [{ sql: `SELECT name, sha256 FROM ${MIGRATIONS_TABLE}` }]);
    for (const r of rows!.results) applied.set(String(r.name), String(r.sha256));
  }
  const allowDestructive = input.allowDestructive === true || input.ledger.entries().some((e) => e.kind === "allow_destructive" || e.name === "allow_destructive");
  const migrationPlan = planMigrations(input.migrations, applied, { allowDestructive, hashOf: sha256 });
  const migrations: PlannedMigration[] = migrationPlan.migrations;
  blocking.push(...migrationPlan.blocks.map((b) => b.message));

  // bricks and settings, against the lock stored with the live deploy
  const lockPlan = planLockChanges(deployedLock, lock, { allowMajor: input.allowMajor, ...(input.catalog ? { catalog: input.catalog } : {}) });
  const bricks: PlannedBrick[] = lockPlan.bricks;
  const settings: PlannedSetting[] = lockPlan.settings;
  const settingsUpgrade = lockPlan.settingsUpgrade;
  blocking.push(...lockPlan.blocks.map((b) => b.message));

  // the Worker
  const reasons: WorkerReason[] = [];
  const live = state.latestVersionId;
  if (!databaseId || live === null) {
    reasons.push("new");
  } else {
    const fingerprint = fingerprintOf(input, databaseId);
    const upToDate = recorded?.upload_sha256 === fingerprint && recorded?.version_id === live;
    if (!upToDate) {
      if (recorded?.version_id !== live) reasons.push("drift");
      const versions = (await client.listVersions(names.script)) ?? [];
      const liveVersion = versions.find((v) => v.id === (recorded?.version_id ?? live));
      const annotations = (liveVersion?.metadata as { annotations?: Record<string, string> } | undefined)?.annotations;
      if (annotations?.["workers/message"] !== `projectx-poc ${input.bundle.sha256}`) reasons.push("bundle");
      const wanted = uploadMetadata(input, databaseId, true).bindings.map(shapeBinding).sort(byName);
      const have = ((await client.getScriptBindings(names.script)) ?? []).map(shapeDeployedBinding).sort(byName);
      if (JSON.stringify(wanted) !== JSON.stringify(have)) reasons.push("bindings");
      if (reasons.filter((r) => r !== "drift").length === 0) reasons.push("config");
    }
  }
  const worker = { changed: reasons.length > 0, reasons };

  // the Workflow
  let action: DeployPlan["workflow"]["action"] = "none";
  if (input.workflow) {
    const registered = (await client.listWorkflowDefinitions()).find((w) => w.name === names.workflow);
    const current = registered !== undefined && registered.className === input.workflow.className && registered.scriptName === names.script;
    if (!registered) action = "register";
    else if (!current || worker.changed) action = "update";
  }

  const rollbackTo = recorded?.last_good_version_id ?? recorded?.version_id ?? null;
  const empty = migrations.length === 0 && bricks.length === 0 && settings.length === 0 && !worker.changed && action === "none" && blocking.length === 0;
  return { migrations, bricks, settings, ...(settingsUpgrade ? { settingsUpgrade } : {}), worker, workflow: { action }, rollbackTo, blocking, empty };
}

type Shaped = { type: string; name: string; workflowName?: string; className?: string };
const byName = (a: Shaped, b: Shaped) => a.name.localeCompare(b.name);
/** A binding as this tool would upload it, reduced to what Cloudflare reports back (no ids, no secret text). */
function shapeBinding(b: Record<string, unknown>): Shaped {
  return { type: String(b.type), name: String(b.name), ...(b.type === "workflow" ? { workflowName: String(b.workflow_name), className: String(b.class_name) } : {}) };
}
function shapeDeployedBinding(b: Shaped): Shaped {
  return { type: b.type, name: b.name, ...(b.type === "workflow" ? { workflowName: b.workflowName as string, className: b.className as string } : {}) };
}

/** The plan as text for a person: one line per difference. */
export function formatPlan(plan: DeployPlan): string {
  return describePlan(plan);
}
