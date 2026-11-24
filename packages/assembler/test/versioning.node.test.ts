import { describe, expect, test } from "vitest";
import { assemble, ManifestSchema } from "../src/index.ts";
import type { Catalog } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";
import { BrickManifestSchema } from "../../../bricks/contracts.ts";

describe("brick versioning, capabilities and ranges (UC8.2)", () => {
  test("Case (a): Brick B requires user-identity@^2.0.0 while A provides user-identity@1.4.0 is refused with diagnostic; compatible range passes", () => {
    // Clone catalog to construct a test fixture with capability versions
    const testCatalog: Catalog = {
      bricks: {
        "brick-a": {
          manifest: {
            manifestVersion: 2,
            kind: "brick",
            id: "brick-a",
            version: "1.4.0",
            trust: "first-party",
            isolation: "none",
            provides: ["user-identity@1.4.0"],
            requires: [],
            migrations: [],
            routePrefixes: ["brick-a"],
            npmDependencies: {},
            settings: {},
            nodes: [],
            worker: {
              package: "@poc/brick-a",
              routes: [],
            },
          },
          files: {},
        },
        "brick-b": {
          manifest: {
            manifestVersion: 2,
            kind: "brick",
            id: "brick-b",
            version: "1.0.0",
            trust: "first-party",
            isolation: "none",
            provides: [],
            requires: ["user-identity@^2.0.0"],
            migrations: [],
            routePrefixes: ["brick-b"],
            npmDependencies: {},
            settings: {},
            nodes: [],
            worker: {
              package: "@poc/brick-b",
              routes: [],
            },
          },
          files: {},
        },
      },
    };

    const incompatibleBlueprint = {
      project: "version-test",
      bricks: ["brick-a", "brick-b"],
    };

    const failureRes = assemble(incompatibleBlueprint, testCatalog);
    expect(failureRes.ok).toBe(false);
    if (!failureRes.ok) {
      const allErrors = failureRes.errors.join("\n");
      // Expect: B requires user-identity@^2.0.0 but A provides 1.4.0
      expect(allErrors).toMatch(/brick-b requires user-identity@\^2\.0\.0 but brick-a provides 1\.4\.0/i);
    }

    // Now test compatible range ^1.0.0
    const compatibleCatalog: Catalog = structuredClone(testCatalog);
    compatibleCatalog.bricks["brick-b"]!.manifest.requires = ["user-identity@^1.0.0"];

    const compatibleRes = assemble(incompatibleBlueprint, compatibleCatalog);
    expect(compatibleRes.ok).toBe(true);
  });

  test("Case (b): assemble(blueprint, catalog, { previousLock }) where a brick major version rose expects UPGRADE_MAJOR_REQUIRES_ACK unless acknowledgeUpgrades: ['<id>@<major>']", () => {
    const testCatalog: Catalog = structuredClone(catalog);
    testCatalog.bricks["multi-workspace"]!.manifest.version = "1.0.0";
    // Pretend credit-wallet was upgraded from 1.0.0 to 2.0.0 in the catalog
    const cw = testCatalog.bricks["credit-wallet"]!;
    cw.manifest.version = "2.0.0";

    const blueprint = {
      project: "upgrade-test",
      bricks: ["multi-workspace", "credit-wallet"],
    };

    const previousLock = {
      project: "upgrade-test",
      bricks: [
        { id: "multi-workspace", version: "1.0.0" },
        { id: "credit-wallet", version: "1.0.0" },
      ],
    };

    // Without acknowledgment, major upgrade must fail with UPGRADE_MAJOR_REQUIRES_ACK
    const unacknowledgedRes = assemble(blueprint, testCatalog, { previousLock });
    expect(unacknowledgedRes.ok).toBe(false);
    if (!unacknowledgedRes.ok) {
      expect(unacknowledgedRes.errors.some((e) => e.includes("UPGRADE_MAJOR_REQUIRES_ACK"))).toBe(true);
    }

    // With acknowledgment, it succeeds
    const acknowledgedRes = assemble(blueprint, testCatalog, {
      previousLock,
      acknowledgeUpgrades: ["credit-wallet@2"],
    });
    expect(acknowledgedRes.ok).toBe(true);
  });

  test("Case (c): downgrade is refused against previousLock", () => {
    const testCatalog: Catalog = structuredClone(catalog);
    // Catalog has credit-wallet at 1.0.0
    const cw = testCatalog.bricks["credit-wallet"]!;
    cw.manifest.version = "1.0.0";

    const blueprint = {
      project: "downgrade-test",
      bricks: ["multi-workspace", "credit-wallet"],
    };

    // Previous lock was at 2.0.0
    const previousLock = {
      project: "downgrade-test",
      bricks: [
        { id: "multi-workspace", version: "1.0.0" },
        { id: "credit-wallet", version: "2.0.0" },
      ],
    };

    const downgradeRes = assemble(blueprint, testCatalog, { previousLock });
    expect(downgradeRes.ok).toBe(false);
    if (!downgradeRes.ok) {
      const allErrors = downgradeRes.errors.join("\n");
      expect(allErrors).toMatch(/downgrade.*credit-wallet.*refused/i);
    }
  });

  test("Case (d): version: '1.2' is refused by the schema (both ManifestSchema and BrickManifestSchema)", () => {
    const manifestWithInvalidVersion = {
      manifestVersion: 2,
      kind: "brick",
      id: "test-brick",
      version: "1.2",
      trust: "first-party",
      isolation: "none",
      provides: [],
      requires: [],
      migrations: [],
      routePrefixes: ["test"],
      npmDependencies: {},
      settings: {},
      nodes: [],
      worker: {
        package: "@poc/test-brick",
        routes: [],
      },
    };

    const parsedManifest = ManifestSchema.safeParse(manifestWithInvalidVersion);
    expect(parsedManifest.success).toBe(false);

    const parsedContract = BrickManifestSchema.safeParse(manifestWithInvalidVersion);
    expect(parsedContract.success).toBe(false);
  });

  test("AC3: project.json records the resolved capability versions next to brick versions", () => {
    const testCatalog: Catalog = {
      bricks: {
        "multi-workspace": {
          manifest: {
            manifestVersion: 2,
            kind: "brick",
            id: "multi-workspace",
            version: "1.0.0",
            trust: "first-party",
            isolation: "none",
            provides: ["workspace"], // bare name means @1.0.0
            requires: [],
            migrations: [],
            routePrefixes: ["workspace"],
            npmDependencies: {},
            settings: {},
            nodes: [],
            worker: {
              package: "@poc/multi-workspace",
              routes: [],
            },
          },
          files: {},
        },
        "credit-wallet": {
          manifest: {
            manifestVersion: 2,
            kind: "brick",
            id: "credit-wallet",
            version: "1.2.0",
            trust: "first-party",
            isolation: "none",
            provides: ["wallet@1.2.0"],
            requires: ["workspace@^1.0.0"],
            migrations: [],
            routePrefixes: ["wallet"],
            npmDependencies: {},
            settings: {},
            nodes: [],
            worker: {
              package: "@poc/credit-wallet",
              routes: [],
            },
          },
          files: {},
        },
      },
    };

    const blueprint = {
      project: "cap-test",
      bricks: ["multi-workspace", "credit-wallet"],
    };

    const res = assemble(blueprint, testCatalog);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const projectJson = JSON.parse(res.files["project.json"]!);
      expect(projectJson.bricks).toBeDefined();

      const mwBrick = projectJson.bricks.find((b: { id: string }) => b.id === "multi-workspace");
      expect(mwBrick).toBeDefined();
      expect(mwBrick.version).toBe("1.0.0");
      expect(mwBrick.capabilities).toEqual({ workspace: "1.0.0" });

      const cwBrick = projectJson.bricks.find((b: { id: string }) => b.id === "credit-wallet");
      expect(cwBrick).toBeDefined();
      expect(cwBrick.version).toBe("1.2.0");
      expect(cwBrick.capabilities).toEqual({ wallet: "1.2.0" });

      expect(projectJson.capabilities).toEqual({
        workspace: "1.0.0",
        wallet: "1.2.0",
      });
    }
  });
});
