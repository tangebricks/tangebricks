import type { IntegrationManifestFile, IntegrationOperation } from "@poc/assembler";
import type { ExecutionContext } from "@poc/sdk";
import { IntegrationCallError } from "./errors.ts";
import { collectConnectionSecretValues, isPlainObject } from "./redaction.ts";
import { resolveParamValue } from "./request-build.ts";

export async function resolveConnectionForOperation(
  ctx: ExecutionContext,
  manifest: IntegrationManifestFile,
  trackedSecrets: Set<string>,
): Promise<Record<string, unknown> | null> {
  if (manifest.auth.type === "none") {
    return null;
  }

  if (typeof ctx.connection !== "function") {
    throw new Error(`INTEGRATION_CONNECTION_MISSING: ExecutionContext does not provide ctx.connection() for integration "${manifest.app}"`);
  }

  const rawRef = resolveParamValue(ctx, "connectionRef") ?? resolveParamValue(ctx, "connection") ?? manifest.app;

  const candidateKeys: string[] = [];

  if (typeof rawRef === "string" && rawRef.trim().length > 0) {
    candidateKeys.push(rawRef.trim());
    if (rawRef.trim() !== manifest.app) {
      candidateKeys.push(manifest.app);
    }
  } else if (isPlainObject(rawRef)) {
    const refApp = typeof rawRef.app === "string" ? rawRef.app.trim() : undefined;
    if (refApp && refApp !== manifest.app) {
      throw new Error(`INTEGRATION_CONNECTION_MISMATCH: Connection reference targets app "${refApp}", expected "${manifest.app}"`);
    }
    const scope = typeof rawRef.scope === "string" ? rawRef.scope : "project";
    const refName = typeof rawRef.ref === "string" ? rawRef.ref.trim() : undefined;

    if (scope === "workspace") {
      const targetApp = refApp ?? manifest.app;
      let resolvedWorkspaceConn: Record<string, unknown> | undefined;
      try {
        const candidate = await ctx.connection<Record<string, unknown>>({
          scope: "workspace",
          app: targetApp,
          ...(typeof rawRef.workspaceId === "string" ? { workspaceId: rawRef.workspaceId } : {}),
        });
        if (isPlainObject(candidate)) {
          resolvedWorkspaceConn = candidate;
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.startsWith("WORKSPACE_CONNECTION_NOT_FOUND:") ||
            err.message.startsWith("WORKSPACE_CREDENTIAL_INTEGRITY_ERROR:") ||
            err.message.startsWith("CONNECTION_EXPIRED:"))
        ) {
          throw err;
        }
        throw new Error(`WORKSPACE_CONNECTION_NOT_FOUND: ${err instanceof Error ? err.message : `No workspace connection found for "${targetApp}"`}`);
      }

      if (!resolvedWorkspaceConn) {
        throw new Error(`WORKSPACE_CONNECTION_NOT_FOUND: No workspace connection found for "${targetApp}"`);
      }

      collectConnectionSecretValues(resolvedWorkspaceConn, trackedSecrets);
      if (typeof resolvedWorkspaceConn.app === "string" && resolvedWorkspaceConn.app.trim().length > 0 && resolvedWorkspaceConn.app.trim() !== manifest.app) {
        throw new Error(`INTEGRATION_CONNECTION_MISMATCH: Connection belongs to app "${resolvedWorkspaceConn.app}", expected "${manifest.app}"`);
      }
      return resolvedWorkspaceConn;
    }

    if (refName) {
      candidateKeys.push(refName);
      candidateKeys.push(`project:${refName}`);
    }
    candidateKeys.push(manifest.app);
  } else {
    candidateKeys.push(manifest.app);
  }

  let resolvedConn: Record<string, unknown> | undefined;
  let lastError: unknown;
  for (const key of candidateKeys) {
    try {
      const candidate = await ctx.connection<Record<string, unknown>>(key);
      if (isPlainObject(candidate)) {
        resolvedConn = candidate;
        break;
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.startsWith("CONNECTION_EXPIRED:") ||
          err.message.startsWith("WORKSPACE_CONNECTION_NOT_FOUND:") ||
          err.message.startsWith("WORKSPACE_CREDENTIAL_INTEGRITY_ERROR:"))
      ) {
        throw err;
      }
      lastError = err;
    }
  }

  if (!resolvedConn) {
    const detail = lastError instanceof Error ? lastError.message : `connection for "${manifest.app}" not found`;
    throw new Error(`INTEGRATION_CONNECTION_MISSING: ${detail}`);
  }

  collectConnectionSecretValues(resolvedConn, trackedSecrets);

  if (typeof resolvedConn.app === "string" && resolvedConn.app.trim().length > 0 && resolvedConn.app.trim() !== manifest.app) {
    throw new Error(`INTEGRATION_CONNECTION_MISMATCH: Connection belongs to app "${resolvedConn.app}", expected "${manifest.app}"`);
  }

  return resolvedConn;
}

export function applyConnectionAuth(
  manifest: IntegrationManifestFile,
  conn: Record<string, unknown> | null,
  headers: Record<string, string>,
  targetUrl: URL,
  trackedSecrets: Set<string>,
  secretFieldNames: Set<string>,
): void {
  if (!conn || manifest.auth.type === "none") return;

  if (manifest.auth.headerName) {
    secretFieldNames.add(manifest.auth.headerName.toLowerCase());
  }
  if (typeof conn.headerName === "string" && conn.headerName.trim()) {
    secretFieldNames.add(conn.headerName.trim().toLowerCase());
  }

  if (manifest.auth.type === "headers") {
    const templateHeaders = manifest.auth.headers ?? {};
    const templateRegex = /\{\{conn\.([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;

    for (const [headerName, template] of Object.entries(templateHeaders)) {
      let containsConnPlaceholder = false;
      const rendered = template.replace(templateRegex, (_match, field) => {
        containsConnPlaceholder = true;
        const val = conn[field];
        if (val === undefined || val === null || val === "") {
          throw new IntegrationCallError(`INTEGRATION_CONNECTION_INCOMPLETE: missing conn.${field}`, { code: "INTEGRATION_CONNECTION_INCOMPLETE" });
        }
        if (typeof val === "string" && val.length >= 3) {
          trackedSecrets.add(val);
        }
        return String(val);
      });

      headers[headerName] = rendered;
      if (containsConnPlaceholder) {
        secretFieldNames.add(headerName.toLowerCase());
        if (rendered.length >= 3) {
          trackedSecrets.add(rendered);
        }
      }
    }
    return;
  }

  if (manifest.auth.type === "oauth2") {
    const headerName = (typeof conn.headerName === "string" && conn.headerName.trim()) || manifest.auth.headerName || "Authorization";
    const prefix = typeof conn.prefix === "string" ? conn.prefix : (manifest.auth.prefix ?? "Bearer");
    const rawToken = String(conn.accessToken ?? conn.token ?? conn.apiKey ?? conn.secret ?? "");
    const headerValue =
      typeof conn.authHeader === "string" && conn.authHeader.trim() ? conn.authHeader.trim() : `${prefix ? `${prefix.trim()} ` : ""}${rawToken}`;
    headers[headerName] = headerValue;
    if (rawToken.length >= 3) trackedSecrets.add(rawToken);
    if (headerValue.length >= 3) trackedSecrets.add(headerValue);
    return;
  }

  if (manifest.auth.type === "apiKey") {
    const rawKey = String(conn.apiKey ?? conn.token ?? conn.accessToken ?? conn.secret ?? "");
    if (rawKey.length >= 3) trackedSecrets.add(rawKey);
    const placement = (typeof conn.in === "string" ? conn.in : manifest.auth.in) ?? "header";
    if (placement === "query") {
      const queryParam = (typeof conn.queryParam === "string" && conn.queryParam.trim()) || manifest.auth.queryParam || manifest.auth.headerName || "api_key";
      secretFieldNames.add(queryParam.toLowerCase());
      targetUrl.searchParams.set(queryParam, rawKey);
      return;
    }
    const headerName = (typeof conn.headerName === "string" && conn.headerName.trim()) || manifest.auth.headerName || "X-API-Key";
    const prefix = typeof conn.prefix === "string" ? conn.prefix : (manifest.auth.prefix ?? "");
    const headerValue =
      typeof conn.authHeader === "string" && conn.authHeader.trim() ? conn.authHeader.trim() : `${prefix ? `${prefix.trim()} ` : ""}${rawKey}`;
    headers[headerName] = headerValue;
    if (headerValue.length >= 3) trackedSecrets.add(headerValue);
    return;
  }

  if (manifest.auth.type === "basic") {
    const headerName = (typeof conn.headerName === "string" && conn.headerName.trim()) || manifest.auth.headerName || "Authorization";
    let headerValue: string;
    if (typeof conn.authHeader === "string" && conn.authHeader.trim()) {
      headerValue = conn.authHeader.trim();
    } else if (typeof conn.username === "string" || typeof conn.password === "string") {
      const user = typeof conn.username === "string" ? conn.username : "";
      const pass = typeof conn.password === "string" ? conn.password : "";
      if (pass.length >= 3) trackedSecrets.add(pass);
      const encoded = btoa(`${user}:${pass}`);
      if (encoded.length >= 3) trackedSecrets.add(encoded);
      headerValue = `Basic ${encoded}`;
    } else {
      const rawBasic = String(conn.basicToken ?? conn.token ?? conn.apiKey ?? conn.secret ?? "");
      if (rawBasic.length >= 3) trackedSecrets.add(rawBasic);
      const encoded = rawBasic.includes(":") ? btoa(rawBasic) : rawBasic;
      if (encoded.length >= 3) trackedSecrets.add(encoded);
      headerValue = `Basic ${encoded}`;
    }
    headers[headerName] = headerValue;
    if (headerValue.length >= 3) trackedSecrets.add(headerValue);
  }
}

export function resolveOperationAuth(
  manifest: IntegrationManifestFile,
  operation: IntegrationOperation,
  connection: Record<string, unknown> | null | undefined,
  requestHeaders: Record<string, string>,
  targetUrl: URL,
  trackedSecrets: Set<string>,
  secretFieldNames: Set<string>,
): Set<string> {
  const effectiveSecurity = operation.security !== undefined ? operation.security : (manifest.auth?.requirements ?? undefined);
  const skipAuth = effectiveSecurity !== undefined && effectiveSecurity.length === 0;

  const authHeaderNames = new Set<string>();
  if (!skipAuth) {
    if (manifest.auth.headerName) {
      authHeaderNames.add(manifest.auth.headerName.toLowerCase());
    }
    if (manifest.auth.type === "oauth2" || manifest.auth.type === "basic") {
      authHeaderNames.add("authorization");
    }
    if (manifest.auth.type === "headers" && manifest.auth.headers) {
      for (const k of Object.keys(manifest.auth.headers)) {
        authHeaderNames.add(k.toLowerCase());
      }
    }
    if (manifest.auth.type === "apiKey") {
      const h = (typeof connection?.headerName === "string" && connection.headerName.trim()) || manifest.auth.headerName || "x-api-key";
      authHeaderNames.add(h.toLowerCase());
    }
    if (connection && typeof connection.headerName === "string" && connection.headerName.trim()) {
      authHeaderNames.add(connection.headerName.trim().toLowerCase());
    }

    if (connection) {
      if (typeof connection.app === "string" && connection.app.trim() && connection.app.trim() !== manifest.app) {
        throw new IntegrationCallError(`INTEGRATION_CONNECTION_MISMATCH: Connection belongs to app "${connection.app}", expected "${manifest.app}"`, {
          code: "INTEGRATION_CONNECTION_MISMATCH",
        });
      }
      collectConnectionSecretValues(connection, trackedSecrets);
      applyConnectionAuth(manifest, connection, requestHeaders, targetUrl, trackedSecrets, secretFieldNames);
    } else if (manifest.auth.type !== "none") {
      throw new IntegrationCallError(`INTEGRATION_CONNECTION_MISSING: Missing connection for integration "${manifest.app}"`, {
        code: "INTEGRATION_CONNECTION_MISSING",
      });
    }
  }

  return authHeaderNames;
}
