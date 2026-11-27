import { describe, expect, test } from "vitest";
import { assemble, hashFiles } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";

// The assembler runs inside a Worker as well as in Node (the MCP endpoint's build_project calls it). This is that
// claim, tested where it matters: in workerd, which has no file system and no Node modules.
const blueprint = { project: "invoice-flow", bricks: ["multi-workspace", { id: "credit-wallet", config: { creditsPerUnit: 10 } }] };

describe("the assembler in workerd", () => {
  test("assembles the two-brick blueprint", () => {
    const result = assemble(blueprint, catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(["multi-workspace", "credit-wallet"]);
    // 11 since story 0.21 (credit-wallet's rate limits bring the px_rate_limits migration); 12 since story 2.3
    // (credit-wallet's order currency migration).
    expect(Object.keys(result.files)).toHaveLength(14); // story 2.5: credit-wallet's 0004; story 2.8: multi-workspace's 0002
    expect(result.files["src/index.ts"]).toContain("creditsPerUnit: 10");
  });

  test("two runs give the same files and the same hashes", async () => {
    const a = assemble(blueprint, catalog);
    const b = assemble(blueprint, catalog);
    if (!a.ok || !b.ok) throw new Error("assembly failed");
    expect(a.files).toEqual(b.files);
    const hashes = await hashFiles(a.files);
    expect(hashes).toEqual(await hashFiles(b.files));
    expect(Object.values(hashes).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(Object.keys(hashes)).toEqual(Object.keys(a.files));
  });

  test("a refused blueprint is refused here too, with the same reason", () => {
    const result = assemble({ project: "p", bricks: ["credit-wallet"] }, catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/credit-wallet requires "workspace-context"/);
  });

  test("the hash is SHA-256 (a known test vector)", async () => {
    const { sha256Hex } = await import("../src/index.ts");
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("adding or modifying workflows and secretRefs emits src/workflows.json, updates project.json, and changes buildHash", async () => {
    const { sha256Hex } = await import("../src/index.ts");
    const computeBuildHash = async (files: Record<string, string>) => {
      const hashes = await hashFiles(files);
      return sha256Hex(
        Object.entries(hashes)
          .map(([p, h]) => `${p}\n${h}`)
          .join("\n"),
      );
    };

    const baseRes = assemble(blueprint, catalog);
    expect(baseRes.ok).toBe(true);
    if (!baseRes.ok) return;
    expect(baseRes.files["src/workflows.json"]).toBeUndefined();
    const baseHash = await computeBuildHash(baseRes.files);

    const withWfRes = assemble(
      {
        ...blueprint,
        workflows: [
          {
            id: "wf-1",
            name: "Billing Flow",
            nodes: [{ id: "n1", type: "trigger.manual", data: { step: 1 } }],
            edges: [],
          },
        ],
      },
      catalog,
    );
    expect(withWfRes.ok).toBe(true);
    if (!withWfRes.ok) return;
    expect(withWfRes.files["src/workflows.json"]).toContain('"id": "wf-1"');
    const wfHash1 = await computeBuildHash(withWfRes.files);
    expect(wfHash1).not.toBe(baseHash);

    const withModifiedWfRes = assemble(
      {
        ...blueprint,
        workflows: [
          {
            id: "wf-1",
            name: "Billing Flow",
            nodes: [{ id: "n1", type: "trigger.manual", data: { step: 2 } }],
            edges: [],
          },
        ],
      },
      catalog,
    );
    expect(withModifiedWfRes.ok).toBe(true);
    if (!withModifiedWfRes.ok) return;
    const wfHash2 = await computeBuildHash(withModifiedWfRes.files);
    expect(wfHash2).not.toBe(wfHash1);

    const withSecretRefRes = assemble(
      {
        ...blueprint,
        secretRefs: [
          {
            ref: "sec_wallet_key",
            targetKind: "brick",
            targetId: "credit-wallet",
            secretName: "WEBHOOK_SECRET",
          },
        ],
      },
      catalog,
    );
    expect(withSecretRefRes.ok).toBe(true);
    if (!withSecretRefRes.ok) return;
    expect(withSecretRefRes.files["project.json"]).toContain("sec_wallet_key");
    const secretHash = await computeBuildHash(withSecretRefRes.files);
    expect(secretHash).not.toBe(baseHash);
  });
});
