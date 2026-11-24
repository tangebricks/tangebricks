import { join } from "node:path";
import { OUT_DIR } from "./emitted.ts";

/** Where the DOM tests' global setup writes the built demo page. A separate module so a test can import the path without importing esbuild. */
export const DEMO_PAGE_FILE = join(OUT_DIR, "demo-page.html");
