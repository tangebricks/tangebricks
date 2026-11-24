# @poc/core-nodes

First-party workflow trigger, logic, data transform, batch, and HTTP nodes for ProjectX workflows.

## Overview

The core nodes pack provides 19 first-party nodes:
1. `core.webhook` — Inbound HTTP webhook trigger.
2. `core.schedule` — Scheduled recurring cron trigger.
3. `core.brick_event` — Intra-project brick event trigger.
4. `core.if` — Conditional branching (`true` / `false` branches).
5. `core.switch` — Multi-branch matching based on expression/field value.
6. `core.loop` — Array iteration bounded by `maxIterations`.
7. `core.map` — Array field transformation.
8. `core.merge` — Combines inputs with conflict resolution strategy.
9. `core.delay` — Pauses workflow step execution by `delayMs`.
10. `core.filter` — Filters array items matching criteria.
11. `core.noop` — Identity node for passthrough wiring.
12. `core.field_map` — Transforms input payload structure to output schema.
13. `core.rename_keys` — Key alias renaming.
14. `core.format_template` — Mustache-style string templating `{{key}}`.
15. `core.json_transform` — Deep path extraction and payload wrapping.
16. `core.math` — Basic arithmetic operations (`add`, `sub`, `mul`, `div`, `round`).
17. `core.date_time` — ISO timestamp parsing and duration shifting.
18. `core.http_request` — Outbound HTTP fetch with timeout and header options.
19. `core.batch` (UC7.5) — Queue-backed batch and chunk primitive for rate-safe bulk execution.

---

## Core Batch Node (`core.batch`)

### Problem & Purpose
Workflows executing bulk operations (e.g. sending emails or messages to 10,000 recipients) exceed Cloudflare Workers per-invocation subrequest limits (50 on Free, 1000 on Paid) if executed directly in a single step. The graph budget checker (UC7.4) rejects graphs with excessive subrequests.

`core.batch` provides a queue-backed chunking primitive:
- Splits items into chunks based on platform limits:
  $$\text{autoChunkSize} = \left\lfloor \frac{\text{subrequestsLimit} \times 0.8}{\text{retries} + 1} \right\rfloor$$
  (e.g., Free tier: $\lfloor 50 \times 0.8 / 1 \rfloor = 40$ items/chunk).
- Writes jobs with `task_type: "batch-chunk"` into `job_queues` via scoped D1 operations (`scoped(db, workspaceId)`).
- Enqueues jobs to Cloudflare Queues (`QUEUE` or `JOB_QUEUE`).
- Queue consumers process chunks using per-item idempotency keys:
  $$\text{Idempotency-Key} = \langle\text{runId}\rangle:\langle\text{nodeId}\rangle:\langle\text{chunk}\rangle:\langle\text{itemIndex}\rangle$$
- Guarantees exact-once per-item processing even across redelivered queue messages.
- Isolates poison pill failures: a failing item dead-letters alone in `job_batch_items` while valid chunk siblings succeed.
- Emits aggregate workflow completion event `batch:<runId>:<nodeId>` containing:
  `{ total, succeeded, failed, deadLettered, chunkSize, chunkCount }`.

### Manifest Specification
```json
{
  "type": "core.batch",
  "label": "Batch Send",
  "summary": "Queue-backed batch and chunk primitive for rate-safe bulk execution.",
  "role": "action",
  "inputs": [{ "id": "in", "label": "Input", "dataType": "any" }],
  "outputs": [{ "id": "out", "label": "Result", "dataType": "object" }],
  "config": {
    "chunkSize": {
      "type": "enum",
      "values": ["auto", "10", "20", "25", "40", "50", "100"],
      "default": "auto"
    },
    "maxItems": {
      "type": "integer",
      "min": 1,
      "max": 100000,
      "default": 100000
    }
  },
  "executor": "executeBatchNode",
  "durable": true,
  "sideEffects": "write",
  "bindings": ["DB", "QUEUE", "JOB_QUEUE"]
}
```

### Example Graph: `out/bulk-send`
```json
{
  "nodes": [
    {
      "id": "trigger",
      "type": "core.webhook",
      "data": { "method": "post" }
    },
    {
      "id": "bulk-send",
      "type": "core.batch",
      "data": {
        "items": 2500,
        "chunkSize": "auto",
        "targetOperation": "integration.send",
        "plan": "free"
      }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "trigger",
      "target": "bulk-send",
      "sourceHandle": "out",
      "targetHandle": "in"
    }
  ]
}
```
