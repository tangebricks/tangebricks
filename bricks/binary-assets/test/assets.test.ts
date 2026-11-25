import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_binary_assets.sql?raw";
import { createAssetRoutes, AssetService, MemoryR2 } from "../src/index.ts";
import type { AssetEnv, R2Like } from "../src/index.ts";

const db = env.DB as D1Like;
const bucket = (env.BUCKET as unknown as R2Like) || new MemoryR2();
const WS_A = "ws_assets_alpha";
const WS_B = "ws_assets_beta";
const USER_A = "usr_alice";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS asset_files").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Binary Asset Pipeline Core Engine", () => {
  it("uploads binary file to R2, indexes metadata in D1, and downloads exact bytes", async () => {
    const service = new AssetService(db, bucket);
    const content = new TextEncoder().encode("Hello Cloudflare R2 Asset Storage!");

    const upload = await service.uploadAsset(
      WS_A,
      USER_A,
      "hello.txt",
      "text/plain",
      content
    );

    expect(upload.ok).toBe(true);
    if (!upload.ok) return;

    expect(upload.asset.filename).toBe("hello.txt");
    expect(upload.asset.content_type).toBe("text/plain");
    expect(upload.asset.size_bytes).toBe(content.byteLength);

    // Verify retrieval from D1
    const retrieved = await service.getAsset(WS_A, upload.asset.id);
    expect(retrieved?.id).toBe(upload.asset.id);

    // Verify binary download from R2
    const fileData = await service.getAssetData(WS_A, upload.asset.id);
    expect(fileData).not.toBeNull();
    const downloadedText = await new Response(fileData!.body).text();
    expect(downloadedText).toBe("Hello Cloudflare R2 Asset Storage!");
  });

  it("refuses files that exceed maxSizeBytes with 413", async () => {
    const service = new AssetService(db, bucket, 100); // 100 bytes limit
    const largeData = new Uint8Array(200); // 200 bytes

    const upload = await service.uploadAsset(
      WS_A,
      USER_A,
      "toolarge.bin",
      "application/octet-stream",
      largeData
    );

    expect(upload.ok).toBe(false);
    if (upload.ok) return;
    expect(upload.code).toBe(413);
    expect(upload.error).toMatch(/exceeds maximum allowed/i);
  });

  it("calculates total workspace storage consumed", async () => {
    const service = new AssetService(db, bucket);
    await service.uploadAsset(WS_A, USER_A, "file1.bin", "application/octet-stream", new Uint8Array(50));
    await service.uploadAsset(WS_A, USER_A, "file2.bin", "application/octet-stream", new Uint8Array(75));

    const total = await service.getTotalStorageBytes(WS_A);
    expect(total).toBe(125);
  });

  it("enforces multi-tenant isolation: Workspace B cannot read or delete Workspace A assets", async () => {
    const service = new AssetService(db, bucket);
    const upload = await service.uploadAsset(
      WS_A,
      USER_A,
      "secret.pdf",
      "application/pdf",
      new TextEncoder().encode("Classified Tenant A Data")
    );
    if (!upload.ok) return;

    // Workspace B cannot view metadata
    const fromB = await service.getAsset(WS_B, upload.asset.id);
    expect(fromB).toBeNull();

    // Workspace B cannot download bytes
    const downloadB = await service.getAssetData(WS_B, upload.asset.id);
    expect(downloadB).toBeNull();

    // Workspace B cannot delete
    const deletedByB = await service.deleteAsset(WS_B, upload.asset.id);
    expect(deletedByB).toBe(false);

    // Workspace A can still access
    const fromA = await service.getAsset(WS_A, upload.asset.id);
    expect(fromA).not.toBeNull();
  });

  it("deleting an asset removes metadata from D1 and deletes object from R2", async () => {
    const service = new AssetService(db, bucket);
    const upload = await service.uploadAsset(
      WS_A,
      USER_A,
      "temp.jpg",
      "image/jpeg",
      new Uint8Array([1, 2, 3, 4, 5])
    );
    if (!upload.ok) return;

    const deleted = await service.deleteAsset(WS_A, upload.asset.id);
    expect(deleted).toBe(true);

    expect(await service.getAsset(WS_A, upload.asset.id)).toBeNull();
    expect(await service.getAssetData(WS_A, upload.asset.id)).toBeNull();
  });
});

describe("Asset Route Handlers (/api/assets/*)", () => {
  const createApp = (wsId = WS_A, role: string | null = "member") => {
    const app = new Hono<AssetEnv>();

    // Mock workspace & user context (role null = nobody signed in)
    app.use("*", async (c, next) => {
      if (role) {
        c.set("workspace", { id: wsId, role });
        c.set("user", { uid: USER_A, email: "alice@test.com" });
        c.set("ctx", Object.freeze({ userId: USER_A, workspaceId: wsId, role }));
      }
      await next();
    });

    app.route("/api", createAssetRoutes({ maxSize: 1048576 }));
    return app;
  };

  it("POST /api/assets/upload -> uploads binary data and returns 201 with asset record", async () => {
    const app = createApp(WS_A);
    const payload = new TextEncoder().encode("API uploaded payload");

    const res = await app.fetch(
      new Request("http://localhost/api/assets/upload?filename=report.txt", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: payload,
      }),
      { DB: db, BUCKET: bucket }
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as { asset: { id: string; filename: string; size_bytes: number } };
    expect(json.asset.filename).toBe("report.txt");
    expect(json.asset.size_bytes).toBe(payload.byteLength);

    // Download via GET /api/assets/:id/download
    const downloadRes = await app.fetch(
      new Request(`http://localhost/api/assets/${json.asset.id}/download`),
      { DB: db, BUCKET: bucket }
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("Content-Type")).toBe("text/plain");
    const downloadedText = await downloadRes.text();
    expect(downloadedText).toBe("API uploaded payload");
  });

  it("DELETE /api/assets/:id -> deletes asset and subsequent GET returns 404", async () => {
    const app = createApp(WS_A, "owner");
    const service = new AssetService(db, bucket);
    const upload = await service.uploadAsset(WS_A, USER_A, "to_delete.txt", "text/plain", "data");
    if (!upload.ok) return;

    const deleteRes = await app.fetch(
      new Request(`http://localhost/api/assets/${upload.asset.id}`, { method: "DELETE" }),
      { DB: db, BUCKET: bucket }
    );
    expect(deleteRes.status).toBe(200);

    const getRes = await app.fetch(
      new Request(`http://localhost/api/assets/${upload.asset.id}`),
      { DB: db, BUCKET: bucket }
    );
    expect(getRes.status).toBe(404);
  });

  it("story 0.6: DELETE /api/assets/:id refuses no user (401) and a plain member (403); admin deletes", async () => {
    const service = new AssetService(db, bucket);
    const upload = await service.uploadAsset(WS_A, "usr_other", "keep.txt", "text/plain", "data");
    expect(upload.ok).toBe(true);
    if (!upload.ok) return;
    const del = (role: string | null) =>
      createApp(WS_A, role).fetch(new Request(`http://localhost/api/assets/${upload.asset.id}`, { method: "DELETE" }), { DB: db, BUCKET: bucket });
    expect((await del(null)).status).toBe(401);
    expect((await del("member")).status).toBe(403);
    expect(await service.getAsset(WS_A, upload.asset.id)).not.toBeNull();
    expect((await del("admin")).status).toBe(200);
    expect(await service.getAsset(WS_A, upload.asset.id)).toBeNull();
  });
});
