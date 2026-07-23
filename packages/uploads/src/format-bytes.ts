/**
 * Human-readable size for measured file/usage bytes (1024-based).
 * files-sdk has no size formatter — only raw `size` on head/upload results.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Decimal (SI) sizes for *marketed* plan limits, which are defined in
 * `@uploads/billing` as round decimal numbers (250 MB, 10 GB, 100 MB).
 * Binary `formatByteSize` would render those as 238.4 MB / 9.3 GB and
 * contradict the plan blurb — same split as apps/web `formatMarketedBytes`.
 */
export function formatMarketedBytes(bytes: number): string {
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
