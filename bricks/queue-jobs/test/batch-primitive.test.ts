import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration0001 from "../migrations/0001_queue_jobs.sql?raw";
import migration0002 from "../migrations/0002_batch_items.sql?raw";
import { JobQueueService, consumeJobQueueBatch } from "../src/index.ts";
import { runGraph } from "@poc/runtime";
import { coreNodeExecutors, coreNodeRegistry } from "../../../packages/core-nodes/src/index.ts";
import { checkGraphBudget, createRegistry, toyRegistry } from "@poc/sdk";
import type { GraphNode, GraphEdge } from "@poc/sdk";

const db = env.DB as D1Like;
const WS_TEST = "ws_batch_test";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS job_batch_items").run();
  await db.prepare("DROP TABLE IF EXISTS job_queues").run();
  await applyMigration(db, migration0001);
  await applyMigration(db, migration0002);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("UC7.5 — Queue-backed batch/chunk primitive for bulk sends", () => {
  it("AC1 & Task 1: 2,500 items with auto chunkSize (<= 40 on free) and 10% queue redelivery process exactly once with 2,500 distinct idempotency keys", async () => {
    const outboundCalls: Array<{ key: string; item: unknown }> = [];
    const enqueuedMessages: Array<{ jobId: string }> = [];

    const fakeQueue = {
      async send(msg: { jobId: string }) {
        enqueuedMessages.push(msg);
      },
      async sendBatch(msgs: Array<{ body: { jobId: string } }>) {
        for (const m of msgs) {
          enqueuedMessages.push(m.body);
        }
      },
    };

    const graph = {
      nodes: [
        { id: "trig", type: "core.webhook", data: { method: "post" } },
        {
          id: "bulk_send",
          type: "core.batch",
          data: {
            items: 2500,
            chunkSize: "auto",
            target: "integration.send",
            plan: "free",
            workspaceId: WS_TEST,
          },
        },
      ],
      edges: [
        { id: "e1", source: "trig", target: "bulk_send", sourceHandle: "out", targetHandle: "in" },
      ],
    };

    // 1. Run the graph with core.batch
    const runResult = await runGraph(graph, coreNodeRegistry, coreNodeExecutors, {
      payload: {},
      runId: "run_bulk_123",
      env: {
        DB: db,
        QUEUE: fakeQueue,
        JOB_QUEUE: fakeQueue,
        workspaceId: WS_TEST,
      },
    });

    expect(runResult.ok).toBe(true);

    // Verify chunk sizes in job_queues are <= 40 (subrequest budget 50 * 0.8)
    const service = new JobQueueService(db);
    const jobs = await service.list(WS_TEST, { limit: 100 });
    expect(jobs.length).toBe(Math.ceil(2500 / 40)); // 63 chunks
    for (const job of jobs) {
      expect(job.task_type).toBe("batch-chunk");
      const items = (job.payload as { items: unknown[] }).items;
      expect(items.length).toBeLessThanOrEqual(40);
    }

    // 2. Simulate Queue delivery with 10% redelivered messages
    const messagesToDeliver: Array<{ id: string; body: { jobId: string } }> = [];
    let msgIdCounter = 1;
    for (let i = 0; i < enqueuedMessages.length; i++) {
      const msg = enqueuedMessages[i]!;
      messagesToDeliver.push({ id: `msg_${msgIdCounter++}`, body: msg });
      // Redeliver every 10th message (10% duplicate delivery)
      if (i % 10 === 0) {
        messagesToDeliver.push({ id: `msg_${msgIdCounter++}_redelivery`, body: msg });
      }
    }

    // Consumer processes messages with callOperation mock
    const consumerResult = await consumeJobQueueBatch(
      {
        queue: "batch",
        messages: messagesToDeliver.map((m) => ({
          id: m.id,
          body: m.body,
          ack: () => {},
          retry: () => {},
        })),
      },
      {
        DB: db,
        callOperation: async (manifest: unknown, opId: string, args: unknown, opts: { idempotencyKey?: string }) => {
          outboundCalls.push({ key: opts.idempotencyKey!, item: args });
          return { ok: true, status: 200, data: { sent: true } };
        },
      },
    );

    expect(consumerResult.completed.length).toBe(jobs.length);

    // AC1: exactly 2,500 outbound calls with distinct idempotency keys
    expect(outboundCalls).toHaveLength(2500);
    const keys = new Set(outboundCalls.map((c) => c.key));
    expect(keys.size).toBe(2500);

    // Verify idempotency key format: <runId>:<nodeId>:<chunk>:<item>
    for (const call of outboundCalls) {
      expect(call.key).toMatch(/^run_bulk_123:bulk_send:\d+:\d+$/);
    }

    // Verify exactly 2,500 rows in job_batch_items
    const countRow = await db.prepare("SELECT COUNT(*) as count FROM job_batch_items WHERE workspace_id = ?").bind(WS_TEST).first<{ count: number }>();
    expect(countRow?.count).toBe(2500);

    // Verify aggregate result returned to graph
    const batchOutput = runResult.outputs["bulk_send"] as {
      out?: { total: number; succeeded: number; failed: number; deadLettered: number; chunkSize: number };
      total?: number;
      succeeded?: number;
    };
    const agg = batchOutput.out ?? batchOutput;
    expect(agg.total).toBe(2500);
    expect(agg.succeeded).toBe(2500);
    expect(agg.failed).toBe(0);
    expect(agg.deadLettered).toBe(0);
  });

  it("AC2: a poisoned item dead-letters alone while the other items in its chunk succeed", async () => {
    const service = new JobQueueService(db);
    const chunkItems = [
      { id: 1, email: "user1@example.com" },
      { id: 2, email: "poison@example.com", shouldFail: true },
      { id: 3, email: "user3@example.com" },
    ];

    const job = await service.enqueue({
      workspaceId: WS_TEST,
      queueName: "batch",
      taskType: "batch-chunk",
      payload: {
        runId: "run_poison_test",
        nodeId: "batch_1",
        chunk: 0,
        totalChunks: 1,
        totalItems: 3,
        items: chunkItems,
        targetOperation: "integration.send",
      },
    });

    const consumerResult = await consumeJobQueueBatch(
      {
        queue: "batch",
        messages: [{
          id: "msg_poison",
          body: { jobId: job.id },
          ack: () => {},
          retry: () => {},
        }],
      },
      {
        DB: db,
        callOperation: async (_m: unknown, _op: string, args: any) => {
          if (args?.shouldFail) {
            throw new Error("POISON_PILL");
          }
          return { ok: true, status: 200, data: { sent: true } };
        },
      },
    );

    expect(consumerResult.completed).toContain(job.id);

    // Verify item statuses in job_batch_items
    const itemRows = await db.prepare("SELECT item_index, status, error_message FROM job_batch_items WHERE job_id = ? ORDER BY item_index ASC").bind(job.id).all<{ item_index: number; status: string; error_message: string | null }>();
    expect(itemRows.results).toHaveLength(3);
    expect(itemRows.results[0]!.status).toBe("succeeded");
    expect(itemRows.results[1]!.status).toBe("dead_letter");
    expect(itemRows.results[1]!.error_message).toContain("POISON_PILL");
    expect(itemRows.results[2]!.status).toBe("succeeded");
  });

  it("AC3: the graph that UC7.4 refused for subrequests passes once bulk node is replaced by core.batch", () => {
    const nodesRefused: GraphNode[] = [
      { id: "trig", type: "trigger.manual", data: {} },
      {
        id: "bulk_search",
        type: "integration.search",
        data: {
          pagination: { maxPages: 60 },
          maxOutputBytes: 10000,
        },
      },
    ];
    const edgesRefused: GraphEdge[] = [
      { id: "e1", source: "trig", target: "bulk_search", sourceHandle: "out", targetHandle: "in" },
    ];

    const refusedIssues = checkGraphBudget({ nodes: nodesRefused, edges: edgesRefused }, coreNodeRegistry, "free");
    expect(refusedIssues.some((i) => i.code === "BUDGET_SUBREQUESTS_EXCEEDED")).toBe(true);

    // Replace the bulk node with core.batch
    const nodesPassing: GraphNode[] = [
      { id: "trig", type: "trigger.manual", data: {} },
      {
        id: "bulk_send",
        type: "core.batch",
        data: {
          items: 2500,
          chunkSize: "auto",
          target: "integration.send",
        },
      },
    ];
    const edgesPassing: GraphEdge[] = [
      { id: "e1", source: "trig", target: "bulk_send", sourceHandle: "out", targetHandle: "in" },
    ];

    const passingIssues = checkGraphBudget({ nodes: nodesPassing, edges: edgesPassing }, coreNodeRegistry, "free");
    expect(passingIssues.filter((i) => i.code === "BUDGET_SUBREQUESTS_EXCEEDED")).toHaveLength(0);
  });
});
