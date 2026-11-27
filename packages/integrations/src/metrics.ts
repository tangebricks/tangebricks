import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { projectIntegrationToNodes } from "@poc/assembler";
import type { IntegrationManifestFile } from "@poc/assembler";

export interface ImportTokenMetrics {
  readonly tokenizer: "gpt-tokenizer 4.1.0, o200k_base";
  readonly compactSummaryTokens: number;
  readonly maxOperationDetailTokens: number;
  readonly maxSearchPageTokens: number;
  readonly perOperationTokens: Record<string, number>;
}

export function countO200kTokens(text: string): number {
  return encode(text).length;
}

/**
 * Computes compact, detail, and search-page token metrics for an integration manifest
 * using `gpt-tokenizer` (`o200k_base`).
 */
export function measureIntegrationTokenMetrics(manifest: IntegrationManifestFile): ImportTokenMetrics {
  const projectedNodes = projectIntegrationToNodes(manifest);

  const compactSummary = {
    app: manifest.app,
    displayName: manifest.ui.displayName,
    category: manifest.ui.category,
    maturity: manifest.ui.maturity,
    summary: manifest.ui.summary,
    authType: manifest.auth.type,
    operationCount: manifest.operations.length,
    triggerCount: manifest.triggers?.length ?? 0,
    operations: manifest.operations.map((op) => ({
      id: op.operationId,
      label: op.label,
      method: op.method,
    })),
  };
  const compactSummaryTokens = countO200kTokens(JSON.stringify(compactSummary));

  const perOperationTokens: Record<string, number> = {};
  let maxOperationDetailTokens = 0;

  for (const node of projectedNodes) {
    const getNodePayload = {
      type: node.type,
      label: node.label,
      summary: node.summary ?? node.label,
      role: node.role,
      source: "integration" as const,
      app: manifest.app,
      inputs: node.inputs,
      outputs: node.outputs,
      config: {},
      secrets: node.secrets ?? [],
      bindings: node.bindings ?? [],
      durable: node.durable ?? true,
      sideEffects: node.sideEffects,
    };
    const tok = countO200kTokens(JSON.stringify(getNodePayload));
    perOperationTokens[node.type] = tok;
    if (tok > maxOperationDetailTokens) {
      maxOperationDetailTokens = tok;
    }
  }

  let maxSearchPageTokens = 0;
  for (let offset = 0; offset < projectedNodes.length; offset += 10) {
    const slice = projectedNodes.slice(offset, offset + 10);
    const pagePayload = {
      items: slice.map((n) => ({
        type: n.type,
        label: n.label,
        role: n.role,
        source: "integration" as const,
        app: manifest.app,
      })),
      nextCursor: offset + 10 < projectedNodes.length ? "Y3Vyc29yOmhhc2g=" : null,
    };
    const pageTok = countO200kTokens(JSON.stringify(pagePayload));
    if (pageTok > maxSearchPageTokens) {
      maxSearchPageTokens = pageTok;
    }
  }

  return {
    tokenizer: "gpt-tokenizer 4.1.0, o200k_base",
    compactSummaryTokens,
    maxOperationDetailTokens,
    maxSearchPageTokens,
    perOperationTokens,
  };
}
