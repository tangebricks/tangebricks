import type { ImportReport, ImportReportEntry } from "./report.ts";
import type { CurationAcknowledge, CurationConfig } from "./curation.ts";

/**
 * Applies `curation.acknowledge` to the report's lossy entries, rejects stale acknowledgements,
 * and in strict mode rejects any loss that is still unacknowledged.
 */
export function applyAcknowledgements(report: ImportReport, curation: CurationConfig, mode: "strict" | "lenient"): void {
  const lossEntries = report.entries.filter((e) => e.status === "approximated" || e.status === "unsupported");
  const matchedAcks = new Set<CurationAcknowledge>();
  const acknowledgedEntries = new Set<ImportReportEntry>();

  if (curation.acknowledge && curation.acknowledge.length > 0) {
    for (const ack of curation.acknowledge) {
      let matchedAny = false;
      for (const entry of lossEntries) {
        const opMatches = ack.op === "*" || ack.op === entry.op;
        const codeMatches = ack.code === entry.code;
        const pointerMatches = ack.pointer === undefined || ack.pointer === entry.pointer;
        if (opMatches && codeMatches && pointerMatches) {
          matchedAny = true;
          acknowledgedEntries.add(entry);
          (entry as any).acknowledged = { reason: ack.reason };
        }
      }
      if (matchedAny) {
        matchedAcks.add(ack);
      }
    }

    for (const ack of curation.acknowledge) {
      if (!matchedAcks.has(ack)) {
        const isUpstreamAck =
          curation.specProvenance === "hand-trimmed" &&
          Boolean(curation.upstream && (ack.op === "*" || (curation.upstream.operationIds && ack.op in curation.upstream.operationIds)));
        if (!isUpstreamAck) {
          const ptrStr = ack.pointer ? `, pointer="${ack.pointer}"` : "";
          throw new Error(
            `OPENAPI_IMPORT_STALE_ACKNOWLEDGEMENT: Stale acknowledgement in curation for "${curation.app}": op="${ack.op}", code="${ack.code}"${ptrStr}`,
          );
        }
      }
    }
  }

  if (mode === "strict") {
    const unacknowledged = lossEntries.filter((e) => !acknowledgedEntries.has(e));
    if (unacknowledged.length > 0) {
      const list = unacknowledged
        .map((e) => `  - op="${e.op ?? "<doc>"}", code="${e.code}", pointer="${e.pointer}" (status=${e.status}, blocking=${e.blocking})`)
        .join("\n");
      throw new Error(
        `OPENAPI_IMPORT_UNACKNOWLEDGED_LOSS: Strict import rejected unacknowledged loss(es) in "${curation.app}" (${unacknowledged.length} unacknowledged):\n${list}`,
      );
    }
  }
}
