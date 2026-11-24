import { computeBuildHash, hashFiles } from "@poc/assembler";
import type { Catalog } from "@poc/assembler";
import {
  OpSchema,
  applyOps,
  collectOpTargets,
  computeReadiness,
  computeSemanticDiff,
  createEmptyBlueprint,
  semanticHash,
  summarizeProposalOps,
} from "@poc/blueprint";
import type {
  BlueprintState,
  BlueprintValidationError,
  Op,
  ProposalRecord,
  ReadinessResult,
  SemanticDiff,
} from "@poc/blueprint";
import type { D1Like } from "@poc/sdk";

export type SettingValue = number | string | boolean;

export interface BlueprintAuthor {
  type: "human" | "agent";
  id: string;
  client?: string;
  /** For an agent acting with a user's token: the user it acts for. */
  onBehalfOf?: string;
}

export interface BlueprintProjectSnapshot {
  project: string;
  revision: number;
  parentRevision?: number;
  rebasedFrom?: number;
  author?: BlueprintAuthor;
  summary?: string;
  state: BlueprintState;
  semanticHash: string;
  readiness: ReadinessResult;
}

export interface BlueprintConflictDetail {
  opId: string;
  target: string;
  conflictingRevision: number;
  conflictingAuthor: BlueprintAuthor;
}

export interface BlueprintConflictError {
  code: "CONFLICT";
  message: string;
  baseRevision: number;
  currentRevision: number;
  conflicts: BlueprintConflictDetail[];
  currentState: BlueprintState;
  interveningOps: unknown[];
  issues?: BlueprintValidationError[];
}

export type BlueprintApplyResult =
  | {
      ok: true;
      status: 200;
      idempotent?: boolean;
      data: BlueprintProjectSnapshot & {
        parentRevision: number;
        author: BlueprintAuthor;
        summary: string;
        mode?: "apply" | "propose";
        status?: "pending" | "accepted" | "partially_accepted" | "rejected";
        proposalId?: string;
        proposal?: ProposalRecord;
        diff?: SemanticDiff;
        proposedState?: BlueprintState;
        proposedSemanticHash?: string;
        proposedReadiness?: ReadinessResult;
      };
    }
  | {
      ok: false;
      status: 409;
      error: BlueprintConflictError;
    }
  | {
      ok: false;
      status: 422;
      error: {
        code: "VALIDATION_FAILED";
        issues: BlueprintValidationError[];
      };
    };

export interface BlueprintClient {
  getProject(project: string, revision?: number): Promise<BlueprintProjectSnapshot | null>;
  applyOps(input: {
    project: string;
    baseRevision?: number;
    author: BlueprintAuthor;
    summary?: string;
    ops: unknown[];
    mode?: "apply" | "propose";
    proposalId?: string;
  }): Promise<BlueprintApplyResult>;
  revertToRevision(input: {
    project: string;
    targetRevision: number;
    baseRevision?: number;
    author: BlueprintAuthor;
  }): Promise<BlueprintApplyResult>;
  seedProject?(
    project: string,
    state: BlueprintState,
    revision?: number,
  ): Promise<{ revision: number; semanticHash: string }>;
}

export interface BlueprintDoStubLike {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface BlueprintDoNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): BlueprintDoStubLike;
}

/** The most projects an in-memory adapter will hold, so a caller with the token cannot fill memory. */
export const MAX_PROJECTS = 1000;

export function createDurableObjectBlueprintClient(
  namespace: BlueprintDoNamespaceLike,
): BlueprintClient {
  return {
    async getProject(project: string, revision?: number): Promise<BlueprintProjectSnapshot | null> {
      const stub = namespace.get(namespace.idFromName(project));
      const url = new URL("http://blueprint-do/state");
      url.searchParams.set("project", project);
      if (revision !== undefined) {
        url.searchParams.set("revision", String(revision));
      }
      const res = await stub.fetch(url.toString(), { method: "GET" });
      if (res.status === 404 || !res.ok) {
        return null;
      }
      const payload = (await res.json()) as BlueprintProjectSnapshot & { exists?: boolean };
      if (revision === undefined && payload.revision === 0 && !payload.exists) {
        return null;
      }
      return payload;
    },

    async applyOps(input): Promise<BlueprintApplyResult> {
      const stub = namespace.get(namespace.idFromName(input.project));
      const res = await stub.fetch("http://blueprint-do/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 200) {
        return {
          ok: true,
          status: 200,
          data: body as unknown as BlueprintProjectSnapshot & {
            parentRevision: number;
            author: BlueprintAuthor;
            summary: string;
          },
        };
      }
      if (res.status === 409) {
        return {
          ok: false,
          status: 409,
          error: body.error as BlueprintConflictError,
        };
      }
      return {
        ok: false,
        status: 422,
        error: body.error as { code: "VALIDATION_FAILED"; issues: BlueprintValidationError[] },
      };
    },

    async revertToRevision(input): Promise<BlueprintApplyResult> {
      const stub = namespace.get(namespace.idFromName(input.project));
      const res = await stub.fetch("http://blueprint-do/revert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 200) {
        return {
          ok: true,
          status: 200,
          data: body as unknown as BlueprintProjectSnapshot & {
            parentRevision: number;
            author: BlueprintAuthor;
            summary: string;
          },
        };
      }
      if (res.status === 409) {
        return {
          ok: false,
          status: 409,
          error: body.error as BlueprintConflictError,
        };
      }
      return {
        ok: false,
        status: 422,
        error: body.error as { code: "VALIDATION_FAILED"; issues: BlueprintValidationError[] },
      };
    },

    async seedProject(project: string, state: BlueprintState, revision = 1) {
      const stub = namespace.get(namespace.idFromName(project));
      const res = await stub.fetch("http://blueprint-do/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, state, revision }),
      });
      const body = (await res.json()) as { revision: number; semanticHash: string };
      return body;
    },
  };
}

interface InMemoryRevisionEntry {
  revision: number;
  parentRevision: number;
  rebasedFrom?: number;
  author: BlueprintAuthor;
  summary: string;
  ops: Op[];
  inverseOps: Op[];
  state: BlueprintState;
  semanticHash: string;
}

interface InMemoryProjectRecord {
  currentRevision: number;
  currentState: BlueprintState;
  semanticHash: string;
  revisions: Map<number, InMemoryRevisionEntry>;
  committedOps: Map<string, number>;
}

export function createInMemoryBlueprintClient(
  catalog: Catalog,
  maxProjects = MAX_PROJECTS,
): BlueprintClient {
  const projects = new Map<string, InMemoryProjectRecord>();

  function getOrCreateRecord(project: string): InMemoryProjectRecord | null {
    const existing = projects.get(project);
    if (existing) return existing;
    if (projects.size >= maxProjects) return null;
    const empty = createEmptyBlueprint(project);
    const created: InMemoryProjectRecord = {
      currentRevision: 0,
      currentState: empty,
      semanticHash: semanticHash(empty),
      revisions: new Map(),
      committedOps: new Map(),
    };
    projects.set(project, created);
    return created;
  }

  return {
    async getProject(project: string, revision?: number): Promise<BlueprintProjectSnapshot | null> {
      const rec = projects.get(project);
      if (!rec) {
        if (revision === 0) {
          const empty = createEmptyBlueprint(project);
          return {
            project,
            revision: 0,
            parentRevision: 0,
            state: empty,
            semanticHash: semanticHash(empty),
            readiness: computeReadiness(empty, catalog),
          };
        }
        return null;
      }

      if (revision !== undefined) {
        if (revision === 0) {
          const empty = createEmptyBlueprint(project);
          return {
            project,
            revision: 0,
            parentRevision: 0,
            state: empty,
            semanticHash: semanticHash(empty),
            readiness: computeReadiness(empty, catalog),
          };
        }
        const entry = rec.revisions.get(revision);
        if (!entry) return null;
        return {
          project,
          revision: entry.revision,
          parentRevision: entry.parentRevision,
          ...(entry.rebasedFrom !== undefined ? { rebasedFrom: entry.rebasedFrom } : {}),
          author: entry.author,
          summary: entry.summary,
          state: entry.state,
          semanticHash: entry.semanticHash,
          readiness: computeReadiness(entry.state, catalog),
        };
      }

      if (rec.currentRevision === 0) return null;
      const latest = rec.revisions.get(rec.currentRevision);
      return {
        project,
        revision: rec.currentRevision,
        ...(latest ? { parentRevision: latest.parentRevision, author: latest.author, summary: latest.summary } : {}),
        ...(latest?.rebasedFrom !== undefined ? { rebasedFrom: latest.rebasedFrom } : {}),
        state: rec.currentState,
        semanticHash: rec.semanticHash,
        readiness: computeReadiness(rec.currentState, catalog),
      };
    },

    async applyOps(input): Promise<BlueprintApplyResult> {
      if (!Array.isArray(input.ops) || input.ops.length === 0) {
        return {
          ok: false,
          status: 422,
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "EMPTY_OPS",
                path: "ops",
                message: "ops array must contain at least one operation",
                suggestedFix: "Provide at least one operation in ops",
              },
            ],
          },
        };
      }

      const existingRec = projects.get(input.project);
      if (!existingRec && projects.size >= maxProjects) {
        return {
          ok: false,
          status: 422,
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "MAX_PROJECTS_EXCEEDED",
                path: "project",
                message: `this server holds at most ${maxProjects} projects`,
              },
            ],
          },
        };
      }

      const incomingOpIds = input.ops.map((raw) =>
        raw && typeof raw === "object" && typeof (raw as { opId?: unknown }).opId === "string"
          ? (raw as { opId: string }).opId.trim()
          : "",
      );

      if (existingRec && incomingOpIds.every((id) => id.length > 0)) {
        const committedRevisions: number[] = [];
        let allCommitted = true;
        for (const opId of incomingOpIds) {
          const rev = existingRec.committedOps.get(opId);
          if (rev !== undefined) {
            committedRevisions.push(rev);
          } else {
            allCommitted = false;
            break;
          }
        }
        if (allCommitted && committedRevisions.length > 0) {
          const committedRev = Math.max(...committedRevisions);
          const entry = existingRec.revisions.get(committedRev);
          if (entry) {
            return {
              ok: true,
              status: 200,
              idempotent: true,
              data: {
                project: input.project,
                revision: entry.revision,
                parentRevision: entry.parentRevision,
                ...(entry.rebasedFrom !== undefined ? { rebasedFrom: entry.rebasedFrom } : {}),
                author: entry.author,
                summary: entry.summary,
                state: entry.state,
                semanticHash: entry.semanticHash,
                readiness: computeReadiness(entry.state, catalog),
              },
            };
          }
        }
      }

      const currentRevision = existingRec ? existingRec.currentRevision : 0;
      const currentState = existingRec
        ? existingRec.currentState
        : createEmptyBlueprint(input.project);

      if (input.baseRevision !== undefined && input.baseRevision > currentRevision) {
        return {
          ok: false,
          status: 409,
          error: {
            code: "CONFLICT",
            message: "Base revision is ahead of current committed revision",
            baseRevision: input.baseRevision,
            currentRevision,
            conflicts: [],
            currentState,
            interveningOps: [],
          },
        };
      }

      const parsedIncomingOps: Op[] = [];
      for (const rawOp of input.ops) {
        const parsed = OpSchema.safeParse(rawOp);
        if (!parsed.success) {
          const appliedErr = applyOps(currentState, input.ops, catalog);
          return {
            ok: false,
            status: 422,
            error: {
              code: "VALIDATION_FAILED",
              issues: appliedErr.ok
                ? [
                    {
                      code: "INVALID_OP",
                      path: "ops",
                      message: "Invalid operation payload",
                    },
                  ]
                : appliedErr.errors,
            },
          };
        }
        parsedIncomingOps.push(parsed.data as Op);
      }

      let rebasedFrom: number | undefined;
      if (existingRec && input.baseRevision !== undefined && input.baseRevision < currentRevision) {
        const baseState =
          input.baseRevision === 0
            ? createEmptyBlueprint(input.project)
            : (existingRec.revisions.get(input.baseRevision)?.state ??
              createEmptyBlueprint(input.project));

        const touchedTargets = new Map<
          string,
          { revision: number; author: BlueprintAuthor; opId: string }
        >();
        const interveningOps: unknown[] = [];

        for (let r = input.baseRevision + 1; r <= currentRevision; r += 1) {
          const entry = existingRec.revisions.get(r);
          if (!entry) continue;
          for (const op of entry.ops) {
            interveningOps.push({ ...op, revision: entry.revision, author: entry.author });
            for (const key of collectOpTargets(op, baseState, currentState)) {
              touchedTargets.set(key, {
                revision: entry.revision,
                author: entry.author,
                opId: op.opId,
              });
            }
          }
        }

        const conflicts: BlueprintConflictDetail[] = [];
        for (const incomingOp of parsedIncomingOps) {
          for (const key of collectOpTargets(incomingOp, baseState, currentState)) {
            const hit = touchedTargets.get(key);
            if (hit) {
              conflicts.push({
                opId: incomingOp.opId,
                target: key,
                conflictingRevision: hit.revision,
                conflictingAuthor: hit.author,
              });
              break;
            }
          }
        }

        if (conflicts.length > 0) {
          return {
            ok: false,
            status: 409,
            error: {
              code: "CONFLICT",
              message: "Base revision is stale and changes overlap with committed revisions",
              baseRevision: input.baseRevision,
              currentRevision,
              conflicts,
              currentState,
              interveningOps,
            },
          };
        }

        const rebasedCheck = applyOps(currentState, input.ops, catalog);
        if (!rebasedCheck.ok) {
          const lastEntry = existingRec.revisions.get(currentRevision);
          const fallbackAuthor = lastEntry?.author ?? { type: "agent", id: "agent:mcp" };
          return {
            ok: false,
            status: 409,
            error: {
              code: "CONFLICT",
              message: "Base revision is stale and rebased operations failed validation against current state",
              baseRevision: input.baseRevision,
              currentRevision,
              conflicts: parsedIncomingOps.map((op) => ({
                opId: op.opId,
                target: collectOpTargets(op, baseState, currentState)[0] ?? op.type,
                conflictingRevision: currentRevision,
                conflictingAuthor: fallbackAuthor,
              })),
              currentState,
              interveningOps,
              issues: rebasedCheck.errors,
            },
          };
        }

        rebasedFrom = input.baseRevision;
      }

      const applied = applyOps(currentState, input.ops, catalog);
      if (!applied.ok) {
        return {
          ok: false,
          status: 422,
          error: {
            code: "VALIDATION_FAILED",
            issues: applied.errors,
          },
        };
      }

      const nextState = applied.state;
      const nextHash = semanticHash(nextState);
      const summary = input.summary?.trim() || summarizeProposalOps(parsedIncomingOps);

      if (input.mode === "propose") {
        const proposalId =
          input.proposalId?.trim() ||
          `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const diff = computeSemanticDiff(currentState, nextState);
        const proposedReadiness = computeReadiness(nextState, catalog);
        const proposal: ProposalRecord = {
          proposalId,
          project: input.project,
          baseRev: currentRevision,
          actor: input.author,
          ops: parsedIncomingOps,
          summary,
          status: "pending",
          createdAt: new Date().toISOString(),
          diff,
          proposedState: nextState,
          proposedReadiness,
        };
        return {
          ok: true,
          status: 200,
          data: {
            project: input.project,
            revision: currentRevision,
            parentRevision: currentRevision,
            ...(rebasedFrom !== undefined ? { rebasedFrom } : {}),
            mode: "propose",
            status: "pending",
            proposalId,
            proposal,
            author: input.author,
            summary,
            state: currentState,
            proposedState: nextState,
            semanticHash: existingRec ? existingRec.semanticHash : semanticHash(currentState),
            proposedSemanticHash: nextHash,
            diff,
            readiness: computeReadiness(currentState, catalog),
            proposedReadiness,
          },
        };
      }

      const rec = getOrCreateRecord(input.project)!;
      const parentRevision = currentRevision;
      const nextRevision = currentRevision + 1;

      const revEntry: InMemoryRevisionEntry = {
        revision: nextRevision,
        parentRevision,
        ...(rebasedFrom !== undefined ? { rebasedFrom } : {}),
        author: input.author,
        summary,
        ops: parsedIncomingOps,
        inverseOps: applied.inverseOps,
        state: nextState,
        semanticHash: nextHash,
      };

      rec.currentRevision = nextRevision;
      rec.currentState = nextState;
      rec.semanticHash = nextHash;
      rec.revisions.set(nextRevision, revEntry);
      for (const op of parsedIncomingOps) {
        rec.committedOps.set(op.opId, nextRevision);
      }

      return {
        ok: true,
        status: 200,
        data: {
          project: input.project,
          revision: nextRevision,
          parentRevision,
          ...(rebasedFrom !== undefined ? { rebasedFrom } : {}),
          author: input.author,
          summary,
          state: nextState,
          semanticHash: nextHash,
          readiness: computeReadiness(nextState, catalog),
        },
      };
    },

    async revertToRevision(input): Promise<BlueprintApplyResult> {
      const existingRec = projects.get(input.project);
      const currentRevision = existingRec ? existingRec.currentRevision : 0;
      const currentState = existingRec
        ? existingRec.currentState
        : createEmptyBlueprint(input.project);

      if (input.baseRevision !== undefined && input.baseRevision !== currentRevision) {
        return {
          ok: false,
          status: 409,
          error: {
            code: "CONFLICT",
            message: `Base revision ${input.baseRevision} does not match current revision ${currentRevision}`,
            baseRevision: input.baseRevision,
            currentRevision,
            conflicts: [],
            currentState,
            interveningOps: [],
          },
        };
      }

      if (
        !Number.isInteger(input.targetRevision) ||
        input.targetRevision < 0 ||
        input.targetRevision >= currentRevision ||
        !existingRec
      ) {
        return {
          ok: false,
          status: 422,
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_TARGET_REVISION",
                path: "targetRevision",
                message: `targetRevision ${input.targetRevision} must be an integer between 0 and ${Math.max(0, currentRevision - 1)} (currentRevision is ${currentRevision})`,
                suggestedFix: `Provide a targetRevision < ${currentRevision}`,
              },
            ],
          },
        };
      }

      const nextRevision = currentRevision + 1;
      const revertOps: Op[] = [];
      let idx = 0;
      for (let rev = currentRevision; rev > input.targetRevision; rev -= 1) {
        const entry = existingRec.revisions.get(rev);
        if (!entry) continue;
        for (const invOp of entry.inverseOps) {
          idx += 1;
          revertOps.push({
            ...invOp,
            opId: `revert-r${nextRevision}-to-r${input.targetRevision}-${idx}`,
          });
        }
      }

      return this.applyOps({
        project: input.project,
        baseRevision: currentRevision,
        author: input.author,
        summary: `Revert to revision ${input.targetRevision}`,
        ops: revertOps,
      });
    },

    async seedProject(project: string, state: BlueprintState, revision = 1) {
      const rec = getOrCreateRecord(project)!;
      const hash = semanticHash(state);
      const revEntry: InMemoryRevisionEntry = {
        revision,
        parentRevision: Math.max(0, revision - 1),
        author: { type: "human", id: "eval:seed" },
        summary: "Seed evaluation blueprint",
        ops: [],
        inverseOps: [],
        state,
        semanticHash: hash,
      };
      rec.currentRevision = revision;
      rec.currentState = state;
      rec.semanticHash = hash;
      rec.revisions.set(revision, revEntry);
      return { revision, semanticHash: hash };
    },
  };
}

export function resolveBlueprintClient(
  env: { BLUEPRINT_DO?: BlueprintDoNamespaceLike } | undefined,
  fallback: BlueprintClient,
): BlueprintClient {
  if (env?.BLUEPRINT_DO && typeof env.BLUEPRINT_DO.idFromName === "function") {
    return createDurableObjectBlueprintClient(env.BLUEPRINT_DO);
  }
  return fallback;
}

/** Thrown when a tool reaches for a project other than the one the call was authorised for. */
export class ProjectOutOfScopeError extends Error {
  constructor(project: string) {
    super(`project "${project}" is outside the project this call is authorised for`);
    this.name = "ProjectOutOfScopeError";
  }
}

/**
 * Wraps a BlueprintClient so it only touches `project` (story 0.15). Reads of any other project see nothing; writes to
 * any other project throw. With `project` null, no project is reachable (catalog-only calls).
 */
export function pinBlueprintClient(base: BlueprintClient, project: string | null): BlueprintClient {
  const allowed = (candidate: string) => project !== null && candidate === project;
  const guard = (candidate: string) => {
    if (!allowed(candidate)) throw new ProjectOutOfScopeError(candidate);
  };
  const pinned: BlueprintClient = {
    async getProject(candidate, revision) {
      if (!allowed(candidate)) return null;
      return base.getProject(candidate, revision);
    },
    async applyOps(input) {
      guard(input.project);
      return base.applyOps(input);
    },
    async revertToRevision(input) {
      guard(input.project);
      return base.revertToRevision(input);
    },
  };
  if (base.seedProject) {
    const seed = base.seedProject.bind(base);
    pinned.seedProject = async (candidate, state, revision) => {
      guard(candidate);
      return seed(candidate, state, revision);
    };
  }
  return pinned;
}

export interface BuildSummary {
  files: number;
  bytes: number;
  /** SHA-256 over every file's path and hash, in path order: equal hashes mean identical projects. */
  hash: string;
}

/** The hash of a whole project: composite digest of codeHash, graphHash, and catalogVersion. */
export async function projectHash(files: Record<string, string>): Promise<string> {
  return computeBuildHash(files);
}

/** Replaces the project's stored files with these, in one batch: a reader never sees half of one build and half of another. */
export async function storeBuild(
  db: D1Like,
  project: string,
  files: Record<string, string>,
): Promise<BuildSummary> {
  // mcp_files and mcp_builds are keyed by project, and every statement below binds it (story 16): a build without the
  // authorised project would land in a shared bucket, so it is refused.
  if (typeof project !== "string" || project.trim().length === 0) {
    throw new Error("storeBuild requires the authorised project");
  }
  const hashes = await hashFiles(files);
  const bytes = Object.values(files).reduce(
    (sum, text) => sum + new TextEncoder().encode(text).length,
    0,
  );
  const hash = await projectHash(files);
  await db.batch([
    db.prepare("DELETE FROM mcp_files WHERE project = ?").bind(project),
    ...Object.entries(files).map(([path, content]) =>
      db
        .prepare("INSERT INTO mcp_files (project, path, content, sha256) VALUES (?, ?, ?, ?)")
        .bind(project, path, content, hashes[path]),
    ),
    db
      .prepare(
        "INSERT INTO mcp_builds (project, project_hash, file_count, byte_count) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(project) DO UPDATE SET project_hash = excluded.project_hash, file_count = excluded.file_count, byte_count = excluded.byte_count, built_at = datetime('now')",
      )
      .bind(project, hash, Object.keys(files).length, bytes),
  ]);
  return { files: Object.keys(files).length, bytes, hash };
}

/**
 * Counts one tool call in this minute's window and says whether it is within `limit`. A shared counter in the database,
 * so the limit holds across every instance of the Worker and not just one. Old windows are dropped as it goes.
 */
export async function withinRateLimit(
  db: D1Like,
  limit: number,
  now = Date.now(),
): Promise<boolean> {
  const window = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
  const [, counted] = await db.batch([
    db
      .prepare("DELETE FROM mcp_rate WHERE window < ?")
      .bind(new Date(now - 3_600_000).toISOString()),
    db
      .prepare(
        "INSERT INTO mcp_rate (window, calls) VALUES (?, 1) ON CONFLICT(window) DO UPDATE SET calls = calls + 1 RETURNING calls",
      )
      .bind(window),
  ]);
  const calls = (counted!.results[0] as { calls?: number } | undefined)?.calls ?? 1;
  return calls <= limit;
}
