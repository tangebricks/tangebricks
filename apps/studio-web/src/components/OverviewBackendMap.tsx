import { useMemo, useState } from "react";
import {
  createOrgProject,
  downloadProjectOpenApiSpec,
  fetchProjectRevisions,
  getProjectOpenApiUrl,
  importProjectBundle,
  type EnvironmentHealthSummaryPayload,
} from "../api.ts";
import { getActiveOrg, useStudioStore } from "../store.ts";
import {
  BackendHealthPanel,
  drillDownToErrorLogs,
  drillDownToFailedWorkflowRuns,
} from "./BackendHealthPanel.tsx";
import {
  PRESET_BLUEPRINTS,
  formatMaturityBadge,
  takesEntitiesInManifest,
} from "../types.ts";
import type {
  ReadinessNeed,
  StudioNavTab,
  StudioSelection,
  WorkflowDefinition,
  WorkflowTrigger,
} from "../types.ts";

export interface CapabilityLink {
  capability: string;
  providerBrickId: string;
  consumerBrickIds: string[];
}

function formatTriggerBadge(trigger?: WorkflowTrigger): { icon: string; label: string } {
  if (!trigger) {
    return { icon: "▶", label: "manual" };
  }
  if (typeof trigger === "string") {
    return { icon: "⚡", label: trigger };
  }
  switch (trigger.kind) {
    case "webhook":
      return { icon: "🌐", label: `webhook ${trigger.path ?? ""}`.trim() };
    case "schedule":
      return { icon: "⏱", label: `schedule ${trigger.cron ?? ""}`.trim() };
    case "queue":
      return { icon: "📥", label: `queue ${trigger.queue ?? ""}`.trim() };
    case "event":
      return { icon: "⚡", label: `event ${trigger.event ?? ""}`.trim() };
    default:
      return { icon: "▶", label: "manual" };
  }
}

function inferTouchedObjects(
  wf: WorkflowDefinition,
  enabledBrickIds: Set<string>,
  entityNames: Set<string>,
): { bricks: string[]; entities: string[] } {
  const touchedBricks = new Set<string>();
  const touchedEntities = new Set<string>();

  for (const node of wf.nodes) {
    const prefix = node.type.split(".")[0] ?? "";
    if (enabledBrickIds.has(prefix)) {
      touchedBricks.add(prefix);
    }
    for (const brickId of enabledBrickIds) {
      if (
        node.type.includes(brickId) ||
        JSON.stringify(node.data).includes(brickId)
      ) {
        touchedBricks.add(brickId);
      }
    }
    const entityData = node.data?.entity;
    if (typeof entityData === "string" && entityNames.has(entityData)) {
      touchedEntities.add(entityData);
    }
    for (const entName of entityNames) {
      if (
        node.type.includes(entName) ||
        JSON.stringify(node.data).includes(entName)
      ) {
        touchedEntities.add(entName);
      }
    }
  }

  return {
    bricks: [...touchedBricks].sort(),
    entities: [...touchedEntities].sort(),
  };
}

function parseNeedTarget(need: ReadinessNeed): {
  selection: StudioSelection | null;
  nav: StudioNavTab;
} {
  if (need.path.startsWith("bricks.")) {
    const parts = need.path.split(".");
    const brickId = parts[1];
    if (brickId) {
      return {
        selection: { kind: "brick", id: brickId },
        nav: "bricks",
      };
    }
  }
  if (need.path.startsWith("workflows.")) {
    const parts = need.path.split(".");
    const wfId = parts[1];
    const nodeId = parts[2] === "nodes" ? parts[3] : undefined;
    if (wfId && nodeId) {
      return {
        selection: { kind: "node", id: nodeId, workflowId: wfId },
        nav: "workflows",
      };
    }
    if (wfId) {
      return {
        selection: { kind: "workflow", id: wfId },
        nav: "workflows",
      };
    }
  }
  if (need.path.startsWith("entities")) {
    return {
      selection: null,
      nav: "data",
    };
  }
  return {
    selection: null,
    nav: "bricks",
  };
}

export function OverviewBackendMap() {
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const projects = useStudioStore((s) => s.projects);
  const activeProjectId = useStudioStore((s) => s.activeProjectId);
  const projectState = useStudioStore((s) => s.projectState);
  const readiness = useStudioStore((s) => s.readiness);
  const catalog = useStudioStore((s) => s.catalog);
  const revisions = useStudioStore((s) => s.revisions);
  const outlineMode = useStudioStore((s) => s.backendMapOutlineMode);
  const setOutlineMode = useStudioStore((s) => s.setBackendMapOutlineMode);
  const selectItem = useStudioStore((s) => s.selectItem);
  const setActiveNav = useStudioStore((s) => s.setActiveNav);
  const setRunHistoryDrawerOpen = useStudioStore((s) => s.setRunHistoryDrawerOpen);
  const setRunsFilters = useStudioStore((s) => s.setRunsFilters);
  const loadProjectRuns = useStudioStore((s) => s.loadProjectRuns);
  const startRunReplay = useStudioStore((s) => s.startRunReplay);
  const setProjects = useStudioStore((s) => s.setProjects);
  const setProjectData = useStudioStore((s) => s.setProjectData);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [loadingPreset, setLoadingPreset] = useState<string | null>(null);
  const [healthSummary, setHealthSummary] =
    useState<EnvironmentHealthSummaryPayload | null>(null);

  const activeOrg = getActiveOrg({ orgs, activeOrgId });

  const handleLoadPreset = async (presetKey: string) => {
    const presetBlueprint = PRESET_BLUEPRINTS[presetKey];
    if (!presetBlueprint) return;
    setPresetError(null);
    setLoadingPreset(presetKey);
    try {
      const targetProject = activeProjectId ?? projectState?.project ?? presetKey;
      const hasProject = projects.some((p) => p.project === targetProject);
      if (!activeProjectId && !hasProject && activeOrg) {
        await createOrgProject(activeOrg.id, targetProject);
      }
      const imported = await importProjectBundle(
        targetProject,
        presetBlueprint,
        "replace",
        presetKey,
      );
      const revs = await fetchProjectRevisions(imported.project);
      if (activeOrg && !projects.some((p) => p.project === imported.project)) {
        setProjects(
          [
            ...projects,
            {
              project: imported.project,
              orgId: activeOrg.id,
              revision: imported.revision,
              semanticHash: imported.semanticHash ?? "imported",
              updatedAt: new Date().toISOString(),
            },
          ],
          imported.project,
        );
      }
      setProjectData({
        project: imported.project,
        revision: imported.revision,
        state: imported.state,
        readiness: imported.readiness,
        revisions: revs.length > 0 ? revs : undefined,
      });
    } catch (err) {
      setPresetError(err instanceof Error ? err.message : "Failed to load preset");
    } finally {
      setLoadingPreset(null);
    }
  };

  const bricks = projectState?.bricks ?? [];
  const entities = projectState?.entities ?? [];
  const workflows = projectState?.workflows ?? [];
  const projectSlug = projectState?.project ?? "my-saas-app";

  const capabilityLinks = useMemo<CapabilityLink[]>(() => {
    const providerMap = new Map<string, string>();
    for (const b of bricks) {
      const manifest = catalog[b.id];
      if (!manifest) continue;
      for (const cap of manifest.provides) {
        if (!providerMap.has(cap)) {
          providerMap.set(cap, b.id);
        }
      }
    }

    const links: CapabilityLink[] = [];
    for (const [cap, providerBrickId] of providerMap.entries()) {
      const consumers: string[] = [];
      for (const b of bricks) {
        if (b.id === providerBrickId) continue;
        const manifest = catalog[b.id];
        if (manifest?.requires.includes(cap)) {
          consumers.push(b.id);
        }
      }
      links.push({
        capability: cap,
        providerBrickId,
        consumerBrickIds: consumers,
      });
    }
    return links;
  }, [bricks, catalog]);

  const entityServingBricks = useMemo(() => {
    return bricks
      .map((b) => catalog[b.id])
      .filter((m): m is NonNullable<typeof m> => Boolean(m && takesEntitiesInManifest(m)))
      .map((m) => m.id);
  }, [bricks, catalog]);

  const brickHasNeed = useMemo(() => {
    const map = new Set<string>();
    for (const need of readiness.needs) {
      if (need.path.startsWith("bricks.")) {
        const brickId = need.path.split(".")[1];
        if (brickId) map.add(brickId);
      }
    }
    return map;
  }, [readiness.needs]);

  const enabledBrickSet = useMemo(() => new Set(bricks.map((b) => b.id)), [bricks]);
  const entityNameSet = useMemo(() => new Set(entities.map((e) => e.name)), [entities]);

  // Empty project state (AC 5)
  if (bricks.length === 0) {
    const mcpSnippet = JSON.stringify(
      {
        mcpServers: {
          "projectx-studio": {
            url: `https://studio.projectx.dev/mcp`,
            headers: {
              Authorization: "Bearer st_mcp_<your_scoped_token>",
            },
          },
        },
      },
      null,
      2,
    );

    return (
      <div data-testid="overview-empty-state" className="space-y-6">
        <div className="p-6 rounded-lg bg-surface-raised border border-border">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-surface-control text-accent text-xs font-bold uppercase tracking-wider">
              <span>◈</span>
              <span>Empty Project</span>
            </div>
            <button
              type="button"
              data-testid="download-openapi-btn"
              data-openapi-url={getProjectOpenApiUrl(projectSlug)}
              onClick={() => void downloadProjectOpenApiSpec(projectSlug)}
              className="px-3 py-1.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-semibold text-text-primary"
            >
              ⬇ Download OpenAPI 3.1 Spec
            </button>
          </div>
          <h2 className="text-base font-bold text-text-primary">
            Welcome to {projectSlug} — choose how to start your backend
          </h2>
          <p className="text-xs text-text-secondary mt-1">
            Your blueprint has no bricks enabled yet. Connect an AI agent over MCP, start from a verified preset, or browse the 40-brick catalog.
          </p>

          <div className="grid grid-cols-3 gap-4 mt-5">
            {/* Card 1: Connect MCP Agent */}
            <div
              data-testid="empty-card-connect-mcp"
              className="p-4 rounded-lg bg-surface-base border border-border flex flex-col justify-between"
            >
              <div>
                <div className="text-xs font-bold text-sky-400">
                  🤖 1. Connect MCP Agent
                </div>
                <p className="text-xs text-text-secondary mt-1">
                  Describe your app to Claude Desktop, Cursor, or any MCP client to build live while you watch.
                </p>
                <pre
                  data-testid="mcp-connection-snippet"
                  className="mt-3 p-2.5 rounded bg-surface-raised border border-border font-mono text-[10px] text-emerald-300 overflow-x-auto"
                >
                  {mcpSnippet}
                </pre>
              </div>
            </div>

            {/* Card 2: Start from Preset */}
            <div
              data-testid="empty-card-start-preset"
              className="p-4 rounded-lg bg-surface-base border border-border flex flex-col justify-between"
            >
              <div>
                <div className="text-xs font-bold text-accent">
                  ⚡ 2. Start from Preset
                </div>
                <p className="text-xs text-text-secondary mt-1">
                  Load a verified multi-brick starter template (`b2b-workspace-app`, `ai-credits-saas`, `marketplace`, or `stripe-discord-ops`).
                </p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {Object.keys(PRESET_BLUEPRINTS).map((presetKey) => (
                  <button
                    key={presetKey}
                    type="button"
                    disabled={loadingPreset !== null}
                    data-testid={`load-preset-${presetKey}`}
                    onClick={() => handleLoadPreset(presetKey)}
                    className="px-2.5 py-1.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-mono text-text-primary disabled:opacity-50"
                  >
                    {presetKey}
                  </button>
                ))}
              </div>
              {presetError && (
                <div
                  role="alert"
                  data-testid="preset-error-banner"
                  className="mt-3 p-2.5 rounded bg-red-950/70 border border-red-700 text-red-200 text-xs"
                >
                  ✕ {presetError}
                </div>
              )}
            </div>

            {/* Card 3: Browse Bricks */}
            <div
              data-testid="empty-card-browse-bricks"
              className="p-4 rounded-lg bg-surface-base border border-border flex flex-col justify-between"
            >
              <div>
                <div className="text-xs font-bold text-emerald-400">
                  ▣ 3. Browse Bricks Catalog
                </div>
                <p className="text-xs text-text-secondary mt-1">
                  Explore all 40 full-stack bricks across identity, billing, data, automation, AI, and governance.
                </p>
              </div>
              <div className="mt-4">
                <button
                  type="button"
                  data-testid="empty-browse-bricks-button"
                  onClick={() => setActiveNav("bricks")}
                  className="px-3 py-1.5 rounded bg-accent hover:bg-accent-hover text-text-on-accent font-bold text-xs"
                >
                  Browse Bricks →
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const identityMode = projectState?.identity ?? "stub";
  const identityManifest = identityMode !== "stub" ? catalog[identityMode] : undefined;

  return (
    <div data-testid="overview-backend-map" className="space-y-6">
      {/* Header & Accessible Outline Toggle */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-text-primary">
            Backend Map — <span className="font-mono text-accent">{projectSlug}</span>
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            Generated non-editable system diagram from BlueprintState ({bricks.length} bricks,{" "}
            {entities.length} entities, {workflows.length} workflows).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="download-openapi-btn"
            data-openapi-url={getProjectOpenApiUrl(projectSlug)}
            onClick={() => void downloadProjectOpenApiSpec(projectSlug)}
            className="px-3 py-1.5 rounded bg-surface-raised hover:bg-surface-control border border-border-strong text-xs font-semibold text-text-secondary hover:text-text-primary transition"
          >
            ⬇ Download OpenAPI 3.1 Spec
          </button>
          <button
            type="button"
            data-testid="backend-map-outline-toggle"
            aria-pressed={outlineMode}
            onClick={() => setOutlineMode(!outlineMode)}
            className={`px-3 py-1.5 rounded border text-xs font-semibold transition ${
              outlineMode
                ? "bg-accent text-text-on-accent border-accent"
                : "bg-surface-raised text-text-secondary border-border-strong hover:text-text-primary"
            }`}
          >
            {outlineMode ? "✓ Outline View (Accessible)" : "≡ Outline View"}
          </button>
        </div>
      </div>

      {/* Accessible Outline View (AC 4) */}
      {outlineMode && (
        <section
          role="region"
          aria-label="Backend Map Outline"
          data-testid="backend-map-outline-region"
          className="p-4 rounded-lg bg-surface-raised border border-border-strong space-y-3"
        >
          <h3 className="text-xs font-bold uppercase tracking-wider text-accent">
            Structured System Outline (Screen Reader & Keyboard View)
          </h3>
          <ul aria-label="Backend system components" className="space-y-2 text-xs">
            <li>
              <span className="font-bold text-text-primary">Identity Provider:</span>{" "}
              <span className="font-mono text-emerald-400">
                {identityManifest
                  ? `${identityManifest.ui?.displayName ?? identityMode} (${identityMode})`
                  : "stub (development identity)"}
              </span>
            </li>
            <li>
              <div className="font-bold text-text-primary">
                Enabled Bricks ({bricks.length})
              </div>
              <ul className="pl-4 mt-1 space-y-1">
                {bricks.map((b) => {
                  const m = catalog[b.id];
                  const mat = formatMaturityBadge(m?.ui?.maturity ?? "production");
                  return (
                    <li key={b.id}>
                      <button
                        type="button"
                        data-testid={`outline-brick-item-${b.id}`}
                        onClick={() => selectItem({ kind: "brick", id: b.id }, "bricks")}
                        className="text-left hover:underline text-text-secondary"
                      >
                        {m?.ui?.displayName ?? b.id} ({b.id}) — {mat.textWithIcon} — Routes:{" "}
                        {(m?.routePrefixes ?? []).map((r) => `/api/${r}`).join(", ") || "none"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
            <li>
              <div className="font-bold text-text-primary">
                Capability Wiring ({capabilityLinks.length})
              </div>
              <ul className="pl-4 mt-1 space-y-1 font-mono text-[11px] text-text-secondary">
                {capabilityLinks.map((link) => (
                  <li key={`${link.providerBrickId}:${link.capability}`}>
                    {link.providerBrickId} provides [{link.capability}] →{" "}
                    {link.consumerBrickIds.length > 0
                      ? `required by ${link.consumerBrickIds.join(", ")}`
                      : "no consumers"}
                  </li>
                ))}
              </ul>
            </li>
            <li>
              <div className="font-bold text-text-primary">
                Declared Entities ({entities.length})
              </div>
              <ul className="pl-4 mt-1 space-y-1">
                {entities.map((ent) => (
                  <li key={ent.name}>
                    <button
                      type="button"
                      data-testid={`outline-entity-item-${ent.name}`}
                      onClick={() => selectItem({ kind: "entity", id: ent.name }, "data")}
                      className="text-left hover:underline text-text-secondary"
                    >
                      {ent.name} ({ent.fields.length} fields)
                    </button>
                  </li>
                ))}
              </ul>
            </li>
            <li>
              <div className="font-bold text-text-primary">
                Workflows ({workflows.length})
              </div>
              <ul className="pl-4 mt-1 space-y-1">
                {workflows.map((wf) => (
                  <li key={wf.id}>
                    <button
                      type="button"
                      data-testid={`outline-workflow-item-${wf.id}`}
                      onClick={() => selectItem({ kind: "workflow", id: wf.id }, "workflows")}
                      className="text-left hover:underline text-text-secondary"
                    >
                      {wf.name} ({wf.id}) — {wf.nodes.length} nodes
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          </ul>
        </section>
      )}

      {/* 1. Identity & Foundation Block + Capability Wiring (AC 1) */}
      <section
        aria-label="Identity and Capability Wiring"
        data-testid="backend-map-identity-block"
        className="p-4 rounded-lg bg-surface-raised border border-border space-y-3"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-accent font-bold">🔐</span>
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">
              Identity & Capability Wiring
            </h3>
          </div>
          <span
            data-testid="backend-map-identity-provider"
            className="px-2.5 py-0.5 rounded bg-surface-control border border-border-strong font-mono text-xs text-emerald-400"
          >
            Identity: {identityMode}
            {identityManifest?.ui?.displayName
              ? ` (${identityManifest.ui.displayName})`
              : ""}
          </span>
        </div>

        <div
          data-testid="backend-map-capability-links"
          className="grid grid-cols-2 gap-2 pt-1"
        >
          {capabilityLinks.map((link) => (
            <div
              key={`${link.providerBrickId}:${link.capability}`}
              data-testid={`capability-link-${link.capability}`}
              className="p-2.5 rounded bg-surface-base border border-border flex items-center justify-between gap-2 text-xs font-mono"
            >
              <div>
                <span className="text-emerald-400 font-semibold">
                  {link.providerBrickId}
                </span>
                <span className="text-text-muted"> provides </span>
                <span className="px-1.5 py-0.5 rounded bg-surface-control text-accent">
                  {link.capability}
                </span>
              </div>
              <div className="text-right text-[11px] text-text-secondary">
                {link.consumerBrickIds.length > 0
                  ? `→ ${link.consumerBrickIds.join(", ")}`
                  : "→ foundation"}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 2. Enabled Bricks Cards (AC 1, AC 2) */}
      <section
        aria-label="Enabled Bricks"
        data-testid="backend-map-bricks-block"
        className="space-y-3"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-text-secondary">
            Enabled Bricks ({bricks.length})
          </h3>
          <button
            type="button"
            onClick={() => setActiveNav("bricks")}
            className="text-xs text-accent hover:underline font-semibold"
          >
            View all in Bricks →
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {bricks.map((b) => {
            const manifest = catalog[b.id];
            const displayName = manifest?.ui?.displayName ?? b.id;
            const maturity = formatMaturityBadge(manifest?.ui?.maturity ?? "production");
            const routes = (manifest?.routePrefixes ?? []).map((p) => `/api/${p}`);
            const hasSetupIssue = brickHasNeed.has(b.id);
            const brickRollup = (healthSummary?.perBrick ?? []).find(
              (rb) => rb.brickId === b.id,
            );

            return (
              <div
                key={b.id}
                data-testid={`backend-map-brick-card-${b.id}`}
                onClick={() => selectItem({ kind: "brick", id: b.id })}
                className="p-3.5 rounded-lg bg-surface-raised border border-border hover:border-accent cursor-pointer flex flex-col justify-between gap-3 transition"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-bold text-xs text-text-primary">
                      {displayName}
                    </div>
                    <span
                      data-testid={`backend-map-brick-maturity-${b.id}`}
                      className="shrink-0 px-1.5 py-0.5 rounded bg-surface-control border border-border-strong text-[10px] font-semibold text-text-secondary"
                    >
                      {maturity.textWithIcon}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-text-muted mt-0.5">
                    {b.id}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {routes.length > 0 ? (
                      routes.map((route) => (
                        <span
                          key={route}
                          className="px-1.5 py-0.5 rounded bg-surface-base border border-border font-mono text-[10px] text-sky-400"
                        >
                          {route}
                        </span>
                      ))
                    ) : (
                      <span className="text-[10px] text-text-muted font-mono">
                        internal guard / schema
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    data-testid={`backend-map-brick-health-${b.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      drillDownToErrorLogs({
                        project: projectSlug,
                        env:
                          healthSummary?.env === "production"
                            ? "production"
                            : "preview",
                        brickId: b.id,
                        setActiveNav,
                        setRunHistoryDrawerOpen,
                      });
                    }}
                    className={`mt-2 px-2 py-0.5 rounded text-[10px] font-mono border ${
                      (brickRollup?.error5xxCount ?? 0) > 0
                        ? "bg-red-950/60 border-red-500/40 text-red-300"
                        : "bg-emerald-950/40 border-emerald-500/30 text-emerald-300"
                    }`}
                  >
                    {brickRollup
                      ? `${brickRollup.requestCount} req · ${brickRollup.error5xxCount} 5xx (${brickRollup.errorRatePercent}%) · p95 ${brickRollup.p95Ms}ms`
                      : "0 req · 0% 5xx · Healthy"}
                  </button>
                </div>

                <div className="pt-2 border-t border-border flex items-center justify-between text-[11px]">
                  <span
                    data-testid={`backend-map-brick-status-${b.id}`}
                    className={
                      hasSetupIssue
                        ? "text-amber-300 font-semibold"
                        : "text-emerald-400 font-semibold"
                    }
                  >
                    {hasSetupIssue ? "⚠ Needs setup" : "✓ Ready"}
                  </span>

                  <button
                    type="button"
                    data-testid={`backend-map-nav-brick-${b.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectItem({ kind: "brick", id: b.id }, "bricks");
                    }}
                    className="text-accent hover:underline font-semibold"
                  >
                    Open in Bricks →
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 3. Data (Entities) Block & 4. Workflows Block (AC 1, AC 2) */}
      <div className="grid grid-cols-2 gap-4">
        {/* Data (Entities) Block */}
        <section
          aria-label="Data Entities"
          data-testid="backend-map-entities-block"
          className="p-4 rounded-lg bg-surface-raised border border-border space-y-3"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">
                Data (Entities) ({entities.length})
              </h3>
              <div
                data-testid="backend-map-entity-handler-status"
                className="text-[11px] text-text-muted mt-0.5"
              >
                {entityServingBricks.length > 0 ? (
                  <span className="text-emerald-400">
                    ✓ Entity handler active ({entityServingBricks.join(", ")})
                  </span>
                ) : (
                  <span className="text-amber-300">
                    ⚠ No entity-serving brick active (enable dynamic-entities)
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveNav("data")}
              className="text-xs text-accent hover:underline font-semibold"
            >
              Open Data →
            </button>
          </div>

          {entities.length === 0 ? (
            <div className="p-3 rounded bg-surface-base border border-border text-xs text-text-muted">
              No entities declared yet.
            </div>
          ) : (
            <div className="space-y-2">
              {entities.map((ent) => (
                <div
                  key={ent.name}
                  data-testid={`backend-map-entity-card-${ent.name}`}
                  onClick={() => selectItem({ kind: "entity", id: ent.name })}
                  className="p-3 rounded bg-surface-base border border-border hover:border-accent cursor-pointer flex items-center justify-between"
                >
                  <div>
                    <div className="font-bold text-xs text-text-primary font-mono">
                      ent_{ent.name} ({ent.name})
                    </div>
                    <div className="text-[11px] text-text-muted">
                      {ent.fields.length} {ent.fields.length === 1 ? "field" : "fields"} ·{" "}
                      {ent.fields.map((f) => `${f.name}:${f.type}`).join(", ")}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid={`backend-map-nav-entity-${ent.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectItem({ kind: "entity", id: ent.name }, "data");
                    }}
                    className="text-xs text-accent hover:underline font-semibold"
                  >
                    Inspect in Data →
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Workflows Block */}
        <section
          aria-label="Workflows"
          data-testid="backend-map-workflows-block"
          className="p-4 rounded-lg bg-surface-raised border border-border space-y-3"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">
                Workflows ({workflows.length})
              </h3>
              <div className="text-[11px] text-text-muted mt-0.5">
                Durable execution graphs (one step per node)
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveNav("workflows")}
              className="text-xs text-accent hover:underline font-semibold"
            >
              Open Canvas →
            </button>
          </div>

          {workflows.length === 0 ? (
            <div className="p-3 rounded bg-surface-base border border-border text-xs text-text-muted">
              No workflows defined in this blueprint yet.
            </div>
          ) : (
            <div className="space-y-2">
              {workflows.map((wf) => {
                const trig = formatTriggerBadge(wf.trigger);
                const touched = inferTouchedObjects(
                  wf,
                  enabledBrickSet,
                  entityNameSet,
                );
                const wfFailure = (
                  healthSummary?.workflows.topFailingWorkflows ?? []
                ).find((item) => item.workflowId === wf.id);
                return (
                  <div
                    key={wf.id}
                    data-testid={`backend-map-workflow-card-${wf.id}`}
                    onClick={() => selectItem({ kind: "workflow", id: wf.id })}
                    className="p-3 rounded bg-surface-base border border-border hover:border-accent cursor-pointer flex items-center justify-between gap-2"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs text-text-primary">
                          {wf.name}
                        </span>
                        <span
                          data-testid={`backend-map-workflow-trigger-${wf.id}`}
                          className="px-1.5 py-0.5 rounded bg-surface-control text-[10px] font-mono text-sky-300"
                        >
                          {trig.icon} {trig.label}
                        </span>
                        <button
                          type="button"
                          data-testid={`backend-map-workflow-health-${wf.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            drillDownToFailedWorkflowRuns({
                              env:
                                healthSummary?.env === "production"
                                  ? "production"
                                  : "preview",
                              workflowId: wf.id,
                              lastFailedRunId: wfFailure?.lastFailedRunId,
                              setActiveNav,
                              setRunHistoryDrawerOpen,
                              setRunsFilters,
                              loadProjectRuns,
                              startRunReplay,
                            });
                          }}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                            (wfFailure?.failedCount ?? 0) > 0
                              ? "bg-red-950/60 border-red-500/40 text-red-300"
                              : "bg-emerald-950/40 border-emerald-500/30 text-emerald-300"
                          }`}
                        >
                          {wfFailure && wfFailure.failedCount > 0
                            ? `✕ ${wfFailure.failedCount} failed`
                            : "✓ 0 failed"}
                        </button>
                      </div>
                      <div className="text-[11px] text-text-muted mt-0.5">
                        {wf.nodes.length} nodes ·{" "}
                        {touched.bricks.length > 0
                          ? `Bricks: ${touched.bricks.join(", ")}`
                          : "Core nodes"}
                        {touched.entities.length > 0
                          ? ` · Entities: ${touched.entities.join(", ")}`
                          : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      data-testid={`backend-map-nav-workflow-${wf.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectItem({ kind: "workflow", id: wf.id }, "workflows");
                      }}
                      className="text-xs text-accent hover:underline font-semibold shrink-0"
                    >
                      Open Canvas →
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* 5. Readiness & Needs Panel + Recent Activity (AC 3) */}
      <div className="grid grid-cols-2 gap-4">
        <section
          aria-label="Readiness and Needs"
          data-testid="backend-map-readiness-panel"
          className="p-4 rounded-lg bg-surface-raised border border-border space-y-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">
              Readiness Checklist
            </h3>
            <span
              className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                readiness.ready
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-amber-500/15 text-amber-300"
              }`}
            >
              {readiness.ready
                ? "✓ Ready to Assemble"
                : `⚠ ${readiness.needs.length} ${readiness.needs.length === 1 ? "issue" : "issues"}`}
            </span>
          </div>

          {readiness.needs.length === 0 ? (
            <div
              data-testid="readiness-all-clear"
              className="p-3 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs"
            >
              ✓ All brick dependencies, identity providers, entity handlers, and secrets are satisfied.
            </div>
          ) : (
            <ul data-testid="readiness-needs-list" className="space-y-2">
              {readiness.needs.map((need, index) => {
                const target = parseNeedTarget(need);
                return (
                  <li
                    key={`${need.code}:${need.path}:${index}`}
                    data-testid={`readiness-need-${need.code}`}
                    className="p-2.5 rounded bg-surface-base border border-amber-500/30 flex items-start justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="font-mono text-[11px] text-amber-300 font-semibold">
                        ⚠ {need.code} ({need.path})
                      </div>
                      <div className="text-text-primary mt-0.5">{need.message}</div>
                      {need.suggestedFix && (
                        <div className="text-[11px] text-text-muted mt-0.5">
                          Fix: {need.suggestedFix}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      data-testid={`readiness-need-link-${need.code}`}
                      onClick={() => selectItem(target.selection, target.nav)}
                      className="shrink-0 px-2 py-1 rounded bg-surface-control hover:bg-slate-700 text-accent font-semibold text-[11px]"
                    >
                      Inspect →
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Recent Activity Summary */}
        <section
          aria-label="Recent Activity"
          data-testid="backend-map-activity-panel"
          className="p-4 rounded-lg bg-surface-raised border border-border space-y-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-primary">
              Recent Activity ({revisions.length})
            </h3>
            <button
              type="button"
              onClick={() => setActiveNav("history")}
              className="text-xs text-accent hover:underline font-semibold"
            >
              Full History →
            </button>
          </div>

          {revisions.length === 0 ? (
            <div className="p-3 rounded bg-surface-base border border-border text-xs text-text-muted">
              No revisions recorded yet.
            </div>
          ) : (
            <ul className="space-y-2 text-xs">
              {revisions.slice(0, 5).map((rev) => {
                const authorLabel =
                  rev.author.type === "agent"
                    ? `🤖 agent:${rev.author.client ?? rev.author.id}`
                    : `👤 human:${rev.author.id}`;
                return (
                  <li
                    key={rev.revision}
                    onClick={() =>
                      selectItem({ kind: "revision", id: String(rev.revision) }, "history")
                    }
                    className="p-2.5 rounded bg-surface-base border border-border hover:border-accent cursor-pointer flex items-center justify-between"
                  >
                    <div>
                      <span className="font-mono font-bold text-text-primary">
                        v{rev.revision}
                      </span>{" "}
                      <span className="text-text-secondary">
                        {rev.summary ?? "Blueprint update"}
                      </span>
                    </div>
                    <span className="font-mono text-[10px] text-text-muted">
                      {authorLabel}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* 6. Backend Health & Metrics Panel (Story 6.4) */}
      <div data-testid="overview-health-panel">
        <BackendHealthPanel
          project={projectSlug}
          onHealthLoaded={setHealthSummary}
        />
      </div>
    </div>
  );
}
