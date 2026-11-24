import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_tabular_engine.sql?raw";
import {
  TabularService,
  parseCsv,
  createTabularRoutes,
} from "../src/index.ts";
import type { TabularEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_tabular_alpha";
const WS_BETA = "ws_tabular_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS tab_grid_views").run();
  await db.prepare("DROP TABLE IF EXISTS tab_import_jobs").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Tabular Engine RFC 4180 CSV Parser", () => {
  it("parses clean and complex quoted CSV data with escaped quotes", () => {
    const raw = `name,company,quote,active,count\r\n"Smith, John","Acme, Inc.","He said ""Hello""",true,42\n"Bob",Solo,"Simple",false,10`;
    const rows = parseCsv(raw);

    expect(rows).toHaveLength(3); // header + 2 rows
    expect(rows[0]).toEqual(["name", "company", "quote", "active", "count"]);
    expect(rows[1]).toEqual(["Smith, John", "Acme, Inc.", 'He said "Hello"', "true", "42"]);
    expect(rows[2]).toEqual(["Bob", "Solo", "Simple", "false", "10"]);
  });
});

describe("Tabular Service Core Logic", () => {
  it("infers schema and preview rows from CSV text", () => {
    const service = new TabularService(db);
    const csv = `Email,First Name,Salary\nalice@example.com,Alice,95000\nbob@example.com,Bob,80000`;
    const res = service.inferSchema(csv);

    expect(res.headers).toEqual(["Email", "First Name", "Salary"]);
    expect(res.previewRows).toHaveLength(2);
    expect(res.previewRows[0]["Email"]).toBe("alice@example.com");
    expect(res.previewRows[0]["Salary"]).toBe("95000");
  });

  it("executes import with type coercion and collects row-level errors", async () => {
    const service = new TabularService(db);
    const job = await service.createImportJob(WS_ALPHA, "contacts", "customers.csv");
    expect(job.status).toBe("pending");

    const csvData = [
      "Full Name,Age,Is Active,Created Date",
      "Alice Smith,30,true,2026-01-15T00:00:00Z",
      ",25,yes,2026-02-01", // Missing required name
      "Charlie,invalid_age,no,bad_date", // Invalid number and invalid date
    ].join("\n");

    const result = await service.executeImport(WS_ALPHA, job.id, csvData, [
      { csvColumn: "Full Name", targetField: "name", type: "string", required: true },
      { csvColumn: "Age", targetField: "age", type: "number" },
      { csvColumn: "Is Active", targetField: "active", type: "boolean" },
      { csvColumn: "Created Date", targetField: "created_at", type: "date" },
    ]);

    expect(result.ok).toBe(true); // at least 1 valid row imported
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toEqual({
      name: "Alice Smith",
      age: 30,
      active: true,
      created_at: "2026-01-15T00:00:00.000Z",
    });

    // Verify errors collected
    expect(result.errors.length).toBeGreaterThan(0);
    const missingNameErr = result.errors.find((e) => e.column === "Full Name");
    expect(missingNameErr?.message).toContain("Required field 'name' is empty");

    const invalidAgeErr = result.errors.find((e) => e.column === "Age");
    expect(invalidAgeErr?.message).toContain("not a valid number");

    // Check saved job state
    const savedJob = await service.getImportJob(WS_ALPHA, job.id);
    expect(savedJob?.status).toBe("completed");
    expect(savedJob?.processed_rows).toBe(1);
    expect(savedJob?.error_count).toBe(result.errors.length);
  });

  it("creates and retrieves interactive grid views isolated per workspace", async () => {
    const service = new TabularService(db);

    const viewAlpha = await service.createGridView(
      WS_ALPHA,
      "deals",
      "High Value Pipeline",
      [
        { key: "deal_name", label: "Deal Name", width: 200, visible: true },
        { key: "amount", label: "Amount ($)", width: 120, visible: true },
      ],
      [{ field: "amount", operator: ">", value: 10000 }],
      [{ field: "amount", direction: "desc" }]
    );

    const viewBeta = await service.createGridView(
      WS_BETA,
      "deals",
      "Beta Pipeline",
      [{ key: "deal_name", label: "Deal" }]
    );

    const alphaViews = await service.listGridViews(WS_ALPHA, "deals");
    const betaViews = await service.listGridViews(WS_BETA, "deals");

    expect(alphaViews).toHaveLength(1);
    expect(betaViews).toHaveLength(1);
    expect(alphaViews[0].name).toBe("High Value Pipeline");
    expect(alphaViews[0].columns[0].key).toBe("deal_name");
  });
});

describe("Tabular HTTP API", () => {
  it("provides full HTTP workflow for inference, import, and grid views", async () => {
    const app = new Hono<TabularEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createTabularRoutes());

    // 1. POST /tabular/infer
    const inferRes = await app.request("/api/tabular/infer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csvText: "id,title\n1,Alpha\n2,Beta" }),
    }, { DB: db });
    expect(inferRes.status).toBe(200);
    const inferJson = (await inferRes.json()) as { headers: string[] };
    expect(inferJson.headers).toEqual(["id", "title"]);

    // 2. POST /tabular/imports
    const jobRes = await app.request("/api/tabular/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        targetEntityType: "products",
        filename: "catalog.csv",
      }),
    }, { DB: db });
    expect(jobRes.status).toBe(201);
    const jobJson = (await jobRes.json()) as { job: { id: string } };
    const jobId = jobJson.job.id;

    // 3. POST /tabular/imports/:id/execute
    const execRes = await app.request(`/api/tabular/imports/${jobId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        csvText: "Product Name,Unit Price\nWidget A,29.99\nWidget B,49.99",
        mappings: [
          { csvColumn: "Product Name", targetField: "name", type: "string" },
          { csvColumn: "Unit Price", targetField: "price", type: "number" },
        ],
      }),
    }, { DB: db });
    expect(execRes.status).toBe(200);
    const execJson = (await execRes.json()) as { ok: boolean; records: Array<{ name: string; price: number }> };
    expect(execJson.ok).toBe(true);
    expect(execJson.records).toHaveLength(2);
    expect(execJson.records[0].price).toBe(29.99);

    // 4. POST /tabular/views
    const viewRes = await app.request("/api/tabular/views", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        entityType: "products",
        name: "Standard Catalog View",
        columns: [{ key: "name", label: "Name" }, { key: "price", label: "Price" }],
      }),
    }, { DB: db });
    expect(viewRes.status).toBe(201);

    // 5. GET /tabular/views
    const listViewsRes = await app.request("/api/tabular/views?entityType=products", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listViewsRes.status).toBe(200);
    const listViewsJson = (await listViewsRes.json()) as { views: unknown[] };
    expect(listViewsJson.views).toHaveLength(1);
  });

  // ID_READ_FOREIGN (story 0.7): another workspace's import job id is "not found"; it cannot be read or executed.
  it("answers 404 for an import job id that belongs to another workspace", async () => {
    const app = new Hono<TabularEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createTabularRoutes());

    const service = new TabularService(db);
    const betaJob = await service.createImportJob(WS_BETA, "contacts", "beta.csv");
    const asAlpha = { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA };

    expect((await app.request(`/api/tabular/imports/${betaJob.id}`, { headers: asAlpha }, { DB: db })).status).toBe(404);
    const exec = await app.request(`/api/tabular/imports/${betaJob.id}/execute`, {
      method: "POST",
      headers: asAlpha,
      body: JSON.stringify({ csvText: "Name\nMallory", mappings: [{ csvColumn: "Name", targetField: "name", type: "string" }] }),
    }, { DB: db });
    expect(exec.status).toBe(404);

    // Beta's job is untouched and still readable by Beta.
    const stillBeta = await service.getImportJob(WS_BETA, betaJob.id);
    expect(stillBeta?.status).toBe("pending");
    expect(await service.getImportJob(WS_ALPHA, betaJob.id)).toBeNull();
  });
});
