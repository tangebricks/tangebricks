// A read-only look at the owner's Cloudflare account (epic 5, story 4). Run with the credentials loaded by Node from the
// env file kept outside the repositories:
//
//   node "--env-file=C:\cephlow minimalist version\env\.env" scripts/poc-probe.ts
//
// It makes GET requests only. It prints what the token can read, the account's workers.dev name, the names already in use,
// and which permissions are missing. It writes evidence/deployed/probe.json: counts and this proof's own leftovers, a call
// log with no header and no body, and no name of the owner's other resources. The token and the account id are never
// printed or written; a last scan of everything about to be written refuses to write if either appears.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CredentialsError, createClient, describeProbe, findSecrets, forEvidence, loadCredentials, onlyReads, runProbe } from "../packages/deploy/src/provisioner/index.ts";

const root = resolve(import.meta.dirname, "..");

let credentials;
try {
  credentials = loadCredentials(process.env);
} catch (error) {
  if (error instanceof CredentialsError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}

const client = createClient({ credentials, fetch: (request) => fetch(request) });
const report = await runProbe({ client });

const lines = describeProbe(report, {
  databases: report.checks.d1.value,
  scripts: report.checks.scripts.value,
  workflows: report.checks.workflows.value,
  subdomain: report.checks.subdomain.value,
});
for (const line of lines) console.log(client.hide(line));

const reads = onlyReads(client.calls);
console.log(`requests made: ${client.calls.length}, all of them reads: ${reads ? "yes" : "NO"}`);
if (!reads) {
  console.error("a request that is not a read was made; this must not happen");
  process.exit(3);
}

const evidence = { story: "5.4", at: new Date().toISOString(), allRequestsWereReads: reads, report: forEvidence(report), calls: client.calls };
const text = JSON.stringify(evidence, null, 2) + "\n";
const leaked = findSecrets(text, { token: credentials.token, accountId: credentials.accountId });
if (leaked.length > 0) {
  console.error(`refusing to write the evidence file: it contains ${leaked.join(" and ")}`);
  process.exit(4);
}
const dir = join(root, "evidence", "deployed");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "probe.json"), text);
console.log("wrote evidence/deployed/probe.json");
process.exit(report.ready ? 0 : 1);
