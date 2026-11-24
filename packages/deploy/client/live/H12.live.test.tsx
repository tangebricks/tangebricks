import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createWalletClient } from "../../../../bricks/credit-wallet/client/wallet-client.ts";
import { loadDeployment } from "../../src/context.ts";
import { GLUE_SCAN_FILES, canonical12, evaluateH12, runH12 } from "../../src/h12.ts";
import type { H12Result } from "../../src/h12.ts";
import { scanTreesForSecrets } from "../../src/leak-scan.ts";
import { overTheNetwork } from "../../src/network.ts";
import { createClient, createRedactor, findSecrets } from "../../src/provisioner/index.ts";
import { jsdomPageDriver } from "../support/page-driver.ts";
import { mountCreditWidget } from "../support/widget-driver.tsx";

// H12 on the real account (epic 5, story 7). Run with the credentials loaded by Node from the env file and the state folder named:
//
//   $env:POC_STATE_DIR = "C:\cephlow minimalist version\env\poc-state"
//   node "--env-file=C:\cephlow minimalist version\env\.env" node_modules/vitest/vitest.mjs run -c vitest.live.config.ts
//
// The credit widget is mounted in jsdom against the deployed address and driven only by looking at it and pressing Refresh. It
// reaches the server only through the credit-wallet brick's own client. This file holds no network code of its own: changes to the
// server's state are made by packages/deploy/src/h12.ts, and the one place a request leaves this machine is src/network.ts.
// WRITES TO THE ACCOUNT: two workspaces, wallet rows and ledger rows in the proof's own database. It uploads nothing.
const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const planRepo = resolve(root, "..", "ProjectX");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test(
  "the credit widget shows the live balance of the deployed API",
  async () => {
    const stateDir = process.env.POC_STATE_DIR;
    if (!stateDir) throw new Error("POC_STATE_DIR names the state folder (outside both repositories)");
    const deployment = loadDeployment({ root, planRepo, stateDir, env: process.env });
    const { credentials, accessKey } = deployment;
    const hide = createRedactor([credentials.token, credentials.accountId, accessKey]);
    const printed: string[] = [];
    const out = (line: string) => {
      printed.push(line);
      console.log(line);
    };
    const scannedFiles = Object.fromEntries(GLUE_SCAN_FILES.map((p) => [p, readFileSync(join(root, p), "utf8")]));

    const { calls, result: first } = await runH12({
      clock: () => performance.now(),
      commandStart: performance.now(),
      createClient: (now) => createClient({ credentials, fetch: overTheNetwork, now, alsoHide: [accessKey] }),
      names: deployment.names,
      databaseId: deployment.databaseId,
      url: deployment.url,
      accessKey,
      fetchUrl: overTheNetwork,
      hide,
      nowIso: () => new Date().toISOString(),
      log: out,
      deployedVersionFromH10: deployment.deployedVersionId,
      widgetClient: (o) => createWalletClient({ baseUrl: o.baseUrl, workspaceId: o.workspaceId, headers: o.headers, fetch: o.send }),
      mount: mountCreditWidget,
      page: jsdomPageDriver(overTheNetwork),
      scanned: Object.fromEntries(Object.entries(scannedFiles).map(([p, text]) => [p, sha(text)])),
    });

    // ---- the evidence: through the secret scan in memory, then to disk, then the repositories are scanned
    const secrets = { token: credentials.token, accountId: credentials.accountId, accessKey };
    const callsText = canonical12(calls);
    for (const [name, text] of [["h12-calls.json", callsText], ["h12-result.json", JSON.stringify(first, null, 2)]] as const) expect(findSecrets(text, secrets), `${name} must hold no secret`).toEqual([]);
    const dir = join(root, "evidence", "deployed");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const name of ["h12-calls.json", "h12-result.json"]) {
      if (existsSync(join(dir, name))) {
        mkdirSync(join(dir, "attempts"), { recursive: true });
        renameSync(join(dir, name), join(dir, "attempts", `${stamp}-${name}`));
      }
    }
    writeFileSync(join(dir, "h12-calls.json"), callsText);
    writeFileSync(join(dir, "h12-result.json"), `${JSON.stringify(first, null, 2)}\n`);
    const scan = scanTreesForSecrets([root, ...(existsSync(planRepo) ? [planRepo] : [])], secrets);
    const final: H12Result = { ...first, leakScan: scan };
    const finalText = `${JSON.stringify(final, null, 2)}\n`;
    expect(findSecrets(finalText + printed.join("\n"), secrets), "the result and the output must hold no secret").toEqual([]);
    writeFileSync(join(dir, "h12-result.json"), finalText);
    const attemptsPath = join(dir, "h12-attempts.json");
    const attempts = existsSync(attemptsPath) ? (JSON.parse(readFileSync(attemptsPath, "utf8")) as unknown[]) : [];
    attempts.push({ startedAt: calls.commandStartedAt, completed: final.completed, stoppedBecause: final.stoppedBecause ?? null });
    writeFileSync(attemptsPath, `${JSON.stringify(attempts, null, 2)}\n`);

    const evaluation = evaluateH12({ callsText, result: final, sources: scannedFiles });
    out("");
    for (const [name, value] of Object.entries(evaluation.checks)) out(`  ${value ? "true " : "FALSE"}  ${name}`);
    for (const note of evaluation.notes) out(`  note: ${note}`);
    out(`leak scan: ${scan.filesScanned} files in the two repositories, ${scan.found.length === 0 ? "no secret found" : `FOUND: ${scan.found.join("; ")}`}`);
    out(`attempt ${attempts.length} recorded; evidence in evidence/deployed/`);

    expect(final.completed, final.stoppedBecause).toBe(true);
    expect(Object.keys(evaluation.checks)).toHaveLength(4);
    expect(Object.values(evaluation.checks).every(Boolean)).toBe(true);
    expect(scan.found).toEqual([]);
  },
  900_000,
);
