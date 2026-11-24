import { describe, it } from "vitest";
import { attach } from "../../../packages/harness/src/results.ts";

describe("clean-tree attachment test fixture", () => {
  it("attaches sample evidence payload", (ctx) => {
    attach(ctx.task, "h5-control", {
      cleanTreeFixture: true,
      timestamp: new Date().toISOString(),
    });
  });
});
