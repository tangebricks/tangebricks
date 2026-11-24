import { z } from "zod";
import { rangesOverlap } from "./range.ts";

const RangeSchema = z
  .strictObject({
    lt: z.number().optional(),
    max: z.number().optional(),
    gt: z.number().optional(),
    min: z.number().optional(),
  })
  .refine((r) => Object.keys(r).length > 0, { message: "a range needs at least one bound" });

const Base = {
  id: z.string().regex(/^H\d+$/, "id must look like H1"),
  title: z.string().min(1),
  epic: z.string().min(1),
};

const LiveSchema = z
  .strictObject({
    ...Base,
    status: z.literal("live"),
    /** The one number this hypothesis is judged on, if any. */
    metric: z.strictObject({ name: z.string().min(1), unit: z.string().min(1) }).nullable(),
    pass: RangeSchema.nullable(),
    kill: RangeSchema.nullable(),
    /** Named boolean checks a test must report true for a pass. */
    mustHold: z.array(z.string().min(1)),
    /** Checks whose falsity is a kill, not just a fail. Must also be in mustHold. */
    killIfFalse: z.array(z.string().min(1)),
    /**
     * Extra evidence that can only ever overturn a verdict: a kill if reported false, no effect on a pass if never
     * reported (the scoreboard says it has not been run). Not in mustHold, so adding one later does not turn a pass
     * into a fail; the rule must be written down before the evidence exists.
     */
    killIfFalseWhenReported: z.array(z.string().min(1)).optional(),
    /** A kill only a person can declare; printed with a fail or kill, never computed. */
    note: z.string().optional(),
    /** What a pass does not show; printed under the row whatever the verdict (except pending). */
    caveat: z.string().optional(),
  })
  .superRefine((h, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (h.metric === null && (h.pass !== null || h.kill !== null)) fail("pass and kill ranges need a metric");
    if (h.metric !== null && h.pass === null) fail("a metric needs a pass range");
    if (h.metric === null && h.mustHold.length === 0) fail("a live hypothesis needs a metric or at least one check");
    if (h.pass && h.kill && rangesOverlap(h.pass, h.kill)) fail("pass and kill ranges overlap");
    for (const name of h.killIfFalse) {
      if (!h.mustHold.includes(name)) fail(`killIfFalse check "${name}" is not in mustHold`);
    }
    for (const name of h.killIfFalseWhenReported ?? []) {
      if (h.mustHold.includes(name)) fail(`killIfFalseWhenReported check "${name}" is already in mustHold`);
    }
  });

const PendingSchema = z.strictObject({ ...Base, status: z.literal("pending") });

export const HypothesisSchema = z.discriminatedUnion("status", [LiveSchema, PendingSchema]);

export const HypothesesFileSchema = z
  .strictObject({
    version: z.literal(1),
    hypotheses: z.array(HypothesisSchema).min(1),
  })
  .refine((f) => new Set(f.hypotheses.map((h) => h.id)).size === f.hypotheses.length, {
    message: "hypothesis ids must be unique",
  });

export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type LiveHypothesis = Extract<Hypothesis, { status: "live" }>;
export type HypothesesFile = z.infer<typeof HypothesesFileSchema>;

export function parseHypotheses(raw: unknown): HypothesesFile {
  return HypothesesFileSchema.parse(raw);
}
