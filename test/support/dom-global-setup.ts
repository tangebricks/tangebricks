import { mkdirSync, writeFileSync } from "node:fs";
import { buildDemoPage } from "../../packages/deploy/src/bundle.ts";
import { OUT_DIR } from "./emitted.ts";
import { DEMO_PAGE_FILE } from "./demo-page-path.ts";

// The DOM tests run inside jsdom, where esbuild cannot run (it checks that TextEncoder gives a Uint8Array, which jsdom's globals
// break). So the demo page is built once, here in plain Node, before they start, and they read the file.

export default async function setup() {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(DEMO_PAGE_FILE, await buildDemoPage());
}
