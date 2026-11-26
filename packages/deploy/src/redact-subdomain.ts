/**
 * The account's workers.dev subdomain is kept out of committed evidence: a Worker's address
 * `https://<worker-name>.<account-subdomain>.workers.dev` keeps its worker name and shows the literal placeholder
 * `<account-subdomain>` in place of the account's own label. Pure text functions, no I/O; the evidence writers use them
 * through scripts/lib/redact-subdomain.ts, and runH12 records its address through them (its writer,
 * packages/deploy/client/live/H12.live.test.tsx, is one of H12's glue-scanned files and is left as it was run).
 */

/** What the committed evidence carries in place of the account's workers.dev subdomain. */
export const ACCOUNT_SUBDOMAIN_PLACEHOLDER = "<account-subdomain>";

/** `<worker-name>.<account-subdomain>.workers.dev`: the label right before `.workers.dev`, when another label precedes it. */
const WORKERS_DEV_HOST = /([a-z0-9-]+)\.([a-z0-9-]+)(\.workers\.dev)\b/gi;

/** The account's label in a `<worker-name>.<account-subdomain>.workers.dev` address, or undefined. */
export function accountSubdomainOf(url: string): string | undefined {
  const m = url.match(/([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev\b/i);
  return m ? m[2] : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RedactOptions {
  /**
   * Account subdomains known to the caller (for example the probe's own reading of the account), replaced wherever they
   * appear as a whole label, not only inside a workers.dev host.
   */
  known?: ReadonlyArray<string | null | undefined>;
}

/** Replaces the account label of every `<label>.<sub>.workers.dev` host in `text` with `<account-subdomain>`. */
export function redactWorkersDevText(text: string, options: RedactOptions = {}): string {
  let out = text.replace(WORKERS_DEV_HOST, (_m, worker: string, _sub: string, suffix: string) => `${worker}.${ACCOUNT_SUBDOMAIN_PLACEHOLDER}${suffix}`);
  for (const sub of options.known ?? []) {
    if (!sub) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(sub)}(?![A-Za-z0-9-])`, "gi"), ACCOUNT_SUBDOMAIN_PLACEHOLDER);
  }
  return out;
}

/** The same redaction through every string (values and keys) of a JSON-shaped value; returns a copy. */
export function redactWorkersDevSubdomains<T>(value: T, options: RedactOptions = {}): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactWorkersDevText(v, options);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [redactWorkersDevText(k, options), walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
