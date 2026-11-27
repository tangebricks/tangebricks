import { runBrickConformance } from "@poc/harness/conformance";
import { Hono } from "hono";
import { entityDdl, parseEntities } from "@poc/sdk";
import { createEntityRoutes, type EntityEnv } from "../src/index.ts";

const declarations = [
  {
    name: "items",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "price", type: "number" },
    ],
  },
];

const parsed = parseEntities(declarations);
if (!parsed.ok) throw new Error("Failed to parse entities");
const firstEntity = parsed.entities[0]!;
const ddl = entityDdl(firstEntity);

const app = new Hono<EntityEnv>();
app.use("*", async (c, next) => {
  const ws = c.req.header("x-workspace-id");
  if (ws && !c.get("workspace")) {
    c.set("workspace", { id: ws, role: "owner", suspended: false });
  }
  if (!c.get("user")) {
    c.set("user", { uid: "usr_conf_test" });
  }
  await next();
});
app.route("/", createEntityRoutes({ entities: declarations }));

runBrickConformance({
  brickDir: "bricks/dynamic-entities",
  app,
  migrations: {
    "0001_items.sql": ddl,
  },
  seed: async (db, { workspaceA, workspaceB }) => {
    await db
      .prepare(`INSERT OR IGNORE INTO ent_items ("id", "workspace_id", "title", "price") VALUES (?, ?, ?, ?)`)
      .bind("11111111-1111-4111-8111-111111111111", workspaceA, "Item Alpha", 100)
      .run();

    await db
      .prepare(`INSERT OR IGNORE INTO ent_items ("id", "workspace_id", "title", "price") VALUES (?, ?, ?, ?)`)
      .bind("22222222-2222-4222-8222-222222222222", workspaceB, "Item Beta", 200)
      .run();
  },
  testRequests: [
    {
      method: "GET",
      path: "/items/11111111-1111-4111-8111-111111111111",
    },
    {
      method: "PATCH",
      path: "/items/11111111-1111-4111-8111-111111111111",
      body: { title: "Updated Item Alpha" },
    },
    {
      method: "DELETE",
      path: "/items/11111111-1111-4111-8111-111111111111",
    },
  ],
  writeRequests: [
    {
      method: "POST",
      path: "/items",
      body: { title: "Idempotent Item", price: 50 },
    },
  ],
  errorRequests: [
    {
      method: "POST",
      path: "/items",
      body: { price: "invalid-number" },
    },
  ],
  skip: {
    CONF_IDEMPOTENT_WRITE: "Dynamic entity creation generates a new UUID for each inserted record without deduplication",
  },
});
