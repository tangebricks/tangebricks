// Story 1.19: secrets the platform can make itself, and what a real upload needs to run code that imports node:*.
//
// A brick secret its manifest marks `generate: "random-32-bytes"` (core-auth's BETTER_AUTH_SECRET) is internal to the brick,
// so no person has to invent it. On a preview deploy the owner approved (or a Studio session deploy), Studio makes 32 random
// bytes with Web Crypto, seals them into the project's vault as a brick_secret row and binds the ref. A later deploy finds the
// row and reuses it: the value is never generated twice. Production never generates (packages/deploy computeDeployPlan).
//
// The value exists only here and in the sealed row. Nothing returns it: callers get names and refs, the audit row holds names
// and refs, and the vault row's key hint is a fixed word rather than the value's last characters.

import type { D1Like } from "@poc/sdk";
import { encryptSecretValue } from "./secrets-vault.ts";

/** What the vault row of a generated secret shows instead of the usual last-four-characters hint. */
export const GENERATED_SECRET_KEY_HINT = "generated";

/** The vault ref a generated secret is stored under: the same spelling the deploy plan's vault matching suggests. */
export function generatedSecretRef(name: string): string {
  return `sec_${name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

/** 32 random bytes from Web Crypto, base64url without padding (43 characters). */
export function generateSecretValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SecretToGenerate {
  name: string;
  requiredByBrick: string;
}

/**
 * Generates and seals each secret that has no valid vault row yet; a row that already exists is left alone (re-deploys
 * reuse the stored value). Returns the names and refs it stored, never a value.
 */
export async function storeGeneratedSecrets(params: {
  db: D1Like;
  vaultKey: string | undefined;
  orgId: string;
  project: string;
  actorId: string;
  secrets: readonly SecretToGenerate[];
  now?: Date;
}): Promise<Array<{ name: string; ref: string; brick: string; created: boolean }>> {
  const out: Array<{ name: string; ref: string; brick: string; created: boolean }> = [];
  const nowIso = (params.now ?? new Date()).toISOString();
  for (const secret of params.secrets) {
    const ref = generatedSecretRef(secret.name);
    const existing = await params.db
      .prepare("SELECT ref FROM studio_secret_vault WHERE project_id = ? AND ref = ? AND status = 'valid' LIMIT 1")
      .bind(params.project, ref)
      .first<{ ref: string }>();
    if (existing) {
      out.push({ name: secret.name, ref, brick: secret.requiredByBrick, created: false });
      continue;
    }
    const sealed = await encryptSecretValue(generateSecretValue(), params.vaultKey);
    // INSERT only where no row is: a row another request stored meanwhile is kept, never overwritten. Scoped to preview: a
    // direct production plan never uses it (only a promotion from preview does).
    const inserted = await params.db
      .prepare(
        `INSERT INTO studio_secret_vault (
           id, org_id, project_id, ref, kind, label, app_or_brick, env_scope,
           ciphertext_b64, iv_b64, key_hint, status, created_by, updated_at
         ) VALUES (?, ?, ?, ?, 'brick_secret', ?, ?, 'preview', ?, ?, ?, 'valid', ?, ?)
         ON CONFLICT(project_id, ref) DO NOTHING`,
      )
      .bind(
        `vault_${params.project}_${ref}`,
        params.orgId,
        params.project,
        ref,
        secret.name,
        secret.requiredByBrick,
        sealed.ciphertextB64,
        sealed.ivB64,
        GENERATED_SECRET_KEY_HINT,
        params.actorId,
        nowIso,
      )
      .run();
    out.push({ name: secret.name, ref, brick: secret.requiredByBrick, created: (inserted.meta?.changes ?? 0) > 0 });
  }
  return out;
}

/** A `node:*` import (static, re-export, dynamic or require) left in bundled code. */
const NODE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']node:[a-z_/]+["']/;

/**
 * The compatibility flags a real upload carries: ["nodejs_compat"] when the bundler says so or the bundle imports `node:*`;
 * otherwise none, so a project without such an import uploads the same metadata as before. The assembled wrangler.jsonc is
 * not consulted: the assembler writes nodejs_compat there for every project with an identity guard (oidc-verify included),
 * which would change the upload of projects that import nothing from Node.
 */
export function realUploadCompatibilityFlags(built: { code: string; compatibilityFlags?: string[] }): string[] {
  const needed = (built.compatibilityFlags ?? []).includes("nodejs_compat") || NODE_IMPORT.test(built.code);
  return needed ? ["nodejs_compat"] : [];
}
