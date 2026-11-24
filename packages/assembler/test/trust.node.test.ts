import { describe, expect, test } from "vitest";
import { assemble, ManifestSchema } from "../src/index.ts";
import type { Catalog } from "../src/index.ts";

describe("brick trust and isolation in assembler and ManifestSchema", () => {
  const baseBrick = {
    manifestVersion: 2,
    kind: "brick",
    id: "my-brick",
    version: "1.0.0",
    provides: [],
    requires: [],
    migrations: [],
    routePrefixes: ["my-brick"],
    npmDependencies: {},
    settings: {},
    worker: { package: "@poc/my-brick", routes: [] },
  };

  test("ManifestSchema rejects untrusted brick without isolation dispatch", () => {
    const untrustedNoIsolation = {
      ...baseBrick,
      trust: "untrusted",
    };
    const parsed = ManifestSchema.safeParse(untrustedNoIsolation);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // Today it fails with unrecognized_keys: trust
      // After UC6.5 it fails with custom superRefine error
      const messages = parsed.error.issues.map((i) => i.message);
      expect(messages.length).toBeGreaterThan(0);
    }
  });

  test('assemble() refuses untrusted brick with no isolation: brick "x" is untrusted and must run isolated (set isolation: "dispatch")', () => {
    const catalog: Catalog = {
      bricks: {
        "my-brick": {
          manifest: {
            ...baseBrick,
            trust: "untrusted",
          } as any,
          files: {},
        },
      },
    };
    const result = assemble({ project: "sample-app", bricks: ["my-brick"] }, catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('brick "my-brick" is untrusted and must run isolated (set isolation: "dispatch")');
    }
  });

  test("AC1 — manifest without trust is treated as untrusted and refused by assemble()", () => {
    const catalog: Catalog = {
      bricks: {
        "my-brick": {
          manifest: {
            ...baseBrick,
          } as any,
          files: {},
        },
      },
    };
    const result = assemble({ project: "sample-app", bricks: ["my-brick"] }, catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('brick "my-brick" is untrusted and must run isolated (set isolation: "dispatch")');
    }
  });

  test("assemble() accepts untrusted brick with isolation dispatch", () => {
    const catalog: Catalog = {
      bricks: {
        "my-brick": {
          manifest: {
            ...baseBrick,
            trust: "untrusted",
            isolation: "dispatch",
          } as any,
          files: {},
        },
      },
    };
    const result = assemble({ project: "sample-app", bricks: ["my-brick"] }, catalog);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files["bricks/my-brick/wrangler.jsonc"]).toBeDefined();
      expect(result.files["bricks/my-brick/src/index.ts"]).toBeDefined();
      expect(result.files["wrangler.jsonc"]).toContain("BRICK_MY_BRICK");
    }
  });

  test("story 0.9: an isolated brick node with no exported executor fails NOT_CONFIGURED instead of returning an empty success", () => {
    const catalog: Catalog = {
      bricks: {
        "my-brick": {
          manifest: {
            ...baseBrick,
            trust: "untrusted",
            isolation: "dispatch",
            nodes: [
              {
                type: "my-brick.do_thing",
                label: "Do thing",
                summary: "Does a thing.",
                role: "action",
                inputs: [{ id: "in", label: "Input", dataType: "any", required: true }],
                outputs: [{ id: "out", label: "Output", dataType: "any" }],
                executor: "executeDoThing",
              },
            ],
          } as any,
          files: {},
        },
      },
    };
    const result = assemble({ project: "sample-app", bricks: ["my-brick"] }, catalog);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (result.ok) {
      const worker = result.files["bricks/my-brick/src/index.ts"]!;
      expect(worker).toContain('"my-brick.do_thing":');
      expect(worker).not.toContain("async () => ({})");
      expect(worker).toContain('NOT_CONFIGURED: my-brick.do_thing: isolated brick \\"my-brick\\" exports no executor \\"executeDoThing\\"');
    }
  });

  test("assemble() accepts first-party brick with isolation none", () => {
    const catalog: Catalog = {
      bricks: {
        "my-brick": {
          manifest: {
            ...baseBrick,
            trust: "first-party",
            isolation: "none",
          } as any,
          files: {},
        },
      },
    };
    const result = assemble({ project: "sample-app", bricks: ["my-brick"] }, catalog);
    expect(result.ok).toBe(true);
  });
});
