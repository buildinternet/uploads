/**
 * Scale, label, and calendar-density helpers for the operator metrics
 * charts (`/admin/metrics`). The page still owns SVG markup and hover
 * wiring; this module is the bit that was getting the axis and the day
 * buckets wrong.
 *
 * SVG `px` is a user unit. `--text-micro` (12px) inside a 480-wide
 * viewBox therefore paints ~12/480 of the chart width — huge once the
 * SVG stretches to the admin content column, which clips "1,000" to
 * ",000" and truncates the last date. The viewBox below is sized near a
 * typical desktop render so a 11px tick stays about 11 CSS pixels.
 */

const DAY_RE = /^(\d{4}-\d{2}-\d{2})/;

export const CHART_VIEW = {
  W: 960,
  H: 400,
  marginLeft: 56,
  marginRight: 32,
  marginTop: 16,
  marginBottom: 40,
} as const;

const DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function normalizeUtcDay(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = DAY_RE.exec(raw.trim());
  return match?.[1] ?? null;
}

export function utcDaysInWindow(since: string, days: number): string[] {
  const start = new Date(`${since}T00:00:00.000Z`);
  const count = Math.max(0, Math.floor(days));
  if (Number.isNaN(start.getTime()) || count === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

export function fillCountSeries(
  since: string,
  days: number,
  points: readonly { day: string; value: number }[],
): { day: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const point of points) {
    const day = normalizeUtcDay(point.day);
    if (day) byDay.set(day, Math.max(0, Number(point.value) || 0));
  }
  return utcDaysInWindow(since, days).map((day) => ({
    day,
    value: byDay.get(day) ?? 0,
  }));
}

export interface UploadClassDay {
  day: string;
  image: number;
  video: number;
  other: number;
}

export function fillUploadClassSeries(
  since: string,
  days: number,
  points: readonly UploadClassDay[],
): UploadClassDay[] {
  const byDay = new Map<string, UploadClassDay>();
  for (const point of points) {
    const day = normalizeUtcDay(point.day);
    if (!day) continue;
    byDay.set(day, {
      day,
      image: Math.max(0, Number(point.image) || 0),
      video: Math.max(0, Number(point.video) || 0),
      other: Math.max(0, Number(point.other) || 0),
    });
  }
  return utcDaysInWindow(since, days).map(
    (day) => byDay.get(day) ?? { day, image: 0, video: 0, other: 0 },
  );
}

/** Round a positive max up to a "clean" axis ceiling (1/2/5/10 * 10^n). */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const frac = value / base;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * base;
}

/**
 * Y-axis tick values for a [0, niceMax] scale: 0, the midpoint, and
 * niceMax. The midpoint is dropped when rounding it for display would
 * collide with either endpoint's rounded label.
 */
export function buildYTicks(niceMax: number): number[] {
  const raw = [0, niceMax / 2, niceMax];
  const rounded = raw.map((t) => Math.round(t));
  if (rounded[1] === rounded[0] || rounded[1] === rounded[2]) {
    return [raw[0], raw[2]];
  }
  return raw;
}

/**
 * Compact tick text so thousands fit in the left gutter. `niceCeil` only
 * yields 1/2/5 × 10^n, so these never need a decimal except at 1.5k-style
 * midpoints (which `buildYTicks` already drops when they'd collide).
 */
export function formatAxisNumber(value: number): string {
  const n = Math.round(value);
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${Number.isInteger(millions) ? String(millions) : millions.toFixed(1)}M`;
  }
  if (abs >= 1000) {
    const thousands = n / 1000;
    return `${Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1)}k`;
  }
  return String(n);
}

export function formatChartDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return DAY_FORMATTER.format(date);
}

/** Evenly spaced x-axis label indices, always including the last day. */
export function pickLabelIndices(n: number, max = 7): Set<number> {
  if (n <= 0) return new Set();
  if (n <= max) return new Set(Array.from({ length: n }, (_, i) => i));
  const step = Math.max(1, Math.ceil(n / max));
  const idx = new Set<number>();
  for (let i = 0; i < n; i += step) idx.add(i);
  idx.add(n - 1);
  return idx;
}

/** Pin the first and last date labels inside the plot instead of centering them off the edge. */
export function xLabelAnchor(index: number, n: number): "start" | "middle" | "end" {
  if (index === 0) return "start";
  if (index === n - 1) return "end";
  return "middle";
}

export function chartPlot(): {
  plotW: number;
  plotH: number;
  baseline: number;
} {
  const { W, H, marginLeft, marginRight, marginTop, marginBottom } = CHART_VIEW;
  return {
    plotW: W - marginLeft - marginRight,
    plotH: H - marginTop - marginBottom,
    baseline: marginTop + (H - marginTop - marginBottom),
  };
}
