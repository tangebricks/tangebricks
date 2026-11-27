import { z } from "zod";

const EntrySchema = z.strictObject({
  title: z.string().min(1),
  from: z.string().min(1),
  kind: z.enum(["ported", "assertion-changed", "rewritten"]),
  why: z.string().optional(),
  /** The scoreboard check this test is evidence for, when a list serves several checks. */
  supports: z.string().optional(),
});

export const PortListSchema = z.strictObject({ version: z.literal(1), about: z.string(), tests: z.array(EntrySchema).min(1) }).superRefine((list, ctx) => {
  const titles = list.tests.map((t) => t.title);
  if (new Set(titles).size !== titles.length) ctx.addIssue({ code: "custom", message: "titles in the port list must be unique" });
  for (const t of list.tests) {
    if (t.kind !== "ported" && !t.why) ctx.addIssue({ code: "custom", message: `"${t.title}" is ${t.kind} and needs a reason` });
  }
});

export type PortList = z.infer<typeof PortListSchema>;

export interface TestOutcome {
  /** Vitest's full name for the test: the describe titles then the test title, joined by " > ". */
  name: string;
  /** The test file it ran in, as the reporter recorded it. */
  file?: string;
  state: "passed" | "failed" | "skipped" | "pending" | string;
}

export interface PortCheck {
  ok: boolean;
  /** One line for each listed test that is missing, ambiguous or not passing. */
  problems: string[];
}

/**
 * A listed test counts only if exactly one test whose title is that string ran and passed. A test that was deleted,
 * renamed, skipped, failing or listed twice by title is a problem, so the list cannot be met by quietly dropping a hard case.
 */
export function checkPortedTests(list: PortList, outcomes: TestOutcome[]): PortCheck {
  const problems: string[] = [];
  for (const { title } of list.tests) {
    const matching = outcomes.filter((o) => o.name === title || o.name.endsWith(` > ${title}`));
    if (matching.length === 0) problems.push(`not found: ${title}`);
    else if (matching.length > 1) problems.push(`ambiguous (${matching.length} tests): ${title}`);
    else if (matching[0]!.state !== "passed") problems.push(`${matching[0]!.state}: ${title}`);
  }
  return { ok: problems.length === 0, problems };
}
