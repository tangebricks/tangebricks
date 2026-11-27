import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export type EvidenceInputKind = "measured" | "simulated";

export interface EvidenceProvenance {
  generatedAt: string;
  gitSha: string;
  gitDirty: boolean;
  generator: string;
  inputKind: EvidenceInputKind;
  quarantined?: boolean;
  reason?: string;
  quarantinedAt?: string;
}

export function getEvidenceDir(): string {
  return process.env.POC_EVIDENCE_DIR ? resolve(process.env.POC_EVIDENCE_DIR) : resolve(repoRoot, "evidence");
}

export function getGitSha(cwd: string = repoRoot): string {
  try {
    const sha = execSync("git rev-parse HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!/^[0-9a-f]{40}$/i.test(sha) || /^0{40}$/.test(sha)) {
      throw new Error(`Invalid git commit SHA: ${sha}`);
    }
    return sha;
  } catch (err: any) {
    throw new Error(`GIT_REV_PARSE_FAILED: Failed to get git commit SHA in ${cwd}: ${err.message}`);
  }
}

export function isGitDirty(cwd: string = repoRoot): boolean {
  try {
    const status = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return status.length > 0;
  } catch (err: any) {
    throw new Error(`GIT_STATUS_FAILED: Failed to check git status in ${cwd}: ${err.message}`);
  }
}

export function stampEvidence(generator: string, inputKind: EvidenceInputKind = "measured"): EvidenceProvenance {
  return {
    generatedAt: new Date().toISOString(),
    gitSha: getGitSha(),
    gitDirty: isGitDirty(),
    generator,
    inputKind,
  };
}

export function writeEvidence(targetPath: string, body: unknown, provenance: EvidenceProvenance): void {
  const normalized = targetPath.replace(/\\/g, "/");

  if (provenance.inputKind === "simulated") {
    // Simulated evidence may only live in these folders (never under any folder that is merely named that).
    const SIMULATED_HOMES = ["evidence/simulated", "evidence/quarantine", ".evidence-run/simulated", ".evidence-run/quarantine"];
    const isSimulated = SIMULATED_HOMES.some((dir) => normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`));
    const isQuarantine = isSimulated;
    if (!isSimulated && !isQuarantine) {
      throw new Error(
        `EVIDENCE_SIMULATED_OUTSIDE_QUARANTINE: Simulated evidence must be written under evidence/simulated/ or evidence/quarantine/, got: ${targetPath}`,
      );
    }
  }

  mkdirSync(dirname(targetPath), { recursive: true });

  const payload: Record<string, unknown> =
    typeof body === "object" && body !== null && !Array.isArray(body) ? { ...(body as Record<string, unknown>), provenance } : { data: body, provenance };

  if (payload.generatedAt === "2026-11-01T00:00:00.000Z" || provenance.generatedAt === "2026-11-01T00:00:00.000Z") {
    throw new Error(`EVIDENCE_HARDCODED_TIMESTAMP: Attempted to write evidence with hardcoded timestamp 2026-11-01T00:00:00.000Z to ${targetPath}`);
  }

  writeFileSync(targetPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}
