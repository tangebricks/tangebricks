// Usage: node scripts/import-wallet-balances.ts <file.json|file.csv> [--sqlite <database.sqlite>] [--apply] [--round half-up|down] [--allow-existing] [--create-wallets] [--out <report.json>]
//
// Story 2.5: loads decimal credit balances into credit-wallet, exactly. The file is a JSON array of
// { "workspaceId": "...", "balance": "12.345" } or a CSV with workspaceId and balance header columns; the balance is
// decimal text in credits. Each balance becomes thousandths of a credit by string parsing (never a float). A balance
// with more than three decimals is refused unless --round is given, and then every rounded row is in the report.
//
// In a JSON file the balance must be a string; a JSON number is refused (it has been through a float already).
//
// A dry run is the default: the balances are converted and reconciled, and, with --sqlite, the database is read to say
// which workspaces would be credited. Every workspace id must be an existing workspace, suspended ones included (a row
// in mw_workspaces; a database without that table falls back to the wallet's existence). A workspace with no wallet is
// refused unless --create-wallets; one whose wallet already holds credits or an earlier import is refused unless
// --allow-existing (the report records it). Every row is checked before anything is written. --apply writes one
// top-up per workspace under the idempotency key import:<file-sha256>:<workspaceId>, through the wallet's own code, so
// running the same file again credits nothing twice. The database must already have credit-wallet's migrations (0001
// to 0004) applied.
//
// Hosted D1: call importWalletBalances (exported by the brick) with a D1Like over Cloudflare's D1 REST endpoint against
// the live database, as packages/deploy/src/h5-hosted.ts does with restD1; or quiesce the wallet (no spending or
// top-ups) before reloading a copy, since anything written to the live database after the copy was taken is lost.
//
// Mapping another system's export to { workspaceId, balance } is done before this tool; it knows no other system's
// column names. Exit code: 0 when reconciled, 1 when a row was refused or did not reconcile, 2 for a usage error.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { CreditRounding, D1Like } from "../packages/sdk/src/index.ts";
import { importWalletBalances, parseBalanceFile } from "../bricks/credit-wallet/src/import-balances.ts";
import { openSqliteD1 } from "./lib/sqlite-d1.ts";

function usage(message: string): never {
  console.error(`import-wallet-balances: ${message}`);
  console.error("usage: node scripts/import-wallet-balances.ts <file.json|file.csv> [--sqlite <database.sqlite>] [--apply] [--round half-up|down] [--allow-existing] [--create-wallets] [--out <report.json>]");
  process.exit(2);
}

const args = process.argv.slice(2);
let file: string | undefined;
let sqlitePath: string | undefined;
let apply = false;
let rounding: CreditRounding | undefined;
let out: string | undefined;
let allowExisting = false;
let createWallets = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg === "--apply") apply = true;
  else if (arg === "--allow-existing") allowExisting = true;
  else if (arg === "--create-wallets") createWallets = true;
  else if (arg === "--sqlite") sqlitePath = args[++i] ?? usage("--sqlite needs a path");
  else if (arg === "--out") out = args[++i] ?? usage("--out needs a path");
  else if (arg === "--round") {
    const mode = args[++i];
    if (mode !== "half-up" && mode !== "down") usage("--round is half-up or down");
    rounding = mode;
  } else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
  else if (file === undefined) file = arg;
  else usage("one input file only");
}
if (!file) usage("no input file");
if (!existsSync(file)) usage(`no such file: ${file}`);
if (apply && !sqlitePath) usage("--apply needs --sqlite <database.sqlite>");
if (sqlitePath && !existsSync(sqlitePath)) usage(`no such database: ${sqlitePath}`);

const bytes = readFileSync(file);
const fileHash = createHash("sha256").update(bytes).digest("hex");
const format = extname(file).toLowerCase() === ".csv" ? "csv" : "json";
const rows = parseBalanceFile(bytes.toString("utf8"), format);

// A dry run without a database still converts and reconciles; it reads nothing and writes nothing.
const emptyDb: D1Like = {
  prepare: (sql) => {
    const stmt = {
      bind: () => stmt,
      first: async () => null,
      all: async () => ({ results: [], success: true, meta: { changes: 0 } }),
      run: async () => {
        throw new Error(`a dry run without --sqlite cannot write (${sql.slice(0, 40)})`);
      },
    };
    return stmt as unknown as ReturnType<D1Like["prepare"]>;
  },
  batch: async () => {
    throw new Error("a dry run without --sqlite cannot write");
  },
  exec: async () => {
    throw new Error("a dry run without --sqlite cannot write");
  },
};

const db = sqlitePath ? openSqliteD1(resolve(sqlitePath)) : undefined;
try {
  const report = await importWalletBalances(db ?? emptyDb, rows, {
    fileHash,
    apply,
    allowExisting,
    createWallets,
    checkDatabase: db !== undefined,
    ...(rounding ? { rounding } : {}),
  });
  const json = JSON.stringify({ file: resolve(file), ...report }, null, 2);
  if (out) writeFileSync(out, `${json}\n`);
  for (const row of report.rows) {
    if (row.status === "refused") console.error(`refused ${row.source} (${row.workspaceId || "no workspace"}): ${row.error}`);
    else if (row.rounded) console.error(`rounded ${row.source} (${row.workspaceId}): ${row.balance} -> ${row.milli} thousandths`);
  }
  console.log(
    `${apply ? "applied" : "dry run"}: ${report.rows.length} rows, source total ${report.sourceTotal}, imported total ${report.importedTotal}, ` +
      `${report.refusedRows} refused, ${report.roundedRows} rounded, ${report.ledgerMismatches} ledger mismatches, ${report.balanceMismatches} balance mismatches${db ? "" : " (database not read)"}: ${report.reconciled ? "reconciled" : "NOT reconciled"}`,
  );
  if (!out) console.log(json);
  process.exitCode = report.reconciled ? 0 : 1;
} finally {
  db?.close();
}
