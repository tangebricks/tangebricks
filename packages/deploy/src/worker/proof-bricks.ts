import { z } from "zod";
import { createRegistry, toyRegistry } from "@poc/sdk";
import type { BrickManifest, Executor } from "@poc/sdk";
import { toyExecutors } from "@poc/runtime";

// The bricks the deployed Workflow can run: the repository's toy bricks (trigger, pick, delay, join, boom, text sink)
// plus an adder and a multiplier. They exist for the proof of H11 only and are not part of any real project: H11 is about
// WHERE a graph lives and how it is run, not about what its nodes compute. Their behaviour is deliberately plain, so
// the expected answer to a graph is something a person can work out by hand.

function number(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${what} is not a finite number`);
  return value;
}

const binary = (type: string): BrickManifest => ({
  type,
  category: "transform",
  inputs: [
    { id: "a", dataType: "json" },
    { id: "b", dataType: "json" },
  ],
  outputs: [{ id: "out", dataType: "json" }],
  configSchema: z.object({}),
  secrets: [],
});

export const PROOF_BRICKS: BrickManifest[] = [binary("proof.add"), binary("proof.multiply")];

export const proofRegistry = createRegistry([...toyRegistry.values(), ...PROOF_BRICKS]);

export const proofExecutors: ReadonlyMap<string, Executor> = new Map<string, Executor>([
  ...toyExecutors,
  ["proof.add", ({ inputs }) => ({ out: number(inputs.a, "input a") + number(inputs.b, "input b") })],
  ["proof.multiply", ({ inputs }) => ({ out: number(inputs.a, "input a") * number(inputs.b, "input b") })],
]);
