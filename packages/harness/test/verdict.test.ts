import { describe, expect, test } from "vitest";
import { inRange, mergeRecords, parseHypotheses, rangesOverlap, verdict, withFailedFile, type Hypothesis, type Result } from "../src/index.ts";
import hypothesesJson from "../../../hypotheses.json";

const file = parseHypotheses(hypothesesJson);
const byId = (id: string): Hypothesis => {
  const found = file.hypotheses.find((h) => h.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

const H1_CHECKS = { fixturesCatchAllEightClasses: true, validFixturePasses: true };
const H2_CHECKS = { chainPasses: true, diamondPasses: true, noDynamicEvaluation: true };
const H3_CHECKS = {
  declaredSecretReadable: true,
  undeclaredSecretAbsent: true,
  undeclaredReadThrows: true,
  rawEnvUnreachable: true,
};

describe("committed hypotheses.json", () => {
  test("is valid and lists H0 plus H1-H12 exactly once, except H4 (retired, see docs/retired-hypotheses.md)", () => {
    const ids = file.hypotheses.map((h) => h.id);
    expect(ids).toEqual(["H0", ...Array.from({ length: 12 }, (_, i) => `H${i + 1}`).filter((id) => id !== "H4")]);
  });

  test("H1-H12 (without the retired H4) are all live, with their rules committed", () => {
    for (let n = 1; n <= 12; n += 1) if (n !== 4) expect(byId(`H${n}`).status).toBe("live");
  });

  test("H10 to H12 each carry a note recording that the rule was fixed before any build, and a caveat", () => {
    for (const id of ["H10", "H11", "H12"]) {
      const h = byId(id);
      expect(h.status === "live" && h.note).toMatch(/Rule fixed 2026-10-21.*BEFORE any/);
      expect(h.status === "live" && (h.caveat ?? "").length).toBeGreaterThan(200);
    }
  });

  test("H3 carries a caveat about code in the same isolate", () => {
    const h3 = byId("H3");
    expect(h3.status === "live" && h3.caveat).toMatch(/same isolate/);
  });
});

describe("H1 thresholds (pass at most 120 lines, kill above 200)", () => {
  const h1 = byId("H1");
  const with_ = (measured: number, checks = H1_CHECKS): Result => ({ measured, checks });

  test.each([
    [0, "pass"],
    [120, "pass"],
    [121, "fail"],
    [200, "fail"],
    [201, "kill"],
    [900, "kill"],
  ])("%i lines -> %s", (lines, expected) => {
    expect(verdict(h1, with_(lines)).verdict).toBe(expected);
  });

  test("a missed error class fails even when small", () => {
    const out = verdict(h1, with_(50, { ...H1_CHECKS, fixturesCatchAllEightClasses: false }));
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toContain("check false: fixturesCatchAllEightClasses");
  });

  test("a missing measurement fails and says why", () => {
    const out = verdict(h1, { checks: H1_CHECKS });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toContain("validatorCodeLines not measured");
  });
});

describe("H2 thresholds (diamond ratio strictly below 1; dynamic evaluation is a kill)", () => {
  const h2 = byId("H2");
  const with_ = (ratio: number, checks = H2_CHECKS): Result => ({ measured: ratio, checks });

  test.each([
    [0.55, "pass"],
    [0.999, "pass"],
    [1, "fail"],
    [1.4, "fail"],
  ])("ratio %f -> %s", (ratio, expected) => {
    expect(verdict(h2, with_(ratio)).verdict).toBe(expected);
  });

  test("any dynamic evaluation is a kill even when the ratio passes", () => {
    expect(verdict(h2, with_(0.5, { ...H2_CHECKS, noDynamicEvaluation: false })).verdict).toBe("kill");
  });

  test("a graph that does not run is a fail, not a kill", () => {
    expect(verdict(h2, with_(0.5, { ...H2_CHECKS, diamondPasses: false })).verdict).toBe("fail");
  });
});

describe("H3 (no metric; undeclared secret visible is a kill)", () => {
  const h3 = byId("H3");

  test("all checks true passes", () => {
    expect(verdict(h3, { checks: H3_CHECKS }).verdict).toBe("pass");
  });

  test("undeclared secret present is a kill", () => {
    expect(verdict(h3, { checks: { ...H3_CHECKS, undeclaredSecretAbsent: false } }).verdict).toBe("kill");
  });

  test.each(["declaredSecretReadable", "undeclaredReadThrows", "rawEnvUnreachable"])("%s false is a fail, not a kill", (name) => {
    expect(verdict(h3, { checks: { ...H3_CHECKS, [name]: false } }).verdict).toBe("fail");
  });
});

describe("H5 thresholds (pass at 0 violating runs of 20, kill at 1 or more; five checks required)", () => {
  const h5 = byId("H5");
  const checks = {
    controlLosesUpdates: true,
    orderCreditedOnce: true,
    insufficientRefusesUnchanged: true,
    graphDeductChangesBalanceOnce: true,
    portedTestsPass: true,
  };

  test.each([
    [0, "pass"],
    [1, "kill"],
    [2, "kill"],
    [20, "kill"],
  ])("%i violating runs -> %s", (runs, expected) => {
    expect(verdict(h5, { measured: runs, checks }).verdict).toBe(expected);
  });

  test.each(Object.keys(checks))("%s false is a fail, not a kill, even at zero violations", (name) => {
    const out = verdict(h5, { measured: 0, checks: { ...checks, [name]: false } });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toContain(`check false: ${name}`);
  });

  test("a control that never loses an update means a pass would prove nothing, so it is not a pass", () => {
    expect(verdict(h5, { measured: 0, checks: { ...checks, controlLosesUpdates: false } }).verdict).not.toBe("pass");
  });

  test("zero violations with the checks not yet reported is a fail that names them", () => {
    const out = verdict(h5, { measured: 0, checks: { controlLosesUpdates: true } });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toEqual([
      "check not reported: orderCreditedOnce",
      "check not reported: insufficientRefusesUnchanged",
      "check not reported: graphDeductChangesBalanceOnce",
      "check not reported: portedTestsPass",
      "extra check not yet run: holdsOnHostedD1",
    ]);
  });

  test("no measurement is a fail, not a pass", () => {
    expect(verdict(h5, { checks }).verdict).toBe("fail");
  });
});

describe("H6 (no metric; any false check is a kill; all five checks required)", () => {
  const h6 = byId("H6");
  const checks = { crossTenantDenied: true, ownWalletWorks: true, emittedProjectUnchanged: true, assemblerNamesNoBrick: true, denialTestsRepoOwned: true };

  test("all five checks true is a pass", () => {
    expect(verdict(h6, { checks }).verdict).toBe("pass");
  });

  test.each(Object.keys(checks))("%s false is a kill", (name) => {
    const out = verdict(h6, { checks: { ...checks, [name]: false } });
    expect(out.verdict).toBe("kill");
    expect(out.reasons).toContain(`check false: ${name}`);
  });

  test("a check the run never reported is a fail that names it, never a pass", () => {
    const { denialTestsRepoOwned: _left, ...rest } = checks;
    const out = verdict(h6, { checks: rest });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toEqual(["check not reported: denialTestsRepoOwned"]);
  });

  test("no result at all is pending, not a pass", () => {
    expect(verdict(h6, undefined).verdict).toBe("pending");
  });
});

describe("H7 thresholds (pass under 5 seconds, kill over 30; identical files required, a network attempt is a fail)", () => {
  const h7 = byId("H7");
  const checks = { identicalHashes: true, noNetworkAttempts: true };

  test.each([
    [0, "pass"],
    [0.42, "pass"],
    [4.999, "pass"],
    [5, "fail"],
    [12, "fail"],
    [30, "fail"],
    [30.001, "kill"],
    [300, "kill"],
  ])("%d seconds -> %s", (seconds, expected) => {
    expect(verdict(h7, { measured: seconds, checks }).verdict).toBe(expected);
  });

  test("different files on a repeat run is a kill even when it is fast", () => {
    const out = verdict(h7, { measured: 0.3, checks: { ...checks, identicalHashes: false } });
    expect(out.verdict).toBe("kill");
    expect(out.reasons).toContain("check false: identicalHashes");
  });

  test("a network attempt is a fail, not a kill, even when it is fast", () => {
    const out = verdict(h7, { measured: 0.3, checks: { ...checks, noNetworkAttempts: false } });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toContain("check false: noNetworkAttempts");
  });

  test("a time with the checks not reported is a fail that names them, never a pass", () => {
    const out = verdict(h7, { measured: 0.3 });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toEqual(["check not reported: identicalHashes", "check not reported: noNetworkAttempts"]);
  });

  test("the checks without a time are a fail, not a pass", () => {
    expect(verdict(h7, { checks }).verdict).toBe("fail");
  });
});

describe("H8 (no metric; safety failures are kills, a functional failure is a fail)", () => {
  const h8 = byId("H8");
  const checks = {
    tenantACrud: true,
    tenantBDenied: true,
    bodyWorkspaceIgnored: true,
    hostileInputsSafe: true,
    entityCodeIsGeneric: true,
    walletStillDenied: true,
    emittedProjectUnchanged: true,
  };

  test("all seven checks true is a pass", () => {
    expect(verdict(h8, { checks }).verdict).toBe("pass");
  });

  test.each(["tenantBDenied", "bodyWorkspaceIgnored", "hostileInputsSafe", "entityCodeIsGeneric"])("%s false is a kill", (name) => {
    const out = verdict(h8, { checks: { ...checks, [name]: false } });
    expect(out.verdict).toBe("kill");
    expect(out.reasons).toContain(`check false: ${name}`);
  });

  test.each(["tenantACrud", "walletStillDenied", "emittedProjectUnchanged"])("%s false is a fail, not a kill", (name) => {
    const out = verdict(h8, { checks: { ...checks, [name]: false } });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toContain(`check false: ${name}`);
  });

  test("a check the run never reported is a fail that names it, never a pass", () => {
    const { walletStillDenied: _left, ...rest } = checks;
    const out = verdict(h8, { checks: rest });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toEqual(["check not reported: walletStillDenied"]);
  });

  test("a safety failure outranks a functional one", () => {
    expect(verdict(h8, { checks: { ...checks, tenantACrud: false, tenantBDenied: false } }).verdict).toBe("kill");
  });
});

describe("H9 thresholds (pass at 15 percent or less, kill above 40; three checks required, none a kill)", () => {
  const h9 = byId("H9");
  const checks = { fiveToolCallsOrFewer: true, sessionBuiltTheDirectProject: true, bothSidesCountedTheSameWay: true };

  test.each([
    [0, "pass"],
    [7.3, "pass"],
    [15, "pass"],
    [15.01, "fail"],
    [25, "fail"],
    [40, "fail"],
    [40.01, "kill"],
    [100, "kill"],
  ])("%d percent -> %s", (percent, expected) => {
    expect(verdict(h9, { measured: percent, checks }).verdict).toBe(expected);
  });

  test.each(Object.keys(checks))("%s false is a fail even at a passing ratio, never a kill", (name) => {
    const out = verdict(h9, { measured: 5, checks: { ...checks, [name]: false } });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toContain(`check false: ${name}`);
  });

  test("a ratio over 40 stays a kill even when the checks hold", () => {
    expect(verdict(h9, { measured: 55, checks }).verdict).toBe("kill");
  });

  test("a ratio with the checks not reported is a fail that names them, never a pass", () => {
    const out = verdict(h9, { measured: 5 });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toEqual([
      "check not reported: fiveToolCallsOrFewer",
      "check not reported: sessionBuiltTheDirectProject",
      "check not reported: bothSidesCountedTheSameWay",
    ]);
  });

  test("the checks without a ratio are a fail", () => {
    expect(verdict(h9, { checks }).verdict).toBe("fail");
  });
});

describe("H10 thresholds (pass at 120 seconds or less, kill above 600 or when REST refuses the upload; seven checks required)", () => {
  const h10 = byId("H10");
  const checks = {
    restUploadAccepted: true,
    deployedOverRestOnly: true,
    urlAnswersCorrectly: true,
    secondRunChangesNothing: true,
    changedProjectChangesOneThing: true,
    publicAccessGated: true,
    tokenNeverLeaked: true,
  };

  test.each([
    [0.5, "pass"],
    [119.9, "pass"],
    [120, "pass"],
    [120.01, "fail"],
    [300, "fail"],
    [600, "fail"],
    [600.01, "kill"],
    [5000, "kill"],
  ])("%d seconds -> %s", (seconds, expected) => {
    expect(verdict(h10, { measured: seconds, checks }).verdict).toBe(expected);
  });

  test("Cloudflare refusing the upload over REST is a kill, even if the time is not measured", () => {
    expect(verdict(h10, { checks: { ...checks, restUploadAccepted: false } }).verdict).toBe("kill");
    expect(verdict(h10, { measured: 10, checks: { ...checks, restUploadAccepted: false } }).verdict).toBe("kill");
  });

  test.each(Object.keys(checks).filter((name) => name !== "restUploadAccepted"))("%s false is a fail, never a kill, even at a passing time", (name) => {
    const out = verdict(h10, { measured: 30, checks: { ...checks, [name]: false } });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toContain(`check false: ${name}`);
  });

  test("a second run that changed something cannot be hidden behind a fast first run", () => {
    expect(verdict(h10, { measured: 5, checks: { ...checks, secondRunChangesNothing: false } }).verdict).toBe("fail");
  });

  test("a time with the checks not reported, or the checks without a time, is a fail that says so", () => {
    expect(verdict(h10, { measured: 5 }).reasons).toContain("check not reported: restUploadAccepted");
    expect(verdict(h10, { measured: 5 }).verdict).toBe("fail");
    expect(verdict(h10, { checks }).verdict).toBe("fail");
  });

  test("with no result recorded it is pending, not a pass", () => {
    expect(verdict(h10, undefined).verdict).toBe("pending");
  });
});

describe("H11 (no metric; needing a re-upload for an edit is a kill, other false checks are fails)", () => {
  const h11 = byId("H11");
  const checks = {
    oneWorkflowClassRanAllGraphs: true,
    graphReadFromD1: true,
    editChangedNextRun: true,
    scriptVersionUnchanged: true,
    resultsMatchLocalInterpreter: true,
    everyNodeRanInsideStepDo: true,
    runKeepsItsGraphWhenEditedMidRun: true,
    badEditRefusedBeforeAnyStep: true,
    writeLatencyRecorded: true,
  };

  test("all nine checks true is a pass", () => {
    expect(verdict(h11, { checks }).verdict).toBe("pass");
  });

  test.each(["editChangedNextRun", "scriptVersionUnchanged"])("%s false is a kill", (name) => {
    expect(verdict(h11, { checks: { ...checks, [name]: false } }).verdict).toBe("kill");
  });

  test.each(Object.keys(checks).filter((name) => name !== "editChangedNextRun" && name !== "scriptVersionUnchanged"))(
    "%s false is a fail, not a kill",
    (name) => {
      expect(verdict(h11, { checks: { ...checks, [name]: false } }).verdict).toBe("fail");
    },
  );

  test("a kill outranks a fail in the same run", () => {
    expect(verdict(h11, { checks: { ...checks, scriptVersionUnchanged: false, graphReadFromD1: false } }).verdict).toBe("kill");
  });

  test("a check the run never reported is a fail that names it, never a pass", () => {
    const { writeLatencyRecorded: _omitted, ...rest } = checks;
    const out = verdict(h11, { checks: rest });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toEqual(["check not reported: writeLatencyRecorded"]);
  });
});

describe("H12 (no metric; needing glue code or not showing the live balance is a kill, a tenant mix-up is a fail)", () => {
  const h12 = byId("H12");
  const checks = { widgetShowsLiveBalance: true, balanceFollowsTheServer: true, noGlueCode: true, tenantBSeesOwnBalance: true };

  test("all four checks true is a pass", () => {
    expect(verdict(h12, { checks }).verdict).toBe("pass");
  });

  test.each(["widgetShowsLiveBalance", "balanceFollowsTheServer", "noGlueCode"])("%s false is a kill", (name) => {
    expect(verdict(h12, { checks: { ...checks, [name]: false } }).verdict).toBe("kill");
  });

  test("tenant B not seeing their own balance is a fail, not a kill", () => {
    expect(verdict(h12, { checks: { ...checks, tenantBSeesOwnBalance: false } }).verdict).toBe("fail");
  });

  test("a check the run never reported is a fail that names it", () => {
    const out = verdict(h12, { checks: { widgetShowsLiveBalance: true, balanceFollowsTheServer: true, noGlueCode: true } });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toEqual(["check not reported: tenantBSeesOwnBalance"]);
  });
});

describe("H5's extra evidence (a kill if reported false, no effect if never reported, but the scoreboard says so)", () => {
  const h5 = byId("H5");
  const base = {
    controlLosesUpdates: true,
    orderCreditedOnce: true,
    insufficientRefusesUnchanged: true,
    graphDeductChangesBalanceOnce: true,
    portedTestsPass: true,
  };

  test("is declared outside mustHold, so it cannot turn the existing pass into a fail", () => {
    expect(h5.status === "live" && h5.killIfFalseWhenReported).toEqual(["holdsOnHostedD1"]);
    expect(h5.status === "live" && h5.mustHold).not.toContain("holdsOnHostedD1");
  });

  test("not yet run: the pass stands and the row says the extra check has not been run", () => {
    const out = verdict(h5, { measured: 0, checks: base });
    expect(out.verdict).toBe("pass");
    expect(out.reasons).toEqual(["extra check not yet run: holdsOnHostedD1"]);
  });

  test("run and true: a pass with nothing to report", () => {
    const out = verdict(h5, { measured: 0, checks: { ...base, holdsOnHostedD1: true } });
    expect(out.verdict).toBe("pass");
    expect(out.reasons).toEqual([]);
  });

  test("run and false: a kill, even though every local check held", () => {
    const out = verdict(h5, { measured: 0, checks: { ...base, holdsOnHostedD1: false } });
    expect(out.verdict).toBe("kill");
    expect(out.reasons).toContain("check false: holdsOnHostedD1 (extra evidence)");
  });

  test("a local violation is still a kill whatever the hosted run says", () => {
    expect(verdict(h5, { measured: 1, checks: { ...base, holdsOnHostedD1: true } }).verdict).toBe("kill");
  });
});

describe("a failing test in a hypothesis's own file", () => {
  const passing = verdict(byId("H3"), { checks: H3_CHECKS });

  test("downgrades pass to fail even though the report test passed", () => {
    const out = withFailedFile(passing, "H3.secrets.test.ts");
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toEqual(["H3.secrets.test.ts has a failing test or failed to load"]);
  });

  test("downgrades pending to fail (the file broke before it could report)", () => {
    expect(withFailedFile(verdict(byId("H3"), undefined), "H3.secrets.test.ts").verdict).toBe("fail");
  });

  test("never softens a kill or a fail", () => {
    const killed = verdict(byId("H3"), { checks: { ...H3_CHECKS, undeclaredSecretAbsent: false } });
    expect(withFailedFile(killed, "H3.x.test.ts")).toBe(killed);
    const failed = verdict(byId("H3"), { checks: { ...H3_CHECKS, rawEnvUnreachable: false } });
    expect(withFailedFile(failed, "H3.x.test.ts")).toBe(failed);
  });

  test("changes nothing when no file failed", () => {
    expect(withFailedFile(passing, undefined)).toBe(passing);
  });
});

describe("pending and unreported", () => {
  test("a pending hypothesis is pending even with a result", () => {
    // every hypothesis now has its rule, so the pending case is built here
    const pending: Hypothesis = { id: "H99", title: "a claim with no rule yet", epic: "e", status: "pending" };
    expect(verdict(pending, { measured: 999, checks: { x: true } }).verdict).toBe("pending");
  });

  test("a live hypothesis with no result is pending", () => {
    expect(verdict(byId("H1"), undefined).verdict).toBe("pending");
  });

  test("a check the test never reported is a fail, not a silent pass", () => {
    const out = verdict(byId("H3"), { checks: { declaredSecretReadable: true } });
    expect(out.verdict).toBe("fail");
    expect(out.reasons).toContain("check not reported: undeclaredSecretAbsent");
  });
});

describe("schema rejects contradictory thresholds", () => {
  const live = (over: Record<string, unknown>) => ({
    version: 1,
    hypotheses: [
      {
        id: "H1",
        title: "t",
        epic: "e",
        status: "live",
        metric: { name: "m", unit: "u" },
        pass: { max: 10 },
        kill: { min: 20 },
        mustHold: [],
        killIfFalse: [],
        ...over,
      },
    ],
  });

  test("overlapping pass and kill ranges", () => {
    expect(() => parseHypotheses(live({ kill: { min: 10 } }))).toThrow(/overlap/);
  });

  test("touching strict and inclusive bounds do not overlap", () => {
    expect(() => parseHypotheses(live({ pass: { lt: 10 }, kill: { min: 10 } }))).not.toThrow();
  });

  test("a metric without a pass range", () => {
    expect(() => parseHypotheses(live({ pass: null }))).toThrow(/pass range/);
  });

  test("killIfFalse naming a check that is not required", () => {
    expect(() => parseHypotheses(live({ mustHold: ["a"], killIfFalse: ["b"] }))).toThrow(/not in mustHold/);
  });

  test("an extra kill check that is also required", () => {
    expect(() => parseHypotheses(live({ mustHold: ["a"], killIfFalse: [], killIfFalseWhenReported: ["a"] }))).toThrow(/already in mustHold/);
  });

  test("an extra kill check that is separate is accepted", () => {
    expect(() => parseHypotheses(live({ mustHold: ["a"], killIfFalse: [], killIfFalseWhenReported: ["b"] }))).not.toThrow();
  });

  test("duplicate ids", () => {
    const one = live({}).hypotheses[0]!;
    expect(() => parseHypotheses({ version: 1, hypotheses: [one, one] })).toThrow(/unique/);
  });
});

describe("range helpers", () => {
  test("inRange honours strict and inclusive bounds", () => {
    expect(inRange(1, { lt: 1 })).toBe(false);
    expect(inRange(1, { max: 1 })).toBe(true);
    expect(inRange(1, { gt: 1 })).toBe(false);
    expect(inRange(1, { min: 1 })).toBe(true);
  });

  test("rangesOverlap", () => {
    expect(rangesOverlap({ max: 120 }, { min: 201 })).toBe(false);
    expect(rangesOverlap({ max: 120 }, { min: 120 })).toBe(true);
    expect(rangesOverlap({ lt: 120 }, { min: 120 })).toBe(false);
  });
});

describe("mergeRecords", () => {
  test("a check is true only if every report that names it says true", () => {
    const merged = mergeRecords([
      { id: "H1", checks: { a: true, b: true } },
      { id: "H1", checks: { a: true, b: false }, measured: 90 },
      { id: "H2", checks: { c: true } },
    ]);
    expect(merged.H1).toEqual({ measured: 90, checks: { a: true, b: false } });
    expect(merged.H2).toEqual({ checks: { c: true } });
  });
});
