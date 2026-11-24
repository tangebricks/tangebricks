import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { buildCatalog } from "../build-catalog.ts";
import {
  checkAllBricks,
  checkIntegrationConformance,
  formatViolationLine,
} from "../check-manifests.ts";
import { IMPORTER_VERSION } from "../../packages/integrations/src/importer.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK_SCRIPT = join(ROOT, "scripts", "check-manifests.ts");

interface FakeBrickSpec {
  id: string;
  manifest?: Record<string, unknown>;
  pkg?: Record<string, unknown>;
  indexTs?: string;
  migrationSql?: string;
  changelog?: string | null;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeBricksWorkspace(spec: FakeBrickSpec): string {
  const bricksDir = mkdtempSync(join(tmpdir(), "poc-check-manifests-"));
  tempDirs.push(bricksDir);
  const brickDir = join(bricksDir, spec.id);
  mkdirSync(join(brickDir, "src"), { recursive: true });
  mkdirSync(join(brickDir, "migrations"), { recursive: true });
  mkdirSync(join(brickDir, "test"), { recursive: true });

  const baseManifest: Record<string, unknown> = {
    manifestVersion: 2,
    kind: "brick",
    id: spec.id,
    version: "1.0.0",
    trust: "first-party",
    provides: [],
    requires: [],
    migrations: ["migrations/0001_init.sql"],
    routePrefixes: ["items"],
    npmDependencies: {
      hono: "4.13.13",
      zod: "4.6.7",
    },
    settings: {
      maxItems: { type: "integer", min: 1, max: 1000, default: 50 },
    },
    privacy: {
      tables: {
        fake_items: {
          subject: "workspace",
          erase: "delete",
          export: true,
        },
      },
    },
    ui: {
      displayName: "Fake Brick",
      category: "data",
      summary: "Fake brick summary.",
      maturity: "production",
      behaviourTest: "test/fake.test.ts",
    },
    worker: {
      package: `@poc/${spec.id}`,
      routes: [
        {
          factory: "createItemRoutes",
          mountAt: "/api",
          options: {
            maxItems: { $setting: "maxItems" },
          },
        },
      ],
    },
    ...spec.manifest,
  };

  const basePkg: Record<string, unknown> = {
    name: `@poc/${spec.id}`,
    version: "1.0.0",
    private: true,
    type: "module",
    exports: { ".": "./src/index.ts" },
    dependencies: {
      "@poc/sdk": "workspace:*",
      hono: "4.13.13",
      zod: "4.6.7",
    },
    ...spec.pkg,
  };

  const baseIndexTs =
    spec.indexTs ??
    `import { Hono } from "hono";
export function createItemRoutes(options: { maxItems?: number } = {}) {
  const app = new Hono<{ Bindings: { DB: unknown } }>();
  app.get("/items", (c) => c.json({ db: Boolean(c.env.DB), max: options.maxItems ?? 50 }));
  return app;
}
`;

  const baseMigrationSql =
    spec.migrationSql ??
    `CREATE TABLE IF NOT EXISTS fake_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL
);
`;

  writeFileSync(join(brickDir, "brick.manifest.json"), JSON.stringify(baseManifest, null, 2) + "\n");
  writeFileSync(join(brickDir, "package.json"), JSON.stringify(basePkg, null, 2) + "\n");
  writeFileSync(join(brickDir, "src", "index.ts"), baseIndexTs);
  writeFileSync(join(brickDir, "migrations", "0001_init.sql"), baseMigrationSql);
  writeFileSync(join(brickDir, "test", "fake.test.ts"), "// behaviour test fixture\n");
  if (spec.changelog !== null) {
    writeFileSync(
      join(brickDir, "CHANGELOG.md"),
      spec.changelog ?? `# Changelog\n\n## ${(baseManifest.version as string) ?? "1.0.0"} — initial versioned release\n`,
    );
  }

  return bricksDir;
}

function runCli(bricksDir: string, extraArgs: string[] = []): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [CHECK_SCRIPT, "--bricks-dir", bricksDir, ...extraArgs], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: stdout.trim() };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
}

describe("scripts/check-manifests.ts conformance checks", () => {
  test("clean fixture passes with 0 violations and CLI exit 0", () => {
    const bricksDir = createFakeBricksWorkspace({ id: "clean-brick" });
    const violations = checkAllBricks(bricksDir);
    expect(violations).toEqual([]);

    const cli = runCli(bricksDir);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toBe("");
  });

  test("missing factory fails with worker.routes violation", () => {
    const bricksDir = createFakeBricksWorkspace({
      id: "missing-factory",
      indexTs: `export function createDifferentRoutes() { return {}; }\n`,
    });
    const lines = checkAllBricks(bricksDir).map(formatViolationLine);
    expect(lines).toContain(
      'missing-factory: worker.routes: factory "createItemRoutes" is not exported as a function by ./src/index.ts',
    );

    const cli = runCli(bricksDir);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain('missing-factory: worker.routes: factory "createItemRoutes"');
  });

  test("undeclared setting read in source fails with settings violation", () => {
    const bricksDir = createFakeBricksWorkspace({
      id: "undeclared-setting",
      manifest: {
        settings: {},
        worker: {
          package: "@poc/undeclared-setting",
          routes: [{ factory: "createItemRoutes", mountAt: "/api", options: {} }],
        },
      },
      indexTs: `import { Hono } from "hono";
export function createItemRoutes(options: { undeclaredLimit?: number } = {}) {
  const app = new Hono();
  app.get("/items", (c) => c.json({ limit: options.undeclaredLimit ?? 10 }));
  return app;
}
`,
    });
    const lines = checkAllBricks(bricksDir).map(formatViolationLine);
    expect(lines).toEqual([
      'undeclared-setting: settings: setting "undeclaredLimit" is read in source but not declared in settings',
    ]);
  });

  test("unread setting declared in manifest fails with settings violation", () => {
    const bricksDir = createFakeBricksWorkspace({
      id: "unread-setting",
      indexTs: `import { Hono } from "hono";
export function createItemRoutes() {
  const app = new Hono();
  app.get("/items", (c) => c.json({ ok: true }));
  return app;
}
`,
    });
    const lines = checkAllBricks(bricksDir).map(formatViolationLine);
    expect(lines).toEqual([
      'unread-setting: settings: setting "maxItems" is declared in settings but never read in source',
    ]);
  });

  test("npm dependency mismatch fails with npmDependencies violation", () => {
    const bricksDir = createFakeBricksWorkspace({
      id: "dep-mismatch",
      pkg: {
        dependencies: {
          "@poc/sdk": "workspace:*",
          hono: "4.12.0",
          zod: "4.6.7",
        },
      },
    });
    const lines = checkAllBricks(bricksDir).map(formatViolationLine);
    expect(lines).toEqual([
      "dep-mismatch: npmDependencies: manifest declares hono@4.13.13 but package.json has 4.12.0",
    ]);
  });

  test("undeclared env binding referenced in source fails with bindings violation", () => {
    const bricksDir = createFakeBricksWorkspace({
      id: "undeclared-env",
      indexTs: `import { Hono } from "hono";
export function createItemRoutes(options: { maxItems?: number } = {}) {
  const app = new Hono<{ Bindings: { DB: unknown; SECRET_BUCKET: unknown } }>();
  app.get("/items", (c) => c.json({ bucket: Boolean(c.env.SECRET_BUCKET), max: options.maxItems }));
  return app;
}
`,
    });
    const lines = checkAllBricks(bricksDir).map(formatViolationLine);
    expect(lines).toEqual([
      "undeclared-env: bindings: env.SECRET_BUCKET is referenced in source but not declared in bindings or secrets",
    ]);
  });

  test("table without workspace_id fails with migrations violation unless listed in globalTables with a reason", () => {
    const bricksDir = createFakeBricksWorkspace({
      id: "no-workspace-id",
      migrationSql: `CREATE TABLE IF NOT EXISTS global_audit_items (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL
);
`,
    });
    const lines = checkAllBricks(bricksDir).map(formatViolationLine);
    expect(lines).toEqual([
      'no-workspace-id: migrations: table "global_audit_items" in migrations/0001_init.sql has no workspace_id column and is not listed as global with a reason',
    ]);

    // When listed in globalTables with a reason, it passes
    const globalAllowedDir = createFakeBricksWorkspace({
      id: "global-table-ok",
      manifest: {
        globalTables: [{ table: "global_audit_items", reason: "System-wide table intentionally not scoped to a workspace." }],
      },
      migrationSql: `CREATE TABLE IF NOT EXISTS global_audit_items (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL
);
`,
    });
    expect(checkAllBricks(globalAllowedDir)).toEqual([]);
  });

  test("table with workspace_id but no privacy rule fails with privacy violation", () => {
    const bricksDir = createFakeBricksWorkspace({
      id: "missing-privacy",
      manifest: {
        privacy: {
          tables: {},
        },
      },
    });
    const lines = checkAllBricks(bricksDir).map(formatViolationLine);
    expect(lines).toEqual([
      'missing-privacy: privacy: table "fake_items" has workspace_id but no privacy rule in manifest.privacy.tables',
    ]);
  });

  test("--json flag emits machine-readable JSON object with conformance and tenant violations", () => {
    const bricksDir = createFakeBricksWorkspace({
      id: "json-check",
      pkg: {
        dependencies: {
          "@poc/sdk": "workspace:*",
          hono: "4.10.0",
          zod: "4.6.7",
        },
      },
    });
    const cli = runCli(bricksDir, ["--json"]);
    expect(cli.status).toBe(1);
    const parsed = JSON.parse(cli.stdout) as {
      violations: Array<{ brick: string; field: string; detail: string }>;
      tenantViolations: unknown[];
    };
    expect(parsed.violations).toEqual([
      {
        brick: "json-check",
        field: "npmDependencies",
        detail: "manifest declares hono@4.13.13 but package.json has 4.10.0",
      },
    ]);
    expect(Array.isArray(parsed.tenantViolations)).toBe(true);
  });

  test("brick exporting its own scheduled/queue default handler or WorkflowEntrypoint fails with triggers violation (AC 2)", () => {
    const ownScheduledDir = createFakeBricksWorkspace({
      id: "own-scheduled",
      indexTs: `import { Hono } from "hono";
export function createItemRoutes(options: { maxItems?: number } = {}) {
  const app = new Hono<{ Bindings: { DB: unknown } }>();
  app.get("/items", (c) => c.json({ db: Boolean(c.env.DB), max: options.maxItems ?? 50 }));
  return app;
}
export default {
  scheduled() {},
  queue() {},
};
`,
    });
    const scheduledLines = checkAllBricks(ownScheduledDir).map(formatViolationLine);
    expect(scheduledLines).toEqual([
      'own-scheduled: triggers: default export defines "queue" handler (AD-S15: shell owns scheduled/queue dispatch)',
      'own-scheduled: triggers: default export defines "scheduled" handler (AD-S15: shell owns scheduled/queue dispatch)',
    ]);

    const workflowClassDir = createFakeBricksWorkspace({
      id: "own-workflow-class",
      indexTs: `import { WorkflowEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
export function createItemRoutes(options: { maxItems?: number } = {}) {
  const app = new Hono<{ Bindings: { DB: unknown } }>();
  app.get("/items", (c) => c.json({ db: Boolean(c.env.DB), max: options.maxItems ?? 50 }));
  return app;
}
export class CustomWorkflow extends WorkflowEntrypoint {}
`,
    });
    const wfLines = checkAllBricks(workflowClassDir).map(formatViolationLine);
    expect(wfLines).toEqual([
      "own-workflow-class: triggers: extends WorkflowEntrypoint (AD-S15: bricks must not define their own Workflow class)",
      "own-workflow-class: triggers: imports WorkflowEntrypoint (AD-S15: bricks must not define their own Workflow class)",
    ]);
  });

  test("rejects missing ui.maturity, non-production tier without ui.maturityReason, and missing or non-existent ui.behaviourTest (Story 0.9)", () => {
    const missingMaturity = createFakeBricksWorkspace({
      id: "missing-maturity",
      manifest: {
        ui: {
          displayName: "Missing Maturity",
          category: "data",
          summary: "Brick without maturity.",
        },
      },
    });
    expect(checkAllBricks(missingMaturity).map(formatViolationLine)).toEqual([
      'missing-maturity: ui.maturity: ui.maturity is required (must be "production", "beta", or "experimental")',
    ]);

    const betaMissingReasonAndTest = createFakeBricksWorkspace({
      id: "beta-missing-reason",
      manifest: {
        ui: {
          displayName: "Beta Missing Reason",
          category: "data",
          summary: "Beta brick without reason or behaviourTest.",
          maturity: "beta",
        },
      },
    });
    expect(checkAllBricks(betaMissingReasonAndTest).map(formatViolationLine)).toEqual([
      'beta-missing-reason: ui.maturityReason: ui.maturityReason is required when ui.maturity is "beta"',
      'beta-missing-reason: ui.behaviourTest: ui.behaviourTest is required when ui.maturity is "beta"',
    ]);

    const missingTestFile = createFakeBricksWorkspace({
      id: "missing-test-file",
      manifest: {
        ui: {
          displayName: "Missing Test File",
          category: "data",
          summary: "Production brick with nonexistent behaviourTest.",
          maturity: "production",
          behaviourTest: "test/nonexistent.test.ts",
        },
      },
    });
    expect(checkAllBricks(missingTestFile).map(formatViolationLine)).toEqual([
      'missing-test-file: ui.behaviourTest: declared behaviourTest "test/nonexistent.test.ts" does not exist',
    ]);
  });

  test("scans integrations/*/integration.json in buildCatalog and checkIntegrationConformance (Story 10.1 AC 2)", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "poc-integrations-check-"));
    tempDirs.push(tmpRoot);
    const integrationsDir = join(tmpRoot, "integrations");
    const appDir = join(integrationsDir, "slack");
    mkdirSync(join(appDir, "test"), { recursive: true });
    writeFileSync(join(appDir, "test", "slack.test.ts"), "// behaviour test\n");
    const canaryDir = join(tmpRoot, "evidence", "live-canary");
    mkdirSync(canaryDir, { recursive: true });
    writeFileSync(join(canaryDir, "slack.json"), JSON.stringify({ status: "pass" }));

    const specContent = "{}";
    const specHash = `sha256:${createHash("sha256").update(Buffer.from(specContent, "utf8")).digest("hex")}`;
    writeFileSync(join(appDir, "openapi.json"), specContent);
    writeFileSync(
      join(appDir, "import-report.json"),
      JSON.stringify({
        specHash,
        importerVersion: IMPORTER_VERSION,
      }),
    );

    const validManifest = {
      manifestVersion: 2,
      kind: "integration",
      app: "slack",
      version: "1.0.0",
      ui: {
        displayName: "Slack",
        category: "communication",
        summary: "Slack messaging integration",
        maturity: "beta",
        maturityReason: "integration fixture",
        behaviourTest: "test/slack.test.ts",
      },
      auth: {
        type: "oauth2",
        scopes: ["chat:write"],
      },
      baseUrl: "https://slack.com/api",
      allowedHosts: ["slack.com"],
      operations: [
        {
          operationId: "post_message",
          label: "Post Message",
          method: "POST",
          path: "/chat.postMessage",
          response: {},
          sideEffects: "write",
        },
      ],
      fidelity: {
        specHash,
        importerVersion: IMPORTER_VERSION,
        level: "exact",
        unsupported: [],
      },
    };

    writeFileSync(join(appDir, "integration.json"), JSON.stringify(validManifest, null, 2));
    expect(checkIntegrationConformance(appDir, "slack")).toEqual([]);

    const built = buildCatalog(ROOT, { integrationsDir });
    expect(built.integrations?.slack).toBeDefined();
    expect(built.integrations?.slack?.nodes).toHaveLength(1);
    expect(built.integrations?.slack?.nodes[0]?.type).toBe("int:slack.post_message");
    expect(built.integrations?.slack?.nodes[0]?.executor).toBe("integration.operation");

    // Missing behaviourTest on production integration fails conformance
    const missingTestManifest = {
      ...validManifest,
      ui: {
        displayName: "Slack",
        category: "communication",
        summary: "Slack messaging integration",
        maturity: "production",
      },
    };
    writeFileSync(join(appDir, "integration.json"), JSON.stringify(missingTestManifest, null, 2));
    expect(checkIntegrationConformance(appDir, "slack").map(formatViolationLine)).toContain(
      'slack: ui.behaviourTest: ui.behaviourTest is required when ui.maturity is "production"',
    );
  });

  test("rateLimits (story 0.21): a path outside routePrefixes, a param key its path lacks, an auth rule that fails open and a reused bucket with other numbers are violations", () => {
    const clean = createFakeBricksWorkspace({
      id: "limited-brick",
      manifest: {
        rateLimits: [
          { method: "POST", path: "/items/:itemId/buy", bucket: "items-buy", limit: 10, windowSeconds: 60, key: "param:itemId" },
          { method: "POST", path: "/items/login", bucket: "auth-items", limit: 5, windowSeconds: 600, key: "field:email", failClosed: true },
        ],
      },
    });
    expect(checkAllBricks(clean)).toEqual([]);

    const bad = createFakeBricksWorkspace({
      id: "bad-limits",
      manifest: {
        rateLimits: [
          { method: "POST", path: "/elsewhere/x", bucket: "items-x", limit: 10, windowSeconds: 60, key: "ip" },
          { method: "POST", path: "/items/x", bucket: "items-y", limit: 10, windowSeconds: 60, key: "param:missing" },
          { method: "POST", path: "/items/login", bucket: "auth-items", limit: 5, windowSeconds: 600, key: "ip" },
          { method: "POST", path: "/items/z", bucket: "items-x", limit: 99, windowSeconds: 60, key: "ip" },
        ],
      },
    });
    const lines = checkAllBricks(bad).map(formatViolationLine);
    expect(lines).toEqual([
      "bad-limits: rateLimits: rateLimits[0] POST /elsewhere/x is not under any routePrefix [items]",
      "bad-limits: rateLimits: rateLimits[1] POST /items/x keys on param:missing, which its path does not name",
      "bad-limits: rateLimits: rateLimits[2] POST /items/login is an auth rule (bucket auth-items) and must set failClosed: true",
      "bad-limits: rateLimits: bucket items-x is declared with different numbers or keys",
    ]);

    const zero = createFakeBricksWorkspace({
      id: "zero-limit",
      manifest: { rateLimits: [{ method: "POST", path: "/items", bucket: "items-z", limit: 0, windowSeconds: 60, key: "ip" }] },
    });
    expect(checkAllBricks(zero).map(formatViolationLine).some((l) => l.startsWith("zero-limit: schema: rateLimits"))).toBe(true);
  });

  test("untrusted brick without isolation dispatch fails with trust violation", () => {
    const bricksDir = createFakeBricksWorkspace({
      id: "untrusted-brick",
      manifest: {
        trust: "untrusted",
      },
    });
    const lines = checkAllBricks(bricksDir).map(formatViolationLine);
    expect(lines).toEqual([
      'untrusted-brick: schema: trust: untrusted requires isolation: "dispatch"',
    ]);
  });

  test("brick version cannot be 0.0.0 and package.json version must match (UC8.2 AC2)", () => {
    const zeroVersionDir = createFakeBricksWorkspace({
      id: "zero-version-brick",
      manifest: { version: "0.0.0" },
      pkg: { version: "0.0.0" },
    });
    const zeroLines = checkAllBricks(zeroVersionDir).map(formatViolationLine);
    expect(zeroLines).toContain("zero-version-brick: version: brick version cannot be 0.0.0");

    const mismatchVersionDir = createFakeBricksWorkspace({
      id: "mismatch-version-brick",
      manifest: { version: "1.0.0" },
      pkg: { version: "0.9.0" },
    });
    const mismatchLines = checkAllBricks(mismatchVersionDir).map(formatViolationLine);
    expect(mismatchLines).toContain('mismatch-version-brick: version: manifest declares version "1.0.0" but package.json version is "0.9.0"');
  });

  test("brick without CHANGELOG.md or whose CHANGELOG lacks version fails conformance (UC8.2 AC2)", () => {
    const missingChangelogDir = createFakeBricksWorkspace({
      id: "no-changelog-brick",
      changelog: null,
    });
    const missingLines = checkAllBricks(missingChangelogDir).map(formatViolationLine);
    expect(missingLines).toContain("no-changelog-brick: changelog: CHANGELOG.md is missing");

    const staleChangelogDir = createFakeBricksWorkspace({
      id: "stale-changelog-brick",
      changelog: "# Changelog\n\n## 0.9.0 — previous release\n",
    });
    const staleLines = checkAllBricks(staleChangelogDir).map(formatViolationLine);
    expect(staleLines).toContain("stale-changelog-brick: changelog: CHANGELOG.md does not mention version 1.0.0");
  });

  test("production integration requires live-canary evidence (UC5.1 / AC2)", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "poc-check-canary-"));
    tempDirs.push(tmpRoot);
    const integrationsDir = join(tmpRoot, "integrations");
    const appDir = join(integrationsDir, "slack");
    mkdirSync(join(appDir, "test"), { recursive: true });
    writeFileSync(join(appDir, "test", "slack.test.ts"), "// behaviour test\n");

    const specContent = "{}";
    const specHash = `sha256:${createHash("sha256").update(Buffer.from(specContent, "utf8")).digest("hex")}`;
    writeFileSync(join(appDir, "openapi.json"), specContent);
    writeFileSync(
      join(appDir, "import-report.json"),
      JSON.stringify({
        specHash,
        importerVersion: IMPORTER_VERSION,
      }),
    );

    const prodManifest = {
      manifestVersion: 2,
      kind: "integration",
      app: "slack",
      version: "1.0.0",
      ui: {
        displayName: "Slack",
        category: "communication",
        summary: "Slack messaging integration",
        maturity: "production",
        behaviourTest: "test/slack.test.ts",
      },
      auth: {
        type: "oauth2",
        scopes: ["chat:write"],
      },
      baseUrl: "https://slack.com/api",
      allowedHosts: ["slack.com"],
      operations: [
        {
          operationId: "post_message",
          label: "Post Message",
          method: "POST",
          path: "/chat.postMessage",
          response: {},
          sideEffects: "write",
        },
      ],
      fidelity: {
        specHash,
        importerVersion: IMPORTER_VERSION,
        level: "exact",
        unsupported: [],
      },
    };

    writeFileSync(join(appDir, "integration.json"), JSON.stringify(prodManifest, null, 2));

    const evidenceDir = join(tmpRoot, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, "tier-evidence.json"),
      JSON.stringify([{ id: "slack", kind: "integration", executed: true, passed: true, assertionCount: 25 }]),
    );

    // Without live-canary evidence, production integration fails conformance
    const violations = checkIntegrationConformance(appDir, "slack");
    expect(violations.map(formatViolationLine)).toContain(
      "slack: ui.maturity: declared production, derived beta: LIVE_CANARY_STALE",
    );

    // With live-canary evidence, production integration passes conformance
    const canaryDir = join(tmpRoot, "evidence", "live-canary");
    mkdirSync(canaryDir, { recursive: true });
    writeFileSync(
      join(canaryDir, "slack.json"),
      JSON.stringify({ status: "pass", verifiedAt: new Date().toISOString() }),
    );
    expect(checkIntegrationConformance(appDir, "slack")).toEqual([]);
  });

  test("the five curated integrations declare beta maturity with live-canary promotion reason (UC5.1 / AC1)", () => {
    const integrationsDir = join(ROOT, "integrations");
    const apps = ["discord", "github", "google", "slack", "stripe"];
    const expectedReason =
      "Verified only against recorded fixtures; promotion requires a passing live canary within the freshness window (UC5.5) and fidelity gate (UC2).";

    const tmpRoot = mkdtempSync(join(tmpdir(), "poc-int-evidence-"));
    tempDirs.push(tmpRoot);
    const evidenceDir = join(tmpRoot, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const tierRows = apps.map((app) => ({
      id: app,
      kind: "integration",
      executed: true,
      passed: true,
      assertionCount: 50,
    }));
    writeFileSync(join(evidenceDir, "tier-evidence.json"), JSON.stringify(tierRows));

    for (const app of apps) {
      const raw = JSON.parse(
        readFileSync(join(integrationsDir, app, "integration.json"), "utf8"),
      );
      expect(raw.ui.maturity).toBe("beta");
      expect(raw.ui.maturityReason).toBe(expectedReason);
      const violations = checkIntegrationConformance(join(integrationsDir, app), app, tmpRoot);
      expect(violations).toEqual([]);
    }
  });
});
