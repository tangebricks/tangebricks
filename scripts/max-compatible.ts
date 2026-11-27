import { assemble } from "../packages/assembler/src/index.ts";
import type { Catalog } from "../packages/assembler/src/index.ts";
import { catalog as defaultCatalog } from "../packages/assembler/catalog.generated.ts";

export interface ExcludedBrick {
  id: string;
  reason: string;
}

export interface MaxCompatibleResult {
  project: string;
  bricks: string[];
  excluded: ExcludedBrick[];
}

function resolveDependencyClosure(targetId: string, selected: Set<string>, catalog: Catalog): string[] {
  const closure = new Set<string>(selected);
  const queue: string[] = [targetId];
  const ids = Object.keys(catalog.bricks).sort();

  while (queue.length > 0) {
    const current = queue.shift()!;
    closure.add(current);
    const entry = catalog.bricks[current];
    if (!entry) continue;

    for (const req of entry.manifest.requires) {
      const reqName = req.includes("@") ? req.slice(0, req.indexOf("@")) : req;
      const alreadyProvided = [...closure].some((id) =>
        catalog.bricks[id]?.manifest.provides.some((p) => (p.includes("@") ? p.slice(0, p.indexOf("@")) : p) === reqName),
      );
      if (alreadyProvided) continue;
      const provider = ids.find((id) => catalog.bricks[id]!.manifest.provides.some((p) => (p.includes("@") ? p.slice(0, p.indexOf("@")) : p) === reqName));
      if (provider && !closure.has(provider)) {
        closure.add(provider);
        queue.push(provider);
      }
    }
  }

  return [...closure].sort();
}

/**
 * A quarantined brick (story 0.11) is experimental with a `QUARANTINED:` maturity reason: unsafe or a stub, kept in the
 * catalog but out of default discovery, presets and this assembly. Other experimental bricks (e.g. scripting-sandbox,
 * pending a platform binding) are not unsafe and stay in, so the attack suite keeps covering them.
 */
export function isQuarantined(entry: Catalog["bricks"][string] | undefined): boolean {
  const ui = entry?.manifest.ui;
  return ui?.maturity === "experimental" && typeof ui.maturityReason === "string" && ui.maturityReason.startsWith("QUARANTINED:");
}

export function computeMaxCompatible(fullCatalog: Catalog = defaultCatalog): MaxCompatibleResult {
  const excluded: ExcludedBrick[] = [];
  const bricks: Catalog["bricks"] = {};
  for (const id of Object.keys(fullCatalog.bricks).sort()) {
    if (isQuarantined(fullCatalog.bricks[id])) excluded.push({ id, reason: "quarantined" });
    else bricks[id] = fullCatalog.bricks[id]!;
  }
  // Quarantined bricks are removed before dependency resolution, so none is pulled in as a provider either.
  const catalog: Catalog = { ...fullCatalog, bricks };
  const ids = Object.keys(catalog.bricks).sort();
  const selected = new Set<string>();

  for (const id of ids) {
    if (selected.has(id)) continue;
    const candidateBricks = resolveDependencyClosure(id, selected, catalog);
    const result = assemble({ project: "max-compatible", bricks: candidateBricks }, catalog);
    if (result.ok) {
      for (const added of candidateBricks) selected.add(added);
    } else {
      excluded.push({ id, reason: result.errors.join("; ") });
    }
  }

  return {
    project: "max-compatible",
    bricks: [...selected].sort(),
    excluded,
  };
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/max-compatible.ts");
if (isMain) {
  const result = computeMaxCompatible();
  console.log(`max-compatible: ${result.bricks.length} bricks included, ${result.excluded.length} excluded`);
  console.log(`included (${result.bricks.length}): ${result.bricks.join(", ")}`);
  if (result.excluded.length > 0) {
    console.log("excluded:");
    for (const item of result.excluded) {
      console.log(`  - ${item.id}: ${item.reason}`);
    }
  }
}
