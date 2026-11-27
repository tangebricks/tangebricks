import { computeSemanticDiff, createEmptyBlueprint, normalizeBlueprintState } from "@poc/blueprint";
import React, { useEffect, useMemo, useState } from "react";
import { fetchProjectAuditLogs, fetchProjectDiff, fetchProjectRetentionSettings, fetchProjectRevisions, updateProjectRetentionSettings } from "../api.ts";
import type { ProjectRetentionSettingsPayload, StudioAuditLogEntry } from "../api.ts";
import { getActiveRole, useStudioStore } from "../store.ts";
import { applyStudioOps, extractAffectedTargets, formatAuthorBadge, formatRelativeTimestamp, getDistinctAgentFilters, matchesAuthorFilter } from "../types.ts";
import type { AffectedObjectTarget, BlueprintState, RevisionSummary, SemanticDiff, StudioNavTab, StudioSelection } from "../types.ts";

export interface ChangeLedgerProps {
  compact?: boolean;
  onFocusObject?: (selection: StudioSelection, nav: StudioNavTab) => void;
  onViewDiff?: (fromRev: number, toRev: number) => void;
  initialDiff?: SemanticDiff | null;
}

function computeFallbackDiffFromRevisions(project: string, revisions: RevisionSummary[], fromRev: number, toRev: number): SemanticDiff {
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
  let stateFrom: BlueprintState = createEmptyBlueprint(project);
  for (const rev of ordered) {
    if (rev.revision <= fromRev && rev.ops) {
      stateFrom = applyStudioOps(stateFrom, rev.ops);
    }
  }
  let stateTo: BlueprintState = createEmptyBlueprint(project);
  for (const rev of ordered) {
    if (rev.revision <= toRev && rev.ops) {
      stateTo = applyStudioOps(stateTo, rev.ops);
    }
  }
  return computeSemanticDiff(
    normalizeBlueprintState(stateFrom as Parameters<typeof normalizeBlueprintState>[0]),
    normalizeBlueprintState(stateTo as Parameters<typeof normalizeBlueprintState>[0]),
  );
}

export function AuthorFilterPills({
  revisions,
  activeFilter,
  onSelectFilter,
  testIdPrefix = "ledger-filter",
}: {
  revisions: RevisionSummary[];
  activeFilter: string;
  onSelectFilter: (filter: string) => void;
  testIdPrefix?: string;
}) {
  const agentFilters = useMemo(() => getDistinctAgentFilters(revisions), [revisions]);

  const basePills = [
    { id: "all", label: "All" },
    { id: "humans", label: "Humans" },
    { id: "agents", label: "AI Agents" },
  ];

  return (
    <div role="group" aria-label="Filter revisions by author" className="flex items-center gap-1.5 flex-wrap">
      {basePills.map((pill) => {
        const active = activeFilter === pill.id;
        return (
          <button
            key={pill.id}
            type="button"
            data-testid={`${testIdPrefix}-${pill.id}`}
            onClick={() => onSelectFilter(pill.id)}
            className={`px-2 py-1 rounded text-[11px] font-semibold transition border ${
              active ? "bg-surface-control text-accent border-amber-500/40" : "bg-surface-base text-text-secondary border-border hover:border-border-strong"
            }`}
          >
            {pill.label}
          </button>
        );
      })}

      {agentFilters.map((agentTag) => {
        const active = activeFilter === agentTag;
        return (
          <button
            key={agentTag}
            type="button"
            data-testid={`${testIdPrefix}-${agentTag}`}
            onClick={() => onSelectFilter(agentTag)}
            className={`px-2 py-1 rounded text-[11px] font-mono transition border ${
              active ? "bg-sky-400/20 text-sky-200 border-sky-400/50 font-semibold" : "bg-sky-400/10 text-sky-300 border-sky-400/25 hover:border-sky-400/50"
            }`}
          >
            🤖 {agentTag}
          </button>
        );
      })}
    </div>
  );
}

export function SemanticDiffPanel({
  project,
  fromRev,
  toRev,
  revisions,
  overrideDiff,
  onClose,
}: {
  project: string;
  fromRev: number;
  toRev: number;
  revisions: RevisionSummary[];
  overrideDiff?: SemanticDiff | null;
  onClose?: () => void;
}) {
  const initialFallback = useMemo(
    () => overrideDiff ?? (revisions.length > 0 ? computeFallbackDiffFromRevisions(project, revisions, fromRev, toRev) : null),
    [overrideDiff, project, revisions, fromRev, toRev],
  );
  const [diff, setDiff] = useState<SemanticDiff | null>(initialFallback);
  const [loading, setLoading] = useState(!initialFallback);

  useEffect(() => {
    if (overrideDiff) {
      setDiff(overrideDiff);
      setLoading(false);
      return;
    }

    let cancelled = false;
    if (revisions.length > 0) {
      setDiff(computeFallbackDiffFromRevisions(project, revisions, fromRev, toRev));
      setLoading(false);
    } else {
      setLoading(true);
    }

    fetchProjectDiff(project, fromRev, toRev)
      .then((payload) => {
        if (!cancelled) {
          setDiff(payload.diff);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          const fallback = computeFallbackDiffFromRevisions(project, revisions, fromRev, toRev);
          setDiff(fallback);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [project, fromRev, toRev, revisions, overrideDiff]);

  return (
    <section
      aria-label={`Semantic diff r${fromRev} to r${toRev}`}
      data-testid="semantic-diff-viewer"
      className="p-4 rounded-lg bg-surface-raised border border-border-strong space-y-4 text-xs"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm text-text-primary">Semantic Diff</span>
          <span data-testid="semantic-diff-range" className="px-2 py-0.5 rounded bg-surface-control border border-border font-mono text-[11px] text-accent">
            r{fromRev} → r{toRev}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            data-testid="semantic-diff-close"
            onClick={onClose}
            className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 text-text-secondary text-[11px]"
          >
            Close diff
          </button>
        )}
      </div>

      {loading ? (
        <div data-testid="semantic-diff-loading" className="text-text-muted py-4 text-center">
          Computing semantic diff r{fromRev} → r{toRev}…
        </div>
      ) : !diff || diff.isEmpty ? (
        <div data-testid="semantic-diff-empty" className="p-3 rounded bg-surface-base border border-border text-text-muted text-center">
          No semantic changes between r{fromRev} and r{toRev} (layout-only or identical state).
        </div>
      ) : (
        <div className="space-y-4">
          {/* Identity */}
          {diff.identity && (
            <div data-testid="diff-section-identity" className="space-y-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Identity Provider</div>
              <div className="p-2.5 rounded bg-amber-500/10 border border-amber-500/30 font-mono text-[11px] text-amber-200">
                ~ Identity: <span className="line-through opacity-75">{diff.identity.from}</span> → <span className="font-bold">{diff.identity.to}</span>
              </div>
            </div>
          )}

          {/* Bricks */}
          {(diff.bricks.added.length > 0 || diff.bricks.removed.length > 0 || diff.bricks.updated.length > 0) && (
            <div data-testid="diff-section-bricks" className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Bricks</div>
              {diff.bricks.added.map((brick) => (
                <div
                  key={`brick-add-${brick.id}`}
                  data-testid={`diff-brick-added-${brick.id}`}
                  className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono text-[11px] flex items-center justify-between"
                >
                  <span>+ Brick enabled: {brick.id}</span>
                  <span>{JSON.stringify(brick.config)}</span>
                </div>
              ))}
              {diff.bricks.removed.map((brick) => (
                <div
                  key={`brick-rem-${brick.id}`}
                  data-testid={`diff-brick-removed-${brick.id}`}
                  className="p-2.5 rounded bg-red-500/10 border border-red-500/30 text-red-300 font-mono text-[11px]"
                >
                  - Brick removed: {brick.id}
                </div>
              ))}
              {diff.bricks.updated.map((upd) => (
                <div
                  key={`brick-upd-${upd.id}`}
                  data-testid={`diff-brick-updated-${upd.id}`}
                  className="p-2.5 rounded bg-amber-500/10 border border-amber-500/30 space-y-2"
                >
                  <div className="font-mono text-[11px] text-amber-300 font-semibold">~ Brick modified: {upd.id}</div>
                  <table className="w-full text-[11px] font-mono border-collapse">
                    <thead>
                      <tr className="text-left text-text-muted border-b border-border">
                        <th className="py-1 pr-2">Setting</th>
                        <th className="py-1 pr-2">Before (r{fromRev})</th>
                        <th className="py-1">After (r{toRev})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(new Set([...Object.keys(upd.before.config), ...Object.keys(upd.after.config)])).map((key) => (
                        <tr key={key} className="border-b border-border/50">
                          <td className="py-1 pr-2 text-text-primary">{key}</td>
                          <td className="py-1 pr-2 text-red-300">{JSON.stringify(upd.before.config[key])}</td>
                          <td className="py-1 text-emerald-300">{JSON.stringify(upd.after.config[key])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {/* Entities */}
          {(diff.entities.added.length > 0 || diff.entities.removed.length > 0 || diff.entities.updated.length > 0) && (
            <div data-testid="diff-section-entities" className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Data Entities</div>
              {diff.entities.added.map((ent) => (
                <div
                  key={`ent-add-${ent.name}`}
                  data-testid={`diff-entity-added-${ent.name}`}
                  className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono text-[11px]"
                >
                  + Entity added: {ent.name} ({ent.fields.map((f) => f.name).join(", ")})
                </div>
              ))}
              {diff.entities.removed.map((ent) => (
                <div
                  key={`ent-rem-${ent.name}`}
                  data-testid={`diff-entity-removed-${ent.name}`}
                  className="p-2.5 rounded bg-red-500/10 border border-red-500/30 text-red-300 font-mono text-[11px]"
                >
                  - Entity removed: {ent.name}
                </div>
              ))}
              {diff.entities.updated.map((upd) => (
                <div
                  key={`ent-upd-${upd.name}`}
                  data-testid={`diff-entity-updated-${upd.name}`}
                  className="p-2.5 rounded bg-amber-500/10 border border-amber-500/30 space-y-2"
                >
                  <div className="font-mono text-[11px] text-amber-300 font-semibold">~ Entity modified: {upd.name}</div>
                  <div className="space-y-1 font-mono text-[11px]">
                    {upd.fieldsAdded.map((f) => (
                      <div key={`fa-${f.name}`} className="text-emerald-300">
                        + Field {f.name} ({f.type})
                      </div>
                    ))}
                    {upd.fieldsRemoved.map((f) => (
                      <div key={`fr-${f.name}`} className="text-red-300">
                        - Field {f.name} ({f.type})
                      </div>
                    ))}
                    {upd.fieldsUpdated.map((f) => (
                      <div key={`fu-${f.name}`} className="text-amber-200">
                        ~ Field {f.name}: {JSON.stringify(f.before)} → {JSON.stringify(f.after)}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Workflows */}
          {(diff.workflows.added.length > 0 || diff.workflows.removed.length > 0 || diff.workflows.updated.length > 0) && (
            <div data-testid="diff-section-workflows" className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Workflows & Nodes</div>
              {diff.workflows.added.map((wf) => (
                <div
                  key={`wf-add-${wf.id}`}
                  data-testid={`diff-workflow-added-${wf.id}`}
                  className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono text-[11px]"
                >
                  + Workflow added: {wf.id} ({wf.nodes.length} nodes, {wf.edges.length} edges)
                </div>
              ))}
              {diff.workflows.removed.map((wf) => (
                <div
                  key={`wf-rem-${wf.id}`}
                  data-testid={`diff-workflow-removed-${wf.id}`}
                  className="p-2.5 rounded bg-red-500/10 border border-red-500/30 text-red-300 font-mono text-[11px]"
                >
                  - Workflow removed: {wf.id}
                </div>
              ))}
              {diff.workflows.updated.map((upd) => (
                <div
                  key={`wf-upd-${upd.id}`}
                  data-testid={`diff-workflow-updated-${upd.id}`}
                  className="p-2.5 rounded bg-amber-500/10 border border-amber-500/30 space-y-1.5 font-mono text-[11px]"
                >
                  <div className="text-amber-300 font-semibold">
                    ~ Workflow modified: {upd.id} ({upd.name})
                  </div>
                  {upd.nodesAdded.map((n) => (
                    <div key={`na-${n.id}`} data-testid={`diff-node-added-${n.id}`} className="text-emerald-300">
                      + Node {n.id} ({n.type}) {n.label ? `"${n.label}"` : ""}
                    </div>
                  ))}
                  {upd.nodesRemoved.map((n) => (
                    <div key={`nr-${n.id}`} data-testid={`diff-node-removed-${n.id}`} className="text-red-300">
                      - Node {n.id} ({n.type})
                    </div>
                  ))}
                  {upd.nodesUpdated.map((n) => (
                    <div key={`nu-${n.id}`} data-testid={`diff-node-updated-${n.id}`} className="text-amber-200">
                      ~ Node {n.id}: {JSON.stringify(n.before.data)} → {JSON.stringify(n.after.data)}
                    </div>
                  ))}
                  {upd.edgesAdded.map((e) => (
                    <div key={`ea-${e.id}`} className="text-emerald-300">
                      + Edge {e.id}: {e.source} → {e.target}
                    </div>
                  ))}
                  {upd.edgesRemoved.map((e) => (
                    <div key={`er-${e.id}`} className="text-red-300">
                      - Edge {e.id}: {e.source} → {e.target}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Secret Refs */}
          {(diff.secretRefs.added.length > 0 || diff.secretRefs.removed.length > 0 || diff.secretRefs.updated.length > 0) && (
            <div data-testid="diff-section-secrets" className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Secret References</div>
              {diff.secretRefs.added.map((s) => (
                <div key={`sec-add-${s.ref}`} className="p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono text-[11px]">
                  + Secret ref {s.ref} ({s.targetKind}:{s.targetId}.{s.secretName})
                </div>
              ))}
              {diff.secretRefs.removed.map((s) => (
                <div key={`sec-rem-${s.ref}`} className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 font-mono text-[11px]">
                  - Secret ref {s.ref}
                </div>
              ))}
              {diff.secretRefs.updated.map((u) => (
                <div key={`sec-upd-${u.ref}`} className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono text-[11px]">
                  ~ Secret ref {u.ref}: {u.before.secretName} → {u.after.secretName}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function SameObjectConflictCard() {
  const pendingConflict = useStudioStore((s) => s.pendingConflict);
  const resolvePendingConflict = useStudioStore((s) => s.resolvePendingConflict);
  const isMutating = useStudioStore((s) => s.isMutating);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const isViewer = getActiveRole({ orgs, activeOrgId }) === "viewer";

  const allFieldKeys = useMemo(() => {
    if (!pendingConflict) return [];
    const keys = new Set<string>([...Object.keys(pendingConflict.mineData), ...Object.keys(pendingConflict.aiData)]);
    return [...keys].sort();
  }, [pendingConflict]);

  const [fieldChoices, setFieldChoices] = useState<Record<string, "mine" | "ai">>({});

  useEffect(() => {
    if (!pendingConflict) {
      setFieldChoices({});
      return;
    }
    const initial: Record<string, "mine" | "ai"> = {};
    for (const k of allFieldKeys) {
      initial[k] = "mine";
    }
    setFieldChoices(initial);
  }, [pendingConflict, allFieldKeys]);

  if (!pendingConflict) return null;

  const authorBadge = formatAuthorBadge(pendingConflict.conflictingAuthor);

  return (
    <div role="alert" data-testid="same-object-conflict-card" className="p-3.5 rounded-lg bg-amber-950/80 border border-amber-500/60 space-y-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-bold text-amber-300 flex items-center gap-1.5">
            <span>⚠ Same-Object Conflict on</span>
            <span className="font-mono px-1.5 py-0.5 rounded bg-surface-control border border-amber-500/40 text-accent">
              {pendingConflict.targetKind}:{pendingConflict.targetId}
            </span>
          </div>
          <p className="text-[11px] text-amber-100/90 mt-1">
            You were editing <span className="font-mono font-semibold">{pendingConflict.targetId}</span> (base r{pendingConflict.baseRevision}) while{" "}
            <span className="font-mono font-semibold">{authorBadge.badgeText}</span> committed r{pendingConflict.conflictingRevision}. Choose how to resolve:
          </p>
        </div>
      </div>

      {allFieldKeys.length > 0 && (
        <div className="overflow-x-auto rounded border border-border bg-surface-base p-2">
          <table className="w-full text-[11px] font-mono border-collapse">
            <thead>
              <tr className="text-left text-text-muted border-b border-border">
                <th className="py-1 pr-2">Field</th>
                <th className="py-1 pr-2">Human (mine)</th>
                <th className="py-1 pr-2">AI ({authorBadge.displayName})</th>
                <th className="py-1">Pick Field</th>
              </tr>
            </thead>
            <tbody>
              {allFieldKeys.map((fieldKey) => {
                const mineVal = pendingConflict.mineData[fieldKey];
                const aiVal = pendingConflict.aiData[fieldKey];
                const selectedSide = fieldChoices[fieldKey] ?? "mine";
                return (
                  <tr key={fieldKey} className="border-b border-border/50">
                    <td className="py-1.5 pr-2 font-bold text-text-primary">{fieldKey}</td>
                    <td className="py-1.5 pr-2 text-amber-200">{JSON.stringify(mineVal)}</td>
                    <td className="py-1.5 pr-2 text-sky-300">{JSON.stringify(aiVal)}</td>
                    <td className="py-1.5">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          data-testid={`conflict-field-choice-${fieldKey}-mine`}
                          aria-pressed={selectedSide === "mine"}
                          onClick={() =>
                            setFieldChoices((prev) => ({
                              ...prev,
                              [fieldKey]: "mine",
                            }))
                          }
                          className={`px-1.5 py-0.5 rounded border text-[10px] ${
                            selectedSide === "mine"
                              ? "bg-amber-500/30 border-amber-400 text-amber-100 font-bold"
                              : "bg-surface-control border-border text-text-muted"
                          }`}
                        >
                          Mine
                        </button>
                        <button
                          type="button"
                          data-testid={`conflict-field-choice-${fieldKey}-ai`}
                          aria-pressed={selectedSide === "ai"}
                          onClick={() =>
                            setFieldChoices((prev) => ({
                              ...prev,
                              [fieldKey]: "ai",
                            }))
                          }
                          className={`px-1.5 py-0.5 rounded border text-[10px] ${
                            selectedSide === "ai" ? "bg-sky-500/30 border-sky-400 text-sky-100 font-bold" : "bg-surface-control border-border text-text-muted"
                          }`}
                        >
                          AI
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          data-testid="conflict-keep-mine-button"
          disabled={isViewer || isMutating}
          onClick={() => void resolvePendingConflict("mine")}
          className="px-2.5 py-1 rounded bg-amber-400 text-slate-950 font-bold text-[11px] hover:opacity-90 disabled:opacity-40"
        >
          Keep mine
        </button>
        <button
          type="button"
          data-testid="conflict-take-ai-button"
          disabled={isViewer || isMutating}
          onClick={() => void resolvePendingConflict("ai")}
          className="px-2.5 py-1 rounded bg-sky-400/20 border border-sky-400/50 text-sky-200 font-bold text-[11px] hover:bg-sky-400/30 disabled:opacity-40"
        >
          Take AI's
        </button>
        {allFieldKeys.length > 0 && (
          <button
            type="button"
            data-testid="conflict-apply-merged-button"
            disabled={isViewer || isMutating}
            onClick={() => void resolvePendingConflict("merged", fieldChoices)}
            className="px-2.5 py-1 rounded bg-emerald-500/20 border border-emerald-500/50 text-emerald-200 font-bold text-[11px] hover:bg-emerald-500/30 disabled:opacity-40"
          >
            Apply field selection
          </button>
        )}
      </div>
    </div>
  );
}

export function ChangeLedgerFeed({ compact = false, onFocusObject, onViewDiff }: ChangeLedgerProps) {
  const revisions = useStudioStore((s) => s.revisions);
  const isMutating = useStudioStore((s) => s.isMutating);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const isViewer = getActiveRole({ orgs, activeOrgId }) === "viewer";
  const ledgerAuthorFilter = useStudioStore((s) => s.ledgerAuthorFilter);
  const setLedgerAuthorFilter = useStudioStore((s) => s.setLedgerAuthorFilter);
  const selectItem = useStudioStore((s) => s.selectItem);
  const setActiveWorkflowId = useStudioStore((s) => s.setActiveWorkflowId);
  const setWorkflowNodeSearch = useStudioStore((s) => s.setWorkflowNodeSearch);
  const setDiffComparison = useStudioStore((s) => s.setDiffComparison);
  const setActiveNav = useStudioStore((s) => s.setActiveNav);
  const undoHistoricalRevision = useStudioStore((s) => s.undoHistoricalRevision);

  const [pendingUndoRev, setPendingUndoRev] = useState<RevisionSummary | null>(null);

  const filteredRevisions = useMemo(() => revisions.filter((rev) => matchesAuthorFilter(rev, ledgerAuthorFilter)), [revisions, ledgerAuthorFilter]);

  const handleTargetClick = (e: React.MouseEvent, target: AffectedObjectTarget) => {
    e.stopPropagation();
    if (target.kind === "brick") {
      const sel: StudioSelection = { kind: "brick", id: target.id };
      selectItem(sel, "bricks");
      onFocusObject?.(sel, "bricks");
    } else if (target.kind === "entity") {
      const sel: StudioSelection = { kind: "entity", id: target.id };
      selectItem(sel, "data");
      onFocusObject?.(sel, "data");
    } else if (target.kind === "workflow") {
      const sel: StudioSelection = { kind: "workflow", id: target.id };
      setActiveWorkflowId(target.id);
      selectItem(sel, "workflows");
      onFocusObject?.(sel, "workflows");
    } else if (target.kind === "node") {
      if (target.workflowId) {
        setActiveWorkflowId(target.workflowId);
      }
      setWorkflowNodeSearch(target.id);
      const sel: StudioSelection = {
        kind: "node",
        id: target.id,
        workflowId: target.workflowId,
      };
      selectItem(sel, "workflows");
      onFocusObject?.(sel, "workflows");
    }
  };

  const handleOpenDiff = (e: React.MouseEvent, rev: RevisionSummary) => {
    e.stopPropagation();
    const fromRev = rev.parentRevision ?? Math.max(0, rev.revision - 1);
    const toRev = rev.revision;
    setDiffComparison({ fromRev, toRev });
    if (compact) {
      setActiveNav("history");
    }
    onViewDiff?.(fromRev, toRev);
  };

  const handleUndoClick = (e: React.MouseEvent, rev: RevisionSummary) => {
    e.stopPropagation();
    if (isViewer || isMutating) return;
    const hasLaterRevisions = revisions.some((r) => r.revision > rev.revision);
    if (hasLaterRevisions) {
      setPendingUndoRev(rev);
    } else {
      void undoHistoricalRevision(rev.revision, "inverse");
    }
  };

  return (
    <div className="space-y-3">
      <SameObjectConflictCard />

      {pendingUndoRev && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Confirm undo revision r${pendingUndoRev.revision}`}
          data-testid="ledger-undo-confirm-modal"
          className="p-3.5 rounded-lg bg-surface-raised border border-amber-500/60 space-y-2.5 text-xs"
        >
          <div className="font-bold text-amber-300">⚠ Confirm Undo of Revision r{pendingUndoRev.revision}</div>
          <p className="text-text-secondary">
            Later revisions exist after <span className="font-mono font-semibold">r{pendingUndoRev.revision}</span> ({pendingUndoRev.summary ?? "revision"}).
            Choose whether to apply the inverse operations of <span className="font-mono">r{pendingUndoRev.revision}</span> or revert the entire project back to{" "}
            <span className="font-mono">r{Math.max(0, pendingUndoRev.parentRevision ?? pendingUndoRev.revision - 1)}</span>:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="ledger-undo-confirm-button"
              disabled={isViewer || isMutating}
              onClick={async () => {
                const target = pendingUndoRev.revision;
                setPendingUndoRev(null);
                await undoHistoricalRevision(target, "inverse");
              }}
              className="px-2.5 py-1 rounded bg-accent text-slate-950 font-bold text-[11px]"
            >
              Undo r{pendingUndoRev.revision} changes
            </button>
            <button
              type="button"
              data-testid="ledger-revert-to-parent-button"
              disabled={isViewer || isMutating}
              onClick={async () => {
                const target = pendingUndoRev.revision;
                setPendingUndoRev(null);
                await undoHistoricalRevision(target, "revert-to-parent");
              }}
              className="px-2.5 py-1 rounded bg-amber-500/20 border border-amber-500/50 text-amber-200 font-semibold text-[11px]"
            >
              Revert project to r{Math.max(0, pendingUndoRev.parentRevision ?? pendingUndoRev.revision - 1)}
            </button>
            <button
              type="button"
              data-testid="ledger-undo-cancel-button"
              onClick={() => setPendingUndoRev(null)}
              className="px-2 py-1 rounded bg-surface-control border border-border text-text-muted text-[11px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <AuthorFilterPills
        revisions={revisions}
        activeFilter={ledgerAuthorFilter}
        onSelectFilter={setLedgerAuthorFilter}
        testIdPrefix={compact ? "dock-ledger-filter" : "ledger-filter"}
      />

      {filteredRevisions.length === 0 ? (
        <div data-testid="ledger-empty-state" className="p-4 rounded bg-surface-base border border-border text-text-muted text-xs text-center">
          No revisions match the selected author filter.
        </div>
      ) : (
        <div className="space-y-2">
          {filteredRevisions.map((rev) => {
            const authorInfo = formatAuthorBadge(rev.author);
            const targets = extractAffectedTargets(rev);
            const relTime = formatRelativeTimestamp(rev.createdAt);

            return (
              <div
                key={rev.revision}
                data-testid={`ledger-entry-${rev.revision}`}
                onClick={() => selectItem({ kind: "revision", id: String(rev.revision) })}
                className="p-3 rounded-lg bg-surface-base border border-border hover:border-border-strong cursor-pointer text-xs space-y-2 transition"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span
                      data-testid={`ledger-rev-badge-${rev.revision}`}
                      className="px-1.5 py-0.5 rounded bg-surface-control border border-border font-mono font-bold text-[11px] text-accent"
                    >
                      r{rev.revision}
                    </span>
                    <span
                      data-testid={`ledger-author-badge-${rev.revision}`}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono ${
                        authorInfo.isAgent
                          ? "bg-sky-400/15 text-sky-300 border border-sky-400/30"
                          : "bg-surface-control text-text-secondary border border-border"
                      }`}
                    >
                      {authorInfo.badgeText}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <time dateTime={rev.createdAt} title={rev.createdAt} className="text-[10px] font-mono text-text-muted">
                      {relTime} · {rev.createdAt.slice(0, 19).replace("T", " ")}
                    </time>
                    <button
                      type="button"
                      data-testid={`view-diff-rev-${rev.revision}`}
                      onClick={(e) => handleOpenDiff(e, rev)}
                      className="px-2 py-0.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[11px] font-semibold text-accent"
                    >
                      View diff
                    </button>
                    <button
                      type="button"
                      data-testid={`ledger-undo-rev-${rev.revision}`}
                      disabled={isViewer || isMutating}
                      onClick={(e) => handleUndoClick(e, rev)}
                      title={`Undo revision r${rev.revision}`}
                      className="px-2 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-[11px] font-semibold text-amber-200 disabled:opacity-40"
                    >
                      ↶ Undo
                    </button>
                  </div>
                </div>

                <div className="text-text-primary font-medium">{rev.summary ?? "Blueprint revision"}</div>

                {targets.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    {targets.map((target) => {
                      const chipIcon = target.kind === "brick" ? "▣" : target.kind === "entity" ? "▤" : target.kind === "workflow" ? "⑂" : "⚡";
                      return (
                        <button
                          key={`${target.kind}:${target.workflowId ?? ""}:${target.id}`}
                          type="button"
                          data-testid={`ledger-target-${target.kind}-${target.id}`}
                          onClick={(e) => handleTargetClick(e, target)}
                          className="px-2 py-0.5 rounded bg-surface-raised hover:bg-surface-control border border-border hover:border-amber-500/40 font-mono text-[10px] text-text-secondary hover:text-text-primary transition"
                        >
                          {chipIcon} {target.kind}:{target.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function HistoryAndLedgerView({ onFocusObject, onViewDiff, initialDiff }: ChangeLedgerProps = {}) {
  const activeProjectId = useStudioStore((s) => s.activeProjectId);
  const projectState = useStudioStore((s) => s.projectState);
  const revisions = useStudioStore((s) => s.revisions);
  const setRevisions = useStudioStore((s) => s.setRevisions);
  const diffComparison = useStudioStore((s) => s.diffComparison);
  const setDiffComparison = useStudioStore((s) => s.setDiffComparison);
  const startCanvasVisualDiff = useStudioStore((s) => s.startCanvasVisualDiff);

  const proposals = useStudioStore((s) => s.proposals);
  const loadProjectProposals = useStudioStore((s) => s.loadProjectProposals);
  const startProposalReview = useStudioStore((s) => s.startProposalReview);
  const activeProposalId = useStudioStore((s) => s.activeProposalId);

  const activityEvents = useStudioStore((s) => s.activityFeed) ?? [];
  const activityAuthorFilter = useStudioStore((s) => s.activityAuthorFilter);
  const activityTypeFilter = useStudioStore((s) => s.activityTypeFilter);
  const activityWindowFilter = useStudioStore((s) => s.activityWindowFilter);
  const loadProjectActivity = useStudioStore((s) => s.loadProjectActivity);
  const setActivityAuthorFilter = useStudioStore((s) => s.setActivityAuthorFilter);
  const setActivityTypeFilter = useStudioStore((s) => s.setActivityTypeFilter);
  const setActivityWindowFilter = useStudioStore((s) => s.setActivityWindowFilter);

  const projectSlug = activeProjectId ?? projectState?.project ?? "my-saas-app";
  const activeRole = useStudioStore(getActiveRole);
  const isViewer = activeRole === "viewer";

  const [fromSelect, setFromSelect] = useState<number>(0);
  const [toSelect, setToSelect] = useState<number>(revisions[0]?.revision ?? 1);

  const [auditLogs, setAuditLogs] = useState<StudioAuditLogEntry[]>([]);
  const [auditActionFilter, setAuditActionFilter] = useState<string>("all");
  const [retentionSettings, setRetentionSettings] = useState<ProjectRetentionSettingsPayload>({
    projectId: projectSlug,
    orgId: "org_default",
    runRetentionDays: 14,
    telemetryRetentionDays: 7,
    captureStepIoInProd: true,
    additionalRedactKeys: [],
    updatedAt: new Date(0).toISOString(),
    updatedBy: null,
  });
  const [redactKeysText, setRedactKeysText] = useState<string>("");
  const [retentionSaving, setRetentionSaving] = useState<boolean>(false);
  const [retentionSaveMessage, setRetentionSaveMessage] = useState<string | null>(null);

  // Fetch revisions on mount if empty and an activeProjectId is set
  useEffect(() => {
    if (!activeProjectId || revisions.length > 0) return;
    let cancelled = false;
    fetchProjectRevisions(activeProjectId).then((loaded) => {
      if (!cancelled && loaded.length > 0) {
        setRevisions(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, revisions.length, setRevisions]);

  // Fetch proposals and unified activity feed on mount and when project changes
  useEffect(() => {
    if (!projectSlug) return;
    void loadProjectProposals();
    void loadProjectActivity();
    let cancelled = false;
    void fetchProjectAuditLogs(projectSlug).then((entries) => {
      if (!cancelled) {
        setAuditLogs(entries);
      }
    });
    void fetchProjectRetentionSettings(projectSlug).then((loaded) => {
      if (!cancelled) {
        setRetentionSettings(loaded);
        setRedactKeysText(loaded.additionalRedactKeys.join(", "));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectSlug, revisions.length, loadProjectProposals, loadProjectActivity]);

  const handleSaveRetentionSettings = async () => {
    if (isViewer || retentionSaving) return;
    setRetentionSaving(true);
    setRetentionSaveMessage(null);
    try {
      const additionalRedactKeys = redactKeysText
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      const updated = await updateProjectRetentionSettings(projectSlug, {
        runRetentionDays: retentionSettings.runRetentionDays,
        telemetryRetentionDays: retentionSettings.telemetryRetentionDays,
        captureStepIoInProd: retentionSettings.captureStepIoInProd,
        additionalRedactKeys,
      });
      setRetentionSettings(updated);
      setRedactKeysText(updated.additionalRedactKeys.join(", "));
      setRetentionSaveMessage("Retention & redaction settings saved.");
      const refreshedLogs = await fetchProjectAuditLogs(projectSlug);
      setAuditLogs(refreshedLogs);
    } catch (err) {
      setRetentionSaveMessage(err instanceof Error ? err.message : "Failed to save retention settings");
    } finally {
      setRetentionSaving(false);
    }
  };

  const filteredAuditLogs = useMemo(() => {
    if (auditActionFilter === "all") return auditLogs;
    return auditLogs.filter((entry) => entry.action.toLowerCase().startsWith(auditActionFilter.toLowerCase()));
  }, [auditLogs, auditActionFilter]);

  const distinctActivityAgentFilters = useMemo(() => {
    const map = new Map<string, string>();
    for (const ev of activityEvents) {
      if (ev.actor.type === "agent") {
        const clientOrId = ev.actor.client || ev.actor.id;
        if (clientOrId && !map.has(clientOrId)) {
          map.set(clientOrId, ev.actor.client ? `🤖 ${ev.actor.client}` : `🤖 ${ev.actor.displayId}`);
        }
      }
    }
    for (const p of proposals) {
      if (p.actor.type === "agent") {
        const clientOrId = p.actor.client || p.actor.id;
        if (clientOrId && !map.has(clientOrId)) {
          map.set(clientOrId, p.actor.client ? `🤖 ${p.actor.client}` : `🤖 agent:${p.actor.id}`);
        }
      }
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }));
  }, [activityEvents, proposals]);

  useEffect(() => {
    if (revisions.length > 0) {
      const latest = Math.max(...revisions.map((r) => r.revision));
      setToSelect(latest);
      setFromSelect(Math.max(0, latest - 1));
    }
  }, [revisions]);

  const revisionNumbers = useMemo(() => {
    const nums = new Set<number>([0]);
    for (const r of revisions) {
      nums.add(r.revision);
      if (r.parentRevision !== null && r.parentRevision !== undefined) {
        nums.add(r.parentRevision);
      }
    }
    return [...nums].sort((a, b) => a - b);
  }, [revisions]);

  return (
    <div data-testid="view-history" className="space-y-6">
      {/* Header & Compare Revisions bar */}
      <section className="p-4 rounded-lg bg-surface-raised border border-border flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-text-primary">Revision History & AI Change Ledger</h2>
          <p className="text-xs text-text-secondary">
            Chronological revision log with human vs AI agent attribution, click-to-focus objects, and semantic diffing
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <label htmlFor="diff-from-select" className="text-text-muted font-mono">
            From:
          </label>
          <select
            id="diff-from-select"
            data-testid="diff-from-select"
            value={fromSelect}
            onChange={(e) => setFromSelect(Number(e.target.value))}
            className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
          >
            {revisionNumbers.map((num) => (
              <option key={`from-${num}`} value={num}>
                r{num}
              </option>
            ))}
          </select>

          <label htmlFor="diff-to-select" className="text-text-muted font-mono">
            To:
          </label>
          <select
            id="diff-to-select"
            data-testid="diff-to-select"
            value={toSelect}
            onChange={(e) => setToSelect(Number(e.target.value))}
            className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
          >
            {revisionNumbers.map((num) => (
              <option key={`to-${num}`} value={num}>
                r{num}
              </option>
            ))}
          </select>

          <button
            type="button"
            data-testid="diff-compare-button"
            onClick={() => {
              setDiffComparison({ fromRev: fromSelect, toRev: toSelect });
              onViewDiff?.(fromSelect, toSelect);
            }}
            className="px-3 py-1 rounded bg-accent text-text-on-accent font-bold text-xs"
          >
            Compare revisions
          </button>

          <button
            type="button"
            data-testid="compare-on-canvas-button"
            onClick={() => void startCanvasVisualDiff(fromSelect, toSelect)}
            className="px-3 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-200 font-bold text-xs"
          >
            ⇄ Compare on Canvas
          </button>
        </div>
      </section>

      {/* Active Semantic Diff Viewer */}
      {diffComparison && (
        <SemanticDiffPanel
          project={projectSlug}
          fromRev={diffComparison.fromRev}
          toRev={diffComparison.toRev}
          revisions={revisions}
          overrideDiff={initialDiff}
          onClose={() => setDiffComparison(null)}
        />
      )}

      {/* Draft Proposals Queue (Story 7.2) */}
      <section data-testid="history-proposals-section" className="p-4 rounded-lg bg-surface-raised border border-border space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted">Draft Proposals ({proposals.length})</h3>
            <p className="text-[11px] text-text-secondary">Agent and human draft branches awaiting or having completed Visual Diff Review</p>
          </div>
        </div>

        {proposals.length === 0 ? (
          <div data-testid="proposals-empty-state" className="p-3 rounded bg-surface-base border border-border text-text-muted text-xs text-center">
            No draft proposals recorded for this project.
          </div>
        ) : (
          <div className="space-y-2">
            {proposals.map((prop) => {
              const isAgent = prop.actor.type === "agent";
              const actorBadge = isAgent ? `🤖 agent:${prop.actor.id}${prop.actor.client ? ` (${prop.actor.client})` : ""}` : `👤 user:${prop.actor.id}`;
              const statusStyle =
                prop.status === "pending"
                  ? "bg-amber-500/20 text-amber-200 border-amber-500/40"
                  : prop.status === "accepted"
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                    : prop.status === "partially_accepted"
                      ? "bg-sky-500/20 text-sky-200 border-sky-500/40"
                      : "bg-rose-500/20 text-rose-300 border-rose-500/40";

              return (
                <div
                  key={prop.proposalId}
                  data-testid={`proposal-entry-${prop.proposalId}`}
                  className="p-3 rounded-lg bg-surface-base border border-border flex items-center justify-between gap-3 flex-wrap text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        data-testid={`proposal-status-badge-${prop.proposalId}`}
                        className={`px-2 py-0.5 rounded border font-mono font-bold text-[10px] uppercase ${statusStyle}`}
                      >
                        {prop.status.replace("_", " ")}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-surface-control border border-border font-mono text-[11px] text-text-secondary">
                        base r{prop.baseRev}
                      </span>
                      {prop.acceptedRev !== null && prop.acceptedRev !== undefined && (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 font-mono text-[11px] text-emerald-300">
                          → r{prop.acceptedRev}
                        </span>
                      )}
                      <span
                        data-testid={`proposal-actor-badge-${prop.proposalId}`}
                        className={`px-2 py-0.5 rounded text-[11px] font-mono ${
                          isAgent ? "bg-sky-400/15 text-sky-300 border border-sky-400/30" : "bg-surface-control text-text-secondary border border-border"
                        }`}
                      >
                        {actorBadge}
                      </span>
                      <span className="text-[11px] font-mono text-text-muted">
                        {prop.ops.length} op{prop.ops.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="font-medium text-text-primary">{prop.summary}</div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid={`review-proposal-${prop.proposalId}`}
                      onClick={() => startProposalReview(prop.proposalId)}
                      className={`px-2.5 py-1 rounded font-bold text-xs border transition ${
                        activeProposalId === prop.proposalId
                          ? "bg-amber-500 text-slate-950 border-amber-400"
                          : "bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border-amber-500/50"
                      }`}
                    >
                      {prop.status === "pending" ? "⇄ Review Visual Diff" : "View Proposal Diff"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Unified Activity Feed (R44 / Story 7.2 AC 4 & AC 5) */}
      <section data-testid="unified-activity-feed" className="p-4 rounded-lg bg-surface-raised border border-border space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted">Unified Activity Feed ({activityEvents.length})</h3>
            <p className="text-[11px] text-text-secondary">
              Revisions, proposals, builds, deployments, connection changes, and workflow runs with exact actor attribution
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap text-xs">
            <label htmlFor="activity-type-filter" className="text-text-muted font-mono text-[11px]">
              Type:
            </label>
            <select
              id="activity-type-filter"
              data-testid="activity-type-filter"
              value={activityTypeFilter}
              onChange={(e) => setActivityTypeFilter(e.target.value)}
              className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
            >
              <option value="all">All events</option>
              <option value="revision">Revisions</option>
              <option value="proposal">Proposals</option>
              <option value="build">Builds</option>
              <option value="deploy">Deployments</option>
              <option value="connection">Connections</option>
              <option value="run">Workflow Runs</option>
            </select>

            <label htmlFor="activity-window-filter" className="text-text-muted font-mono text-[11px]">
              Window:
            </label>
            <select
              id="activity-window-filter"
              data-testid="activity-window-filter"
              value={activityWindowFilter}
              onChange={(e) => setActivityWindowFilter(e.target.value)}
              className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
            >
              <option value="all">All time</option>
              <option value="1h">Last 1h</option>
              <option value="24h">Last 24h</option>
              <option value="7d">Last 7d</option>
              <option value="30d">Last 30d</option>
            </select>
          </div>
        </div>

        {/* Author filter pills for Unified Activity Feed */}
        <div data-testid="activity-author-filters" className="flex items-center gap-1.5 flex-wrap text-[11px]">
          <span className="text-text-muted font-mono mr-1">Author:</span>
          {[
            { value: "all", label: "All" },
            { value: "humans", label: "👤 Humans only" },
            { value: "agents", label: "🤖 Agents only" },
            ...distinctActivityAgentFilters,
          ].map((pill) => {
            const active = activityAuthorFilter === pill.value;
            return (
              <button
                key={pill.value}
                type="button"
                data-testid={`activity-author-filter-${pill.value}`}
                onClick={() => setActivityAuthorFilter(pill.value)}
                className={`px-2 py-0.5 rounded font-mono transition ${
                  active ? "bg-accent text-slate-950 font-bold" : "bg-surface-control text-text-secondary hover:text-text-primary border border-border"
                }`}
              >
                {pill.label}
              </button>
            );
          })}
        </div>

        {activityEvents.length === 0 ? (
          <div data-testid="activity-empty-state" className="p-3 rounded bg-surface-base border border-border text-text-muted text-xs text-center">
            No activity events match the active filters.
          </div>
        ) : (
          <div className="space-y-2">
            {activityEvents.map((ev) => {
              const isAgent = ev.actor.type === "agent";
              const typeBadgeColor =
                ev.type === "proposal"
                  ? "bg-amber-500/20 text-amber-200 border-amber-500/40"
                  : ev.type === "revision"
                    ? "bg-accent/20 text-accent border-accent/40"
                    : ev.type === "deploy"
                      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                      : ev.type === "build"
                        ? "bg-purple-500/20 text-purple-300 border-purple-500/40"
                        : ev.type === "connection"
                          ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40"
                          : "bg-sky-500/20 text-sky-300 border-sky-500/40";

              return (
                <div
                  key={ev.id}
                  data-testid={`activity-event-${ev.id}`}
                  data-event-type={ev.type}
                  data-actor-type={ev.actor.type}
                  data-actor-id={ev.actor.displayId}
                  className="p-2.5 rounded-lg bg-surface-base border border-border flex items-center justify-between gap-3 flex-wrap text-xs"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded border font-mono font-bold text-[10px] uppercase ${typeBadgeColor}`}>
                      {ev.type}:{ev.action}
                    </span>
                    <span
                      data-testid={`activity-actor-${ev.id}`}
                      className={`px-2 py-0.5 rounded font-mono text-[11px] ${
                        isAgent ? "bg-sky-400/15 text-sky-300 border border-sky-400/30" : "bg-surface-control text-text-secondary border border-border"
                      }`}
                    >
                      {isAgent ? "🤖 " : "👤 "}
                      {ev.actor.displayId}
                      {ev.actor.client ? ` (${ev.actor.client})` : ""}
                    </span>
                    <span className="text-text-primary font-medium">{ev.summary}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <time dateTime={ev.timestamp} className="text-[10px] font-mono text-text-muted">
                      {ev.timestamp.slice(0, 19).replace("T", " ")}
                    </time>
                    {ev.type === "proposal" && typeof ev.proposalId === "string" && (
                      <button
                        type="button"
                        data-testid={`activity-review-proposal-${ev.proposalId}`}
                        onClick={() => startProposalReview(String(ev.proposalId))}
                        className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 font-semibold text-[11px]"
                      >
                        Review
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Chronological Revision Stream */}
      <section className="p-4 rounded-lg bg-surface-raised border border-border space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted">Chronological Revisions ({revisions.length})</h3>
        </div>

        <ChangeLedgerFeed compact={false} onFocusObject={onFocusObject} onViewDiff={onViewDiff} />
      </section>

      {/* Retention & Privacy Settings Panel (Story 8.2 AC 3) */}
      <section data-testid="retention-settings-panel" className="p-4 rounded-lg bg-surface-raised border border-border space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted">Retention &amp; Privacy Settings</h3>
            <p className="text-[11px] text-text-secondary">
              Configurable D1 run retention, telemetry &amp; structured log retention, production step I/O privacy, and custom redaction keys
            </p>
          </div>
          {retentionSaveMessage && (
            <span
              data-testid="retention-save-status"
              className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 font-mono text-[11px] text-emerald-300"
            >
              {retentionSaveMessage}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="p-3 rounded bg-surface-base border border-border space-y-1.5">
            <label htmlFor="retention-run-days-input" className="block font-semibold text-text-primary">
              Run History Retention (1–90 days, default 14d): <span className="font-mono text-accent">{retentionSettings.runRetentionDays}d</span>
            </label>
            <input
              id="retention-run-days-input"
              data-testid="retention-run-days-input"
              type="number"
              min={1}
              max={90}
              disabled={isViewer || retentionSaving}
              value={retentionSettings.runRetentionDays}
              onChange={(e) => {
                const val = Math.max(1, Math.min(90, Math.round(Number(e.target.value) || 14)));
                setRetentionSettings((prev) => ({
                  ...prev,
                  runRetentionDays: val,
                }));
              }}
              className="w-full px-2.5 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
            />
          </div>

          <div className="p-3 rounded bg-surface-base border border-border space-y-1.5">
            <label htmlFor="retention-telemetry-days-input" className="block font-semibold text-text-primary">
              Telemetry &amp; Structured Log Retention (1–30 days, default 7d):{" "}
              <span className="font-mono text-accent">{retentionSettings.telemetryRetentionDays}d</span>
            </label>
            <input
              id="retention-telemetry-days-input"
              data-testid="retention-telemetry-days-input"
              type="number"
              min={1}
              max={30}
              disabled={isViewer || retentionSaving}
              value={retentionSettings.telemetryRetentionDays}
              onChange={(e) => {
                const val = Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 7)));
                setRetentionSettings((prev) => ({
                  ...prev,
                  telemetryRetentionDays: val,
                }));
              }}
              className="w-full px-2.5 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
            />
          </div>

          <div className="p-3 rounded bg-surface-base border border-border flex items-center justify-between gap-3">
            <div>
              <label htmlFor="retention-capture-step-io-toggle" className="font-semibold text-text-primary block">
                Capture Step I/O in Production
              </label>
              <div className="text-[11px] text-text-secondary">
                When disabled, production step events store status, duration, and error class while omitting step input/output payloads
              </div>
            </div>
            <input
              id="retention-capture-step-io-toggle"
              aria-label="Capture Step I/O in Production"
              data-testid="retention-capture-step-io-toggle"
              type="checkbox"
              disabled={isViewer || retentionSaving}
              checked={retentionSettings.captureStepIoInProd}
              onChange={(e) =>
                setRetentionSettings((prev) => ({
                  ...prev,
                  captureStepIoInProd: e.target.checked,
                }))
              }
              className="h-4 w-4 accent-amber-400"
            />
          </div>

          <div className="p-3 rounded bg-surface-base border border-border space-y-1.5">
            <label htmlFor="retention-redact-keys-input" className="block font-semibold text-text-primary">
              Custom Redaction Keys (comma-separated)
            </label>
            <input
              id="retention-redact-keys-input"
              data-testid="retention-redact-keys-input"
              type="text"
              disabled={isViewer || retentionSaving}
              placeholder="e.g. ssn, customer_pin, internal_token"
              value={redactKeysText}
              onChange={(e) => setRedactKeysText(e.target.value)}
              className="w-full px-2.5 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
            />
          </div>
        </div>

        <div className="flex items-center justify-end">
          <button
            type="button"
            data-testid="retention-settings-save-button"
            disabled={isViewer || retentionSaving}
            onClick={() => void handleSaveRetentionSettings()}
            className="px-3 py-1.5 rounded bg-accent text-text-on-accent font-bold text-xs disabled:opacity-40"
          >
            {retentionSaving ? "Saving…" : "Save Retention Settings"}
          </button>
        </div>
      </section>

      {/* Immutable Audit Log Panel (Story 8.2 AC 2) */}
      <section data-testid="studio-audit-log-panel" className="p-4 rounded-lg bg-surface-raised border border-border space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted">Immutable Audit Log ({filteredAuditLogs.length})</h3>
            <p className="text-[11px] text-text-secondary">Append-only privileged control-plane ledger enforced by SQLite immutability triggers</p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <label htmlFor="audit-action-filter" className="text-text-muted font-mono text-[11px]">
              Category:
            </label>
            <select
              id="audit-action-filter"
              data-testid="audit-action-filter"
              value={auditActionFilter}
              onChange={(e) => setAuditActionFilter(e.target.value)}
              className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
            >
              <option value="all">All privileged actions</option>
              <option value="project.ops">Blueprint ops</option>
              <option value="proposal.">Proposals</option>
              <option value="environment.">Deploy / Promote / Rollback</option>
              <option value="cloudflare_token.">Cloudflare BYOC tokens</option>
              <option value="connection.">Connections</option>
              <option value="org.mcp_token.">MCP tokens</option>
              <option value="data_browser.">Data Browser mutations</option>
              <option value="project.retention_settings.">Retention settings</option>
            </select>
          </div>
        </div>

        {filteredAuditLogs.length === 0 ? (
          <div data-testid="audit-log-empty-state" className="p-3 rounded bg-surface-base border border-border text-text-muted text-xs text-center">
            No immutable audit log entries recorded yet for this filter.
          </div>
        ) : (
          <div className="space-y-1.5">
            {filteredAuditLogs.map((entry) => {
              const isAgent = entry.actor.startsWith("agent:");
              return (
                <div
                  key={entry.id}
                  data-testid={`audit-log-entry-${entry.id}`}
                  className="p-2.5 rounded bg-surface-base border border-border flex items-center justify-between gap-3 flex-wrap text-xs"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      data-testid={`audit-log-action-${entry.id}`}
                      className="px-1.5 py-0.5 rounded bg-surface-control border border-border font-mono font-bold text-[10px] text-amber-300"
                    >
                      {entry.action}
                    </span>
                    <span
                      data-testid={`audit-log-actor-${entry.id}`}
                      className={`px-2 py-0.5 rounded font-mono text-[11px] ${
                        isAgent ? "bg-sky-400/15 text-sky-300 border border-sky-400/30" : "bg-surface-control text-text-secondary border border-border"
                      }`}
                    >
                      {isAgent ? "🤖 " : "👤 "}
                      {entry.actor}
                    </span>
                    {entry.targetRef && (
                      <span data-testid={`audit-log-target-${entry.id}`} className="font-mono text-[11px] text-text-primary">
                        target: {entry.targetRef}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 font-mono text-[10px] text-text-muted">
                    <span title={`Hashed IP: ${entry.ipHash}`}>ip:{entry.ipHash}</span>
                    <time dateTime={entry.ts}>{entry.ts.slice(0, 19).replace("T", " ")}</time>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
