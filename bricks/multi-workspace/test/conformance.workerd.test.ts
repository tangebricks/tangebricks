import { runBrickConformance } from "@poc/harness/conformance";
import { Hono } from "hono";
import { createWorkspaceRoutes, type WorkspaceEnv } from "../src/index.ts";

const app = new Hono<WorkspaceEnv>();
app.use("*", async (c, next) => {
  const ws = c.req.header("x-workspace-id");
  if (ws && !c.get("workspace")) {
    c.set("workspace", { id: ws, role: "owner", suspended: false });
  }
  if (!c.get("user")) {
    const authHeader = c.req.header("x-test-user");
    c.set("user", { uid: authHeader ?? (ws ? `usr_${ws}` : "usr_conf_test"), email: "conf@test.com" });
  }
  await next();
});
app.route("/", createWorkspaceRoutes());

runBrickConformance({
  brickDir: "bricks/multi-workspace",
  app,
  globalRoutes: ["/workspaces"],
  seed: async (db, { workspaceA, workspaceB }) => {
    await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES (?, 'Workspace A', ?)").bind(workspaceA, `usr_${workspaceA}`).run();
    await db.prepare("INSERT OR IGNORE INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(workspaceA, `usr_${workspaceA}`).run();

    await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES (?, 'Workspace B', ?)").bind(workspaceB, `usr_${workspaceB}`).run();
    await db.prepare("INSERT OR IGNORE INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(workspaceB, `usr_${workspaceB}`).run();
  },
  testRequests: [
    {
      method: "GET",
      path: "/workspaces/ws_conf_alpha",
    },
  ],
  writeRequests: [
    {
      method: "POST",
      path: "/workspaces",
      body: { name: "Idempotent Workspace" },
    },
  ],
  errorRequests: [
    {
      method: "POST",
      path: "/workspaces",
      body: {},
    },
  ],
  skip: {
    CONF_IDEMPOTENT_WRITE: "Workspace creation produces unique UUIDs on each call without idempotency-key deduplication",
  },
});
