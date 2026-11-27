import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import type { ReportCollector } from "./report.ts";
import { isPlainObject, sanitizeOperationId } from "./util.ts";
import type { ImportSpecFormat } from "./types.ts";
export type DetectedSpecVersion = "openapi3.0" | "openapi3.1" | "swagger2" | "google-discovery";

export function detectSpecVersion(spec: unknown): DetectedSpecVersion {
  if (Array.isArray(spec)) {
    return "google-discovery";
  }
  if (!isPlainObject(spec)) {
    throw new Error("OPENAPI_IMPORT_PARSE_ERROR: 1:1 Spec must be an object");
  }
  if (typeof spec.openapi === "string") {
    if (spec.openapi.startsWith("3.1")) {
      return "openapi3.1";
    }
    if (spec.openapi.startsWith("3.0") || spec.openapi.startsWith("3.")) {
      return "openapi3.0";
    }
  }
  if (spec.swagger === "2.0" || (typeof spec.swagger === "string" && spec.swagger.startsWith("2."))) {
    return "swagger2";
  }
  if (spec.kind === "discovery#restDescription" || spec.discoveryVersion === "v1" || Array.isArray(spec.apis) || (spec.protocol === "rest" && spec.rootUrl)) {
    return "google-discovery";
  }
  throw new Error("OPENAPI_IMPORT_FORMAT_MISMATCH: Unable to detect spec dialect");
}

export function normalizeUrlForCompare(raw: string): string {
  try {
    const u = new URL(raw);
    const pathname = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${pathname}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

export function expandServerVariables(serverUrl: string, variables: Record<string, any> | undefined): { expandedUrl: string; wasExpanded: boolean } {
  let wasExpanded = false;
  const expandedUrl = serverUrl.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, varName) => {
    if (variables && variables[varName] && variables[varName].default !== undefined) {
      wasExpanded = true;
      return String(variables[varName].default);
    }
    return match;
  });
  return { expandedUrl, wasExpanded };
}

export interface ServerDiffOptions {
  readonly spec: Record<string, unknown> | unknown[];
  readonly format: ImportSpecFormat | "swagger2";
  readonly report: ReportCollector;
  readonly curation?: {
    readonly baseUrl?: string;
    readonly allowedHosts?: string[];
  };
}

export function diffServers(options: ServerDiffOptions): void {
  const { spec, report, curation } = options;
  const detected = detectSpecVersion(spec);

  interface RawServerInfo {
    rawUrl: string;
    pointer: string;
    op: string | null;
    variables?: Record<string, any>;
    isOpLevel?: boolean;
  }

  const collectedServers: RawServerInfo[] = [];

  if (detected === "google-discovery") {
    const docs = Array.isArray(spec) ? spec : Array.isArray((spec as any).apis) ? ((spec as any).apis as unknown[]) : [spec];

    for (let idx = 0; idx < docs.length; idx++) {
      const doc = docs[idx] as Record<string, unknown>;
      const rootUrl = typeof doc.rootUrl === "string" ? doc.rootUrl : "";
      const servicePath = typeof doc.servicePath === "string" ? doc.servicePath : "";
      const rawUrl = `${rootUrl.replace(/\/+$/, "")}/${servicePath.replace(/^\/+/, "")}`.replace(/\/+$/, "");
      const pointer = docs.length > 1 ? `/${idx}/rootUrl` : "#/rootUrl";
      collectedServers.push({
        rawUrl: rawUrl || "/",
        pointer,
        op: null,
      });
    }
  } else if (detected === "swagger2") {
    const s = spec as Record<string, unknown>;
    const host = typeof s.host === "string" ? s.host : "";
    const basePath = typeof s.basePath === "string" ? s.basePath : "";
    const schemes = Array.isArray(s.schemes) && s.schemes.length > 0 ? s.schemes : ["https"];
    const scheme = schemes[0] ?? "https";
    let rawUrl = "/";
    let pointer = "#/basePath";
    if (host) {
      rawUrl = `${scheme}://${host}${basePath.startsWith("/") ? "" : "/"}${basePath}`.replace(/\/+$/, "");
      pointer = "#/host";
    } else if (basePath) {
      rawUrl = basePath.replace(/\/+$/, "");
    }
    collectedServers.push({
      rawUrl,
      pointer,
      op: null,
    });
  } else {
    // openapi 3.0 / 3.1
    const s = spec as Record<string, unknown>;
    if (Array.isArray(s.servers) && s.servers.length > 0) {
      s.servers.forEach((srv: any, i: number) => {
        if (isPlainObject(srv) && typeof srv.url === "string") {
          collectedServers.push({
            rawUrl: srv.url,
            pointer: `#/servers/${i}`,
            op: null,
            variables: isPlainObject(srv.variables) ? srv.variables : undefined,
          });
        }
      });
    } else {
      collectedServers.push({
        rawUrl: curation?.baseUrl ?? "/",
        pointer: "#/servers",
        op: null,
      });
    }

    // Path-level and op-level servers
    if (isPlainObject(s.paths)) {
      for (const [pathStr, pathItemRaw] of Object.entries(s.paths)) {
        if (!isPlainObject(pathItemRaw)) continue;
        const pathItem = pathItemRaw as Record<string, unknown>;
        if (Array.isArray(pathItem.servers)) {
          pathItem.servers.forEach((srv: any, i: number) => {
            if (isPlainObject(srv) && typeof srv.url === "string") {
              collectedServers.push({
                rawUrl: srv.url,
                pointer: `#/paths/${escapeJsonPointer(pathStr)}/servers/${i}`,
                op: null,
                variables: isPlainObject(srv.variables) ? srv.variables : undefined,
              });
            }
          });
        }

        const methods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
        for (const m of methods) {
          const opRaw = pathItem[m];
          if (!isPlainObject(opRaw)) continue;
          const op = opRaw as Record<string, unknown>;
          if (Array.isArray(op.servers)) {
            const opId = typeof op.operationId === "string" ? sanitizeOperationId(op.operationId) : null;
            op.servers.forEach((srv: any, i: number) => {
              if (isPlainObject(srv) && typeof srv.url === "string") {
                collectedServers.push({
                  rawUrl: srv.url,
                  pointer: `#/paths/${escapeJsonPointer(pathStr)}/${m}/servers/${i}`,
                  op: opId,
                  variables: isPlainObject(srv.variables) ? srv.variables : undefined,
                  isOpLevel: true,
                });
              }
            });
          }
        }
      }
    }
  }

  // 1. Expand server variables with their default
  const expandedServers = collectedServers.map((s) => {
    const { expandedUrl, wasExpanded } = expandServerVariables(s.rawUrl, s.variables);
    if (wasExpanded) {
      report.normalized({
        op: s.op,
        element: "server",
        code: FIDELITY_CODES.SERVER_VARIABLE_EXPANDED.code,
        pointer: s.pointer,
        from: s.rawUrl,
        to: expandedUrl,
        blocking: false,
      });
    }
    return {
      ...s,
      url: expandedUrl,
    };
  });

  const rootOrPathServers = expandedServers.filter((s) => !s.isOpLevel);
  const primarySpecUrl = rootOrPathServers[0]?.url ?? "/";
  const effectiveBaseUrl = curation?.baseUrl ?? primarySpecUrl;

  // 2. Compare root/path servers with curation.baseUrl
  const seenDistinctRootUrls = new Set<string>();

  for (const s of rootOrPathServers) {
    const normUrl = normalizeUrlForCompare(s.url);
    if (seenDistinctRootUrls.has(normUrl)) continue;
    seenDistinctRootUrls.add(normUrl);

    const normEffective = normalizeUrlForCompare(effectiveBaseUrl);
    if (normUrl === normEffective) {
      report.mapped({
        op: null,
        element: "server",
        code: FIDELITY_CODES.BASEURL.code,
        pointer: s.pointer,
        from: s.url,
        to: effectiveBaseUrl,
        blocking: false,
      });
    } else {
      report.curated({
        op: null,
        element: "server",
        code: FIDELITY_CODES.BASEURL_CURATED.code,
        pointer: s.pointer,
        from: s.url,
        to: effectiveBaseUrl,
        blocking: false,
      });
    }
  }

  // 3. Op-level servers diff:
  // An op-level server whose host or path differs from baseUrl is unsupported OPERATION_SERVER_OVERRIDE with blocking:true
  const opLevelServers = expandedServers.filter((s) => s.isOpLevel);
  for (const s of opLevelServers) {
    const normOpUrl = normalizeUrlForCompare(s.url);
    const normBase = normalizeUrlForCompare(effectiveBaseUrl);
    if (normOpUrl !== normBase) {
      report.unsupported({
        op: s.op,
        element: "server",
        code: FIDELITY_CODES.OPERATION_SERVER_OVERRIDE.code,
        pointer: s.pointer,
        from: s.url,
        to: effectiveBaseUrl,
        blocking: true,
      });
    } else {
      report.mapped({
        op: s.op,
        element: "server",
        code: FIDELITY_CODES.BASEURL.code,
        pointer: s.pointer,
        from: s.url,
        to: effectiveBaseUrl,
        blocking: false,
      });
    }
  }

  // 4. Allowed hosts narrowed:
  // A spec server host missing from curation.allowedHosts is curated ALLOWED_HOSTS_NARROWED
  if (curation?.allowedHosts && curation.allowedHosts.length > 0) {
    const seenHosts = new Set<string>();
    for (const s of expandedServers) {
      try {
        const u = new URL(s.url);
        const host = u.hostname;
        if (host && !seenHosts.has(host)) {
          seenHosts.add(host);
          if (!curation.allowedHosts.includes(host)) {
            report.curated({
              op: s.op,
              element: "server",
              code: FIDELITY_CODES.ALLOWED_HOSTS_NARROWED.code,
              pointer: s.pointer,
              from: host,
              to: curation.allowedHosts,
              reason: `Spec server host "${host}" missing from curation.allowedHosts`,
              blocking: false,
            });
          }
        }
      } catch {
        // relative URL or unparseable, no host
      }
    }
  }
}
