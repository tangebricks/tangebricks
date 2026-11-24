// The known-failures registry shared by the attack suites (the assembled-app fuzz in
// packages/assembler/test/cross-tenant.fuzz.test.ts and the control-plane suite in
// apps/studio-api/test/control-plane-attack.test.ts). A suite fails on any violation the registry does not list
// (NEW_FAILURE) and on any listed entry that no longer fails (STALE_ENTRY), so a fixing story must prune its entries.

/** One registry entry: a known violation and the story that fixes it. */
export interface RegistryEntry {
  route: string;
  method: string;
  attack: string;
  story: string;
  reason: string;
}

/** What a suite reports for one failing request. */
export interface RegistryViolation {
  method: string;
  route: string;
  attack: string;
  detail: string;
}

export interface Comparison<V extends RegistryViolation = RegistryViolation> {
  /** Violations with no registry entry, one per method + route + attack. */
  newFailures: V[];
  /** Registry entries whose attack no longer fails. */
  staleEntries: RegistryEntry[];
  known: RegistryEntry[];
}

export const registryKeyOf = (x: { method: string; route: string; attack: string }) =>
  `${x.method} ${x.route} ${x.attack}`;

export function compareWithRegistry<V extends RegistryViolation>(
  violations: V[],
  entries: RegistryEntry[],
): Comparison<V> {
  const entryKeys = new Set(entries.map(registryKeyOf));
  const violationKeys = new Set(violations.map(registryKeyOf));
  const seen = new Set<string>();
  const newFailures: V[] = [];
  for (const v of violations) {
    const k = registryKeyOf(v);
    if (entryKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    newFailures.push(v);
  }
  return {
    newFailures,
    staleEntries: entries.filter((e) => !violationKeys.has(registryKeyOf(e))),
    known: entries.filter((e) => violationKeys.has(registryKeyOf(e))),
  };
}

/** One line per NEW_FAILURE and STALE_ENTRY; `registryFile` is named in the STALE_ENTRY fix-it line. */
export function describeComparison(
  c: Comparison,
  registryFile = "attack-suite.known-failures.json",
): string[] {
  return [
    ...c.newFailures.map((v) => `NEW_FAILURE ${v.method} ${v.route} ${v.attack}: ${v.detail}`),
    ...c.staleEntries.map(
      (e) =>
        `STALE_ENTRY remove fixed entry ${e.method} ${e.route} ${e.attack} (story ${e.story}) from ${registryFile}`,
    ),
  ];
}
