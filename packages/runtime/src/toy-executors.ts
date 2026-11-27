import type { Executor } from "@poc/sdk";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Follows a dotted path ("a.b") through a value's own properties; undefined if any step is missing or inherited. */
function dig(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((at, key) => (typeof at === "object" && at !== null && Object.hasOwn(at, key) ? (at as Record<string, unknown>)[key] : undefined), value);
}

/** Behaviour for the toy bricks in @poc/sdk. Real bricks bring their own executors. */
export const toyExecutors: ReadonlyMap<string, Executor> = new Map<string, Executor>([
  ["trigger.manual", ({ payload }) => ({ out: payload })],
  ["transform.pick", ({ data, inputs }) => ({ out: dig(inputs.in, String(data.path)) })],
  ["sink.text", () => ({})],
  [
    "util.delay",
    async ({ data, inputs }) => {
      await sleep(Number(data.ms));
      return { out: inputs.in };
    },
  ],
  ["util.join", ({ inputs }) => ({ out: { a: inputs.a, b: inputs.b } })],
  [
    "util.boom",
    () => {
      throw new Error("boom");
    },
  ],
]);
