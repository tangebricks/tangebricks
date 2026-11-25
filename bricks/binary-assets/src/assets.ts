import type { D1Like } from "@poc/sdk";
import { scoped } from "@poc/sdk";

export interface R2HttpMetadataLike {
  contentType?: string;
  contentDisposition?: string;
}

export interface R2ObjectLike {
  key: string;
  size: number;
  httpMetadata?: R2HttpMetadataLike;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  body: ReadableStream;
}

export interface R2Like {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: R2HttpMetadataLike }
  ): Promise<R2ObjectLike>;
  delete(key: string): Promise<void>;
}

export class MemoryR2 implements R2Like {
  private readonly store = new Map<string, { data: Uint8Array; httpMetadata: R2HttpMetadataLike }>();

  /** The keys currently stored (for tests). */
  keys(): string[] {
    return [...this.store.keys()];
  }

  async get(key: string): Promise<R2ObjectLike | null> {
    const item = this.store.get(key);
    if (!item) return null;
    const data = item.data;
    return {
      key,
      size: data.byteLength,
      httpMetadata: { ...item.httpMetadata },
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
    options?: { httpMetadata?: R2HttpMetadataLike }
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

    this.store.set(key, { data: bytes, httpMetadata: { ...options?.httpMetadata } });
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

/** Story 1.14 (A15): the media types an upload may declare unless the app sets `allowedContentTypes`. */
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
  "application/octet-stream",
  "audio/mpeg",
  "video/mp4",
];

/** 1 GiB: the per-workspace storage quota unless the app sets `workspaceQuotaBytes` (A14). */
export const DEFAULT_WORKSPACE_QUOTA_BYTES = 1073741824;

export const MAX_LIST_LIMIT = 100;
export const MAX_LIST_OFFSET = 100000;
const MAX_R2_KEY_LENGTH = 512;
const MAX_PUBLIC_URL_LENGTH = 1024;

const ACTIVE_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/xsl",
]);

/** The media type alone: lowercased, trimmed, parameters (`; charset=...`) stripped. */
export function normalizeContentType(raw: string): string {
  return (raw.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Story 1.14 (A15): a type a browser may run script from when it renders it inline. These never get a public URL and
 * are only ever served as an attachment of type application/octet-stream, even when an app allows them. Any `+xml`
 * type counts too, because an XML document can carry XHTML script elements.
 */
export function isActiveContentType(mediaType: string): boolean {
  const t = normalizeContentType(mediaType);
  return ACTIVE_CONTENT_TYPES.has(t) || t.endsWith("+xml") || t.includes("javascript") || t.includes("ecmascript");
}

/**
 * Story 1.14 (A15): a row stored before 1.14 can hold an active type with a public URL. Reads never return that URL.
 */
function withSafePublicUrl<T extends AssetRecord | null>(row: T): T {
  if (row && row.public_url !== null && isActiveContentType(row.content_type)) return { ...row, public_url: null };
  return row;
}

/** Parses an allowlist given as a comma string or a list into normalized media types. */
export function parseAllowedContentTypes(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [...DEFAULT_ALLOWED_CONTENT_TYPES];
  const items = typeof value === "string" ? value.split(",") : value;
  return items.map(normalizeContentType).filter((t) => t.length > 0);
}

/**
 * Story 1.14 (A16): keeps only the last path segment (split on `/` and `\`), drops control characters, replaces
 * anything outside `[A-Za-z0-9._ -]` with `_`, strips leading dots and spaces (and trailing spaces), caps the name at
 * 255 characters, and falls back to `upload.bin` when nothing is left.
 */
export function sanitizeFilename(raw: string): string {
  const segments = raw.split(/[\\/]/);
  let name = segments[segments.length - 1] ?? "";
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  name = name.replace(/[^A-Za-z0-9._ -]/g, "_");
  name = name.replace(/^[. ]+/, "");
  if (name.length > 255) name = name.slice(0, 255);
  name = name.replace(/ +$/, "");
  return name.length > 0 ? name : "upload.bin";
}

/** A `filename*` value (RFC 8187): UTF-8, percent-encoded. */
function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Story 1.14 (A17): an attachment Content-Disposition with an ASCII-safe `filename` (no quotes, backslashes, control or
 * non-ASCII characters) and the exact name in `filename*`.
 */
export function contentDispositionAttachment(filename: string): string {
  const ascii = filename.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc8187(filename)}`;
}

export function newCorrelationId(): string {
  return `err_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export type UploadErrorCode =
  | "INVALID_FILENAME"
  | "INVALID_CONTENT_TYPE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "FILE_TOO_LARGE"
  | "QUOTA_EXCEEDED"
  | "INTERNAL_ERROR";

export type UploadResult =
  | { ok: true; asset: AssetRecord }
  | { ok: false; error: string; code: number; errorCode: UploadErrorCode; correlationId?: string };

export interface AssetServiceOptions {
  /** The most a workspace's assets may total, in bytes (A14). Default {@link DEFAULT_WORKSPACE_QUOTA_BYTES}. */
  quotaBytes?: number;
  /** Media types an upload may declare, as a comma string or a list (A15). Default {@link DEFAULT_ALLOWED_CONTENT_TYPES}. */
  allowedContentTypes?: string | readonly string[];
}

export class AssetService {
  private readonly r2: R2Like;
  private readonly quotaBytes: number;
  private readonly allowedContentTypes: ReadonlySet<string>;

  constructor(
    private readonly db: D1Like,
    r2Bucket?: R2Like,
    private readonly maxSizeBytes = 10485760, // 10MB
    private readonly publicBaseUrl?: string,
    options: AssetServiceOptions = {}
  ) {
    this.r2 = r2Bucket || new MemoryR2();
    this.quotaBytes = options.quotaBytes ?? DEFAULT_WORKSPACE_QUOTA_BYTES;
    this.allowedContentTypes = new Set(parseAllowedContentTypes(options.allowedContentTypes));
  }

  /**
   * Uploads file bytes into R2 and saves asset metadata in D1.
   *
   * The quota check reads the workspace's total before writing, so it is best-effort under concurrency: uploads that
   * run in parallel and each fit can together pass the quota, by at most one file each.
   */
  async uploadAsset(
    workspaceId: string,
    uploadedBy: string,
    filenameRaw: string,
    contentTypeRaw: string,
    data: Uint8Array | ArrayBuffer | string
  ): Promise<UploadResult> {
    const filename = sanitizeFilename(filenameRaw);

    const contentType = normalizeContentType(contentTypeRaw) || "application/octet-stream";
    if (contentType.length > 128) {
      return { ok: false, error: "Content type header too long", code: 400, errorCode: "INVALID_CONTENT_TYPE" };
    }
    if (!this.allowedContentTypes.has(contentType)) {
      return { ok: false, error: "Content type is not allowed", code: 415, errorCode: "UNSUPPORTED_CONTENT_TYPE" };
    }
    const active = isActiveContentType(contentType);

    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    const sizeBytes = bytes.byteLength;

    if (sizeBytes > this.maxSizeBytes) {
      return {
        ok: false,
        error: `File size ${sizeBytes} bytes exceeds maximum allowed ${this.maxSizeBytes} bytes`,
        code: 413,
        errorCode: "FILE_TOO_LARGE",
      };
    }

    const used = await this.getTotalStorageBytes(workspaceId);
    if (used + sizeBytes > this.quotaBytes) {
      return {
        ok: false,
        error: `Upload would exceed the workspace storage quota of ${this.quotaBytes} bytes`,
        code: 413,
        errorCode: "QUOTA_EXCEEDED",
      };
    }

    const assetId = `ast_${crypto.randomUUID().replace(/-/g, "")}`;
    // The sanitized name is a single path segment and is URI-encoded in the key. Every key segment is encoded again in
    // the public URL, so the URL addresses exactly this object.
    const r2Key = `workspaces/${workspaceId}/assets/${assetId}/${encodeURIComponent(filename)}`;
    const publicUrl =
      this.publicBaseUrl && !active
        ? `${this.publicBaseUrl.replace(/\/$/, "")}/${r2Key.split("/").map(encodeURIComponent).join("/")}`
        : null;
    if (r2Key.length > MAX_R2_KEY_LENGTH || (publicUrl !== null && publicUrl.length > MAX_PUBLIC_URL_LENGTH)) {
      return { ok: false, error: "Filename too long", code: 400, errorCode: "INVALID_FILENAME" };
    }
    const now = new Date().toISOString();

    // 1. Upload to R2. Active content is stored as an opaque attachment, so the bucket never serves it inline.
    await this.r2.put(r2Key, bytes, {
      httpMetadata: active
        ? { contentType: "application/octet-stream", contentDisposition: "attachment" }
        : { contentType },
    });

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
      // Roll back the R2 upload. The raw error goes only to the log, under a correlation id (A18).
      await this.r2.delete(r2Key);
      const correlationId = newCorrelationId();
      console.error(
        `binary-assets: saving asset metadata failed [${correlationId}]`,
        err instanceof Error ? err.message : String(err)
      );
      return { ok: false, error: "Failed to save asset metadata", code: 500, errorCode: "INTERNAL_ERROR", correlationId };
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
    const row = await scoped(this.db, workspaceId).first<AssetRecord>(
      "asset_files",
      "id = ?",
      [assetId],
    );
    return withSafePublicUrl(row);
  }

  /**
   * Retrieves an asset's metadata and its R2 body as a stream; the bytes are not buffered (A17).
   */
  async getAssetData(
    workspaceId: string,
    assetId: string
  ): Promise<{ asset: AssetRecord; body: ReadableStream; size: number } | null> {
    const asset = await this.getAsset(workspaceId, assetId);
    if (!asset) return null;

    const r2Obj = await this.r2.get(asset.r2_key);
    if (!r2Obj) return null;

    return { asset, body: r2Obj.body, size: r2Obj.size };
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
   * Lists assets in a workspace. `limit` is clamped to 1..100 and `offset` to 0..100000; the routes refuse values
   * outside those ranges before calling this (A18).
   */
  async listAssets(workspaceId: string, limit = 50, offset = 0): Promise<AssetRecord[]> {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT) : 50;
    const safeOffset = Number.isFinite(offset) ? Math.min(Math.max(Math.trunc(offset), 0), MAX_LIST_OFFSET) : 0;
    const rows = await scoped(this.db, workspaceId).select<AssetRecord>(
      "asset_files",
      undefined,
      [],
      { orderBy: "created_at DESC", limit: safeLimit, offset: safeOffset },
    );
    return rows.map(withSafePublicUrl);
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
