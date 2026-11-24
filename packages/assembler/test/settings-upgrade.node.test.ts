import { describe, expect, it } from "vitest";
import {
  assemble,
  checkSettingsUpgrade,
  ManifestSchema,
  type Catalog,
  type ProjectLock,
} from "../src/index.ts";

function createMockCatalog(creditWalletManifest: any): Catalog {
  return {
    bricks: {
      "credit-wallet": {
        manifest: creditWalletManifest,
        files: {
          "migrations/0001_wallet.sql": "CREATE TABLE wallet (id TEXT PRIMARY KEY);\n",
        },
      },
      "multi-workspace": {
        manifest: {
          manifestVersion: 2,
          kind: "brick",
          id: "multi-workspace",
          version: "1.0.0",
          trust: "first-party",
          isolation: "none",
          provides: ["user-identity@1.0.0"],
          requires: [],
          migrations: [],
          routePrefixes: ["workspace"],
          npmDependencies: {},
          settings: {},
          nodes: [],
          worker: {
            package: "@poc/multi-workspace",
            routes: [
              {
                factory: "createWorkspaceRoutes",
                mountAt: "/workspace",
                options: {},
                guardPaths: [],
              },
            ],
          },
        },
        files: {},
      },
    },
  };
}

describe("Settings upgrade re-validation (UC8.3)", () => {
  it("AC1 & Task 1: detects narrowed integer setting and returns formatted error", () => {
    const previousLock: ProjectLock = {
      project: "test-app",
      bricks: [
        {
          id: "credit-wallet",
          version: "1.0.0",
          settings: {
            maxDebit: 500,
          },
        },
      ],
    };

    const newManifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "credit-wallet",
      version: "1.1.0",
      trust: "first-party",
      isolation: "none",
      provides: ["wallet-service@1.1.0"],
      requires: ["user-identity@1.0.0"],
      migrations: ["migrations/0001_wallet.sql"],
      routePrefixes: ["wallet"],
      npmDependencies: {},
      settings: {
        maxDebit: {
          type: "integer",
          min: 0,
          max: 400,
          default: 100,
        },
      },
      nodes: [],
      worker: {
        package: "@poc/credit-wallet",
        routes: [
          {
            factory: "createWalletRoutes",
            mountAt: "/wallet",
            options: {},
            guardPaths: [],
          },
        ],
      },
    };

    const catalog = createMockCatalog(newManifest);
    const result = checkSettingsUpgrade(previousLock, catalog);

    expect(result.errors).toContain(
      "setting credit-wallet.maxDebit=500 is outside 0..400 in 1.1.0"
    );
  });

  it("Task 1: warns on deprecated setting with migration hint", () => {
    const previousLock: ProjectLock = {
      project: "test-app",
      bricks: [
        {
          id: "credit-wallet",
          version: "1.0.0",
          settings: {
            legacyOption: 50,
          },
        },
      ],
    };

    const newManifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "credit-wallet",
      version: "1.1.0",
      trust: "first-party",
      isolation: "none",
      provides: ["wallet-service@1.1.0"],
      requires: ["user-identity@1.0.0"],
      migrations: ["migrations/0001_wallet.sql"],
      routePrefixes: ["wallet"],
      npmDependencies: {},
      settings: {
        legacyOption: {
          type: "integer",
          min: 0,
          max: 100,
          default: 50,
          deprecated: {
            since: "1.1.0",
            replacedBy: "newOption",
          },
        },
      },
      nodes: [],
      worker: {
        package: "@poc/credit-wallet",
        routes: [
          {
            factory: "createWalletRoutes",
            mountAt: "/wallet",
            options: {},
            guardPaths: [],
          },
        ],
      },
    };

    const catalog = createMockCatalog(newManifest);
    const result = checkSettingsUpgrade(previousLock, catalog);

    expect(result.warnings.length).toBeGreaterThan(0);
    const warning = result.warnings[0]!;
    expect(warning).toContain("credit-wallet.legacyOption");
    expect(warning).toContain("1.1.0");
    expect(warning).toContain("newOption");
  });

  it("Task 1: reports newly added setting with since that was absent in saved config as added with its default", () => {
    const previousLock: ProjectLock = {
      project: "test-app",
      bricks: [
        {
          id: "credit-wallet",
          version: "1.0.0",
          settings: {
            maxDebit: 200,
          },
        },
      ],
    };

    const newManifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "credit-wallet",
      version: "1.1.0",
      trust: "first-party",
      isolation: "none",
      provides: ["wallet-service@1.1.0"],
      requires: ["user-identity@1.0.0"],
      migrations: ["migrations/0001_wallet.sql"],
      routePrefixes: ["wallet"],
      npmDependencies: {},
      settings: {
        maxDebit: {
          type: "integer",
          min: 0,
          max: 1000,
          default: 200,
        },
        autoTopUp: {
          type: "boolean",
          default: false,
          since: "1.1.0",
        },
      },
      nodes: [],
      worker: {
        package: "@poc/credit-wallet",
        routes: [
          {
            factory: "createWalletRoutes",
            mountAt: "/wallet",
            options: {},
            guardPaths: [],
          },
        ],
      },
    };

    const catalog = createMockCatalog(newManifest);
    const result = checkSettingsUpgrade(previousLock, catalog);

    expect(result.errors).toHaveLength(0);
    expect(result.added).toContainEqual({
      brick: "credit-wallet",
      setting: "autoTopUp",
      default: false,
      since: "1.1.0",
    });
  });

  it("AC2: a removed setting whose saved value differs from the old default is an error", () => {
    const previousLock: ProjectLock = {
      project: "test-app",
      bricks: [
        {
          id: "credit-wallet",
          version: "1.0.0",
          settings: {
            customFeature: true,
            defaultFeature: false,
          },
          defaults: {
            customFeature: false,
            defaultFeature: false,
          },
        } as any,
      ],
    };

    const newManifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "credit-wallet",
      version: "1.1.0",
      trust: "first-party",
      isolation: "none",
      provides: ["wallet-service@1.1.0"],
      requires: ["user-identity@1.0.0"],
      migrations: ["migrations/0001_wallet.sql"],
      routePrefixes: ["wallet"],
      npmDependencies: {},
      settings: {},
      nodes: [],
      worker: {
        package: "@poc/credit-wallet",
        routes: [
          {
            factory: "createWalletRoutes",
            mountAt: "/wallet",
            options: {},
            guardPaths: [],
          },
        ],
      },
    };

    const catalog = createMockCatalog(newManifest);
    const result = checkSettingsUpgrade(previousLock, catalog);

    // customFeature differs from default -> error
    expect(result.errors.some((e) => e.includes("credit-wallet.customFeature"))).toBe(true);
    // defaultFeature equals default -> silently dropped (not an error)
    expect(result.errors.some((e) => e.includes("credit-wallet.defaultFeature"))).toBe(false);
  });

  it("Task 2: ManifestSchema validates since and deprecated, and superRefine rejects since > brick version", () => {
    const baseManifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "credit-wallet",
      version: "1.1.0",
      trust: "first-party",
      isolation: "none",
      provides: ["wallet-service@1.1.0"],
      requires: [],
      migrations: [],
      routePrefixes: ["wallet"],
      npmDependencies: {},
      settings: {
        validSetting: {
          type: "integer",
          min: 0,
          max: 100,
          default: 10,
          since: "1.0.0",
          deprecated: {
            since: "1.1.0",
            replacedBy: "other",
          },
        },
      },
      nodes: [],
      worker: {
        package: "@poc/credit-wallet",
        routes: [],
      },
    };

    // Valid manifest parses cleanly
    const parsedValid = ManifestSchema.safeParse(baseManifest);
    expect(parsedValid.success).toBe(true);

    // Invalid manifest: since > brick version
    const invalidSinceManifest = {
      ...baseManifest,
      settings: {
        futureSetting: {
          type: "integer",
          min: 0,
          max: 100,
          default: 10,
          since: "2.0.0", // Greater than 1.1.0
        },
      },
    };
    const parsedSince = ManifestSchema.safeParse(invalidSinceManifest);
    expect(parsedSince.success).toBe(false);
    expect(parsedSince.error?.issues.some((i) => i.message.includes("greater than brick version"))).toBe(true);

    // Invalid manifest: deprecated.since > brick version
    const invalidDepManifest = {
      ...baseManifest,
      settings: {
        futureDepSetting: {
          type: "integer",
          min: 0,
          max: 100,
          default: 10,
          deprecated: {
            since: "2.0.0", // Greater than 1.1.0
          },
        },
      },
    };
    const parsedDep = ManifestSchema.safeParse(invalidDepManifest);
    expect(parsedDep.success).toBe(false);
    expect(parsedDep.error?.issues.some((i) => i.message.includes("greater than brick version"))).toBe(true);
  });

  it("Task 3: assemble() calls checkSettingsUpgrade when previousLock is provided and blocks on errors", () => {
    const previousLock: ProjectLock = {
      project: "my-app",
      bricks: [
        {
          id: "credit-wallet",
          version: "1.0.0",
          settings: {
            maxDebit: 500,
          },
        },
      ],
    };

    const newManifest = {
      manifestVersion: 2,
      kind: "brick",
      id: "credit-wallet",
      version: "1.1.0",
      trust: "first-party",
      isolation: "none",
      provides: ["wallet-service@1.1.0"],
      requires: ["user-identity@1.0.0"],
      migrations: ["migrations/0001_wallet.sql"],
      routePrefixes: ["wallet"],
      npmDependencies: {},
      settings: {
        maxDebit: {
          type: "integer",
          min: 0,
          max: 400, // Narrowed!
          default: 100,
        },
      },
      nodes: [],
      worker: {
        package: "@poc/credit-wallet",
        routes: [
          {
            factory: "createWalletRoutes",
            mountAt: "/wallet",
            options: {},
            guardPaths: [],
          },
        ],
      },
    };

    const catalog = createMockCatalog(newManifest);
    const blueprint = {
      project: "my-app",
      bricks: [
        { id: "credit-wallet", config: { maxDebit: 300 } },
        { id: "multi-workspace", config: {} },
      ],
    };

    const result = assemble(blueprint, catalog, { previousLock });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "setting credit-wallet.maxDebit=500 is outside 0..400 in 1.1.0"
      );
    }
  });
});
