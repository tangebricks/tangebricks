import { findWorkspaceState, formatMilli, toMilli, toMilliRounded } from "@poc/sdk";
import type { CreditRounding } from "@poc/sdk";
import type { D1Like } from "./d1.ts";
import { createWallet } from "./wallet.ts";

// Story 2.5: load existing decimal balances (from another system's export) into credit-wallet, exactly.
//
// Each balance is decimal text ("12.345", "0.2", "7") converted to thousandths by string parsing, never through a float.
// A value with more than three decimals is refused unless the caller chose a rounding mode, and then every rounded row
// is reported. Each workspace gets one top-up under the idempotency key `import:<file-hash>:<workspaceId>`, written by
// the wallet's own code, so running the same file twice credits it once. Nothing here knows any other system's column
// names: the input is `{ workspaceId, balance }` rows, and mapping an export to that shape is the caller's job.
//
// Safety rules (a top-up adds to whatever is there, so these keep an import from doubling money):
//   * every workspace id must be an existing workspace, suspended ones included (the row the workspace guard reads, via
//     `findWorkspaceState` in @poc/sdk); a database without that registry falls back to the wallet's existence;
//   * a workspace with no wallet is refused unless `createWallets` (which still needs the workspace to exist);
//   * a workspace whose wallet already holds a non-zero balance, or already has an `import:` row from any file, is
//     refused unless `allowExisting`, which the report records;
//   * every row is checked, and the totals are checked to be safe integers, before anything is written.

export interface BalanceImportRow {
  workspaceId: string;
  /** Decimal text in credits. */
  balance: string;
  /** Where the row came from (line or index), for the report. */
  source?: string;
  /** Why the row could not even be read (a JSON number balance, for example); the import refuses it. */
  error?: string;
}

export interface ImportBalancesOptions {
  /** The input file's SHA-256 (hex): part of every idempotency key, so a different file is a different import. */
  fileHash: string;
  /** False (the default) is a dry run: nothing is written, and the report says what would be. */
  apply?: boolean;
  /** Round values with more than three decimals instead of refusing them. */
  rounding?: CreditRounding;
  /** Recorded on each ledger row. Default "import". */
  userId?: string;
  /** Import into a wallet that already holds credits or an earlier import (the credit is added to it). Default false. */
  allowExisting?: boolean;
  /** Open a wallet for an existing workspace (suspended ones included) that has none. Default false: such a row is refused. */
  createWallets?: boolean;
  /**
   * Read the database for each workspace (whether it exists, its wallet, earlier imports). Default true. Only a dry run
   * with no database at all turns this off; `apply` requires it.
   */
  checkDatabase?: boolean;
}

export type ImportRowStatus = "imported" | "already_imported" | "would_import" | "zero" | "refused";

export interface ImportRowReport {
  source: string;
  workspaceId: string;
  /** The balance as given. */
  balance: string;
  /** The thousandths credited (or that would be); null when the row was refused. */
  milli: number | null;
  rounded: boolean;
  status: ImportRowStatus;
  /** The wallet's balance before this import (null when it had no wallet or the database was not read). */
  balanceBeforeMilli: number | null;
  /** After `apply`, the wallet's balance read back; on a dry run, what it would be. Null when nothing applies. */
  resultingBalanceMilli: number | null;
  /** For a row imported in this run: whether the resulting balance is exactly the source balance (plus the balance before, with allowExisting). */
  balanceMatches: boolean | null;
  /** When writing failed in the apply pass: the thousandths that were to be credited (no longer in `milli`). */
  failedMilli?: number | null;
  error?: string;
}

export interface BalanceImportReport {
  fileHash: string;
  applied: boolean;
  rounding: CreditRounding | null;
  allowExisting: boolean;
  createWallets: boolean;
  databaseChecked: boolean;
  rows: ImportRowReport[];
  /** The exact sum of every balance as given (decimal text, all its decimals), refused rows included. */
  sourceTotal: string;
  /** The exact sum of the thousandths credited or to be credited, as decimal text and as thousandths. */
  importedTotal: string;
  importedTotalMilli: number;
  /** The sum of the resulting balances of the rows credited (or to be) in this run, minus what they held before. */
  resultingTotalMilli: number;
  /** Rows whose credited thousandths differ from the balance as given (rounded or refused rows). */
  mismatchedRows: number;
  roundedRows: number;
  refusedRows: number;
  /** Rows whose ledger entry, read back, is not the amount intended. */
  ledgerMismatches: number;
  /** Rows imported in this run whose resulting balance is not the source balance. Always 0 on a dry run. */
  balanceMismatches: number;
  /** True when the source total equals the imported total to the thousandth and nothing was refused or mismatched. */
  reconciled: boolean;
}

const WORKSPACE_ID = /^[A-Za-z0-9_:.-]{1,200}$/;
const FILE_HASH = /^[0-9a-f]{8,64}$/;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Reads `{ workspaceId, balance }` rows from a JSON array or from CSV with a header line naming both columns (any
 * order; other columns are ignored; double-quoted fields may contain commas and doubled quotes). In JSON the balance
 * must be a string: a JSON number has already been through a float when it is parsed, so it is refused with a reason.
 * Throws on a file that has neither shape; a single bad row is kept and refused by `importWalletBalances`, not here.
 */
export function parseBalanceFile(text: string, format: "json" | "csv"): BalanceImportRow[] {
  if (format === "json") {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error("a JSON balance file is an array of { workspaceId, balance }");
    return data.map((item, index) => {
      const row = (item && typeof item === "object" ? item : {}) as { workspaceId?: unknown; balance?: unknown };
      const workspaceId = typeof row.workspaceId === "string" ? row.workspaceId : "";
      const source = `item ${index}`;
      if (typeof row.balance === "number") {
        return {
          workspaceId,
          balance: String(row.balance),
          source,
          error: 'a JSON balance must be a string, e.g. "12.345", not a number (numbers lose precision when parsed)',
        };
      }
      return { workspaceId, balance: typeof row.balance === "string" ? row.balance : "", source };
    });
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.trim());
  const wsCol = header.indexOf("workspaceId");
  const balCol = header.indexOf("balance");
  if (wsCol < 0 || balCol < 0) throw new Error("a CSV balance file needs a header line with workspaceId and balance columns");
  const rows: BalanceImportRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line);
    rows.push({ workspaceId: (cells[wsCol] ?? "").trim(), balance: (cells[balCol] ?? "").trim(), source: `line ${i + 1}` });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** The exact sum of non-negative decimal strings, as decimal text (BigInt arithmetic, no float). Invalid text counts as 0. */
export function exactDecimalSum(values: string[]): string {
  const valid: RegExpExecArray[] = [];
  let scale = 0;
  for (const value of values) {
    const m = DECIMAL.exec(value);
    if (!m) continue;
    valid.push(m);
    const decimals = (m[2] ?? "").length;
    if (decimals > scale) scale = decimals;
  }
  let total = 0n;
  for (const m of valid) total += BigInt(`${m[1]}${(m[2] ?? "").padEnd(scale, "0")}`);
  if (scale === 0) return total.toString();
  const digits = total.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

interface Planned {
  report: ImportRowReport;
  key: string;
  openWallet: boolean;
}

/**
 * Converts and checks every row first, then (with `apply`) credits each planned workspace once through the wallet's own
 * top-up. Returns the reconciliation report. Throws, before anything is written, for a bad `fileHash`, for `apply`
 * without database checks, or when the totals would not be exact integers.
 */
export async function importWalletBalances(db: D1Like, rows: BalanceImportRow[], options: ImportBalancesOptions): Promise<BalanceImportReport> {
  if (!FILE_HASH.test(options.fileHash)) throw new RangeError("fileHash must be lowercase hex (8 to 64 characters)");
  const apply = options.apply === true;
  const checkDatabase = options.checkDatabase !== false;
  if (apply && !checkDatabase) throw new RangeError("an import that writes must read the database first");
  const allowExisting = options.allowExisting === true;
  const createWallets = options.createWallets === true;
  const wallet = createWallet(db, undefined);
  const seen = new Set<string>();
  const reports: ImportRowReport[] = [];
  const planned: Planned[] = [];
  let ledgerMismatches = 0;

  // Pass 1: read and decide every row. Nothing is written here.
  for (const [index, row] of rows.entries()) {
    const report: ImportRowReport = {
      source: row.source ?? `row ${index}`,
      workspaceId: row.workspaceId,
      balance: row.balance,
      milli: null,
      rounded: false,
      status: "refused",
      balanceBeforeMilli: null,
      resultingBalanceMilli: null,
      balanceMatches: null,
    };
    reports.push(report);
    const refuse = (error: string) => {
      report.milli = null;
      report.status = "refused";
      report.error = error;
    };
    if (row.error) {
      refuse(row.error);
      continue;
    }
    if (!WORKSPACE_ID.test(row.workspaceId)) {
      refuse("workspaceId is missing or not a workspace id");
      continue;
    }
    if (seen.has(row.workspaceId)) {
      refuse("this workspace is listed more than once");
      continue;
    }
    seen.add(row.workspaceId);
    try {
      if (options.rounding) ({ milli: report.milli, rounded: report.rounded } = toMilliRounded(row.balance, options.rounding));
      else report.milli = toMilli(row.balance);
    } catch (error) {
      refuse(error instanceof Error ? error.message : String(error));
      continue;
    }
    const milli = report.milli!;
    const key = `import:${options.fileHash}:${row.workspaceId}`;

    if (!checkDatabase) {
      report.status = milli === 0 ? "zero" : "would_import";
      report.resultingBalanceMilli = milli;
      continue;
    }
    const state = await findWorkspaceState(db, row.workspaceId);
    if (!state) {
      refuse("no such workspace");
      continue;
    }
    const before = await wallet.getBalanceMilli(row.workspaceId);
    report.balanceBeforeMilli = before;
    if (before === null && !state.checked) {
      // No workspace registry in this database (a host with its own workspace guard): a wallet is the only evidence
      // that the id is a workspace, so none can be created for it.
      refuse("the workspace has no wallet, and without a workspace registry an id cannot be checked, so none is created");
      continue;
    }
    if (before === null && !createWallets) {
      refuse("the workspace has no wallet (createWallets / --create-wallets opens one)");
      continue;
    }
    // This file already imported here: a re-run, idempotent.
    const already = await db
      .prepare("SELECT amount_milli FROM credit_ledger WHERE workspace_id = ? AND idempotency_key = ?")
      .bind(row.workspaceId, key)
      .first<{ amount_milli: number }>();
    if (already) {
      if (already.amount_milli !== milli) ledgerMismatches += 1;
      report.status = "already_imported";
      report.resultingBalanceMilli = before;
      continue;
    }
    if (!allowExisting) {
      const earlierImport = await db
        .prepare("SELECT 1 AS present FROM credit_ledger WHERE workspace_id = ? AND idempotency_key LIKE 'import:%' LIMIT 1")
        .bind(row.workspaceId)
        .first<{ present: number }>();
      if ((before ?? 0) !== 0 || earlierImport) {
        refuse("the wallet already holds credits or has an earlier import; set allowExisting or --allow-existing to add to it");
        continue;
      }
    }
    const expected = (before ?? 0) + milli;
    if (!Number.isSafeInteger(expected)) {
      refuse("the resulting balance is too large");
      continue;
    }
    report.status = milli === 0 ? "zero" : "would_import";
    report.resultingBalanceMilli = expected;
    planned.push({ report, key, openWallet: before === null });
  }

  let importedTotalMilli = 0;
  for (const r of reports) importedTotalMilli += r.milli ?? 0;
  if (!Number.isSafeInteger(importedTotalMilli)) throw new RangeError("the imported total is too large to be exact; nothing was written");

  // Pass 2: write, only when every row has been decided and the totals are exact.
  if (apply) {
    for (const { report, key, openWallet } of planned) {
      // A row that fails here is recorded and the rest go on, so the report always comes back.
      const fail = (error: string) => {
        report.status = "refused";
        report.error = error;
        report.failedMilli = report.milli;
        report.milli = null;
        report.resultingBalanceMilli = null;
        report.balanceMatches = false;
      };
      try {
        if (openWallet) await wallet.openWallet(report.workspaceId, 0);
        if (report.milli! > 0) {
          const result = await wallet.refund({
            workspaceId: report.workspaceId,
            userId: options.userId ?? "import",
            amountMilli: report.milli!,
            reason: "Balance import",
            metadata: { import_file: options.fileHash, balance: report.balance, rounded: report.rounded, allow_existing: allowExisting },
            idempotencyKey: key,
          });
          if (!result.ok) {
            fail(result.reason === "idempotency_key_reused" ? "the import key is already used for another operation" : "the wallet could not be credited");
            continue;
          }
          // Reconciled against what the ledger and the wallet now hold, not against what was sent.
          const landed = await db
            .prepare("SELECT amount_milli FROM credit_ledger WHERE workspace_id = ? AND idempotency_key = ?")
            .bind(report.workspaceId, key)
            .first<{ amount_milli: number }>();
          if (landed?.amount_milli !== report.milli) ledgerMismatches += 1;
          report.status = result.duplicate ? "already_imported" : "imported";
        }
        const after = await wallet.getBalanceMilli(report.workspaceId);
        report.resultingBalanceMilli = after;
        report.balanceMatches = after === (allowExisting ? (report.balanceBeforeMilli ?? 0) : 0) + report.milli!;
      } catch (error) {
        fail(`writing failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      }
    }
    // A row that failed in this pass no longer counts as imported.
    importedTotalMilli = 0;
    for (const r of reports) importedTotalMilli += r.milli ?? 0;
  }

  let resultingTotalMilli = 0;
  for (const { report } of planned) {
    if (report.resultingBalanceMilli !== null) resultingTotalMilli += report.resultingBalanceMilli - (allowExisting ? (report.balanceBeforeMilli ?? 0) : 0);
  }
  const sourceTotal = exactDecimalSum(rows.map((r) => r.balance));
  const importedTotal = formatMilli(importedTotalMilli);
  const refusedRows = reports.filter((r) => r.status === "refused").length;
  const roundedRows = reports.filter((r) => r.rounded).length;
  const balanceMismatches = reports.filter((r) => r.balanceMatches === false).length;
  // A row mismatches when what is credited is not exactly the balance as given (it was rounded, or refused).
  const mismatchedRows = reports.filter((r) => r.milli === null || r.rounded).length;
  return {
    fileHash: options.fileHash,
    applied: apply,
    rounding: options.rounding ?? null,
    allowExisting,
    createWallets,
    databaseChecked: checkDatabase,
    rows: reports,
    sourceTotal,
    importedTotal,
    importedTotalMilli,
    resultingTotalMilli,
    mismatchedRows,
    roundedRows,
    refusedRows,
    ledgerMismatches,
    balanceMismatches,
    reconciled: sourceTotal === importedTotal && refusedRows === 0 && mismatchedRows === 0 && ledgerMismatches === 0 && balanceMismatches === 0,
  };
}

// Story 2.9: compare a host's own balances with this brick's, read-only. A host that keeps its own wallet and mirrors
// every change into credit-wallet ("shadow mode") uses this to show that the two ledgers agree before it switches over.

export interface ReconcileRow {
  workspaceId: string;
  /** The host's balance for this workspace, in thousandths (the host converts its own units first). */
  balanceMilli: number;
}

export interface ReconcileRowReport {
  workspaceId: string;
  /** The host's balance as given. */
  hostMilli: number;
  /** This brick's balance, or null when the workspace has no wallet here (compared as 0). */
  brickMilli: number | null;
  /** `brickMilli` (0 when null) minus `hostMilli`: positive when the brick holds more. */
  diffMilli: number;
  /** True when this row was refused (a bad id, a balance that is not a safe integer, or a repeated workspace). */
  refused: boolean;
  error?: string;
}

export interface ReconcileReport {
  rows: ReconcileRowReport[];
  hostTotalMilli: number;
  brickTotalMilli: number;
  /** brickTotalMilli minus hostTotalMilli. */
  diffTotalMilli: number;
  /** Rows whose diff is not 0. */
  mismatchedRows: number;
  /** Rows with no wallet here (they still match when the host's balance is 0). */
  missingWallets: number;
  refusedRows: number;
  /** True only when every row was read and every diff is 0. */
  exact: boolean;
}

/**
 * Reads this brick's balance for each `{ workspaceId, balanceMilli }` row and reports the difference per workspace and
 * in total. Writes nothing. A workspace with no wallet counts as 0 (and is counted in `missingWallets`). Throws only
 * when the totals would not be exact integers.
 */
/** Story 2.9: at most this many workspace ids go into one `IN (...)` list (D1 binds at most 100 parameters). */
const RECONCILE_CHUNK = 90;

export async function reconcileWallets(db: D1Like, rows: ReconcileRow[]): Promise<ReconcileReport> {
  const seen = new Set<string>();
  const reports: ReconcileRowReport[] = [];
  const toRead: ReconcileRowReport[] = [];
  for (const row of rows) {
    const workspaceId = typeof row?.workspaceId === "string" ? row.workspaceId : "";
    const hostMilli = row?.balanceMilli;
    const report: ReconcileRowReport = {
      workspaceId,
      hostMilli: Number.isSafeInteger(hostMilli) ? hostMilli : 0,
      brickMilli: null,
      diffMilli: 0,
      refused: false,
    };
    reports.push(report);
    const refuse = (error: string) => {
      report.refused = true;
      report.error = error;
    };
    if (!WORKSPACE_ID.test(workspaceId)) {
      refuse("workspaceId is missing or not a workspace id");
      continue;
    }
    if (!Number.isSafeInteger(hostMilli)) {
      refuse("balanceMilli must be a whole number of thousandths");
      continue;
    }
    if (seen.has(workspaceId)) {
      refuse("this workspace is listed more than once");
      continue;
    }
    seen.add(workspaceId);
    toRead.push(report);
  }
  // One query per chunk of at most RECONCILE_CHUNK workspaces, never one per workspace.
  const balances = new Map<string, number>();
  for (let i = 0; i < toRead.length; i += RECONCILE_CHUNK) {
    const ids = toRead.slice(i, i + RECONCILE_CHUNK).map((r) => r.workspaceId);
    // tenant-lint: allow read-only reconciliation reads the listed workspaces' balances in one IN query
    const result = await db
      .prepare(`SELECT workspace_id, balance_milli FROM credit_wallets WHERE workspace_id IN (${ids.map(() => "?").join(", ")})`)
      .bind(...ids)
      .all<{ workspace_id: string; balance_milli: number }>();
    for (const r of result.results ?? []) balances.set(r.workspace_id, r.balance_milli);
  }
  let hostTotalMilli = 0;
  let brickTotalMilli = 0;
  for (const report of toRead) {
    report.brickMilli = balances.has(report.workspaceId) ? balances.get(report.workspaceId)! : null;
    report.diffMilli = (report.brickMilli ?? 0) - report.hostMilli;
    hostTotalMilli += report.hostMilli;
    brickTotalMilli += report.brickMilli ?? 0;
  }
  if (!Number.isSafeInteger(hostTotalMilli) || !Number.isSafeInteger(brickTotalMilli)) throw new RangeError("the totals are too large to be exact");
  const mismatchedRows = reports.filter((r) => !r.refused && r.diffMilli !== 0).length;
  const refusedRows = reports.filter((r) => r.refused).length;
  return {
    rows: reports,
    hostTotalMilli,
    brickTotalMilli,
    diffTotalMilli: brickTotalMilli - hostTotalMilli,
    mismatchedRows,
    missingWallets: reports.filter((r) => !r.refused && r.brickMilli === null).length,
    refusedRows,
    exact: mismatchedRows === 0 && refusedRows === 0,
  };
}
