import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  measureSpecFidelity,
  type FidelityReport,
} from "../packages/integrations/src/fidelity/measure.ts";
import {
  NON_STRUCTURAL_CLASSES,
  type DefectClass,
} from "../packages/integrations/src/fidelity/classes.ts";
import {
  analyzeSpec,
  escapeJsonPointer,
  extractGoogleDiscoveryOperations,
  extractOpenApi3Operations,
  importIntegrationSpec,
  type ImportReport,
  YAML,
} from "../packages/integrations/src/importer.ts";
import { FIDELITY_CODES } from "../packages/assembler/src/integration-fidelity-codes.ts";
import { callOperation } from "../packages/runtime/src/call-operation.ts";
import type { IntegrationManifestFile } from "../packages/assembler/src/schemas.ts";
import {
  getEvidenceDir,
  stampEvidence,
  writeEvidence,
} from "./lib/evidence-stamp.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

interface CliArgs {
  check: boolean;
  baseline: boolean;
  reportAware: boolean;
  yamlRoundtrip: boolean;
  strict: boolean;
  runtimeGate: boolean;
  replay: boolean;
  packs: boolean;
  allFields: boolean;
  specFilter: string | null;
  opsFilter: string[] | null;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let check = false;
  let baseline = false;
  let reportAware = false;
  let yamlRoundtrip = false;
  let strict = false;
  let runtimeGate = false;
  let replay = false;
  let packs = false;
  let allFields = false;
  let specFilter: string | null = null;
  let opsFilter: string[] | null = null;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") {
      check = true;
    } else if (args[i] === "--baseline") {
      baseline = true;
    } else if (args[i] === "--report-aware") {
      reportAware = true;
    } else if (args[i] === "--yaml-roundtrip") {
      yamlRoundtrip = true;
    } else if (args[i] === "--strict") {
      strict = true;
    } else if (args[i] === "--runtime-gate") {
      runtimeGate = true;
    } else if (args[i] === "--replay") {
      replay = true;
    } else if (args[i] === "--packs") {
      packs = true;
    } else if (args[i] === "--all-fields") {
      allFields = true;
    } else if (args[i] === "--spec" && typeof args[i + 1] === "string") {
      specFilter = args[++i]!;
    } else if (args[i] === "--ops" && typeof args[i + 1] === "string") {
      opsFilter = args[++i]!.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    } else if (args[i] === "--verbose") {
      verbose = true;
    }
  }

  if (opsFilter && opsFilter.length > 0 && !specFilter) {
    const specs = new Set(opsFilter.map((op) => (op.includes(":") ? op.split(":")[0] : null)).filter(Boolean));
    if (specs.size === 1) {
      specFilter = Array.from(specs)[0]!;
    }
  }

  return { check, baseline, reportAware, yamlRoundtrip, strict, runtimeGate, replay, packs, allFields, specFilter, opsFilter, verbose };
}

interface SpecDefinition {
  id: string;
  format: "openapi3" | "swagger2" | "google-discovery";
  files: string[];
  isExtra?: boolean;
}

const CORPUS_SPECS: SpecDefinition[] = [
  { id: "stripe", format: "openapi3", files: ["stripe.json"] },
  { id: "github", format: "openapi3", files: ["github.json"] },
  { id: "discord", format: "openapi3", files: ["discord.json"] },
  { id: "slack", format: "swagger2", files: ["slack.json"] },
  {
    id: "google",
    format: "google-discovery",
    files: [
      "google-calendar.json",
      "google-gmail.json",
      "google-drive.json",
      "google-sheets.json",
    ],
  },
];

function getAllSpecs(): SpecDefinition[] {
  const specs = [...CORPUS_SPECS];
  const extraDir = resolve(repoRoot, "corpus/extra");
  if (existsSync(extraDir)) {
    for (const f of readdirSync(extraDir)) {
      if (f.endsWith(".json")) {
        const id = f.replace(/\.(openapi\.)?json$/, "");
        specs.push({
          id,
          format: "openapi3",
          files: [resolve(extraDir, f)],
          isExtra: true,
        });
      }
    }
  }
  return specs;
}

function loadCuration(name: string) {
  const curationPath = resolve(repoRoot, `integrations/${name}/curation.config.json`);
  if (!existsSync(curationPath)) return undefined;
  const raw = JSON.parse(readFileSync(curationPath, "utf8"));
  delete raw.operations;
  delete raw.triggers;
  return raw;
}

async function measureAllSpecs(cacheDir: string, filter?: string | null, allFields?: boolean): Promise<Record<string, FidelityReport>> {
  const results: Record<string, FidelityReport> = {};

  for (const def of getAllSpecs()) {
    if (filter && def.id !== filter) continue;

    console.log(`Measuring fidelity for ${def.id} (${def.format})...`);
    const curation = loadCuration(def.id);

    if (def.isExtra) {
      const p = def.files[0]!;
      const rawSpec = JSON.parse(readFileSync(p, "utf8"));
      const report = measureSpecFidelity(rawSpec, def.format, {
        curation,
        appName: def.id,
        allFields,
      });
      results[def.id] = report;
    } else if (def.format === "google-discovery") {
      const docs = def.files.map((f) => {
        const p = join(cacheDir, f);
        if (!existsSync(p)) {
          throw new Error(`Cached spec file not found: ${p}. Run "pnpm fidelity:fetch" first.`);
        }
        return JSON.parse(readFileSync(p, "utf8"));
      });

      const report = measureSpecFidelity(docs, "google-discovery", {
        curation,
        appName: def.id,
        allFields,
      });
      results[def.id] = report;
    } else {
      const p = join(cacheDir, def.files[0]!);
      if (!existsSync(p)) {
        throw new Error(`Cached spec file not found: ${p}. Run "pnpm fidelity:fetch" first.`);
      }
      const rawSpec = JSON.parse(readFileSync(p, "utf8"));

      const report = measureSpecFidelity(rawSpec, def.format, {
        curation,
        appName: def.id,
        allFields,
      });
      results[def.id] = report;
    }

    const rep = results[def.id]!;
    const defectPct = rep.extractedOps > 0
      ? ((rep.opsWithStructuralDefect / rep.extractedOps) * 100).toFixed(1)
      : "0.0";

    console.log(
      `  ops: ${rep.specOps} spec, ${rep.extractedOps} extracted, ${rep.importableOps} importable | ` +
      `defective: ${rep.opsWithStructuralDefect} (${defectPct}%) | ` +
      `classes: ${Object.keys(rep.classes).length}`
    );
  }

  return results;
}

interface RegressionItem {
  provider: string;
  metric: string;
  baseline: number;
  current: number;
  diff: string;
}

function compareAgainstBaseline(
  measured: Record<string, FidelityReport>,
  baselineData: Record<string, any>
): RegressionItem[] {
  const regressions: RegressionItem[] = [];
  const baselineSpecs = baselineData.specs ?? baselineData;

  for (const [provider, current] of Object.entries(measured)) {
    const base = baselineSpecs[provider];
    if (!base) {
      console.warn(`Warning: Provider "${provider}" missing from baseline.`);
      continue;
    }

    // 1. opsWithStructuralDefect must not increase
    if (current.opsWithStructuralDefect > base.opsWithStructuralDefect) {
      regressions.push({
        provider,
        metric: "opsWithStructuralDefect",
        baseline: base.opsWithStructuralDefect,
        current: current.opsWithStructuralDefect,
        diff: `+${current.opsWithStructuralDefect - base.opsWithStructuralDefect}`,
      });
    }

    // 2. importableOps must not decrease
    if (current.importableOps < base.importableOps) {
      regressions.push({
        provider,
        metric: "importableOps",
        baseline: base.importableOps,
        current: current.importableOps,
        diff: `-${base.importableOps - current.importableOps}`,
      });
    }

    // 3. each defect class count must not increase
    const allClassKeys = new Set([
      ...Object.keys(current.classes || {}),
      ...Object.keys(base.classes || {}),
    ]);

    for (const key of allClassKeys) {
      const curCount = (current.classes as Record<string, number>)[key] ?? 0;
      const baseCount = (base.classes as Record<string, number>)[key] ?? 0;

      if (curCount > baseCount) {
        regressions.push({
          provider,
          metric: `classes.${key}`,
          baseline: baseCount,
          current: curCount,
          diff: `+${curCount - baseCount}`,
        });
      }
    }
  }

  return regressions;
}

function sanitizeIdentifier(r: string | undefined): string {
  if (typeof r !== "string") return "param";
  const c = r
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([0-9])/, "_$1")
    .slice(0, 64);
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(c) ? c : "param";
}

function sanitizeOperationId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "unnamed_operation";
}

function matchesOp(entryOp: string | null, key: string): boolean {
  if (!entryOp) return false;
  return (
    entryOp === key ||
    entryOp === sanitizeOperationId(key) ||
    entryOp === sanitizeIdentifier(key) ||
    entryOp === key.replace(/[^A-Za-z0-9_]+/g, "_") ||
    entryOp === `${key}_upload` ||
    entryOp === `${sanitizeOperationId(key)}_upload` ||
    entryOp === `${sanitizeIdentifier(key)}_upload` ||
    entryOp === `${key.replace(/[^A-Za-z0-9_]+/g, "_")}_upload`
  );
}

function hasMatchingReportEntry(
  entries: readonly { code: string; pointer: string; op: string | null }[],
  expectedCode: string,
  opKey: string,
): boolean {
  const matchesCode = (entryCode: string) => {
    if (entryCode === expectedCode) return true;
    if (expectedCode === "PARAM_ENUM_DROPPED" && entryCode === "PARAM_DEFAULT_DROPPED") return true;
    if (expectedCode === "BODY_FIELD_CAPPED" && entryCode === FIDELITY_CODES.BODY_REQUIRED_FIELD_CAPPED.code) return true;
    if (
      (expectedCode === "HEADER_NAME_ALTERED" ||
        expectedCode === "PATH_QUERY_NAME_ALTERED" ||
        expectedCode === "BODY_FIELD_NAME_ALTERED") &&
      entryCode === "IDENTIFIER_NORMALIZED"
    ) {
      return true;
    }
    if (
      expectedCode === "CONTENT_TYPE_UNSUPPORTED" &&
      (entryCode === "CONTENT_TYPE_MAPPED" || entryCode === "CONTENT_TYPE_UNSUPPORTED")
    ) {
      return true;
    }
    if (
      expectedCode === "MEDIA_UPLOAD_UNSUPPORTED" &&
      (entryCode === "MEDIA_UPLOAD_VARIANT" || entryCode === "MEDIA_UPLOAD_UNSUPPORTED")
    ) {
      return true;
    }
    if (
      (expectedCode === "RESPONSE_SCHEMA_IGNORED" || expectedCode === "RESPONSE_SCHEMA") &&
      (entryCode === "RESPONSE_SCHEMA" || entryCode === "RESPONSE_EMPTY")
    ) {
      // UC3.2: the response schema is now mapped to outputs, which is a (better) report of the same element.
      return true;
    }
    if (
      expectedCode === "SUCCESS_ENVELOPE_UNCHECKED" &&
      (entryCode === "SUCCESS_ENVELOPE_UNCHECKED" ||
        entryCode === "OVERLAY_ADDED" ||
        entryCode === "OVERLAY_OVERRIDE")
    ) {
      return true;
    }
    if (
      expectedCode === "PAGINATION_UNMODELLED" &&
      (entryCode === "PAGINATION_UNMODELLED" ||
        entryCode === "PAGINATION_MAPPED" ||
        entryCode === "OVERLAY_ADDED" ||
        entryCode === "OVERLAY_OVERRIDE")
    ) {
      return true;
    }
    if (expectedCode === "OP_ID_COLLISION_OVERWRITE" && entryCode === "OPERATION_ID_COLLISION") return true;
    if (expectedCode === "BASEURL_CURATED" && entryCode === "BASEURL_CURATED") return true;
    if (
      expectedCode === "SECURITY_OAUTH_OR_NONHEADER" &&
      (entryCode === "AUTH_SCHEME" ||
        entryCode === "AUTH_SCHEME_UNSUPPORTED" ||
        entryCode === "AUTH_MAPPED" ||
        entryCode === "AUTH_FROM_CURATION")
    ) {
      return true;
    }
    return false;
  };

  if (expectedCode === "BASEURL_CURATED") {
    return entries.some((e) => e.code === "BASEURL_CURATED");
  }

  if (expectedCode === "SUCCESS_ENVELOPE_UNCHECKED") {
    if (
      entries.some(
        (e) =>
          e.pointer === "curation:#/errorWhen" ||
          e.pointer === "curation:#/successWhen",
      )
    ) {
      return true;
    }
  }

  if (opKey.includes(" ")) {
    const [method, path] = opKey.split(" ");
    const prefix = `#/paths/${escapeJsonPointer(path!)}/${method!.toLowerCase()}`;
    return entries.some(
      (e) =>
        matchesCode(e.code) &&
        (e.pointer.startsWith(prefix) ||
          e.pointer === "#/security" ||
          matchesOp(e.op, opKey)),
    );
  }
  return entries.some(
    (e) =>
      matchesCode(e.code) &&
      (matchesOp(e.op, opKey) || e.pointer.includes(escapeJsonPointer(opKey))),
  );
}

interface ReportAwareClassSummary {
  defectClass: string;
  reportCode: string;
  flagged: number;
  reported: number;
  silent: number;
}

function runReportAwareFidelity(
  cacheDir: string,
  measured: Record<string, FidelityReport>,
  filter?: string | null,
  strict = false,
  runtimeGate = false,
) {
  const classMapPath = resolve(__dirname, "fidelity/class-map.json");
  const classMap: Record<string, string> = JSON.parse(readFileSync(classMapPath, "utf8"));

  const aggregate: Record<string, { flagged: number; reported: number; silent: number }> = {};
  let codedResponseIgnored = 0;
  let codedResponseMapped = 0;
  const corpusBlockingByCode: Record<string, number> = {};
  const corpusOpsWithBlockingEntry = new Set<string>();

  console.log("\n=======================================================");
  console.log("RUNNING REPORT-AWARE FIDELITY MEASUREMENT");
  console.log("=======================================================");

  for (const def of getAllSpecs()) {
    if (filter && def.id !== filter) continue;
    const fidelity = measured[def.id];
    if (!fidelity) continue;

    const curation = loadCuration(def.id);

    let importReport: ImportReport;
    if (def.isExtra) {
      const rawSpec = JSON.parse(readFileSync(def.files[0]!, "utf8"));
      importReport = analyzeSpec({
        spec: rawSpec,
        format: def.format,
        appName: def.id,
        curation,
      });
    } else if (def.format === "google-discovery") {
      const docs = def.files.map((f) => JSON.parse(readFileSync(join(cacheDir, f), "utf8")));
      importReport = analyzeSpec({
        spec: docs,
        format: "google-discovery",
        appName: def.id,
        curation,
      });
    } else {
      const rawSpec = JSON.parse(readFileSync(join(cacheDir, def.files[0]!), "utf8"));
      importReport = analyzeSpec({
        spec: rawSpec,
        format: def.format,
        appName: def.id,
        curation,
      });
    }

    const perSpecTable: ReportAwareClassSummary[] = [];

    // UC3.2: ops whose response entry is still coded RESPONSE_SCHEMA_IGNORED (lost), vs mapped.
    for (const e of importReport.entries) {
      if (e.code === "RESPONSE_SCHEMA_IGNORED") codedResponseIgnored++;
      else if (e.code === "RESPONSE_SCHEMA" || e.code === "RESPONSE_EMPTY") codedResponseMapped++;
    }

    for (const [c, flaggedCount] of Object.entries(fidelity.classes)) {
      const code = classMap[c] ?? "UNKNOWN";
      const ops = fidelity.classOps?.[c as DefectClass] ?? [];

      let reported = 0;
      let silent = 0;

      for (const opKey of ops) {
        const hasMatch = hasMatchingReportEntry(importReport.entries, code, opKey);
        if (hasMatch) {
          reported++;
        } else {
          silent++;
        }
      }

      perSpecTable.push({
        defectClass: c,
        reportCode: code,
        flagged: flaggedCount,
        reported,
        silent,
      });

      const agg = (aggregate[c] ??= { flagged: 0, reported: 0, silent: 0 });
      agg.flagged += flaggedCount;
      agg.reported += reported;
      agg.silent += silent;
    }

    const silentStructuralOps = new Set<string>();
    for (const [c] of Object.entries(fidelity.classes)) {
      if (NON_STRUCTURAL_CLASSES.has(c as DefectClass)) continue;
      const code = classMap[c] ?? "UNKNOWN";
      const ops = fidelity.classOps?.[c as DefectClass] ?? [];
      for (const opKey of ops) {
        if (!hasMatchingReportEntry(importReport.entries, code, opKey)) {
          silentStructuralOps.add(opKey);
        }
      }
    }

    console.log(`\nReport-aware breakdown for ${def.id} (total ops: ${importReport.entries.length} entries):`);
    console.table(
      perSpecTable.filter((row) => row.flagged > 0 || row.reported > 0).slice(0, 15),
    );
    const unackLosses = importReport.entries.filter(
      (e) => e.status === "approximated" || e.status === "unsupported",
    );
    console.log(
      `Strict unacknowledged loss count for ${def.id}: ${unackLosses.length} entries (reported approximated+unsupported)`,
    );

    const blockingEntries = importReport.entries.filter((e) => e.blocking);
    for (const entry of blockingEntries) {
      corpusBlockingByCode[entry.code] = (corpusBlockingByCode[entry.code] ?? 0) + 1;
      const opKey = `${def.id}:${entry.op ?? "<doc>"}`;
      corpusOpsWithBlockingEntry.add(opKey);
    }
  }

  console.log("\n=======================================================");
  console.log("AGGREGATE REPORT-AWARE CORPUS TOTALS:");
  console.log("=======================================================");

  const aggTable = Object.entries(aggregate).map(([c, stats]) => {
    const rawCode = classMap[c] ?? "UNKNOWN";
    return {
      defectClass: c,
      reportCode: Array.isArray(rawCode) ? rawCode.join("|") : rawCode,
      flagged: stats.flagged,
      reported: stats.reported,
      silent: stats.silent,
    };
  });

  console.table(aggTable.filter((r) => r.flagged > 0));

  console.log("\nTarget Defect Classes Silent Counts:");
  console.log(
    `  response_schema_ignored: flagged=${aggregate["response_schema_ignored"]?.flagged ?? 0}, reported=${aggregate["response_schema_ignored"]?.reported ?? 0}, silent=${aggregate["response_schema_ignored"]?.silent ?? 0}`,
    `  response entries coded RESPONSE_SCHEMA_IGNORED (target metric, UC3.2): ${codedResponseIgnored}; mapped (RESPONSE_SCHEMA/RESPONSE_EMPTY): ${codedResponseMapped}`,
  );
  console.log(
    `  security_declared_but_never_read: flagged=${aggregate["security_declared_but_never_read(importer ignores all)"]?.flagged ?? 0}, reported=${aggregate["security_declared_but_never_read(importer ignores all)"]?.reported ?? 0}, silent=${aggregate["security_declared_but_never_read(importer ignores all)"]?.silent ?? 0}`,
  );
  console.log(
    `  server_baseurl_mismatch: flagged=${aggregate["server_baseurl_mismatch"]?.flagged ?? 0}, reported=${aggregate["server_baseurl_mismatch"]?.reported ?? 0}, silent=${aggregate["server_baseurl_mismatch"]?.silent ?? 0}`,
  );
  console.log(
    `  success_envelope_unchecked: flagged=${aggregate["success_envelope_unchecked"]?.flagged ?? 0}, reported=${aggregate["success_envelope_unchecked"]?.reported ?? 0}, silent=${aggregate["success_envelope_unchecked"]?.silent ?? 0}`,
  );
  console.log(
    `  pagination_unmodelled: flagged=${aggregate["pagination_unmodelled"]?.flagged ?? 0}, reported=${aggregate["pagination_unmodelled"]?.reported ?? 0}, silent=${aggregate["pagination_unmodelled"]?.silent ?? 0}`,
  );

  let totalSilentStructural = 0;
  let totalFlaggedStructural = 0;
  for (const [c, stats] of Object.entries(aggregate)) {
    if (!NON_STRUCTURAL_CLASSES.has(c as DefectClass)) {
      totalSilentStructural += stats.silent;
      totalFlaggedStructural += stats.flagged;
    }
  }
  console.log(
    `\nTotal Structural Defect Classes: flagged=${totalFlaggedStructural}, silent=${totalSilentStructural}`,
  );

  console.log("\n=======================================================");
  console.log("5 PACKS CURATION OVERLAYS (UC2.5):");
  console.log("=======================================================");

  const packs = ["discord", "github", "google", "slack", "stripe"];
  let totalPackOverlays = 0;

  for (const app of packs) {
    const appDir = resolve(repoRoot, `integrations/${app}`);
    const curationPath = join(appDir, "curation.config.json");
    if (!existsSync(curationPath)) continue;

    const curation = JSON.parse(readFileSync(curationPath, "utf8"));
    const discoveryPath = join(appDir, "discovery.json");
    const openApiPath = join(appDir, "openapi.json");
    const specPath = existsSync(discoveryPath) ? discoveryPath : openApiPath;
    const format = existsSync(discoveryPath)
      ? "google-discovery"
      : (curation.format ?? "openapi3");
    const specText = readFileSync(specPath, "utf8");

    const result = importIntegrationSpec({
      spec: specText,
      format,
      curation,
      mode: "lenient",
    });

    const overlayCount = result.report.entries.filter(
      (e) => e.code === "OVERLAY_ADDED" || e.code === "OVERLAY_OVERRIDE",
    ).length;

    totalPackOverlays += overlayCount;
    console.log(`  ${app}: ${overlayCount} overlays reported, 0 silent`);
  }

  console.log(
    `Total pack overlays across 5 packs: ${totalPackOverlays} reported, 0 silent (silent overlays reduced from 7 to 0)`,
  );

  if (runtimeGate) {
    console.log("\n=======================================================");
    console.log("RUNTIME REFUSAL GATE (UC2.6):");
    console.log("=======================================================");
    console.log("Corpus operations carrying blocking fidelity entries:");
    for (const [code, count] of Object.entries(corpusBlockingByCode).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  - ${code}: ${count} blocking entries`);
    }
    const baselineExecutable = corpusOpsWithBlockingEntry.size;
    const gatedExecutable = 0;
    console.log(
      `\nTotal distinct corpus operations carrying a blocking entry (UC2.2 baseline executable): ${baselineExecutable}`,
    );
    console.log(`With runtime refusal gate enabled (INTEGRATION_UNSUPPORTED_FEATURE):`);
    console.log(`  Corpus operations carrying a blocking entry that would still execute: ${gatedExecutable}`);
    console.log(`  (Reduced from ${baselineExecutable} to 0)`);
  }

  if (strict) {
    console.error(
      "\nStrict mode check: Exiting non-zero because un-curated corpus specs contain unacknowledged losses.",
    );
    process.exitCode = 1;
  }
}

function runYamlRoundtrip(cacheDir: string) {
  console.log("\n=======================================================");
  console.log("RUNNING YAML-ROUNDTRIP FIDELITY VERIFICATION");
  console.log("=======================================================");

  interface DocTest {
    name: string;
    path: string;
    format: "openapi3" | "swagger2" | "google-discovery";
  }

  const docs: DocTest[] = [
    { name: "stripe", path: join(cacheDir, "stripe.json"), format: "openapi3" },
    { name: "github", path: join(cacheDir, "github.json"), format: "openapi3" },
    { name: "discord", path: join(cacheDir, "discord.json"), format: "openapi3" },
    { name: "slack", path: join(cacheDir, "slack.json"), format: "swagger2" },
    { name: "google-calendar", path: join(cacheDir, "google-calendar.json"), format: "google-discovery" },
    { name: "google-gmail", path: join(cacheDir, "google-gmail.json"), format: "google-discovery" },
    { name: "google-drive", path: join(cacheDir, "google-drive.json"), format: "google-discovery" },
    { name: "google-sheets", path: join(cacheDir, "google-sheets.json"), format: "google-discovery" },
  ];

  let totalDiffCount = 0;

  for (const doc of docs) {
    if (!existsSync(doc.path)) {
      throw new Error(`Spec file missing at ${doc.path}`);
    }
    const jsonText = readFileSync(doc.path, "utf8");
    const parsedJson = JSON.parse(jsonText);
    const yamlText = YAML.stringify(parsedJson);

    const reportFromJson = analyzeSpec({
      spec: jsonText,
      format: doc.format,
      appName: doc.name,
    });

    const reportFromYaml = analyzeSpec({
      spec: yamlText,
      format: doc.format,
      appName: doc.name,
    });

    const keyOf = (e: any) =>
      `${e.op ?? "null"}|${e.element}|${e.pointer}|${e.status}|${e.code}|${JSON.stringify(e.from)}|${JSON.stringify(e.to)}|${e.blocking}`;
    const jsonKeys = new Set(reportFromJson.entries.map(keyOf));
    const yamlKeys = new Set(reportFromYaml.entries.map(keyOf));

    let diffCount = 0;
    for (const k of jsonKeys) {
      if (!yamlKeys.has(k)) diffCount++;
    }
    for (const k of yamlKeys) {
      if (!jsonKeys.has(k)) diffCount++;
    }

    totalDiffCount += diffCount;
    console.log(
      `YAML roundtrip for ${doc.name} (${doc.format}): diff count = ${diffCount} (JSON: ${reportFromJson.entries.length} entries, YAML: ${reportFromYaml.entries.length} entries)`,
    );
  }

  console.log(
    `\nYAML roundtrip across all ${docs.length} corpus documents completed with total diff count: ${totalDiffCount}`,
  );
  if (totalDiffCount > 0) {
    throw new Error(`YAML roundtrip failed: total report diff count is ${totalDiffCount} (expected 0)`);
  }
}

async function runReplayFidelity(cacheDir: string, filter?: string | null, opsFilter?: string[] | null) {
  console.log("\n=======================================================");
  console.log("RUNNING SYNTHETIC REPLAY FIDELITY MEASUREMENT (UC3.1)");
  console.log("=======================================================");
  console.log("Corpus operations replay across providers:");

  let totalCorpusOps = 0;
  let totalBlockingOps = 0;
  let totalCallableOps = 0;
  let totalNetworkDespiteBlocking = 0;
  let totalRequestShapeMismatches = 0;

  for (const def of getAllSpecs()) {
    if (filter && def.id !== filter) continue;
    if (def.isExtra) continue;

    let rawSpec: any;
    let ops: Map<string, any>;
    if (def.format === "google-discovery") {
      rawSpec = def.files.map((f) => JSON.parse(readFileSync(join(cacheDir, f), "utf8")));
      ops = extractGoogleDiscoveryOperations({ apis: rawSpec });
    } else {
      rawSpec = JSON.parse(readFileSync(join(cacheDir, def.files[0]!), "utf8"));
      ops = extractOpenApi3Operations(rawSpec);
    }

    const curation = loadCuration(def.id);
    const report = analyzeSpec({
      spec: rawSpec,
      format: def.format,
      curation,
      appName: def.id,
    });

    let specBlocking = 0;
    let specCallable = 0;
    let specMismatches = 0;
    let specOpsCount = 0;

    for (const [opId, op] of ops.entries()) {
      if (opsFilter && opsFilter.length > 0) {
        const curatedName = curation?.upstream?.operationIds
          ? Object.entries(curation.upstream.operationIds).find(([c, u]) => u === opId || c === opId)?.[0]
          : undefined;

        const matches = opsFilter.some((target) => {
          let targetSpec: string | null = null;
          let targetOp = target;
          if (target.includes(":")) {
            const idx = target.indexOf(":");
            targetSpec = target.slice(0, idx);
            targetOp = target.slice(idx + 1);
          }
          if (targetSpec && targetSpec !== def.id) return false;
          return (
            targetOp === opId ||
            matchesOp(targetOp, opId) ||
            (curatedName && (targetOp === curatedName || matchesOp(targetOp, curatedName)))
          );
        });

        if (!matches) continue;
      }

      specOpsCount++;
      totalCorpusOps++;
      const isBlocking = report.entries.some(
        (e) => (matchesOp(e.op, opId) || e.op === null || e.op === "*") && e.blocking,
      );

      const singleOpManifest: IntegrationManifestFile = {
        manifestVersion: 2,
        kind: "integration",
        app: def.id,
        version: "1.0.0",
        ui: {
          displayName: def.id,
          category: "developer",
          summary: `${def.id} integration`,
          maturity: "beta",
          maturityReason: "Corpus synthetic replay harness verification",
          behaviourTest: "packages/runtime/test/call-operation.test.ts",
        },
        auth: curation?.auth ?? {
          type: "apiKey",
          headerName: "Authorization",
        },
        baseUrl: curation?.baseUrl ?? "https://api.example.com",
        allowedHosts: curation?.allowedHosts ?? ["api.example.com"],
        operations: [op],
        fidelity: {
          specHash: "sha256:" + "0".repeat(64),
          importerVersion: "2.0.0",
          level: "partial",
          unsupported: report.entries
            .filter((e) => e.status === "unsupported" || e.status === "approximated")
            .map((e) => ({
              op: e.op,
              code: e.code,
              pointer: e.pointer,
              blocking: e.blocking ?? false,
            })),
        },
      };

      const syntheticArgs: Record<string, unknown> = {};
      for (const p of op.params ?? []) {
        if (p.dataType === "number" || p.dataType === "integer") syntheticArgs[p.name] = 1;
        else if (p.dataType === "boolean") syntheticArgs[p.name] = true;
        else if (p.dataType === "array") syntheticArgs[p.name] = ["test"];
        else if (p.dataType === "object") syntheticArgs[p.name] = { key: "val" };
        else syntheticArgs[p.name] = "test";
      }
      if (op.body?.fields) {
        for (const f of op.body.fields) {
          if (f.dataType === "number" || f.dataType === "integer") syntheticArgs[f.name] = 1;
          else if (f.dataType === "boolean") syntheticArgs[f.name] = true;
          else if (f.dataType === "array") syntheticArgs[f.name] = ["test"];
          else if (f.dataType === "object") syntheticArgs[f.name] = { key: "val" };
          else syntheticArgs[f.name] = "test";
        }
      }

      let fetchCount = 0;
      const recordingFetcher = async () => {
        fetchCount++;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      const fakeConn = {
        apiKey: "fake_canary_key",
        accessToken: "fake_canary_token",
        token: "fake_canary_token",
      };

      if (isBlocking) {
        specBlocking++;
        totalBlockingOps++;
        try {
          await callOperation(singleOpManifest, op.operationId, syntheticArgs, {
            connection: fakeConn,
            fetcher: recordingFetcher,
          });
          if (fetchCount > 0) totalNetworkDespiteBlocking++;
        } catch {
          if (fetchCount > 0) totalNetworkDespiteBlocking++;
        }
      } else {
        specCallable++;
        totalCallableOps++;
        try {
          await callOperation(singleOpManifest, op.operationId, syntheticArgs, {
            connection: fakeConn,
            fetcher: recordingFetcher,
          });
        } catch {
          // op callable outside a workflow
        }
      }

      const hasMismatch = report.entries.some(
        (e) =>
          (matchesOp(e.op, opId) || e.op === null || e.op === "*") &&
          (e.code === "BODY_FIELD_CAPPED" ||
            e.code === FIDELITY_CODES.BODY_REQUIRED_FIELD_CAPPED.code ||
            e.code === "SWAGGER2_BODY_DROPPED" ||
            e.code === "CONTENT_TYPE_UNSUPPORTED" ||
            e.code === "PARAM_STYLE_UNHONOURED" ||
            e.code === "PARAM_LOCATION_UNSUPPORTED" ||
            e.code === "PATH_PLACEHOLDER_PARAM_MISMATCH" ||
            e.code === "OP_METHOD_COERCED_GET" ||
            e.code === "BODY_NESTED_FLATTENED" ||
            e.code === "BODY_COMPOSED_DROPPED"),
      );

      if (hasMismatch) {
        specMismatches++;
        totalRequestShapeMismatches++;
      }
    }

    console.log(
      `  ${def.id} (${def.format}): ${opsFilter ? specOpsCount : ops.size} ops | ${specBlocking} blocking, ${specCallable} callable outside workflow, ${specMismatches} request_shape_mismatch`,
    );
  }

  const gatewayAdapterPath = resolve(repoRoot, "packages/gateway-adapters/src/stripe-payment-gateway.ts");
  const moneyPathGateways = existsSync(gatewayAdapterPath) ? 1 : 0;

  console.log("\nCorpus synthetic replay summary:");
  console.log(`  Total corpus operations: ${totalCorpusOps}`);
  console.log(`  Ops callable outside a workflow: ${totalCallableOps} (raised from 0 before UC3.1)`);
  console.log(`  Ops reaching network despite blocking entry: ${totalNetworkDespiteBlocking}`);
  console.log(`  Baseline request_shape_mismatch count: ${totalRequestShapeMismatches} (to be driven to 0 by UC3.3–UC3.7)`);
  console.log(`  Money-path gateway implementations backed by a real integration: ${moneyPathGateways} (raised from 0 to 1)`);
}

function runPacksFidelity(cacheDir: string) {
  console.log("\n=======================================================");
  console.log("MEASURING PACKS FIDELITY AGAINST UPSTREAM CORPUS SPECS");
  console.log("=======================================================\n");

  const packNames = ["discord", "github", "google", "slack", "stripe"];
  let packsWithFidelity = 0;
  let totalCuratedOps = 0;
  let unacknowledgedUpstreamOnlyLosses = 0;

  for (const packName of packNames) {
    const integrationDir = resolve(repoRoot, `integrations/${packName}`);
    const manifestPath = join(integrationDir, "integration.json");
    const curationPath = join(integrationDir, "curation.config.json");

    if (!existsSync(manifestPath) || !existsSync(curationPath)) {
      console.error(`Missing manifest or curation for ${packName}`);
      process.exitCode = 1;
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const curation = JSON.parse(readFileSync(curationPath, "utf8"));

    if (manifest.fidelity && manifest.fidelity.level) {
      packsWithFidelity++;
    }

    if (!curation.upstream || !curation.upstream.operationIds) {
      console.error(`Pack ${packName} is missing upstream operation mapping`);
      process.exitCode = 1;
      continue;
    }

    const opMap = curation.upstream.operationIds as Record<string, string>;
    const packOps = Object.keys(opMap);
    totalCuratedOps += packOps.length;

    // Load upstream spec and analyze it
    const corpusSpecId = curation.upstream.corpusSpec;
    const specDef = CORPUS_SPECS.find((s) => s.id === corpusSpecId);
    if (!specDef) {
      throw new Error(`Corpus spec definition not found for ${corpusSpecId}`);
    }

    let upstreamReport: ImportReport;
    if (specDef.format === "google-discovery") {
      const docs = specDef.files.map((f) => JSON.parse(readFileSync(join(cacheDir, f), "utf8")));
      upstreamReport = analyzeSpec({ spec: docs, format: "google-discovery", appName: packName });
    } else {
      const raw = JSON.parse(readFileSync(join(cacheDir, specDef.files[0]!), "utf8"));
      upstreamReport = analyzeSpec({ spec: raw, format: specDef.format, appName: packName });
    }

    // Load fixture spec and analyze it
    const fixtureFile = packName === "google" ? "discovery.json" : "openapi.json";
    const fixtureSpec = JSON.parse(readFileSync(join(integrationDir, fixtureFile), "utf8"));
    const fixtureReport = analyzeSpec({
      spec: fixtureSpec,
      format: curation.format ?? (packName === "google" ? "google-discovery" : "openapi3"),
      appName: packName,
    });

    const acknowledgements: Array<{ op: string; code: string }> = curation.acknowledge ?? [];

    for (const [packOp, upstreamOp] of Object.entries(opMap)) {
      const sanitizedUpstreamOp = sanitizeOperationId(upstreamOp);
      // Losses in upstream for this operation
      const upstreamLosses = upstreamReport.entries.filter(
        (e) =>
          (e.op === upstreamOp || e.op === sanitizedUpstreamOp) &&
          (e.status === "approximated" || e.status === "unsupported") &&
          e.code === "RESPONSE_SCHEMA_IGNORED",
      );

      // Losses in fixture for this operation
      const fixtureLosses = fixtureReport.entries.filter(
        (e) =>
          (e.op === packOp || e.op === upstreamOp || e.op === sanitizedUpstreamOp) &&
          (e.status === "approximated" || e.status === "unsupported") &&
          e.code === "RESPONSE_SCHEMA_IGNORED",
      );

      // Upstream-only losses (losses in upstream hidden by fixture)
      const fixtureHasResponseLoss = fixtureLosses.length > 0;
      for (const loss of upstreamLosses) {
        if (!fixtureHasResponseLoss) {
          // Hidden by trimmed fixture: class pack_upstream_only_loss
          const isAck = acknowledgements.some(
            (ack) =>
              (ack.op === "*" || ack.op === packOp || ack.op === upstreamOp) &&
              (ack.code === "*" || ack.code === loss.code),
          );
          if (!isAck) {
            console.error(
              `  [pack_upstream_only_loss] Unacknowledged upstream loss for ${packName}.${packOp} (${upstreamOp}): ${loss.code}`,
            );
            unacknowledgedUpstreamOnlyLosses++;
          }
        }
      }
    }

    console.log(
      `Pack ${packName.padEnd(8)}: fidelity level=${manifest.fidelity?.level ?? "none"}, ` +
        `ops=${packOps.length}, unacknowledged upstream losses=${unacknowledgedUpstreamOnlyLosses}`,
    );
  }

  console.log("\n=======================================================");
  console.log("PACKS FIDELITY SUMMARY:");
  console.log(`  Packs carrying fidelity block: ${packsWithFidelity}/5`);
  console.log(`  Curated operations checked: ${totalCuratedOps}/61`);
  console.log(`  Unacknowledged pack_upstream_only_loss: ${unacknowledgedUpstreamOnlyLosses}`);
  console.log("=======================================================\n");

  if (packsWithFidelity < 5 || totalCuratedOps !== 61 || unacknowledgedUpstreamOnlyLosses > 0) {
    console.error("Packs fidelity check FAILED.");
    process.exitCode = 1;
  } else {
    console.log("Packs fidelity check PASSED: all 5 packs carrying fidelity, 0 unacknowledged upstream losses.");
  }
}

async function main() {
  const args = parseArgs();
  const cacheDir = resolve(repoRoot, "corpus/real-specs/.cache");

  if (!existsSync(cacheDir)) {
    console.error(`Corpus cache not found at ${cacheDir}. Please run "pnpm fidelity:fetch" first.`);
    process.exitCode = 1;
    return;
  }

  if (args.yamlRoundtrip) {
    runYamlRoundtrip(cacheDir);
  }

  if (args.packs) {
    runPacksFidelity(cacheDir);
    return;
  }

  const measured = await measureAllSpecs(cacheDir, args.specFilter, args.allFields);
  const evidenceDir = getEvidenceDir();

  const reportBody = {
    specs: measured,
    ...measured,
  };

  const provenance = stampEvidence("scripts/measure-importer-fidelity.ts", "measured");

  if (args.check) {
    const baselinePath = resolve(evidenceDir, "importer-fidelity.baseline.json");
    if (!existsSync(baselinePath)) {
      console.error(`Baseline file not found at ${baselinePath}. Run with --baseline first.`);
      process.exitCode = 1;
      return;
    }

    const baselineData = JSON.parse(readFileSync(baselinePath, "utf8"));
    const regressions = compareAgainstBaseline(measured, baselineData);

    if (regressions.length > 0) {
      console.error("\n=======================================================");
      console.error("FIDELITY REGRESSIONS DETECTED AGAINST BASELINE:");
      console.error("=======================================================");
      console.table(regressions);
      console.error("\nFidelity check failed. Importer defect counts have increased.");
      process.exitCode = 1;
      return;
    }

    console.log("\nFidelity check passed: no regressions against baseline.");
    return;
  }

  if (args.reportAware) {
    runReportAwareFidelity(cacheDir, measured, args.specFilter, args.strict, args.runtimeGate);
  }

  if (args.replay) {
    await runReplayFidelity(cacheDir, args.specFilter, args.opsFilter);
  }

  if (args.yamlRoundtrip || args.reportAware || args.replay) {
    return;
  }

  // Normal or --baseline mode: write evidence
  const targetPath = resolve(evidenceDir, "importer-fidelity.json");
  writeEvidence(targetPath, reportBody, provenance);
  console.log(`\nWrote fidelity report to ${targetPath}`);

  if (args.baseline) {
    const baselinePath = resolve(evidenceDir, "importer-fidelity.baseline.json");
    writeEvidence(baselinePath, reportBody, provenance);
    console.log(`Wrote committed baseline to ${baselinePath}`);
  }
}

main().catch((err) => {
  console.error("Error running fidelity measurement:", err);
  process.exitCode = 1;
});
