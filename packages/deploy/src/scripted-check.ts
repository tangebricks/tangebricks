// The scripted correctness check: what "the deployed project answers correctly" means. One definition, run against
// the project in three places: the unbundled project under test, the bundled script under a local workerd, and (in
// later stories) the real deployed address.
//
// It only needs a function that sends a Request and returns a Response, so it runs in Node and in workerd. It records
// what it saw as plain observations (a status and a few facts, never an id or a timestamp, which differ every run), and
// the expected observations are written out below, so "the same answers" is a comparison with a fixed list and not
// with whatever the project happened to say.

export type Send = (request: Request) => Promise<Response>;
export type Fact = string | number | boolean | null;
export interface Observation {
  step: string;
  status: number;
  facts: Record<string, Fact>;
}

export interface CheckOptions {
  /** Origin the requests are addressed to. Ignored by a `send` that routes by itself. */
  origin?: string;
  /** Sent on every request, for example the deploy's access key. */
  headers?: Record<string, string>;
}

/** What a correct project answers, step by step. Statuses are the product's own (see the H6 and H8 tests). */
export const SCRIPTED_EXPECTED: readonly Observation[] = [
  { step: "alice creates workspace A", status: 201, facts: { hasWorkspaceId: true } },
  { step: "bob creates workspace B", status: 201, facts: { hasWorkspaceId: true } },
  { step: "A's wallet starts at zero", status: 200, facts: { balance: 0 } },
  { step: "A creates an invoice", status: 201, facts: { clientName: "Acme", amount: 100, invoiceStatus: "draft" } },
  { step: "A reads its own invoice by id", status: 200, facts: { clientName: "Acme" } },
  { step: "A lists its invoices", status: 200, facts: { total: 1, firstClient: "Acme" } },
  { step: "B lists its invoices and sees none of A's", status: 200, facts: { total: 0, sawAcme: false } },
  { step: "B reads A's invoice by id and is refused", status: 404, facts: { leakedAcme: false } },
  { step: "B names A's workspace and is refused", status: 403, facts: { leakedAcme: false } },
  { step: "a request with no identity is refused", status: 401, facts: {} },
];

export async function runScriptedCheck(send: Send, options: CheckOptions = {}): Promise<Observation[]> {
  const origin = options.origin ?? "http://project.invalid";
  const observations: Observation[] = [];

  async function call(step: string, method: string, path: string, user: string | null, workspace: string | null, body?: unknown) {
    const headers: Record<string, string> = {
      ...options.headers,
      ...(user ? { "x-test-user": user } : {}),
      ...(workspace ? { "x-workspace-id": workspace } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    };
    const response = await send(new Request(`${origin}${path}`, { method, headers, body: body === undefined ? null : JSON.stringify(body) }));
    const text = await response.text();
    let parsed: Record<string, any> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, any>;
    } catch {
      // not JSON: the facts below will not match, which is the point
    }
    return { step, status: response.status, text, body: parsed };
  }
  const note = (r: { step: string; status: number }, facts: Record<string, Fact>) => observations.push({ step: r.step, status: r.status, facts });

  const a = await call("alice creates workspace A", "POST", "/api/workspaces", "alice", null, { name: "Scripted A" });
  note(a, { hasWorkspaceId: typeof a.body?.workspace?.id === "string" });
  const b = await call("bob creates workspace B", "POST", "/api/workspaces", "bob", null, { name: "Scripted B" });
  note(b, { hasWorkspaceId: typeof b.body?.workspace?.id === "string" });
  const wsA = String(a.body?.workspace?.id ?? "");
  const wsB = String(b.body?.workspace?.id ?? "");

  const wallet = await call("A's wallet starts at zero", "GET", "/api/wallet", "alice", wsA);
  note(wallet, { balance: wallet.body?.currentBalance ?? null });

  const created = await call("A creates an invoice", "POST", "/api/invoices", "alice", wsA, { client_name: "Acme", amount: 100, status: "draft" });
  note(created, { clientName: created.body?.item?.client_name ?? null, amount: created.body?.item?.amount ?? null, invoiceStatus: created.body?.item?.status ?? null });
  const invoiceId = String(created.body?.item?.id ?? "none");

  // B's refusal below only means something if the id is real, so A reads the same id first and gets the invoice.
  const readOwn = await call("A reads its own invoice by id", "GET", `/api/invoices/${encodeURIComponent(invoiceId)}`, "alice", wsA);
  note(readOwn, { clientName: readOwn.body?.item?.client_name ?? null });

  const listA = await call("A lists its invoices", "GET", "/api/invoices", "alice", wsA);
  note(listA, { total: listA.body?.total ?? null, firstClient: listA.body?.items?.[0]?.client_name ?? null });

  const listB = await call("B lists its invoices and sees none of A's", "GET", "/api/invoices", "bob", wsB);
  note(listB, { total: listB.body?.total ?? null, sawAcme: listB.text.includes("Acme") });

  const readOther = await call("B reads A's invoice by id and is refused", "GET", `/api/invoices/${encodeURIComponent(invoiceId)}`, "bob", wsB);
  note(readOther, { leakedAcme: readOther.text.includes("Acme") });

  const crossWorkspace = await call("B names A's workspace and is refused", "GET", "/api/invoices", "bob", wsA);
  note(crossWorkspace, { leakedAcme: crossWorkspace.text.includes("Acme") });

  const anonymous = await call("a request with no identity is refused", "GET", "/api/invoices", null, null);
  note(anonymous, {});

  return observations;
}

/** True only when the observations are exactly the expected ones, in order. */
export function scriptedCheckPasses(observations: readonly Observation[]): boolean {
  return JSON.stringify(observations) === JSON.stringify(SCRIPTED_EXPECTED);
}

/** A readable list of the steps that differ, for a failing test or a deploy log. */
export function describeDifferences(observations: readonly Observation[]): string[] {
  const out: string[] = [];
  SCRIPTED_EXPECTED.forEach((expected, i) => {
    const seen = observations[i];
    if (JSON.stringify(seen) !== JSON.stringify(expected)) out.push(`${expected.step}: expected ${JSON.stringify({ status: expected.status, facts: expected.facts })}, saw ${seen ? JSON.stringify({ status: seen.status, facts: seen.facts }) : "nothing"}`);
  });
  if (observations.length > SCRIPTED_EXPECTED.length) out.push(`${observations.length - SCRIPTED_EXPECTED.length} unexpected extra observations`);
  return out;
}
