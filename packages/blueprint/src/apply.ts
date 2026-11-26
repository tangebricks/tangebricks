import { checkBrickConfig, projectIntegrationToNodes } from "@poc/assembler";
import type { Catalog } from "@poc/assembler";
import {
  catalogNodeToBrickManifest,
  checkGraphBudget,
  checkWire,
  parseEntities,
  relationKeyHint,
  relationTargetErrors,
  toyRegistry,
  validateGraph,
} from "@poc/sdk";
import type { BrickManifest, Registry } from "@poc/sdk";
import { OpSchema } from "./ops.ts";
import type { Op } from "./ops.ts";
import {
  BRICK_ID_PATTERN,
  EDGE_ID_PATTERN,
  EntityDefinitionSchema,
  IDENTIFIER_PATTERN,
  NODE_ID_PATTERN,
  WORKFLOW_ID_PATTERN,
  isValidSecretRefHandle,
  normalizeBlueprintState,
  toSdkEntity,
} from "./schema.ts";
import type {
  BlueprintMetadata,
  BlueprintState,
  SettingValue,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from "./schema.ts";

export interface BlueprintValidationError {
  code: string;
  path: string;
  message: string;
  suggestedFix?: string;
}

export type ApplyOpResult =
  | { ok: true; state: BlueprintState; inverseOps: Op[] }
  | { ok: false; errors: BlueprintValidationError[] };

const IDENTITY_CAPABILITY = "user-identity";

export function buildCatalogNodeRegistry(
  catalog: Catalog,
  baseRegistry: Registry = toyRegistry,
): Registry {
  const merged = new Map<string, BrickManifest>(baseRegistry);
  for (const packEntry of Object.values(catalog.nodePacks ?? {})) {
    for (const node of packEntry.manifest.nodes ?? []) {
      if (!merged.has(node.type)) {
        merged.set(node.type, catalogNodeToBrickManifest(node));
      }
    }
  }
  for (const brickEntry of Object.values(catalog.bricks ?? {})) {
    for (const node of brickEntry.manifest.nodes ?? []) {
      if (!merged.has(node.type)) {
        merged.set(node.type, catalogNodeToBrickManifest(node));
      }
    }
  }
  for (const integrationEntry of Object.values(catalog.integrations ?? {})) {
    const nodes =
      integrationEntry.nodes ?? projectIntegrationToNodes(integrationEntry.manifest);
    for (const node of nodes) {
      if (!merged.has(node.type)) {
        merged.set(node.type, catalogNodeToBrickManifest(node));
      }
    }
  }
  return merged;
}

function checkUnsupportedIntegrationNode(
  catalog: Catalog,
  registry: Registry,
  nodeType: string,
): { isUnsupported: boolean; blockingCodes: string[] } {
  const manifest = registry.get(nodeType);
  let isUnsupported = manifest?.availability === "unsupported";
  let blockingCodes: string[] = [];

  const match = /^int:([a-z0-9-]+)\.([A-Za-z0-9_]+)$/.exec(nodeType);
  if (match) {
    const app = match[1];
    const opId = match[2];
    if (app && opId) {
      const intEntry = catalog.integrations?.[app];
      if (intEntry?.manifest?.fidelity?.unsupported) {
        const matching = intEntry.manifest.fidelity.unsupported.filter(
          (e: { op: string | null; blocking: boolean; code: string }) =>
            (e.op === opId || e.op === null || e.op === "*") && e.blocking,
        );
        if (matching.length > 0) {
          isUnsupported = true;
          blockingCodes = matching.map((e: { code: string }) => e.code);
        }
      }
    }
  }

  return { isUnsupported, blockingCodes };
}

function validateWorkflowGraph(
  workflowId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  registry: Registry,
  options: {
    requireTrigger: boolean;
    rejectOrphans: boolean;
  },
): BlueprintValidationError[] {
  const errors: BlueprintValidationError[] = [];
  const byId = new Map<string, WorkflowNode>();
  const seenNodeIds = new Set<string>();

  for (const node of nodes) {
    if (!NODE_ID_PATTERN.test(node.id)) {
      errors.push({
        code: "INVALID_NODE_ID",
        path: `workflows.${workflowId}.nodes.${node.id}`,
        message: `invalid node id "${node.id}"`,
        suggestedFix: "Use an alphanumeric node id (1-64 chars)",
      });
    }
    if (seenNodeIds.has(node.id)) {
      errors.push({
        code: "duplicate_node",
        path: `workflows.${workflowId}.nodes.${node.id}`,
        message: `duplicate node id "${node.id}" in workflow "${workflowId}"`,
        suggestedFix: `Give each node in workflow "${workflowId}" a unique id`,
      });
    }
    seenNodeIds.add(node.id);
    byId.set(node.id, node);
  }

  const seenEdgeIds = new Set<string>();
  const incidentNodes = new Set<string>();
  for (const edge of edges) {
    if (!EDGE_ID_PATTERN.test(edge.id)) {
      errors.push({
        code: "INVALID_EDGE_ID",
        path: `workflows.${workflowId}.edges.${edge.id}`,
        message: `invalid edge id "${edge.id}"`,
        suggestedFix: "Use an alphanumeric edge id (1-128 chars)",
      });
    }
    if (seenEdgeIds.has(edge.id)) {
      errors.push({
        code: "DUPLICATE_EDGE",
        path: `workflows.${workflowId}.edges.${edge.id}`,
        message: `duplicate edge id "${edge.id}" in workflow "${workflowId}"`,
        suggestedFix: `Use a unique edge id within workflow "${workflowId}"`,
      });
    }
    seenEdgeIds.add(edge.id);

    if (!byId.has(edge.source)) {
      errors.push({
        code: "MISSING_EDGE_ENDPOINT",
        path: `workflows.${workflowId}.edges.${edge.id}.source`,
        message: `edge "${edge.id}" references missing source node "${edge.source}"`,
        suggestedFix: `Add node "${edge.source}" before connecting edge "${edge.id}"`,
      });
      continue;
    }
    if (!byId.has(edge.target)) {
      errors.push({
        code: "MISSING_EDGE_ENDPOINT",
        path: `workflows.${workflowId}.edges.${edge.id}.target`,
        message: `edge "${edge.id}" references missing target node "${edge.target}"`,
        suggestedFix: `Add node "${edge.target}" before connecting edge "${edge.id}"`,
      });
      continue;
    }
    incidentNodes.add(edge.source);
    incidentNodes.add(edge.target);

    if (edge.source === edge.target) {
      errors.push({
        code: "SELF_LOOP",
        path: `workflows.${workflowId}.edges.${edge.id}`,
        message: `edge "${edge.id}" connects node "${edge.source}" to itself`,
        suggestedFix: "Connect the edge between two distinct nodes",
      });
    }

    const sourceKnown = registry.has(byId.get(edge.source)!.type);
    const targetKnown = registry.has(byId.get(edge.target)!.type);
    if (sourceKnown && targetKnown) {
      const wireProblem = checkWire(edge, nodes, registry);
      if (wireProblem === "unknown port") {
        errors.push({
          code: "incompatible_wire",
          path: `workflows.${workflowId}.edges.${edge.id}`,
          message: `edge "${edge.id}": unknown port (${edge.sourceHandle ?? "out"} -> ${edge.targetHandle ?? "in"})`,
          suggestedFix: "Specify valid sourceHandle and targetHandle port ids declared by the nodes",
        });
      }
    }
  }

  if (errors.length > 0) {
    return errors;
  }

  const { issues } = validateGraph(nodes, edges, registry);
  for (const issue of issues) {
    if (issue.code === "no_trigger" && !options.requireTrigger) {
      continue;
    }
    if (issue.code === "orphan_node" && !options.rejectOrphans) {
      continue;
    }
    if (issue.code === "bad_ref") {
      const node = byId.get(issue.nodeId);
      if (node && !incidentNodes.has(node.id)) {
        const refs = [...JSON.stringify(node.data).matchAll(/\{\{\$node\.([\w-]+)\./g)].map(
          (m) => m[1]!,
        );
        const allExistAndDistinct = refs.every((r) => byId.has(r) && r !== node.id);
        if (allExistAndDistinct) {
          continue;
        }
      }
    }
    errors.push({
      code: issue.code,
      path: issue.nodeId
        ? `workflows.${workflowId}.nodes.${issue.nodeId}`
        : `workflows.${workflowId}`,
      message: issue.message,
      suggestedFix: suggestedFixForGraphIssue(issue.code),
    });
  }

  const budgetIssues = checkGraphBudget({ nodes, edges }, registry, "free");
  for (const bIssue of budgetIssues) {
    if (bIssue.severity === "error") {
      errors.push({
        code: bIssue.code,
        path: bIssue.nodeId
          ? `workflows.${workflowId}.nodes.${bIssue.nodeId}`
          : `workflows.${workflowId}`,
        message: bIssue.message,
        suggestedFix: bIssue.fix,
      });
    }
  }

  return errors;
}

function suggestedFixForGraphIssue(code: string): string {
  switch (code) {
    case "no_trigger":
      return "Add a trigger node (e.g. trigger.manual) to start the workflow";
    case "multi_trigger":
      return "Keep only one trigger node in the workflow";
    case "cycle":
      return "Remove the edge creating a cycle so the workflow remains a DAG";
    case "orphan_node":
      return "Connect the node to an upstream path reachable from the trigger or remove it";
    case "unknown_brick":
      return "Use a registered node type from the catalog/registry";
    case "invalid_config":
      return "Update the node data fields to match the node's configSchema";
    case "bad_ref":
      return "Reference only upstream nodes that execute before this node";
    case "incompatible_wire":
      return "Connect ports with matching dataType (or dataType 'any') on distinct nodes";
    case "duplicate_node":
      return "Assign a unique id to each node in the workflow";
    default:
      return "Fix the workflow graph validation issue";
  }
}

function reservedRoutesForCatalog(catalog: Catalog, state: BlueprintState): Set<string> {
  const reserved = new Set<string>();
  for (const entry of Object.values(catalog.bricks)) {
    for (const prefix of entry.manifest.routePrefixes) {
      reserved.add(prefix);
    }
  }
  for (const enabled of state.bricks) {
    const entry = catalog.bricks[enabled.id];
    if (entry) {
      for (const prefix of entry.manifest.routePrefixes) {
        reserved.add(prefix);
      }
    }
  }
  return reserved;
}

function checkBrickConflicts(
  brickId: string,
  state: BlueprintState,
  catalog: Catalog,
): BlueprintValidationError[] {
  const errors: BlueprintValidationError[] = [];
  const targetManifest = catalog.bricks[brickId]?.manifest;
  if (!targetManifest) return errors;

  const enabledIds = new Set(state.bricks.map((b) => b.id));
  const reportedPairs = new Set<string>();

  for (const conflict of targetManifest.conflicts ?? []) {
    if (conflict.brick !== brickId && enabledIds.has(conflict.brick)) {
      const pair = [brickId, conflict.brick].sort();
      const pairKey = pair.join("\0");
      if (!reportedPairs.has(pairKey)) {
        reportedPairs.add(pairKey);
        errors.push({
          code: "BRICK_CONFLICT",
          path: `bricks.${brickId}`,
          message: `conflict: ${pair[0]} × ${pair[1]}: ${conflict.reason}`,
          suggestedFix: `Remove conflicting brick "${conflict.brick}" before enabling "${brickId}"`,
        });
      }
    }
  }

  for (const enabled of state.bricks) {
    if (enabled.id === brickId) continue;
    const enabledManifest = catalog.bricks[enabled.id]?.manifest;
    for (const conflict of enabledManifest?.conflicts ?? []) {
      if (conflict.brick === brickId) {
        const pair = [brickId, enabled.id].sort();
        const pairKey = pair.join("\0");
        if (!reportedPairs.has(pairKey)) {
          reportedPairs.add(pairKey);
          errors.push({
            code: "BRICK_CONFLICT",
            path: `bricks.${brickId}`,
            message: `conflict: ${pair[0]} × ${pair[1]}: ${conflict.reason}`,
            suggestedFix: `Remove conflicting brick "${enabled.id}" before enabling "${brickId}"`,
          });
        }
      }
    }
  }

  return errors;
}

/** The message for one schema issue of an entity declaration, with a pointer to `relation` for a wrong relation key. */
function entityIssueMessage(
  entityName: string,
  issue: { path: PropertyKey[]; message: string; code: string; keys?: readonly unknown[] },
): string {
  const hint = issue.code === "unrecognized_keys" ? relationKeyHint(issue.keys) : null;
  return `entities.${entityName}${issue.path.length > 0 ? "." + issue.path.map(String).join(".") : ""}: ${issue.message}${hint ? ` (${hint})` : ""}`;
}

/** The fix to suggest for an entity schema error: the relation pointer when a wrong relation key caused it. */
function entitySchemaFix(message: string, fallback: string): string {
  return relationSuggestedFix(message) ?? fallback;
}

/** Dangling-relation messages for a set of blueprint entities; an entity that cannot be read as SDK is checked elsewhere. */
function danglingRelations(entities: BlueprintState["entities"]): string[] {
  const sdk: ReturnType<typeof toSdkEntity>[] = [];
  for (const entity of entities) {
    try {
      sdk.push(toSdkEntity(entity));
    } catch {
      // not representable; its own validation reports it
    }
  }
  return relationTargetErrors(sdk, new Set(entities.map((e) => e.name)));
}

/** The dangling relations `after` has that `before` did not: only those are refused, so a relation already dangling in a stored blueprint does not block unrelated changes. */
function introducedDanglingRelations(before: BlueprintState["entities"], after: BlueprintState["entities"]): string[] {
  const existing = new Set(danglingRelations(before));
  return danglingRelations(after).filter((message) => !existing.has(message));
}

const RELATION_FIX = 'Declare the entity a relation field names, or change its "relation" to an entity declared in this project';

/** The relation fix for an entity error message: a wrong relation key, or a relation to an undeclared entity. */
export function relationSuggestedFix(message: string): string | undefined {
  if (message.includes('use type "relation" with the "relation" key')) {
    return 'Replace the key with "relation": {"name":"customer_id","type":"relation","relation":"customer"}';
  }
  if (/relates to entity "[^"]+", which is not declared/.test(message)) return RELATION_FIX;
  return undefined;
}

/** A `relation` key on a field that is not of type relation would be silently ignored; refuse it in an op instead. */
function misplacedRelationKeys(entityName: string, entity: { fields: ReadonlyArray<{ name: string; type: string; relation?: string }> }): BlueprintValidationError[] {
  return entity.fields
    .filter((field) => field.type !== "relation" && field.relation !== undefined)
    .map((field) => ({
      code: "INVALID_ENTITY_SCHEMA",
      path: `entities.${entityName}`,
      message: `entities.${entityName}: field "${field.name}" has type "${field.type}" but a "relation" key; a relation is only enforced on a field of type "relation"`,
      suggestedFix: `use type: "relation" with relation: "${field.relation}"`,
    }));
}

export interface ApplyOpOptions {
  /**
   * Leave relation targets unchecked in this op: applyOps checks them once on the final state, so a batch may add an
   * entity and the entity it relates to in either order, or two entities that relate to each other.
   */
  deferRelationTargets?: boolean;
}

export function applyOp(
  state: BlueprintState,
  rawOp: unknown,
  catalog: Catalog,
  nodeRegistry?: Registry,
  options: ApplyOpOptions = {},
): ApplyOpResult {
  const effectiveNodeRegistry =
    nodeRegistry !== undefined ? nodeRegistry : buildCatalogNodeRegistry(catalog, toyRegistry);
  const parsedOp = OpSchema.safeParse(rawOp);
  if (!parsedOp.success) {
    return {
      ok: false,
      errors: parsedOp.error.issues.map((issue) => ({
        code: "INVALID_OP",
        path: issue.path.join(".") || "op",
        message: issue.message,
        suggestedFix: "Ensure the operation matches one of the closed OpSchema union variants",
      })),
    };
  }

  const op = parsedOp.data as Op;
  const availableBricks = Object.keys(catalog.bricks).sort();

  switch (op.type) {
    case "enable_brick": {
      if (!BRICK_ID_PATTERN.test(op.brickId) || !catalog.bricks[op.brickId]) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_BRICK",
              path: `bricks.${op.brickId}`,
              message: `unknown brick "${op.brickId}" (available: ${availableBricks.join(", ") || "none"})`,
              suggestedFix: `Choose a valid brick id from the catalog (e.g. ${availableBricks.slice(0, 5).join(", ")})`,
            },
          ],
        };
      }

      const rawConfig = (op.config ?? {}) as Record<string, SettingValue>;
      const configErrors = checkBrickConfig(op.brickId, rawConfig, catalog);
      if (configErrors.length > 0) {
        return {
          ok: false,
          errors: configErrors.map((msg) => ({
            code: "INVALID_BRICK_CONFIG",
            path: `bricks.${op.brickId}.config`,
            message: msg,
            suggestedFix: `Inspect "${op.brickId}" settings via get_brick and provide valid setting values`,
          })),
        };
      }

      const conflictErrors = checkBrickConflicts(op.brickId, state, catalog);
      if (conflictErrors.length > 0) {
        return { ok: false, errors: conflictErrors };
      }

      const existing = state.bricks.find((b) => b.id === op.brickId);
      const nextBricks = [
        ...state.bricks.filter((b) => b.id !== op.brickId),
        { id: op.brickId, config: { ...rawConfig } },
      ];
      const nextState = normalizeBlueprintState({
        ...state,
        bricks: nextBricks,
      });

      const inverseOps: Op[] = existing
        ? [
            {
              opId: `${op.opId}:inv`,
              type: "configure_brick",
              brickId: op.brickId,
              config: { ...existing.config },
              replace: true,
            },
          ]
        : [
            {
              opId: `${op.opId}:inv`,
              type: "remove_brick",
              brickId: op.brickId,
            },
          ];

      return { ok: true, state: nextState, inverseOps };
    }

    case "configure_brick": {
      if (!BRICK_ID_PATTERN.test(op.brickId) || !catalog.bricks[op.brickId]) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_BRICK",
              path: `bricks.${op.brickId}`,
              message: `unknown brick "${op.brickId}" (available: ${availableBricks.join(", ") || "none"})`,
              suggestedFix: `Choose a valid brick id from the catalog`,
            },
          ],
        };
      }

      const existing = state.bricks.find((b) => b.id === op.brickId);
      if (!existing) {
        return {
          ok: false,
          errors: [
            {
              code: "BRICK_NOT_ENABLED",
              path: `bricks.${op.brickId}`,
              message: `brick "${op.brickId}" is not enabled in project "${state.project}"`,
              suggestedFix: `Enable brick "${op.brickId}" with enable_brick before configuring it`,
            },
          ],
        };
      }

      const mergedConfig = (
        op.replace ? { ...op.config } : { ...existing.config, ...op.config }
      ) as Record<string, SettingValue>;
      const configErrors = checkBrickConfig(op.brickId, mergedConfig, catalog);
      if (configErrors.length > 0) {
        return {
          ok: false,
          errors: configErrors.map((msg) => ({
            code: "INVALID_BRICK_CONFIG",
            path: `bricks.${op.brickId}.config`,
            message: msg,
            suggestedFix: `Inspect "${op.brickId}" settings via get_brick and provide valid setting values`,
          })),
        };
      }

      const nextState = normalizeBlueprintState({
        ...state,
        bricks: state.bricks.map((b) =>
          b.id === op.brickId ? { id: b.id, config: mergedConfig } : b,
        ),
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "configure_brick",
            brickId: op.brickId,
            config: { ...existing.config },
            replace: true,
          },
        ],
      };
    }

    case "remove_brick": {
      const existing = state.bricks.find((b) => b.id === op.brickId);
      if (!existing) {
        const isKnown = Boolean(catalog.bricks[op.brickId]);
        return {
          ok: false,
          errors: [
            {
              code: isKnown ? "BRICK_NOT_ENABLED" : "UNKNOWN_BRICK",
              path: `bricks.${op.brickId}`,
              message: isKnown
                ? `brick "${op.brickId}" is not enabled in project "${state.project}"`
                : `unknown brick "${op.brickId}"`,
              suggestedFix: isKnown
                ? `Check enabled bricks before calling remove_brick`
                : `Specify a valid enabled brick id`,
            },
          ],
        };
      }

      const nextState = normalizeBlueprintState({
        ...state,
        bricks: state.bricks.filter((b) => b.id !== op.brickId),
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "enable_brick",
            brickId: existing.id,
            config: { ...existing.config },
          },
        ],
      };
    }

    case "set_identity": {
      if (op.identity !== "stub") {
        const entry = catalog.bricks[op.identity];
        if (!BRICK_ID_PATTERN.test(op.identity) || !entry) {
          return {
            ok: false,
            errors: [
              {
                code: "UNKNOWN_BRICK",
                path: "identity",
                message: `unknown identity brick "${op.identity}"`,
                suggestedFix: `Use "stub", "core-auth", or another brick that provides "${IDENTITY_CAPABILITY}"`,
              },
            ],
          };
        }
        // A capability may carry a version ("user-identity@1.0.0"); compare the name, as the assembler does.
        if (!entry.manifest.provides.some((p) => (p.includes("@") ? p.slice(0, p.indexOf("@")) : p) === IDENTITY_CAPABILITY)) {
          return {
            ok: false,
            errors: [
              {
                code: "INVALID_IDENTITY_BRICK",
                path: "identity",
                message: `identity "${op.identity}" does not provide "${IDENTITY_CAPABILITY}"`,
                suggestedFix: `Use "stub", "core-auth", or a brick whose manifest provides "${IDENTITY_CAPABILITY}"`,
              },
            ],
          };
        }
      }

      const previousIdentity = state.identity;
      const nextState = normalizeBlueprintState({
        ...state,
        identity: op.identity,
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "set_identity",
            identity: previousIdentity,
          },
        ],
      };
    }

    case "add_entity": {
      const entityName = op.entity?.name ?? "";
      if (state.entities.some((e) => e.name === entityName)) {
        return {
          ok: false,
          errors: [
            {
              code: "DUPLICATE_ENTITY",
              path: `entities.${entityName}`,
              message: `entity "${entityName}" is already declared`,
              suggestedFix: `Use update_entity to modify "${entityName}" or choose a unique entity name`,
            },
          ],
        };
      }

      const reserved = reservedRoutesForCatalog(catalog, state);
      if (reserved.has(entityName)) {
        return {
          ok: false,
          errors: [
            {
              code: "ENTITY_ROUTE_COLLISION",
              path: `entities.${entityName}`,
              message: `entity "${entityName}" uses a name that a brick's routes already use`,
              suggestedFix: `Rename entity "${entityName}" so it does not collide with reserved route prefixes`,
            },
          ],
        };
      }

      const validatedEntity = EntityDefinitionSchema.safeParse(op.entity);
      if (!validatedEntity.success) {
        return {
          ok: false,
          errors: validatedEntity.error.issues.map((issue) => {
            const message = entityIssueMessage(entityName || "0", issue);
            return {
              code: "INVALID_ENTITY_SCHEMA",
              path: `entities.${entityName || "0"}`,
              message,
              suggestedFix: entitySchemaFix(
                message,
                "Ensure entity name and fields satisfy EntitySchema (snake_case names, non-reserved columns, valid bounds)",
              ),
            };
          }),
        };
      }

      const misplacedAdd = misplacedRelationKeys(entityName || "0", validatedEntity.data);
      if (misplacedAdd.length > 0) return { ok: false, errors: misplacedAdd };

      const parsed = parseEntities(
        [...state.entities.map(toSdkEntity), toSdkEntity(validatedEntity.data)],
        reserved,
        "free",
        { skipRelationTargets: true },
      );
      if (!parsed.ok) {
        return {
          ok: false,
          errors: parsed.errors.map((err) => ({
            code: err.includes("routes already use")
              ? "ENTITY_ROUTE_COLLISION"
              : "INVALID_ENTITY_SCHEMA",
            path: `entities.${entityName || "0"}`,
            message: err,
            suggestedFix:
              "Ensure entity name and fields satisfy EntitySchema (snake_case names, non-reserved columns, valid bounds)",
          })),
        };
      }

      const addedEntities = [...state.entities, validatedEntity.data];
      if (!options.deferRelationTargets) {
        const introduced = introducedDanglingRelations(state.entities, addedEntities);
        if (introduced.length > 0) {
          return {
            ok: false,
            errors: introduced.map((message) => ({ code: "INVALID_ENTITY_SCHEMA", path: `entities.${entityName || "0"}`, message, suggestedFix: RELATION_FIX })),
          };
        }
      }

      const nextState = normalizeBlueprintState({
        ...state,
        entities: addedEntities,
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "remove_entity",
            name: entityName,
          },
        ],
      };
    }

    case "update_entity": {
      const entityName = op.entity?.name ?? "";
      const existing = state.entities.find((e) => e.name === entityName);
      if (!existing) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_ENTITY",
              path: `entities.${entityName}`,
              message: `entity "${entityName}" does not exist in project "${state.project}"`,
              suggestedFix: `Use add_entity to create "${entityName}" before updating it`,
            },
          ],
        };
      }

      const validatedEntity = EntityDefinitionSchema.safeParse(op.entity);
      if (!validatedEntity.success) {
        return {
          ok: false,
          errors: validatedEntity.error.issues.map((issue) => {
            const message = entityIssueMessage(entityName, issue);
            return {
              code: "INVALID_ENTITY_SCHEMA",
              path: `entities.${entityName}`,
              message,
              suggestedFix: entitySchemaFix(
                message,
                "Ensure entity fields satisfy EntitySchema (snake_case names, non-reserved columns, valid bounds)",
              ),
            };
          }),
        };
      }

      const misplacedUpdate = misplacedRelationKeys(entityName, validatedEntity.data);
      if (misplacedUpdate.length > 0) return { ok: false, errors: misplacedUpdate };

      const reserved = reservedRoutesForCatalog(catalog, state);
      const parsed = parseEntities(
        [
          ...state.entities.filter((e) => e.name !== entityName).map(toSdkEntity),
          toSdkEntity(validatedEntity.data),
        ],
        reserved,
        "free",
        { skipRelationTargets: true },
      );
      if (!parsed.ok) {
        return {
          ok: false,
          errors: parsed.errors.map((err) => ({
            code: err.includes("routes already use")
              ? "ENTITY_ROUTE_COLLISION"
              : "INVALID_ENTITY_SCHEMA",
            path: `entities.${entityName}`,
            message: err,
            suggestedFix:
              "Ensure entity fields satisfy EntitySchema (snake_case names, non-reserved columns, valid bounds)",
          })),
        };
      }

      const updatedEntities = [...state.entities.filter((e) => e.name !== entityName), validatedEntity.data];
      if (!options.deferRelationTargets) {
        const introduced = introducedDanglingRelations(state.entities, updatedEntities);
        if (introduced.length > 0) {
          return {
            ok: false,
            errors: introduced.map((message) => ({ code: "INVALID_ENTITY_SCHEMA", path: `entities.${entityName}`, message, suggestedFix: RELATION_FIX })),
          };
        }
      }

      const nextState = normalizeBlueprintState({
        ...state,
        entities: updatedEntities,
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "update_entity",
            entity: structuredClone(existing),
          },
        ],
      };
    }

    case "remove_entity": {
      const existing = state.entities.find((e) => e.name === op.name);
      if (!existing) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_ENTITY",
              path: `entities.${op.name}`,
              message: `entity "${op.name}" does not exist in project "${state.project}"`,
              suggestedFix: "Specify the name of an existing declared entity",
            },
          ],
        };
      }

      const remaining = state.entities.filter((e) => e.name !== op.name);
      if (!options.deferRelationTargets) {
        const dangling = introducedDanglingRelations(state.entities, remaining);
        if (dangling.length > 0) {
          return {
            ok: false,
            errors: dangling.map((message) => ({
              code: "INVALID_ENTITY_SCHEMA",
              path: `entities.${op.name}`,
              message,
              suggestedFix: `Remove or change the relation fields that point at "${op.name}" before removing it`,
            })),
          };
        }
      }

      const nextState = normalizeBlueprintState({
        ...state,
        entities: remaining,
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "add_entity",
            entity: structuredClone(existing),
          },
        ],
      };
    }

    case "add_workflow": {
      const wfId = op.workflow.id;
      if (!WORKFLOW_ID_PATTERN.test(wfId)) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_WORKFLOW_ID",
              path: `workflows.${wfId}`,
              message: `invalid workflow id "${wfId}"`,
              suggestedFix: "Use an alphanumeric workflow id (1-64 chars, hyphens/underscores allowed)",
            },
          ],
        };
      }

      if (state.workflows.some((w) => w.id === wfId)) {
        return {
          ok: false,
          errors: [
            {
              code: "DUPLICATE_WORKFLOW",
              path: `workflows.${wfId}`,
              message: `workflow "${wfId}" already exists`,
              suggestedFix: `Choose a unique workflow id or modify "${wfId}" with node/edge ops`,
            },
          ],
        };
      }

      const nodes = op.workflow.nodes ?? [];
      const edges = op.workflow.edges ?? [];
      if (nodes.length > 0 || edges.length > 0) {
        const graphErrors = validateWorkflowGraph(wfId, nodes, edges, effectiveNodeRegistry, {
          requireTrigger: true,
          rejectOrphans: edges.length > 0,
        });
        if (graphErrors.length > 0) {
          return { ok: false, errors: graphErrors };
        }
      }

      const newWorkflow: Workflow = {
        id: wfId,
        name: op.workflow.name,
        ...(op.workflow.trigger !== undefined ? { trigger: op.workflow.trigger } : {}),
        nodes: structuredClone(nodes),
        edges: structuredClone(edges),
      };

      const nextState = normalizeBlueprintState({
        ...state,
        workflows: [...state.workflows, newWorkflow],
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "remove_workflow",
            workflowId: wfId,
          },
        ],
      };
    }

    case "remove_workflow": {
      const existing = state.workflows.find((w) => w.id === op.workflowId);
      if (!existing) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_WORKFLOW",
              path: `workflows.${op.workflowId}`,
              message: `workflow "${op.workflowId}" does not exist`,
              suggestedFix: "Create the workflow with add_workflow first",
            },
          ],
        };
      }

      const nextState = normalizeBlueprintState({
        ...state,
        workflows: state.workflows.filter((w) => w.id !== op.workflowId),
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "add_workflow",
            workflow: structuredClone(existing),
          },
        ],
      };
    }

    case "add_node": {
      const wf = state.workflows.find((w) => w.id === op.workflowId);
      if (!wf) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_WORKFLOW",
              path: `workflows.${op.workflowId}`,
              message: `workflow "${op.workflowId}" does not exist`,
              suggestedFix: `Create workflow "${op.workflowId}" with add_workflow before adding nodes`,
            },
          ],
        };
      }

      if (wf.nodes.some((n) => n.id === op.node.id)) {
        return {
          ok: false,
          errors: [
            {
              code: "duplicate_node",
              path: `workflows.${op.workflowId}.nodes.${op.node.id}`,
              message: `node "${op.node.id}" already exists in workflow "${op.workflowId}"`,
              suggestedFix: `Use update_node to modify "${op.node.id}" or pick a unique node id`,
            },
          ],
        };
      }

      const { isUnsupported: addIsUnsupported, blockingCodes: addBlockingCodes } =
        checkUnsupportedIntegrationNode(catalog, effectiveNodeRegistry, op.node.type);
      if (addIsUnsupported) {
        const details = addBlockingCodes.join(", ") || "blocking fidelity loss";
        return {
          ok: false,
          errors: [
            {
              code: "INTEGRATION_OPERATION_UNSUPPORTED",
              path: `workflows.${op.workflowId}.nodes.${op.node.id}`,
              message: `Integration operation "${op.node.type}" cannot run faithfully: ${details}`,
              suggestedFix: `Resolve blocking fidelity issues (${details}) or select a supported operation`,
            },
          ],
        };
      }

      const nextNodes = [...wf.nodes, structuredClone(op.node)];
      const graphErrors = validateWorkflowGraph(
        op.workflowId,
        nextNodes,
        wf.edges,
        effectiveNodeRegistry,
        {
          requireTrigger: false,
          rejectOrphans: false,
        },
      );
      if (graphErrors.length > 0) {
        return { ok: false, errors: graphErrors };
      }

      const nextState = normalizeBlueprintState({
        ...state,
        workflows: state.workflows.map((w) =>
          w.id === op.workflowId ? { ...w, nodes: nextNodes } : w,
        ),
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "remove_node",
            workflowId: op.workflowId,
            nodeId: op.node.id,
          },
        ],
      };
    }

    case "update_node": {
      const wf = state.workflows.find((w) => w.id === op.workflowId);
      if (!wf) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_WORKFLOW",
              path: `workflows.${op.workflowId}`,
              message: `workflow "${op.workflowId}" does not exist`,
              suggestedFix: `Check the workflowId before calling update_node`,
            },
          ],
        };
      }

      const existingNode = wf.nodes.find((n) => n.id === op.nodeId);
      if (!existingNode) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_NODE",
              path: `workflows.${op.workflowId}.nodes.${op.nodeId}`,
              message: `node "${op.nodeId}" does not exist in workflow "${op.workflowId}"`,
              suggestedFix: `Add node "${op.nodeId}" with add_node before updating it`,
            },
          ],
        };
      }

      const nextType = op.node?.type ?? op.patch?.type ?? op.nodeType ?? existingNode.type;

      const { isUnsupported: updIsUnsupported, blockingCodes: updBlockingCodes } =
        checkUnsupportedIntegrationNode(catalog, effectiveNodeRegistry, nextType);
      if (updIsUnsupported) {
        const details = updBlockingCodes.join(", ") || "blocking fidelity loss";
        return {
          ok: false,
          errors: [
            {
              code: "INTEGRATION_OPERATION_UNSUPPORTED",
              path: `workflows.${op.workflowId}.nodes.${op.nodeId}`,
              message: `Integration operation "${nextType}" cannot run faithfully: ${details}`,
              suggestedFix: `Resolve blocking fidelity issues (${details}) or select a supported operation`,
            },
          ],
        };
      }
      const nextData = structuredClone(
        op.node?.data ?? op.patch?.data ?? op.data ?? existingNode.data,
      );
      let nextLabel = existingNode.label;
      if (op.node !== undefined) {
        nextLabel = op.node.label;
      } else if (op.patch && "label" in op.patch) {
        nextLabel = op.patch.label ?? undefined;
      } else if ("label" in op && op.label !== undefined) {
        nextLabel = op.label ?? undefined;
      }

      const nextPosition = op.node?.position ?? op.patch?.position ?? existingNode.position;
      const updatedNode: WorkflowNode = {
        id: existingNode.id,
        type: nextType,
        ...(nextLabel !== undefined ? { label: nextLabel } : {}),
        data: nextData,
        ...(nextPosition !== undefined
          ? { position: { x: nextPosition.x, y: nextPosition.y } }
          : {}),
      };

      const nextNodes = wf.nodes.map((n) => (n.id === op.nodeId ? updatedNode : n));
      const graphErrors = validateWorkflowGraph(
        op.workflowId,
        nextNodes,
        wf.edges,
        effectiveNodeRegistry,
        {
          requireTrigger: false,
          rejectOrphans: false,
        },
      );
      if (graphErrors.length > 0) {
        return { ok: false, errors: graphErrors };
      }

      const nextState = normalizeBlueprintState({
        ...state,
        workflows: state.workflows.map((w) =>
          w.id === op.workflowId ? { ...w, nodes: nextNodes } : w,
        ),
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "update_node",
            workflowId: op.workflowId,
            nodeId: op.nodeId,
            node: structuredClone(existingNode),
          },
        ],
      };
    }

    case "remove_node": {
      const wf = state.workflows.find((w) => w.id === op.workflowId);
      if (!wf) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_WORKFLOW",
              path: `workflows.${op.workflowId}`,
              message: `workflow "${op.workflowId}" does not exist`,
              suggestedFix: "Specify an existing workflowId",
            },
          ],
        };
      }

      const existingNode = wf.nodes.find((n) => n.id === op.nodeId);
      if (!existingNode) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_NODE",
              path: `workflows.${op.workflowId}.nodes.${op.nodeId}`,
              message: `node "${op.nodeId}" does not exist in workflow "${op.workflowId}"`,
              suggestedFix: "Specify an existing nodeId in the workflow",
            },
          ],
        };
      }

      const removedEdges = wf.edges.filter(
        (e) => e.source === op.nodeId || e.target === op.nodeId,
      );
      const nextEdges = wf.edges.filter(
        (e) => e.source !== op.nodeId && e.target !== op.nodeId,
      );
      const nextNodes = wf.nodes.filter((n) => n.id !== op.nodeId);

      const graphErrors = validateWorkflowGraph(
        op.workflowId,
        nextNodes,
        nextEdges,
        effectiveNodeRegistry,
        {
          requireTrigger: false,
          rejectOrphans: false,
        },
      );
      if (graphErrors.length > 0) {
        return { ok: false, errors: graphErrors };
      }

      const nextState = normalizeBlueprintState({
        ...state,
        workflows: state.workflows.map((w) =>
          w.id === op.workflowId ? { ...w, nodes: nextNodes, edges: nextEdges } : w,
        ),
      });

      const inverseOps: Op[] = [
        {
          opId: removedEdges.length > 0 ? `${op.opId}:inv:node` : `${op.opId}:inv`,
          type: "add_node",
          workflowId: op.workflowId,
          node: structuredClone(existingNode),
        },
      ];
      if (removedEdges.length > 0) {
        inverseOps.push({
          opId: `${op.opId}:inv:edges`,
          type: "connect_edges",
          workflowId: op.workflowId,
          edges: structuredClone(removedEdges),
        });
      }

      return { ok: true, state: nextState, inverseOps };
    }

    case "connect_edges": {
      const wf = state.workflows.find((w) => w.id === op.workflowId);
      if (!wf) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_WORKFLOW",
              path: `workflows.${op.workflowId}`,
              message: `workflow "${op.workflowId}" does not exist`,
              suggestedFix: `Create workflow "${op.workflowId}" before connecting edges`,
            },
          ],
        };
      }

      const nextEdges = [...wf.edges, ...structuredClone(op.edges)];
      const graphErrors = validateWorkflowGraph(
        op.workflowId,
        wf.nodes,
        nextEdges,
        effectiveNodeRegistry,
        {
          requireTrigger: true,
          rejectOrphans: false,
        },
      );
      if (graphErrors.length > 0) {
        return { ok: false, errors: graphErrors };
      }

      const nextState = normalizeBlueprintState({
        ...state,
        workflows: state.workflows.map((w) =>
          w.id === op.workflowId ? { ...w, edges: nextEdges } : w,
        ),
      });

      const inverseOps: Op[] = [...op.edges].reverse().map((edge, idx) => ({
        opId: op.edges.length === 1 ? `${op.opId}:inv` : `${op.opId}:inv:${idx}`,
        type: "disconnect_edge",
        workflowId: op.workflowId,
        edgeId: edge.id,
      }));

      return { ok: true, state: nextState, inverseOps };
    }

    case "disconnect_edge": {
      const wf = state.workflows.find((w) => w.id === op.workflowId);
      if (!wf) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_WORKFLOW",
              path: `workflows.${op.workflowId}`,
              message: `workflow "${op.workflowId}" does not exist`,
              suggestedFix: "Specify an existing workflowId",
            },
          ],
        };
      }

      const existingEdge = wf.edges.find((e) => e.id === op.edgeId);
      if (!existingEdge) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_EDGE",
              path: `workflows.${op.workflowId}.edges.${op.edgeId}`,
              message: `edge "${op.edgeId}" does not exist in workflow "${op.workflowId}"`,
              suggestedFix: "Specify an existing edgeId in the workflow",
            },
          ],
        };
      }

      const nextEdges = wf.edges.filter((e) => e.id !== op.edgeId);
      const graphErrors = validateWorkflowGraph(
        op.workflowId,
        wf.nodes,
        nextEdges,
        effectiveNodeRegistry,
        {
          requireTrigger: false,
          rejectOrphans: false,
        },
      );
      if (graphErrors.length > 0) {
        return { ok: false, errors: graphErrors };
      }

      const nextState = normalizeBlueprintState({
        ...state,
        workflows: state.workflows.map((w) =>
          w.id === op.workflowId ? { ...w, edges: nextEdges } : w,
        ),
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "connect_edges",
            workflowId: op.workflowId,
            edges: [structuredClone(existingEdge)],
          },
        ],
      };
    }

    case "bind_secret_ref": {
      const path = `secretRefs.${op.targetKind}.${op.targetId}.${op.secretName}`;
      if (!IDENTIFIER_PATTERN.test(op.secretName)) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_SECRET_REF",
              path,
              message: `invalid secretName "${op.secretName}"`,
              suggestedFix: "Use a valid identifier for secretName (e.g. 'API_SECRET_KEY')",
            },
          ],
        };
      }

      if (op.targetKind === "brick" && !catalog.bricks[op.targetId]) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_BRICK",
              path,
              message: `unknown brick "${op.targetId}" for secret binding`,
              suggestedFix: `Use a valid brick id from the catalog`,
            },
          ],
        };
      }

      const existing = state.secretRefs.find(
        (s) =>
          s.targetKind === op.targetKind &&
          s.targetId === op.targetId &&
          s.secretName === op.secretName,
      );

      if (op.ref === null) {
        if (!existing) {
          return {
            ok: false,
            errors: [
              {
                code: "UNKNOWN_SECRET_REF",
                path,
                message: `no secret ref bound for ${op.targetKind}:${op.targetId}:${op.secretName}`,
                suggestedFix: "Check bound secretRefs before unbinding",
              },
            ],
          };
        }

        const nextState = normalizeBlueprintState({
          ...state,
          secretRefs: state.secretRefs.filter((s) => s !== existing),
        });

        return {
          ok: true,
          state: nextState,
          inverseOps: [
            {
              opId: `${op.opId}:inv`,
              type: "bind_secret_ref",
              ref: existing.ref,
              targetKind: existing.targetKind,
              targetId: existing.targetId,
              secretName: existing.secretName,
            },
          ],
        };
      }

      const handleCheck = isValidSecretRefHandle(op.ref);
      if (!handleCheck.ok) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_SECRET_REF",
              path,
              message: handleCheck.reason,
              suggestedFix:
                'Pass a clean secret reference handle (such as "sec_stripe_key" or "STRIPE_API_KEY_REF"), never a raw secret value',
            },
          ],
        };
      }

      const nextSecretRefs = [
        ...state.secretRefs.filter(
          (s) =>
            !(
              s.targetKind === op.targetKind &&
              s.targetId === op.targetId &&
              s.secretName === op.secretName
            ),
        ),
        {
          ref: op.ref,
          targetKind: op.targetKind,
          targetId: op.targetId,
          secretName: op.secretName,
        },
      ];

      const nextState = normalizeBlueprintState({
        ...state,
        secretRefs: nextSecretRefs,
      });

      const inverseOps: Op[] = existing
        ? [
            {
              opId: `${op.opId}:inv`,
              type: "bind_secret_ref",
              ref: existing.ref,
              targetKind: existing.targetKind,
              targetId: existing.targetId,
              secretName: existing.secretName,
            },
          ]
        : [
            {
              opId: `${op.opId}:inv`,
              type: "unbind_secret_ref",
              targetKind: op.targetKind,
              targetId: op.targetId,
              secretName: op.secretName,
              ref: op.ref,
            },
          ];

      return { ok: true, state: nextState, inverseOps };
    }

    case "unbind_secret_ref": {
      const path = `secretRefs.${op.targetKind}.${op.targetId}.${op.secretName}`;
      const existing = state.secretRefs.find(
        (s) =>
          s.targetKind === op.targetKind &&
          s.targetId === op.targetId &&
          s.secretName === op.secretName,
      );
      if (!existing) {
        return {
          ok: false,
          errors: [
            {
              code: "UNKNOWN_SECRET_REF",
              path,
              message: `no secret ref bound for ${op.targetKind}:${op.targetId}:${op.secretName}`,
              suggestedFix: "Check bound secretRefs before unbinding",
            },
          ],
        };
      }

      const nextState = normalizeBlueprintState({
        ...state,
        secretRefs: state.secretRefs.filter((s) => s !== existing),
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "bind_secret_ref",
            ref: existing.ref,
            targetKind: existing.targetKind,
            targetId: existing.targetId,
            secretName: existing.secretName,
          },
        ],
      };
    }

    case "set_metadata": {
      const previousMetadata = structuredClone(state.metadata ?? {});
      const baseMeta: BlueprintMetadata = op.replace ? {} : structuredClone(state.metadata ?? {});

      if ("displayName" in op.metadata) {
        if (op.metadata.displayName === null || op.metadata.displayName === undefined) {
          delete baseMeta.displayName;
        } else {
          baseMeta.displayName = op.metadata.displayName;
        }
      }
      if ("description" in op.metadata) {
        if (op.metadata.description === null || op.metadata.description === undefined) {
          delete baseMeta.description;
        } else {
          baseMeta.description = op.metadata.description;
        }
      }
      if ("catalogVersion" in op.metadata) {
        if (op.metadata.catalogVersion === null || op.metadata.catalogVersion === undefined) {
          delete baseMeta.catalogVersion;
        } else {
          baseMeta.catalogVersion = op.metadata.catalogVersion;
        }
      }
      if ("viewport" in op.metadata) {
        if (op.metadata.viewport === null || op.metadata.viewport === undefined) {
          delete baseMeta.viewport;
        } else {
          baseMeta.viewport = { ...op.metadata.viewport };
        }
      }
      if ("layout" in op.metadata) {
        if (op.metadata.layout === null || op.metadata.layout === undefined) {
          delete baseMeta.layout;
        } else {
          const nextLayout: Record<string, { x: number; y: number }> = op.replace
            ? {}
            : { ...baseMeta.layout };
          for (const [nodeId, coords] of Object.entries(op.metadata.layout)) {
            if (coords === null || coords === undefined) {
              delete nextLayout[nodeId];
            } else {
              nextLayout[nodeId] = { x: coords.x, y: coords.y };
            }
          }
          baseMeta.layout = nextLayout;
        }
      }

      const nextState = normalizeBlueprintState({
        ...state,
        metadata: baseMeta,
      });

      return {
        ok: true,
        state: nextState,
        inverseOps: [
          {
            opId: `${op.opId}:inv`,
            type: "set_metadata",
            metadata: previousMetadata,
            replace: true,
          },
        ],
      };
    }
  }
}

export function applyOps(
  state: BlueprintState,
  ops: ReadonlyArray<unknown>,
  catalog: Catalog,
  nodeRegistry?: Registry,
): ApplyOpResult {
  let current = normalizeBlueprintState(state);
  const initialEntities = current.entities;
  const inverseOps: Op[] = [];

  let touchedEntities = false;
  for (const op of ops) {
    const res = applyOp(current, op, catalog, nodeRegistry, { deferRelationTargets: true });
    if (!res.ok) {
      return res;
    }
    const type = (op as { type?: unknown } | null)?.type;
    if (type === "add_entity" || type === "update_entity" || type === "remove_entity") touchedEntities = true;
    current = res.state;
    inverseOps.unshift(...res.inverseOps);
  }

  // Relation targets are checked once, on the result of the whole batch (see ApplyOpOptions.deferRelationTargets).
  if (touchedEntities) {
    // Only what the batch introduced: a relation already dangling before it does not block it.
    const dangling = introducedDanglingRelations(initialEntities, current.entities);
    if (dangling.length > 0) {
      return {
        ok: false,
        errors: dangling.map((message) => ({ code: "INVALID_ENTITY_SCHEMA", path: "entities", message, suggestedFix: RELATION_FIX })),
      };
    }
  }

  return { ok: true, state: current, inverseOps };
}
