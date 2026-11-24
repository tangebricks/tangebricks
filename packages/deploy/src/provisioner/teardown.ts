import { PROOF_PREFIX, assertProofName, isProofName } from "./names.ts";
import type { Client } from "./cloudflare.ts";
import type { Ledger, ResourceKind } from "./ledger.ts";

// Removes what this tool created, and only that. It walks the ledger; it never lists the account and deletes by pattern.
// A resource is deleted only if the ledger lists it AND its name carries the proof's prefix. Anything that looks like the
// proof's but is not in the ledger is reported by name and left alone: the owner decides.

export interface TeardownResult {
  removed: Array<{ kind: ResourceKind; name: string }>;
  alreadyGone: Array<{ kind: ResourceKind; name: string }>;
  /** Resources with the proof's prefix that the ledger does not know. Reported, never deleted. */
  unledgered: Array<{ kind: ResourceKind; name: string }>;
}

const ORDER: Record<ResourceKind, number> = { workflow: 0, worker_script: 1, d1_database: 2, d1_bookmark: 3, allow_destructive: 4 };

export async function teardown(client: Client, ledger: Ledger): Promise<TeardownResult> {
  const result: TeardownResult = { removed: [], alreadyGone: [], unledgered: [] };
  const entries = ledger
    .entries()
    .filter((e) => e.status !== "removed")
    .sort((a, b) => {
      const orderDiff = ORDER[a.kind] - ORDER[b.kind];
      if (orderDiff !== 0) return orderDiff;
      if (a.kind === "worker_script") {
        if (a.name.endsWith("-tail") && !b.name.endsWith("-tail")) return 1;
        if (!a.name.endsWith("-tail") && b.name.endsWith("-tail")) return -1;
      }
      return 0;
    });

  // Every name is checked before anything is deleted: one bad entry stops the whole teardown, not just the rest of it.
  for (const entry of entries) assertProofName(entry.name);

  for (const entry of entries) {
    if (entry.kind === "d1_bookmark" || entry.kind === "allow_destructive") {
      ledger.removed(entry.kind, entry.name);
      continue;
    }
    assertProofName(entry.name); // and again at the point of use
    try {
      if (entry.kind === "workflow") await client.deleteWorkflow(entry.name);
      else if (entry.kind === "worker_script") await client.deleteScript(entry.name);
      else if (entry.kind === "d1_database") {
        // delete by the id the ledger recorded, after checking that the id still belongs to a database of that name
        const named = (await client.listDatabases(entry.name)).filter((d) => d.name === entry.name);
        const target = named.find((d) => d.uuid === entry.id) ?? (entry.id === undefined ? named[0] : undefined);
        if (!target) {
          result.alreadyGone.push({ kind: entry.kind, name: entry.name });
          ledger.removed(entry.kind, entry.name);
          continue;
        }
        await client.deleteDatabase(target.uuid);
      }
      result.removed.push({ kind: entry.kind, name: entry.name });
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status: number }).status === 404) result.alreadyGone.push({ kind: entry.kind, name: entry.name });
      else throw error;
    }
    ledger.removed(entry.kind, entry.name);
  }

  result.unledgered = await findUnledgered(client, ledger);
  return result;
}

/** Proof-prefixed resources in the account that the ledger does not list as live. Read-only. */
export async function findUnledgered(client: Client, ledger: Ledger): Promise<Array<{ kind: ResourceKind; name: string }>> {
  const live = new Set(ledger.entries().filter((e) => e.status !== "removed").map((e) => `${e.kind}:${e.name}`));
  const out: Array<{ kind: ResourceKind; name: string }> = [];
  const consider = (kind: ResourceKind, name: string) => {
    if (name.startsWith(PROOF_PREFIX) && isProofName(name) && !live.has(`${kind}:${name}`)) out.push({ kind, name });
  };
  for (const name of await client.listScripts()) consider("worker_script", name);
  for (const database of await client.listDatabases(PROOF_PREFIX)) consider("d1_database", database.name);
  for (const name of await client.listWorkflows()) consider("workflow", name);
  return out;
}
