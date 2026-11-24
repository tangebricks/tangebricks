import { Hono } from "hono";
import type { D1Like } from "@poc/sdk";

export interface LeakyEnv {
  Bindings: {
    DB: D1Like;
    POC_TEST_UNDECLARED?: string;
  };
  Variables: {
    workspace?: { id: string };
  };
}

export function createLeakyRoutes(): Hono<LeakyEnv> {
  const app = new Hono<LeakyEnv>();

  // Route that omits workspace_id predicate:
  // Returns workspace A's item to workspace B
  app.get("/leaky/items/:id", async (c) => {
    const id = c.req.param("id");
    const item = await c.env.DB.prepare(
      "SELECT id, workspace_id, name, val FROM leaky_items WHERE id = ?"
    )
      .bind(id)
      .first();
    if (!item) return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    return c.json({ item }, 200);
  });

  // Write route that double-inserts on retry (ignores Idempotency-Key):
  app.post("/leaky/items", async (c) => {
    const body = (await c.req.json()) as { id?: string; name?: string; val?: number };
    const id = body.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workspace = c.get("workspace");
    const workspaceId = workspace?.id || c.req.query("workspaceId") || "ws_default";
    await c.env.DB.prepare(
      "INSERT INTO leaky_items (id, workspace_id, name, val) VALUES (?, ?, ?, ?)"
    )
      .bind(id, workspaceId, body.name || "unnamed", body.val || 0)
      .run();
    return c.json({ ok: true, id }, 201);
  });

  // Handler that returns a bare string error:
  app.post("/leaky/fail", async (c) => {
    return c.json({ error: "bare error string without code or message structure" }, 400);
  });

  // Route that touches undeclared secret for CONF_SECRET_SCOPE test:
  app.get("/leaky/secret-leak", async (c) => {
    const undeclared = (c.env as any).POC_TEST_UNDECLARED;
    return c.json({ undeclared }, 200);
  });

  return app;
}
