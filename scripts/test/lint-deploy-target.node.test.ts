import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { STUDIO_DEPLOY_CLIENT_FILE, lintDeployTarget, scanStudioSourceForFakeControlPlane } from "../lint-deploy-target.ts";

// Story R53: a production Studio build cannot construct the in-memory Cloudflare fake. The checks are structural.

const ENVIRONMENTS = 'export const FAKE_DEPLOY_CLIENT_ENVIRONMENTS: readonly string[] = ["test", "development"];';
const ACCESSOR = [
  "export function getStudioFakeControlPlane(accountId: string, env: StudioDeployClientEnv | undefined): MockCloudflareControlPlane {",
  '  if (studioDeployClientMode(env) !== "fake") throw new StudioDeployClientConfigError("tests only");',
  "  return new MockCloudflareControlPlane();",
  "}",
];
const GUARDED = [
  "export function getStudioControlPlane(accountId: string, env?: StudioDeployClientEnv) {",
  '  if (studioDeployClientMode(env) === "fake") return getStudioFakeControlPlane(accountId, env);',
  "}",
  "export function getStudioVerificationClient(env?: StudioDeployClientEnv) {",
  '  if (studioDeployClientMode(env) === "fake") return new MockCloudflareControlPlane();',
  "}",
];
const scan = (lines: string[]) => scanStudioSourceForFakeControlPlane(lines.join("\n"), STUDIO_DEPLOY_CLIENT_FILE);

describe("lint-deploy-target: the fake control plane stays out of Studio's production paths", () => {
  test("the repository passes", () => {
    const result = lintDeployTarget(resolve(import.meta.dirname, "..", ".."));
    expect(result.issues).toEqual([]);
  });

  test("a Studio route that constructs or reaches the fake is refused", () => {
    const route = `import { MockCloudflareControlPlane } from "x";\nconst cp = new MockCloudflareControlPlane();\nconst f = getStudioFakeControlPlane(accountId, env);`;
    const issues = scanStudioSourceForFakeControlPlane(route, "apps/studio-api/src/index.ts");
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3]);
    expect(issues.every((i) => i.rule === "FAKE_CONTROL_PLANE_IN_PRODUCTION_PATH")).toBe(true);
  });

  test("Studio may not construct ByocCloudflareTarget (fake and made-up token by default)", () => {
    const src = "const a = new ByocCloudflareTarget();\nconst b = ByocCloudflareTarget.create({});\nexport { ByocCloudflareTarget };";
    expect(scanStudioSourceForFakeControlPlane(src, "apps/studio-api/src/index.ts").map((i) => i.line)).toEqual([1, 2]);
  });

  test("deploy-client.ts in its guarded shape passes", () => {
    expect(scan([ENVIRONMENTS, ...ACCESSOR, ...GUARDED])).toEqual([]);
  });

  test("an unguarded construction is refused", () => {
    expect(scan([ENVIRONMENTS, ...ACCESSOR, "export function v() {", "  return new MockCloudflareControlPlane();", "}"]).map((i) => i.line)).toEqual([7]);
  });

  test("a guard line with anything else on it is refused (not a substring match)", () => {
    const sneaky = [
      ENVIRONMENTS,
      ...ACCESSOR,
      "export function v(env) {",
      '  if (studioDeployClientMode(env) === "fake" || true) return new MockCloudflareControlPlane();',
      "}",
    ];
    expect(scan(sneaky).map((i) => i.line)).toEqual([7]);
    const extra = [
      ENVIRONMENTS,
      ...ACCESSOR,
      "export function v(env) {",
      '  const x = 1; if (studioDeployClientMode(env) === "fake") return new MockCloudflareControlPlane();',
      "}",
    ];
    expect(scan(extra).map((i) => i.line)).toEqual([7]);
    const call = [
      ENVIRONMENTS,
      ...ACCESSOR,
      "export function v(env) {",
      '  if (studioDeployClientMode(env) === "fake") return getStudioFakeControlPlane(other, env) ?? null;',
      "}",
    ];
    expect(scan(call).map((i) => i.line)).toEqual([7]);
  });

  test("a guard wrapped over two lines (as Prettier prints it) still counts as the opening guard", () => {
    const wrapped = [
      ACCESSOR[0]!,
      '  if (studioDeployClientMode(env) !== "fake")',
      '    throw new StudioDeployClientConfigError("tests only");',
      ...ACCESSOR.slice(2),
    ];
    expect(scan([ENVIRONMENTS, ...wrapped, ...GUARDED])).toEqual([]);
  });

  test("a wrapped first statement that is not the guard is refused", () => {
    const wrongFirst = [
      ACCESSOR[0]!,
      "  const cp =",
      "    new MockCloudflareControlPlane();",
      '  if (studioDeployClientMode(env) !== "fake") throw new StudioDeployClientConfigError("tests only");',
      "  return cp;",
      "}",
    ];
    expect(scan([ENVIRONMENTS, ...wrongFirst, ...GUARDED]).map((i) => i.line)).toContain(2);
  });

  test("the accessor must open with its own guard", () => {
    const unguardedAccessor = [ENVIRONMENTS, ACCESSOR[0]!, "  return new MockCloudflareControlPlane();", "}", ...GUARDED];
    expect(scan(unguardedAccessor).map((i) => i.line)).toEqual([2]);
  });

  test("the fake must be kept to PX_ENVIRONMENT test/development", () => {
    expect(scan([...ACCESSOR, ...GUARDED])).toHaveLength(1);
  });
});
