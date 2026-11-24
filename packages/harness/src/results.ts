import type { Result } from "./verdict.ts";

/** One report from one test. Several tests may report for the same hypothesis. */
export interface Report extends Result {
  id: string;
}

/** A named blob of evidence a test wants stored as evidence/<name>.json (for example a per-file table). */
export interface Attachment {
  name: string;
  data: unknown;
}

interface MetaHolder {
  meta: object;
}

// vitest types `task.meta` as an empty interface; the cast is confined to these helpers.
type PocMeta = { poc?: Report[]; attachments?: Attachment[] };

/**
 * Called from inside a test (which runs in workerd and cannot write files). The report rides on
 * `task.meta` to the Node-side reporter, which merges and stores it.
 */
export function record(task: MetaHolder, report: Report): void {
  const meta = task.meta as PocMeta;
  meta.poc = [...(meta.poc ?? []), report];
}

/** Reads back what `record` attached; used by the reporter. */
export function readReports(meta: object): Report[] {
  return (meta as PocMeta).poc ?? [];
}

const ATTACHMENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Attaches evidence to be written to evidence/<name>.json. The name is restricted so it cannot name a path. */
export function attach(task: MetaHolder, name: string, data: unknown): void {
  if (!ATTACHMENT_NAME.test(name)) throw new Error(`attachment name must be lowercase letters, digits and dashes: ${name}`);
  const meta = task.meta as PocMeta;
  meta.attachments = [...(meta.attachments ?? []), { name, data }];
}

/** Reads back what `attach` stored; used by the reporter, which re-checks every name. */
export function readAttachments(meta: object): Attachment[] {
  return ((meta as PocMeta).attachments ?? []).filter((a) => ATTACHMENT_NAME.test(a.name));
}

/** Merges reports per hypothesis: a check is true only if every report that names it says true. */
export function mergeRecords(reports: Report[]): Record<string, Result> {
  const merged: Record<string, Result> = {};
  for (const report of reports) {
    const into = (merged[report.id] ??= {});
    if (report.measured !== undefined) into.measured = report.measured;
    if (report.checks) {
      const checks = (into.checks ??= {});
      for (const [name, value] of Object.entries(report.checks)) {
        checks[name] = name in checks ? checks[name] === true && value : value;
      }
    }
  }
  return merged;
}
