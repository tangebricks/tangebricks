# Retired hypotheses

A retired hypothesis is removed from `hypotheses.json`, the verdict logic and the generated proof documents. Its code and
evidence stay in git history. This file records what each one measured last, why it was retired and how to restore it.

## H4: Dafthunk Bridge ("unmodified dafthunk nodes run behind a small adapter")

- **Final measured result:** pass, `290 nodes` runnable of 486 concrete nodes (rule: pass at least 250, kill at most 99). Recorded in
  `evidence/verdicts.json` at 2026-11-05T18:37:02Z, commit `b1cc860` (`inputsHash` eaa8413f5868...). Only three nodes were ever
  executed (a multiplication, a JSONPath extract and a WebAssembly image decode); the other 287 were shown to load, not to be correct.
- **Retired:** 2026-11-06, by the owner's decision, as a one-off cleanup (not a plan story). Merge message: "Retire the vendored
  Dafthunk bridge and hypothesis H4 (restore from tag dafthunk-bridge-final)".
- **Reason:** no product code uses the bridge. No app, brick or package imports `@poc/dafthunk`, `scripts/build-catalog.ts` excluded the
  adapter by default, and the catalog's only node pack is `core-nodes`. Keeping it cost a 666-file vendored tree, special test
  configuration (wasm and Node-API workarounds) and a hypothesis that no longer guards anything we ship.
- **Restore tag:** `dafthunk-bridge-final` (the last commit with the bridge intact, `d74ac2a`). The tag is local; push it before
  relying on it from another clone.
- **What was removed:** `vendor/dafthunk`, `packages/dafthunk` (adapter, census, H4 tests), `shim/dafthunk-runtime.ts`,
  `scripts/{vendor-sync,vendor-check,read-dafthunk-lock,run-census,run-load,survey-imports,survey-runnable,mutate-h4,make-test-png}.ts`,
  the evidence files `evidence/census.json` and `evidence/load-results.json` (only the H4 census test produced them), the
  `@dafthunk/*` aliases and the wasm plugin in `vitest.workers.config.ts`, the `@poc/dafthunk` dependency and the `vendor:*`, `poc:load`,
  `poc:census` and `poc:h4` scripts.
- **Not removed at the time:** the third-party devDependencies that only the vendored nodes used (`@cf-wasm/*`, `@gltf-transform/core`,
  `@mapbox/martini`, `d3-*`, `geotiff`, `exifreader` and similar) and the Dafthunk entries in `scripts/build-ua-graph.ts`. Story 1.31
  (`pnpm lint:unused`) removed those devDependencies, together with the other root devDependencies nothing imported. The
  entries in `scripts/build-ua-graph.ts` remain.
- **Licence:** Dafthunk's licence (MIT-style, `vendor/dafthunk/LICENSE`) imposes no obligation once the code is removed. The vendored code and its
  licence stay at that tag in the private pre-public history; they are not in this repository.
- **To bring it back:** restore it from the `dafthunk-bridge-final` tag of the private pre-public history.
  (then re-apply the edits to `hypotheses.json`, `scripts/verify.ts`, `scripts/poc-verdict.ts`, `scripts/proof-inputs.ts`,
  `vitest.workers.config.ts`, `package.json` and `.gitattributes` from the same tag), run `pnpm install` and `pnpm evidence:refresh`.
