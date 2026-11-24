// Usage: node scripts/build-catalog.ts
// Reads every bricks/*/brick.manifest.json and packages/*/core-nodes.manifest.json, checks them against the
// assembler's manifest schemas, reads migration files, and writes packages/assembler/catalog.generated.ts and catalog.json.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IntegrationManifestSchema,
  ManifestSchema,
  NodePackManifestSchema,
  extractAuthConnectionFields,
  formatIssues,
  projectIntegrationToNodes,
} from "../packages/assembler/src/schemas.ts";
import type {
  Catalog,
  IntegrationManifestFile,
  ManifestNodeDefinition,
  NodePackManifestFile,
} from "../packages/assembler/src/schemas.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_PATH = join(root, "packages", "assembler", "catalog.generated.ts");
export const CATALOG_JSON_PATH = join(root, "catalog.json");
export const STUDIO_WEB_CATALOG_JSON_PATH = join(root, "apps", "studio-web", "src", "catalog-data.json");

export interface BuildCatalogOptions {
  readonly integrationsDir?: string;
}

export function buildCatalog(repoRoot = root, options: BuildCatalogOptions = {}): Catalog {
  const catalog: Catalog = { bricks: {}, nodePacks: {}, integrations: {} };
  const sourceDirs = [join(repoRoot, "bricks"), join(repoRoot, "packages")];
  for (const base of sourceDirs) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dirPath = join(base, name);
      const manifestPath = join(dirPath, "brick.manifest.json");
      if (existsSync(manifestPath)) {
        const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
        if (!parsed.success) throw new Error(`${manifestPath}:\n  ${formatIssues(parsed.error).join("\n  ")}`);
        const manifest = parsed.data;
        if (!catalog.bricks[manifest.id]) {
          const files: Record<string, string> = {};
          for (const file of manifest.migrations) {
            // Line endings are normalised so the catalog (and every project assembled from it) is the same on every machine.
            files[file] = readFileSync(join(base, name, file), "utf8").replace(/\r\n/g, "\n");
          }
          catalog.bricks[manifest.id] = { manifest, files };
        }
      }

      const nodePackPath = join(dirPath, `${name}.manifest.json`);
      if (existsSync(nodePackPath)) {
        const rawJson = JSON.parse(readFileSync(nodePackPath, "utf8")) as Record<string, unknown>;
        if (rawJson.kind === "node-pack") {
          const parsedPack = NodePackManifestSchema.safeParse(rawJson);
          if (!parsedPack.success) throw new Error(`${nodePackPath}:\n  ${formatIssues(parsedPack.error).join("\n  ")}`);
          const packManifest: NodePackManifestFile = parsedPack.data;
          if (catalog.nodePacks && !catalog.nodePacks[packManifest.id]) {
            catalog.nodePacks[packManifest.id] = { manifest: packManifest };
          }
        }
      }
    }
  }

  const integrationsBase = options.integrationsDir ?? join(repoRoot, "integrations");
  if (existsSync(integrationsBase)) {
    for (const name of readdirSync(integrationsBase).sort()) {
      const dirPath = join(integrationsBase, name);
      const manifestPath = join(dirPath, "integration.json");
      if (!existsSync(manifestPath)) continue;
      const parsed = IntegrationManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
      if (!parsed.success) {
        throw new Error(`${manifestPath}:\n  ${formatIssues(parsed.error).join("\n  ")}`);
      }
      const manifest: IntegrationManifestFile = parsed.data;
      if (
        (manifest.ui.maturity === "production" || manifest.ui.maturity === "beta") &&
        !manifest.ui.behaviourTest?.trim()
      ) {
        throw new Error(
          `${manifestPath}:\n  ui.behaviourTest: ui.behaviourTest is required when ui.maturity is "${manifest.ui.maturity}"`,
        );
      }
      const nodes: ManifestNodeDefinition[] = projectIntegrationToNodes(manifest);
      if (!manifest.auth.connectionFields) {
        manifest.auth.connectionFields = extractAuthConnectionFields(manifest.auth);
      }
      if (catalog.integrations && !catalog.integrations[manifest.app]) {
        catalog.integrations[manifest.app] = { manifest, nodes };
      }
    }
  }

  const sortedBricks = Object.fromEntries(
    Object.entries(catalog.bricks)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, brick]) => [
        id,
        {
          manifest: brick.manifest,
          files: Object.fromEntries(Object.entries(brick.files).sort(([a], [b]) => (a < b ? -1 : 1))),
        },
      ]),
  );
  const sortedNodePacks = Object.fromEntries(
    Object.entries(catalog.nodePacks ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, pack]) => [id, { manifest: pack.manifest }]),
  );
  const sortedIntegrations = Object.fromEntries(
    Object.entries(catalog.integrations ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([app, entry]) => [
        app,
        {
          manifest: entry.manifest,
          nodes: entry.nodes,
        },
      ]),
  );
  const canonicalPayload =
    Object.keys(sortedIntegrations).length > 0
      ? JSON.stringify({
          bricks: sortedBricks,
          nodePacks: sortedNodePacks,
          integrations: sortedIntegrations,
        })
      : JSON.stringify({ bricks: sortedBricks, nodePacks: sortedNodePacks });
  const catalogVersion = createHash("sha256").update(canonicalPayload).digest("hex");

  return {
    catalogVersion,
    bricks: sortedBricks,
    nodePacks: sortedNodePacks,
    integrations: sortedIntegrations,
  };
}

export function renderCatalogJson(catalog: Catalog): string {
  const normalized = buildSortedCatalog(catalog);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function renderStudioWebCatalogJson(catalog: Catalog): string {
  const normalized = buildSortedCatalog(catalog);
  const tiersPath = join(root, "evidence", "brick-tiers.json");
  let tiersData: {
    bricks?: Array<{
      id: string;
      derivedTier?: string;
      blockers?: string[];
      evidence?: unknown;
    }>;
    integrations?: Array<{
      id: string;
      derivedTier?: string;
      blockers?: string[];
      evidence?: unknown;
    }>;
  } | null = null;

  if (existsSync(tiersPath)) {
    try {
      tiersData = JSON.parse(readFileSync(tiersPath, "utf8"));
    } catch {
      // Ignore if unparseable
    }
  }

  const brickTiersMap = new Map(
    (tiersData?.bricks ?? []).map((b) => [b.id, b]),
  );
  const integrationTiersMap = new Map(
    (tiersData?.integrations ?? []).map((i) => [i.id, i]),
  );

  const bricks = Object.fromEntries(
    Object.entries(normalized.bricks).map(([id, entry]) => {
      const manifest = JSON.parse(JSON.stringify(entry.manifest));
      const tierInfo = brickTiersMap.get(id);
      if (tierInfo && manifest.ui) {
        if (tierInfo.derivedTier) manifest.ui.derivedTier = tierInfo.derivedTier;
        if (tierInfo.blockers) manifest.ui.blockers = tierInfo.blockers;
        if (tierInfo.evidence) manifest.ui.evidence = tierInfo.evidence;
      }
      return [id, manifest];
    }),
  );

  const integrations = Object.fromEntries(
    Object.entries(normalized.integrations ?? {}).map(([app, entry]) => {
      const manifest = JSON.parse(JSON.stringify(entry.manifest));
      const tierInfo = integrationTiersMap.get(app);
      if (tierInfo && manifest.ui) {
        if (tierInfo.derivedTier) manifest.ui.derivedTier = tierInfo.derivedTier;
        if (tierInfo.blockers) manifest.ui.blockers = tierInfo.blockers;
        if (tierInfo.evidence) manifest.ui.evidence = tierInfo.evidence;
      }
      return [app, { ...entry, manifest }];
    }),
  );

  return `${JSON.stringify(
    {
      catalogVersion: normalized.catalogVersion,
      bricks,
      nodePacks: normalized.nodePacks ?? {},
      integrations,
    },
    null,
    2,
  )}\n`;
}

function buildSortedCatalog(catalog: Catalog): Catalog {
  const sortedBricks = Object.fromEntries(
    Object.entries(catalog.bricks)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, brick]) => [
        id,
        {
          manifest: brick.manifest,
          files: Object.fromEntries(Object.entries(brick.files).sort(([a], [b]) => (a < b ? -1 : 1))),
        },
      ]),
  );
  const sortedNodePacks = Object.fromEntries(
    Object.entries(catalog.nodePacks ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, pack]) => [id, { manifest: pack.manifest }]),
  );
  const sortedIntegrations = Object.fromEntries(
    Object.entries(catalog.integrations ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([app, entry]) => [
        app,
        {
          manifest: entry.manifest,
          nodes: entry.nodes ?? projectIntegrationToNodes(entry.manifest),
        },
      ]),
  );
  const canonicalPayload =
    Object.keys(sortedIntegrations).length > 0
      ? JSON.stringify({
          bricks: sortedBricks,
          nodePacks: sortedNodePacks,
          integrations: sortedIntegrations,
        })
      : JSON.stringify({ bricks: sortedBricks, nodePacks: sortedNodePacks });
  const catalogVersion = catalog.catalogVersion ?? createHash("sha256").update(canonicalPayload).digest("hex");
  return {
    catalogVersion,
    bricks: sortedBricks,
    nodePacks: sortedNodePacks,
    integrations: sortedIntegrations,
  };
}

export function renderCatalogSource(catalog: Catalog): string {
  const sorted = buildSortedCatalog(catalog);
  return (
    "// Generated by scripts/build-catalog.ts from packages/*/brick.manifest.json. Do not edit; run `pnpm catalog:build`.\n" +
    'import type { Catalog } from "./src/schemas.ts";\n\n' +
    `export const catalog: Catalog = ${JSON.stringify(sorted, null, 2)};\n`
  );
}

if (import.meta.main) {
  const built = buildCatalog(root);
  const source = renderCatalogSource(built);
  writeFileSync(CATALOG_PATH, source);
  writeFileSync(CATALOG_JSON_PATH, renderCatalogJson(built));
  writeFileSync(STUDIO_WEB_CATALOG_JSON_PATH, renderStudioWebCatalogJson(built));
  console.log(
    `wrote ${CATALOG_PATH}, ${CATALOG_JSON_PATH}, and ${STUDIO_WEB_CATALOG_JSON_PATH} (catalogVersion=${built.catalogVersion}, bricks=${Object.keys(built.bricks).length}, nodePacks=${Object.keys(built.nodePacks ?? {}).length}, integrations=${Object.keys(built.integrations ?? {}).length})`,
  );
}
