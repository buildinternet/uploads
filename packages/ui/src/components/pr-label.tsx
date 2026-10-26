import {
  isSafePrHref,
  PR_ICON_NODES,
  PR_ICON_SVG_ATTRS,
  prIconName,
  prLabelParts,
  prLabelSrText,
  type PrLabelInput,
  type PrState,
} from "../lib/pr-label";
import { cn } from "../lib/utils";

/**
 * One label for a pull request or issue everywhere in the signed-in app:
 * a state icon (pull request, merge, closed, issue) plus "#123 Title", or
 * "owner/repo #123" while the title is unknown. Copy comes from `prLabelParts`; the HTML-string twin in apps/web
 * (lib/pr-label-html.ts) renders the same parts for Astro and string markup.
 */

export type PrLabelSize = "sm" | "md" | "lg";

export interface PrLabelProps extends PrLabelInput {
  size?: PrLabelSize;
  /** Renders an anchor when set and safe (http(s) or root-relative). */
  href?: string;
  /** "_blank" also sets rel="noopener noreferrer". */
  target?: "_blank";
  /** Icon and "#123" only, for tile badges where a title cannot fit. */
  compact?: boolean;
  className?: string;
}

const SIZE_CLASS: Record<PrLabelSize, string> = {
  sm: "gap-1.5 text-(length:--text-micro)",
  md: "gap-1.5 text-(length:--text-meta)",
  lg: "gap-2.5 text-(length:--text-h2) leading-tight font-semibold",
};

const ICON_SIZE_CLASS: Record<PrLabelSize, string> = {
  sm: "size-3",
  md: "size-3.5",
  lg: "size-5",
};

// Token-backed: --color-success = --green, --color-primary = --accent (violet),
// --color-destructive = --red (packages/ui/src/theme.css).
const ICON_STATE_CLASS: Record<PrState | "unknown", string> = {
  open: "text-success",
  merged: "text-primary",
  closed: "text-destructive",
  unknown: "text-muted-foreground/60",
};

const SVG_PROPS = {
  viewBox: PR_ICON_SVG_ATTRS.viewBox,
  fill: PR_ICON_SVG_ATTRS.fill,
  stroke: PR_ICON_SVG_ATTRS.stroke,
  strokeWidth: PR_ICON_SVG_ATTRS["stroke-width"],
  strokeLinecap: PR_ICON_SVG_ATTRS["stroke-linecap"],
  strokeLinejoin: PR_ICON_SVG_ATTRS["stroke-linejoin"],
} as const;

/** The state icon on its own, for places that show state without a label. */
function PrStateIcon({
  kind,
  state,
  className,
}: {
  kind?: "pull" | "issue";
  state?: PrState | null;
  className?: string;
}) {
  const name = prIconName(kind, state ?? null);
  return (
    <svg
      {...SVG_PROPS}
      aria-hidden="true"
      data-icon={name}
      className={cn("shrink-0", ICON_STATE_CLASS[state ?? "unknown"], className)}
    >
      {PR_ICON_NODES[name].map(([tag, attrs], i) => {
        const Tag = tag;
        return <Tag key={i} {...attrs} />;
      })}
    </svg>
  );
}

// `no-underline!` (important): the app's unlayered global `a` underline rule
// beats a layered utility otherwise.
const LINK_CLASS =
  "text-fg no-underline! hover:text-primary focus-visible:text-primary focus-visible:outline-none";

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
    "relative inline-flex max-w-full min-w-0 items-center align-middle",
    SIZE_CLASS[size],
    link ? LINK_CLASS : "text-fg",
    className,
  );
  const split = size === "lg" && !compact && parts.title !== null && parts.number !== "";

  const body = (
    <>
      <PrStateIcon kind={kind} state={parts.state} className={ICON_SIZE_CLASS[size]} />
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
      <span className="sr-only">{prLabelSrText({ ghRef, title, state, kind }, compact)}</span>
    </span>
  );
}

export { PrLabel, PrStateIcon };
