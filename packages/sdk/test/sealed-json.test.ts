import { describe, expect, it } from "vitest";
import { SealedJsonError, hasSealingKey, sealJson, unsealJson } from "../src/index.ts";

// Story 2.4: the shared AES-GCM sealing helper (moved from integration-connections).
const opts = (associatedData: string, keyMaterial: string | undefined = "k-0123456789", domain = "test-domain-v1") => ({
  keyMaterial,
  keyName: "TEST_KEY",
  domain,
  associatedData,
});

describe("sealJson / unsealJson", () => {
  it("round-trips, and the envelope holds no plaintext", async () => {
    const sealed = await sealJson({ apiKey: "sk_secret_value" }, opts("ws_a:chn_1"));
    expect(sealed).not.toContain("sk_secret_value");
    expect(JSON.parse(sealed)).toMatchObject({ v: 1 });
    expect(await unsealJson(sealed, opts("ws_a:chn_1"))).toEqual({ apiKey: "sk_secret_value" });
  });

  it("other associated data, another key or another domain fails INTEGRITY", async () => {
    const sealed = await sealJson({ a: 1 }, opts("ws_a:chn_1"));
    for (const o of [opts("ws_b:chn_1"), opts("ws_a:chn_2"), opts("ws_a:chn_1", "other-key"), opts("ws_a:chn_1", "k-0123456789", "other-domain")]) {
      await expect(unsealJson(sealed, o)).rejects.toMatchObject({ code: "INTEGRITY" });
    }
  });

  it("no key fails MISSING_KEY naming the key, never a value; blank associated data and malformed envelopes are refused", async () => {
    await expect(sealJson({ a: 1 }, { ...opts("x"), keyMaterial: undefined })).rejects.toThrow(/Missing required secret TEST_KEY/);
    await expect(sealJson({ a: 1 }, opts("x", "   "))).rejects.toBeInstanceOf(SealedJsonError);
    await expect(sealJson({ a: 1 }, opts(" "))).rejects.toMatchObject({ code: "MISSING_ASSOCIATED_DATA" });
    await expect(unsealJson("not json", opts("x"))).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(unsealJson("{}", opts("x"))).rejects.toMatchObject({ code: "MALFORMED" });
    expect(hasSealingKey("k")).toBe(true);
    expect(hasSealingKey(" ")).toBe(false);
    expect(hasSealingKey(undefined)).toBe(false);
  });
});

describe("compatibility with integration-connections' sealing before story 2.4", () => {
  // Produced by bricks/integration-connections/src/crypto.ts at 7f7b35d (sealWorkspaceCredentials, before it used this
  // helper) with the key, workspace and plaintext below. It must still open, or stored connection credentials would be lost.
  const LEGACY_ENVELOPE =
    '{"v":1,"iv":"19salchJh8975BW/","ct":"e6vfDvY3coYiIc4BytLZo34fUo+DBociCt0yIMVVgK4vJFGeOJkHE5xKBz96o8DiH04PqEOvknoScZjF9En7VLPkGUb4lSEhJHYq6Lk="}';

  it("a fixed legacy envelope opens with unsealJson (domain projectx-studio-vault-v1, associated data = workspace id)", async () => {
    const opened = await unsealJson(LEGACY_ENVELOPE, {
      keyMaterial: "legacy-fixed-vector-key-0123456789",
      keyName: "PX_CONN_KEY",
      domain: "projectx-studio-vault-v1",
      associatedData: "ws_legacy_vector",
    });
    expect(opened).toEqual({ provider: "slack", accessToken: "xoxb-legacy-fixed-vector" });
    await expect(
      unsealJson(LEGACY_ENVELOPE, { keyMaterial: "legacy-fixed-vector-key-0123456789", keyName: "PX_CONN_KEY", domain: "projectx-studio-vault-v1", associatedData: "ws_other" }),
    ).rejects.toMatchObject({ code: "INTEGRITY" });
  });
});
