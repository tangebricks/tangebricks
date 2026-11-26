// Story 1.21: a manifest text that claims a stub needs a px-stub marker in the brick's src, and a marker needs a claim.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { ManifestSchema } from "../../packages/assembler/src/schemas.ts";
import {
  checkAllBrickClaims,
  checkBrickClaims,
  findStubMarkers,
  formatBrickClaimViolation,
} from "../check-brick-claims.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function fixtureBricks(
  bricks: Record<string, { summary?: string; maturityReason?: string; description?: string; src?: Record<string, string> }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "px-brick-claims-"));
  tempDirs.push(root);
  for (const [id, spec] of Object.entries(bricks)) {
    const dir = join(root, id);
    mkdirSync(join(dir, "src"), { recursive: true });
    const manifest = {
      id,
      ...(spec.description ? { description: spec.description } : {}),
      ui: {
        displayName: id,
        category: "data",
        summary: spec.summary ?? "Stores rows.",
        maturity: spec.maturityReason ? "beta" : "production",
        ...(spec.maturityReason ? { maturityReason: spec.maturityReason } : {}),
      },
    };
    writeFileSync(join(dir, "brick.manifest.json"), JSON.stringify(manifest, null, 2));
    for (const [file, text] of Object.entries(spec.src ?? { "index.ts": "export const x = 1;\n" })) {
      mkdirSync(dirname(join(dir, "src", file)), { recursive: true });
      writeFileSync(join(dir, "src", file), text);
    }
  }
  return root;
}

const runCli = (bricksDir: string) =>
  spawnSync(process.execPath, [join(repoRoot, "scripts", "check-brick-claims.ts"), "--bricks-dir", bricksDir], { encoding: "utf8" });

describe("check:brick-claims (story 1.21)", () => {
  test("the repository passes: every stub claim has a marker in src, and every marker a claim", () => {
    expect(checkAllBrickClaims(join(repoRoot, "bricks")).map(formatBrickClaimViolation)).toEqual([]);
  });

  test("checkout-gateway's text matches its code: no stubbed provider APIs, a marked synthetic placeholder URL", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "bricks", "checkout-gateway", "brick.manifest.json"), "utf8")) as {
      ui: { maturityReason: string };
    };
    expect(manifest.ui.maturityReason).not.toMatch(/Razorpay|LemonSqueezy|API calls are stubbed/);
    expect(manifest.ui.maturityReason).toMatch(/Stripe, Cashfree adapters/);
    expect(manifest.ui.maturityReason).toMatch(/none is wired by default/);
    const markers = findStubMarkers(join(repoRoot, "bricks", "checkout-gateway"));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ file: "src/checkout.ts" });
    expect(markers[0]!.what).toMatch(/synthetic placeholder/);
  });

  test("every quarantined brick marks the quarantined code path", () => {
    const quarantined = ["admin-console", "agent-sandbox", "custom-domains", "document-pdf", "marketplace-splits", "oauth-server", "realtime-presence", "workflow-dag"];
    for (const id of quarantined) {
      expect(findStubMarkers(join(repoRoot, "bricks", id)).length, id).toBeGreaterThan(0);
    }
  });

  test("a stale claim (stubbed, no px-stub marker in src) fails naming the brick, the field and the claim", () => {
    const dir = fixtureBricks({ "stale-brick": { maturityReason: "Provider API calls are stubbed with synthetic URLs" } });
    const lines = checkAllBrickClaims(dir).map(formatBrickClaimViolation);
    expect(lines).toEqual([
      'stale-brick: brick-claims: ui.maturityReason claims "stubbed" but no "px-stub: <what>" marker is in stale-brick/src; mark the stubbed code path or correct the text to say what the code does',
    ]);
    const cli = runCli(dir);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('stale-brick: brick-claims: ui.maturityReason claims "stubbed"');
  });

  test("each claim word in summary, maturityReason or description needs a marker", () => {
    const dir = fixtureBricks({
      a: { summary: "A fake mailer." },
      b: { description: "Sends nothing: the provider is not configured." },
      c: { maturityReason: "QUARANTINED: unsafe" },
      d: { summary: "Synthetic data." },
    });
    expect(checkAllBrickClaims(dir).map((v) => [v.brick, v.detail.split(" but ")[0]])).toEqual([
      ["a", 'ui.summary claims "fake"'],
      ["b", 'description claims "not configured"'],
      ["c", 'ui.maturityReason claims "QUARANTINED"'],
      ["d", 'ui.summary claims "Synthetic"'],
    ]);
  });

  test("a hidden stub (px-stub marker, no claim in the texts) fails naming the brick and the marker", () => {
    const dir = fixtureBricks({
      "hidden-brick": { summary: "Sends email.", src: { "send.ts": "export function send() {\n  // px-stub: never calls the provider\n  return true;\n}\n" } },
    });
    expect(checkAllBrickClaims(dir).map(formatBrickClaimViolation)).toEqual([
      'hidden-brick: brick-claims: src/send.ts:2 has "px-stub: never calls the provider" but no description, ui.summary or ui.maturityReason says stub, synthetic, fake, not configured or quarantined',
    ]);
    expect(runCli(dir).status).toBe(1);
  });

  test("a claim with a marker passes; an empty marker fails; an error code such as NOT_CONFIGURED is not a claim", () => {
    const dir = fixtureBricks({
      honest: { maturityReason: "Stub: verify reports success without a DNS call", src: { "lib/verify.ts": "/* px-stub: no DNS call */\nexport const ok = true;\n" } },
      empty: { maturityReason: "Stub: returns a fixed answer", src: { "index.ts": "// px-stub:\nexport const ok = true;\n" } },
      coded: { maturityReason: "Payment routes answer 503 NOT_CONFIGURED until a gateway is passed" },
    });
    expect(checkBrickClaims(join(dir, "honest"), "honest")).toEqual([]);
    expect(checkBrickClaims(join(dir, "coded"), "coded")).toEqual([]);
    expect(checkBrickClaims(join(dir, "empty"), "empty").map((v) => v.detail)).toEqual([
      'src/index.ts:1 has an empty "px-stub:" marker; say what is stubbed ("px-stub: <what>")',
    ]);
  });

  test("catalog:conformance runs the claims check and fails on a stale claim", () => {
    const script = readFileSync(join(repoRoot, "scripts", "check-manifests.ts"), "utf8");
    expect(script).toMatch(/checkAllBrickClaims\(bricksDir\)/);
    expect(script).toMatch(/claimViolations\.length > 0 \? 1 : 0/);
  });
});

describe("ui.keywords in the manifest schema (story 1.21)", () => {
  const base = JSON.parse(readFileSync(join(repoRoot, "bricks", "multi-workspace", "brick.manifest.json"), "utf8")) as {
    ui: Record<string, unknown>;
  };
  const withKeywords = (keywords: unknown) => ManifestSchema.safeParse({ ...base, ui: { ...base.ui, keywords } });

  test("accepts up to 12 lowercase words of up to 24 characters", () => {
    expect(withKeywords(["teams", "multitenant", "b2b-saas"]).success).toBe(true);
    expect(withKeywords(Array.from({ length: 12 }, (_, i) => `word${i}`)).success).toBe(true);
    expect(withKeywords(["a".repeat(24)]).success).toBe(true);
  });

  test("refuses more than 12, upper case, spaces, long or repeated words", () => {
    expect(withKeywords(Array.from({ length: 13 }, (_, i) => `word${i}`)).success).toBe(false);
    expect(withKeywords(["Teams"]).success).toBe(false);
    expect(withKeywords(["two words"]).success).toBe(false);
    expect(withKeywords(["a".repeat(25)]).success).toBe(false);
    expect(withKeywords(["teams", "teams"]).success).toBe(false);
  });

  test("the bricks agents search for by plain words carry those keywords", () => {
    const required: Record<string, string[]> = {
      "multi-workspace": ["teams", "tenants", "multitenant", "organizations"],
      "dynamic-entities": ["database", "tables", "crud", "records"],
      "credit-wallet": ["credits", "billing", "balance"],
      "checkout-gateway": ["payments", "stripe", "cashfree"],
      "core-auth": ["login", "signup", "password"],
      "subscription-plans": ["plans", "pricing", "tiers"],
    };
    for (const [id, words] of Object.entries(required)) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, "bricks", id, "brick.manifest.json"), "utf8")) as { ui: { keywords?: string[] } };
      for (const word of words) expect(manifest.ui.keywords, `${id} keywords`).toContain(word);
    }
  });
});
