// Story 1.20: which of a brick's manifest schedules are wired under its settings. Kept free of imports so Studio (web
// and api) can use the exact rule the assembler applies (`@poc/assembler/schedules`).

/** A condition on one of a brick's settings: it holds while the setting `equals` a value, or differs from `notEquals`. */
export type ScheduleSettingCondition = { setting: string; equals: number | string | boolean } | { setting: string; notEquals: number | string | boolean };

/** Whether a condition holds for a brick's settings; a setting missing from `settings` takes its manifest default. */
export function settingConditionHolds(
  condition: ScheduleSettingCondition,
  settings: Readonly<Record<string, unknown>>,
  definitions: Readonly<Record<string, { default?: unknown }>> = {},
): boolean {
  const value = condition.setting in settings ? settings[condition.setting] : definitions[condition.setting]?.default;
  return "equals" in condition ? value === condition.equals : value !== condition.notEquals;
}

/**
 * The manifest's schedules that are wired under `settings` (the brick's config or its resolved settings): every one
 * without an `enabledWhen`, and each whose `enabledWhen` holds.
 */
export function enabledSchedules<S extends { enabledWhen?: ScheduleSettingCondition | undefined }>(
  manifest: { settings?: Readonly<Record<string, { default?: unknown }>>; triggers?: { schedules?: readonly S[] | undefined } | undefined },
  settings: Readonly<Record<string, unknown>> = {},
): S[] {
  return (manifest.triggers?.schedules ?? []).filter(
    (sched) => !sched.enabledWhen || settingConditionHolds(sched.enabledWhen, settings, manifest.settings ?? {}),
  );
}
