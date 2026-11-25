// Story 1.13 (threat model A1-A4, PROPOSED-7), against the assembled max-compatible app in workerd. llm-gateway and
// credit-wallet are both enabled, so the assembler wires credit-wallet's walletCharger into llm-gateway's routes
// (`$capability`); llm-gateway does not import credit-wallet. No provider is connected in the assembled app, so a fake
// provider stands in for "workers-ai" (the default provider) by replacing LlmGatewayService's adapter lookup.
// (Imported by path: it resolves to the same module the assembled entry imports as @poc/llm-gateway.)
//
//   - Alice generates in workspace A: A's real wallet is debited the call's maximum once (ledger key ai:<log id>) and
//     the unused part refunded once (ai:<log id>:refund), so it pays the model's actual cost; Bob's workspace B keeps
//     its balance and has no ledger row.
//   - Parallel calls on one balance: only those the balance covers reserve and generate; the rest get 402.
//   - With too little in A's wallet the call answers 402 INSUFFICIENT_CREDITS: nothing is generated or charged.
//   - An unknown model gets 400 MODEL_NOT_ALLOWED, an out-of-range maxTokens 400, and a provider failure 502 with no
//     provider text in the body.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { D1Like } from "@poc/sdk";
import { LlmGatewayService } from "../../../bricks/llm-gateway/src/index.ts";
import type { LlmProviderAdapter } from "../../../bricks/llm-gateway/src/index.ts";
import { createWallet } from "@poc/credit-wallet";
import { call, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

const entryLoaders = import.meta.glob("../../../out/max-compatible/src/index.ts") as Record<string, () => Promise<{ default: App }>>;
const app = (await Object.values(entryLoaders)[0]?.())?.default;
const entrySource = Object.values(
  import.meta.glob("../../../out/max-compatible/src/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0];
const sql = import.meta.glob("../../../out/max-compatible/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const db = env.DB as unknown as D1Like;

class FakeProvider implements LlmProviderAdapter {
  readonly name = "workers-ai";
  calls: Array<{ model: string; maxTokens: number | undefined }> = [];
  failWith: string | undefined;
  gate: Promise<void> | undefined;
  async generate(prompt: string, model: string, options?: { temperature?: number; maxTokens?: number }) {
    this.calls.push({ model, maxTokens: options?.maxTokens });
    if (this.gate) await this.gate;
    if (this.failWith) throw new Error(this.failWith);
    // It reports 1200 prompt tokens, more than the reservation's estimate for "hello" (21): billing caps them at 21.
    return { text: `fake answer to ${prompt}`, promptTokens: 1200, completionTokens: 600, modelUsed: model };
  }
}

async function newWorkspace(owner: string, name: string): Promise<string> {
  const created = await call(app!, "POST", "/api/workspaces", { user: owner, body: { name } });
  expect(created.status).toBe(201);
  return (JSON.parse(created.text) as { workspace: { id: string } }).workspace.id;
}

async function setBalance(workspaceId: string, credits: number): Promise<void> {
  await createWallet(db, undefined).openWallet(workspaceId, 0);
  await db.prepare("UPDATE credit_wallets SET balance = ? WHERE workspace_id = ?").bind(credits, workspaceId).run();
}

async function balanceOf(workspaceId: string): Promise<number> {
  const res = await call(app!, "GET", "/api/wallet", { user: workspaceId === wsA ? "alice" : "bob", ws: workspaceId });
  expect(res.status).toBe(200);
  return (JSON.parse(res.text) as { currentBalance: number }).currentBalance;
}

async function ledger(workspaceId: string) {
  return (
    await db
      .prepare("SELECT amount, idempotency_key, user_id FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid")
      .bind(workspaceId)
      .all<{ amount: number; idempotency_key: string; user_id: string }>()
  ).results;
}

async function aiLogs(workspaceId: string) {
  return (
    await db
      .prepare("SELECT id, cost_credits, billing_status FROM ai_generation_logs WHERE workspace_id = ? ORDER BY rowid")
      .bind(workspaceId)
      .all<{ id: string; cost_credits: number; billing_status: string }>()
  ).results;
}

let wsA = "";
let wsB = "";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI generation is billed to the workspace wallet in the assembled max-compatible app (story 1.13)", () => {
  test("the emitted app wires credit-wallet's walletCharger into llm-gateway's routes", () => {
    expect(entrySource, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    expect(entrySource).toMatch(/import \{[^}]*\bwalletCharger\b[^}]*\} from "@poc\/credit-wallet";/);
    expect(entrySource!.match(/createAiRoutes\(([^)]*)\)/)?.[1]).toContain("charger: walletCharger");
  });

  test("A reserves the maximum and keeps the model's actual cost, B is untouched, and a short balance gets 402 with nothing generated", async () => {
    expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    await resetAndMigrate(db, sql);
    wsA = await newWorkspace("alice", "Workspace A");
    wsB = await newWorkspace("bob", "Workspace B");
    await setBalance(wsA, 50);
    await setBalance(wsB, 50);

    const provider = new FakeProvider();
    vi.spyOn(LlmGatewayService.prototype, "adapterFor").mockImplementation((name: string) => (name === provider.name ? provider : undefined));

    // Reserve: 5 bytes + 16 overhead = 21 prompt tokens + maxTokens 1000 at gpt-4o-mini's 1:2 -> ceil(0.021 + 2) = 3.
    // Actual: 21 (capped) prompt and 600 completion tokens -> ceil(0.021 + 1.2) = 2, so 1 is refunded.
    const res = await call(app!, "POST", "/api/ai/generate", { user: "alice", ws: wsA, body: { prompt: "hello", maxTokens: 1000 } });
    expect(res.status, res.text).toBe(200);
    const result = (JSON.parse(res.text) as { result: { costCredits: number; billed: boolean; text: string } }).result;
    expect(result).toMatchObject({ costCredits: 2, billed: true, text: "fake answer to hello" });
    expect(provider.calls).toEqual([{ model: "gpt-4o-mini", maxTokens: 1000 }]);

    const logs = await aiLogs(wsA);
    expect(logs).toEqual([{ id: expect.any(String), cost_credits: 2, billing_status: "charged" }]);
    expect(await ledger(wsA)).toEqual([
      { amount: -3, idempotency_key: `ai:${logs[0]!.id}`, user_id: "alice" },
      { amount: 1, idempotency_key: `ai:${logs[0]!.id}:refund`, user_id: "alice" },
    ]);
    expect(await balanceOf(wsA)).toBe(48);
    expect(await balanceOf(wsB)).toBe(50);
    expect(await ledger(wsB)).toEqual([]);
    expect(await aiLogs(wsB)).toEqual([]);

    // Too little in A's wallet: refused before generation, nothing charged or logged.
    // "hello" -> at most 21 prompt tokens; maxTokens 4096 (the cap) at 1:2 -> ceil(0.021 + 8.192) = 9 credits reserved.
    await setBalance(wsA, 8);
    const short = await call(app!, "POST", "/api/ai/generate", { user: "alice", ws: wsA, body: { prompt: "hello" } });
    expect(short.status, short.text).toBe(402);
    expect((JSON.parse(short.text) as { code: string }).code).toBe("INSUFFICIENT_CREDITS");
    expect(provider.calls).toHaveLength(1);
    expect(await balanceOf(wsA)).toBe(8);
    expect(await ledger(wsA)).toHaveLength(2);
    expect(await aiLogs(wsA)).toHaveLength(1);

    // Unknown model and out-of-range maxTokens: 400, nothing generated.
    await setBalance(wsA, 50);
    const model = await call(app!, "POST", "/api/ai/generate", { user: "alice", ws: wsA, body: { prompt: "hello", model: "gpt-5-max" } });
    expect(model.status).toBe(400);
    expect((JSON.parse(model.text) as { code: string }).code).toBe("MODEL_NOT_ALLOWED");
    for (const maxTokens of [0, 4097]) {
      expect((await call(app!, "POST", "/api/ai/generate", { user: "alice", ws: wsA, body: { prompt: "hello", maxTokens } })).status).toBe(400);
    }
    expect(provider.calls).toHaveLength(1);

    // A provider failure: 502 with the fixed message, no provider text, nothing charged.
    provider.failWith = "upstream said: invalid key sk-proj-LEAKME";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await call(app!, "POST", "/api/ai/generate", { user: "alice", ws: wsA, body: { prompt: "hello" } });
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.text)).toMatchObject({ code: "PROVIDER_ERROR", error: "The AI provider could not complete the request" });
    expect(failed.text).not.toMatch(/LEAKME|sk-proj|upstream/);
    // The reservation was taken and refunded in full.
    expect(await balanceOf(wsA)).toBe(50);
    expect((await ledger(wsA)).slice(2).map((r) => r.amount)).toEqual([-9, 9]);
    expect((await aiLogs(wsA)).map((l) => [l.cost_credits, l.billing_status])).toEqual([
      [2, "charged"],
      [0, "refunded"],
    ]);
  });

  test("parallel calls on one balance: only the ones the wallet covers are generated, the rest get 402", async () => {
    expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    await resetAndMigrate(db, sql);
    wsA = await newWorkspace("alice", "Workspace A");
    wsB = await newWorkspace("bob", "Workspace B");
    await setBalance(wsA, 6); // two reservations of 3

    const provider = new FakeProvider();
    let release!: () => void;
    provider.gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(LlmGatewayService.prototype, "adapterFor").mockImplementation((name: string) => (name === provider.name ? provider : undefined));

    const settled: number[] = [];
    const calls = Array.from({ length: 5 }, () =>
      call(app!, "POST", "/api/ai/generate", { user: "alice", ws: wsA, body: { prompt: "hello", maxTokens: 1000 } }).then((r) => {
        settled.push(r.status);
        return r;
      }),
    );
    for (let i = 0; i < 400 && provider.calls.length + settled.length < 5; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(provider.calls).toHaveLength(2);
    expect(settled).toEqual([402, 402, 402]);
    release();
    const results = await Promise.all(calls);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 402, 402, 402]);
    // Each kept 2 of its 3 credits: 6 - 2 * 2. The wallet never went below zero.
    expect(await balanceOf(wsA)).toBe(2);
    expect((await ledger(wsA)).map((r) => r.amount)).toEqual(expect.arrayContaining([-3, -3, 1, 1]));
    expect(await ledger(wsA)).toHaveLength(4);
    expect((await aiLogs(wsA)).map((l) => l.billing_status)).toEqual(["charged", "charged"]);
  });
  test("a reservation that commits and then throws, leaving less than a second one, is retried with the real walletCharger and not refused", async () => {
    expect(app, "out/max-compatible/src/index.ts was not assembled").toBeDefined();
    await resetAndMigrate(db, sql);
    wsA = await newWorkspace("alice", "Workspace A");
    wsB = await newWorkspace("bob", "Workspace B");
    await setBalance(wsA, 3); // exactly one reservation of 3

    const provider = new FakeProvider();
    vi.spyOn(LlmGatewayService.prototype, "adapterFor").mockImplementation((name: string) => (name === provider.name ? provider : undefined));
    vi.spyOn(console, "error").mockImplementation(() => {});

    // The first wallet debit commits and then the connection "drops": the batch's result is lost and it throws.
    let armed = true;
    let debitPrepared = false;
    const real = db as unknown as Record<string, unknown> & { prepare(sql: string): unknown; batch(s: unknown[]): Promise<unknown> };
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") {
          return (q: string) => {
            if (q.startsWith("UPDATE credit_wallets SET balance = balance - ?")) debitPrepared = true;
            return target.prepare(q);
          };
        }
        if (prop === "batch") {
          return async (statements: unknown[]) => {
            const result = await target.batch(statements);
            const isDebit = debitPrepared;
            debitPrepared = false;
            if (armed && isDebit) {
              armed = false;
              throw new Error("network reset after commit");
            }
            return result;
          };
        }
        const value = target[prop as string];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    const res = await call(app!, "POST", "/api/ai/generate", { user: "alice", ws: wsA, body: { prompt: "hello", maxTokens: 1000 }, env: { ...env, DB: flaky } });
    expect(armed, "the debit batch was interrupted").toBe(false);
    expect(res.status, res.text).toBe(200);
    expect(JSON.parse(res.text).result).toMatchObject({ costCredits: 2, billed: true });
    const logs = await aiLogs(wsA);
    expect(logs.map((l) => l.billing_status)).toEqual(["charged"]);
    expect(await ledger(wsA)).toEqual([
      { amount: -3, idempotency_key: `ai:${logs[0]!.id}`, user_id: "alice" },
      { amount: 1, idempotency_key: `ai:${logs[0]!.id}:refund`, user_id: "alice" },
    ]);
    expect(await balanceOf(wsA)).toBe(1);
  });
});
