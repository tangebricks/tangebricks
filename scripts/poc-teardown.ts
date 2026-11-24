// Removes what scripts/poc-deploy.ts created, and only that: it walks the ledger in the state folder, deletes the resources
// the ledger lists (checking every name carries the proof's prefix before anything is deleted), and REPORTS any other
// resource with the proof's prefix without touching it.
//
//   node "--env-file=C:\cephlow minimalist version\env\.env" scripts/poc-teardown.ts --state-dir "C:\cephlow minimalist version\env\poc-state" --yes
//
// Without --yes it only prints what it would remove.
import { join, resolve } from "node:path";
import { CredentialsError, createClient, fileStore, findUnledgered, isCloudflareError, loadCredentials, openLedger, teardown } from "../packages/deploy/src/provisioner/index.ts";

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
const flag = process.argv.indexOf("--state-dir");
const stateArg = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!stateArg) {
  console.error("--state-dir <folder> is required");
  process.exit(2);
}
const store = fileStore(join(resolve(stateArg), "ledger.json"));
if (store.read() === null) {
  console.log("there is no ledger in that folder: nothing to remove");
  process.exit(0);
}
const ledger = openLedger(store, () => {
  throw new Error("unreachable: the ledger exists");
});
const live = ledger.entries().filter((e) => e.status !== "removed");
console.log(live.length === 0 ? "the ledger lists nothing that is still in the account" : `the ledger lists: ${live.map((e) => `${e.kind} ${e.name}`).join(", ")}`);

const client = createClient({ credentials, fetch: (request) => fetch(request) });
try {
  if (!process.argv.includes("--yes")) {
    const stray = await findUnledgered(client, ledger);
    console.log(stray.length === 0 ? "no other resource carries the proof's prefix" : `other resources carry the proof's prefix and would be left alone: ${stray.map((s) => `${s.kind} ${s.name}`).join(", ")}`);
    console.log("nothing was removed (add --yes to remove what the ledger lists)");
    process.exit(0);
  }
  const result = await teardown(client, ledger);
  for (const r of result.removed) console.log(`removed ${r.kind} ${r.name}`);
  for (const r of result.alreadyGone) console.log(`already gone: ${r.kind} ${r.name}`);
  for (const r of result.unledgered) console.log(`left alone, not in the ledger: ${r.kind} ${r.name}`);
} catch (error) {
  console.error(isCloudflareError(error) ? client.hide(error.message) : error instanceof Error ? client.hide(error.message) : "failed");
  process.exit(1);
}
