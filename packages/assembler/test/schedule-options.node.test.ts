// Story 1.20: schedule options and conditional wiring. A manifest schedule may take `options` (resolved like route
// options: `$setting`, `$capability`, ...) and `enabledWhen` (wired only while a condition on the brick's settings holds);
// a `$setting` or `$capability` option may be `requiredWhen` a setting `notEquals` a value. subscription-plans uses all
// three for plan credits; with `planCredits` empty its app is wired as before and the only change is the additive
// migration 0002 (nullable columns and an index); existing schedules (cron-alarms) are called exactly as before.
import { describe, expect, test } from "vitest";
import { ManifestSchema, assemble } from "../src/index.ts";
import type { Catalog } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";

const filesOf = (input: unknown, c: Catalog = catalog) => {
  const result = assemble(input, c);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.files;
};
const plans = (config: Record<string, unknown> = {}) => ({ id: "subscription-plans", config });

describe("subscription-plans plan credits wiring (story 1.20)", () => {
  test("with planCredits set and credit-wallet enabled, the route and the schedule both get the settings and the charger", () => {
    const files = filesOf({ project: "pc", bricks: ["multi-workspace", "credit-wallet", plans({ planCredits: "free:100", creditPeriod: "year" })] });
    const entry = files["src/index.ts"]!;
    expect(entry).toMatch(/import \{[^}]*\bwalletCharger\b[^}]*\} from "@poc\/credit-wallet";/);
    expect(entry).toMatch(/import \{ createPlanRoutes, runPlanCreditSweep \} from "@poc\/subscription-plans";/);
    expect(entry).toContain('createPlanRoutes({ defaultTier: "free", planCredits: "free:100", creditPeriod: "year", charger: walletCharger })');
    expect(entry).toContain(
      'await runPlanCreditSweep({ controller, env, ctx, dueRows: dueRows.filter((r) => r.brick_id === "subscription-plans"), options: { planCredits: "free:100", creditPeriod: "year", charger: walletCharger } });',
    );
    expect(entry).toContain("  scheduled,");
    expect(files["wrangler.jsonc"]).toContain('"crons"');
    expect(Object.keys(files).some((f) => f.endsWith("_shell__px_schedules.sql"))).toBe(true);
  });

  test("with planCredits empty, the only change is the additive migration 0002: the migration list differs by that file alone", () => {
    const base = catalog.bricks["subscription-plans"]!;
    const manifest = structuredClone(base.manifest);
    manifest.migrations = manifest.migrations.filter((m) => !m.endsWith("0002_plan_credits.sql"));
    const without = { ...catalog, bricks: { ...catalog.bricks, "subscription-plans": { ...base, manifest } } };
    const migrationsOf = (files: Record<string, string>) =>
      Object.keys(files)
        .filter((f) => f.startsWith("migrations/"))
        .map((f) => f.replace(/^migrations\/\d+_/, ""))
        .sort();
    for (const bricks of [
      ["multi-workspace", "subscription-plans"],
      ["multi-workspace", "credit-wallet", "subscription-plans"],
    ]) {
      const now = filesOf({ project: "pc", bricks });
      const before = filesOf({ project: "pc", bricks }, without);
      const added = migrationsOf(now).filter((m) => !migrationsOf(before).includes(m));
      expect(added).toEqual(["subscription-plans__0002_plan_credits.sql"]);
      expect(migrationsOf(before).filter((m) => !migrationsOf(now).includes(m))).toEqual([]);
      const routeLine = (files: Record<string, string>) => files["src/index.ts"]!.split("\n").find((l) => l.includes("createPlanRoutes("));
      expect(routeLine(now)).toBe(routeLine(before));
      expect(now["wrangler.jsonc"]).toBe(before["wrangler.jsonc"]);
    }
  });

  test("with planCredits empty, nothing new is wired: no charger, no schedule, no cron, no credit-wallet needed", () => {
    for (const bricks of [
      ["multi-workspace", "subscription-plans"],
      ["multi-workspace", plans({ planCredits: "", creditPeriod: "year" })],
      ["multi-workspace", "credit-wallet", "subscription-plans"],
    ]) {
      const files = filesOf({ project: "pc", bricks });
      const entry = files["src/index.ts"]!;
      expect(entry).toContain('app.route("/api", createPlanRoutes({ defaultTier: "free" }));');
      expect(entry).not.toContain("runPlanCreditSweep");
      expect(entry).not.toContain("walletCharger");
      expect(entry).not.toContain("async function scheduled");
      expect(entry).toContain("export default app;");
      expect(files["wrangler.jsonc"]).not.toContain('"crons"');
      expect(Object.keys(files).some((f) => f.includes("px_schedules"))).toBe(false);
    }
  });

  test("with planCredits set and no credit-wallet, assembly is refused with a message naming credit-wallet", () => {
    const result = assemble({ project: "pc", bricks: ["multi-workspace", plans({ planCredits: "free:100" })] }, catalog);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.errors.join("\n");
    expect(message).toContain('subscription-plans: option "charger" of createPlanRoutes needs "credit-wallet" (its walletCharger)');
    expect(message).toContain('subscription-plans: option "charger" of schedule plan-credits needs "credit-wallet"');
    expect(message).toContain("enable one of: credit-wallet");
    expect(message).toContain('setting "planCredits" to ""');
  });

  test("a malformed planCredits or creditPeriod is refused with the expected format", () => {
    for (const planCredits of [
      "free",
      "free:-1",
      "free:1.5",
      "Free:100",
      "free:100,",
      "free:100 ,pro:1",
      Array.from({ length: 21 }, (_, i) => `t${i}:1`).join(","),
    ]) {
      const result = assemble({ project: "pc", bricks: ["multi-workspace", "credit-wallet", plans({ planCredits })] }, catalog);
      expect(result.ok, planCredits).toBe(false);
      if (!result.ok) expect(result.errors.join("; ")).toContain('setting "planCredits" is not in the expected format (for example "free:100,pro:1000")');
    }
    expect(assemble({ project: "pc", bricks: ["multi-workspace", "credit-wallet", plans({ creditPeriod: "week" })] }, catalog).ok).toBe(false);
    for (const planCredits of ["free:0", "free:100,pro:1000,enterprise:999999999", "team-2.x:5"]) {
      expect(assemble({ project: "pc", bricks: ["multi-workspace", "credit-wallet", plans({ planCredits })] }, catalog).ok, planCredits).toBe(true);
    }
  });
});

describe("schedule options and enabledWhen (story 1.20)", () => {
  /** The catalog with cron-alarms' manifest changed by `patch`. */
  const withCron = (patch: (m: Catalog["bricks"][string]["manifest"]) => void): Catalog => {
    const base = catalog.bricks["cron-alarms"]!;
    const manifest = structuredClone(base.manifest);
    patch(manifest);
    return { ...catalog, bricks: { ...catalog.bricks, "cron-alarms": { ...base, manifest } } };
  };
  const cronApp = { project: "cron-app", bricks: ["multi-workspace", "cron-alarms"] };

  test("a schedule without options is called exactly as before, and `options: {}` changes no byte", () => {
    const files = filesOf(cronApp);
    expect(files["src/index.ts"]).toContain(
      '  await runScheduledCronAlarms({ controller, env, ctx, dueRows: dueRows.filter((r) => r.brick_id === "cron-alarms") });\n',
    );
    expect(
      filesOf(
        cronApp,
        withCron((m) => (m.triggers!.schedules![0]!.options = {})),
      ),
    ).toEqual(files);
    // An enabledWhen that holds changes nothing either.
    expect(
      filesOf(
        cronApp,
        withCron((m) => (m.triggers!.schedules![0]!.enabledWhen = { setting: "maxSchedulesPerWorkspace", notEquals: 0 })),
      ),
    ).toEqual(files);
  });

  test("schedule options resolve settings and capabilities like route options", () => {
    const c = withCron((m) => {
      m.triggers!.schedules![0]!.options = {
        max: { $setting: "maxSchedulesPerWorkspace" },
        label: "x",
        on: true,
        charger: { $capability: "credit-wallet.walletCharger" },
      };
    });
    const entry = filesOf({ ...cronApp, bricks: [...cronApp.bricks, "credit-wallet"] }, c)["src/index.ts"]!;
    expect(entry).toContain('options: { max: 50, label: "x", on: true, charger: walletCharger } });');
    expect(entry).toMatch(/import \{[^}]*\bwalletCharger\b[^}]*\} from "@poc\/credit-wallet";/);
    const refused = assemble(cronApp, c);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.join("; ")).toContain('cron-alarms: option "charger" of schedule due-schedules needs "credit-wallet"');
  });

  test("a schedule whose enabledWhen does not hold is not wired, and its options are neither checked nor imported", () => {
    const c = withCron((m) => {
      m.triggers!.schedules![0]!.enabledWhen = { setting: "maxSchedulesPerWorkspace", equals: 7 };
      m.triggers!.schedules![0]!.options = { charger: { $capability: "credit-wallet.walletCharger" } };
    });
    const off = filesOf(cronApp, c);
    expect(off["src/index.ts"]).not.toContain("runScheduledCronAlarms");
    expect(off["src/index.ts"]).not.toContain("async function scheduled");
    expect(off["wrangler.jsonc"]).not.toContain('"crons"');
    const on = assemble({ project: "cron-app", bricks: ["multi-workspace", { id: "cron-alarms", config: { maxSchedulesPerWorkspace: 7 } }] }, c);
    expect(on.ok).toBe(false); // now wired, so its charger needs credit-wallet
  });

  test("a $setting option with requiredWhen is passed only while the condition holds", () => {
    const base = catalog.bricks["llm-gateway"]!;
    const manifest = structuredClone(base.manifest);
    manifest.worker.routes[0]!.options = {
      ...manifest.worker.routes[0]!.options,
      maxTokens: { $setting: "maxTokens", requiredWhen: { setting: "billingMode", notEquals: "none" } },
    };
    const c = { ...catalog, bricks: { ...catalog.bricks, "llm-gateway": { ...base, manifest } } };
    const ai = (billingMode: string) =>
      filesOf({ project: "ai", bricks: ["multi-workspace", "credit-wallet", { id: "llm-gateway", config: { billingMode } }] }, c)["src/index.ts"]!.match(
        /createAiRoutes\(([^)]*)\)/,
      )![1]!;
    expect(ai("wallet")).toContain("maxTokens: 4096");
    expect(ai("none")).not.toContain("maxTokens");
  });

  test("an isolated brick's schedule cannot take another brick's export", () => {
    const c = withCron((m) => {
      m.isolation = "dispatch";
      m.triggers!.schedules![0]!.options = { charger: { $capability: "credit-wallet.walletCharger" } };
    });
    const result = assemble({ ...cronApp, bricks: [...cronApp.bricks, "credit-wallet"] }, c);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.join("; ")).toContain(
        'option "charger" of schedule due-schedules names "credit-wallet.walletCharger", which an isolated brick cannot take',
      );
  });

  test("the manifest schema checks schedule options, enabledWhen and the notEquals form", () => {
    const parse = (patch: (m: Catalog["bricks"][string]["manifest"]) => void) => ManifestSchema.safeParse(withCron(patch).bricks["cron-alarms"]!.manifest);
    expect(parse(() => {}).success).toBe(true);
    expect(parse((m) => (m.triggers!.schedules![0]!.options = { max: { $setting: "maxSchedulesPerWorkspace" } })).success).toBe(true);
    const unknownSetting = parse((m) => (m.triggers!.schedules![0]!.options = { max: { $setting: "nope" } }));
    expect(unknownSetting.success).toBe(false);
    expect(JSON.stringify(unknownSetting.error?.issues)).toContain('schedule due-schedules option max uses unknown setting \\"nope\\"');
    const unknownWhen = parse((m) => (m.triggers!.schedules![0]!.enabledWhen = { setting: "nope", notEquals: "" }));
    expect(unknownWhen.success).toBe(false);
    expect(JSON.stringify(unknownWhen.error?.issues)).toContain('schedule due-schedules is enabled when unknown setting \\"nope\\" is set');
    const unknownRequired = parse(
      (m) => (m.triggers!.schedules![0]!.options = { c: { $capability: "credit-wallet.walletCharger", requiredWhen: { setting: "nope", notEquals: "" } } }),
    );
    expect(unknownRequired.success).toBe(false);
    for (const bad of [
      { setting: "maxSchedulesPerWorkspace" },
      { setting: "maxSchedulesPerWorkspace", equals: 1, notEquals: 2 },
      { setting: "maxSchedulesPerWorkspace", differs: 1 },
    ]) {
      expect(parse((m) => (m.triggers!.schedules![0]!.enabledWhen = bad as never)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ManifestSchema.safeParse(catalog.bricks["subscription-plans"]!.manifest).success).toBe(true);
  });
});
