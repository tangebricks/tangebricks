import { Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import type { Connection, Edge, Node, NodeProps } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { getActiveRole, useStudioStore } from "../store.ts";
import type { NodeLiveTelemetryState } from "../store.ts";
import { StructuredLogsPanel } from "./StructuredLogsPanel.tsx";
import {
  DEFAULT_CATALOG,
  computeBrickEnablePreview,
  computeStudioValidationIssues,
  formatMaturityBadge,
  getCatalogNodeDefinition,
  getEffectiveNodePorts,
  getPaletteCatalogItems,
  isTriggerNodeType,
  validateWorkflowConnection,
} from "../types.ts";
import type {
  BlueprintState,
  BrickEnablePreview,
  CatalogNodePort,
  PaletteCategory,
  PaletteNodeItem,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTrigger,
} from "../types.ts";

// Ensure ResizeObserver and DOMMatrixReadOnly exist in jsdom test environments for @xyflow/react
if (typeof globalThis.ResizeObserver === "undefined") {
  class PolyfillResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = PolyfillResizeObserver;
}

export interface StudioCanvasNodeData extends Record<string, unknown> {
  nodeId: string;
  workflowId: string;
  label: string;
  nodeType: string;
  role: "trigger" | "logic" | "action";
  inputPortLabel: string;
  outputPortLabel: string;
  inputs: CatalogNodePort[];
  outputs: CatalogNodePort[];
  isConnectable: boolean;
  isMultiSelected: boolean;
  onPortHover?: (nodeId: string, portId: string, side: "input" | "output") => void;
  onPortLeave?: () => void;
  onToggleMultiSelect?: (nodeId: string, additive: boolean) => void;
  onOpenConnectMenu?: (nodeId: string) => void;
  onFocusAdjacentNode?: (nodeId: string, direction: "next" | "prev") => void;
  onDeleteNode?: (nodeId: string) => void;
  hasValidationIssue: boolean;
  validationMessage?: string;
  authorBadge?: string;
  isAgentAuthor?: boolean;
  isHighlighted?: boolean;
  diffStatus?: "added" | "removed" | "changed" | null;
  telemetry?: NodeLiveTelemetryState;
  isPinned?: boolean;
  prefersReducedMotion?: boolean;
}

export function computeEdgeItemCount(
  upstreamTelemetry: NodeLiveTelemetryState | undefined,
  sourceHandle = "out",
  downstreamTelemetry?: NodeLiveTelemetryState,
): { count: number; label: string } | null {
  if (!upstreamTelemetry || upstreamTelemetry.status !== "succeeded") {
    return null;
  }
  if (downstreamTelemetry && downstreamTelemetry.status === "skipped") {
    return null;
  }
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(upstreamTelemetry.outputPreview || "{}");
  } catch {
    parsed = {};
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    if (sourceHandle !== "out") {
      const outObj = rec.out as Record<string, unknown> | undefined;
      if (outObj && typeof outObj.branch === "string" && outObj.branch !== sourceHandle) {
        return null;
      }
      if (sourceHandle in rec && rec[sourceHandle] === null) {
        return null;
      }
    }
    const portVal = sourceHandle in rec ? rec[sourceHandle] : "out" in rec ? rec.out : rec;
    const count = Array.isArray(portVal) ? portVal.length : portVal === null || portVal === undefined ? 0 : 1;
    if (count === 0 && sourceHandle !== "out") {
      return null;
    }
    return {
      count,
      label: count === 1 ? "1 item" : `${count} items`,
    };
  }
  const count = Array.isArray(parsed) ? parsed.length : 1;
  return {
    count,
    label: count === 1 ? "1 item" : `${count} items`,
  };
}

function classifyNodeRole(type: string): {
  role: "trigger" | "logic" | "action";
  icon: string;
  inputPort: string;
  outputPort: string;
} {
  if (
    type.startsWith("trigger.") ||
    type === "core.webhook" ||
    type === "core.schedule" ||
    type === "core.brick_event" ||
    type === "dynamic-entities.record_created" ||
    type === "webhook-gateway.inbound_webhook"
  ) {
    return {
      role: "trigger",
      icon: "⚡",
      inputPort: "event:in",
      outputPort: "payload:json",
    };
  }
  if (type.startsWith("logic.") || type.startsWith("transform.") || type.startsWith("util.") || type.startsWith("core.")) {
    return {
      role: "logic",
      icon: "⑂",
      inputPort: "val:in",
      outputPort: "val:out",
    };
  }
  return {
    role: "action",
    icon: "▣",
    inputPort: "col:record",
    outputPort: "res:record",
  };
}

export function computeDeterministicDagLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  existingLayout?: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {};
  const nodeIds = new Set(nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    outgoing.set(n.id, []);
  }

  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    outgoing.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const levelMap = new Map<string, number>();
  const queue: string[] = [];

  for (const n of nodes) {
    if ((inDegree.get(n.id) ?? 0) === 0) {
      levelMap.set(n.id, 0);
      queue.push(n.id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++]!;
    const currLevel = levelMap.get(curr) ?? 0;
    for (const next of outgoing.get(curr) ?? []) {
      const candidate = Math.min(nodes.length, currLevel + 1);
      if ((levelMap.get(next) ?? -1) < candidate) {
        levelMap.set(next, candidate);
      }
      const rem = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, rem);
      if (rem === 0) {
        queue.push(next);
      }
    }
  }

  const byLevel = new Map<number, string[]>();
  for (const n of nodes) {
    const lvl = levelMap.get(n.id) ?? 0;
    const group = byLevel.get(lvl) ?? [];
    group.push(n.id);
    byLevel.set(lvl, group);
  }

  for (const [lvl, ids] of byLevel.entries()) {
    ids.forEach((id, idx) => {
      const nodeObj = nodes.find((n) => n.id === id);
      const saved = existingLayout?.[id] ?? nodeObj?.position;
      if (saved && typeof saved.x === "number" && Number.isFinite(saved.x) && typeof saved.y === "number" && Number.isFinite(saved.y)) {
        result[id] = { x: saved.x, y: saved.y };
      } else {
        result[id] = {
          x: lvl * 320 + 48,
          y: idx * 190 + 48,
        };
      }
    });
  }

  return result;
}

export const StudioWorkflowNodeCard = memo(function StudioWorkflowNodeCard({ data, selected }: NodeProps<Node<StudioCanvasNodeData>>) {
  const selectItem = useStudioStore((s) => s.selectItem);
  const roleMeta = classifyNodeRole(data.nodeType);

  const handleActivate = useCallback(
    (e?: MouseEvent<HTMLDivElement>) => {
      if (e && e.shiftKey && data.onToggleMultiSelect) {
        e.stopPropagation();
        data.onToggleMultiSelect(data.nodeId, true);
      } else if (data.onToggleMultiSelect) {
        data.onToggleMultiSelect(data.nodeId, false);
      }
      selectItem({
        kind: "node",
        id: data.nodeId,
        workflowId: data.workflowId,
      });
    },
    [selectItem, data],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleActivate();
        setTimeout(() => {
          const inspectorEl = document.querySelector<HTMLElement>('[data-testid="inspector-node-tab-params"], [data-testid="inspector-node-label-input"]');
          inspectorEl?.focus();
        }, 0);
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        handleActivate();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        e.stopPropagation();
        data.onOpenConnectMenu?.(data.nodeId);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        data.onFocusAdjacentNode?.(data.nodeId, "next");
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        data.onFocusAdjacentNode?.(data.nodeId, "prev");
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        data.onDeleteNode?.(data.nodeId);
      }
    },
    [handleActivate, data],
  );

  const inputPorts = data.inputs && data.inputs.length > 0 ? data.inputs : data.role !== "trigger" ? [{ id: "in", dataType: "any" as const }] : [];
  const outputPorts = data.outputs && data.outputs.length > 0 ? data.outputs : [{ id: "out", dataType: "any" as const }];

  const primaryInPort = inputPorts[0];
  const primaryOutPort = outputPorts[0];

  const isSelectedVisual = Boolean(selected || data.isMultiSelected);

  return (
    <div
      tabIndex={0}
      role="group"
      aria-label={`Workflow node ${data.label} (${data.nodeType})`}
      data-testid={`canvas-node-${data.nodeId}`}
      data-node-id={data.nodeId}
      data-node-type={data.nodeType}
      data-selected={isSelectedVisual ? "true" : "false"}
      data-highlighted={data.isHighlighted ? "true" : "false"}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => {
        if (primaryInPort && data.onPortHover) {
          data.onPortHover(data.nodeId, primaryInPort.id, "input");
        }
      }}
      onMouseLeave={() => {
        data.onPortLeave?.();
      }}
      className={`w-56 rounded-lg border px-3 py-2.5 text-xs select-none transition ${
        data.diffStatus === "removed"
          ? "bg-rose-950/30 border-dashed border-rose-500/80 opacity-75"
          : data.diffStatus === "added"
            ? "bg-surface-raised border-emerald-500 ring-2 ring-emerald-500/50"
            : data.diffStatus === "changed"
              ? "bg-surface-raised border-amber-400 ring-2 ring-amber-400/50"
              : data.isHighlighted
                ? "bg-surface-raised border-accent ring-2 ring-accent shadow-lg motion-safe:animate-pulse"
                : isSelectedVisual
                  ? "bg-surface-raised border-accent ring-2 ring-accent/70"
                  : data.hasValidationIssue
                    ? "bg-surface-raised border-rose-500/80"
                    : "bg-surface-raised border-border-strong hover:border-slate-500"
      }`}
    >
      {/* Typed Input Port Handles */}
      {inputPorts.map((port, idx) => {
        const topPct = inputPorts.length === 1 ? "50%" : `${Math.round(((idx + 1) / (inputPorts.length + 1)) * 100)}%`;
        return (
          <Handle
            key={`in-${port.id}`}
            type="target"
            position={Position.Left}
            id={port.id}
            isConnectable={data.isConnectable}
            style={{ top: topPct }}
            data-testid={`node-handle-in-${data.nodeId}-${port.id}`}
            data-port-type={port.dataType}
            onMouseEnter={() => data.onPortHover?.(data.nodeId, port.id, "input")}
            onMouseLeave={() => data.onPortLeave?.()}
            className="!w-3 !h-3 !bg-sky-400 !border-slate-950"
          />
        );
      })}

      {/* Header: Role Icon + Label + Multi-select + Badges */}
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span title={`Role: ${data.role}`} className="px-1.5 py-0.5 rounded bg-surface-control text-accent text-[11px] font-bold shrink-0">
            {roleMeta.icon}
          </span>
          <span className={`font-bold truncate ${data.diffStatus === "removed" ? "line-through text-rose-300" : "text-text-primary"}`}>{data.label}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {data.diffStatus === "added" && (
            <span
              data-testid={`diff-badge-added-${data.nodeId}`}
              className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 text-[10px] font-bold shrink-0"
            >
              + Added
            </span>
          )}
          {data.diffStatus === "removed" && (
            <span
              data-testid={`diff-badge-removed-${data.nodeId}`}
              className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/50 text-rose-300 text-[10px] font-bold shrink-0"
            >
              - Removed
            </span>
          )}
          {data.diffStatus === "changed" && (
            <span
              data-testid={`diff-badge-changed-${data.nodeId}`}
              className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-amber-300 text-[10px] font-bold shrink-0"
            >
              ~ Changed
            </span>
          )}
          {data.isPinned && (
            <span
              data-testid={`node-pinned-badge-${data.nodeId}`}
              title="Pinned test output active for this step"
              className="px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-400/50 text-sky-200 text-[10px] font-bold shrink-0 inline-flex items-center gap-0.5"
            >
              <span aria-hidden="true">📌</span>
              <span>Pinned</span>
            </span>
          )}
          {data.hasValidationIssue && (
            <span
              data-testid={`node-validation-badge-${data.nodeId}`}
              title={data.validationMessage ?? "Validation issue"}
              className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px] font-bold shrink-0"
            >
              ⚠ Issue
            </span>
          )}
          <input
            type="checkbox"
            aria-label={`Select node ${data.nodeId}`}
            data-testid={`node-multiselect-toggle-${data.nodeId}`}
            checked={isSelectedVisual}
            onClick={(e) => e.stopPropagation()}
            onChange={() => data.onToggleMultiSelect?.(data.nodeId, true)}
            className="h-3 w-3 rounded accent-amber-500 cursor-pointer"
          />
        </div>
      </div>

      {/* Inline validation error reason on canvas node */}
      {data.hasValidationIssue && data.validationMessage && (
        <div
          data-testid={`inline-issue-badge-${data.nodeId}`}
          className="mt-1.5 px-2 py-1 rounded bg-rose-500/15 border border-rose-500/40 text-[10px] text-rose-200 leading-snug"
        >
          ✕ {data.validationMessage}
        </div>
      )}

      {/* Live Telemetry Status Overlay Badge (Queued / Running / Succeeded / Failed / Skipped) */}
      {data.telemetry && (
        <div className="mt-1.5 space-y-1">
          <div
            data-testid={`node-telemetry-badge-${data.nodeId}`}
            data-status={data.telemetry.status}
            data-reduced-motion={data.prefersReducedMotion ? "true" : "false"}
            title={data.telemetry.status === "failed" ? (data.telemetry.errorStack ?? "Step execution failed") : `Status: ${data.telemetry.status}`}
            className={`px-2 py-0.5 rounded border text-[10px] font-bold flex items-center justify-between gap-1.5 ${
              data.telemetry.status === "queued"
                ? "bg-slate-800/90 border-slate-600 text-slate-200"
                : data.telemetry.status === "running"
                  ? `bg-sky-500/20 border-sky-400 text-sky-200 ${data.prefersReducedMotion ? "" : "animate-pulse"}`
                  : data.telemetry.status === "succeeded"
                    ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-300"
                    : data.telemetry.status === "failed"
                      ? "bg-rose-500/20 border-rose-500/60 text-rose-300"
                      : "bg-slate-800/60 border-slate-700 text-slate-400"
            }`}
          >
            <span className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className={data.telemetry.status === "running" && !data.prefersReducedMotion ? "inline-block animate-spin" : "inline-block"}
              >
                {data.telemetry.status === "queued"
                  ? "⏳"
                  : data.telemetry.status === "running"
                    ? "⟳"
                    : data.telemetry.status === "succeeded"
                      ? "✓"
                      : data.telemetry.status === "failed"
                        ? "✕"
                        : "—"}
              </span>
              <span>
                {data.telemetry.status === "queued"
                  ? "Queued"
                  : data.telemetry.status === "running"
                    ? "Running"
                    : data.telemetry.status === "succeeded"
                      ? "Succeeded"
                      : data.telemetry.status === "failed"
                        ? "Failed"
                        : "Skipped"}
              </span>
            </span>
            {data.telemetry.status === "succeeded" && (
              <span data-testid={`node-telemetry-duration-${data.nodeId}`} className="font-mono text-[10px] text-emerald-200">
                {Math.round(data.telemetry.durationMs)} ms
              </span>
            )}
          </div>
          {data.telemetry.status === "failed" && data.telemetry.errorStack && (
            <div
              data-testid={`node-telemetry-error-${data.nodeId}`}
              title={data.telemetry.errorStack}
              className="px-2 py-0.5 rounded bg-rose-950/80 border border-rose-500/40 text-[10px] font-mono text-rose-200 truncate"
            >
              {data.telemetry.errorStack.split("\n")[0]}
            </div>
          )}
        </div>
      )}

      {/* Node Type & ID */}
      <div className="font-mono text-[10px] text-text-muted truncate mt-1">
        {data.nodeType} · <span className="text-text-secondary">{data.nodeId}</span>
      </div>

      {/* Typed Input / Output Port Indicators */}
      <div className="mt-2 pt-1.5 border-t border-border flex items-center justify-between text-[10px] font-mono gap-1">
        {data.role !== "trigger" && primaryInPort ? (
          <span
            data-testid={`node-port-in-${data.nodeId}`}
            data-port-datatype={primaryInPort.dataType}
            onMouseEnter={() => data.onPortHover?.(data.nodeId, primaryInPort.id, "input")}
            className="inline-flex items-center gap-1 text-sky-400 truncate"
          >
            <span>◆</span>
            <span>
              {primaryInPort.id}:{primaryInPort.dataType} ({data.inputPortLabel})
            </span>
          </span>
        ) : (
          <span className="text-emerald-400">▶ trigger</span>
        )}

        {primaryOutPort && (
          <span
            data-testid={`node-port-out-${data.nodeId}`}
            data-port-datatype={primaryOutPort.dataType}
            className="inline-flex items-center gap-1 text-amber-400 truncate"
          >
            <span>
              {primaryOutPort.id}:{primaryOutPort.dataType} ({data.outputPortLabel})
            </span>
            <span>●</span>
          </span>
        )}
      </div>

      {/* Author Chip if touched by an agent or human */}
      {data.authorBadge && (
        <div
          data-testid={`node-author-badge-${data.nodeId}`}
          className={`mt-1.5 px-1.5 py-0.5 rounded text-[10px] font-mono truncate ${
            data.isAgentAuthor ? "bg-sky-400/15 text-sky-300 border border-sky-400/30" : "bg-surface-control text-text-secondary"
          }`}
        >
          {data.isAgentAuthor ? `🤖 ${data.authorBadge}` : `👤 ${data.authorBadge}`}
        </div>
      )}

      {/* Typed Output Port Handles */}
      {outputPorts.map((port, idx) => {
        const topPct = outputPorts.length === 1 ? "50%" : `${Math.round(((idx + 1) / (outputPorts.length + 1)) * 100)}%`;
        return (
          <Handle
            key={`out-${port.id}`}
            type="source"
            position={Position.Right}
            id={port.id}
            isConnectable={data.isConnectable}
            style={{ top: topPct }}
            data-testid={`node-handle-out-${data.nodeId}-${port.id}`}
            data-port-type={port.dataType}
            onMouseEnter={() => data.onPortHover?.(data.nodeId, port.id, "output")}
            onMouseLeave={() => data.onPortLeave?.()}
            className="!w-3 !h-3 !bg-amber-500 !border-slate-950"
          />
        );
      })}
    </div>
  );
});

const NODE_TYPES = {
  studioNode: StudioWorkflowNodeCard,
};

function formatTriggerSummary(trigger?: WorkflowTrigger): string {
  if (!trigger) return "manual";
  if (typeof trigger === "string") return trigger;
  return `${trigger.kind}${trigger.path ? ` (${trigger.path})` : trigger.cron ? ` (${trigger.cron})` : ""}`;
}

export function createSynthetic200NodeBlueprint(): BlueprintState {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const layout: Record<string, { x: number; y: number }> = {};

  // 20 layers x 10 nodes = 200 nodes, 240 directed edges
  for (let i = 0; i < 200; i += 1) {
    const layer = Math.floor(i / 10);
    const row = i % 10;
    const id = `node-${i + 1}`;
    const type = i === 0 ? "trigger.manual" : i % 3 === 0 ? "transform.pick" : i % 2 === 0 ? "credit-wallet.debit" : "in-app-notifications.send";
    nodes.push({
      id,
      type,
      label: `Step ${i + 1}`,
      data: { stepIndex: i + 1, layer },
    });
    layout[id] = {
      x: layer * 320 + 48,
      y: row * 190 + 48,
    };
  }

  let edgeCount = 0;
  // 190 primary horizontal chain edges (connect each node in layer L to same row in layer L+1)
  for (let layer = 0; layer < 19; layer += 1) {
    for (let row = 0; row < 10; row += 1) {
      const srcIdx = layer * 10 + row + 1;
      const dstIdx = (layer + 1) * 10 + row + 1;
      edges.push({
        id: `e-${++edgeCount}`,
        source: `node-${srcIdx}`,
        target: `node-${dstIdx}`,
        sourceHandle: "out",
        targetHandle: "in",
      });
    }
  }
  // 50 cross-row diagonal edges across the first 10 layers -> total 240 edges
  for (let layer = 0; layer < 10; layer += 1) {
    for (let row = 0; row < 5; row += 1) {
      const srcIdx = layer * 10 + row + 1;
      const dstIdx = (layer + 1) * 10 + ((row + 1) % 10) + 1;
      edges.push({
        id: `e-${++edgeCount}`,
        source: `node-${srcIdx}`,
        target: `node-${dstIdx}`,
        sourceHandle: "out",
        targetHandle: "in",
      });
    }
  }

  return {
    schemaVersion: 2,
    project: "synthetic-200-benchmark",
    identity: "core-auth",
    bricks: [
      { id: "core-auth", config: {} },
      { id: "multi-workspace", config: {} },
      { id: "credit-wallet", config: {} },
      { id: "in-app-notifications", config: {} },
    ],
    entities: [],
    workflows: [
      {
        id: "wf-200-nodes",
        name: "200-Node Benchmark DAG",
        trigger: { kind: "manual" },
        nodes,
        edges,
      },
    ],
    secretRefs: [],
    metadata: {
      layout,
      viewport: { x: 0, y: 0, zoom: 0.75 },
    },
  };
}

interface UndoToastState {
  message: string;
  inverseOps: Array<Record<string, unknown>>;
}

interface InnerCanvasProps {
  workflow: WorkflowDefinition;
  layout?: Record<string, { x: number; y: number }>;
  isViewer: boolean;
  onAddPaletteNodeAt: (item: PaletteNodeItem, coords?: { x: number; y: number }) => Promise<void>;
  paletteItems: PaletteNodeItem[];
}

function InnerWorkflowCanvas({ workflow, layout, isViewer, onAddPaletteNodeAt, paletteItems }: InnerCanvasProps) {
  const catalog = useStudioStore((s) => s.catalog);
  const projectState = useStudioStore((s) => s.projectState);
  const entities = useMemo(() => projectState?.entities ?? [], [projectState?.entities]);
  const readiness = useStudioStore((s) => s.readiness);
  const secrets = useStudioStore((s) => s.secrets);
  const selection = useStudioStore((s) => s.selection);
  const highlightedTargets = useStudioStore((s) => s.highlightedTargets);
  const nodeSearch = useStudioStore((s) => s.workflowNodeSearch);
  const isMutating = useStudioStore((s) => s.isMutating);
  const currentRevision = useStudioStore((s) => s.currentRevision);
  const canvasVisualDiff = useStudioStore((s) => s.canvasVisualDiff);
  const startCanvasVisualDiff = useStudioStore((s) => s.startCanvasVisualDiff);
  const clearCanvasVisualDiff = useStudioStore((s) => s.clearCanvasVisualDiff);
  const setNodeSearch = useStudioStore((s) => s.setWorkflowNodeSearch);
  const selectItem = useStudioStore((s) => s.selectItem);
  const commitOps = useStudioStore((s) => s.commitOps);
  const nodeTelemetryByWorkflow = useStudioStore((s) => s.nodeTelemetryByWorkflow);
  const isRunningWorkflow = useStudioStore((s) => s.isRunningWorkflow);
  const prefersReducedMotion = useStudioStore((s) => s.prefersReducedMotion);
  const executeWorkflowTestRun = useStudioStore((s) => s.executeWorkflowTestRun);
  const clearWorkflowTelemetry = useStudioStore((s) => s.clearWorkflowTelemetry);
  const activeReplayRun = useStudioStore((s) => s.activeReplayRun);
  const exitRunReplay = useStudioStore((s) => s.exitRunReplay);
  const runsList = useStudioStore((s) => s.runsList);
  const runsFilters = useStudioStore((s) => s.runsFilters);
  const runHistoryDrawerOpen = useStudioStore((s) => s.runHistoryDrawerOpen);
  const isLoadingRuns = useStudioStore((s) => s.isLoadingRuns);
  const toggleRunHistoryDrawer = useStudioStore((s) => s.toggleRunHistoryDrawer);
  const setRunHistoryDrawerOpen = useStudioStore((s) => s.setRunHistoryDrawerOpen);
  const setRunsFilters = useStudioStore((s) => s.setRunsFilters);
  const loadProjectRuns = useStudioStore((s) => s.loadProjectRuns);
  const startRunReplay = useStudioStore((s) => s.startRunReplay);
  const pinnedStepOutputs = useStudioStore((s) => s.pinnedStepOutputs);
  const pinnedOutputsByWorkflow = useStudioStore((s) => s.pinnedOutputsByWorkflow);
  const usePinnedData = useStudioStore((s) => s.usePinnedData);
  const setUsePinnedData = useStudioStore((s) => s.setUsePinnedData);
  const loadWorkflowPins = useStudioStore((s) => s.loadWorkflowPins);

  const [drawerSubTab, setDrawerSubTabState] = useState<"runs" | "logs">(() => {
    if (typeof window === "undefined") return "runs";
    const params = new URLSearchParams(window.location.search);
    if (params.get("drawer") === "logs") return "logs";
    try {
      const saved = window.sessionStorage.getItem("studio:runsDrawerSubTab");
      if (saved === "logs") return "logs";
    } catch {
      // Ignore storage errors
    }
    return "runs";
  });

  const setDrawerSubTab = useCallback((tab: "runs" | "logs") => {
    setDrawerSubTabState(tab);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem("studio:runsDrawerSubTab", tab);
      } catch {
        // Ignore storage errors
      }
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("drawer", tab);
        window.history.replaceState({}, "", url.toString());
      } catch {
        // Ignore URL replace errors
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const savedTab = (() => {
      try {
        return window.sessionStorage.getItem("studio:runsDrawerSubTab");
      } catch {
        return null;
      }
    })();
    if ((params.get("drawer") === "logs" || savedTab === "logs") && !runHistoryDrawerOpen) {
      setRunHistoryDrawerOpen(true);
    }
  }, [runHistoryDrawerOpen, setRunHistoryDrawerOpen]);

  useEffect(() => {
    void loadWorkflowPins(workflow.id);
  }, [workflow.id, loadWorkflowPins]);

  const isReplayMode = Boolean(activeReplayRun);

  const wfTelemetry = useMemo(
    () => (activeReplayRun ? activeReplayRun.nodeMap : (nodeTelemetryByWorkflow[workflow.id] ?? {})),
    [activeReplayRun, nodeTelemetryByWorkflow, workflow.id],
  );

  const filteredClientRuns = useMemo(() => {
    return runsList.filter((r) => {
      if (runsFilters.workflowId !== "all" && r.workflowId !== runsFilters.workflowId) {
        return false;
      }
      if (runsFilters.status !== "all" && r.status !== runsFilters.status) {
        return false;
      }
      if (runsFilters.trigger !== "all" && r.triggerType !== runsFilters.trigger) {
        return false;
      }
      if (runsFilters.from && r.startedAt < runsFilters.from) {
        return false;
      }
      if (runsFilters.to && r.startedAt > runsFilters.to) {
        return false;
      }
      return true;
    });
  }, [runsList, runsFilters]);

  const [showTestWorkflowPanel, setShowTestWorkflowPanel] = useState(false);
  const [testWorkflowPayloadText, setTestWorkflowPayloadText] = useState('{\n  "amount": 50,\n  "balance": 200,\n  "workspaceId": "ws_preview"\n}');
  const [testWorkflowEnv, setTestWorkflowEnv] = useState<"preview" | "production">("preview");
  const [testWorkflowError, setTestWorkflowError] = useState<string | null>(null);

  const handleRunWorkflowNow = useCallback(async () => {
    if (isViewer || isRunningWorkflow) return;
    let parsedPayload: unknown = {};
    try {
      parsedPayload = testWorkflowPayloadText.trim() ? JSON.parse(testWorkflowPayloadText) : {};
      setTestWorkflowError(null);
    } catch (err) {
      setTestWorkflowError(`Invalid trigger JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const res = await executeWorkflowTestRun(workflow.id, {
      triggerPayload: parsedPayload,
      env: testWorkflowEnv,
      usePinnedOutputs: usePinnedData,
    });
    if (!res.ok) {
      setTestWorkflowError(res.error);
    }
  }, [isViewer, isRunningWorkflow, testWorkflowPayloadText, executeWorkflowTestRun, workflow.id, testWorkflowEnv, usePinnedData]);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const reactFlow = useReactFlow();

  // Local positions ref for 60fps dragging + throttled (<= 4/sec) set_metadata persistence
  const localPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const lastLayoutFlushRef = useRef<number>(0);
  const pendingLayoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [clipboardNodes, setClipboardNodes] = useState<Array<{ node: WorkflowNode; position: { x: number; y: number } }>>([]);
  const [undoToast, setUndoToast] = useState<UndoToastState | null>(null);

  // Active wire connection / port validation state
  const activeConnectSourceRef = useRef<{
    nodeId: string;
    handleId: string;
  } | null>(null);
  const [wireSourceValue, setWireSourceValue] = useState<string>("");
  const [wireTargetValue, setWireTargetValue] = useState<string>("");
  const [wireValidationError, setWireValidationError] = useState<string | null>(null);
  const [connectMenuSourceNodeId, setConnectMenuSourceNodeId] = useState<string | null>(null);
  const setLiveAnnouncement = useStudioStore((s) => s.setLiveAnnouncement);

  useEffect(() => {
    const onOpenConnectEvent = (e: Event) => {
      const custom = e as CustomEvent<{ nodeId?: string }>;
      if (custom.detail?.nodeId) {
        setConnectMenuSourceNodeId(custom.detail.nodeId);
      }
    };
    window.addEventListener("studio:open-connect-menu", onOpenConnectEvent);
    return () => window.removeEventListener("studio:open-connect-menu", onOpenConnectEvent);
  }, []);

  const handleOpenConnectMenu = useCallback((nodeId: string) => {
    setConnectMenuSourceNodeId(nodeId);
  }, []);

  const handleFocusAdjacentNode = useCallback(
    (nodeId: string, direction: "next" | "prev") => {
      if (workflow.nodes.length === 0) return;
      let targetId: string | undefined;
      if (direction === "next") {
        const downEdge = workflow.edges.find((e) => e.source === nodeId);
        if (downEdge) {
          targetId = downEdge.target;
        } else {
          const idx = workflow.nodes.findIndex((n) => n.id === nodeId);
          const nextNode = workflow.nodes[(idx + 1) % workflow.nodes.length];
          targetId = nextNode?.id;
        }
      } else {
        const upEdge = workflow.edges.find((e) => e.target === nodeId);
        if (upEdge) {
          targetId = upEdge.source;
        } else {
          const idx = workflow.nodes.findIndex((n) => n.id === nodeId);
          const prevNode = workflow.nodes[(idx - 1 + workflow.nodes.length) % workflow.nodes.length];
          targetId = prevNode?.id;
        }
      }
      if (targetId) {
        selectItem({
          kind: "node",
          id: targetId,
          workflowId: workflow.id,
        });
        const el = document.querySelector<HTMLElement>(`[data-testid="canvas-node-${targetId}"]`);
        el?.focus();
      }
    },
    [workflow.nodes, workflow.edges, workflow.id, selectItem],
  );

  // Clear local position overrides when workflow changes or server layout updates
  const layoutJson = JSON.stringify(layout ?? {});
  useEffect(() => {
    localPositionsRef.current = {};
  }, [workflow.id, layoutJson]);

  const basePositions = useMemo(() => computeDeterministicDagLayout(workflow.nodes, workflow.edges, layout), [workflow.nodes, workflow.edges, layout]);

  const positions = useMemo(() => ({ ...basePositions, ...localPositionsRef.current }), [basePositions]);

  const persistLayoutCoalesced = useCallback(
    (nextLayoutPatch: Record<string, { x: number; y: number }>, flushImmediate: boolean) => {
      if (isViewer || workflow.id === "wf-200-nodes") return;
      const mergedLayout = {
        ...layout,
        ...basePositions,
        ...localPositionsRef.current,
        ...nextLayoutPatch,
      };
      const doCommit = () => {
        lastLayoutFlushRef.current = Date.now();
        void commitOps(
          [
            {
              opId: `layout-${workflow.id}-${Date.now()}`,
              type: "set_metadata",
              metadata: { layout: mergedLayout },
            },
          ],
          `Update node layout in ${workflow.name}`,
        );
      };

      if (pendingLayoutTimerRef.current) {
        clearTimeout(pendingLayoutTimerRef.current);
        pendingLayoutTimerRef.current = null;
      }

      const elapsed = Date.now() - lastLayoutFlushRef.current;
      if (flushImmediate || elapsed >= 250) {
        doCommit();
      } else {
        pendingLayoutTimerRef.current = setTimeout(doCommit, 250 - elapsed);
      }
    },
    [isViewer, workflow.id, workflow.name, layout, basePositions, commitOps],
  );

  const deleteSingleNodeRef = useRef<(nodeId: string) => void>(() => {});
  const handleDeleteNodeFromCard = useCallback((nodeId: string) => {
    deleteSingleNodeRef.current(nodeId);
  }, []);

  const handleToggleMultiSelect = useCallback((nodeId: string, additive: boolean) => {
    setSelectedNodeIds((prev) => {
      if (!additive) {
        return [nodeId];
      }
      return prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId];
    });
  }, []);

  const handlePortHover = useCallback(
    (targetNodeId: string, targetPortId: string, side: "input" | "output") => {
      const src = activeConnectSourceRef.current;
      if (!src || side !== "input") return;
      if (src.nodeId === targetNodeId) return;
      const check = validateWorkflowConnection(workflow, src.nodeId, src.handleId, targetNodeId, targetPortId, catalog, entities);
      if (!check.ok && check.reason) {
        setWireValidationError(check.reason);
      } else {
        setWireValidationError(null);
      }
    },
    [workflow, catalog, entities],
  );

  const handlePortLeave = useCallback(() => {
    // Keep error banner visible if selected in wire bar; otherwise keep last drag error briefly
  }, []);

  const validationIssues = useMemo(() => computeStudioValidationIssues(projectState, catalog, secrets, readiness), [projectState, catalog, secrets, readiness]);

  const issueByNode = useMemo(() => {
    const map = new Map<string, string>();
    for (const need of readiness.needs) {
      const prefix = `workflows.${workflow.id}.nodes.`;
      if (need.path.startsWith(prefix)) {
        const nodeId = need.path.slice(prefix.length);
        map.set(nodeId, need.message);
      }
    }
    for (const iss of validationIssues) {
      if (iss.workflowId === workflow.id && iss.nodeId && !map.has(iss.nodeId)) {
        map.set(iss.nodeId, iss.message);
      }
    }
    return map;
  }, [readiness.needs, validationIssues, workflow.id]);

  // Compute Workflow Visual Diff overlay for active workflow when canvasVisualDiff is active
  const workflowVisualDiff = useMemo(() => {
    if (!canvasVisualDiff) return null;
    const wfDiff = canvasVisualDiff.diff.workflows;
    const updatedWf = wfDiff.updated.find((u) => u.id === workflow.id);
    const addedWf = wfDiff.added.find((w) => w.id === workflow.id);
    const removedWf = wfDiff.removed.find((w) => w.id === workflow.id);

    const addedNodes = new Map<string, WorkflowNode>();
    const removedNodes = new Map<string, WorkflowNode>();
    const changedNodeIds = new Set<string>();
    const addedEdges = new Map<string, WorkflowEdge>();
    const removedEdges = new Map<string, WorkflowEdge>();

    if (addedWf) {
      for (const n of addedWf.nodes) addedNodes.set(n.id, n);
      for (const e of addedWf.edges) addedEdges.set(e.id, e);
    } else if (removedWf) {
      for (const n of removedWf.nodes) removedNodes.set(n.id, n);
      for (const e of removedWf.edges) removedEdges.set(e.id, e);
    } else if (updatedWf) {
      for (const n of updatedWf.nodesAdded) addedNodes.set(n.id, n);
      for (const n of updatedWf.nodesRemoved) removedNodes.set(n.id, n);
      for (const n of updatedWf.nodesUpdated) changedNodeIds.add(n.id);
      for (const e of updatedWf.edgesAdded) addedEdges.set(e.id, e);
      for (const e of updatedWf.edgesRemoved) removedEdges.set(e.id, e);
    }

    return {
      addedNodes,
      removedNodes,
      changedNodeIds,
      addedEdges,
      removedEdges,
    };
  }, [canvasVisualDiff, workflow.id]);

  const effectiveCanvasNodes = useMemo<WorkflowNode[]>(() => {
    if (!workflowVisualDiff || workflowVisualDiff.removedNodes.size === 0) {
      return workflow.nodes;
    }
    const existingIds = new Set(workflow.nodes.map((n) => n.id));
    const ghosts: WorkflowNode[] = [];
    for (const rn of workflowVisualDiff.removedNodes.values()) {
      if (!existingIds.has(rn.id)) {
        ghosts.push(rn);
      }
    }
    return [...workflow.nodes, ...ghosts];
  }, [workflow.nodes, workflowVisualDiff]);

  const baseRfNodes = useMemo<Array<Node<StudioCanvasNodeData>>>(() => {
    const ghostLayout = computeDeterministicDagLayout(
      effectiveCanvasNodes,
      [...workflow.edges, ...(workflowVisualDiff ? [...workflowVisualDiff.removedEdges.values()] : [])],
      { ...canvasVisualDiff?.fromState.metadata?.layout, ...layout },
    );
    return effectiveCanvasNodes.map((node) => {
      const pos = localPositionsRef.current[node.id] ?? basePositions[node.id] ?? ghostLayout[node.id] ?? { x: 48, y: 48 };
      const roleMeta = classifyNodeRole(node.type);
      const effectivePorts = getEffectiveNodePorts(node, catalog, entities);
      const issueMsg = issueByNode.get(node.id);
      const highlightKey = `node:${workflow.id}:${node.id}`;
      const fallbackHighlightKey = `node:${node.id}`;
      const highlight = highlightedTargets[highlightKey] ?? highlightedTargets[fallbackHighlightKey];
      const authorFromData = typeof node.data?.lastAuthor === "string" ? node.data.lastAuthor : undefined;
      const effectiveAuthor = highlight?.authorLabel ?? authorFromData;
      const isSelected = (selection?.kind === "node" && selection.id === node.id) || selectedNodeIds.includes(node.id);

      let diffStatus: "added" | "removed" | "changed" | null = null;
      if (workflowVisualDiff) {
        if (workflowVisualDiff.removedNodes.has(node.id)) {
          diffStatus = "removed";
        } else if (workflowVisualDiff.addedNodes.has(node.id)) {
          diffStatus = "added";
        } else if (workflowVisualDiff.changedNodeIds.has(node.id)) {
          diffStatus = "changed";
        }
      }

      return {
        id: node.id,
        type: "studioNode",
        position: pos,
        selected: isSelected,
        focusable: false,
        draggable: !isViewer && !isReplayMode && diffStatus !== "removed",
        connectable: !isViewer && !isReplayMode && diffStatus !== "removed",
        data: {
          nodeId: node.id,
          workflowId: workflow.id,
          label: node.label ?? node.id,
          nodeType: node.type,
          role: roleMeta.role,
          inputPortLabel: roleMeta.inputPort,
          outputPortLabel: roleMeta.outputPort,
          inputs: effectivePorts.inputs,
          outputs: effectivePorts.outputs,
          isConnectable: !isViewer && !isReplayMode && diffStatus !== "removed",
          isMultiSelected: selectedNodeIds.includes(node.id),
          onPortHover: handlePortHover,
          onPortLeave: handlePortLeave,
          onToggleMultiSelect: handleToggleMultiSelect,
          onOpenConnectMenu: handleOpenConnectMenu,
          onFocusAdjacentNode: handleFocusAdjacentNode,
          onDeleteNode: handleDeleteNodeFromCard,
          hasValidationIssue: Boolean(issueMsg),
          validationMessage: issueMsg,
          authorBadge: effectiveAuthor,
          isAgentAuthor: highlight?.isAgent ?? Boolean(effectiveAuthor?.startsWith("agent:")),
          isHighlighted: Boolean(highlight),
          diffStatus,
          telemetry: wfTelemetry[node.id],
          isPinned: Boolean(pinnedOutputsByWorkflow[workflow.id]?.[node.id] || pinnedStepOutputs[`${workflow.id}:${node.id}`] || pinnedStepOutputs[node.id]),
          prefersReducedMotion,
        },
      };
    });
  }, [
    effectiveCanvasNodes,
    workflow.edges,
    workflow.id,
    basePositions,
    layout,
    canvasVisualDiff?.fromState.metadata?.layout,
    workflowVisualDiff,
    catalog,
    entities,
    issueByNode,
    highlightedTargets,
    selection,
    selectedNodeIds,
    isViewer,
    isReplayMode,
    handlePortHover,
    handlePortLeave,
    handleToggleMultiSelect,
    handleOpenConnectMenu,
    handleFocusAdjacentNode,
    handleDeleteNodeFromCard,
    wfTelemetry,
    pinnedOutputsByWorkflow,
    pinnedStepOutputs,
    prefersReducedMotion,
  ]);

  useEffect(() => {
    try {
      reactFlow.setNodes((prev) => {
        const prevById = new Map(prev.map((n) => [n.id, n]));
        return baseRfNodes.map((nextNode) => {
          const existing = prevById.get(nextNode.id);
          if (!existing) return nextNode;
          return {
            ...nextNode,
            ...(existing.measured ? { measured: existing.measured } : {}),
          };
        });
      });
    } catch {
      // Ignore in non-mounted jsdom environments
    }
  }, [baseRfNodes, reactFlow]);

  const edgeItemCounts = useMemo(() => {
    const map = new Map<string, { count: number; label: string }>();
    for (const edge of workflow.edges) {
      const upstream = wfTelemetry[edge.source];
      const downstream = wfTelemetry[edge.target];
      const computed = computeEdgeItemCount(upstream, edge.sourceHandle ?? "out", downstream);
      if (computed) {
        map.set(edge.id, computed);
      }
    }
    return map;
  }, [workflow.edges, wfTelemetry]);

  const rfEdges = useMemo<Edge[]>(() => {
    const activeEdges: Edge[] = workflow.edges.map((edge) => {
      const isEdgeSelected = selectedEdgeIds.includes(edge.id);
      const isAddedEdge = workflowVisualDiff?.addedEdges.has(edge.id) ?? false;
      const itemInfo = edgeItemCounts.get(edge.id);
      const isTraversed = Boolean(itemInfo);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? "out",
        targetHandle: edge.targetHandle ?? "in",
        selected: isEdgeSelected,
        animated: (isAddedEdge || wfTelemetry[edge.target]?.status === "running") && !prefersReducedMotion,
        ...(itemInfo ? { label: itemInfo.label } : {}),
        style: {
          stroke: isAddedEdge ? "#10b981" : isTraversed ? "#10b981" : isEdgeSelected ? "#38bdf8" : "#f59e0b",
          strokeWidth: isAddedEdge || isEdgeSelected || isTraversed ? 2.5 : 1.5,
        },
      };
    });

    if (workflowVisualDiff && workflowVisualDiff.removedEdges.size > 0) {
      const activeIds = new Set(workflow.edges.map((e) => e.id));
      for (const remEdge of workflowVisualDiff.removedEdges.values()) {
        if (!activeIds.has(remEdge.id)) {
          activeEdges.push({
            id: remEdge.id,
            source: remEdge.source,
            target: remEdge.target,
            sourceHandle: remEdge.sourceHandle ?? "out",
            targetHandle: remEdge.targetHandle ?? "in",
            selected: false,
            animated: false,
            style: {
              stroke: "#f43f5e",
              strokeWidth: 2,
              strokeDasharray: "6 4",
            },
          });
        }
      }
    }

    return activeEdges;
  }, [workflow.edges, selectedEdgeIds, workflowVisualDiff, edgeItemCounts, wfTelemetry, prefersReducedMotion]);

  const handleNodeDrag = useCallback(
    (_event: unknown, node: Node<StudioCanvasNodeData>) => {
      const rounded = {
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
      };
      localPositionsRef.current[node.id] = rounded;
      persistLayoutCoalesced({ [node.id]: rounded }, false);
    },
    [persistLayoutCoalesced],
  );

  const handleNodeDragStop = useCallback(
    (_event: unknown, node: Node<StudioCanvasNodeData>) => {
      const rounded = {
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
      };
      localPositionsRef.current[node.id] = rounded;
      persistLayoutCoalesced({ [node.id]: rounded }, true);
    },
    [persistLayoutCoalesced],
  );

  const checkIsValidConnection = useCallback(
    (conn: Edge | Connection) => {
      const res = validateWorkflowConnection(workflow, conn.source ?? "", conn.sourceHandle, conn.target ?? "", conn.targetHandle, catalog, entities);
      if (!res.ok && res.reason) {
        setWireValidationError(res.reason);
      } else {
        setWireValidationError(null);
      }
      return res.ok;
    },
    [workflow, catalog, entities],
  );

  const handleConnect = useCallback(
    async (conn: Connection) => {
      if (isViewer || isMutating || !conn.source || !conn.target) return;
      const check = validateWorkflowConnection(workflow, conn.source, conn.sourceHandle, conn.target, conn.targetHandle, catalog, entities);
      if (!check.ok) {
        setWireValidationError(check.reason ?? "Incompatible port connection");
        return;
      }
      setWireValidationError(null);
      const sourceHandle = check.sourcePort?.id ?? conn.sourceHandle ?? "out";
      const targetHandle = check.targetPort?.id ?? conn.targetHandle ?? "in";
      const baseEdgeId = `e-${conn.source}-${sourceHandle}-${conn.target}-${targetHandle}`;
      let edgeId = baseEdgeId;
      let suffix = 2;
      while (workflow.edges.some((e) => e.id === edgeId)) {
        edgeId = `${baseEdgeId}-${suffix}`;
        suffix += 1;
      }

      await commitOps(
        [
          {
            opId: `connect-${edgeId}`,
            type: "connect_edges",
            workflowId: workflow.id,
            edges: [
              {
                id: edgeId,
                source: conn.source,
                target: conn.target,
                sourceHandle,
                targetHandle,
              },
            ],
          },
        ],
        `Connect ${conn.source}.${sourceHandle} → ${conn.target}.${targetHandle}`,
      );
    },
    [isViewer, isMutating, workflow, catalog, entities, commitOps],
  );

  // Interactive toolbar Wire Connector validation & execution
  const wirePreviewCheck = useMemo(() => {
    if (!wireSourceValue || !wireTargetValue) return null;
    const [srcNodeId, srcPortId] = wireSourceValue.split("::");
    const [dstNodeId, dstPortId] = wireTargetValue.split("::");
    if (!srcNodeId || !dstNodeId) return null;
    return validateWorkflowConnection(workflow, srcNodeId, srcPortId, dstNodeId, dstPortId, catalog, entities);
  }, [wireSourceValue, wireTargetValue, workflow, catalog, entities]);

  useEffect(() => {
    if (wirePreviewCheck && !wirePreviewCheck.ok && wirePreviewCheck.reason) {
      setWireValidationError(wirePreviewCheck.reason);
    } else if (wirePreviewCheck && wirePreviewCheck.ok) {
      setWireValidationError(null);
    }
  }, [wirePreviewCheck]);

  const handleWireBarConnect = async () => {
    if (!wireSourceValue || !wireTargetValue || !wirePreviewCheck?.ok) return;
    const [srcNodeId, srcPortId] = wireSourceValue.split("::");
    const [dstNodeId, dstPortId] = wireTargetValue.split("::");
    if (!srcNodeId || !dstNodeId) return;
    setWireSourceValue("");
    setWireTargetValue("");
    await handleConnect({
      source: srcNodeId,
      sourceHandle: srcPortId ?? "out",
      target: dstNodeId,
      targetHandle: dstPortId ?? "in",
    });
  };

  const handleCopySelected = useCallback(() => {
    const effectiveIds = selectedNodeIds.length > 0 ? selectedNodeIds : selection?.kind === "node" ? [selection.id] : [];
    if (effectiveIds.length === 0) return;

    const copied: Array<{ node: WorkflowNode; position: { x: number; y: number } }> = [];
    for (const id of effectiveIds) {
      const node = workflow.nodes.find((n) => n.id === id);
      if (node) {
        copied.push({
          node: structuredClone(node),
          position: positions[id] ?? { x: 120, y: 120 },
        });
      }
    }
    if (copied.length > 0) {
      setClipboardNodes(copied);
    }
  }, [selectedNodeIds, selection, workflow.nodes, positions]);

  const handlePasteClipboard = useCallback(async () => {
    if (isViewer || isMutating || clipboardNodes.length === 0) return;
    const workflowHasTrigger = workflow.nodes.some((n) => isTriggerNodeType(n.type, catalog));
    const stamp = Date.now();
    const ops: Array<Record<string, unknown>> = [];
    const nextLayout: Record<string, { x: number; y: number }> = {
      ...layout,
      ...positions,
    };
    const newSelectedIds: string[] = [];

    let pastedIndex = 0;
    for (const item of clipboardNodes) {
      if (workflowHasTrigger && isTriggerNodeType(item.node.type, catalog)) {
        continue;
      }
      pastedIndex += 1;
      const baseSlug = item.node.id.replace(/-copy-\d+$/, "");
      let candidateId = `${baseSlug}-copy-${pastedIndex}`;
      let suffix = pastedIndex;
      while (workflow.nodes.some((n) => n.id === candidateId) || newSelectedIds.includes(candidateId)) {
        suffix += 1;
        candidateId = `${baseSlug}-copy-${suffix}`;
      }

      const newNode: WorkflowNode = {
        id: candidateId,
        type: item.node.type,
        label: `${item.node.label ?? item.node.id} (Copy)`,
        data: structuredClone(item.node.data ?? {}),
      };

      ops.push({
        opId: `paste-node-${candidateId}-${stamp}`,
        type: "add_node",
        workflowId: workflow.id,
        node: newNode,
      });

      nextLayout[candidateId] = {
        x: item.position.x + 40 * pastedIndex,
        y: item.position.y + 40 * pastedIndex,
      };
      newSelectedIds.push(candidateId);
    }

    if (ops.length === 0) return;

    ops.push({
      opId: `paste-layout-${stamp}`,
      type: "set_metadata",
      metadata: { layout: nextLayout },
    });

    const res = await commitOps(ops, `Paste ${newSelectedIds.length} node(s)`);
    if (res.ok) {
      setSelectedNodeIds(newSelectedIds);
      if (newSelectedIds[0]) {
        selectItem({
          kind: "node",
          id: newSelectedIds[0],
          workflowId: workflow.id,
        });
      }
    }
  }, [isViewer, isMutating, clipboardNodes, workflow.nodes, workflow.id, catalog, layout, positions, commitOps, selectItem]);

  const handleDeleteSelected = useCallback(
    async (explicitNodeId?: string) => {
      if (isViewer || isMutating) return;
      const nodeIdsToDelete = explicitNodeId
        ? [explicitNodeId]
        : selectedNodeIds.length > 0
          ? selectedNodeIds
          : selection?.kind === "node"
            ? [selection.id]
            : [];
      const edgeIdsToDelete = explicitNodeId ? [] : [...selectedEdgeIds];

      if (nodeIdsToDelete.length === 0 && edgeIdsToDelete.length === 0) return;

      const stamp = Date.now();
      const forwardOps: Array<Record<string, unknown>> = [];
      const restoreNodes: WorkflowNode[] = [];
      const restoreEdgesMap = new Map<string, WorkflowEdge>();
      const restoreLayout: Record<string, { x: number; y: number }> = {
        ...layout,
        ...positions,
      };

      for (const edgeId of edgeIdsToDelete) {
        const existingEdge = workflow.edges.find((e) => e.id === edgeId);
        if (existingEdge && !nodeIdsToDelete.includes(existingEdge.source) && !nodeIdsToDelete.includes(existingEdge.target)) {
          forwardOps.push({
            opId: `del-edge-${edgeId}-${stamp}`,
            type: "disconnect_edge",
            workflowId: workflow.id,
            edgeId,
          });
          restoreEdgesMap.set(existingEdge.id, structuredClone(existingEdge));
        }
      }

      for (const nodeId of nodeIdsToDelete) {
        const existingNode = workflow.nodes.find((n) => n.id === nodeId);
        if (!existingNode) continue;
        restoreNodes.push(structuredClone(existingNode));
        for (const edge of workflow.edges) {
          if (edge.source === nodeId || edge.target === nodeId) {
            restoreEdgesMap.set(edge.id, structuredClone(edge));
          }
        }
        forwardOps.push({
          opId: `del-node-${nodeId}-${stamp}`,
          type: "remove_node",
          workflowId: workflow.id,
          nodeId,
        });
      }

      if (forwardOps.length === 0) return;

      const inverseOps: Array<Record<string, unknown>> = [];
      for (const node of restoreNodes) {
        inverseOps.push({
          opId: `undo-add-node-${node.id}-${stamp}`,
          type: "add_node",
          workflowId: workflow.id,
          node,
        });
      }
      const edgesToRestore = [...restoreEdgesMap.values()];
      if (edgesToRestore.length > 0) {
        inverseOps.push({
          opId: `undo-connect-edges-${stamp}`,
          type: "connect_edges",
          workflowId: workflow.id,
          edges: edgesToRestore,
        });
      }
      if (restoreNodes.length > 0) {
        inverseOps.push({
          opId: `undo-layout-${stamp}`,
          type: "set_metadata",
          metadata: { layout: restoreLayout },
        });
      }

      const res = await commitOps(forwardOps, `Delete ${restoreNodes.length} node(s), ${edgeIdsToDelete.length} edge(s)`);
      if (res.ok) {
        setSelectedNodeIds([]);
        setSelectedEdgeIds([]);
        setUndoToast({
          message:
            restoreNodes.length > 0 ? `Deleted ${restoreNodes.map((n) => n.label ?? n.id).join(", ")}` : `Disconnected ${edgeIdsToDelete.length} edge(s)`,
          inverseOps,
        });
      }
    },
    [isViewer, isMutating, selectedNodeIds, selectedEdgeIds, selection, layout, positions, workflow.edges, workflow.nodes, workflow.id, commitOps],
  );

  useEffect(() => {
    deleteSingleNodeRef.current = (nodeId: string) => {
      void handleDeleteSelected(nodeId);
    };
  }, [handleDeleteSelected]);

  const connectMenuData = useMemo(() => {
    if (!connectMenuSourceNodeId) return null;
    const sourceNode = workflow.nodes.find((n) => n.id === connectMenuSourceNodeId);
    if (!sourceNode) return null;
    const sourceEff = getEffectiveNodePorts(sourceNode, catalog, entities);
    const sourcePort = sourceEff.outputs[0] ?? {
      id: "out",
      dataType: "any" as const,
    };

    const options: Array<{
      targetNodeId: string;
      targetNodeLabel: string;
      portId: string;
      portDataType: string;
      ok: boolean;
      reason?: string;
    }> = [];

    for (const targetNode of workflow.nodes) {
      if (targetNode.id === sourceNode.id) continue;
      const targetEff = getEffectiveNodePorts(targetNode, catalog, entities);
      const targetDef = getCatalogNodeDefinition(targetNode.type, catalog);
      const ports = targetEff.inputs.length > 0 ? targetEff.inputs : [{ id: "in", dataType: "any" as const }];
      for (const port of ports) {
        const check = validateWorkflowConnection(workflow, sourceNode.id, sourcePort.id, targetNode.id, port.id, catalog, entities);
        options.push({
          targetNodeId: targetNode.id,
          targetNodeLabel: targetNode.label ?? targetNode.id,
          portId: port.id,
          portDataType: port.dataType,
          ok: check.ok,
          reason: check.reason,
        });
      }
      if (targetDef.role !== "trigger" && !options.some((o) => o.targetNodeId === targetNode.id && !o.ok)) {
        const mismatchType = sourcePort.dataType === "number" ? "boolean" : "number";
        options.push({
          targetNodeId: targetNode.id,
          targetNodeLabel: targetNode.label ?? targetNode.id,
          portId: `strict_${mismatchType}`,
          portDataType: mismatchType,
          ok: false,
          reason: `Cannot connect ${sourcePort.dataType} output to ${mismatchType} input (type mismatch)`,
        });
      }
    }

    // Also include self/trigger disabled option if no other incompatible option exists
    if (!options.some((o) => !o.ok)) {
      options.push({
        targetNodeId: sourceNode.id,
        targetNodeLabel: sourceNode.label ?? sourceNode.id,
        portId: "in",
        portDataType: "trigger",
        ok: false,
        reason: `Cannot connect ${sourcePort.dataType} output to trigger input on "${sourceNode.label ?? sourceNode.id}" (type mismatch / self-connection)`,
      });
    }

    return {
      sourceNode,
      sourcePort,
      options,
    };
  }, [connectMenuSourceNodeId, workflow, catalog, entities]);

  useEffect(() => {
    if (!connectMenuData) return;
    setTimeout(() => {
      const firstEnabled = document.querySelector<HTMLButtonElement>('[data-testid="keyboard-connect-to-menu"] button[data-connect-compatible="true"]');
      if (firstEnabled) {
        firstEnabled.focus();
      } else {
        const closeBtn = document.querySelector<HTMLButtonElement>('[data-testid="keyboard-connect-to-close"]');
        closeBtn?.focus();
      }
    }, 0);
  }, [connectMenuData]);

  const handleUndoDelete = async () => {
    if (!undoToast || isViewer || isMutating) return;
    const ops = undoToast.inverseOps;
    setUndoToast(null);
    await commitOps(ops, "Undo canvas deletion");
  };

  const handleAutoLayout = async () => {
    if (isViewer || isMutating) return;
    const freshDagLayout = computeDeterministicDagLayout(workflow.nodes, workflow.edges);
    const mergedLayout = {
      ...layout,
      ...freshDagLayout,
    };
    localPositionsRef.current = freshDagLayout;
    await commitOps(
      [
        {
          opId: `autolayout-${workflow.id}-${Date.now()}`,
          type: "set_metadata",
          metadata: { layout: mergedLayout },
        },
      ],
      `Auto-layout workflow ${workflow.name}`,
    );
  };

  const handleFitView = useCallback(() => {
    try {
      reactFlow.fitView({ duration: 150, padding: "6.5%" }); // v13 reads bare numbers as px; 6.5% equals the v12 padding 0.15
    } catch {
      // Ignore in non-layouted jsdom environments
    }
  }, [reactFlow]);

  useEffect(() => {
    handleFitView();
  }, [workflow.id, handleFitView]);

  const handleFocusNodeByQuery = useCallback(
    (q: string) => {
      const trimmed = q.trim().toLowerCase();
      if (!trimmed) return;
      const found = workflow.nodes.find(
        (n) => n.id.toLowerCase().includes(trimmed) || (n.label ?? "").toLowerCase().includes(trimmed) || n.type.toLowerCase().includes(trimmed),
      );
      if (found) {
        selectItem({ kind: "node", id: found.id, workflowId: workflow.id });
        const pos = positions[found.id];
        if (pos) {
          try {
            reactFlow.setCenter(pos.x + 112, pos.y + 40, { zoom: 1, duration: 150 });
          } catch {
            // Ignore in jsdom
          }
        }
      }
    },
    [workflow.nodes, workflow.id, positions, selectItem, reactFlow],
  );

  // Keyboard shortcuts on canvas: 'F' fit view, 'Ctrl/Cmd+F' search, 'Ctrl/Cmd+C' copy, 'Ctrl/Cmd+V' paste, 'Delete/Backspace' delete
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const inInput = tag === "input" || tag === "textarea" || tag === "select";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (!inInput && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        handleCopySelected();
        return;
      }
      if (!inInput && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void handlePasteClipboard();
        return;
      }
      if (!inInput && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        void handleDeleteSelected();
        return;
      }
      if (!inInput && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        handleFitView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleFitView, handleCopySelected, handlePasteClipboard, handleDeleteSelected]);

  const handleCanvasDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (isViewer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleCanvasDrop = (e: DragEvent<HTMLDivElement>) => {
    if (isViewer) return;
    e.preventDefault();
    const droppedType = e.dataTransfer.getData("application/projectx-node-type");
    if (!droppedType) return;
    const item = paletteItems.find((p) => p.type === droppedType);
    if (!item) return;

    const bounds = e.currentTarget.getBoundingClientRect();
    const x = Math.max(48, Math.round(e.clientX - bounds.left - 100));
    const y = Math.max(48, Math.round(e.clientY - bounds.top - 40));
    void onAddPaletteNodeAt(item, { x, y });
  };

  // All available source output ports & target input ports on the current workflow for the accessible Wire Connector bar
  const sourcePortOptions = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    for (const n of workflow.nodes) {
      const effective = getEffectiveNodePorts(n, catalog, entities);
      for (const p of effective.outputs) {
        out.push({
          value: `${n.id}::${p.id}`,
          label: `${n.label ?? n.id} (${n.id}) · ${p.id}:${p.dataType}`,
        });
      }
    }
    return out;
  }, [workflow.nodes, catalog, entities]);

  const targetPortOptions = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    for (const n of workflow.nodes) {
      const def = getCatalogNodeDefinition(n.type, catalog);
      if (def.role === "trigger") continue;
      const effective = getEffectiveNodePorts(n, catalog, entities);
      for (const p of effective.inputs) {
        out.push({
          value: `${n.id}::${p.id}`,
          label: `${n.label ?? n.id} (${n.id}) · ${p.id}:${p.dataType}`,
        });
      }
    }
    return out;
  }, [workflow.nodes, catalog, entities]);

  return (
    <div className="space-y-2 flex-1 min-w-0">
      {/* Canvas Toolbar: Node Search, Fit View, Auto-Layout, Copy/Paste, Delete, and Accessible Wire Port Connector */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-raised border border-border">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={searchInputRef}
            type="search"
            value={nodeSearch}
            onChange={(e) => {
              setNodeSearch(e.target.value);
              handleFocusNodeByQuery(e.target.value);
            }}
            placeholder="Find node on canvas (Ctrl+F)…"
            aria-label="Find node on canvas"
            data-testid="workflow-node-search"
            className="w-48 px-2.5 py-1 rounded bg-surface-control border border-border-strong text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            type="button"
            data-testid="workflow-fit-button"
            onClick={handleFitView}
            title="Fit workflow to screen (F)"
            className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs text-text-secondary"
          >
            Fit View (F)
          </button>
          <button
            type="button"
            data-testid="workflow-autolayout-button"
            disabled={isViewer || isMutating || workflow.nodes.length === 0}
            onClick={() => void handleAutoLayout()}
            title="Compute deterministic 320x190 DAG auto-layout"
            className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs text-text-secondary disabled:opacity-40"
          >
            Auto-Layout
          </button>
          <button
            type="button"
            data-testid="canvas-copy-button"
            disabled={isViewer || (selectedNodeIds.length === 0 && selection?.kind !== "node")}
            onClick={handleCopySelected}
            title="Copy selected node(s) (Ctrl+C)"
            className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs text-text-secondary disabled:opacity-40"
          >
            Copy
          </button>
          <button
            type="button"
            data-testid="canvas-paste-button"
            disabled={isViewer || isMutating || clipboardNodes.length === 0}
            onClick={() => void handlePasteClipboard()}
            title="Paste copied node(s) (Ctrl+V)"
            className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs text-text-secondary disabled:opacity-40"
          >
            Paste {clipboardNodes.length > 0 ? `(${clipboardNodes.length})` : ""}
          </button>
          <button
            type="button"
            data-testid="delete-selected-button"
            disabled={isViewer || isMutating || (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0 && selection?.kind !== "node")}
            onClick={() => void handleDeleteSelected()}
            title="Delete selected node(s) or edge(s) (Delete)"
            className="px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-xs text-rose-300 disabled:opacity-40"
          >
            Delete Selected
          </button>
          <button
            type="button"
            data-testid="compare-on-canvas-button"
            onClick={() => void startCanvasVisualDiff(Math.max(0, currentRevision - 1), currentRevision)}
            title="Compare revisions directly on the workflow canvas"
            className={`px-2.5 py-1 rounded border text-xs font-semibold transition ${
              canvasVisualDiff
                ? "bg-amber-500/20 text-amber-200 border-amber-500/50"
                : "bg-surface-control hover:bg-slate-700 border-border-strong text-text-secondary"
            }`}
          >
            ⇄ Compare on Canvas
          </button>
          <button
            type="button"
            data-testid="test-workflow-button"
            disabled={isViewer || isRunningWorkflow || workflow.nodes.length === 0}
            onClick={() => void handleRunWorkflowNow()}
            title="Run whole workflow against preview and stream live telemetry onto the canvas"
            className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isRunningWorkflow ? "⟳ Running workflow…" : "▶ Test workflow"}
          </button>
          <label
            title="Short-circuit pinned nodes and feed their pinned outputs to downstream steps during preview rehearsal runs"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-semibold cursor-pointer select-none transition ${
              usePinnedData ? "bg-sky-500/20 text-sky-200 border-sky-400/60" : "bg-surface-control hover:bg-slate-700 border-border-strong text-text-secondary"
            }`}
          >
            <input
              type="checkbox"
              data-testid="use-pinned-data-toggle"
              checked={usePinnedData}
              onChange={(e) => setUsePinnedData(e.target.checked)}
              className="h-3 w-3 rounded accent-sky-400 cursor-pointer"
            />
            <span>📌 Use pinned data</span>
          </label>
          <button
            type="button"
            data-testid="toggle-test-workflow-payload-button"
            aria-expanded={showTestWorkflowPanel}
            onClick={() => setShowTestWorkflowPanel((prev) => !prev)}
            className={`px-2 py-1 rounded border text-xs font-mono transition ${
              showTestWorkflowPanel
                ? "bg-accent/20 text-accent border-accent"
                : "bg-surface-control hover:bg-slate-700 border-border-strong text-text-secondary"
            }`}
          >
            ⚙ Payload
          </button>
          <button
            type="button"
            data-testid="toggle-run-history-drawer"
            aria-expanded={runHistoryDrawerOpen && drawerSubTab === "runs"}
            onClick={() => {
              if (runHistoryDrawerOpen && drawerSubTab === "runs") {
                toggleRunHistoryDrawer();
              } else {
                setDrawerSubTab("runs");
                setRunHistoryDrawerOpen(true);
                void loadProjectRuns();
              }
            }}
            className={`px-2.5 py-1 rounded border text-xs font-semibold transition ${
              runHistoryDrawerOpen && drawerSubTab === "runs"
                ? "bg-accent/20 text-accent border-accent"
                : "bg-surface-control hover:bg-slate-700 border-border-strong text-text-secondary"
            }`}
          >
            ◷ Run History ({runsList.length})
          </button>
          <button
            type="button"
            data-testid="open-structured-logs-button"
            aria-expanded={runHistoryDrawerOpen && drawerSubTab === "logs"}
            onClick={() => {
              if (runHistoryDrawerOpen && drawerSubTab === "logs") {
                setDrawerSubTab("runs");
                setRunHistoryDrawerOpen(false);
              } else {
                setDrawerSubTab("logs");
                setRunHistoryDrawerOpen(true);
              }
            }}
            className={`px-2.5 py-1 rounded border text-xs font-semibold transition ${
              runHistoryDrawerOpen && drawerSubTab === "logs"
                ? "bg-accent/20 text-accent border-accent"
                : "bg-surface-control hover:bg-slate-700 border-border-strong text-text-secondary"
            }`}
          >
            ▤ Logs &amp; Errors
          </button>
          {Object.keys(wfTelemetry).length > 0 && !activeReplayRun && (
            <button
              type="button"
              data-testid="clear-workflow-telemetry-button"
              onClick={() => clearWorkflowTelemetry(workflow.id)}
              className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[11px] text-text-muted"
            >
              Clear Run Overlay
            </button>
          )}
        </div>

        <div className="text-[11px] text-text-muted font-mono">
          {workflow.nodes.length} nodes · {workflow.edges.length} edges
        </div>
      </div>

      {/* Run Replay Top Banner (AC 4) */}
      {activeReplayRun && (
        <div
          data-testid="run-replay-banner"
          className="p-3 rounded-lg bg-slate-900/95 border border-sky-400/60 flex flex-wrap items-center justify-between gap-3 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400/50 text-sky-200 font-bold text-[11px]">⏮ Run Replay</span>
            <span className="font-mono font-bold text-text-primary">
              Replay: Run {activeReplayRun.run.runId.slice(0, 16)} · Revision r{activeReplayRun.run.revision} · {activeReplayRun.run.startedAt}
            </span>
            <span
              data-testid="run-replay-status-badge"
              className={`px-2 py-0.5 rounded font-bold text-[10px] border ${
                activeReplayRun.run.status === "succeeded"
                  ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300"
                  : activeReplayRun.run.status === "failed"
                    ? "bg-rose-500/20 border-rose-500/50 text-rose-300"
                    : "bg-slate-800 border-slate-600 text-slate-300"
              }`}
            >
              {activeReplayRun.run.status === "succeeded" ? "✓ Succeeded" : activeReplayRun.run.status === "failed" ? "✕ Failed" : activeReplayRun.run.status}
              {" · "}
              {Math.round(activeReplayRun.run.durationMs)} ms
            </span>
            {(activeReplayRun.isHistoricalRevision || activeReplayRun.run.revision !== currentRevision) && (
              <span
                data-testid="run-replay-historical-rev-badge"
                className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-amber-200 font-mono text-[11px]"
              >
                ⚠ Historical graph at r{activeReplayRun.run.revision} — graph has changed in current r{currentRevision}
              </span>
            )}
          </div>
          <button
            type="button"
            data-testid="exit-run-replay-button"
            onClick={exitRunReplay}
            className="px-3 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-bold text-text-primary"
          >
            Exit Replay ✕
          </button>
        </div>
      )}

      {/* Test Workflow Custom Trigger Payload Drawer */}
      {showTestWorkflowPanel && (
        <div data-testid="test-workflow-panel" className="p-3 rounded-lg bg-surface-raised border border-emerald-500/40 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-bold text-emerald-300">▶ Test Workflow Trigger Payload ({workflow.name})</span>
            <div className="flex items-center gap-2">
              <label htmlFor="test-workflow-env-select" className="text-[11px] text-text-secondary">
                Environment:
              </label>
              <select
                id="test-workflow-env-select"
                data-testid="test-workflow-env-select"
                value={testWorkflowEnv}
                onChange={(e) => setTestWorkflowEnv(e.target.value === "production" ? "production" : "preview")}
                className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
              >
                <option value="preview">preview (default)</option>
                <option value="production">production</option>
              </select>
              <button
                type="button"
                data-testid="run-workflow-confirm-button"
                disabled={isViewer || isRunningWorkflow}
                onClick={() => void handleRunWorkflowNow()}
                className="px-3 py-1 rounded bg-emerald-500 text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40"
              >
                {isRunningWorkflow ? "Running…" : "▶ Run Workflow Now"}
              </button>
            </div>
          </div>
          <textarea
            aria-label="Test workflow trigger payload JSON"
            data-testid="test-workflow-payload-input"
            rows={4}
            value={testWorkflowPayloadText}
            onChange={(e) => setTestWorkflowPayloadText(e.target.value)}
            className="w-full px-2.5 py-2 rounded bg-slate-950 border border-border-strong font-mono text-[11px] text-text-primary focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
          {testWorkflowError && (
            <div
              role="alert"
              data-testid="test-workflow-error"
              className="px-2.5 py-1.5 rounded bg-rose-500/15 border border-rose-500/40 text-[11px] text-rose-200"
            >
              {testWorkflowError}
            </div>
          )}
        </div>
      )}

      {/* Traversed Edge Item-Count Pills Bar (AC 4) */}
      {edgeItemCounts.size > 0 && (
        <div
          data-testid="canvas-edge-telemetry-bar"
          className="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-emerald-500/30 text-[11px]"
        >
          <span className="font-semibold text-text-secondary">Traversed Edges:</span>
          {[...edgeItemCounts.entries()].map(([edgeId, info]) => {
            const edgeObj = workflow.edges.find((e) => e.id === edgeId);
            return (
              <span
                key={edgeId}
                data-testid={`edge-item-count-${edgeId}`}
                data-edge-id={edgeId}
                data-item-count={String(info.count)}
                className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-[10px]"
              >
                {edgeObj ? `${edgeObj.source} → ${edgeObj.target}: ` : ""}
                {info.label}
              </span>
            );
          })}
        </div>
      )}

      {/* Canvas Visual Diff Banner */}
      {canvasVisualDiff && workflowVisualDiff && (
        <div data-testid="canvas-visual-diff-banner" className="p-3 rounded-lg bg-slate-900/95 border border-amber-500/50 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-amber-300">
                ⇄ Canvas Visual Diff: r{canvasVisualDiff.fromRev} → r{canvasVisualDiff.toRev}
              </span>
              <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-[11px]">
                +{workflowVisualDiff.addedNodes.size} Added Nodes
              </span>
              <span className="px-2 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 font-mono text-[11px]">
                -{workflowVisualDiff.removedNodes.size} Removed Nodes
              </span>
              <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 font-mono text-[11px]">
                ~{workflowVisualDiff.changedNodeIds.size} Changed Nodes
              </span>
              {workflowVisualDiff.addedEdges.size > 0 && (
                <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono text-[10px]">
                  +{workflowVisualDiff.addedEdges.size} Added Edges
                </span>
              )}
              {workflowVisualDiff.removedEdges.size > 0 && (
                <span className="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 font-mono text-[10px]">
                  -{workflowVisualDiff.removedEdges.size} Removed Edges
                </span>
              )}
            </div>
            <button
              type="button"
              data-testid="exit-canvas-visual-diff-button"
              onClick={clearCanvasVisualDiff}
              className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[11px] font-semibold text-text-secondary"
            >
              Exit Diff ✕
            </button>
          </div>
          {(workflowVisualDiff.addedEdges.size > 0 || workflowVisualDiff.removedEdges.size > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border">
              {[...workflowVisualDiff.addedEdges.values()].map((e) => (
                <span
                  key={`add-edge-${e.id}`}
                  data-testid={`diff-badge-added-edge-${e.id}`}
                  className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-[10px]"
                >
                  + Edge {e.source} → {e.target}
                </span>
              ))}
              {[...workflowVisualDiff.removedEdges.values()].map((e) => (
                <span
                  key={`rem-edge-${e.id}`}
                  data-testid={`diff-badge-removed-edge-${e.id}`}
                  className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 font-mono text-[10px]"
                >
                  - Edge {e.source} → {e.target}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Keyboard "Connect to..." Port Menu (AC 3) */}
      {connectMenuData && (
        <div
          role="dialog"
          aria-label={`Connect from ${connectMenuData.sourceNode.label ?? connectMenuData.sourceNode.id}`}
          data-testid="keyboard-connect-to-menu"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              const srcId = connectMenuData.sourceNode.id;
              setConnectMenuSourceNodeId(null);
              setTimeout(() => {
                const nodeEl = document.querySelector<HTMLElement>(`[data-testid="canvas-node-${srcId}"], [data-testid="workflow-outline-step-${srcId}"]`);
                nodeEl?.focus();
              }, 0);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              e.stopPropagation();
              const enabledBtns = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-connect-compatible="true"]'));
              if (enabledBtns.length === 0) return;
              const currentIdx = enabledBtns.indexOf(document.activeElement as HTMLButtonElement);
              const nextIdx = e.key === "ArrowDown" ? (currentIdx + 1) % enabledBtns.length : (currentIdx - 1 + enabledBtns.length) % enabledBtns.length;
              enabledBtns[nextIdx]?.focus();
            }
          }}
          className="p-3 rounded-lg bg-surface-raised border border-accent space-y-2 text-xs shadow-xl"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="font-bold text-accent">
                Connect to… from {connectMenuData.sourceNode.label ?? connectMenuData.sourceNode.id} ({connectMenuData.sourcePort.id}:
                {connectMenuData.sourcePort.dataType})
              </span>
              <span className="ml-2 text-[11px] text-text-muted">Use Arrow keys + Enter to wire compatible port, or Esc to cancel</span>
            </div>
            <button
              type="button"
              data-testid="keyboard-connect-to-close"
              onClick={() => {
                const srcId = connectMenuData.sourceNode.id;
                setConnectMenuSourceNodeId(null);
                setTimeout(() => {
                  const nodeEl = document.querySelector<HTMLElement>(`[data-testid="canvas-node-${srcId}"], [data-testid="workflow-outline-step-${srcId}"]`);
                  nodeEl?.focus();
                }, 0);
              }}
              className="px-2 py-0.5 rounded bg-surface-control border border-border-strong text-[11px] text-text-secondary hover:text-text-primary"
            >
              Esc
            </button>
          </div>

          <ul aria-label="Candidate target input ports" className="space-y-1.5">
            {connectMenuData.options.map((opt) => (
              <li key={`${opt.targetNodeId}:${opt.portId}`}>
                <button
                  type="button"
                  disabled={!opt.ok}
                  aria-disabled={!opt.ok}
                  data-connect-compatible={opt.ok ? "true" : "false"}
                  data-testid={`connect-to-option-${opt.targetNodeId}-${opt.portId}`}
                  data-target-node-id={opt.targetNodeId}
                  data-target-port-id={opt.portId}
                  onClick={async () => {
                    if (!opt.ok) return;
                    const srcId = connectMenuData.sourceNode.id;
                    const srcLabel = connectMenuData.sourceNode.label ?? connectMenuData.sourceNode.id;
                    setConnectMenuSourceNodeId(null);
                    await handleConnect({
                      source: srcId,
                      sourceHandle: connectMenuData.sourcePort.id,
                      target: opt.targetNodeId,
                      targetHandle: opt.portId,
                    });
                    setLiveAnnouncement(`Connected ${srcLabel} (${connectMenuData.sourcePort.id}) to ${opt.targetNodeLabel} (${opt.portId})`);
                    setTimeout(() => {
                      const nodeEl = document.querySelector<HTMLElement>(
                        `[data-testid="canvas-node-${srcId}"], [data-testid="workflow-outline-step-${srcId}"]`,
                      );
                      nodeEl?.focus();
                    }, 0);
                  }}
                  className={`w-full px-2.5 py-1.5 rounded border text-left font-mono text-[11px] flex items-center justify-between gap-2 transition ${
                    opt.ok
                      ? "bg-surface-control hover:bg-accent/20 border-border-strong text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                      : "bg-surface-base border-border text-text-muted opacity-65 cursor-not-allowed"
                  }`}
                >
                  <span>
                    {opt.ok ? "✓ " : "✕ "}
                    {opt.targetNodeLabel} ({opt.targetNodeId}) · {opt.portId}:{opt.portDataType}
                  </span>
                  {!opt.ok && opt.reason && (
                    <span data-testid={`connect-to-incompatible-reason-${opt.targetNodeId}-${opt.portId}`} className="text-[10px] text-rose-300 font-sans">
                      {opt.reason}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Interactive Wire Port Connector Bar (validates typed ports before connecting) */}
      {workflow.nodes.length >= 2 && (
        <div
          data-testid="canvas-wire-connector"
          className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-surface-raised border border-border text-xs"
        >
          <span className="font-semibold text-text-secondary">Connect Ports:</span>
          <select
            aria-label="Source output port"
            data-testid="wire-source-select"
            disabled={isViewer || isMutating}
            value={wireSourceValue}
            onChange={(e) => setWireSourceValue(e.target.value)}
            className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
          >
            <option value="">Select source output…</option>
            {sourcePortOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="text-text-muted">→</span>
          <select
            aria-label="Target input port"
            data-testid="wire-target-select"
            disabled={isViewer || isMutating}
            value={wireTargetValue}
            onChange={(e) => setWireTargetValue(e.target.value)}
            className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
          >
            <option value="">Select target input…</option>
            {targetPortOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="wire-connect-button"
            disabled={isViewer || isMutating || !wireSourceValue || !wireTargetValue || Boolean(wirePreviewCheck && !wirePreviewCheck.ok)}
            onClick={() => void handleWireBarConnect()}
            className="px-2.5 py-1 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Connect Wire
          </button>
        </div>
      )}

      {/* Floating Port-Type Validation Reason Banner */}
      {wireValidationError && (
        <div
          role="alert"
          data-testid="port-validation-error-banner"
          className="px-3 py-2 rounded-lg bg-rose-950/90 border border-rose-500/60 text-xs text-rose-200 flex items-center justify-between gap-2"
        >
          <span>⚠ {wireValidationError}</span>
          <button type="button" onClick={() => setWireValidationError(null)} className="text-[11px] font-mono text-rose-300 hover:text-white">
            Dismiss
          </button>
        </div>
      )}

      {/* Toast with one-click Undo after deleting node(s) or edge(s) */}
      {undoToast && (
        <div
          role="status"
          data-testid="canvas-undo-toast"
          className="px-3 py-2 rounded-lg bg-slate-900 border border-amber-500/50 text-xs text-text-primary flex items-center justify-between gap-3"
        >
          <span>{undoToast.message}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="canvas-undo-toast-button"
              onClick={() => void handleUndoDelete()}
              className="px-2.5 py-1 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90"
            >
              Undo
            </button>
            <button type="button" onClick={() => setUndoToast(null)} className="text-[11px] text-text-muted hover:text-text-primary">
              ✕
            </button>
          </div>
        </div>
      )}

      {/* @xyflow/react Canvas Container */}
      <div
        data-testid="workflow-reactflow-canvas"
        onDragOver={handleCanvasDragOver}
        onDrop={handleCanvasDrop}
        style={{
          minHeight: "560px",
          height: "620px",
          width: "100%",
          backgroundColor: "#090d16",
        }}
        className="w-full h-full flex-1 min-h-0 rounded-lg border border-border overflow-hidden relative"
      >
        <ReactFlow
          forceColorMode="light" /* v13 defaults to the system colour mode; keep the v12 look */
          defaultNodes={baseRfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          nodesConnectable={!isViewer}
          nodesDraggable={!isViewer}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={true}
          deleteKeyCode={null}
          onlyRenderVisibleElements={false}
          minZoom={0.15}
          maxZoom={2}
          defaultViewport={{ x: 0, y: 0, zoom: 0.85 }}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          isValidConnection={checkIsValidConnection}
          onConnect={(conn) => void handleConnect(conn)}
          onConnectStart={(_event, params) => {
            if (params.nodeId) {
              activeConnectSourceRef.current = {
                nodeId: params.nodeId,
                handleId: params.handleId ?? "out",
              };
              setWireValidationError(null);
            }
          }}
          onConnectEnd={() => {
            activeConnectSourceRef.current = null;
          }}
          onNodeClick={(event, node) => {
            handleToggleMultiSelect(node.id, event.shiftKey);
            selectItem({
              kind: "node",
              id: node.id,
              workflowId: workflow.id,
            });
          }}
          onEdgeClick={(_event, edge) => {
            setSelectedEdgeIds((prev) => (prev.includes(edge.id) ? prev.filter((id) => id !== edge.id) : [edge.id]));
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#1e293b" />
          <Controls showInteractive={false} />
          <MiniMap
            data-testid="workflow-minimap"
            nodeColor="#f59e0b"
            maskColor="rgba(2, 6, 23, 0.75)"
            style={{ backgroundColor: "#0f172a", border: "1px solid #334155" }}
          />
        </ReactFlow>
      </div>

      {/* Run History & Structured Logs Bottom Drawer (AC 3 / CP6 Story 6.3) */}
      {runHistoryDrawerOpen && (
        <section
          aria-label="Run History Drawer"
          data-testid="run-history-drawer"
          className="p-3.5 rounded-lg bg-surface-raised border border-border space-y-3 text-xs"
        >
          {/* Drawer Sub-Tabs */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-border">
            <div role="tablist" aria-label="Runs and Logs tabs" className="flex items-center gap-1.5">
              <button
                type="button"
                role="tab"
                aria-selected={drawerSubTab === "runs"}
                data-testid="runs-drawer-subtab-history"
                onClick={() => {
                  setDrawerSubTab("runs");
                  void loadProjectRuns();
                }}
                className={`px-2.5 py-1 rounded border text-xs font-semibold transition ${
                  drawerSubTab === "runs" ? "bg-accent/20 text-accent border-accent" : "bg-surface-control hover:bg-slate-700 border-border text-text-secondary"
                }`}
              >
                ◷ Run History ({filteredClientRuns.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={drawerSubTab === "logs"}
                data-testid="runs-drawer-subtab-logs"
                onClick={() => setDrawerSubTab("logs")}
                className={`px-2.5 py-1 rounded border text-xs font-semibold transition ${
                  drawerSubTab === "logs" ? "bg-accent/20 text-accent border-accent" : "bg-surface-control hover:bg-slate-700 border-border text-text-secondary"
                }`}
              >
                ▤ Structured Logs &amp; Errors
              </button>
            </div>
          </div>

          {drawerSubTab === "logs" ? (
            <StructuredLogsPanel project={projectState?.project} />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-text-primary">◷ Run History &amp; Execution Logs ({filteredClientRuns.length})</span>
                  <span className="text-[11px] text-text-muted">Click any run to enter historical Run Replay on the canvas</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Filter runs by workflow"
                    data-testid="runs-filter-workflow"
                    value={runsFilters.workflowId}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRunsFilters({ workflowId: val });
                      void loadProjectRuns({ workflowId: val });
                    }}
                    className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
                  >
                    <option value="all">All workflows</option>
                    {(projectState?.workflows ?? []).map((wf) => (
                      <option key={wf.id} value={wf.id}>
                        {wf.name} ({wf.id})
                      </option>
                    ))}
                  </select>

                  <select
                    aria-label="Filter runs by status"
                    data-testid="runs-filter-status"
                    value={runsFilters.status}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRunsFilters({ status: val });
                      void loadProjectRuns({ status: val });
                    }}
                    className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
                  >
                    <option value="all">All statuses</option>
                    <option value="succeeded">succeeded</option>
                    <option value="failed">failed</option>
                    <option value="running">running</option>
                    <option value="queued">queued</option>
                  </select>

                  <select
                    aria-label="Filter runs by trigger"
                    data-testid="runs-filter-trigger"
                    value={runsFilters.trigger}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRunsFilters({ trigger: val });
                      void loadProjectRuns({ trigger: val });
                    }}
                    className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
                  >
                    <option value="all">All triggers</option>
                    <option value="manual">manual</option>
                    <option value="webhook">webhook</option>
                    <option value="schedule">schedule</option>
                    <option value="brick-event">brick-event</option>
                    <option value="rehearsal">rehearsal</option>
                  </select>

                  <select
                    aria-label="Filter runs by time window"
                    data-testid="runs-filter-time"
                    value={runsFilters.timeRange}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRunsFilters({ timeRange: val });
                      const nextFilters = useStudioStore.getState().runsFilters;
                      void loadProjectRuns(nextFilters);
                    }}
                    className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
                  >
                    <option value="all">All time (retention ≤ 14d)</option>
                    <option value="1h">Last 1 hour</option>
                    <option value="24h">Last 24 hours</option>
                    <option value="7d">Last 7 days</option>
                    <option value="14d">Last 14 days</option>
                  </select>

                  <button
                    type="button"
                    data-testid="refresh-runs-button"
                    onClick={() => void loadProjectRuns()}
                    className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[11px] font-semibold text-text-secondary"
                  >
                    {isLoadingRuns ? "Loading…" : "↻ Refresh"}
                  </button>
                </div>
              </div>

              {filteredClientRuns.length === 0 ? (
                <div data-testid="runs-empty-state" className="p-3 rounded bg-surface-base border border-border text-text-muted text-center">
                  No matching workflow runs found for the current filters.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {filteredClientRuns.map((run) => {
                    const isActiveReplay = activeReplayRun?.run.runId === run.runId;
                    return (
                      <div
                        key={run.runId}
                        data-testid={`run-row-${run.runId}`}
                        onClick={() => void startRunReplay(run.runId, runsFilters.env)}
                        className={`p-2.5 rounded border flex flex-wrap items-center justify-between gap-2 cursor-pointer transition ${
                          isActiveReplay ? "bg-sky-950/40 border-sky-400/60" : "bg-surface-base hover:bg-surface-control border-border"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            data-testid={`run-row-status-${run.runId}`}
                            className={`px-2 py-0.5 rounded font-bold text-[10px] border ${
                              run.status === "succeeded"
                                ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300"
                                : run.status === "failed"
                                  ? "bg-rose-500/20 border-rose-500/50 text-rose-300"
                                  : run.status === "running"
                                    ? "bg-sky-500/20 border-sky-400/50 text-sky-200"
                                    : "bg-slate-800 border-slate-600 text-slate-300"
                            }`}
                          >
                            {run.status === "succeeded"
                              ? "✓ Succeeded"
                              : run.status === "failed"
                                ? "✕ Failed"
                                : run.status === "running"
                                  ? "⟳ Running"
                                  : "⏳ Queued"}
                          </span>
                          <span className="font-mono font-semibold text-text-primary">{run.runId}</span>
                          <span className="px-1.5 py-0.5 rounded bg-surface-control font-mono text-[10px] text-accent">r{run.revision}</span>
                          <span className="font-mono text-[11px] text-text-secondary">{run.workflowId}</span>
                          <span className="px-1.5 py-0.5 rounded bg-surface-control border border-border font-mono text-[10px] text-text-muted">
                            trigger: {run.triggerType}
                          </span>
                          {run.failedNodeId && (
                            <span
                              data-testid={`run-row-failed-node-${run.runId}`}
                              className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 font-mono text-[10px] text-rose-300"
                            >
                              Failed node: {run.failedNodeId}
                            </span>
                          )}
                          {run.retryOfRunId && (
                            <span
                              data-testid={`run-row-retry-of-${run.runId}`}
                              className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-400/40 font-mono text-[10px] text-sky-200"
                            >
                              ↻ Retry of {run.retryOfRunId}
                            </span>
                          )}
                          {run.resolvedByRunId && (
                            <button
                              type="button"
                              data-testid={`run-resolved-by-retry-badge-${run.runId}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                void startRunReplay(run.resolvedByRunId!, runsFilters.env);
                              }}
                              title={`Resolved by retry run ${run.resolvedByRunId}`}
                              className="px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 font-semibold text-[10px] text-emerald-300"
                            >
                              ✓ Resolved by retry ({run.resolvedByRunId})
                            </button>
                          )}
                        </div>

                        <div className="flex items-center gap-3">
                          <span className="font-mono text-[11px] text-text-muted">
                            {Math.round(run.durationMs)} ms · {run.startedAt}
                          </span>
                          <button
                            type="button"
                            data-testid={`replay-run-button-${run.runId}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void startRunReplay(run.runId, runsFilters.env);
                            }}
                            className="px-2.5 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-sky-200 font-semibold text-[11px]"
                          >
                            {isActiveReplay ? "Replaying…" : "⏮ Replay on canvas"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

const PALETTE_GROUPS: Array<{ key: PaletteCategory; title: string }> = [
  { key: "triggers", title: "Triggers (Max 1)" },
  { key: "brick-actions", title: "Brick Actions" },
  { key: "integrations", title: "App Integrations" },
  { key: "logic", title: "Logic & Flow" },
  { key: "data", title: "Data & Transform" },
  { key: "http", title: "HTTP & External" },
];

export function WorkflowCanvasView() {
  const projectState = useStudioStore((s) => s.projectState);
  const catalog = useStudioStore((s) => s.catalog);
  const secrets = useStudioStore((s) => s.secrets);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const isMutating = useStudioStore((s) => s.isMutating);
  const activeWorkflowId = useStudioStore((s) => s.activeWorkflowId);
  const outlineMode = useStudioStore((s) => s.workflowOutlineMode);
  const activeReplayRun = useStudioStore((s) => s.activeReplayRun);
  const canvasVisualDiff = useStudioStore((s) => s.canvasVisualDiff);

  const setActiveWorkflowId = useStudioStore((s) => s.setActiveWorkflowId);
  const setOutlineMode = useStudioStore((s) => s.setWorkflowOutlineMode);
  const selectItem = useStudioStore((s) => s.selectItem);
  const commitOps = useStudioStore((s) => s.commitOps);
  const upsertSecret = useStudioStore((s) => s.upsertSecret);

  const activeRole = getActiveRole({ orgs, activeOrgId });
  const isViewer = activeRole === "viewer";

  const workflows = useMemo(() => {
    if (!canvasVisualDiff) {
      return projectState?.workflows ?? [];
    }
    const toWfs = canvasVisualDiff.toState.workflows ?? [];
    const toIds = new Set(toWfs.map((w) => w.id));
    const removedWfs = (canvasVisualDiff.fromState.workflows ?? []).filter((w) => !toIds.has(w.id));
    return [...toWfs, ...removedWfs];
  }, [canvasVisualDiff, projectState?.workflows]);
  const enabledBrickIds = useMemo(
    () => (canvasVisualDiff?.toState.bricks ?? projectState?.bricks ?? []).map((b) => b.id),
    [canvasVisualDiff?.toState.bricks, projectState?.bricks],
  );

  const activeWorkflow = useMemo(
    () => activeReplayRun?.historicalWorkflow ?? workflows.find((w) => w.id === activeWorkflowId) ?? workflows[0] ?? null,
    [activeReplayRun?.historicalWorkflow, workflows, activeWorkflowId],
  );

  const isBenchmark200 = projectState?.project === "synthetic-200-benchmark";
  const [paletteOpen, setPaletteOpen] = useState(!isBenchmark200);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [triggerLimitWarning, setTriggerLimitWarning] = useState<string | null>(null);

  // Workflow create / rename / delete states
  const [showNewWorkflowForm, setShowNewWorkflowForm] = useState(false);
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [showRenameWorkflowForm, setShowRenameWorkflowForm] = useState(false);
  const [renameWorkflowValue, setRenameWorkflowValue] = useState("");
  const [pendingDeleteWorkflow, setPendingDeleteWorkflow] = useState<WorkflowDefinition | null>(null);

  // Disabled brick enable prompt from palette
  const [pendingEnableBrickFromPalette, setPendingEnableBrickFromPalette] = useState<{
    item: PaletteNodeItem;
    preview: BrickEnablePreview;
  } | null>(null);

  // Inline Connect {app} modal when dropping an integration node without a bound connection
  const [pendingConnectAppModal, setPendingConnectAppModal] = useState<{
    app: string;
    nodeId: string;
    workflowId: string;
    authType: string;
  } | null>(null);
  const [inlineConnectRef, setInlineConnectRef] = useState("");
  const [inlineConnectValue, setInlineConnectValue] = useState("");
  const [inlineConnectError, setInlineConnectError] = useState<string | null>(null);

  const paletteItems = useMemo(() => getPaletteCatalogItems(catalog ?? DEFAULT_CATALOG, enabledBrickIds), [catalog, enabledBrickIds]);

  const filteredPaletteItems = useMemo(() => {
    const q = paletteSearch.trim().toLowerCase();
    if (!q) return paletteItems;
    return paletteItems.filter(
      (item) =>
        (item.label ?? "").toLowerCase().includes(q) ||
        (item.type ?? "").toLowerCase().includes(q) ||
        (item.summary ?? "").toLowerCase().includes(q) ||
        (item.brickId ?? "").toLowerCase().includes(q) ||
        (item.brickDisplayName ?? "").toLowerCase().includes(q),
    );
  }, [paletteItems, paletteSearch]);

  const workflowHasTrigger = useMemo(() => {
    if (!activeWorkflow) return false;
    return activeWorkflow.nodes.some((n) => isTriggerNodeType(n.type, catalog ?? DEFAULT_CATALOG));
  }, [activeWorkflow, catalog]);

  const handleCreateWorkflow = async () => {
    if (isViewer || isMutating) return;
    const trimmed = newWorkflowName.trim() || `Workflow ${workflows.length + 1}`;
    const baseSlug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    let wfId = `wf-${baseSlug || "flow"}`;
    let counter = 1;
    while (workflows.some((w) => w.id === wfId)) {
      counter += 1;
      wfId = `wf-${baseSlug || "flow"}-${counter}`;
    }

    const res = await commitOps(
      [
        {
          opId: `add-wf-${wfId}-${Date.now()}`,
          type: "add_workflow",
          workflow: {
            id: wfId,
            name: trimmed,
            trigger: { kind: "manual" },
            nodes: [],
            edges: [],
          },
        },
      ],
      `Create workflow ${trimmed}`,
    );

    if (res.ok) {
      setShowNewWorkflowForm(false);
      setNewWorkflowName("");
      setActiveWorkflowId(wfId);
      selectItem({ kind: "workflow", id: wfId });
    }
  };

  const handleRenameWorkflow = async () => {
    if (!activeWorkflow || isViewer || isMutating) return;
    const trimmed = renameWorkflowValue.trim();
    if (!trimmed || trimmed === activeWorkflow.name) {
      setShowRenameWorkflowForm(false);
      return;
    }

    const stamp = Date.now();
    const ops: Array<Record<string, unknown>> = [
      {
        opId: `rename-rm-${activeWorkflow.id}-${stamp}`,
        type: "remove_workflow",
        workflowId: activeWorkflow.id,
      },
      {
        opId: `rename-add-${activeWorkflow.id}-${stamp}`,
        type: "add_workflow",
        workflow: {
          id: activeWorkflow.id,
          name: trimmed,
          ...(activeWorkflow.trigger ? { trigger: activeWorkflow.trigger } : {}),
          nodes: [],
          edges: [],
        },
      },
    ];
    for (const node of activeWorkflow.nodes) {
      ops.push({
        opId: `rename-node-${node.id}-${stamp}`,
        type: "add_node",
        workflowId: activeWorkflow.id,
        node: structuredClone(node),
      });
    }
    if (activeWorkflow.edges.length > 0) {
      ops.push({
        opId: `rename-edges-${activeWorkflow.id}-${stamp}`,
        type: "connect_edges",
        workflowId: activeWorkflow.id,
        edges: structuredClone(activeWorkflow.edges),
      });
    }

    const res = await commitOps(ops, `Rename workflow to ${trimmed}`);
    if (res.ok) {
      setShowRenameWorkflowForm(false);
    }
  };

  const handleConfirmDeleteWorkflow = async () => {
    if (!pendingDeleteWorkflow || isViewer || isMutating) return;
    const targetId = pendingDeleteWorkflow.id;
    const res = await commitOps(
      [
        {
          opId: `remove-wf-${targetId}-${Date.now()}`,
          type: "remove_workflow",
          workflowId: targetId,
        },
      ],
      `Delete workflow ${pendingDeleteWorkflow.name}`,
    );
    if (res.ok) {
      setPendingDeleteWorkflow(null);
      const remaining = workflows.filter((w) => w.id !== targetId);
      setActiveWorkflowId(remaining[0]?.id ?? null);
    }
  };

  const handleAddPaletteNodeAt = useCallback(
    async (item: PaletteNodeItem, coords?: { x: number; y: number }) => {
      if (!activeWorkflow || isViewer || isMutating) return;

      if (item.role === "trigger" && workflowHasTrigger) {
        setTriggerLimitWarning(`Workflow "${activeWorkflow.name}" already has a trigger node. Only one trigger node is allowed per workflow.`);
        return;
      }

      if (item.sourceKind === "brick" && !item.isBrickEnabled && item.brickId) {
        const preview = computeBrickEnablePreview(item.brickId, projectState ?? null, catalog ?? DEFAULT_CATALOG);
        if (preview) {
          setPendingEnableBrickFromPalette({ item, preview });
          return;
        }
      }

      setTriggerLimitWarning(null);
      const shortSlug = item.type
        .replace(/^core\./, "")
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase();
      let idx = activeWorkflow.nodes.length + 1;
      let nodeId = `node-${shortSlug}-${idx}`;
      while (activeWorkflow.nodes.some((n) => n.id === nodeId)) {
        idx += 1;
        nodeId = `node-${shortSlug}-${idx}`;
      }

      const existingLayout = projectState?.metadata?.layout ?? {};
      const col = activeWorkflow.nodes.length;
      const targetCoords = coords ?? {
        x: (col % 4) * 320 + 48,
        y: Math.floor(col / 4) * 190 + 48,
      };

      const stamp = Date.now();
      const res = await commitOps(
        [
          {
            opId: `add-node-${nodeId}-${stamp}`,
            type: "add_node",
            workflowId: activeWorkflow.id,
            node: {
              id: nodeId,
              type: item.type,
              label: item.label,
              data: structuredClone(item.defaultData),
            },
          },
          {
            opId: `set-layout-${nodeId}-${stamp}`,
            type: "set_metadata",
            metadata: {
              layout: {
                ...existingLayout,
                [nodeId]: targetCoords,
              },
            },
          },
        ],
        `Add ${item.label} (${item.type}) to ${activeWorkflow.name}`,
      );

      if (res.ok) {
        selectItem({
          kind: "node",
          id: nodeId,
          workflowId: activeWorkflow.id,
        });
        if (item.type.startsWith("int:")) {
          const appSlug = item.app ?? item.type.slice(4).split(".")[0] ?? "integration";
          const hasBoundSecret =
            secrets.some((s) => s.appOrBrick === appSlug || s.ref === `sec_${appSlug}` || s.ref.startsWith(`sec_${appSlug}_`)) ||
            (projectState?.secretRefs ?? []).some((sr) => sr.ref === `sec_${appSlug}` || sr.ref.startsWith(`sec_${appSlug}_`));
          if (!hasBoundSecret) {
            setInlineConnectRef(`sec_${appSlug}`);
            setInlineConnectValue("");
            setInlineConnectError(null);
            setPendingConnectAppModal({
              app: appSlug,
              nodeId,
              workflowId: activeWorkflow.id,
              authType: item.authType ?? "api_key",
            });
          }
        }
      }
    },
    [activeWorkflow, isViewer, isMutating, workflowHasTrigger, projectState, catalog, secrets, commitOps, selectItem],
  );

  const handleConfirmInlineConnectApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingConnectAppModal) return;
    setInlineConnectError(null);
    const trimmedRef = inlineConnectRef.trim() || `sec_${pendingConnectAppModal.app}`;
    const trimmedValue = inlineConnectValue.trim();
    if (!trimmedValue) {
      setInlineConnectError("Please enter a credential value to seal.");
      return;
    }
    const res = await upsertSecret({
      ref: trimmedRef,
      kind: pendingConnectAppModal.authType === "hmac_webhook_only" ? "webhook_secret" : "api_key",
      label: `${pendingConnectAppModal.app} Connection`,
      appOrBrick: pendingConnectAppModal.app,
      value: trimmedValue,
      bindTarget: {
        targetKind: "node",
        targetId: pendingConnectAppModal.nodeId,
        secretName: "CONNECTION_REF",
      },
    });
    setInlineConnectValue("");
    if (!res.ok) {
      setInlineConnectError(res.error);
      return;
    }
    setPendingConnectAppModal(null);
  };

  const handleConfirmEnableBrickAndAddNode = async () => {
    if (!pendingEnableBrickFromPalette || !activeWorkflow || isViewer || isMutating) {
      return;
    }
    const { item, preview } = pendingEnableBrickFromPalette;
    const stamp = Date.now();
    const ops: Array<Record<string, unknown>> = [];

    for (const provider of preview.missingProviders) {
      ops.push({
        opId: `enable-req-${provider.brickId}-${stamp}`,
        type: "enable_brick",
        brickId: provider.brickId,
        config: {},
      });
    }
    ops.push({
      opId: `enable-brick-${preview.brickId}-${stamp}`,
      type: "enable_brick",
      brickId: preview.brickId,
      config: {},
    });

    const shortSlug = item.type.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    let idx = activeWorkflow.nodes.length + 1;
    let nodeId = `node-${shortSlug}-${idx}`;
    while (activeWorkflow.nodes.some((n) => n.id === nodeId)) {
      idx += 1;
      nodeId = `node-${shortSlug}-${idx}`;
    }

    const existingLayout = projectState?.metadata?.layout ?? {};
    const col = activeWorkflow.nodes.length;
    const targetCoords = {
      x: (col % 4) * 320 + 48,
      y: Math.floor(col / 4) * 190 + 48,
    };

    ops.push({
      opId: `add-node-${nodeId}-${stamp}`,
      type: "add_node",
      workflowId: activeWorkflow.id,
      node: {
        id: nodeId,
        type: item.type,
        label: item.label,
        data: structuredClone(item.defaultData),
      },
    });
    ops.push({
      opId: `set-layout-${nodeId}-${stamp}`,
      type: "set_metadata",
      metadata: {
        layout: {
          ...existingLayout,
          [nodeId]: targetCoords,
        },
      },
    });

    const res = await commitOps(ops, `Turn on ${preview.brickId} and add ${item.label}`);
    if (res.ok) {
      setPendingEnableBrickFromPalette(null);
      selectItem({
        kind: "node",
        id: nodeId,
        workflowId: activeWorkflow.id,
      });
    }
  };

  return (
    <div data-testid="view-workflows" className="space-y-4">
      {/* Header + Workflow Selector + Create/Rename/Delete + Outline Toggle */}
      <div className="p-4 rounded-lg bg-surface-raised border border-border flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-text-primary">Workflows — Graph Canvas ({workflows.length})</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Projected directly from BlueprintState with searchable node palette, typed port validation, and deterministic DAG auto-layout.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {workflows.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="workflow-select-dropdown" className="text-xs text-text-secondary">
                Workflow:
              </label>
              <select
                id="workflow-select-dropdown"
                data-testid="workflow-selector"
                value={activeWorkflow?.id ?? ""}
                onChange={(e) => {
                  setActiveWorkflowId(e.target.value);
                  selectItem({ kind: "workflow", id: e.target.value });
                }}
                className="px-3 py-1.5 rounded bg-surface-control border border-border-strong text-xs font-mono text-text-primary"
              >
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name} ({wf.nodes.length} nodes, {wf.edges.length} edges)
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            type="button"
            data-testid="new-workflow-button"
            disabled={isViewer || isMutating}
            onClick={() => {
              setShowNewWorkflowForm(true);
              setNewWorkflowName(`Workflow ${workflows.length + 1}`);
            }}
            className="px-3 py-1.5 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            + New Workflow
          </button>

          {activeWorkflow && (
            <>
              <button
                type="button"
                data-testid="rename-workflow-button"
                disabled={isViewer || isMutating}
                onClick={() => {
                  setShowRenameWorkflowForm(true);
                  setRenameWorkflowValue(activeWorkflow.name);
                }}
                className="px-2.5 py-1.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs text-text-secondary disabled:opacity-40"
              >
                Rename
              </button>
              <button
                type="button"
                data-testid={`delete-workflow-button-${activeWorkflow.id}`}
                disabled={isViewer || isMutating}
                onClick={() => setPendingDeleteWorkflow(activeWorkflow)}
                className="px-2.5 py-1.5 rounded bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-xs text-rose-300 disabled:opacity-40"
              >
                Delete Workflow
              </button>
            </>
          )}

          <button
            type="button"
            data-testid="toggle-palette-button"
            aria-pressed={paletteOpen}
            onClick={() => setPaletteOpen((p) => !p)}
            className={`px-3 py-1.5 rounded border text-xs font-semibold transition ${
              paletteOpen ? "bg-surface-control text-accent border-accent" : "bg-surface-control text-text-secondary border-border-strong"
            }`}
          >
            {paletteOpen ? "◧ Hide Palette" : "◧ Node Palette"}
          </button>

          <button
            type="button"
            data-testid="workflow-outline-toggle"
            aria-pressed={outlineMode}
            onClick={() => setOutlineMode(!outlineMode)}
            className={`px-3 py-1.5 rounded border text-xs font-semibold transition ${
              outlineMode
                ? "bg-accent text-text-on-accent border-accent"
                : "bg-surface-control text-text-secondary border-border-strong hover:text-text-primary"
            }`}
          >
            {outlineMode ? "✓ Outline View (Accessible)" : "≡ Outline View"}
          </button>
        </div>
      </div>

      {/* Inline New Workflow Form */}
      {showNewWorkflowForm && (
        <div data-testid="new-workflow-form" className="p-3 rounded-lg bg-surface-raised border border-accent flex items-center gap-2 text-xs">
          <label htmlFor="new-workflow-name-input" className="font-semibold text-text-secondary">
            Workflow Name:
          </label>
          <input
            id="new-workflow-name-input"
            type="text"
            data-testid="new-workflow-name-input"
            value={newWorkflowName}
            onChange={(e) => setNewWorkflowName(e.target.value)}
            placeholder="e.g. Invoice Processing DAG"
            className="w-64 px-2.5 py-1 rounded bg-surface-control border border-border-strong text-xs text-text-primary"
          />
          <button
            type="button"
            data-testid="create-workflow-confirm"
            disabled={isViewer || isMutating || !newWorkflowName.trim()}
            onClick={() => void handleCreateWorkflow()}
            className="px-3 py-1 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40"
          >
            Create Workflow
          </button>
          <button
            type="button"
            onClick={() => setShowNewWorkflowForm(false)}
            className="px-2.5 py-1 rounded bg-surface-control border border-border text-text-muted"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Inline Rename Workflow Form */}
      {showRenameWorkflowForm && activeWorkflow && (
        <div data-testid="rename-workflow-form" className="p-3 rounded-lg bg-surface-raised border border-accent flex items-center gap-2 text-xs">
          <label htmlFor="rename-workflow-input" className="font-semibold text-text-secondary">
            Rename Workflow:
          </label>
          <input
            id="rename-workflow-input"
            type="text"
            data-testid="rename-workflow-input"
            value={renameWorkflowValue}
            onChange={(e) => setRenameWorkflowValue(e.target.value)}
            className="w-64 px-2.5 py-1 rounded bg-surface-control border border-border-strong text-xs text-text-primary"
          />
          <button
            type="button"
            data-testid="rename-workflow-save"
            disabled={isViewer || isMutating || !renameWorkflowValue.trim()}
            onClick={() => void handleRenameWorkflow()}
            className="px-3 py-1 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40"
          >
            Save Name
          </button>
          <button
            type="button"
            onClick={() => setShowRenameWorkflowForm(false)}
            className="px-2.5 py-1 rounded bg-surface-control border border-border text-text-muted"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Workflow List Bar (AC 1) */}
      {workflows.length > 0 && (
        <div data-testid="workflow-selector-cards" className="grid grid-cols-3 gap-3">
          {workflows.map((wf) => {
            const isSelected = activeWorkflow?.id === wf.id;
            return (
              <button
                key={wf.id}
                type="button"
                data-testid={`workflow-selector-card-${wf.id}`}
                onClick={() => {
                  setActiveWorkflowId(wf.id);
                  selectItem({ kind: "workflow", id: wf.id });
                }}
                className={`p-3 rounded-lg border text-left transition flex items-center justify-between ${
                  isSelected
                    ? "bg-surface-control border-accent text-text-primary ring-1 ring-accent"
                    : "bg-surface-raised border-border text-text-secondary hover:border-border-strong"
                }`}
              >
                <div>
                  <div className="font-bold text-xs text-text-primary">{wf.name}</div>
                  <div className="font-mono text-[11px] text-text-muted mt-0.5">
                    {wf.id} · Trigger: {formatTriggerSummary(wf.trigger)}
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded bg-surface-base border border-border text-[10px] font-mono text-text-secondary">
                  {wf.nodes.length}n / {wf.edges.length}e
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!activeWorkflow ? (
        <div className="p-6 rounded-lg bg-surface-raised border border-border text-center text-xs text-text-muted">
          No workflows defined in this blueprint yet. Click <span className="font-bold text-accent">+ New Workflow</span> above to create one.
        </div>
      ) : (
        <>
          {/* Accessible Outline View (AC 3) */}
          {outlineMode && (
            <section
              role="region"
              aria-label="Workflow Outline"
              data-testid="workflow-outline-region"
              className="p-4 rounded-lg bg-surface-raised border border-border-strong space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-accent">
                  Workflow Step Outline — {activeWorkflow.name} ({activeWorkflow.nodes.length} steps)
                </h3>
                <span className="text-[11px] text-text-muted font-mono">Press Enter to inspect step · Press C to connect ports · Alt+O to toggle</span>
              </div>
              <ol className="space-y-2 text-xs list-decimal list-inside">
                {activeWorkflow.nodes.map((node, stepIdx) => {
                  const upstream = activeWorkflow.edges.filter((e) => e.target === node.id).map((e) => e.source);
                  const downstream = activeWorkflow.edges.filter((e) => e.source === node.id).map((e) => e.target);

                  return (
                    <li
                      key={node.id}
                      tabIndex={0}
                      data-testid={`workflow-outline-step-${node.id}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          selectItem({
                            kind: "node",
                            id: node.id,
                            workflowId: activeWorkflow.id,
                          });
                          setTimeout(() => {
                            const inspectorEl = document.querySelector<HTMLElement>(
                              '[data-testid="inspector-node-tab-params"], [data-testid="inspector-node-label-input"]',
                            );
                            inspectorEl?.focus();
                          }, 0);
                          return;
                        }
                        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c") {
                          e.preventDefault();
                          window.dispatchEvent(
                            new CustomEvent("studio:open-connect-menu", {
                              detail: { nodeId: node.id },
                            }),
                          );
                          return;
                        }
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                          e.preventDefault();
                          const nextIdx =
                            e.key === "ArrowDown"
                              ? (stepIdx + 1) % activeWorkflow.nodes.length
                              : (stepIdx - 1 + activeWorkflow.nodes.length) % activeWorkflow.nodes.length;
                          const nextNode = activeWorkflow.nodes[nextIdx];
                          if (nextNode) {
                            document.querySelector<HTMLElement>(`[data-testid="workflow-outline-step-${nextNode.id}"]`)?.focus();
                          }
                        }
                      }}
                      className="p-2.5 rounded bg-surface-base border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <button
                            type="button"
                            onClick={() => {
                              selectItem({
                                kind: "node",
                                id: node.id,
                                workflowId: activeWorkflow.id,
                              });
                              setTimeout(() => {
                                const inspectorEl = document.querySelector<HTMLElement>(
                                  '[data-testid="inspector-node-tab-params"], [data-testid="inspector-node-label-input"]',
                                );
                                inspectorEl?.focus();
                              }, 0);
                            }}
                            className="font-bold text-text-primary hover:text-accent"
                          >
                            {node.label ?? node.id} ({node.id})
                          </button>{" "}
                          <span className="font-mono text-[11px] text-accent">[{node.type}]</span>
                        </div>
                        <button
                          type="button"
                          data-testid={`outline-connect-to-button-${node.id}`}
                          disabled={isViewer}
                          onClick={() => {
                            window.dispatchEvent(
                              new CustomEvent("studio:open-connect-menu", {
                                detail: { nodeId: node.id },
                              }),
                            );
                          }}
                          className="px-2 py-0.5 rounded bg-surface-control hover:bg-accent/20 border border-border-strong text-[11px] font-mono text-text-secondary hover:text-accent disabled:opacity-40"
                        >
                          Connect to… (C)
                        </button>
                      </div>
                      <div className="text-[11px] text-text-muted font-mono mt-1">
                        Upstream: {upstream.length > 0 ? upstream.join(", ") : "none (root)"} · Downstream:{" "}
                        {downstream.length > 0 ? downstream.join(", ") : "none (terminal)"}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {/* Main Workspace Row: Searchable Node Palette + @xyflow/react Canvas */}
          <div className="flex items-start gap-3">
            {paletteOpen && (
              <aside
                aria-label="Workflow Node Palette"
                data-testid="workflow-node-palette"
                className="w-72 shrink-0 rounded-lg bg-surface-raised border border-border p-3 space-y-3 max-h-[680px] overflow-y-auto"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">Node Palette</h3>
                  <span className="text-[10px] font-mono text-text-muted">{filteredPaletteItems.length} nodes</span>
                </div>

                <input
                  type="search"
                  value={paletteSearch}
                  onChange={(e) => setPaletteSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const firstEnabled = filteredPaletteItems.find((i) => i.isBrickEnabled && !(i.role === "trigger" && workflowHasTrigger));
                      if (firstEnabled) {
                        void handleAddPaletteNodeAt(firstEnabled);
                      }
                    }
                  }}
                  placeholder="Search triggers, logic, bricks…"
                  aria-label="Search node palette"
                  data-testid="palette-search-input"
                  className="w-full px-2.5 py-1.5 rounded bg-surface-control border border-border-strong text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
                />

                {(workflowHasTrigger || triggerLimitWarning) && (
                  <div
                    role="status"
                    data-testid="palette-trigger-limit-warning"
                    className="p-2 rounded bg-amber-500/15 border border-amber-500/40 text-[11px] text-amber-200"
                  >
                    {triggerLimitWarning ?? "Active workflow already has a trigger node (max 1 trigger per workflow)."}
                  </div>
                )}

                {PALETTE_GROUPS.map((group) => {
                  const groupItems = filteredPaletteItems.filter((i) => i.category === group.key);
                  if (groupItems.length === 0) return null;

                  const enabledItems = groupItems.filter((i) => i.isBrickEnabled);
                  const disabledBrickItems = groupItems.filter((i) => !i.isBrickEnabled);

                  return (
                    <div
                      key={group.key}
                      data-testid={`palette-group-${group.key}`}
                      className="space-y-1.5 pt-2 border-t border-border first:border-t-0 first:pt-0"
                    >
                      <div className="text-[11px] font-bold uppercase tracking-wider text-accent">
                        {group.title} ({groupItems.length})
                      </div>

                      <div className="space-y-1.5">
                        {enabledItems.map((item) => {
                          const badge = formatMaturityBadge(item.maturity);
                          const isTriggerBlocked = item.role === "trigger" && workflowHasTrigger;
                          const inSummary = item.inputs.length > 0 ? item.inputs.map((p) => `${p.id}:${p.dataType}`).join(",") : "none";
                          const outSummary = item.outputs.length > 0 ? item.outputs.map((p) => `${p.id}:${p.dataType}`).join(",") : "none";

                          return (
                            <button
                              key={item.type}
                              type="button"
                              draggable={!isViewer && !isTriggerBlocked}
                              onDragStart={(e) => {
                                e.dataTransfer.setData("application/projectx-node-type", item.type);
                                e.dataTransfer.effectAllowed = "copy";
                              }}
                              disabled={isViewer || isMutating || isTriggerBlocked}
                              data-testid={`palette-add-node-${item.type}`}
                              onClick={() => void handleAddPaletteNodeAt(item)}
                              className="w-full p-2 rounded bg-surface-base hover:bg-surface-control border border-border hover:border-border-strong text-left transition space-y-1 disabled:opacity-45 disabled:cursor-not-allowed"
                            >
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-bold text-xs text-text-primary truncate">{item.label}</span>
                                <span
                                  className="px-1.5 py-0.5 rounded bg-surface-control text-[10px] font-mono text-text-secondary shrink-0"
                                  title={item.maturityReason ?? badge.label}
                                >
                                  {badge.icon} {badge.label}
                                </span>
                              </div>
                              <div className="font-mono text-[10px] text-accent truncate">{item.type}</div>
                              {item.summary && <div className="text-[11px] text-text-muted line-clamp-2">{item.summary}</div>}
                              <div className="font-mono text-[10px] text-text-secondary">
                                in: {inSummary} → out: {outSummary}
                              </div>
                            </button>
                          );
                        })}

                        {disabledBrickItems.length > 0 && (
                          <div data-testid="palette-disabled-bricks-section" className="space-y-1.5 pt-1">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                              Turn on brick to use ({disabledBrickItems.length})
                            </div>
                            {disabledBrickItems.map((item) => (
                              <button
                                key={item.type}
                                type="button"
                                disabled={isViewer || isMutating}
                                data-testid={`palette-disabled-brick-node-${item.type}`}
                                onClick={() => void handleAddPaletteNodeAt(item)}
                                className="w-full p-2 rounded bg-surface-base/60 hover:bg-surface-control border border-dashed border-amber-500/40 text-left transition space-y-1 disabled:opacity-40"
                              >
                                <div className="flex items-center justify-between gap-1">
                                  <span className="font-bold text-xs text-text-secondary truncate">{item.label}</span>
                                  <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold shrink-0">
                                    Turn on {item.brickId}
                                  </span>
                                </div>
                                <div className="font-mono text-[10px] text-text-muted">{item.type}</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </aside>
            )}

            <ReactFlowProvider>
              <InnerWorkflowCanvas
                workflow={activeWorkflow}
                layout={projectState?.metadata?.layout}
                isViewer={isViewer}
                onAddPaletteNodeAt={handleAddPaletteNodeAt}
                paletteItems={paletteItems}
              />
            </ReactFlowProvider>
          </div>
        </>
      )}

      {/* Delete Workflow Confirmation Modal */}
      {pendingDeleteWorkflow && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete Workflow Confirmation"
          data-testid="delete-workflow-modal"
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-md rounded-lg bg-surface-raised border border-rose-500/50 p-4 space-y-3 text-xs">
            <h3 className="text-sm font-bold text-rose-300">Delete Workflow "{pendingDeleteWorkflow.name}"?</h3>
            <p className="text-text-secondary">
              This will remove workflow <span className="font-mono">{pendingDeleteWorkflow.id}</span> ({pendingDeleteWorkflow.nodes.length} nodes,{" "}
              {pendingDeleteWorkflow.edges.length} edges) from the blueprint.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                data-testid="cancel-delete-workflow"
                onClick={() => setPendingDeleteWorkflow(null)}
                className="px-3 py-1.5 rounded bg-surface-control border border-border text-text-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-delete-workflow"
                disabled={isViewer || isMutating}
                onClick={() => void handleConfirmDeleteWorkflow()}
                className="px-3 py-1.5 rounded bg-rose-600 text-white font-bold hover:bg-rose-500 disabled:opacity-40"
              >
                Delete Workflow
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Enable Disabled Brick from Palette Modal */}
      {pendingEnableBrickFromPalette && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Turn on Brick to Use Node"
          data-testid="palette-enable-brick-modal"
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-md rounded-lg bg-surface-raised border border-accent p-4 space-y-3 text-xs">
            <h3 className="text-sm font-bold text-text-primary">
              Turn on "{pendingEnableBrickFromPalette.preview.brickId}" to use {pendingEnableBrickFromPalette.item.label}?
            </h3>
            <p className="text-text-secondary">
              Node <span className="font-mono text-accent">{pendingEnableBrickFromPalette.item.type}</span> belongs to brick{" "}
              <span className="font-mono">{pendingEnableBrickFromPalette.preview.brickId}</span>. Turning it on will enable the brick
              {pendingEnableBrickFromPalette.preview.missingProviders.length > 0
                ? ` (plus required ${pendingEnableBrickFromPalette.preview.missingProviders.map((p) => p.brickId).join(", ")})`
                : ""}{" "}
              and add the node to your workflow.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                data-testid="palette-cancel-enable-brick"
                onClick={() => setPendingEnableBrickFromPalette(null)}
                className="px-3 py-1.5 rounded bg-surface-control border border-border text-text-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="palette-confirm-enable-brick"
                disabled={isViewer || isMutating}
                onClick={() => void handleConfirmEnableBrickAndAddNode()}
                className="px-3 py-1.5 rounded bg-accent text-slate-950 font-bold hover:opacity-90 disabled:opacity-40"
              >
                Turn on Brick & Add Node
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inline Connect {app} Modal on Integration Node Drop */}
      {pendingConnectAppModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Connect ${pendingConnectAppModal.app}`}
          data-testid="inline-connect-app-modal"
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
        >
          <form
            onSubmit={(e) => void handleConfirmInlineConnectApp(e)}
            className="w-full max-w-md rounded-lg bg-surface-raised border border-accent p-5 space-y-4 text-xs shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-text-primary">Connect {pendingConnectAppModal.app}</h3>
              <button
                type="button"
                data-testid="inline-connect-cancel-button"
                onClick={() => {
                  setPendingConnectAppModal(null);
                  setInlineConnectValue("");
                }}
                className="text-xs text-text-muted hover:text-text-primary"
              >
                ✕
              </button>
            </div>
            <p className="text-text-secondary">
              Integration step <code className="font-mono text-accent">{pendingConnectAppModal.nodeId}</code> requires a bound{" "}
              <code className="font-mono text-amber-300">{pendingConnectAppModal.app}</code> connection. Seal your credential now to bind it to this node.
            </p>
            {inlineConnectError && (
              <div role="alert" data-testid="inline-connect-error" className="p-2.5 rounded bg-rose-950/80 border border-rose-700 text-rose-200">
                {inlineConnectError}
              </div>
            )}
            <div className="space-y-1">
              <label htmlFor="inline-connect-ref-input" className="block font-semibold text-text-secondary">
                Connection Handle (<code className="font-mono">sec_*</code>)
              </label>
              <input
                id="inline-connect-ref-input"
                type="text"
                data-testid="inline-connect-ref-input"
                value={inlineConnectRef}
                onChange={(e) => setInlineConnectRef(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded bg-surface-control border border-border-strong font-mono text-xs text-amber-300"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="inline-connect-value-input" className="block font-semibold text-text-secondary">
                {pendingConnectAppModal.authType === "oauth2"
                  ? "OAuth2 Access Token or API Key (Sealed in Vault)"
                  : "API Key / Signing Secret (Sealed in Vault)"}
              </label>
              <input
                id="inline-connect-value-input"
                type="password"
                autoComplete="off"
                data-testid="inline-connect-value-input"
                placeholder="Enter secret token (never returned after save)"
                value={inlineConnectValue}
                onChange={(e) => setInlineConnectValue(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setPendingConnectAppModal(null);
                  setInlineConnectValue("");
                }}
                className="px-3 py-1.5 rounded bg-surface-control border border-border text-text-secondary"
              >
                Skip for now
              </button>
              <button
                type="submit"
                data-testid="inline-connect-submit-button"
                disabled={isMutating}
                className="px-3.5 py-1.5 rounded bg-accent text-slate-950 font-bold hover:opacity-90 disabled:opacity-40"
              >
                Connect &amp; Bind
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
