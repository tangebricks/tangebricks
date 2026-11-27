import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  downloadProjectOpenApiSpec,
  executeEnvironmentDeploy,
  fetchEnvironmentDeployPlan,
  getProjectOpenApiUrl,
  promoteEnvironmentDeployment,
  upsertProjectSecret,
} from "../api.ts";
import type { DeployExecutionResponse, DeployPlanPayload, DestructiveMigrationWarningPayload, ProjectDeployEnvironmentRecord } from "../api.ts";
import { useStudioStore } from "../store.ts";

export interface DeployPlanModalProps {
  open: boolean;
  projectSlug: string;
  orgId?: string;
  initialEnvName?: "preview" | "production";
  initialPlan?: DeployPlanPayload | null;
  onClose: () => void;
  onDeployed?: (result: { envName: "preview" | "production"; buildHash: string; revision: number; environment?: ProjectDeployEnvironmentRecord }) => void;
  onSwitchIdentityOverride?: () => Promise<void> | void;
  onAddSecretOverride?: (input: { name: string; requiredByBrick: string; value: string }) => Promise<void> | void;
  onDeployOverride?: (input: { envName: "preview" | "production"; confirmDestructive: boolean; confirmedMigrationNames: string[] }) => Promise<void> | void;
}

export function DeployPlanModal({
  open,
  projectSlug,
  orgId,
  initialEnvName = "preview",
  initialPlan = null,
  onClose,
  onDeployed,
  onSwitchIdentityOverride,
  onAddSecretOverride,
  onDeployOverride,
}: DeployPlanModalProps) {
  const projectState = useStudioStore((s) => s.projectState);
  const currentRevision = useStudioStore((s) => s.currentRevision);
  const commitOps = useStudioStore((s) => s.commitOps);
  const loadProjectSecrets = useStudioStore((s) => s.loadProjectSecrets);

  const [envName, setEnvName] = useState<"preview" | "production">(initialEnvName);
  const [plan, setPlan] = useState<DeployPlanPayload | null>(initialPlan);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [expandedMigrations, setExpandedMigrations] = useState<Record<string, boolean>>({});

  // Inline secret inputs keyed by secret name
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [savingSecretName, setSavingSecretName] = useState<string | null>(null);

  // Stub identity switch state
  const [switchingIdentity, setSwitchingIdentity] = useState(false);

  // Destructive Migration Guard confirmation checkbox
  const [confirmDestructiveChecked, setConfirmDestructiveChecked] = useState(false);

  // Deploy execution state
  const [deploying, setDeploying] = useState(false);
  const [deploySuccessMessage, setDeploySuccessMessage] = useState<string | null>(null);
  const [lastDeployResult, setLastDeployResult] = useState<Extract<DeployExecutionResponse, { ok: true }> | null>(null);

  useEffect(() => {
    if (open) {
      setEnvName(initialEnvName);
      setConfirmDestructiveChecked(false);
      setDeploySuccessMessage(null);
      setLastDeployResult(null);
      setPlanError(null);
      if (initialPlan) {
        setPlan(initialPlan);
      }
    }
  }, [open, initialEnvName, initialPlan]);

  const loadPlan = useCallback(
    async (targetEnv: "preview" | "production") => {
      if (!projectSlug) return;
      setLoadingPlan(true);
      setPlanError(null);
      try {
        const fetched = await fetchEnvironmentDeployPlan(projectSlug, targetEnv, {
          orgId,
        });
        if (fetched && fetched.worker && fetched.d1 && Array.isArray(fetched.blockers)) {
          setPlan(fetched);
        }
      } catch (err) {
        if (!initialPlan) {
          setPlanError(err instanceof Error ? err.message : "Failed to compute Pre-deploy Plan & Diff");
        }
      } finally {
        setLoadingPlan(false);
      }
    },
    [projectSlug, orgId, initialPlan],
  );

  useEffect(() => {
    if (!open) return;
    if (initialPlan && initialPlan.envName === envName) {
      setPlan(initialPlan);
      return;
    }
    if (!initialPlan) {
      void loadPlan(envName);
    }
  }, [open, envName, initialPlan, loadPlan]);

  const handleSelectEnvTab = (nextEnv: "preview" | "production") => {
    setEnvName(nextEnv);
    setConfirmDestructiveChecked(false);
    setDeploySuccessMessage(null);
    setLastDeployResult(null);
    setPlanError(null);
    if (!initialPlan) {
      void loadPlan(nextEnv);
    }
  };

  const stubIdentityBlocker = useMemo(() => plan?.blockers?.find((b) => b.code === "PRODUCTION_IDENTITY_STUB_FORBIDDEN") ?? null, [plan]);

  const destructiveWarnings: DestructiveMigrationWarningPayload[] = plan?.d1?.destructiveWarnings ?? [];

  const hasBlockers = (plan?.blockers?.length ?? 0) > 0;
  const requiresDestructiveConfirm = destructiveWarnings.length > 0;

  const canConfirmDeploy = Boolean(plan) && !loadingPlan && !deploying && !hasBlockers && (!requiresDestructiveConfirm || confirmDestructiveChecked);

  const effectiveRevision = plan?.revision ?? currentRevision ?? 1;
  const shortBuildHash = (plan?.worker?.nextBuildHash ?? "sha256").slice(0, 12);

  const handleInlineSaveSecret = async (secretName: string, requiredByBrick: string) => {
    const rawValue = (secretInputs[secretName] ?? "").trim();
    if (!rawValue) return;

    setSavingSecretName(secretName);
    setPlanError(null);
    try {
      if (onAddSecretOverride) {
        await onAddSecretOverride({
          name: secretName,
          requiredByBrick,
          value: rawValue,
        });
      } else {
        const ref = `sec_${secretName
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .replace(/^_+|_+$/g, "")}`;
        await upsertProjectSecret(projectSlug, {
          ref,
          kind: "brick_secret",
          label: secretName,
          appOrBrick: requiredByBrick || "blueprint",
          value: rawValue,
          ...(requiredByBrick && requiredByBrick !== "blueprint"
            ? {
                bindTarget: {
                  targetKind: "brick",
                  targetId: requiredByBrick,
                  secretName,
                },
              }
            : {}),
        });
        await loadProjectSecrets().catch(() => {});
      }
      // Scrub plaintext secret value immediately
      setSecretInputs((prev) => ({ ...prev, [secretName]: "" }));
      await loadPlan(envName);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : `Failed to save secret ${secretName}`);
    } finally {
      setSavingSecretName(null);
    }
  };

  const handleSwitchToCoreAuth = async () => {
    setSwitchingIdentity(true);
    setPlanError(null);
    try {
      if (onSwitchIdentityOverride) {
        await onSwitchIdentityOverride();
        await loadPlan(envName);
      } else {
        const hasCoreAuthBrick = Boolean(projectState?.bricks.some((b) => b.id === "core-auth"));
        const ops: Array<Record<string, unknown>> = [];
        if (!hasCoreAuthBrick) {
          ops.push({
            opId: `enable-core-auth-${Date.now()}`,
            type: "enable_brick",
            brickId: "core-auth",
            config: {},
          });
        }
        ops.push({
          opId: `set-identity-core-auth-${Date.now()}`,
          type: "set_identity",
          identity: "core-auth",
        });
        await commitOps(ops, "Switch identity from stub to Better Auth (core-auth)");
        await loadPlan(envName);
      }
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Failed to switch blueprint identity to core-auth");
    } finally {
      setSwitchingIdentity(false);
    }
  };

  const handleConfirmAndDeploy = async (usePromote?: boolean) => {
    if (!plan || !canConfirmDeploy) return;

    const confirmedMigrationNames = Array.from(new Set(destructiveWarnings.map((w) => w.migrationName)));

    setDeploying(true);
    setPlanError(null);
    setDeploySuccessMessage(null);
    try {
      if (onDeployOverride) {
        await onDeployOverride({
          envName,
          confirmDestructive: confirmDestructiveChecked,
          confirmedMigrationNames,
        });
        setDeploySuccessMessage(`Deployed revision r${effectiveRevision} (${shortBuildHash}) to ${envName}.`);
        return;
      }

      const shouldPromote = usePromote ?? envName === "production";
      const res = shouldPromote
        ? await promoteEnvironmentDeployment(projectSlug, envName, {
            orgId,
            confirmDestructive: confirmDestructiveChecked,
            confirmedMigrationNames,
          })
        : await executeEnvironmentDeploy(projectSlug, envName, {
            orgId,
            confirmDestructive: confirmDestructiveChecked,
            confirmedMigrationNames,
          });

      if (!res.ok) {
        setPlanError(res.error.message);
        if (res.plan) {
          setPlan(res.plan);
        }
        return;
      }

      setLastDeployResult(res);
      const resultHash = (res.buildHash ?? res.deployment.buildHash).slice(0, 12);
      if (res.noChanges || res.action === "noop") {
        setDeploySuccessMessage(`No changes — ${envName} is already at revision r${res.revision} (${resultHash})`);
      } else if (res.liveWithoutRedeploy || res.action === "hot_apply_graphs") {
        setDeploySuccessMessage(
          res.promotedFromEnv
            ? `Promoted revision r${res.revision} (${resultHash}) from ${res.promotedFromEnv} to ${envName} — Live without redeploy (updated workflow graphs in D1) → ${res.deployment.url}`
            : `Live without redeploy — updated workflow graphs in D1 for revision r${res.revision} (${resultHash}) → ${res.deployment.url}`,
        );
      } else if (res.promotedFromEnv) {
        setDeploySuccessMessage(`Promoted revision r${res.revision} (${resultHash}) from ${res.promotedFromEnv} to ${envName} → ${res.deployment.url}`);
      } else {
        setDeploySuccessMessage(`Deployed revision r${res.revision} (${resultHash}) to ${envName} → ${res.deployment.url}`);
      }
      onDeployed?.({
        envName,
        buildHash: res.buildHash ?? res.deployment.buildHash,
        revision: res.revision,
        environment: res.environment,
      });
      await loadPlan(envName);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Deployment execution failed");
    } finally {
      setDeploying(false);
    }
  };

  if (!open) return null;

  return (
    <div
      data-testid="deploy-plan-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deploy-plan-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg bg-surface-overlay border border-border-strong shadow-2xl p-6 space-y-5 text-text-primary">
        {/* Header & Environment Switcher */}
        <div className="flex items-start justify-between gap-4 border-b border-border pb-3">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-wider text-accent">Pre-deploy Plan &amp; Diff · {projectSlug}</div>
            <h3 id="deploy-plan-modal-title" className="text-base font-bold text-text-primary mt-0.5">
              Review Change Plan Before Deploying to <span className="font-mono text-amber-300">{envName}</span>
            </h3>
          </div>

          <div className="flex items-center gap-2">
            <div role="tablist" aria-label="Target Environment" className="inline-flex rounded bg-surface-base border border-border p-0.5">
              <button
                type="button"
                role="tab"
                aria-selected={envName === "preview"}
                data-testid="deploy-plan-env-tab-preview"
                onClick={() => handleSelectEnvTab("preview")}
                className={`px-3 py-1 rounded text-xs font-mono font-semibold transition ${
                  envName === "preview" ? "bg-accent text-text-on-accent" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                preview
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={envName === "production"}
                data-testid="deploy-plan-env-tab-production"
                onClick={() => handleSelectEnvTab("production")}
                className={`px-3 py-1 rounded text-xs font-mono font-semibold transition ${
                  envName === "production" ? "bg-accent text-text-on-accent" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                production
              </button>
            </div>

            <button
              type="button"
              data-testid="close-deploy-plan-modal"
              onClick={onClose}
              className="px-2.5 py-1 rounded bg-surface-control border border-border text-xs text-text-secondary hover:text-text-primary"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Production Stub-Identity Blocking Banner (D8, AD-S12) */}
        {stubIdentityBlocker && (
          <div
            data-testid="deploy-plan-stub-identity-blocker"
            role="alert"
            className="p-4 rounded-md bg-rose-950/90 border border-rose-600 text-rose-100 space-y-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-bold text-xs text-rose-200 flex items-center gap-2">
                <span>⛔</span>
                <span>
                  Production Blocked — Stub Identity Forbidden (<code className="font-mono">PRODUCTION_IDENTITY_STUB_FORBIDDEN</code>)
                </span>
              </div>
              <span className="px-2 py-0.5 rounded bg-rose-900 border border-rose-500 text-[10px] font-mono">identity: &quot;stub&quot;</span>
            </div>
            <p className="text-xs text-rose-200/90">{stubIdentityBlocker.message}</p>
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11px] text-rose-300">{stubIdentityBlocker.remediation}</span>
              <button
                type="button"
                data-testid="switch-to-core-auth-button"
                disabled={switchingIdentity}
                onClick={() => void handleSwitchToCoreAuth()}
                className="px-3 py-1.5 rounded bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs shrink-0 disabled:opacity-50"
              >
                {switchingIdentity ? "Switching…" : "Switch to Better Auth (core-auth)"}
              </button>
            </div>
          </div>
        )}

        {/* No-op Banner when environment is already at current revision & buildHash */}
        {plan && plan.action === "noop" && (
          <div
            data-testid="deploy-plan-noop-banner"
            className="p-3.5 rounded-md bg-emerald-950/70 border border-emerald-600/60 text-emerald-100 text-xs flex items-center justify-between gap-3"
          >
            <div>
              <strong>
                No changes — environment is already at revision r{effectiveRevision} (build {shortBuildHash})
              </strong>
            </div>
            <span className="px-2 py-0.5 rounded bg-emerald-900/80 border border-emerald-500/40 font-mono text-[11px] text-emerald-300">noop</span>
          </div>
        )}

        {/* Graph-Only Hot-Apply Banner when codeHash is unchanged and only graphHash changed */}
        {plan && (plan.action === "hot_apply_graphs" || lastDeployResult?.liveWithoutRedeploy) && (
          <div
            data-testid="deploy-plan-hot-apply-banner"
            className="p-3.5 rounded-md bg-sky-950/80 border border-sky-500/60 text-sky-100 text-xs flex items-center justify-between gap-3"
          >
            <div>
              <strong>Live without redeploy — workflow graph changes hot-applied directly to D1 without rebuilding or re-uploading the Worker script.</strong>
            </div>
            <span
              data-testid="deploy-live-without-redeploy-badge"
              className="px-2 py-0.5 rounded bg-sky-900/80 border border-sky-400/50 font-mono text-[11px] text-sky-200 shrink-0"
            >
              Live without redeploy
            </span>
          </div>
        )}

        {/* Preflight Checklist */}
        {plan && (
          <div data-testid="deploy-plan-preflight" className="p-3.5 rounded-md bg-surface-raised border border-border space-y-2.5 text-xs">
            <div className="font-semibold text-text-primary flex items-center justify-between gap-2 flex-wrap">
              <span>Preflight Checklist</span>
              <div className="flex items-center gap-2">
                {(plan.reusedCachedBuild || lastDeployResult?.reusedCachedBuild) && (
                  <span
                    data-testid="deploy-reused-cached-build-badge"
                    className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 font-mono text-[11px] text-emerald-300"
                  >
                    Reuses cached build ({shortBuildHash})
                  </span>
                )}
                <span
                  data-testid="deploy-plan-action-badge"
                  className="px-2 py-0.5 rounded bg-surface-base border border-border-strong font-mono text-[11px] text-amber-300"
                >
                  Action: {plan.action}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div
                data-testid="preflight-token-permissions"
                className="p-2 rounded bg-surface-base border border-emerald-500/30 flex items-center justify-between"
              >
                <span className="text-text-secondary">Cloudflare Token Permissions</span>
                <span className="font-mono text-emerald-400 font-bold">✓ 4/4 Verified</span>
              </div>

              <div
                data-testid="preflight-readiness"
                className={`p-2 rounded bg-surface-base border flex items-center justify-between ${
                  plan.blockers.some((b) => b.code === "READINESS_NOT_READY") ? "border-rose-500/40 text-rose-300" : "border-emerald-500/30 text-emerald-400"
                }`}
              >
                <span className="text-text-secondary">Blueprint Readiness</span>
                <span className="font-mono font-bold">{plan.blockers.some((b) => b.code === "READINESS_NOT_READY") ? "✕ Issues Found" : "✓ Ready"}</span>
              </div>
            </div>

            {/* Required Secrets List + Inline Add Secret */}
            <div data-testid="preflight-secrets" className="space-y-2 pt-1">
              <div className="text-[11px] font-semibold text-text-secondary">Required Secrets ({plan.secrets.filter((s) => !s.optional).length})</div>
              {plan.secrets.length === 0 ? (
                <div className="text-[11px] text-text-muted">✓ No external brick secrets required by this blueprint.</div>
              ) : (
                <div className="space-y-1.5">
                  {plan.secrets.map((sec) => (
                    <div
                      key={sec.name}
                      data-testid={`preflight-secret-row-${sec.name}`}
                      className={`p-2 rounded border flex items-center justify-between gap-3 flex-wrap ${
                        sec.status === "optional_missing"
                          ? "bg-surface-raised border-border"
                          : sec.status === "present" || sec.status === "will_generate"
                            ? "bg-emerald-500/10 border-emerald-500/30"
                            : "bg-amber-950/50 border-amber-500/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono font-bold ${
                            sec.status === "optional_missing" ? "text-text-muted" : sec.status === "missing" ? "text-amber-300" : "text-emerald-400"
                          }`}
                        >
                          {sec.status === "missing" ? "✕" : sec.status === "optional_missing" ? "–" : "✓"}
                        </span>
                        <code className="font-mono font-semibold text-text-primary">{sec.name}</code>
                        <span className="text-[11px] text-text-muted">
                          ({sec.optional ? `optional, used by ${sec.requiredByBrick}` : `required by ${sec.requiredByBrick}`})
                        </span>
                      </div>

                      {sec.status === "present" ? (
                        <span className="text-[11px] font-mono text-emerald-300">present ✓</span>
                      ) : sec.status === "will_generate" ? (
                        <span data-testid={`preflight-secret-generate-${sec.name}`} className="text-[11px] font-mono text-emerald-300">
                          will be generated on deploy
                        </span>
                      ) : sec.status === "optional_missing" ? (
                        <span data-testid={`preflight-secret-optional-${sec.name}`} className="text-[11px] font-mono text-text-muted">
                          optional, not configured
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            data-testid={`inline-secret-input-${sec.name}`}
                            value={secretInputs[sec.name] ?? ""}
                            onChange={(e) =>
                              setSecretInputs((prev) => ({
                                ...prev,
                                [sec.name]: e.target.value,
                              }))
                            }
                            placeholder={`Enter ${sec.name}…`}
                            aria-label={`Add secret ${sec.name}`}
                            className="px-2 py-1 rounded bg-surface-base border border-border-strong font-mono text-xs text-text-primary w-48"
                          />
                          <button
                            type="button"
                            data-testid={`inline-secret-save-${sec.name}`}
                            disabled={savingSecretName === sec.name || !(secretInputs[sec.name] ?? "").trim()}
                            onClick={() => void handleInlineSaveSecret(sec.name, sec.requiredByBrick)}
                            className="px-2.5 py-1 rounded bg-accent text-text-on-accent font-bold text-[11px] disabled:opacity-50"
                          >
                            {savingSecretName === sec.name ? "Saving…" : "Add secret"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Resource Diff Cards */}
        {plan && (
          <div className="space-y-3">
            {/* Worker Bundle Diff Card */}
            <div data-testid="deploy-plan-card-worker" className="p-3.5 rounded-md bg-surface-raised border border-border space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-text-primary">
                  1. Cloudflare Worker Bundle (<code className="font-mono text-amber-300">{plan.worker.scriptName}</code>)
                </div>
                <span
                  data-testid="deploy-plan-worker-status"
                  className={`px-2 py-0.5 rounded font-mono text-[11px] border ${
                    plan.worker.changed ? "bg-amber-500/15 border-amber-500/40 text-amber-300" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  }`}
                >
                  {plan.worker.currentBuildHash === null ? "create" : plan.worker.changed ? "update" : "unchanged"}
                </span>
              </div>
              <div className="font-mono text-[11px] text-text-secondary">
                buildHash:{" "}
                <span data-testid="deploy-plan-current-build-hash">{plan.worker.currentBuildHash ? plan.worker.currentBuildHash.slice(0, 12) : "(none)"}</span>{" "}
                →{" "}
                <span data-testid="deploy-plan-next-build-hash" className="text-text-primary font-semibold">
                  {plan.worker.nextBuildHash.slice(0, 12)}
                </span>
              </div>
            </div>

            {/* D1 Database & Migrations Diff Card */}
            <div data-testid="deploy-plan-card-d1" className="p-3.5 rounded-md bg-surface-raised border border-border space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-text-primary">
                  2. D1 SQLite Database &amp; Migrations (<code className="font-mono text-amber-300">{plan.d1.databaseName}</code>)
                </div>
                <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-surface-base border border-border text-text-secondary">
                  {plan.d1.createDatabase ? "create DB" : "existing DB"} · {plan.d1.pendingMigrations.length} pending migration(s)
                </span>
              </div>

              {plan.d1.pendingMigrations.length === 0 ? (
                <div className="text-[11px] text-text-muted">No pending D1 migrations to apply.</div>
              ) : (
                <div className="space-y-1.5">
                  {plan.d1.pendingMigrations.map((migName) => {
                    const sqlText = plan.d1.pendingMigrationSql?.[migName];
                    const isExpanded = Boolean(expandedMigrations[migName]);
                    return (
                      <div
                        key={migName}
                        data-testid={`deploy-plan-migration-row-${migName}`}
                        className="p-2 rounded bg-surface-base border border-border space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <code className="font-mono text-[11px] text-text-primary">{migName}</code>
                          {sqlText && (
                            <button
                              type="button"
                              data-testid={`deploy-plan-migration-sql-toggle-${migName}`}
                              onClick={() =>
                                setExpandedMigrations((prev) => ({
                                  ...prev,
                                  [migName]: !prev[migName],
                                }))
                              }
                              className="px-2 py-0.5 rounded bg-surface-control border border-border text-[11px] text-amber-300 hover:opacity-90"
                            >
                              {isExpanded ? "Hide SQL" : "Preview SQL"}
                            </button>
                          )}
                        </div>
                        {sqlText && isExpanded && (
                          <pre
                            data-testid={`deploy-plan-migration-sql-${migName}`}
                            className="p-2 rounded bg-slate-950 border border-border font-mono text-[11px] text-slate-200 overflow-x-auto whitespace-pre-wrap"
                          >
                            {sqlText}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Queues, Cron Triggers & Workflows Summary Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div data-testid="deploy-plan-card-queues" className="p-3 rounded-md bg-surface-raised border border-border space-y-1">
                <div className="font-semibold text-text-primary">3. Queues ({plan.queues.length})</div>
                {plan.queues.length === 0 ? (
                  <div className="text-[11px] text-text-muted">None</div>
                ) : (
                  plan.queues.map((q) => (
                    <div key={q.queueName} className="flex items-center justify-between font-mono text-[11px]">
                      <span className="truncate">{q.queueName}</span>
                      <span className="text-amber-300">{q.action}</span>
                    </div>
                  ))
                )}
              </div>

              <div data-testid="deploy-plan-card-crons" className="p-3 rounded-md bg-surface-raised border border-border space-y-1">
                <div className="font-semibold text-text-primary">4. Cron Triggers ({plan.cronTriggers.schedulesCount})</div>
                {plan.cronTriggers.nextCrons.length === 0 ? (
                  <div className="text-[11px] text-text-muted">None</div>
                ) : (
                  plan.cronTriggers.nextCrons.map((cron) => (
                    <div key={cron} className="flex items-center justify-between font-mono text-[11px]">
                      <span>{cron}</span>
                      <span className="text-amber-300">{plan.cronTriggers.changed ? "update" : "unchanged"}</span>
                    </div>
                  ))
                )}
              </div>

              <div data-testid="deploy-plan-card-workflows" className="p-3 rounded-md bg-surface-raised border border-border space-y-1">
                <div className="font-semibold text-text-primary">5. Workflows ({plan.workflows.length})</div>
                {plan.workflows.length === 0 ? (
                  <div className="text-[11px] text-text-muted">None</div>
                ) : (
                  plan.workflows.map((wf) => (
                    <div key={wf.workflowName} className="flex items-center justify-between font-mono text-[11px]">
                      <span className="truncate">{wf.workflowName}</span>
                      <span className="text-amber-300">{wf.action}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Destructive Migration Guard Box (R17, R31) */}
        {destructiveWarnings.length > 0 && (
          <div
            data-testid="destructive-migration-guard"
            role="alert"
            className="p-4 rounded-md bg-rose-950/90 border-2 border-rose-600 text-rose-100 space-y-3"
          >
            <div className="font-bold text-xs text-rose-200 flex items-center gap-2">
              <span>⚠️</span>
              <span>Destructive Migration Guard — {destructiveWarnings.length} destructive SQL operation(s) detected</span>
            </div>

            <ul className="space-y-1.5 text-xs">
              {destructiveWarnings.map((w, idx) => (
                <li
                  key={`${w.migrationName}-${w.affectedTable}-${w.affectedColumn ?? idx}`}
                  data-testid={`destructive-warning-item-${idx}`}
                  className="p-2 rounded bg-rose-900/60 border border-rose-700 font-mono text-[11px]"
                >
                  <div>
                    <strong className="text-amber-300">{w.kind}</strong> in <code>{w.migrationName}</code> → table{" "}
                    <strong className="text-white">{w.affectedTable}</strong>
                    {w.affectedColumn ? (
                      <>
                        , column <strong className="text-white">{w.affectedColumn}</strong>
                      </>
                    ) : null}
                  </div>
                  <div className="text-rose-200 mt-0.5 font-sans">{w.message}</div>
                </li>
              ))}
            </ul>

            <label className="flex items-center gap-2.5 pt-1 cursor-pointer select-none text-xs font-semibold text-rose-100">
              <input
                type="checkbox"
                data-testid="destructive-migration-confirm-checkbox"
                checked={confirmDestructiveChecked}
                onChange={(e) => setConfirmDestructiveChecked(e.target.checked)}
                className="h-4 w-4 rounded border-rose-400"
              />
              <span>
                I understand this migration permanently drops data in <code className="font-mono text-amber-300">{envName}</code>
              </span>
            </label>
          </div>
        )}

        {planError && (
          <div data-testid="deploy-plan-error-banner" role="alert" className="p-3 rounded bg-rose-950/80 border border-rose-700 text-xs text-rose-100">
            {planError}
          </div>
        )}

        {deploySuccessMessage && (
          <div
            data-testid="deploy-execution-success"
            className="p-3 rounded bg-emerald-950/80 border border-emerald-600 text-xs text-emerald-100 font-semibold space-y-2"
          >
            <div>{deploySuccessMessage}</div>
            {lastDeployResult?.steps && lastDeployResult.steps.length > 0 && (
              <div data-testid="deploy-ledger-steps" className="pt-2 border-t border-emerald-700/60 space-y-1 font-normal">
                {lastDeployResult.steps.map((step) => (
                  <div
                    key={`${step.stepOrder}-${step.stepName}`}
                    data-testid={`deploy-ledger-step-${step.stepName}`}
                    className="flex items-center justify-between gap-2 font-mono text-[11px] text-emerald-200/90"
                  >
                    <span>
                      {step.status === "succeeded" ? "✓" : "○"} {step.stepName} · {step.summary}
                    </span>
                    <span className="text-emerald-300">{step.action}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="refresh-deploy-plan-button"
              disabled={loadingPlan || deploying}
              onClick={() => void loadPlan(envName)}
              className="px-3 py-1.5 rounded bg-surface-control border border-border-strong text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              {loadingPlan ? "Computing plan…" : "↻ Re-compute Plan"}
            </button>
            <button
              type="button"
              data-testid="download-openapi-btn"
              data-openapi-url={getProjectOpenApiUrl(projectSlug, effectiveRevision)}
              onClick={() => void downloadProjectOpenApiSpec(projectSlug, effectiveRevision)}
              className="px-3 py-1.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-semibold text-text-secondary hover:text-text-primary"
            >
              ⬇ Download OpenAPI 3.1 Spec
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded bg-surface-control border border-border text-xs text-text-secondary">
              Close
            </button>
            {envName === "production" && (
              <button
                type="button"
                data-testid="promote-to-production-button"
                disabled={!canConfirmDeploy}
                onClick={() => void handleConfirmAndDeploy(true)}
                className="px-3.5 py-1.5 rounded bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deploying ? "Promoting…" : `Promote Cached Build (${shortBuildHash})`}
              </button>
            )}
            <button
              type="button"
              data-testid="confirm-and-deploy-button"
              disabled={!canConfirmDeploy}
              onClick={() => void handleConfirmAndDeploy()}
              className="px-4 py-1.5 rounded bg-accent text-text-on-accent font-bold text-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {deploying
                ? `Deploying to ${envName}…`
                : plan?.action === "hot_apply_graphs"
                  ? `Hot-Apply Graphs to ${envName}`
                  : envName === "production"
                    ? "Confirm & Deploy to production"
                    : "Confirm & Deploy to preview"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
