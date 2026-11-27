import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const defaultRepoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const StoryProvenanceSchema = z.object({
  agent: z.string().min(1, "missing provenance.agent"),
  model: z.string().min(1, "missing provenance.model"),
  commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/i, "commit must be 7-40 hex chars")).min(1, "missing provenance.commits"),
  evidence: z.string().min(1, "missing provenance.evidence"),
});

export type StoryProvenance = z.infer<typeof StoryProvenanceSchema>;

export const StoryFrontMatterSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  parent: z.string().optional(),
  epic: z.union([z.number(), z.string()]).optional(),
  id: z.union([z.number(), z.string()]).optional(),
  status: z.string(),
  after: z.array(z.any()).optional(),
  covers: z.array(z.string()).optional(),
  provenance: StoryProvenanceSchema.optional(),
});

export type StoryFrontMatter = z.infer<typeof StoryFrontMatterSchema>;

export interface StoryValidationResult {
  file: string;
  valid: boolean;
  status?: string;
  grandfathered?: boolean;
  errors: string[];
}

function parseYamlScalar(val: string): any {
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseYamlScalar(s));
  }
  return trimmed;
}

export function parseStoryFrontMatter(content: string): { frontMatter: Record<string, any>; raw: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const raw = match[1];
  if (raw === undefined) return null;
  const lines = raw.split(/\r?\n/);
  const result: Record<string, any> = {};

  let currentKey: string | null = null;
  let currentObj: Record<string, any> | null = null;
  let currentArray: any[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Check indentation
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch && indentMatch[1] !== undefined ? indentMatch[1].length : 0;

    if (indent === 0) {
      // Top-level key
      currentKey = null;
      currentObj = null;
      currentArray = null;

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const afterColon = line.slice(colonIdx + 1).trim();

      if (afterColon.startsWith("{") && afterColon.endsWith("}")) {
        try {
          result[key] = JSON.parse(afterColon);
        } catch {
          result[key] = afterColon;
        }
      } else if (afterColon) {
        result[key] = parseYamlScalar(afterColon);
      } else {
        // Nested block
        currentKey = key;
        // Check next non-empty line to see if it's an array or object
        let nextLine: string | null = null;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (l !== undefined && l.trim() && !l.trim().startsWith("#")) {
            nextLine = l;
            break;
          }
        }
        if (nextLine && nextLine.trim().startsWith("-")) {
          currentArray = [];
          result[key] = currentArray;
        } else {
          currentObj = {};
          result[key] = currentObj;
        }
      }
    } else if (currentKey) {
      const trimmedLine = line.trim();
      if (currentArray && trimmedLine.startsWith("-")) {
        const itemVal = trimmedLine.slice(1).trim();
        currentArray.push(parseYamlScalar(itemVal));
      } else if (currentObj) {
        const colonIdx = trimmedLine.indexOf(":");
        if (colonIdx !== -1) {
          const subKey = trimmedLine.slice(0, colonIdx).trim();
          const subVal = trimmedLine.slice(colonIdx + 1).trim();
          if (!subVal) {
            // Nested array inside object (e.g. commits:\n  - sha)
            const subArray: any[] = [];
            currentObj[subKey] = subArray;
            while (i + 1 < lines.length) {
              const nextL = lines[i + 1];
              if (nextL === undefined || !nextL.trim().startsWith("-")) break;
              i++;
              subArray.push(parseYamlScalar(nextL.trim().slice(1).trim()));
            }
          } else {
            currentObj[subKey] = parseYamlScalar(subVal);
          }
        }
      }
    }
  }

  return { frontMatter: result, raw };
}

export function parseStoryFile(filePath: string): { frontMatter: Record<string, any>; raw: string } | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  return parseStoryFrontMatter(content);
}

export function loadLegacyStories(legacyPath: string = resolve(defaultRepoRoot, "scripts/story-gate.legacy.json")): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(legacyPath)) return map;
  try {
    const raw = readFileSync(legacyPath, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.path && item.reason) {
          map.set(item.path.replace(/\\/g, "/"), item.reason);
        }
      }
    }
  } catch {
    // If invalid JSON, empty map
  }
  return map;
}

export interface ValidateStoryOptions {
  repoRoot?: string;
  legacyMap?: Map<string, string>;
  targetRef?: string;
}

export function isNonCodePath(file: string): boolean {
  const normalized = file.trim().replace(/\\/g, "/");
  if (!normalized) return true;
  if (normalized.endsWith(".md")) return true;
  if (normalized.startsWith("_bmad-output/")) return true;
  if (normalized.startsWith("evidence/")) return true;
  if (normalized.startsWith("docs/")) return true;
  return false;
}

export function validateStoryFile(filePath: string, options: ValidateStoryOptions = {}): StoryValidationResult {
  const repoRoot = options.repoRoot || defaultRepoRoot;
  const legacyMap = options.legacyMap ?? loadLegacyStories(resolve(repoRoot, "scripts/story-gate.legacy.json"));
  const targetRef = options.targetRef || "HEAD";

  const normalizedPath = filePath.replace(/\\/g, "/");
  const relPath = normalizedPath.startsWith(repoRoot.replace(/\\/g, "/") + "/")
    ? normalizedPath.slice(repoRoot.replace(/\\/g, "/").length + 1)
    : normalizedPath;

  const errors: string[] = [];

  // Check grandfathered
  if (legacyMap.has(relPath)) {
    return {
      file: relPath,
      valid: true,
      status: "grandfathered",
      grandfathered: true,
      errors: [],
    };
  }

  if (!existsSync(filePath)) {
    return {
      file: relPath,
      valid: false,
      errors: [`STORY_GATE: ${relPath}: file does not exist`],
    };
  }

  const parsed = parseStoryFile(filePath);
  if (!parsed || !parsed.frontMatter) {
    return {
      file: relPath,
      valid: false,
      errors: [`STORY_GATE: ${relPath}: missing front matter`],
    };
  }

  const fm = parsed.frontMatter;
  const status = typeof fm.status === "string" ? fm.status.toLowerCase() : "";
  if (!status) {
    return {
      file: relPath,
      valid: false,
      errors: [`STORY_GATE: ${relPath}: missing status in front matter`],
    };
  }

  // Stories in todo or in-progress or blocked do not require provenance yet
  if (status !== "review" && status !== "done") {
    return {
      file: relPath,
      valid: true,
      status,
      errors: [],
    };
  }

  const prov = fm.provenance;
  if (!prov || typeof prov !== "object") {
    errors.push(`STORY_GATE: ${relPath}: missing provenance`);
    return { file: relPath, valid: false, status, errors };
  }

  if (!prov.agent || typeof prov.agent !== "string" || !prov.agent.trim()) {
    errors.push(`STORY_GATE: ${relPath}: missing provenance.agent`);
  }

  if (!prov.model || typeof prov.model !== "string" || !prov.model.trim()) {
    errors.push(`STORY_GATE: ${relPath}: missing provenance.model`);
  }

  if (!Array.isArray(prov.commits) || prov.commits.length === 0) {
    errors.push(`STORY_GATE: ${relPath}: missing provenance.commits`);
  }

  if (!prov.evidence || typeof prov.evidence !== "string" || !prov.evidence.trim()) {
    errors.push(`STORY_GATE: ${relPath}: missing provenance.evidence`);
  }

  if (errors.length > 0) {
    return { file: relPath, valid: false, status, errors };
  }

  // Validate commits exist in git and are ancestors of targetRef (default HEAD)
  const validCommits: string[] = [];
  for (const c of prov.commits) {
    const sha = String(c).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      errors.push(`STORY_GATE: ${relPath}: invalid commit sha format: ${sha}`);
      continue;
    }
    try {
      execSync(`git cat-file -e "${sha}^{commit}"`, {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      errors.push(`STORY_GATE: ${relPath}: commit ${sha} not found in git history`);
      continue;
    }

    try {
      execSync(`git merge-base --is-ancestor "${sha}" "${targetRef}"`, {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
      });
      validCommits.push(sha);
    } catch {
      errors.push(`STORY_GATE: ${relPath}: commit ${sha} is not an ancestor of ${targetRef}`);
    }
  }

  if (errors.length > 0) {
    return { file: relPath, valid: false, status, errors };
  }

  // For done stories, check code diff (must touch at least one code file outside non-code paths)
  if (status === "done") {
    let hasCodeDiff = false;
    for (const sha of validCommits) {
      try {
        const out = execSync(`git show --name-only --format= "${sha}"`, {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const changedFiles = out
          .split(/\r?\n/)
          .map((s) => s.trim().replace(/\\/g, "/"))
          .filter(Boolean);

        for (const file of changedFiles) {
          if (!isNonCodePath(file)) {
            hasCodeDiff = true;
            break;
          }
        }
        if (hasCodeDiff) break;
      } catch (err: any) {
        errors.push(`STORY_GATE: ${relPath}: failed to inspect commit ${sha}: ${err.message}`);
      }
    }

    if (!hasCodeDiff) {
      errors.push(`STORY_GATE: ${relPath}: done without code diff`);
    }
  }

  return {
    file: relPath,
    valid: errors.length === 0,
    status,
    errors,
  };
}

export function validateStoryGate(
  storyFiles: string[],
  options: ValidateStoryOptions = {},
): {
  total: number;
  grandfathered: number;
  passed: number;
  failed: number;
  results: StoryValidationResult[];
} {
  const results: StoryValidationResult[] = [];
  let grandfathered = 0;
  let passed = 0;
  let failed = 0;

  for (const file of storyFiles) {
    const res = validateStoryFile(file, options);
    results.push(res);
    if (res.grandfathered) {
      grandfathered++;
    } else if (res.valid) {
      passed++;
    } else {
      failed++;
    }
  }

  return {
    total: storyFiles.length,
    grandfathered,
    passed,
    failed,
    results,
  };
}

export interface TaskFileStory {
  id: string;
  title: string;
  status: string;
  provenance?: StoryProvenance;
  rawSection?: string;
}

export function parseTaskFileStories(markdown: string): TaskFileStory[] {
  const stories: TaskFileStory[] = [];
  const headingRegex = /^####\s+\[[\s\S]?\]\s+(UC\d+\.\d+)\s+[-—–]\s+(.*)$/gm;
  const matches = [...markdown.matchAll(headingRegex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!match || match.index === undefined) continue;
    const id = match[1] || "";
    const title = (match[2] || "").trim();
    const startIndex = match.index + match[0].length;
    const nextMatch = matches[i + 1];
    const endIndex = nextMatch && nextMatch.index !== undefined ? nextMatch.index : markdown.length;
    const sectionBody = markdown.slice(startIndex, endIndex);

    const statusMatch = sectionBody.match(/\*\*Status:\*\*\s*([a-zA-Z-]+)/);
    const status = statusMatch && statusMatch[1] ? statusMatch[1].toLowerCase() : "unknown";

    const provMatch = sectionBody.match(/<!--\s*provenance:\s*(\{[\s\S]*?\})\s*-->/);
    let provenance: StoryProvenance | undefined = undefined;
    if (provMatch && provMatch[1]) {
      try {
        provenance = JSON.parse(provMatch[1]);
      } catch {
        // If malformed JSON, keep undefined
      }
    }

    stories.push({
      id,
      title,
      status,
      provenance,
      rawSection: sectionBody,
    });
  }

  return stories;
}

export function commitBelongsToStory(subject: string, storyId: string): boolean {
  const trimmed = subject.trim();
  if (trimmed.startsWith(`${storyId}:`)) return true;
  if (trimmed.startsWith(`${storyId} rework`)) return true;
  return false;
}

export function validateTaskFileStory(story: TaskFileStory, options: ValidateStoryOptions = {}): StoryValidationResult {
  const repoRoot = options.repoRoot || defaultRepoRoot;
  const targetRef = options.targetRef || "HEAD";
  const errors: string[] = [];

  const status = story.status.toLowerCase();

  // Stories in todo or in-progress or blocked do not require provenance yet
  if (status !== "review" && status !== "done") {
    return {
      file: story.id,
      valid: true,
      status,
      errors: [],
    };
  }

  const prov = story.provenance;
  if (!prov || typeof prov !== "object") {
    errors.push(`STORY_GATE: ${story.id}: missing provenance`);
    return { file: story.id, valid: false, status, errors };
  }

  if (!prov.agent || typeof prov.agent !== "string" || !prov.agent.trim()) {
    errors.push(`STORY_GATE: ${story.id}: missing provenance.agent`);
  }

  if (!prov.model || typeof prov.model !== "string" || !prov.model.trim()) {
    errors.push(`STORY_GATE: ${story.id}: missing provenance.model`);
  }

  if (!Array.isArray(prov.commits) || prov.commits.length === 0) {
    errors.push(`STORY_GATE: ${story.id}: missing provenance.commits`);
  }

  if (errors.length > 0) {
    return { file: story.id, valid: false, status, errors };
  }

  // Validate commits exist in git, are ancestors of targetRef, and subject belongs to story
  const validCommits: string[] = [];
  for (const c of prov.commits) {
    const sha = String(c).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      errors.push(`STORY_GATE: ${story.id}: invalid commit sha format: ${sha}`);
      continue;
    }

    try {
      execSync(`git cat-file -e "${sha}^{commit}"`, {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      errors.push(`STORY_GATE: ${story.id}: commit ${sha} not found in git history`);
      continue;
    }

    try {
      execSync(`git merge-base --is-ancestor "${sha}" "${targetRef}"`, {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      errors.push(`STORY_GATE: ${story.id}: commit ${sha} is not an ancestor of ${targetRef}`);
      continue;
    }

    // Check commit subject
    try {
      const subject = execSync(`git log -1 --format=%s "${sha}"`, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

      if (!commitBelongsToStory(subject, story.id)) {
        errors.push(`STORY_GATE: ${story.id}: commit ${sha} does not belong to this story`);
        continue;
      }
    } catch (err: any) {
      errors.push(`STORY_GATE: ${story.id}: failed to inspect commit ${sha}: ${err.message}`);
      continue;
    }

    validCommits.push(sha);
  }

  if (errors.length > 0) {
    return { file: story.id, valid: false, status, errors };
  }

  // For done stories, check code diff
  if (status === "done") {
    let hasCodeDiff = false;
    for (const sha of validCommits) {
      try {
        const out = execSync(`git show --name-only --format= "${sha}"`, {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const changedFiles = out
          .split(/\r?\n/)
          .map((s) => s.trim().replace(/\\/g, "/"))
          .filter(Boolean);

        for (const file of changedFiles) {
          if (!isNonCodePath(file)) {
            hasCodeDiff = true;
            break;
          }
        }
        if (hasCodeDiff) break;
      } catch (err: any) {
        errors.push(`STORY_GATE: ${story.id}: failed to inspect commit ${sha}: ${err.message}`);
      }
    }

    if (!hasCodeDiff) {
      errors.push(`STORY_GATE: ${story.id}: done without code diff`);
    }
  }

  return {
    file: story.id,
    valid: errors.length === 0,
    status,
    errors,
  };
}

export function validateTaskFile(
  taskFilePath: string,
  options: ValidateStoryOptions = {},
): {
  total: number;
  checked: number;
  skipped: number;
  passed: number;
  failed: number;
  results: StoryValidationResult[];
} {
  const results: StoryValidationResult[] = [];
  if (!existsSync(taskFilePath)) {
    return {
      total: 0,
      checked: 0,
      skipped: 0,
      passed: 0,
      failed: 0,
      results,
    };
  }

  const content = readFileSync(taskFilePath, "utf8");
  const stories = parseTaskFileStories(content);

  let checked = 0;
  let skipped = 0;
  let passed = 0;
  let failed = 0;

  for (const story of stories) {
    const res = validateTaskFileStory(story, options);
    results.push(res);
    const s = story.status.toLowerCase();
    if (s === "review" || s === "done") {
      checked++;
      if (res.valid) {
        passed++;
      } else {
        failed++;
      }
    } else {
      skipped++;
    }
  }

  return {
    total: stories.length,
    checked,
    skipped,
    passed,
    failed,
    results,
  };
}
