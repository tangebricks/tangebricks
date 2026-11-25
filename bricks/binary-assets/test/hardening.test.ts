// Story 1.14 (PROPOSED-8): binary-assets upload hardening, one block per threat-model finding A14-A18.
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_binary_assets.sql?raw";
import {
  AssetService,
  MemoryR2,
  contentDispositionAttachment,
  createAssetRoutes,
  isActiveContentType,
  sanitizeFilename,
} from "../src/index.ts";
import type { AssetEnv, AssetRouteOptions } from "../src/index.ts";

const db = env.DB as D1Like;
const WS = "ws_assets_hardening";
const USER = "usr_hardening";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS asset_files").run();
  await applyMigration(db, migration);
}

async function rowCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM asset_files").first<{ n: number }>();
  return row?.n ?? 0;
}

function makeApp(options: AssetRouteOptions = {}) {
  const app = new Hono<AssetEnv>();
  app.use("*", async (c, next) => {
    c.set("workspace", { id: WS, role: "member" });
    c.set("user", { uid: USER });
    c.set("ctx", Object.freeze({ userId: USER, workspaceId: WS, role: "member" }));
    await next();
  });
  app.route("/api", createAssetRoutes({ maxSize: 1024, ...options }));
  return app;
}

function upload(
  app: Hono<AssetEnv>,
  bucket: MemoryR2,
  body: BodyInit,
  headers: Record<string, string> = { "Content-Type": "application/octet-stream" },
  query = "filename=f.bin",
  database: D1Like = db
) {
  return app.fetch(new Request(`http://localhost/api/assets/upload?${query}`, { method: "POST", headers, body }), {
    DB: database,
    BUCKET: bucket,
  });
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A14: size precheck, bounded streaming read, per-workspace quota", () => {
  it("refuses a declared Content-Length above maxSize with 413 FILE_TOO_LARGE without reading the body", async () => {
    const bucket = new MemoryR2();
    const app = makeApp();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1000));
          if (pulls >= 5) controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const req = new Request("http://localhost/api/assets/upload?filename=big.bin", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": "5000" },
      body,
    });
    expect(req.headers.get("Content-Length")).toBe("5000");
    const res = await app.fetch(req, { DB: db, BUCKET: bucket });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("FILE_TOO_LARGE");
    expect(req.bodyUsed).toBe(false);
    expect(pulls).toBe(0);
    expect(bucket.keys()).toEqual([]);
    expect(await rowCount()).toBe(0);
  });

  it("stops reading a streamed body with no Content-Length as soon as it passes maxSize (413, nothing stored)", async () => {
    const bucket = new MemoryR2();
    const app = makeApp();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls > 50) controller.close();
          else controller.enqueue(new Uint8Array(512));
        },
      },
      { highWaterMark: 0 }
    );
    const res = await upload(app, bucket, stream);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("FILE_TOO_LARGE");
    // 1024 bytes is passed on the third 512-byte chunk; the read stops there, far short of the 50 on offer.
    expect(pulls).toBeLessThan(10);
    expect(bucket.keys()).toEqual([]);
    expect(await rowCount()).toBe(0);
  });

  it("refuses an upload that would take the workspace over quotaBytes with 413 QUOTA_EXCEEDED", async () => {
    const bucket = new MemoryR2();
    const app = makeApp({ quotaBytes: 100 });
    expect((await upload(app, bucket, new Uint8Array(60))).status).toBe(201);
    expect((await upload(app, bucket, new Uint8Array(40))).status).toBe(201);
    const over = await upload(app, bucket, new Uint8Array(1));
    expect(over.status).toBe(413);
    expect(((await over.json()) as { code: string }).code).toBe("QUOTA_EXCEEDED");
    expect(bucket.keys()).toHaveLength(2);
    expect(await rowCount()).toBe(2);
  });
});

describe("A15: Content-Type allowlist and active types", () => {
  it("refuses text/html under the default allowlist with 415 UNSUPPORTED_CONTENT_TYPE, nothing stored", async () => {
    const bucket = new MemoryR2();
    const app = makeApp({ publicBaseUrl: "https://cdn.example.com" });
    for (const type of ["text/html", "image/svg+xml", "application/javascript", "Text/HTML; charset=utf-8"]) {
      const res = await upload(app, bucket, "<script>alert(1)</script>", { "Content-Type": type }, "filename=x.html");
      expect(res.status).toBe(415);
      expect(((await res.json()) as { code: string }).code).toBe("UNSUPPORTED_CONTENT_TYPE");
    }
    expect(bucket.keys()).toEqual([]);
    expect(await rowCount()).toBe(0);
  });

  it("normalizes the media type: lowercased, parameters stripped", async () => {
    const bucket = new MemoryR2();
    const res = await upload(makeApp(), bucket, "hello", { "Content-Type": "TEXT/Plain; charset=UTF-8" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { asset: { content_type: string } }).asset.content_type).toBe("text/plain");
  });

  it("an active type the app allows gets no public URL, is stored as an attachment, and downloads as octet-stream", async () => {
    const bucket = new MemoryR2();
    const app = makeApp({ publicBaseUrl: "https://cdn.example.com/", allowedContentTypes: "image/svg+xml, image/png" });
    const svg = await upload(app, bucket, "<svg onload=alert(1)/>", { "Content-Type": "image/svg+xml" }, "filename=a.svg");
    expect(svg.status).toBe(201);
    const { asset } = (await svg.json()) as { asset: { id: string; r2_key: string; public_url: string | null } };
    expect(asset.public_url).toBeNull();
    const stored = await bucket.get(asset.r2_key);
    expect(stored?.httpMetadata?.contentDisposition).toBe("attachment");
    expect(stored?.httpMetadata?.contentType).toBe("application/octet-stream");

    const dl = await app.fetch(new Request(`http://localhost/api/assets/${asset.id}/download`), { DB: db, BUCKET: bucket });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(dl.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(dl.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new TextDecoder().decode(await dl.arrayBuffer())).toBe("<svg onload=alert(1)/>");

    // text/xsl is rendered as XML by browsers, so it is active too.
    const xslApp = makeApp({ publicBaseUrl: "https://cdn.example.com/", allowedContentTypes: "text/xsl" });
    const xsl = await upload(xslApp, bucket, "<xsl:stylesheet/>", { "Content-Type": "text/xsl" }, "filename=s.xsl");
    expect(xsl.status).toBe(201);
    expect(((await xsl.json()) as { asset: { public_url: string | null } }).asset.public_url).toBeNull();

    // A passive type on the same app does get a public URL.
    const png = await upload(app, bucket, new Uint8Array([137, 80, 78, 71]), { "Content-Type": "image/png" }, "filename=p.png");
    const pngAsset = ((await png.json()) as { asset: { r2_key: string; public_url: string | null } }).asset;
    expect(pngAsset.public_url).toBe(`https://cdn.example.com/${pngAsset.r2_key}`);
  });

  it("isActiveContentType covers the script-capable types, including XSLT", () => {
    for (const type of ["text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml", "text/xsl", "application/xslt+xml", "application/rss+xml", "text/javascript", "application/ecmascript", "TEXT/XSL; charset=utf-8"]) {
      expect(isActiveContentType(type), type).toBe(true);
    }
    for (const type of ["image/png", "text/plain", "text/csv", "application/json", "application/pdf"]) {
      expect(isActiveContentType(type), type).toBe(false);
    }
  });

  it("a pre-1.14 row of an active type with a public_url is read back with public_url null", async () => {
    const bucket = new MemoryR2();
    const app = makeApp({ publicBaseUrl: "https://cdn.example.com" });
    const key = `workspaces/${WS}/assets/ast_oldhtml/page.html`;
    await bucket.put(key, "<script>alert(1)</script>", { httpMetadata: { contentType: "text/html" } });
    await db
      .prepare(
        "INSERT INTO asset_files (id, workspace_id, uploaded_by, filename, content_type, size_bytes, r2_key, public_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind("ast_oldhtml", WS, USER, "page.html", "text/html", 25, key, `https://cdn.example.com/${key}`, new Date().toISOString())
      .run();

    const one = await app.fetch(new Request("http://localhost/api/assets/ast_oldhtml"), { DB: db, BUCKET: bucket });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { asset: { public_url: string | null } }).asset.public_url).toBeNull();

    const list = await app.fetch(new Request("http://localhost/api/assets"), { DB: db, BUCKET: bucket });
    expect(list.status).toBe(200);
    const assets = ((await list.json()) as { assets: { id: string; public_url: string | null }[] }).assets;
    expect(assets.find((a) => a.id === "ast_oldhtml")?.public_url).toBeNull();
  });
});

describe("A16: filename sanitizing", () => {
  it("sanitizes a hostile filename and keeps the key under the workspace's asset prefix", async () => {
    const bucket = new MemoryR2();
    const app = makeApp({ publicBaseUrl: "https://cdn.example.com" });
    const hostile = '../../x/evil\u0000"; .html';
    const res = await upload(app, bucket, "data", { "Content-Type": "text/plain" }, `filename=${encodeURIComponent(hostile)}`);
    expect(res.status).toBe(201);
    const { asset } = (await res.json()) as { asset: { id: string; filename: string; r2_key: string; public_url: string } };
    expect(asset.filename).toBe("evil__ .html");
    expect(asset.r2_key).toBe(`workspaces/${WS}/assets/${asset.id}/evil__%20.html`);
    expect(asset.r2_key.split("/")).toHaveLength(5);
    expect(asset.r2_key).not.toContain("..");
    expect(bucket.keys()).toEqual([asset.r2_key]);
    // Each key segment is encoded again in the URL, so the URL addresses exactly that key.
    expect(asset.public_url).toBe(`https://cdn.example.com/workspaces/${WS}/assets/${asset.id}/evil__%2520.html`);
    expect(decodeURIComponent(new URL(asset.public_url).pathname.slice(1))).toBe(asset.r2_key);
  });

  it("sanitizeFilename: last segment, no control chars, safe set, no leading dots, 255 cap, fallback", () => {
    expect(sanitizeFilename("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("..\\..\\.htaccess")).toBe("htaccess");
    expect(sanitizeFilename("r\u00e9sum\u00e9 (1).pdf")).toBe("r_sum_ _1_.pdf");
    expect(sanitizeFilename("a\r\nb\u007f.txt")).toBe("ab.txt");
    expect(sanitizeFilename("....")).toBe("upload.bin");
    expect(sanitizeFilename("dir/")).toBe("upload.bin");
    expect(sanitizeFilename("")).toBe("upload.bin");
    expect(sanitizeFilename("x".repeat(400))).toHaveLength(255);
  });
});

describe("A17: download headers", () => {
  it("escapes the filename in Content-Disposition, adds filename*, sends nosniff and streams the bytes", async () => {
    const bucket = new MemoryR2();
    const app = makeApp();
    // A row written before 1.14 can hold an unsanitized name.
    const name = 'a"b\\c \u00e9.txt';
    const key = `workspaces/${WS}/assets/ast_legacy/legacy.txt`;
    await bucket.put(key, "legacy bytes", { httpMetadata: { contentType: "text/plain" } });
    await db
      .prepare(
        "INSERT INTO asset_files (id, workspace_id, uploaded_by, filename, content_type, size_bytes, r2_key, public_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)"
      )
      .bind("ast_legacy", WS, USER, name, "text/plain", 12, key, new Date().toISOString())
      .run();

    const res = await app.fetch(new Request("http://localhost/api/assets/ast_legacy/download"), { DB: db, BUCKET: bucket });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="abc _.txt"; filename*=UTF-8''a%22b%5Cc%20%C3%A9.txt`
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Length")).toBe("12");
    expect(await res.text()).toBe("legacy bytes");
  });

  it("contentDispositionAttachment never lets a name break out of the quoted value", () => {
    const header = contentDispositionAttachment('x"; filename="evil.html');
    expect(header).toBe(`attachment; filename="x; filename=evil.html"; filename*=UTF-8''x%22%3B%20filename%3D%22evil.html`);
    expect(contentDispositionAttachment('""')).toBe(`attachment; filename="download"; filename*=UTF-8''%22%22`);
  });
});

describe("A18: bounded paging and redacted errors", () => {
  it("answers 400 for limit/offset outside their ranges or not whole numbers", async () => {
    const bucket = new MemoryR2();
    const app = makeApp();
    for (const query of ["limit=-1", "limit=0", "limit=1000", "limit=abc", "limit=1.5", "limit=", "offset=-1", "offset=Infinity", "offset=100001", "offset=1e3"]) {
      const res = await app.fetch(new Request(`http://localhost/api/assets?${query}`), { DB: db, BUCKET: bucket });
      expect(res.status, query).toBe(400);
    }
    const ok = await app.fetch(new Request("http://localhost/api/assets?limit=100&offset=100000"), { DB: db, BUCKET: bucket });
    expect(ok.status).toBe(200);
    const dflt = await app.fetch(new Request("http://localhost/api/assets"), { DB: db, BUCKET: bucket });
    expect(dflt.status).toBe(200);
  });

  it("a failed metadata insert answers 500 with a generic message and correlation id, and removes the R2 object", async () => {
    const bucket = new MemoryR2();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb: D1Like = {
      prepare(sql: string) {
        if (/^\s*INSERT/i.test(sql)) throw new Error("D1_ERROR: boom-secret-detail asset_files");
        return db.prepare(sql);
      },
      batch: (statements) => db.batch(statements),
      exec: (sql) => db.exec(sql),
    };
    const res = await upload(makeApp(), bucket, "data", { "Content-Type": "text/plain" }, "filename=f.txt", failingDb);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("boom-secret");
    expect(text).not.toContain("D1_ERROR");
    const body = JSON.parse(text) as { error: string; code: string; correlationId: string };
    expect(body.error).toBe("Failed to save asset metadata");
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.correlationId).toMatch(/^err_[0-9a-f]{16}$/);
    expect(bucket.keys()).toEqual([]);
    expect(await rowCount()).toBe(0);
    const logged = errors.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain(body.correlationId);
    expect(logged).toContain("boom-secret-detail");
  });

  it("the service clamps paging even when called directly", async () => {
    const service = new AssetService(db, new MemoryR2());
    await service.uploadAsset(WS, USER, "a.txt", "text/plain", "a");
    expect(await service.listAssets(WS, -1, Number.POSITIVE_INFINITY)).toHaveLength(1);
  });
});
