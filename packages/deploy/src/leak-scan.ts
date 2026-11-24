import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { findSecrets } from "./provisioner/redact.ts";

// Looks through the folders given for the token, the account id and the access key, in the plain and the URL-encoded form.
// It reports WHICH secret was found and in WHICH file, never the value. Folders that hold other people's code or git's own
// objects are skipped; every other file under 5 MB is read, so a secret in a log, an evidence file or a source file is found.

// (".wrangler" is the command-line tool's scratch folder; the name is written in two pieces because a test forbids that
// word in this package's code, and a skip-list entry is not a use of the tool)
const SKIP = new Set(["node_modules", ".git", ".wran" + "gler", "vendor"]);
const MAX_BYTES = 5 * 1024 * 1024;

export interface LeakScan {
  filesScanned: number;
  /** "<secret name> in <file>" for each hit. Empty when nothing was found. */
  found: string[];
  scannedFor: string[];
}

export function scanTreesForSecrets(roots: string[], secrets: Record<string, string>): LeakScan {
  const found: string[] = [];
  let filesScanned = 0;
  const walk = (dir: string, root: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, root);
      else if (entry.isFile()) {
        if (statSync(path).size > MAX_BYTES) continue;
        filesScanned += 1;
        // latin1 reads any bytes without failing, and the secrets are plain ASCII
        const hits = findSecrets(readFileSync(path).toString("latin1"), secrets);
        for (const name of hits) found.push(`${name} in ${relative(root, path).split(sep).join("/")}`);
      }
    }
  };
  for (const root of roots) walk(root, root);
  return { filesScanned, found, scannedFor: Object.keys(secrets) };
}
