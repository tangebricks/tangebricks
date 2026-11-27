import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseTaskFileStories, validateStoryFile, validateTaskFileStory } from "../lib/story-provenance.ts";
import { buildStoryGateRepo, type StoryGateRepo } from "./support/story-gate-repo.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = resolve(repoRoot, "scripts/test/fixtures/story-gate");
const legacyStoriesPath = resolve(repoRoot, "scripts/story-gate.legacy.json");
const checkStoryGateScript = resolve(repoRoot, "scripts/check-story-gate.ts");

// Fixtures cite stand-in SHAs; this throwaway repository holds real commits for them.
let gate: StoryGateRepo;
beforeAll(() => {
  gate = buildStoryGateRepo(fixturesDir);
});

describe("UC0.4 story provenance front matter and story gate", () => {
  it("fixture (a): status done with no provenance fails gate", () => {
    const file = resolve(gate.fixtures, "story-a-no-provenance.md");
    const result = validateStoryFile(file, { repoRoot: gate.root });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /STORY_GATE:.*missing provenance/i.test(e))).toBe(true);
  });

  it("fixture (b): AC1 — status done with only markdown changes fails with 'done without code diff'", () => {
    const file = resolve(gate.fixtures, "story-b-md-only.md");
    const result = validateStoryFile(file, { repoRoot: gate.root });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /STORY_GATE:.*done without code diff/.test(e))).toBe(true);
  });

  it("fixture (c): status done with non-existent SHA fails gate", () => {
    const file = resolve(gate.fixtures, "story-c-bad-sha.md");
    const result = validateStoryFile(file, { repoRoot: gate.root });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /STORY_GATE:.*(commit|sha).*not found/i.test(e))).toBe(true);
  });

  it("fixture (d): valid story with real code diff passes gate", () => {
    const file = resolve(gate.fixtures, "story-d-valid.md");
    const result = validateStoryFile(file, { repoRoot: gate.root });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fixture (e): AC2 — review or done story missing provenance.model fails with 'missing provenance.model'", () => {
    const file = resolve(gate.fixtures, "story-e-missing-model.md");
    const result = validateStoryFile(file, { repoRoot: gate.root });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /STORY_GATE:.*missing provenance\.model/.test(e))).toBe(true);
  });

  it("fixture (f): status done with only evidence changes fails with 'done without code diff'", () => {
    const file = resolve(gate.fixtures, "story-f-evidence-only.md");
    const result = validateStoryFile(file, { repoRoot: gate.root });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /STORY_GATE:.*done without code diff/.test(e))).toBe(true);
  });

  it("fixture (g): status done with commit not an ancestor of HEAD fails gate", () => {
    const file = resolve(gate.fixtures, "story-g-non-ancestor-sha.md");
    const result = validateStoryFile(file, { repoRoot: gate.root });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /STORY_GATE:.*not an ancestor of/i.test(e))).toBe(true);
  });

  it("legacy stories: grandfathered stories are skipped, audited, and protected against additions", () => {
    expect(existsSync(legacyStoriesPath), "scripts/story-gate.legacy.json must exist").toBe(true);
    const raw = readFileSync(legacyStoriesPath, "utf8");
    const legacy = JSON.parse(raw);

    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy.length).toBe(77);

    for (const entry of legacy) {
      expect(entry.path).toBeDefined();
      expect(entry.reason).toBe("pre-provenance (CP0–CP10), audited in UC0.4");
      // The grandfathered stories live in the private planning folder, which is not part of the public
      // repository. Check they exist only where that folder is present.
      if (existsSync(resolve(repoRoot, "_bmad-output"))) {
        expect(existsSync(resolve(repoRoot, entry.path)), `Legacy story must exist on disk: ${entry.path}`).toBe(true);
      }
    }

    // Verify hash protection against unauthorized additions to legacy list
    const computedHash = createHash("sha256").update(raw.trim()).digest("hex");
    expect(computedHash).toBe("b2beed4a4254842d57a5ad645947ee7b0ff0bb8eaa7fa8cf3b6b3dffefc17a6d");
  });

  it("AC3: story gate CLI passes against the repository and reports grandfathered in summary", { timeout: 180000 }, () => {
    const res = spawnSync("node", [checkStoryGateScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const combined = `${res.stdout}\n${res.stderr}`;
    expect(res.status, `CLI failed with output:\n${combined}`).toBe(0);
    expect(combined).toMatch(/grandfathered/i);
  });
});

describe("UC0.8 story gate covers task file and ties provenance commits to story", () => {
  const taskFileFixturePath = () => resolve(gate.fixtures, "taskfile-fixture.md");

  it("parseTaskFileStories parses stories with status and provenance comments", () => {
    const raw = readFileSync(taskFileFixturePath(), "utf8");
    const stories = parseTaskFileStories(raw);
    expect(stories.length).toBe(7);
    const s0 = stories[0]!;
    expect(s0.id).toBe("UC9.1");
    expect(s0.status).toBe("done");
    expect(s0.provenance).toBeUndefined();

    const s1 = stories[1]!;
    expect(s1.id).toBe("UC0.4");
    expect(s1.status).toBe("done");
    expect(s1.provenance?.agent).toBe("Amelia (Dev)");
    expect(s1.provenance?.commits).toHaveLength(1);
    expect(s1.provenance?.commits?.[0]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("case (a) & AC1: status done with no provenance comment fails gate", () => {
    const raw = readFileSync(taskFileFixturePath(), "utf8");
    const stories = parseTaskFileStories(raw);
    const storyA = stories.find((s) => s.id === "UC9.1" && s.title.includes("Case A"))!;
    const res = validateTaskFileStory(storyA, { repoRoot: gate.root });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /STORY_GATE:\s*UC9\.1:\s*missing provenance$/i.test(e))).toBe(true);
  });

  it("case (b) & AC3: status done with commits touching only markdown fails with 'done without code diff'", () => {
    const raw = readFileSync(taskFileFixturePath(), "utf8");
    const stories = parseTaskFileStories(raw);
    const storyB = stories.find((s) => s.id === "UC0.4" && s.title.includes("Case B"))!;
    const res = validateTaskFileStory(storyB, { repoRoot: gate.root });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /STORY_GATE:\s*UC0\.4:\s*done without code diff/i.test(e))).toBe(true);
  });

  it("case (c) & AC2: status done citing commit not belonging to story fails", () => {
    const raw = readFileSync(taskFileFixturePath(), "utf8");
    const stories = parseTaskFileStories(raw);
    const storyC = stories.find((s) => s.id === "UC9.1" && s.title.includes("Case C"))!;
    const res = validateTaskFileStory(storyC, { repoRoot: gate.root });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /STORY_GATE:\s*UC9\.1:\s*commit [0-9a-f]{40} does not belong to this story/i.test(e))).toBe(true);
  });

  it("case (d) & AC1: review status with provenance missing model fails gate", () => {
    const raw = readFileSync(taskFileFixturePath(), "utf8");
    const stories = parseTaskFileStories(raw);
    const storyD = stories.find((s) => s.id === "UC9.2" && s.title.includes("Case D"))!;
    const res = validateTaskFileStory(storyD, { repoRoot: gate.root });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /STORY_GATE:\s*UC9\.2:\s*missing provenance\.model/i.test(e))).toBe(true);
  });

  it("case (e): valid done story passes gate", () => {
    const raw = readFileSync(taskFileFixturePath(), "utf8");
    const stories = parseTaskFileStories(raw);
    const storyE = stories.find((s) => s.id === "UC0.1" && s.title.includes("Case E"))!;
    const res = validateTaskFileStory(storyE, { repoRoot: gate.root });
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("case (f): todo and in-progress stories are skipped", () => {
    const raw = readFileSync(taskFileFixturePath(), "utf8");
    const stories = parseTaskFileStories(raw);
    const storyTodo = stories.find((s) => s.id === "UC9.3")!;
    const storyInProgress = stories.find((s) => s.id === "UC9.4")!;

    const resTodo = validateTaskFileStory(storyTodo, { repoRoot: gate.root });
    expect(resTodo.valid).toBe(true);
    expect(resTodo.errors).toEqual([]);

    const resProg = validateTaskFileStory(storyInProgress, { repoRoot: gate.root });
    expect(resProg.valid).toBe(true);
    expect(resProg.errors).toEqual([]);
  });

  it("AC4: CLI skips the task file when it is absent and says so", { timeout: 180000 }, () => {
    // The central task file was retired when the repository went public.
    expect(existsSync(resolve(repoRoot, "UPDATIONS-BY-CLAUDE-TASKS.md"))).toBe(false);
    const res = spawnSync("node", [checkStoryGateScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const combined = `${res.stdout}\n${res.stderr}`;
    expect(res.status, `CLI failed with output:\n${combined}`).toBe(0);
    expect(combined).toMatch(/task file:\s*skipped \(file absent\)/i);
  });

  it("AC5: mutation check - removing UC0.1 provenance makes gate fail naming UC0.1", () => {
    const content = [
      "#### [ ] UC0.1 — Evidence stamp helper",
      "**Status:** done · **Size:** M",
      '<!-- provenance: { "agent": "Amelia (Dev)", "model": "test-model", "commits": ["c8e8a9c"] } -->',
      "",
    ].join("\n");
    const mutated = content.replace(/<!--\s*provenance:[\s\S]*?-->/, "<!-- provenance removed -->");

    const stories = parseTaskFileStories(mutated);
    const uc01 = stories.find((s) => s.id === "UC0.1")!;
    const res = validateTaskFileStory(uc01, { repoRoot: gate.root });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /STORY_GATE:\s*UC0\.1:\s*missing provenance/i.test(e))).toBe(true);
  });
});
