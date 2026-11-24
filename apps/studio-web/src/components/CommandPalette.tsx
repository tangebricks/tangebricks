import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useStudioStore } from "../store.ts";
import { formatMaturityBadge } from "../types.ts";
import type { StudioNavTab, StudioSelection } from "../types.ts";

export interface CommandPaletteItem {
  key: string;
  group:
    | "Enabled Bricks"
    | "Catalog Bricks"
    | "Entities"
    | "Workflows"
    | "Workflow Nodes"
    | "Revisions"
    | "Navigation";
  title: string;
  subtitle: string;
  badge?: string;
  selection: StudioSelection | null;
  navigateTo: StudioNavTab;
  onAction?: () => void;
}

export function CommandPalette() {
  const open = useStudioStore((s) => s.commandPaletteOpen);
  const query = useStudioStore((s) => s.commandPaletteQuery);
  const setOpen = useStudioStore((s) => s.setCommandPaletteOpen);
  const setQuery = useStudioStore((s) => s.setCommandPaletteQuery);
  const selectItem = useStudioStore((s) => s.selectItem);
  const setActiveNav = useStudioStore((s) => s.setActiveNav);
  const workflowOutlineMode = useStudioStore((s) => s.workflowOutlineMode);
  const setWorkflowOutlineMode = useStudioStore((s) => s.setWorkflowOutlineMode);
  const projectState = useStudioStore((s) => s.projectState);
  const catalog = useStudioStore((s) => s.catalog);
  const revisions = useStudioStore((s) => s.revisions);

  const [activeIndex, setActiveIndex] = useState(0);
  const triggerElementRef = useRef<HTMLElement | null>(null);
  const shouldRestoreFocusRef = useRef(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      shouldRestoreFocusRef.current = false;
      const currentActive =
        typeof document !== "undefined"
          ? (document.activeElement as HTMLElement | null)
          : null;
      if (
        currentActive &&
        !modalRef.current?.contains(currentActive) &&
        currentActive !== document.body
      ) {
        triggerElementRef.current = currentActive;
      }
      inputRef.current?.focus();

      const onFocusIn = (e: FocusEvent) => {
        if (shouldRestoreFocusRef.current) return;
        const target = e.target as Node | null;
        if (modalRef.current && target && !modalRef.current.contains(target)) {
          inputRef.current?.focus();
        }
      };
      document.addEventListener("focusin", onFocusIn);
      return () => document.removeEventListener("focusin", onFocusIn);
    }

    if (shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false;
      const prev = triggerElementRef.current;
      if (prev && typeof prev.focus === "function" && document.contains(prev)) {
        prev.focus();
      }
    }
    return undefined;
  }, [open]);

  const closeAndRestoreFocus = () => {
    shouldRestoreFocusRef.current = true;
    setOpen(false);
  };

  const items = useMemo<CommandPaletteItem[]>(() => {
    const list: CommandPaletteItem[] = [];
    const enabledBrickIds = new Set(projectState?.bricks.map((b) => b.id) ?? []);

    for (const b of projectState?.bricks ?? []) {
      const manifest = catalog[b.id];
      const displayName = manifest?.ui?.displayName ?? b.id;
      const badge = formatMaturityBadge(manifest?.ui?.maturity ?? "production").textWithIcon;
      list.push({
        key: `enabled-brick:${b.id}`,
        group: "Enabled Bricks",
        title: displayName,
        subtitle: b.id,
        badge,
        selection: { kind: "brick", id: b.id },
        navigateTo: "bricks",
      });
    }

    for (const [id, manifest] of Object.entries(catalog)) {
      if (enabledBrickIds.has(id)) continue;
      const displayName = manifest.ui?.displayName ?? id;
      const badge = formatMaturityBadge(manifest.ui?.maturity ?? "production").textWithIcon;
      list.push({
        key: `catalog-brick:${id}`,
        group: "Catalog Bricks",
        title: displayName,
        subtitle: `${id} · ${manifest.ui?.summary ?? ""}`,
        badge,
        selection: { kind: "brick", id },
        navigateTo: "bricks",
      });
    }

    for (const ent of projectState?.entities ?? []) {
      list.push({
        key: `entity:${ent.name}`,
        group: "Entities",
        title: `Entity: ${ent.name}`,
        subtitle: `ent_${ent.name} (${ent.fields.length} fields)`,
        selection: { kind: "entity", id: ent.name },
        navigateTo: "data",
      });
    }

    for (const wf of projectState?.workflows ?? []) {
      list.push({
        key: `workflow:${wf.id}`,
        group: "Workflows",
        title: wf.name,
        subtitle: `${wf.id} (${wf.nodes.length} nodes)`,
        selection: { kind: "workflow", id: wf.id },
        navigateTo: "workflows",
      });
      for (const node of wf.nodes) {
        list.push({
          key: `node:${wf.id}:${node.id}`,
          group: "Workflow Nodes",
          title: node.label ?? node.id,
          subtitle: `${wf.name} · ${node.type}`,
          selection: { kind: "node", id: node.id, workflowId: wf.id },
          navigateTo: "workflows",
        });
      }
    }

    for (const rev of revisions) {
      const authorLabel =
        rev.author.type === "agent"
          ? `agent:${rev.author.client ?? rev.author.id}`
          : `human:${rev.author.id}`;
      list.push({
        key: `revision:${rev.revision}`,
        group: "Revisions",
        title: `Revision #${rev.revision}`,
        subtitle: `${rev.summary ?? "Blueprint update"} (${authorLabel})`,
        selection: { kind: "revision", id: String(rev.revision) },
        navigateTo: "history",
      });
    }

    list.push(
      {
        key: "nav:workflows",
        group: "Navigation",
        title: "Switch to Workflows View",
        subtitle: "Open Graph Canvas & Node Palette",
        selection: null,
        navigateTo: "workflows",
        onAction: () => setActiveNav("workflows"),
      },
      {
        key: "nav:overview",
        group: "Navigation",
        title: "Switch to Overview View",
        subtitle: "Open Backend Map",
        selection: null,
        navigateTo: "overview",
        onAction: () => setActiveNav("overview"),
      },
      {
        key: "action:toggle-outline",
        group: "Navigation",
        title: "Toggle Outline View (Alt+O)",
        subtitle: "Switch between spatial canvas and keyboard-accessible outline",
        selection: null,
        navigateTo: "workflows",
        onAction: () => {
          setActiveNav("workflows");
          setWorkflowOutlineMode(!workflowOutlineMode);
        },
      },
    );

    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, 30);

    return list.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q),
    );
  }, [
    projectState,
    catalog,
    revisions,
    query,
    setActiveNav,
    workflowOutlineMode,
    setWorkflowOutlineMode,
  ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  if (!open) return null;

  const chooseItem = (item: CommandPaletteItem) => {
    if (item.onAction) {
      item.onAction();
    } else if (item.selection) {
      selectItem(item.selection, item.navigateTo);
    } else {
      setActiveNav(item.navigateTo);
    }
    setOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (document.activeElement === inputRef.current) {
        closeButtonRef.current?.focus();
      } else {
        inputRef.current?.focus();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((idx) => (items.length === 0 ? 0 : (idx + 1) % items.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((idx) =>
        items.length === 0 ? 0 : (idx - 1 + items.length) % items.length,
      );
      return;
    }
    if (e.key === "Enter" && items[activeIndex]) {
      e.preventDefault();
      chooseItem(items[activeIndex]!);
    }
  };

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      data-testid="command-palette-modal"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 bg-slate-950/80 flex items-start justify-center pt-20 p-4"
    >
      <div className="w-full max-w-xl bg-surface-raised border border-border-strong rounded-lg shadow-2xl overflow-hidden">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <span className="text-accent font-bold">⌘K</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to brick, entity, workflow, node, or revision…"
            aria-label="Search command palette"
            data-testid="command-palette-input"
            className="flex-1 bg-transparent text-text-primary text-xs focus:outline-none placeholder:text-text-muted"
          />
          <button
            ref={closeButtonRef}
            type="button"
            onClick={closeAndRestoreFocus}
            data-testid="command-palette-close"
            className="px-2 py-0.5 rounded bg-surface-control text-text-muted hover:text-text-primary text-xs"
          >
            Esc
          </button>
        </div>

        <ul
          role="listbox"
          aria-label="Command palette results"
          data-testid="command-palette-results"
          className="max-h-80 overflow-y-auto divide-y divide-border"
        >
          {items.length === 0 ? (
            <li className="p-4 text-center text-text-muted text-xs">
              No matching bricks, entities, workflows, nodes, or revisions.
            </li>
          ) : (
            items.map((item, idx) => {
              const isSelected = idx === activeIndex;
              return (
                <li
                  key={item.key}
                  role="option"
                  aria-selected={isSelected}
                  data-testid={`command-palette-item-${item.key}`}
                  onClick={() => chooseItem(item)}
                  className={`px-3 py-2.5 cursor-pointer flex items-center justify-between text-xs transition ${
                    isSelected
                      ? "bg-surface-control text-text-primary ring-1 ring-inset ring-accent"
                      : "hover:bg-surface-control/60 text-text-secondary"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-surface-base text-text-muted">
                        {item.group}
                      </span>
                      <span className="font-semibold text-text-primary truncate">
                        {item.title}
                      </span>
                    </div>
                    <div className="text-[11px] text-text-muted font-mono truncate mt-0.5">
                      {item.subtitle}
                    </div>
                  </div>
                  {item.badge && (
                    <span className="ml-2 shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-surface-base border border-border-strong text-text-secondary">
                      {item.badge}
                    </span>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
