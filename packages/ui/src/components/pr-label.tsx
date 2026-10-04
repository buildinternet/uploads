import { isSafePrHref, prLabelParts, type PrLabelInput, type PrState } from "../lib/pr-label";
import { cn } from "../lib/utils";

/**
 * One label for a pull request or issue everywhere in the signed-in app:
 * a status dot plus "#123 Title", or "owner/repo #123" while the title is
 * unknown. Copy comes from `prLabelParts`; the HTML-string twin in apps/web
 * (lib/pr-label-html.ts) renders the same parts for Astro and string markup.
 */

export type PrLabelSize = "sm" | "md" | "lg";

export interface PrLabelProps extends PrLabelInput {
  size?: PrLabelSize;
  /** Renders an anchor when set and safe (http(s) or root-relative). */
  href?: string;
  /** "_blank" also sets rel="noopener noreferrer". */
  target?: "_blank";
  /** Dot and "#123" only, for tile badges where a title cannot fit. */
  compact?: boolean;
  className?: string;
}

const SIZE_CLASS: Record<PrLabelSize, string> = {
  sm: "gap-1.5 text-(length:--text-micro)",
  md: "gap-1.5 text-(length:--text-meta)",
  lg: "gap-2.5 text-(length:--text-h2) leading-tight font-semibold",
};

const DOT_SIZE_CLASS: Record<PrLabelSize, string> = {
  sm: "size-1.5",
  md: "size-[7px]",
  lg: "size-2.5",
};

// Token-backed: --color-success = --green, --color-primary = --accent (violet),
// --color-destructive = --red (packages/ui/src/theme.css).
const DOT_STATE_CLASS: Record<PrState | "unknown", string> = {
  open: "bg-success",
  merged: "bg-primary",
  closed: "bg-destructive",
  unknown: "bg-muted-foreground/60",
};

const LINK_CLASS =
  "text-fg no-underline hover:text-primary focus-visible:text-primary focus-visible:outline-none";

function PrLabel({
  ghRef,
  title,
  state,
  kind,
  size = "md",
  href,
  target,
  compact = false,
  className,
}: PrLabelProps) {
  const parts = prLabelParts({ ghRef, title, state, kind });
  const stateKey = parts.state ?? "unknown";
  const link = href !== undefined && isSafePrHref(href) ? href : null;
  const rootClass = cn(
    "inline-flex max-w-full min-w-0 items-center align-middle",
    SIZE_CLASS[size],
    link ? LINK_CLASS : "text-fg",
    className,
  );
  const split = size === "lg" && !compact && parts.title !== null && parts.number !== "";

  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn("shrink-0 rounded-full", DOT_SIZE_CLASS[size], DOT_STATE_CLASS[stateKey])}
      />
      {compact ? (
        <span className="truncate">{parts.number || parts.text}</span>
      ) : split ? (
        <span className="min-w-0 truncate">
          {`${parts.title} `}
          <span className="font-normal text-muted-foreground">{parts.number}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate">{parts.text}</span>
      )}
    </>
  );

  if (link) {
    return (
      <a
        data-slot="pr-label"
        data-state={stateKey}
        className={rootClass}
        href={link}
        aria-label={parts.ariaLabel}
        target={target}
        rel={target === "_blank" ? "noopener noreferrer" : undefined}
      >
        {body}
      </a>
    );
  }
  return (
    <span data-slot="pr-label" data-state={stateKey} className={rootClass}>
      {body}
      {parts.state && <span className="sr-only">{` (${parts.state})`}</span>}
    </span>
  );
}

export { PrLabel };
