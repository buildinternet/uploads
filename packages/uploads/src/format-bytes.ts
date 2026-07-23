/**
 * Decimal (SI) human sizes for CLI output. Plan catalog caps are round decimal
 * numbers (250 MB free, 10 GB pro); binary units made Free look like 238.4 MB.
 * Used for usage meters, list sizes, optimize notes, and doctor — same base
 * as apps/web `formatBytes` / `formatMarketedBytes`.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Alias for call sites that want plan-cap wording; same SI formatter. */
export function formatMarketedBytes(bytes: number): string {
  return formatByteSize(bytes);
}
