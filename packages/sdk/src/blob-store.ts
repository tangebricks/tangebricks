export interface BlobStorePutMeta {
  contentType: string;
  maxBytes: number;
}

export interface BlobStorePutResult {
  ref: string;
  size: number;
  contentType: string;
}

export interface BlobStoreGetResult {
  body: ReadableStream;
  size: number;
  contentType: string;
}

export interface BlobStore {
  put(
    body: ReadableStream | ArrayBuffer,
    meta: BlobStorePutMeta,
  ): Promise<BlobStorePutResult>;
  get(ref: string): Promise<BlobStoreGetResult>;
}

export class BlobStoreError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "BlobStoreError";
    this.code = code;
  }
}

export function createMemoryBlobStore(): BlobStore {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();

  return {
    async put(
      body: ReadableStream | ArrayBuffer,
      meta: BlobStorePutMeta,
    ): Promise<BlobStorePutResult> {
      let bytes: Uint8Array;
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const u8 = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        if (u8.byteLength > meta.maxBytes) {
          throw new BlobStoreError(
            `INTEGRATION_PAYLOAD_TOO_LARGE: payload exceeded limit of ${meta.maxBytes} bytes`,
            "INTEGRATION_PAYLOAD_TOO_LARGE",
          );
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
              throw new BlobStoreError(
                `INTEGRATION_PAYLOAD_TOO_LARGE: payload exceeded limit of ${meta.maxBytes} bytes`,
                "INTEGRATION_PAYLOAD_TOO_LARGE",
              );
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

      const ref = `blob_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 12)}`;
      store.set(ref, { bytes, contentType: meta.contentType });
      return { ref, size: bytes.byteLength, contentType: meta.contentType };
    },

    async get(ref: string): Promise<BlobStoreGetResult> {
      const item = store.get(ref);
      if (!item) {
        throw new BlobStoreError(
          `INTEGRATION_BLOB_NOT_FOUND: blob ref "${ref}" not found`,
          "INTEGRATION_BLOB_NOT_FOUND",
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(item.bytes);
          controller.close();
        },
      });
      return {
        body: stream,
        size: item.bytes.byteLength,
        contentType: item.contentType,
      };
    },
  };
}
