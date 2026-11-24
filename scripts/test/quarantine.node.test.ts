// Story 0.11: unsafe and stub bricks are quarantined (experimental with a `QUARANTINED:` reason). They stay in the
// catalog, but max-compatible (the attack suite's app), the presets and the Studio templates leave them out.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { assemble } from "../../packages/assembler/src/index.ts";
import { catalog } from "../../packages/assembler/catalog.generated.ts";
import { listStarterTemplates } from "../../apps/studio-api/src/templates.ts";
import { computeMaxCompatible, isQuarantined } from "../max-compatible.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const QUARANTINED = [
  "admin-console",
  "agent-sandbox",
  "custom-domains",
  "document-pdf",
  "marketplace-splits",
  "oauth-server",
  "realtime-presence",
  "workflow-dag",
];

const brickIds = (bricks: unknown[]): string[] =>
  bricks.map((b) => (typeof b === "string" ? b : String((b as { id: unknown }).id)));

describe("quarantined bricks (story 0.11)", () => {
  test("exactly the eight unsafe or stub bricks are quarantined, each experimental with a QUARANTINED: reason", () => {
    const quarantined = Object.keys(catalog.bricks).filter((id) => isQuarantined(catalog.bricks[id])).sort();
    expect(quarantined).toEqual(QUARANTINED);
    for (const id of QUARANTINED) {
      const ui = catalog.bricks[id]!.manifest.ui!;
      expect(ui.maturity, id).toBe("experimental");
      expect(ui.maturityReason, id).toMatch(/^QUARANTINED: \S/);
    }
    // Quarantine is reversible: the code stays in the catalog.
    for (const id of QUARANTINED) expect(catalog.bricks[id], id).toBeDefined();
  });

  test("MAX_COMPAT: max-compatible excludes each quarantined brick with reason 'quarantined' and still assembles", () => {
    const result = computeMaxCompatible(catalog);
    for (const id of QUARANTINED) {
      expect(result.bricks, id).not.toContain(id);
      expect(result.excluded, id).toContainEqual({ id, reason: "quarantined" });
    }
    // Only quarantined bricks get that reason; scripting-sandbox (experimental, not quarantined) stays in.
    expect(result.excluded.filter((e) => e.reason === "quarantined").map((e) => e.id).sort()).toEqual(QUARANTINED);
    expect(result.bricks).toContain("scripting-sandbox");
    expect(assemble({ project: result.project, bricks: result.bricks }, catalog).ok).toBe(true);
  });

  test("PRESETS: no preset and no Studio starter template includes a quarantined brick", () => {
    const presetDir = join(repoRoot, "presets");
    const presets = readdirSync(presetDir).filter((f) => f.endsWith(".blueprint.json"));
    expect(presets.length).toBeGreaterThan(0);
    for (const file of presets) {
      const raw = readFileSync(join(presetDir, file), "utf8");
      const preset = JSON.parse(raw) as { bricks: unknown[] };
      for (const id of brickIds(preset.bricks)) expect(QUARANTINED, `${file} enables ${id}`).not.toContain(id);
      for (const id of QUARANTINED) expect(raw, `${file} mentions ${id}`).not.toContain(`"${id}"`);
    }
    const studioPresets = JSON.parse(readFileSync(join(repoRoot, "apps", "studio-web", "src", "presets-data.json"), "utf8")) as Record<string, { bricks: unknown[] }>;
    for (const [name, preset] of Object.entries(studioPresets)) {
      for (const id of brickIds(preset.bricks)) expect(QUARANTINED, `studio-web preset ${name} enables ${id}`).not.toContain(id);
    }
    for (const template of listStarterTemplates()) {
      for (const id of template.bricks) expect(QUARANTINED, `template ${template.id} enables ${id}`).not.toContain(id);
    }
  });

  test("marketplace says payout splits are experimental", () => {
    const marketplace = JSON.parse(readFileSync(join(repoRoot, "presets", "marketplace.blueprint.json"), "utf8")) as {
      metadata: { description: string };
    };
    expect(marketplace.metadata.description).toMatch(/splits.*experimental/i);
  });
});
