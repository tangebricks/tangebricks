import { useEffect, useState } from "react";
import { rollbackProjectEnvironment } from "../api.ts";
import type { DeployPlanPayload, EnvironmentDeploymentRecordPayload, ProjectDeployEnvironmentRecord } from "../api.ts";

export interface RollbackModalProps {
  open: boolean;
  projectSlug: string;
  orgId: string;
  envName: "preview" | "production";
  targetDeployment: EnvironmentDeploymentRecordPayload | null;
  currentDeployment?: EnvironmentDeploymentRecordPayload | null;
  onClose: () => void;
  onRolledBack?: (result: {
    deployId?: string;
    rollbackFromDeploymentId: string | null;
    targetDeploymentId: string;
    revision?: number;
    buildHash?: string;
    environment?: ProjectDeployEnvironmentRecord;
  }) => void;
}

export function RollbackModal({ open, projectSlug, orgId, envName, targetDeployment, currentDeployment, onClose, onRolledBack }: RollbackModalProps) {
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [plan, setPlan] = useState<DeployPlanPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [rolledBackSuccess, setRolledBackSuccess] = useState<{
    deployId?: string;
    rollbackFromDeploymentId: string | null;
    revision?: number;
    buildHash?: string;
    statusMessage?: string;
  } | null>(null);

  useEffect(() => {
    if (!open || !targetDeployment || !projectSlug) return;
    let cancelled = false;
    setLoadingPlan(true);
    setErrorMessage(null);
    setConfirmDestructive(false);
    setRolledBackSuccess(null);

    void rollbackProjectEnvironment(projectSlug, envName, {
      targetDeploymentId: targetDeployment.deployId,
      dryRun: true,
      orgId,
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setPlan(res.plan);
        } else {
          setErrorMessage(res.error.message);
          if (res.plan) {
            setPlan(res.plan);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : "Failed to load rollback diff plan");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingPlan(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectSlug, orgId, envName, targetDeployment]);

  if (!open || !targetDeployment) return null;

  const destructiveWarnings = plan?.d1.destructiveWarnings ?? [];
  const hasDestructiveWarnings = destructiveWarnings.length > 0;
  const requiredMigrationNames = Array.from(new Set(destructiveWarnings.map((w) => w.migrationName)));
  const canConfirm = !loadingPlan && !executing && (!hasDestructiveWarnings || confirmDestructive);

  const handleConfirmRollback = async () => {
    if (!canConfirm) return;
    setExecuting(true);
    setErrorMessage(null);
    try {
      const res = await rollbackProjectEnvironment(projectSlug, envName, {
        targetDeploymentId: targetDeployment.deployId,
        confirmDestructive: hasDestructiveWarnings ? confirmDestructive : undefined,
        confirmedMigrationNames: hasDestructiveWarnings && confirmDestructive ? requiredMigrationNames : undefined,
        orgId,
      });

      if (!res.ok) {
        setErrorMessage(res.error.message);
        if (res.plan) {
          setPlan(res.plan);
        }
        return;
      }

      setRolledBackSuccess({
        deployId: res.deployId,
        rollbackFromDeploymentId: res.rollbackFromDeploymentId,
        revision: res.revision ?? targetDeployment.revision,
        buildHash: res.buildHash ?? targetDeployment.buildHash,
        statusMessage: res.statusMessage ?? `Rolled back to r${targetDeployment.revision}`,
      });
      onRolledBack?.({
        deployId: res.deployId,
        rollbackFromDeploymentId: res.rollbackFromDeploymentId,
        targetDeploymentId: targetDeployment.deployId,
        revision: res.revision ?? targetDeployment.revision,
        buildHash: res.buildHash ?? targetDeployment.buildHash,
        environment: res.environment,
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to execute rollback");
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Roll back ${envName} environment`}
      data-testid="rollback-confirmation-modal"
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="w-full max-w-2xl rounded-lg bg-surface-raised border border-border-strong p-5 space-y-4 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <span>↶</span>
              <span>
                Roll back {envName} to {targetDeployment.versionLabel} (r
                {targetDeployment.revision})
              </span>
            </h2>
            <p className="text-xs text-text-secondary mt-1">
              Redeploys cached build{" "}
              <code data-testid="rollback-target-build-hash" className="font-mono text-amber-300">
                {targetDeployment.buildHash.slice(0, 14)}
              </code>{" "}
              and restores workflow graphs &amp; schedules without rebuilding from scratch.
            </p>
          </div>
          <button
            type="button"
            data-testid="close-rollback-modal"
            onClick={onClose}
            className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 text-xs text-text-secondary"
          >
            ✕
          </button>
        </div>

        {/* Version transition summary */}
        <div
          data-testid="rollback-diff-summary"
          className="p-3 rounded bg-surface-base border border-border flex items-center justify-between gap-3 flex-wrap text-xs"
        >
          <div className="space-y-0.5">
            <div className="text-text-muted">Currently Deployed</div>
            <div className="font-mono font-semibold text-text-primary">
              {currentDeployment
                ? `${currentDeployment.versionLabel} · r${currentDeployment.revision} (${currentDeployment.buildHash.slice(0, 10)})`
                : "Current active deployment"}
            </div>
          </div>
          <span className="text-amber-300 font-bold">→ Roll back to →</span>
          <div className="space-y-0.5">
            <div className="text-text-muted">Target Historical Deployment</div>
            <div data-testid="rollback-target-summary" className="font-mono font-semibold text-emerald-300">
              {targetDeployment.versionLabel} · r{targetDeployment.revision} ({targetDeployment.buildHash.slice(0, 10)})
            </div>
          </div>
        </div>

        {loadingPlan && (
          <div data-testid="rollback-plan-loading" className="p-4 rounded bg-surface-base border border-border text-xs text-text-secondary">
            Computing rollback diff against current {envName} state…
          </div>
        )}

        {errorMessage && (
          <div role="alert" data-testid="rollback-error-banner" className="p-3 rounded bg-rose-950/80 border border-rose-700 text-rose-200 text-xs">
            ✕ {errorMessage}
          </div>
        )}

        {plan && (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div data-testid="rollback-worker-diff-card" className="p-3 rounded bg-surface-base border border-border space-y-1">
                <div className="font-semibold text-text-primary flex items-center justify-between">
                  <span>Worker Bundle ({plan.worker.scriptName})</span>
                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[10px]">Cached Build Reused</span>
                </div>
                <div className="font-mono text-[11px] text-text-secondary">
                  Code: {(plan.worker.currentCodeHash ?? "none").slice(0, 10)} → {(plan.worker.nextCodeHash ?? targetDeployment.codeHash).slice(0, 10)}
                </div>
                <div className="font-mono text-[11px] text-text-secondary">
                  Graph: {(plan.worker.currentGraphHash ?? "none").slice(0, 10)} → {(plan.worker.nextGraphHash ?? targetDeployment.graphHash).slice(0, 10)}
                </div>
              </div>

              <div data-testid="rollback-workflows-diff-card" className="p-3 rounded bg-surface-base border border-border space-y-1">
                <div className="font-semibold text-text-primary">Workflows &amp; Schedules ({plan.d1.databaseName})</div>
                <div className="text-text-secondary">
                  Workflows: {plan.workflows.length === 0 ? "0 workflows" : plan.workflows.map((w) => `${w.workflowName} (${w.action})`).join(", ")}
                </div>
                <div className="text-text-secondary">
                  Cron schedules: {plan.cronTriggers.currentCrons.length} → {plan.cronTriggers.nextCrons.length}
                </div>
              </div>
            </div>

            {hasDestructiveWarnings && (
              <div data-testid="rollback-destructive-migration-guard" className="p-3.5 rounded bg-amber-950/70 border border-amber-600/70 space-y-2.5">
                <div className="font-bold text-amber-200 flex items-center gap-2">
                  <span>⚠</span>
                  <span>Destructive Schema Downgrade / Applied Migration Warning</span>
                </div>
                <p className="text-amber-100/90 text-[11px]">
                  The current {envName} environment has applied D1 migrations or schema tables/columns that do not exist in{" "}
                  <strong>
                    {targetDeployment.versionLabel} (r
                    {targetDeployment.revision})
                  </strong>
                  :
                </p>
                <ul className="list-disc list-inside space-y-1 font-mono text-[11px] text-amber-200">
                  {destructiveWarnings.map((w, i) => (
                    <li key={`${w.migrationName}:${i}`} data-testid={`rollback-destructive-warning-${i}`}>
                      [{w.kind}] {w.migrationName}: {w.message}
                    </li>
                  ))}
                </ul>
                <label className="flex items-center gap-2 pt-1 cursor-pointer text-amber-100 font-semibold">
                  <input
                    type="checkbox"
                    data-testid="rollback-confirm-destructive-checkbox"
                    checked={confirmDestructive}
                    onChange={(e) => setConfirmDestructive(e.target.checked)}
                    className="rounded border-amber-500"
                  />
                  <span>I understand this rollback crosses destructive schema or D1 migration boundaries and confirm proceeding.</span>
                </label>
              </div>
            )}
          </div>
        )}

        {rolledBackSuccess && (
          <div data-testid="rollback-success-banner" className="p-3 rounded bg-emerald-950/80 border border-emerald-600 text-emerald-200 text-xs space-y-1">
            <div className="font-bold">
              ✓ {rolledBackSuccess.statusMessage} (Cached artifact <code className="font-mono">{rolledBackSuccess.buildHash?.slice(0, 12)}</code>)
            </div>
            {rolledBackSuccess.rollbackFromDeploymentId && (
              <div className="font-mono text-[11px] text-emerald-300">
                Recorded new deployment {rolledBackSuccess.deployId} (rolled back from {rolledBackSuccess.rollbackFromDeploymentId})
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <button
            type="button"
            data-testid="cancel-rollback-button"
            onClick={onClose}
            className="px-3 py-1.5 rounded bg-surface-control border border-border text-xs text-text-secondary"
          >
            {rolledBackSuccess ? "Close" : "Cancel"}
          </button>
          {!rolledBackSuccess && (
            <button
              type="button"
              data-testid="confirm-rollback-button"
              disabled={!canConfirm}
              onClick={() => void handleConfirmRollback()}
              className="px-3.5 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {executing ? "Rolling back…" : `Confirm Rollback to ${targetDeployment.versionLabel} (r${targetDeployment.revision})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
