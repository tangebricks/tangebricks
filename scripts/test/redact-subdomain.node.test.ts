import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WORKERS_SUBDOMAIN_FILE, resolveWorkerUrl } from "../../packages/deploy/src/context.ts";
import { canonical } from "../../packages/deploy/src/h10.ts";
import {
  ACCOUNT_SUBDOMAIN_PLACEHOLDER,
  accountSubdomainOf,
  redactCallsAndResult,
  redactWorkersDevSubdomains,
  redactWorkersDevText,
} from "../lib/redact-subdomain.ts";

// The account's workers.dev subdomain is kept out of committed evidence: every live evidence writer passes its texts
// through scripts/lib/redact-subdomain.ts before hashing. "example-acct" stands in for a real account's subdomain.

const SUB = "example-acct";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("redactWorkersDevText", () => {
  test("replaces the account label and keeps the worker name, scheme, path and the rest of the text", () => {
    expect(ACCOUNT_SUBDOMAIN_PLACEHOLDER).toBe("<account-subdomain>");
    expect(redactWorkersDevText(`switched on https://px-app-1234-preview.${SUB}.workers.dev/mcp?x=1`)).toBe(
      "switched on https://px-app-1234-preview.<account-subdomain>.workers.dev/mcp?x=1",
    );
    expect(redactWorkersDevText(`a.${SUB}.workers.dev and B.${SUB.toUpperCase()}.WORKERS.DEV`)).toBe(
      "a.<account-subdomain>.workers.dev and B.<account-subdomain>.WORKERS.DEV",
    );
  });

  test("leaves a bare <name>.workers.dev host, the placeholder itself and unrelated hosts alone (idempotent)", () => {
    for (const text of [
      "https://px-drift-ui-app-preview.workers.dev",
      "https://x.<account-subdomain>.workers.dev",
      "https://api.cloudflare.com/client/v4",
      "<project>.<subdomain>.workers.dev",
    ]) {
      expect(redactWorkersDevText(text)).toBe(text);
    }
    const once = redactWorkersDevText(`https://w.${SUB}.workers.dev`);
    expect(redactWorkersDevText(once)).toBe(once);
  });

  test("a known subdomain is replaced wherever it stands as a whole label, not inside longer words", () => {
    expect(redactWorkersDevText(`"value": "${SUB}"`, { known: [SUB] })).toBe(`"value": "<account-subdomain>"`);
    expect(redactWorkersDevText(`not-${SUB}-here ${SUB}x`, { known: [SUB, null, undefined] })).toBe(`not-${SUB}-here ${SUB}x`);
  });

  test("accountSubdomainOf reads the label from an address", () => {
    expect(accountSubdomainOf(`https://w-1.${SUB}.workers.dev/x`)).toBe(SUB);
    expect(accountSubdomainOf("https://w.workers.dev")).toBeUndefined();
  });
});

describe("redactWorkersDevSubdomains", () => {
  test("walks nested JSON (values and keys), returns a copy, and leaves non-strings unchanged", () => {
    const input = {
      url: `https://w.${SUB}.workers.dev`,
      n: 3,
      ok: true,
      none: null,
      list: [{ deep: [`https://v.${SUB}.workers.dev/healthz`] }],
      [`k.${SUB}.workers.dev`]: 1,
    };
    const out = redactWorkersDevSubdomains(input);
    expect(JSON.stringify(out)).not.toContain(SUB);
    expect(out.url).toBe("https://w.<account-subdomain>.workers.dev");
    expect(out.list[0]!.deep[0]).toBe("https://v.<account-subdomain>.workers.dev/healthz");
    expect(out).toMatchObject({ n: 3, ok: true, none: null, "k.<account-subdomain>.workers.dev": 1 });
    expect(input.url).toContain(SUB);
  });
});

describe("redactCallsAndResult", () => {
  test("redacts both texts and re-points callsSha256 at the redacted calls text, which stays canonical", () => {
    const calls = {
      commandStartedAt: "2026-01-01T00:00:00.000Z",
      facts: { url: `https://projectx-poc-0a1b2c3d.${SUB}.workers.dev`, changes: [`switched on https://projectx-poc-0a1b2c3d.${SUB}.workers.dev`] },
    };
    const raw = canonical(calls as never);
    const { callsText, result } = redactCallsAndResult(raw, {
      schema: 1,
      callsSha256: sha(raw),
      note: `reached https://projectx-poc-0a1b2c3d.${SUB}.workers.dev`,
    });
    expect(callsText).not.toContain(SUB);
    expect(JSON.stringify(result)).not.toContain(SUB);
    expect(result.callsSha256).toBe(sha(callsText));
    expect(canonical(JSON.parse(callsText) as never)).toBe(callsText);
  });
});

describe("resolveWorkerUrl (the later live scripts get the real address back from the state folder)", () => {
  test("fills the placeholder from the state folder, else from PX_WORKERS_SUBDOMAIN, and refuses without either", () => {
    const state = mkdtempSync(join(tmpdir(), "redact-sub-"));
    roots.push(state);
    const redacted = "https://projectx-poc-0a1b2c3d.<account-subdomain>.workers.dev";
    expect(resolveWorkerUrl("https://w.other.workers.dev", state, {})).toBe("https://w.other.workers.dev");
    expect(() => resolveWorkerUrl(redacted, state, {})).toThrow(/PX_WORKERS_SUBDOMAIN/);
    expect(resolveWorkerUrl(redacted, state, { PX_WORKERS_SUBDOMAIN: SUB })).toBe(`https://projectx-poc-0a1b2c3d.${SUB}.workers.dev`);
    writeFileSync(join(state, WORKERS_SUBDOMAIN_FILE), `${SUB}\n`);
    expect(resolveWorkerUrl(redacted, state, {})).toBe(`https://projectx-poc-0a1b2c3d.${SUB}.workers.dev`);
  });
});
