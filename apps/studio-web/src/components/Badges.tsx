import { useState } from "react";
import { formatMaturityBadge } from "../types.ts";
import type { BrickMaturity, DisplayMaturity } from "../types.ts";
import { humanizeBlocker } from "./tier-blockers.ts";

export interface AuthorBadgeProps {
  testId: string;
  authorLabel: string;
  isAgent: boolean;
}

export function AuthorBadge({ testId, authorLabel, isAgent }: AuthorBadgeProps) {
  return (
    <span
      data-testid={testId}
      className="px-2 py-0.5 rounded bg-sky-400/15 border border-sky-400/30 text-sky-300 font-mono text-[10px]"
    >
      {isAgent ? "🤖 " : "👤 "}
      {authorLabel}
    </span>
  );
}

export interface MaturityBadgeProps {
  testId: string;
  tier?: BrickMaturity;
  derivedTier?: BrickMaturity;
  blockers?: string[];
  reason?: string;
  evidence?: {
    gitSha?: string;
    runAt?: string;
    assertionCount?: number;
    liveVerifiedAt?: string | null;
    fidelity?: unknown;
  };
  isIntegration?: boolean;
}

export function MaturityBadge({
  testId,
  tier,
  derivedTier,
  blockers = [],
  reason,
  evidence,
  isIntegration,
}: MaturityBadgeProps) {
  const [open, setOpen] = useState(false);

  let effectiveTier: DisplayMaturity;
  if (derivedTier) {
    effectiveTier = derivedTier;
  } else if (evidence?.gitSha) {
    effectiveTier = tier === "production" ? "unverified" : (tier ?? "experimental");
  } else if (tier === "beta") {
    effectiveTier = "beta";
  } else if (tier === "experimental") {
    effectiveTier = "experimental";
  } else {
    effectiveTier = "unverified";
  }

  const maturity = formatMaturityBadge(effectiveTier);
  const badgeClasses =
    maturity.tier === "production"
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
      : maturity.tier === "beta"
        ? "bg-sky-400/15 text-sky-300 border-sky-400/30"
        : maturity.tier === "experimental"
          ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
          : "bg-slate-500/20 text-slate-300 border-slate-500/40";

  const shortSha = evidence?.gitSha ? evidence.gitSha.slice(0, 7) : null;
  const verifiedDate = evidence?.runAt
    ? new Date(evidence.runAt).toISOString().split("T")[0]
    : null;
  const liveCheckDate = evidence?.liveVerifiedAt
    ? new Date(evidence.liveVerifiedAt).toISOString().split("T")[0]
    : null;

  return (
    <div className="relative inline-block">
      <span
        data-testid={testId}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            setOpen((v) => !v);
          }
        }}
        title={reason ?? `${maturity.label} tier brick`}
        className={`shrink-0 px-2 py-0.5 rounded border text-[10px] font-bold cursor-pointer select-none ${badgeClasses}`}
      >
        {maturity.textWithIcon}
      </span>

      {open && (
        <div
          data-testid={`${testId}-details`}
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full mt-1 z-50 w-64 p-3 rounded-lg bg-surface-raised border border-border shadow-xl text-left text-xs space-y-2 font-normal"
        >
          <div className="flex items-center justify-between border-b border-border pb-1 font-bold text-text-primary text-[11px]">
            <span>{maturity.label} Tier Evidence</span>
            <button
              type="button"
              className="text-text-muted hover:text-text-primary text-[10px] px-1"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            >
              ✕
            </button>
          </div>

          <div className="space-y-1 text-[11px] text-text-secondary">
            {shortSha ? (
              <div>
                {`Verified at ${shortSha}${verifiedDate ? ` on ${verifiedDate}` : ""}`}
              </div>
            ) : (
              <div className="text-amber-300">Unverified (no run evidence)</div>
            )}

            {evidence?.assertionCount !== undefined && (
              <div>Assertions: {evidence.assertionCount}</div>
            )}

            {(isIntegration || evidence?.liveVerifiedAt !== undefined) && (
              <div>
                {liveCheckDate ? (
                  <span>Live check: {liveCheckDate}</span>
                ) : (
                  <span className="text-amber-300">Never live-checked</span>
                )}
              </div>
            )}

            {blockers.length > 0 && (
              <div className="pt-1 border-t border-border space-y-1">
                <div className="font-semibold text-amber-300 text-[10px] uppercase tracking-wider">
                  Blockers:
                </div>
                <ul className="list-disc pl-4 space-y-0.5 text-text-muted text-[11px]">
                  {blockers.map((b, idx) => (
                    <li key={`${b}-${idx}`}>{humanizeBlocker(b)}</li>
                  ))}
                </ul>
              </div>
            )}

            {reason && (
              <div className="pt-1 text-[10px] text-text-muted italic border-t border-border">
                {reason}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
