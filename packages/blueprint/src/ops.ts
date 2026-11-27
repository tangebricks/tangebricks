import { z } from "zod";
import { NodePositionSchema, SecretRefTargetKindSchema, ViewportSchema, WorkflowEdgeSchema, WorkflowNodeSchema, WorkflowTriggerSchema } from "./schema.ts";
import type {
  BlueprintMetadata,
  BlueprintState,
  EntityDefinition,
  NodePosition,
  SecretRefTargetKind,
  SettingValue,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from "./schema.ts";

export const OP_TYPES = [
  "enable_brick",
  "configure_brick",
  "remove_brick",
  "set_identity",
  "add_entity",
  "update_entity",
  "remove_entity",
  "add_workflow",
  "remove_workflow",
  "add_node",
  "update_node",
  "remove_node",
  "connect_edges",
  "disconnect_edge",
  "bind_secret_ref",
  "unbind_secret_ref",
  "set_metadata",
] as const;

export type OpType = (typeof OP_TYPES)[number];

const OpIdSchema = z.string().min(1).max(128);

const EntityInputSchema = z
  .object({
    name: z.string(),
    workspaceScoped: z.boolean().optional(),
    fields: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const WorkflowInputSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  trigger: WorkflowTriggerSchema.optional(),
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
});

export const EnableBrickOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("enable_brick"),
  brickId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const ConfigureBrickOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("configure_brick"),
  brickId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  replace: z.boolean().optional(),
});

export const RemoveBrickOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("remove_brick"),
  brickId: z.string().min(1),
});

export const SetIdentityOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("set_identity"),
  identity: z.string().min(1),
});

export const AddEntityOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("add_entity"),
  entity: EntityInputSchema,
});

export const UpdateEntityOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("update_entity"),
  entity: EntityInputSchema,
});

export const RemoveEntityOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("remove_entity"),
  name: z.string().min(1),
});

export const AddWorkflowOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("add_workflow"),
  workflow: WorkflowInputSchema,
});

export const RemoveWorkflowOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("remove_workflow"),
  workflowId: z.string().min(1),
});

export const AddNodeOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("add_node"),
  workflowId: z.string().min(1),
  node: WorkflowNodeSchema,
});

export const NodePatchSchema = z.strictObject({
  type: z.string().min(1).max(120).optional(),
  label: z.string().min(1).max(120).nullable().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  position: NodePositionSchema.optional(),
});

export const UpdateNodeOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("update_node"),
  workflowId: z.string().min(1),
  nodeId: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
  label: z.string().min(1).max(120).nullable().optional(),
  nodeType: z.string().min(1).max(120).optional(),
  patch: NodePatchSchema.optional(),
  node: WorkflowNodeSchema.optional(),
});

export const RemoveNodeOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("remove_node"),
  workflowId: z.string().min(1),
  nodeId: z.string().min(1),
});

export const ConnectEdgesOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("connect_edges"),
  workflowId: z.string().min(1),
  edges: z.array(WorkflowEdgeSchema).min(1),
});

export const DisconnectEdgeOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("disconnect_edge"),
  workflowId: z.string().min(1),
  edgeId: z.string().min(1),
});

export const BindSecretRefOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("bind_secret_ref"),
  ref: z.string().nullable(),
  targetKind: SecretRefTargetKindSchema,
  targetId: z.string().min(1),
  secretName: z.string().min(1),
});

export const UnbindSecretRefOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("unbind_secret_ref"),
  targetKind: SecretRefTargetKindSchema,
  targetId: z.string().min(1),
  secretName: z.string().min(1),
  ref: z.string().optional(),
});

export const MetadataPatchSchema = z.strictObject({
  displayName: z.string().max(120).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  catalogVersion: z.string().max(64).nullable().optional(),
  layout: z.record(z.string(), NodePositionSchema.nullable()).nullable().optional(),
  viewport: ViewportSchema.nullable().optional(),
});

export const SetMetadataOpSchema = z.strictObject({
  opId: OpIdSchema,
  type: z.literal("set_metadata"),
  metadata: MetadataPatchSchema,
  replace: z.boolean().optional(),
});

export const OpSchema = z.discriminatedUnion("type", [
  EnableBrickOpSchema,
  ConfigureBrickOpSchema,
  RemoveBrickOpSchema,
  SetIdentityOpSchema,
  AddEntityOpSchema,
  UpdateEntityOpSchema,
  RemoveEntityOpSchema,
  AddWorkflowOpSchema,
  RemoveWorkflowOpSchema,
  AddNodeOpSchema,
  UpdateNodeOpSchema,
  RemoveNodeOpSchema,
  ConnectEdgesOpSchema,
  DisconnectEdgeOpSchema,
  BindSecretRefOpSchema,
  UnbindSecretRefOpSchema,
  SetMetadataOpSchema,
]);

export interface EnableBrickOp {
  opId: string;
  type: "enable_brick";
  brickId: string;
  config?: Record<string, SettingValue>;
}

export interface ConfigureBrickOp {
  opId: string;
  type: "configure_brick";
  brickId: string;
  config: Record<string, SettingValue>;
  replace?: boolean;
}

export interface RemoveBrickOp {
  opId: string;
  type: "remove_brick";
  brickId: string;
}

export interface SetIdentityOp {
  opId: string;
  type: "set_identity";
  identity: string;
}

export interface AddEntityOp {
  opId: string;
  type: "add_entity";
  entity: EntityDefinition | { name: string; workspaceScoped?: true; fields: EntityDefinition["fields"] };
}

export interface UpdateEntityOp {
  opId: string;
  type: "update_entity";
  entity: EntityDefinition | { name: string; workspaceScoped?: true; fields: EntityDefinition["fields"] };
}

export interface RemoveEntityOp {
  opId: string;
  type: "remove_entity";
  name: string;
}

export interface AddWorkflowOp {
  opId: string;
  type: "add_workflow";
  workflow: {
    id: string;
    name: string;
    trigger?: Workflow["trigger"];
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
  };
}

export interface RemoveWorkflowOp {
  opId: string;
  type: "remove_workflow";
  workflowId: string;
}

export interface AddNodeOp {
  opId: string;
  type: "add_node";
  workflowId: string;
  node: WorkflowNode;
}

export interface UpdateNodeOp {
  opId: string;
  type: "update_node";
  workflowId: string;
  nodeId: string;
  data?: Record<string, unknown>;
  label?: string | null;
  nodeType?: string;
  patch?: {
    type?: string;
    label?: string | null;
    data?: Record<string, unknown>;
    position?: NodePosition;
  };
  node?: WorkflowNode;
}

export interface RemoveNodeOp {
  opId: string;
  type: "remove_node";
  workflowId: string;
  nodeId: string;
}

export interface ConnectEdgesOp {
  opId: string;
  type: "connect_edges";
  workflowId: string;
  edges: WorkflowEdge[];
}

export interface DisconnectEdgeOp {
  opId: string;
  type: "disconnect_edge";
  workflowId: string;
  edgeId: string;
}

export interface BindSecretRefOp {
  opId: string;
  type: "bind_secret_ref";
  ref: string | null;
  targetKind: SecretRefTargetKind;
  targetId: string;
  secretName: string;
}

export interface UnbindSecretRefOp {
  opId: string;
  type: "unbind_secret_ref";
  targetKind: SecretRefTargetKind;
  targetId: string;
  secretName: string;
  ref?: string;
}

export interface SetMetadataOp {
  opId: string;
  type: "set_metadata";
  metadata: {
    displayName?: string | null;
    description?: string | null;
    catalogVersion?: string | null;
    layout?: Record<string, { x: number; y: number } | null> | null;
    viewport?: BlueprintMetadata["viewport"] | null;
  };
  replace?: boolean;
}

export type Op =
  | EnableBrickOp
  | ConfigureBrickOp
  | RemoveBrickOp
  | SetIdentityOp
  | AddEntityOp
  | UpdateEntityOp
  | RemoveEntityOp
  | AddWorkflowOp
  | RemoveWorkflowOp
  | AddNodeOp
  | UpdateNodeOp
  | RemoveNodeOp
  | ConnectEdgesOp
  | DisconnectEdgeOp
  | BindSecretRefOp
  | UnbindSecretRefOp
  | SetMetadataOp;

/**
 * Extracts deterministic target keys touched by an op for concurrency/rebase conflict detection.
 */
export function targetKey(op: Op, state?: BlueprintState): string[] {
  const keys = new Set<string>();
  switch (op.type) {
    case "enable_brick":
    case "configure_brick":
    case "remove_brick":
      keys.add(`brick:${op.brickId}`);
      break;
    case "set_identity":
      keys.add("identity");
      break;
    case "add_entity":
    case "update_entity":
      keys.add(`entity:${op.entity.name}`);
      break;
    case "remove_entity":
      keys.add(`entity:${op.name}`);
      break;
    case "add_workflow":
      keys.add(`workflow:${op.workflow.id}`);
      break;
    case "remove_workflow":
      keys.add(`workflow:${op.workflowId}`);
      break;
    case "add_node":
      keys.add(`workflow:${op.workflowId}:node:${op.node.id}`);
      break;
    case "update_node":
      keys.add(`workflow:${op.workflowId}:node:${op.nodeId}`);
      break;
    case "remove_node": {
      keys.add(`workflow:${op.workflowId}:node:${op.nodeId}`);
      const wf = state?.workflows.find((w) => w.id === op.workflowId);
      if (wf) {
        for (const edge of wf.edges) {
          if (edge.source === op.nodeId || edge.target === op.nodeId) {
            keys.add(`workflow:${op.workflowId}:edge:${edge.id}`);
          }
        }
      }
      break;
    }
    case "connect_edges":
      for (const edge of op.edges) {
        keys.add(`workflow:${op.workflowId}:edge:${edge.id}`);
        keys.add(`workflow:${op.workflowId}:port:${edge.source}:out:${edge.sourceHandle ?? "out"}`);
        keys.add(`workflow:${op.workflowId}:port:${edge.target}:in:${edge.targetHandle ?? "in"}`);
      }
      break;
    case "disconnect_edge": {
      keys.add(`workflow:${op.workflowId}:edge:${op.edgeId}`);
      const wf = state?.workflows.find((w) => w.id === op.workflowId);
      const edge = wf?.edges.find((e) => e.id === op.edgeId);
      if (edge) {
        keys.add(`workflow:${op.workflowId}:port:${edge.source}:out:${edge.sourceHandle ?? "out"}`);
        keys.add(`workflow:${op.workflowId}:port:${edge.target}:in:${edge.targetHandle ?? "in"}`);
      }
      break;
    }
    case "bind_secret_ref":
    case "unbind_secret_ref":
      keys.add(`secret:${op.targetKind}:${op.targetId}:${op.secretName}`);
      if (op.ref) {
        keys.add(`secret:${op.ref}`);
      }
      break;
    case "set_metadata": {
      const metaEntries = Object.entries(op.metadata).filter(([, v]) => v !== undefined);
      if (metaEntries.length === 0) {
        keys.add("meta");
      } else {
        for (const [k, v] of metaEntries) {
          if (k === "layout" && v && typeof v === "object") {
            const layoutNodeIds = Object.keys(v);
            if (layoutNodeIds.length === 0) {
              keys.add("meta:layout");
            } else {
              for (const nodeId of layoutNodeIds) {
                keys.add(`layout:${nodeId}`);
              }
            }
          } else {
            keys.add(`meta:${k}`);
          }
        }
      }
      break;
    }
  }
  return [...keys].sort();
}

export const opTargets = targetKey;

export function primaryTargetForOp(op: Op): string | null {
  switch (op.type) {
    case "enable_brick":
    case "configure_brick":
    case "remove_brick":
      return `brick:${op.brickId}`;
    case "set_identity":
      return "identity";
    case "add_entity":
    case "update_entity":
      return `entity:${op.entity.name}`;
    case "remove_entity":
      return `entity:${op.name}`;
    case "add_workflow":
      return `workflow:${op.workflow.id}`;
    case "remove_workflow":
      return `workflow:${op.workflowId}`;
    case "add_node":
      return `workflow:${op.workflowId}:node:${op.node.id}`;
    case "update_node":
    case "remove_node":
      return `workflow:${op.workflowId}:node:${op.nodeId}`;
    case "connect_edges":
      return op.edges[0] ? `workflow:${op.workflowId}:edge:${op.edges[0].id}` : null;
    case "disconnect_edge":
      return `workflow:${op.workflowId}:edge:${op.edgeId}`;
    case "bind_secret_ref":
    case "unbind_secret_ref":
      return op.ref ? `secret:${op.ref}` : `secret:${op.targetKind}:${op.targetId}:${op.secretName}`;
    case "set_metadata":
      return null;
  }
}

export function collectOpTargets(op: Op, baseState: BlueprintState, currentState: BlueprintState): string[] {
  const ordered = new Set<string>();
  const primary = primaryTargetForOp(op);
  if (primary) {
    ordered.add(primary);
  }
  for (const key of targetKey(op, baseState)) {
    ordered.add(key);
  }
  for (const key of targetKey(op, currentState)) {
    ordered.add(key);
  }
  if (op.type === "remove_workflow") {
    for (const wf of [baseState.workflows.find((w) => w.id === op.workflowId), currentState.workflows.find((w) => w.id === op.workflowId)]) {
      if (!wf) continue;
      for (const node of wf.nodes) {
        ordered.add(`workflow:${op.workflowId}:node:${node.id}`);
      }
      for (const edge of wf.edges) {
        ordered.add(`workflow:${op.workflowId}:edge:${edge.id}`);
      }
    }
  }
  return [...ordered];
}
