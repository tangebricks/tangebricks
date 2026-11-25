import { Hono } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, workspaceRoleRefusal } from "@poc/sdk";
import {
  AssetService,
  MAX_LIST_LIMIT,
  MAX_LIST_OFFSET,
  contentDispositionAttachment,
  isActiveContentType,
} from "./assets.ts";
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
  /** The largest upload, in bytes (setting `maxFileSizeBytes`). Default 10 MiB. */
  maxSize?: number;
  publicBaseUrl?: string;
  /** The most a workspace's assets may total, in bytes (setting `workspaceQuotaBytes`). Default 1 GiB. */
  quotaBytes?: number;
  /** Media types an upload may declare, as a comma string or a list (setting `allowedContentTypes`). */
  allowedContentTypes?: string | readonly string[];
}

const DEFAULT_MAX_SIZE = 10485760;

/** A whole number in [min, max] from a query value; `undefined` gives the default, anything else invalid gives null. */
function parseBoundedInt(raw: string | undefined, min: number, max: number, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

type BoundedRead = { ok: true; bytes: Uint8Array } | { ok: false; tooLarge: boolean };

/**
 * Story 1.14 (A14): reads a request body as a stream, counting bytes, and stops as soon as it passes `maxSize`, so a
 * missing or lying Content-Length cannot make the worker buffer more than `maxSize` (plus one chunk).
 */
async function readBodyBounded(body: ReadableStream<Uint8Array> | null, maxSize: number): Promise<BoundedRead> {
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxSize) {
        await reader.cancel().catch(() => {});
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export function createAssetRoutes(options: AssetRouteOptions = {}): Hono<AssetEnv> {
  const app = new Hono<AssetEnv>();
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const newService = (env: AssetEnv["Bindings"]) =>
    new AssetService(env.DB, env.BUCKET, maxSize, options.publicBaseUrl, {
      quotaBytes: options.quotaBytes,
      allowedContentTypes: options.allowedContentTypes,
    });

  // List assets in current workspace
  app.get("/assets", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    // A18: whole numbers only, limit 1..100 and offset 0..100000; anything else is refused.
    const limit = parseBoundedInt(c.req.query("limit"), 1, MAX_LIST_LIMIT, 50);
    const offset = parseBoundedInt(c.req.query("offset"), 0, MAX_LIST_OFFSET, 0);
    if (limit === null || offset === null) {
      return c.json(
        { error: `limit must be a whole number from 1 to ${MAX_LIST_LIMIT}, offset from 0 to ${MAX_LIST_OFFSET}`, code: "INVALID_PAGING" },
        400
      );
    }

    const service = newService(c.env);
    const assets = await service.listAssets(workspace.id, limit, offset);
    const totalStorageBytes = await service.getTotalStorageBytes(workspace.id);

    return c.json({ assets, totalStorageBytes }, 200);
  });

  // Get asset metadata
  app.get("/assets/:id", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const assetId = c.req.param("id");
    const asset = await newService(c.env).getAsset(workspace.id, assetId);

    if (!asset) return c.json({ error: "Asset not found" }, 404);
    return c.json({ asset }, 200);
  });

  // Download raw asset bytes: always an attachment, never sniffed, streamed from R2 (A15, A17).
  app.get("/assets/:id/download", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const assetId = c.req.param("id");
    const item = await newService(c.env).getAssetData(workspace.id, assetId);

    if (!item) return c.json({ error: "Asset not found" }, 404);

    const contentType = isActiveContentType(item.asset.content_type) ? "application/octet-stream" : item.asset.content_type;
    return new Response(item.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": item.size.toString(),
        "Content-Disposition": contentDispositionAttachment(item.asset.filename),
        "X-Content-Type-Options": "nosniff",
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

    // A14: refuse a declared oversize body before reading any of it.
    const declared = c.req.header("Content-Length");
    if (declared !== undefined && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxSize) {
      return c.json({ error: `File exceeds maximum allowed ${maxSize} bytes`, code: "FILE_TOO_LARGE" }, 413);
    }

    const read = await readBodyBounded(c.req.raw.body, maxSize);
    if (!read.ok) {
      if (read.tooLarge) {
        return c.json({ error: `File exceeds maximum allowed ${maxSize} bytes`, code: "FILE_TOO_LARGE" }, 413);
      }
      return c.json({ error: "Invalid binary payload" }, 400);
    }

    if (read.bytes.byteLength === 0) {
      return c.json({ error: "File content cannot be empty" }, 400);
    }

    const result = await newService(c.env).uploadAsset(workspace.id, uploadedBy, filename, contentType, read.bytes);

    if (!result.ok) {
      return c.json(
        {
          error: result.error,
          code: result.errorCode,
          ...(result.correlationId ? { correlationId: result.correlationId } : {}),
        },
        result.code as 400 | 413 | 415 | 500
      );
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
    const deleted = await newService(c.env).deleteAsset(workspace.id, assetId);

    if (!deleted) return c.json({ error: "Asset not found" }, 404);
    return c.json({ success: true }, 200);
  });

  return app;
}
