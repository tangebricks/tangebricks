import { z } from "zod";

// The credit-wallet brick's client layer: typed calls to the brick's own routes. It is browser code, so it lives
// outside src/ (which holds only worker code) and has its own tsconfig. Responses are checked with Zod rather than
// trusted, so a server that answers with something unexpected becomes an error the widget can show, not a crash.

const BalanceSchema = z.object({ currentBalance: z.number().int().nonnegative(), creditsPerUnit: z.number(), minOrderAmount: z.number() });
const LedgerRowSchema = z.object({
  id: z.string(),
  type: z.enum(["topup", "deduction"]),
  amount: z.number().int(),
  balanceAfter: z.number().int().nonnegative(),
  description: z.string(),
  createdAt: z.string(),
});
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
