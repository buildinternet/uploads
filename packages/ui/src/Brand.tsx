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
      <svg className="ul-brand__mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="var(--panel, #121214)" />
        <g
          fill="none"
          stroke="var(--accent, #b794ff)"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 12.5 L16 5 L24 12.5" />
          <path d="M8 19.5 L16 12 L24 19.5" opacity=".55" />
          <path d="M8 26.5 L16 19 L24 26.5" opacity=".28" />
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
