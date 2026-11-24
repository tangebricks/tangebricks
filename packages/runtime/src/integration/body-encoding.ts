import type { FieldSchema, IntegrationOperation } from "@poc/assembler";
import type { BlobStore } from "@poc/sdk";
import { IntegrationCallError } from "./errors.ts";
import { isPlainObject, trackSecretValue } from "./redaction.ts";

export function encodeBracketForm(
  prefix: string,
  val: unknown,
  targetPairs: [string, string][],
): void {
  if (isPlainObject(val)) {
    for (const [k, v] of Object.entries(val)) {
      encodeBracketForm(`${prefix}[${k}]`, v, targetPairs);
    }
  } else if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      encodeBracketForm(`${prefix}[${i}]`, val[i], targetPairs);
    }
  } else if (val !== undefined && val !== null) {
    targetPairs.push([prefix, String(val)]);
  }
}

export function matchesVariant(val: unknown, variant: FieldSchema): boolean {
  if (variant.discriminator && typeof val === "object" && val !== null) {
    const discVal = (val as Record<string, unknown>)[variant.discriminator];
    const discSchema = variant.properties?.[variant.discriminator];
    if (discSchema?.enum) {
      return discSchema.enum.includes(discVal as any);
    }
  }
  if (variant.properties && typeof val === "object" && val !== null && !Array.isArray(val)) {
    for (const [k, propSchema] of Object.entries(variant.properties)) {
      if (propSchema.enum && Object.hasOwn(val, k)) {
        if (!propSchema.enum.includes((val as Record<string, unknown>)[k] as any)) {
          return false;
        }
      }
    }
    return true;
  }
  if (variant.dataType === "string") return typeof val === "string";
  if (variant.dataType === "number") return typeof val === "number";
  if (variant.dataType === "boolean") return typeof val === "boolean";
  if (variant.dataType === "array") return Array.isArray(val);
  if (variant.dataType === "object") return typeof val === "object" && val !== null && !Array.isArray(val);
  return true;
}

export function validateVariants(name: string, val: unknown, schema?: FieldSchema): void {
  if (!schema?.variants || schema.variants.length === 0) return;
  const matches = schema.variants.some((v) => matchesVariant(val, v));
  if (!matches) {
    throw new IntegrationCallError(
      `INTEGRATION_INVALID_PARAM: Value for "${name}" does not match any oneOf variant`,
      { code: "INTEGRATION_INVALID_PARAM" },
    );
  }
}

export async function encodeRequestBody(
  operation: IntegrationOperation,
  args: Record<string, unknown>,
  requestHeaders: Record<string, string>,
  options: { blobStore?: BlobStore },
  trackedSecrets: Set<string>,
  secretFieldNames: Set<string>,
): Promise<any> {
  if (!operation.body || operation.method === "GET") {
    return undefined;
  }

  const contentType = operation.body.contentType ?? "application/json";
  requestHeaders["content-type"] = contentType;

  if (contentType === "multipart/form-data") {
    const formData = new FormData();
    delete requestHeaders["content-type"];
    delete requestHeaders["Content-Type"];

    for (const field of operation.body.fields ?? []) {
      const val = args[field.name];
      if (field.sensitive || secretFieldNames.has(field.name.toLowerCase())) {
        trackSecretValue(val, trackedSecrets);
      }
      if (val === undefined) {
        if (field.required) {
          throw new IntegrationCallError(
            `INTEGRATION_MISSING_PARAM: Missing required body field "${field.name}"`,
            { code: "INTEGRATION_MISSING_PARAM" },
          );
        }
        continue;
      }
      if (field.binary) {
        if (val && typeof val === "object" && "blobRef" in (val as Record<string, unknown>)) {
          if (!options.blobStore) {
            throw new IntegrationCallError(
              "INTEGRATION_BLOBSTORE_MISSING: blobStore is required for binary payload",
              { code: "INTEGRATION_BLOBSTORE_MISSING" },
            );
          }
          const blobRef = String((val as Record<string, unknown>).blobRef);
          const stored = await options.blobStore.get(blobRef);
          const reader = stored.body.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const totalBytes = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
          let offset = 0;
          for (const c of chunks) {
            totalBytes.set(c, offset);
            offset += c.byteLength;
          }
          const fileType = String((val as Record<string, unknown>).contentType ?? stored.contentType ?? "application/octet-stream");
          const fileName = String((val as Record<string, unknown>).filename ?? "file");
          const fileObj = typeof File !== "undefined"
            ? new File([totalBytes], fileName, { type: fileType })
            : new Blob([totalBytes], { type: fileType });
          formData.append(field.wireName ?? field.name, fileObj as any, fileName);
        } else if (val instanceof Blob || (typeof File !== "undefined" && val instanceof File)) {
          formData.append(field.wireName ?? field.name, val as any);
        } else {
          formData.append(field.wireName ?? field.name, String(val));
        }
      } else {
        formData.append(field.wireName ?? field.name, String(val));
      }
    }
    return formData;
  }

  if (contentType === "multipart/related") {
    const boundary = "----ProjectXBoundary" + Math.random().toString(36).slice(2, 10);
    requestHeaders["content-type"] = `multipart/related; boundary=${boundary}`;

    const metadataVal = args.metadata ?? {};
    const mediaVal = (args.media ?? {}) as Record<string, unknown>;
    let mediaBytes: Uint8Array;
    let mediaType = "application/octet-stream";

    if (mediaVal && typeof mediaVal === "object" && "blobRef" in mediaVal) {
      if (!options.blobStore) {
        throw new IntegrationCallError(
          "INTEGRATION_BLOBSTORE_MISSING: blobStore is required for binary payload",
          { code: "INTEGRATION_BLOBSTORE_MISSING" },
        );
      }
      const stored = await options.blobStore.get(String(mediaVal.blobRef));
      const reader = stored.body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      mediaBytes = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
      let offset = 0;
      for (const c of chunks) {
        mediaBytes.set(c, offset);
        offset += c.byteLength;
      }
      mediaType = String(mediaVal.contentType ?? stored.contentType ?? "application/octet-stream");
    } else {
      mediaBytes = new Uint8Array(0);
    }

    const preamble = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadataVal)}\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`;
    const postamble = `\r\n--${boundary}--\r\n`;
    const preambleBytes = new TextEncoder().encode(preamble);
    const postambleBytes = new TextEncoder().encode(postamble);
    const combined = new Uint8Array(preambleBytes.byteLength + mediaBytes.byteLength + postambleBytes.byteLength);
    combined.set(preambleBytes, 0);
    combined.set(mediaBytes, preambleBytes.byteLength);
    combined.set(postambleBytes, preambleBytes.byteLength + mediaBytes.byteLength);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(combined);
        controller.close();
      },
    });
  }

  if (contentType === "application/octet-stream") {
    const rootVal: unknown = args.body !== undefined ? args.body : (args.in !== undefined ? args.in : args);
    if (rootVal && typeof rootVal === "object" && "blobRef" in (rootVal as Record<string, unknown>)) {
      if (!options.blobStore) {
        throw new IntegrationCallError(
          "INTEGRATION_BLOBSTORE_MISSING: blobStore is required for binary payload",
          { code: "INTEGRATION_BLOBSTORE_MISSING" },
        );
      }
      const stored = await options.blobStore.get(String((rootVal as Record<string, unknown>).blobRef));
      return stored.body;
    } else if (rootVal instanceof ReadableStream || rootVal instanceof ArrayBuffer || ArrayBuffer.isView(rootVal)) {
      return rootVal as any;
    } else {
      return String(rootVal);
    }
  }

  if (contentType === "text/plain") {
    const raw = args.body !== undefined ? args.body : (args.in !== undefined ? args.in : (typeof args === "string" ? args : JSON.stringify(args)));
    return typeof raw === "string" ? raw : String(raw);
  }

  if (operation.body.root) {
    let rootVal: unknown;
    if (args.body !== undefined) {
      rootVal = args.body;
    } else if (args.in !== undefined) {
      rootVal = args.in;
    } else if (Array.isArray(args)) {
      rootVal = args;
    } else {
      rootVal = args;
    }
    trackSecretValue(rootVal, trackedSecrets);
    if (operation.body.root.schema) {
      validateVariants("body", rootVal, operation.body.root.schema);
    }
    if (contentType === "application/x-www-form-urlencoded") {
      const formPairs: [string, string][] = [];
      if (isPlainObject(rootVal)) {
        for (const [k, v] of Object.entries(rootVal)) {
          encodeBracketForm(k, v, formPairs);
        }
      } else {
        formPairs.push(["body", String(rootVal)]);
      }
      const formParams = new URLSearchParams();
      for (const [k, v] of formPairs) {
        formParams.append(k, v);
      }
      return formParams.toString();
    } else {
      return JSON.stringify(rootVal);
    }
  }

  const bodyFields: Record<string, unknown> = {};
  for (const field of operation.body.fields ?? []) {
    const val = args[field.name];
    if (field.sensitive || secretFieldNames.has(field.name.toLowerCase())) {
      trackSecretValue(val, trackedSecrets);
    }
    if (val === undefined) {
      if (field.required) {
        throw new IntegrationCallError(
          `INTEGRATION_MISSING_PARAM: Missing required body field "${field.name}"`,
          { code: "INTEGRATION_MISSING_PARAM" },
        );
      }
      continue;
    }
    if (field.schema) {
      validateVariants(field.name, val, field.schema);
    }
    bodyFields[field.wireName ?? field.name] = val;
  }

  if (contentType === "application/x-www-form-urlencoded") {
    const formPairs: [string, string][] = [];
    for (const [k, v] of Object.entries(bodyFields)) {
      encodeBracketForm(k, v, formPairs);
    }
    const formParams = new URLSearchParams();
    for (const [k, v] of formPairs) {
      formParams.append(k, v);
    }
    return formParams.toString();
  } else {
    return JSON.stringify(bodyFields);
  }
}
