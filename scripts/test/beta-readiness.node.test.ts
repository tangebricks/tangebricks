import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const betaReadinessScript = resolve(repoRoot, "scripts/beta-readiness.ts");

describe("Story UC0.2 — beta-readiness metrics generator", () => {
  it("AC 1: running without --cohort exits 1 and prints BETA_READINESS_NO_REAL_COHORT", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "beta-test-"));
    const evidenceDir = join(tempDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    try {
      const res = spawnSync(process.execPath, [betaReadinessScript], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, POC_EVIDENCE_DIR: evidenceDir },
      });
      expect(res.status).toBe(1);
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).toContain("BETA_READINESS_NO_REAL_COHORT");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("running with --cohort containing seeded partner ids exits 1 with BETA_READINESS_SEEDED_INPUT", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "beta-test-"));
    const evidenceDir = join(tempDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    try {
      const seededCohortFile = join(tempDir, "seeded-cohort.json");
      const seededPayload = [
        {
          orgId: "org_cohort1_agency_northstar",
          orgName: "Fake Northstar",
          orgSlug: "northstar-agency",
          partnerType: "agency",
          ownerEmail: "lead@northstar-agency.example.com",
        },
      ];
      writeFileSync(seededCohortFile, JSON.stringify(seededPayload));

      const res = spawnSync(process.execPath, [betaReadinessScript, "--cohort", seededCohortFile], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, POC_EVIDENCE_DIR: evidenceDir },
      });
      expect(res.status).toBe(1);
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).toContain("BETA_READINESS_SEEDED_INPUT");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("AC 2: running with --simulate outputs only to evidence/simulated/cp8-beta-readiness.json with inputKind simulated", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "beta-test-"));
    const evidenceDir = join(tempDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    try {
      const res = spawnSync(process.execPath, [betaReadinessScript, "--simulate"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, POC_EVIDENCE_DIR: evidenceDir },
      });
      expect(res.status).toBe(0);

      const topLevel = join(evidenceDir, "cp8-beta-readiness.json");
      expect(existsSync(topLevel)).toBe(false);

      const simulatedPath = join(evidenceDir, "simulated", "cp8-beta-readiness.json");
      expect(existsSync(simulatedPath)).toBe(true);

      const data = JSON.parse(readFileSync(simulatedPath, "utf8"));
      expect(data.provenance).toBeDefined();
      expect(data.provenance.inputKind).toBe("simulated");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("running with valid real cohort export produces measured evidence at top level", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "beta-test-"));
    const evidenceDir = join(tempDir, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    try {
      const realCohortFile = join(tempDir, "real-cohort.json");
      const realPartners = [
        {
          orgId: "org_real_acme_agency",
          orgName: "Acme Agency Partners",
          orgSlug: "acme-agency-partners",
          partnerType: "agency",
          ownerEmail: "admin@acme-agency.example.com",
          ownerName: "Alice Smith",
          sessionTelemetry: {
            projectId: "acme-ops",
            ttfdMinutes: 18.0,
            connectCfCompleted: true,
            deployedIntegrationWorkflows: 2,
            meanTimeToLocateFailingNodeSec: 45,
            weeklyActiveSessionsW4: 5,
          },
        },
        {
          orgId: "org_real_bolt_agency",
          orgName: "Bolt Dev Agency",
          orgSlug: "bolt-dev-agency",
          partnerType: "agency",
          ownerEmail: "tech@bolt-agency.example.com",
          ownerName: "Bob Jones",
          sessionTelemetry: {
            projectId: "bolt-portal",
            ttfdMinutes: 20.0,
            connectCfCompleted: true,
            deployedIntegrationWorkflows: 1,
            meanTimeToLocateFailingNodeSec: 50,
            weeklyActiveSessionsW4: 4,
          },
        },
        {
          orgId: "org_real_vector_mcp",
          orgName: "Vector MCP Studio",
          orgSlug: "vector-mcp-studio",
          partnerType: "mcp-first-dev",
          ownerEmail: "charlie@vector-mcp.example.com",
          ownerName: "Charlie Brown",
          sessionTelemetry: {
            projectId: "vector-credits",
            ttfdMinutes: 12.0,
            connectCfCompleted: true,
            deployedIntegrationWorkflows: 3,
            meanTimeToLocateFailingNodeSec: 30,
            weeklyActiveSessionsW4: 6,
          },
        },
        {
          orgId: "org_real_quantum_mcp",
          orgName: "Quantum Agents Co",
          orgSlug: "quantum-agents-co",
          partnerType: "mcp-first-dev",
          ownerEmail: "dana@quantum-agents.example.com",
          ownerName: "Dana White",
          sessionTelemetry: {
            projectId: "quantum-router",
            ttfdMinutes: 15.0,
            connectCfCompleted: true,
            deployedIntegrationWorkflows: 1,
            meanTimeToLocateFailingNodeSec: 40,
            weeklyActiveSessionsW4: 5,
          },
        },
        {
          orgId: "org_real_solofounder_echo",
          orgName: "Echo Solo SaaS",
          orgSlug: "echo-solo-saas",
          partnerType: "solo-founder",
          ownerEmail: "evan@echosolo.example.com",
          ownerName: "Evan Taylor",
          sessionTelemetry: {
            projectId: "echo-saas",
            ttfdMinutes: 22.0,
            connectCfCompleted: true,
            deployedIntegrationWorkflows: 1,
            meanTimeToLocateFailingNodeSec: 60,
            weeklyActiveSessionsW4: 4,
          },
        },
      ];
      writeFileSync(realCohortFile, JSON.stringify(realPartners));

      const res = spawnSync(process.execPath, [betaReadinessScript, "--cohort", realCohortFile], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, POC_EVIDENCE_DIR: evidenceDir },
      });
      expect(res.status).toBe(0);

      const measuredPath = join(evidenceDir, "cp8-beta-readiness.json");
      expect(existsSync(measuredPath)).toBe(true);

      const data = JSON.parse(readFileSync(measuredPath, "utf8"));
      expect(data.provenance).toBeDefined();
      expect(data.provenance.inputKind).toBe("measured");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
