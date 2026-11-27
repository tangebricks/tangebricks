import { describe, expect, it } from "vitest";
import type { IntegrationManifestFile } from "@poc/assembler";
import { createMemoryBlobStore } from "@poc/sdk";
import { callOperation, IntegrationCallError } from "../src/index.ts";
import type { IntegrationFetcher } from "../src/index.ts";

const baseManifest: IntegrationManifestFile = {
  manifestVersion: 2,
  kind: "integration",
  app: "test-content-types",
  version: "1.0.0",
  fidelity: {
    specHash: "sha256-test",
    importerVersion: "1.0.0",
    level: "curated",
    unsupported: [],
  },
  ui: {
    displayName: "Test Content Types",
    category: "developer",
    summary: "Content types and binary payload test suite",
    maturity: "beta",
    maturityReason: "UC3.6 content types verification",
    behaviourTest: "packages/runtime/test/integration-content-types.test.ts",
  },
  auth: {
    type: "none",
  },
  baseUrl: "https://api.example.com",
  allowedHosts: ["api.example.com"],
  operations: [
    {
      operationId: "uploadMultipartForm",
      label: "Upload Multipart Form",
      summary: "Upload a file with multipart/form-data",
      method: "POST",
      path: "/v1/files",
      sideEffects: "write",
      response: {},
      body: {
        contentType: "multipart/form-data" as any,
        fields: [
          { name: "purpose", dataType: "string", required: true },
          { name: "file", dataType: "any", binary: true, required: true },
        ],
      },
    },
    {
      operationId: "uploadOctetStream",
      label: "Upload Octet Stream",
      summary: "Upload raw binary octet stream",
      method: "POST",
      path: "/v1/assets",
      sideEffects: "write",
      response: {},
      body: {
        contentType: "application/octet-stream" as any,
        root: { dataType: "any" },
      },
    },
    {
      operationId: "uploadMultipartRelated",
      label: "Upload Multipart Related",
      summary: "Upload JSON metadata plus binary media with multipart/related",
      method: "POST",
      path: "/upload/v1/media",
      sideEffects: "write",
      response: {},
      body: {
        contentType: "multipart/related" as any,
        fields: [
          { name: "metadata", dataType: "object", required: true },
          { name: "media", dataType: "any", binary: true, required: true },
        ],
      },
    },
    {
      operationId: "sendTextPlain",
      label: "Send Text Plain",
      summary: "Send plain text body",
      method: "POST",
      path: "/v1/text",
      sideEffects: "write",
      response: {},
      body: {
        contentType: "text/plain" as any,
        root: { dataType: "string" },
      },
    },
    {
      operationId: "getPdf",
      label: "Get PDF",
      summary: "Download PDF document",
      method: "GET",
      path: "/v1/document.pdf",
      sideEffects: "read",
      response: {
        contentType: "application/pdf" as any,
        binary: true,
      } as any,
    },
    {
      operationId: "getLargeBinary",
      label: "Get Large Binary",
      summary: "Download large binary with capped maxBytes",
      method: "GET",
      path: "/v1/large.bin",
      sideEffects: "read",
      response: {
        contentType: "application/octet-stream" as any,
        binary: true,
        maxBytes: 1024 * 1024, // 1 MiB cap
      } as any,
    },
    {
      operationId: "getCsv",
      label: "Get CSV",
      summary: "Download CSV spreadsheet text",
      method: "GET",
      path: "/v1/export.csv",
      sideEffects: "read",
      response: {
        contentType: "text/csv" as any,
        outputs: [{ id: "text", dataType: "string" }],
      } as any,
    },
  ],
};

describe("UC3.6 — Runtime Content Types and Binary Payloads via host BlobStore", () => {
  it("multipart/form-data with a file field {blobRef} reaches the fetcher as FormData with the right part name, filename and content-type", async () => {
    const blobStore = createMemoryBlobStore();
    const pdfData = new TextEncoder().encode("%PDF-1.4 test file content");
    const blob = await blobStore.put(pdfData.buffer as ArrayBuffer, {
      contentType: "application/pdf",
      maxBytes: 10 * 1024 * 1024,
    });

    let capturedInit: RequestInit | undefined;
    const fetcher: IntegrationFetcher = async (_input, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true, id: "file_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await callOperation(
      baseManifest,
      "uploadMultipartForm",
      {
        purpose: "dispute_evidence",
        file: {
          blobRef: blob.ref,
          filename: "evidence.pdf",
          contentType: "application/pdf",
        },
      },
      {
        connection: null,
        fetcher,
        blobStore,
      },
    );

    expect(result.status).toBe(200);
    expect(capturedInit).toBeDefined();
    expect(capturedInit!.body).toBeInstanceOf(FormData);
    const fd = capturedInit!.body as FormData;
    expect(fd.get("purpose")).toBe("dispute_evidence");

    const filePart = fd.get("file") as unknown as { name?: string; type?: string; size?: number };
    expect(filePart).toBeDefined();
    expect(filePart.name).toBe("evidence.pdf");
    expect(filePart.type).toBe("application/pdf");
    expect(filePart.size).toBe(pdfData.byteLength);
  });

  it("an application/octet-stream body streams from a blobRef", async () => {
    const blobStore = createMemoryBlobStore();
    const rawBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff]);
    const blob = await blobStore.put(rawBytes.buffer as ArrayBuffer, {
      contentType: "application/octet-stream",
      maxBytes: 10 * 1024 * 1024,
    });

    let capturedHeaders: Record<string, string> = {};
    let capturedBodyBytes: Uint8Array | undefined;
    const fetcher: IntegrationFetcher = async (_input, init) => {
      capturedHeaders = Object.fromEntries(
        init?.headers instanceof Headers ? init.headers.entries() : Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      if (init?.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        capturedBodyBytes = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
        let offset = 0;
        for (const c of chunks) {
          capturedBodyBytes.set(c, offset);
          offset += c.byteLength;
        }
      } else if (init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body)) {
        capturedBodyBytes = new Uint8Array(init.body as ArrayBuffer);
      }
      return new Response(JSON.stringify({ assetId: "asset_99" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await callOperation(
      baseManifest,
      "uploadOctetStream",
      {
        body: { blobRef: blob.ref },
      },
      {
        connection: null,
        fetcher,
        blobStore,
      },
    );

    expect(result.status).toBe(201);
    expect(capturedHeaders["content-type"] ?? capturedHeaders["Content-Type"]).toBe("application/octet-stream");
    expect(capturedBodyBytes).toEqual(rawBytes);
  });

  it("multipart/related is sent as a JSON metadata part plus a media part with a correct boundary", async () => {
    const blobStore = createMemoryBlobStore();
    const mediaBytes = new TextEncoder().encode("image-binary-data");
    const blob = await blobStore.put(mediaBytes.buffer as ArrayBuffer, {
      contentType: "image/png",
      maxBytes: 10 * 1024 * 1024,
    });

    let capturedHeaders: Record<string, string> = {};
    let capturedBodyText: string = "";
    const fetcher: IntegrationFetcher = async (_input, init) => {
      capturedHeaders = Object.fromEntries(
        init?.headers instanceof Headers ? init.headers.entries() : Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      if (typeof init?.body === "string") {
        capturedBodyText = init.body;
      } else if (init?.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
        let offset = 0;
        for (const c of chunks) {
          total.set(c, offset);
          offset += c.byteLength;
        }
        capturedBodyText = new TextDecoder().decode(total);
      }
      return new Response(JSON.stringify({ id: "media_uploaded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await callOperation(
      baseManifest,
      "uploadMultipartRelated",
      {
        metadata: { title: "Document Title", folderId: "f_123" },
        media: {
          blobRef: blob.ref,
          contentType: "image/png",
          filename: "snapshot.png",
        },
      },
      {
        connection: null,
        fetcher,
        blobStore,
      },
    );

    expect(result.status).toBe(200);
    const contentType = capturedHeaders["content-type"] ?? capturedHeaders["Content-Type"];
    expect(contentType).toMatch(/^multipart\/related; boundary=[a-zA-Z0-9_-]+/);

    const boundary = contentType!.split("boundary=")[1];
    expect(capturedBodyText).toContain(`--${boundary}`);
    expect(capturedBodyText).toContain("Content-Type: application/json");
    expect(capturedBodyText).toContain('"title":"Document Title"');
    expect(capturedBodyText).toContain("Content-Type: image/png");
    expect(capturedBodyText).toContain("image-binary-data");
    expect(capturedBodyText).toContain(`--${boundary}--`);
  });

  it("a text/plain request is sent as text", async () => {
    let capturedBody: unknown;
    let capturedContentType: string | undefined;
    const fetcher: IntegrationFetcher = async (_input, init) => {
      capturedBody = init?.body;
      const headers = Object.fromEntries(
        init?.headers instanceof Headers ? init.headers.entries() : Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      capturedContentType = headers["content-type"] ?? headers["Content-Type"];
      return new Response(JSON.stringify({ lines: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await callOperation(
      baseManifest,
      "sendTextPlain",
      {
        body: "Hello world raw string payload",
      },
      {
        connection: null,
        fetcher,
      },
    );

    expect(result.status).toBe(200);
    expect(capturedContentType).toBe("text/plain");
    expect(capturedBody).toBe("Hello world raw string payload");
  });

  it('a 3 MB application/pdf response is stored in the BlobStore, and the output is {blobRef, contentType:"application/pdf", size}', async () => {
    const blobStore = createMemoryBlobStore();
    const pdfSize = 3 * 1024 * 1024;
    const pdfBytes = new Uint8Array(pdfSize);
    pdfBytes[0] = 0x25; // %
    pdfBytes[1] = 0x50; // P
    pdfBytes[2] = 0x44; // D
    pdfBytes[3] = 0x46; // F

    const fetcher: IntegrationFetcher = async () => {
      return new Response(pdfBytes, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    };

    const result = await callOperation(
      baseManifest,
      "getPdf",
      {},
      {
        connection: null,
        fetcher,
        blobStore,
      },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      blobRef: expect.any(String),
      contentType: "application/pdf",
      size: pdfSize,
    });
    const blobRef = (result.body as any).blobRef;
    const stored = await blobStore.get(blobRef);
    expect(stored.size).toBe(pdfSize);
    expect(stored.contentType).toBe("application/pdf");
  });

  it("a response larger than maxBytes rejects INTEGRATION_PAYLOAD_TOO_LARGE after reading at most maxBytes + 64KiB", async () => {
    const blobStore = createMemoryBlobStore();
    const maxBytes = 1024 * 1024; // 1 MiB
    const chunkSize = 16 * 1024; // 16 KiB
    let bytesRead = 0;

    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (closed) return;
        bytesRead += chunkSize;
        controller.enqueue(new Uint8Array(chunkSize));
        if (bytesRead >= maxBytes + 128 * 1024) {
          closed = true;
          controller.close();
        }
      },
    });

    const fetcher: IntegrationFetcher = async () => {
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    };

    let caughtError: unknown;
    try {
      await callOperation(
        baseManifest,
        "getLargeBinary",
        {},
        {
          connection: null,
          fetcher,
          blobStore,
        },
      );
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(IntegrationCallError);
    const callErr = caughtError as IntegrationCallError;
    expect(callErr.code).toBe("INTEGRATION_PAYLOAD_TOO_LARGE");
    // Assert streaming enforcement: must not read whole stream, and stop at most maxBytes + 64 KiB
    expect(bytesRead).toBeLessThanOrEqual(maxBytes + 64 * 1024);
  });

  it("a binary op without a blobStore rejects INTEGRATION_BLOBSTORE_MISSING", async () => {
    const fetcher: IntegrationFetcher = async () => {
      return new Response(new Uint8Array([0x01, 0x02]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    };

    let caughtError: unknown;
    try {
      await callOperation(
        baseManifest,
        "getPdf",
        {},
        {
          connection: null,
          fetcher,
          // blobStore deliberately omitted
        },
      );
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(IntegrationCallError);
    expect((caughtError as IntegrationCallError).code).toBe("INTEGRATION_BLOBSTORE_MISSING");
  });

  it("a text/csv response becomes a string output", async () => {
    const csvContent = "id,name,role\n1,Alice,Admin\n2,Bob,User\n";
    const fetcher: IntegrationFetcher = async () => {
      return new Response(csvContent, {
        status: 200,
        headers: { "content-type": "text/csv; charset=utf-8" },
      });
    };

    const result = await callOperation(
      baseManifest,
      "getCsv",
      {},
      {
        connection: null,
        fetcher,
      },
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe(csvContent);
  });
});
