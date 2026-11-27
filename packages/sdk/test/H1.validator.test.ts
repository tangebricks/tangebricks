import { describe, expect, test } from "vitest";
import { countCodeLines, record } from "@poc/harness";
import { toyRegistry, validateGraph } from "../src/index.ts";
import validatorSource from "../src/validate.ts?raw";
import { fixtures, type Fixture } from "./fixtures.ts";

const codesFor = (f: Fixture): string[] => [...new Set(validateGraph(f.nodes, f.edges, toyRegistry).issues.map((i) => i.code))].sort();
const matches = (f: Fixture): boolean => JSON.stringify(codesFor(f)) === JSON.stringify([...f.expect].sort());

describe("H1: every fixture gets exactly the issue codes it should", () => {
  test.each(fixtures)("$name", (fixture) => {
    expect(codesFor(fixture)).toEqual([...fixture.expect].sort());
  });
});

// The eight classes the H1 claim names. Extra classes found later are welcome but cannot replace these.
const CLAIMED_CLASSES = ["no_trigger", "multi_trigger", "cycle", "orphan_node", "unknown_brick", "invalid_config", "bad_ref", "incompatible_wire"];

test("H1 report", ({ task }) => {
  const invalid = fixtures.filter((f) => f.expect.length > 0);
  const valid = fixtures.filter((f) => f.expect.length === 0);
  const classes = new Set(invalid.flatMap((f) => f.expect));

  record(task, {
    id: "H1",
    measured: countCodeLines(validatorSource),
    checks: {
      // All eight claimed classes must be covered, and every invalid fixture must get exactly its code.
      fixturesCatchAllEightClasses: CLAIMED_CLASSES.every((c) => classes.has(c as never)) && invalid.every(matches),
      validFixturePasses: valid.length === 1 && valid.every(matches),
    },
  });
});
