import { Hono } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, workspaceRoleRefusal } from "@poc/sdk";
import { AssetService } from "./assets.ts";
import type { R2Like } from "./assets.ts";

export interface AssetEnv {
  Bindings: {
    DB: D1Like;
    BUCKET?: R2Like;
  };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified request context set by the workspace middleware; the only source of the caller's role. */
    ctx?: RequestContext;
  };
}

export interface AssetRouteOptions {
  maxSize?: number;
  publicBaseUrl?: string;
}

export function createAssetRoutes(options: AssetRouteOptions = {}): Hono<AssetEnv> {
  const app = new Hono<AssetEnv>();

  // List assets in current workspace
  app.get("/assets", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const limit = Number(c.req.query("limit")) || 50;
    const offset = Number(c.req.query("offset")) || 0;

    const service = new AssetService(c.env.DB, c.env.BUCKET, options.maxSize, options.publicBaseUrl);
    const assets = await service.listAssets(workspace.id, limit, offset);
    const totalStorageBytes = await service.getTotalStorageBytes(workspace.id);

    return c.json({ assets, totalStorageBytes }, 200);
  });

  // Get asset metadata
  app.get("/assets/:id", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const assetId = c.req.param("id");
    const service = new AssetService(c.env.DB, c.env.BUCKET, options.maxSize, options.publicBaseUrl);
    const asset = await service.getAsset(workspace.id, assetId);

    if (!asset) return c.json({ error: "Asset not found" }, 404);
    return c.json({ asset }, 200);
  });

  // Download raw asset bytes
  app.get("/assets/:id/download", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const assetId = c.req.param("id");
    const service = new AssetService(c.env.DB, c.env.BUCKET, options.maxSize, options.publicBaseUrl);
    const item = await service.getAssetData(workspace.id, assetId);

    if (!item) return c.json({ error: "Asset not found" }, 404);

    return new Response(item.data, {
      status: 200,
      headers: {
        "Content-Type": item.asset.content_type,
        "Content-Length": item.asset.size_bytes.toString(),
        "Content-Disposition": `attachment; filename="${item.asset.filename}"`,
      },
    });
  });

  // Upload an asset
  app.post("/assets/upload", async (c) => {
    const user = c.get("user");
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);
    const uploadedBy = user?.uid || "anonymous";

    const contentType = c.req.header("Content-Type") || "application/octet-stream";
    const filename = c.req.query("filename") || c.req.header("X-Filename") || "upload.bin";

    let data: ArrayBuffer;
    try {
      data = await c.req.arrayBuffer();
    } catch {
      return c.json({ error: "Invalid binary payload" }, 400);
    }

    if (data.byteLength === 0) {
      return c.json({ error: "File content cannot be empty" }, 400);
    }

    const service = new AssetService(c.env.DB, c.env.BUCKET, options.maxSize, options.publicBaseUrl);
    const result = await service.uploadAsset(workspace.id, uploadedBy, filename, contentType, data);

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as 400 | 413 | 500);
    }

    return c.json({ asset: result.asset }, 201);
  });

  // Delete an asset. Owner/admin only, so a member cannot delete everyone's files (sweep A19).
  app.delete("/assets/:id", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const assetId = c.req.param("id");
    const service = new AssetService(c.env.DB, c.env.BUCKET, options.maxSize, options.publicBaseUrl);
    const deleted = await service.deleteAsset(workspace.id, assetId);

    if (!deleted) return c.json({ error: "Asset not found" }, 404);
    return c.json({ success: true }, 200);
  });

  return app;
}
