// The denominator of the token budget's Session A (story 7.4) and of H9: the first-party source of the three bricks the
// scored session builds (multi-workspace, credit-wallet, dynamic-entities) plus the files a direct assembly of the
// invoices project emits, counted with the one tokenizer (test/support/tokens.ts). Node only: it reads the bricks from
// disk. `pnpm mcp:budget` calls it directly; the workerd tests read the value the global setup writes to
// out/h9-emitted-source.json (a workerd test cannot read the bricks' source).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "../../packages/assembler/src/index.ts";
import { catalog } from "../../packages/assembler/catalog.generated.ts";
import { H9_INVOICES_ENTITY } from "../../packages/mcp-server/src/token-budget.ts";
import { INVOICE_FLOW_BLUEPRINT } from "./blueprints.ts";
import { firstPartySource } from "./tokens.ts";

export const H9_SOURCE_BRICK_DIRS = ["bricks/multi-workspace", "bricks/credit-wallet", "bricks/dynamic-entities"] as const;

/** The token count of the H9 3-brick project's first-party source and generated files, as `pnpm mcp:budget` measures it. */
export function measureH9EmittedSourceTokens(root?: string): number {
  const direct = assemble({ ...INVOICE_FLOW_BLUEPRINT, entities: [H9_INVOICES_ENTITY] }, catalog);
  if (!direct.ok) throw new Error(`Direct assembly failed: ${direct.errors.join("; ")}`);
  return firstPartySource({ packageDirs: [...H9_SOURCE_BRICK_DIRS], generated: direct.files, ...(root ? { root } : {}) }).total;
}

/** Written by the workerd global setup; read by the workerd token-budget tests. */
export const H9_EMITTED_SOURCE_FILE = "h9-emitted-source.json";

export function writeH9EmittedSource(outDir: string): number {
  const tokens = measureH9EmittedSourceTokens();
  writeFileSync(join(outDir, H9_EMITTED_SOURCE_FILE), JSON.stringify({ tokens }, null, 2) + "\n");
  return tokens;
}
