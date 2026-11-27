import type { BlobStore, BlobStoreGetResult, BlobStorePutMeta, BlobStorePutResult } from "@poc/sdk";
import { BlobStoreError } from "@poc/sdk";

export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
      customMetadata?: Record<string, string>;
    },
  ): Promise<{ size: number; key: string } | null>;
  get(key: string): Promise<{
    body: ReadableStream;
    size: number;
    httpMetadata?: {
      contentType?: string;
    };
  } | null>;
}

export interface R2BlobStoreOptions {
  workspaceId: string;
}

/**
 * Creates an R2-backed BlobStore for integration operations with binary payloads.
 *
 * Keys are partitioned by workspace:
 *   `int-blobs/<workspaceId>/<uuid>`
 *
 * Lifecycle rule (documented for provisioner):
 *   R2 buckets holding integration blobs should configure a lifecycle rule
 *   expiring prefix `int-blobs/` after 7 days to prevent unbounded storage growth.
 */
export function createR2BlobStore(bucket: R2BucketLike, options: R2BlobStoreOptions): BlobStore {
  const { workspaceId } = options;

  return {
    async put(body: ReadableStream | ArrayBuffer, meta: BlobStorePutMeta): Promise<BlobStorePutResult> {
      const uuid = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 12);
      const key = `int-blobs/${workspaceId}/${uuid}`;

      let bytes: Uint8Array;
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const u8 = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        if (u8.byteLength > meta.maxBytes) {
          throw new BlobStoreError(`INTEGRATION_PAYLOAD_TOO_LARGE: payload exceeded limit of ${meta.maxBytes} bytes`, "INTEGRATION_PAYLOAD_TOO_LARGE");
        }
        bytes = new Uint8Array(u8);
      } else {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.byteLength;
            if (total > meta.maxBytes) {
              await reader.cancel();
              throw new BlobStoreError(`INTEGRATION_PAYLOAD_TOO_LARGE: payload exceeded limit of ${meta.maxBytes} bytes`, "INTEGRATION_PAYLOAD_TOO_LARGE");
            }
          }
        } finally {
          reader.releaseLock();
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }

      await bucket.put(key, bytes, {
        httpMetadata: {
          contentType: meta.contentType,
        },
        customMetadata: {
          workspaceId,
        },
      });

      return {
        ref: key,
        size: bytes.byteLength,
        contentType: meta.contentType,
      };
    },

    async get(ref: string): Promise<BlobStoreGetResult> {
      const obj = await bucket.get(ref);
      if (!obj) {
        throw new BlobStoreError(`INTEGRATION_BLOB_NOT_FOUND: blob ref "${ref}" not found in R2`, "INTEGRATION_BLOB_NOT_FOUND");
      }
      return {
        body: obj.body,
        size: obj.size,
        contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      };
    },
  };
}
