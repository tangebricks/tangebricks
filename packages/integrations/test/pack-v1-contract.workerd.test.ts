import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationManifestSchema, type Catalog } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import {
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  GraphWorkflow,
  rehearseStep,
  runGraph,
} from "@poc/runtime";
import { applyMigration, createMemoryBlobStore } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import {
  WebhookService,
  signHmacSha256,
  signStripeWebhookPayload,
} from "../../../bricks/webhook-gateway/src/index.ts";
import webhookGatewayMigrationSql from "../../../bricks/webhook-gateway/migrations/0001_webhook_gateway.sql?raw";

const PACK_V1_APPS = ["discord", "stripe", "slack", "google", "github"] as const;

describe("Story 10.4 — Curated Integration Pack v1 Contract Suite in workerd (AC 2, AC 3, AC 4)", () => {
  const db = env.DB as unknown as D1Like;

  beforeEach(async () => {
    await db.prepare("DROP TABLE IF EXISTS px_webhook_deliveries").run();
    await db.prepare("DROP TABLE IF EXISTS wh_subscriptions").run();
    await db.prepare("DROP TABLE IF EXISTS wh_deliveries").run();
    await db.prepare("DROP TABLE IF EXISTS wh_endpoints").run();
    await db.prepare("DROP TABLE IF EXISTS px_connections").run();
    await applyMigration(db, webhookGatewayMigrationSql);
  });

  it("validates all 5 Pack v1 manifests in catalog.integrations with 10..30 operations, triggers, maturity metadata, and explicit 401/429 errorMappings", () => {
    const integrations = catalog.integrations ?? {};
    expect(Object.keys(integrations).sort()).toEqual([...PACK_V1_APPS].sort());

    let totalOperations = 0;
    for (const app of PACK_V1_APPS) {
      const entry = integrations[app];
      expect(entry, `catalog.integrations.${app} must exist`).toBeDefined();
      const manifest = entry!.manifest;

      const parsed = IntegrationManifestSchema.safeParse(manifest);
      expect(parsed.success, `${app} manifest must pass IntegrationManifestSchema`).toBe(true);

      expect(manifest.operations.length).toBeGreaterThanOrEqual(10);
      expect(manifest.operations.length).toBeLessThanOrEqual(30);
      totalOperations += manifest.operations.length;

      expect(manifest.triggers?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(manifest.ui.maturity).toBe("beta");
      expect(manifest.ui.maturityReason).toBe(
        "Verified only against recorded fixtures; promotion requires a passing live canary within the freshness window (UC5.5) and fidelity gate (UC2).",
      );
      expect(manifest.ui.behaviourTest).toBe(
        "packages/integrations/test/pack-v1-contract.workerd.test.ts",
      );

      expect(manifest.errorMappings).toBeDefined();
      const mappings = manifest.errorMappings as Record<string, { code: string; hint?: string }>;
      expect(mappings["401"]?.code).toBe("CONNECTION_EXPIRED");
      expect(mappings["401"]?.hint?.length).toBeGreaterThan(5);
      expect(mappings["429"]?.code).toBe("RATE_LIMITED");
    }

    expect(totalOperations).toBeGreaterThanOrEqual(50);
  });

  it("executes representative actions, auth formatting, form-urlencoded & JSON bodies, and cursor/link pagination across Discord, Stripe, Slack, Google, and GitHub with rehearseStep == runGraph parity", async () => {
    const registry = buildRegistryFromCatalog(catalog);

    const capturedRequests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }> = [];

    const recordedFixtureFetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = String(input);
      const u = new URL(urlStr);
      const headersObj = new Headers(init?.headers);
      const headersRecord: Record<string, string> = {};
      headersObj.forEach((v, k) => {
        headersRecord[k.toLowerCase()] = v;
      });
      const bodyStr = typeof init?.body === "string" ? init.body : null;
      capturedRequests.push({
        url: urlStr,
        method: init?.method ?? "GET",
        headers: headersRecord,
        body: bodyStr,
      });

      // 1. Discord fixtures
      if (u.hostname === "discord.com") {
        if (u.pathname === "/api/v10/channels/ch_101/messages" && init?.method === "POST") {
          const parsed = JSON.parse(bodyStr ?? "{}") as Record<string, unknown>;
          return Response.json({
            id: "msg_discord_1",
            channel_id: "ch_101",
            content: parsed.content,
            embeds: parsed.embeds ?? [],
          });
        }
        if (u.pathname === "/api/v10/channels/ch_101/messages" && init?.method === "GET") {
          const after = u.searchParams.get("after");
          const page = after === "cur_2" ? 2 : after === "cur_3" ? 3 : 1;
          return Response.json({
            messages: [{ id: `msg_p${page}`, content: `Page ${page}` }],
            next_after: page < 3 ? `cur_${page + 1}` : "",
          });
        }
      }

      // 2. Stripe fixtures
      if (u.hostname === "api.stripe.com") {
        if (u.pathname === "/v1/customers" && init?.method === "POST") {
          const form = new URLSearchParams(bodyStr ?? "");
          return Response.json({
            id: "cus_stripe_1",
            object: "customer",
            email: form.get("email"),
            name: form.get("name"),
          });
        }
        if (u.pathname === "/v1/customers" && init?.method === "GET") {
          const after = u.searchParams.get("starting_after");
          const page = after === "cus_p1" ? 2 : 1;
          return Response.json({
            object: "list",
            data: [{ id: `cus_p${page}` }],
            has_more: page === 1,
            next_starting_after: page === 1 ? "cus_p1" : "",
          });
        }
        if (u.pathname === "/v1/payment_intents" && init?.method === "POST") {
          const form = new URLSearchParams(bodyStr ?? "");
          return Response.json({
            id: "pi_stripe_1",
            amount: Number(form.get("amount")),
            currency: form.get("currency"),
            status: "requires_payment_method",
          });
        }
      }

      // 3. Slack fixtures
      if (u.hostname === "slack.com") {
        if (u.pathname === "/api/chat.postMessage") {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(bodyStr ?? "{}") as Record<string, unknown>;
          } catch {
            const params = new URLSearchParams(bodyStr ?? "");
            parsed = Object.fromEntries(params.entries());
          }
          return Response.json({
            ok: true,
            channel: parsed.channel,
            ts: "1730000100.0001",
            message: { text: parsed.text },
          });
        }
        if (u.pathname === "/api/conversations.list") {
          const cursor = u.searchParams.get("cursor");
          const page = cursor === "slack_cur_2" ? 2 : 1;
          return Response.json({
            ok: true,
            channels: [{ id: `C_${page}`, name: `chan-${page}` }],
            response_metadata: {
              next_cursor: page === 1 ? "slack_cur_2" : "",
            },
          });
        }
      }

      // 4. Google Workspace fixtures
      if (u.hostname === "www.googleapis.com") {
        if (u.pathname === "/calendar/v3/calendars/primary/events" && init?.method === "GET") {
          const pageToken = u.searchParams.get("pageToken");
          const page = pageToken === "gcal_p2" ? 2 : 1;
          return Response.json({
            kind: "calendar#events",
            items: [{ id: `evt_${page}`, summary: `Meeting ${page}` }],
            ...(page === 1 ? { nextPageToken: "gcal_p2" } : {}),
          });
        }
        if (u.pathname.startsWith("/v4/spreadsheets/sheet_123/values/") && init?.method === "POST") {
          const parsed = JSON.parse(bodyStr ?? "{}") as Record<string, unknown>;
          return Response.json({
            spreadsheetId: "sheet_123",
            updates: { updatedRows: Array.isArray(parsed.values) ? parsed.values.length : 1 },
          });
        }
        if (u.pathname === "/gmail/v1/users/me/messages/send" && init?.method === "POST") {
          return Response.json({
            id: "gmail_msg_1",
            threadId: "gmail_thr_1",
            labelIds: ["SENT"],
          });
        }
      }

      // 5. GitHub fixtures (including RFC 5988 Link pagination)
      if (u.hostname === "api.github.com") {
        if (u.pathname === "/repos/acme/platform/issues" && init?.method === "POST") {
          const parsed = JSON.parse(bodyStr ?? "{}") as Record<string, unknown>;
          return Response.json(
            {
              id: 9001,
              number: 42,
              title: parsed.title,
              state: "open",
            },
            { status: 201 },
          );
        }
        if (u.pathname === "/repos/acme/platform/issues" && init?.method === "GET") {
          const page = Number(u.searchParams.get("page") ?? "1");
          const headers = new Headers({ "content-type": "application/json" });
          if (page < 3) {
            headers.set(
              "Link",
              `<https://api.github.com/repos/acme/platform/issues?page=${page + 1}>; rel="next"`,
            );
          }
          return new Response(
            JSON.stringify({
              items: [{ number: page, title: `Issue page ${page}` }],
            }),
            { status: 200, headers },
          );
        }
      }

      return Response.json({ error: "unmatched_fixture", url: urlStr }, { status: 404 });
    };

    const executors = buildExecutorsFromCatalog(catalog, {
      integration: { fetcher: recordedFixtureFetcher },
    });

    const connections = {
      discord: { app: "discord", accessToken: "discord_oauth_token_abc" },
      stripe: { app: "stripe", accessToken: "sk_test_stripe_oauth_token" },
      slack: { app: "slack", accessToken: "xox" + "b-slack-token-abc" },
      google: { app: "google", accessToken: "ya29.google_oauth_token" },
      github: { app: "github", accessToken: "gho_github_oauth_token" },
    };

    // A) Discord createMessage + getChannelMessages pagination
    const discordCreateRehearsal = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_discord_msg",
        nodeType: "int:discord.createMessage",
        config: { },
        input: {
          channelId: "ch_101",
          content: "Build succeeded!",
          embeds: [{ title: "Deploy #12" }],
        },
      },
      { registry, executors, connections },
    );
    const discordCreateGraph = await runGraph(
      {
        nodes: [
          { id: "t", type: "trigger.manual", data: {} },
          {
            id: "n_discord_msg",
            type: "int:discord.createMessage",
            data: { },
          },
        ],
        edges: [{ id: "e1", source: "t", target: "n_discord_msg" }],
      },
      registry,
      executors,
      { workspaceId: "ws_test",
        payload: {
          channelId: "ch_101",
          content: "Build succeeded!",
          embeds: [{ title: "Deploy #12" }],
        },
        connections,
      },
    );
    expect(discordCreateRehearsal.ok).toBe(true);
    expect(discordCreateGraph.ok).toBe(true);
    expect(discordCreateRehearsal.output).toEqual(discordCreateGraph.outputs.n_discord_msg);

    const discordListRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_discord_list",
        nodeType: "int:discord.getChannelMessages",
        config: { },
        input: { channelId: "ch_101" },
      },
      { registry, executors, connections },
    );
    expect(discordListRes.ok).toBe(true);
    expect(discordListRes.output.messages).toHaveLength(3);

    // B) Stripe form-urlencoded createCustomer + cursor-paginated listCustomers
    const stripeCustomerRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_stripe_cus",
        nodeType: "int:stripe.createCustomer",
        config: { },
        input: { email: "billing@acme.dev", name: "Acme Corp" },
      },
      { registry, executors, connections },
    );
    expect(stripeCustomerRes.ok).toBe(true);
    expect(stripeCustomerRes.output.id).toBe("cus_stripe_1");
    const stripePostReq = capturedRequests.find(
      (r) => r.url === "https://api.stripe.com/v1/customers" && r.method === "POST",
    );
    expect(stripePostReq?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(stripePostReq?.body).toContain("email=billing%40acme.dev");

    const stripeListRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_stripe_list",
        nodeType: "int:stripe.listCustomers",
        config: { },
        input: {},
      },
      { registry, executors, connections },
    );
    expect(stripeListRes.ok).toBe(true);
    expect(stripeListRes.output.data).toEqual([{ id: "cus_p1" }, { id: "cus_p2" }]);

    // C) Slack chat_postMessage + conversations_list cursor pagination
    const slackPostRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_slack_post",
        nodeType: "int:slack.chat_postMessage",
        config: { },
        input: { channel: "C_OPS", text: "Hello Slack" },
      },
      { registry, executors, connections },
    );
    expect(slackPostRes.ok).toBe(true);
    expect(slackPostRes.output.ts).toBe("1730000100.0001");

    const slackListRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_slack_list",
        nodeType: "int:slack.conversations_list",
        config: { },
        input: {},
      },
      { registry, executors, connections },
    );
    expect(slackListRes.ok).toBe(true);
    expect(slackListRes.output.channels).toHaveLength(2);

    // D) Google Calendar list (Discovery imported) + Sheets append + Gmail send
    const googleCalRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_gcal_list",
        nodeType: "int:google.calendar_events_list",
        config: { },
        input: { calendarId: "primary" },
      },
      { registry, executors, connections },
    );
    expect(googleCalRes.ok).toBe(true);
    expect(googleCalRes.output.items).toHaveLength(2);

    const googleSheetsRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_gsheets_append",
        nodeType: "int:google.sheets_values_append",
        config: { },
        input: {
          spreadsheetId: "sheet_123",
          range: "Sheet1!A1:B1",
          values: [["Alice", 100]],
        },
      },
      { registry, executors, connections },
    );
    expect(googleSheetsRes.ok).toBe(true);

    const googleGmailRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_gmail_send",
        nodeType: "int:google.gmail_messages_send",
        config: { },
        input: { userId: "me", raw: "SGVsbG8gR21haWw=" },
      },
      { registry, executors, connections },
    );
    expect(googleGmailRes.ok).toBe(true);
    expect(googleGmailRes.output.id).toBe("gmail_msg_1");

    // E) GitHub createIssue + RFC 5988 Link-header pagination on listIssues
    const githubIssueRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_gh_issue",
        nodeType: "int:github.createIssue",
        config: { },
        input: { owner: "acme", repo: "platform", title: "Ship Pack v1" },
      },
      { registry, executors, connections },
    );
    expect(githubIssueRes.ok).toBe(true);
    expect(githubIssueRes.output.number).toBe(42);

    const githubListRes = await rehearseStep(
      { workspaceId: "ws_test",
        nodeId: "n_gh_list",
        nodeType: "int:github.listIssues",
        config: { },
        input: { owner: "acme", repo: "platform" },
      },
      { registry, executors, connections },
    );
    expect(githubListRes.ok).toBe(true);
    expect(githubListRes.output.items).toHaveLength(3);
  });

  it("enforces 429 rate-limit retry and 401 -> CONNECTION_EXPIRED error mapping across all 5 apps", async () => {
    const registry = buildRegistryFromCatalog(catalog);

    const representativeOps: Array<{
      app: (typeof PACK_V1_APPS)[number];
      nodeType: string;
      input: Record<string, unknown>;
    }> = [
      { app: "discord", nodeType: "int:discord.getGuild", input: { guildId: "g_1" } },
      { app: "stripe", nodeType: "int:stripe.getCustomer", input: { customerId: "cus_1" } },
      { app: "slack", nodeType: "int:slack.users_info", input: { user: "U_1" } },
      {
        app: "google",
        nodeType: "int:google.gmail_messages_get",
        input: { userId: "me", id: "m_1" },
      },
      {
        app: "github",
        nodeType: "int:github.getRepo",
        input: { owner: "acme", repo: "platform" },
      },
    ];

    const connections = {
      discord: { app: "discord", accessToken: "CANARY_DISCORD_TOK" },
      stripe: { app: "stripe", accessToken: "CANARY_STRIPE_TOK" },
      slack: { app: "slack", accessToken: "CANARY_SLACK_TOK" },
      google: { app: "google", accessToken: "CANARY_GOOGLE_TOK" },
      github: { app: "github", accessToken: "CANARY_GITHUB_TOK" },
    };

    for (const item of representativeOps) {
      // 1. 429 retry -> 200
      let attempts = 0;
      const sleepSpy = vi.fn().mockResolvedValue(undefined);
      const retryFetcher = async (): Promise<Response> => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ message: "rate_limited" }), {
            status: 429,
            headers: {
              "Retry-After": "0",
              "X-RateLimit-Reset": "0",
            },
          });
        }
        return Response.json({ ok: true, id: `${item.app}_ok` }, { status: 200 });
      };

      const retryExecutors = buildExecutorsFromCatalog(catalog, {
        integration: { fetcher: retryFetcher, sleep: sleepSpy },
      });
      const retryRes = await rehearseStep(
        { workspaceId: "ws_test",
          nodeId: `n_${item.app}_retry`,
          nodeType: item.nodeType,
          config: {},
          input: item.input,
        },
        { registry, executors: retryExecutors, connections },
      );
      expect(retryRes.ok, `${item.app} 429 retry should succeed`).toBe(true);
      expect(attempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledWith(0);

      // 2. 401 -> CONNECTION_EXPIRED with hint
      const unauthorizedFetcher = async (): Promise<Response> =>
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

      const unauthExecutors = buildExecutorsFromCatalog(catalog, {
        integration: { fetcher: unauthorizedFetcher },
      });
      const unauthRes = await rehearseStep(
        { workspaceId: "ws_test",
          nodeId: `n_${item.app}_401`,
          nodeType: item.nodeType,
          config: {},
          input: item.input,
        },
        { registry, executors: unauthExecutors, connections },
      );
      expect(unauthRes.ok).toBe(false);
      expect(unauthRes.error?.message).toContain("CONNECTION_EXPIRED");
      expect(unauthRes.error?.message).not.toContain(`CANARY_${item.app.toUpperCase()}_TOK`);
    }
  });

  it("verifies webhook signatures and deduplicates deliveries through bricks/webhook-gateway for all 5 apps", async () => {
    const gateway = new WebhookService(db);
    const dispatchedRuns: Array<{ app: string; triggerId: string; eventId: string }> = [];

    const secret = "whsec_pack_v1_shared_signing_secret_0123456789";
    const nowSec = 1730000000;

    const discordKeyPair = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as unknown as {
      publicKey: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
      privateKey: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
    };
    const discordPubKeyRaw = await crypto.subtle.exportKey("raw", discordKeyPair.publicKey);
    const discordPubKeyHex = Array.from(new Uint8Array(discordPubKeyRaw))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    for (const app of PACK_V1_APPS) {
      const manifest = catalog.integrations![app]!.manifest;
      const trigger = manifest.triggers![0]!;
      const subSecret = app === "discord" ? discordPubKeyHex : secret;

      const sub = await gateway.registerSubscription({
        id: `whsub_${app}`,
        workspaceId: "ws_pack_v1",
        workflowId: `wf_${app}`,
        app,
        triggerId: trigger.id,
        verifier: trigger.verifier,
        signatureHeader: trigger.signatureHeader,
        eventIdPath: trigger.eventIdPath,
        signingSecret: subSecret,
      });

      const eventPayloadObj =
        app === "google"
          ? { message: { messageId: `evt_${app}_001` }, state: "sync" }
          : app === "slack"
            ? { event_id: `evt_${app}_001`, event: { type: "app_mention" } }
            : app === "github"
              ? { delivery_id: `evt_${app}_001`, action: "opened" }
              : { id: `evt_${app}_001`, type: trigger.eventTypeFilter?.[0] ?? "ping" };
      const rawBody = JSON.stringify(eventPayloadObj);

      let validSigHeader: string;
      if (trigger.verifier === "stripe-signature") {
        validSigHeader = await signStripeWebhookPayload(rawBody, subSecret, nowSec);
      } else if (trigger.verifier === "shared-secret") {
        validSigHeader = subSecret;
      } else if (app === "slack" || trigger.verifier === "slack-v0") {
        validSigHeader = `v0=${await signHmacSha256(`v0:${nowSec}:${rawBody}`, subSecret)}`;
      } else if (app === "github" || trigger.verifier === "github-hmac-sha256") {
        validSigHeader = `sha256=${await signHmacSha256(rawBody, subSecret)}`;
      } else if (trigger.verifier === "ed25519" || trigger.verifier === "discord-ed25519") {
        const sigBuf = await crypto.subtle.sign(
          "Ed25519",
          discordKeyPair.privateKey,
          new TextEncoder().encode(rawBody),
        );
        validSigHeader = Array.from(new Uint8Array(sigBuf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      } else {
        validSigHeader = await signHmacSha256(rawBody, subSecret);
      }

      const deliveryHeaders: Record<string, string> = {
        [trigger.signatureHeader]: validSigHeader,
      };
      if (app === "slack" || trigger.verifier === "slack-v0") {
        deliveryHeaders["X-Slack-Request-Timestamp"] = String(nowSec);
      }

      // 1. Valid delivery starts workflow
      const firstDelivery = await gateway.ingestSubscriptionWebhook(
        sub.id,
        rawBody,
        deliveryHeaders,
        {
          adapter: {
            nowSeconds: () => nowSec,
            onTriggerWorkflow: ({ app: triggeredApp, triggerId, eventId }) => {
              dispatchedRuns.push({ app: triggeredApp, triggerId, eventId });
              return { runId: `run_${triggeredApp}_1` };
            },
          },
        },
      );
      expect(firstDelivery.ok, `${app} webhook delivery should pass`).toBe(true);
      if (firstDelivery.ok) {
        expect(firstDelivery.deduplicated).toBe(false);
        expect(firstDelivery.eventId).toBe(`evt_${app}_001`);
      }

      // 2. Duplicate delivery is deduplicated
      const secondDelivery = await gateway.ingestSubscriptionWebhook(
        sub.id,
        rawBody,
        deliveryHeaders,
        {
          adapter: {
            nowSeconds: () => nowSec,
            onTriggerWorkflow: () => {
              throw new Error("Should not trigger on duplicate delivery");
            },
          },
        },
      );
      expect(secondDelivery.ok).toBe(true);
      if (secondDelivery.ok) {
        expect(secondDelivery.deduplicated).toBe(true);
      }

      // 3. Invalid signature is rejected with 401
      const forgedDelivery = await gateway.ingestSubscriptionWebhook(
        sub.id,
        rawBody,
        { [trigger.signatureHeader]: "forged_signature_value" },
        {
          adapter: {
            nowSeconds: () => nowSec,
          },
        },
      );
      expect(forgedDelivery.ok).toBe(false);
      if (!forgedDelivery.ok) {
        expect(forgedDelivery.status).toBe(401);
      }
    }

    expect(dispatchedRuns).toHaveLength(5);
    expect(dispatchedRuns.map((d) => d.app).sort()).toEqual([...PACK_V1_APPS].sort());
  });

  it("AC1 (UC3.6) — No binary payload appears in workflow step output, carrying only {blobRef, contentType, size} via host BlobStore in GraphWorkflow", async () => {
    const blobStore = createMemoryBlobStore();
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n

    const binaryFixtureFetcher = async (input: Request | string | URL) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const u = new URL(urlStr);
      if (u.pathname === "/reports/download") {
        return new Response(pdfBytes, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const testCatalog: Catalog = {
      ...catalog,
      integrations: {
        ...catalog.integrations,
        testbinary: {
          nodes: undefined as any,
          manifest: {
            manifestVersion: 2,
            kind: "integration",
            app: "testbinary",
            version: "1.0.0",
            fidelity: {
              specHash: "sha256-test",
              importerVersion: "1.0.0",
              level: "curated",
              unsupported: [],
            },
            baseUrl: "https://example.com",
            allowedHosts: ["example.com"],
            auth: {
              type: "none",
            },
            operations: [
              {
                operationId: "downloadReport",
                label: "Download Report",
                summary: "Download PDF report",
                method: "GET",
                path: "/reports/download",
                sideEffects: "read",
                response: {
                  binary: true,
                  contentType: "application/pdf",
                  outputs: [
                    { id: "blobRef", dataType: "string" },
                    { id: "contentType", dataType: "string" },
                    { id: "size", dataType: "number" },
                  ],
                },
              },
            ],
            ui: {
              displayName: "Test Binary",
              summary: "Binary test app",
              maturity: "beta",
              category: "developer",
            },
          },
        },
      },
    };

    const registry = buildRegistryFromCatalog(testCatalog);
    const executors = buildExecutorsFromCatalog(testCatalog, {
      integration: {
        fetcher: binaryFixtureFetcher,
        blobStore,
      },
    });

    const workflow = new GraphWorkflow(registry, executors);
    const result = await workflow.start({ workspaceId: "ws_test",
      graph: {
        nodes: [
          { id: "t", type: "trigger.manual", data: {} },
          { id: "bin_node", type: "int:testbinary.downloadReport", data: {} },
        ],
        edges: [{ id: "e1", source: "t", target: "bin_node" }],
      },
      connections: {},
    });

    expect(result.ok).toBe(true);
    const stepOutput = result.outputs["bin_node"] as Record<string, unknown>;
    expect(stepOutput).toBeDefined();

    // AC1 Assertion: Step output carries only reference metadata { blobRef, contentType, size } and no raw bytes
    expect(typeof stepOutput.blobRef).toBe("string");
    expect(stepOutput.blobRef).toMatch(/^blob_[0-9a-f-]+$/);
    expect(stepOutput.contentType).toBe("application/pdf");
    expect(stepOutput.size).toBe(pdfBytes.length);
    expect(stepOutput.body).toEqual({
      blobRef: stepOutput.blobRef,
      contentType: "application/pdf",
      size: pdfBytes.length,
    });

    // Assert NO raw binary payload appears anywhere in workflow step output
    const serialized = JSON.stringify(stepOutput);
    expect(serialized).not.toContain("%PDF");
    expect(stepOutput).not.toHaveProperty("buffer");
    expect(stepOutput).not.toHaveProperty("bytes");

    // Assert binary payload was stored faithfully in host BlobStore
    const stored = await blobStore.get(stepOutput.blobRef as string);
    expect(stored).toBeDefined();
    expect(stored?.contentType).toBe("application/pdf");
    expect(stored?.size).toBe(pdfBytes.length);
    const storedBytes = new Uint8Array(await new Response(stored?.body).arrayBuffer());
    expect(storedBytes).toEqual(pdfBytes);
  });
});
