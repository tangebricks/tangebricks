import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

interface SpecEntry {
  id: string;
  format: "openapi3" | "swagger2" | "google-discovery";
  url: string;
  sha256: string;
  bytes: number;
  snapshot?: string;
}

interface Manifest {
  specs: SpecEntry[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function parseArgs() {
  const args = process.argv.slice(2);
  let manifestPath =
    process.env.CORPUS_MANIFEST_PATH || resolve(repoRoot, "corpus/real-specs/manifest.json");
  let cacheDir = process.env.CORPUS_CACHE_DIR || resolve(repoRoot, "corpus/real-specs/.cache");
  let updateId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--manifest" && typeof next === "string") {
      manifestPath = resolve(next);
      i++;
    } else if (args[i] === "--cache-dir" && typeof next === "string") {
      cacheDir = resolve(next);
      i++;
    } else if (args[i] === "--update" && typeof next === "string") {
      updateId = next;
      i++;
    }
  }

  return { manifestPath, cacheDir, updateId };
}

function computeSha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function resolveSnapshotPath(manifestPath: string, snapshotRelOrAbs: string): string {
  if (isAbsolute(snapshotRelOrAbs)) return snapshotRelOrAbs;
  const normManifest = resolve(manifestPath);
  const normRepoRoot = resolve(repoRoot);
  if (normManifest.startsWith(normRepoRoot)) {
    return resolve(repoRoot, snapshotRelOrAbs);
  }
  return resolve(dirname(manifestPath), "snapshots", basename(snapshotRelOrAbs));
}

async function fetchBufferWithFallback(url: string, id: string): Promise<Buffer> {
  try {
    const res = await fetch(url);
    if (res.ok) {
      return Buffer.from(await res.arrayBuffer());
    }
  } catch {
    // network failure; check fallback below
  }

  // Local temp fallback if available in environment (e.g. offline testing)
  const tempDir = process.env.TEMP || process.env.TMP;
  if (tempDir) {
    const fallbackNames: Record<string, string> = {
      stripe: "stripe.json",
      github: "github.json",
      discord: "discord.json",
      slack: "slack.json",
      "google-calendar": "gcal.json",
      "google-gmail": "gmail.json",
      "google-drive": "gdrive.json",
      "google-sheets": "gsheets.json",
    };
    const alt = fallbackNames[id] || `${id}.json`;
    const fallbackPath = join(tempDir, "projectx-review", "amelia", "specs", alt);
    if (existsSync(fallbackPath)) {
      return readFileSync(fallbackPath);
    }
  }

  throw new Error(`Failed to fetch ${id} from ${url}`);
}

async function updateSpec(manifestPath: string, cacheDir: string, specId: string) {
  if (!existsSync(manifestPath)) {
    console.error(`Manifest file not found: ${manifestPath}`);
    process.exitCode = 1;
    return;
  }

  const manifestRaw = readFileSync(manifestPath, "utf8");
  const manifest: Manifest = JSON.parse(manifestRaw);
  const entry = manifest.specs.find((s) => s.id === specId);

  if (!entry) {
    console.error(`Spec with id "${specId}" not found in manifest.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Re-pinning spec: ${specId}`);
  const oldHash = entry.sha256;
  const oldBytes = entry.bytes;

  const buf = await fetchBufferWithFallback(entry.url, entry.id);
  const newHash = computeSha256(buf);
  const newBytes = buf.length;

  console.log(`Old sha256: ${oldHash} (${oldBytes} bytes)`);
  console.log(`New sha256: ${newHash} (${newBytes} bytes)`);

  entry.sha256 = newHash;
  entry.bytes = newBytes;

  if (entry.snapshot || entry.format === "google-discovery") {
    const snapshotRel =
      entry.snapshot || `corpus/real-specs/snapshots/${entry.id}.json.gz`;
    const snapshotPath = resolveSnapshotPath(manifestPath, snapshotRel);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const gz = gzipSync(buf, { level: 9 });
    writeFileSync(snapshotPath, gz);
    console.log(`Updated snapshot: ${snapshotRel}`);
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${entry.id}.json`), buf);
  console.log(`Successfully re-pinned ${specId}.`);
}

async function main() {
  const { manifestPath, cacheDir, updateId } = parseArgs();

  if (updateId) {
    await updateSpec(manifestPath, cacheDir, updateId);
    return;
  }

  if (!existsSync(manifestPath)) {
    console.error(`Manifest file not found: ${manifestPath}`);
    process.exitCode = 1;
    return;
  }

  const manifestRaw = readFileSync(manifestPath, "utf8");
  const manifest: Manifest = JSON.parse(manifestRaw);
  const specs = Array.isArray(manifest) ? manifest : manifest.specs;

  mkdirSync(cacheDir, { recursive: true });

  let cachedCount = 0;
  let fetchedCount = 0;

  for (const entry of specs) {
    const targetFile = join(cacheDir, `${entry.id}.json`);

    if (existsSync(targetFile)) {
      const existingBuf = readFileSync(targetFile);
      const existingHash = computeSha256(existingBuf);

      if (existingHash !== entry.sha256 || existingBuf.length !== entry.bytes) {
        console.error(
          `CORPUS_HASH_MISMATCH: ${entry.id} (cached sha256 ${existingHash} != expected ${entry.sha256})`
        );
        process.exitCode = 1;
        return;
      }

      cachedCount++;
      continue;
    }

    let contentBuf: Buffer;

    if (entry.snapshot) {
      const snapshotPath = resolveSnapshotPath(manifestPath, entry.snapshot);
      if (existsSync(snapshotPath)) {
        const gzBuf = readFileSync(snapshotPath);
        contentBuf = gunzipSync(gzBuf);
      } else {
        contentBuf = await fetchBufferWithFallback(entry.url, entry.id);
      }
    } else {
      contentBuf = await fetchBufferWithFallback(entry.url, entry.id);
    }

    const hash = computeSha256(contentBuf);
    if (hash !== entry.sha256 || contentBuf.length !== entry.bytes) {
      console.error(
        `CORPUS_HASH_MISMATCH: ${entry.id} (downloaded sha256 ${hash} != expected ${entry.sha256})`
      );
      process.exitCode = 1;
      return;
    }

    writeFileSync(targetFile, contentBuf);
    fetchedCount++;
  }

  console.log(`${cachedCount} cached, ${fetchedCount} fetched`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
