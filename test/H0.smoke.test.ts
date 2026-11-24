import { expect, test } from "vitest";
import { record } from "@poc/harness";

// Proves the suite really runs inside workerd and not in Node, and that a report
// made in workerd reaches the Node-side reporter through task.meta.
test("tests run inside the workerd runtime", ({ task }) => {
  const runsInWorkerd = navigator.userAgent === "Cloudflare-Workers";
  record(task, { id: "H0", checks: { runsInWorkerd } });
  expect(runsInWorkerd).toBe(true);
});
