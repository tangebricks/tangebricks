import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { sizeLimitReport } from "./bundle.ts";
import type { WorkerBundle } from "./bundle.ts";

// Turns the MCP endpoint (packages/mcp-server, with the brick catalog) into the one script that is uploaded as its own Worker
// (epic 5, story 9). Nothing is assembled here: the Worker assembles projects itself when a tool asks it to, which is what the
// story measures. The endpoint checks bearer tokens itself, so it does not use the project's access-key gate. Since story 0.15 there
// is no shared bearer: each token is bound to one project with fixed scopes, and the Worker reads the SHA-256 hashes of its
// tokens (never the tokens) from a secret binding.

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const slash = (path: string) => path.replace(/\\/g, "/");

/** The secret binding holding the hashed per-project token records; the endpoint's verifier reads it. */
export const MCP_TOKEN_BINDING = "MCP_TOKEN_RECORDS";

/** The scopes a measurement token carries: it builds projects, so it reads and edits; it never deploys or connects. */
export const MCP_MEASUREMENT_SCOPES = ["read", "edit"] as const;

/**
 * The secret text for MCP_TOKEN_BINDING: one record per project, each holding only the SHA-256 of its token. Tokens are bound to
 * one project each, so a token for one project is refused on any other.
 */
export function mcpTokenRecords(
  tokensByProject: Readonly<Record<string, string>>,
  userId = "mcp-measurement",
  scopes: readonly string[] = MCP_MEASUREMENT_SCOPES,
): string {
  return JSON.stringify(
    Object.entries(tokensByProject).map(([projectId, token]) => ({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      projectId,
      scopes: [...scopes],
      tokenId: `mcp-token:${projectId}`,
      clientName: "mcp-measurement",
    })),
  );
}
export const MCP_MIGRATION_NAME = "0001_mcp_server.sql";

export async function bundleMcpWorker(): Promise<Omit<WorkerBundle, "dynamicEvaluation">> {
  const server = JSON.stringify(slash(join(repoRoot, "packages", "mcp-server", "src", "index.ts")));
  const catalog = JSON.stringify(slash(join(repoRoot, "packages", "assembler", "catalog.generated.ts")));
  const entry = [
    `import { createHashedTokenVerifier, createMcpApp } from ${server};`,
    `import { catalog } from ${catalog};`,
    `const app = createMcpApp({ catalog, verifyToken: createHashedTokenVerifier(${JSON.stringify(MCP_TOKEN_BINDING)}) });`,
    `export default { fetch: (request, env, ctx) => app.fetch(request, env, ctx) };`,
  ].join("\n");
  const result = await build({
    stdin: { contents: entry, resolveDir: repoRoot, sourcefile: "mcp-entry.ts", loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*"],
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  });
  const code = result.outputFiles[0]!.text;
  const bytes = Buffer.byteLength(code, "utf8");
  return {
    code,
    bytes,
    gzipBytes: gzipSync(code).length,
    sha256: createHash("sha256").update(code).digest("hex"),
    inputs: Object.keys(result.metafile!.inputs).length,
    warnings: result.warnings.map((w) => w.text),
    limit: sizeLimitReport(bytes),
  };
}

/** The endpoint's one migration, as the deploy tool applies it. */
export function mcpMigration(): { name: string; sql: string } {
  return { name: MCP_MIGRATION_NAME, sql: readFileSync(join(repoRoot, "packages", "mcp-server", "migrations", MCP_MIGRATION_NAME), "utf8") };
}
