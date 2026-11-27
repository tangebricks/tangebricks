// Story 1.13: the `$capability` route option. A brick names another capability's export (`credit-wallet.walletCharger`)
// and the assembler imports it from whichever enabled brick provides that capability, so the two bricks never import
// each other. llm-gateway uses it to charge generations to the wallet: with billing "wallet" and no credit-wallet the
// blueprint is refused with a clear message; with billing "none" the option is left out.
import { describe, expect, test } from "vitest";
import { ManifestSchema, assemble } from "../src/index.ts";
import type { Catalog } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";

const AI_BRICKS = ["multi-workspace", "llm-gateway"];

const entryOf = (input: unknown, c: Catalog = catalog) => {
  const result = assemble(input, c);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.files["src/index.ts"]!;
};

describe("llm-gateway billing wiring (story 1.13)", () => {
  test("with credit-wallet enabled, the charger is credit-wallet's walletCharger, imported from its package", () => {
    const entry = entryOf({ project: "ai-app", bricks: [...AI_BRICKS, "credit-wallet"] });
    expect(entry).toMatch(/import \{[^}]*\bwalletCharger\b[^}]*\} from "@poc\/credit-wallet";/);
    const ai = entry.match(/createAiRoutes\(([^)]*)\)/);
    expect(ai).not.toBeNull();
    expect(ai![1]).toContain("charger: walletCharger");
    expect(ai![1]).toContain('billing: "wallet"');
    expect(ai![1]).toContain('models: "gpt-4o-mini:1:2"');
    expect(ai![1]).toContain("maxTokens: 4096");
  });

  test('with billing "wallet" (the default) and no credit-wallet, assembly fails and says how to fix it', () => {
    for (const bricks of [AI_BRICKS, [AI_BRICKS[0], { id: "llm-gateway", config: { billingMode: "wallet" } }]]) {
      const result = assemble({ project: "ai-app", bricks }, catalog);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const message = result.errors.join("\n");
      expect(message).toContain('llm-gateway: option "charger" of createAiRoutes needs "credit-wallet"');
      expect(message).toContain("enable one of: credit-wallet");
      expect(message).toContain('setting "billingMode" to something other than "wallet"');
    }
  });

  test('with billing "none" and no credit-wallet, it assembles without a charger', () => {
    const entry = entryOf({ project: "ai-app", bricks: [AI_BRICKS[0], { id: "llm-gateway", config: { billingMode: "none" } }] });
    const ai = entry.match(/createAiRoutes\(([^)]*)\)/);
    expect(ai![1]).toContain('billing: "none"');
    expect(ai![1]).not.toContain("charger");
    expect(entry).not.toContain("@poc/credit-wallet");
  });

  test("bad billing, models and maxTokens settings are refused", () => {
    for (const config of [{ billingMode: "free" }, { maxTokens: 0 }, { maxTokens: 200_000 }, { models: "x".repeat(201) }]) {
      const result = assemble({ project: "ai-app", bricks: [AI_BRICKS[0], { id: "llm-gateway", config }, "credit-wallet"] }, catalog);
      expect(result.ok, JSON.stringify(config)).toBe(false);
    }
  });

  test("a malformed models value is refused at assembly, with an example; Workers AI ids and ':' in ids are accepted", () => {
    const withConfig = (config: Record<string, unknown>) =>
      assemble({ project: "ai-app", bricks: [AI_BRICKS[0], { id: "llm-gateway", config }, "credit-wallet"] }, catalog);
    for (const models of ["gpt-4o-mini", "gpt-4o-mini:1", ":1:2", "gpt-4o-mini:1:2,", "gpt-4o-mini:-1:2", "gpt 4o:1:2", "gpt-4o-mini:1000000:2"]) {
      const result = withConfig({ models });
      expect(result.ok, models).toBe(false);
      if (!result.ok) expect(result.errors.join("; ")).toContain('setting "models" is not in the expected format (for example');
    }
    for (const models of ["gpt-4o-mini:1:2", "@cf/meta/llama-3.1-8b-instruct:0.5:1, vendor:model:tag:3:4", "a:0:0,b:999999.5:1"]) {
      expect(withConfig({ models }).ok, models).toBe(true);
    }
  });

  test("fallbackProviders is the app's own list: at most three valid names", () => {
    const withConfig = (config: Record<string, unknown>) =>
      assemble({ project: "ai-app", bricks: [AI_BRICKS[0], { id: "llm-gateway", config }, "credit-wallet"] }, catalog);
    expect(withConfig({ fallbackProviders: "openai, anthropic" }).ok).toBe(true);
    expect(entryOf({ project: "ai-app", bricks: [AI_BRICKS[0], { id: "llm-gateway", config: { fallbackProviders: "openai" } }, "credit-wallet"] })).toContain(
      'fallbackProviders: "openai"',
    );
    for (const fallbackProviders of ["a,b,c,d", "bad name", "a,,b"]) expect(withConfig({ fallbackProviders }).ok, fallbackProviders).toBe(false);
  });
});

describe("the $capability route option (story 1.13)", () => {
  const withOption = (option: Record<string, unknown>, patch: Record<string, unknown> = {}): Catalog => {
    const base = catalog.bricks["llm-gateway"]!;
    const manifest = structuredClone(base.manifest);
    manifest.worker.routes[0]!.options = { ...manifest.worker.routes[0]!.options, charger: option as never };
    Object.assign(manifest, patch);
    return { ...catalog, bricks: { ...catalog.bricks, "llm-gateway": { ...base, manifest } } };
  };

  test("without requiredWhen, a missing provider always refuses the blueprint", () => {
    const c = withOption({ $capability: "credit-wallet.walletCharger" });
    for (const config of [{}, { billingMode: "none" }]) {
      const result = assemble({ project: "ai-app", bricks: [AI_BRICKS[0], { id: "llm-gateway", config }] }, c);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toContain('needs "credit-wallet" (its walletCharger)');
    }
  });

  test("a capability no catalog brick provides is reported without an offer", () => {
    const result = assemble({ project: "ai-app", bricks: AI_BRICKS }, withOption({ $capability: "no-such-capability.thing" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = result.errors.join("\n");
      expect(message).toContain('needs "no-such-capability" (its thing), which no enabled brick provides');
      expect(message).not.toContain("enable one of");
    }
  });

  test("the manifest schema checks the reference and its requiredWhen setting", () => {
    const parse = (option: Record<string, unknown>) => ManifestSchema.safeParse(withOption(option).bricks["llm-gateway"]!.manifest);
    expect(parse({ $capability: "credit-wallet.walletCharger" }).success).toBe(true);
    expect(parse({ $capability: "credit-wallet.walletCharger", requiredWhen: { setting: "billingMode", equals: "wallet" } }).success).toBe(true);
    for (const bad of ["credit-wallet", "credit-wallet.", ".walletCharger", "Credit.walletCharger", "credit-wallet.wallet-charger", "credit-wallet.a.b"]) {
      expect(parse({ $capability: bad }).success, bad).toBe(false);
    }
    const unknownSetting = parse({ $capability: "credit-wallet.walletCharger", requiredWhen: { setting: "noSuchSetting", equals: true } });
    expect(unknownSetting.success).toBe(false);
    expect(JSON.stringify(unknownSetting.error?.issues)).toContain('unknown setting \\"noSuchSetting\\"');
    expect(parse({ $capability: "credit-wallet.walletCharger", extra: 1 }).success).toBe(false);
  });

  test("an isolated brick cannot take another brick's export", () => {
    const c = withOption({ $capability: "credit-wallet.walletCharger" }, { isolation: "dispatch" });
    const result = assemble({ project: "ai-app", bricks: [...AI_BRICKS, "credit-wallet"] }, c);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("; ")).toContain("which an isolated brick cannot take");
  });
  /** The catalog with credit-wallet's manifest changed by `patch`. */
  const withWallet = (patch: (m: Catalog["bricks"][string]["manifest"]) => void): Catalog => {
    const base = catalog.bricks["credit-wallet"]!;
    const manifest = structuredClone(base.manifest);
    patch(manifest);
    return { ...catalog, bricks: { ...catalog.bricks, "credit-wallet": { ...base, manifest } } };
  };
  const walletApp = (c: Catalog) => assemble({ project: "ai-app", bricks: [...AI_BRICKS, "credit-wallet"] }, c);

  test("the provider must declare the export in worker.capabilityExports", () => {
    expect(catalog.bricks["credit-wallet"]!.manifest.worker.capabilityExports).toEqual({ "credit-wallet": ["walletCharger"] });
    for (const c of [
      withWallet((m) => delete m.worker.capabilityExports),
      withWallet((m) => (m.worker.capabilityExports = { "credit-wallet": ["somethingElse"] })),
      withOption({ $capability: "credit-wallet.createWallet", requiredWhen: { setting: "billingMode", equals: "wallet" } }),
    ]) {
      const result = walletApp(c);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.errors.join("; ")).toMatch(/but credit-wallet does not offer "(walletCharger|createWallet)" for "credit-wallet" \(it offers: /);
    }
    const schema = ManifestSchema.safeParse(
      withWallet((m) => (m.worker.capabilityExports = { "not-provided": ["walletCharger"] })).bricks["credit-wallet"]!.manifest,
    );
    expect(schema.success).toBe(false);
    expect(JSON.stringify(schema.error?.issues)).toContain("which this brick does not provide");
  });

  test("an isolated, untrusted or quarantined provider cannot hand its code to another brick", () => {
    for (const [label, c] of [
      ["isolated", withWallet((m) => (m.isolation = "dispatch"))],
      ["untrusted", withWallet((m) => Object.assign(m, { trust: "untrusted", isolation: "dispatch" }))],
    ] as const) {
      const result = walletApp(c);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.errors.join("; "), label).toContain("credit-wallet is not a first-party, non-isolated brick");
    }
    const quarantined = walletApp(withWallet((m) => (m.ui = { ...m.ui!, maturity: "experimental", maturityReason: "QUARANTINED: test" })));
    expect(quarantined.ok).toBe(false);
    if (!quarantined.ok) expect(quarantined.errors.join("; ")).toContain("but credit-wallet is quarantined");
  });

  test("two packages imported under one name are refused, not emitted as a duplicate binding", () => {
    // credit-wallet offers an export named like llm-gateway's own route factory.
    const c = withWallet((m) => (m.worker.capabilityExports = { "credit-wallet": ["walletCharger", "createAiRoutes"] }));
    const clash = { ...c, bricks: { ...c.bricks, "llm-gateway": withOption({ $capability: "credit-wallet.createAiRoutes" }).bricks["llm-gateway"]! } };
    const result = walletApp(clash);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain(
        '"createAiRoutes" would be imported from both @poc/llm-gateway and @poc/credit-wallet; the entry cannot bind one name twice',
      );
  });

  test("a string setting's pattern must compile and match its default", () => {
    const parse = (patch: Record<string, unknown>) => {
      const m = structuredClone(catalog.bricks["llm-gateway"]!.manifest);
      Object.assign(m.settings["models"]!, patch);
      return ManifestSchema.safeParse(m).success;
    };
    expect(parse({})).toBe(true);
    expect(parse({ pattern: "([" })).toBe(false);
    expect(parse({ pattern: "^x$" })).toBe(false);
  });
  test("a pattern is allowed on first-party manifests only", () => {
    const m = structuredClone(catalog.bricks["llm-gateway"]!.manifest);
    expect(ManifestSchema.safeParse(m).success).toBe(true);
    Object.assign(m, { trust: "untrusted", isolation: "dispatch" });
    const untrusted = ManifestSchema.safeParse(m);
    expect(untrusted.success).toBe(false);
    expect(JSON.stringify(untrusted.error?.issues)).toContain('setting \\"models\\" declares a pattern, which only a first-party brick may do');
  });

  test("capabilityExports may not name a reserved word or a binding the assembled entry defines", () => {
    for (const name of ["default", "await", "app", "Hono", "entities", "exportTenant", "eraseTenant", "purgeWorkspaceData", "notSuspended_x"]) {
      const c = withWallet((m) => (m.worker.capabilityExports = { "credit-wallet": ["walletCharger", name] }));
      const parsed = ManifestSchema.safeParse(c.bricks["credit-wallet"]!.manifest);
      expect(parsed.success, name).toBe(false);
      expect(JSON.stringify(parsed.error?.issues), name).toContain(`worker.capabilityExports \\"${name}\\" cannot be imported into the assembled entry`);
    }
    // assemble() checks the reference itself too, for a catalog that skipped the schema.
    const c = withWallet((m) => (m.worker.capabilityExports = { "credit-wallet": ["walletCharger", "app"] }));
    const clash = { ...c, bricks: { ...c.bricks, "llm-gateway": withOption({ $capability: "credit-wallet.app" }).bricks["llm-gateway"]! } };
    const result = walletApp(clash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("; ")).toContain("cannot be imported into the assembled entry: the entry already defines that name");
  });

  test("when requiredWhen does not hold, the provider is neither checked nor wired", () => {
    const none = { id: "llm-gateway", config: { billingMode: "none" } };
    for (const [label, c] of [
      ["quarantined", withWallet((m) => (m.ui = { ...m.ui!, maturity: "experimental", maturityReason: "QUARANTINED: test" }))],
      ["undeclared export", withWallet((m) => delete m.worker.capabilityExports)],
      ["isolated", withWallet((m) => (m.isolation = "dispatch"))],
    ] as const) {
      const refused = walletApp(c);
      expect(refused.ok, `${label}: billing wallet is refused`).toBe(false);
      const result = assemble({ project: "ai-app", bricks: [AI_BRICKS[0], none, "credit-wallet"] }, c);
      expect(result.ok, `${label}: billing none assembles`).toBe(true);
      if (result.ok && label !== "isolated") {
        const ai = result.files["src/index.ts"]!.match(/createAiRoutes\(([^)]*)\)/);
        expect(ai![1]).not.toContain("charger");
        expect(result.files["src/index.ts"]).not.toContain("walletCharger");
      }
    }
  });
});
