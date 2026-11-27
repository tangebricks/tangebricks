import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import { hasUnsupportedScheme, parseSecurityRequirements, satisfiesRequirement } from "./security.ts";
import type { extractSpecSecurity } from "./security.ts";
import type { IntegrationAuthDefinition } from "@poc/assembler";
import type { OpenApiOpContext } from "./openapi3-params.ts";

type SpecSecurity = ReturnType<typeof extractSpecSecurity>;

/** Reports how the operation's security requirements map to the curated auth; returns its own `security` override. */
export function reportOpenApiAuth(
  ctx: OpenApiOpContext,
  opRaw: Record<string, unknown>,
  security: SpecSecurity,
  curationAuth: IntegrationAuthDefinition | string | undefined,
): Array<Array<{ scheme: string; scopes?: string[] }>> | undefined {
  const { report, operationId, rawPath, methodLower } = ctx;
  const { schemes, requirements: rootRequirements } = security;
  const opSec = Array.isArray(opRaw.security) ? opRaw.security : undefined;
  const opHasSecurityOverride = opSec !== undefined;
  const effectiveRequirements = opHasSecurityOverride ? parseSecurityRequirements(opSec) : rootRequirements;

  let opSecurityValue: Array<Array<{ scheme: string; scopes?: string[] }>> | undefined = undefined;
  if (opHasSecurityOverride) {
    opSecurityValue = effectiveRequirements;
  }

  const authPointer = opHasSecurityOverride ? `#/paths/${escapeJsonPointer(rawPath)}/${methodLower}/security` : `#/security`;

  if (opHasSecurityOverride && opSec.length === 0) {
    report?.mapped({
      op: operationId,
      element: "auth",
      code: FIDELITY_CODES.AUTH_NONE.code,
      pointer: authPointer,
      blocking: false,
    });
  } else if (effectiveRequirements.length === 0) {
    const authType = typeof curationAuth === "string" ? curationAuth : curationAuth?.type;
    if (authType && authType !== "none") {
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
        pointer: "#/security",
        blocking: false,
      });
    }
  } else {
    const satisfiesAny = effectiveRequirements.some((req) => satisfiesRequirement(req, curationAuth, schemes));

    if (satisfiesAny) {
      report?.mapped({
        op: operationId,
        element: "auth",
        code: FIDELITY_CODES.AUTH_SCHEME.code,
        pointer: authPointer,
        blocking: false,
      });
    } else {
      const hasUnsupported = effectiveRequirements.some((req) => hasUnsupportedScheme(req, schemes));
      if (hasUnsupported) {
        report?.unsupported({
          op: operationId,
          element: "auth",
          code: FIDELITY_CODES.AUTH_SCHEME_UNSUPPORTED.code,
          pointer: authPointer,
          reason: "Cookie, mutualTLS, or openIdConnect security schemes are unsupported",
          blocking: true,
        });
      } else {
        const specSchemes = [...new Set(effectiveRequirements.flatMap((req) => req.map((i) => i.scheme)))];
        const authType = typeof curationAuth === "string" ? curationAuth : curationAuth?.type;
        report?.curated({
          op: operationId,
          element: "auth",
          code: FIDELITY_CODES.AUTH_FROM_CURATION.code,
          pointer: authPointer,
          from: specSchemes,
          to: authType ?? "none",
          blocking: false,
        });
      }
    }
  }

  return opSecurityValue;
}
