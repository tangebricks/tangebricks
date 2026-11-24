import { describe, expect, it, vi } from "vitest";
import {
  createHardenedFetch,
  isPrivateAddress,
} from "../src/index.ts";
import type { EgressPolicy } from "../src/index.ts";

describe("UC1.3 — Hardened Egress Fetch", () => {
  const allowedHosts = ["api.github.com", "api.stripe.com"];

  it("(a) throws INTEGRATION_REDIRECT_FORBIDDEN when redirect targets unallowed host (e.g. 302 to evil.example)", async () => {
    const baseFetcher = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof Request ? url.url : url.toString();
      if (u === "https://api.github.com/v1/resource") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/malicious" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const hardened = createHardenedFetch(baseFetcher, {
      allowedHosts,
      resolveHost: undefined,
    });

    await expect(hardened("https://api.github.com/v1/resource")).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/INTEGRATION_REDIRECT_FORBIDDEN/),
      }),
    );
  });

  it("(b) throws INTEGRATION_TIMEOUT after timeoutMs when response never resolves (50ms)", async () => {
    const baseFetcher = vi.fn().mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response("late response after timeout", { status: 200 }));
        }, 200);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
    });

    const hardened = createHardenedFetch(baseFetcher, {
      allowedHosts,
      timeoutMs: 50,
      resolveHost: undefined,
    });

    await expect(hardened("https://api.github.com/hang")).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/INTEGRATION_TIMEOUT/),
      }),
    );
  });

  it("(c) throws INTEGRATION_RESPONSE_TOO_LARGE when response stream exceeds maxResponseBytes cap (20MB stream with 10MB cap)", async () => {
    const chunkSize = 1024 * 1024; // 1 MB
    const totalChunks = 20; // 20 MB

    const baseFetcher = vi.fn().mockImplementation(async () => {
      let count = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (count < totalChunks) {
            controller.enqueue(new Uint8Array(chunkSize));
            count += 1;
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    });

    const hardened = createHardenedFetch(baseFetcher, {
      allowedHosts,
      maxResponseBytes: 10 * 1024 * 1024,
      resolveHost: undefined,
    });

    const res = await hardened("https://api.github.com/large-data");
    await expect(res.text()).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/INTEGRATION_RESPONSE_TOO_LARGE/),
      }),
    );
  });

  it("(d) follows same-host redirect to new path and preserves Authorization header", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const baseFetcher = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url instanceof Request ? url.url : url.toString();
      const headers = new Headers(init?.headers);
      calls.push({ url: u, headers });

      if (u === "https://api.github.com/old-path") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/new-path" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const hardened = createHardenedFetch(baseFetcher, {
      allowedHosts,
      resolveHost: undefined,
    });

    const res = await hardened("https://api.github.com/old-path", {
      headers: {
        Authorization: "Bearer ghp_secret_token_12345",
      },
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.github.com/old-path");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer ghp_secret_token_12345");
    expect(calls[1]!.url).toBe("https://api.github.com/new-path");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer ghp_secret_token_12345");
  });

  it("(e) drops Authorization, Cookie, and sensitive headers on cross-host redirect to another allowed host", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const baseFetcher = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url instanceof Request ? url.url : url.toString();
      const headers = new Headers(init?.headers);
      calls.push({ url: u, headers });

      if (u === "https://api.github.com/start") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://api.stripe.com/target" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const hardened = createHardenedFetch(baseFetcher, {
      allowedHosts,
      resolveHost: undefined,
    });

    const res = await hardened("https://api.github.com/start", {
      headers: {
        Authorization: "Bearer sensitive_token_abc",
        Cookie: "session_id=12345",
        "X-Api-Key": "my-secret-key",
      },
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.github.com/start");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sensitive_token_abc");
    expect(calls[0]!.headers.get("cookie")).toBe("session_id=12345");

    expect(calls[1]!.url).toBe("https://api.stripe.com/target");
    expect(calls[1]!.headers.get("authorization")).toBeNull();
    expect(calls[1]!.headers.get("cookie")).toBeNull();
    expect(calls[1]!.headers.get("x-api-key")).toBeNull();
  });

  it("(f) throws INTEGRATION_PRIVATE_ADDRESS when resolveHost returns private, loopback, link-local, CGNAT, or metadata IP", async () => {
    const privateIps = [
      "10.0.0.5",
      "169.254.169.254",
      "127.0.0.1",
      "::1",
      "fc00::1",
      "100.64.0.1",
    ];

    for (const badIp of privateIps) {
      const baseFetcher = vi.fn();
      const resolveHost = vi.fn().mockResolvedValue([badIp]);

      const hardened = createHardenedFetch(baseFetcher, {
        allowedHosts,
        resolveHost,
      });

      await expect(hardened("https://api.github.com/users")).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringMatching(/INTEGRATION_PRIVATE_ADDRESS/),
        }),
      );
      expect(baseFetcher).not.toHaveBeenCalled();
    }
  });

  it("(g) AC1: always calls base fetcher with redirect: 'manual' and a signal", async () => {
    let capturedInit: RequestInit | undefined;
    const baseFetcher = vi.fn().mockImplementation(async (_url, init) => {
      capturedInit = init;
      return new Response("ok", { status: 200 });
    });

    const hardened = createHardenedFetch(baseFetcher, {
      allowedHosts,
      resolveHost: undefined,
    });

    await hardened("https://api.github.com/test");

    expect(capturedInit).toBeDefined();
    expect(capturedInit?.redirect).toBe("manual");
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("(h) isPrivateAddress identifies private, loopback, CGNAT, link-local, multicast, and ULA IPv4 and IPv6", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("172.16.5.10")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("100.127.255.255")).toBe(true);
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    expect(isPrivateAddress("224.0.0.1")).toBe(true);
    expect(isPrivateAddress("255.255.255.255")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("ff02::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);

    // Public IPs should return false
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("140.82.121.4")).toBe(false); // GitHub
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false); // Cloudflare
  });
});
