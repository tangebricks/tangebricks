// Usage: node scripts/check-manifests.ts [--bricks-dir <dir>] [--json]
// Checks every brick manifest against its package.json, TypeScript source, and SQL migrations.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
import { lintMigration } from "../packages/deploy/src/migration-lint.ts";
import { extractCreatedTables } from "./lib/tenant-tables.ts";
import { lintTenantQueries } from "./lint-tenant-queries.ts";
import { IMPORTER_VERSION } from "../packages/integrations/src/importer.ts";
import {
  IntegrationManifestSchema,
  ManifestSchema,
  NodePackManifestSchema,
  nodeDefinition,
  projectIntegrationToNodes,
} from "../packages/assembler/src/schemas.ts";
import type {
  BrickManifestFile,
  IntegrationManifestFile,
  NodePackManifestFile,
} from "../packages/assembler/src/schemas.ts";
import { deriveTier, loadTierPolicy, TIER_RANK } from "./lib/derive-tier.ts";
import type { MaturityTier } from "./lib/derive-tier.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ConformanceViolation {
  brick: string;
  field: string;
  detail: string;
}

export function loadTierEvidenceMap(rootDir = ROOT): Map<string, any> {
  const map = new Map<string, any>();
  const evidenceDir = process.env.POC_EVIDENCE_DIR
    ? resolve(process.env.POC_EVIDENCE_DIR)
    : // Committed evidence unless a run directory is named explicitly (evidence:refresh sets POC_EVIDENCE_DIR).
      // A leftover .evidence-run/ from an earlier step is never picked up implicitly.
      join(rootDir, "evidence");
  const p = process.env.POC_TIER_EVIDENCE_PATH
    ? resolve(process.env.POC_TIER_EVIDENCE_PATH)
    : join(evidenceDir, "tier-evidence.json");

  if (existsSync(p)) {
    try {
      const content = JSON.parse(readFileSync(p, "utf8"));
      const rows = Array.isArray(content) ? content : Array.isArray(content?.data) ? content.data : [];
      for (const row of rows) {
        if (row && typeof row === "object" && row.id) {
          map.set(row.id, row);
        }
      }
    } catch {}
  }
  return map;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options"]);
// Route-factory options a host passes in code, not manifest settings. `knownPermissions` (rbac-policy, story 0.19) is
// a string[] allowlist a host sets for its own app; manifest settings have no list type.
const DI_OPTION_KEYS = new Set(["adapter", "adapters", "gateway", "publicBaseUrl", "knownPermissions"]);
// Optional app-config env vars a host sets for its own app, not bindings or secrets a brick needs to boot,
// keyed by the one brick allowed to read each, so rule 8 stays strict for every other brick.
// `CRON_WORKFLOW_TARGETS` (cron-alarms, story 0.20) is the comma-separated Workflow binding allowlist; unset fails closed.
const APP_CONFIG_ENV_VARS: Record<string, readonly string[]> = { "cron-alarms": ["CRON_WORKFLOW_TARGETS"] };

function listTsSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listTsSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

function parseSourceFile(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, "utf8");
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isFunctionLikeInitializer(init: ts.Expression | undefined, typeNode: ts.TypeNode | undefined): boolean {
  if (init) {
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isCallExpression(init)) {
      return true;
    }
  }
  if (typeNode) {
    const typeText = typeNode.getText();
    if (typeText.includes("MiddlewareHandler") || typeText.includes("=>")) {
      return true;
    }
  }
  return false;
}

function resolveRelativeModule(fromFile: string, moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith(".")) return null;
  const baseDir = dirname(fromFile);
  const direct = resolve(baseDir, moduleSpecifier);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  if (moduleSpecifier.endsWith(".js")) {
    const asTs = resolve(baseDir, moduleSpecifier.slice(0, -3) + ".ts");
    if (existsSync(asTs)) return asTs;
  }
  const withTs = `${direct}.ts`;
  if (existsSync(withTs)) return withTs;
  return null;
}

function collectExportedFunctions(entryFilePath: string, visited = new Set<string>()): Set<string> {
  const exportedFns = new Set<string>();
  if (!existsSync(entryFilePath) || visited.has(entryFilePath)) return exportedFns;
  visited.add(entryFilePath);

  const sf = parseSourceFile(entryFilePath);
  const localFns = new Set<string>();

  for (const stmt of sf.statements) {
    const hasExport = ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      localFns.add(stmt.name.text);
      if (hasExport) exportedFns.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && isFunctionLikeInitializer(decl.initializer, decl.type)) {
          localFns.add(decl.name.text);
          if (hasExport) exportedFns.add(decl.name.text);
        }
      }
    }
  }

  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
    if (spec) {
      const targetPath = resolveRelativeModule(entryFilePath, spec);
      if (!targetPath) continue;
      const targetExports = collectExportedFunctions(targetPath, new Set(visited));
      if (!stmt.exportClause) {
        for (const fn of targetExports) exportedFns.add(fn);
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.isTypeOnly) continue;
          const origName = el.propertyName ? el.propertyName.text : el.name.text;
          const exportedName = el.name.text;
          if (targetExports.has(origName)) exportedFns.add(exportedName);
        }
      }
    } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.isTypeOnly) continue;
        const origName = el.propertyName ? el.propertyName.text : el.name.text;
        const exportedName = el.name.text;
        if (localFns.has(origName)) exportedFns.add(exportedName);
      }
    }
  }

  return exportedFns;
}

function collectSettingsAndEnvFromSource(
  sourceFiles: string[],
  factoryNames: Set<string>,
  mountPoints: string[],
): {
  readSettings: Set<string>;
  envRefs: Set<string>;
  mountedRoutes: Array<{ path: string; firstSegment: string }>;
  forbiddenRuntimeConstructs: string[];
} {
  const readSettings = new Set<string>();
  const envRefs = new Set<string>();
  const mountedRoutes: Array<{ path: string; firstSegment: string }> = [];
  const forbiddenSet = new Set<string>();

  const mountBase = mountPoints[0] ?? "/api";

  for (const filePath of sourceFiles) {
    const sf = parseSourceFile(filePath);

    for (const stmt of sf.statements) {
      const hasExport = ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const hasDefault = ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        if (ts.isObjectLiteralExpression(stmt.expression)) {
          for (const prop of stmt.expression.properties) {
            const propName = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
            if (propName === "scheduled" || propName === "queue") {
              forbiddenSet.add(`default export defines "${propName}" handler (AD-S15: shell owns scheduled/queue dispatch)`);
            }
          }
        }
      }

      if (hasExport && ts.isFunctionDeclaration(stmt) && stmt.name) {
        if (stmt.name.text === "scheduled" || stmt.name.text === "queue") {
          forbiddenSet.add(`exports top-level "${stmt.name.text}" handler (AD-S15: shell owns scheduled/queue dispatch)`);
        }
      }

      if (hasExport && ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && (decl.name.text === "scheduled" || decl.name.text === "queue")) {
            forbiddenSet.add(`exports top-level "${decl.name.text}" handler (AD-S15: shell owns scheduled/queue dispatch)`);
          }
        }
      }

      if (ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
        for (const el of stmt.importClause.namedBindings.elements) {
          const imported = el.propertyName ? el.propertyName.text : el.name.text;
          if (imported === "WorkflowEntrypoint") {
            forbiddenSet.add("imports WorkflowEntrypoint (AD-S15: bricks must not define their own Workflow class)");
          }
        }
      }

      if ((ts.isClassDeclaration(stmt) || hasDefault) && ts.isClassDeclaration(stmt) && stmt.heritageClauses) {
        for (const clause of stmt.heritageClauses) {
          for (const type of clause.types) {
            if (type.expression.getText(sf).includes("WorkflowEntrypoint")) {
              forbiddenSet.add("extends WorkflowEntrypoint (AD-S15: bricks must not define their own Workflow class)");
            }
          }
        }
      }
    }

    const scanFactoryBody = (fnNode: ts.FunctionLikeDeclarationBase) => {
      const firstParam = fnNode.parameters[0];
      let paramIdent: string | null = null;
      if (firstParam) {
        if (ts.isIdentifier(firstParam.name)) {
          paramIdent = firstParam.name.text;
        } else if (ts.isObjectBindingPattern(firstParam.name)) {
          for (const el of firstParam.name.elements) {
            const key = el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : ts.isIdentifier(el.name)
                ? el.name.text
                : null;
            if (key) readSettings.add(key);
          }
        }
      }

      const visitBody = (node: ts.Node) => {
        if (ts.isTypeNode(node)) return;
        if (paramIdent && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === paramIdent) {
          readSettings.add(node.name.text);
        }
        if (
          paramIdent &&
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          node.initializer.text === paramIdent
        ) {
          for (const el of node.name.elements) {
            const key = el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : ts.isIdentifier(el.name)
                ? el.name.text
                : null;
            if (key) readSettings.add(key);
          }
        }
        ts.forEachChild(node, visitBody);
      };

      if (fnNode.body) visitBody(fnNode.body);
    };

    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        return;
      }

      // Check if this is a route factory function
      if (ts.isFunctionDeclaration(node) && node.name && factoryNames.has(node.name.text)) {
        scanFactoryBody(node);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        factoryNames.has(node.name.text) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        scanFactoryBody(node.initializer);
      }

      // Check direct `settings.<key>` access anywhere in value positions
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "settings") {
        readSettings.add(node.name.text);
      }

      // Check `env.<X>` or `<obj>.env.<X>` (e.g. `c.env.<X>`)
      if (ts.isPropertyAccessExpression(node)) {
        const target = node.expression;
        if (ts.isIdentifier(target) && target.text === "env") {
          envRefs.add(node.name.text);
        } else if (ts.isPropertyAccessExpression(target) && target.name.text === "env") {
          envRefs.add(node.name.text);
        }
      }

      // Check Hono route mounts: app.get("/foo", ...) / router.post("/bar", ...)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const firstArg = node.arguments[0];
        if (HTTP_METHODS.has(method) && firstArg && ts.isStringLiteral(firstArg)) {
          const routePath = firstArg.text;
          if (routePath.startsWith("/")) {
            const fullPath = `${mountBase.replace(/\/+$/, "")}/${routePath.replace(/^\/+/, "")}`;
            const relativeToApi = fullPath.startsWith("/api/")
              ? fullPath.slice("/api/".length)
              : fullPath.replace(/^\/+/, "");
            const firstSegment = relativeToApi.split("/").filter(Boolean)[0] ?? "";
            if (firstSegment && !firstSegment.startsWith(":")) {
              mountedRoutes.push({ path: routePath, firstSegment });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sf, visit);
  }

  return { readSettings, envRefs, mountedRoutes, forbiddenRuntimeConstructs: [...forbiddenSet].sort() };
}

export function checkBrickConformance(brickDir: string, brickName = brickDir.split(/[\\/]/).pop() ?? brickDir, rootDir?: string): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  const manifestPath = join(brickDir, "brick.manifest.json");
  const pkgPath = join(brickDir, "package.json");

  if (!existsSync(manifestPath)) {
    violations.push({ brick: brickName, field: "schema", detail: "brick.manifest.json is missing" });
    return violations;
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    violations.push({ brick: brickName, field: "schema", detail: `invalid JSON in brick.manifest.json: ${(err as Error).message}` });
    return violations;
  }

  // 1. Schema valid against ManifestSchema v2
  const parsed = ManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const pathPrefix = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      violations.push({ brick: brickName, field: "schema", detail: `${pathPrefix}${issue.message}` });
    }
    return violations;
  }
  const manifest: BrickManifestFile = parsed.data;

  // 1b. Version check (cannot be 0.0.0)
  if (manifest.version === "0.0.0") {
    violations.push({
      brick: brickName,
      field: "version",
      detail: "brick version cannot be 0.0.0",
    });
  }

  // 1c. CHANGELOG.md check
  const changelogPath = join(brickDir, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    violations.push({
      brick: brickName,
      field: "changelog",
      detail: "CHANGELOG.md is missing",
    });
  } else {
    const changelogContent = readFileSync(changelogPath, "utf8");
    if (!changelogContent.includes(manifest.version)) {
      violations.push({
        brick: brickName,
        field: "changelog",
        detail: `CHANGELOG.md does not mention version ${manifest.version}`,
      });
    }
  }

  // Read package.json
  if (!existsSync(pkgPath)) {
    violations.push({ brick: brickName, field: "worker.package", detail: "package.json is missing" });
    return violations;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name?: string;
    version?: string;
    exports?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  // 2. worker.package equals package.json name & version matches
  if (manifest.worker.package !== pkg.name) {
    violations.push({
      brick: brickName,
      field: "worker.package",
      detail: `manifest declares "${manifest.worker.package}" but package.json name is "${pkg.name ?? ""}"`,
    });
  }
  if (pkg.version && pkg.version !== manifest.version) {
    violations.push({
      brick: brickName,
      field: "version",
      detail: `manifest declares version "${manifest.version}" but package.json version is "${pkg.version}"`,
    });
  }

  // 3. Exported functions check (routes[].factory, $call options, worker.guard.export, triggers handlers)
  const entryRel = pkg.exports?.["."] ?? "./src/index.ts";
  const entryPath = resolve(brickDir, entryRel);
  const exportedFns = collectExportedFunctions(entryPath);

  for (const route of manifest.worker.routes) {
    if (!exportedFns.has(route.factory)) {
      violations.push({
        brick: brickName,
        field: "worker.routes",
        detail: `factory "${route.factory}" is not exported as a function by ${entryRel}`,
      });
    }
    for (const [optName, optVal] of Object.entries(route.options)) {
      if (typeof optVal === "object" && "$call" in optVal && !exportedFns.has(optVal.$call)) {
        violations.push({
          brick: brickName,
          field: "worker.routes",
          detail: `$call "${optVal.$call}" (option "${optName}") is not exported as a function by ${entryRel}`,
        });
      }
    }
  }

  if (manifest.worker.guard && !exportedFns.has(manifest.worker.guard.export)) {
    violations.push({
      brick: brickName,
      field: "worker.guard",
      detail: `guard "${manifest.worker.guard.export}" is not exported as a function by ${entryRel}`,
    });
  }
  if (manifest.worker.guard?.suspension && !exportedFns.has(manifest.worker.guard.suspension)) {
    violations.push({
      brick: brickName,
      field: "worker.guard",
      detail: `suspension check "${manifest.worker.guard.suspension}" is not exported as a function by ${entryRel}`,
    });
  }

  if (manifest.worker.approvalGuard && !exportedFns.has(manifest.worker.approvalGuard.export)) {
    violations.push({
      brick: brickName,
      field: "worker.approvalGuard",
      detail: `approval guard "${manifest.worker.approvalGuard.export}" is not exported as a function by ${entryRel}`,
    });
  }

  if (manifest.triggers) {
    for (const sched of manifest.triggers.schedules ?? []) {
      if (!exportedFns.has(sched.handler)) {
        violations.push({
          brick: brickName,
          field: "triggers.schedules",
          detail: `handler "${sched.handler}" for schedule "${sched.id}" is not exported as a function by ${entryRel}`,
        });
      }
    }
    for (const q of manifest.triggers.queues ?? []) {
      if (!exportedFns.has(q.handler)) {
        violations.push({
          brick: brickName,
          field: "triggers.queues",
          detail: `handler "${q.handler}" for queue "${q.id}" is not exported as a function by ${entryRel}`,
        });
      }
    }
  }

  for (const node of manifest.nodes ?? []) {
    if (!exportedFns.has(node.executor)) {
      violations.push({
        brick: brickName,
        field: "nodes",
        detail: `executor "${node.executor}" for node "${node.type}" is not exported as a function by ${entryRel}`,
      });
    }
  }

  // 4. Migrations check & workspace_id column check
  const globalTables = new Set(
    (manifest.globalTables ?? []).filter((g) => g.reason.trim().length > 0).map((g) => g.table),
  );
  // Story 1.10: every table the migrations create, and whether it has workspace_id, for the workspaceData checks below.
  const createdTables = new Map<string, boolean>();
  for (const mig of manifest.migrations) {
    const migPath = join(brickDir, mig);
    if (!existsSync(migPath)) {
      violations.push({
        brick: brickName,
        field: "migrations",
        detail: `declared migration "${mig}" does not exist`,
      });
      continue;
    }
    const sqlContent = readFileSync(migPath, "utf8");
    const lintRes = lintMigration(mig, sqlContent);
    if (lintRes.class === "destructive") {
      const header = lintRes.header;
      const validContract =
        header?.phase === "contract" &&
        header.expands &&
        manifest.migrations.some((m) => m === header.expands || m.endsWith(`/${header.expands}`));
      if (!validContract) {
        violations.push({
          brick: brickName,
          field: "migrations",
          detail: `migration "${mig}" is destructive and blocked without expand/contract header: ${lintRes.findings.map((f) => f.message).join("; ")}`,
        });
      }
    }
    for (const { table, hasWorkspaceId } of extractCreatedTables(sqlContent)) {
      if (!createdTables.has(table)) createdTables.set(table, hasWorkspaceId);
      if (!hasWorkspaceId && !globalTables.has(table)) {
        violations.push({
          brick: brickName,
          field: "migrations",
          detail: `table "${table}" in ${mig} has no workspace_id column and is not listed as global with a reason`,
        });
      }
      if (hasWorkspaceId && !globalTables.has(table)) {
        const hasPrivacy = Boolean(
          manifest.privacy?.tables?.[table] ||
          manifest.privacy?.hookTables?.includes(table)
        );
        if (!hasPrivacy) {
          violations.push({
            brick: brickName,
            field: "privacy",
            detail: `table "${table}" has workspace_id but no privacy rule in manifest.privacy.tables`,
          });
        }
      }
    }
  }

  // 4a. Story 2.6: a platformWide privacy table must be one this brick's own migrations create, without workspace_id.
  for (const [table, rule] of Object.entries(manifest.privacy?.tables ?? {})) {
    if (!rule.platformWide) continue;
    if (createdTables.get(table) !== false) {
      violations.push({
        brick: brickName,
        field: "privacy",
        detail: `platformWide privacy table "${table}" must be created by this brick's own migrations, without a workspace_id column`,
      });
    }
  }

  // 4b. Workspace data (story 1.10): every tenant table is purged when its workspace is deleted, or exempt with a reason;
  // every declared table exists and has workspace_id.
  const declaredData = new Set((manifest.workspaceData?.tables ?? []).map((t) => t.table));
  const exemptData = new Set((manifest.workspaceData?.exempt ?? []).filter((e) => e.reason.trim().length > 0).map((e) => e.table));
  for (const [table, hasWorkspaceId] of createdTables) {
    if (hasWorkspaceId && !globalTables.has(table) && !declaredData.has(table) && !exemptData.has(table)) {
      violations.push({
        brick: brickName,
        field: "workspaceData",
        detail: `tenant table "${table}" is neither declared in workspaceData.tables nor exempt with a reason`,
      });
    }
  }
  for (const entry of [...(manifest.workspaceData?.tables ?? []), ...(manifest.workspaceData?.exempt ?? [])]) {
    const hasWorkspaceId = createdTables.get(entry.table);
    if (hasWorkspaceId === undefined) {
      violations.push({ brick: brickName, field: "workspaceData", detail: `table "${entry.table}" is not created by any of the brick's migrations` });
    } else if (!hasWorkspaceId) {
      violations.push({ brick: brickName, field: "workspaceData", detail: `table "${entry.table}" has no workspace_id column` });
    }
  }

  const migrationsDir = join(brickDir, "migrations");
  if (existsSync(migrationsDir) && statSync(migrationsDir).isDirectory()) {
    const declaredSet = new Set(manifest.migrations);
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      const rel = `migrations/${file}`;
      if (!declaredSet.has(rel)) {
        violations.push({
          brick: brickName,
          field: "migrations",
          detail: `migration file "${rel}" on disk is not listed in migrations`,
        });
      }
    }
  }

  // 5. npmDependencies equals package.json dependencies (ignoring workspace:*)
  const pkgExternalDeps: Record<string, string> = {};
  for (const [dep, ver] of Object.entries(pkg.dependencies ?? {})) {
    if (!ver.startsWith("workspace:")) {
      pkgExternalDeps[dep] = ver;
    }
  }
  for (const [dep, ver] of Object.entries(manifest.npmDependencies)) {
    if (pkgExternalDeps[dep] !== ver) {
      violations.push({
        brick: brickName,
        field: "npmDependencies",
        detail: `manifest declares ${dep}@${ver} but package.json has ${pkgExternalDeps[dep] ?? "none"}`,
      });
    }
  }
  for (const [dep, ver] of Object.entries(pkgExternalDeps)) {
    if (!(dep in manifest.npmDependencies)) {
      violations.push({
        brick: brickName,
        field: "npmDependencies",
        detail: `package.json dependency ${dep}@${ver} is missing from npmDependencies`,
      });
    }
  }

  // Scan TypeScript source in src/**
  const srcFiles = listTsSourceFiles(join(brickDir, "src"));
  const factoryNames = new Set(manifest.worker.routes.map((r) => r.factory));
  const mountPoints = manifest.worker.routes.map((r) => r.mountAt);
  const { readSettings, envRefs, mountedRoutes, forbiddenRuntimeConstructs } = collectSettingsAndEnvFromSource(
    srcFiles,
    factoryNames,
    mountPoints,
  );

  for (const detail of forbiddenRuntimeConstructs) {
    violations.push({
      brick: brickName,
      field: "triggers",
      detail,
    });
  }

  // 6. Mounted route paths vs routePrefixes
  const declaredPrefixes = new Set(manifest.routePrefixes);
  const seenUnmatchedPrefixes = new Set<string>();
  const matchedPrefixes = new Set<string>();
  for (const { path, firstSegment } of mountedRoutes) {
    if (declaredPrefixes.has(firstSegment)) {
      matchedPrefixes.add(firstSegment);
    } else if (!seenUnmatchedPrefixes.has(firstSegment)) {
      seenUnmatchedPrefixes.add(firstSegment);
      violations.push({
        brick: brickName,
        field: "routePrefixes",
        detail: `mounted route "${path}" uses prefix "${firstSegment}" which is not in routePrefixes [${manifest.routePrefixes.join(", ")}]`,
      });
    }
  }
  if (mountedRoutes.length > 0) {
    for (const prefix of manifest.routePrefixes) {
      if (!matchedPrefixes.has(prefix)) {
        violations.push({
          brick: brickName,
          field: "routePrefixes",
          detail: `declared routePrefix "${prefix}" has no mounted route under it`,
        });
      }
    }
  }

  // 6b. Rate-limited routes (story 0.21): each path sits under one of the brick's routePrefixes, numbers are positive,
  // a param key names a param of its path, a bucket means the same rule wherever it is used, and auth rules fail closed.
  const bucketRules = new Map<string, string>();
  for (const [index, rule] of (manifest.rateLimits ?? []).entries()) {
    const where = `rateLimits[${index}] ${rule.method} ${rule.path}`;
    const firstSegment = rule.path.split("/")[1] ?? "";
    if (!declaredPrefixes.has(firstSegment)) {
      violations.push({
        brick: brickName,
        field: "rateLimits",
        detail: `${where} is not under any routePrefix [${manifest.routePrefixes.join(", ")}]`,
      });
    }
    if (!(Number.isInteger(rule.limit) && rule.limit > 0) || !(Number.isInteger(rule.windowSeconds) && rule.windowSeconds > 0)) {
      violations.push({ brick: brickName, field: "rateLimits", detail: `${where} needs a positive whole limit and windowSeconds` });
    }
    if (rule.key.startsWith("param:") && !rule.path.split("/").includes(`:${rule.key.slice("param:".length)}`)) {
      violations.push({ brick: brickName, field: "rateLimits", detail: `${where} keys on ${rule.key}, which its path does not name` });
    }
    if (rule.bucket.startsWith("auth-") && rule.failClosed !== true) {
      violations.push({ brick: brickName, field: "rateLimits", detail: `${where} is an auth rule (bucket ${rule.bucket}) and must set failClosed: true` });
    }
    const signature = JSON.stringify([rule.limit, rule.windowSeconds, rule.key, rule.failClosed === true]);
    const previous = bucketRules.get(rule.bucket);
    if (previous !== undefined && previous !== signature) {
      violations.push({ brick: brickName, field: "rateLimits", detail: `bucket ${rule.bucket} is declared with different numbers or keys` });
    }
    bucketRules.set(rule.bucket, signature);
  }

  // 7. Settings read in source vs declared in manifest.settings
  const nonSettingOptions = new Set<string>(DI_OPTION_KEYS);
  const optionToSetting = new Map<string, string>();
  for (const route of manifest.worker.routes) {
    for (const [optName, optVal] of Object.entries(route.options)) {
      if (typeof optVal === "object" && ("$call" in optVal || "$entities" in optVal || "$privacy" in optVal || "$workspaceData" in optVal || "$capability" in optVal || "$capabilitySetting" in optVal)) {
        nonSettingOptions.add(optName);
      } else if (typeof optVal === "object" && "$setting" in optVal) {
        optionToSetting.set(optName, optVal.$setting);
      }
    }
  }
  const declaredSettings = new Set(Object.keys(manifest.settings));
  const resolvedReadSettings = new Set<string>();
  for (const key of [...readSettings].sort()) {
    if (nonSettingOptions.has(key)) continue;
    const settingName = optionToSetting.get(key) ?? key;
    resolvedReadSettings.add(settingName);
    if (!declaredSettings.has(settingName)) {
      violations.push({
        brick: brickName,
        field: "settings",
        detail: `setting "${settingName}" is read in source but not declared in settings`,
      });
    }
  }
  for (const key of [...declaredSettings].sort()) {
    if (!resolvedReadSettings.has(key)) {
      violations.push({
        brick: brickName,
        field: "settings",
        detail: `setting "${key}" is declared in settings but never read in source`,
      });
    }
  }

  // 8. Every env.X / c.env.X referenced is declared in bindings or secrets (DB is standard shell D1 binding)
  const declaredEnv = new Set<string>(["DB", ...(APP_CONFIG_ENV_VARS[brickName] ?? [])]);
  if (Array.isArray(manifest.bindings)) {
    for (const b of manifest.bindings) declaredEnv.add(b);
  } else if (manifest.bindings && typeof manifest.bindings === "object") {
    for (const b of Object.keys(manifest.bindings)) declaredEnv.add(b);
  }
  for (const s of manifest.secrets ?? []) {
    declaredEnv.add(s);
  }
  for (const envName of [...envRefs].sort()) {
    if (!declaredEnv.has(envName)) {
      violations.push({
        brick: brickName,
        field: "bindings",
        detail: `env.${envName} is referenced in source but not declared in bindings or secrets`,
      });
    }
  }

  // 9. Maturity tier, reason, and deriveTier checks (Story UC5.6)
  if (!manifest.ui?.maturity) {
    violations.push({
      brick: brickName,
      field: "ui.maturity",
      detail: 'ui.maturity is required (must be "production", "beta", or "experimental")',
    });
  } else {
    const declaredTier = manifest.ui.maturity as MaturityTier;
    if (declaredTier !== "production" && !manifest.ui.maturityReason?.trim()) {
      violations.push({
        brick: brickName,
        field: "ui.maturityReason",
        detail: `ui.maturityReason is required when ui.maturity is "${declaredTier}"`,
      });
    }
    if (declaredTier === "production" || declaredTier === "beta") {
      if (!manifest.ui.behaviourTest) {
        violations.push({
          brick: brickName,
          field: "ui.behaviourTest",
          detail: `ui.behaviourTest is required when ui.maturity is "${declaredTier}"`,
        });
      } else if (!existsSync(join(brickDir, manifest.ui.behaviourTest))) {
        violations.push({
          brick: brickName,
          field: "ui.behaviourTest",
          detail: `declared behaviourTest "${manifest.ui.behaviourTest}" does not exist`,
        });
      }
    } else if (manifest.ui.behaviourTest && !existsSync(join(brickDir, manifest.ui.behaviourTest))) {
      violations.push({
        brick: brickName,
        field: "ui.behaviourTest",
        detail: `declared behaviourTest "${manifest.ui.behaviourTest}" does not exist`,
      });
    }

    // deriveTier check
    const resolvedRoot = rootDir ?? resolve(brickDir, "..", "..");
    const tierEvidenceMap = loadTierEvidenceMap(resolvedRoot);
    if (tierEvidenceMap.size > 0 || process.env.POC_EVIDENCE_DIR) {
      const tierEvidence = tierEvidenceMap.get(brickName);
      const policy = loadTierPolicy(
        existsSync(join(resolvedRoot, "scripts", "tier-policy.json"))
          ? join(resolvedRoot, "scripts", "tier-policy.json")
          : undefined,
      );
      const derived = deriveTier(manifest, tierEvidence, null, null, policy);
      if (TIER_RANK[declaredTier] > TIER_RANK[derived.tier]) {
        violations.push({
          brick: brickName,
          field: "ui.maturity",
          detail: `declared ${declaredTier}, derived ${derived.tier}: ${derived.blockers.join(", ")}`,
        });
      }
    }
  }

  return violations;
}

export function checkNodePackConformance(packDir: string, packName = packDir.split(/[\\/]/).pop() ?? packDir): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  const manifestPath = join(packDir, `${packName}.manifest.json`);
  const pkgPath = join(packDir, "package.json");

  if (!existsSync(manifestPath)) {
    return [{ brick: packName, field: "manifest", detail: `${packName}.manifest.json is missing` }];
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return [{ brick: packName, field: "manifest", detail: `invalid JSON: ${(err as Error).message}` }];
  }

  const parsed = NodePackManifestSchema.safeParse(rawJson);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      violations.push({
        brick: packName,
        field: issue.path.join(".") || "(root)",
        detail: issue.message,
      });
    }
    return violations;
  }

  const manifest: NodePackManifestFile = parsed.data;
  if (!existsSync(pkgPath)) {
    violations.push({ brick: packName, field: "package.json", detail: "package.json is missing" });
    return violations;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name?: string;
    exports?: Record<string, string>;
  };

  if (manifest.package !== pkg.name) {
    violations.push({
      brick: packName,
      field: "package",
      detail: `manifest declares "${manifest.package}" but package.json name is "${pkg.name ?? ""}"`,
    });
  }

  const entryRel = pkg.exports?.["."] ?? "./src/index.ts";
  const entryPath = resolve(packDir, entryRel);
  const exportedFns = collectExportedFunctions(entryPath);

  for (const node of manifest.nodes) {
    if (!exportedFns.has(node.executor)) {
      violations.push({
        brick: packName,
        field: "nodes",
        detail: `executor "${node.executor}" for node "${node.type}" is not exported as a function by ${entryRel}`,
      });
    }
  }

  if (manifest.ui.maturity !== "production" && !manifest.ui.maturityReason?.trim()) {
    violations.push({
      brick: packName,
      field: "ui.maturityReason",
      detail: `ui.maturityReason is required when ui.maturity is "${manifest.ui.maturity}"`,
    });
  }
  if (!manifest.ui.behaviourTest) {
    violations.push({
      brick: packName,
      field: "ui.behaviourTest",
      detail: `ui.behaviourTest is required when ui.maturity is "${manifest.ui.maturity}"`,
    });
  } else if (!existsSync(join(packDir, manifest.ui.behaviourTest))) {
    violations.push({
      brick: packName,
      field: "ui.behaviourTest",
      detail: `declared behaviourTest "${manifest.ui.behaviourTest}" does not exist`,
    });
  }

  return violations;
}

export function checkIntegrationConformance(
  integrationDir: string,
  appName = integrationDir.split(/[\\/]/).pop() ?? integrationDir,
  rootDir?: string,
): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  const manifestPath = join(integrationDir, "integration.json");

  if (!existsSync(manifestPath)) {
    return [{ brick: appName, field: "manifest", detail: "integration.json is missing" }];
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return [{ brick: appName, field: "manifest", detail: `invalid JSON: ${(err as Error).message}` }];
  }

  const parsed = IntegrationManifestSchema.safeParse(rawJson);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      violations.push({
        brick: appName,
        field: issue.path.join(".") || "(root)",
        detail: issue.message,
      });
    }
    return violations;
  }

  const manifest: IntegrationManifestFile = parsed.data;
  if (manifest.app !== appName) {
    violations.push({
      brick: appName,
      field: "app",
      detail: `manifest declares app "${manifest.app}" but directory name is "${appName}"`,
    });
  }

  if (manifest.ui.maturity !== "production" && !manifest.ui.maturityReason?.trim()) {
    violations.push({
      brick: appName,
      field: "ui.maturityReason",
      detail: `ui.maturityReason is required when ui.maturity is "${manifest.ui.maturity}"`,
    });
  }

  if (manifest.ui.maturity === "production" || manifest.ui.maturity === "beta") {
    if (!manifest.ui.behaviourTest) {
      violations.push({
        brick: appName,
        field: "ui.behaviourTest",
        detail: `ui.behaviourTest is required when ui.maturity is "${manifest.ui.maturity}"`,
      });
    } else if (
      !existsSync(join(integrationDir, manifest.ui.behaviourTest)) &&
      !existsSync(join(ROOT, manifest.ui.behaviourTest))
    ) {
      violations.push({
        brick: appName,
        field: "ui.behaviourTest",
        detail: `declared behaviourTest "${manifest.ui.behaviourTest}" does not exist`,
      });
    }
  } else if (
    manifest.ui.behaviourTest &&
    !existsSync(join(integrationDir, manifest.ui.behaviourTest)) &&
    !existsSync(join(ROOT, manifest.ui.behaviourTest))
  ) {
    violations.push({
      brick: appName,
      field: "ui.behaviourTest",
      detail: `declared behaviourTest "${manifest.ui.behaviourTest}" does not exist`,
    });
  }

  // Check deriveTier for integration (Story UC5.6 replaces UC5.1 interim rule)
  const resolvedRoot = rootDir ?? resolve(integrationDir, "..", "..");
  const tierEvidenceMap = loadTierEvidenceMap(resolvedRoot);
  const evidenceDir = process.env.POC_EVIDENCE_DIR
    ? resolve(process.env.POC_EVIDENCE_DIR)
    : existsSync(join(resolvedRoot, ".evidence-run", "tier-evidence.json"))
      ? join(resolvedRoot, ".evidence-run")
      : join(resolvedRoot, "evidence");

  const canaryPath = join(evidenceDir, "live-canary", `${manifest.app}.json`);
  let liveCanary: any = null;
  if (existsSync(canaryPath)) {
    try {
      liveCanary = JSON.parse(readFileSync(canaryPath, "utf8"));
    } catch {}
  }

  const reportPath = join(integrationDir, "import-report.json");
  let fidelityReport: any = null;
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const lossEntries = (report.entries ?? []).filter(
        (e: any) =>
          e.status === "approximated" ||
          e.status === "unsupported" ||
          (typeof e.code === "string" && e.code.endsWith("_LOSS")),
      );
      const curationPath = existsSync(join(integrationDir, "curation.config.json"))
        ? join(integrationDir, "curation.config.json")
        : join(integrationDir, "curation.json");
      let unackCount = 0;
      if (lossEntries.length > 0) {
        const acks = new Set<string>();
        if (existsSync(curationPath)) {
          try {
            const curation = JSON.parse(readFileSync(curationPath, "utf8"));
            const rawAcks = Array.isArray(curation.acknowledge)
              ? curation.acknowledge
              : Array.isArray(curation.acknowledgements)
                ? curation.acknowledgements
                : [];
            for (const ack of rawAcks) {
              acks.add(`${ack.op ?? "<doc>"}:${ack.code}`);
              if (ack.pointer) {
                acks.add(`${ack.op ?? "<doc>"}:${ack.code}:${ack.pointer}`);
              }
            }
          } catch {}
        }
        unackCount = lossEntries.filter(
          (e: any) =>
            !acks.has(`${e.op ?? "<doc>"}:${e.code}`) &&
            !acks.has(`${e.op ?? "<doc>"}:${e.code}:${e.pointer ?? ""}`),
        ).length;
      }
      fidelityReport = {
        reportPresent: true,
        unacknowledgedLosses: unackCount,
        ...report,
      };
    } catch {}
  }

  if (tierEvidenceMap.size > 0 || process.env.POC_EVIDENCE_DIR) {
    const tierEvidence = tierEvidenceMap.get(appName);
    const policy = loadTierPolicy(
      existsSync(join(resolvedRoot, "scripts", "tier-policy.json"))
        ? join(resolvedRoot, "scripts", "tier-policy.json")
        : undefined,
    );
    const derived = deriveTier(manifest, tierEvidence, fidelityReport, liveCanary, policy);
    const declaredTier = manifest.ui.maturity as MaturityTier;
    if (TIER_RANK[declaredTier] > TIER_RANK[derived.tier]) {
      violations.push({
        brick: appName,
        field: "ui.maturity",
        detail: `declared ${declaredTier}, derived ${derived.tier}: ${derived.blockers.join(", ")}`,
      });
    }
  }

  // Check import-report.json and fidelity freshness (Story UC2.7)
  const discoveryPath = join(integrationDir, "discovery.json");
  const openApiJsonPath = join(integrationDir, "openapi.json");
  const openApiYamlPath = join(integrationDir, "openapi.yaml");
  const specPath = existsSync(discoveryPath)
    ? discoveryPath
    : existsSync(openApiJsonPath)
      ? openApiJsonPath
      : existsSync(openApiYamlPath)
        ? openApiYamlPath
        : null;

  if (!existsSync(reportPath)) {
    violations.push({
      brick: appName,
      field: "fidelity",
      detail: "stale import: run pnpm openapi:import --all",
    });
  } else {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      let specFileHash = "";
      if (specPath && existsSync(specPath)) {
        const specRaw = readFileSync(specPath, "utf8");
        specFileHash = `sha256:${createHash("sha256").update(Buffer.from(specRaw, "utf8")).digest("hex")}`;
      }

      if (
        !manifest.fidelity ||
        report.specHash !== manifest.fidelity.specHash ||
        report.specHash !== specFileHash ||
        report.importerVersion !== manifest.fidelity.importerVersion ||
        manifest.fidelity.importerVersion !== IMPORTER_VERSION
      ) {
        violations.push({
          brick: appName,
          field: "fidelity",
          detail: "stale import: run pnpm openapi:import --all",
        });
      }
    } catch {
      violations.push({
        brick: appName,
        field: "fidelity",
        detail: "stale import: run pnpm openapi:import --all",
      });
    }
  }

  const projectedNodes = projectIntegrationToNodes(manifest);
  for (const node of projectedNodes) {
    const nodeParsed = nodeDefinition.safeParse(node);
    if (!nodeParsed.success) {
      for (const issue of nodeParsed.error.issues) {
        violations.push({
          brick: appName,
          field: `projectedNodes.${node.type}`,
          detail: issue.message,
        });
      }
    }
  }

  return violations;
}

export function checkAllBricks(bricksDir = join(ROOT, "bricks")): ConformanceViolation[] {
  if (!existsSync(bricksDir)) return [];
  const entries = readdirSync(bricksDir)
    .filter((name) => {
      const full = join(bricksDir, name);
      return statSync(full).isDirectory() && existsSync(join(full, "brick.manifest.json"));
    })
    .sort();

  const violations: ConformanceViolation[] = [];
  for (const name of entries) {
    violations.push(...checkBrickConformance(join(bricksDir, name), name));
  }
  const rootDir = dirname(resolve(bricksDir));
  const packagesDir = join(rootDir, "packages");
  if (existsSync(packagesDir)) {
    for (const name of readdirSync(packagesDir).sort()) {
      const full = join(packagesDir, name);
      if (statSync(full).isDirectory() && existsSync(join(full, `${name}.manifest.json`))) {
        violations.push(...checkNodePackConformance(full, name));
      }
    }
  }
  const integrationsDir = join(rootDir, "integrations");
  if (existsSync(integrationsDir)) {
    for (const name of readdirSync(integrationsDir).sort()) {
      const full = join(integrationsDir, name);
      if (statSync(full).isDirectory() && existsSync(join(full, "integration.json"))) {
        violations.push(...checkIntegrationConformance(full, name, rootDir));
      }
    }
  }
  return violations;
}

export function formatViolationLine(v: ConformanceViolation): string {
  return `${v.brick}: ${v.field}: ${v.detail}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let bricksDir = join(ROOT, "bricks");
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bricks-dir" && args[i + 1]) {
      bricksDir = resolve(args[++i]!);
    } else if (args[i] === "--root" && args[i + 1]) {
      bricksDir = join(resolve(args[++i]!), "bricks");
    } else if (args[i] === "--json") {
      jsonOutput = true;
    }
  }

  const violations = checkAllBricks(bricksDir);
  const tenantLint = lintTenantQueries({ bricksDir });

  if (jsonOutput) {
    console.log(JSON.stringify({ violations, tenantViolations: tenantLint.violations }, null, 2));
  } else {
    for (const v of violations) {
      console.log(formatViolationLine(v));
    }
    if (tenantLint.violations.length > 0) {
      console.error(`\n[tenant-lint] Found ${tenantLint.violations.length} tenant query violation(s):`);
      for (const tv of tenantLint.violations) {
        console.error(tv.message);
      }
    }
  }
  process.exit(violations.length > 0 || tenantLint.violations.length > 0 ? 1 : 0);
}
