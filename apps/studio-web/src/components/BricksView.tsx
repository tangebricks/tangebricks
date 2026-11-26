import { useMemo, useState } from "react";
import { getActiveRole, useStudioStore } from "../store.ts";
import {
  DEFAULT_INTEGRATIONS,
  computeBrickDisableImpact,
  computeBrickEnablePreview,
  computeStudioValidationIssues,
  formatMaturityBadge,
  hasSchedulingOrQueueTriggers,
} from "../types.ts";
import type {
  BrickCategory,
  CatalogBrickManifest,
  CatalogIntegrationManifest,
} from "../types.ts";
import { AuthorBadge, MaturityBadge } from "./Badges.tsx";

const CATEGORIES: Array<{ value: "all" | BrickCategory; label: string }> = [
  { value: "all", label: "All Categories" },
  { value: "identity", label: "Identity" },
  { value: "billing", label: "Billing" },
  { value: "data", label: "Data" },
  { value: "automation", label: "Automation" },
  { value: "communication", label: "Communication" },
  { value: "ai", label: "AI" },
  { value: "developer", label: "Developer" },
  { value: "governance", label: "Governance" },
];

export function BricksView() {
  const projectState = useStudioStore((s) => s.projectState);
  const readiness = useStudioStore((s) => s.readiness);
  const secrets = useStudioStore((s) => s.secrets);
  const catalog = useStudioStore((s) => s.catalog);
  const integrations = useStudioStore((s) => s.integrations ?? DEFAULT_INTEGRATIONS);
  const selection = useStudioStore((s) => s.selection);
  const highlightedTargets = useStudioStore((s) => s.highlightedTargets);
  const showExperimental = useStudioStore((s) => s.bricksShowExperimental);
  const categoryFilter = useStudioStore((s) => s.bricksCategoryFilter);
  const searchQuery = useStudioStore((s) => s.bricksSearchQuery);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const isMutating = useStudioStore((s) => s.isMutating);
  const mutationError = useStudioStore((s) => s.mutationError);
  const canvasVisualDiff = useStudioStore((s) => s.canvasVisualDiff);

  const setShowExperimental = useStudioStore((s) => s.setBricksShowExperimental);
  const setCategoryFilter = useStudioStore((s) => s.setBricksCategoryFilter);
  const setSearchQuery = useStudioStore((s) => s.setBricksSearchQuery);
  const selectItem = useStudioStore((s) => s.selectItem);
  const setMutationError = useStudioStore((s) => s.setMutationError);
  const commitOps = useStudioStore((s) => s.commitOps);

  const activeRole = getActiveRole({ orgs, activeOrgId });
  const isViewer = activeRole === "viewer";

  const [enableModalBrickId, setEnableModalBrickId] = useState<string | null>(null);
  const [experimentalConfirmed, setExperimentalConfirmed] = useState(false);
  const [disableModalBrickId, setDisableModalBrickId] = useState<string | null>(null);

  const enabledBricks = useMemo(() => {
    if (!canvasVisualDiff) {
      return projectState?.bricks ?? [];
    }
    const toBricks = canvasVisualDiff.toState.bricks ?? [];
    const toIds = new Set(toBricks.map((b) => b.id));
    const removedBricks = (canvasVisualDiff.fromState.bricks ?? []).filter(
      (b) => !toIds.has(b.id),
    );
    return [...toBricks, ...removedBricks];
  }, [canvasVisualDiff, projectState?.bricks]);
  const enabledIds = useMemo(() => new Set(enabledBricks.map((b) => b.id)), [enabledBricks]);
  const brickDiffMap = useMemo(() => {
    const map = new Map<string, "added" | "changed" | "removed">();
    if (!canvasVisualDiff) return map;
    for (const b of canvasVisualDiff.diff.bricks.added) {
      map.set(b.id, "added");
    }
    for (const b of canvasVisualDiff.diff.bricks.updated) {
      map.set(b.id, "changed");
    }
    for (const b of canvasVisualDiff.diff.bricks.removed) {
      map.set(b.id, "removed");
    }
    return map;
  }, [canvasVisualDiff]);
  const validationIssues = useMemo(
    () =>
      computeStudioValidationIssues(projectState, catalog, secrets, readiness),
    [projectState, catalog, secrets, readiness],
  );

  const enablePreview = useMemo(() => {
    if (!enableModalBrickId) return null;
    return computeBrickEnablePreview(enableModalBrickId, projectState, catalog);
  }, [enableModalBrickId, projectState, catalog]);

  const disableImpact = useMemo(() => {
    if (!disableModalBrickId) return null;
    return computeBrickDisableImpact(disableModalBrickId, projectState, catalog);
  }, [disableModalBrickId, projectState, catalog]);

  const openEnableModal = (brickId: string) => {
    setMutationError(null);
    setExperimentalConfirmed(false);
    setEnableModalBrickId(brickId);
  };

  const openDisableModal = (brickId: string) => {
    setMutationError(null);
    setDisableModalBrickId(brickId);
  };

  const handleConfirmEnable = async () => {
    if (!enablePreview || enablePreview.conflicts.length > 0) return;
    if (enablePreview.isExperimental && !experimentalConfirmed) return;

    const stamp = Date.now();
    const ops: Array<Record<string, unknown>> = [];

    for (const provider of enablePreview.missingProviders) {
      ops.push({
        opId: `enable-${provider.brickId}-${stamp}`,
        type: "enable_brick",
        brickId: provider.brickId,
        config: {},
      });
    }

    ops.push({
      opId: `enable-${enablePreview.brickId}-${stamp}`,
      type: "enable_brick",
      brickId: enablePreview.brickId,
      config: {},
    });

    if (
      enablePreview.manifest.provides.includes("user-identity") &&
      enablePreview.manifest.worker?.guard?.capability === "user-identity" &&
      (projectState?.identity ?? "stub") === "stub"
    ) {
      ops.push({
        opId: `set-identity-${enablePreview.brickId}-${stamp}`,
        type: "set_identity",
        identity: enablePreview.brickId,
      });
    }

    const res = await commitOps(
      ops,
      enablePreview.missingProviders.length > 0
        ? `Enable ${enablePreview.brickId} (+ ${enablePreview.missingProviders.map((p) => p.brickId).join(", ")})`
        : `Enable ${enablePreview.brickId}`,
    );
    if (res.ok) {
      const enabledId = enablePreview.brickId;
      setEnableModalBrickId(null);
      setExperimentalConfirmed(false);
      selectItem({ kind: "brick", id: enabledId });
    }
  };

  const handleConfirmDisable = async () => {
    if (!disableImpact) return;

    const stamp = Date.now();
    const ops: Array<Record<string, unknown>> = [];

    if (projectState?.identity === disableImpact.brickId) {
      ops.push({
        opId: `reset-identity-${stamp}`,
        type: "set_identity",
        identity: "stub",
      });
    }

    for (const dep of disableImpact.dependentBricks) {
      ops.push({
        opId: `remove-dep-${dep.brickId}-${stamp}`,
        type: "remove_brick",
        brickId: dep.brickId,
      });
    }

    ops.push({
      opId: `remove-${disableImpact.brickId}-${stamp}`,
      type: "remove_brick",
      brickId: disableImpact.brickId,
    });

    const res = await commitOps(ops, `Disable ${disableImpact.brickId}`);
    if (res.ok) {
      setDisableModalBrickId(null);
    }
  };

  const matchesSearchAndCategory = (manifest: CatalogBrickManifest): boolean => {
    const category = manifest.ui?.category ?? "developer";
    if (categoryFilter !== "all" && category !== categoryFilter) {
      return false;
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const displayName = (manifest.ui?.displayName ?? manifest.id).toLowerCase();
    const summary = (manifest.ui?.summary ?? "").toLowerCase();
    return (
      manifest.id.toLowerCase().includes(q) ||
      displayName.includes(q) ||
      summary.includes(q) ||
      category.toLowerCase().includes(q)
    );
  };

  // Enabled in Project: always shown regardless of experimental tier (AC 1)
  const enabledManifests = useMemo(() => {
    return enabledBricks
      .map((entry) => catalog[entry.id])
      .filter((m): m is CatalogBrickManifest => Boolean(m))
      .filter(matchesSearchAndCategory);
  }, [enabledBricks, catalog, categoryFilter, searchQuery]);

  // Brick Catalog: hides experimental bricks unless showExperimental is true (AD-S8, AC 1)
  const catalogManifests = useMemo(() => {
    return Object.values(catalog)
      .filter((manifest) => {
        const tier = manifest.ui?.derivedTier ?? manifest.ui?.maturity ?? "experimental";
        if (!showExperimental && tier === "experimental") {
          return false;
        }
        return matchesSearchAndCategory(manifest);
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [catalog, showExperimental, categoryFilter, searchQuery]);

  // Curated Integrations: hides experimental integrations unless showExperimental is true
  const integrationList = useMemo(() => {
    return Object.values(integrations)
      .map((entry) => entry.manifest)
      .filter((manifest) => {
        const tier = manifest.ui?.derivedTier ?? manifest.ui?.maturity ?? "beta";
        if (!showExperimental && tier === "experimental") {
          return false;
        }
        if (categoryFilter !== "all" && manifest.ui?.category !== categoryFilter) {
          return false;
        }
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        const displayName = (manifest.ui?.displayName ?? manifest.ui?.title ?? manifest.app).toLowerCase();
        const summary = (manifest.ui?.summary ?? "").toLowerCase();
        return (
          manifest.app.toLowerCase().includes(q) ||
          displayName.includes(q) ||
          summary.includes(q)
        );
      })
      .sort((a, b) => a.app.localeCompare(b.app));
  }, [integrations, showExperimental, categoryFilter, searchQuery]);

  const renderIntegrationCard = (manifest: CatalogIntegrationManifest) => {
    const displayName = manifest.ui?.displayName ?? manifest.ui?.title ?? manifest.app;
    return (
      <div
        key={`integration:${manifest.app}`}
        data-testid={`integration-card-${manifest.app}`}
        className="p-4 rounded-lg bg-surface-raised border border-border hover:border-border-strong flex flex-col justify-between gap-3 transition"
      >
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-bold text-xs text-text-primary">
                {displayName}
              </div>
              <div className="font-mono text-[11px] text-text-muted mt-0.5">
                {manifest.app}
              </div>
            </div>

            <MaturityBadge
              testId={`integration-maturity-${manifest.app}`}
              tier={manifest.ui?.maturity}
              derivedTier={manifest.ui?.derivedTier}
              blockers={manifest.ui?.blockers}
              evidence={manifest.ui?.evidence}
              reason={manifest.ui?.maturityReason}
              isIntegration={true}
            />
          </div>

          {manifest.ui?.summary && (
            <p className="text-xs text-text-secondary">{manifest.ui.summary}</p>
          )}

          {manifest.ui?.maturityReason && manifest.ui?.derivedTier !== "production" && (
            <div
              data-testid={`integration-reason-${manifest.app}`}
              className="p-2 rounded bg-surface-base border border-border text-[11px] text-amber-200/90"
            >
              ⚠ {manifest.ui.maturityReason}
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-border flex items-center justify-between gap-2 text-[11px]">
          <span className="px-2 py-0.5 rounded bg-surface-control text-text-secondary uppercase tracking-wider text-[10px] font-bold">
            {manifest.ui?.category ?? "communication"}
          </span>
          <span className="text-text-muted">Integration Pack</span>
        </div>
      </div>
    );
  };

  const renderBrickCard = (manifest: CatalogBrickManifest, sectionPrefix: "enabled" | "catalog") => {
    const effectiveTier =
      manifest.ui?.derivedTier ??
      (manifest.ui?.evidence?.gitSha
        ? manifest.ui?.maturity === "production"
          ? "unverified"
          : manifest.ui?.maturity ?? "experimental"
        : manifest.ui?.maturity === "beta"
          ? "beta"
          : manifest.ui?.maturity === "experimental"
            ? "experimental"
            : "unverified");
    const maturity = formatMaturityBadge(effectiveTier);
    const maturityReason = manifest.ui?.maturityReason;
    const needsScheduling = hasSchedulingOrQueueTriggers(manifest, enabledBricks.find((b) => b.id === manifest.id)?.config ?? {});
    const isEnabled = enabledIds.has(manifest.id);
    const isSelected = selection?.kind === "brick" && selection.id === manifest.id;
    const highlight =
      highlightedTargets[`brick:${manifest.id}`] ?? highlightedTargets[manifest.id];
    const diffStatus = brickDiffMap.get(manifest.id) ?? null;
    const brickIssues = isEnabled
      ? validationIssues.filter((iss) => iss.brickId === manifest.id)
      : [];

    return (
      <div
        key={`${sectionPrefix}:${manifest.id}`}
        data-testid={`${sectionPrefix}-brick-card-${manifest.id}`}
        data-highlighted={highlight ? "true" : "false"}
        data-diff-status={diffStatus ?? undefined}
        onClick={() => selectItem({ kind: "brick", id: manifest.id })}
        className={`p-4 rounded-lg bg-surface-raised border cursor-pointer flex flex-col justify-between gap-3 transition ${
          diffStatus === "added"
            ? "border-emerald-500 ring-2 ring-emerald-500/40"
            : diffStatus === "changed"
              ? "border-amber-400 ring-2 ring-amber-400/40"
              : diffStatus === "removed"
                ? "bg-rose-950/30 border-dashed border-rose-500/80 opacity-80"
                : isSelected
                  ? "border-accent ring-2 ring-accent/40"
                  : highlight
                    ? "border-sky-400 ring-2 ring-sky-400/40"
                    : "border-border hover:border-border-strong"
        }`}
      >
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div
                className={`font-bold text-xs ${
                  diffStatus === "removed"
                    ? "line-through text-rose-300"
                    : "text-text-primary"
                }`}
              >
                {manifest.ui?.displayName ?? manifest.id}
              </div>
              <div className="font-mono text-[11px] text-text-muted mt-0.5">
                {manifest.id}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {diffStatus === "added" && (
                <span
                  data-testid={`diff-badge-brick-added-${manifest.id}`}
                  className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 text-[10px] font-bold"
                >
                  + Added
                </span>
              )}
              {diffStatus === "changed" && (
                <span
                  data-testid={`diff-badge-brick-changed-${manifest.id}`}
                  className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-amber-300 text-[10px] font-bold"
                >
                  ~ Modified
                </span>
              )}
              {diffStatus === "removed" && (
                <span
                  data-testid={`diff-badge-brick-removed-${manifest.id}`}
                  className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/50 text-rose-300 text-[10px] font-bold"
                >
                  - Removed
                </span>
              )}
              {highlight && (
                <AuthorBadge
                  testId={`brick-author-badge-${manifest.id}`}
                  authorLabel={highlight.authorLabel}
                  isAgent={highlight.isAgent}
                />
              )}
              <MaturityBadge
                testId={`${sectionPrefix}-brick-maturity-${manifest.id}`}
                tier={manifest.ui?.maturity}
                derivedTier={manifest.ui?.derivedTier}
                blockers={manifest.ui?.blockers}
                evidence={manifest.ui?.evidence}
                reason={maturityReason}
              />
            </div>
          </div>

          {manifest.ui?.summary && (
            <p className="text-xs text-text-secondary">{manifest.ui.summary}</p>
          )}

          {maturityReason && maturity.tier !== "production" && (
            <div
              data-testid={`${sectionPrefix}-brick-reason-${manifest.id}`}
              className="p-2 rounded bg-surface-base border border-border text-[11px] text-amber-200/90"
            >
              {maturity.icon} {maturityReason}
            </div>
          )}

          {needsScheduling && (
            <div
              data-testid={`${sectionPrefix}-brick-scheduling-${manifest.id}`}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-sky-400/10 border border-sky-400/30 text-sky-300 text-[10px] font-semibold"
            >
              <span>⏱</span>
              <span>Needs scheduling / queues</span>
            </div>
          )}

          {brickIssues.length > 0 && (
            <div
              data-testid={`inline-issue-badge-${manifest.id}`}
              className="p-2 rounded bg-rose-500/15 border border-rose-500/40 text-[11px] text-rose-200 space-y-1"
            >
              {brickIssues.map((iss) => (
                <div key={iss.id} className="flex items-start gap-1.5">
                  <span className="font-bold text-rose-400">
                    {iss.severity === "error" ? "✕" : "⚠"}
                  </span>
                  <span>{iss.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-border flex items-center justify-between gap-2 text-[11px]">
          <span
            data-testid={`${sectionPrefix}-brick-category-${manifest.id}`}
            className="px-2 py-0.5 rounded bg-surface-control text-text-secondary uppercase tracking-wider text-[10px] font-bold"
          >
            {manifest.ui?.category ?? "developer"}
          </span>

          <div className="flex items-center gap-2">
            <span
              className={
                isEnabled
                  ? "text-emerald-400 font-semibold"
                  : "text-text-muted"
              }
            >
              {isEnabled ? "● Enabled in project" : "○ Available in catalog"}
            </span>

            {isEnabled ? (
              <button
                type="button"
                data-testid={`${sectionPrefix}-brick-disable-${manifest.id}`}
                disabled={isViewer || isMutating}
                onClick={(e) => {
                  e.stopPropagation();
                  openDisableModal(manifest.id);
                }}
                className="px-2 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25 font-semibold text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Turn off
              </button>
            ) : (
              <button
                type="button"
                data-testid={`${sectionPrefix}-brick-enable-${manifest.id}`}
                disabled={isViewer || isMutating}
                onClick={(e) => {
                  e.stopPropagation();
                  openEnableModal(manifest.id);
                }}
                className="px-2 py-0.5 rounded bg-accent/20 border border-accent/50 text-accent hover:bg-accent/30 font-semibold text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Turn on
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div data-testid="view-bricks" className="space-y-6">
      {mutationError && (
        <div
          role="alert"
          data-testid="mutation-error-alert"
          className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs flex items-center justify-between gap-3"
        >
          <span>⚠ {mutationError}</span>
          <button
            type="button"
            data-testid="mutation-error-dismiss"
            onClick={() => setMutationError(null)}
            className="px-2 py-0.5 rounded bg-surface-control text-text-secondary hover:text-text-primary text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Header & Filter Bar */}
      <div className="p-4 rounded-lg bg-surface-raised border border-border flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-text-primary">
            Bricks — Enabled & 40-Brick Catalog
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            Full-stack capabilities with production, beta, and experimental maturity badges. Turn bricks on or off and configure settings in the Right Dock Inspector.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Search Input */}
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search bricks by name, id, or capability…"
            aria-label="Search bricks"
            data-testid="bricks-search-input"
            className="w-64 px-3 py-1.5 rounded bg-surface-control border border-border-strong text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />

          {/* Category Filter */}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            aria-label="Filter bricks by category"
            data-testid="bricks-category-filter"
            className="px-3 py-1.5 rounded bg-surface-control border border-border-strong text-xs text-text-primary"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>

          {/* Include Experimental Toggle (off by default per AD-S8) */}
          <label
            data-testid="bricks-experimental-toggle-label"
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-surface-control border border-border-strong text-xs text-text-secondary cursor-pointer select-none"
          >
            <input
              type="checkbox"
              checked={showExperimental}
              onChange={(e) => setShowExperimental(e.target.checked)}
              data-testid="bricks-experimental-toggle"
              className="rounded accent-amber-500"
            />
            <span>Include experimental</span>
          </label>
        </div>
      </div>

      {/* Section 1: Enabled in Project */}
      <section
        aria-label="Enabled in Project"
        data-testid="bricks-enabled-section"
        className="space-y-3"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">
            Enabled in Project ({enabledManifests.length})
          </h3>
          <span className="text-[11px] text-text-muted">
            Enabled bricks are always shown regardless of maturity tier
          </span>
        </div>

        {enabledManifests.length === 0 ? (
          <div className="p-4 rounded-lg bg-surface-raised border border-border text-xs text-text-muted">
            No enabled bricks match the current filter.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {enabledManifests.map((manifest) => renderBrickCard(manifest, "enabled"))}
          </div>
        )}
      </section>

      {/* Section 2: Brick Catalog */}
      <section
        aria-label="Brick Catalog"
        data-testid="bricks-catalog-section"
        className="space-y-3"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">
            Brick Catalog ({catalogManifests.length} shown)
          </h3>
          <span className="text-[11px] text-text-muted">
            {showExperimental
              ? "Showing production, beta, and experimental bricks"
              : "Experimental bricks hidden by default — toggle 'Include experimental' to view"}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {catalogManifests.map((manifest) => renderBrickCard(manifest, "catalog"))}
        </div>
      </section>

      {/* Section 3: Curated Integrations */}
      <section
        aria-label="Curated Integrations"
        data-testid="bricks-integrations-section"
        className="space-y-3"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">
            Curated Integrations ({integrationList.length})
          </h3>
          <span className="text-[11px] text-text-muted">
            Integration packs with live-canary and fidelity verification
          </span>
        </div>

        {integrationList.length === 0 ? (
          <div className="p-4 rounded-lg bg-surface-raised border border-border text-xs text-text-muted">
            No integrations match the current filter.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {integrationList.map((intManifest) => renderIntegrationCard(intManifest))}
          </div>
        )}
      </section>

      {/* Dependency & Impact Preview Modal (Enable Brick) */}
      {enablePreview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Turn on ${enablePreview.manifest.ui?.displayName ?? enablePreview.brickId}`}
          data-testid="brick-enable-modal"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-lg rounded-lg bg-surface-raised border border-border-strong p-5 space-y-4 text-xs shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-text-primary">
                  Turn on {enablePreview.manifest.ui?.displayName ?? enablePreview.brickId}
                </h3>
                <div className="font-mono text-[11px] text-text-muted mt-0.5">
                  {enablePreview.brickId}
                </div>
              </div>
              <MaturityBadge
                testId="brick-enable-modal-maturity"
                tier={enablePreview.manifest.ui?.maturity}
                derivedTier={enablePreview.manifest.ui?.derivedTier}
                blockers={enablePreview.manifest.ui?.blockers}
                evidence={enablePreview.manifest.ui?.evidence}
                reason={enablePreview.maturityReason}
              />
            </div>

            {enablePreview.manifest.ui?.summary && (
              <p className="text-text-secondary">{enablePreview.manifest.ui.summary}</p>
            )}

            {/* Transitive Required Providers */}
            <div
              data-testid="brick-enable-requires"
              className="p-3 rounded bg-surface-base border border-border space-y-1.5"
            >
              <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                Dependency Preview
              </div>
              {enablePreview.missingProviders.length === 0 ? (
                <div className="text-emerald-400">
                  ✓ All required capabilities are already satisfied.
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-amber-300 font-semibold">
                    Also turns on:{" "}
                    {enablePreview.missingProviders
                      .map((p) => `${p.brickId} (required)`)
                      .join(", ")}
                  </div>
                  <ul className="space-y-1 text-text-secondary font-mono text-[11px]">
                    {enablePreview.missingProviders.map((p) => (
                      <li
                        key={p.brickId}
                        data-testid={`brick-enable-req-${p.brickId}`}
                      >
                        + {p.brickId} ({p.displayName}) — provides {p.providesCapability}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Conflicts */}
            {enablePreview.conflicts.length > 0 && (
              <div
                role="alert"
                data-testid="brick-enable-conflicts"
                className="p-3 rounded bg-rose-500/15 border border-rose-500/40 text-rose-200 space-y-1.5"
              >
                <div className="font-bold text-rose-300">
                  ✕ Conflict with enabled brick — cannot turn on:
                </div>
                <ul className="space-y-1 font-mono text-[11px]">
                  {enablePreview.conflicts.map((c, idx) => (
                    <li key={`${c.brickA}:${c.brickB}:${idx}`}>
                      {c.brickA} × {c.brickB}: {c.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* What this brick adds */}
            <div
              data-testid="brick-enable-adds"
              className="p-3 rounded bg-surface-base border border-border space-y-1.5"
            >
              <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                What This Brick Adds
              </div>
              <div>
                <span className="text-text-muted">Migrations: </span>
                <span className="font-mono text-text-secondary">
                  {enablePreview.adds.migrations.length > 0
                    ? enablePreview.adds.migrations.join(", ")
                    : "None"}
                </span>
              </div>
              <div>
                <span className="text-text-muted">Routes: </span>
                <span className="font-mono text-sky-400">
                  {enablePreview.adds.routes.length > 0
                    ? enablePreview.adds.routes.join(", ")
                    : "None"}
                </span>
              </div>
              <div>
                <span className="text-text-muted">Workflow Actions / Triggers: </span>
                <span className="font-mono text-emerald-400">
                  {enablePreview.adds.nodes.length > 0
                    ? enablePreview.adds.nodes.map((n) => `${n.type} (${n.role})`).join(", ")
                    : "None"}
                </span>
              </div>
            </div>

            {/* Experimental Confirmation Checkbox */}
            {enablePreview.isExperimental && (
              <label
                data-testid="experimental-confirm-box"
                className="flex items-start gap-2.5 p-3 rounded bg-amber-500/10 border border-amber-500/40 text-amber-200 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  data-testid="experimental-confirm-checkbox"
                  checked={experimentalConfirmed}
                  onChange={(e) => setExperimentalConfirmed(e.target.checked)}
                  className="mt-0.5 rounded accent-amber-500"
                />
                <span>
                  I understand this brick is experimental:{" "}
                  {enablePreview.maturityReason ?? "Experimental maturity tier"}
                </span>
              </label>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                data-testid="brick-enable-cancel"
                onClick={() => {
                  setEnableModalBrickId(null);
                  setExperimentalConfirmed(false);
                }}
                className="px-3 py-1.5 rounded bg-surface-control border border-border-strong text-text-secondary hover:text-text-primary font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="brick-enable-confirm"
                disabled={
                  isMutating ||
                  enablePreview.conflicts.length > 0 ||
                  (enablePreview.isExperimental && !experimentalConfirmed)
                }
                onClick={() => void handleConfirmEnable()}
                className="px-3 py-1.5 rounded bg-accent text-slate-950 font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isMutating ? "Turning on…" : "Confirm & Turn on"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Disable / Remove Brick Impact Modal */}
      {disableImpact && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Turn off ${disableImpact.manifest.ui?.displayName ?? disableImpact.brickId}`}
          data-testid="brick-disable-modal"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-lg rounded-lg bg-surface-raised border border-border-strong p-5 space-y-4 text-xs shadow-xl">
            <div>
              <h3 className="text-sm font-bold text-text-primary">
                Turn off {disableImpact.manifest.ui?.displayName ?? disableImpact.brickId}?
              </h3>
              <div className="font-mono text-[11px] text-text-muted mt-0.5">
                {disableImpact.brickId}
              </div>
            </div>

            <div
              data-testid="brick-disable-dependents"
              className="p-3 rounded bg-surface-base border border-border space-y-1.5"
            >
              <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                Dependent Bricks Impact
              </div>
              {disableImpact.dependentBricks.length === 0 ? (
                <div className="text-emerald-400">
                  ✓ No other enabled bricks depend exclusively on this brick.
                </div>
              ) : (
                <div className="space-y-1 text-amber-300">
                  <div className="font-semibold">
                    Turning off {disableImpact.brickId} will also turn off dependent bricks:
                  </div>
                  <ul className="font-mono text-[11px] space-y-1">
                    {disableImpact.dependentBricks.map((d) => (
                      <li key={d.brickId} data-testid={`brick-disable-dep-${d.brickId}`}>
                        - {d.brickId} (requires {d.requiredCapability})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div
              data-testid="brick-disable-workflows"
              className="p-3 rounded bg-surface-base border border-border space-y-1.5"
            >
              <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                Workflow Impact
              </div>
              {disableImpact.dependentWorkflows.length === 0 ? (
                <div className="text-emerald-400">
                  ✓ No workflows currently use {disableImpact.brickId} nodes.
                </div>
              ) : (
                <div className="space-y-1 text-amber-300">
                  <div className="font-semibold">
                    Workflows referencing {disableImpact.brickId} nodes:
                  </div>
                  <ul className="font-mono text-[11px] space-y-1">
                    {disableImpact.dependentWorkflows.map((w) => (
                      <li key={w.workflowId} data-testid={`brick-disable-wf-${w.workflowId}`}>
                        - {w.workflowName} ({w.workflowId}): nodes [{w.nodeIds.join(", ")}]
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                data-testid="brick-disable-cancel"
                onClick={() => setDisableModalBrickId(null)}
                className="px-3 py-1.5 rounded bg-surface-control border border-border-strong text-text-secondary hover:text-text-primary font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="brick-disable-confirm"
                disabled={isMutating}
                onClick={() => void handleConfirmDisable()}
                className="px-3 py-1.5 rounded bg-rose-500 text-slate-950 font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isMutating ? "Turning off…" : "Confirm & Turn off"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
