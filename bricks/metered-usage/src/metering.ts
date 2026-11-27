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

/** Story 1.9: the largest value one usage event may carry; keeps summed totals finite. */
export const MAX_METER_EVENT_VALUE = 1e12;

export function getCurrentWindow(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export class MeteringService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  /**
   * Registers a meter definition (e.g., api_calls, compute_ms, storage_gb).
   */
  async defineMeter(keyRaw: string, nameRaw: string, aggregation: MeterAggregation = "sum"): Promise<MeterDefinition> {
    const key = keyRaw.trim().toLowerCase();
    const name = nameRaw.trim();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `
      INSERT INTO meter_definitions (key, name, aggregation, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        name = excluded.name,
        aggregation = excluded.aggregation
    `,
      )
      .bind(key, name, aggregation, now)
      .run();

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
    return await this.db
      .prepare("SELECT key, name, aggregation, created_at FROM meter_definitions WHERE key = ?")
      .bind(key.trim().toLowerCase())
      .first<MeterDefinition>();
  }

  /**
   * Lists all defined meters.
   */
  async listMeters(): Promise<MeterDefinition[]> {
    const res = await this.db.prepare("SELECT key, name, aggregation, created_at FROM meter_definitions ORDER BY key ASC").all<MeterDefinition>();
    return res.results;
  }

  /**
   * Ingests a single usage event with idempotency protection and atomic aggregation.
   */
  async ingestEvent(event: MeterEventInput): Promise<{ ok: boolean; duplicate?: boolean; eventId?: string; error?: string }> {
    const meter = await this.getMeter(event.meterKey);
    if (!meter) {
      return { ok: false, error: `Meter '${event.meterKey}' is not defined` };
    }

    const eventId = `evt_${crypto.randomUUID().replace(/-/g, "")}`;
    // Story 1.9: usage only ever goes up. A null, negative, NaN, infinite or absurdly large value would lower a billed
    // total, poison it, or (summed) overflow it to Infinity, so each event is bounded.
    if (event.value === null || (event.value !== undefined && typeof event.value !== "number")) {
      return { ok: false, error: "INVALID_VALUE: usage value must be a number" };
    }
    const value = event.value !== undefined ? event.value : 1.0;
    if (!Number.isFinite(value) || value < 0 || value > MAX_METER_EVENT_VALUE) {
      return { ok: false, error: `INVALID_VALUE: usage value must be a finite number between 0 and ${MAX_METER_EVENT_VALUE}` };
    }
    const timestamp = event.timestamp || new Date().toISOString();
    const windowPeriod = getCurrentWindow(new Date(timestamp));
    const metadataJson = event.metadata ? JSON.stringify(event.metadata) : null;

    // Check idempotency if key provided. Keys belong to a workspace (migration 0002, AD-V2): the same key sent by
    // another workspace is a different event, so the lookup is always by (workspace_id, idempotency_key).
    const findByKey = async (key: string) => scoped(this.db, event.workspaceId).first<{ id: string }>("meter_events", "idempotency_key = ?", [key]);
    if (event.idempotencyKey) {
      const existing = await findByKey(event.idempotencyKey);
      if (existing) {
        return { ok: true, duplicate: true, eventId: existing.id };
      }
    }

    // Story 1.9: the event row and its aggregate change are one atomic batch, and the aggregate is computed by a single
    // upsert in SQL (never read-add-write in JavaScript), so concurrent events can neither lose nor double-count usage.
    const now = new Date().toISOString();
    const initialValue = meter.aggregation === "count" ? 1.0 : value;
    const nextValueSql =
      meter.aggregation === "sum"
        ? "meter_aggregates.total_value + excluded.total_value"
        : meter.aggregation === "count"
          ? "meter_aggregates.total_value + 1.0"
          : meter.aggregation === "max"
            ? "MAX(meter_aggregates.total_value, excluded.total_value)"
            : "excluded.total_value";
    try {
      await this.db.batch([
        this.db
          .prepare("INSERT INTO meter_events (id, workspace_id, meter_key, value, idempotency_key, timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(eventId, event.workspaceId, meter.key, value, event.idempotencyKey || null, timestamp, metadataJson),
        this.db
          .prepare(
            `INSERT INTO meter_aggregates (workspace_id, meter_key, window_period, total_value, event_count, updated_at)
             VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT (workspace_id, meter_key, window_period) DO UPDATE SET
               total_value = ${nextValueSql},
               event_count = meter_aggregates.event_count + 1,
               updated_at = excluded.updated_at`,
          )
          .bind(event.workspaceId, meter.key, windowPeriod, initialValue, now),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // A concurrent insert of the same key in the same workspace won the race: answer with that event (the batch
      // rolled back, so the aggregate was not touched twice).
      if (event.idempotencyKey && /UNIQUE constraint failed: meter_events\.workspace_id, meter_events\.idempotency_key/.test(msg)) {
        const existing = await findByKey(event.idempotencyKey);
        return { ok: true, duplicate: true, ...(existing ? { eventId: existing.id } : {}) };
      }
      return { ok: false, error: msg };
    }

    return { ok: true, duplicate: false, eventId };
  }

  /**
   * Retrieves usage aggregate for a specific workspace and meter in a window.
   */
  async getUsage(workspaceId: string, meterKeyRaw: string, windowPeriod: string = getCurrentWindow()): Promise<MeterUsageAggregate> {
    const meterKey = meterKeyRaw.trim().toLowerCase();
    const row = await scoped(this.db, workspaceId).first<MeterUsageAggregate>("meter_aggregates", "meter_key = ? AND window_period = ?", [
      meterKey,
      windowPeriod,
    ]);

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
  async getUsageSummary(workspaceId: string, windowPeriod: string = getCurrentWindow()): Promise<MeterUsageAggregate[]> {
    return scoped(this.db, workspaceId).select<MeterUsageAggregate>("meter_aggregates", "window_period = ?", [windowPeriod], { orderBy: "meter_key ASC" });
  }
}
