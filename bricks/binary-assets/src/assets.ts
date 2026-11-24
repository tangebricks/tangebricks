import type { D1Like } from "@poc/sdk";
import { scoped } from "@poc/sdk";

export interface R2ObjectLike {
  key: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  body: ReadableStream;
}

export interface R2Like {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<R2ObjectLike>;
  delete(key: string): Promise<void>;
}

export class MemoryR2 implements R2Like {
  private readonly store = new Map<string, { data: Uint8Array; contentType?: string }>();

  async get(key: string): Promise<R2ObjectLike | null> {
    const item = this.store.get(key);
    if (!item) return null;
    const data = item.data;
    return {
      key,
      size: data.byteLength,
      async arrayBuffer() {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      },
      async text() {
        return new TextDecoder().decode(data);
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
    };
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<R2ObjectLike> {
    let bytes: Uint8Array;
    if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof Uint8Array) {
      bytes = value;
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else {
      // ReadableStream
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (chunk) {
          chunks.push(chunk);
          total += chunk.byteLength;
        }
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
    }

    this.store.set(key, { data: bytes, contentType: options?.httpMetadata?.contentType });
    return (await this.get(key))!;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export interface AssetRecord {
  id: string;
  workspace_id: string;
  uploaded_by: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
  public_url: string | null;
  created_at: string;
}

export class AssetService {
  private readonly r2: R2Like;

  constructor(
    private readonly db: D1Like,
    r2Bucket?: R2Like,
    private readonly maxSizeBytes = 10485760, // 10MB
    private readonly publicBaseUrl?: string
  ) {
    this.r2 = r2Bucket || new MemoryR2();
  }

  /**
   * Uploads file bytes into R2 and saves asset metadata in D1.
   */
  async uploadAsset(
    workspaceId: string,
    uploadedBy: string,
    filenameRaw: string,
    contentTypeRaw: string,
    data: Uint8Array | ArrayBuffer | string
  ): Promise<{ ok: true; asset: AssetRecord } | { ok: false; error: string; code: number }> {
    const filename = filenameRaw.trim();
    if (!filename || filename.length > 255) {
      return { ok: false, error: "Filename must be between 1 and 255 characters", code: 400 };
    }

    const contentType = contentTypeRaw.trim().toLowerCase() || "application/octet-stream";
    if (contentType.length > 128) {
      return { ok: false, error: "Content type header too long", code: 400 };
    }

    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    const sizeBytes = bytes.byteLength;

    if (sizeBytes > this.maxSizeBytes) {
      return {
        ok: false,
        error: `File size ${sizeBytes} bytes exceeds maximum allowed ${this.maxSizeBytes} bytes`,
        code: 413,
      };
    }

    const assetId = `ast_${crypto.randomUUID().replace(/-/g, "")}`;
    const r2Key = `workspaces/${workspaceId}/assets/${assetId}/${filename}`;
    const publicUrl = this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, "")}/${r2Key}` : null;
    const now = new Date().toISOString();

    // 1. Upload to R2
    await this.r2.put(r2Key, bytes, { httpMetadata: { contentType } });

    // 2. Insert metadata into D1
    try {
      await scoped(this.db, workspaceId).insert("asset_files", {
        id: assetId,
        uploaded_by: uploadedBy,
        filename,
        content_type: contentType,
        size_bytes: sizeBytes,
        r2_key: r2Key,
        public_url: publicUrl,
        created_at: now,
      });
    } catch (err: unknown) {
      // Rollback R2 upload if D1 insert fails
      await this.r2.delete(r2Key);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to save asset metadata: ${msg}`, code: 500 };
    }

    return {
      ok: true,
      asset: {
        id: assetId,
        workspace_id: workspaceId,
        uploaded_by: uploadedBy,
        filename,
        content_type: contentType,
        size_bytes: sizeBytes,
        r2_key: r2Key,
        public_url: publicUrl,
        created_at: now,
      },
    };
  }

  /**
   * Retrieves asset metadata by ID scoped to workspace.
   */
  async getAsset(workspaceId: string, assetId: string): Promise<AssetRecord | null> {
    return scoped(this.db, workspaceId).first<AssetRecord>(
      "asset_files",
      "id = ?",
      [assetId],
    );
  }

  /**
   * Retrieves asset file bytes from R2.
   */
  async getAssetData(workspaceId: string, assetId: string): Promise<{ asset: AssetRecord; data: ArrayBuffer } | null> {
    const asset = await this.getAsset(workspaceId, assetId);
    if (!asset) return null;

    const r2Obj = await this.r2.get(asset.r2_key);
    if (!r2Obj) return null;

    const data = await r2Obj.arrayBuffer();
    return { asset, data };
  }

  /**
   * Deletes an asset from D1 and R2.
   */
  async deleteAsset(workspaceId: string, assetId: string): Promise<boolean> {
    const asset = await this.getAsset(workspaceId, assetId);
    if (!asset) return false;

    // Remove from R2
    await this.r2.delete(asset.r2_key);

    // Remove from D1
    const res = await scoped(this.db, workspaceId).delete("asset_files", "id = ?", [assetId]);

    return res.meta.changes > 0;
  }

  /**
   * Lists assets in a workspace.
   */
  async listAssets(workspaceId: string, limit = 50, offset = 0): Promise<AssetRecord[]> {
    return scoped(this.db, workspaceId).select<AssetRecord>(
      "asset_files",
      undefined,
      [],
      { orderBy: "created_at DESC", limit: Math.min(limit, 100), offset },
    );
  }

  /**
   * Computes total storage consumed in bytes for a workspace.
   */
  async getTotalStorageBytes(workspaceId: string): Promise<number> {
    interface SumRow {
      total: number | null;
    }
    const res = await scoped(this.db, workspaceId).raw(
      "SELECT SUM(size_bytes) as total FROM asset_files WHERE workspace_id = ?",
      [workspaceId],
    ).first<SumRow>();

    return res?.total ?? 0;
  }
}
