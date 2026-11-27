import { canonicalizeValue, normalizeBlueprintState } from "./schema.ts";
import type { BlueprintState, BrickEntry, Entity, EntityField, SecretRef, Workflow, WorkflowEdge, WorkflowNode } from "./schema.ts";

export interface BrickDiffUpdate {
  id: string;
  before: BrickEntry;
  after: BrickEntry;
}

export interface EntityFieldDiffUpdate {
  name: string;
  before: EntityField;
  after: EntityField;
}

export interface EntityDiffUpdate {
  name: string;
  fieldsAdded: EntityField[];
  fieldsRemoved: EntityField[];
  fieldsUpdated: EntityFieldDiffUpdate[];
}

export interface WorkflowNodeDiffUpdate {
  id: string;
  before: WorkflowNode;
  after: WorkflowNode;
}

export interface WorkflowDiffUpdate {
  id: string;
  name: string;
  nodesAdded: WorkflowNode[];
  nodesRemoved: WorkflowNode[];
  nodesUpdated: WorkflowNodeDiffUpdate[];
  edgesAdded: WorkflowEdge[];
  edgesRemoved: WorkflowEdge[];
}

export interface SecretRefDiffUpdate {
  ref: string;
  before: SecretRef;
  after: SecretRef;
}

export interface SemanticDiff {
  identity: { from: string; to: string } | null;
  bricks: {
    added: BrickEntry[];
    removed: BrickEntry[];
    updated: BrickDiffUpdate[];
  };
  entities: {
    added: Entity[];
    removed: Entity[];
    updated: EntityDiffUpdate[];
  };
  workflows: {
    added: Workflow[];
    removed: Workflow[];
    updated: WorkflowDiffUpdate[];
  };
  secretRefs: {
    added: SecretRef[];
    removed: SecretRef[];
    updated: SecretRefDiffUpdate[];
  };
  isEmpty: boolean;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function diffBricks(fromBricks: ReadonlyArray<BrickEntry>, toBricks: ReadonlyArray<BrickEntry>): SemanticDiff["bricks"] {
  const fromMap = new Map(fromBricks.map((b) => [b.id, b]));
  const toMap = new Map(toBricks.map((b) => [b.id, b]));

  const added: BrickEntry[] = [];
  const removed: BrickEntry[] = [];
  const updated: BrickDiffUpdate[] = [];

  for (const [id, after] of toMap) {
    const before = fromMap.get(id);
    if (!before) {
      added.push(after);
    } else if (stableJson(before.config) !== stableJson(after.config)) {
      updated.push({ id, before, after });
    }
  }

  for (const [id, before] of fromMap) {
    if (!toMap.has(id)) {
      removed.push(before);
    }
  }

  return { added, removed, updated };
}

function diffEntities(fromEntities: ReadonlyArray<Entity>, toEntities: ReadonlyArray<Entity>): SemanticDiff["entities"] {
  const fromMap = new Map(fromEntities.map((e) => [e.name, e]));
  const toMap = new Map(toEntities.map((e) => [e.name, e]));

  const added: Entity[] = [];
  const removed: Entity[] = [];
  const updated: EntityDiffUpdate[] = [];

  for (const [name, after] of toMap) {
    const before = fromMap.get(name);
    if (!before) {
      added.push(after);
      continue;
    }

    const fromFields = new Map(
      [...before.fields]
        .map((f) => canonicalizeValue(f))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((f) => [f.name, f]),
    );
    const toFields = new Map(
      [...after.fields]
        .map((f) => canonicalizeValue(f))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((f) => [f.name, f]),
    );

    const fieldsAdded: EntityField[] = [];
    const fieldsRemoved: EntityField[] = [];
    const fieldsUpdated: EntityFieldDiffUpdate[] = [];

    for (const [fName, afterField] of toFields) {
      const beforeField = fromFields.get(fName);
      if (!beforeField) {
        fieldsAdded.push(afterField);
      } else if (stableJson(beforeField) !== stableJson(afterField)) {
        fieldsUpdated.push({ name: fName, before: beforeField, after: afterField });
      }
    }

    for (const [fName, beforeField] of fromFields) {
      if (!toFields.has(fName)) {
        fieldsRemoved.push(beforeField);
      }
    }

    if (fieldsAdded.length > 0 || fieldsRemoved.length > 0 || fieldsUpdated.length > 0) {
      updated.push({ name, fieldsAdded, fieldsRemoved, fieldsUpdated });
    }
  }

  for (const [name, before] of fromMap) {
    if (!toMap.has(name)) {
      removed.push(before);
    }
  }

  return { added, removed, updated };
}

function diffWorkflows(fromWorkflows: ReadonlyArray<Workflow>, toWorkflows: ReadonlyArray<Workflow>): SemanticDiff["workflows"] {
  const fromMap = new Map(fromWorkflows.map((w) => [w.id, w]));
  const toMap = new Map(toWorkflows.map((w) => [w.id, w]));

  const added: Workflow[] = [];
  const removed: Workflow[] = [];
  const updated: WorkflowDiffUpdate[] = [];

  for (const [id, after] of toMap) {
    const before = fromMap.get(id);
    if (!before) {
      added.push(after);
      continue;
    }

    const fromNodes = new Map(before.nodes.map((n) => [n.id, n]));
    const toNodes = new Map(after.nodes.map((n) => [n.id, n]));

    const nodesAdded: WorkflowNode[] = [];
    const nodesRemoved: WorkflowNode[] = [];
    const nodesUpdated: WorkflowNodeDiffUpdate[] = [];

    for (const [nodeId, afterNode] of toNodes) {
      const beforeNode = fromNodes.get(nodeId);
      if (!beforeNode) {
        nodesAdded.push(afterNode);
      } else if (stableJson(beforeNode) !== stableJson(afterNode)) {
        nodesUpdated.push({ id: nodeId, before: beforeNode, after: afterNode });
      }
    }

    for (const [nodeId, beforeNode] of fromNodes) {
      if (!toNodes.has(nodeId)) {
        nodesRemoved.push(beforeNode);
      }
    }

    const fromEdges = new Map(before.edges.map((e) => [e.id, e]));
    const toEdges = new Map(after.edges.map((e) => [e.id, e]));

    const edgesAdded: WorkflowEdge[] = [];
    const edgesRemoved: WorkflowEdge[] = [];

    for (const [edgeId, afterEdge] of toEdges) {
      const beforeEdge = fromEdges.get(edgeId);
      if (!beforeEdge) {
        edgesAdded.push(afterEdge);
      } else if (stableJson(beforeEdge) !== stableJson(afterEdge)) {
        edgesRemoved.push(beforeEdge);
        edgesAdded.push(afterEdge);
      }
    }

    for (const [edgeId, beforeEdge] of fromEdges) {
      if (!toEdges.has(edgeId)) {
        edgesRemoved.push(beforeEdge);
      }
    }

    const metaChanged = before.name !== after.name || stableJson(before.trigger) !== stableJson(after.trigger);

    if (metaChanged || nodesAdded.length > 0 || nodesRemoved.length > 0 || nodesUpdated.length > 0 || edgesAdded.length > 0 || edgesRemoved.length > 0) {
      updated.push({
        id,
        name: after.name,
        nodesAdded,
        nodesRemoved,
        nodesUpdated,
        edgesAdded,
        edgesRemoved,
      });
    }
  }

  for (const [id, before] of fromMap) {
    if (!toMap.has(id)) {
      removed.push(before);
    }
  }

  return { added, removed, updated };
}

function diffSecretRefs(fromRefs: ReadonlyArray<SecretRef>, toRefs: ReadonlyArray<SecretRef>): SemanticDiff["secretRefs"] {
  const remainingFrom = [...fromRefs];
  const remainingTo = [...toRefs];

  // 1. Remove exact matches
  for (let i = remainingTo.length - 1; i >= 0; i -= 1) {
    const after = remainingTo[i]!;
    const exactIdx = remainingFrom.findIndex(
      (b) => b.ref === after.ref && b.targetKind === after.targetKind && b.targetId === after.targetId && b.secretName === after.secretName,
    );
    if (exactIdx !== -1) {
      remainingFrom.splice(exactIdx, 1);
      remainingTo.splice(i, 1);
    }
  }

  const updated: SecretRefDiffUpdate[] = [];

  // 2. Match updated secret refs by target slot (targetKind:targetId:secretName) or by ref handle
  for (let i = 0; i < remainingTo.length;) {
    const after = remainingTo[i]!;
    let matchIdx = remainingFrom.findIndex((b) => b.targetKind === after.targetKind && b.targetId === after.targetId && b.secretName === after.secretName);
    if (matchIdx === -1) {
      matchIdx = remainingFrom.findIndex((b) => b.ref === after.ref);
    }
    if (matchIdx !== -1) {
      const [before] = remainingFrom.splice(matchIdx, 1);
      remainingTo.splice(i, 1);
      updated.push({ ref: after.ref, before: before!, after });
    } else {
      i += 1;
    }
  }

  return {
    added: remainingTo,
    removed: remainingFrom,
    updated,
  };
}

export function computeSemanticDiff(fromState: BlueprintState, toState: BlueprintState): SemanticDiff {
  const fromNorm = normalizeBlueprintState(fromState);
  const toNorm = normalizeBlueprintState(toState);

  const identity = fromNorm.identity !== toNorm.identity ? { from: fromNorm.identity, to: toNorm.identity } : null;
  const bricks = diffBricks(fromNorm.bricks, toNorm.bricks);
  const entities = diffEntities(fromNorm.entities, toNorm.entities);
  const workflows = diffWorkflows(fromNorm.workflows, toNorm.workflows);
  const secretRefs = diffSecretRefs(fromNorm.secretRefs, toNorm.secretRefs);

  const isEmpty =
    identity === null &&
    bricks.added.length === 0 &&
    bricks.removed.length === 0 &&
    bricks.updated.length === 0 &&
    entities.added.length === 0 &&
    entities.removed.length === 0 &&
    entities.updated.length === 0 &&
    workflows.added.length === 0 &&
    workflows.removed.length === 0 &&
    workflows.updated.length === 0 &&
    secretRefs.added.length === 0 &&
    secretRefs.removed.length === 0 &&
    secretRefs.updated.length === 0;

  return {
    identity,
    bricks,
    entities,
    workflows,
    secretRefs,
    isEmpty,
  };
}
