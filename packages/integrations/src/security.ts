import { derefObject, isPlainObject } from "./util.ts";
import type { ImportSpecFormat } from "./types.ts";
import type { IntegrationAuthDefinition } from "@poc/assembler";
export function parseSecurityRequirements(sec: unknown): Array<Array<{ scheme: string; scopes?: string[] }>> {
  if (!Array.isArray(sec)) return [];
  const result: Array<Array<{ scheme: string; scopes?: string[] }>> = [];
  for (const item of sec) {
    if (!isPlainObject(item)) continue;
    const req: Array<{ scheme: string; scopes?: string[] }> = [];
    for (const [scheme, scopes] of Object.entries(item)) {
      req.push({
        scheme,
        ...(Array.isArray(scopes) && scopes.length > 0 ? { scopes: scopes.map(String) } : {}),
      });
    }
    result.push(req);
  }
  return result;
}

export function extractSpecSecurity(
  spec: Record<string, unknown>,
  format?: ImportSpecFormat,
): {
  schemes: Record<string, any>;
  requirements: Array<Array<{ scheme: string; scopes?: string[] }>>;
} {
  const schemes: Record<string, any> = {};
  if (format === "google-discovery") {
    schemes["oauth2"] = { type: "oauth2" };
    return {
      schemes,
      requirements: [[{ scheme: "oauth2" }]],
    };
  }

  const rawSchemes =
    isPlainObject(spec.components) && isPlainObject(spec.components.securitySchemes)
      ? (spec.components.securitySchemes as Record<string, unknown>)
      : isPlainObject(spec.securityDefinitions)
        ? (spec.securityDefinitions as Record<string, unknown>)
        : {};

  for (const [name, raw] of Object.entries(rawSchemes)) {
    const s = derefObject(spec, raw).target;
    if (s.type === "apiKey") {
      schemes[name] = {
        type: "apiKey",
        in: s.in,
        name: s.name,
      };
    } else if (s.type === "http") {
      schemes[name] = {
        type: "http",
        ...(typeof s.scheme === "string" ? { scheme: s.scheme.toLowerCase() } : {}),
        ...(typeof s.bearerFormat === "string" ? { bearerFormat: s.bearerFormat } : {}),
      };
    } else if (s.type === "basic") {
      schemes[name] = {
        type: "http",
        scheme: "basic",
      };
    } else if (s.type === "oauth2") {
      schemes[name] = {
        type: "oauth2",
      };
    } else if (s.type === "openIdConnect") {
      schemes[name] = {
        type: "openIdConnect",
      };
    } else if (s.type === "mutualTLS") {
      schemes[name] = {
        type: "mutualTLS",
      };
    }
  }

  const requirements = parseSecurityRequirements(spec.security);
  return { schemes, requirements };
}

export function satisfiesRequirement(
  req: Array<{ scheme: string; scopes?: string[] }>,
  curationAuth: IntegrationAuthDefinition | string | undefined | null,
  schemes: Record<string, any>,
): boolean {
  if (!curationAuth) return false;
  const authObj: IntegrationAuthDefinition = typeof curationAuth === "string" ? { type: curationAuth as any } : curationAuth;
  if (req.length === 0) return authObj.type === "none";

  for (const item of req) {
    const s = schemes[item.scheme];
    if (!s) return false;

    if (authObj.type === "oauth2") {
      const match = s.type === "oauth2" || (s.type === "http" && s.scheme === "bearer");
      if (!match) return false;
    } else if (authObj.type === "basic") {
      const match = s.type === "http" && s.scheme === "basic";
      if (!match) return false;
    } else if (authObj.type === "apiKey") {
      if (s.type === "apiKey") {
        const placement = authObj.in ?? "header";
        if (s.in && s.in !== placement) return false;
        if (authObj.headerName && s.name && authObj.headerName.toLowerCase() !== s.name.toLowerCase()) {
          return false;
        }
      } else if (s.type === "http" && s.scheme === "bearer") {
        const hName = authObj.headerName?.toLowerCase();
        if (hName && hName !== "authorization") return false;
        const prefix = authObj.prefix?.toLowerCase();
        if (prefix && prefix !== "bearer") return false;
      } else {
        return false;
      }
    } else if (authObj.type === "headers") {
      const templateHeaders = authObj.headers ?? {};
      if (s.type === "apiKey" && s.in === "header") {
        const matchesKey = Object.keys(templateHeaders).some((k) => k.toLowerCase() === (s.name ?? "").toLowerCase());
        if (!matchesKey) return false;
      } else {
        return false;
      }
    } else {
      return false;
    }
  }

  return true;
}

export function hasUnsupportedScheme(req: Array<{ scheme: string; scopes?: string[] }>, schemes: Record<string, any>): boolean {
  return req.some((item) => {
    const s = schemes[item.scheme];
    if (!s) return false;
    if (s.type === "apiKey" && s.in === "cookie") return true;
    if (s.type === "mutualTLS" || s.type === "openIdConnect") return true;
    return false;
  });
}
