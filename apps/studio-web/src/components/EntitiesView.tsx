import { useEffect, useMemo, useState } from "react";
import { getActiveRole, useStudioStore } from "../store.ts";
import {
  computeDestructiveEntityImpact,
  computeStudioValidationIssues,
  formatEntityCrudPreview,
  formatEntityDdl,
  formatEntityIsolationPreview,
  takesEntitiesInManifest,
  validateEntityDraft,
} from "../types.ts";
import type {
  DestructiveEntityImpact,
  EntityDefinition,
  EntityField,
  EntityFieldType,
} from "../types.ts";
import { AuthorBadge } from "./Badges.tsx";
import { DataBrowserView } from "./DataBrowserView.tsx";
import { WalletLedgerView } from "./WalletLedgerView.tsx";

const FIELD_TYPES: Array<{ value: EntityFieldType; label: string }> = [
  { value: "text", label: "text" },
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "integer", label: "integer" },
  { value: "boolean", label: "boolean" },
  { value: "enum", label: "enum" },
  { value: "json", label: "json" },
  { value: "datetime", label: "datetime" },
  { value: "relation", label: "relation" },
  { value: "date", label: "date" },
  { value: "money", label: "money" },
  { value: "longtext", label: "longtext" },
];

function formatFieldConstraints(field: EntityField): string {
  const parts: string[] = [];
  if (
    field.type === "text" ||
    field.type === "string" ||
    field.type === "json" ||
    field.type === "datetime"
  ) {
    parts.push(`maxLength: ${field.maxLength ?? 500}`);
  } else if (field.type === "number" || field.type === "integer") {
    if (field.min !== undefined) parts.push(`min: ${field.min}`);
    if (field.max !== undefined) parts.push(`max: ${field.max}`);
  } else if (field.type === "enum") {
    parts.push(`values: [${field.values.join(", ")}]`);
  } else if (field.type === "longtext") {
    parts.push(`maxLength: ${field.maxLength ?? 20000}`);
  } else if (field.type === "date") {
    parts.push("YYYY-MM-DD");
  } else if (field.type === "money") {
    parts.push(`{amount, currency} · currencies: [${field.currencies.join(", ")}]`);
  }
  if (field.relation) {
    parts.push(`relation: ${field.relation}`);
  }
  if (field.indexed) {
    parts.push("indexed");
  }
  if (field.default !== undefined && String(field.default) !== "") {
    parts.push(`default: ${String(field.default)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function normalizeFieldForSave(field: EntityField): EntityField {
  const common: {
    name: string;
    required: boolean;
    unique?: boolean;
    indexed?: boolean;
    relation?: string;
    default?: string | number | boolean;
  } = {
    name: field.name.trim(),
    required: Boolean(field.required),
    ...(field.unique ? { unique: true } : {}),
    ...(field.indexed ? { indexed: true } : {}),
    // Only a relation field carries a relation target; the blueprint refuses one on any other type.
    ...(field.type === "relation" && field.relation && field.relation.trim()
      ? { relation: field.relation.trim() }
      : {}),
    ...(field.default !== undefined && String(field.default) !== ""
      ? { default: field.default }
      : {}),
  };

  switch (field.type) {
    case "text":
    case "string":
    case "json":
    case "datetime":
    case "relation":
      return {
        ...common,
        type: field.type,
        maxLength:
          field.maxLength ??
          (field.type === "json"
            ? 5000
            : field.type === "datetime" || field.type === "relation"
              ? 64
              : 500),
      };
    case "number":
    case "integer":
      return {
        ...common,
        type: field.type,
        ...(field.min !== undefined ? { min: field.min } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
      };
    case "boolean":
      return {
        ...common,
        type: "boolean",
      };
    case "enum":
      return {
        ...common,
        type: "enum",
        values: field.values.map((v) => v.trim()).filter(Boolean),
      };
    case "date":
      return { ...common, type: "date" };
    case "money":
      return { ...common, type: "money", currencies: [...field.currencies] };
    case "longtext":
      return { ...common, type: "longtext", maxLength: field.maxLength ?? 20000 };
  }
}

export function EntitiesView() {
  const projectState = useStudioStore((s) => s.projectState);
  const readiness = useStudioStore((s) => s.readiness);
  const secrets = useStudioStore((s) => s.secrets);
  const catalog = useStudioStore((s) => s.catalog);
  const selection = useStudioStore((s) => s.selection);
  const highlightedTargets = useStudioStore((s) => s.highlightedTargets);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const isMutating = useStudioStore((s) => s.isMutating);
  const mutationError = useStudioStore((s) => s.mutationError);
  const canvasVisualDiff = useStudioStore((s) => s.canvasVisualDiff);

  const selectItem = useStudioStore((s) => s.selectItem);
  const setMutationError = useStudioStore((s) => s.setMutationError);
  const commitOps = useStudioStore((s) => s.commitOps);

  const activeRole = getActiveRole({ orgs, activeOrgId });
  const isViewer = activeRole === "viewer";

  const entities = useMemo(() => {
    if (!canvasVisualDiff) {
      return projectState?.entities ?? [];
    }
    const toEntities = canvasVisualDiff.toState.entities ?? [];
    const toNames = new Set(toEntities.map((e) => e.name));
    const removedEntities = (canvasVisualDiff.fromState.entities ?? []).filter(
      (e) => !toNames.has(e.name),
    );
    return [...toEntities, ...removedEntities];
  }, [canvasVisualDiff, projectState?.entities]);
  const entityDiffMap = useMemo(() => {
    const map = new Map<string, "added" | "changed" | "removed">();
    if (!canvasVisualDiff) return map;
    for (const e of canvasVisualDiff.diff.entities.added) {
      map.set(e.name, "added");
    }
    for (const e of canvasVisualDiff.diff.entities.updated) {
      map.set(e.name, "changed");
    }
    for (const e of canvasVisualDiff.diff.entities.removed) {
      map.set(e.name, "removed");
    }
    return map;
  }, [canvasVisualDiff]);
  const workflows = projectState?.workflows ?? [];
  const bricks = canvasVisualDiff?.toState.bricks ?? projectState?.bricks ?? [];
  const validationIssues = useMemo(
    () =>
      computeStudioValidationIssues(projectState, catalog, secrets, readiness),
    [projectState, catalog, secrets, readiness],
  );

  const hasDynamicEntities = useMemo(
    () => bricks.some((b) => b.id === "dynamic-entities"),
    [bricks],
  );

  const hasWalletOrUsageLedger = useMemo(
    () =>
      bricks.some(
        (b) =>
          b.id === "credit-wallet" ||
          b.id === "usage-metering" ||
          b.id === "metered-usage",
      ),
    [bricks],
  );

  const [editorMode, setEditorMode] = useState<"edit" | "create">("edit");
  const [activeDataSubTab, setActiveDataSubTab] = useState<
    "schema" | "browser" | "ledger"
  >(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = window.sessionStorage.getItem("studio:dataSubTab");
        if (saved === "browser" || saved === "ledger") return saved;
      } catch {
        // Ignore storage errors
      }
    }
    return "schema";
  });

  const handleSelectDataSubTab = (tab: "schema" | "browser" | "ledger") => {
    setActiveDataSubTab(tab);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem("studio:dataSubTab", tab);
      } catch {
        // Ignore storage errors
      }
    }
  };
  const [draftEntity, setDraftEntity] = useState<EntityDefinition>({
    name: "",
    workspaceScoped: true,
    fields: [{ name: "title", type: "text", required: true, maxLength: 500 }],
  });
  const [enumRawInputs, setEnumRawInputs] = useState<Record<number, string>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [pendingDestructive, setPendingDestructive] =
    useState<DestructiveEntityImpact | null>(null);

  const activeEntityName =
    selection?.kind === "entity"
      ? selection.id
      : entities[0]?.name ?? null;

  const activeEntity = useMemo(
    () => entities.find((e) => e.name === activeEntityName) ?? entities[0] ?? null,
    [entities, activeEntityName],
  );

  const activeEntityJson = JSON.stringify(activeEntity ?? null);

  // Automatically select first entity in Inspector if Schema Designer is opened and no entity is selected yet
  useEffect(() => {
    if (
      activeDataSubTab === "schema" &&
      activeEntity &&
      selection?.kind !== "entity" &&
      editorMode === "edit"
    ) {
      selectItem({ kind: "entity", id: activeEntity.name });
    }
  }, [activeDataSubTab, activeEntity, selection?.kind, selectItem, editorMode]);

  // Sync draftEntity when switching selected entity in edit mode
  useEffect(() => {
    if (editorMode === "edit") {
      if (activeEntity) {
        const cloned = structuredClone(activeEntity);
        setDraftEntity(cloned);
        const nextEnumInputs: Record<number, string> = {};
        cloned.fields.forEach((f, idx) => {
          if (f.type === "enum") {
            nextEnumInputs[idx] = f.values.join(", ");
          }
        });
        setEnumRawInputs(nextEnumInputs);
      } else {
        setDraftEntity({
          name: "",
          workspaceScoped: true,
          fields: [{ name: "title", type: "text", required: true, maxLength: 500 }],
        });
        setEnumRawInputs({});
      }
    }
  }, [activeEntityJson, editorMode]);

  const validation = useMemo(
    () =>
      validateEntityDraft(
        draftEntity,
        entities,
        catalog,
        editorMode === "edit" ? (activeEntity?.name ?? null) : null,
      ),
    [draftEntity, entities, catalog, editorMode, activeEntity?.name],
  );

  const usedByRefs = useMemo(() => {
    const targetName =
      editorMode === "edit" ? (activeEntity?.name ?? draftEntity.name) : draftEntity.name;
    if (!targetName) {
      return {
        bricks: [] as string[],
        workflows: [] as Array<{ id: string; name: string }>,
      };
    }

    const refBricks: string[] = [];
    for (const b of bricks) {
      const m = catalog[b.id];
      if (m && takesEntitiesInManifest(m)) {
        refBricks.push(b.id);
      }
    }

    const refWorkflows: Array<{ id: string; name: string }> = [];
    for (const wf of workflows) {
      const touches = wf.nodes.some(
        (node) =>
          node.type.includes(targetName) ||
          node.data?.entity === targetName ||
          JSON.stringify(node.data).includes(targetName),
      );
      if (touches) {
        refWorkflows.push({ id: wf.id, name: wf.name });
      }
    }

    return {
      bricks: refBricks,
      workflows: refWorkflows,
    };
  }, [activeEntity?.name, draftEntity.name, editorMode, bricks, catalog, workflows]);

  const handleTurnOnDynamicEntities = async () => {
    if (isViewer || isMutating) return;
    const stamp = Date.now();
    const ops: Array<Record<string, unknown>> = [];
    if (!bricks.some((b) => b.id === "multi-workspace")) {
      ops.push({
        opId: `enable-mw-${stamp}`,
        type: "enable_brick",
        brickId: "multi-workspace",
        config: {},
      });
    }
    ops.push({
      opId: `enable-de-${stamp}`,
      type: "enable_brick",
      brickId: "dynamic-entities",
      config: {},
    });
    await commitOps(ops, "Turn on dynamic-entities brick");
  };

  const handleStartNewEntity = () => {
    setMutationError(null);
    setSaveSuccess(false);
    setEditorMode("create");
    setDraftEntity({
      name: "",
      workspaceScoped: true,
      fields: [{ name: "title", type: "text", required: true, maxLength: 500 }],
    });
    setEnumRawInputs({});
  };

  const handleSelectExistingEntity = (name: string) => {
    setMutationError(null);
    setSaveSuccess(false);
    setEditorMode("edit");
    selectItem({ kind: "entity", id: name });
  };

  const handleAddField = () => {
    setSaveSuccess(false);
    setDraftEntity((prev) => ({
      ...prev,
      fields: [
        ...prev.fields,
        {
          name: `field_${prev.fields.length + 1}`,
          type: "text",
          required: false,
          maxLength: 500,
        },
      ],
    }));
  };

  const handleRemoveField = (index: number) => {
    setSaveSuccess(false);
    setDraftEntity((prev) => ({
      ...prev,
      fields: prev.fields.filter((_, i) => i !== index),
    }));
  };

  const handleMoveField = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draftEntity.fields.length) return;
    setSaveSuccess(false);
    setDraftEntity((prev) => {
      const next = [...prev.fields];
      const temp = next[index]!;
      next[index] = next[target]!;
      next[target] = temp;
      return { ...prev, fields: next };
    });
  };

  const handleUpdateField = (index: number, updater: (prev: EntityField) => EntityField) => {
    setSaveSuccess(false);
    setDraftEntity((prev) => ({
      ...prev,
      fields: prev.fields.map((f, i) => (i === index ? updater(f) : f)),
    }));
  };

  const handleChangeFieldType = (index: number, newType: EntityFieldType) => {
    setSaveSuccess(false);
    handleUpdateField(index, (prev) => {
      const base = {
        name: prev.name,
        required: prev.required ?? false,
        ...(prev.unique ? { unique: true } : {}),
        ...(prev.indexed ? { indexed: true } : {}),
        ...(prev.default !== undefined ? { default: prev.default } : {}),
      };
      if (newType === "enum") {
        const defaultValues =
          prev.type === "enum" && prev.values.length > 0
            ? prev.values
            : ["draft", "active"];
        setEnumRawInputs((map) => ({ ...map, [index]: defaultValues.join(", ") }));
        return { ...base, type: "enum", values: defaultValues };
      }
      if (newType === "number" || newType === "integer") {
        return { ...base, type: newType };
      }
      if (newType === "boolean") {
        return { ...base, type: "boolean" };
      }
      if (newType === "date") {
        return { ...base, type: "date" };
      }
      if (newType === "money") {
        return { ...base, type: "money", currencies: prev.type === "money" ? prev.currencies : ["INR"] };
      }
      if (newType === "longtext") {
        return { ...base, type: "longtext", maxLength: 20000 };
      }
      if (newType === "relation") {
        // The first other declared entity; with none, the target is left empty for the user to choose (a relation
        // to an undeclared entity is refused on save).
        const otherEntity = entities.find((e) => e.name !== draftEntity.name)?.name;
        return {
          ...base,
          type: "relation",
          relation: prev.relation ?? (otherEntity ? `${otherEntity}.id` : ""),
          maxLength: 64,
        };
      }
      return {
        ...base,
        type: newType,
        maxLength: newType === "json" ? 5000 : newType === "datetime" ? 64 : 500,
      };
    });
  };

  const executeSaveEntity = async () => {
    if (!validation.ok || isViewer || isMutating) return;
    const normalizedEntity: EntityDefinition = {
      name: draftEntity.name.trim(),
      workspaceScoped: true,
      fields: draftEntity.fields.map(normalizeFieldForSave),
    };

    const opType = editorMode === "create" ? "add_entity" : "update_entity";
    const res = await commitOps(
      [
        {
          opId: `${opType}-${normalizedEntity.name}-${Date.now()}`,
          type: opType,
          entity: normalizedEntity,
        },
      ],
      editorMode === "create"
        ? `Add entity ${normalizedEntity.name}`
        : `Update entity ${normalizedEntity.name}`,
    );

    if (res.ok) {
      setPendingDestructive(null);
      setEditorMode("edit");
      setSaveSuccess(true);
      selectItem({ kind: "entity", id: normalizedEntity.name });
    }
  };

  const handleSaveClick = () => {
    if (!validation.ok || isViewer || isMutating) return;
    if (editorMode === "edit" && activeEntity) {
      const impact = computeDestructiveEntityImpact(
        "update_entity",
        activeEntity.name,
        activeEntity,
        draftEntity,
        workflows,
      );
      if (impact.isDestructive) {
        setPendingDestructive(impact);
        return;
      }
    }
    void executeSaveEntity();
  };

  const handleDeleteEntityClick = (entityName: string) => {
    if (isViewer || isMutating) return;
    const targetEnt = entities.find((e) => e.name === entityName) ?? activeEntity;
    const impact = computeDestructiveEntityImpact(
      "remove_entity",
      entityName,
      targetEnt,
      null,
      workflows,
    );
    setPendingDestructive(impact);
  };

  const handleConfirmDestructive = async () => {
    if (!pendingDestructive) return;
    if (pendingDestructive.action === "remove_entity") {
      const nameToDelete = pendingDestructive.entityName;
      const res = await commitOps(
        [
          {
            opId: `remove-entity-${nameToDelete}-${Date.now()}`,
            type: "remove_entity",
            name: nameToDelete,
          },
        ],
        `Remove entity ${nameToDelete}`,
      );
      if (res.ok) {
        setPendingDestructive(null);
        const remaining = entities.filter((e) => e.name !== nameToDelete);
        if (remaining[0]) {
          selectItem({ kind: "entity", id: remaining[0].name });
        } else {
          selectItem(null);
        }
      }
    } else {
      await executeSaveEntity();
    }
  };

  const previewEntity = useMemo<EntityDefinition>(
    () => ({
      name: draftEntity.name.trim() || "new_entity",
      workspaceScoped: true,
      fields: draftEntity.fields,
    }),
    [draftEntity],
  );

  const crudPreview = useMemo(
    () => formatEntityCrudPreview(previewEntity),
    [previewEntity],
  );
  const isolationPreview = useMemo(
    () => formatEntityIsolationPreview(previewEntity),
    [previewEntity],
  );
  const ddlPreview = useMemo(
    () =>
      formatEntityDdl(
        previewEntity,
        editorMode === "edit" ? activeEntity : null,
      ),
    [previewEntity, editorMode, activeEntity],
  );

  const showDesigner = editorMode === "create" || Boolean(activeEntity);

  return (
    <div data-testid="view-data" className="space-y-6">
      {/* Sub-navigation bar: Schema Designer vs Workspace Data Browser */}
      <div
        role="tablist"
        aria-label="Data view sections"
        data-testid="data-subtabs"
        className="flex items-center gap-2 border-b border-border pb-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeDataSubTab === "schema"}
          data-testid="data-subtab-schema"
          onClick={() => handleSelectDataSubTab("schema")}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
            activeDataSubTab === "schema"
              ? "bg-surface-control text-text-primary border border-accent"
              : "text-text-secondary hover:text-text-primary border border-transparent"
          }`}
        >
          Schema Designer ({entities.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeDataSubTab === "browser"}
          data-testid="data-subtab-browser"
          onClick={() => handleSelectDataSubTab("browser")}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
            activeDataSubTab === "browser"
              ? "bg-surface-control text-text-primary border border-accent"
              : "text-text-secondary hover:text-text-primary border border-transparent"
          }`}
        >
          Data Browser (Workspace-Scoped)
        </button>
        {hasWalletOrUsageLedger && (
          <button
            type="button"
            role="tab"
            aria-selected={activeDataSubTab === "ledger"}
            data-testid="data-subtab-ledger"
            onClick={() => handleSelectDataSubTab("ledger")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
              activeDataSubTab === "ledger"
                ? "bg-surface-control text-text-primary border border-accent"
                : "text-text-secondary hover:text-text-primary border border-transparent"
            }`}
          >
            Wallet &amp; Usage Ledger
          </button>
        )}
      </div>

      {activeDataSubTab === "browser" ? (
        <DataBrowserView />
      ) : activeDataSubTab === "ledger" && hasWalletOrUsageLedger ? (
        <WalletLedgerView />
      ) : (
        <>
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

      {!hasDynamicEntities && (
        <div
          role="region"
          aria-label="Entity handler brick required"
          data-testid="entity-missing-handler-banner"
          className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/40 flex flex-wrap items-center justify-between gap-3 text-xs"
        >
          <div className="text-amber-200">
            <span className="font-bold">⚠ Entity routes are not mounted yet:</span> Turn on{" "}
            <span className="font-mono font-semibold">dynamic-entities</span> so declared tables are served at{" "}
            <span className="font-mono">/api/entities/:entity</span>.
          </div>
          <button
            type="button"
            data-testid="turn-on-dynamic-entities-button"
            disabled={isViewer || isMutating}
            onClick={() => void handleTurnOnDynamicEntities()}
            className="px-3 py-1.5 rounded bg-amber-400 text-slate-950 font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Turn on dynamic-entities
          </button>
        </div>
      )}

      <div className="p-4 rounded-lg bg-surface-raised border border-border flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-text-primary">
            Data — Declared Entities ({entities.length})
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            Workspace-isolated D1 tables (`ent_&lt;name&gt;`) with typed fields, constraints, REST CRUD routes, and deterministic SQLite DDL.
          </p>
        </div>
        <button
          type="button"
          data-testid="new-entity-button"
          disabled={isViewer || isMutating}
          onClick={handleStartNewEntity}
          className="px-3 py-1.5 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + New Entity
        </button>
      </div>

      {entities.length === 0 && !showDesigner ? (
        <div
          data-testid="entities-empty-state"
          className="p-6 rounded-lg bg-surface-raised border border-border text-center text-xs text-text-muted"
        >
          No entities declared in this blueprint yet. Click "+ New Entity" above or use an MCP agent (`define_entity`) to add your first table.
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {/* Left column: Entity List */}
          <div
            data-testid="entities-list-panel"
            className="col-span-4 space-y-2"
          >
            <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted px-1">
              Entities ({entities.length})
            </div>
            {entities.length === 0 && (
              <div
                data-testid="entities-empty-state"
                className="p-3 rounded-lg bg-surface-raised border border-border text-xs text-text-muted"
              >
                Creating first entity table…
              </div>
            )}
            {entities.map((ent) => {
              const isSelected =
                editorMode === "edit" && activeEntity?.name === ent.name;
              const highlight =
                highlightedTargets[`entity:${ent.name}`] ?? highlightedTargets[ent.name];
              const entDiffStatus = entityDiffMap.get(ent.name) ?? null;
              const entIssues = validationIssues.filter(
                (iss) => iss.entityName === ent.name,
              );
              return (
                <button
                  key={ent.name}
                  type="button"
                  data-testid={`entity-list-item-${ent.name}`}
                  data-highlighted={highlight ? "true" : "false"}
                  data-diff-status={entDiffStatus ?? undefined}
                  onClick={() => handleSelectExistingEntity(ent.name)}
                  className={`w-full p-3 rounded-lg border text-left transition flex flex-col gap-1.5 ${
                    entDiffStatus === "added"
                      ? "bg-surface-control border-emerald-500 text-text-primary ring-2 ring-emerald-500/40"
                      : entDiffStatus === "changed"
                        ? "bg-surface-control border-amber-400 text-text-primary ring-2 ring-amber-400/40"
                        : entDiffStatus === "removed"
                          ? "bg-rose-950/30 border-dashed border-rose-500/80 text-rose-300 opacity-80"
                          : isSelected
                            ? "bg-surface-control border-accent text-text-primary ring-1 ring-accent"
                            : highlight
                              ? "bg-surface-raised border-sky-400 ring-2 ring-sky-400/40"
                              : "bg-surface-raised border-border text-text-secondary hover:border-border-strong"
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <div>
                      <div
                        className={`font-bold text-xs font-mono ${
                          entDiffStatus === "removed"
                            ? "line-through text-rose-300"
                            : "text-text-primary"
                        }`}
                      >
                        {ent.name}
                      </div>
                      <div className="text-[11px] text-text-muted font-mono">
                        ent_{ent.name}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {entDiffStatus === "added" && (
                        <span
                          data-testid={`diff-badge-entity-added-${ent.name}`}
                          className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 text-[10px] font-bold"
                        >
                          + Added
                        </span>
                      )}
                      {entDiffStatus === "changed" && (
                        <span
                          data-testid={`diff-badge-entity-changed-${ent.name}`}
                          className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-amber-300 text-[10px] font-bold"
                        >
                          ~ Modified
                        </span>
                      )}
                      {entDiffStatus === "removed" && (
                        <span
                          data-testid={`diff-badge-entity-removed-${ent.name}`}
                          className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-500/50 text-rose-300 text-[10px] font-bold"
                        >
                          - Removed
                        </span>
                      )}
                      {highlight && (
                        <AuthorBadge
                          testId={`entity-author-badge-${ent.name}`}
                          authorLabel={highlight.authorLabel}
                          isAgent={highlight.isAgent}
                        />
                      )}
                      <span className="px-2 py-0.5 rounded bg-surface-base border border-border text-[10px] font-mono text-text-secondary">
                        {ent.fields.length} {ent.fields.length === 1 ? "field" : "fields"}
                      </span>
                    </div>
                  </div>
                  {entIssues.length > 0 && (
                    <div
                      data-testid={`inline-issue-badge-${ent.name}`}
                      className="p-1.5 rounded bg-rose-500/15 border border-rose-500/40 text-[10px] text-rose-200 space-y-0.5"
                    >
                      {entIssues.map((iss) => (
                        <div key={iss.id}>✕ {iss.message}</div>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Right column: Selected Entity Designer + Previews */}
          <div className="col-span-8 space-y-4">
            {showDesigner && (
              <>
                <div
                  data-testid={
                    editorMode === "edit" && activeEntity
                      ? `entity-detail-panel-${activeEntity.name}`
                      : "entity-detail-panel-new"
                  }
                  className="p-4 rounded-lg bg-surface-raised border border-border space-y-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1 flex-1 min-w-[240px]">
                      <div className="flex items-center gap-2">
                        <label
                          htmlFor="entity-name-input"
                          className="text-[11px] font-bold uppercase tracking-wider text-text-muted"
                        >
                          {editorMode === "create" ? "New Entity Name:" : "Entity Table:"}
                        </label>
                        <input
                          id="entity-name-input"
                          type="text"
                          data-testid="entity-name-input"
                          disabled={editorMode === "edit" || isViewer || isMutating}
                          placeholder="e.g. invoices"
                          value={draftEntity.name}
                          onChange={(e) => {
                            setSaveSuccess(false);
                            setDraftEntity((prev) => ({
                              ...prev,
                              name: e.target.value,
                            }));
                          }}
                          className="px-2.5 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-text-primary disabled:opacity-70"
                        />
                        <h3 className="text-sm font-bold text-text-primary font-mono">
                          ent_{draftEntity.name || "unnamed"}
                        </h3>
                      </div>

                      {validation.nameError && (
                        <div
                          role="alert"
                          data-testid="entity-name-error"
                          className="text-[11px] text-rose-400 font-semibold"
                        >
                          {validation.nameError}
                        </div>
                      )}

                      <div className="text-[11px] text-text-muted">
                        Tenancy:{" "}
                        <span className="font-mono text-emerald-400">
                          workspace_id NOT NULL
                        </span>{" "}
                        · Route:{" "}
                        <span className="font-mono text-sky-400">
                          /api/entities/{draftEntity.name || "unnamed"}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-semibold">
                        ✓ Workspace Scoped
                      </span>
                      {editorMode === "edit" && activeEntity && (
                        <button
                          type="button"
                          data-testid={`delete-entity-button-${activeEntity.name}`}
                          disabled={isViewer || isMutating}
                          onClick={() => handleDeleteEntityClick(activeEntity.name)}
                          className="px-2.5 py-1 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25 text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Delete Entity
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Interactive Field Table */}
                  <div className="overflow-x-auto">
                    <table
                      data-testid="entity-fields-table"
                      className="w-full text-left border-collapse text-xs"
                    >
                      <thead>
                        <tr className="border-b border-border text-[11px] uppercase tracking-wider text-text-muted">
                          <th className="py-2 px-2">Field Name</th>
                          <th className="py-2 px-2">Type</th>
                          <th className="py-2 px-2">Required</th>
                          <th className="py-2 px-2">Unique / Index</th>
                          <th className="py-2 px-2">Reference / Constraints</th>
                          <th className="py-2 px-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border font-mono">
                        {/* System columns */}
                        <tr className="text-text-muted bg-surface-base/40">
                          <td className="py-2 px-2">id</td>
                          <td className="py-2 px-2">TEXT (PK)</td>
                          <td className="py-2 px-2">✓ Yes</td>
                          <td className="py-2 px-2">✓ Yes</td>
                          <td className="py-2 px-2">Primary key</td>
                          <td className="py-2 px-2 text-right text-[10px]">System</td>
                        </tr>
                        <tr className="text-text-muted bg-surface-base/40">
                          <td className="py-2 px-2">workspace_id</td>
                          <td className="py-2 px-2">TEXT</td>
                          <td className="py-2 px-2">✓ Yes</td>
                          <td className="py-2 px-2">Indexed</td>
                          <td className="py-2 px-2">Workspace tenancy isolation</td>
                          <td className="py-2 px-2 text-right text-[10px]">System</td>
                        </tr>

                        {draftEntity.fields.map((field, idx) => {
                          const rowTestId = field.name
                            ? `entity-field-row-${field.name}`
                            : `entity-field-row-${idx}`;
                          const fieldErr = validation.fieldErrors[idx];
                          const entUpdate =
                            canvasVisualDiff?.diff.entities.updated.find(
                              (u) => u.name === draftEntity.name,
                            );
                          const isEntityAdded =
                            canvasVisualDiff?.diff.entities.added.some(
                              (a) => a.name === draftEntity.name,
                            ) ?? false;
                          const isEntityRemoved =
                            canvasVisualDiff?.diff.entities.removed.some(
                              (r) => r.name === draftEntity.name,
                            ) ?? false;
                          const fieldDiffStatus:
                            | "added"
                            | "changed"
                            | "removed"
                            | null = isEntityAdded
                            ? "added"
                            : isEntityRemoved
                              ? "removed"
                              : entUpdate?.fieldsAdded.some(
                                    (f) => f.name === field.name,
                                  )
                                ? "added"
                                : entUpdate?.fieldsUpdated.some(
                                      (f) => f.name === field.name,
                                    )
                                  ? "changed"
                                  : null;
                          return (
                            <tr
                              key={idx}
                              data-testid={rowTestId}
                              data-diff-status={fieldDiffStatus ?? undefined}
                              className={`text-text-primary align-top ${
                                fieldDiffStatus === "added"
                                  ? "bg-emerald-500/10"
                                  : fieldDiffStatus === "changed"
                                    ? "bg-amber-500/10"
                                    : fieldDiffStatus === "removed"
                                      ? "bg-rose-500/10 opacity-75"
                                      : ""
                              }`}
                            >
                              <td className="py-2 px-2 space-y-1">
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    aria-label={`Field ${idx + 1} name`}
                                    data-testid={`field-name-input-${idx}`}
                                    disabled={isViewer || isMutating}
                                    value={field.name}
                                    onChange={(e) =>
                                      handleUpdateField(idx, (prev) => ({
                                        ...prev,
                                        name: e.target.value,
                                      }))
                                    }
                                    className="w-32 px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-accent font-semibold disabled:opacity-50"
                                  />
                                  {fieldDiffStatus === "added" && (
                                    <span
                                      data-testid={`diff-badge-field-added-${field.name}`}
                                      className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 text-[10px] font-bold"
                                    >
                                      + Added
                                    </span>
                                  )}
                                  {fieldDiffStatus === "changed" && (
                                    <span
                                      data-testid={`diff-badge-field-changed-${field.name}`}
                                      className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-amber-300 text-[10px] font-bold"
                                    >
                                      ~ Modified
                                    </span>
                                  )}
                                </div>
                                <span className="sr-only">{field.name}</span>
                                {fieldErr && (
                                  <div
                                    role="alert"
                                    data-testid={`field-error-${idx}`}
                                    className="text-[10px] text-rose-400 font-sans font-semibold max-w-[180px]"
                                  >
                                    {fieldErr}
                                  </div>
                                )}
                              </td>

                              <td className="py-2 px-2">
                                <select
                                  aria-label={`Field ${idx + 1} type`}
                                  data-testid={`field-type-select-${idx}`}
                                  disabled={isViewer || isMutating}
                                  value={field.type}
                                  onChange={(e) =>
                                    handleChangeFieldType(
                                      idx,
                                      e.target.value as EntityFieldType,
                                    )
                                  }
                                  className="px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-xs text-sky-400 disabled:opacity-50"
                                >
                                  {FIELD_TYPES.map((ft) => (
                                    <option key={ft.value} value={ft.value}>
                                      {ft.label}
                                    </option>
                                  ))}
                                </select>
                                <span className="sr-only">{field.type}</span>
                              </td>

                              <td className="py-2 px-2">
                                <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-[11px]">
                                  <input
                                    type="checkbox"
                                    data-testid={`field-required-toggle-${idx}`}
                                    disabled={isViewer || isMutating}
                                    checked={Boolean(field.required)}
                                    onChange={(e) =>
                                      handleUpdateField(idx, (prev) => ({
                                        ...prev,
                                        required: e.target.checked,
                                      }))
                                    }
                                    className="rounded accent-sky-400"
                                  />
                                  <span>{field.required ? "✓ Required" : "Optional"}</span>
                                </label>
                              </td>

                              <td className="py-2 px-2 space-y-1">
                                <label className="flex items-center gap-1.5 cursor-pointer select-none text-[11px]">
                                  <input
                                    type="checkbox"
                                    data-testid={`field-unique-toggle-${idx}`}
                                    disabled={isViewer || isMutating}
                                    checked={Boolean(field.unique)}
                                    onChange={(e) =>
                                      handleUpdateField(idx, (prev) => ({
                                        ...prev,
                                        unique: e.target.checked,
                                      }))
                                    }
                                    className="rounded accent-sky-400"
                                  />
                                  <span>{field.unique ? "✓ Unique" : "Unique"}</span>
                                </label>
                                <label className="flex items-center gap-1.5 cursor-pointer select-none text-[11px] text-text-secondary">
                                  <input
                                    type="checkbox"
                                    data-testid={`field-indexed-toggle-${idx}`}
                                    disabled={isViewer || isMutating}
                                    checked={Boolean(field.indexed)}
                                    onChange={(e) =>
                                      handleUpdateField(idx, (prev) => ({
                                        ...prev,
                                        indexed: e.target.checked,
                                      }))
                                    }
                                    className="rounded accent-sky-400"
                                  />
                                  <span>Indexed</span>
                                </label>
                              </td>

                              <td className="py-2 px-2 text-text-secondary space-y-1.5">
                                <div className="text-[11px]">
                                  {formatFieldConstraints(field)}
                                </div>

                                {field.type === "enum" && (
                                  <input
                                    type="text"
                                    aria-label={`Field ${idx + 1} enum values`}
                                    data-testid={`field-enum-values-input-${idx}`}
                                    disabled={isViewer || isMutating}
                                    placeholder="draft, paid, void"
                                    value={
                                      idx in enumRawInputs
                                        ? enumRawInputs[idx]
                                        : field.values.join(", ")
                                    }
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      setEnumRawInputs((prev) => ({
                                        ...prev,
                                        [idx]: raw,
                                      }));
                                      const parsedVals = raw
                                        .split(",")
                                        .map((v) => v.trim())
                                        .filter(Boolean);
                                      handleUpdateField(idx, (prev) =>
                                        prev.type === "enum"
                                          ? { ...prev, values: parsedVals }
                                          : prev,
                                      );
                                    }}
                                    className="w-44 px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary disabled:opacity-50"
                                  />
                                )}

                                {(field.type === "relation" || field.relation !== undefined) && (
                                  <input
                                    type="text"
                                    aria-label={`Field ${idx + 1} relation target`}
                                    data-testid={`field-relation-input-${idx}`}
                                    disabled={isViewer || isMutating}
                                    placeholder="accounts.id"
                                    value={field.relation ?? ""}
                                    onChange={(e) =>
                                      handleUpdateField(idx, (prev) => ({
                                        ...prev,
                                        relation: e.target.value,
                                      }))
                                    }
                                    className="w-40 px-2 py-1 rounded bg-surface-control border border-border-strong font-mono text-[11px] text-text-primary disabled:opacity-50"
                                  />
                                )}

                                <div className="flex items-center gap-1">
                                  <span className="text-[10px] text-text-muted">default:</span>
                                  <input
                                    type="text"
                                    aria-label={`Field ${idx + 1} default value`}
                                    data-testid={`field-default-input-${idx}`}
                                    disabled={isViewer || isMutating}
                                    placeholder="optional"
                                    value={
                                      field.default === undefined
                                        ? ""
                                        : String(field.default)
                                    }
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      handleUpdateField(idx, (prev) => ({
                                        ...prev,
                                        default:
                                          raw === ""
                                            ? undefined
                                            : prev.type === "number" ||
                                                prev.type === "integer"
                                              ? Number(raw)
                                              : prev.type === "boolean"
                                                ? raw === "true"
                                                : raw,
                                      }));
                                    }}
                                    className="w-28 px-1.5 py-0.5 rounded bg-surface-control border border-border font-mono text-[10px] text-text-primary disabled:opacity-50"
                                  />
                                </div>
                              </td>

                              <td className="py-2 px-2 text-right">
                                <div className="inline-flex items-center gap-1">
                                  <button
                                    type="button"
                                    title="Move field up"
                                    data-testid={`field-move-up-${idx}`}
                                    disabled={isViewer || isMutating || idx === 0}
                                    onClick={() => handleMoveField(idx, -1)}
                                    className="px-1.5 py-0.5 rounded bg-surface-control border border-border text-[10px] text-text-secondary hover:text-text-primary disabled:opacity-30"
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    title="Move field down"
                                    data-testid={`field-move-down-${idx}`}
                                    disabled={
                                      isViewer ||
                                      isMutating ||
                                      idx === draftEntity.fields.length - 1
                                    }
                                    onClick={() => handleMoveField(idx, 1)}
                                    className="px-1.5 py-0.5 rounded bg-surface-control border border-border text-[10px] text-text-secondary hover:text-text-primary disabled:opacity-30"
                                  >
                                    ↓
                                  </button>
                                  <button
                                    type="button"
                                    title="Remove field"
                                    data-testid={`field-remove-button-${idx}`}
                                    disabled={
                                      isViewer ||
                                      isMutating ||
                                      draftEntity.fields.length <= 1
                                    }
                                    onClick={() => handleRemoveField(idx)}
                                    className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-[10px] text-rose-300 hover:bg-rose-500/25 disabled:opacity-30"
                                  >
                                    ✕
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Field Editor Footer Actions */}
                  <div className="pt-2 border-t border-border flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      data-testid="add-field-button"
                      disabled={isViewer || isMutating || draftEntity.fields.length >= 30}
                      onClick={handleAddField}
                      className="px-3 py-1.5 rounded bg-surface-control border border-border-strong text-xs font-semibold text-text-primary hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      + Add Field
                    </button>

                    <div className="flex items-center gap-3">
                      {saveSuccess && (
                        <span
                          data-testid="entity-saved-badge"
                          className="text-xs font-semibold text-emerald-400"
                        >
                          ✓ Entity saved
                        </span>
                      )}
                      {editorMode === "create" && entities.length > 0 && (
                        <button
                          type="button"
                          data-testid="cancel-new-entity-button"
                          onClick={() => setEditorMode("edit")}
                          className="px-3 py-1.5 rounded bg-surface-control border border-border-strong text-xs font-semibold text-text-secondary hover:text-text-primary"
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="save-entity-button"
                        disabled={!validation.ok || isViewer || isMutating}
                        onClick={handleSaveClick}
                        className="px-3.5 py-1.5 rounded bg-accent text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {isMutating
                          ? "Saving…"
                          : editorMode === "create"
                            ? "Create Entity Table"
                            : "Save Entity Changes"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* "Used by" panel */}
                <div
                  data-testid="entity-used-by-panel"
                  className="p-4 rounded-lg bg-surface-raised border border-border space-y-2"
                >
                  <h4 className="text-xs font-bold uppercase tracking-wider text-text-primary">
                    Used By (Bricks & Workflows)
                  </h4>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {usedByRefs.bricks.map((brickId) => (
                      <button
                        key={brickId}
                        type="button"
                        data-testid={`entity-used-by-brick-${brickId}`}
                        onClick={() => selectItem({ kind: "brick", id: brickId }, "bricks")}
                        className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong font-mono text-emerald-400"
                      >
                        ▣ Brick: {brickId}
                      </button>
                    ))}
                    {usedByRefs.workflows.map((wf) => (
                      <button
                        key={wf.id}
                        type="button"
                        data-testid={`entity-used-by-workflow-${wf.id}`}
                        onClick={() => selectItem({ kind: "workflow", id: wf.id }, "workflows")}
                        className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong font-mono text-sky-300"
                      >
                        ☍ Workflow: {wf.name} ({wf.id})
                      </button>
                    ))}
                    {usedByRefs.bricks.length === 0 && usedByRefs.workflows.length === 0 && (
                      <span className="text-text-muted">
                        No enabled bricks or workflows reference this entity yet.
                      </span>
                    )}
                  </div>
                </div>

                {/* Live Preview 1: SQLite Migration Preview (CREATE TABLE + ALTER TABLE diff) */}
                <div
                  data-testid="entity-sql-preview-panel"
                  className="p-4 rounded-lg bg-surface-raised border border-border space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-text-primary">
                      Generated SQLite DDL (workspace_id Scoped)
                    </h4>
                    <span className="font-mono text-[11px] text-sky-400">
                      REST CRUD: /api/entities/{previewEntity.name}
                    </span>
                  </div>
                  <pre
                    data-testid="entity-sql-ddl-code"
                    className="p-3 rounded bg-surface-base border border-border font-mono text-[11px] text-emerald-300 overflow-x-auto whitespace-pre-wrap"
                  >
                    {ddlPreview}
                  </pre>
                </div>

                {/* Live Preview 2: REST CRUD Routes & JSON Payload Schemas */}
                <div
                  data-testid="entity-crud-routes-preview"
                  className="p-4 rounded-lg bg-surface-raised border border-border space-y-3 text-xs"
                >
                  <h4 className="text-xs font-bold uppercase tracking-wider text-text-primary">
                    REST CRUD Routes & Request/Response Schema Preview
                  </h4>
                  <ul className="space-y-1 font-mono text-[11px] text-sky-400">
                    {crudPreview.endpoints.map((ep) => (
                      <li key={`${ep.method}:${ep.path}`}>
                        <span className="font-bold text-text-primary">{ep.method}</span>{" "}
                        {ep.path}{" "}
                        <span className="text-text-muted font-sans">— {ep.description}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
                        POST / PATCH Body Schema
                      </div>
                      <pre
                        data-testid="entity-crud-request-schema"
                        // Scrollable code block: focusable so keyboard users can scroll it (axe scrollable-region-focusable).
                        tabIndex={0}
                        role="region"
                        aria-label="POST / PATCH body schema"
                        className="p-2.5 rounded bg-surface-base border border-border font-mono text-[11px] text-text-secondary overflow-x-auto"
                      >
                        {JSON.stringify(crudPreview.requestBodySchema, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
                        Response Item Schema
                      </div>
                      <pre
                        data-testid="entity-crud-response-schema"
                        // Scrollable code block: focusable so keyboard users can scroll it (axe scrollable-region-focusable).
                        tabIndex={0}
                        role="region"
                        aria-label="Response item schema"
                        className="p-2.5 rounded bg-surface-base border border-border font-mono text-[11px] text-text-secondary overflow-x-auto"
                      >
                        {JSON.stringify(crudPreview.responseItemSchema, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>

                {/* Live Preview 3: Cross-Workspace Isolation Contract */}
                <div
                  data-testid="entity-isolation-preview"
                  className="p-4 rounded-lg bg-surface-raised border border-border space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-text-primary">
                      Cross-Workspace Tenant Isolation Preview (AD-7 / C1)
                    </h4>
                    <span className="font-mono text-[11px] text-emerald-400">
                      WHERE "workspace_id" = :ctx.workspaceId
                    </span>
                  </div>
                  <pre
                    data-testid="entity-isolation-sql-code"
                    className="p-3 rounded bg-surface-base border border-border font-mono text-[11px] text-amber-200 overflow-x-auto whitespace-pre-wrap"
                  >
                    {isolationPreview}
                  </pre>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Destructive Migration Confirmation Modal */}
      {pendingDestructive && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Destructive Migration Confirmation"
          data-testid="destructive-entity-modal"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-lg rounded-lg bg-surface-raised border border-border-strong p-5 space-y-4 text-xs shadow-xl">
            <div>
              <h3 className="text-sm font-bold text-rose-300">
                ⚠ Destructive Migration Confirmation — ent_{pendingDestructive.entityName}
              </h3>
              <p className="text-text-secondary mt-1">
                This schema change drops persisted columns or tables and may cause data loss or break referencing workflows.
              </p>
            </div>

            <div
              data-testid="destructive-entity-reasons"
              className="p-3 rounded bg-rose-500/15 border border-rose-500/40 text-rose-200 space-y-1.5"
            >
              <div className="font-bold uppercase tracking-wider text-[10px] text-rose-300">
                Data-Loss Impact
              </div>
              <ul className="space-y-1 font-mono text-[11px]">
                {pendingDestructive.reasons.map((r, i) => (
                  <li key={i}>• {r}</li>
                ))}
              </ul>
            </div>

            <div
              data-testid="destructive-entity-workflows"
              className="p-3 rounded bg-surface-base border border-border space-y-1.5"
            >
              <div className="font-bold uppercase tracking-wider text-[10px] text-text-muted">
                Referencing Workflows & Dynamic Ports Impact
              </div>
              {pendingDestructive.affectedWorkflows.length === 0 ? (
                <div className="text-emerald-400">
                  ✓ No workflows currently reference ent_{pendingDestructive.entityName}.
                </div>
              ) : (
                <ul className="space-y-1 font-mono text-[11px] text-amber-300">
                  {pendingDestructive.affectedWorkflows.map((wf) => (
                    <li
                      key={wf.workflowId}
                      data-testid={`destructive-entity-wf-${wf.workflowId}`}
                    >
                      - {wf.workflowName} ({wf.workflowId}): nodes [{wf.nodeIds.join(", ")}]
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                data-testid="destructive-entity-cancel"
                onClick={() => setPendingDestructive(null)}
                className="px-3 py-1.5 rounded bg-surface-control border border-border-strong text-text-secondary hover:text-text-primary font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="destructive-entity-confirm"
                disabled={isMutating}
                onClick={() => void handleConfirmDestructive()}
                className="px-3 py-1.5 rounded bg-rose-500 text-slate-950 font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isMutating ? "Applying…" : "Confirm Destructive Migration"}
              </button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
