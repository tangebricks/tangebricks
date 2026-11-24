import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const manifestPath = resolve(repoRoot, "corpus/real-specs/manifest.json");
const fetchScript = resolve(repoRoot, "scripts/fetch-real-specs.ts");
const packageJsonPath = resolve(repoRoot, "package.json");

describe("UC0.5 real-spec fidelity corpus", () => {
  it("manifest.json exists and has valid schema for all 8 specs", () => {
    expect(existsSync(manifestPath), `Expected ${manifestPath} to exist`).toBe(true);

    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    const specs = Array.isArray(manifest) ? manifest : manifest.specs;
    expect(Array.isArray(specs)).toBe(true);
    expect(specs.length).toBe(8);

    const expectedIds = [
      "stripe",
      "github",
      "discord",
      "slack",
      "google-calendar",
      "google-gmail",
      "google-drive",
      "google-sheets",
    ];

    const allowedFormats = new Set(["openapi3", "swagger2", "google-discovery"]);
    const foundIds = specs.map((s: { id: string }) => s.id);
    expect(foundIds.sort()).toEqual(expectedIds.sort());

    for (const entry of specs) {
      expect(typeof entry.id).toBe("string");
      expect(allowedFormats.has(entry.format)).toBe(true);
      expect(typeof entry.url).toBe("string");
      expect(entry.url).toMatch(/^https?:\/\//);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof entry.bytes).toBe("number");
      expect(entry.bytes).toBeGreaterThan(0);
      expect(Number.isInteger(entry.bytes)).toBe(true);
    }
  });

  it("AC3: No upstream URL in the manifest refers to a branch name", () => {
    expect(existsSync(manifestPath)).toBe(true);
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    const specs = Array.isArray(manifest) ? manifest : manifest.specs;

    for (const entry of specs) {
      if (entry.url.includes("raw.githubusercontent.com")) {
        const match = entry.url.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([0-9a-f]{40})\//);
        expect(
          match,
          `URL for ${entry.id} (${entry.url}) must pin a 40-hex commit, not a branch or tag`
        ).not.toBeNull();
      }
    }
  });

  it("package.json registers fidelity:fetch script", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    expect(pkg.scripts?.["fidelity:fetch"]).toBe("node scripts/fetch-real-specs.ts");
  });

  it("AC2: Changing one byte in a cached file causes CORPUS_HASH_MISMATCH: <id> and exit 1", () => {
    expect(existsSync(fetchScript), `Expected ${fetchScript} to exist`).toBe(true);

    const tempDir = mkdtempSync(join(tmpdir(), "corpus-test-tamper-"));
    try {
      const manifestCopy = join(tempDir, "manifest.json");
      const cacheDir = join(tempDir, ".cache");
      mkdirSync(cacheDir, { recursive: true });

      // Create a dummy manifest with one entry
      const dummySpec = {
        id: "dummy-spec",
        format: "openapi3",
        url: "https://example.com/dummy.json",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // hash of empty string
        bytes: 0,
      };
      writeFileSync(manifestCopy, JSON.stringify({ specs: [dummySpec] }));

      // Create tampered cached file (1 byte)
      writeFileSync(join(cacheDir, "dummy-spec.json"), "x");

      const proc = spawnSync(process.execPath, [fetchScript, "--manifest", manifestCopy, "--cache-dir", cacheDir], {
        encoding: "utf8",
        env: { ...process.env, CORPUS_MANIFEST_PATH: manifestCopy, CORPUS_CACHE_DIR: cacheDir },
      });

      expect(proc.status).toBe(1);
      const combined = (proc.stdout || "") + (proc.stderr || "");
      expect(combined).toContain("CORPUS_HASH_MISMATCH: dummy-spec");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tampered sha256 in manifest causes fetch to fail with CORPUS_HASH_MISMATCH", () => {
    expect(existsSync(fetchScript), `Expected ${fetchScript} to exist`).toBe(true);

    const tempDir = mkdtempSync(join(tmpdir(), "corpus-test-mismatch-"));
    try {
      const manifestCopy = join(tempDir, "manifest.json");
      const cacheDir = join(tempDir, ".cache");
      mkdirSync(cacheDir, { recursive: true });

      // Create dummy manifest with wrong sha256
      const dummySpec = {
        id: "tampered-spec",
        format: "openapi3",
        url: "https://raw.githubusercontent.com/discord/discord-api-spec/4e75626a4cedfbc397d66f5491c79a9a62a71fd5/specs/openapi.json",
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        bytes: 1204742,
      };
      writeFileSync(manifestCopy, JSON.stringify({ specs: [dummySpec] }));

      const proc = spawnSync(process.execPath, [fetchScript, "--manifest", manifestCopy, "--cache-dir", cacheDir], {
        encoding: "utf8",
        env: { ...process.env, CORPUS_MANIFEST_PATH: manifestCopy, CORPUS_CACHE_DIR: cacheDir },
      });

      expect(proc.status).toBe(1);
      const combined = (proc.stdout || "") + (proc.stderr || "");
      expect(combined).toContain("CORPUS_HASH_MISMATCH: tampered-spec");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("AC1: fetch produces 8 valid spec files, and second run downloads nothing (8 cached, 0 fetched)", () => {
    expect(existsSync(fetchScript), `Expected ${fetchScript} to exist`).toBe(true);

    const tempDir = mkdtempSync(join(tmpdir(), "corpus-test-ac1-"));
    try {
      const cacheDir = join(tempDir, ".cache");

      // First run: clean cache -> should fetch 8 specs
      const firstRun = spawnSync(process.execPath, [fetchScript, "--cache-dir", cacheDir], {
        encoding: "utf8",
        cwd: repoRoot,
        env: { ...process.env, CORPUS_CACHE_DIR: cacheDir },
      });

      expect(firstRun.status).toBe(0);
      const firstOut = (firstRun.stdout || "") + (firstRun.stderr || "");
      expect(firstOut).toContain("0 cached, 8 fetched");

      // Verify that all 8 spec files exist in cache and match manifest
      const raw = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(raw);
      const specs = Array.isArray(manifest) ? manifest : manifest.specs;

      for (const entry of specs) {
        const cachedPath = join(cacheDir, `${entry.id}.json`);
        expect(existsSync(cachedPath), `Expected ${cachedPath} to exist`).toBe(true);
        const buf = readFileSync(cachedPath);
        expect(buf.length).toBe(entry.bytes);
      }

      // Second run: idempotent -> should report 8 cached, 0 fetched
      const secondRun = spawnSync(process.execPath, [fetchScript, "--cache-dir", cacheDir], {
        encoding: "utf8",
        cwd: repoRoot,
        env: { ...process.env, CORPUS_CACHE_DIR: cacheDir },
      });

      expect(secondRun.status).toBe(0);
      const secondOut = (secondRun.stdout || "") + (secondRun.stderr || "");
      expect(secondOut).toContain("8 cached, 0 fetched");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("supports --update <id> flag to re-pin a spec and print old and new hashes", () => {
    expect(existsSync(fetchScript), `Expected ${fetchScript} to exist`).toBe(true);

    const tempDir = mkdtempSync(join(tmpdir(), "corpus-test-update-"));
    try {
      const manifestCopy = join(tempDir, "manifest.json");
      const cacheDir = join(tempDir, ".cache");
      const raw = readFileSync(manifestPath, "utf8");
      writeFileSync(manifestCopy, raw);

      const proc = spawnSync(
        process.execPath,
        [fetchScript, "--manifest", manifestCopy, "--cache-dir", cacheDir, "--update", "google-calendar"],
        {
          encoding: "utf8",
          cwd: repoRoot,
          env: { ...process.env, CORPUS_MANIFEST_PATH: manifestCopy, CORPUS_CACHE_DIR: cacheDir },
        }
      );

      expect(proc.status).toBe(0);
      const combined = (proc.stdout || "") + (proc.stderr || "");
      expect(combined).toContain("Re-pinning spec: google-calendar");
      expect(combined).toContain("Old sha256:");
      expect(combined).toContain("New sha256:");
      expect(combined).toContain("Successfully re-pinned google-calendar.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
