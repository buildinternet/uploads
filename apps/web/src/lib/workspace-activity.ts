/**
 * Usage tab activity section: three window totals (uploads, PRs with uploads,
 * PR comment updates) that double as the switch for one daily bar chart.
 * Pure string renderers, so the page's SSR first paint and the client
 * re-render after a window or metric change produce the same markup.
 *
 * The API returns a fixed 180-day series (`apps/api/src/workspace-activity.ts`);
 * every window and its previous-period comparison is sliced from it here.
 *
 * On the Uploads chart, days with an Analytics Engine type split stack image,
 * video and other like the operator chart. The split is sampled, so each bar
 * keeps the D1 upload count as its height and only takes its proportions
 * from the split (`splitUploads`).
 */
import type { WorkspaceActivityResponse } from "@uploads/api/workspace-settings";
import {
  buildYTicks,
  formatAxisNumber,
  formatChartDay,
  niceCeil,
  pickLabelIndices,
  xLabelAnchor,
} from "./admin-metrics-chart";
import { escapeHtml, formatCount } from "./workspace-ui";

export type ActivityDay = WorkspaceActivityResponse["days"][number];
export type ActivityMetric = "uploads" | "prs" | "comments";

export const ACTIVITY_WINDOWS = [7, 30, 90] as const;
export type ActivityWindow = (typeof ACTIVITY_WINDOWS)[number];
export const DEFAULT_ACTIVITY_WINDOW: ActivityWindow = 30;

export const ACTIVITY_METRICS: readonly { key: ActivityMetric; label: string }[] = [
  { key: "uploads", label: "Uploads" },
  { key: "prs", label: "PRs with uploads" },
  { key: "comments", label: "PR comment updates" },
];

export const UPLOAD_TYPE_KEYS = ["image", "video", "other"] as const;
export type UploadTypeKey = (typeof UPLOAD_TYPE_KEYS)[number];
const UPLOAD_TYPE_LABELS: Record<UploadTypeKey, string> = {
  image: "Images",
  video: "Videos",
  other: "Other",
};

/** "1 image", "3 images", "2 other". */
function typeNoun(key: UploadTypeKey, n: number): string {
  if (key === "other") return "other";
  return n === 1 ? key : `${key}s`;
}

/**
 * Splits a day's D1 upload count by its sampled type proportions, rounding
 * by largest remainder so the parts always add up to `uploads`. `null` when
 * the day has no split, or the split is empty while uploads is not.
 */
export function splitUploads(day: ActivityDay): Record<UploadTypeKey, number> | null {
  const types = day.types;
  if (!types) return null;
  const sampled = types.image + types.video + types.other;
  if (sampled <= 0) return day.uploads === 0 ? { image: 0, video: 0, other: 0 } : null;
  const exact = UPLOAD_TYPE_KEYS.map((key) => (types[key] / sampled) * day.uploads);
  const parts = exact.map(Math.floor);
  let left = day.uploads - parts.reduce((n, v) => n + v, 0);
  const order = exact
    .map((v, i) => ({ i, rem: v - Math.floor(v) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return { image: parts[0]!, video: parts[1]!, other: parts[2]! };
}

export function parseActivityWindow(raw: unknown): ActivityWindow {
  const n = Number(raw);
  return (ACTIVITY_WINDOWS as readonly number[]).includes(n)
    ? (n as ActivityWindow)
    : DEFAULT_ACTIVITY_WINDOW;
}

export interface WindowTotal {
  current: number;
  /** The same-length period just before; `null` when the series is too short. */
  previous: number | null;
}

/** Sum of `metric` over the last `window` days, and over the `window` days before. */
export function windowTotal(
  days: readonly ActivityDay[],
  metric: ActivityMetric,
  window: number,
): WindowTotal {
  const sum = (slice: readonly ActivityDay[]) => slice.reduce((n, d) => n + d[metric], 0);
  const current = sum(days.slice(-window));
  const previous = days.length >= window * 2 ? sum(days.slice(-window * 2, -window)) : null;
  return { current, previous };
}

/** "+12% vs prior 30 days", "Same as prior 30 days", or "" when there is no baseline. */
export function changeLabel(total: WindowTotal, window: number): string {
  const { current, previous } = total;
  if (previous === null || (previous === 0 && current === 0)) return "";
  const period = `prior ${window} days`;
  if (previous === 0) return `Up from 0 the ${period}`;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return `Same as ${period}`;
  return `${pct > 0 ? "+" : "−"}${formatCount(Math.abs(pct))}% vs ${period}`;
}

function renderTilesHtml(
  days: readonly ActivityDay[],
  window: number,
  selected: ActivityMetric,
): string {
  return ACTIVITY_METRICS.map(({ key, label }) => {
    const total = windowTotal(days, key, window);
    const change = changeLabel(total, window);
    return `<button type="button" class="activity-tile" data-metric="${key}" aria-pressed="${key === selected}">
        <span class="activity-tile-label">${escapeHtml(label)}</span>
        <span class="activity-tile-value">${escapeHtml(formatCount(total.current))}</span>
        <span class="activity-tile-change">${escapeHtml(change) || "&nbsp;"}</span>
      </button>`;
  }).join("");
}

/** Shorter than the operator chart's 960×400: this sits under three tiles. */
const VIEW = { W: 960, H: 260, left: 48, right: 24, top: 12, bottom: 32 } as const;

function roundedTopRectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return "";
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h} Z`;
}

export function renderActivityChartHtml(
  days: readonly ActivityDay[],
  window: number,
  metric: ActivityMetric,
): string {
  const label = ACTIVITY_METRICS.find((m) => m.key === metric)?.label ?? metric;
  const points = days.slice(-window);
  const values = points.map((d) => Math.max(0, d[metric]));
  const niceMax = niceCeil(Math.max(1, ...values));
  const { W, H, left, right, top, bottom } = VIEW;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const baseline = top + plotH;
  const band = plotW / Math.max(1, points.length);
  const gap = Math.min(8, Math.max(2, band * 0.25));
  const barW = Math.max(1, Math.min(28, band - gap));
  const labelIdx = pickLabelIndices(points.length);

  const grid = buildYTicks(niceMax)
    .map((t) => {
      const v = Math.round(t);
      const y = baseline - (v / niceMax) * plotH;
      return (
        `<line x1="${left}" y1="${y}" x2="${W - right}" y2="${y}" class="metrics-gridline" />` +
        `<text x="${left - 8}" y="${y}" class="metrics-axis-label" text-anchor="end" dominant-baseline="middle">${escapeHtml(formatAxisNumber(v))}</text>`
      );
    })
    .join("");

  const lower = label.toLowerCase();
  const splits = metric === "uploads" ? points.map(splitUploads) : points.map(() => null);
  const stacked = splits.some((split) => split !== null);
  const bars = points
    .map((point, i) => {
      const value = values[i];
      const h = (value / niceMax) * plotH;
      const x = left + i * band + (band - barW) / 2;
      const day = escapeHtml(formatChartDay(point.day));
      const split = splits[i];
      let fills: string;
      let detail = "";
      if (split) {
        // Stack bottom-up; only the topmost non-empty segment gets the rounded top.
        const topKey = [...UPLOAD_TYPE_KEYS].reverse().find((key) => split[key] > 0);
        let cursor = baseline;
        fills = UPLOAD_TYPE_KEYS.map((key) => {
          const segH = (split[key] / niceMax) * plotH;
          const y = cursor - segH;
          cursor = y;
          if (segH <= 0) return "";
          const d =
            key === topKey
              ? roundedTopRectPath(x, y, barW, segH, 4)
              : `M${x},${y} H${x + barW} V${y + segH} H${x} Z`;
          return `<path d="${d}" class="metrics-bar-fill metrics-bar-fill--${key}" />`;
        }).join("");
        detail = ` (${UPLOAD_TYPE_KEYS.map(
          (key) => `${formatCount(split[key])} ${typeNoun(key, split[key])}`,
        ).join(", ")})`;
      } else {
        const path = roundedTopRectPath(x, baseline - h, barW, h, 4);
        fills = path ? `<path d="${path}" class="metrics-bar-fill" />` : "";
      }
      const xLabel = labelIdx.has(i)
        ? `<text x="${x + barW / 2}" y="${H - 8}" class="metrics-axis-label" text-anchor="${xLabelAnchor(i, points.length)}">${day}</text>`
        : "";
      return `<g class="metrics-bar"><title>${day}: ${escapeHtml(formatCount(value))} ${escapeHtml(lower)}${escapeHtml(detail)}</title>${fills}<rect class="activity-bar-hit" x="${x - gap / 2}" y="${top}" width="${barW + gap}" height="${plotH}" />${xLabel}</g>`;
    })
    .join("");

  const legend = stacked
    ? `<div class="metrics-legend">${UPLOAD_TYPE_KEYS.map(
        (key) =>
          `<span class="metrics-legend-item"><span class="metrics-legend-swatch metrics-legend-swatch--${key}"></span>${UPLOAD_TYPE_LABELS[key]}</span>`,
      ).join("")}</div>`
    : "";

  const rows = points
    .map(
      (point, i) =>
        `<tr><td>${escapeHtml(point.day)}</td><td>${escapeHtml(formatCount(values[i]))}</td></tr>`,
    )
    .join("");

  return `<svg class="metrics-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)} per day, last ${window} days">
      <line x1="${left}" y1="${baseline}" x2="${W - right}" y2="${baseline}" class="metrics-axis-line" />
      ${grid}
      ${bars}
    </svg>
    ${legend}
    <table class="sr-only">
      <caption>${escapeHtml(label)} per day</caption>
      <thead><tr><th scope="col">Day (UTC)</th><th scope="col">${escapeHtml(label)}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Tiles + chart for `#ws-activity-body`. */
export function renderActivityBodyHtml(
  activity: WorkspaceActivityResponse,
  window: number,
  metric: ActivityMetric,
): string {
  return `<div class="activity-tiles" role="group" aria-label="Chart metric">${renderTilesHtml(
    activity.days,
    window,
    metric,
  )}</div>
    <div class="activity-chart">${renderActivityChartHtml(activity.days, window, metric)}</div>`;
}
