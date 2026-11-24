import { describe, expect, it } from "vitest";
import {
  EgressForbiddenError,
  assertPublicUrl,
  createPublicUrlFetch,
  isForbiddenIntegrationHost,
  isPrivateAddress,
  type HostResolver,
} from "../src/index.ts";

const publicResolver: HostResolver = async () => ["93.184.216.34"];

interface Call {
  url: string;
  init?: RequestInit;
}

function recordingFetch(respond: (url: string) => Response = () => new Response("ok", { status: 200 })) {
  const calls: Call[] = [];
  const base = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return respond(url);
  };
  return { calls, base };
}

async function expectRefused(promise: Promise<unknown>, code = "EGRESS_FORBIDDEN"): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EgressForbiddenError);
  expect((err as EgressForbiddenError).code).toBe(code);
}

describe("public URL guard (SSRF)", () => {
  it("SSRF_PRIVATE_LITERAL: refuses loopback, private, IPv6 loopback and metadata IP literals without fetching", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, { resolveHost: publicResolver });
    for (const url of [
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0/",
      "http://2130706433/", // 127.0.0.1 in integer form; the URL parser normalises it
    ]) {
      await expectRefused(guarded(url, { method: "POST", body: "{}" }));
    }
    expect(calls).toHaveLength(0);
  });

  it("SSRF_HOSTNAME: refuses localhost, *.local, *.internal and metadata host names", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, { resolveHost: publicResolver });
    for (const url of [
      "http://localhost/",
      "http://localhost./",
      "http://api.localhost/",
      "http://printer.local/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://service.internal/",
    ]) {
      await expectRefused(guarded(url));
    }
    expect(calls).toHaveLength(0);
  });

  it("SSRF_RESOLVES_PRIVATE: refuses a public-looking host whose resolver answers with a private address", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, {
      resolveHost: async (host) => (host === "evil.example.com" ? ["93.184.216.34", "10.1.2.3"] : ["93.184.216.34"]),
    });
    await expectRefused(guarded("https://evil.example.com/hook"));
    expect(calls).toHaveLength(0);
  });

  it("refuses a host that resolves to no addresses (intranet-only name, DoH outage)", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, { resolveHost: async () => [] });
    await expectRefused(guarded("http://intranet.example.com/"));
    expect(calls).toHaveLength(0);
  });

  it("refuses a host whose lookup throws", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, {
      resolveHost: async () => {
        throw new Error("DoH unreachable");
      },
    });
    await expectRefused(guarded("https://example.com/hook"));
    expect(calls).toHaveLength(0);
  });

  it("applies the request timeout to DNS resolution (a hanging resolver yields EGRESS_TIMEOUT)", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, {
      resolveHost: () => new Promise<string[]>(() => {}),
      timeoutMs: 50,
    });
    await expectRefused(guarded("https://example.com/hook"), "EGRESS_TIMEOUT");
    expect(calls).toHaveLength(0);
  });

  it("classifies IPv6 forms that embed a private IPv4 address", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, { resolveHost: publicResolver });
    // IPv4-compatible ::a.b.c.d
    expect(isPrivateAddress("::127.0.0.1")).toBe(true);
    await expectRefused(guarded("http://[::127.0.0.1]/"));
    // NAT64 64:ff9b::/96
    expect(isPrivateAddress("64:ff9b::a9fe:a9fe")).toBe(true); // 169.254.169.254
    await expectRefused(guarded("http://[64:ff9b::10.0.0.1]/"));
    expect(isPrivateAddress("64:ff9b::808:808")).toBe(false); // 8.8.8.8
    // 6to4 2002::/16
    expect(isPrivateAddress("2002:7f00:1::")).toBe(true); // 127.0.0.1
    await expectRefused(guarded("http://[2002:c0a8:101::1]/")); // 192.168.1.1
    expect(isPrivateAddress("2002:808:808::1")).toBe(false); // 8.8.8.8
    expect(calls).toHaveLength(0);
  });

  it("SSRF_REDIRECT: refuses at the hop when a public URL redirects to an internal address", async () => {
    const { calls, base } = recordingFetch((url) =>
      url.startsWith("https://example.com/")
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })
        : new Response("internal", { status: 200 }),
    );
    const guarded = createPublicUrlFetch(base, { resolveHost: publicResolver });
    await expectRefused(guarded("https://example.com/hook", { method: "POST", body: "{}" }));
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/hook"]);
    expect(calls[0]!.init?.redirect).toBe("manual");
  });

  it("follows a redirect to another public URL and re-validates it", async () => {
    const { calls, base } = recordingFetch((url) =>
      url === "https://example.com/old"
        ? new Response(null, { status: 307, headers: { location: "https://example.org/new" } })
        : new Response("done", { status: 200 }),
    );
    const resolved: string[] = [];
    const guarded = createPublicUrlFetch(base, {
      resolveHost: async (host) => {
        resolved.push(host);
        return ["93.184.216.34"];
      },
    });
    const res = await guarded("https://example.com/old", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/old", "https://example.org/new"]);
    expect(resolved).toEqual(["example.com", "example.org"]);
  });

  it("stops after maxRedirects", async () => {
    const { base } = recordingFetch(() => new Response(null, { status: 302, headers: { location: "https://example.com/loop" } }));
    const guarded = createPublicUrlFetch(base, { resolveHost: publicResolver, maxRedirects: 2 });
    await expectRefused(guarded("https://example.com/loop"), "EGRESS_TOO_MANY_REDIRECTS");
  });

  it("SSRF_CREDENTIALS: refuses URLs with embedded credentials", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, { resolveHost: publicResolver });
    await expectRefused(guarded("https://user:pass@example.com/"));
    expect(calls).toHaveLength(0);
  });

  it("refuses non-http schemes and malformed URLs", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, { resolveHost: publicResolver });
    await expectRefused(guarded("file:///etc/passwd"));
    await expectRefused(guarded("ftp://example.com/"));
    await expectRefused(guarded("not a url"));
    expect(calls).toHaveLength(0);
  });

  it("PUBLIC_OK: fetches a public URL whose resolver returns a public IP", async () => {
    const { calls, base } = recordingFetch();
    const guarded = createPublicUrlFetch(base, { resolveHost: publicResolver });
    const res = await guarded("https://example.com/hook", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.com/hook");
    expect(calls[0]!.init?.method).toBe("POST");
    await expect(assertPublicUrl(new URL("http://93.184.216.34:8080/x"), publicResolver)).resolves.toBeUndefined();
  });

  it("keeps the address and integration-host classifiers the runtime and assembler reuse", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isForbiddenIntegrationHost("api.stripe.com")).toBe(false);
    expect(isForbiddenIntegrationHost("localhost")).toBe(true);
    expect(isForbiddenIntegrationHost("10.0.0.1")).toBe(true);
    expect(isForbiddenIntegrationHost("*.example.com")).toBe(true);
  });
});
