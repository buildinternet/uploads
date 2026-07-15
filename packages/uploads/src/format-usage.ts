/**
 * Human formatting for `uploads usage` — sizes, progress bars (mirrors web
 * account meters when workspace quotas exist), and local timestamps.
 *
 * Metered vs unmetered is derived from the usage payload: cloud / self-serve
 * workspaces ship with `maxStorageBytes` / `maxUploadsPerPeriod`; self-host
 * and operator workspaces usually omit them (unlimited). Progress bars only
 * appear for fields that have a positive cap — never invent a budget.
 */
import { formatByteSize } from "./format-bytes.js";
import { BRAND, type Rgb } from "./cli-brand.js";

export type UsageSnapshotLike = {
  workspace: string;
  bytes: number;
  objects: number;
  uploadsInPeriod: number;
  periodStart: string;
  updatedAt: string;
  maxStorageBytes?: number;
  storageRemainingBytes?: number;
  maxUploadsPerPeriod?: number;
  uploadsRemaining?: number;
};

export type FormatUsageOptions = {
  /** IANA zone or undefined for the host local zone. */
  timeZone?: string;
  /** Color the bar fill (TTY / FORCE_COLOR). Default false. */
  color?: boolean;
  /** Progress track width in cells. Default 20. */
  barWidth?: number;
};

/** True when the API reported any cumulative workspace quota. */
export function isUsageMetered(result: UsageSnapshotLike): boolean {
  return (
    usagePct(result.bytes, result.maxStorageBytes) !== null ||
    usagePct(result.uploadsInPeriod, result.maxUploadsPerPeriod) !== null
  );
}

/** 0–100, one decimal. Missing/invalid caps → no bar. Matches web `usagePct`. */
export function usagePct(value: number, max: number | undefined): number | null {
  if (typeof max !== "number" || !(max > 0) || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round((value / max) * 1000) / 10));
}

/** Web thresholds: high ≥85, full ≥100. */
export function usageLevel(pct: number): "normal" | "high" | "full" {
  if (pct >= 100) return "full";
  if (pct >= 85) return "high";
  return "normal";
}

/**
 * Terminal meter: `[████░░░░░░░░░░░░░░░░]  20%`
 * At least one filled cell when pct > 0 so tiny usage is still visible.
 */
export function formatProgressBar(
  pct: number,
  opts: { width?: number; color?: boolean } = {},
): string {
  const width = opts.width ?? 20;
  const clamped = Math.min(100, Math.max(0, pct));
  let filled = Math.round((clamped / 100) * width);
  if (clamped > 0 && filled === 0) filled = 1;
  if (clamped >= 100) filled = width;
  filled = Math.min(width, Math.max(0, filled));

  const fillChar = "█";
  const emptyChar = "░";
  const body = fillChar.repeat(filled) + emptyChar.repeat(width - filled);
  const bar = opts.color ? colorizeBar(body, filled, usageLevel(clamped)) : body;
  const label = formatPctLabel(clamped);
  return `[${bar}] ${label.padStart(5)}`;
}

function formatPctLabel(pct: number): string {
  if (Number.isInteger(pct)) return `${pct}%`;
  return `${pct.toFixed(1)}%`;
}

function colorizeBar(body: string, filled: number, level: "normal" | "high" | "full"): string {
  if (filled <= 0) return paint(body, BRAND.muted);
  const fill = body.slice(0, filled);
  const empty = body.slice(filled);
  const tone = level === "full" ? BRAND.accent : level === "high" ? BRAND.body : BRAND.green;
  return paint(fill, tone) + paint(empty, BRAND.muted);
}

function paint(text: string, c: Rgb): string {
  return `\u001b[38;2;${c.r};${c.g};${c.b}m${text}\u001b[0m`;
}

function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString("en-US") : String(n);
}

/** Host-local time by default; pass `timeZone` for stable tests. */
export function formatUsageTimestamp(iso: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(ms));
  } catch {
    return iso;
  }
}

/** Human-readable lines for `uploads usage` (not JSON). */
export function formatUsageHuman(
  result: UsageSnapshotLike,
  opts: FormatUsageOptions = {},
): string[] {
  const width = opts.barWidth ?? 20;
  const color = opts.color === true;
  const metered = isUsageMetered(result);
  const lines: string[] = [`workspace: ${result.workspace}`];

  const storagePct = usagePct(result.bytes, result.maxStorageBytes);
  if (storagePct !== null && result.maxStorageBytes != null) {
    const detail =
      `${formatByteSize(result.bytes)} / ${formatByteSize(result.maxStorageBytes)}` +
      (result.storageRemainingBytes != null
        ? ` (${formatByteSize(result.storageRemainingBytes)} free)`
        : "");
    const bar = formatProgressBar(storagePct, { width, color });
    lines.push(`storage:   ${bar}  ${detail}`);
  } else {
    lines.push(`storage:   ${formatByteSize(result.bytes)}`);
  }

  lines.push(`objects:   ${formatCount(result.objects)}`);

  const uploadsPct = usagePct(result.uploadsInPeriod, result.maxUploadsPerPeriod);
  if (uploadsPct !== null && result.maxUploadsPerPeriod != null) {
    const detail = `${formatCount(result.uploadsInPeriod)} / ${formatCount(result.maxUploadsPerPeriod)} this period (${result.periodStart})`;
    const bar = formatProgressBar(uploadsPct, { width, color });
    lines.push(`uploads:   ${bar}  ${detail}`);
  } else {
    // Unmetered (or no upload cap): period counter only — not a quota fraction.
    lines.push(
      `uploads:   ${formatCount(result.uploadsInPeriod)} this period (${result.periodStart})`,
    );
  }

  lines.push(`updated:   ${formatUsageTimestamp(result.updatedAt, opts.timeZone)}`);

  if (!metered) {
    // Self-host / operator unlimited: report usage without implying a plan.
    lines.push("note:      unmetered — no storage or upload quotas on this workspace");
  }

  return lines;
}
