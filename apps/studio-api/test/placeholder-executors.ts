import { catalog } from "@poc/assembler/catalog";
import { PLACEHOLDER_BRICK_EXECUTOR_MODULES, buildExecutorsFromCatalog } from "@poc/runtime";
import { createStudioApiApp } from "../src/index.ts";

/**
 * Story 0.9 (R-B): studio-api no longer wires placeholder brick executors by
 * default. Tests that exercise brick action nodes without a real backend inject
 * the test-only placeholders explicitly through this app.
 */
export const placeholderExecutors = buildExecutorsFromCatalog(catalog, PLACEHOLDER_BRICK_EXECUTOR_MODULES);

export const appWithPlaceholderExecutors = createStudioApiApp({ executors: placeholderExecutors });
