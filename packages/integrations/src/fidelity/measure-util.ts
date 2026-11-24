export function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function sanitizeIdentifier(r: string | undefined): string {
  if (typeof r !== "string") return "param";
  const c = r
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([0-9])/, "_$1")
    .slice(0, 64);
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(c) ? c : "param";
}

export function dereference(root: any, target: any, depth = 0): any {
  if (!isObject(target)) return {};
  if (typeof target.$ref === "string" && depth < 20) {
    const parts = target.$ref
      .replace(/^#\//, "")
      .split("/")
      .map((p: string) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    let curr = root;
    for (const p of parts) {
      if (!isObject(curr)) return target;
      curr = curr[p];
    }
    if (isObject(curr)) {
      return dereference(root, { ...curr, ...target, $ref: undefined }, depth + 1);
    }
  }
  return target;
}
