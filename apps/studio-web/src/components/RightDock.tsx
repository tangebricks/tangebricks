import { isValidSecretRefHandle } from "@poc/blueprint";
import { useEffect, useMemo, useState } from "react";
import type { TestStepResponse } from "../api.ts";
import { getActiveRole, useStudioStore } from "../store.ts";
import {
  computeStudioValidationIssues,
  extractStepExpressionPills,
  formatEntityDdl,
  formatMaturityBadge,
  getCatalogNodeDefinition,
  getEffectiveNodePorts,
  getUpstreamAncestorNodes,
  hasSchedulingOrQueueTriggers,
  validateBrickSettingValue,
  validateStepExpression,
  brickSecretNames,
} from "../types.ts";
import type { CatalogSettingDefinition } from "../types.ts";
import { ChangeLedgerFeed, SameObjectConflictCard } from "./HistoryAndLedgerView.tsx";

function BrickInspectorDetail({ brickId }: { brickId: string }) {
  const catalog = useStudioStore((s) => s.catalog);
  const projectState = useStudioStore((s) => s.projectState);
  const currentRevision = useStudioStore((s) => s.currentRevision);
  const secrets = useStudioStore((s) => s.secrets);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const isMutating = useStudioStore((s) => s.isMutating);
  const highlightedInspectorField = useStudioStore(
    (s) => s.highlightedInspectorField,
  );
  const setDirtyTarget = useStudioStore((s) => s.setDirtyTarget);
  const commitOps = useStudioStore((s) => s.commitOps);
  const upsertSecret = useStudioStore((s) => s.upsertSecret);

  const activeRole = getActiveRole({ orgs, activeOrgId });
  const isViewer = activeRole === "viewer";

  const manifest = catalog[brickId];
  const enabledEntry = projectState?.bricks.find((b) => b.id === brickId);
  const configJson = JSON.stringify(enabledEntry?.config ?? {});
  const secretRefsJson = JSON.stringify(
    (projectState?.secretRefs ?? []).filter(
      (r) => r.targetKind === "brick" && r.targetId === brickId,
    ),
  );

  const [draftSettings, setDraftSettings] = useState<Record<string, unknown>>({});
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [inlineSecretOpen, setInlineSecretOpen] = useState<Record<string, boolean>>({});
  const [inlineSecretHandles, setInlineSecretHandles] = useState<Record<string, string>>({});
  const [inlineSecretValues, setInlineSecretValues] = useState<Record<string, string>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (!manifest) return;
    const nextSettings: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(manifest.settings ?? {})) {
      nextSettings[key] = enabledEntry?.config?.[key] ?? def.default;
    }
    setDraftSettings(nextSettings);
    setSaveSuccess(false);
  }, [brickId, configJson, manifest]);

  useEffect(() => {
    if (!manifest) return;
    const nextSecrets: Record<string, string> = {};
    for (const secretName of brickSecretNames(manifest)) {
      const bound = projectState?.secretRefs.find(
        (r) =>
          r.targetKind === "brick" &&
          r.targetId === brickId &&
          r.secretName === secretName,
      );
      nextSecrets[secretName] = bound?.ref ?? "";
    }
    setSecretInputs(nextSecrets);
  }, [brickId, secretRefsJson, manifest, projectState?.secretRefs]);

  if (!manifest) {
    return (
      <div className="text-xs text-text-muted">
        Unknown brick <span className="font-mono">{brickId}</span>
      </div>
    );
  }

  const maturity = formatMaturityBadge(manifest.ui?.maturity ?? "production");
  const needsScheduling = hasSchedulingOrQueueTriggers(manifest, enabledEntry?.config ?? {});
  const settingsEntries = Object.entries(manifest.settings ?? {});
  const secretsList = brickSecretNames(manifest);

  const validationResults = useMemo(() => {
    const map: Record<string, { ok: boolean; value?: unknown; error?: string }> = {};
    for (const [key, def] of settingsEntries) {
      const rawVal =
        key in draftSettings
          ? draftSettings[key]
          : (enabledEntry?.config?.[key] ?? def.default);
      map[key] = validateBrickSettingValue(key, rawVal, def);
    }
    return map;
  }, [settingsEntries, draftSettings, enabledEntry?.config]);

  const hasValidationErrors = Object.values(validationResults).some((r) => !r.ok);

  const handleSaveSettings = async () => {
    if (!enabledEntry || isViewer || isMutating || hasValidationErrors) return;
    const validatedConfig: Record<string, unknown> = {};
    for (const [key, def] of settingsEntries) {
      const res = validationResults[key];
      if (!res || !res.ok) return;
      // An empty string for a setting whose default is empty means "not set": leave it out, as MCP does, so the
      // blueprint (and its semantic hash) is the same whichever surface configured the brick.
      if (res.value === "" && (def.default ?? "") === "") continue;
      validatedConfig[key] = res.value;
    }
    const result = await commitOps(
      [
        {
          opId: `cfg-${brickId}-${Date.now()}`,
          type: "configure_brick",
          brickId,
          config: validatedConfig,
        },
      ],
      `Configure ${brickId} settings`,
    );
    if (result.ok) {
      setSaveSuccess(true);
    }
  };

  const handleBindSecretRef = async (secretName: string, explicitRef?: string) => {
    if (!enabledEntry || isViewer || isMutating) return;
    const ref = (explicitRef ?? secretInputs[secretName] ?? "").trim();
    if (!isValidSecretRefHandle(ref).ok) return;
    await commitOps(
      [
        {
          opId: `sec-${brickId}-${secretName}-${Date.now()}`,
          type: "bind_secret_ref",
          targetKind: "brick",
          targetId: brickId,
          secretName,
          ref,
        },
      ],
      `Bind secret ${secretName} on ${brickId}`,
    );
  };

  const handleInlineCreateSecret = async (secretName: string) => {
    if (!enabledEntry || isViewer || isMutating) return;
    const defaultHandle = `sec_${brickId.replace(/[^a-z0-9]+/g, "_")}_${secretName.toLowerCase()}`;
    const ref = (inlineSecretHandles[secretName] ?? defaultHandle).trim();
    const val = (inlineSecretValues[secretName] ?? "").trim();
    if (!ref.startsWith("sec_") || !isValidSecretRefHandle(ref).ok || !val) return;

    setInlineSecretValues((prev) => ({ ...prev, [secretName]: "" }));
    setInlineSecretOpen((prev) => ({ ...prev, [secretName]: false }));

    const res = await upsertSecret({
      ref,
      kind: "brick_secret",
      label: `${brickId} ${secretName}`,
      appOrBrick: brickId,
      value: val,
      bindTarget: {
        targetKind: "brick",
        targetId: brickId,
        secretName,
      },
    });
    if (res.ok) {
      setSecretInputs((prev) => ({ ...prev, [secretName]: ref }));
    }
  };

  return (
    <div data-testid="inspector-brick-detail" className="space-y-4 text-xs">
      {highlightedInspectorField && (
        <div
          data-testid="inspector-highlighted-field"
          data-field-key={highlightedInspectorField}
          className="p-2 rounded bg-amber-500/15 border border-amber-500/50 text-[11px] text-amber-200 flex items-center justify-between"
        >
          <span>
            ⚑ Focused offending field:{" "}
            <span className="font-mono font-bold text-accent">
              {highlightedInspectorField}
            </span>
          </span>
        </div>
      )}
      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-text-primary">
            {manifest.ui?.displayName ?? manifest.id}
          </h3>
          <span
            data-testid="inspector-brick-maturity"
            className="px-2 py-0.5 rounded bg-surface-control border border-border-strong text-[11px] font-semibold"
          >
            {maturity.textWithIcon}
          </span>
        </div>
        <div className="font-mono text-[11px] text-text-muted mt-0.5">{manifest.id}</div>
        {manifest.ui?.summary && (
          <p className="text-text-secondary mt-1.5">{manifest.ui.summary}</p>
        )}
        {manifest.ui?.maturityReason && (
          <div
            data-testid="inspector-brick-maturity-reason"
            className="mt-2 p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[11px]"
          >
            ⚠ {manifest.ui.maturityReason}
          </div>
        )}
        {needsScheduling && (
          <div
            data-testid="inspector-brick-scheduling-marker"
            className="mt-2 p-2 rounded bg-sky-400/10 border border-sky-400/30 text-sky-300 text-[11px]"
          >
            ⏱ Needs scheduling / queues
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Capabilities & Wiring
        </div>
        <div>
          <span className="text-text-muted">Provides: </span>
          {manifest.provides.length === 0 ? (
            <span className="text-text-muted">None</span>
          ) : (
            <span
              data-testid="inspector-brick-provides"
              className="font-mono text-emerald-400"
            >
              {manifest.provides.join(", ")}
            </span>
          )}
        </div>
        <div>
          <span className="text-text-muted">Requires: </span>
          {manifest.requires.length === 0 ? (
            <span className="text-text-muted">None</span>
          ) : (
            <span
              data-testid="inspector-brick-requires"
              className="font-mono text-amber-400"
            >
              {manifest.requires.join(", ")}
            </span>
          )}
        </div>
        <div>
          <span className="text-text-muted">Route Prefixes: </span>
          {manifest.routePrefixes.length === 0 ? (
            <span className="text-text-muted">None</span>
          ) : (
            <span
              data-testid="inspector-brick-routes"
              className="font-mono text-sky-400"
            >
              {manifest.routePrefixes.map((p) => `/api/${p}`).join(", ")}
            </span>
          )}
        </div>
        <div>
          <span className="text-text-muted">Migrations: </span>
          {manifest.migrations.length === 0 ? (
            <span className="text-text-muted">None</span>
          ) : (
            <span
              data-testid="inspector-brick-migrations"
              className="font-mono text-text-secondary"
            >
              {manifest.migrations.join(", ")}
            </span>
          )}
        </div>
        <div>
          <span className="text-text-muted">Required Secrets: </span>
          {secretsList.length === 0 ? (
            <span className="text-text-muted">None</span>
          ) : (
            <span
              data-testid="inspector-brick-secrets"
              className="font-mono text-amber-300"
            >
              {secretsList.join(", ")}
            </span>
          )}
        </div>
      </div>

      {/* Secret Reference Bindings (for bricks declaring secrets) */}
      {secretsList.length > 0 && (
        <div
          data-testid="inspector-brick-secret-refs"
          className="space-y-2 border-t border-border pt-3"
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Secret Reference Handles (sec_*)
          </div>
          {secretsList.map((secretName) => {
            const val = secretInputs[secretName] ?? "";
            const trimmed = val.trim();
            const isInvalid = trimmed.length > 0 && !isValidSecretRefHandle(trimmed).ok;
            const defaultInlineHandle = `sec_${brickId.replace(/[^a-z0-9]+/g, "_")}_${secretName.toLowerCase()}`;
            const inlineHandle = inlineSecretHandles[secretName] ?? defaultInlineHandle;
            const inlineVal = inlineSecretValues[secretName] ?? "";
            const isInlineOpen = Boolean(inlineSecretOpen[secretName]);

            return (
              <div
                key={secretName}
                data-testid={`inspector-secret-row-${secretName}`}
                className="p-2 rounded bg-surface-base border border-border space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-mono text-[11px] font-semibold text-amber-300">
                    {secretName}
                  </div>
                  <button
                    type="button"
                    data-testid={`inline-add-secret-button-${secretName}`}
                    disabled={!enabledEntry || isViewer || isMutating}
                    onClick={() =>
                      setInlineSecretOpen((prev) => ({
                        ...prev,
                        [secretName]: !prev[secretName],
                      }))
                    }
                    className="px-2 py-0.5 rounded bg-accent/15 hover:bg-accent/25 border border-accent/40 text-[10px] font-semibold text-accent disabled:opacity-40"
                  >
                    + Add secret inline
                  </button>
                </div>

                {/* Select Existing Secret Dropdown */}
                <div className="space-y-1">
                  <select
                    aria-label={`Select existing secret for ${secretName}`}
                    data-testid={`select-existing-secret-${secretName}`}
                    disabled={!enabledEntry || isViewer || isMutating}
                    value={secrets.some((s) => s.ref === trimmed) ? trimmed : ""}
                    onChange={(e) => {
                      const chosen = e.target.value;
                      if (!chosen) return;
                      setSecretInputs((prev) => ({
                        ...prev,
                        [secretName]: chosen,
                      }));
                      void handleBindSecretRef(secretName, chosen);
                    }}
                    className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary disabled:opacity-50"
                  >
                    <option value="">Select existing secret from vault…</option>
                    {secrets.map((sec) => (
                      <option key={sec.ref} value={sec.ref}>
                        {sec.ref} ({sec.keyHint}) — {sec.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    placeholder="sec_..."
                    aria-label={`Secret handle for ${secretName}`}
                    data-testid={`secret-ref-input-${secretName}`}
                    disabled={!enabledEntry || isViewer || isMutating}
                    value={val}
                    onChange={(e) =>
                      setSecretInputs((prev) => ({
                        ...prev,
                        [secretName]: e.target.value,
                      }))
                    }
                    className="flex-1 px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary disabled:opacity-50"
                  />
                  <button
                    type="button"
                    data-testid={`secret-ref-bind-${secretName}`}
                    disabled={
                      !enabledEntry ||
                      isViewer ||
                      isMutating ||
                      trimmed.length === 0 ||
                      isInvalid
                    }
                    onClick={() => void handleBindSecretRef(secretName)}
                    className="px-2 py-1 rounded bg-surface-control border border-border-strong text-[11px] font-semibold text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Bind
                  </button>
                </div>

                {/* Inline Add Secret Form */}
                {isInlineOpen && (
                  <div
                    data-testid={`inline-add-secret-form-${secretName}`}
                    className="p-2 rounded bg-surface-raised border border-accent/40 space-y-1.5"
                  >
                    <div className="text-[10px] font-bold text-accent">
                      Create &amp; Seal Secret Inline (AES-GCM)
                    </div>
                    <input
                      type="text"
                      aria-label={`Inline secret handle for ${secretName}`}
                      data-testid={`inline-secret-handle-${secretName}`}
                      value={inlineHandle}
                      onChange={(e) =>
                        setInlineSecretHandles((prev) => ({
                          ...prev,
                          [secretName]: e.target.value,
                        }))
                      }
                      className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-amber-300"
                    />
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="Plaintext value (sealed immediately)"
                      aria-label={`Inline secret plaintext value for ${secretName}`}
                      data-testid={`inline-secret-value-${secretName}`}
                      value={inlineVal}
                      onChange={(e) =>
                        setInlineSecretValues((prev) => ({
                          ...prev,
                          [secretName]: e.target.value,
                        }))
                      }
                      className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
                    />
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setInlineSecretOpen((prev) => ({
                            ...prev,
                            [secretName]: false,
                          }))
                        }
                        className="px-2 py-0.5 rounded bg-surface-control border border-border text-[10px] text-text-secondary"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        data-testid={`inline-secret-submit-${secretName}`}
                        disabled={
                          isMutating ||
                          !inlineVal.trim() ||
                          !inlineHandle.trim().startsWith("sec_") ||
                          !isValidSecretRefHandle(inlineHandle.trim()).ok
                        }
                        onClick={() => void handleInlineCreateSecret(secretName)}
                        className="px-2.5 py-0.5 rounded bg-accent text-slate-950 font-bold text-[10px] disabled:opacity-40"
                      >
                        Seal &amp; Bind
                      </button>
                    </div>
                  </div>
                )}

                {isInvalid && (
                  <div
                    role="alert"
                    data-testid={`secret-ref-error-${secretName}`}
                    className="text-[10px] text-rose-400 font-semibold"
                  >
                    Secret reference must be an opaque handle matching sec_* — never raw plaintext.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Auto-generated Manifest Settings Form */}
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            {enabledEntry ? "Settings (Configurable)" : "Settings (Catalog Defaults)"}
          </span>
          <span className="text-[10px] text-text-muted">
            {enabledEntry ? "Enabled in project" : "Turn on brick to edit"}
          </span>
        </div>
        {settingsEntries.length === 0 ? (
          <div className="text-text-muted text-[11px]">
            This brick declares no configurable settings.
          </div>
        ) : (
          <div data-testid="inspector-brick-settings" className="space-y-2.5">
            {settingsEntries.map(([key, def]) => {
              const currentVal =
                key in draftSettings
                  ? draftSettings[key]
                  : (enabledEntry?.config?.[key] ?? def.default);
              const uiMeta = manifest.ui?.settings?.[key];
              const label = uiMeta?.label ?? key;
              const helpText = uiMeta?.helpText ?? uiMeta?.help;
              const validation = validationResults[key];

              const constraintText =
                def.type === "integer"
                  ? `integer (${def.min}..${def.max}, default ${def.default})`
                  : def.type === "enum"
                    ? `enum [${def.values.join(" | ")}] (default ${def.default})`
                    : def.type === "boolean"
                      ? `boolean (default ${String(def.default)})`
                      : def.type === "number"
                        ? `number (default ${String(def.default ?? 0)})`
                        : `string (default ${String(def.default ?? "")})`;

              return (
                <div
                  key={key}
                  data-testid={`inspector-setting-${key}`}
                  className="p-2.5 rounded bg-surface-base border border-border space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-mono font-semibold text-text-primary">{key}</div>
                      {uiMeta?.label && uiMeta.label !== key && (
                        <div className="text-[10px] text-text-secondary">{uiMeta.label}</div>
                      )}
                    </div>
                    <span
                      data-testid={`inspector-setting-value-${key}`}
                      className="font-mono px-1.5 py-0.5 rounded bg-surface-control text-accent font-bold"
                    >
                      {String(currentVal)}
                    </span>
                  </div>

                  {helpText && (
                    <div className="text-[10px] text-text-secondary">{helpText}</div>
                  )}

                  {/* Auto-generated widget per setting type */}
                  {def.type === "integer" && (
                    <div className="space-y-1.5">
                      <input
                        type="number"
                        aria-label={label}
                        data-testid={`setting-input-${key}`}
                        min={def.min}
                        max={def.max}
                        step={1}
                        disabled={!enabledEntry || isViewer || isMutating}
                        value={currentVal === "" ? "" : String(currentVal)}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const nextVal = raw === "" ? "" : Number(raw);
                          setDraftSettings((prev) => {
                            const next = { ...prev, [key]: nextVal };
                            setDirtyTarget({
                              kind: "brick",
                              id: brickId,
                              draftData: next,
                              baseRevision: currentRevision,
                            });
                            return next;
                          });
                          setSaveSuccess(false);
                        }}
                        className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary disabled:opacity-50"
                      />
                      <input
                        type="range"
                        aria-label={`${label} slider`}
                        data-testid={`setting-slider-${key}`}
                        min={def.min}
                        max={Math.min(def.max, 100000)}
                        step={1}
                        disabled={!enabledEntry || isViewer || isMutating}
                        value={
                          typeof currentVal === "number" && !Number.isNaN(currentVal)
                            ? Math.min(
                                Math.max(currentVal, def.min),
                                Math.min(def.max, 100000),
                              )
                            : def.default
                        }
                        onChange={(e) => {
                          setDraftSettings((prev) => ({
                            ...prev,
                            [key]: Number(e.target.value),
                          }));
                          setSaveSuccess(false);
                        }}
                        className="w-full accent-sky-400 disabled:opacity-50"
                      />
                    </div>
                  )}

                  {def.type === "enum" && (
                    <select
                      aria-label={label}
                      data-testid={`setting-select-${key}`}
                      disabled={!enabledEntry || isViewer || isMutating}
                      value={String(currentVal)}
                      onChange={(e) => {
                        setDraftSettings((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }));
                        setSaveSuccess(false);
                      }}
                      className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary disabled:opacity-50"
                    >
                      {def.values.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  )}

                  {def.type === "boolean" && (
                    <div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={Boolean(currentVal)}
                        aria-label={label}
                        data-testid={`setting-toggle-${key}`}
                        disabled={!enabledEntry || isViewer || isMutating}
                        onClick={() => {
                          setDraftSettings((prev) => ({
                            ...prev,
                            [key]: !currentVal,
                          }));
                          setSaveSuccess(false);
                        }}
                        className={`px-2.5 py-1 rounded font-mono text-[11px] font-semibold border transition disabled:opacity-50 ${
                          currentVal
                            ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300"
                            : "bg-surface-control border-border-strong text-text-muted"
                        }`}
                      >
                        {currentVal ? "Enabled (true)" : "Disabled (false)"}
                      </button>
                    </div>
                  )}

                  {(def.type === "string" || def.type === "number") && (
                    <input
                      type={def.type === "number" ? "number" : "text"}
                      aria-label={label}
                      data-testid={`setting-input-${key}`}
                      disabled={!enabledEntry || isViewer || isMutating}
                      value={currentVal === undefined ? "" : String(currentVal)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setDraftSettings((prev) => ({
                          ...prev,
                          [key]:
                            def.type === "number"
                              ? raw === ""
                                ? ""
                                : Number(raw)
                              : raw,
                        }));
                        setSaveSuccess(false);
                      }}
                      className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary disabled:opacity-50"
                    />
                  )}

                  <div className="text-[10px] text-text-muted">{constraintText}</div>

                  {validation && !validation.ok && (
                    <div
                      role="alert"
                      data-testid={`setting-error-${key}`}
                      className="text-[11px] text-rose-400 font-semibold"
                    >
                      {validation.error}
                    </div>
                  )}
                </div>
              );
            })}

            {enabledEntry && (
              <div className="flex items-center justify-between gap-2 pt-1">
                {saveSuccess ? (
                  <span
                    data-testid="brick-settings-saved-badge"
                    className="text-[11px] text-emerald-400 font-semibold"
                  >
                    ✓ Settings saved
                  </span>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  data-testid="brick-settings-save"
                  disabled={!enabledEntry || isViewer || isMutating || hasValidationErrors}
                  onClick={() => void handleSaveSettings()}
                  className="px-3 py-1.5 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isMutating ? "Saving…" : "Save Settings"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const EXTRA_NODE_CONFIG_FIELDS: Record<
  string,
  Record<string, CatalogSettingDefinition>
> = {
  "core.if": {
    field: { type: "string", default: "" },
    value: { type: "string", default: "" },
  },
  "core.switch": {
    field: { type: "string", default: "type" },
    defaultBranch: { type: "string", default: "default" },
  },
  "core.format_template": {
    to: { type: "string", default: "" },
    subject: { type: "string", default: "" },
    template: { type: "string", default: "" },
  },
  "omnichannel-outbound.send_message": {
    to: { type: "string", default: "" },
    subject: { type: "string", default: "" },
    body: { type: "string", default: "" },
  },
  "core.http_request": {
    url: { type: "string", default: "" },
    body: { type: "string", default: "" },
  },
};

function flattenOutputTableRows(
  value: unknown,
  prefix = "",
  sink: Array<{ path: string; type: string; valueText: string }> = [],
): Array<{ path: string; type: string; valueText: string }> {
  if (value === null || value === undefined || typeof value !== "object") {
    sink.push({
      path: prefix || "value",
      type: value === null ? "null" : typeof value,
      valueText: value === undefined ? "undefined" : String(value),
    });
    return sink;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      sink.push({ path: prefix || "[]", type: "array", valueText: "[]" });
      return sink;
    }
    value.forEach((item, idx) => {
      flattenOutputTableRows(item, prefix ? `${prefix}[${idx}]` : `[${idx}]`, sink);
    });
    return sink;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    sink.push({ path: prefix || "{}", type: "object", valueText: "{}" });
    return sink;
  }
  for (const [k, v] of entries) {
    const childPath = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      flattenOutputTableRows(v, childPath, sink);
    } else {
      sink.push({
        path: childPath,
        type: v === null ? "null" : typeof v,
        valueText: v === undefined ? "undefined" : String(v),
      });
    }
  }
  return sink;
}

function NodeIoAndTestStepPanel({
  nodeId,
  nodeType,
  isViewer,
  isRunning,
  testInputText,
  onChangeTestInputText,
  testInputSource,
  upstreamNodeId,
  outputViewMode,
  onChangeOutputViewMode,
  result,
  isPinned,
  pinnedOutput,
  onPinOutput,
  onUnpinOutput,
  onRunTestStep,
  onFocusErrorField,
}: {
  workflowId: string;
  nodeId: string;
  nodeType: string;
  nodeConfig: Record<string, unknown>;
  isViewer: boolean;
  isRunning: boolean;
  testInputText: string;
  onChangeTestInputText: (val: string) => void;
  testInputSource: "pinned" | "upstream" | "custom";
  upstreamNodeId: string | null;
  outputViewMode: "json" | "table";
  onChangeOutputViewMode: (mode: "json" | "table") => void;
  result: TestStepResponse | null;
  isPinned: boolean;
  pinnedOutput: unknown | undefined;
  onPinOutput: (output: unknown) => Promise<void>;
  onUnpinOutput: () => Promise<void>;
  onRunTestStep: (parsedInput: unknown) => Promise<void>;
  onFocusErrorField: (fieldKey: string) => void;
}) {
  let parsedTestInput: unknown = {};
  let jsonParseError: string | null = null;
  try {
    parsedTestInput = testInputText.trim() ? JSON.parse(testInputText) : {};
  } catch (err) {
    jsonParseError = err instanceof Error ? err.message : "Invalid JSON test input";
  }

  const handleTriggerRun = () => {
    if (isViewer || isRunning || jsonParseError) return;
    void onRunTestStep(parsedTestInput);
  };

  const displayOutputObj = useMemo(() => {
    if (!result) return null;
    if (
      result.output &&
      typeof result.output === "object" &&
      Object.keys(result.output).length > 0
    ) {
      return result.output;
    }
    try {
      return JSON.parse(result.outputPreview || "{}");
    } catch {
      return { raw: result.outputPreview };
    }
  }, [result]);

  const tableRows = useMemo(
    () => (displayOutputObj ? flattenOutputTableRows(displayOutputObj) : []),
    [displayOutputObj],
  );

  return (
    <div
      data-testid="inspector-test-step-panel"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          handleTriggerRun();
        }
      }}
      className="space-y-3 border-t border-border pt-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Preview Rehearsal (BYOC Preview)
          </div>
          <div
            data-testid="test-step-input-source-badge"
            className="text-[10px] font-mono text-sky-300 mt-0.5"
          >
            {testInputSource === "pinned"
              ? `📌 Pinned output from ${upstreamNodeId ?? "upstream"}`
              : testInputSource === "upstream"
                ? `↳ Last output from ${upstreamNodeId ?? "upstream"}`
                : "✎ Custom JSON test input"}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="pin-node-output-button"
            disabled={isViewer || isRunning || Boolean(jsonParseError && !displayOutputObj)}
            onClick={() =>
              void onPinOutput(displayOutputObj ?? pinnedOutput ?? parsedTestInput)
            }
            title="Pin this node's output as non-semantic test data for downstream steps"
            className="px-2.5 py-1.5 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-sky-200 font-semibold text-[11px] disabled:opacity-40"
          >
            📌 Pin output as test data
          </button>
          {isPinned && (
            <button
              type="button"
              data-testid="unpin-node-output-button"
              disabled={isViewer || isRunning}
              onClick={() => void onUnpinOutput()}
              title="Unpin test output for this node"
              className="px-2 py-1.5 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-text-secondary font-semibold text-[11px] disabled:opacity-40"
            >
              Unpin
            </button>
          )}
          <button
            type="button"
            data-testid="run-test-step-button"
            disabled={isViewer || isRunning || Boolean(jsonParseError)}
            onClick={handleTriggerRun}
            title="Execute single node in preview rehearsal mode (Ctrl+Enter)"
            className="px-3 py-1.5 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40"
          >
            {isRunning ? "Running…" : "▶ Test step"}
          </button>
        </div>
      </div>

      {isPinned && (
        <div
          data-testid="node-pinned-output-banner"
          className="p-2 rounded bg-sky-500/15 border border-sky-400/40 flex items-center justify-between gap-2 text-[11px] text-sky-200"
        >
          <span>📌 Pinned test output is active for this node (non-semantic).</span>
          <span className="font-mono text-[10px] text-sky-300 truncate max-w-[160px]">
            {JSON.stringify(pinnedOutput ?? {})}
          </span>
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor={`test-step-input-${nodeId}`}
          className="block text-[11px] font-semibold text-text-secondary"
        >
          Test Input Payload (JSON)
        </label>
        <textarea
          id={`test-step-input-${nodeId}`}
          aria-label="Test step JSON input"
          data-testid="test-step-input-editor"
          disabled={isViewer || isRunning}
          rows={5}
          value={testInputText}
          onChange={(e) => onChangeTestInputText(e.target.value)}
          className="w-full p-2 rounded bg-slate-950 border border-border-strong font-mono text-[11px] text-text-primary disabled:opacity-50"
        />
        {jsonParseError && (
          <div
            role="alert"
            data-testid="test-step-input-json-error"
            className="text-[11px] text-rose-400 font-semibold"
          >
            Invalid JSON: {jsonParseError}
          </div>
        )}
      </div>

      {result && (
        <div
          data-testid="test-step-result-container"
          className="space-y-2.5 border-t border-border pt-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span
                data-testid="test-step-status-badge"
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-bold text-[11px] border ${
                  result.status === "succeeded"
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                    : "bg-rose-500/15 border-rose-500/40 text-rose-300"
                }`}
              >
                {result.status === "succeeded" ? "✓ Succeeded" : "✕ Failed"}
              </span>
              <span
                data-testid="test-step-duration-badge"
                className="px-2 py-0.5 rounded bg-surface-base border border-border font-mono text-[11px] text-text-secondary"
              >
                {result.durationMs} ms
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="test-step-view-mode-json"
                onClick={() => onChangeOutputViewMode("json")}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                  outputViewMode === "json"
                    ? "bg-accent/20 border-accent text-accent"
                    : "bg-surface-control border-border text-text-secondary"
                }`}
              >
                JSON
              </button>
              <button
                type="button"
                data-testid="test-step-view-mode-table"
                onClick={() => onChangeOutputViewMode("table")}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                  outputViewMode === "table"
                    ? "bg-accent/20 border-accent text-accent"
                    : "bg-surface-control border-border text-text-secondary"
                }`}
              >
                Table / Tree
              </button>
            </div>
          </div>

          {result.status === "failed" && result.error && (
            <div
              role="alert"
              data-testid="test-step-error-card"
              className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/40 space-y-1.5 text-[11px]"
            >
              <div className="font-bold text-rose-300">
                <span className="uppercase text-[10px] text-rose-400 mr-1">
                  What happened:
                </span>
                <span data-testid="test-step-error-what">
                  {result.error.whatHappened}
                </span>
              </div>
              <div className="text-rose-200 font-mono">
                <span className="uppercase font-sans font-bold text-[10px] text-rose-400 mr-1">
                  Why:
                </span>
                <span data-testid="test-step-error-why">{result.error.why}</span>
              </div>
              <div className="text-amber-200">
                <span className="uppercase font-bold text-[10px] text-amber-400 mr-1">
                  What to do:
                </span>
                <span data-testid="test-step-error-todo">
                  {result.error.whatToDo}
                </span>
              </div>
              {result.error.field && (
                <div className="pt-1">
                  <button
                    type="button"
                    data-testid="test-step-error-focus-field"
                    onClick={() => onFocusErrorField(result.error!.field!)}
                    className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-200 font-semibold text-[10px]"
                  >
                    ⚑ Focus field "{result.error.field}" in Params
                  </button>
                </div>
              )}
            </div>
          )}

          <div
            data-testid="test-step-output-preview"
            tabIndex={0}
            aria-label={`Step output preview for ${nodeType}`}
            className="space-y-1 focus:outline-none focus:ring-2 focus:ring-accent rounded"
          >
            <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
              Step Output ({nodeType})
            </div>
            {outputViewMode === "json" ? (
              <pre
                tabIndex={0}
                aria-label="Test step output JSON"
                data-testid="test-step-output-json"
                className="p-2.5 rounded bg-slate-950 border border-border font-mono text-[11px] text-emerald-300 overflow-x-auto whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {JSON.stringify(displayOutputObj ?? {}, null, 2)}
              </pre>
            ) : (
              <div
                tabIndex={0}
                aria-label="Test step output table"
                data-testid="test-step-output-table"
                className="rounded bg-slate-950 border border-border overflow-x-auto focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <table className="w-full font-mono text-[10px] border-collapse">
                  <thead>
                    <tr className="text-left text-text-muted border-b border-border bg-surface-base">
                      <th className="py-1 px-2">Field Path</th>
                      <th className="py-1 px-2">Type</th>
                      <th className="py-1 px-2">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((row) => (
                      <tr key={row.path} className="border-b border-border/40">
                        <td className="py-1 px-2 font-semibold text-amber-300">
                          {row.path}
                        </td>
                        <td className="py-1 px-2 text-sky-300">{row.type}</td>
                        <td className="py-1 px-2 text-emerald-300">
                          {row.valueText}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NodeInspectorDetail({
  nodeId,
  workflowId,
}: {
  nodeId: string;
  workflowId?: string;
}) {
  const projectState = useStudioStore((s) => s.projectState);
  const currentRevision = useStudioStore((s) => s.currentRevision);
  const catalog = useStudioStore((s) => s.catalog);
  const readiness = useStudioStore((s) => s.readiness);
  const secrets = useStudioStore((s) => s.secrets);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const isMutating = useStudioStore((s) => s.isMutating);
  const highlightedInspectorField = useStudioStore(
    (s) => s.highlightedInspectorField,
  );
  const setHighlightedInspectorField = useStudioStore(
    (s) => s.setHighlightedInspectorField,
  );
  const canvasVisualDiff = useStudioStore((s) => s.canvasVisualDiff);
  const setDirtyTarget = useStudioStore((s) => s.setDirtyTarget);
  const commitOps = useStudioStore((s) => s.commitOps);
  const upsertSecret = useStudioStore((s) => s.upsertSecret);
  const selectItem = useStudioStore((s) => s.selectItem);
  const stepTestResults = useStudioStore((s) => s.stepTestResults);
  const pinnedStepOutputs = useStudioStore((s) => s.pinnedStepOutputs);
  const pinnedOutputsByWorkflow = useStudioStore(
    (s) => s.pinnedOutputsByWorkflow,
  );
  const isRunningTestStep = useStudioStore((s) => s.isRunningTestStep);
  const isRunningWorkflow = useStudioStore((s) => s.isRunningWorkflow);
  const runTestStep = useStudioStore((s) => s.runTestStep);
  const pinNodeOutput = useStudioStore((s) => s.pinNodeOutput);
  const unpinNodeOutput = useStudioStore((s) => s.unpinNodeOutput);
  const rerunFromNode = useStudioStore((s) => s.rerunFromNode);
  const activeReplayRun = useStudioStore((s) => s.activeReplayRun);
  const runHistoryDrawerOpen = useStudioStore((s) => s.runHistoryDrawerOpen);
  const startRunReplay = useStudioStore((s) => s.startRunReplay);
  const [rerunError, setRerunError] = useState<string | null>(null);

  const activeRole = getActiveRole({ orgs, activeOrgId });
  const isViewer = activeRole === "viewer";
  const entities = projectState?.entities ?? [];

  const wf = useMemo(() => {
    if (
      activeReplayRun?.historicalWorkflow &&
      (activeReplayRun.historicalWorkflow.id === workflowId ||
        activeReplayRun.historicalWorkflow.nodes.some((n) => n.id === nodeId))
    ) {
      return activeReplayRun.historicalWorkflow;
    }
    return (
      activeReplayRun?.historicalState?.workflows.find(
        (w) => w.id === workflowId || w.nodes.some((n) => n.id === nodeId),
      ) ??
      canvasVisualDiff?.toState.workflows.find(
        (w) => w.id === workflowId || w.nodes.some((n) => n.id === nodeId),
      ) ??
      canvasVisualDiff?.fromState.workflows.find(
        (w) => w.id === workflowId || w.nodes.some((n) => n.id === nodeId),
      ) ??
      projectState?.workflows.find(
        (w) => w.id === workflowId || w.nodes.some((n) => n.id === nodeId),
      )
    );
  }, [activeReplayRun, canvasVisualDiff, projectState?.workflows, workflowId, nodeId]);

  const node = wf?.nodes.find((n) => n.id === nodeId);
  const replayStepTelemetry = activeReplayRun?.nodeMap[nodeId] ?? null;

  const nodeDef = useMemo(
    () => (node ? getCatalogNodeDefinition(node.type, catalog) : null),
    [node, catalog],
  );

  const nodeDataJson = JSON.stringify(node?.data ?? {});
  const [activeNodeTab, setActiveNodeTab] = useState<"params" | "io">("params");
  const [draftLabel, setDraftLabel] = useState(node?.label ?? node?.id ?? "");
  const [draftData, setDraftData] = useState<Record<string, unknown>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [activePillPickerField, setActivePillPickerField] = useState<string | null>(
    null,
  );
  const [rawExpressionModeByField, setRawExpressionModeByField] = useState<
    Record<string, boolean>
  >({});
  const [newParamKey, setNewParamKey] = useState("");
  const [nodeInlineSecretOpen, setNodeInlineSecretOpen] = useState(false);
  const [nodeInlineHandle, setNodeInlineHandle] = useState("");
  const [nodeInlineValue, setNodeInlineValue] = useState("");
  const [testInputText, setTestInputText] = useState("{}");
  const [testInputSource, setTestInputSource] = useState<
    "pinned" | "upstream" | "custom"
  >("custom");
  const [outputViewMode, setOutputViewMode] = useState<"json" | "table">("json");

  const defaultUpstreamTestInput = useMemo(() => {
    if (!wf || !node) return { value: {}, source: "custom" as const, upstreamId: null as string | null };
    const inEdge = wf.edges.find((e) => e.target === node.id);
    if (!inEdge) return { value: {}, source: "custom" as const, upstreamId: null as string | null };
    const upId = inEdge.source;
    const pinned = pinnedStepOutputs[`${wf.id}:${upId}`] ?? pinnedStepOutputs[upId];
    if (pinned !== undefined) {
      const unwrapped =
        typeof pinned === "object" &&
        pinned !== null &&
        "out" in pinned &&
        Object.keys(pinned).length === 1
          ? pinned.out
          : pinned;
      return { value: unwrapped, source: "pinned" as const, upstreamId: upId };
    }
    const lastRes = stepTestResults[`${wf.id}:${upId}`] ?? stepTestResults[upId];
    if (lastRes && lastRes.status === "succeeded") {
      const unwrapped =
        typeof lastRes.output === "object" &&
        lastRes.output !== null &&
        "out" in lastRes.output &&
        Object.keys(lastRes.output).length === 1
          ? lastRes.output.out
          : lastRes.output;
      return { value: unwrapped, source: "upstream" as const, upstreamId: upId };
    }
    return { value: {}, source: "custom" as const, upstreamId: upId };
  }, [wf, node, pinnedStepOutputs, stepTestResults]);

  const defaultUpstreamJson = JSON.stringify(defaultUpstreamTestInput.value ?? {}, null, 2);

  useEffect(() => {
    setTestInputText(defaultUpstreamJson);
    setTestInputSource(defaultUpstreamTestInput.source);
  }, [node?.id, defaultUpstreamJson, defaultUpstreamTestInput.source]);

  useEffect(() => {
    if (!node || !nodeDef) return;
    setDraftLabel(node.label ?? node.id);
    const nextData: Record<string, unknown> = { ...node.data };
    const mergedSchema = {
      ...EXTRA_NODE_CONFIG_FIELDS[node.type],
      ...nodeDef.config,
    };
    for (const [k, def] of Object.entries(mergedSchema)) {
      if (!(k in nextData) && def.default !== undefined) {
        nextData[k] = def.default;
      }
    }
    setDraftData(nextData);
    setActivePillPickerField(null);
  }, [node?.id, node?.label, nodeDataJson, nodeDef]);

  const upstreamAncestors = useMemo(() => {
    if (!wf || !node) return [];
    return getUpstreamAncestorNodes(wf, node.id, catalog, entities);
  }, [wf, node, catalog, entities]);

  const ancestorSchemaMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const anc of upstreamAncestors) {
      map[anc.node.id] = anc.fields.map((f) => f.fieldName);
    }
    return map;
  }, [upstreamAncestors]);

  const effectivePorts = useMemo(() => {
    if (!node) return null;
    const previewNode = {
      ...node,
      data: { ...node.data, ...draftData },
    };
    return getEffectiveNodePorts(previewNode, catalog, entities);
  }, [node, draftData, catalog, entities]);

  if (!node || !wf || !nodeDef) {
    return <div className="text-xs text-text-muted">Node not found.</div>;
  }

  const mergedConfigMap: Record<string, CatalogSettingDefinition> = {
    ...EXTRA_NODE_CONFIG_FIELDS[node.type],
    ...nodeDef.config,
  };
  for (const existingKey of Object.keys(draftData)) {
    if (existingKey === "entity" || existingKey === "lastAuthor") continue;
    if (!(existingKey in mergedConfigMap)) {
      mergedConfigMap[existingKey] = { type: "string", default: "" };
    }
  }

  const configEntries = Object.entries(mergedConfigMap);
  const configValidation: Record<
    string,
    { ok: true; value: unknown } | { ok: false; error: string }
  > = {};
  const expressionValidationByField: Record<
    string,
    { ok: boolean; reason?: string }
  > = {};

  for (const [key, def] of configEntries) {
    const rawVal =
      key in draftData ? draftData[key] : (node.data?.[key] ?? def.default);
    const strVal = typeof rawVal === "string" ? rawVal : "";
    if (strVal.includes("{{") || strVal.includes("}}")) {
      const exprRes = validateStepExpression(strVal, ancestorSchemaMap);
      expressionValidationByField[key] = exprRes;
      if (!exprRes.ok) {
        configValidation[key] = {
          ok: false,
          error: exprRes.reason ?? "Invalid step expression.",
        };
      } else {
        configValidation[key] = { ok: true, value: strVal };
      }
    } else {
      expressionValidationByField[key] = { ok: true };
      configValidation[key] = validateBrickSettingValue(key, rawVal, def);
    }
  }
  const hasValidationErrors = Object.values(configValidation).some((v) => !v.ok);

  const incomingEdges = wf.edges.filter((e) => e.target === node.id);
  const outgoingEdges = wf.edges.filter((e) => e.source === node.id);
  const studioIssues = computeStudioValidationIssues(
    projectState,
    catalog,
    secrets,
    readiness,
  ).filter((iss) => iss.nodeId === node.id);
  const nodeIssues = [
    ...readiness.needs.filter(
      (n) =>
        n.path === `workflows.${wf.id}.nodes.${node.id}` ||
        n.message.includes(node.id),
    ),
    ...studioIssues.map((iss) => ({
      code: iss.code,
      message: iss.message,
    })),
  ];

  // Side-by-side node field diff when Canvas Visual Diff is active
  const nodeVisualDiffUpdate = canvasVisualDiff?.diff.workflows.updated
    .find((u) => u.id === wf.id)
    ?.nodesUpdated.find((nu) => nu.id === node.id);

  const selectedEntityName =
    typeof draftData.entity === "string"
      ? draftData.entity
      : (effectivePorts?.boundEntity?.name ?? "");

  const handleSelectEntity = (entityName: string) => {
    setDraftData((prev) => {
      const next: Record<string, unknown> = { ...prev };
      if (!entityName) {
        delete next.entity;
      } else {
        next.entity = entityName;
        if (
          node.type === "core.brick_event" &&
          (!next.event || next.event === "brick.updated")
        ) {
          next.event = `${entityName}.record_created`;
        }
      }
      return next;
    });
    setSaveSuccess(false);
  };

  const handleInsertDataPill = (fieldKey: string, pillExpression: string) => {
    setDraftData((prev) => {
      const def = mergedConfigMap[fieldKey];
      const existingRaw =
        fieldKey in prev ? prev[fieldKey] : (node.data?.[fieldKey] ?? def?.default ?? "");
      const existingStr = existingRaw === undefined || existingRaw === null ? "" : String(existingRaw);

      let nextVal: string;
      if (
        !existingStr ||
        existingStr === "{{value}}" ||
        fieldKey === "field" ||
        fieldKey === "to"
      ) {
        nextVal = pillExpression;
      } else if (existingStr.includes(pillExpression)) {
        nextVal = existingStr;
      } else {
        nextVal = `${existingStr}${existingStr.endsWith(" ") ? "" : " "}${pillExpression}`;
      }
      return {
        ...prev,
        [fieldKey]: nextVal,
      };
    });
    setSaveSuccess(false);
  };

  const handleRemoveDataPill = (fieldKey: string, rawPillToken: string) => {
    setDraftData((prev) => {
      const existingStr = String(prev[fieldKey] ?? "");
      const cleaned = existingStr
        .replace(rawPillToken, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      return {
        ...prev,
        [fieldKey]: cleaned,
      };
    });
    setSaveSuccess(false);
  };

  const handleAddCustomParam = () => {
    const trimmed = newParamKey.trim();
    if (!trimmed || trimmed === "entity" || trimmed === "lastAuthor") return;
    setDraftData((prev) => ({
      ...prev,
      [trimmed]: prev[trimmed] ?? "",
    }));
    setNewParamKey("");
    setSaveSuccess(false);
  };

  const handleSaveNode = async () => {
    if (isViewer || isMutating || hasValidationErrors) return;
    const nextData: Record<string, unknown> = { ...node.data, ...draftData };
    for (const [key] of configEntries) {
      const check = configValidation[key];
      if (!check || !check.ok) return;
      nextData[key] = check.value;
    }

    const res = await commitOps(
      [
        {
          opId: `update-node-${node.id}-${Date.now()}`,
          type: "update_node",
          workflowId: wf.id,
          nodeId: node.id,
          label: draftLabel.trim() || node.id,
          data: nextData,
        },
      ],
      `Update node ${draftLabel.trim() || node.id}`,
    );
    if (res.ok) {
      setSaveSuccess(true);
    }
  };

  const handleDeleteNode = async () => {
    if (isViewer || isMutating) return;
    const res = await commitOps(
      [
        {
          opId: `remove-node-${node.id}-${Date.now()}`,
          type: "remove_node",
          workflowId: wf.id,
          nodeId: node.id,
        },
      ],
      `Remove node ${node.label ?? node.id}`,
    );
    if (res.ok) {
      selectItem({ kind: "workflow", id: wf.id });
    }
  };

  const nodeSecretName =
    node.type === "core.webhook"
      ? "WEBHOOK_SIGNING_SECRET"
      : "AUTHORIZATION_BEARER";
  const boundNodeSecretRef =
    projectState?.secretRefs.find(
      (sr) =>
        (sr.targetKind === "connection" ||
          (sr.targetKind as string) === "node") &&
        sr.targetId === node.id,
    )?.ref ?? "";
  const defaultNodeSecretHandle = `sec_${node.id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_key`;

  const handleBindNodeSecret = async (ref: string) => {
    if (isViewer || isMutating || !ref) return;
    await commitOps(
      [
        {
          opId: `bind-node-sec-${node.id}-${Date.now()}`,
          type: "bind_secret_ref",
          targetKind: "connection",
          targetId: node.id,
          secretName: nodeSecretName,
          ref,
        },
      ],
      `Bind secret ${ref} to node ${node.label ?? node.id}`,
    );
  };

  const handleCreateNodeSecretInline = async () => {
    if (isViewer || isMutating) return;
    const ref = (nodeInlineHandle || defaultNodeSecretHandle).trim();
    const val = nodeInlineValue.trim();
    if (!ref.startsWith("sec_") || !isValidSecretRefHandle(ref).ok || !val) {
      return;
    }
    setNodeInlineValue("");
    setNodeInlineSecretOpen(false);
    await upsertSecret({
      ref,
      kind: node.type === "core.webhook" ? "webhook_secret" : "api_key",
      label: `${node.label ?? node.id} Secret`,
      appOrBrick: node.type,
      value: val,
      bindTarget: {
        targetKind: "node",
        targetId: node.id,
        secretName: nodeSecretName,
      },
    });
  };

  return (
    <div data-testid="inspector-node-detail" className="space-y-4 text-xs">
      {highlightedInspectorField && (
        <div
          data-testid="inspector-highlighted-field"
          data-field-key={highlightedInspectorField}
          className="p-2 rounded bg-amber-500/15 border border-amber-500/50 text-[11px] text-amber-200 flex items-center justify-between"
        >
          <span>
            ⚑ Focused offending field:{" "}
            <span className="font-mono font-bold text-accent">
              {highlightedInspectorField}
            </span>
          </span>
        </div>
      )}

      {nodeVisualDiffUpdate && canvasVisualDiff && (
        <div
          data-testid="inspector-node-side-by-side-diff"
          className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/40 space-y-2 text-[11px]"
        >
          <div className="font-bold text-amber-300 font-mono">
            ~ Side-by-Side Field Diff (r{canvasVisualDiff.fromRev} → r
            {canvasVisualDiff.toRev})
          </div>
          <table className="w-full font-mono text-[10px] border-collapse">
            <thead>
              <tr className="text-left text-text-muted border-b border-border">
                <th className="py-1 pr-2">Field</th>
                <th className="py-1 pr-2">Before (r{canvasVisualDiff.fromRev})</th>
                <th className="py-1">After (r{canvasVisualDiff.toRev})</th>
              </tr>
            </thead>
            <tbody>
              {nodeVisualDiffUpdate.before.label !==
                nodeVisualDiffUpdate.after.label && (
                <tr className="border-b border-border/50">
                  <td className="py-1 pr-2 font-bold text-text-primary">label</td>
                  <td className="py-1 pr-2 text-rose-300">
                    {JSON.stringify(nodeVisualDiffUpdate.before.label)}
                  </td>
                  <td className="py-1 text-emerald-300">
                    {JSON.stringify(nodeVisualDiffUpdate.after.label)}
                  </td>
                </tr>
              )}
              {Array.from(
                new Set([
                  ...Object.keys(nodeVisualDiffUpdate.before.data ?? {}),
                  ...Object.keys(nodeVisualDiffUpdate.after.data ?? {}),
                ]),
              ).map((fieldKey) => {
                const beforeVal = (
                  nodeVisualDiffUpdate.before.data as
                    | Record<string, unknown>
                    | undefined
                )?.[fieldKey];
                const afterVal = (
                  nodeVisualDiffUpdate.after.data as
                    | Record<string, unknown>
                    | undefined
                )?.[fieldKey];
                return (
                  <tr key={fieldKey} className="border-b border-border/50">
                    <td className="py-1 pr-2 font-bold text-text-primary">
                      {fieldKey}
                    </td>
                    <td className="py-1 pr-2 text-rose-300">
                      {JSON.stringify(beforeVal)}
                    </td>
                    <td className="py-1 text-emerald-300">
                      {JSON.stringify(afterVal)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-text-primary">{node.label ?? node.id}</h3>
          <div className="font-mono text-[11px] text-text-muted mt-0.5">
            <span data-testid="inspector-node-id">{node.id}</span> ·{" "}
            <span data-testid="inspector-node-type" className="text-accent">
              {node.type}
            </span>
          </div>
        </div>
        <button
          type="button"
          data-testid="inspector-delete-node-button"
          disabled={isViewer || isMutating || Boolean(activeReplayRun)}
          onClick={() => void handleDeleteNode()}
          className="px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 text-[11px] font-semibold disabled:opacity-40"
        >
          Delete
        </button>
      </div>

      {/* Run Replay Node Inspector Panel (AC 5) */}
      {activeReplayRun && (
        <div
          data-testid="inspector-run-replay-panel"
          className="p-3 rounded-lg bg-slate-900/95 border border-sky-400/50 space-y-2.5 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-bold text-sky-300">
              ⏮ Run Replay Step Inspector (r{activeReplayRun.run.revision})
            </span>
            <div className="flex items-center gap-1.5">
              <span
                data-testid="replay-node-status"
                className={`px-2 py-0.5 rounded font-bold text-[10px] border ${
                  replayStepTelemetry?.status === "succeeded"
                    ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300"
                    : replayStepTelemetry?.status === "failed"
                      ? "bg-rose-500/20 border-rose-500/50 text-rose-300"
                      : "bg-slate-800 border-slate-600 text-slate-300"
                }`}
              >
                {replayStepTelemetry?.status === "succeeded"
                  ? "✓ Succeeded"
                  : replayStepTelemetry?.status === "failed"
                    ? "✕ Failed"
                    : replayStepTelemetry?.status === "skipped"
                      ? "— Skipped"
                      : (replayStepTelemetry?.status ?? "Not executed")}
              </span>
              <span
                data-testid="replay-node-duration"
                className="px-2 py-0.5 rounded bg-surface-base border border-border font-mono text-[10px] text-text-secondary"
              >
                {Math.round(replayStepTelemetry?.durationMs ?? 0)} ms
              </span>
              <span
                data-testid="replay-node-retries"
                className="px-2 py-0.5 rounded bg-surface-base border border-border font-mono text-[10px] text-amber-300"
              >
                {replayStepTelemetry?.retries ?? 0}{" "}
                {(replayStepTelemetry?.retries ?? 0) === 1 ? "retry" : "retries"}
              </span>
            </div>
          </div>

          {((replayStepTelemetry?.inputPreview ?? "").includes(
            '"__truncated":true',
          ) ||
            (replayStepTelemetry?.outputPreview ?? "").includes(
              '"__truncated":true',
            )) && (
            <div
              role="status"
              data-testid="replay-preview-truncated-notice"
              className="p-2 rounded bg-amber-500/15 border border-amber-500/50 text-[11px] text-amber-200 font-semibold"
            >
              ⚠ Payload preview truncated at 16 KB cap (redacted preview stored in D1).
            </div>
          )}

          {replayStepTelemetry?.status === "failed" && (
            <div
              role="alert"
              data-testid="replay-node-error-card"
              className="p-2.5 rounded bg-rose-950/90 border border-rose-500/50 space-y-1.5"
            >
              <div
                data-testid="replay-node-error-message"
                className="font-bold text-rose-200 text-[11px]"
              >
                ✕ Step failed:{" "}
                {(replayStepTelemetry.errorStack ?? "Step execution failed")
                  .split("\n")[0]}
              </div>
              {replayStepTelemetry.errorStack && (
                <pre
                  data-testid="replay-node-error-stack"
                  className="p-2 rounded bg-slate-950 border border-rose-500/30 font-mono text-[10px] text-rose-300 overflow-x-auto whitespace-pre-wrap"
                >
                  {replayStepTelemetry.errorStack}
                </pre>
              )}
            </div>
          )}

          <div className="space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
              Recorded Redacted Input Preview
            </div>
            <pre
              data-testid="replay-node-input-preview"
              className="p-2 rounded bg-slate-950 border border-border font-mono text-[11px] text-sky-300 overflow-x-auto whitespace-pre-wrap"
            >
              {(() => {
                const raw = replayStepTelemetry?.inputPreview ?? "{}";
                try {
                  return JSON.stringify(JSON.parse(raw), null, 2);
                } catch {
                  return raw;
                }
              })()}
            </pre>
          </div>

          <div className="space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
              Recorded Redacted Output Preview
            </div>
            <pre
              data-testid="replay-node-output-preview"
              className="p-2 rounded bg-slate-950 border border-border font-mono text-[11px] text-emerald-300 overflow-x-auto whitespace-pre-wrap"
            >
              {(() => {
                const raw = replayStepTelemetry?.outputPreview ?? "{}";
                try {
                  return JSON.stringify(JSON.parse(raw), null, 2);
                } catch {
                  return raw;
                }
              })()}
            </pre>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border">
            <div className="flex flex-wrap items-center gap-1.5">
              {activeNodeTab !== "io" && (
                <>
                  <button
                    type="button"
                    data-testid="pin-node-output-button"
                    disabled={isViewer}
                    onClick={() => {
                      let parsedReplayOut: unknown = {};
                      try {
                        parsedReplayOut = JSON.parse(
                          replayStepTelemetry?.outputPreview || "{}",
                        );
                      } catch {
                        parsedReplayOut = {
                          raw: replayStepTelemetry?.outputPreview ?? "",
                        };
                      }
                      void pinNodeOutput(
                        wf.id,
                        node.id,
                        parsedReplayOut,
                        activeReplayRun.run.runId,
                      );
                    }}
                    className="px-2.5 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-sky-200 font-semibold text-[11px] disabled:opacity-40"
                  >
                    📌 Pin output as test data
                  </button>
                  {Boolean(
                    pinnedOutputsByWorkflow[wf.id]?.[node.id] ||
                      pinnedStepOutputs[`${wf.id}:${node.id}`] ||
                      pinnedStepOutputs[node.id],
                  ) && (
                    <button
                      type="button"
                      data-testid="unpin-node-output-button"
                      disabled={isViewer}
                      onClick={() => void unpinNodeOutput(wf.id, node.id)}
                      className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-text-secondary font-semibold text-[11px] disabled:opacity-40"
                    >
                      Unpin
                    </button>
                  )}
                </>
              )}
              {activeReplayRun.run.resolvedByRunId && !runHistoryDrawerOpen && (
                <button
                  type="button"
                  data-testid={`run-resolved-by-retry-badge-${activeReplayRun.run.runId}`}
                  onClick={() =>
                    void startRunReplay(
                      activeReplayRun.run.resolvedByRunId!,
                    )
                  }
                  className="px-2 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 font-semibold text-[11px]"
                >
                  ✓ Resolved by retry ({activeReplayRun.run.resolvedByRunId})
                </button>
              )}
            </div>

            <button
              type="button"
              data-testid="rerun-from-node-button"
              disabled={isViewer || isRunningWorkflow}
              onClick={async () => {
                setRerunError(null);
                const res = await rerunFromNode(
                  activeReplayRun.run.runId,
                  node.id,
                  true,
                );
                if (!res.ok) {
                  setRerunError(res.error);
                }
              }}
              title="Re-execute workflow starting from this step while reusing recorded upstream outputs"
              className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-[11px] disabled:opacity-40"
            >
              {isRunningWorkflow ? "⟳ Re-running…" : "↻ Re-run from this step"}
            </button>
          </div>

          {rerunError && (
            <div
              role="alert"
              data-testid="rerun-from-node-error"
              className="p-2 rounded bg-rose-500/15 border border-rose-500/40 text-[11px] text-rose-200"
            >
              {rerunError}
            </div>
          )}
        </div>
      )}

      {/* Node Inspector Sub-Tabs: Params · I/O & Test Step */}
      <div
        role="tablist"
        aria-label="Node Inspector Sections"
        data-testid="inspector-node-subtabs"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            const nextTab = activeNodeTab === "params" ? "io" : "params";
            setActiveNodeTab(nextTab);
            const targetTestId =
              nextTab === "params"
                ? "inspector-node-tab-params"
                : "inspector-node-tab-io";
            const btn = e.currentTarget.querySelector<HTMLButtonElement>(
              `[data-testid="${targetTestId}"]`,
            );
            btn?.focus();
          }
        }}
        className="flex items-center gap-1 p-1 rounded-lg bg-surface-base border border-border"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeNodeTab === "params"}
          data-testid="inspector-node-tab-params"
          onClick={() => setActiveNodeTab("params")}
          className={`flex-1 py-1 px-2 rounded text-[11px] font-semibold transition ${
            activeNodeTab === "params"
              ? "bg-accent text-slate-950 font-bold"
              : "text-text-secondary hover:text-text-primary"
          }`}
        >
          Params
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeNodeTab === "io"}
          data-testid="inspector-node-tab-io"
          onClick={() => setActiveNodeTab("io")}
          className={`flex-1 py-1 px-2 rounded text-[11px] font-semibold transition ${
            activeNodeTab === "io"
              ? "bg-accent text-slate-950 font-bold"
              : "text-text-secondary hover:text-text-primary"
          }`}
        >
          I/O &amp; Test Step
        </button>
      </div>

      {activeNodeTab === "io" && (
        <NodeIoAndTestStepPanel
          workflowId={wf.id}
          nodeId={node.id}
          nodeType={node.type}
          nodeConfig={{ ...node.data, ...draftData }}
          isViewer={isViewer}
          isRunning={isRunningTestStep}
          testInputText={testInputText}
          onChangeTestInputText={(val) => {
            setTestInputText(val);
            setTestInputSource("custom");
          }}
          testInputSource={testInputSource}
          upstreamNodeId={defaultUpstreamTestInput.upstreamId}
          outputViewMode={outputViewMode}
          onChangeOutputViewMode={setOutputViewMode}
          result={stepTestResults[`${wf.id}:${node.id}`] ?? stepTestResults[node.id] ?? null}
          isPinned={Boolean(
            pinnedOutputsByWorkflow[wf.id]?.[node.id] ||
              pinnedStepOutputs[`${wf.id}:${node.id}`] !== undefined ||
              pinnedStepOutputs[node.id] !== undefined,
          )}
          pinnedOutput={
            pinnedOutputsByWorkflow[wf.id]?.[node.id]?.output ??
            pinnedStepOutputs[`${wf.id}:${node.id}`] ??
            pinnedStepOutputs[node.id]
          }
          onPinOutput={async (outputToPin) => {
            await pinNodeOutput(
              wf.id,
              node.id,
              outputToPin,
              activeReplayRun?.run.runId,
            );
          }}
          onUnpinOutput={async () => {
            await unpinNodeOutput(wf.id, node.id);
          }}
          onRunTestStep={async (parsedInput) => {
            await runTestStep(wf.id, node.id, {
              nodeType: node.type,
              config: { ...node.data, ...draftData },
              input: parsedInput,
            });
          }}
          onFocusErrorField={(fieldKey) => {
            setHighlightedInspectorField(fieldKey);
            setActiveNodeTab("params");
          }}
        />
      )}

      {/* Editable Node Label, Entity Binding & Config with Structured Data-Pill Picker */}
      <div className={activeNodeTab === "io" ? "hidden" : "space-y-2.5 border-t border-border pt-3"}>
        <div>
          <label
            htmlFor="inspector-node-label-input"
            className="block text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1"
          >
            Step Label
          </label>
          <input
            id="inspector-node-label-input"
            type="text"
            data-testid="inspector-node-label-input"
            disabled={isViewer || isMutating}
            value={draftLabel}
            onChange={(e) => {
              const nextLabel = e.target.value;
              setDraftLabel(nextLabel);
              setDirtyTarget({
                kind: "node",
                id: node.id,
                workflowId: wf.id,
                draftData,
                draftLabel: nextLabel,
                baseRevision: currentRevision,
              });
              setSaveSuccess(false);
            }}
            className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong text-xs text-text-primary disabled:opacity-50"
          />
        </div>

        {/* Entity Binding for Dynamic col-* Ports */}
        <div>
          <label
            htmlFor="node-entity-select"
            className="block text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1"
          >
            Bound Entity (Dynamic col-* Ports)
          </label>
          <select
            id="node-entity-select"
            aria-label="Bound Entity"
            data-testid="node-entity-select"
            disabled={isViewer || isMutating}
            value={selectedEntityName}
            onChange={(e) => handleSelectEntity(e.target.value)}
            className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary disabled:opacity-50"
          >
            <option value="">None (Standard Node Ports)</option>
            {entities.map((ent) => (
              <option key={ent.name} value={ent.name}>
                {ent.name} ({ent.fields.length} fields)
              </option>
            ))}
          </select>
        </div>

        {/* Step Connection / Secret Binding (sec_*) */}
        <div
          data-testid="inspector-node-secret-binding"
          className="p-2 rounded bg-surface-base border border-border space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                Step Secret / Connection ({nodeSecretName})
              </div>
              {boundNodeSecretRef && (
                <div
                  data-testid="inspector-node-bound-secret-ref"
                  className="font-mono text-[11px] text-amber-300 mt-0.5"
                >
                  Bound: {boundNodeSecretRef}
                </div>
              )}
            </div>
            <button
              type="button"
              data-testid="inline-add-secret-button-node"
              disabled={isViewer || isMutating}
              onClick={() => {
                if (!nodeInlineHandle) {
                  setNodeInlineHandle(defaultNodeSecretHandle);
                }
                setNodeInlineSecretOpen((prev) => !prev);
              }}
              className="px-2 py-0.5 rounded bg-accent/15 hover:bg-accent/25 border border-accent/40 text-[10px] font-semibold text-accent disabled:opacity-40"
            >
              + Add secret inline
            </button>
          </div>

          <select
            aria-label="Select existing secret for step"
            data-testid="select-existing-secret-node"
            disabled={isViewer || isMutating}
            value={boundNodeSecretRef}
            onChange={(e) => {
              const chosen = e.target.value;
              if (chosen) {
                void handleBindNodeSecret(chosen);
              }
            }}
            className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary disabled:opacity-50"
          >
            <option value="">Select existing secret from vault…</option>
            {secrets.map((sec) => (
              <option key={sec.ref} value={sec.ref}>
                {sec.ref} ({sec.keyHint}) — {sec.label}
              </option>
            ))}
          </select>

          {nodeInlineSecretOpen && (
            <div
              data-testid="inline-add-secret-form-node"
              className="p-2 rounded bg-surface-raised border border-accent/40 space-y-1.5"
            >
              <div className="text-[10px] font-bold text-accent">
                Create &amp; Seal Step Secret Inline (AES-GCM)
              </div>
              <input
                type="text"
                aria-label="Inline step secret handle"
                data-testid="inline-secret-handle-node"
                value={nodeInlineHandle || defaultNodeSecretHandle}
                onChange={(e) => setNodeInlineHandle(e.target.value)}
                className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-amber-300"
              />
              <input
                type="password"
                autoComplete="off"
                placeholder="Plaintext value (sealed immediately)"
                aria-label="Inline step secret value"
                data-testid="inline-secret-value-node"
                value={nodeInlineValue}
                onChange={(e) => setNodeInlineValue(e.target.value)}
                className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setNodeInlineSecretOpen(false)}
                  className="px-2 py-0.5 rounded bg-surface-control border border-border text-[10px] text-text-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="inline-secret-submit-node"
                  disabled={
                    isMutating ||
                    !nodeInlineValue.trim() ||
                    !(nodeInlineHandle || defaultNodeSecretHandle)
                      .trim()
                      .startsWith("sec_") ||
                    !isValidSecretRefHandle(
                      (nodeInlineHandle || defaultNodeSecretHandle).trim(),
                    ).ok
                  }
                  onClick={() => void handleCreateNodeSecretInline()}
                  className="px-2.5 py-0.5 rounded bg-accent text-slate-950 font-bold text-[10px] disabled:opacity-40"
                >
                  Seal &amp; Bind
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Live Dynamic Data-Driven Ports Preview */}
        {effectivePorts &&
          (effectivePorts.boundEntity || effectivePorts.placeholders.length > 0) && (
            <div
              data-testid="inspector-node-dynamic-ports"
              className="p-2 rounded bg-surface-base border border-border space-y-1.5"
            >
              <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                Dynamic Data-Driven Ports
              </div>
              <div className="flex flex-wrap gap-1">
                {effectivePorts.outputs
                  .filter((p) => p.id.startsWith("col-"))
                  .map((p) => (
                    <span
                      key={`out-${p.id}`}
                      data-testid={`dynamic-port-out-${p.id}`}
                      className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 font-mono text-[10px] text-emerald-300"
                    >
                      out {p.id}:{p.dataType}
                    </span>
                  ))}
                {effectivePorts.inputs
                  .filter((p) => p.id.startsWith("col-") || p.id.startsWith("ph-"))
                  .map((p) => (
                    <span
                      key={`in-${p.id}`}
                      data-testid={`dynamic-port-in-${p.id}`}
                      className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/40 font-mono text-[10px] text-sky-300"
                    >
                      in {p.id}:{p.dataType}
                    </span>
                  ))}
              </div>
            </div>
          )}

        {configEntries.length > 0 && (
          <div className="space-y-2.5 pt-1">
            <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
              Node Configuration & Data Mapping
            </div>
            {configEntries.map(([key, def]) => {
              const currentVal =
                key in draftData ? draftData[key] : (node.data?.[key] ?? def.default);
              const currentStr =
                currentVal === undefined || currentVal === null ? "" : String(currentVal);
              const validation = configValidation[key];
              const exprValidation = expressionValidationByField[key];
              const supportsPills = def.type !== "boolean" && def.type !== "enum";
              const isPickerOpen = activePillPickerField === key;
              const isRawMode = Boolean(rawExpressionModeByField[key]);
              const extractedPills = supportsPills
                ? extractStepExpressionPills(currentStr)
                : [];

              return (
                <div
                  key={key}
                  data-testid={`node-config-field-${key}`}
                  className="p-2 rounded bg-surface-base border border-border space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono font-semibold text-text-primary">{key}</span>
                    {supportsPills && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          data-testid={`open-pill-picker-${key}`}
                          disabled={isViewer || isMutating}
                          onClick={() =>
                            setActivePillPickerField((prev) =>
                              prev === key ? null : key,
                            )
                          }
                          className="px-1.5 py-0.5 rounded bg-accent/15 hover:bg-accent/25 border border-accent/40 text-accent font-semibold text-[10px] disabled:opacity-40"
                        >
                          + Insert data pill
                        </button>
                        <button
                          type="button"
                          data-testid={`toggle-raw-expression-${key}`}
                          disabled={isViewer || isMutating}
                          onClick={() =>
                            setRawExpressionModeByField((prev) => ({
                              ...prev,
                              [key]: !prev[key],
                            }))
                          }
                          className="px-1.5 py-0.5 rounded bg-surface-control border border-border-strong text-text-secondary hover:text-text-primary text-[10px]"
                        >
                          {isRawMode ? "Visual mode" : "Advanced: Edit raw expression"}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Rendered Data Pill Chips */}
                  {extractedPills.length > 0 && (
                    <div
                      data-testid={`data-pill-chips-${key}`}
                      className="flex flex-wrap items-center gap-1.5 py-1"
                    >
                      {extractedPills.map((pill, idx) => {
                        const anc = upstreamAncestors.find(
                          (a) => a.node.id === pill.nodeId,
                        );
                        const matchedField = anc?.fields.find(
                          (f) => f.fieldName === pill.fieldPath,
                        );
                        const stepTitle =
                          anc?.label ?? pill.nodeId ?? "Trigger";
                        const badgeType = matchedField?.dataType ?? "any";
                        return (
                          <span
                            key={`${pill.raw}-${idx}`}
                            data-testid={`data-pill-chip-${key}-${pill.fieldPath}`}
                            data-pill-expression={pill.raw}
                            style={{
                              backgroundColor: "rgba(245, 158, 11, 0.16)",
                              borderColor: "rgba(245, 158, 11, 0.55)",
                              color: "#fde68a",
                            }}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border font-mono text-[10px] font-semibold"
                          >
                            <span>
                              [{stepTitle} → {pill.fieldPath} : {badgeType}]
                            </span>
                            <button
                              type="button"
                              aria-label={`Remove pill ${pill.fieldPath}`}
                              data-testid={`remove-pill-${key}-${pill.fieldPath}`}
                              disabled={isViewer || isMutating}
                              onClick={() => handleRemoveDataPill(key, pill.raw)}
                              className="ml-0.5 text-amber-300 hover:text-white font-bold"
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {def.type === "enum" ? (
                    <select
                      aria-label={`Node config ${key}`}
                      data-testid={`node-config-select-${key}`}
                      disabled={isViewer || isMutating}
                      value={String(currentVal)}
                      onChange={(e) => {
                        const nextVal = e.target.value;
                        setDraftData((prev) => {
                          const next = { ...prev, [key]: nextVal };
                          setDirtyTarget({
                            kind: "node",
                            id: node.id,
                            workflowId: wf.id,
                            draftData: next,
                            draftLabel,
                            baseRevision: currentRevision,
                          });
                          return next;
                        });
                        setSaveSuccess(false);
                      }}
                      className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary disabled:opacity-50"
                    >
                      {def.values.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  ) : def.type === "boolean" ? (
                    <input
                      type="checkbox"
                      aria-label={`Node config ${key}`}
                      data-testid={`node-config-toggle-${key}`}
                      disabled={isViewer || isMutating}
                      checked={Boolean(currentVal)}
                      onChange={(e) => {
                        const nextVal = e.target.checked;
                        setDraftData((prev) => {
                          const next = { ...prev, [key]: nextVal };
                          setDirtyTarget({
                            kind: "node",
                            id: node.id,
                            workflowId: wf.id,
                            draftData: next,
                            draftLabel,
                            baseRevision: currentRevision,
                          });
                          return next;
                        });
                        setSaveSuccess(false);
                      }}
                    />
                  ) : isRawMode ? (
                    <input
                      type="text"
                      aria-label={`Raw expression for ${key}`}
                      data-testid={`raw-expression-input-${key}`}
                      disabled={isViewer || isMutating}
                      value={currentStr}
                      onChange={(e) => {
                        const nextVal = e.target.value;
                        setDraftData((prev) => {
                          const next = { ...prev, [key]: nextVal };
                          setDirtyTarget({
                            kind: "node",
                            id: node.id,
                            workflowId: wf.id,
                            draftData: next,
                            draftLabel,
                            baseRevision: currentRevision,
                          });
                          return next;
                        });
                        setSaveSuccess(false);
                      }}
                      className="w-full px-2 py-1 rounded bg-slate-950 border border-accent/50 font-mono text-xs text-amber-200 disabled:opacity-50"
                    />
                  ) : (
                    <input
                      type={
                        (def.type === "integer" || def.type === "number") &&
                        !currentStr.includes("{{")
                          ? "number"
                          : "text"
                      }
                      aria-label={`Node config ${key}`}
                      data-testid={`node-config-input-${key}`}
                      disabled={isViewer || isMutating}
                      value={currentStr}
                      onFocus={() => {
                        if (supportsPills && upstreamAncestors.length > 0) {
                          setActivePillPickerField(key);
                        }
                      }}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const nextVal =
                          (def.type === "integer" || def.type === "number") &&
                          !raw.includes("{{")
                            ? raw === ""
                              ? ""
                              : Number(raw)
                            : raw;
                        setDraftData((prev) => {
                          const next = { ...prev, [key]: nextVal };
                          setDirtyTarget({
                            kind: "node",
                            id: node.id,
                            workflowId: wf.id,
                            draftData: next,
                            draftLabel,
                            baseRevision: currentRevision,
                          });
                          return next;
                        });
                        setSaveSuccess(false);
                      }}
                      className="w-full px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary disabled:opacity-50"
                    />
                  )}

                  {/* Hierarchical Data-Pill Picker Popover */}
                  {supportsPills && isPickerOpen && (
                    <div
                      data-testid={`data-pill-picker-${key}`}
                      style={{
                        backgroundColor: "#0f172a",
                        borderColor: "#334155",
                      }}
                      className="mt-1.5 p-2 rounded-lg border space-y-2 shadow-lg"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-accent">
                          Upstream Step Outputs (Click to Pick Pill)
                        </span>
                        <button
                          type="button"
                          onClick={() => setActivePillPickerField(null)}
                          className="text-[10px] text-text-muted hover:text-text-primary"
                        >
                          Close
                        </button>
                      </div>

                      {upstreamAncestors.length === 0 ? (
                        <div className="text-[11px] text-text-muted">
                          No upstream ancestor steps connected to this node. Connect an incoming wire first.
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {upstreamAncestors.map((anc) => (
                            <div
                              key={anc.node.id}
                              data-testid={`pill-group-${anc.node.id}`}
                              className="space-y-1"
                            >
                              <div className="flex items-center justify-between text-[11px] font-semibold text-text-secondary">
                                <span>
                                  {anc.label}{" "}
                                  <span className="font-mono text-[10px] text-text-muted">
                                    ({anc.node.id})
                                  </span>
                                </span>
                                {anc.boundEntityName && (
                                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[9px]">
                                    entity:{anc.boundEntityName}
                                  </span>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {anc.fields.map((f) => (
                                  <button
                                    key={`${anc.node.id}-${f.fieldName}`}
                                    type="button"
                                    data-testid={`pill-option-${anc.node.id}-${f.fieldName}`}
                                    onClick={() =>
                                      handleInsertDataPill(key, f.expression)
                                    }
                                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-amber-500/20 border border-slate-700 hover:border-amber-500/50 font-mono text-[10px] text-text-primary flex items-center gap-1 transition"
                                  >
                                    <span className="font-semibold text-amber-300">
                                      {f.label}
                                    </span>
                                    <span className="text-[9px] text-sky-300">
                                      :{f.dataType}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {exprValidation && !exprValidation.ok && (
                    <div
                      role="alert"
                      data-testid={`expression-validation-error-${key}`}
                      className="text-[11px] text-rose-400 font-semibold"
                    >
                      {exprValidation.reason}
                    </div>
                  )}

                  {validation && !validation.ok && exprValidation?.ok && (
                    <div
                      role="alert"
                      data-testid={`node-config-error-${key}`}
                      className="text-[11px] text-rose-400 font-semibold"
                    >
                      {validation.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Add Custom Input Parameter */}
        <div className="flex items-center gap-1.5 pt-1">
          <input
            type="text"
            placeholder="Add parameter key (e.g. body, to)…"
            aria-label="Add custom parameter key"
            data-testid="add-node-param-key"
            disabled={isViewer || isMutating}
            value={newParamKey}
            onChange={(e) => setNewParamKey(e.target.value)}
            className="flex-1 px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary disabled:opacity-50"
          />
          <button
            type="button"
            data-testid="add-node-param-button"
            disabled={isViewer || isMutating || !newParamKey.trim()}
            onClick={handleAddCustomParam}
            className="px-2 py-1 rounded bg-surface-control border border-border-strong text-[11px] font-semibold text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            + Field
          </button>
        </div>

        <div className="flex items-center justify-between pt-1">
          {saveSuccess ? (
            <span
              data-testid="inspector-node-saved-badge"
              className="text-[11px] text-emerald-400 font-semibold"
            >
              ✓ Node saved
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            data-testid="inspector-node-save"
            disabled={isViewer || isMutating || hasValidationErrors}
            onClick={() => void handleSaveNode()}
            className="px-3 py-1 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40"
          >
            Save Step
          </button>
        </div>
      </div>

      <div className="space-y-1.5 border-t border-border pt-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Parameters JSON
        </div>
        <pre
          data-testid="inspector-node-config"
          className="p-2 rounded bg-surface-base border border-border font-mono text-[11px] text-text-secondary overflow-x-auto"
        >
          {JSON.stringify(node.data, null, 2)}
        </pre>
      </div>

      <div className="space-y-1.5 border-t border-border pt-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Incoming Edges ({incomingEdges.length})
        </div>
        <div data-testid="inspector-node-incoming" className="space-y-1 font-mono text-[11px]">
          {incomingEdges.length === 0 ? (
            <div className="text-text-muted">None (root / trigger node)</div>
          ) : (
            incomingEdges.map((edge) => (
              <div key={edge.id} className="text-sky-400">
                {edge.source}.{edge.sourceHandle ?? "out"} → {edge.targetHandle ?? "in"}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-border pt-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Outgoing Edges ({outgoingEdges.length})
        </div>
        <div data-testid="inspector-node-outgoing" className="space-y-1 font-mono text-[11px]">
          {outgoingEdges.length === 0 ? (
            <div className="text-text-muted">None (terminal node)</div>
          ) : (
            outgoingEdges.map((edge) => (
              <div key={edge.id} className="text-emerald-400">
                {edge.sourceHandle ?? "out"} → {edge.target}.{edge.targetHandle ?? "in"}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-border pt-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Validation Status
        </div>
        <div data-testid="inspector-node-issues">
          {nodeIssues.length === 0 ? (
            <div className="text-emerald-400">✓ Valid node configuration</div>
          ) : (
            <ul className="space-y-1 text-amber-300">
              {nodeIssues.map((iss, idx) => (
                <li key={`${iss.code}:${idx}`}>
                  ⚠ {iss.code}: {iss.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function RightDock() {
  const open = useStudioStore((s) => s.rightDockOpen);
  const tab = useStudioStore((s) => s.rightDockTab);
  const selection = useStudioStore((s) => s.selection);
  const projectState = useStudioStore((s) => s.projectState);
  const revisions = useStudioStore((s) => s.revisions);
  const toggleRightDock = useStudioStore((s) => s.toggleRightDock);
  const setRightDockTab = useStudioStore((s) => s.setRightDockTab);

  if (!open) {
    return (
      <aside
        aria-label="Right Dock (Collapsed)"
        data-testid="right-dock-collapsed"
        className="w-10 shrink-0 bg-surface-raised border-l border-border flex flex-col items-center py-3 gap-3"
      >
        <button
          type="button"
          onClick={toggleRightDock}
          aria-label="Expand right dock"
          data-testid="right-dock-toggle"
          title="Expand Right Dock"
          className="p-1.5 rounded bg-surface-control text-text-secondary hover:text-text-primary text-xs"
        >
          ◀
        </button>
      </aside>
    );
  }

  const renderEntityInspector = (entityName: string) => {
    const entity = projectState?.entities.find((e) => e.name === entityName);
    if (!entity) {
      return (
        <div className="text-xs text-text-muted">
          Entity <span className="font-mono">{entityName}</span> not found in blueprint.
        </div>
      );
    }

    const ddl = formatEntityDdl(entity);
    const baseRoute = `/api/entities/${entity.name}`;

    return (
      <div data-testid="inspector-entity-detail" className="space-y-4 text-xs">
        <div>
          <h3 className="text-sm font-bold text-text-primary">Entity: {entity.name}</h3>
          <div className="font-mono text-[11px] text-text-muted mt-0.5">
            Table: ent_{entity.name} · {entity.fields.length} fields · workspace_id isolated
          </div>
        </div>

        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Generated REST CRUD Routes
          </div>
          <ul
            data-testid="inspector-entity-routes"
            className="space-y-1 font-mono text-[11px] text-sky-400"
          >
            <li>GET {baseRoute}</li>
            <li>POST {baseRoute}</li>
            <li>GET {baseRoute}/:id</li>
            <li>PATCH {baseRoute}/:id</li>
            <li>DELETE {baseRoute}/:id</li>
          </ul>
        </div>

        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Deterministic SQLite DDL Preview
          </div>
          <pre
            data-testid="inspector-entity-ddl"
            className="p-2.5 rounded bg-surface-base border border-border font-mono text-[11px] text-emerald-300 overflow-x-auto whitespace-pre-wrap"
          >
            {ddl}
          </pre>
        </div>
      </div>
    );
  };

  const renderWorkflowOrNodeInspector = () => {
    if (!selection) return null;
    if (selection.kind === "workflow") {
      const wf = projectState?.workflows.find((w) => w.id === selection.id);
      if (!wf) return <div className="text-xs text-text-muted">Workflow not found.</div>;
      return (
        <div data-testid="inspector-workflow-detail" className="space-y-3 text-xs">
          <h3 className="text-sm font-bold text-text-primary">{wf.name}</h3>
          <div className="font-mono text-[11px] text-text-muted">ID: {wf.id}</div>
          <div className="text-text-secondary">
            Nodes: {wf.nodes.length} · Edges: {wf.edges.length}
          </div>
        </div>
      );
    }

    if (selection.kind === "node") {
      return (
        <NodeInspectorDetail
          nodeId={selection.id}
          workflowId={selection.workflowId}
        />
      );
    }

    if (selection.kind === "revision") {
      const rev = revisions.find((r) => String(r.revision) === selection.id);
      if (!rev) return <div className="text-xs text-text-muted">Revision not found.</div>;
      const authorText =
        rev.author.type === "agent"
          ? `agent:${rev.author.client ?? rev.author.id}`
          : `human:${rev.author.id}`;
      return (
        <div data-testid="inspector-revision-detail" className="space-y-3 text-xs">
          <h3 className="text-sm font-bold text-text-primary">Revision #{rev.revision}</h3>
          <div className="font-mono text-[11px] text-text-muted">Author: {authorText}</div>
          <div className="text-text-secondary">{rev.summary ?? "Blueprint revision"}</div>
          <div className="font-mono text-[10px] text-text-muted break-all">
            Hash: {rev.semanticHash}
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <aside
      aria-label="Right Dock"
      data-testid="right-dock"
      className="w-80 shrink-0 bg-surface-raised border-l border-border flex flex-col"
    >
      <div className="h-10 px-3 border-b border-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="right-dock-tab-inspector"
            onClick={() => setRightDockTab("inspector")}
            className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
              tab === "inspector"
                ? "bg-surface-control text-accent"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            Inspector
          </button>
          <button
            type="button"
            data-testid="right-dock-tab-ledger"
            onClick={() => setRightDockTab("ledger")}
            className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
              tab === "ledger"
                ? "bg-surface-control text-accent"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            AI Change Ledger
          </button>
        </div>

        <button
          type="button"
          onClick={toggleRightDock}
          aria-label="Collapse right dock"
          data-testid="right-dock-toggle"
          title="Collapse Right Dock"
          className="p-1 rounded bg-surface-control text-text-secondary hover:text-text-primary text-xs"
        >
          ▶
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === "inspector" ? (
          <div data-testid="right-dock-inspector-panel" className="space-y-3">
            <SameObjectConflictCard />
            {!selection ? (
              <div
                data-testid="inspector-empty"
                className="p-4 rounded bg-surface-base border border-border text-text-muted text-xs text-center"
              >
                Select a brick, entity, workflow, node, or revision to inspect its read-only configuration and schema.
              </div>
            ) : selection.kind === "brick" ? (
              <BrickInspectorDetail brickId={selection.id} />
            ) : selection.kind === "entity" ? (
              renderEntityInspector(selection.id)
            ) : (
              renderWorkflowOrNodeInspector()
            )}
          </div>
        ) : (
          <div data-testid="right-dock-ledger-panel" className="space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2">
              Recent Changesets ({revisions.length})
            </div>
            <ChangeLedgerFeed compact />
          </div>
        )}
      </div>
    </aside>
  );
}
