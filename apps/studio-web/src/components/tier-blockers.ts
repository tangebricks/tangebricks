const TIER_BLOCKER_DESCRIPTIONS: Record<string, string> = {
  ASSERTIONS_BELOW_MIN: "Test assertions below production minimum",
  CONFORMANCE_KIT_MISSING: "Missing shared brick conformance kit suite",
  BEHAVIOUR_TEST_NOT_EXECUTED: "Behaviour test has not been executed",
  BEHAVIOUR_TEST_FAILED: "Behaviour test failed",
  DEFAULT_ADAPTER_FAKE: "Default adapter is a fake/stub implementation",
  FIDELITY_UNACKNOWLEDGED_LOSS: "Unacknowledged fidelity loss in integration spec",
  LIVE_CANARY_STALE: "Live canary check is stale or missing",
};

export function humanizeBlocker(blocker: string): string {
  return TIER_BLOCKER_DESCRIPTIONS[blocker] ?? blocker.replace(/_/g, " ").toLowerCase();
}
