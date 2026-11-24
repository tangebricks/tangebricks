// pnpm evidence:record-live (story 0.12, R54): records genuine live re-runs in evidence/deployed/integrity.json.
//
// Run it after a live command (poc:deploy, poc:graphs, poc:h5-hosted, poc:deploy:mcp, ...) has written a new
// evidence/deployed/*-result.json. A file with a new, later run timestamp gets a fresh sha256 entry. A file whose bytes
// changed while its run timestamp did not is refused: that is an edit, not a run. Then run `pnpm readme:generate`.
//
// Usage: node scripts/record-live-evidence.ts [--root <dir>]
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INTEGRITY_REL, recordLiveIntegrity } from "./lib/live-evidence.ts";

const repoRoot = resolve(import.meta.dirname, "..");

export function runRecordLiveCli(argv: string[] = process.argv.slice(2)): number {
  let targetRoot = repoRoot;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      targetRoot = resolve(argv[i + 1]!);
      i += 1;
    }
  }
  const res = recordLiveIntegrity(targetRoot);
  if (!res.ok) {
    console.error(`evidence:record-live FAILED; ${INTEGRITY_REL} was not changed:`);
    for (const e of res.errors) console.error(`  - ${e}`);
    return 1;
  }
  if (res.recorded.length === 0) {
    console.log(`evidence:record-live: no new live runs; ${INTEGRITY_REL} unchanged.`);
  } else {
    console.log(`evidence:record-live: recorded ${res.recorded.length} live run(s) in ${INTEGRITY_REL}:`);
    for (const r of res.recorded) console.log(`  - ${r}`);
    console.log("Now run pnpm readme:generate so the README shows the new run dates.");
  }
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.exit(runRecordLiveCli());
}
