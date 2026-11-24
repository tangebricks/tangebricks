import { Hono } from "hono";
import { runBrickConformance } from "@poc/harness/conformance";
import { createAuditRoutes } from "../src/index.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

// The routes read the workspace from the verified context only, so the kit's x-workspace-id header goes through the
// stand-in for workspaceMiddleware first.
const app = new Hono();
app.use("*", stubWorkspaceContext);
app.route("/", createAuditRoutes());

runBrickConformance({
  brickDir: "bricks/audit-trail",
  routes: createAuditRoutes(),
  app,
  skip: {
    CONF_IDEMPOTENT_WRITE: "Audit trail is an append-only log without idempotency-key deduplication",
  },
});
