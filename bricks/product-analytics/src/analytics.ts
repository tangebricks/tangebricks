import { scoped, type D1Like } from "@poc/sdk";

export interface AnalyticsEvent {
  id: string;
  workspace_id: string;
  user_id: string | null;
  anonymous_id: string;
  event_name: string;
  session_id: string | null;
  properties: Record<string, unknown>;
  context: Record<string, unknown>;
  timestamp: string;
}

export interface TrackEventInput {
  workspaceId: string;
  userId?: string;
  anonymousId: string;
  eventName: string;
  sessionId?: string;
  properties?: Record<string, unknown>;
  context?: Record<string, unknown>;
  timestamp?: string;
}

export interface Funnel {
  id: string;
  workspace_id: string;
  name: string;
  steps: string[];
  created_at: string;
}

export interface FunnelStepReport {
  step: string;
  count: number;
  conversionRate: number;
  dropoffRate: number;
}

export interface FunnelReport {
  funnelId: string;
  funnelName: string;
  steps: FunnelStepReport[];
  overallConversion: number;
}

interface RawEventRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  anonymous_id: string;
  event_name: string;
  session_id: string | null;
  properties_json: string | null;
  context_json: string | null;
  timestamp: string;
}

interface RawFunnelRow {
  id: string;
  workspace_id: string;
  name: string;
  steps_json: string;
  created_at: string;
}

export class ProductAnalyticsService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  private parseEvent(row: RawEventRow): AnalyticsEvent {
    let props = {};
    if (row.properties_json) {
      try {
        props = JSON.parse(row.properties_json);
      } catch {
        props = {};
      }
    }

    let ctx = {};
    if (row.context_json) {
      try {
        ctx = JSON.parse(row.context_json);
      } catch {
        ctx = {};
      }
    }

    return {
      id: row.id,
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      anonymous_id: row.anonymous_id,
      event_name: row.event_name,
      session_id: row.session_id,
      properties: props,
      context: ctx,
      timestamp: row.timestamp,
    };
  }

  /**
   * Ingests a telemetry / clickstream event into the immutable analytics store.
   */
  async track(input: TrackEventInput): Promise<AnalyticsEvent> {
    const id = `evt_${crypto.randomUUID().replace(/-/g, "")}`;
    const timestamp = input.timestamp || new Date().toISOString();
    const propsJson = input.properties ? JSON.stringify(input.properties) : null;
    const ctxJson = input.context ? JSON.stringify(input.context) : null;

    await scoped(this.db, input.workspaceId).insert("evt_analytics_events", {
      id,
      user_id: input.userId?.trim() || null,
      anonymous_id: input.anonymousId.trim(),
      event_name: input.eventName.trim().toLowerCase(),
      session_id: input.sessionId?.trim() || null,
      properties_json: propsJson,
      context_json: ctxJson,
      timestamp,
    });

    return {
      id,
      workspace_id: input.workspaceId,
      user_id: input.userId?.trim() || null,
      anonymous_id: input.anonymousId.trim(),
      event_name: input.eventName.trim().toLowerCase(),
      session_id: input.sessionId?.trim() || null,
      properties: input.properties || {},
      context: input.context || {},
      timestamp,
    };
  }

  /**
   * Aliases an anonymous device ID with an authenticated user identity retroactively.
   */
  async identify(workspaceId: string, anonymousId: string, userId: string): Promise<{ updatedCount: number }> {
    const res = await scoped(this.db, workspaceId).update("evt_analytics_events", { user_id: userId.trim() }, "anonymous_id = ? AND user_id IS NULL", [
      anonymousId.trim(),
    ]);

    return { updatedCount: res.meta.changes };
  }

  /**
   * Aggregates event totals grouped by event name.
   */
  async getEventCounts(workspaceId: string, options: { eventNames?: string[] } = {}): Promise<Record<string, number>> {
    let query = "SELECT event_name, COUNT(*) as count FROM evt_analytics_events WHERE workspace_id = ?";
    const params: unknown[] = [workspaceId];

    if (options.eventNames && options.eventNames.length > 0) {
      const placeholders = options.eventNames.map(() => "?").join(",");
      query += ` AND event_name IN (${placeholders})`;
      params.push(...options.eventNames.map((n) => n.trim().toLowerCase()));
    }

    query += " GROUP BY event_name";

    interface CountRow {
      event_name: string;
      count: number;
    }

    const rows = (await scoped(this.db, workspaceId).raw(query, params).all<CountRow>()).results;
    const result: Record<string, number> = {};
    for (const r of rows) {
      result[r.event_name] = r.count;
    }

    return result;
  }

  /**
   * Defines a new conversion funnel.
   */
  async createFunnel(workspaceId: string, nameRaw: string, steps: string[]): Promise<Funnel> {
    const id = `fnl_${crypto.randomUUID().replace(/-/g, "")}`;
    const name = nameRaw.trim();
    const cleanSteps = steps.map((s) => s.trim().toLowerCase()).filter(Boolean);
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("evt_funnels", {
      id,
      name,
      steps_json: JSON.stringify(cleanSteps),
      created_at: now,
    });

    return {
      id,
      workspace_id: workspaceId,
      name,
      steps: cleanSteps,
      created_at: now,
    };
  }

  /**
   * Retrieves a funnel definition.
   */
  async getFunnel(funnelId: string, workspaceId?: string): Promise<Funnel | null> {
    if (!workspaceId) return null;
    const row = await scoped(this.db, workspaceId).first<RawFunnelRow>("evt_funnels", "id = ?", [funnelId]);

    if (!row) return null;

    return {
      ...row,
      steps: JSON.parse(row.steps_json || "[]"),
    };
  }

  /**
   * Calculates step-by-step conversion dropoff rates for a funnel.
   */
  async calculateFunnel(workspaceId: string, funnelId: string): Promise<FunnelReport | null> {
    const funnel = await this.getFunnel(funnelId, workspaceId);
    if (!funnel || funnel.workspace_id !== workspaceId) return null;

    const stepReports: FunnelStepReport[] = [];
    let previousActors = new Set<string>();

    for (const [i, stepName] of funnel.steps.entries()) {
      // Query distinct actors (user_id if present, else anonymous_id) for this step
      interface ActorRow {
        actor: string;
      }
      const rows = (
        await scoped(this.db, workspaceId)
          .raw(
            `
        SELECT DISTINCT COALESCE(user_id, anonymous_id) as actor
        FROM evt_analytics_events
        WHERE workspace_id = ? AND event_name = ?
      `,
            [workspaceId, stepName],
          )
          .all<ActorRow>()
      ).results;

      const currentActors = new Set(rows.map((r) => r.actor));

      if (i === 0) {
        // First step is 100% of baseline
        stepReports.push({
          step: stepName,
          count: currentActors.size,
          conversionRate: 1.0,
          dropoffRate: 0.0,
        });
        previousActors = currentActors;
      } else {
        // Intersection with previous actors who completed prior step
        const retainedActors = new Set([...currentActors].filter((a) => previousActors.has(a)));
        const prevCount = previousActors.size;
        const currentCount = retainedActors.size;
        const convRate = prevCount > 0 ? currentCount / prevCount : 0;
        const dropRate = 1.0 - convRate;

        stepReports.push({
          step: stepName,
          count: currentCount,
          conversionRate: Math.round(convRate * 1000) / 1000,
          dropoffRate: Math.round(dropRate * 1000) / 1000,
        });
        previousActors = retainedActors;
      }
    }

    const firstStepCount = stepReports[0]?.count || 0;
    const finalStepCount = stepReports[stepReports.length - 1]?.count || 0;
    const overallConversion = firstStepCount > 0 ? Math.round((finalStepCount / firstStepCount) * 1000) / 1000 : 0;

    return {
      funnelId: funnel.id,
      funnelName: funnel.name,
      steps: stepReports,
      overallConversion,
    };
  }
}
