import { isValidSecretRefHandle } from "@poc/blueprint";
import { useEffect, useMemo, useState } from "react";
import {
  checkProjectEnvironmentDrift,
  disconnectCloudflareToken,
  downloadProjectOpenApiSpec,
  fetchProjectConnections,
  fetchProjectEnvironments,
  fetchProjectSecrets,
  getProjectOpenApiUrl,
  reauthorizeProjectConnection,
  recheckCloudflareToken,
  testProjectConnection,
} from "../api.ts";
import type {
  CloudflareTokenMetadataSummary,
  EnvironmentDeploymentRecordPayload,
  ProjectDeployEnvironmentRecord,
} from "../api.ts";
import { getActiveOrg, getActiveRole, useStudioStore } from "../store.ts";
import type {
  StudioConnectionRequest,
  StudioSecretKind,
  StudioSecretMetadata,
  StudioSecretStatus,
  StudioSecretUsedByTarget,
} from "../types.ts";
import { ConnectCloudflareModal } from "./ConnectCloudflareModal.tsx";
import { DeployPlanModal } from "./DeployPlanModal.tsx";
import { RollbackModal } from "./RollbackModal.tsx";

function formatKindLabel(kind: StudioSecretKind): string {
  switch (kind) {
    case "api_key":
      return "API Key";
    case "webhook_secret":
      return "Webhook Signing Secret";
    case "brick_secret":
      return "Brick Secret";
    case "oauth2":
      return "OAuth2 Connection";
  }
}

function statusBadgeMeta(status: StudioSecretStatus): {
  label: string;
  classes: string;
} {
  switch (status) {
    case "valid":
      return {
        label: "✓ Valid · Connected",
        classes: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
      };
    case "connected":
      return {
        label: "✓ Connected",
        classes: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
      };
    case "expired":
      return {
        label: "⚠ Expired",
        classes: "bg-amber-500/15 text-amber-300 border-amber-500/40",
      };
    case "revoked":
      return {
        label: "✕ Revoked",
        classes: "bg-rose-500/15 text-rose-300 border-rose-500/40",
      };
    case "error":
      return {
        label: "✕ Error",
        classes: "bg-rose-500/15 text-rose-300 border-rose-500/40",
      };
    case "missing":
      return {
        label: "⚠ Missing Value",
        classes: "bg-amber-500/15 text-amber-300 border-amber-500/40",
      };
  }
}

function toSuggestedHandle(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug ? `sec_${slug}` : "sec_custom_key";
}

export function ConnectionsView() {
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const activeProjectId = useStudioStore((s) => s.activeProjectId);
  const currentRevision = useStudioStore((s) => s.currentRevision);
  const projectState = useStudioStore((s) => s.projectState);
  const catalog = useStudioStore((s) => s.catalog);
  const secrets = useStudioStore((s) => s.secrets);
  const isMutating = useStudioStore((s) => s.isMutating);
  const mutationError = useStudioStore((s) => s.mutationError);

  const setSecrets = useStudioStore((s) => s.setSecrets);
  const upsertSecret = useStudioStore((s) => s.upsertSecret);
  const removeSecret = useStudioStore((s) => s.removeSecret);
  const selectItem = useStudioStore((s) => s.selectItem);

  const activeOrg = getActiveOrg({ orgs, activeOrgId });
  const activeRole = getActiveRole({ orgs, activeOrgId });
  const isViewer = activeRole === "viewer";

  const [modalOpen, setModalOpen] = useState(false);
  const [rotatingSecret, setRotatingSecret] =
    useState<StudioSecretMetadata | null>(null);
  const [deletingSecret, setDeletingSecret] =
    useState<StudioSecretMetadata | null>(null);

  const [cfWizardOpen, setCfWizardOpen] = useState(false);
  const [replacingTokenRef, setReplacingTokenRef] = useState<string | null>(
    null,
  );
  const [activeCfToken, setActiveCfToken] =
    useState<CloudflareTokenMetadataSummary | null>(null);
  const [cfEnvironments, setCfEnvironments] = useState<
    ProjectDeployEnvironmentRecord[]
  >([]);
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false);
  const [cfStatusMessage, setCfStatusMessage] = useState<string | null>(null);
  const [cfRechecking, setCfRechecking] = useState(false);
  const [deployPlanOpen, setDeployPlanOpen] = useState(false);
  const [deployPlanEnv, setDeployPlanEnv] = useState<"preview" | "production">(
    "preview",
  );
  const [checkingDriftEnv, setCheckingDriftEnv] = useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<{
    envName: "preview" | "production";
    targetDeployment: EnvironmentDeploymentRecordPayload;
    currentDeployment?: EnvironmentDeploymentRecordPayload | null;
  } | null>(null);

  const [kind, setKind] = useState<StudioSecretKind>("api_key");
  const [label, setLabel] = useState("");
  const [refHandle, setRefHandle] = useState("sec_");
  const [handleEditedManually, setHandleEditedManually] = useState(false);
  const [appOrBrick, setAppOrBrick] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [selectedBindOption, setSelectedBindOption] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [connectionRequests, setConnectionRequests] = useState<
    StudioConnectionRequest[]
  >([]);
  const [connectionActionMessage, setConnectionActionMessage] = useState<
    string | null
  >(null);
  const [caseBPreviewStates, setCaseBPreviewStates] = useState<
    Record<
      string,
      {
        status: "not_connected" | "connecting" | "connected" | "expired";
        accountLabel: string | null;
      }
    >
  >({
    google: { status: "not_connected", accountLabel: null },
    slack: { status: "connected", accountLabel: "workspace-team@acme.io" },
    github: { status: "expired", accountLabel: "octocat@acme.io" },
  });

  const projectSlug = activeProjectId ?? projectState?.project ?? "";
  const resolvedOrgId = activeOrg?.id ?? activeOrgId ?? "org_default";

  useEffect(() => {
    if (!projectSlug || typeof fetch !== "function") return;
    let cancelled = false;
    void fetchProjectSecrets(projectSlug)
      .then((loaded) => {
        if (!cancelled && (loaded.length > 0 || secrets.length === 0)) {
          setSecrets(loaded);
        }
      })
      .catch(() => {
        // Initial background load may run in unit tests without a mocked /secrets endpoint
      });
    void fetchProjectConnections(projectSlug)
      .then((res) => {
        if (!cancelled) {
          if (res.connectionRequests && res.connectionRequests.length > 0) {
            setConnectionRequests(res.connectionRequests);
          }
          if (res.connections.length > 0 && secrets.length === 0) {
            setSecrets(res.connections);
          }
        }
      })
      .catch(() => {
        // Ignore in unit tests without mocked /connections endpoint
      });
    const loadEnvironments = () => {
      void fetchProjectEnvironments(projectSlug, resolvedOrgId)
        .then((envRes) => {
          if (!cancelled) {
            setActiveCfToken(envRes.activeToken ?? null);
            setCfEnvironments(envRes.environments ?? []);
          }
        })
        .catch(() => {
          // Ignore in unit tests without mocked /environments endpoint
        });
    };
    loadEnvironments();
    const onOpenCfWizard = () => {
      setReplacingTokenRef(null);
      setCfWizardOpen(true);
    };
    const onEnvsUpdated = () => loadEnvironments();
    if (typeof window !== "undefined") {
      window.addEventListener("studio:open-cf-wizard", onOpenCfWizard);
      window.addEventListener("studio:environments-updated", onEnvsUpdated);
    }
    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("studio:open-cf-wizard", onOpenCfWizard);
        window.removeEventListener("studio:environments-updated", onEnvsUpdated);
      }
    };
  }, [projectSlug, resolvedOrgId, currentRevision, setSecrets]);

  const handleCheckEnvironmentDrift = async (
    envName: "preview" | "production",
  ) => {
    if (!projectSlug) return;
    setCheckingDriftEnv(envName);
    try {
      const res = await checkProjectEnvironmentDrift(projectSlug, envName, {
        orgId: resolvedOrgId,
      });
      setCfEnvironments((prev) => {
        const filtered = prev.filter(
          (e) =>
            !(
              e.projectId === res.environment.projectId &&
              e.envName === res.environment.envName
            ),
        );
        return [...filtered, res.environment];
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("studio:environments-updated"));
      }
    } catch (err) {
      setCfStatusMessage(
        err instanceof Error ? err.message : "Failed to check drift",
      );
    } finally {
      setCheckingDriftEnv(null);
    }
  };

  const handleRecheckCfToken = async () => {
    if (!activeCfToken) return;
    setCfRechecking(true);
    setCfStatusMessage(null);
    try {
      const res = await recheckCloudflareToken(
        resolvedOrgId,
        activeCfToken.tokenRef,
      );
      setActiveCfToken(res.token);
      setCfStatusMessage(res.verification.summaryMessage);
    } catch (err) {
      setCfStatusMessage(
        err instanceof Error ? err.message : "Failed to re-check token",
      );
    } finally {
      setCfRechecking(false);
    }
  };

  const handleConfirmDisconnectCf = async () => {
    if (!activeCfToken) return;
    try {
      const res = await disconnectCloudflareToken(
        resolvedOrgId,
        activeCfToken.tokenRef,
      );
      setActiveCfToken(null);
      setCfEnvironments([]);
      setConfirmDisconnectOpen(false);
      setCfStatusMessage(
        res.workersKeepRunningMessage ??
          "Disconnected. Your deployed Workers keep running in your Cloudflare account.",
      );
    } catch (err) {
      setCfStatusMessage(
        err instanceof Error ? err.message : "Failed to disconnect token",
      );
    }
  };

  const availableBindOptions = useMemo(() => {
    const options: Array<{
      value: string;
      label: string;
      targetKind: "brick" | "node";
      targetId: string;
      secretName: string;
      appOrBrick: string;
    }> = [];
    if (!projectState) return options;

    for (const brick of projectState.bricks) {
      const manifest = catalog[brick.id];
      for (const secretName of manifest?.secrets ?? []) {
        options.push({
          value: `brick:${brick.id}:${secretName}`,
          label: `Brick: ${brick.id} → ${secretName}`,
          targetKind: "brick",
          targetId: brick.id,
          secretName,
          appOrBrick: brick.id,
        });
      }
    }

    for (const wf of projectState.workflows) {
      for (const node of wf.nodes) {
        if (
          node.type === "core.http_request" ||
          node.type === "core.webhook" ||
          node.type.includes("http") ||
          node.type.includes("webhook")
        ) {
          const defaultSecretName =
            node.type === "core.webhook"
              ? "WEBHOOK_SIGNING_SECRET"
              : "AUTHORIZATION_BEARER";
          options.push({
            value: `node:${node.id}:${defaultSecretName}`,
            label: `Workflow Step: ${wf.name} / ${node.label ?? node.id} (${defaultSecretName})`,
            targetKind: "node",
            targetId: node.id,
            secretName: defaultSecretName,
            appOrBrick: node.type,
          });
        }
      }
    }

    return options;
  }, [projectState, catalog]);

  const openAddModal = () => {
    setRotatingSecret(null);
    setKind("api_key");
    setLabel("");
    setRefHandle("sec_");
    setHandleEditedManually(false);
    setAppOrBrick("custom");
    setSecretValue("");
    setSelectedBindOption("");
    setFormError(null);
    setModalOpen(true);
  };

  const openAddModalForRequest = (req: StudioConnectionRequest) => {
    setRotatingSecret(null);
    setKind("api_key");
    setLabel(`${req.app} Connection`);
    setRefHandle(req.suggestedRef || `sec_${req.app}`);
    setHandleEditedManually(true);
    setAppOrBrick(req.app);
    setSecretValue("");
    setSelectedBindOption("");
    setFormError(null);
    setModalOpen(true);
  };

  const handleTestConnection = async (secret: StudioSecretMetadata) => {
    if (!projectSlug) return;
    try {
      const res = await testProjectConnection(projectSlug, secret.ref);
      setSecrets(
        secrets.map((s) =>
          s.ref === secret.ref
            ? { ...s, status: res.status, lastCheckedAt: res.lastCheckedAt }
            : s,
        ),
      );
      setConnectionActionMessage(
        `Tested ${secret.ref}: status is ${res.status}.`,
      );
    } catch (err) {
      setConnectionActionMessage(
        err instanceof Error ? err.message : "Failed to test connection",
      );
    }
  };

  const handleReauthorizeConnection = async (secret: StudioSecretMetadata) => {
    if (!projectSlug) return;
    try {
      const res = await reauthorizeProjectConnection(projectSlug, secret.ref);
      setSecrets(
        secrets.map((s) =>
          s.ref === secret.ref ? { ...s, status: res.status } : s,
        ),
      );
      setConnectionActionMessage(
        res.authorizeUrl
          ? `Re-authorization ready for ${secret.ref} (${res.authorizeUrl}).`
          : `Re-authorized ${secret.ref}.`,
      );
    } catch {
      openRotateModal(secret);
    }
  };

  const openRotateModal = (secret: StudioSecretMetadata) => {
    setRotatingSecret(secret);
    setKind(secret.kind);
    setLabel(secret.label ?? secret.ref);
    setRefHandle(secret.ref);
    setHandleEditedManually(true);
    setAppOrBrick(secret.appOrBrick ?? "");
    setSecretValue("");
    setSelectedBindOption("");
    setFormError(null);
    setModalOpen(true);
  };

  const handleLabelChange = (nextLabel: string) => {
    setLabel(nextLabel);
    if (!rotatingSecret && !handleEditedManually) {
      setRefHandle(toSuggestedHandle(nextLabel));
    }
  };

  const handleSubmitSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedRef = (refHandle ?? "").trim();
    const trimmedLabel = (label ?? "").trim() || trimmedRef;
    const trimmedValue = (secretValue ?? "").trim();

    if (!trimmedRef.startsWith("sec_") || !isValidSecretRefHandle(trimmedRef).ok) {
      setFormError(
        "Secret reference handle must start with sec_ and contain only safe handle characters.",
      );
      return;
    }

    if (!trimmedValue) {
      setFormError("Secret plaintext value is required to seal into the vault.");
      return;
    }

    const chosenBind = availableBindOptions.find(
      (o) => o.value === selectedBindOption,
    );

    const res = await upsertSecret({
      ref: trimmedRef,
      kind,
      label: trimmedLabel,
      appOrBrick: (appOrBrick ?? "").trim() || chosenBind?.appOrBrick || "custom",
      value: trimmedValue,
      ...(chosenBind
        ? {
            bindTarget: {
              targetKind: chosenBind.targetKind,
              targetId: chosenBind.targetId,
              secretName: chosenBind.secretName,
            },
          }
        : {}),
    });

    // Immediately scrub plaintext value from component state
    setSecretValue("");

    if (!res.ok) {
      setFormError(res.error);
      return;
    }

    setModalOpen(false);
    setRotatingSecret(null);
  };

  const handleConfirmDelete = async () => {
    if (!deletingSecret) return;
    const res = await removeSecret(deletingSecret.ref, true);
    if (res.ok) {
      setDeletingSecret(null);
    }
  };

  const handleJumpToTarget = (target: StudioSecretUsedByTarget) => {
    if (target.targetKind === "brick") {
      selectItem({ kind: "brick", id: target.targetId }, "bricks");
      return;
    }
    const matchingWorkflow = projectState?.workflows.find((wf) =>
      wf.nodes.some((n) => n.id === target.targetId),
    );
    selectItem(
      {
        kind: "node",
        id: target.targetId,
        workflowId: matchingWorkflow?.id ?? projectState?.workflows[0]?.id,
      },
      "workflows",
    );
  };

  return (
    <div data-testid="view-connections" className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <span>🔐</span>
            <span>Connections &amp; Secrets Center</span>
          </h1>
          <p className="text-xs text-text-secondary mt-1">
            Secrets are encrypted with AES-GCM 256-bit keys in the Studio Vault.
            Blueprints and AI agents only ever see opaque{" "}
            <code className="font-mono text-amber-300">sec_*</code> handles and
            4-character masked hints.
          </p>
        </div>

        <button
          type="button"
          data-testid="add-secret-button"
          disabled={isViewer || isMutating}
          onClick={openAddModal}
          className="px-3.5 py-2 rounded-md bg-accent text-text-on-accent font-bold text-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          + Add Secret
        </button>
      </div>

      {mutationError && (
        <div
          role="alert"
          data-testid="connections-mutation-error"
          className="p-3 rounded-md bg-rose-950/80 border border-rose-700 text-rose-200 text-xs"
        >
          ✕ {mutationError}
        </div>
      )}

      {connectionActionMessage && (
        <div
          role="status"
          data-testid="connections-action-message"
          className="p-3 rounded-md bg-surface-raised border border-border text-text-secondary text-xs"
        >
          {connectionActionMessage}
        </div>
      )}

      {connectionRequests.filter((r) => r.status === "pending").length > 0 && (
        <div
          data-testid="agent-connection-consent-banner"
          className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/40 space-y-2.5"
        >
          <div className="text-xs font-bold text-amber-300 flex items-center gap-2">
            <span>🤖</span>
            <span>
              AI Agent Requested Connection Consent (
              {connectionRequests.filter((r) => r.status === "pending").length})
            </span>
          </div>
          <div className="space-y-2">
            {connectionRequests
              .filter((r) => r.status === "pending")
              .map((req) => (
                <div
                  key={req.requestId}
                  data-testid={`consent-request-row-${req.requestId}`}
                  className="p-2.5 rounded bg-surface-base border border-amber-500/30 flex items-center justify-between gap-3 flex-wrap text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="font-semibold text-text-primary">
                      Connect{" "}
                      <span className="font-mono text-amber-300">
                        {req.app}
                      </span>{" "}
                      as{" "}
                      <code className="font-mono text-amber-300">
                        {req.suggestedRef}
                      </code>
                    </div>
                    <div className="text-text-secondary">{req.reason}</div>
                  </div>
                  <button
                    type="button"
                    data-testid={`consent-banner-connect-${req.requestId}`}
                    disabled={isViewer || isMutating}
                    onClick={() => openAddModalForRequest(req)}
                    className="px-3 py-1.5 rounded bg-amber-400 text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40"
                  >
                    Authorize &amp; Connect {req.app}
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Cloudflare Deploy Target (BYOC) Card */}
      <div
        data-testid="cloudflare-connection-card"
        className="p-4 rounded-lg bg-surface-raised border border-border space-y-3"
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="font-bold text-sm text-text-primary">
                ☁ Cloudflare Deploy Target (BYOC)
              </span>
              {activeCfToken && activeCfToken.status === "active" ? (
                <span
                  data-testid="cloudflare-connection-status"
                  className="px-2 py-0.5 rounded border text-xs font-semibold bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                >
                  ✓ Connected
                </span>
              ) : activeCfToken && activeCfToken.status === "expired" ? (
                <span
                  data-testid="cloudflare-connection-status"
                  className="px-2 py-0.5 rounded border text-xs font-semibold bg-amber-500/15 text-amber-300 border-amber-500/40"
                >
                  ⚠ Token Expired
                </span>
              ) : (
                <span
                  data-testid="cloudflare-connection-status"
                  className="px-2 py-0.5 rounded border text-xs font-semibold bg-surface-control text-text-secondary border-border-strong"
                >
                  Not connected
                </span>
              )}
            </div>
            <p
              data-testid="cloudflare-byoc-explanation"
              className="text-xs text-text-secondary"
            >
              Your backend runs in your own Cloudflare account. We never host it.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid={deployPlanOpen ? "download-openapi-card-btn" : "download-openapi-btn"}
              data-openapi-url={getProjectOpenApiUrl(projectSlug || "default", currentRevision)}
              onClick={() => void downloadProjectOpenApiSpec(projectSlug || "default", currentRevision)}
              className="px-2.5 py-1.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-semibold text-text-secondary hover:text-text-primary"
            >
              ⬇ Download OpenAPI 3.1 Spec
            </button>
            {activeCfToken ? (
              <>
                <button
                  type="button"
                  data-testid="cloudflare-recheck-button"
                  disabled={isViewer || cfRechecking}
                  onClick={() => void handleRecheckCfToken()}
                  className="px-2.5 py-1.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-semibold text-text-primary disabled:opacity-40"
                >
                  {cfRechecking ? "Checking…" : "↻ Re-check"}
                </button>
                <button
                  type="button"
                  data-testid="cloudflare-replace-token-button"
                  disabled={isViewer}
                  onClick={() => {
                    setReplacingTokenRef(activeCfToken.tokenRef);
                    setCfWizardOpen(true);
                  }}
                  className="px-2.5 py-1.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-semibold text-text-primary disabled:opacity-40"
                >
                  Replace token
                </button>
                <button
                  type="button"
                  data-testid="cloudflare-disconnect-button"
                  disabled={isViewer}
                  onClick={() => setConfirmDisconnectOpen(true)}
                  className="px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900 border border-rose-700/60 text-xs font-semibold text-rose-200 disabled:opacity-40"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="connect-cloudflare-button"
                disabled={isViewer}
                onClick={() => {
                  setReplacingTokenRef(null);
                  setCfWizardOpen(true);
                }}
                className="px-3.5 py-1.5 rounded-md bg-accent text-text-on-accent font-bold text-xs hover:opacity-90 disabled:opacity-40"
              >
                Connect Cloudflare
              </button>
            )}
          </div>
        </div>

        {activeCfToken && (
          <div className="pt-2 border-t border-border/60 flex items-center justify-between gap-4 flex-wrap text-xs">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-text-secondary">
                Account:{" "}
                <strong
                  data-testid="cloudflare-connected-account-name"
                  className="text-text-primary"
                >
                  {activeCfToken.accountName}
                </strong>{" "}
                (
                <code
                  data-testid="cloudflare-connected-account-id"
                  className="font-mono text-amber-300"
                >
                  {activeCfToken.accountId}
                </code>
                )
              </span>
              <span
                data-testid="cloudflare-connected-token-ref"
                className="px-2 py-0.5 rounded bg-surface-base border border-border font-mono text-[11px] text-text-secondary"
              >
                {activeCfToken.tokenRef} · ••••{activeCfToken.tokenLast4}
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {(() => {
                const filtered = cfEnvironments
                  .filter((e) => !projectSlug || e.projectId === projectSlug)
                  .map((e) => e.envName);
                const envNames =
                  filtered.length > 0
                    ? Array.from(new Set(filtered))
                    : (["preview", "production"] as const);
                return envNames.map((envName) => {
                  const envRec = cfEnvironments.find(
                    (e) =>
                      (!projectSlug || e.projectId === projectSlug) &&
                      e.envName === envName,
                  );
                  return (
                    <span
                      key={envName}
                      data-testid={`cloudflare-env-badge-${envName}`}
                      data-build-hash={envRec?.buildHash ?? ""}
                      className="px-2 py-0.5 rounded border bg-emerald-500/10 border-emerald-500/30 text-emerald-300 font-mono text-[11px] font-semibold"
                    >
                      {envName} · byoc
                      {envRec?.deployedRev ? ` · r${envRec.deployedRev}` : ""}
                      {envRec?.buildHash
                        ? ` · ${envRec.buildHash.slice(0, 10)}`
                        : ""}
                    </span>
                  );
                });
              })()}
              <button
                type="button"
                data-testid="open-deploy-plan-preview-button"
                disabled={isViewer}
                onClick={() => {
                  setDeployPlanEnv("preview");
                  setDeployPlanOpen(true);
                }}
                className="px-2.5 py-1 rounded bg-accent text-text-on-accent font-bold text-xs hover:opacity-90 disabled:opacity-40"
              >
                Plan &amp; Deploy (preview)
              </button>
              <button
                type="button"
                data-testid="open-deploy-plan-production-button"
                disabled={isViewer}
                onClick={() => {
                  setDeployPlanEnv("production");
                  setDeployPlanOpen(true);
                }}
                className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-amber-300 font-bold text-xs disabled:opacity-40"
              >
                Promote to production
              </button>
            </div>
          </div>
        )}

        {confirmDisconnectOpen && activeCfToken && (
          <div
            data-testid="cloudflare-disconnect-confirm-panel"
            className="p-3 rounded bg-rose-950/70 border border-rose-700 text-xs text-rose-100 space-y-2"
          >
            <div>
              <strong>Disconnect Cloudflare token?</strong> Your already-deployed
              Workers and D1 databases keep running in your Cloudflare account.
              Studio will immediately wipe the encrypted token from its vault.
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="cloudflare-confirm-disconnect-button"
                onClick={() => void handleConfirmDisconnectCf()}
                className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs"
              >
                Confirm Disconnect
              </button>
              <a
                href="https://dash.cloudflare.com/profile/api-tokens"
                target="_blank"
                rel="noreferrer"
                data-testid="cloudflare-dashboard-revoke-link"
                className="px-2.5 py-1 rounded bg-surface-control border border-border text-amber-300 underline text-xs"
              >
                Also delete token in Cloudflare Dashboard ↗
              </a>
              <button
                type="button"
                onClick={() => setConfirmDisconnectOpen(false)}
                className="px-2.5 py-1 rounded bg-surface-control border border-border text-text-secondary text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {cfStatusMessage && (
          <div
            data-testid="cloudflare-status-message"
            className="p-2.5 rounded bg-surface-base border border-border text-xs text-text-secondary"
          >
            {cfStatusMessage}
          </div>
        )}

        {/* Environment Drift & Deployment History Panels */}
        {activeCfToken && cfEnvironments.length > 0 && (
          <div
            data-testid="cloudflare-environments-detail-grid"
            className="pt-3 border-t border-border/60 grid grid-cols-1 lg:grid-cols-2 gap-4"
          >
            {(["preview", "production"] as const).map((envName) => {
              const envRec = cfEnvironments.find(
                (e) =>
                  (!projectSlug || e.projectId === projectSlug) &&
                  e.envName === envName,
              );
              if (!envRec) return null;
              const drift = envRec.driftReport;
              const deployments = envRec.deployments ?? [];
              const isDeployed =
                envRec.deployedRev !== null && envRec.deployedRev !== undefined;
              const inSync = drift ? drift.inSync : true;
              const bpDrift = drift?.blueprintDrift;
              const oobDrift = drift?.outOfBandDrift ?? [];

              return (
                <div
                  key={envName}
                  data-testid={`env-drift-card-${envName}`}
                  className="p-3.5 rounded-md bg-surface-base border border-border space-y-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="font-bold uppercase tracking-wider text-text-primary">
                        {envName}
                      </span>
                      {isDeployed ? (
                        <span
                          data-testid={`env-drift-status-${envName}`}
                          className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                            inSync
                              ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                              : "bg-amber-500/20 border-amber-500/50 text-amber-300"
                          }`}
                        >
                          {inSync ? "✓ In Sync" : "⚠ Drift Detected"}
                        </span>
                      ) : (
                        <span
                          data-testid={`env-drift-status-${envName}`}
                          className="px-2 py-0.5 rounded border bg-surface-control border-border text-[11px] text-text-muted"
                        >
                          Not deployed yet
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      data-testid={`check-drift-button-${envName}`}
                      disabled={checkingDriftEnv === envName}
                      onClick={() => void handleCheckEnvironmentDrift(envName)}
                      className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[11px] font-semibold text-text-primary disabled:opacity-40"
                    >
                      {checkingDriftEnv === envName
                        ? "Checking…"
                        : "↻ Check Drift"}
                    </button>
                  </div>

                  {/* Blueprint Drift Summary */}
                  {isDeployed && bpDrift && (
                    <div
                      data-testid={`blueprint-drift-summary-${envName}`}
                      className="p-2.5 rounded bg-surface-raised border border-border/80 space-y-1"
                    >
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-text-secondary">
                          Deployed Rev:{" "}
                          <strong className="font-mono text-text-primary">
                            r{bpDrift.deployedRev}
                          </strong>{" "}
                          · Current Blueprint:{" "}
                          <strong className="font-mono text-accent">
                            r{bpDrift.currentRev}
                          </strong>
                        </span>
                        <span className="font-mono text-[11px] text-text-muted">
                          {envRec.buildHash?.slice(0, 12)}
                        </span>
                      </div>
                      {(bpDrift.hasCodeDrift || bpDrift.hasGraphDrift) && (
                        <div
                          data-testid={`blueprint-drift-flags-${envName}`}
                          className="flex items-center gap-2 flex-wrap pt-1"
                        >
                          {bpDrift.hasCodeDrift && (
                            <span
                              data-testid={`blueprint-code-drift-badge-${envName}`}
                              className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 font-mono text-[10px]"
                            >
                              Code Drift (Worker / Schema changed)
                            </span>
                          )}
                          {bpDrift.hasGraphDrift && (
                            <span
                              data-testid={`blueprint-graph-drift-badge-${envName}`}
                              className="px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300 font-mono text-[10px]"
                            >
                              Graph Drift (Workflows / Schedules changed)
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Out-of-Band Drift Items */}
                  {oobDrift.length > 0 && (
                    <div
                      data-testid={`out-of-band-drift-list-${envName}`}
                      className="p-2.5 rounded bg-rose-950/60 border border-rose-700/70 space-y-1.5"
                    >
                      <div className="font-bold text-rose-200 text-[11px]">
                        ⚠ Out-of-Band Cloudflare Drift ({oobDrift.length})
                      </div>
                      <ul className="space-y-1 text-[11px] font-mono text-rose-100">
                        {oobDrift.map((item, idx) => (
                          <li
                            key={`${item.resource}:${idx}`}
                            data-testid={`out-of-band-drift-item-${envName}-${idx}`}
                          >
                            [{item.resource.toUpperCase()}] {item.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Deployment History */}
                  <div className="space-y-1.5">
                    <div className="font-semibold text-text-secondary text-[11px] flex items-center justify-between">
                      <span>Deployment History ({deployments.length})</span>
                      {envRec.deployedBy && (
                        <span className="text-text-muted font-mono text-[10px]">
                          Last by {envRec.deployedBy}
                        </span>
                      )}
                    </div>

                    {deployments.length === 0 ? (
                      <div
                        data-testid={`deployment-history-empty-${envName}`}
                        className="p-2.5 rounded bg-surface-raised border border-border/60 text-text-muted text-[11px] italic"
                      >
                        No deployments recorded for {envName} yet.
                      </div>
                    ) : (
                      <div
                        data-testid={`deployment-history-${envName}`}
                        className="space-y-1.5 max-h-60 overflow-y-auto"
                      >
                        {deployments.map((dep, idx) => {
                          const isLatest = idx === 0;
                          const canRollback =
                            !isViewer && (!isLatest || !inSync);
                          return (
                            <div
                              key={dep.deployId}
                              data-testid={`deployment-row-${dep.deployId}`}
                              data-version-label={dep.versionLabel}
                              className="p-2 rounded bg-surface-raised border border-border flex items-center justify-between gap-2 flex-wrap"
                            >
                              <div className="space-y-0.5">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span
                                    data-testid={`deployment-version-${envName}-${dep.versionLabel}`}
                                    className="px-1.5 py-0.5 rounded bg-accent/20 text-accent font-mono font-bold text-[10px]"
                                  >
                                    {dep.versionLabel}
                                  </span>
                                  <span className="font-mono font-semibold text-text-primary text-[11px]">
                                    r{dep.revision}
                                  </span>
                                  <code
                                    data-testid={`deployment-build-hash-${dep.deployId}`}
                                    className="font-mono text-[10px] text-amber-300"
                                  >
                                    {dep.buildHash.slice(0, 10)}
                                  </code>
                                  <span className="px-1.5 py-0.5 rounded bg-surface-control border border-border text-[10px] text-text-secondary">
                                    {dep.action}
                                  </span>
                                  {isLatest && (
                                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-semibold text-[10px]">
                                      Active
                                    </span>
                                  )}
                                  {dep.rollbackFromDeploymentId && (
                                    <span
                                      data-testid={`deployment-rollback-badge-${dep.deployId}`}
                                      className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 font-mono text-[10px]"
                                    >
                                      ↶ rolled back from{" "}
                                      {dep.rollbackFromDeploymentId.slice(0, 12)}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] text-text-muted font-mono">
                                  by {dep.actorId} · {dep.createdAt}
                                </div>
                              </div>

                              {canRollback && (
                                <button
                                  type="button"
                                  data-testid={`rollback-button-${dep.deployId}`}
                                  data-rollback-version={`${envName}-${dep.versionLabel}`}
                                  onClick={() =>
                                    setRollbackTarget({
                                      envName,
                                      targetDeployment: dep,
                                      currentDeployment: deployments[0] ?? null,
                                    })
                                  }
                                  className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-200 font-bold text-[11px]"
                                >
                                  ↶ Roll back
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConnectCloudflareModal
        open={cfWizardOpen}
        orgId={resolvedOrgId}
        projectSlug={projectSlug}
        replaceTokenRef={replacingTokenRef}
        onClose={() => setCfWizardOpen(false)}
        onConnected={({ token, environments }) => {
          setActiveCfToken(token);
          setCfEnvironments(environments);
          setCfStatusMessage(
            `Connected to ${token.accountName} — preview & production environments ready.`,
          );
        }}
      />

      {/* Secrets & Connections Table / List */}
      {secrets.length === 0 ? (
        <div
          data-testid="connections-empty-state"
          className="p-8 rounded-lg bg-surface-raised border border-border text-center space-y-2"
        >
          <div className="text-sm font-semibold text-text-primary">
            No connections or secrets configured yet
          </div>
          <p className="text-xs text-text-muted max-w-md mx-auto">
            Add an API Key, Webhook Signing Secret, or Brick Secret to seal it in
            the AES-GCM vault and bind its{" "}
            <code className="font-mono text-amber-300">sec_*</code> handle to
            your bricks or workflow steps.
          </p>
        </div>
      ) : (
        <div data-testid="secrets-list" className="space-y-3">
          {secrets.map((secret) => {
            const statusMeta = statusBadgeMeta(secret.status);
            return (
              <div
                key={secret.ref}
                data-testid={`secret-row-${secret.ref}`}
                className="p-4 rounded-lg bg-surface-raised border border-border flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="font-bold text-sm text-text-primary">
                        {secret.label}
                      </span>
                      <span
                        data-testid={`secret-ref-${secret.ref}`}
                        className="px-2 py-0.5 rounded bg-surface-base border border-border font-mono text-xs text-amber-300"
                      >
                        {secret.ref}
                      </span>
                      <span
                        data-testid={`secret-status-${secret.ref}`}
                        className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${statusMeta.classes}`}
                      >
                        {statusMeta.label}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-surface-control border border-border text-[11px] text-text-secondary">
                        {formatKindLabel(secret.kind)}
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-text-muted">
                      <span>
                        App / Brick:{" "}
                        <strong className="font-mono text-text-secondary">
                          {secret.appOrBrick}
                        </strong>
                      </span>
                      <span>
                        Key Hint:{" "}
                        <code
                          data-testid={`secret-key-hint-${secret.ref}`}
                          className="px-1.5 py-0.5 rounded bg-surface-base border border-border font-mono text-text-primary"
                        >
                          {secret.keyHint}
                        </code>
                      </span>
                      <span>
                        Scope:{" "}
                        <span className="font-mono text-text-secondary">
                          {secret.envScope}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Row Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      data-testid={`test-connection-button-${secret.ref}`}
                      disabled={isViewer || isMutating}
                      onClick={() => void handleTestConnection(secret)}
                      className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-semibold text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      data-testid={`reauthorize-connection-button-${secret.ref}`}
                      disabled={isViewer || isMutating}
                      onClick={() => void handleReauthorizeConnection(secret)}
                      className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-semibold text-amber-300 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Re-authorize
                    </button>
                    <button
                      type="button"
                      data-testid={`rotate-secret-button-${secret.ref}`}
                      disabled={isViewer || isMutating}
                      onClick={() => openRotateModal(secret)}
                      className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-semibold text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {secret.status === "missing"
                        ? "Provide Value"
                        : "Rotate / Replace"}
                    </button>
                    <button
                      type="button"
                      data-testid={`delete-secret-button-${secret.ref}`}
                      disabled={isViewer || isMutating}
                      onClick={() => setDeletingSecret(secret)}
                      className="px-2.5 py-1 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-700/60 text-xs font-semibold text-rose-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {/* Used By Targets */}
                <div
                  data-testid={`secret-used-by-${secret.ref}`}
                  className="pt-2 border-t border-border/60 flex items-center gap-2 flex-wrap text-xs"
                >
                  <span className="text-text-muted font-semibold">Used by:</span>
                  {secret.usedBy.length === 0 ? (
                    <span className="text-text-muted italic">
                      Not bound to any brick or workflow step yet
                    </span>
                  ) : (
                    secret.usedBy.map((target) => (
                      <button
                        key={`${target.targetKind}:${target.targetId}:${target.secretName}`}
                        type="button"
                        data-testid={`secret-used-by-target-${secret.ref}-${target.targetId}`}
                        onClick={() => handleJumpToTarget(target)}
                        className="px-2 py-0.5 rounded bg-surface-control hover:bg-accent/20 border border-border-strong text-[11px] font-mono text-sky-300 flex items-center gap-1.5 transition"
                      >
                        <span>
                          {target.targetKind === "brick" ? "▣ Brick" : "☍ Node"}:
                        </span>
                        <span className="font-bold">{target.targetId}</span>
                        <span className="text-text-muted">
                          ({target.secretName})
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Case B — End-User Workspace Connections (bricks/integration-connections Live App Preview) */}
      <div
        data-testid="case-b-widget-preview"
        aria-label="Connect your account"
        className="rounded-lg bg-surface-raised border border-border-strong p-4 space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xs font-bold text-text-primary flex items-center gap-2">
              <span>Case B — Connect your account (Workspace Widget Preview)</span>
              <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 text-[10px] font-mono">
                bricks/integration-connections
              </span>
            </h2>
            <p className="text-[11px] text-text-secondary">
              End-user multi-tenant OAuth2 widget isolated per customer workspace (AD-S19,Aad-bound).
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(
            [
              { provider: "google", displayName: "Google Workspace" },
              { provider: "slack", displayName: "Slack" },
              { provider: "github", displayName: "GitHub" },
            ] as const
          ).map(({ provider, displayName }) => {
            const entry = caseBPreviewStates[provider] ?? {
              status: "not_connected" as const,
              accountLabel: null,
            };
            const statusText =
              entry.status === "connecting"
                ? "Connecting"
                : entry.status === "connected"
                  ? "Connected"
                  : entry.status === "expired"
                    ? "Expired"
                    : "Not connected";
            return (
              <div
                key={provider}
                data-testid={`case-b-provider-card-${provider}`}
                className="rounded bg-surface-control border border-border p-3 flex flex-col justify-between gap-2"
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-text-primary">
                      {displayName}
                    </span>
                    <span
                      data-testid={`case-b-provider-status-${provider}`}
                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold border border-border-strong text-text-secondary"
                    >
                      {statusText}
                    </span>
                  </div>
                  {entry.status === "connected" && entry.accountLabel && (
                    <div
                      data-testid={`case-b-provider-account-${provider}`}
                      className="text-[11px] text-emerald-300 font-mono"
                    >
                      {entry.accountLabel}
                    </div>
                  )}
                </div>

                <div className="pt-1">
                  {entry.status === "not_connected" && (
                    <button
                      type="button"
                      disabled={isViewer}
                      data-testid={`case-b-connect-btn-${provider}`}
                      onClick={() => {
                        setCaseBPreviewStates((prev) => ({
                          ...prev,
                          [provider]: { status: "connecting", accountLabel: null },
                        }));
                        setTimeout(() => {
                          setCaseBPreviewStates((prev) => ({
                            ...prev,
                            [provider]: {
                              status: "connected",
                              accountLabel: `customer@${provider}.workspace.io`,
                            },
                          }));
                        }, 10);
                      }}
                      className="w-full px-2.5 py-1 rounded bg-accent hover:bg-accent-hover text-slate-950 text-[11px] font-bold"
                    >
                      Connect {displayName}
                    </button>
                  )}
                  {entry.status === "connecting" && (
                    <button
                      type="button"
                      disabled
                      data-testid={`case-b-connecting-btn-${provider}`}
                      className="w-full px-2.5 py-1 rounded bg-surface-raised border border-border-strong text-text-muted text-[11px] font-semibold"
                    >
                      Connecting…
                    </button>
                  )}
                  {entry.status === "connected" && (
                    <button
                      type="button"
                      disabled={isViewer}
                      data-testid={`case-b-disconnect-btn-${provider}`}
                      onClick={() =>
                        setCaseBPreviewStates((prev) => ({
                          ...prev,
                          [provider]: { status: "not_connected", accountLabel: null },
                        }))
                      }
                      className="w-full px-2.5 py-1 rounded bg-rose-950/60 hover:bg-rose-900/60 border border-rose-700/60 text-rose-200 text-[11px] font-semibold"
                    >
                      Disconnect
                    </button>
                  )}
                  {entry.status === "expired" && (
                    <button
                      type="button"
                      disabled={isViewer}
                      data-testid={`case-b-reconnect-btn-${provider}`}
                      onClick={() =>
                        setCaseBPreviewStates((prev) => ({
                          ...prev,
                          [provider]: {
                            status: "connected",
                            accountLabel: entry.accountLabel ?? `customer@${provider}.workspace.io`,
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-bold"
                    >
                      Reconnect
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Add / Rotate Secret Modal */}
      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={rotatingSecret ? "Rotate Secret Value" : "Add Secret"}
          data-testid="add-secret-modal"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <form
            onSubmit={(e) => void handleSubmitSecret(e)}
            className="w-full max-w-md rounded-lg bg-surface-raised border border-border-strong p-5 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-text-primary">
                {rotatingSecret
                  ? `Rotate Secret Value (${rotatingSecret.ref})`
                  : "Add Connection / Secret"}
              </h2>
              <button
                type="button"
                data-testid="close-secret-modal"
                onClick={() => {
                  setModalOpen(false);
                  setRotatingSecret(null);
                  setSecretValue("");
                }}
                className="text-xs text-text-muted hover:text-text-primary"
              >
                ✕
              </button>
            </div>

            {formError && (
              <div
                role="alert"
                data-testid="secret-modal-error"
                className="p-2.5 rounded bg-rose-950/80 border border-rose-700 text-rose-200 text-xs"
              >
                {formError}
              </div>
            )}

            <div className="space-y-1">
              <label
                htmlFor="secret-kind-select"
                className="block text-xs font-semibold text-text-secondary"
              >
                Secret Kind
              </label>
              <select
                id="secret-kind-select"
                data-testid="secret-kind-select"
                value={kind}
                onChange={(e) => setKind(e.target.value as StudioSecretKind)}
                className="w-full px-2.5 py-1.5 rounded bg-surface-control border border-border-strong text-xs text-text-primary"
              >
                <option value="api_key">API Key</option>
                <option value="webhook_secret">Webhook Signing Secret</option>
                <option value="brick_secret">Brick Secret</option>
              </select>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="secret-label-input"
                className="block text-xs font-semibold text-text-secondary"
              >
                Display Label
              </label>
              <input
                id="secret-label-input"
                type="text"
                data-testid="secret-label-input"
                placeholder="e.g. Stripe Webhook Secret"
                value={label}
                onChange={(e) => handleLabelChange(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded bg-surface-control border border-border-strong text-xs text-text-primary"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="secret-handle-input"
                className="block text-xs font-semibold text-text-secondary"
              >
                Opaque Handle (<code className="font-mono">sec_*</code>)
              </label>
              <input
                id="secret-handle-input"
                type="text"
                data-testid="secret-handle-input"
                disabled={Boolean(rotatingSecret)}
                value={refHandle}
                onChange={(e) => {
                  setHandleEditedManually(true);
                  setRefHandle(e.target.value);
                }}
                className="w-full px-2.5 py-1.5 rounded bg-surface-control border border-border-strong font-mono text-xs text-amber-300 disabled:opacity-60"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="secret-app-input"
                className="block text-xs font-semibold text-text-secondary"
              >
                App or Brick Identifier
              </label>
              <input
                id="secret-app-input"
                type="text"
                data-testid="secret-app-input"
                placeholder="e.g. webhook-gateway or stripe"
                value={appOrBrick}
                onChange={(e) => setAppOrBrick(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="secret-value-input"
                className="block text-xs font-semibold text-text-secondary"
              >
                Secret Plaintext Value (Write-Only · Sealed with AES-GCM)
              </label>
              <input
                id="secret-value-input"
                type="password"
                autoComplete="off"
                data-testid="secret-value-input"
                placeholder="Enter secret value (never returned after save)"
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary"
              />
            </div>

            {!rotatingSecret && availableBindOptions.length > 0 && (
              <div className="space-y-1">
                <label
                  htmlFor="secret-bind-target-select"
                  className="block text-xs font-semibold text-text-secondary"
                >
                  Bind to Brick or Workflow Step (Optional)
                </label>
                <select
                  id="secret-bind-target-select"
                  data-testid="secret-bind-target-select"
                  value={selectedBindOption}
                  onChange={(e) => setSelectedBindOption(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded bg-surface-control border border-border-strong text-xs text-text-primary"
                >
                  <option value="">Do not bind immediately</option>
                  {availableBindOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  setRotatingSecret(null);
                  setSecretValue("");
                }}
                className="px-3 py-1.5 rounded bg-surface-control border border-border text-xs text-text-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="save-secret-submit"
                disabled={isMutating}
                className="px-3.5 py-1.5 rounded bg-accent text-text-on-accent font-bold text-xs disabled:opacity-50"
              >
                {rotatingSecret ? "Seal & Rotate Value" : "Seal & Save Secret"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Secret Confirmation Modal */}
      {deletingSecret && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete Secret Confirmation"
          data-testid="delete-secret-modal"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-md rounded-lg bg-surface-raised border border-rose-500/40 p-5 space-y-4 shadow-xl">
            <h2 className="text-sm font-bold text-rose-300">
              Delete Secret {deletingSecret.ref}?
            </h2>
            <p className="text-xs text-text-secondary">
              This will permanently remove the encrypted ciphertext from the
              Studio Vault and unbind{" "}
              <code className="font-mono text-amber-300">
                {deletingSecret.ref}
              </code>{" "}
              from the blueprint.
            </p>

            {deletingSecret.usedBy.length > 0 && (
              <div
                data-testid="delete-secret-impact-warning"
                className="p-3 rounded bg-amber-500/10 border border-amber-500/30 space-y-1.5"
              >
                <div className="text-xs font-bold text-amber-300">
                  ⚠ Warning: {deletingSecret.usedBy.length}{" "}
                  {deletingSecret.usedBy.length === 1 ? "target" : "targets"}{" "}
                  will become unready:
                </div>
                <ul className="list-disc list-inside text-xs font-mono text-amber-200 space-y-0.5">
                  {deletingSecret.usedBy.map((t) => (
                    <li key={`${t.targetKind}:${t.targetId}:${t.secretName}`}>
                      {t.targetKind}: {t.targetId} ({t.secretName})
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                data-testid="cancel-delete-secret"
                onClick={() => setDeletingSecret(null)}
                className="px-3 py-1.5 rounded bg-surface-control border border-border text-xs text-text-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-delete-secret"
                disabled={isMutating}
                onClick={() => void handleConfirmDelete()}
                className="px-3.5 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs disabled:opacity-50"
              >
                Delete &amp; Unbind Secret
              </button>
            </div>
          </div>
        </div>
      )}
      <DeployPlanModal
        open={deployPlanOpen}
        projectSlug={projectSlug}
        orgId={resolvedOrgId}
        initialEnvName={deployPlanEnv}
        onClose={() => setDeployPlanOpen(false)}
        onDeployed={({ environment }) => {
          if (environment) {
            setCfEnvironments((prev) => {
              const filtered = prev.filter(
                (e) =>
                  !(
                    e.projectId === environment.projectId &&
                    e.envName === environment.envName
                  ),
              );
              return [...filtered, environment];
            });
          }
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("studio:environments-updated"));
          }
        }}
      />
      <RollbackModal
        open={Boolean(rollbackTarget)}
        projectSlug={projectSlug}
        orgId={resolvedOrgId}
        envName={rollbackTarget?.envName ?? "preview"}
        targetDeployment={rollbackTarget?.targetDeployment ?? null}
        currentDeployment={rollbackTarget?.currentDeployment ?? null}
        onClose={() => setRollbackTarget(null)}
        onRolledBack={({ environment, revision }) => {
          if (environment) {
            setCfEnvironments((prev) => {
              const filtered = prev.filter(
                (e) =>
                  !(
                    e.projectId === environment.projectId &&
                    e.envName === environment.envName
                  ),
              );
              return [...filtered, environment];
            });
          }
          setCfStatusMessage(
            `Rolled back ${rollbackTarget?.envName ?? "environment"} to r${revision ?? ""}.`,
          );
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("studio:environments-updated"));
          }
        }}
      />
    </div>
  );
}
