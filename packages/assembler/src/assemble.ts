import { BlueprintSchema, capabilityReference, entryBindingClash, formatIssues } from "./schemas.ts";
import type { ObservabilityConfig } from "./schemas.ts";
import { lintMigration } from "../../deploy/src/migration-lint.ts";
import { PX_RATE_LIMITS_DDL, entityDdl, parseEntities, tableName } from "@poc/sdk";
import type { Entity } from "@poc/sdk";
import type { BrickManifestFile, Catalog, ProjectLock, SettingDefinition, ValueExpr } from "./schemas.ts";
import { compare, parse, satisfies } from "./semver.ts";
import { IDENTITY_STUB_SOURCE } from "./identity-stub.ts";
import { generateOpenApiSpec } from "./openapi.ts";
import { sha256Sync } from "./hash.ts";
import { renderTailWorker, renderTailWrangler } from "./tail-worker.ts";

// A pure function: the same blueprint and catalog always give the same files. It reads no file, no clock, no random
// source and no network, and it knows no brick by name; what to mount and in which order comes from the manifests.

export type AssembleResult =
  | {
      ok: true;
      project: string;
      /** Brick ids in the order they were mounted. */
      order: string[];
      /** Path to text, keys sorted. */
      files: Record<string, string>;
      warnings?: string[];
      settingsUpgrade?: SettingsUpgradeResult;
    }
  | { ok: false; errors: string[] };

/** The URL prefix every brick mounts under, and the D1 binding every brick's routes expect. */
const API_PREFIX = "/api";
const DB_BINDING = "DB";
const COMPATIBILITY_DATE = "2026-10-01";
const IDENTITY_CAPABILITY = ["user", "identity"].join("-");

const PX_SCHEDULES_DDL = [
  "CREATE TABLE IF NOT EXISTS px_schedules (",
  "  id TEXT PRIMARY KEY,",
  "  workspace_id TEXT NOT NULL,",
  "  brick_id TEXT NOT NULL,",
  "  schedule_id TEXT NOT NULL,",
  "  cron_expression TEXT NOT NULL,",
  "  payload_json TEXT NOT NULL DEFAULT '{}',",
  "  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),",
  "  next_run_at TEXT NOT NULL,",
  "  last_run_at TEXT,",
  "  created_at TEXT NOT NULL DEFAULT (datetime('now'))",
  ");",
  "",
  "CREATE INDEX IF NOT EXISTS px_schedules_due_idx ON px_schedules(active, next_run_at);",
  "CREATE INDEX IF NOT EXISTS px_schedules_workspace_idx ON px_schedules(workspace_id);",
  "",
].join("\n");

/**
 * Story 1.10: the routes a suspended workspace may still call. Everywhere else that a workspace guard with a
 * `suspension` export is mounted, a suspended workspace gets 403 WORKSPACE_SUSPENDED. Matched on the request's method
 * and exact path shape only (never a header or the query); `:name` is one path segment. Each entry says why it is
 * exempt. Routes with no workspace guard (auth, payment verify, inbound webhooks, the workspace brick's own routes)
 * are never behind the check, so they need no entry here.
 */
export const SUSPENSION_EXEMPT: ReadonlyArray<{ method: "GET" | "POST"; path: string; reason: string }> = [
  { method: "POST", path: "/api/privacy/export", reason: "data-subject rights must remain available while suspended" },
  { method: "GET", path: "/api/privacy/export/:id", reason: "data-subject rights must remain available while suspended" },
  { method: "POST", path: "/api/privacy/erasure", reason: "data-subject rights must remain available while suspended" },
  { method: "GET", path: "/api/privacy/erasure/:id", reason: "data-subject rights must remain available while suspended" },
];

/** An exempt path as the source of an anchored regular expression over the request path (for `new RegExp`). */
export function exemptPathPattern(path: string): string {
  const prefix = path.endsWith("/*");
  const segments = (prefix ? path.slice(0, -2) : path).split("/");
  const body = segments.map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`))).join("/");
  return `^${body}${prefix ? "(?:/.*)?" : ""}$`;
}

type SettingValue = number | string | boolean;

interface Chosen {
  id: string;
  manifest: BrickManifestFile;
  files: Record<string, string>;
  settings: Record<string, SettingValue>;
}

/** One per-workspace table the generated purge touches (story 1.10). `keep` is a tombstone table without deleted_at. */
interface WorkspaceDataTable {
  brick: string;
  table: string;
  mode: "delete" | "tombstone" | "keep";
}

/** An object-store prefix holding one workspace's objects (story 1.10); `{workspaceId}` is filled in at delete time. */
interface WorkspaceObjectPrefix {
  brick: string;
  binding: string;
  prefix: string;
}

interface ScheduledTriggerEntry {
  brickId: string;
  pkg: string;
  id: string;
  cron: string;
  handler: string;
}

interface QueueTriggerEntry {
  brickId: string;
  pkg: string;
  id: string;
  handler: string;
  maxBatch: number;
  dlq: boolean;
}

export interface AssembleOptions {
  previousLock?: ProjectLock;
  acknowledgeUpgrades?: string[];
  /** Where the project will run. Defaults to "dev". The test stub identity is refused in "production". */
  environment?: "dev" | "preview" | "production";
}

export function assemble(input: unknown, catalog: Catalog, opts?: AssembleOptions): AssembleResult {
  const parsed = BlueprintSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error, "blueprint ") };
  const blueprint = parsed.data;
  const errors: string[] = [];
  const available = Object.keys(catalog.bricks).sort();

  // 1. Which bricks, once each, and are they in the catalog?
  const requested = blueprint.bricks.map((b) => (typeof b === "string" ? { id: b, config: {} as Record<string, SettingValue> } : { id: b.id, config: b.config ?? {} }));
  const seen = new Set<string>();
  const chosen: Chosen[] = [];
  for (const { id, config } of requested) {
    if (seen.has(id)) {
      errors.push(`brick "${id}" is listed more than once`);
      continue;
    }
    seen.add(id);
    const entry = catalog.bricks[id];
    if (!entry) {
      errors.push(`unknown brick "${id}" (available: ${available.join(", ") || "none"})`);
      continue;
    }
    const settings = resolveSettings(id, entry.manifest.settings, config, errors);
    chosen.push({ id, manifest: entry.manifest, files: entry.files, settings });
  }
  if (errors.length > 0) return { ok: false, errors };

  // 1a. Reserved route prefixes: healthz and readyz are reserved for platform health and readiness probes
  for (const brick of chosen) {
    for (const prefix of brick.manifest.routePrefixes) {
      const normalized = prefix.replace(/^\//, "").split("/")[0]?.toLowerCase();
      if (normalized === "healthz" || normalized === "readyz") {
        errors.push(`brick "${brick.id}" uses reserved route prefix "${prefix}"`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // 1b. Brick trust and isolation (Story UC6.5 / F-ISO-3 / UC6.7)
  for (const brick of chosen) {
    const trust = brick.manifest.trust ?? "untrusted";
    const isolation = brick.manifest.isolation ?? "none";
    if (trust === "untrusted" && isolation !== "dispatch") {
      errors.push(`brick "${brick.id}" is untrusted and must run isolated (set isolation: "dispatch")`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // 1c. Declared entities: checked in full, against the route names the bricks already use, and handed to a brick that
  // says it takes them. The assembler writes the tables and the declaration; it contains no code for any entity.
  const reserved = new Set([
    ...Object.values(catalog.bricks).flatMap((b) => b.manifest.routePrefixes),
    "healthz",
    "readyz",
  ]);
  const parsedEntities = parseEntities(blueprint.entities, reserved);
  if (!parsedEntities.ok) return { ok: false, errors: parsedEntities.errors };
  const entities = parsedEntities.entities;
  const handlers = chosen.filter((b) => takesEntities(b.manifest));
  if (entities.length > 0 && handlers.length === 0) {
    const offers = available.filter((id) => takesEntities(catalog.bricks[id]!.manifest));
    errors.push(`entities are declared but no enabled brick handles them${offers.length > 0 ? ` (enable one of: ${offers.join(", ")})` : ""}`);
  }
  if (handlers.length > 1) errors.push(`${handlers.map((b) => b.id).join(" and ")} both handle entities; enable only one`);
  if (errors.length > 0) return { ok: false, errors };

  // 2. Does every needed capability have exactly one provider among the chosen bricks?
  interface ProviderEntry {
    brickId: string;
    version: string;
  }
  const providerOf = new Map<string, ProviderEntry>();
  const providerBrickId = new Map<string, string>();
  const brickResolvedCapabilities = new Map<string, Record<string, string>>();
  const resolvedCapabilities: Record<string, string> = {};

  for (const brick of chosen) {
    const brickCaps: Record<string, string> = {};
    for (const capability of brick.manifest.provides) {
      const at = capability.indexOf("@");
      const name = at > -1 ? capability.slice(0, at) : capability;
      const ver = at > -1 ? capability.slice(at + 1) : brick.manifest.version;
      brickCaps[name] = ver;
      resolvedCapabilities[name] = ver;

      const existing = providerOf.get(name);
      if (existing) {
        errors.push(`"${name}" is provided by both ${existing.brickId} and ${brick.id}; enable only one`);
      } else {
        providerOf.set(name, { brickId: brick.id, version: ver });
        providerBrickId.set(name, brick.id);
      }
    }
    brickResolvedCapabilities.set(brick.id, brickCaps);
  }

  for (const brick of chosen) {
    for (const reqItem of brick.manifest.requires) {
      const at = reqItem.indexOf("@");
      const name = at > -1 ? reqItem.slice(0, at) : reqItem;
      const range = at > -1 ? reqItem.slice(at + 1) : "*";

      const provider = providerOf.get(name);
      if (!provider) {
        const offers = available.filter((id) => {
          const m = catalog.bricks[id]?.manifest;
          return m?.provides.some((p) => (p.includes("@") ? p.slice(0, p.indexOf("@")) : p) === name);
        });
        errors.push(`${brick.id} requires "${reqItem}", which no enabled brick provides${offers.length > 0 ? ` (enable one of: ${offers.join(", ")})` : ""}`);
      } else {
        if (!satisfies(provider.version, range)) {
          errors.push(`${brick.id} requires ${reqItem} but ${provider.brickId} provides ${provider.version}`);
        }
      }
    }
  }

  // Check version changes against previousLock
  if (opts?.previousLock?.bricks && Array.isArray(opts.previousLock.bricks)) {
    const ackSet = new Set(opts.acknowledgeUpgrades ?? []);
    for (const prevBrick of opts.previousLock.bricks) {
      const current = chosen.find((b) => b.id === prevBrick.id);
      if (!current) continue;
      const oldVer = prevBrick.version;
      const newVer = current.manifest.version;
      if (!oldVer || !newVer) continue;
      const cmp = compare(newVer, oldVer);
      if (cmp < 0) {
        errors.push(`downgrade of brick "${current.id}" from ${oldVer} to ${newVer} is refused`);
        continue;
      }
      const oldParsed = parse(oldVer);
      const newParsed = parse(newVer);
      if (oldParsed && newParsed && newParsed.major > oldParsed.major) {
        const ackKey = `${current.id}@${newParsed.major}`;
        const ackFullKey = `${current.id}@${newVer}`;
        if (!ackSet.has(ackKey) && !ackSet.has(ackFullKey)) {
          errors.push(
            `UPGRADE_MAJOR_REQUIRES_ACK: brick "${current.id}" upgraded from ${oldVer} to ${newVer}; acknowledge with "${ackKey}"`,
          );
        }
      }
    }
  }

  // Check settings upgrade against previousLock
  let settingsUpgradeResult: SettingsUpgradeResult | undefined;
  if (opts?.previousLock) {
    settingsUpgradeResult = checkSettingsUpgrade(opts.previousLock, catalog);
    if (settingsUpgradeResult.errors.length > 0) {
      errors.push(...settingsUpgradeResult.errors);
    }
  }

  // A route guarded with a capability needs the provider to export a guard for exactly that capability.
  for (const brick of chosen) {
    for (const route of brick.manifest.worker.routes) {
      if (!route.guardWith || !providerOf.has(route.guardWith)) continue;
      const provider = chosen.find((b) => b.id === providerOf.get(route.guardWith!)!.brickId)!;
      if (provider.manifest.worker.guard?.capability !== route.guardWith) {
        errors.push(`${brick.id} guards ${route.factory} with "${route.guardWith}", but ${provider.id} offers that capability without a guard to mount`);
      }
    }
  }
  // Story 1.13: a route option naming another capability's export (`$capability`) needs a brick that provides it,
  // unless the option is only required while one of the brick's settings has a given value and it has another.
  for (const brick of chosen) {
    for (const route of brick.manifest.worker.routes) {
      for (const [name, value] of Object.entries(route.options)) {
        if (typeof value !== "object" || value === null || !("$capability" in value)) continue;
        const ref = capabilityReference(value.$capability);
        if (brick.manifest.isolation === "dispatch") {
          // An isolated brick runs in its own worker and cannot be handed another brick's code.
          errors.push(`${brick.id}: option "${name}" of ${route.factory} names "${value.$capability}", which an isolated brick cannot take`);
          continue;
        }
        // Story 1.13: an option that is not required under this brick's settings is neither checked nor wired, so a
        // setting that turns the feature off is never refused over a provider it does not use.
        if (!capabilityRequired(value, brick.settings)) continue;
        const provider = providerOf.get(ref.capability);
        if (provider) {
          const providing = chosen.find((b) => b.id === provider.brickId)!;
          const where = `${brick.id}: option "${name}" of ${route.factory} names "${value.$capability}"`;
          if (providing.manifest.isolation === "dispatch" || providing.manifest.trust !== "first-party") {
            // Its code would run inside this brick's worker, outside the isolation it was given.
            errors.push(`${where}, but ${providing.id} is not a first-party, non-isolated brick, so its code cannot be handed to another brick`);
          } else if (isQuarantinedManifest(providing.manifest)) {
            errors.push(`${where}, but ${providing.id} is quarantined`);
          } else if (entryBindingClash(ref.export)) {
            errors.push(`${where}, which cannot be imported into the assembled entry: ${entryBindingClash(ref.export)}`);
          } else if (!(providing.manifest.worker.capabilityExports?.[ref.capability] ?? []).includes(ref.export)) {
            const offered = providing.manifest.worker.capabilityExports?.[ref.capability] ?? [];
            errors.push(`${where}, but ${providing.id} does not offer "${ref.export}" for "${ref.capability}" (it offers: ${offered.join(", ") || "nothing"})`);
          }
          continue;
        }
        const when = value.requiredWhen;
        const offers = available.filter((id) =>
          catalog.bricks[id]?.manifest.provides.some((p) => (p.includes("@") ? p.slice(0, p.indexOf("@")) : p) === ref.capability),
        );
        errors.push(
          `${brick.id}: option "${name}" of ${route.factory} needs "${ref.capability}" (its ${ref.export}), which no enabled brick provides` +
            `${offers.length > 0 ? ` (enable one of: ${offers.join(", ")})` : ""}` +
            `${when ? `; or set ${brick.id}'s setting "${when.setting}" to something other than ${JSON.stringify(when.equals)}` : ""}`,
        );
      }
    }
  }
  const reportedConflicts = new Set<string>();
  for (const brick of [...chosen].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const conflict of brick.manifest.conflicts ?? []) {
      if (!seen.has(conflict.brick)) continue;
      const pairKey = [brick.id, conflict.brick].sort().join("\0");
      if (reportedConflicts.has(pairKey)) continue;
      reportedConflicts.add(pairKey);
      errors.push(`conflict: ${brick.id} × ${conflict.brick}: ${conflict.reason}`);
    }
  }
  let identityGuard: { pkg: string; export: string } | undefined;
  const environment = opts?.environment ?? "dev";
  if (blueprint.identity === "stub" && environment === "production") {
    // The alternatives come from the catalog: every brick that provides identity and mounts a guard for it.
    const real = Object.values(catalog.bricks)
      .filter((b) => b.manifest.worker.guard?.capability === IDENTITY_CAPABILITY && b.manifest.provides.some((p) => (p.includes("@") ? p.slice(0, p.indexOf("@")) : p) === IDENTITY_CAPABILITY))
      .map((b) => b.manifest.id)
      .sort();
    errors.push(`identity "stub" is for tests only; choose ${real.length > 0 ? real.join(" or ") : `a brick that provides "${IDENTITY_CAPABILITY}"`}`);
  }
  if (blueprint.identity !== "stub") {
    const identityBrick = chosen.find((b) => b.id === blueprint.identity);
    if (!identityBrick) {
      errors.push(`identity "${blueprint.identity}" requires brick "${blueprint.identity}" to be enabled in bricks`);
    } else if (!identityBrick.manifest.provides.some((p) => (p.includes("@") ? p.slice(0, p.indexOf("@")) : p) === IDENTITY_CAPABILITY)) {
      errors.push(`identity "${blueprint.identity}" does not provide "${IDENTITY_CAPABILITY}"`);
    } else if (!identityBrick.manifest.worker.guard || identityBrick.manifest.worker.guard.capability !== IDENTITY_CAPABILITY) {
      errors.push(`identity "${blueprint.identity}" must declare a worker.guard for "${IDENTITY_CAPABILITY}"`);
    } else {
      identityGuard = {
        pkg: identityBrick.manifest.worker.package,
        export: identityBrick.manifest.worker.guard.export,
      };
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // 3. Dependency order, with ties broken by brick id so the order never depends on how the blueprint was written.
  const order = orderBricks(chosen, providerBrickId);
  if (!order.ok) return { ok: false, errors: order.errors };
  const ordered = order.bricks;

  // 4. Third-party packages must agree on one version, and queue ids must be unique.
  const dependencies: Record<string, string> = {};
  const schedules: ScheduledTriggerEntry[] = [];
  const queues: QueueTriggerEntry[] = [];
  const queueOwner = new Map<string, string>();
  for (const brick of ordered) {
    for (const [name, version] of Object.entries(brick.manifest.npmDependencies)) {
      if (dependencies[name] !== undefined && dependencies[name] !== version) errors.push(`${name} is needed at ${dependencies[name]} and at ${version}`);
      else dependencies[name] = version;
    }
    for (const sched of brick.manifest.triggers?.schedules ?? []) {
      schedules.push({
        brickId: brick.id,
        pkg: brick.manifest.worker.package,
        id: sched.id,
        cron: sched.cron,
        handler: sched.handler,
      });
    }
    for (const q of brick.manifest.triggers?.queues ?? []) {
      const existing = queueOwner.get(q.id);
      if (existing) {
        errors.push(`queue "${q.id}" is declared by both ${existing} and ${brick.id}; enable only one`);
      } else {
        queueOwner.set(q.id, brick.id);
        queues.push({
          brickId: brick.id,
          pkg: brick.manifest.worker.package,
          id: q.id,
          handler: q.handler,
          maxBatch: q.maxBatch ?? 10,
          dlq: q.dlq ?? true,
        });
      }
    }
  }
  // 4b. Privacy & GDPR coverage check: every tenant table must have a privacy rule
  for (const brick of ordered) {
    const globals = new Set(
      (brick.manifest.globalTables ?? [])
        .filter((g) => g.reason.trim().length > 0)
        .map((g) => g.table),
    );
    const coveredTables = new Set<string>([
      ...Object.keys(brick.manifest.privacy?.tables ?? {}),
      ...(brick.manifest.privacy?.hookTables ?? []),
    ]);

    for (const path of brick.manifest.migrations) {
      const sql = brick.files[path];
      if (!sql) continue;
      const created = extractCreatedTables(sql);
      for (const { table, hasWorkspaceId } of created) {
        if (hasWorkspaceId && !globals.has(table) && !coveredTables.has(table)) {
          errors.push(`table "${table}" (brick ${brick.id}) has workspace_id but no privacy rule`);
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // 4c. Workspace data (story 1.10): the tables each brick declares as holding per-workspace rows, checked against its
  // migrations and listed in reverse install order, so a workspace delete removes child rows before their parents.
  const workspaceData: WorkspaceDataTable[] = [];
  for (const brick of ordered) {
    const declared = brick.manifest.workspaceData?.tables ?? [];
    if (declared.length === 0) continue;
    const globals = new Set((brick.manifest.globalTables ?? []).map((g) => g.table));
    const created = workspaceTablesOf(brick.manifest.migrations.map((path) => brick.files[path] ?? ""));
    const position = new Map(created.map((t, index) => [t.table, index]));
    const rows: Array<WorkspaceDataTable & { index: number }> = [];
    for (const entry of declared) {
      const info = created.find((t) => t.table === entry.table);
      if (!info) errors.push(`${brick.id} declares workspaceData table "${entry.table}", which its migrations do not create`);
      else if (!info.hasWorkspaceId) errors.push(`${brick.id} declares workspaceData table "${entry.table}", which has no workspace_id column`);
      else if (globals.has(entry.table)) errors.push(`${brick.id} declares workspaceData table "${entry.table}", which is a global table`);
      else rows.push({ brick: brick.id, table: entry.table, mode: entry.tombstone ? (info.hasDeletedAt ? "tombstone" : "keep") : "delete", index: position.get(entry.table)! });
    }
    for (const row of rows.sort((a, b) => a.index - b.index)) workspaceData.push({ brick: row.brick, table: row.table, mode: row.mode });
  }
  // Declared entities are per-workspace tables too (entityDdl always gives them workspace_id), installed after the bricks.
  for (const entity of entities) workspaceData.push({ brick: "entity", table: tableName(entity), mode: "delete" });
  // The shell's px_schedules (emitted when a brick declares schedules) is a platform table, but each row mirrors one
  // workspace's schedule: left behind, scheduled() would keep claiming a deleted workspace's rows every minute.
  if (chosen.some((b) => (b.manifest.triggers?.schedules ?? []).length > 0)) workspaceData.push({ brick: "shell", table: "px_schedules", mode: "delete" });
  workspaceData.reverse();
  const workspaceObjects: WorkspaceObjectPrefix[] = [];
  for (const brick of ordered) {
    const raw = brick.manifest.bindings;
    const typeOf = (name: string) => (raw && !Array.isArray(raw) ? raw[name] : undefined);
    for (const o of brick.manifest.workspaceData?.objectPrefixes ?? []) {
      // Only an R2 bucket is listed and deleted by prefix; any other binding would make every workspace delete fail.
      if (typeOf(o.binding) !== "r2") errors.push(`${brick.id} declares workspaceData objects in binding "${o.binding}", which is not an R2 binding in its bindings`);
      else workspaceObjects.push({ brick: brick.id, binding: o.binding, prefix: o.prefix });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // 5. Write the files.
  const files: Record<string, string> = {};
  const migrationNames: string[] = [];
  const migrationEntries: Array<{ name: string; sha256: string }> = [];
  let counter = 0;
  for (const brick of ordered) {
    for (const path of brick.manifest.migrations) {
      const text = brick.files[path];
      if (text === undefined) {
        errors.push(`${brick.id} lists migration ${path}, which is not in the catalog`);
        continue;
      }
      counter += 1;
      const fileName = `${String(counter).padStart(4, "0")}_${brick.id}__${path.split("/").pop()}`;
      const name = `migrations/${fileName}`;
      const formatted = ensureTrailingNewline(text);
      files[name] = formatted;
      migrationNames.push(name);
      migrationEntries.push({ name: fileName, sha256: sha256Sync(formatted) });
    }
  }
  // One table per declared entity, after every brick's tables.
  for (const entity of entities) {
    counter += 1;
    const fileName = `${String(counter).padStart(4, "0")}_entity__${entity.name}.sql`;
    const name = `migrations/${fileName}`;
    const ddl = entityDdl(entity);
    const lintRes = lintMigration(name, ddl);
    if (lintRes.class === "destructive") {
      errors.push(`Generated entity migration "${name}" is destructive: ${lintRes.findings.map((f: { message: string }) => f.message).join("; ")}`);
    }
    files[name] = ddl;
    migrationNames.push(name);
    migrationEntries.push({ name: fileName, sha256: sha256Sync(ddl) });
  }
  if (schedules.length > 0) {
    counter += 1;
    const fileName = `${String(counter).padStart(4, "0")}_shell__px_schedules.sql`;
    const name = `migrations/${fileName}`;
    files[name] = PX_SCHEDULES_DDL;
    migrationNames.push(name);
    migrationEntries.push({ name: fileName, sha256: sha256Sync(PX_SCHEDULES_DDL) });
  }
  // The shared rate limiter's counters (story 0.21), only when an enabled brick declares a rate-limited route, so a
  // blueprint without one assembles exactly as before.
  if (ordered.some((b) => (b.manifest.rateLimits ?? []).length > 0)) {
    counter += 1;
    const fileName = `${String(counter).padStart(4, "0")}_shell__px_rate_limits.sql`;
    const name = `migrations/${fileName}`;
    files[name] = PX_RATE_LIMITS_DDL;
    migrationNames.push(name);
    migrationEntries.push({ name: fileName, sha256: sha256Sync(PX_RATE_LIMITS_DDL) });
  }
  if (errors.length > 0) return { ok: false, errors };

  const workflows =
    Array.isArray(blueprint.workflows) && blueprint.workflows.length > 0
      ? canonicalizeJson(blueprint.workflows)
      : undefined;
  const secretRefs =
    Array.isArray(blueprint.secretRefs) && blueprint.secretRefs.length > 0
      ? canonicalizeJson(blueprint.secretRefs)
      : undefined;

  const brickBindings = new Set<string>();
  for (const brick of ordered) {
    const b = brick.manifest.bindings;
    if (Array.isArray(b)) {
      for (const name of b) brickBindings.add(name);
    } else if (b && typeof b === "object") {
      for (const name of Object.keys(b)) brickBindings.add(name);
    }
  }
  for (const q of queues) {
    brickBindings.add(q.id.toUpperCase().replace(/-/g, "_"));
  }
  const isolatedBricks = ordered.filter((b) => b.manifest.isolation === "dispatch");
  const isolatedServices = isolatedBricks.map((b) => ({
    binding: `BRICK_${b.id.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`,
    service: `${blueprint.project}-b-${b.id}`,
  }));
  for (const svc of isolatedServices) {
    brickBindings.add(svc.binding);
  }
  const requiredBindings = [DB_BINDING, ...[...brickBindings].filter((b) => b !== DB_BINDING).sort()];

  const buildSha = sha256Sync(
    JSON.stringify({
      project: blueprint.project,
      bricks: ordered.map((b) => ({ id: b.id, version: b.manifest.version })),
      migrations: migrationEntries,
      bindings: requiredBindings,
    }),
  );

  files["openapi.json"] = json(generateOpenApiSpec(blueprint, ordered, entities));
  try {
    files["src/index.ts"] = renderEntry(
      ordered,
      entities,
      schedules,
      queues,
      migrationEntries,
      requiredBindings,
      buildSha,
      identityGuard,
      workspaceData,
      workspaceObjects,
    );
  } catch (error) {
    if (error instanceof ImportConflictError) return { ok: false, errors: error.conflicts };
    throw error;
  }
  files["src/privacy.generated.ts"] = renderPrivacyGenerated(ordered, entities);
  if (handlers.length > 0) files["src/entities.json"] = json(entities);
  if (workflows) files["src/workflows.json"] = json(workflows);
  if (!identityGuard) files["src/identity.stub.ts"] = IDENTITY_STUB_SOURCE;
  for (const brick of isolatedBricks) {
    files[`bricks/${brick.id}/wrangler.jsonc`] = renderIsolatedBrickWrangler(blueprint.project, brick);
    files[`bricks/${brick.id}/src/index.ts`] = renderIsolatedBrickEntry(brick);
  }
  // Decided by the bindings the bricks declare in their manifests, never by a brick id.
  const hasScriptingSandbox = brickBindings.has("SCRIPT_DISPATCH");
  const hasBinaryPayloads = hasBinaryPayloadOperation(blueprint.workflows, catalog);
  files["wrangler.jsonc"] = renderWrangler(
    blueprint.project,
    schedules,
    queues,
    Boolean(identityGuard),
    hasScriptingSandbox,
    isolatedServices,
    blueprint.observability,
    hasBinaryPayloads,
  );
  if (blueprint.observability?.alerts) {
    const webhookSecret = blueprint.observability.alerts.webhookSecret ?? "PX_ALERT_WEBHOOK_URL";
    files["tail/src/index.ts"] = renderTailWorker(blueprint.project, webhookSecret);
    files["tail/wrangler.jsonc"] = renderTailWrangler(blueprint.project);
  }
  files["package.json"] = json({
    name: blueprint.project,
    private: true,
    type: "module",
    // Brick packages come from the proof's workspace; a published brick would be a version here.
    dependencies: sortKeys({
      ...Object.fromEntries(ordered.map((b) => [b.manifest.worker.package, "workspace:*"])),
      ...(blueprint.observability?.alerts ? { "@poc/telemetry": "workspace:*" } : {}),
      ...dependencies,
    }),
  });
  files["project.json"] = json({
    project: blueprint.project,
    identity: blueprint.identity,
    environment,
    bricks: ordered.map((b) => ({
      id: b.id,
      version: b.manifest.version,
      capabilities: sortKeys(brickResolvedCapabilities.get(b.id) ?? {}),
      settings: sortKeys(b.settings),
    })),
    capabilities: sortKeys(resolvedCapabilities),
    migrations: migrationNames,
    entities: entities.map((entity) => entity.name),
    ...(workflows ? { workflows } : {}),
    ...(secretRefs ? { secretRefs } : {}),
  });

  return {
    ok: true,
    project: blueprint.project,
    order: ordered.map((b) => b.id),
    files: sortKeys(files),
    ...(settingsUpgradeResult ? { warnings: settingsUpgradeResult.warnings, settingsUpgrade: settingsUpgradeResult } : {}),
  };
}

function canonicalizeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalizeJson(v)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

/**
 * Checks one brick and its settings against the catalog, without needing the rest of a blueprint to be complete. Used by
 * tools that add bricks one at a time: a half-built blueprint is not buildable yet, but a misspelt brick or a bad setting
 * can be refused straight away. Returns readable problems; empty means the brick and its settings are acceptable.
 */
export function checkBrickConfig(id: string, config: Record<string, SettingValue>, catalog: Catalog): string[] {
  const entry = catalog.bricks[id];
  if (!entry) return [`unknown brick "${id}" (available: ${Object.keys(catalog.bricks).sort().join(", ") || "none"})`];
  const errors: string[] = [];
  resolveSettings(id, entry.manifest.settings, config, errors);
  return errors;
}

export interface SettingUpgradeAdded {
  brick: string;
  setting: string;
  default: SettingValue;
  since?: string;
}

export interface SettingsUpgradeResult {
  errors: string[];
  warnings: string[];
  added: SettingUpgradeAdded[];
}

export interface CheckSettingsUpgradeOptions {
  previousCatalog?: Catalog;
}

export function checkSettingsUpgrade(
  previousLock?: ProjectLock | null,
  catalog?: Catalog | null,
  options?: CheckSettingsUpgradeOptions
): SettingsUpgradeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const added: SettingUpgradeAdded[] = [];

  if (!previousLock || !catalog || !previousLock.bricks || !Array.isArray(previousLock.bricks)) {
    return { errors, warnings, added };
  }

  for (const prevBrick of previousLock.bricks) {
    const catalogEntry = catalog.bricks[prevBrick.id];
    if (!catalogEntry) continue;
    const newManifest = catalogEntry.manifest;
    const currentSettingsDefs = newManifest.settings ?? {};
    const savedSettings = (prevBrick.settings ?? {}) as Record<string, SettingValue>;
    const savedDefaults = (prevBrick.defaults ?? {}) as Record<string, SettingValue>;
    const prevCatalogDefaults = options?.previousCatalog?.bricks[prevBrick.id]?.manifest.settings;

    // 1. Check for removed settings (present in previous saved settings, missing from current manifest)
    for (const [savedKey, savedVal] of Object.entries(savedSettings)) {
      if (!(savedKey in currentSettingsDefs)) {
        const oldDefault = savedKey in savedDefaults
          ? savedDefaults[savedKey]
          : prevCatalogDefaults?.[savedKey]?.default;

        if (oldDefault !== undefined) {
          if (savedVal !== oldDefault) {
            errors.push(
              `setting ${prevBrick.id}.${savedKey}=${JSON.stringify(savedVal)} was removed in ${newManifest.version} (differing from old default ${JSON.stringify(oldDefault)})`
            );
          }
        } else {
          errors.push(
            `setting ${prevBrick.id}.${savedKey}=${JSON.stringify(savedVal)} was removed in ${newManifest.version}`
          );
        }
      }
    }

    // 2. Check for narrowed or deprecated settings (present in both saved settings and current manifest)
    for (const [sKey, sDef] of Object.entries(currentSettingsDefs)) {
      if (sKey in savedSettings) {
        const savedVal = savedSettings[sKey];

        // Deprecation warning
        if (sDef.deprecated) {
          let warnMsg = `setting ${prevBrick.id}.${sKey} is deprecated since ${sDef.deprecated.since}`;
          if (sDef.deprecated.replacedBy) {
            warnMsg += `; migrate to ${sDef.deprecated.replacedBy}`;
          }
          if (sDef.deprecated.removeIn) {
            warnMsg += ` (scheduled for removal in ${sDef.deprecated.removeIn})`;
          }
          warnings.push(warnMsg);
        }

        // Narrowing checks
        if (sDef.type === "integer") {
          if (typeof savedVal !== "number" || !Number.isSafeInteger(savedVal) || savedVal < sDef.min || savedVal > sDef.max) {
            errors.push(
              `setting ${prevBrick.id}.${sKey}=${savedVal} is outside ${sDef.min}..${sDef.max} in ${newManifest.version}`
            );
          }
        } else if (sDef.type === "enum") {
          if (typeof savedVal !== "string" || !sDef.values.includes(savedVal)) {
            errors.push(
              `setting ${prevBrick.id}.${sKey}="${savedVal}" is not one of [${sDef.values.join(", ")}] in ${newManifest.version}`
            );
          }
        } else if (sDef.type === "boolean") {
          if (typeof savedVal !== "boolean") {
            errors.push(
              `setting ${prevBrick.id}.${sKey} must be boolean in ${newManifest.version}`
            );
          }
        }
      } else {
        // Setting in new manifest was absent in saved settings
        added.push({
          brick: prevBrick.id,
          setting: sKey,
          default: sDef.default,
          ...(sDef.since ? { since: sDef.since } : {}),
        });
      }
    }
  }

  return { errors, warnings, added };
}

function resolveSettings(id: string, definitions: Record<string, SettingDefinition>, config: Record<string, SettingValue>, errors: string[]): Record<string, SettingValue> {
  const resolved: Record<string, SettingValue> = {};
  for (const name of Object.keys(config)) {
    if (!(name in definitions)) errors.push(`${id}: unknown setting "${name}" (known: ${Object.keys(definitions).sort().join(", ") || "none"})`);
  }
  for (const [name, definition] of Object.entries(definitions)) {
    const value = name in config ? config[name]! : definition.default;
    if (definition.type === "integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < definition.min || value > definition.max) {
        errors.push(`${id}: setting "${name}" must be a whole number from ${definition.min} to ${definition.max}`);
        continue;
      }
    } else if (definition.type === "enum") {
      if (typeof value !== "string" || !definition.values.includes(value)) {
        errors.push(`${id}: setting "${name}" must be one of ${definition.values.join(", ")}`);
        continue;
      }
    } else if (definition.type === "boolean") {
      if (typeof value !== "boolean") {
        errors.push(`${id}: setting "${name}" must be true or false`);
        continue;
      }
    } else if (definition.type === "string") {
      if (typeof value !== "string") {
        errors.push(`${id}: setting "${name}" must be a string`);
        continue;
      }
      const maxLen = definition.maxLength ?? 512;
      if (value.length > maxLen) {
        errors.push(`${id}: setting "${name}" must be at most ${maxLen} characters`);
        continue;
      }
      // Story 1.13: a declared pattern is checked here, so a malformed value never reaches the running app.
      if (definition.pattern !== undefined && !new RegExp(definition.pattern).test(value)) {
        errors.push(`${id}: setting "${name}" is not in the expected format${definition.example !== undefined ? ` (for example ${JSON.stringify(definition.example)})` : ""}`);
        continue;
      }
      if (value.length > 0 && definition.format) {
        if (definition.format === "url") {
          try {
            const u = new URL(value);
            if (u.protocol !== "https:" && u.protocol !== "http:") {
              errors.push(`${id}: setting "${name}" must be a valid http or https URL`);
              continue;
            }
          } catch {
            errors.push(`${id}: setting "${name}" must be a valid URL`);
            continue;
          }
        } else if (definition.format === "identifier") {
          if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
            errors.push(`${id}: setting "${name}" must be a valid identifier`);
            continue;
          }
        } else if (definition.format === "claim-path") {
          if (!/^[A-Za-z0-9_:.\/-]+(\.[A-Za-z0-9_:\/-]+)*$/.test(value)) {
            errors.push(`${id}: setting "${name}" must be a valid claim-path`);
            continue;
          }
        }
      }
    }
    resolved[name] = value;
  }
  return resolved;
}

function orderBricks(chosen: Chosen[], providerOf: Map<string, string>): { ok: true; bricks: Chosen[] } | { ok: false; errors: string[] } {
  const byId = new Map(chosen.map((b) => [b.id, b]));
  const waitingOn = new Map<string, Set<string>>();
  for (const brick of chosen) {
    const needs = new Set<string>();
    for (const capability of brick.manifest.requires) {
      const name = capability.includes("@") ? capability.slice(0, capability.indexOf("@")) : capability;
      const provider = providerOf.get(name);
      if (provider && provider !== brick.id) needs.add(provider);
    }
    waitingOn.set(brick.id, needs);
  }
  const ordered: Chosen[] = [];
  const remaining = new Set(byId.keys());
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => [...waitingOn.get(id)!].every((dep) => !remaining.has(dep))).sort();
    if (ready.length === 0) return { ok: false, errors: [`bricks depend on each other in a cycle: ${[...remaining].sort().join(", ")}`] };
    const next = ready[0]!;
    ordered.push(byId.get(next)!);
    remaining.delete(next);
  }
  return { ok: true, bricks: ordered };
}

function expression(value: ValueExpr, settings: Record<string, SettingValue>): string {
  if (typeof value === "object") {
    if ("$setting" in value) return JSON.stringify(settings[value.$setting]);
    if ("$entities" in value) return "entities"; // the identifier imported from ./entities.json
    if ("$privacy" in value) return value.$privacy;
    if ("$workspaceData" in value) return value.$workspaceData;
    if ("$capability" in value) return capabilityReference(value.$capability).export; // imported by renderEntry
    return `${value.$call}()`;
  }
  return JSON.stringify(value);
}

/** Whether a brick's routes are given the declared entities (so the brick is the one that serves them). */
function takesEntities(manifest: BrickManifestFile): boolean {
  return manifest.worker.routes.some((route) => Object.values(route.options).some((v) => typeof v === "object" && "$entities" in v));
}

/** One `app.on(method, path, rateLimit(rule))` line per rate-limited route the brick declares, in manifest order. */
function renderRateLimits(brick: Chosen): string[] {
  // Rule paths are relative to the brick's mount, as routePrefixes are: the mount of its (first) route.
  const mount = (brick.manifest.worker.routes[0]?.mountAt ?? API_PREFIX).replace(/\/+$/, "");
  return (brick.manifest.rateLimits ?? []).map((r) => {
    const rule = {
      bucket: r.bucket,
      limit: r.limit,
      windowSeconds: r.windowSeconds,
      key: r.key,
      ...(r.failClosed ? { failClosed: true } : {}),
    };
    return `app.on(${JSON.stringify(r.method)}, ${JSON.stringify(mount + r.path)}, rateLimit(${JSON.stringify(rule)}));`;
  });
}

/** A guard path may name each declared entity with {entity}; every other path stands for itself. */
function expandGuardPath(path: string, entities: Entity[]): string[] {
  return path.includes("{entity}") ? entities.map((entity) => path.replaceAll("{entity}", entity.name)) : [path];
}

/** Thrown by renderEntry when two packages would be imported under one name (story 1.13); assemble() reports it. */
class ImportConflictError extends Error {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super(conflicts.join("; "));
    this.conflicts = conflicts;
  }
}

/** Whether a `$capability` option applies: always, or while its `requiredWhen` setting has the given value. */
function capabilityRequired(value: { requiredWhen?: { setting: string; equals: SettingValue } | undefined }, settings: Record<string, SettingValue>): boolean {
  return !value.requiredWhen || settings[value.requiredWhen.setting] === value.requiredWhen.equals;
}

/** A quarantined brick (story 0.11): experimental, with a maturity reason starting "QUARANTINED:". */
function isQuarantinedManifest(manifest: BrickManifestFile): boolean {
  const ui = manifest.ui;
  return ui?.maturity === "experimental" && typeof ui.maturityReason === "string" && ui.maturityReason.startsWith("QUARANTINED:");
}

function renderEntry(
  ordered: Chosen[],
  entities: Entity[],
  schedules: ScheduledTriggerEntry[],
  queues: QueueTriggerEntry[],
  migrations: Array<{ name: string; sha256: string }>,
  requiredBindings: string[],
  buildSha: string,
  identityGuard?: { pkg: string; export: string },
  workspaceData: WorkspaceDataTable[] = [],
  workspaceObjects: WorkspaceObjectPrefix[] = [],
): string {
  const imports = new Map<string, Set<string>>();
  // Story 1.13: one identifier may be imported from one package only; two would be a duplicate binding in the entry.
  const boundTo = new Map<string, string>();
  const conflicts: string[] = [];
  const use = (pkg: string, name: string) => {
    const earlier = boundTo.get(name);
    if (earlier !== undefined && earlier !== pkg) {
      const conflict = `"${name}" would be imported from both ${earlier} and ${pkg}; the entry cannot bind one name twice`;
      if (!conflicts.includes(conflict)) conflicts.push(conflict);
      return;
    }
    boundTo.set(name, pkg);
    imports.set(pkg, (imports.get(pkg) ?? new Set()).add(name));
  };
  let needsEntities = false;
  let needsPrivacy = false;
  // Story 1.10: set when a brick's route takes the generated workspace-data purge (the workspace delete route).
  let needsWorkspaceData = false;
  // Story 1.10: one suspension check per guard capability that has one, keyed by capability.
  const suspensionChecks = new Map<string, { name: string; suspension: string }>();
  if (identityGuard) use(identityGuard.pkg, identityGuard.export);
  // Story 1.11: alternative identities (credentials other than the session), in install order.
  const identityAlternatives: string[] = [];
  // Every concrete path a guard is mounted at: alternative identities are mounted only there (story 1.11).
  const guardedPaths: string[] = [];
  for (const brick of ordered) {
    const alternative = brick.manifest.worker.identityAlternative;
    if (!alternative) continue;
    use(brick.manifest.worker.package, alternative.export);
    identityAlternatives.push(alternative.export);
  }
  // Story 1.13: the package of the enabled brick that provides each capability, for `$capability` route options.
  const capabilityProviders = new Map<string, string>();
  for (const brick of ordered) {
    for (const p of brick.manifest.provides) capabilityProviders.set(p.includes("@") ? p.slice(0, p.indexOf("@")) : p, brick.manifest.worker.package);
  }
  const guardOf = new Map<string, { pkg: string; export: string; suspension?: string }>();
  for (const brick of ordered) {
    const guard = brick.manifest.worker.guard;
    if (guard) guardOf.set(guard.capability, { pkg: brick.manifest.worker.package, export: guard.export, ...(guard.suspension ? { suspension: guard.suspension } : {}) });
  }

  const body: string[] = [];
  const hasRateLimits = ordered.some((b) => (b.manifest.rateLimits ?? []).length > 0);
  for (const brick of ordered) {
    body.push(`// ${brick.id}`);
    const isIsolated = brick.manifest.isolation === "dispatch";
    const bindingName = `BRICK_${brick.id.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
    // Story 0.21: a brick with rate-limited routes gets all its guards first, then the SDK limiter (so a workspace key
    // sees the verified workspace), then its routes. A brick without rules keeps the guard/route interleaving it had.
    const rateLimitLines = renderRateLimits(brick);
    const guardLines: string[] = [];
    const routeLines: string[] = [];
    const emitGuard = (line: string) => (rateLimitLines.length > 0 ? guardLines : body).push(line);
    const emitRoute = (line: string) => (rateLimitLines.length > 0 ? routeLines : body).push(line);

    for (const route of brick.manifest.worker.routes) {
      if (route.guardWith) {
        const guard = guardOf.get(route.guardWith);
        if (!guard) throw new Error(`no guard for "${route.guardWith}"`); // cannot happen: assemble() refuses a route whose capability has no guard
        use(guard.pkg, guard.export);
        let check: string | undefined;
        if (guard.suspension) {
          use(guard.pkg, guard.suspension);
          check = `notSuspended_${route.guardWith.replace(/[^A-Za-z0-9]/g, "_")}`;
          suspensionChecks.set(route.guardWith, { name: check, suspension: guard.suspension });
        }
        for (const path of route.guardPaths) {
          for (const concrete of expandGuardPath(path, entities)) {
            emitGuard(`app.use(${JSON.stringify(concrete)}, ${guard.export});`);
            if (!guardedPaths.includes(concrete)) guardedPaths.push(concrete);
            // Story 1.10: right after the guard that resolved the workspace, refuse a suspended one.
            if (check) emitGuard(`app.use(${JSON.stringify(concrete)}, ${check});`);
          }
        }
      }
      if (isIsolated) {
        emitRoute(`app.all(${JSON.stringify(route.mountAt + "/*")}, (c) => (c.env as any).${bindingName}.fetch(c.req.raw));`);
      } else {
        use(brick.manifest.worker.package, route.factory);
        const options = Object.entries(route.options).flatMap(([name, value]) => {
          if (typeof value === "object" && value !== null && "$capability" in value) {
            // Story 1.13: the provider's export, imported from the provider's package. With no provider enabled the
            // option is left out (assemble() has already refused the blueprint if the option was required).
            const ref = capabilityReference(value.$capability);
            const provider = capabilityProviders.get(ref.capability);
            if (!provider || !capabilityRequired(value, brick.settings)) return [];
            use(provider, ref.export);
          }
          if (typeof value === "object" && value !== null && "$call" in value) use(brick.manifest.worker.package, value.$call);
          if (typeof value === "object" && value !== null && "$entities" in value) needsEntities = true;
          if (typeof value === "object" && value !== null && "$privacy" in value) needsPrivacy = true;
          if (typeof value === "object" && value !== null && "$workspaceData" in value) needsWorkspaceData = true;
          return `${name}: ${expression(value, brick.settings)}`;
        });
        emitRoute(`app.route(${JSON.stringify(route.mountAt)}, ${route.factory}(${options.length > 0 ? `{ ${options.join(", ")} }` : ""}));`);
      }
    }
    body.push(...guardLines, ...rateLimitLines, ...routeLines);
  }

  for (const sched of schedules) use(sched.pkg, sched.handler);
  for (const q of queues) use(q.pkg, q.handler);
  if (conflicts.length > 0) throw new ImportConflictError(conflicts);

  const importLines = [...imports.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pkg, names]) => `import { ${[...names].sort().join(", ")} } from ${JSON.stringify(pkg)};`);

  // Story 1.10: the purge reads the declared entities from entities.json at run time, so no entity is named in code.
  const purgeEntities = needsWorkspaceData && workspaceData.some((t) => t.brick === "entity");
  if (purgeEntities) needsEntities = true;

  const hasTriggers = schedules.length > 0 || queues.length > 0;
  const footerLines: string[] = [];
  if (!hasTriggers) {
    footerLines.push("", "export default app;");
  } else {
    if (schedules.length > 0) {
      footerLines.push(
        "",
        "async function scheduled(controller: { scheduledTime?: number; cron?: string }, env: { DB: unknown; PX_RUN_RETENTION_DAYS?: number | string; [key: string]: unknown }, ctx?: unknown): Promise<void> {",
        "  const nowMs = controller?.scheduledTime ?? Date.now();",
        "  const nowIso = new Date(nowMs).toISOString();",
        "  const retentionDays = Math.max(7, Math.floor(Number(env.PX_RUN_RETENTION_DAYS ?? 14) || 14));",
        "  const cutoffIso = new Date(nowMs - retentionDays * 86_400_000).toISOString();",
        "  const db = env.DB as { prepare: (sql: string) => { bind: (...args: unknown[]) => { all: <T>() => Promise<{ results: T[] }>; run?: () => Promise<unknown> } } };",
        '  await db.prepare("DELETE FROM px_step_events WHERE created_at < ? OR run_id IN (SELECT run_id FROM px_runs WHERE started_at < ?)").bind(cutoffIso, cutoffIso).run?.().catch(() => {});',
        '  await db.prepare("DELETE FROM px_runs WHERE started_at < ?").bind(cutoffIso).run?.().catch(() => {});',
        '  const dueCandidates = (await db.prepare("SELECT id, workspace_id, brick_id, schedule_id, cron_expression, payload_json, next_run_at FROM px_schedules WHERE active = 1 AND datetime(next_run_at) <= datetime(?)").bind(nowIso).all<{ id: string; workspace_id: string; brick_id: string; schedule_id: string; cron_expression: string; payload_json: string; next_run_at: string }>()).results;',
        '  const dueRows: typeof dueCandidates = [];',
        '  for (const row of dueCandidates) {',
        '    const claimed = (await db.prepare("UPDATE px_schedules SET next_run_at = datetime(?, \'+1 minute\'), last_run_at = ? WHERE id = ? AND next_run_at = ? AND active = 1 RETURNING id").bind(nowIso, nowIso, row.id, row.next_run_at).all<{ id: string }>().catch(() => ({ results: [] }))).results;',
        '    if (claimed && claimed.length > 0) dueRows.push(row);',
        '  }',
        ...schedules.map(
          (s) =>
            `  await ${s.handler}({ controller, env, ctx, dueRows: dueRows.filter((r) => r.brick_id === ${JSON.stringify(s.brickId)}) });`,
        ),
        "}",
      );
    }
    if (queues.length > 0) {
      footerLines.push(
        "",
        "async function queue(batch: { queue: string; messages: readonly unknown[] }, env: { DB: unknown; [key: string]: unknown }, ctx?: unknown): Promise<void> {",
        "  switch (batch.queue) {",
        ...queues.flatMap((q) => [
          `    case ${JSON.stringify(q.id)}:`,
          `      await ${q.handler}(batch, env, ctx);`,
          "      return;",
        ]),
        "    default:",
        '      throw new Error(`unhandled queue "${batch.queue}"`);',
        "  }",
        "}",
      );
    }
    footerLines.push(
      "",
      "export default {",
      "  fetch: app.fetch,",
      ...(schedules.length > 0 ? ["  scheduled,"] : []),
      ...(queues.length > 0 ? ["  queue,"] : []),
      "};",
    );
  }

  return (
    [
      "// Assembled by @poc/assembler. Do not edit: change the blueprint and assemble again.",
      'import { Hono } from "hono";',
      `import { createHttpGuard${hasRateLimits ? ", rateLimit" : ""}${purgeEntities ? ", tableName" : ""} } from "@poc/sdk";`,
      ...importLines,
      ...(identityGuard ? [] : ['import { stubIdentity } from "./identity.stub.ts";']),
      ...(needsEntities ? ['import entities from "./entities.json";'] : []),
      ...(needsPrivacy ? ['import { eraseTenant, exportTenant } from "./privacy.generated.ts";'] : []),
      ...(needsWorkspaceData ? ['import type { D1Like } from "@poc/sdk";'] : []),
      'import openapiSpec from "../openapi.json";',
      "",
      "const app = new Hono();",
      "",
      'app.get("/openapi.json", (c) => c.json(openapiSpec, 200, { "Cache-Control": "public, max-age=60", "Content-Type": "application/json; charset=utf-8" }));',
      "",
      `const MIGRATIONS: ReadonlyArray<{ name: string; sha256: string }> = ${JSON.stringify(migrations, null, 2)};`,
      `const REQUIRED_BINDINGS: ReadonlyArray<string> = ${JSON.stringify(requiredBindings)};`,
      `const BUILD_SHA = ${JSON.stringify(buildSha)};`,
      "",
      'app.get("/healthz", (c) => {',
      '  const envObj = (c.env ?? {}) as Record<string, unknown>;',
      '  const build = typeof envObj.PX_BUILD_SHA === "string" && envObj.PX_BUILD_SHA.length > 0 ? envObj.PX_BUILD_SHA : BUILD_SHA;',
      '  return c.json({ ok: true, build }, 200, { "Cache-Control": "no-store" });',
      '});',
      "",
      'app.get("/readyz", async (c) => {',
      '  const envObj = (c.env ?? {}) as Record<string, unknown>;',
      '  const missingBindings = REQUIRED_BINDINGS.filter((b) => envObj[b] === undefined || envObj[b] === null);',
      '  const bindingsStatus = missingBindings.length > 0 ? `missing: ${missingBindings.join(", ")}` : "ok";',
      '  let d1Status = "ok";',
      '  const db = envObj.DB as { prepare: (sql: string) => { run: () => Promise<unknown>; all: <T>() => Promise<{ results: T[] }> } } | undefined;',
      '  if (!db || typeof db.prepare !== "function") {',
      '    d1Status = "missing: DB";',
      '  } else {',
      '    try {',
      '      const probe = db.prepare("SELECT 1").run();',
      '      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("D1 probe timeout")), 2000));',
      '      await Promise.race([probe, timeout]);',
      '    } catch (err) {',
      '      d1Status = "error: " + (err instanceof Error ? err.message : String(err));',
      '    }',
      '  }',
      '  let migrationsStatus = "ok";',
      '  if (d1Status !== "ok") {',
      '    migrationsStatus = MIGRATIONS.length > 0 ? `pending: ${MIGRATIONS.map((m) => m.name).join(", ")}` : "ok";',
      '  } else {',
      '    try {',
      '      const query = db!.prepare("SELECT name, sha256 FROM _projectx_migrations").all<{ name: string; sha256?: string }>();',
      '      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Migrations query timeout")), 2000));',
      '      const res = await Promise.race([query, timeout]);',
      '      // Compared without the leading counter: a migration renumbered by a later brick migration has still run.',
      '      const key = (name: string) => name.replace(/^\\d+_/, "");',
      '      const applied = new Map((res.results ?? []).map((r) => [key(r.name), r.sha256]));',
      '      const pending: string[] = [];',
      '      const mismatched: string[] = [];',
      '      for (const m of MIGRATIONS) {',
      '        if (!applied.has(key(m.name))) {',
      '          pending.push(m.name);',
      '        } else if (applied.get(key(m.name)) && applied.get(key(m.name)) !== m.sha256) {',
      '          mismatched.push(m.name);',
      '        }',
      '      }',
      '      if (pending.length > 0) {',
      '        migrationsStatus = `pending: ${pending.join(", ")}`;',
      '      } else if (mismatched.length > 0) {',
      '        migrationsStatus = `mismatched: ${mismatched.join(", ")}`;',
      '      }',
      '    } catch {',
      '      migrationsStatus = MIGRATIONS.length > 0 ? `pending: ${MIGRATIONS.map((m) => m.name).join(", ")}` : "ok";',
      '    }',
      '  }',
      '  const isReady = d1Status === "ok" && bindingsStatus === "ok" && migrationsStatus === "ok";',
      '  const checks = { d1: d1Status, bindings: bindingsStatus, migrations: migrationsStatus };',
      '  return c.json({ ok: isReady, checks }, isReady ? 200 : 503, { "Cache-Control": "no-store" });',
      '});',
      "// CSRF (Origin check on cookie-authenticated writes) and CORS allow-list (PX_ALLOWED_ORIGINS); signed webhook ingress is exempt.",
      `app.use(${JSON.stringify(API_PREFIX + "/*")}, createHttpGuard({ exemptPaths: ${JSON.stringify([API_PREFIX + "/webhooks/in/", API_PREFIX + "/webhooks/ingress/"])} }));`,
      ...renderIdentity(identityGuard?.export, identityAlternatives, guardedPaths),
      "",
      ...(needsWorkspaceData ? renderWorkspaceDataPurge(workspaceData, workspaceObjects, purgeEntities) : []),
      ...(suspensionChecks.size > 0 ? renderSuspensionChecks([...suspensionChecks.values()]) : []),
      ...body,
      ...footerLines,
    ].join("\n") + "\n"
  );
}

/**
 * The identity steps on the API routes. Without alternatives: the session identity (or the stub) alone, as before.
 * With them (story 1.11): each alternative first, mounted only on the guarded paths (the routes that act inside one
 * workspace), so on every other path their credential header is ignored. An alternative that resolves its credential
 * sets the `authenticatedBy` marker (or refuses the request); the session identity is skipped only for a request
 * carrying that marker.
 */
function renderIdentity(sessionExport: string | undefined, alternatives: string[], guardedPaths: string[]): string[] {
  const all = JSON.stringify(API_PREFIX + "/*");
  const session = sessionExport ?? "stubIdentity";
  const lines = sessionExport ? [] : ["// STUB IDENTITY (proof only): trusts a request header. Replace before real use."];
  if (alternatives.length === 0) return [...lines, `app.use(${all}, ${session});`];
  return [
    "// Alternative identities first, on the workspace-guarded paths only: a request carrying one of their credentials is",
    "// resolved (or refused) there and skips the session identity; any other request goes on to the session identity.",
    ...alternatives.flatMap((name) => guardedPaths.map((path) => `app.use(${JSON.stringify(path)}, ${name});`)),
    ...lines,
    `app.use(${all}, (c: any, next: any) => (c.get("authenticatedBy") ? next() : ${session}(c, next)));`,
  ];
}

function isBinaryOperation(op: any): boolean {
  if (op.response?.binary) return true;
  const ct = op.body?.contentType;
  if (
    ct === "multipart/form-data" ||
    ct === "multipart/related" ||
    ct === "application/octet-stream"
  ) {
    return true;
  }
  if (Array.isArray(op.body?.fields) && op.body.fields.some((f: any) => f.binary)) {
    return true;
  }
  return false;
}

function hasBinaryPayloadOperation(workflows: unknown[] | undefined, catalog: Catalog): boolean {
  if (!workflows || !Array.isArray(workflows) || !catalog.integrations) {
    return false;
  }
  const binaryOps = new Set<string>();
  for (const integ of Object.values(catalog.integrations)) {
    const manifest = integ.manifest;
    if (!manifest || !Array.isArray(manifest.operations)) continue;
    for (const op of manifest.operations) {
      if (isBinaryOperation(op)) {
        binaryOps.add(op.operationId);
        binaryOps.add(`int:${manifest.app}.${op.operationId}`);
        binaryOps.add(`${manifest.app}.${op.operationId}`);
      }
    }
  }
  if (binaryOps.size === 0) return false;

  for (const wf of workflows) {
    if (!wf || typeof wf !== "object") continue;
    const nodes = (wf as any).nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = (node as any).type;
      const opId = (node as any).data?.operationId ?? (node as any).config?.operationId;
      if (
        (type && binaryOps.has(type)) ||
        (opId && binaryOps.has(opId)) ||
        (node as any).binary === true ||
        (node as any).data?.binary === true
      ) {
        return true;
      }
    }
  }
  return false;
}

function renderWrangler(
  project: string,
  schedules: ScheduledTriggerEntry[],
  queues: QueueTriggerEntry[],
  nodejsCompat = false,
  scriptIsolation = false,
  services: Array<{ binding: string; service: string }> = [],
  observability?: ObservabilityConfig,
  needsIntegrationBlobs = false,
): string {
  return (
    "// Assembled by @poc/assembler. database_id is filled in when the project is deployed.\n" +
    json({
      name: project,
      main: "src/index.ts",
      compatibility_date: COMPATIBILITY_DATE,
      ...(nodejsCompat ? { compatibility_flags: ["nodejs_compat"] } : {}),
      d1_databases: [{ binding: DB_BINDING, database_name: project, database_id: "REPLACE_AT_DEPLOY", migrations_dir: "migrations" }],
      ...(needsIntegrationBlobs
        ? {
            r2_buckets: [
              {
                binding: "INTEGRATION_BLOBS",
                bucket_name: `${project}-blobs`,
              },
            ],
          }
        : {}),
      ...(services.length > 0 ? { services } : {}),
      ...(scriptIsolation
        ? {
            dispatch_namespaces: [
              {
                binding: "SCRIPT_DISPATCH",
                namespace: "px-scripts",
              },
            ],
          }
        : {}),
      ...(observability?.logs ? { observability: { enabled: true } } : {}),
      ...(observability?.logpush ? { logpush: true } : {}),
      ...(observability?.alerts ? { tail_consumers: [{ service: `${project}-tail` }] } : {}),
      ...(schedules.length > 0 ? { triggers: { crons: ["* * * * *"] } } : {}),
      ...(queues.length > 0
        ? {
            queues: {
              producers: queues.map((q) => ({
                binding: q.id.toUpperCase().replace(/-/g, "_"),
                queue: q.id,
              })),
              consumers: queues.map((q) => ({
                queue: q.id,
                max_batch_size: q.maxBatch,
                ...(q.dlq ? { dead_letter_queue: `${q.id}-dlq` } : {}),
              })),
            },
          }
        : {}),
    })
  );
}

function renderIsolatedBrickWrangler(project: string, brick: Chosen): string {
  const declaredSecrets = brick.manifest.secrets ?? [];
  const rawBindings = brick.manifest.bindings;
  const declaredBindings = Array.isArray(rawBindings)
    ? rawBindings
    : rawBindings && typeof rawBindings === "object"
      ? Object.keys(rawBindings)
      : [];

  const config: Record<string, unknown> = {
    name: `${project}-b-${brick.id}`,
    main: "src/index.ts",
    compatibility_date: COMPATIBILITY_DATE,
  };

  if (declaredSecrets.length > 0) {
    config.vars = Object.fromEntries(declaredSecrets.map((s) => [s, ""]));
  }

  const d1Bindings = declaredBindings.filter((b) => b === DB_BINDING);
  if (d1Bindings.length > 0) {
    config.d1_databases = d1Bindings.map((binding) => ({
      binding,
      database_name: `${project}-b-${brick.id}`,
      database_id: "REPLACE_AT_DEPLOY",
    }));
  }

  return (
    "// Assembled by @poc/assembler for isolated brick " +
    brick.id +
    "\n" +
    json(config)
  );
}

function renderIsolatedBrickEntry(brick: Chosen): string {
  const declaredSecrets = brick.manifest.secrets ?? [];
  const rawBindings = brick.manifest.bindings;
  const declaredBindings = Array.isArray(rawBindings)
    ? rawBindings
    : rawBindings && typeof rawBindings === "object"
      ? Object.keys(rawBindings)
      : [];

  const imports: string[] = [
    'import { WorkerEntrypoint, env } from "cloudflare:workers";',
    'import { Hono } from "hono";',
    `import * as brickPkg from ${JSON.stringify(brick.manifest.worker.package)};`,
  ];

  const routeMounts: string[] = [];
  for (const route of brick.manifest.worker.routes) {
    const options = Object.entries(route.options).map(([name, value]) => {
      return `${name}: ${expression(value, brick.settings)}`;
    });
    routeMounts.push(
      `const factory_${route.factory.replace(/[^A-Za-z0-9_]/g, "_")} = (brickPkg as any)[${JSON.stringify(route.factory)}];`,
      `if (typeof factory_${route.factory.replace(/[^A-Za-z0-9_]/g, "_")} === "function") {`,
      `  app.route(${JSON.stringify(route.mountAt)}, factory_${route.factory.replace(/[^A-Za-z0-9_]/g, "_")}(${options.length > 0 ? `{ ${options.join(", ")} }` : ""}));`,
      `}`,
    );
  }

  const executorMapLines: string[] = (brick.manifest.nodes ?? []).map(
    (n) =>
      `  ${JSON.stringify(n.type)}: (brickPkg as any)[${JSON.stringify(n.executor)}] ?? (brickPkg as any).executors?.[${JSON.stringify(n.type)}] ?? (brickPkg as any).default?.[${JSON.stringify(n.executor)}] ?? ((brickPkg as any).default && typeof (brickPkg as any).default === "function" ? (brickPkg as any).default : async () => { throw new Error(${JSON.stringify(`NOT_CONFIGURED: ${n.type}: isolated brick "${brick.id}" exports no executor "${n.executor}"; nothing was done.`)}); }),`,
  );

  return [
    `// Assembled by @poc/assembler for isolated brick "${brick.id}".`,
    ...imports,
    "",
    "const app = new Hono();",
    ...routeMounts,
    "",
    `const DECLARED_SECRETS: ReadonlyArray<string> = ${JSON.stringify(declaredSecrets)};`,
    `const DECLARED_BINDINGS: ReadonlyArray<string> = ${JSON.stringify(declaredBindings)};`,
    "",
    "const EXECUTORS: Record<string, (ctx: any) => Promise<any> | any> = {",
    ...executorMapLines,
    "};",
    "",
    "export default class extends WorkerEntrypoint {",
    "  async fetch(request: Request) {",
    "    return app.fetch(request, (this as any).env ?? env, (this as any).ctx);",
    "  }",
    "  async execute(nodeType: string, ctxSnapshot: { nodeId: string; runId: string; workspaceId: string; data: Record<string, unknown>; inputs: Record<string, unknown>; payload: unknown; idempotencyKey?: string }) {",
    "    const executor = EXECUTORS[nodeType] ?? (brickPkg as any)[nodeType];",
    `    if (!executor) throw new Error(\`no executor registered for \${nodeType} in isolated brick "${brick.id}"\`);`,
    "    const envObj = (this as any).env ?? env;",
    "    const execCtx = {",
    "      nodeId: ctxSnapshot.nodeId,",
    "      runId: ctxSnapshot.runId,",
    "      // the run's verified workspace, set by the host runtime (story 1.1)",
    "      workspaceId: ctxSnapshot.workspaceId,",
    "      data: ctxSnapshot.data,",
    "      inputs: ctxSnapshot.inputs,",
    "      payload: ctxSnapshot.payload,",
    "      idempotencyKey: ctxSnapshot.idempotencyKey,",
    "      secret: (name: string): string => {",
    `        if (!DECLARED_SECRETS.includes(name)) throw new Error(\`secret "\${name}" is not declared by \${nodeType}\`);`,
    "        const val = envObj[name];",
    `        if (typeof val !== "string") throw new Error(\`secret "\${name}" is declared by \${nodeType} but was not provided\`);`,
    "        return val;",
    "      },",
    "      binding: <T = unknown>(name: string): T => {",
    `        if (!DECLARED_BINDINGS.includes(name)) throw new Error(\`binding "\${name}" is not declared by \${nodeType}\`);`,
    "        const val = envObj[name];",
    `        if (val === undefined || val === null) throw new Error(\`binding "\${name}" is declared by \${nodeType} but was not provided\`);`,
    "        return val as T;",
    "      },",
    "    };",
    "    return await executor(execCtx);",
    "  }",
    "}",
  ].join("\n") + "\n";
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const ensureTrailingNewline = (text: string) => (text.endsWith("\n") ? text : text + "\n");

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

interface CreatedTableInfo {
  table: string;
  hasWorkspaceId: boolean;
}

function extractCreatedTables(sqlContent: string): CreatedTableInfo[] {
  const stripped = sqlContent
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const results: CreatedTableInfo[] = [];
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_"]+)\s*\(([\s\S]*?)\)\s*;/gi;
  for (const match of stripped.matchAll(createTableRegex)) {
    const rawName = match[1] ?? "";
    const table = rawName.replace(/"/g, "");
    const body = match[2] ?? "";
    const hasWorkspaceId = /\bworkspace_id\b/i.test(body);
    results.push({ table, hasWorkspaceId });
  }
  return results;
}

function renderPrivacyGenerated(ordered: Chosen[], entities: Entity[]): string {
  const tables: Array<{
    table: string;
    subject: "workspace" | "user";
    userColumn?: string;
    erase: "delete" | "anonymize" | "retain";
    anonymize?: string[];
    retainReason?: string;
    export: boolean;
  }> = [];

  // Declared entities default to subject: "workspace", erase: "delete", export: true
  // Reverse order for entities (entity migrations are after brick migrations)
  for (const entity of [...entities].reverse()) {
    tables.push({
      table: `ent_${entity.name}`,
      subject: "workspace",
      erase: "delete",
      export: true,
    });
  }

  const hooks: Array<{
    brickId: string;
    pkg: string;
    exportTenant?: string;
    eraseTenant?: string;
  }> = [];

  for (const brick of [...ordered].reverse()) {
    const p = brick.manifest.privacy;
    if (p?.tables) {
      const entries = Object.entries(p.tables).reverse();
      for (const [table, rule] of entries) {
        tables.push({
          table,
          subject: rule.subject,
          userColumn: rule.userColumn,
          erase: rule.erase,
          anonymize: rule.anonymize,
          retainReason: rule.retainReason,
          export: rule.export,
        });
      }
    }

    const wp = brick.manifest.worker?.privacy;
    if (wp?.exportTenant || wp?.eraseTenant) {
      hooks.push({
        brickId: brick.id,
        pkg: brick.manifest.worker.package,
        exportTenant: wp.exportTenant,
        eraseTenant: wp.eraseTenant,
      });
    }
  }

  const hookImports: string[] = [];
  for (const h of hooks) {
    const names = [h.exportTenant, h.eraseTenant].filter(Boolean) as string[];
    if (names.length > 0) {
      hookImports.push(`import { ${names.join(", ")} } from ${JSON.stringify(h.pkg)};`);
    }
  }

  return (
    [
      "// Emitted by @poc/assembler. Do not edit directly.",
      'import { scoped, type D1Like } from "@poc/sdk";',
      ...hookImports,
      "",
      "export interface PrivacySubject {",
      "  workspaceId: string;",
      "  userId?: string;",
      "}",
      "",
      "export interface ErasureResult {",
      "  deletedCount: number;",
      "  retain: Array<{ table: string; reason?: string }>;",
      "}",
      "",
      `const PRIVACY_TABLES: Array<{ table: string; subject: "workspace" | "user"; userColumn?: string; erase: "delete" | "anonymize" | "retain"; anonymize?: string[]; retainReason?: string; export: boolean }> = ${JSON.stringify(tables, null, 2)};`,
      "",
      "export async function exportTenant(db: D1Like, subject: PrivacySubject): Promise<Record<string, unknown>> {",
      "  const sDb = scoped(db, subject.workspaceId);",
      "  const result: Record<string, unknown> = {};",
      "",
      "  for (const rule of PRIVACY_TABLES) {",
      "    if (!rule.export) continue;",
      "    if (subject.userId) {",
      '      if (rule.subject === "user" && rule.userColumn) {',
      '        const rows = await sDb.select(rule.table, `"${rule.userColumn}" = ?`, [subject.userId]);',
      "        result[rule.table] = rows;",
      "      }",
      "    } else {",
      "      const rows = await sDb.select(rule.table);",
      "      result[rule.table] = rows;",
      "    }",
      "  }",
      "",
      ...hooks.filter((h) => h.exportTenant).flatMap((h) => [
        `  try {`,
        `    const hookData = await ${h.exportTenant}!(sDb, subject);`,
        `    if (hookData && typeof hookData === "object") {`,
        `      Object.assign(result, hookData);`,
        `    }`,
        `  } catch (err) {`,
        `    console.error("exportTenant hook error in ${h.brickId}:", err);`,
        `  }`,
      ]),
      "",
      "  return result;",
      "}",
      "",
      "export async function eraseTenant(db: D1Like, subject: PrivacySubject): Promise<ErasureResult> {",
      "  const sDb = scoped(db, subject.workspaceId);",
      "  const retain: Array<{ table: string; reason?: string }> = [];",
      "  const statements: any[] = [];",
      "",
      "  for (const rule of PRIVACY_TABLES) {",
      '    if (rule.erase === "retain") {',
      "      retain.push({ table: rule.table, reason: rule.retainReason });",
      "      continue;",
      "    }",
      "",
      "    if (subject.userId) {",
      '      if (rule.subject === "user" && rule.userColumn) {',
      '        if (rule.erase === "delete") {',
      '          statements.push(db.prepare(`DELETE FROM "${rule.table}" WHERE workspace_id = ? AND "${rule.userColumn}" = ?`).bind(subject.workspaceId, subject.userId));',
      '        } else if (rule.erase === "anonymize" && rule.anonymize && rule.anonymize.length > 0) {',
      '          const setClause = rule.anonymize.map((col: string) => `"${col}" = NULL`).join(", ");',
      '          statements.push(db.prepare(`UPDATE "${rule.table}" SET ${setClause} WHERE workspace_id = ? AND "${rule.userColumn}" = ?`).bind(subject.workspaceId, subject.userId));',
      "        }",
      "      }",
      "    } else {",
      '      if (rule.erase === "delete") {',
      '        statements.push(db.prepare(`DELETE FROM "${rule.table}" WHERE workspace_id = ?`).bind(subject.workspaceId));',
      "      }",
      "    }",
      "  }",
      "",
      "  let deletedCount = 0;",
      "  if (statements.length > 0) {",
      "    const BATCH_SIZE = 100;",
      "    for (let i = 0; i < statements.length; i += BATCH_SIZE) {",
      "      const batch = statements.slice(i, i + BATCH_SIZE);",
      "      const batchRes = await db.batch(batch);",
      "      for (const res of batchRes) {",
      "        deletedCount += (res as any).meta?.changes ?? 0;",
      "      }",
      "    }",
      "  }",
      "",
      ...hooks.filter((h) => h.eraseTenant).flatMap((h) => [
        `  try {`,
        `    const hookRes = await ${h.eraseTenant}!(sDb, subject);`,
        `    if (hookRes && typeof hookRes === "object") {`,
        `      if (typeof (hookRes as any).deletedCount === "number") deletedCount += (hookRes as any).deletedCount;`,
        `      if (Array.isArray((hookRes as any).retain)) retain.push(...(hookRes as any).retain);`,
        `    }`,
        `  } catch (err) {`,
        `    console.error("eraseTenant hook error in ${h.brickId}:", err);`,
        `  }`,
      ]),
      "",
      "  return { deletedCount, retain };",
      "}",
      "",
    ].join("\n") + "\n"
  );
}

/**
 * Story 1.10: one `notSuspended_<capability>` per guard capability, each wrapping that guard's own `suspension` export
 * with the assembler's allowlist. The decision uses the request's method and path only, so no header or query can
 * make a route exempt.
 */
function renderSuspensionChecks(checks: Array<{ name: string; suspension: string }>): string[] {
  return [
    "// A suspended workspace gets 403 WORKSPACE_SUSPENDED on every workspace route (story 1.10), apart from these:",
    "const SUSPENSION_EXEMPT: ReadonlyArray<{ method: string; path: RegExp }> = [",
    ...SUSPENSION_EXEMPT.flatMap((e) => [
      `  // ${e.method} ${e.path}: ${e.reason}`,
      `  { method: ${JSON.stringify(e.method)}, path: new RegExp(${JSON.stringify(exemptPathPattern(e.path))}) },`,
    ]),
    "];",
    "const suspensionExempt = (c: any) => SUSPENSION_EXEMPT.some((e) => e.method === c.req.method && e.path.exec(c.req.path) !== null);",
    ...checks.map((k) => `const ${k.name} = (c: any, next: any) => (suspensionExempt(c) ? next() : ${k.suspension}(c, next));`),
    "",
  ];
}

interface WorkspaceTableInfo {
  table: string;
  hasWorkspaceId: boolean;
  hasDeletedAt: boolean;
}

/**
 * The tables a brick's migrations leave behind, in the order they first appear, with whether each has workspace_id and
 * deleted_at. Follows `ALTER TABLE a RENAME TO b` (b takes a's columns) and `ALTER TABLE t ADD COLUMN deleted_at`.
 */
function workspaceTablesOf(migrations: string[]): WorkspaceTableInfo[] {
  const tables = new Map<string, WorkspaceTableInfo>();
  const statement =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_"]+)\s*\(([\s\S]*?)\)\s*;|ALTER\s+TABLE\s+([A-Za-z0-9_"]+)\s+RENAME\s+TO\s+([A-Za-z0-9_"]+)|ALTER\s+TABLE\s+([A-Za-z0-9_"]+)\s+ADD\s+(?:COLUMN\s+)?([A-Za-z0-9_"]+)/gi;
  const name = (raw: string | undefined) => (raw ?? "").replace(/"/g, "");
  for (const sql of migrations) {
    const stripped = sql.replace(/--[^\r\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of stripped.matchAll(statement)) {
      if (m[1] !== undefined) {
        const table = name(m[1]);
        const body = m[2] ?? "";
        if (!tables.has(table)) tables.set(table, { table, hasWorkspaceId: /\bworkspace_id\b/i.test(body), hasDeletedAt: /\bdeleted_at\b/i.test(body) });
      } else if (m[3] !== undefined) {
        const from = tables.get(name(m[3]));
        const to = name(m[4]);
        // The renamed table keeps the place of the table it replaces (or of the one renamed, when it is new).
        if (from) {
          const existing = tables.get(to);
          if (existing) {
            existing.hasWorkspaceId = from.hasWorkspaceId;
            existing.hasDeletedAt = from.hasDeletedAt;
          } else {
            tables.set(to, { table: to, hasWorkspaceId: from.hasWorkspaceId, hasDeletedAt: from.hasDeletedAt });
          }
        }
      } else if (m[5] !== undefined) {
        const target = tables.get(name(m[5]));
        if (target && name(m[6]).toLowerCase() === "deleted_at") target.hasDeletedAt = true;
      }
    }
  }
  return [...tables.values()];
}

/**
 * Story 1.10: `purgeWorkspaceData(env, workspaceId)`, emitted into the entry. It first deletes the objects under each
 * declared object prefix (listed page by page), then removes one workspace's rows from every table the enabled bricks
 * declare as per-workspace data (and every declared entity, and the shell's px_schedules), in reverse install order, in
 * batches of at most 25 statements. Every statement is an idempotent DELETE or UPDATE bound to that workspace only, so
 * a failed purge can be retried. Global tables are never listed.
 */
function renderWorkspaceDataPurge(tables: WorkspaceDataTable[], objects: WorkspaceObjectPrefix[], withEntities: boolean): string[] {
  const sql = (list: WorkspaceDataTable[]) =>
    list
      .filter((t) => t.mode !== "keep")
      .map((t) =>
        t.mode === "delete"
          ? `DELETE FROM "${t.table}" WHERE workspace_id = ?`
          : `UPDATE "${t.table}" SET deleted_at = datetime('now') WHERE workspace_id = ? AND deleted_at IS NULL`,
      );
  // Reverse install order: the shell's tables (installed last), then the declared entities, then the bricks' tables.
  const shell = sql(tables.filter((t) => t.brick === "shell"));
  const bricks = sql(tables.filter((t) => t.brick !== "shell" && t.brick !== "entity"));
  const kept = tables.filter((t) => t.mode === "keep").map((t) => t.table);
  return [
    "// Workspace delete (story 1.10): one statement per declared per-workspace table, in reverse install order, each bound",
    `// to the deleted workspace's id only, run in batches of at most 25.${withEntities ? " Entity tables come from entities.json." : ""}`,
    ...(kept.length > 0 ? [`// Kept for audit (tombstone tables without a deleted_at column): ${kept.join(", ")}.`] : []),
    `const WORKSPACE_PURGE_SHELL_SQL: ReadonlyArray<string> = ${JSON.stringify(shell, null, 2)};`,
    `const WORKSPACE_PURGE_BRICK_SQL: ReadonlyArray<string> = ${JSON.stringify(bricks, null, 2)};`,
    "const WORKSPACE_PURGE_SQL: ReadonlyArray<string> = [",
    "  ...WORKSPACE_PURGE_SHELL_SQL,",
    ...(withEntities
      ? ["  ...[...(entities as Array<{ name: string }>)].reverse().map((entity) => `DELETE FROM \"${tableName(entity)}\" WHERE workspace_id = ?`),"]
      : []),
    "  ...WORKSPACE_PURGE_BRICK_SQL,",
    "];",
    `const WORKSPACE_PURGE_OBJECTS: ReadonlyArray<{ binding: string; prefix: string }> = ${JSON.stringify(objects.map((o) => ({ binding: o.binding, prefix: o.prefix })))};`,
    "const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;",
    "type PurgeBucket = { list(o: { prefix: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>; delete(keys: string[]): Promise<unknown> };",
    "async function purgeWorkspaceData(env: { DB: D1Like } & Record<string, unknown>, workspaceId: string): Promise<void> {",
    "  // One plain segment only: a '/' would widen an object prefix to other workspaces' objects.",
    '  if (WORKSPACE_ID_PATTERN.exec(workspaceId) === null) throw new Error("workspace purge: invalid workspace id");',
    "  for (const o of WORKSPACE_PURGE_OBJECTS) {",
    "    const bucket = env[o.binding] as PurgeBucket | undefined;",
    "    if (!bucket) throw new Error(`workspace purge: binding ${o.binding} is missing`);",
    '    const prefix = o.prefix.split("{workspaceId}").join(workspaceId);',
    "    let cursor: string | undefined;",
    "    do {",
    "      const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });",
    "      const keys = page.objects.map((obj) => obj.key);",
    "      if (keys.length > 0) await bucket.delete(keys);",
    "      cursor = page.truncated ? page.cursor : undefined;",
    "    } while (cursor);",
    "  }",
    "  for (let i = 0; i < WORKSPACE_PURGE_SQL.length; i += 25) {",
    "    await env.DB.batch(WORKSPACE_PURGE_SQL.slice(i, i + 25).map((sql) => env.DB.prepare(sql).bind(workspaceId)));",
    "  }",
    "}",
    "",
  ];
}
