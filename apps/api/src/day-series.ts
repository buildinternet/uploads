/**
 * Calendar-dense day series for operator metrics charts.
 *
 * `daily_metrics` and the auth signup query are sparse: a day with no
 * activity has no row. Charts need every UTC day in the selected window so
 * bar spacing matches real time, with an explicit 0 on quiet days.
 */

import { utcDay } from "./adoption";

const DAY_RE = /^(\d{4}-\d{2}-\d{2})/;

/** First `YYYY-MM-DD` in a string, or null if the value is not a date. */
export function normalizeUtcDay(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = DAY_RE.exec(raw.trim());
  return match?.[1] ?? null;
}

/**
 * Inclusive UTC days from `since` for `days` buckets. `days = 1` is
 * `since` only. Invalid `since` yields an empty list rather than a
 * NaN-walked calendar.
 */
export function utcDaysInWindow(since: string, days: number): string[] {
  const start = new Date(`${since}T00:00:00.000Z`);
  const count = Math.max(0, Math.floor(days));
  if (Number.isNaN(start.getTime()) || count === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    out.push(utcDay(day));
  }
  return out;
}

/**
 * Reindex `points` onto every calendar day in the window. Days with no
 * matching point get `empty(day)`. Out-of-window points are dropped.
 */
export function fillDaySeries<T>(
  since: string,
  days: number,
  points: readonly T[],
  empty: (day: string) => T,
  dayOf: (point: T) => string = (point) => (point as { day: string }).day,
): T[] {
  const byDay = new Map<string, T>();
  for (const point of points) {
    const day = normalizeUtcDay(dayOf(point));
    if (day) byDay.set(day, point);
  }
  return utcDaysInWindow(since, days).map((day) => byDay.get(day) ?? empty(day));
}
