import { z } from "zod";

// The credit-wallet brick's client layer: typed calls to the brick's own routes. It is browser code, so it lives
// outside src/ (which holds only worker code) and has its own tsconfig. Responses are checked with Zod rather than
// trusted, so a server that answers with something unexpected becomes an error the widget can show, not a crash.

// Story 2.5: credits have up to three decimals. Each amount comes as a number of credits (for display) and as whole
// thousandths (`...Milli`, exact); the two must agree, or the answer is not trusted.
const agrees = (credits: number, milli: number) => Math.round(credits * 1000) === milli;
const BalanceSchema = z
  .object({
    currentBalance: z.number().nonnegative(),
    currentBalanceMilli: z.number().int().nonnegative(),
    creditsPerUnit: z.number(),
    minOrderAmount: z.number(),
  })
  .refine((b) => agrees(b.currentBalance, b.currentBalanceMilli));
const LedgerRowSchema = z
  .object({
    id: z.string(),
    type: z.enum(["topup", "deduction", "transfer_out", "transfer_in"]),
    amount: z.number(),
    amountMilli: z.number().int(),
    balanceAfter: z.number().nonnegative(),
    balanceAfterMilli: z.number().int().nonnegative(),
    description: z.string(),
    transferCode: z.string().optional(),
    createdAt: z.string(),
  })
  .refine((r) => agrees(r.amount, r.amountMilli) && agrees(r.balanceAfter, r.balanceAfterMilli));
const HistorySchema = z.object({ ledgers: z.array(LedgerRowSchema) });

export type WalletBalance = z.infer<typeof BalanceSchema>;
export type LedgerEntry = z.infer<typeof LedgerRowSchema>;

export class WalletClientError extends Error {
  /** The HTTP status, or 0 when the request never got an answer. */
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WalletClientError";
    this.status = status;
  }
}

export interface WalletClientOptions {
  /** Where the brick's routes are mounted, for example "https://app.example.com/api". No trailing slash needed. */
  baseUrl: string;
  /** The workspace the signed-in user is acting in; sent as `x-workspace-id`. */
  workspaceId: string;
  /** Extra headers on every call, for example `Authorization`. */
  headers?: Record<string, string>;
  /** Defaults to the global fetch. Injected in tests, and by hosts that proxy requests. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface WalletClient {
  getBalance(): Promise<WalletBalance>;
  getHistory(): Promise<LedgerEntry[]>;
}

export function createWalletClient(options: WalletClientOptions): WalletClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { headers: { ...options.headers, "x-workspace-id": options.workspaceId, accept: "application/json" } });
    } catch {
      throw new WalletClientError("Could not reach the server", 0);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WalletClientError("The server's answer was not understood", response.status);
    }
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `Request failed (${response.status})`;
      throw new WalletClientError(message, response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new WalletClientError("The server's answer was not understood", response.status);
    return parsed.data;
  }

  return {
    getBalance: () => get("/wallet", BalanceSchema),
    getHistory: async () => (await get("/wallet/history", HistorySchema)).ledgers,
  };
}
