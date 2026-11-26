import { scoped, type D1Like } from "@poc/sdk";

export interface OnboardingStep {
  stepKey: string;
  title: string;
  description?: string;
  actionUrl?: string;
  isOptional?: boolean;
}

export interface OnboardingFlow {
  id: string;
  workspace_id: string;
  key: string;
  title: string;
  description: string | null;
  steps: OnboardingStep[];
  is_active: boolean;
  created_at: string;
}

export interface UserProgress {
  id: string;
  flow_id: string;
  flow_key: string;
  workspace_id: string;
  user_id: string;
  completed_steps: string[];
  total_steps: number;
  completed_count: number;
  percent_complete: number;
  is_completed: boolean;
  is_dismissed: boolean;
  started_at: string;
  completed_at: string | null;
  dismissed_at: string | null;
}

export interface FlowAnalytics {
  total_started: number;
  total_completed: number;
  completion_rate_percent: number;
  avg_time_to_completion_seconds: number;
}

export interface CreateFlowInput {
  workspaceId: string;
  key: string;
  title: string;
  description?: string;
  steps: OnboardingStep[];
  isActive?: boolean;
}

interface RawFlowRow {
  id: string;
  workspace_id: string;
  key: string;
  title: string;
  description: string | null;
  steps_json: string;
  is_active: number;
  created_at: string;
}

interface RawProgressRow {
  id: string;
  flow_id: string;
  workspace_id: string;
  user_id: string;
  completed_steps_json: string;
  is_completed: number;
  is_dismissed: number;
  started_at: string;
  completed_at: string | null;
  dismissed_at: string | null;
}

export class UserOnboardingService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  private mapFlow(row: RawFlowRow): OnboardingFlow {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      key: row.key,
      title: row.title,
      description: row.description,
      steps: JSON.parse(row.steps_json || "[]"),
      is_active: row.is_active === 1,
      created_at: row.created_at,
    };
  }

  /**
   * Registers a new onboarding checklist / tour flow.
   */
  async createFlow(input: CreateFlowInput): Promise<OnboardingFlow> {
    const id = `flow_${crypto.randomUUID().replace(/-/g, "")}`;
    const key = input.key.trim().toLowerCase();
    const now = new Date().toISOString();
    const stepsJson = JSON.stringify(input.steps);
    const active = input.isActive !== false ? 1 : 0;

    const existing = await scoped(this.db, input.workspaceId).first<RawFlowRow>(
      "onb_flows",
      "key = ?",
      [key]
    );

    if (existing) {
      await scoped(this.db, input.workspaceId).update(
        "onb_flows",
        {
          title: input.title.trim(),
          description: input.description?.trim() || null,
          steps_json: stepsJson,
          is_active: active,
        },
        "key = ?",
        [key]
      );
    } else {
      await scoped(this.db, input.workspaceId).insert("onb_flows", {
        id,
        key,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        steps_json: stepsJson,
        is_active: active,
        created_at: now,
      });
    }

    const flow = await this.getFlow(input.workspaceId, key);
    return flow!;
  }

  /**
   * Retrieves an onboarding flow by key.
   */
  async getFlow(workspaceId: string, flowKey: string): Promise<OnboardingFlow | null> {
    const row = await scoped(this.db, workspaceId).first<RawFlowRow>(
      "onb_flows",
      "key = ?",
      [flowKey.trim().toLowerCase()]
    );

    return row ? this.mapFlow(row) : null;
  }

  /**
   * Lists all onboarding flows for workspace.
   */
  async listFlows(workspaceId: string): Promise<OnboardingFlow[]> {
    const rows = await scoped(this.db, workspaceId).select<RawFlowRow>(
      "onb_flows",
      undefined,
      [],
      { orderBy: "created_at ASC" }
    );

    return rows.map((r) => this.mapFlow(r));
  }

  /**
   * Retrieves or initializes a user's progress on an onboarding flow.
   */
  async getUserProgress(workspaceId: string, flowKey: string, userId: string): Promise<UserProgress> {
    const flow = await this.getFlow(workspaceId, flowKey);
    if (!flow) {
      throw new Error(`Onboarding flow '${flowKey}' not found`);
    }

    let row = await scoped(this.db, workspaceId).first<RawProgressRow>(
      "onb_user_progress",
      "flow_id = ? AND user_id = ?",
      [flow.id, userId.trim()]
    );

    const now = new Date().toISOString();

    if (!row) {
      const progId = `prog_${crypto.randomUUID().replace(/-/g, "")}`;
      await scoped(this.db, workspaceId).insert("onb_user_progress", {
        id: progId,
        flow_id: flow.id,
        user_id: userId.trim(),
        completed_steps_json: "[]",
        is_completed: 0,
        is_dismissed: 0,
        started_at: now,
        completed_at: null,
        dismissed_at: null,
      });

      row = {
        id: progId,
        flow_id: flow.id,
        workspace_id: workspaceId,
        user_id: userId.trim(),
        completed_steps_json: "[]",
        is_completed: 0,
        is_dismissed: 0,
        started_at: now,
        completed_at: null,
        dismissed_at: null,
      };
    }

    const completedSteps: string[] = JSON.parse(row.completed_steps_json || "[]");
    const totalSteps = flow.steps.length;
    const completedCount = completedSteps.length;
    const percent = totalSteps > 0 ? Math.round((completedCount / totalSteps) * 100) : 100;

    return {
      id: row.id,
      flow_id: row.flow_id,
      flow_key: flow.key,
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      completed_steps: completedSteps,
      total_steps: totalSteps,
      completed_count: completedCount,
      percent_complete: percent,
      is_completed: row.is_completed === 1,
      is_dismissed: row.is_dismissed === 1,
      started_at: row.started_at,
      completed_at: row.completed_at,
      dismissed_at: row.dismissed_at,
    };
  }

  /**
   * Completes a step in the user's checklist.
   */
  async completeStep(
    workspaceId: string,
    flowKey: string,
    userId: string,
    stepKey: string
  ): Promise<UserProgress> {
    const flow = await this.getFlow(workspaceId, flowKey);
    if (!flow) {
      throw new Error(`Flow '${flowKey}' not found`);
    }

    const validStep = flow.steps.some((s) => s.stepKey === stepKey);
    if (!validStep) {
      throw new Error(`Step '${stepKey}' is not part of flow '${flowKey}'`);
    }

    const current = await this.getUserProgress(workspaceId, flowKey, userId);
    const completedSet = new Set(current.completed_steps);
    completedSet.add(stepKey);

    const updatedSteps = Array.from(completedSet);
    const requiredSteps = flow.steps.filter((s) => !s.isOptional).map((s) => s.stepKey);
    const allRequiredDone = requiredSteps.every((sk) => completedSet.has(sk));

    const now = new Date().toISOString();
    const isCompleted = allRequiredDone ? 1 : current.is_completed ? 1 : 0;
    const completedAt = allRequiredDone && !current.is_completed ? now : current.completed_at;

    await scoped(this.db, workspaceId).update(
      "onb_user_progress",
      {
        completed_steps_json: JSON.stringify(updatedSteps),
        is_completed: isCompleted,
        completed_at: completedAt,
      },
      "flow_id = ? AND user_id = ?",
      [flow.id, userId.trim()]
    );

    return this.getUserProgress(workspaceId, flowKey, userId);
  }

  /**
   * Dismisses an onboarding checklist / banner for a user.
   */
  async dismissFlow(workspaceId: string, flowKey: string, userId: string): Promise<UserProgress> {
    const current = await this.getUserProgress(workspaceId, flowKey, userId);
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).update(
      "onb_user_progress",
      {
        is_dismissed: 1,
        dismissed_at: now,
      },
      "flow_id = ? AND user_id = ?",
      [current.flow_id, userId.trim()]
    );

    return this.getUserProgress(workspaceId, flowKey, userId);
  }

  /**
   * Resets progress on a flow.
   */
  async resetFlowProgress(workspaceId: string, flowKey: string, userId: string): Promise<UserProgress> {
    const flow = await this.getFlow(workspaceId, flowKey);
    if (!flow) {
      throw new Error(`Flow '${flowKey}' not found`);
    }

    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).update(
      "onb_user_progress",
      {
        completed_steps_json: "[]",
        is_completed: 0,
        is_dismissed: 0,
        started_at: now,
        completed_at: null,
        dismissed_at: null,
      },
      "flow_id = ? AND user_id = ?",
      [flow.id, userId.trim()]
    );

    return this.getUserProgress(workspaceId, flowKey, userId);
  }

  /**
   * Calculates time-to-first-value (TTFV) & activation metrics.
   */
  async getFlowAnalytics(workspaceId: string, flowKey: string): Promise<FlowAnalytics> {
    const flow = await this.getFlow(workspaceId, flowKey);
    if (!flow) {
      throw new Error(`Flow '${flowKey}' not found`);
    }

    const rows = await scoped(this.db, workspaceId).select<{
      started_at: string;
      completed_at: string | null;
      is_completed: number;
    }>("onb_user_progress", "flow_id = ?", [flow.id]);

    const totalStarted = rows.length;
    const completedRows = rows.filter((r) => r.is_completed === 1 && r.completed_at);
    const totalCompleted = completedRows.length;

    let totalDurationSeconds = 0;
    for (const r of completedRows) {
      const start = new Date(r.started_at).getTime();
      const end = new Date(r.completed_at!).getTime();
      totalDurationSeconds += Math.max(0, (end - start) / 1000);
    }

    const avgDuration = totalCompleted > 0 ? Math.round(totalDurationSeconds / totalCompleted) : 0;
    const rate = totalStarted > 0 ? Math.round((totalCompleted / totalStarted) * 100) : 0;

    return {
      total_started: totalStarted,
      total_completed: totalCompleted,
      completion_rate_percent: rate,
      avg_time_to_completion_seconds: avgDuration,
    };
  }
}
