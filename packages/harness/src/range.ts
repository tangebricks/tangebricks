/** A numeric range. Every bound that is present must hold: lt/gt are strict, max/min inclusive. */
export interface Range {
  lt?: number;
  max?: number;
  gt?: number;
  min?: number;
}

interface Bound {
  value: number;
  open: boolean;
}

export function inRange(value: number, r: Range): boolean {
  return (
    (r.lt === undefined || value < r.lt) &&
    (r.max === undefined || value <= r.max) &&
    (r.gt === undefined || value > r.gt) &&
    (r.min === undefined || value >= r.min)
  );
}

function lower(r: Range): Bound {
  const candidates: Bound[] = [];
  if (r.gt !== undefined) candidates.push({ value: r.gt, open: true });
  if (r.min !== undefined) candidates.push({ value: r.min, open: false });
  if (candidates.length === 0) return { value: -Infinity, open: true };
  return candidates.reduce((a, b) => (b.value > a.value || (b.value === a.value && b.open) ? b : a));
}

function upper(r: Range): Bound {
  const candidates: Bound[] = [];
  if (r.lt !== undefined) candidates.push({ value: r.lt, open: true });
  if (r.max !== undefined) candidates.push({ value: r.max, open: false });
  if (candidates.length === 0) return { value: Infinity, open: true };
  return candidates.reduce((a, b) => (b.value < a.value || (b.value === a.value && b.open) ? b : a));
}

/** True when some number satisfies both ranges. Used to reject contradictory pass and kill thresholds. */
export function rangesOverlap(a: Range, b: Range): boolean {
  const la = lower(a);
  const lb = lower(b);
  const lo = la.value > lb.value ? la : lb.value > la.value ? lb : la.open ? la : lb;
  const ua = upper(a);
  const ub = upper(b);
  const hi = ua.value < ub.value ? ua : ub.value < ua.value ? ub : ua.open ? ua : ub;
  if (lo.value < hi.value) return true;
  if (lo.value === hi.value) return !lo.open && !hi.open;
  return false;
}
