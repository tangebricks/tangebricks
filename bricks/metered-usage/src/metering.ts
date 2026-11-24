import { scoped, type D1Like } from "@poc/sdk";

export type MeterAggregation = "sum" | "count" | "max" | "last";

export interface MeterDefinition {
  key: string;
  name: string;
  aggregation: MeterAggregation;
  created_at: string;
}

export interface MeterEventInput {
  workspaceId: string;
  meterKey: string;
  value?: number;
  idempotencyKey?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface MeterUsageAggregate {
  workspace_id: string;
  meter_key: string;
  window_period: string;
  total_value: number;
  event_count: number;
  updated_at: string;
}

export function getCurrentWindow(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export class MeteringService {
  constructor(private readonly db: D1Like) {}

  /**
   * Registers a meter definition (e.g., api_calls, compute_ms, storage_gb).
   */
  async defineMeter(
    keyRaw: string,
    nameRaw: string,
    aggregation: MeterAggregation = "sum"
  ): Promise<MeterDefinition> {
    const key = keyRaw.trim().toLowerCase();
    const name = nameRaw.trim();
    const now = new Date().toISOString();

    await this.db.prepare(`
      INSERT INTO meter_definitions (key, name, aggregation, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        name = excluded.name,
        aggregation = excluded.aggregation
    `).bind(key, name, aggregation, now).run();

    return {
      key,
      name,
      aggregation,
      created_at: now,
    };
  }

  /**
   * Retrieves a meter definition.
   */
  async getMeter(key: string): Promise<MeterDefinition | null> {
    return await this.db.prepare(
      "SELECT key, name, aggregation, created_at FROM meter_definitions WHERE key = ?"
    ).bind(key.trim().toLowerCase()).first<MeterDefinition>();
  }

  /**
   * Lists all defined meters.
   */
  async listMeters(): Promise<MeterDefinition[]> {
    const res = await this.db.prepare(
      "SELECT key, name, aggregation, created_at FROM meter_definitions ORDER BY key ASC"
    ).all<MeterDefinition>();
    return res.results;
  }

  /**
   * Ingests a single usage event with idempotency protection and atomic aggregation.
   */
  async ingestEvent(
    event: MeterEventInput
  ): Promise<{ ok: boolean; duplicate?: boolean; eventId?: string; error?: string }> {
    const meter = await this.getMeter(event.meterKey);
    if (!meter) {
      return { ok: false, error: `Meter '${event.meterKey}' is not defined` };
    }

    const eventId = `evt_${crypto.randomUUID().replace(/-/g, "")}`;
    const value = event.value !== undefined ? Number(event.value) : 1.0;
    const timestamp = event.timestamp || new Date().toISOString();
    const windowPeriod = getCurrentWindow(new Date(timestamp));
    const metadataJson = event.metadata ? JSON.stringify(event.metadata) : null;

    // Check idempotency if key provided. Keys belong to a workspace (migration 0002, AD-V2): the same key sent by
    // another workspace is a different event, so the lookup is always by (workspace_id, idempotency_key).
    const findByKey = async (key: string) =>
      scoped(this.db, event.workspaceId).first<{ id: string }>("meter_events", "idempotency_key = ?", [key]);
    if (event.idempotencyKey) {
      const existing = await findByKey(event.idempotencyKey);
      if (existing) {
        return { ok: true, duplicate: true, eventId: existing.id };
      }
    }

    // Insert event
    try {
      await scoped(this.db, event.workspaceId).insert("meter_events", {
        id: eventId,
        meter_key: meter.key,
        value,
        idempotency_key: event.idempotencyKey || null,
        timestamp,
        metadata_json: metadataJson,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // A concurrent insert of the same key in the same workspace won the race: answer with that event.
      if (event.idempotencyKey && /UNIQUE constraint failed: meter_events\.workspace_id, meter_events\.idempotency_key/.test(msg)) {
        const existing = await findByKey(event.idempotencyKey);
        return { ok: true, duplicate: true, ...(existing ? { eventId: existing.id } : {}) };
      }
      return { ok: false, error: msg };
    }

    // Update aggregate atomically depending on aggregation strategy
    const now = new Date().toISOString();

    const existingAgg = await scoped(this.db, event.workspaceId).first<MeterUsageAggregate>(
      "meter_aggregates",
      "meter_key = ? AND window_period = ?",
      [meter.key, windowPeriod]
    );

    if (existingAgg) {
      let newValue = value;
      if (meter.aggregation === "sum") {
        newValue = existingAgg.total_value + value;
      } else if (meter.aggregation === "count") {
        newValue = existingAgg.total_value + 1.0;
      } else if (meter.aggregation === "max") {
        newValue = Math.max(existingAgg.total_value, value);
      } else if (meter.aggregation === "last") {
        newValue = value;
      }
      await scoped(this.db, event.workspaceId).update(
        "meter_aggregates",
        {
          total_value: newValue,
          event_count: existingAgg.event_count + 1,
          updated_at: now,
        },
        "meter_key = ? AND window_period = ?",
        [meter.key, windowPeriod]
      );
    } else {
      const initialValue = meter.aggregation === "count" ? 1.0 : value;
      await scoped(this.db, event.workspaceId).insert("meter_aggregates", {
        meter_key: meter.key,
        window_period: windowPeriod,
        total_value: initialValue,
        event_count: 1,
        updated_at: now,
      });
    }

    return { ok: true, duplicate: false, eventId };
  }

  /**
   * Retrieves usage aggregate for a specific workspace and meter in a window.
   */
  async getUsage(
    workspaceId: string,
    meterKeyRaw: string,
    windowPeriod: string = getCurrentWindow()
  ): Promise<MeterUsageAggregate> {
    const meterKey = meterKeyRaw.trim().toLowerCase();
    const row = await scoped(this.db, workspaceId).first<MeterUsageAggregate>(
      "meter_aggregates",
      "meter_key = ? AND window_period = ?",
      [meterKey, windowPeriod]
    );

    if (row) return row;

    return {
      workspace_id: workspaceId,
      meter_key: meterKey,
      window_period: windowPeriod,
      total_value: 0,
      event_count: 0,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Lists usage aggregates across all meters for a workspace in a window.
   */
  async getUsageSummary(
    workspaceId: string,
    windowPeriod: string = getCurrentWindow()
  ): Promise<MeterUsageAggregate[]> {
    return scoped(this.db, workspaceId).select<MeterUsageAggregate>(
      "meter_aggregates",
      "window_period = ?",
      [windowPeriod],
      { orderBy: "meter_key ASC" }
    );
  }
}
