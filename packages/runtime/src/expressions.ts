/**
 * Pure, deterministic step-output expression resolver & validator (`C1`).
 * Never uses `eval` or `new Function`. Explicitly rejects prototype-chain properties
 * (`__proto__`, `constructor`, `prototype`).
 */

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export interface ParsedPillExpression {
  raw: string;
  token: string;
  sourceKind: "steps" | "trigger";
  nodeId?: string;
  portId: string;
  fieldPath: string;
}

export interface StepExpressionValidationResult {
  ok: boolean;
  errors: string[];
  reason?: string;
}

export function isSafePropertySegment(segment: string): boolean {
  return Boolean(segment) && !FORBIDDEN_SEGMENTS.has(segment);
}

export function hasForbiddenSegment(path: string): string | null {
  for (const segment of path.split(".").map((s) => s.trim()).filter(Boolean)) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return segment;
    }
  }
  return null;
}

/**
 * Pure property-path traversal using `Object.hasOwn`.
 */
export function traverseSafePropertyPath(
  root: unknown,
  segments: readonly string[],
): unknown {
  let current: unknown = root;
  for (const seg of segments) {
    if (!isSafePropertySegment(seg)) {
      return undefined;
    }
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(seg)) return undefined;
      const idx = Number(seg);
      if (!Object.hasOwn(current, idx)) return undefined;
      current = current[idx];
      continue;
    }
    if (!Object.hasOwn(current, seg)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function parsePillToken(rawToken: string): ParsedPillExpression | null {
  const token = rawToken.trim();
  if (!token) return null;

  const parts = token.split(".").map((p) => p.trim());
  if (parts[0] === "steps") {
    if (parts.length < 3) return null;
    const nodeId = parts[1];
    const portId = parts[2];
    if (!nodeId || !portId) return null;
    const fieldPath = parts.slice(3).join(".");
    return {
      raw: `{{${rawToken}}}`,
      token,
      sourceKind: "steps",
      nodeId,
      portId,
      fieldPath,
    };
  }

  if (parts[0] === "trigger") {
    if (parts.length < 2) return null;
    const second = parts[1]!;
    if (second === "output" || second === "out") {
      return {
        raw: `{{${rawToken}}}`,
        token,
        sourceKind: "trigger",
        portId: second,
        fieldPath: parts.slice(2).join("."),
      };
    }
    return {
      raw: `{{${rawToken}}}`,
      token,
      sourceKind: "trigger",
      portId: "output",
      fieldPath: parts.slice(1).join("."),
    };
  }

  return null;
}

function resolveFromSourceRecord(
  sourceRecord: unknown,
  portId: string,
  fieldPath: string,
): unknown {
  if (sourceRecord === null || sourceRecord === undefined || typeof sourceRecord !== "object") {
    return undefined;
  }

  const forbiddenInPort = hasForbiddenSegment(portId);
  const forbiddenInField = hasForbiddenSegment(fieldPath);
  if (forbiddenInPort || forbiddenInField) {
    return undefined;
  }

  const rec = sourceRecord as Record<string, unknown>;
  const segments = fieldPath ? fieldPath.split(".").filter(Boolean) : [];

  if (portId === "output" || portId === "out") {
    // 1. Check `rec.output`
    if (Object.hasOwn(rec, "output") && rec.output !== undefined) {
      if (segments.length === 0) return rec.output;
      const fromOutput = traverseSafePropertyPath(rec.output, segments);
      if (fromOutput !== undefined) return fromOutput;
    }
    // 2. Check `rec.out` (standard @poc/runtime executor port)
    if (Object.hasOwn(rec, "out") && rec.out !== undefined) {
      if (segments.length === 0) return rec.out;
      const fromOut = traverseSafePropertyPath(rec.out, segments);
      if (fromOut !== undefined) return fromOut;
    }
    // 3. Fallback: direct property on `rec`
    if (segments.length === 0) return rec;
    return traverseSafePropertyPath(rec, segments);
  }

  // Specific portId (e.g. `steps.node_1.record.id` or `steps.node_1.col-customer_email`)
  if (Object.hasOwn(rec, portId)) {
    const portVal = rec[portId];
    if (segments.length === 0) return portVal;
    const fromPort = traverseSafePropertyPath(portVal, segments);
    if (fromPort !== undefined) return fromPort;
  }

  const combined = [portId, ...segments];
  const fromOutput = Object.hasOwn(rec, "output")
    ? traverseSafePropertyPath(rec.output, combined)
    : undefined;
  if (fromOutput !== undefined) return fromOutput;

  const fromOut = Object.hasOwn(rec, "out")
    ? traverseSafePropertyPath(rec.out, combined)
    : undefined;
  if (fromOut !== undefined) return fromOut;

  return traverseSafePropertyPath(rec, combined);
}

function resolveParsedPill(
  parsed: ParsedPillExpression,
  stepOutputsByNodeId: Readonly<Record<string, unknown>>,
  triggerOutput?: unknown,
): unknown {
  if (
    (parsed.nodeId && hasForbiddenSegment(parsed.nodeId)) ||
    hasForbiddenSegment(parsed.portId) ||
    hasForbiddenSegment(parsed.fieldPath)
  ) {
    return undefined;
  }

  if (parsed.sourceKind === "trigger") {
    const trigCandidate =
      triggerOutput !== undefined
        ? triggerOutput
        : Object.hasOwn(stepOutputsByNodeId, "trigger")
          ? stepOutputsByNodeId["trigger"]
          : undefined;
    return resolveFromSourceRecord(trigCandidate, parsed.portId, parsed.fieldPath);
  }

  const nodeId = parsed.nodeId!;
  if (!Object.hasOwn(stepOutputsByNodeId, nodeId)) {
    return undefined;
  }
  const nodeOut = stepOutputsByNodeId[nodeId];
  return resolveFromSourceRecord(nodeOut, parsed.portId, parsed.fieldPath);
}

const SINGLE_PILL_PATTERN = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const ANY_PILL_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Resolves `{{steps.<nodeId>.output.<fieldPath>}}` and `{{trigger.output.<fieldPath>}}`
 * expressions against completed upstream step outputs (`C1` pure property-path reader).
 *
 * - Single pill string `"{{steps.node_1.output.amount}}"` preserves the underlying primitive/object/array type.
 * - Multi-pill or embedded string `"Invoice {{steps.node_1.output.id}}"` interpolates each pill as a string.
 * - Non-step placeholders (e.g. `"{{value}}"` for `core.format_template`) are left untouched.
 */
export function resolveStepExpressions(
  value: unknown,
  stepOutputsByNodeId: Readonly<Record<string, unknown>>,
  triggerOutput?: unknown,
): unknown {
  if (typeof value === "string") {
    const singleMatch = SINGLE_PILL_PATTERN.exec(value);
    if (singleMatch) {
      const inner = singleMatch[1]!.trim();
      for (const seg of inner.split(".")) {
        if (FORBIDDEN_SEGMENTS.has(seg.trim())) {
          return undefined;
        }
      }
      const parsed = parsePillToken(inner);
      if (!parsed) {
        return value;
      }
      return resolveParsedPill(parsed, stepOutputsByNodeId, triggerOutput);
    }

    if (!value.includes("{{")) {
      return value;
    }

    return value.replace(ANY_PILL_PATTERN, (fullMatch, rawInner: string) => {
      const inner = rawInner.trim();
      for (const seg of inner.split(".")) {
        if (FORBIDDEN_SEGMENTS.has(seg.trim())) {
          return "";
        }
      }
      const parsed = parsePillToken(inner);
      if (!parsed) {
        return fullMatch;
      }
      const resolved = resolveParsedPill(parsed, stepOutputsByNodeId, triggerOutput);
      if (resolved === undefined || resolved === null) {
        return "";
      }
      return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      resolveStepExpressions(item, stepOutputsByNodeId, triggerOutput),
    );
  }

  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_SEGMENTS.has(k)) continue;
      out[k] = resolveStepExpressions(v, stepOutputsByNodeId, triggerOutput);
    }
    return out;
  }

  return value;
}

/**
 * Extracts all `{{steps.<nodeId>.output.<fieldPath>}}` / `{{trigger.output.<fieldPath>}}` pills from a string.
 */
export function extractStepExpressionPills(input: string): ParsedPillExpression[] {
  if (typeof input !== "string" || !input.includes("{{")) {
    return [];
  }
  const pills: ParsedPillExpression[] = [];
  for (const match of input.matchAll(ANY_PILL_PATTERN)) {
    const parsed = parsePillToken(match[1] ?? "");
    if (parsed) {
      pills.push({
        ...parsed,
        raw: match[0],
      });
    }
  }
  return pills;
}

/**
 * Extracts template placeholder names (`{name}` or `{{name}}` excluding `steps.*` and `trigger.*`).
 */
export function extractTemplatePlaceholders(template: string): string[] {
  if (typeof template !== "string" || !template.trim()) return [];
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
    const token = (match[1] ?? "").trim();
    if (!token || token.startsWith("steps.") || token.startsWith("trigger.")) continue;
    const root = token.split(".")[0]!;
    if (root && !FORBIDDEN_SEGMENTS.has(root)) {
      found.add(root);
    }
  }
  for (const match of template.matchAll(/(?<!\{)\{\s*([a-zA-Z0-9_]+)\s*\}(?!\})/g)) {
    const token = (match[1] ?? "").trim();
    if (token && !FORBIDDEN_SEGMENTS.has(token)) {
      found.add(token);
    }
  }
  return [...found];
}

/**
 * Validates a string containing `{{steps.<nodeId>.output.<fieldPath>}}` expressions against
 * the set of upstream ancestor nodes and their declared output schemas.
 */
export function validateStepExpression(
  input: string,
  ancestorNodeOutputs: Readonly<
    Record<string, ReadonlyArray<string> | Readonly<Record<string, unknown>>>
  >,
): StepExpressionValidationResult {
  const errors: string[] = [];
  if (typeof input !== "string" || (!input.includes("{{") && !input.includes("}}"))) {
    return { ok: true, errors };
  }

  // Check balanced '{{' and '}}'
  const stripped = input.replace(ANY_PILL_PATTERN, "");
  if (stripped.includes("{{") || stripped.includes("}}")) {
    errors.push("Unbalanced '{{' or '}}' delimiters in expression.");
    return { ok: false, errors, reason: errors[0] };
  }

  for (const match of input.matchAll(ANY_PILL_PATTERN)) {
    const rawInner = (match[1] ?? "").trim();
    if (!rawInner) {
      errors.push("Empty '{{}}' expression is not allowed.");
      continue;
    }

    const forbidden = hasForbiddenSegment(rawInner);
    if (forbidden) {
      errors.push(`Unsafe property segment '${forbidden}' is forbidden.`);
      continue;
    }

    const parsed = parsePillToken(rawInner);
    if (!parsed) {
      // Check if it looks like a malformed steps.* expression
      if (rawInner.startsWith("steps") || rawInner.includes("steps.")) {
        errors.push(
          `Invalid pill syntax '{{${rawInner}}}'. Expected {{steps.<nodeId>.output.<fieldPath>}}.`,
        );
      }
      continue;
    }

    if (parsed.sourceKind === "steps") {
      const nodeId = parsed.nodeId!;
      if (!Object.hasOwn(ancestorNodeOutputs, nodeId)) {
        errors.push(`Node '${nodeId}' is not an upstream ancestor of this step.`);
        continue;
      }

      if (!parsed.fieldPath) {
        errors.push(
          `Missing output field path in '{{${rawInner}}}'. Expected {{steps.${nodeId}.output.<field>}}.`,
        );
        continue;
      }

      const rootField = parsed.fieldPath.split(".")[0]!;
      const schemaEntry = ancestorNodeOutputs[nodeId];
      if (Array.isArray(schemaEntry)) {
        if (
          schemaEntry.length > 0 &&
          !schemaEntry.includes("*") &&
          !schemaEntry.includes(parsed.fieldPath) &&
          !schemaEntry.includes(rootField)
        ) {
          errors.push(
            `Field '${parsed.fieldPath}' does not exist on upstream node '${nodeId}'.`,
          );
        }
      } else if (typeof schemaEntry === "object" && schemaEntry !== null) {
        const keys = Object.keys(schemaEntry);
        if (
          keys.length > 0 &&
          !Object.hasOwn(schemaEntry, "*") &&
          !Object.hasOwn(schemaEntry, parsed.fieldPath) &&
          !Object.hasOwn(schemaEntry, rootField)
        ) {
          errors.push(
            `Field '${parsed.fieldPath}' does not exist on upstream node '${nodeId}'.`,
          );
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    ...(errors[0] ? { reason: errors[0] } : {}),
  };
}
