import type { Catalog } from "@poc/assembler";
import type { Registry } from "@poc/sdk";
import { applyOps, buildCatalogNodeRegistry } from "./apply.ts";
import type { BlueprintValidationError } from "./apply.ts";
import { computeSemanticDiff } from "./diff.ts";
import type { SemanticDiff } from "./diff.ts";
import { semanticHash } from "./hash.ts";
import { OpSchema } from "./ops.ts";
import type { Op } from "./ops.ts";
import { computeReadiness } from "./readiness.ts";
import type { ReadinessResult } from "./readiness.ts";
import { normalizeBlueprintState } from "./schema.ts";
import type { BlueprintState } from "./schema.ts";

export type ProposalStatus =
  | "pending"
  | "accepted"
  | "partially_accepted"
  | "rejected";

export interface ProposalActor {
  type: "human" | "agent";
  id: string;
  client?: string;
  onBehalfOf?: string;
}

export interface ProposalRecord {
  proposalId: string;
  project: string;
  baseRev: number;
  actor: ProposalActor;
  ops: Op[];
  summary: string;
  status: ProposalStatus;
  diff: SemanticDiff;
  proposedState: BlueprintState;
  proposedReadiness: ReadinessResult;
  createdAt: string;
  reviewedAt?: string | null;
  reviewedBy?: ProposalActor | null;
  rejectionReason?: string | null;
  acceptedRev?: number | null;
  acceptedOpIds?: string[] | null;
}

export type ProposalSelectionEvaluation =
  | {
      ok: true;
      selectedOps: Op[];
      selectedOpIds: string[];
      isPartial: boolean;
      state: BlueprintState;
      semanticHash: string;
      diff: SemanticDiff;
      readiness: ReadinessResult;
    }
  | {
      ok: false;
      status: 422;
      error: {
        code: "VALIDATION_FAILED";
        message: string;
        issues: BlueprintValidationError[];
      };
    };

const BLOCKING_PARTIAL_READINESS_CODES = new Set<string>([
  "MISSING_CAPABILITY_PROVIDER",
  "DUPLICATE_CAPABILITY_PROVIDER",
  "MISSING_IDENTITY_BRICK",
  "INVALID_IDENTITY_BRICK",
  "MISSING_ENTITY_HANDLER",
  "MULTIPLE_ENTITY_HANDLERS",
  "no_trigger",
  "multi_trigger",
  "cycle",
  "orphan_node",
  "bad_ref",
  "incompatible_wire",
]);

export function summarizeProposalOps(ops: ReadonlyArray<Op>): string {
  if (ops.length === 0) return "Empty proposal";
  const first = ops[0]!;
  const describeOne = (op: Op): string => {
    switch (op.type) {
      case "enable_brick":
        return `Enable brick ${op.brickId}`;
      case "configure_brick":
        return `Configure brick ${op.brickId}`;
      case "remove_brick":
        return `Remove brick ${op.brickId}`;
      case "set_identity":
        return `Set identity to ${op.identity}`;
      case "add_entity":
        return `Add entity ${op.entity.name}`;
      case "update_entity":
        return `Update entity ${op.entity.name}`;
      case "remove_entity":
        return `Remove entity ${op.name}`;
      case "add_workflow":
        return `Add workflow ${op.workflow.id}`;
      case "remove_workflow":
        return `Remove workflow ${op.workflowId}`;
      case "add_node":
        return `Add node ${op.node.id} to ${op.workflowId}`;
      case "update_node":
        return `Update node ${op.nodeId} in ${op.workflowId}`;
      case "remove_node":
        return `Remove node ${op.nodeId} from ${op.workflowId}`;
      case "connect_edges":
        return `Connect ${op.edges.length} edge(s) in ${op.workflowId}`;
      case "disconnect_edge":
        return `Disconnect edge ${op.edgeId} in ${op.workflowId}`;
      case "bind_secret_ref":
        return `Bind secret ${op.secretName} on ${op.targetId}`;
      case "unbind_secret_ref":
        return `Unbind secret ${op.secretName} on ${op.targetId}`;
      case "set_metadata":
        return "Update blueprint metadata";
    }
  };
  if (ops.length === 1) {
    return describeOne(first);
  }
  return `${describeOne(first)} (+${ops.length - 1} more op${ops.length - 1 === 1 ? "" : "s"})`;
}

/**
 * Evaluates a full or partial selection of `opIds` from a proposal against `currentState`.
 * Preserves the original batch order of `proposalOps`.
 * Validates both local op constraints (via `applyOps`) and cross-op readiness rules.
 */
export function evaluateProposalSelection(
  currentState: BlueprintState,
  proposalOps: ReadonlyArray< unknown>,
  selectedOpIds: ReadonlyArray<string> | undefined,
  catalog: Catalog,
  nodeRegistry?: Registry,
): ProposalSelectionEvaluation {
  const effectiveRegistry = nodeRegistry ?? buildCatalogNodeRegistry(catalog);
  const parsedOps: Op[] = [];
  const parseIssues: BlueprintValidationError[] = [];

  for (let i = 0; i < proposalOps.length; i += 1) {
    const parsed = OpSchema.safeParse(proposalOps[i]);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        parseIssues.push({
          code: "INVALID_OP_SCHEMA",
          path: `ops[${i}]${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""}`,
          message: issue.message,
          suggestedFix: "Provide a valid Blueprint operation matching OpSchema",
        });
      }
    } else {
      parsedOps.push(parsed.data as Op);
    }
  }

  if (parseIssues.length > 0) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        message: parseIssues[0]!.message,
        issues: parseIssues,
      },
    };
  }

  if (parsedOps.length === 0) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        message: "Proposal must contain at least one operation",
        issues: [
          {
            code: "EMPTY_OP_SELECTION",
            path: "ops",
            message: "Proposal must contain at least one operation",
            suggestedFix: "Select at least one operation to apply",
          },
        ],
      },
    };
  }

  let selectedOps: Op[];
  if (selectedOpIds === undefined) {
    selectedOps = parsedOps;
  } else {
    if (selectedOpIds.length === 0) {
      return {
        ok: false,
        status: 422,
        error: {
          code: "VALIDATION_FAILED",
          message: "At least one operation must be selected to accept",
          issues: [
            {
              code: "EMPTY_OP_SELECTION",
              path: "opIds",
              message: "At least one operation must be selected to accept",
              suggestedFix: "Select one or more opIds or use Reject to discard the proposal",
            },
          ],
        },
      };
    }

    const availableById = new Map(parsedOps.map((op) => [op.opId, op]));
    const unknownIds = selectedOpIds.filter((id) => !availableById.has(id));
    if (unknownIds.length > 0) {
      return {
        ok: false,
        status: 422,
        error: {
          code: "VALIDATION_FAILED",
          message: `Unknown opId(s) in selection: ${unknownIds.join(", ")}`,
          issues: unknownIds.map((id) => ({
            code: "UNKNOWN_OP_ID",
            path: `opIds.${id}`,
            message: `Operation "${id}" is not part of this proposal`,
            suggestedFix: `Choose from proposal opIds: ${parsedOps.map((o) => o.opId).join(", ")}`,
          })),
        },
      };
    }

    const selectedSet = new Set(selectedOpIds);
    selectedOps = parsedOps.filter((op) => selectedSet.has(op.opId));
  }

  const normalizedBase = normalizeBlueprintState(currentState);
  const applied = applyOps(normalizedBase, selectedOps, catalog, effectiveRegistry);
  if (!applied.ok) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "VALIDATION_FAILED",
        message:
          applied.errors[0]?.message ??
          "Selected proposal operations failed validation",
        issues: applied.errors,
      },
    };
  }

  const isPartial = selectedOps.length < parsedOps.length;
  const readiness = computeReadiness(applied.state, catalog, effectiveRegistry);

  if (isPartial) {
    const baseReadiness = computeReadiness(normalizedBase, catalog, effectiveRegistry);
    const baseNeedKeys = new Set(
      baseReadiness.needs.map((n) => `${n.code}:${n.path}`),
    );

    const fullApplied = applyOps(normalizedBase, parsedOps, catalog, effectiveRegistry);
    const fullNeedKeys = new Set(
      fullApplied.ok
        ? computeReadiness(fullApplied.state, catalog, effectiveRegistry).needs.map(
            (n) => `${n.code}:${n.path}`,
          )
        : [],
    );

    const brokenReadinessNeeds = readiness.needs.filter(
      (need) =>
        BLOCKING_PARTIAL_READINESS_CODES.has(need.code) &&
        !baseNeedKeys.has(`${need.code}:${need.path}`) &&
        !fullNeedKeys.has(`${need.code}:${need.path}`),
    );

    if (brokenReadinessNeeds.length > 0) {
      return {
        ok: false,
        status: 422,
        error: {
          code: "VALIDATION_FAILED",
          message: brokenReadinessNeeds[0]!.message,
          issues: brokenReadinessNeeds.map((n) => ({
            code: n.code,
            path: n.path,
            message: n.message,
            ...(n.suggestedFix ? { suggestedFix: n.suggestedFix } : {}),
          })),
        },
      };
    }
  }

  const diff = computeSemanticDiff(normalizedBase, applied.state);
  const nextHash = semanticHash(applied.state);

  return {
    ok: true,
    selectedOps,
    selectedOpIds: selectedOps.map((op) => op.opId),
    isPartial,
    state: applied.state,
    semanticHash: nextHash,
    diff,
    readiness,
  };
}
