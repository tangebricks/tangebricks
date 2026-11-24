import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import type { IntegrationAuthDefinition } from "@poc/assembler";
import type { DiscoveryMethodContext } from "./discovery-params.ts";

/** Reports how the method's scopes map to the curated auth; returns the scopes. */
export function reportDiscoveryAuth(
  ctx: DiscoveryMethodContext,
  methodVal: Record<string, unknown>,
  curationAuth: IntegrationAuthDefinition | string | undefined,
): any[] {
  const { report, operationId, methodIdStr } = ctx;
  const scopes = Array.isArray(methodVal.scopes) ? methodVal.scopes : [];
  const authType = typeof curationAuth === "string" ? curationAuth : curationAuth?.type;
  if (scopes.length > 0 && authType === "oauth2") {
    report?.mapped({
      op: operationId,
      element: "auth",
      code: FIDELITY_CODES.AUTH_SCHEME.code,
      pointer: `#/methods/${escapeJsonPointer(methodIdStr)}/scopes`,
      blocking: false,
    });
  } else if (scopes.length > 0) {
    report?.curated({
      op: operationId,
      element: "auth",
      code: FIDELITY_CODES.AUTH_FROM_CURATION.code,
      pointer: `#/methods/${escapeJsonPointer(methodIdStr)}/scopes`,
      from: scopes,
      to: authType ?? "none",
      blocking: false,
    });
  } else if (authType && authType !== "none") {
    report?.curated({
      op: operationId,
      element: "auth",
      code: FIDELITY_CODES.AUTH_FROM_CURATION.code,
      pointer: "curation:#/auth",
      to: authType,
      reason: "spec declares no security",
      blocking: false,
    });
  } else {
    report?.mapped({
      op: operationId,
      element: "auth",
      code: FIDELITY_CODES.AUTH_MAPPED.code,
      pointer: `#/methods/${escapeJsonPointer(methodIdStr)}/scopes`,
      blocking: false,
    });
  }

  return scopes;
}
