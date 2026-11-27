/**
 * Keeps the Cloudflare account's workers.dev subdomain out of the committed evidence.
 *
 * A Worker's address is `https://<worker-name>.<account-subdomain>.workers.dev`. The worker name is kept (it is the
 * prefixed, per-run resource name the evidence is about); the account's own label is replaced by the literal placeholder
 * `<account-subdomain>`. Every live script that writes under evidence/deployed passes its texts through here *before*
 * any hash is taken (`callsSha256`, the integrity record), so the recorded hashes cover the redacted bytes.
 *
 * The real address the later live scripts need is restored from the state folder, outside the repository
 * (`resolveWorkerUrl` in packages/deploy/src/context.ts).
 */
import { createHash } from "node:crypto";
import { redactWorkersDevSubdomains, redactWorkersDevText } from "../../packages/deploy/src/redact-subdomain.ts";
import type { RedactOptions } from "../../packages/deploy/src/redact-subdomain.ts";

export {
  ACCOUNT_SUBDOMAIN_PLACEHOLDER,
  accountSubdomainOf,
  redactWorkersDevSubdomains,
  redactWorkersDevText,
} from "../../packages/deploy/src/redact-subdomain.ts";
export type { RedactOptions } from "../../packages/deploy/src/redact-subdomain.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Redacts a live run's calls text and its result, and re-points the result's `callsSha256` at the redacted calls text,
 * so the pair written to disk still verifies (`evaluate*` compares the hash with the calls file).
 */
export function redactCallsAndResult<R extends { callsSha256: string }>(
  callsText: string,
  result: R,
  options: RedactOptions = {},
): { callsText: string; result: R } {
  const redactedCalls = redactWorkersDevText(callsText, options);
  return { callsText: redactedCalls, result: { ...redactWorkersDevSubdomains(result, options), callsSha256: sha256(redactedCalls) } };
}
