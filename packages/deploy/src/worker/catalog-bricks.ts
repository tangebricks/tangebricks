import { catalog } from "@poc/assembler/catalog";
import { buildExecutorsFromCatalog, buildRegistryFromCatalog } from "@poc/runtime";
import { createRegistry } from "@poc/sdk";
import type { BrickManifest, Executor, Executors, Registry } from "@poc/sdk";
import * as creditWallet from "@poc/credit-wallet";

// The bricks a deployed Workflow runs: the real catalog registry and the real executors (story 1.1, R52), not the proof
// stubs. Runs in workerd; imports nothing from Node.
//
// Package exports wired here are the catalog bricks whose package executors do the real work. A brick action whose package
// is not listed keeps the runtime's NOT_CONFIGURED executor, so it fails visibly instead of reporting work it did not do:
//   - @poc/credit-wallet: debit is the D1-backed deduction against the run's verified workspace; credit fails NOT_CONFIGURED.
//   - @poc/core-nodes: always included by buildExecutorsFromCatalog.
// Left out on purpose (their package executors report success without doing anything, which story 0.9 forbids by default):
// @poc/in-app-notifications (send), @poc/scripting-sandbox (run_script), @poc/dynamic-entities (create_record).
// @poc/omnichannel-outbound's send fails NOT_CONFIGURED either way. Trigger nodes have the runtime's own defaults.

export const DEPLOY_PACKAGE_EXPORTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "@poc/credit-wallet": creditWallet as unknown as Readonly<Record<string, unknown>>,
};

export interface DeployBricks {
  registry: Registry;
  executors: Executors;
}

export interface DeployBricksOptions {
  /** The deploy environment switch (PX_ENVIRONMENT). "production" refuses placeholder executors at load. */
  environment?: string;
  /**
   * Test fixtures only (for example the H10/H11 proof bricks): extra manifests and executors added on top of the catalog's.
   * The shipped bundle never passes this.
   */
  fixtures?: { manifests: readonly BrickManifest[]; executors: ReadonlyMap<string, Executor> };
}

export function createDeployBricks(options: DeployBricksOptions = {}): DeployBricks {
  const base = buildRegistryFromCatalog(catalog);
  const real = buildExecutorsFromCatalog(catalog, DEPLOY_PACKAGE_EXPORTS, options.environment !== undefined ? { environment: options.environment } : {});
  if (!options.fixtures) return { registry: base, executors: real };
  return {
    registry: createRegistry([...base.values(), ...options.fixtures.manifests.filter((m) => !base.has(m.type))]),
    executors: new Map<string, Executor>([...real, ...[...options.fixtures.executors].filter(([type]) => !real.has(type))]),
  };
}
