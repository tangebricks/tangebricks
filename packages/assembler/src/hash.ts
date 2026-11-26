export const DEFAULT_CATALOG_VERSION = "1.0.0";

/** Synchronous pure-JS SHA-256 (no node:crypto, works in workerd, browser and node). Returns lowercase 64-character hex. */
export function sha256Sync(ascii: string): string {
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let i: number;
  let result = "";
  const words: number[] = [];
  const hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;
  const isComposite: Record<number, number> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = candidate * candidate; i < 312; i += candidate) isComposite[i] = candidate;
      if (primeCounter < 8) hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      primeCounter++;
    }
  }
  const utf8: number[] = [];
  for (let idx = 0; idx < ascii.length; idx++) {
    const charcode = ascii.charCodeAt(idx);
    if (charcode < 0x80) utf8.push(charcode);
    else if (charcode < 0x800) {
      utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
    } else if (charcode < 0xd800 || charcode >= 0xe000) {
      utf8.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
    } else {
      idx++;
      const nextChar = ascii.charCodeAt(idx);
      const code = 0x10000 + (((charcode & 0x3ff) << 10) | (nextChar & 0x3ff));
      utf8.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  const bitLength = utf8.length * 8;
  utf8.push(0x80);
  while ((utf8.length % 64) !== 56) utf8.push(0);
  for (let b = 7; b >= 0; b--) {
    utf8.push((b >= 4 ? 0 : (bitLength >>> (b * 8))) & 0xff);
  }
  for (i = 0; i < utf8.length; i += 4) {
    words.push(((utf8[i] ?? 0) << 24) | ((utf8[i + 1] ?? 0) << 16) | ((utf8[i + 2] ?? 0) << 8) | (utf8[i + 3] ?? 0));
  }
  const w: number[] = Array.from({ length: 64 }, () => 0);
  for (i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[i + t] ?? 0;
    for (let t = 16; t < 64; t++) {
      const wt15 = w[t - 15] ?? 0;
      const wt2 = w[t - 2] ?? 0;
      const wt16 = w[t - 16] ?? 0;
      const wt7 = w[t - 7] ?? 0;
      const s0 = ((wt15 >>> 7) | (wt15 << 25)) ^ ((wt15 >>> 18) | (wt15 << 14)) ^ (wt15 >>> 3);
      const s1 = ((wt2 >>> 17) | (wt2 << 15)) ^ ((wt2 >>> 19) | (wt2 << 13)) ^ (wt2 >>> 10);
      w[t] = (((wt16 + s0) | 0) + ((wt7 + s1) | 0)) | 0;
    }
    let a = hash[0] ?? 0;
    let b = hash[1] ?? 0;
    let c = hash[2] ?? 0;
    let d = hash[3] ?? 0;
    let e = hash[4] ?? 0;
    let f = hash[5] ?? 0;
    let g = hash[6] ?? 0;
    let h = hash[7] ?? 0;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (((h + S1) | 0) + (((ch + (k[t] ?? 0)) | 0) + (w[t] ?? 0)) | 0) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) | 0;
    hash[1] = ((hash[1] ?? 0) + b) | 0;
    hash[2] = ((hash[2] ?? 0) + c) | 0;
    hash[3] = ((hash[3] ?? 0) + d) | 0;
    hash[4] = ((hash[4] ?? 0) + e) | 0;
    hash[5] = ((hash[5] ?? 0) + f) | 0;
    hash[6] = ((hash[6] ?? 0) + g) | 0;
    hash[7] = ((hash[7] ?? 0) + h) | 0;
  }
  for (i = 0; i < 8; i++) {
    result += ((hash[i] ?? 0) >>> 0).toString(16).padStart(8, "0");
  }
  return result;
}

/** SHA-256 of a text as lowercase hex. Uses Web Crypto, so it runs the same in Node and in a Worker. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The hash of every file, by path. Equal maps mean byte-identical projects. */
export async function hashFiles(files: Record<string, string>): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.entries(files).map(async ([path, text]) => [path, await sha256Hex(text)] as const));
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Content hash of emitted Worker code, wrangler bindings, and SQL migrations
 * (everything that requires a Worker/D1 provisioner update).
 * Excludes workflow graph definitions so workflow-only edits do not change codeHash.
 */
export async function computeCodeHash(files: Record<string, string>): Promise<string> {
  const codeFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (path === "src/workflows.json") continue;
    if (path === "project.json") {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const { workflows: _workflows, ...rest } = parsed;
        codeFiles[path] = JSON.stringify(rest);
        continue;
      } catch {
        // Fallback to raw content if project.json is not valid JSON
      }
    }
    codeFiles[path] = content;
  }
  const hashes = await hashFiles(codeFiles);
  return sha256Hex(
    Object.entries(hashes)
      .map(([path, hash]) => `${path}\n${hash}`)
      .join("\n"),
  );
}

function extractWorkflowSchedules(workflows: unknown[]): string[] {
  const crons = new Set<string>();
  for (const wf of workflows) {
    if (!wf || typeof wf !== "object") continue;
    const wfObj = wf as {
      trigger?: { type?: string; config?: Record<string, unknown> };
      nodes?: Array<{ type?: string; data?: Record<string, unknown>; config?: Record<string, unknown> }>;
    };
    if (
      wfObj.trigger?.type === "schedule" &&
      typeof wfObj.trigger.config?.cron === "string" &&
      wfObj.trigger.config.cron.trim().length > 0
    ) {
      crons.add(wfObj.trigger.config.cron.trim());
    }
    for (const node of wfObj.nodes ?? []) {
      const cronVal = node.data?.cron ?? node.config?.cron;
      if (
        typeof node.type === "string" &&
        node.type.includes("schedule") &&
        typeof cronVal === "string" &&
        cronVal.trim().length > 0
      ) {
        crons.add(cronVal.trim());
      }
    }
  }
  return [...crons].sort();
}

/**
 * Content hash of workflows[] definitions and schedule triggers stored in D1.
 */
export async function computeGraphHash(
  filesOrWorkflows: Record<string, string> | unknown[],
  schedules?: unknown[] | { schedules?: unknown[] },
): Promise<string> {
  let parsedWorkflows: unknown[] = [];
  let workflowsRaw = "[]";

  if (Array.isArray(filesOrWorkflows)) {
    parsedWorkflows = filesOrWorkflows;
    workflowsRaw = JSON.stringify(filesOrWorkflows);
  } else if (filesOrWorkflows && typeof filesOrWorkflows === "object") {
    const fileMap = filesOrWorkflows as Record<string, string>;
    if (typeof fileMap["src/workflows.json"] === "string") {
      workflowsRaw = fileMap["src/workflows.json"].trim();
      try {
        const parsed = JSON.parse(workflowsRaw) as unknown;
        if (Array.isArray(parsed)) parsedWorkflows = parsed;
      } catch {
        // Keep raw string
      }
    } else if (typeof fileMap["project.json"] === "string") {
      try {
        const proj = JSON.parse(fileMap["project.json"]) as { workflows?: unknown };
        if (Array.isArray(proj.workflows)) {
          parsedWorkflows = proj.workflows;
          workflowsRaw = JSON.stringify(proj.workflows);
        }
      } catch {
        // Ignore
      }
    }
  }

  const scheduleList = Array.isArray(schedules)
    ? schedules
    : schedules && typeof schedules === "object" && "schedules" in schedules
      ? (schedules.schedules ?? [])
      : [];

  const scheduleSet = new Set<string>(extractWorkflowSchedules(parsedWorkflows));
  for (const s of scheduleList) {
    if (typeof s === "string" && s.trim().length > 0) {
      scheduleSet.add(s.trim());
    } else if (s && typeof s === "object") {
      scheduleSet.add(JSON.stringify(s));
    }
  }
  const canonicalSchedules = [...scheduleSet].sort();

  return sha256Hex(
    `workflows:${workflowsRaw}\nschedules:${JSON.stringify(canonicalSchedules)}`,
  );
}

export interface CompositeBuildHashInput {
  codeHash: string;
  graphHash: string;
  catalogVersion?: string | undefined;
}

function isCompositeBuildHashInput(
  input: Record<string, string> | CompositeBuildHashInput,
): input is CompositeBuildHashInput {
  return (
    typeof (input as CompositeBuildHashInput).codeHash === "string" &&
    typeof (input as CompositeBuildHashInput).graphHash === "string" &&
    !("src/index.ts" in input) &&
    !("project.json" in input) &&
    !("wrangler.jsonc" in input)
  );
}

/**
 * Composite digest of (codeHash, graphHash, catalogVersion).
 * Accepts either assembled files Record<string, string> or precomputed { codeHash, graphHash, catalogVersion }.
 */
export async function computeBuildHash(
  filesOrCompositeOrCodeHash:
    | Record<string, string>
    | CompositeBuildHashInput
    | string,
  catalogVersionOrGraphHash: string = DEFAULT_CATALOG_VERSION,
  catalogVersionArg: string = DEFAULT_CATALOG_VERSION,
): Promise<string> {
  if (typeof filesOrCompositeOrCodeHash === "string") {
    return sha256Hex(
      `codeHash:${filesOrCompositeOrCodeHash}\ngraphHash:${catalogVersionOrGraphHash}\ncatalogVersion:${catalogVersionArg}`,
    );
  }
  if (isCompositeBuildHashInput(filesOrCompositeOrCodeHash)) {
    const ver =
      filesOrCompositeOrCodeHash.catalogVersion ?? catalogVersionOrGraphHash;
    return sha256Hex(
      `codeHash:${filesOrCompositeOrCodeHash.codeHash}\ngraphHash:${filesOrCompositeOrCodeHash.graphHash}\ncatalogVersion:${ver}`,
    );
  }
  const codeHash = await computeCodeHash(filesOrCompositeOrCodeHash);
  const graphHash = await computeGraphHash(filesOrCompositeOrCodeHash);
  return sha256Hex(
    `codeHash:${codeHash}\ngraphHash:${graphHash}\ncatalogVersion:${catalogVersionOrGraphHash}`,
  );
}

export interface ArtifactHashes {
  codeHash: string;
  graphHash: string;
  buildHash: string;
  catalogVersion: string;
}

export async function computeArtifactHashes(
  files: Record<string, string>,
  options?: { catalogVersion?: string; schedules?: unknown[] },
): Promise<ArtifactHashes> {
  const catalogVersion = options?.catalogVersion ?? DEFAULT_CATALOG_VERSION;
  const codeHash = await computeCodeHash(files);
  const graphHash = await computeGraphHash(files, options?.schedules);
  const buildHash = await computeBuildHash({
    codeHash,
    graphHash,
    catalogVersion,
  });
  return {
    codeHash,
    graphHash,
    buildHash,
    catalogVersion,
  };
}

