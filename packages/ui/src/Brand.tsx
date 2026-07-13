export interface BrandProps {
  /** Link target for the lockup. Defaults to `/`. Pass `null` to render a non-link. */
  href?: string | null;
  /** `"lg"` renders the larger homepage-hero treatment. */
  size?: "md" | "lg";
  /** Wordmark text. Defaults to the canonical `uploads.sh`. */
  label?: string;
  className?: string;
}

/**
 * The canonical uploads.sh brand lockup: the stacked-chevron mark plus the
 * `uploads.sh` wordmark set in Geist Pixel. This is the single source of truth for
 * the brand — every surface's top-left brand should render `Brand`, never its own
 * markup, so the treatment stays identical everywhere. Colors read `--fg` / `--accent`,
 * so the mark adapts to whatever surface it sits on.
 *
 * @example
 * <Brand />
 * @example
 * <Brand size="lg" href={null} />
 */
export function Brand({ href = "/", size = "md", label = "uploads.sh", className }: BrandProps) {
  const cls = ["ul-brand", size === "lg" && "ul-brand--lg", className].filter(Boolean).join(" ");
  const inner = (
    <>
      <svg
        className="ul-brand__mark"
        viewBox="0 0 32 32"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        <path d="M4 0H28V4H32V28H28V32H4V28H0V4H4Z" fill="var(--panel, #121214)" />
        <g fill="var(--accent, #c27eff)">
          <path d="M14 4h4v4h-4z M10 6h4v4h-4z M18 6h4v4h-4z M6 8h4v4h-4z M22 8h4v4h-4z" />
          <path
            opacity=".55"
            d="M14 12h4v4h-4z M10 14h4v4h-4z M18 14h4v4h-4z M6 16h4v4h-4z M22 16h4v4h-4z"
          />
          <path
            opacity=".28"
            d="M14 20h4v4h-4z M10 22h4v4h-4z M18 22h4v4h-4z M6 24h4v4h-4z M22 24h4v4h-4z"
          />
        </g>
      </svg>
      <span>{label}</span>
    </>
  );

  if (href == null) {
    return (
      <span className={cls} aria-label={`${label} brand`}>
        {inner}
      </span>
    );
  }
  return (
    <a className={cls} href={href} aria-label={`${label} home`}>
      {inner}
    </a>
  );
}
