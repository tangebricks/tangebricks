import { useEffect, useState } from "react";
import { DEFAULT_CLOUDFLARE_TEMPLATE_URL, fetchCloudflareTokenTemplate, postCloudflareFunnelEvent, verifyAndSaveCloudflareToken } from "../api.ts";
import { safeHref } from "../safe-href.ts";
import type { CloudflareAccountChoice, CloudflarePermissionStatusRow, CloudflareTokenMetadataSummary, ProjectDeployEnvironmentRecord } from "../api.ts";

export interface ConnectCloudflareModalProps {
  open: boolean;
  orgId: string;
  projectSlug: string;
  replaceTokenRef?: string | null;
  onClose: () => void;
  onConnected: (payload: { token: CloudflareTokenMetadataSummary; environments: ProjectDeployEnvironmentRecord[] }) => void;
}

const DEFAULT_PERMISSION_ROWS: CloudflarePermissionStatusRow[] = [
  {
    id: "account_settings_read",
    label: "Account Settings: Read",
    required: true,
    granted: false,
    remediationUrl: DEFAULT_CLOUDFLARE_TEMPLATE_URL,
  },
  {
    id: "workers_scripts_edit",
    label: "Workers Scripts: Edit",
    required: true,
    granted: false,
    remediationUrl: DEFAULT_CLOUDFLARE_TEMPLATE_URL,
  },
  {
    id: "d1_edit",
    label: "D1: Edit",
    required: true,
    granted: false,
    remediationUrl: DEFAULT_CLOUDFLARE_TEMPLATE_URL,
  },
  {
    id: "queues_edit",
    label: "Queues: Edit",
    required: true,
    granted: false,
    remediationUrl: DEFAULT_CLOUDFLARE_TEMPLATE_URL,
  },
];

export function ConnectCloudflareModal({ open, orgId, projectSlug, replaceTokenRef, onClose, onConnected }: ConnectCloudflareModalProps) {
  const [templateUrl, setTemplateUrl] = useState(DEFAULT_CLOUDFLARE_TEMPLATE_URL);
  const [tokenInput, setTokenInput] = useState("");
  const [accountIdInput, setAccountIdInput] = useState("");
  const [accountNameInput, setAccountNameInput] = useState("");
  const [availableAccounts, setAvailableAccounts] = useState<CloudflareAccountChoice[]>([]);
  const [permissionRows, setPermissionRows] = useState<CloudflarePermissionStatusRow[]>(DEFAULT_PERMISSION_ROWS);
  const [hasChecked, setHasChecked] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [remediationUrl, setRemediationUrl] = useState(DEFAULT_CLOUDFLARE_TEMPLATE_URL);

  useEffect(() => {
    if (!open || !orgId) return;
    setTokenInput("");
    setHasChecked(false);
    setErrorBanner(null);
    setPermissionRows(DEFAULT_PERMISSION_ROWS);

    void postCloudflareFunnelEvent(orgId, {
      step: "wizard_opened",
      projectId: projectSlug || undefined,
    });

    let cancelled = false;
    void fetchCloudflareTokenTemplate(orgId)
      .then((res) => {
        if (!cancelled && res.templateUrl) {
          setTemplateUrl(res.templateUrl);
          setRemediationUrl(res.templateUrl);
        }
      })
      .catch(() => {
        // Keep default template URL if offline in unit tests
      });

    return () => {
      cancelled = true;
    };
  }, [open, orgId, projectSlug]);

  if (!open) return null;

  const handleTemplateClick = () => {
    void postCloudflareFunnelEvent(orgId, {
      step: "template_link_clicked",
      projectId: projectSlug || undefined,
    });
  };

  const runVerification = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setErrorBanner("Paste your scoped Cloudflare API token to verify permissions.");
      return;
    }

    setIsVerifying(true);
    setErrorBanner(null);
    try {
      const result = await verifyAndSaveCloudflareToken(orgId, {
        token: trimmed,
        accountId: accountIdInput.trim() || undefined,
        accountName: accountNameInput.trim() || undefined,
        projectId: projectSlug || undefined,
        replaceTokenRef: replaceTokenRef || undefined,
      });

      setHasChecked(true);

      if (!result.ok) {
        if (result.verification?.accounts && result.verification.accounts.length > 0) {
          setAvailableAccounts(result.verification.accounts);
        }
        if (result.error.permissions && result.error.permissions.length > 0) {
          setPermissionRows(result.error.permissions);
        } else if (result.verification?.permissions) {
          setPermissionRows(result.verification.permissions);
        }
        if (result.error.remediationUrl) {
          setRemediationUrl(result.error.remediationUrl);
        }
        setErrorBanner(result.error.message);
        return;
      }

      if (result.verification.accounts && result.verification.accounts.length > 0) {
        setAvailableAccounts(result.verification.accounts);
      }
      setPermissionRows(result.verification.permissions);

      // Immediately clear plaintext token from React state on save
      setTokenInput("");

      onConnected({
        token: result.token,
        environments: result.environments,
      });
      onClose();
    } catch (err) {
      setHasChecked(true);
      setErrorBanner(err instanceof Error ? err.message : "Failed to verify Cloudflare token");
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect Cloudflare"
      data-testid="connect-cloudflare-modal"
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
    >
      <div className="w-full max-w-xl rounded-lg bg-surface-raised border border-border-strong shadow-2xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-text-primary flex items-center gap-2">
              <span>☁</span>
              <span>{replaceTokenRef ? "Replace Cloudflare API Token" : "Connect Cloudflare (BYOC)"}</span>
            </h2>
            <p data-testid="cf-wizard-explanation" className="text-xs text-amber-300 font-semibold mt-1">
              Your backend runs in your own Cloudflare account. We never host it.
            </p>
          </div>
          <button
            type="button"
            data-testid="cf-wizard-close-button"
            onClick={onClose}
            className="px-2 py-1 rounded bg-surface-control text-xs text-text-secondary hover:text-text-primary"
          >
            ✕
          </button>
        </div>

        {/* Step 1: Pre-filled Cloudflare Token Template Link */}
        <div className="p-3.5 rounded-md bg-surface-base border border-border space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-xs font-bold text-text-primary">Step 1 · Create a least-privilege scoped API token</div>
              <p className="text-[11px] text-text-secondary mt-0.5">
                Opens Cloudflare with the 4 required permissions pre-selected (<code className="font-mono text-accent">Workers Scripts: Edit</code>,{" "}
                <code className="font-mono text-accent">D1: Edit</code>, <code className="font-mono text-accent">Queues: Edit</code>,{" "}
                <code className="font-mono text-accent">Account Settings: Read</code>
                ).
              </p>
            </div>
            <a
              href={safeHref(templateUrl)}
              target="_blank"
              rel="noreferrer"
              data-testid="cf-create-token-link"
              onClick={handleTemplateClick}
              className="px-3 py-1.5 rounded-md bg-accent text-text-on-accent font-bold text-xs hover:opacity-90 shrink-0"
            >
              Create token in Cloudflare ↗
            </a>
          </div>
        </div>

        {/* Step 2: Token Paste & Account Selection */}
        <form onSubmit={runVerification} className="space-y-4">
          <div>
            <label htmlFor="cf-token-input-field" className="block text-xs font-semibold text-text-secondary mb-1">
              Step 2 · Paste your Cloudflare API Token
            </label>
            <input
              id="cf-token-input-field"
              type="password"
              autoComplete="off"
              data-testid="cf-token-input"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="cf_..."
              className="w-full px-3 py-2 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
            />
            <p className="text-[11px] text-text-muted mt-1">Encrypted at rest with AES-256-GCM envelope encryption. Never exposed to AI agents or logs.</p>
          </div>

          {availableAccounts.length > 1 ? (
            <div>
              <label htmlFor="cf-account-selector-field" className="block text-xs font-semibold text-text-secondary mb-1">
                Select Cloudflare Account ({availableAccounts.length} accounts detected)
              </label>
              <select
                id="cf-account-selector-field"
                data-testid="cf-account-selector"
                value={accountIdInput}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setAccountIdInput(nextId);
                  const found = availableAccounts.find((a) => a.id === nextId);
                  if (found) setAccountNameInput(found.name);
                }}
                className="w-full px-3 py-2 rounded bg-surface-control border border-border-strong text-xs text-text-primary"
              >
                {availableAccounts.map((acct) => (
                  <option key={acct.id} value={acct.id}>
                    {acct.name} ({acct.id})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="cf-account-id-field" className="block text-xs font-semibold text-text-secondary mb-1">
                  Account ID (optional if token resolves single account)
                </label>
                <input
                  id="cf-account-id-field"
                  type="text"
                  data-testid="cf-account-id-input"
                  value={accountIdInput}
                  onChange={(e) => setAccountIdInput(e.target.value)}
                  placeholder="32-character hex account ID"
                  className="w-full px-3 py-1.5 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
                />
              </div>
              <div>
                <label htmlFor="cf-account-name-field" className="block text-xs font-semibold text-text-secondary mb-1">
                  Account Label (optional)
                </label>
                <input
                  id="cf-account-name-field"
                  type="text"
                  data-testid="cf-account-name-input"
                  value={accountNameInput}
                  onChange={(e) => setAccountNameInput(e.target.value)}
                  placeholder="Acme Production Cloudflare"
                  className="w-full px-3 py-1.5 rounded bg-surface-control border border-border-strong text-xs text-text-primary"
                />
              </div>
            </div>
          )}

          {/* Step 3: Per-Permission Verification Checklist */}
          <div data-testid="cf-permissions-checklist" className="p-3.5 rounded-md bg-surface-base border border-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-text-primary">Step 3 · Required Permission Check</span>
              {hasChecked && (
                <button
                  type="button"
                  data-testid="cf-recheck-button"
                  disabled={isVerifying}
                  onClick={() => void runVerification()}
                  className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[11px] font-semibold text-text-primary"
                >
                  ↻ Re-check
                </button>
              )}
            </div>

            <div className="space-y-1.5">
              {permissionRows.map((perm) => {
                const isAccountRow = perm.id === "account_settings_read";
                const statusBadgeText = !hasChecked
                  ? "Pending check"
                  : perm.granted
                    ? isAccountRow
                      ? "Account found ✓"
                      : `${perm.label} ✓`
                    : `${perm.label} missing ✕`;

                return (
                  <div
                    key={perm.id}
                    data-testid={`cf-perm-row-${perm.id}`}
                    className={`p-2 rounded border text-xs flex flex-col gap-1 ${
                      !hasChecked
                        ? "bg-surface-control/40 border-border text-text-secondary"
                        : perm.granted
                          ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                          : "bg-rose-950/60 border-rose-500/40 text-rose-200"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{perm.label}</span>
                      <span data-testid={`cf-perm-status-${perm.id}`} className="font-mono text-[11px] font-bold">
                        {statusBadgeText}
                      </span>
                    </div>
                    {hasChecked && !perm.granted && perm.plainError && (
                      <div data-testid={`cf-perm-error-${perm.id}`} className="text-[11px] text-rose-300 flex items-center justify-between gap-2 flex-wrap">
                        <span>{perm.plainError}</span>
                        <a
                          href={safeHref(perm.remediationUrl) ?? safeHref(remediationUrl)}
                          target="_blank"
                          rel="noreferrer"
                          data-testid={`cf-fix-link-${perm.id}`}
                          className="underline font-semibold text-amber-300 hover:text-amber-200"
                        >
                          Fix in Cloudflare ↗
                        </a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {errorBanner && (
            <div role="alert" data-testid="cf-verification-error" className="p-3 rounded bg-rose-950/80 border border-rose-700 text-rose-200 text-xs space-y-2">
              <div className="font-semibold">✕ {errorBanner}</div>
              <div className="flex items-center gap-3">
                <a
                  href={safeHref(remediationUrl)}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="cf-fix-in-cloudflare-link"
                  onClick={handleTemplateClick}
                  className="px-2.5 py-1 rounded bg-amber-500/20 border border-amber-500/40 text-amber-200 font-semibold text-[11px]"
                >
                  Fix in Cloudflare ↗
                </a>
                <button
                  type="button"
                  data-testid="cf-error-recheck-button"
                  disabled={isVerifying}
                  onClick={() => void runVerification()}
                  className="px-2.5 py-1 rounded bg-surface-control border border-border-strong text-text-primary font-semibold text-[11px]"
                >
                  Re-check
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              data-testid="cf-cancel-button"
              onClick={onClose}
              className="px-3 py-1.5 rounded bg-surface-control border border-border text-xs text-text-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="cf-verify-submit-button"
              disabled={isVerifying}
              className="px-4 py-1.5 rounded bg-accent text-text-on-accent font-bold text-xs hover:opacity-90 disabled:opacity-40"
            >
              {isVerifying ? "Verifying permissions…" : "Verify & Connect Account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
