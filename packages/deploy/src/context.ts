import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadCredentials } from "./provisioner/credentials.ts";
import type { Credentials } from "./provisioner/credentials.ts";
import { fileKeyStore, loadOrCreateAccessKey } from "./provisioner/access-key.ts";
import { fileStore } from "./provisioner/ledger.ts";
import type { ResourceNames } from "./provisioner/names.ts";
import { ACCOUNT_SUBDOMAIN_PLACEHOLDER } from "./redact-subdomain.ts";

// What the later stories need to know about the deployment H10 left behind: where it is, what it is called, which database it
// uses and which version of the Worker the deploy ended on. It comes from the H10 evidence, the ledger and the access key in the
// state folder (outside both repositories), and it refuses to go on if they do not describe one finished deployment.

/** In the state folder (outside both repositories): the account's workers.dev subdomain, written by scripts/poc-deploy.ts. */
export const WORKERS_SUBDOMAIN_FILE = "workers-subdomain.txt";

/**
 * The real address of a Worker whose evidence URL was redacted: the placeholder is filled from the state folder's
 * workers-subdomain.txt, else from PX_WORKERS_SUBDOMAIN. A URL without the placeholder is returned unchanged.
 */
export function resolveWorkerUrl(url: string, stateDir: string, env: Record<string, string | undefined>): string {
  if (!url.includes(ACCOUNT_SUBDOMAIN_PLACEHOLDER)) return url;
  const file = join(resolve(stateDir), WORKERS_SUBDOMAIN_FILE);
  const sub = (existsSync(file) ? readFileSync(file, "utf8").trim() : "") || env.PX_WORKERS_SUBDOMAIN?.trim() || "";
  if (!/^[a-z0-9-]+$/i.test(sub)) {
    throw new Error(
      `the H10 evidence shows the Worker's address with the account's workers.dev subdomain redacted; put the subdomain in ${WORKERS_SUBDOMAIN_FILE} in the state folder (scripts/poc-deploy.ts writes it) or set PX_WORKERS_SUBDOMAIN`,
    );
  }
  return url.split(ACCOUNT_SUBDOMAIN_PLACEHOLDER).join(sub);
}

export interface Deployment {
  credentials: Credentials;
  accessKey: string;
  names: ResourceNames;
  url: string;
  databaseId: string;
  deployedVersionId: string | null;
}

export function loadDeployment(options: { root: string; planRepo: string; stateDir: string; env: Record<string, string | undefined> }): Deployment {
  const stateDir = resolve(options.stateDir);
  const inside = (child: string, parent: string) => (child + sep).toLowerCase().startsWith((resolve(parent) + sep).toLowerCase());
  if (inside(stateDir, options.root) || inside(stateDir, options.planRepo))
    throw new Error("the state folder must be outside both repositories: it holds the access key");
  const credentials = loadCredentials(options.env);
  const h10Path = join(options.root, "evidence", "deployed", "h10-calls.json");
  if (!existsSync(h10Path)) throw new Error("evidence/deployed/h10-calls.json is missing: run scripts/poc-deploy.ts first");
  const h10 = JSON.parse(readFileSync(h10Path, "utf8")) as {
    facts: { url: string | null; names: ResourceNames; readings: { afterFourth?: { databaseId: string | null; latestVersionId: string | null } } };
  };
  const { url, names } = h10.facts;
  const databaseId = h10.facts.readings.afterFourth?.databaseId ?? null;
  const ledger = fileStore(join(stateDir, "ledger.json")).read();
  if (!url || !databaseId || !ledger || ledger.suffix !== names.suffix || ledger.entries.some((e) => e.status !== "created"))
    throw new Error("the H10 evidence, the ledger and the account do not describe one finished deployment: run scripts/poc-deploy.ts again");
  const accessKey = loadOrCreateAccessKey(fileKeyStore(join(stateDir, "access-key.txt")), () => {
    throw new Error("the access key is missing: this Worker cannot be reached");
  });
  return {
    credentials,
    accessKey,
    names,
    url: resolveWorkerUrl(url, stateDir, options.env),
    databaseId,
    deployedVersionId: h10.facts.readings.afterFourth?.latestVersionId ?? null,
  };
}
