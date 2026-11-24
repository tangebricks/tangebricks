import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { importIntegrationSpec } from "./importer.ts";
import type { ImportIntegrationResult, ImportSpecFormat } from "./importer.ts";
import { parseCurationConfig } from "./curation.ts";

export interface CliImportArgs {
  readonly specPath?: string;
  readonly format?: ImportSpecFormat;
  readonly curationPath?: string;
  readonly outPath?: string;
  readonly all?: boolean;
  readonly lenient?: boolean;
  readonly check?: boolean;
}

export function createUnifiedDiff(filename: string, oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const lines: string[] = [
    `--- ${filename} (committed)`,
    `+++ ${filename} (regenerated)`,
  ];
  const max = Math.max(oldLines.length, newLines.length);
  let diffFound = false;
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o !== n) {
      diffFound = true;
      if (o !== undefined) lines.push(`-${o}`);
      if (n !== undefined) lines.push(`+${n}`);
    }
  }
  return diffFound ? lines.join("\n") : "";
}

export function parseImportCliArgs(argv: readonly string[]): CliImportArgs {
  let specPath: string | undefined;
  let format: ImportSpecFormat | undefined;
  let curationPath: string | undefined;
  let outPath: string | undefined;
  let all = false;
  let lenient = false;
  let check = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec" && argv[i + 1]) {
      specPath = argv[++i];
    } else if (arg === "--format" && argv[i + 1]) {
      const val = argv[++i];
      if (val !== "openapi3" && val !== "google-discovery" && val !== "swagger2") {
        throw new Error(`Unsupported --format "${val}". Expected "openapi3", "swagger2", or "google-discovery".`);
      }
      format = val as ImportSpecFormat;
    } else if (arg === "--curation" && argv[i + 1]) {
      curationPath = argv[++i];
    } else if (arg === "--out" && argv[i + 1]) {
      outPath = argv[++i];
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--lenient") {
      lenient = true;
    } else if (arg === "--check") {
      check = true;
    }
  }

  return {
    ...(specPath !== undefined ? { specPath } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(curationPath !== undefined ? { curationPath } : {}),
    ...(outPath !== undefined ? { outPath } : {}),
    all,
    lenient,
    check,
  };
}

export function runOpenApiImportFile(options: {
  readonly specPath: string;
  readonly format?: ImportSpecFormat;
  readonly curationPath: string;
  readonly outPath: string;
  readonly mode?: "strict" | "lenient";
  readonly check?: boolean;
}): ImportIntegrationResult & { readonly drift?: boolean } {
  const mode = options.mode ?? "strict";
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const integrationsDir = resolve(repoRoot, "integrations");
  const resolvedOut = resolve(options.outPath);

  if (
    mode === "lenient" &&
    (resolvedOut === integrationsDir ||
      resolvedOut.startsWith(integrationsDir + sep) ||
      resolvedOut.startsWith(integrationsDir + "/"))
  ) {
    throw new Error(
      `OPENAPI_IMPORT_LENIENT_OUTPUT_FORBIDDEN: Lenient mode output is forbidden inside ${integrationsDir} (received: ${options.outPath})`,
    );
  }

  const specText = readFileSync(resolve(options.specPath), "utf8");
  const rawCuration = JSON.parse(
    readFileSync(resolve(options.curationPath), "utf8"),
  );
  const curation = parseCurationConfig(rawCuration);

  const format: ImportSpecFormat | undefined =
    options.format ??
    curation.format;

  const result = importIntegrationSpec({
    spec: specText,
    format,
    curation,
    mode,
  });

  const reportPath = join(dirname(resolvedOut), "import-report.json");
  const expectedManifestText = `${JSON.stringify(result.manifest, null, 2)}\n`;
  const expectedReportText = `${JSON.stringify(result.report, null, 2)}\n`;

  if (options.check) {
    const existingManifestText = existsSync(resolvedOut) ? readFileSync(resolvedOut, "utf8") : "";
    const existingReportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";

    let hasDiff = false;
    if (existingManifestText !== expectedManifestText) {
      hasDiff = true;
      console.error(`\nDrift detected in ${resolvedOut}:`);
      console.error(createUnifiedDiff(resolvedOut, existingManifestText, expectedManifestText));
    }
    if (existingReportText !== expectedReportText) {
      hasDiff = true;
      console.error(`\nDrift detected in ${reportPath}:`);
      console.error(createUnifiedDiff(reportPath, existingReportText, expectedReportText));
    }
    return { ...result, drift: hasDiff };
  }

  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(resolvedOut, expectedManifestText, "utf8");
  writeFileSync(reportPath, expectedReportText, "utf8");

  return result;
}

export function runOpenApiImportAll(
  repoRoot: string,
  mode: "strict" | "lenient" = "strict",
  check = false,
): (ImportIntegrationResult & { readonly drift?: boolean })[] {
  const integrationsDir = join(repoRoot, "integrations");
  if (!existsSync(integrationsDir)) {
    throw new Error(`Integrations directory not found at ${integrationsDir}`);
  }

  const results: (ImportIntegrationResult & { readonly drift?: boolean })[] = [];
  for (const appDirName of readdirSync(integrationsDir).sort()) {
    const appDir = join(integrationsDir, appDirName);
    const curationPath = join(appDir, "curation.config.json");
    if (!existsSync(curationPath)) continue;

    const discoveryPath = join(appDir, "discovery.json");
    const openApiJsonPath = join(appDir, "openapi.json");
    const openApiYamlPath = join(appDir, "openapi.yaml");

    const specPath = existsSync(discoveryPath)
      ? discoveryPath
      : existsSync(openApiJsonPath)
        ? openApiJsonPath
        : openApiYamlPath;
    const format: ImportSpecFormat | undefined = existsSync(discoveryPath)
      ? "google-discovery"
      : undefined;
    const outPath = join(appDir, "integration.json");

    const res = runOpenApiImportFile({
      specPath,
      format,
      curationPath,
      outPath,
      mode,
      check,
    });
    results.push(res);
  }
  return results;
}

export function runOpenApiImportCli(argv = process.argv.slice(2)): ImportIntegrationResult[] {
  const parsed = parseImportCliArgs(argv);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const mode = parsed.lenient ? "lenient" : "strict";

  if (parsed.specPath && parsed.curationPath && parsed.outPath) {
    const single = runOpenApiImportFile({
      specPath: parsed.specPath,
      ...(parsed.format ? { format: parsed.format } : {}),
      curationPath: parsed.curationPath,
      outPath: parsed.outPath,
      mode,
      check: parsed.check,
    });
    if (parsed.check) {
      if (single.drift) {
        console.error(`\n[openapi:import --check] Drift detected for ${parsed.outPath}. Exiting 1.`);
        process.exit(1);
      }
      console.log(`[openapi:import --check] ${parsed.outPath} is up to date.`);
      return [single];
    }
    console.log(
      `[openapi:import] Wrote ${parsed.outPath} (app=${single.manifest.app}, operations=${single.manifest.operations.length}, triggers=${single.manifest.triggers?.length ?? 0}, summaryTokens=${single.tokenMetrics.compactSummaryTokens}, maxOpTokens=${single.tokenMetrics.maxOperationDetailTokens}, maxPageTokens=${single.tokenMetrics.maxSearchPageTokens}, level=${single.manifest.fidelity?.level ?? "none"}, unsupported=${single.manifest.fidelity?.unsupported.length ?? 0})`,
    );
    return [single];
  }

  if (parsed.all || (!parsed.specPath && !parsed.curationPath && !parsed.outPath)) {
    const allResults = runOpenApiImportAll(repoRoot, mode, parsed.check);
    if (parsed.check) {
      const hasAnyDrift = allResults.some((r) => r.drift);
      if (hasAnyDrift) {
        console.error(`\n[openapi:import --check] Import drift detected across one or more packs. Run "pnpm openapi:import --all" to regenerate.`);
        process.exit(1);
      }
      console.log(`[openapi:import --check] All 5 packs match regenerated manifests and reports.`);
      return allResults;
    }

    for (const r of allResults) {
      console.log(
        `[openapi:import] Wrote integrations/${r.manifest.app}/integration.json (operations=${r.manifest.operations.length}, triggers=${r.manifest.triggers?.length ?? 0}, summaryTokens=${r.tokenMetrics.compactSummaryTokens}, maxOpTokens=${r.tokenMetrics.maxOperationDetailTokens}, maxPageTokens=${r.tokenMetrics.maxSearchPageTokens}, level=${r.manifest.fidelity?.level ?? "none"}, unsupported=${r.manifest.fidelity?.unsupported.length ?? 0})`,
      );
    }
    return allResults;
  }

  throw new Error(
    "Usage: pnpm openapi:import --spec <path> --format <openapi3|google-discovery> --curation <path> --out <path> (or --all [--check])",
  );
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runOpenApiImportCli();
}
