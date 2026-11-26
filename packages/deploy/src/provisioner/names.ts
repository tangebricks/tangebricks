// What this proof is allowed to name in the owner's account. Every Cloudflare resource it creates carries the prefix and
// a random suffix, so it is recognisable at a glance and teardown can refuse to touch anything else.

export const PROOF_PREFIX = "projectx-poc-";
const NAME = /^projectx-poc-[a-z0-9][a-z0-9-]{0,60}$/;

export const isProofName = (name: string): boolean => NAME.test(name);

export interface ResourceNames {
  suffix: string;
  script: string;
  database: string;
  workflow: string;
}

export function resourceNames(suffix: string): ResourceNames {
  if (!/^[0-9a-f]{8}$/.test(suffix)) throw new Error("the suffix must be 8 hexadecimal characters");
  const names = { suffix, script: `${PROOF_PREFIX}${suffix}`, database: `${PROOF_PREFIX}${suffix}-db`, workflow: `${PROOF_PREFIX}${suffix}-graphs` };
  for (const name of [names.script, names.database, names.workflow]) if (!isProofName(name)) throw new Error(`"${name}" is not a valid proof resource name`);
  return names;
}

/**
 * The names for the MCP endpoint's own Worker and database (epic 5, story 9), made from the same suffix as the project's, so one
 * teardown ledger covers both. It has no Workflow; the field is filled with a name that is never created, so the type stays one.
 */
export function mcpResourceNames(suffix: string): ResourceNames {
  const base = resourceNames(suffix);
  const names = { suffix, script: `${base.script}-mcp`, database: `${base.script}-mcp-db`, workflow: `${base.script}-mcp-unused` };
  for (const name of [names.script, names.database, names.workflow]) if (!isProofName(name)) throw new Error(`"${name}" is not a valid proof resource name`);
  return names;
}

/** A fresh suffix from the given random bytes (injected so tests are deterministic). */
export function newSuffix(randomBytes: (n: number) => Uint8Array): string {
  return Buffer.from(randomBytes(4)).toString("hex");
}

export function assertProofName(name: string): void {
  if (!isProofName(name)) throw new Error(`refusing to touch "${name}": it does not carry the proof's prefix ${PROOF_PREFIX}`);
}

/** Which names a ledger may record and a teardown may delete. Every ledger has one; the default is the proof's. */
export interface NamePolicy {
  prefix: string;
  isName(name: string): boolean;
  assertName(name: string): void;
}

export const PROOF_NAME_POLICY: NamePolicy = { prefix: PROOF_PREFIX, isName: isProofName, assertName: assertProofName };

/**
 * Story R53: the live Studio deploy proof's own names. Studio names an environment's resources px-<project>-<env>..., and
 * the proof's project is tangebricks-test-<8 hex>, so every resource it makes starts with px-tangebricks-test-<8 hex>-:
 * distinct from projectx-poc-*, and from anything else in the account.
 */
export const STUDIO_TEST_PREFIX = "px-tangebricks-test-";
const STUDIO_TEST_NAME = /^px-tangebricks-test-[0-9a-f]{8}-[a-z0-9][a-z0-9-]{0,60}$/;
export const isStudioTestName = (name: string): boolean => STUDIO_TEST_NAME.test(name);
export const STUDIO_TEST_NAME_POLICY: NamePolicy = {
  prefix: STUDIO_TEST_PREFIX,
  isName: isStudioTestName,
  assertName(name) {
    if (!isStudioTestName(name)) throw new Error(`refusing to touch "${name}": it does not carry the live Studio proof's prefix ${STUDIO_TEST_PREFIX}<8 hex>-`);
  },
};
/** The Studio project id the live proof deploys, for a ledger suffix. */
export const studioTestProject = (suffix: string): string => {
  if (!/^[0-9a-f]{8}$/.test(suffix)) throw new Error("the suffix must be 8 hexadecimal characters");
  return `tangebricks-test-${suffix}`;
};
