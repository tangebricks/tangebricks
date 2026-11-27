import { getActiveRole, useStudioStore } from "../store.ts";
import { formatAuthorBadge } from "../types.ts";
import type { Op } from "@poc/blueprint";
import { AuthorBadge } from "./Badges.tsx";

function describeOpTarget(op: Op): { badge: "added" | "changed" | "removed"; label: string } {
  switch (op.type) {
    case "enable_brick":
      return { badge: "added", label: `enable_brick: ${op.brickId}` };
    case "configure_brick":
      return { badge: "changed", label: `configure_brick: ${op.brickId}` };
    case "remove_brick":
      return { badge: "removed", label: `remove_brick: ${op.brickId}` };
    case "add_entity":
      return { badge: "added", label: `add_entity: ${op.entity.name}` };
    case "update_entity":
      return { badge: "changed", label: `update_entity: ${op.entity.name}` };
    case "remove_entity":
      return { badge: "removed", label: `remove_entity: ${op.name}` };
    case "add_workflow":
      return { badge: "added", label: `add_workflow: ${op.workflow.id}` };
    case "remove_workflow":
      return { badge: "removed", label: `remove_workflow: ${op.workflowId}` };
    case "add_node":
      return {
        badge: "added",
        label: `add_node: ${op.node.id} (${op.node.type}) in ${op.workflowId}`,
      };
    case "update_node":
      return {
        badge: "changed",
        label: `update_node: ${op.nodeId} in ${op.workflowId}`,
      };
    case "remove_node":
      return {
        badge: "removed",
        label: `remove_node: ${op.nodeId} from ${op.workflowId}`,
      };
    case "connect_edges":
      return {
        badge: "added",
        label: `connect_edges (${op.edges.length}) in ${op.workflowId}`,
      };
    case "disconnect_edge":
      return {
        badge: "removed",
        label: `disconnect_edge: ${op.edgeId} from ${op.workflowId}`,
      };
    case "set_identity":
      return { badge: "changed", label: `set_identity: ${op.identity}` };
    case "bind_secret_ref":
      return {
        badge: "added",
        label: `bind_secret_ref: ${op.ref} → ${op.targetId}.${op.secretName}`,
      };
    case "unbind_secret_ref":
      return {
        badge: "removed",
        label: `unbind_secret_ref: ${op.targetId}.${op.secretName}`,
      };
    case "set_metadata":
      return { badge: "changed", label: "set_metadata" };
    default: {
      const unknownOp = op as { type?: string };
      return { badge: "changed", label: unknownOp.type ?? "op" };
    }
  }
}

export function ProposalReviewBar() {
  const proposals = useStudioStore((s) => s.proposals);
  const activeProposalId = useStudioStore((s) => s.activeProposalId);
  const selectedProposalOpIds = useStudioStore((s) => s.selectedProposalOpIds);
  const proposalValidationError = useStudioStore((s) => s.proposalValidationError);
  const isMutating = useStudioStore((s) => s.isMutating);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const activeNav = useStudioStore((s) => s.activeNav);

  const startProposalReview = useStudioStore((s) => s.startProposalReview);
  const toggleProposalOp = useStudioStore((s) => s.toggleProposalOp);
  const setAllProposalOpsSelected = useStudioStore((s) => s.setAllProposalOpsSelected);
  const exitProposalReview = useStudioStore((s) => s.exitProposalReview);
  const acceptActiveProposal = useStudioStore((s) => s.acceptActiveProposal);
  const rejectActiveProposal = useStudioStore((s) => s.rejectActiveProposal);
  const setActiveNav = useStudioStore((s) => s.setActiveNav);

  const activeRole = getActiveRole({ orgs, activeOrgId });
  const isViewer = activeRole === "viewer";

  const pendingProposals = proposals.filter((p) => p.status === "pending");
  const activeProposal = proposals.find((p) => p.proposalId === activeProposalId) ?? null;

  if (!activeProposal) {
    if (pendingProposals.length === 0) return null;
    const latest = pendingProposals[0]!;
    const authorInfo = formatAuthorBadge(latest.actor);
    return (
      <div
        role="region"
        aria-label="Pending Draft Proposals"
        data-testid="pending-proposals-banner"
        className="px-4 py-2.5 bg-sky-950/80 border-b border-sky-400/50 text-xs flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            data-testid="pending-proposals-count-badge"
            className="px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400/50 text-sky-200 font-bold font-mono text-[11px]"
          >
            {pendingProposals.length} Pending Proposal
            {pendingProposals.length === 1 ? "" : "s"}
          </span>
          <AuthorBadge testId={`pending-proposal-author-${latest.proposalId}`} authorLabel={authorInfo.displayName} isAgent={authorInfo.isAgent} />
          <span className="font-semibold text-text-primary">{latest.summary}</span>
          <span className="font-mono text-[11px] text-text-muted">
            ({latest.ops.length} op{latest.ops.length === 1 ? "" : "s"} on base r{latest.baseRev})
          </span>
        </div>

        <div className="flex items-center gap-2">
          {pendingProposals.map((prop, idx) => (
            <button
              key={prop.proposalId}
              type="button"
              data-testid={idx === 0 ? "review-latest-proposal-button" : `review-proposal-button-${prop.proposalId}`}
              onClick={() => startProposalReview(prop.proposalId)}
              className="px-3 py-1 rounded bg-sky-400 text-slate-950 font-bold text-xs hover:bg-sky-300 transition"
            >
              Review Visual Diff ({prop.proposalId})
            </button>
          ))}
        </div>
      </div>
    );
  }

  const authorInfo = formatAuthorBadge(activeProposal.actor);
  const totalOps = activeProposal.ops.length;
  const selectedCount = selectedProposalOpIds.length;

  return (
    <section
      aria-label="Proposal Visual Diff Review Bar"
      data-testid="proposal-review-bar"
      className="px-4 py-3 bg-slate-900/95 border-b-2 border-amber-400/70 space-y-3 text-xs shadow-lg"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            data-testid="proposal-review-mode-badge"
            className="px-2.5 py-0.5 rounded bg-amber-500/20 border border-amber-400/60 text-amber-200 font-bold uppercase tracking-wider text-[10px]"
          >
            ☍ Visual Diff Review Mode
          </span>
          <span data-testid="proposal-review-id" className="font-mono font-bold text-accent">
            {activeProposal.proposalId}
          </span>
          <span
            data-testid="proposal-review-base-rev"
            className="px-2 py-0.5 rounded bg-surface-base border border-border font-mono text-[11px] text-text-secondary"
          >
            Base: r{activeProposal.baseRev}
          </span>
          <AuthorBadge testId="proposal-review-author-badge" authorLabel={authorInfo.displayName} isAgent={authorInfo.isAgent} />
          <span data-testid="proposal-review-summary" className="font-bold text-text-primary">
            {activeProposal.summary}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* View Switcher Pills */}
          <div className="flex items-center gap-1 pr-2 border-r border-border">
            <button
              type="button"
              data-testid="proposal-jump-workflows"
              onClick={() => setActiveNav("workflows")}
              className={`px-2 py-1 rounded text-[11px] font-semibold border ${
                activeNav === "workflows" ? "bg-accent/20 border-accent text-accent" : "bg-surface-control border-border text-text-secondary"
              }`}
            >
              Workflows Diff
            </button>
            <button
              type="button"
              data-testid="proposal-jump-bricks"
              onClick={() => setActiveNav("bricks")}
              className={`px-2 py-1 rounded text-[11px] font-semibold border ${
                activeNav === "bricks" ? "bg-accent/20 border-accent text-accent" : "bg-surface-control border-border text-text-secondary"
              }`}
            >
              Bricks Diff
            </button>
            <button
              type="button"
              data-testid="proposal-jump-entities"
              onClick={() => setActiveNav("data")}
              className={`px-2 py-1 rounded text-[11px] font-semibold border ${
                activeNav === "data" ? "bg-accent/20 border-accent text-accent" : "bg-surface-control border-border text-text-secondary"
              }`}
            >
              Entities Diff
            </button>
          </div>

          <button
            type="button"
            data-testid="proposal-accept-all"
            disabled={isViewer || isMutating}
            onClick={() => void acceptActiveProposal(activeProposal.ops.map((op) => op.opId))}
            className="px-3 py-1.5 rounded bg-emerald-500 text-slate-950 font-bold text-xs hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ✓ Accept all ({totalOps})
          </button>

          <button
            type="button"
            data-testid="proposal-accept-selected"
            disabled={isViewer || isMutating || selectedCount === 0 || Boolean(proposalValidationError)}
            onClick={() => void acceptActiveProposal(selectedProposalOpIds)}
            className="px-3 py-1.5 rounded bg-sky-400 text-slate-950 font-bold text-xs hover:bg-sky-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Accept selected ({selectedCount}/{totalOps})
          </button>

          <button
            type="button"
            data-testid="proposal-reject"
            disabled={isViewer || isMutating}
            onClick={() => void rejectActiveProposal("Rejected in Studio Review Bar")}
            className="px-3 py-1.5 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/50 text-rose-200 font-bold text-xs disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ✕ Reject
          </button>

          <button
            type="button"
            data-testid="proposal-exit-review"
            onClick={exitProposalReview}
            className="px-2.5 py-1.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-text-secondary text-xs"
          >
            Exit Review
          </button>
        </div>
      </div>

      {/* Per-Op Checkboxes for Selective Accept + Live Preview */}
      <div data-testid="proposal-ops-list" className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/60">
        <div className="flex items-center gap-1.5 mr-1">
          <span className="text-[11px] font-semibold text-text-muted">
            Operations ({selectedCount}/{totalOps} selected):
          </span>
          <button
            type="button"
            data-testid="proposal-select-all-ops"
            onClick={() => setAllProposalOpsSelected(true)}
            className="px-1.5 py-0.5 rounded bg-surface-control border border-border text-[10px] text-text-secondary hover:text-text-primary"
          >
            All
          </button>
          <button
            type="button"
            data-testid="proposal-deselect-all-ops"
            onClick={() => setAllProposalOpsSelected(false)}
            className="px-1.5 py-0.5 rounded bg-surface-control border border-border text-[10px] text-text-secondary hover:text-text-primary"
          >
            None
          </button>
        </div>

        {activeProposal.ops.map((op, idx) => {
          const checked = selectedProposalOpIds.includes(op.opId);
          const desc = describeOpTarget(op);
          const badgeColor =
            desc.badge === "added"
              ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
              : desc.badge === "removed"
                ? "text-rose-300 border-rose-500/40 bg-rose-500/10"
                : "text-amber-300 border-amber-500/40 bg-amber-500/10";
          const badgeSign = desc.badge === "added" ? "+" : desc.badge === "removed" ? "-" : "~";
          return (
            <label
              key={op.opId}
              data-testid={`proposal-op-item-${op.opId}`}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border font-mono text-[11px] cursor-pointer select-none transition ${
                checked ? badgeColor : "bg-surface-base border-border text-text-muted opacity-60"
              }`}
            >
              <input
                type="checkbox"
                data-testid={`proposal-op-checkbox-${op.opId}`}
                checked={checked}
                onChange={() => toggleProposalOp(op.opId)}
                className="h-3.5 w-3.5 rounded accent-amber-400 cursor-pointer"
              />
              <span className="font-bold">
                [{idx + 1}] {badgeSign}
              </span>
              <span>{desc.label}</span>
            </label>
          );
        })}
      </div>

      {/* Live Validation Error when deselecting a required op breaks a dependent op */}
      {proposalValidationError && (
        <div
          role="alert"
          data-testid="proposal-validation-error"
          className="p-2.5 rounded bg-rose-950/90 border border-rose-500/60 text-rose-200 font-semibold text-xs flex items-center justify-between gap-2"
        >
          <span>✕ Invalid partial operation selection: {proposalValidationError}</span>
          <span className="font-mono text-[10px] text-rose-300 shrink-0">422 VALIDATION_FAILED</span>
        </div>
      )}
    </section>
  );
}
