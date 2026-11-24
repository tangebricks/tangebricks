import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CreatedTableInfo {
  table: string;
  hasWorkspaceId: boolean;
}

/**
 * Extracts table definitions from SQL migration files.
 * Reused from check-manifests.ts migration parser.
 */
export function extractCreatedTables(sqlContent: string): CreatedTableInfo[] {
  const stripped = sqlContent
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const results: CreatedTableInfo[] = [];
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_"]+)\s*\(([\s\S]*?)\)\s*;/gi;
  for (const match of stripped.matchAll(createTableRegex)) {
    const rawName = match[1] ?? "";
    const table = rawName.replace(/"/g, "");
    const body = match[2] ?? "";
    const hasWorkspaceId = /\bworkspace_id\b/i.test(body);
    results.push({ table, hasWorkspaceId });
  }
  return results;
}

export interface BrickTenantTables {
  brickId: string;
  brickDir: string;
  tenantTables: Set<string>;
  globalTables: Set<string>;
  allTables: Set<string>;
}

/**
 * Derives tenant tables and global tables for a single brick from its manifest and migrations.
 */
export function getTenantTablesForBrick(brickDir: string): BrickTenantTables {
  const manifestPath = join(brickDir, "brick.manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      brickId: "",
      brickDir,
      tenantTables: new Set(),
      globalTables: new Set(),
      allTables: new Set(),
    };
  }

  let manifest: any = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = {};
  }

  const brickId = typeof manifest.id === "string" ? manifest.id : "";
  const globalTablesList: Array<{ table: string; reason?: string }> = Array.isArray(manifest.globalTables)
    ? manifest.globalTables
    : [];
  const globalTables = new Set(
    globalTablesList
      .filter((g) => typeof g.reason === "string" && g.reason.trim().length > 0)
      .map((g) => g.table),
  );

  const tenantTables = new Set<string>();
  const allTables = new Set<string>();

  const migrations: string[] = Array.isArray(manifest.migrations) ? manifest.migrations : [];
  for (const mig of migrations) {
    const migPath = join(brickDir, mig);
    if (!existsSync(migPath)) continue;
    const sqlContent = readFileSync(migPath, "utf8");
    for (const { table, hasWorkspaceId } of extractCreatedTables(sqlContent)) {
      allTables.add(table);
      if (hasWorkspaceId && !globalTables.has(table)) {
        tenantTables.add(table);
      }
    }
  }

  return {
    brickId,
    brickDir,
    tenantTables,
    globalTables,
    allTables,
  };
}

/**
 * Scans a directory (either a single brick dir or a parent dir containing multiple bricks)
 * and returns a map of brickId -> BrickTenantTables.
 */
export function getAllTenantTables(targetDir: string): Map<string, BrickTenantTables> {
  const map = new Map<string, BrickTenantTables>();
  if (!existsSync(targetDir)) return map;

  // Check if targetDir itself is a brick directory
  if (existsSync(join(targetDir, "brick.manifest.json"))) {
    const info = getTenantTablesForBrick(targetDir);
    map.set(info.brickId || "brick", info);
    return map;
  }

  // Otherwise, inspect child directories
  const entries = readdirSync(targetDir);
  for (const entry of entries) {
    const fullPath = join(targetDir, entry);
    if (statSync(fullPath).isDirectory() && existsSync(join(fullPath, "brick.manifest.json"))) {
      const info = getTenantTablesForBrick(fullPath);
      map.set(info.brickId || entry, info);
    }
  }

  return map;
}
