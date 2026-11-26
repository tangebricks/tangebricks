import { describe, expect, test } from "vitest";
import { ManifestSchema, secretDeclarations, secretNames } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";

// Story 1.19: a manifest secret is a name or { name, optional, generate }.

const baseBrick = {
  manifestVersion: 2,
  kind: "brick",
  id: "my-brick",
  version: "1.0.0",
  trust: "first-party",
  provides: [],
  requires: [],
  migrations: [],
  routePrefixes: ["my-brick"],
  npmDependencies: {},
  settings: {},
  worker: { package: "@poc/my-brick", routes: [] },
};

describe("manifest secret declarations (story 1.19)", () => {
  test("a name, an optional secret and a generated secret are all accepted, in any mix", () => {
    const parsed = ManifestSchema.safeParse({
      ...baseBrick,
      secrets: ["PLAIN_KEY", { name: "OPTIONAL_KEY", optional: true }, { name: "SIGNING_KEY", generate: "random-32-bytes" }, { name: "OBJECT_KEY" }],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(secretDeclarations(parsed.data!)).toEqual([
      { name: "PLAIN_KEY", optional: false },
      { name: "OPTIONAL_KEY", optional: true },
      { name: "SIGNING_KEY", optional: false, generate: "random-32-bytes" },
      { name: "OBJECT_KEY", optional: false },
    ]);
    expect(secretNames(parsed.data!)).toEqual(["PLAIN_KEY", "OPTIONAL_KEY", "SIGNING_KEY", "OBJECT_KEY"]);
  });

  test.each([
    ["both optional and generate", { name: "K", optional: true, generate: "random-32-bytes" }],
    ["an unknown generator", { name: "K", generate: "uuid" }],
    ["optional: false (only true is written)", { name: "K", optional: false }],
    ["an unknown key", { name: "K", rotate: true }],
    ["a name that is not an identifier", { name: "not-an-identifier" }],
  ])("refuses %s", (_label, declaration) => {
    expect(ManifestSchema.safeParse({ ...baseBrick, secrets: [declaration] }).success).toBe(false);
  });

  test("core-auth: BETTER_AUTH_SECRET is generated, the GitHub credentials are optional", () => {
    expect(secretDeclarations(catalog.bricks["core-auth"]!.manifest)).toEqual([
      { name: "BETTER_AUTH_SECRET", optional: false, generate: "random-32-bytes" },
      { name: "GITHUB_CLIENT_ID", optional: true },
      { name: "GITHUB_CLIENT_SECRET", optional: true },
    ]);
  });

  test("no catalog brick generates a third-party credential: only core-auth's own signing secret is generated", () => {
    const generated = Object.entries(catalog.bricks).flatMap(([id, b]) => secretDeclarations(b.manifest).filter((d) => d.generate).map((d) => `${id}.${d.name}`));
    expect(generated).toEqual(["core-auth.BETTER_AUTH_SECRET"]);
  });
});
