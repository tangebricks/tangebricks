import type { IntegrationManifestFile } from "@poc/assembler";
import type { ExecutionContext } from "@poc/sdk";
import { isPlainObject } from "./redaction.ts";
import { applyConnectionAuth, resolveConnectionForOperation } from "./auth.ts";
import { parseLinkNextUrl } from "./pagination.ts";
import { findErrorMappingForStatus } from "./response-decoding.ts";

export {
  applyConnectionAuth,
  findErrorMappingForStatus,
  parseLinkNextUrl,
  resolveConnectionForOperation,
};

export function getByDotPath(target: unknown, dotPath: string | undefined): unknown {
  if (!dotPath || dotPath === "" || dotPath === ".") return target;
  if (!target || typeof target !== "object") return undefined;
  const parts = dotPath.split(".");
  let cur: any = target;
  for (const part of parts) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setByDotPath(
  target: unknown,
  dotPath: string | undefined,
  value: unknown,
): unknown {
  if (!dotPath || dotPath === "" || dotPath === ".") return value;
  const parts = dotPath.split(".");
  const root: any = isPlainObject(target) ? { ...target } : {};
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (cur[part] === undefined || cur[part] === null || typeof cur[part] !== "object") {
      cur[part] = {};
    } else if (isPlainObject(cur[part])) {
      cur[part] = { ...cur[part] };
    }
    cur = cur[part];
  }
  const lastKey = parts[parts.length - 1]!;
  cur[lastKey] = value;
  return root;
}

export function resolveParamValue(ctx: ExecutionContext, name: string): unknown {
  if (Object.hasOwn(ctx.inputs, name) && ctx.inputs[name] !== undefined) {
    return ctx.inputs[name];
  }
  if (isPlainObject(ctx.inputs.in) && Object.hasOwn(ctx.inputs.in, name) && ctx.inputs.in[name] !== undefined) {
    return ctx.inputs.in[name];
  }
  if (Object.hasOwn(ctx.data, name) && ctx.data[name] !== undefined) {
    return ctx.data[name];
  }
  return undefined;
}

export function validatePathSegmentValue(
  paramName: string,
  val: string,
  allowReserved = false,
): string {
  if (allowReserved) {
    if (
      val.includes("\\") ||
      val.includes("@") ||
      /(?:^|\/)\.\.(?:\/|$)/.test(val) ||
      /%2e%2e/i.test(val)
    ) {
      throw new Error(
        `INTEGRATION_HOST_FORBIDDEN: Path parameter "${paramName}" contains forbidden path traversal or host-injection characters`,
      );
    }
    return val;
  }

  const str = String(val);
  if (
    str.includes("/") ||
    str.includes("\\") ||
    str.includes("..") ||
    str.includes("%2e%2e") ||
    str.includes("@")
  ) {
    throw new Error(
      `INTEGRATION_HOST_FORBIDDEN: Path parameter "${paramName}" contains forbidden path traversal or host-injection characters`,
    );
  }
  return encodeURIComponent(str);
}

export function validateRawPathTemplate(rawPath: string, app: string): void {
  const trimmed = rawPath.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("://") ||
    trimmed.includes("\\") ||
    trimmed.includes("@") ||
    /(?:^|\/)\.\.(?:\/|$)/.test(trimmed) ||
    /%2e%2e/i.test(trimmed)
  ) {
    throw new Error(
      `INTEGRATION_HOST_FORBIDDEN: Path "${rawPath}" for integration "${app}" contains forbidden host override or path traversal segments`,
    );
  }
}

export function validateAndBuildTargetUrl(
  manifest: IntegrationManifestFile,
  rawPath: string,
): URL {
  validateRawPathTemplate(rawPath, manifest.app);

  let baseUrlObj: URL;
  try {
    baseUrlObj = new URL(manifest.baseUrl);
  } catch {
    throw new Error(`INTEGRATION_HOST_FORBIDDEN: Invalid baseUrl "${manifest.baseUrl}"`);
  }

  if (baseUrlObj.protocol !== "https:") {
    throw new Error(
      `INTEGRATION_HOST_FORBIDDEN: Base URL "${manifest.baseUrl}" must use HTTPS protocol`,
    );
  }

  if (!manifest.allowedHosts.includes(baseUrlObj.hostname)) {
    throw new Error(
      `INTEGRATION_HOST_FORBIDDEN: Base URL host "${baseUrlObj.hostname}" is not in allowedHosts [${manifest.allowedHosts.join(", ")}]`,
    );
  }

  const basePath = baseUrlObj.pathname.replace(/\/+$/, "");
  const cleanOpPath = rawPath.replace(/^\/+/, "");
  const fullPath = `${basePath}/${cleanOpPath}`;

  let targetUrl: URL;
  try {
    targetUrl = new URL(fullPath, baseUrlObj.origin);
  } catch {
    throw new Error(`INTEGRATION_HOST_FORBIDDEN: Failed to construct URL for path "${rawPath}"`);
  }

  if (targetUrl.protocol !== "https:") {
    throw new Error(
      `INTEGRATION_HOST_FORBIDDEN: Target URL "${targetUrl.toString()}" must use HTTPS protocol`,
    );
  }

  if (!manifest.allowedHosts.includes(targetUrl.hostname)) {
    throw new Error(
      `INTEGRATION_HOST_FORBIDDEN: Target URL "${targetUrl.toString()}" violates allowedHosts [${manifest.allowedHosts.join(", ")}]`,
    );
  }

  return targetUrl;
}

export function substitutePathParams(
  ctx: ExecutionContext,
  rawPath: string,
  manifest: IntegrationManifestFile,
  paramAllowReserved: Map<string, boolean> = new Map(),
): string {
  return rawPath.replace(/\{([^{}]+)\}/g, (_match, paramName: string) => {
    let lookupName = paramName;
    let allowReserved = paramAllowReserved.get(paramName) ?? false;
    if (paramName.startsWith("+")) {
      lookupName = paramName.slice(1);
      allowReserved = true;
    }
    const val = resolveParamValue(ctx, lookupName);
    if (val === undefined || val === null || String(val).trim().length === 0) {
      throw new Error(
        `INTEGRATION_MISSING_PARAM: Missing required path parameter "${lookupName}" for path "${rawPath}"`,
      );
    }
    return validatePathSegmentValue(lookupName, String(val), allowReserved);
  });
}

export function assertNoReservedDataKeys(ctx: ExecutionContext): void {
  const check = (obj: unknown): void => {
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      for (const key of Object.getOwnPropertyNames(obj)) {
        if (key.startsWith("__")) {
          throw new Error(`INTEGRATION_RESERVED_DATA_KEY: ${key}`);
        }
      }
    }
  };
  check(ctx.data);
  check(ctx.inputs);
  check(ctx.payload);
  if (isPlainObject(ctx.inputs?.in)) {
    check(ctx.inputs.in);
  }
  if (isPlainObject(ctx.data?.params)) {
    check(ctx.data.params);
  }
  if (isPlainObject(ctx.data?.body)) {
    check(ctx.data.body);
  }
}
