// Story 2.6: what the assembler does for the platform-admin brick, and the three generic features it added for it:
//   - `requiredWhen: "provided"` on a `$capability` option: wired when a provider is enabled, left out (never refused)
//     when none is;
//   - `$capabilitySetting`: a provider's resolved setting value, left out with no provider;
//   - `worker.approvalGuard`: a gate mounted on the guarded paths only while the brick's boolean setting is true.
import { describe, expect, test } from "vitest";
import { ManifestSchema, assemble } from "../src/index.ts";
import type { Catalog } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";

const entryOf = (input: unknown, c: Catalog = catalog) => {
  const result = assemble(input, c);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.files["src/index.ts"]!;
};
const routesCall = (entry: string) => entry.match(/createPlatformAdminRoutes\(([^)]*)\)/)?.[1] ?? "";
const MIN = ["multi-workspace", "audit-trail", "platform-admin"];

describe("platform-admin wiring (story 2.6)", () => {
  test("with every provider enabled, the audit recorder, the charger, the override surface and its setting are wired", () => {
    const entry = entryOf({ project: "ops", bricks: [...MIN, "credit-wallet", { id: "feature-flags", config: { allowWorkspaceOverrides: false } }] });
    const options = routesCall(entry);
    expect(options).toContain("auditRecorder: auditRecorder");
    expect(options).toContain("charger: walletCharger");
    expect(options).toContain("flagOverrides: flagOverrides");
    expect(options).toContain("flagOverridesAllowed: false");
    expect(options).toContain("maxGrantCredits: 1000000");
    expect(entry).toMatch(/import \{[^}]*\bauditRecorder\b[^}]*\} from "@poc\/audit-trail";/);
    expect(entry).toMatch(/import \{[^}]*\bflagOverrides\b[^}]*\} from "@poc\/feature-flags";/);
    expect(entryOf({ project: "ops", bricks: [...MIN, "feature-flags"] })).toContain("flagOverridesAllowed: true");
  });

  test("without credit-wallet or feature-flags the blueprint still assembles; those options are left out", () => {
    const entry = entryOf({ project: "ops", bricks: MIN });
    const options = routesCall(entry);
    expect(options).toContain("auditRecorder: auditRecorder");
    expect(options).not.toMatch(/charger|flagOverrides/);
    expect(entry).not.toContain("@poc/credit-wallet");
    expect(entry).not.toContain("@poc/feature-flags");
  });

  test("audit logging is required: without audit-trail the blueprint is refused", () => {
    const result = assemble({ project: "ops", bricks: ["multi-workspace", "platform-admin"] }, catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("; ")).toContain("audit-logging");
  });

  test("the operator routes are not workspace-guarded, and every write is rate-limited per user", () => {
    const entry = entryOf({ project: "ops", bricks: MIN });
    expect(entry).not.toMatch(/app\.use\("\/api\/platform/);
    for (const [method, path] of [
      ["POST", "/api/platform/workspaces/:id/credits"],
      ["POST", "/api/platform/workspaces/:id/suspend"],
      ["POST", "/api/platform/workspaces/:id/unsuspend"],
      ["PUT", "/api/platform/workspaces/:id/flags/:flagKey"],
      ["DELETE", "/api/platform/workspaces/:id/flags/:flagKey"],
      ["POST", "/api/platform/users/:uid/approve"],
      ["POST", "/api/platform/users/:uid/reject"],
    ]) {
      expect(entry).toContain(`app.on("${method}", "${path}", rateLimit({"bucket":"platform-admin-write","limit":120,"windowSeconds":60,"key":"user"}));`);
    }
  });

  test("the approval gate is mounted on every guarded path after the identity step only when requireUserApproval is true", () => {
    const off = entryOf({ project: "ops", bricks: [...MIN, "credit-wallet"] });
    expect(off).not.toContain("requireApprovedUser");
    const on = entryOf({ project: "ops", bricks: [...MIN.slice(0, 2), { id: "platform-admin", config: { requireUserApproval: true } }, "credit-wallet"] });
    const lines = on.split("\n");
    const identity = lines.findIndex((l) => l.startsWith('app.use("/api/*", stubIdentity)'));
    const gates = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes(", requireApprovedUser);"));
    const guards = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes(", workspaceMiddleware);"));
    expect(identity).toBeGreaterThan(-1);
    expect(guards.length).toBeGreaterThan(0);
    // One gate per guarded path, all after the identity step and before the first workspace guard.
    expect(gates.map(([l]) => l.replace(", requireApprovedUser);", "")).sort()).toEqual(guards.map(([l]) => l.replace(", workspaceMiddleware);", "")).sort());
    expect(gates.every(([, i]) => i > identity && i < guards[0]![1])).toBe(true);
    expect(on).toMatch(/import \{[^}]*\brequireApprovedUser\b[^}]*\} from "@poc\/platform-admin";/);
  });

  test("turning the gate off leaves the entry exactly as an app without the setting", () => {
    const plain = entryOf({ project: "ops", bricks: MIN });
    const explicitOff = entryOf({ project: "ops", bricks: [...MIN.slice(0, 2), { id: "platform-admin", config: { requireUserApproval: false } }] });
    expect(explicitOff).toBe(plain);
  });
});

describe("the generic features behind it (story 2.6)", () => {
  const parse = (option: unknown) =>
    ManifestSchema.safeParse({
      ...catalog.bricks["platform-admin"]!.manifest,
      worker: {
        ...catalog.bricks["platform-admin"]!.manifest.worker,
        routes: [{ factory: "createPlatformAdminRoutes", mountAt: "/api", options: { x: option } }],
      },
    });

  test('the schema accepts requiredWhen "provided" and $capabilitySetting, and refuses malformed ones', () => {
    expect(parse({ $capability: "credit-wallet.walletCharger", requiredWhen: "provided" }).success).toBe(true);
    expect(parse({ $capability: "credit-wallet.walletCharger", requiredWhen: "always" }).success).toBe(false);
    expect(parse({ $capabilitySetting: "feature-flags.allowWorkspaceOverrides" }).success).toBe(true);
    expect(parse({ $capabilitySetting: "feature-flags" }).success).toBe(false);
    expect(parse({ $capabilitySetting: "feature-flags.x", extra: 1 }).success).toBe(false);
  });

  test("a $capabilitySetting naming a setting the provider does not have is refused at assembly", () => {
    const c: Catalog = JSON.parse(JSON.stringify(catalog));
    (c.bricks["platform-admin"]!.manifest.worker.routes[0]!.options as Record<string, unknown>).flagOverridesAllowed = {
      $capabilitySetting: "feature-flags.noSuchSetting",
    };
    const result = assemble({ project: "ops", bricks: [...MIN, "feature-flags"] }, c);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("; ")).toContain('has no setting "noSuchSetting"');
    // With no provider enabled there is nothing to check, and the option is left out.
    expect(assemble({ project: "ops", bricks: MIN }, c).ok).toBe(true);
  });

  test("an optional provider that is enabled is still checked like any $capability", () => {
    const c: Catalog = JSON.parse(JSON.stringify(catalog));
    delete c.bricks["feature-flags"]!.manifest.worker.capabilityExports;
    const result = assemble({ project: "ops", bricks: [...MIN, "feature-flags"] }, c);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("; ")).toContain('does not offer "flagOverrides" for "feature-flags"');
  });

  test("approvalGuard must name a boolean setting of the brick", () => {
    const base = catalog.bricks["platform-admin"]!.manifest;
    const withGate = (gate: unknown) => ManifestSchema.safeParse({ ...base, worker: { ...base.worker, approvalGuard: gate } });
    expect(withGate({ export: "requireApprovedUser", setting: "requireUserApproval" }).success).toBe(true);
    expect(withGate({ export: "requireApprovedUser", setting: "maxGrantCredits" }).success).toBe(false);
    expect(withGate({ export: "requireApprovedUser", setting: "noSuchSetting" }).success).toBe(false);
    expect(withGate({ export: "app", setting: "requireUserApproval" }).success).toBe(false);
  });
});

describe("trust rules for the story 2.6 features", () => {
  const clone = (): Catalog => JSON.parse(JSON.stringify(catalog));
  const quarantine = (m: Catalog["bricks"][string]["manifest"]) => (m.ui = { ...m.ui!, maturity: "experimental", maturityReason: "QUARANTINED: test" });
  const errorsOf = (input: unknown, c: Catalog) => {
    const result = assemble(input, c);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.errors.join("; ");
  };
  const GATED = [...MIN.slice(0, 2), { id: "platform-admin", config: { requireUserApproval: true } }];

  test("an approval gate is refused unless its brick is first-party, not isolated and not quarantined", () => {
    const q = clone();
    quarantine(q.bricks["platform-admin"]!.manifest);
    expect(errorsOf({ project: "ops", bricks: GATED }, q)).toContain(
      'platform-admin: worker.approvalGuard "requireApprovedUser" is refused: platform-admin is quarantined',
    );
    const u = clone();
    Object.assign(u.bricks["platform-admin"]!.manifest, { trust: "untrusted", isolation: "dispatch" });
    expect(errorsOf({ project: "ops", bricks: GATED }, u)).toContain("only a first-party, non-isolated brick may mount an approval gate");
    const i = clone();
    Object.assign(i.bricks["platform-admin"]!.manifest, { isolation: "dispatch" });
    expect(errorsOf({ project: "ops", bricks: GATED }, i)).toContain("only a first-party, non-isolated brick may mount an approval gate");
  });

  test("$capabilitySetting: an isolated taker gets a clear error; the provider must be first-party and not quarantined", () => {
    const isolated = clone();
    Object.assign(isolated.bricks["platform-admin"]!.manifest, { isolation: "dispatch" });
    expect(errorsOf({ project: "ops", bricks: [...MIN, "feature-flags"] }, isolated)).toContain(
      'platform-admin: option "flagOverridesAllowed" of createPlatformAdminRoutes names "feature-flags.allowWorkspaceOverrides", which an isolated brick cannot take',
    );
    const q = clone();
    quarantine(q.bricks["feature-flags"]!.manifest);
    expect(errorsOf({ project: "ops", bricks: [...MIN, "feature-flags"] }, q)).toContain(
      '"feature-flags.allowWorkspaceOverrides", but feature-flags is quarantined',
    );
    const u = clone();
    Object.assign(u.bricks["feature-flags"]!.manifest, { trust: "untrusted", isolation: "dispatch" });
    expect(errorsOf({ project: "ops", bricks: [...MIN, "feature-flags"] }, u)).toContain(
      '"feature-flags.allowWorkspaceOverrides", but feature-flags is not a first-party, non-isolated brick',
    );
  });
});

describe("platform-wide privacy tables (story 2.6)", () => {
  test("pa_user_approvals is declared retained and exported by user; the generated privacy code reads it by user id only", () => {
    const rule = catalog.bricks["platform-admin"]!.manifest.privacy?.tables?.pa_user_approvals;
    expect(rule).toMatchObject({ subject: "user", userColumn: "user_id", erase: "retain", export: true, platformWide: true });
    expect(rule?.retainReason).toMatch(/governance/);
    const result = assemble({ project: "ops", bricks: MIN }, catalog);
    if (!result.ok) throw new Error(result.errors.join("; "));
    const privacy = result.files["src/privacy.generated.ts"]!;
    expect(privacy).toContain("const PRIVACY_PLATFORM_TABLES");
    expect(privacy).toContain('"table": "pa_user_approvals"');
    // Never in the workspace-scoped list, whose queries add workspace_id.
    expect(privacy.slice(privacy.indexOf("const PRIVACY_TABLES"), privacy.indexOf("const PRIVACY_PLATFORM_TABLES"))).not.toContain("pa_user_approvals");
  });

  test("an app without a platform-wide table gets no platform-wide privacy code", () => {
    const result = assemble({ project: "plain", bricks: ["multi-workspace", "audit-trail", "credit-wallet"] }, catalog);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.files["src/privacy.generated.ts"]).not.toContain("PRIVACY_PLATFORM_TABLES");
  });

  test("platformWide is refused for a brick that is not first-party, is isolated or quarantined, or does not own the table", () => {
    const clone = (): Catalog => JSON.parse(JSON.stringify(catalog));
    const errorsOf = (c: Catalog) => {
      const result = assemble({ project: "ops", bricks: MIN }, c);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.errors.join("; ");
    };
    const q = clone();
    q.bricks["platform-admin"]!.manifest.ui = { ...q.bricks["platform-admin"]!.manifest.ui!, maturity: "experimental", maturityReason: "QUARANTINED: test" };
    expect(errorsOf(q)).toContain(
      'privacy table "pa_user_approvals" is platformWide, which only a first-party, non-isolated, non-quarantined brick may declare',
    );
    const u = clone();
    Object.assign(u.bricks["platform-admin"]!.manifest, { trust: "untrusted", isolation: "dispatch" });
    expect(errorsOf(u)).toContain("which only a first-party, non-isolated, non-quarantined brick may declare");
    const foreign = clone();
    const tables = foreign.bricks["platform-admin"]!.manifest.privacy!.tables!;
    tables.mw_workspaces = { ...tables.pa_user_approvals! };
    expect(errorsOf(foreign)).toContain('privacy table "mw_workspaces" is platformWide but is not one of platform-admin\'s own global tables');
    // The manifest schema refuses the same.
    const base = catalog.bricks["platform-admin"]!.manifest;
    const rule = base.privacy!.tables!.pa_user_approvals!;
    expect(ManifestSchema.safeParse({ ...base, privacy: { tables: { mw_workspaces: rule } } }).success).toBe(false);
    expect(ManifestSchema.safeParse({ ...base, trust: "untrusted", isolation: "dispatch" }).success).toBe(false);
  });

  test("platformWide is accepted only for a retained user table with a user column", () => {
    const base = catalog.bricks["platform-admin"]!.manifest;
    const withRule = (rule: Record<string, unknown>) => ManifestSchema.safeParse({ ...base, privacy: { tables: { pa_user_approvals: rule } } }).success;
    expect(withRule({ subject: "user", userColumn: "user_id", erase: "retain", retainReason: "r", export: true, platformWide: true })).toBe(true);
    expect(withRule({ subject: "user", userColumn: "user_id", erase: "delete", export: true, platformWide: true })).toBe(false);
    expect(withRule({ subject: "workspace", erase: "retain", retainReason: "r", export: true, platformWide: true })).toBe(false);
  });
});
