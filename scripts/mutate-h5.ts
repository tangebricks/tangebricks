// Breaks the credit-wallet on purpose, one rule at a time, and prints what the scoreboard says each time.
// Used while building story 3.2 to show the H5 evidence can fail for the right reason. Always restores what it touched.
// Usage: node scripts/mutate-h5.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);

function h5Row(): string {
  const run = spawnSync(process.execPath, [join(root, "scripts", "verify.ts"), "H5"], { cwd: root, encoding: "utf8" });
  const lines = stripVTControlCharacters(run.stdout + run.stderr).split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith("H5 "));
  const row = at >= 0 ? lines.slice(at, at + 8).filter((l) => /^H5 |^\s+- /.test(l)).map((l) => l.trim().replace(/\s{2,}/g, "  ")) : ["(no H5 row)"];
  // The H5 row alone cannot show a failing test while the row is already `fail` for another reason, so the test count is printed too.
  const tests = lines.find((l) => l.startsWith("Tests:"))?.replace(/\. Verdicts.*$/, "") ?? "Tests: (not printed)";
  const short = row.filter((l) => !/graphDeductChangesBalanceOnce/.test(l)).join(" | ").slice(0, 260);
  return `${tests} | ${short}`;
}

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
  /** More replacements applied to the same file in the same mutation. */
  also?: Array<[string, string]>;
  /** Replacements in other files, applied in the same mutation. */
  alsoIn?: Array<{ file: string; from: string; to: string }>;
}
const WALLET = "bricks/credit-wallet/src/wallet.ts";
const BRICK = "bricks/credit-wallet/src/brick.ts";
const RUN = "packages/runtime/src/run.ts";
const MW_MIDDLEWARE = "bricks/multi-workspace/src/middleware.ts";
const MW_ROUTES = "bricks/multi-workspace/src/routes.ts";
const WALLET_ROUTES = "bricks/credit-wallet/src/routes.ts";
const PAYMENT_TESTS = "bricks/credit-wallet/test/H5.payment-routes.test.ts";
const MIGRATION = "bricks/credit-wallet/migrations/0001_credit_wallet.sql";
// 0002 rebuilt credit_ledger (per-workspace idempotency key); 0004 (story 2.5) renames the wallet's balance to
// balance_milli and rebuilds the ledger again in thousandths, so the live constraints are 0004's.
const LEDGER_MIGRATION = "bricks/credit-wallet/migrations/0004_milli_credits.sql";
const cases: Case[] = [
  {
    name: "top-up reads the balance, adds in JavaScript, writes it back",
    file: WALLET,
    from: 'db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli + ? WHERE workspace_id = ?").bind(creditsMilli, order.workspace_id),',
    to: 'db.prepare("UPDATE credit_wallets SET balance_milli = ? WHERE workspace_id = ?").bind(((await getBalanceMilli(order.workspace_id)) ?? 0) + creditsMilli, order.workspace_id),',
  },
  {
    name: "ledger no longer has a unique idempotency key",
    file: LEDGER_MIGRATION,
    from: "created_at TEXT NOT NULL DEFAULT (datetime('now')),\n  UNIQUE (workspace_id, idempotency_key)",
    to: "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
  },
  {
    name: "wallet balance may go negative (no CHECK on the wallet)",
    file: MIGRATION,
    from: "balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),",
    to: "balance INTEGER NOT NULL DEFAULT 0,",
  },
  {
    name: "no floor anywhere (no CHECK on wallet or ledger)",
    file: MIGRATION,
    from: "balance_after INTEGER NOT NULL CHECK (balance_after >= 0),",
    to: "balance_after INTEGER NOT NULL,",
    also: [["balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),", "balance INTEGER NOT NULL DEFAULT 0,"]],
    alsoIn: [{ file: LEDGER_MIGRATION, from: "balance_after_milli INTEGER NOT NULL CHECK (balance_after_milli >= 0),", to: "balance_after_milli INTEGER NOT NULL," }],
  },
  {
    name: "deduction writes a wrong balance_after into the ledger",
    file: WALLET,
    from: "SELECT ?, workspace_id, ?, 'deduction', ?, balance_milli, ?, ?, ? FROM credit_wallets",
    to: "SELECT ?, workspace_id, ?, 'deduction', ?, balance_milli + 1, ?, ?, ? FROM credit_wallets",
  },
  {
    name: "an order is closed even when no ledger row was written",
    file: WALLET,
    from: "AND EXISTS (SELECT 1 FROM credit_ledger WHERE workspace_id = ? AND idempotency_key = ?)",
    to: "AND ? IS NOT NULL AND ? IS NOT NULL",
  },
  {
    name: "a duplicate confirmation is not recognised and surfaces as an error",
    file: WALLET,
    from: "const isDuplicateKey = (error: unknown) =>\n  /UNIQUE constraint failed: credit_ledger\\.workspace_id, credit_ledger\\.idempotency_key/.test(errorText(error));",
    to: "const isDuplicateKey = (_error: unknown) => false;",
  },
  {
    name: "an overdraw is not recognised and surfaces as an error",
    file: WALLET,
    from: "const isOverdraw = (error: unknown) => /CHECK constraint failed: (balance_milli|balance_after_milli) >= 0/.test(errorText(error));",
    to: "const isOverdraw = (_error: unknown) => false;",
  },
  {
    name: "amounts are no longer checked to be whole positive numbers",
    file: WALLET,
    from: "const isWholeAmount = (n: unknown): n is number => typeof n === \"number\" && Number.isSafeInteger(n) && n > 0;",
    to: "const isWholeAmount = (n: unknown): n is number => typeof n === \"number\";",
  },
  {
    name: "the audit's unsafe design: conditional debit (WHERE balance >= ?) plus an unconditional ledger insert",
    file: WALLET,
    from: 'db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli - ? WHERE workspace_id = ?").bind(amountMilli, workspaceId),',
    to: 'db.prepare("UPDATE credit_wallets SET balance_milli = balance_milli - ? WHERE workspace_id = ? AND balance_milli >= ?").bind(amountMilli, workspaceId, amountMilli),',
  },
  {
    name: "runtime hands out any binding, ignoring the manifest",
    file: RUN,
    from: "if (!declaredBindings.includes(name)) throw new Error(`binding \"${name}\" is not declared by ${node.type}`);",
    to: "",
  },
  {
    name: "runtime checks bindings against the secrets list (the two are conflated)",
    file: RUN,
    from: "const declaredBindings = registry.get(node.type)?.bindings ?? [];",
    to: "const declaredBindings = [...(registry.get(node.type)?.bindings ?? []), ...declared];",
  },
  {
    name: "runtime puts the raw env into the executor's context",
    file: RUN,
    from: "payload: options.payload, secret, binding });",
    to: "payload: options.payload, secret, binding, env: options.env } as never);",
  },
  {
    name: "runtime treats a declared but missing binding as undefined instead of failing",
    file: RUN,
    from: "if (value === undefined || value === null) throw new Error(`binding \"${name}\" is declared by ${node.type} but was not provided`);",
    to: "",
  },
  {
    name: "deduct brick takes the workspace from the node's stored data instead of the caller",
    file: BRICK,
    from: "workspaceId: input.workspaceId,\n    userId: input.userId,",
    to: "workspaceId: String((ctx.data as { workspaceId?: string }).workspaceId ?? input.workspaceId),\n    userId: input.userId,",
  },
  {
    name: "deduct brick turns a refusal into a successful step",
    file: BRICK,
    from: "  if (!result.ok) {\n    throw new Error(",
    to: "  if (!result.ok) {\n    return { out: { charged: 0 } };\n    throw new Error(",
  },
  {
    name: "deduct brick drops the idempotency key",
    file: BRICK,
    from: "idempotencyKey: input.idempotencyKey,",
    to: "idempotencyKey: undefined,",
  },
  {
    name: "deduct brick no longer declares its binding",
    file: BRICK,
    from: "bindings: [WALLET_DB_BINDING],",
    to: "bindings: [],",
  },
  {
    name: "membership check ignores which user is asking",
    file: MW_MIDDLEWARE,
    from: "WHERE m.workspace_id = ? AND m.user_id = ?",
    to: "WHERE m.workspace_id = ? AND ? IS NOT NULL",
  },
  {
    name: "the caller's claimed role is trusted over the database's",
    file: MW_MIDDLEWARE,
    from: "role: member.role, suspended",
    to: "role: (c.req.header(\"x-workspace-role\") as WorkspaceRole | undefined) ?? member.role, suspended",
  },
  {
    name: "the suspended flag is never read",
    file: MW_MIDDLEWARE,
    from: "suspended: Boolean(member.suspended) }",
    to: "suspended: false }",
  },
  {
    name: "requireNotSuspended lets a suspended workspace through",
    file: MW_MIDDLEWARE,
    from: "if (workspace.suspended) return",
    to: "if ((workspace.suspended as boolean) && false) return",
  },
  {
    name: "the database's own error text is returned to the caller",
    file: MW_MIDDLEWARE,
    from: "console.error(\"workspaceMiddleware:\", error);\n    return c.json(INTERNAL, 500);",
    to: "return c.json({ error: String(error) }, 500);",
  },
  {
    name: "no identity is accepted as an identity",
    file: MW_MIDDLEWARE,
    from: "if (!user) return c.json({ error: \"Unauthorized\" }, 401);\n\n  const requested",
    to: "const requested",
  },
  {
    name: "listing workspaces is not filtered by the caller",
    file: MW_ROUTES,
    from: "WHERE m.user_id = ? ORDER BY",
    to: "WHERE ? IS NOT NULL ORDER BY",
  },
  {
    name: "the creator becomes a plain member instead of the owner",
    file: MW_ROUTES,
    from: "VALUES (?, ?, 'owner')",
    to: "VALUES (?, ?, 'member')",
  },
  {
    name: "a blank workspace name is accepted",
    file: MW_ROUTES,
    from: "z.string().trim().min(1).max(100)",
    to: "z.string().trim().max(100)",
  },
  {
    name: "verify no longer checks that the caller owns the order",
    file: WALLET_ROUTES,
    from: 'if (!order || order.userId !== user.uid) return c.json({ error: "Order not found" }, 404);',
    to: 'if (!order) return c.json({ error: "Order not found" }, 404);',
  },
  {
    name: "the ledger history is not filtered by workspace",
    file: WALLET_ROUTES,
    from: "FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 50",
    to: "FROM credit_ledger WHERE ? IS NOT NULL ORDER BY rowid DESC LIMIT 50",
  },
  {
    name: "the gateway's own error text is returned to the caller",
    file: WALLET_ROUTES,
    from: 'return c.json({ error: "Payment gateway error" }, 500);',
    to: 'return c.json({ error: "Payment gateway error: " + String(error) }, 500);',
  },
  {
    name: "the wallet routes guess a workspace from the header when the middleware is missing",
    file: WALLET_ROUTES,
    from: 'if (!workspace) return { failure: c.json({ error: "Missing workspace context" }, 400) } as const;',
    to: 'if (!workspace) return { user, workspace: { id: c.req.header("x-workspace-id") ?? "", role: "member", suspended: false } } as const;',
  },
  {
    name: "credits per unit is ignored when crediting",
    file: WALLET,
    from: "const credits = (gatewayOrder.amount || order.amount) * creditsPerUnit;",
    to: "const credits = (gatewayOrder.amount || order.amount) * 1;",
  },
  {
    name: "an order is credited whatever status the gateway reports",
    file: WALLET,
    from: 'if (gatewayOrder.status !== "PAID") return { status: gatewayOrder.status, credited: false };',
    to: "",
  },
  {
    name: "a ported test is renamed (its listed title disappears)",
    file: PAYMENT_TESTS,
    from: 'it("should reject invalid amount",',
    to: 'it("should reject invalid amounts",',
  },
  {
    name: "a ported test is skipped",
    file: PAYMENT_TESTS,
    from: 'it("should reject missing order_id",',
    to: 'it.skip("should reject missing order_id",',
  },
  {
    name: "a ported test title is used twice",
    file: PAYMENT_TESTS,
    from: 'it("an order that does not exist is a 404",',
    to: 'it("should reject missing order_id",',
  },
  {
    name: "a ported test is left with no assertion (it still passes, nothing is checked)",
    file: PAYMENT_TESTS,
    from: 'const res = await call("/api/payments/verify", "user-123", "ws-abc", {});\n      expect(res.status).toBe(400);',
    to: 'const res = await call("/api/payments/verify", "user-123", "ws-abc", {});\n      void res;',
  },
  {
    name: "a ported test loses one of its two assertions (the other still checks the status)",
    file: PAYMENT_TESTS,
    from: 'expect((await json(res)).error).toBe("Invalid amount");',
    to: "void res;",
  },
];

console.log(`baseline                                                    -> ${h5Row()}`);
for (const c of cases) {
  const original = read(c.file);
  const edits: Array<[string, string]> = [[c.from, c.to], ...(c.also ?? [])];
  const others = (c.alsoIn ?? []).map((o) => ({ ...o, original: read(o.file) }));
  if (edits.some(([from]) => !original.includes(from)) || others.some((o) => !o.original.includes(o.from))) {
    console.log(`${c.name.padEnd(60)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  write(c.file, edits.reduce((text, [from, to]) => text.replace(from, to), original));
  for (const o of others) write(o.file, o.original.replace(o.from, o.to));
  try {
    console.log(`${c.name.padEnd(60)}-> ${h5Row()}`);
  } finally {
    write(c.file, original);
    for (const o of others) write(o.file, o.original);
  }
}
console.log(`restored                                                    -> ${h5Row()}`);
