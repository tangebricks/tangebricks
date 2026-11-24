import { checkSettingsUpgrade } from "@poc/assembler";
import type { Catalog, ProjectLock } from "@poc/assembler";
import { lintMigration } from "../migration-lint.ts";
import type { MigrationClass } from "../migration-lint.ts";

// The pure part of a deploy plan: no network, no clock, no Node built-ins. planDeploy (the provisioner, which reads the account)
// and Studio's BYOC plan in target.ts (which reads it through another client) both call these, so there is one implementation of
// what a migration is, what a brick move is and which of them block a deploy.

export type BrickChangeKind = "major" | "minor" | "patch" | "added" | "removed" | "changed";
export interface PlannedMigration {
  name: string;
  class: MigrationClass;
}
export interface PlannedBrick {
  id: string;
  from: string | null;
  to: string | null;
  kind: BrickChangeKind;
}
export interface PlannedSetting {
  brick: string;
  key: string;
  from: unknown;
  to: unknown;
}
/** A blocking item: `code` is stable for programs, `message` is for people. */
export interface PlanBlock {
  code: "MIGRATION_DESTRUCTIVE_BLOCKED" | "MIGRATION_EDITED" | "BRICK_MAJOR_UNACKNOWLEDGED" | "SETTINGS_UPGRADE_ERROR";
  message: string;
}

/**
 * The stable identity of an emitted migration: its name without the leading counter the assembler gives it
 * (`0003_credit-wallet__0002_x.sql` -> `credit-wallet__0002_x.sql`). Adding a brick migration renumbers every later one, so
 * "has this run?" is decided on this key, never on the full name; otherwise a renumbered migration would run a second time.
 */
export function migrationKey(name: string): string {
  return name.replace(/^\d+_/, "");
}

export interface MigrationPlan {
  migrations: PlannedMigration[];
  blocks: PlanBlock[];
}

/**
 * Classifies the migrations that have not run yet. `applied` maps an applied migration's name to its recorded hash (or null when
 * the hash is unknown, as in Studio, which only knows names); `hashOf` is given when hashes are known so an edited migration is caught.
 */
export function planMigrations(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
  applied: ReadonlyMap<string, string | null>,
  options: { allowDestructive?: boolean; hashOf?: (sql: string) => string } = {},
): MigrationPlan {
  const planned: PlannedMigration[] = [];
  const blocks: PlanBlock[] = [];
  const appliedByKey = new Map([...applied].map(([name, hash]) => [migrationKey(name), hash]));
  for (const migration of migrations) {
    const key = migrationKey(migration.name);
    if (appliedByKey.has(key)) {
      const before = appliedByKey.get(key);
      if (before && options.hashOf && before !== options.hashOf(migration.sql)) {
        blocks.push({ code: "MIGRATION_EDITED", message: `migration ${migration.name} was applied with different contents; a migration is never run twice, so add a new one instead of editing it` });
      }
      continue;
    }
    const lint = lintMigration(migration.name, migration.sql);
    planned.push({ name: migration.name, class: lint.class });
    if (lint.class !== "destructive" || options.allowDestructive) continue;
    if (lint.header?.phase === "contract") {
      const expands = lint.header.expands;
      if (!expands || !applied.has(expands)) blocks.push({ code: "MIGRATION_DESTRUCTIVE_BLOCKED", message: `MIGRATION_DESTRUCTIVE_BLOCKED: contract migration "${migration.name}" requires expand migration "${expands ?? "none"}" to be already applied` });
    } else {
      blocks.push({ code: "MIGRATION_DESTRUCTIVE_BLOCKED", message: `MIGRATION_DESTRUCTIVE_BLOCKED: migration "${migration.name}" is destructive and blocked without expand/contract header or allowDestructive flag: ${lint.findings.map((f) => f.message).join("; ")}` });
    }
  }
  return { migrations: planned, blocks };
}

function brickKind(from: string, to: string): BrickChangeKind {
  const parse = (v: string) => v.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4).map(Number);
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return "changed";
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return "patch";
}

export interface LockPlan {
  bricks: PlannedBrick[];
  settings: PlannedSetting[];
  settingsUpgrade?: { errors: string[]; warnings: string[] };
  blocks: PlanBlock[];
}

/** What changes between the lock stored with the live deploy and the lock about to be deployed. */
export function planLockChanges(
  deployed: ProjectLock | null | undefined,
  next: ProjectLock,
  options: { allowMajor?: boolean; catalog?: Catalog } = {},
): LockPlan {
  const bricks: PlannedBrick[] = [];
  const settings: PlannedSetting[] = [];
  const blocks: PlanBlock[] = [];
  let settingsUpgrade: LockPlan["settingsUpgrade"];
  if (deployed?.bricks) {
    const before = new Map(deployed.bricks.map((b) => [b.id, b]));
    const after = new Map((next.bricks ?? []).map((b) => [b.id, b]));
    for (const [id, b] of after) {
      const was = before.get(id);
      if (!was) {
        bricks.push({ id, from: null, to: b.version, kind: "added" });
        continue;
      }
      if (was.version !== b.version) {
        const kind = brickKind(was.version, b.version);
        bricks.push({ id, from: was.version, to: b.version, kind });
        if (kind === "major" && options.allowMajor !== true) blocks.push({ code: "BRICK_MAJOR_UNACKNOWLEDGED", message: `brick ${id} would move from ${was.version} to ${b.version}, a major version; deploy again with allowMajor to acknowledge it` });
      }
      const wasSettings = (was.settings ?? {}) as Record<string, unknown>;
      const nowSettings = (b.settings ?? {}) as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(wasSettings), ...Object.keys(nowSettings)])].sort()) {
        if (JSON.stringify(wasSettings[key] ?? null) !== JSON.stringify(nowSettings[key] ?? null)) settings.push({ brick: id, key, from: wasSettings[key] ?? null, to: nowSettings[key] ?? null });
      }
    }
    for (const [id, was] of before) if (!after.has(id)) bricks.push({ id, from: was.version, to: null, kind: "removed" });
  }
  if (deployed && options.catalog) {
    const upgrade = checkSettingsUpgrade(deployed, options.catalog);
    settingsUpgrade = { errors: upgrade.errors, warnings: upgrade.warnings };
    for (const e of upgrade.errors) blocks.push({ code: "SETTINGS_UPGRADE_ERROR", message: `settings: ${e}` });
  }
  return { bricks, settings, ...(settingsUpgrade ? { settingsUpgrade } : {}), blocks };
}

/** One printable summary of a plan: one line per difference, and a clear line when there is none. */
export function describePlan(parts: { migrations: PlannedMigration[]; bricks: PlannedBrick[]; settings: PlannedSetting[]; worker?: { changed: boolean; reasons: string[] }; workflow?: { action: string }; rollbackTo?: string | null; blocking: string[] }): string {
  const lines: string[] = [];
  for (const m of parts.migrations) lines.push(`migration  ${m.name} (${m.class})`);
  for (const b of parts.bricks) lines.push(`brick      ${b.id} ${b.from ?? "-"} -> ${b.to ?? "-"} (${b.kind})`);
  for (const s of parts.settings) lines.push(`setting    ${s.brick}.${s.key}: ${JSON.stringify(s.from)} -> ${JSON.stringify(s.to)}`);
  if (parts.worker?.changed) lines.push(`worker     upload (${parts.worker.reasons.join(", ")})`);
  if (parts.workflow && parts.workflow.action !== "none") lines.push(`workflow   ${parts.workflow.action}`);
  if (lines.length === 0 && parts.blocking.length === 0) lines.push("no changes: the account already matches this project");
  if (parts.rollbackTo) lines.push(`rollback   would return to ${parts.rollbackTo}`);
  for (const b of parts.blocking) lines.push(`BLOCKED    ${b}`);
  return lines.join("\n");
}
