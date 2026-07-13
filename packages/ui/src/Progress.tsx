import type { ComponentPropsWithoutRef } from "react";

export interface ProgressProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** Current value toward the quota. */
  value: number;
  /** Cap. Defaults to 100 (percentage mode). */
  max?: number;
  /** Accessible name, e.g. "Storage" or "Uploads this month". */
  label: string;
}

function clampRatio(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value) || !Number.isFinite(max)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** Visual band for the fill: quiet until high, accent only at full. */
function levelFor(ratio: number): "high" | "full" | undefined {
  if (ratio >= 1) return "full";
  if (ratio >= 0.85) return "high";
  return undefined;
}

/**
 * Narrow horizontal progress bar with stepped pixel corners and a soft
 * dithered leading edge. Stack inside `.ul-progress` for multiple meters
 * (storage, monthly uploads) without shifting surrounding layout.
 *
 * @example
 * <div className="ul-progress">
 *   <Progress label="Storage" value={bytes} max={maxBytes} />
 *   <Progress label="Uploads this month" value={n} max={cap} />
 * </div>
 */
export function Progress({ value, max = 100, label, className, ...rest }: ProgressProps) {
  const ratio = clampRatio(value, max);
  const pct = Math.round(ratio * 1000) / 10;
  const level = levelFor(ratio);

  return (
    <div className={["ul-progress__row", className].filter(Boolean).join(" ")} {...rest}>
      <div
        className="ul-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={label}
      >
        <div className="ul-progress__fill" data-level={level} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
