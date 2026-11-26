import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { PROOF_NAME_POLICY } from "./names.ts";
import type { NamePolicy } from "./names.ts";

// The record of what this tool created in the owner's account. Teardown deletes only what is listed here, and only if the
// name carries the proof's prefix. An entry is written BEFORE the create call is made ("creating"), so a crash between the
// call and the answer still leaves a trace and nothing is created that the ledger does not know about.

export type ResourceKind = "d1_database" | "worker_script" | "workflow" | "queue" | "d1_bookmark" | "allow_destructive";
export interface LedgerEntry {
  kind: ResourceKind;
  name: string;
  id?: string;
  status: "creating" | "created" | "removed";
  at: string;
}
export interface LedgerData {
  suffix: string;
  entries: LedgerEntry[];
}
export interface LedgerStore {
  read(): LedgerData | null;
  write(data: LedgerData): void;
}

export function memoryStore(initial: LedgerData | null = null): LedgerStore & { snapshot(): LedgerData | null } {
  let data = initial ? structuredClone(initial) : null;
  return {
    read: () => (data ? structuredClone(data) : null),
    write: (next) => {
      data = structuredClone(next);
    },
    snapshot: () => (data ? structuredClone(data) : null),
  };
}

/** A ledger in a JSON file, written by writing a temporary file and renaming it, so a crash never leaves half a file. */
export function fileStore(path: string): LedgerStore {
  return {
    read() {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf8")) as LedgerData;
    },
    write(data) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
      renameSync(temporary, path);
    },
  };
}

export interface Ledger {
  readonly suffix: string;
  entries(): LedgerEntry[];
  has(kind: ResourceKind, name: string): boolean;
  /** Called before the resource is created. */
  planned(kind: ResourceKind, name: string): void;
  created(kind: ResourceKind, name: string, id?: string): void;
  removed(kind: ResourceKind, name: string): void;
}

export function openLedger(store: LedgerStore, newSuffix: () => string, now: () => Date = () => new Date(), policy: NamePolicy = PROOF_NAME_POLICY): Ledger {
  let data = store.read();
  if (!data) {
    data = { suffix: newSuffix(), entries: [] };
    store.write(data);
  }
  const current = data;
  const find = (kind: ResourceKind, name: string) => current.entries.find((e) => e.kind === kind && e.name === name);
  const save = () => store.write(current);
  const stamp = () => now().toISOString();
  return {
    suffix: current.suffix,
    entries: () => structuredClone(current.entries),
    has: (kind, name) => {
      const entry = find(kind, name);
      return entry !== undefined && entry.status !== "removed";
    },
    planned(kind, name) {
      if (!policy.isName(name)) throw new Error(`refusing to record "${name}": it does not carry the proof's prefix ${policy.prefix}`);
      const existing = find(kind, name);
      if (existing) {
        existing.status = "creating";
        existing.at = stamp();
      } else current.entries.push({ kind, name, status: "creating", at: stamp() });
      save();
    },
    created(kind, name, id) {
      const entry = find(kind, name);
      if (!entry) throw new Error(`"${name}" was never planned in the ledger`);
      entry.status = "created";
      if (id !== undefined) entry.id = id;
      entry.at = stamp();
      save();
    },
    removed(kind, name) {
      const entry = find(kind, name);
      if (!entry) return;
      entry.status = "removed";
      entry.at = stamp();
      save();
    },
  };
}
