export interface ValuePattern {
  readonly kind: string;
  readonly regex: RegExp;
  readonly pattern: RegExp;
  readonly fastCheck?: string;
  readonly replace?: (match: string, ...args: any[]) => string;
}

interface ValuePatternDef {
  readonly kind: string;
  readonly regex: RegExp;
  readonly fastCheck?: string;
  readonly replace?: (match: string, ...args: any[]) => string;
}

function definePattern(def: ValuePatternDef): ValuePattern {
  return {
    kind: def.kind,
    regex: def.regex,
    get pattern(): RegExp {
      return def.regex;
    },
    fastCheck: def.fastCheck,
    replace: def.replace,
  };
}

export const VALUE_PATTERNS: readonly ValuePattern[] = [
  // 1. Bearer tokens in headers or logs (e.g. "Bearer <token>")
  definePattern({
    kind: "bearer",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b/gi,
    fastCheck: "Bearer",
  }),
  // 2. JSON Web Tokens (three base64url segments starting with eyJ)
  definePattern({
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g,
    fastCheck: "eyJ",
  }),
  // 3. Stripe secret and restricted API keys (sk_live_, sk_test_, rk_live_, rk_test_)
  definePattern({
    kind: "stripe",
    regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+\b/g,
  }),
  // 4. Stripe webhook signing secrets (whsec_)
  definePattern({
    kind: "stripe",
    regex: /\bwhsec_[A-Za-z0-9]+\b/g,
    fastCheck: "whsec_",
  }),
  // 5. GitHub Personal Access Tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  definePattern({
    kind: "github",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    fastCheck: "gh",
  }),
  // 6. GitHub fine-grained Personal Access Tokens (github_pat_)
  definePattern({
    kind: "github",
    regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    fastCheck: "github_pat_",
  }),
  // 7. Slack API tokens (xoxb-, xoxa-, xoxp-, xoxr-, xoxs-)
  definePattern({
    kind: "slack",
    regex: /\bxox[abposr]-[A-Za-z0-9-]+\b/g,
    fastCheck: "xox",
  }),
  // 8. AWS Access Key IDs (AKIA...)
  definePattern({
    kind: "aws",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    fastCheck: "AKIA",
  }),
  // 9. Google API Keys (AIza...)
  definePattern({
    kind: "google",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    fastCheck: "AIza",
  }),
  // 10. PEM private key blocks (-----BEGIN ... PRIVATE KEY-----)
  definePattern({
    kind: "pem",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g,
    fastCheck: "-----BEGIN",
  }),
  // 11. URL query parameter secrets (?key=..., &token=..., etc.)
  definePattern({
    kind: "url_query",
    regex: /([?&](?:key|token|sig|signature|access_token)=)(?!\[REDACTED)([^&\s"'>#]+)/gi,
    replace: (_match: string, p1: string) => `${p1}[REDACTED:url_query]`,
  }),
];

export function scrubValuePatterns(input: string, customPatterns?: Iterable<ValuePattern | { kind: string; regex?: RegExp; pattern?: RegExp }>): string {
  if (!input || typeof input !== "string") return input;
  let out = input;

  // 1. Built-in VALUE_PATTERNS
  for (const p of VALUE_PATTERNS) {
    if (p.fastCheck && !out.includes(p.fastCheck)) {
      continue;
    }
    const re = new RegExp(p.regex.source, p.regex.flags.includes("g") ? p.regex.flags : `${p.regex.flags}g`);
    if (p.replace) {
      out = out.replace(re, p.replace);
    } else {
      out = out.replace(re, `[REDACTED:${p.kind}]`);
    }
  }

  // 2. Additive custom patterns (e.g. from integration manifests or caller options)
  if (customPatterns) {
    for (const cp of customPatterns) {
      const reg = cp.regex ?? (cp as { pattern?: RegExp }).pattern;
      if (reg) {
        const re = new RegExp(reg.source, reg.flags.includes("g") ? reg.flags : `${reg.flags}g`);
        const replacer = (cp as { replace?: (m: string, ...args: any[]) => string }).replace;
        if (replacer) {
          out = out.replace(re, replacer);
        } else {
          out = out.replace(re, `[REDACTED:${cp.kind}]`);
        }
      }
    }
  }

  return out;
}
