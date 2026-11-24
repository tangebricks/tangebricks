export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const EXACT_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parse(v: string): SemVer | null {
  const trimmed = v.trim();
  const m = EXACT_SEMVER.exec(trimmed);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

export function compare(a: string | SemVer, b: string | SemVer): number {
  const pa = typeof a === "string" ? parse(a) : a;
  const pb = typeof b === "string" ? parse(b) : b;
  if (!pa || !pb) {
    throw new Error(`Invalid semver: ${typeof a === "string" ? a : JSON.stringify(a)} vs ${typeof b === "string" ? b : JSON.stringify(b)}`);
  }
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const trimmed = range.trim();
  if (trimmed === "*" || trimmed === "") return true;

  if (trimmed.startsWith("^")) {
    const target = parse(trimmed.slice(1));
    if (!target) return false;
    if (compare(v, target) < 0) return false;
    if (target.major > 0) return v.major === target.major;
    if (target.minor > 0) return v.major === 0 && v.minor === target.minor;
    return v.major === 0 && v.minor === 0 && v.patch === target.patch;
  }

  if (trimmed.startsWith("~")) {
    const target = parse(trimmed.slice(1));
    if (!target) return false;
    if (compare(v, target) < 0) return false;
    return v.major === target.major && v.minor === target.minor;
  }

  if (trimmed.startsWith(">=")) {
    const target = parse(trimmed.slice(2));
    if (!target) return false;
    return compare(v, target) >= 0;
  }

  if (trimmed.startsWith("<=")) {
    const target = parse(trimmed.slice(2));
    if (!target) return false;
    return compare(v, target) <= 0;
  }

  if (trimmed.startsWith(">")) {
    const target = parse(trimmed.slice(1));
    if (!target) return false;
    return compare(v, target) > 0;
  }

  if (trimmed.startsWith("<")) {
    const target = parse(trimmed.slice(1));
    if (!target) return false;
    return compare(v, target) < 0;
  }

  // Exact version
  const exact = parse(trimmed);
  if (!exact) return false;
  return compare(v, exact) === 0;
}
