// Runs in Node, once, before the workerd tests start and again after they finish.
//
// Before: assembles each blueprint into out/<project>/ and records each file's hash, so the workerd tests can import a
// real, freshly written project. (A workerd test cannot write files, and Vite fixes the set of importable modules
// before tests run, so this has to happen first.)
// After: re-reads each folder and compares it with the record. If anything in an assembled project changed while the
// tests ran, that is recorded: "no hand edit" is checked, not assumed. (Vitest only logs an error thrown while it
// closes down and does not fail the run, so scripts/verify.ts reads the record and fails the run itself.)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assemble } from "../../packages/assembler/src/index.ts";
import { catalog } from "../../packages/assembler/catalog.generated.ts";
import { computeMaxCompatible } from "../../scripts/max-compatible.ts";
import {
  APPROVAL_GATE_BLUEPRINT,
  ENTITY_GRAPH_BLUEPRINT,
  INVOICE_FLOW_BLUEPRINT,
  PLAN_CREDITS_BLUEPRINT,
  PRIVACY_PRESENCE_BLUEPRINT,
  TWO_BRICK_BLUEPRINT,
  WORKFLOW_SHELL_BLUEPRINT,
} from "./blueprints.ts";
import { OUT_DIR, compareProject, hashesPath, verifiedPath, writeProject } from "./emitted.ts";
import { writeH9EmittedSource } from "./h9-emitted-source.ts";

/** Every project the tests import. scripts/verify.ts reads the same list. */
export const ASSEMBLED_PROJECTS = [TWO_BRICK_BLUEPRINT, INVOICE_FLOW_BLUEPRINT] as const;

const repoRoot = resolve(import.meta.dirname, "..", "..");
const readPreset = (name: string) =>
  JSON.parse(readFileSync(join(repoRoot, "presets", `${name}.blueprint.json`), "utf8")) as { project: string; bricks: unknown[]; entities?: unknown[] };

export function getBootBlueprints() {
  const maxSet = computeMaxCompatible(catalog);
  return [
    readPreset("ai-credits-saas"),
    readPreset("b2b-workspace-app"),
    readPreset("marketplace"),
    readPreset("stripe-discord-ops"),
    {
      project: maxSet.project,
      bricks: maxSet.bricks,
      entities: [
        {
          name: "records",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "amount", type: "number" },
          ],
        },
      ],
    },
  ];
}

export default async function setup(): Promise<() => Promise<void>> {
  // Story 7.4: the token budget's Session A denominator, measured from the bricks on disk for the workerd tests.
  mkdirSync(OUT_DIR, { recursive: true });
  writeH9EmittedSource(OUT_DIR);
  const written: Array<{ project: string; dir: string; expected: number }> = [];
  for (const blueprint of ASSEMBLED_PROJECTS) {
    const project = blueprint.project;
    const result = assemble(blueprint, catalog);
    if (!result.ok) throw new Error(`the ${project} blueprint did not assemble:\n  ${result.errors.join("\n  ")}`);
    const dir = join(OUT_DIR, project);
    const hashes = await writeProject(dir, result.files);
    writeFileSync(hashesPath(project), JSON.stringify(hashes, null, 2) + "\n");
    writeFileSync(verifiedPath(project), JSON.stringify({ project, unchanged: null, note: "the run has not finished" }, null, 2) + "\n");
    written.push({ project, dir, expected: Object.keys(result.files).length });
  }

  for (const blueprint of [
    ...getBootBlueprints(),
    WORKFLOW_SHELL_BLUEPRINT,
    PRIVACY_PRESENCE_BLUEPRINT,
    APPROVAL_GATE_BLUEPRINT,
    PLAN_CREDITS_BLUEPRINT,
    ENTITY_GRAPH_BLUEPRINT,
  ]) {
    const project = blueprint.project;
    const result = assemble(blueprint, catalog);
    if (!result.ok) throw new Error(`the ${project} blueprint did not assemble:\n  ${result.errors.join("\n  ")}`);
    const dir = join(OUT_DIR, project);
    await writeProject(dir, result.files);
  }

  return async () => {
    const problems: string[] = [];
    for (const { project, dir, expected } of written) {
      const recorded = JSON.parse(readFileSync(hashesPath(project), "utf8")) as Record<string, string>;
      const comparison = await compareProject(dir, recorded);
      // `checked` is how many files the comparison itself read back from disk. A record that says "unchanged" with
      // nothing checked is not evidence, and scripts/verify.ts refuses it.
      writeFileSync(verifiedPath(project), JSON.stringify({ project, ...comparison, expected }, null, 2) + "\n");
      if (!comparison.unchanged) {
        problems.push(
          `the assembled project ${project} changed while the tests ran:\n` +
            [
              ...comparison.changed.map((f) => `  changed: ${f}`),
              ...comparison.missing.map((f) => `  missing: ${f}`),
              ...comparison.extra.map((f) => `  extra: ${f}`),
            ].join("\n"),
        );
      }
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
  };
}
