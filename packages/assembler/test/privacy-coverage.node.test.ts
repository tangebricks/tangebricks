import { describe, expect, test } from "vitest";
import { assemble } from "../src/index.ts";
import type { Catalog } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";

describe("Privacy & GDPR coverage enforcement in assembler (UC9.2)", () => {
  test("a catalog brick with a workspace_id table and no privacy entry fails assemble() with specific error", () => {
    // Clone catalog and remove privacy block from credit-wallet
    const testCatalog: Catalog = JSON.parse(JSON.stringify(catalog));
    delete (testCatalog.bricks["credit-wallet"]!.manifest as any).privacy;

    const blueprint = {
      project: "test-privacy-check",
      bricks: ["multi-workspace", "credit-wallet"],
    };

    const result = assemble(blueprint, testCatalog);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected assemble to fail");

    const found = result.errors.some((err) =>
      err.includes('table "credit_wallets" (brick credit-wallet) has workspace_id but no privacy rule'),
    );
    expect(found).toBe(true);
  });

  test("AC1: removing any one table from privacy.tables makes assemble() fail naming the table", () => {
    const testCatalog: Catalog = JSON.parse(JSON.stringify(catalog));
    const manifest = testCatalog.bricks["credit-wallet"]!.manifest as any;
    if (manifest.privacy?.tables) {
      delete manifest.privacy.tables["credit_wallets"];
    }

    const blueprint = {
      project: "test-privacy-omitted-table",
      bricks: ["multi-workspace", "credit-wallet"],
    };

    const result = assemble(blueprint, testCatalog);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected assemble to fail");

    expect(result.errors).toContain(
      'table "credit_wallets" (brick credit-wallet) has workspace_id but no privacy rule',
    );
  });

  test("assemble() emits src/privacy.generated.ts with exportTenant and eraseTenant", () => {
    const blueprint = {
      project: "test-privacy-emit",
      bricks: ["multi-workspace", "credit-wallet"],
    };

    const result = assemble(blueprint, catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));

    expect(result.files["src/privacy.generated.ts"]).toBeDefined();
    const source = result.files["src/privacy.generated.ts"]!;
    expect(source).toContain("export async function exportTenant");
    expect(source).toContain("export async function eraseTenant");
  });
});
