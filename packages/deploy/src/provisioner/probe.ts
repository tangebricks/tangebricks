import { isCloudflareError, CloudflareApiError } from "./cloudflare.ts";
import type { CallRecord, Client } from "./cloudflare.ts";
import { PROOF_PREFIX } from "./names.ts";

// A look at the owner's account that changes nothing. It makes GET requests only (the token check is one of them) and says,
// for each thing the deploy will need, whether the token could READ it. A read answer cannot show that the token may also
// WRITE, and the probe says so rather than guessing: the token's own list of permission groups is the only read-only
// evidence of write access, and a token usually cannot read its own policies.
//
// Nothing here creates, changes or deletes. The workers.dev name is not created here even when the account has none: the
// deploy tool does not create one either, because choosing the owner's account-wide address is the owner's decision.

export type ReadState = "readable" | "refused" | "not_found" | "failed";
export interface Reading<T> {
  state: ReadState;
  value?: T;
  /** HTTP status and Cloudflare's error codes when it answered with a refusal; nothing secret. */
  status?: number;
  codes?: number[];
  /** A short reason with secrets hidden. */
  note?: string;
}

async function read<T>(client: Client, fetcher: () => Promise<T>): Promise<Reading<T>> {
  try {
    return { state: "readable", value: await fetcher() };
  } catch (error) {
    if (error instanceof CloudflareApiError) {
      if (error.status === 404) return { state: "not_found", status: 404, codes: error.codes, note: client.hide(error.details.join("; ") || "not found") };
      const authentication = error.status === 401 || error.status === 403 || error.codes.includes(10000);
      return {
        state: authentication ? "refused" : "failed",
        status: error.status,
        codes: error.codes,
        note: client.hide(error.details.join("; ") || error.message),
      };
    }
    if (isCloudflareError(error)) return { state: "failed", note: client.hide(error.message) };
    throw error;
  }
}

export interface ProbeReport {
  token: { reachable: boolean; status: string | null; expiresOn: string | null; daysLeft: number | null; note?: string };
  /** Permission group names from the token's own policies, or why they could not be read. */
  permissionGroups: Reading<string[]>;
  checks: {
    d1: Reading<string[]>;
    scripts: Reading<string[]>;
    subdomain: Reading<string | null>;
    workflows: Reading<string[]>;
  };
  /** Existing resources that already carry this proof's prefix (from an earlier run). They are reported, never touched. */
  existingProofResources: Array<{ kind: "d1_database" | "worker_script" | "workflow"; name: string }>;
  counts: { databases: number | null; scripts: number | null; workflows: number | null };
  /** What to add to the token, in the words of Cloudflare's permission groups. Empty when nothing the probe could test is missing. */
  missing: string[];
  /** Things the probe cannot establish with reads. They are not "missing"; the first write will show. */
  notEstablished: string[];
  ready: boolean;
}

export interface ProbeInput {
  client: Client;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WRITE_GROUP = {
  d1: /\bD1\b.*\b(Write|Edit)\b/i,
  scripts: /\bWorkers Scripts\b.*\b(Write|Edit)\b/i,
};

export async function runProbe(input: ProbeInput): Promise<ProbeReport> {
  const { client } = input;
  const now = (input.now ?? (() => new Date()))();
  const empty = <T>(): Reading<T> => ({ state: "failed", note: "not attempted: the token check did not pass" });
  const report: ProbeReport = {
    token: { reachable: false, status: null, expiresOn: null, daysLeft: null },
    permissionGroups: empty(),
    checks: { d1: empty(), scripts: empty(), subdomain: empty(), workflows: empty() },
    existingProofResources: [],
    counts: { databases: null, scripts: null, workflows: null },
    missing: [],
    notEstablished: [],
    ready: false,
  };

  // 1. The token itself.
  let tokenId: string | undefined;
  try {
    const verified = await client.verifyToken();
    tokenId = verified.id;
    report.token = {
      reachable: true,
      status: verified.status,
      expiresOn: verified.expiresOn ?? null,
      daysLeft: verified.expiresOn ? Math.floor((Date.parse(verified.expiresOn) - now.getTime()) / DAY_MS) : null,
    };
    if (verified.status !== "active") report.token.note = `the token's status is "${verified.status}", not "active"`;
  } catch (error) {
    if (!isCloudflareError(error)) throw error;
    report.token.note = client.hide(error.message);
    report.missing.push("a working token: Cloudflare did not accept the one given");
    return report;
  }
  if (report.token.status !== "active") return report;

  // 2. What the token says it may do (usually refused: reading a token needs its own permission).
  report.permissionGroups =
    tokenId === undefined
      ? { state: "failed", note: "the check did not return the token's id" }
      : await read(client, () => client.getTokenPermissions(tokenId));

  // 3. What it can read, one request each.
  report.checks.d1 = await read(client, async () => (await client.listDatabases()).map((d) => d.name));
  report.checks.scripts = await read(client, () => client.listScripts());
  report.checks.subdomain = await read(client, () => client.getAccountSubdomain());
  report.checks.workflows = await read(client, () => client.listWorkflows());

  const { d1, scripts, subdomain, workflows } = report.checks;
  report.counts = { databases: d1.value?.length ?? null, scripts: scripts.value?.length ?? null, workflows: workflows.value?.length ?? null };
  for (const [kind, reading] of [
    ["d1_database", d1],
    ["worker_script", scripts],
    ["workflow", workflows],
  ] as const) {
    for (const name of reading.value ?? []) if (name.startsWith(PROOF_PREFIX)) report.existingProofResources.push({ kind, name });
  }

  // 4. What is missing, only where a refusal or the token's own list shows it.
  if (d1.state === "refused") report.missing.push("D1 (Read or Write)");
  if (scripts.state === "refused" || subdomain.state === "refused") report.missing.push("Workers Scripts (Read or Write)");
  if (workflows.state === "refused")
    report.missing.push("the permission that covers Workflows (a Workflows group if the dashboard lists one; otherwise it may be part of Workers Scripts)");
  if (permissionGroupsKnown(report)) {
    const names = report.permissionGroups.value!;
    if (!names.some((n) => WRITE_GROUP.d1.test(n))) report.missing.push("D1 Write (the token's own list has no D1 write group)");
    if (!names.some((n) => WRITE_GROUP.scripts.test(n))) report.missing.push("Workers Scripts Write (the token's own list has no Workers Scripts write group)");
  } else {
    report.notEstablished.push(
      "whether the token may WRITE to D1 and Workers Scripts: reads cannot show it, and the token's own list was not readable; the first write in story 5 will show",
    );
  }
  if (subdomain.state === "readable" && subdomain.value === null)
    report.notEstablished.push(
      "the account has no workers.dev name yet: choose one in the dashboard (Workers & Pages) before the deploy; this tool does not create it",
    );
  if (workflows.state === "not_found")
    report.notEstablished.push(
      "Cloudflare answered 'not found' to the Workflows list request: the path used here is a guess from documentation and may be wrong; it is only used to look for leftovers",
    );
  if (workflows.state === "failed") report.notEstablished.push("the Workflows list request failed for a reason other than permission");
  if (report.token.daysLeft !== null && report.token.daysLeft < 2) report.notEstablished.push(`the token expires in ${report.token.daysLeft} day(s)`);

  const readable = d1.state === "readable" && scripts.state === "readable" && subdomain.state === "readable";
  report.ready = readable && subdomain.value !== null && report.missing.length === 0 && (report.token.daysLeft === null || report.token.daysLeft >= 1);
  return report;
}

function permissionGroupsKnown(report: ProbeReport): boolean {
  return report.permissionGroups.state === "readable" && Array.isArray(report.permissionGroups.value);
}

/**
 * The report as it may be written to a file kept in the repository: counts and this proof's own leftovers, but not the names
 * of the owner's other databases, Workers or Workflows. The console shows those names; the file does not keep them.
 */
export function forEvidence(report: ProbeReport): ProbeReport {
  const strip = (r: Reading<string[]>): Reading<string[]> => {
    const { value, ...rest } = r;
    return value === undefined ? rest : { ...rest, value: value.filter((n) => n.startsWith(PROOF_PREFIX)) };
  };
  return {
    ...report,
    checks: { ...report.checks, d1: strip(report.checks.d1), scripts: strip(report.checks.scripts), workflows: strip(report.checks.workflows) },
  };
}

/** True when every call in the log was a GET. The probe's promise, checked from the log and not from the code. */
export const onlyReads = (calls: readonly CallRecord[]): boolean => calls.length > 0 && calls.every((c) => c.method === "GET");

/** Plain-words lines for the console. Contains names of existing resources (the owner asked to see them) but no secret. */
export function describeProbe(
  report: ProbeReport,
  details: { databases?: string[]; scripts?: string[]; workflows?: string[]; subdomain?: string | null } = {},
): string[] {
  const out: string[] = [];
  const t = report.token;
  out.push(
    t.reachable
      ? `token: ${t.status}${t.expiresOn ? `, expires ${t.expiresOn}${t.daysLeft !== null ? ` (${t.daysLeft} days from now)` : ""}` : ", no expiry date"}${t.note ? ` - ${t.note}` : ""}`
      : `token: not accepted - ${t.note ?? "no answer"}`,
  );
  const pg = report.permissionGroups;
  out.push(
    pg.state === "readable"
      ? `permission groups the token holds: ${pg.value!.length ? pg.value!.join(", ") : "(none listed)"}`
      : `permission groups the token holds: could not be read (${pg.status ?? "no"} ${pg.note ?? pg.state}); the token's own list needs its own permission`,
  );
  const line = (label: string, r: Reading<unknown>, shown: string) =>
    out.push(
      `${label}: ${r.state === "readable" ? shown : `${r.state}${r.status ? ` (HTTP ${r.status}${r.codes?.length ? `, code ${r.codes.join(",")}` : ""})` : ""}${r.note ? ` - ${r.note}` : ""}`}`,
    );
  const list = (names: string[] | undefined) => (names && names.length ? names.join(", ") : "none");
  line("workers.dev name", report.checks.subdomain, details.subdomain ? `${details.subdomain}.workers.dev` : "the account has none yet");
  line("D1 databases", report.checks.d1, `${report.counts.databases} (${list(details.databases)})`);
  line("Worker scripts", report.checks.scripts, `${report.counts.scripts} (${list(details.scripts)})`);
  line("Workflows", report.checks.workflows, `${report.counts.workflows} (${list(details.workflows)})`);
  out.push(
    report.existingProofResources.length
      ? `leftovers with this proof's prefix (reported, never touched): ${report.existingProofResources.map((r) => `${r.kind} ${r.name}`).join(", ")}`
      : "no resource carries this proof's prefix: no name can clash",
  );
  out.push(report.missing.length ? `missing permissions: ${report.missing.join("; ")}` : "missing permissions: none that a read can show");
  for (const note of report.notEstablished) out.push(`not established: ${note}`);
  out.push(report.ready ? "ready: yes, as far as reads can show" : "ready: no");
  return out;
}
