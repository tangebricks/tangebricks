import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Reporter, TestModule, Vitest } from "vitest/node";
import { mergeRecords, readAttachments, readReports } from "../packages/harness/src/results.ts";
import type { Attachment, Report } from "../packages/harness/src/results.ts";
import { stampEvidence, writeEvidence } from "../scripts/lib/evidence-stamp.ts";

export interface ManifestDeclaration {
  id: string;
  kind: "brick" | "integration";
  behaviourTest: string;
}

export interface TierEvidenceRow {
  id: string;
  kind: "brick" | "integration";
  behaviourTest: string;
  executed: boolean;
  passed: boolean;
  testsRun: number;
  testsSkipped: number;
  assertionCount: number;
  skipped?: Array<{ check: string; reason: string }>;
}

export function loadManifestDeclarations(root: string, manifestDirOverride?: string): ManifestDeclaration[] {
  const manifests: ManifestDeclaration[] = [];

  if (manifestDirOverride && existsSync(manifestDirOverride)) {
    const topBrickMf = join(manifestDirOverride, "brick.manifest.json");
    if (existsSync(topBrickMf)) {
      try {
        const data = JSON.parse(readFileSync(topBrickMf, "utf8"));
        if (data.ui?.behaviourTest) {
          const relPath = relative(root, resolve(manifestDirOverride, data.ui.behaviourTest)).replace(/\\/g, "/");
          manifests.push({
            id: data.id,
            kind: "brick",
            behaviourTest: relPath,
          });
        }
      } catch {}
    }

    const entries = readdirSync(manifestDirOverride, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = join(manifestDirOverride, entry.name);
        const brickMf = join(subDir, "brick.manifest.json");
        const intMf = join(subDir, "integration.json");
        if (existsSync(brickMf)) {
          try {
            const data = JSON.parse(readFileSync(brickMf, "utf8"));
            if (data.ui?.behaviourTest) {
              const relPath = relative(root, resolve(subDir, data.ui.behaviourTest)).replace(/\\/g, "/");
              manifests.push({
                id: data.id,
                kind: "brick",
                behaviourTest: relPath,
              });
            }
          } catch {}
        } else if (existsSync(intMf)) {
          try {
            const data = JSON.parse(readFileSync(intMf, "utf8"));
            if (data.ui?.behaviourTest) {
              const relPath = relative(root, resolve(subDir, data.ui.behaviourTest)).replace(/\\/g, "/");
              manifests.push({
                id: data.id ?? data.app,
                kind: "integration",
                behaviourTest: relPath,
              });
            }
          } catch {}
        }
      }
    }
    return manifests;
  }

  // Real repository manifests:
  // 1. bricks/*/brick.manifest.json (behaviourTest relative to brick directory)
  const bricksDir = join(root, "bricks");
  if (existsSync(bricksDir)) {
    for (const entry of readdirSync(bricksDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const mfPath = join(bricksDir, entry.name, "brick.manifest.json");
        if (existsSync(mfPath)) {
          try {
            const data = JSON.parse(readFileSync(mfPath, "utf8"));
            if (data.ui?.behaviourTest) {
              const relPath = join("bricks", entry.name, data.ui.behaviourTest).replace(/\\/g, "/");
              manifests.push({
                id: data.id,
                kind: "brick",
                behaviourTest: relPath,
              });
            }
          } catch {}
        }
      }
    }
  }

  // 2. integrations/*/integration.json (behaviourTest relative to repo root)
  const intDir = join(root, "integrations");
  if (existsSync(intDir)) {
    for (const entry of readdirSync(intDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const mfPath = join(intDir, entry.name, "integration.json");
        if (existsSync(mfPath)) {
          try {
            const data = JSON.parse(readFileSync(mfPath, "utf8"));
            if (data.ui?.behaviourTest) {
              const relPath = data.ui.behaviourTest.replace(/\\/g, "/");
              manifests.push({
                id: data.id ?? data.app,
                kind: "integration",
                behaviourTest: relPath,
              });
            }
          } catch {}
        }
      }
    }
  }

  return manifests;
}

/**
 * Collects the reports tests attach to `task.meta.poc` (tests run in workerd and cannot write
 * files) and stores them for scripts/verify.ts, which turns them into verdicts. It also records
 * which test files failed, so a file that broke before it could report is not mistaken for one
 * that has not been written yet.
 */
export default class EvidenceReporter implements Reporter {
  private root = process.cwd();

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>, unhandledErrors: ReadonlyArray<unknown>): void {
    const reports: Report[] = [];
    const attachments = new Map<string, Attachment>();
    const failedFiles: string[] = [];
    const testOutcomes: Array<{ name: string; file: string; state: string }> = [];
    const conformanceData = new Map<string, Array<{ check: string; reason: string }>>();
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let todo = 0;

    // Track execution stats per module
    const moduleStatsMap = new Map<
      string,
      {
        testsRun: number;
        testsSkipped: number;
        modulePassed: boolean;
        assertionCount: number;
      }
    >();

    for (const module of testModules) {
      if (module.state() === "failed") failedFiles.push(module.moduleId.replace(/\\/g, "/"));

      let moduleTestsRun = 0;
      let moduleTestsSkipped = 0;
      let modulePassed = module.state() !== "failed";
      let moduleAssertionCount = 0;

      for (const test of module.children.allTests()) {
        const state = test.result()?.state;
        const mode = (test as any).mode;
        testOutcomes.push({ name: test.fullName, file: module.moduleId.replace(/\\/g, "/"), state });
        if (mode === "todo") {
          todo += 1;
        } else if (state === "passed") {
          passed += 1;
          moduleTestsRun += 1;
          moduleAssertionCount += (test.meta() as any)?.assertionCount ?? 0;
        } else if (state === "failed") {
          failed += 1;
          moduleTestsRun += 1;
          modulePassed = false;
          moduleAssertionCount += (test.meta() as any)?.assertionCount ?? 0;
        } else if (state === "skipped" || mode === "skip") {
          skipped += 1;
          moduleTestsSkipped += 1;
        }

        if (state === "passed") {
          reports.push(...readReports(test.meta()));
          for (const attachment of readAttachments(test.meta())) {
            if (attachment.name === "tier-evidence") {
              const items = Array.isArray(attachment.data) ? attachment.data : [attachment.data];
              for (const item of items) {
                if (item && item.id && item.skipped) {
                  conformanceData.set(item.id, item.skipped);
                }
              }
            } else {
              attachments.set(attachment.name, attachment);
            }
          }
        }
      }

      const normKey = resolve(module.moduleId).replace(/\\/g, "/").toLowerCase();
      moduleStatsMap.set(normKey, {
        testsRun: moduleTestsRun,
        testsSkipped: moduleTestsSkipped,
        modulePassed,
        assertionCount: moduleAssertionCount,
      });
    }

    // Build tier-evidence rows
    const manifestDeclarations = loadManifestDeclarations(this.root, process.env.POC_MANIFEST_DIR);
    const tierRows: TierEvidenceRow[] = manifestDeclarations.map((mf) => {
      const manifestKey = resolve(this.root, mf.behaviourTest).replace(/\\/g, "/").toLowerCase();
      const stats = moduleStatsMap.get(manifestKey);

      let executed = false;
      let testPassed = false;
      let testsRun = 0;
      let testsSkipped = 0;
      let assertionCount = 0;

      if (stats) {
        testsRun = stats.testsRun;
        testsSkipped = stats.testsSkipped;
        assertionCount = stats.assertionCount;
        executed = testsRun > 0;
        testPassed = executed && stats.modulePassed;
      }

      const row: TierEvidenceRow = {
        id: mf.id,
        kind: mf.kind,
        behaviourTest: mf.behaviourTest,
        executed,
        passed: testPassed,
        testsRun,
        testsSkipped,
        assertionCount,
      };

      if (conformanceData.has(mf.id)) {
        row.skipped = conformanceData.get(mf.id);
      }

      return row;
    });

    tierRows.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

    const dir = process.env.POC_EVIDENCE_DIR ? resolve(this.root, process.env.POC_EVIDENCE_DIR) : join(this.root, ".evidence-run");
    mkdirSync(dir, { recursive: true });

    const prov = stampEvidence("reporters/evidence-reporter.ts", "measured");

    // Write tier-evidence.json
    writeEvidence(join(dir, "tier-evidence.json"), tierRows, prov);

    for (const { name, data } of attachments.values()) {
      writeEvidence(join(dir, `${name}.json`), data, prov);
    }

    writeEvidence(
      join(dir, "raw-results.json"),
      {
        runAt: new Date().toISOString(),
        files: { total: testModules.length, failed: failedFiles.length },
        tests: { passed, failed, skipped, todo },
        failedFiles,
        testOutcomes,
        unhandledErrors: unhandledErrors.length,
        results: mergeRecords(reports),
      },
      prov,
    );
  }
}
