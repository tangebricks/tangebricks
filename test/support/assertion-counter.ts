import { afterEach, expect } from "vitest";

afterEach((ctx) => {
  try {
    const count = typeof expect?.getState === "function" ? (expect.getState().assertionCalls ?? 0) : 0;
    if (ctx.task) {
      const meta = ctx.task.meta as Record<string, unknown>;
      meta.assertionCount = count;
    }
  } catch {
    // ignore if expect state is unavailable
  }
});
