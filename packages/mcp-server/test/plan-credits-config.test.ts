// Story 1.20: an agent sets a plan's credits through MCP. get_brick shows subscription-plans' planCredits and
// creditPeriod settings; apply_ops configure_brick { planCredits: "free:100,pro:1000" } is validated (a bad value is
// refused with the expected format), is money-affecting (proposed by default, PROPOSAL_REQUIRED in mode apply under
// AD-V8), and once a reviewer accepts it the blueprint assembles to exactly the app that
// packages/assembler/test/plan-credits.attack.test.ts drives in workerd (test/support/blueprints.ts PLAN_CREDITS_BLUEPRINT).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { assemble } from "@poc/assembler";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_mcp_server.sql?raw";
import { classifyApplyRisk, createInMemoryBlueprintClient, createMcpApp } from "../src/index.ts";
import { testToken, testTokenVerifier } from "./support/test-verifier.ts";
import { PLAN_CREDITS_BLUEPRINT } from "../../../test/support/blueprints.ts";

const db = env.DB as D1Like;
const reviewer = { type: "human" as const, id: "user:reviewer" };
const PROJECT = PLAN_CREDITS_BLUEPRINT.project;
const assembledFiles = import.meta.glob("../../../out/plan-credits/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

beforeEach(async () => {
  for (const table of ["mcp_files", "mcp_builds", "mcp_projects", "mcp_rate"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, migration);
});

let rpcId = 1;
async function callTool(
  app: ReturnType<typeof createMcpApp>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; json: Record<string, any>; text: string }> {
  const res = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${testToken(String(args.project ?? PROJECT))}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    }),
    { DB: db },
  );
  const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  const text = body.result.content[0]?.text ?? "";
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    json = {};
  }
  return { isError: body.result.isError === true, json, text };
}

const configure = (config: Record<string, unknown>, opId = "credits") => [{ opId, type: "configure_brick", brickId: "subscription-plans", config }];

describe("plan credits through MCP (story 1.20)", () => {
  it("get_brick shows the planCredits and creditPeriod settings an agent can set", async () => {
    const app = createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier, blueprintClient: createInMemoryBlueprintClient(catalog) });
    const reply = await callTool(app, "get_brick", { id: "subscription-plans" });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.json.settings).toMatchObject({
      planCredits: 'text, e.g. free:100,pro:1000, default ""',
      creditPeriod: "one of month|year, default month",
    });
  });

  it("configure_brick planCredits is money-affecting, validated, proposed by default, and assembles to the driven app once accepted", async () => {
    const client = createInMemoryBlueprintClient(catalog);
    const app = createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier, blueprintClient: client });
    const seeded = await client.applyOps({
      project: PROJECT,
      author: reviewer,
      mode: "apply",
      ops: ["multi-workspace", "credit-wallet", "subscription-plans"].map((brickId) => ({ opId: `seed-${brickId}`, type: "enable_brick", brickId })),
    });
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);

    expect(classifyApplyRisk(configure({ planCredits: "free:100" })).reasons.join(";")).toContain("money setting: configure_brick:subscription-plans");

    const refused = await callTool(app, "apply_ops", { project: PROJECT, mode: "apply", ops: configure({ planCredits: "free:100,pro:1000" }) });
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe("PROPOSAL_REQUIRED");
    expect(refused.json.error.reasons.join(";")).toContain("money setting: configure_brick:subscription-plans");

    const bad = await callTool(app, "apply_ops", { project: PROJECT, ops: configure({ planCredits: "free=100" }) });
    expect(bad.isError, bad.text).toBe(true);
    expect(bad.text).toContain("INVALID_BRICK_CONFIG");
    expect(bad.text).toContain("free:100,pro:1000");

    const proposed = await callTool(app, "apply_ops", { project: PROJECT, ops: configure({ planCredits: "free:100,pro:1000" }) });
    expect(proposed.isError, proposed.text).toBe(false);
    expect(proposed.json).toMatchObject({ mode: "propose", status: "pending" });
    expect((await client.getProject(PROJECT))!.state.bricks.find((b) => b.id === "subscription-plans")!.config ?? {}).not.toHaveProperty("planCredits");

    const accepted = await client.acceptProposal!({ project: PROJECT, proposalId: proposed.json.proposalId as string, reviewer });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    const state = (await client.getProject(PROJECT))!.state;
    expect(state.bricks.find((b) => b.id === "subscription-plans")!.config).toEqual({ planCredits: "free:100,pro:1000" });

    const result = assemble(state, catalog);
    if (!result.ok) throw new Error(result.errors.join("; "));
    const driven = Object.fromEntries(Object.entries(assembledFiles).map(([path, text]) => [path.replace("../../../out/plan-credits/", ""), text]));
    expect(Object.keys(driven).length).toBeGreaterThan(5);
    for (const file of ["src/index.ts", "wrangler.jsonc", ...Object.keys(result.files).filter((f) => f.startsWith("migrations/"))]) {
      expect(result.files[file], file).toBe(driven[file]);
    }
  });
});
