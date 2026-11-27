import { useEffect } from "react";
import { getActiveRole, useStudioStore } from "../store.ts";
import type { ApprovalRequestRecord } from "../api.ts";

// AD-V8: destructive actions an MCP agent asked for (deploy, promote, rollback, revert, sandbox deploy, promote to your
// account) wait here until an editor approves or rejects them. Approving does not run the action: the agent retries with
// the approval id, so the run stays attributed to the agent and the audit log shows who approved it.

const POLL_MS = 2000;

const ACTION_LABELS: Record<ApprovalRequestRecord["action"], string> = {
  deploy: "Deploy",
  promote: "Promote",
  rollback: "Roll back",
  revert: "Revert blueprint",
  sandbox_deploy: "Deploy sandbox",
  promote_to_byoc: "Promote to your Cloudflare account",
  import: "Import (replace blueprint)",
};

interface DiffSection {
  added?: string[];
  removed?: string[];
  updated?: string[];
}

/** A names-only semantic diff (as the server records it) as one line per changed area. */
function diffLines(diff: unknown): string[] {
  if (!diff || typeof diff !== "object") return [];
  const d = diff as Record<string, unknown>;
  if (d.isEmpty === true) return ["no blueprint change"];
  const lines: string[] = [];
  for (const area of ["bricks", "entities", "workflows", "secretRefs"]) {
    const sec = d[area] as DiffSection | undefined;
    if (!sec) continue;
    const parts: string[] = [];
    if (sec.added?.length) parts.push(`+${sec.added.join(", +")}`);
    if (sec.removed?.length) parts.push(`-${sec.removed.join(", -")}`);
    if (sec.updated?.length) parts.push(`~${sec.updated.join(", ~")}`);
    if (parts.length) lines.push(`${area}: ${parts.join(" ")}`);
  }
  const identity = d.identity as { from?: string; to?: string } | null | undefined;
  if (identity) lines.push(`identity: ${identity.from} → ${identity.to}`);
  return lines;
}

const short = (hash: unknown) => (typeof hash === "string" ? hash.slice(0, 12) : "?");

function age(createdAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(createdAt)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** What the reviewer is approving, from the plan or request recorded when the agent asked. */
function summaryLines(approval: ApprovalRequestRecord): string[] {
  const s = approval.summary;
  const lines: string[] = [];
  if (typeof s.planAction === "string") lines.push(`plan: ${s.planAction}`);
  if (typeof s.revision === "number")
    lines.push(`blueprint r${s.revision}${typeof s.deployedRev === "number" ? ` (live: r${s.deployedRev})` : " (nothing live yet)"}`);
  if (Array.isArray(s.migrations) && s.migrations.length > 0) {
    for (const m of s.migrations as Array<{ name: string; sha256: string; bytes: number; destructive: boolean }>) {
      lines.push(`migration ${m.name}: ${m.bytes} B sql ${short(m.sha256)}${m.destructive ? " DESTRUCTIVE" : ""}`);
    }
  } else if (Array.isArray(s.pendingMigrations) && s.pendingMigrations.length > 0) {
    lines.push(`migrations: ${(s.pendingMigrations as string[]).join(", ")}`);
  }
  if (s.confirmDestructive === true) lines.push("destructive migrations confirmed by the agent");
  if (typeof s.destructiveWarnings === "number" && s.destructiveWarnings > 0) lines.push(`${s.destructiveWarnings} destructive migration warning(s)`);
  if (typeof s.targetRevision === "number") lines.push(`back to r${s.targetRevision} (from r${approval.blueprintRev})`);
  if (typeof s.mode === "string" && approval.action === "import") lines.push(`import (${s.mode}) over r${approval.blueprintRev}`);
  lines.push(...diffLines(s.diff));
  if (s.from && typeof s.from === "object") {
    const f = s.from as { deploymentId?: string; codeHash?: string; buildHash?: string };
    lines.push(`from ${f.deploymentId} (code ${short(f.codeHash)}, build ${short(f.buildHash)})`);
  }
  if (s.to && typeof s.to === "object") {
    const t = s.to as { deploymentId?: string; codeHash?: string; buildHash?: string };
    lines.push(`to ${t.deploymentId} (code ${short(t.codeHash)}, build ${short(t.buildHash)})`);
  } else if (typeof s.targetDeploymentId === "string") {
    lines.push(`to deployment ${s.targetDeploymentId}`);
  }
  if (typeof s.accountId === "string") {
    lines.push(`account ${typeof s.accountName === "string" ? `${s.accountName} ` : ""}(${s.accountId}) via ${String(s.token ?? "?")}`);
  }
  if (s.deployProduction === true) lines.push("also deploys production");
  if (typeof s.buildHash === "string") lines.push(`build ${short(s.buildHash)}`);
  if (lines.length === 0) lines.push(`blueprint r${approval.blueprintRev}`);
  return lines;
}

export function PendingApprovals() {
  const activeProjectId = useStudioStore((s) => s.activeProjectId);
  const approvals = useStudioStore((s) => s.approvals);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const loadProjectApprovals = useStudioStore((s) => s.loadProjectApprovals);
  const decideApproval = useStudioStore((s) => s.decideApproval);

  useEffect(() => {
    if (!activeProjectId) return;
    void loadProjectApprovals();
    const timer = window.setInterval(() => void loadProjectApprovals(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeProjectId, loadProjectApprovals]);

  const pending = approvals.filter((a) => a.status === "pending");
  if (pending.length === 0) return null;
  const canDecide = getActiveRole({ orgs, activeOrgId }) !== "viewer";
  const now = Date.now();

  return (
    <section
      role="region"
      aria-label="Pending approvals"
      data-testid="pending-approvals"
      className="px-4 py-2.5 bg-rose-950/70 border-b border-rose-400/50 text-xs space-y-2"
    >
      <div className="font-bold text-rose-100">
        {pending.length} agent request{pending.length === 1 ? "" : "s"} waiting for approval
      </div>
      <ul className="space-y-2">
        {pending.map((approval) => (
          <li
            key={approval.approvalId}
            data-testid={`approval-${approval.approvalId}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded border border-rose-400/30 bg-slate-950/60 px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="approval-action" className="font-bold text-text-primary">
                {ACTION_LABELS[approval.action] ?? approval.action}
                {approval.env ? ` → ${approval.env}` : ""}
              </span>
              <span
                data-testid="approval-requested-by"
                className="px-2 py-0.5 rounded bg-violet-500/20 border border-violet-400/50 text-violet-200 font-mono text-[11px]"
              >
                agent: {approval.requestedBy.clientName ?? approval.requestedBy.tokenId}
              </span>
              <span className="font-mono text-[11px] text-text-muted">{age(approval.createdAt, now)}</span>
              <ul data-testid="approval-summary" className="font-mono text-[11px] text-text-secondary w-full">
                {summaryLines(approval).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
            {canDecide ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="approval-approve"
                  onClick={() => void decideApproval(approval.approvalId, "approve")}
                  className="px-3 py-1 rounded bg-emerald-400 text-slate-950 font-bold hover:bg-emerald-300 transition"
                >
                  Approve
                </button>
                <button
                  type="button"
                  data-testid="approval-reject"
                  onClick={() => void decideApproval(approval.approvalId, "reject")}
                  className="px-3 py-1 rounded bg-surface-base border border-rose-400/60 text-rose-200 font-bold hover:bg-rose-900/60 transition"
                >
                  Reject
                </button>
              </div>
            ) : (
              <span className="text-text-muted">An editor must approve this.</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
