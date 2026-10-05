/**
 * HTML-string twin of the React `PrLabel` (@uploads/ui/components/pr-label)
 * for markup that cannot ship React: Astro public pages (through
 * components/PrLabel.astro) and string-built DOM such as the workspace rail.
 * Copy and accessible names come from the same `prLabelParts`, so both
 * renderers say the same thing. Styles: styles/pr-label.css. Import that
 * stylesheet wherever this markup can appear.
 */
import {
  isSafePrHref,
  prLabelParts,
  prLabelSrText,
  type PrLabelInput,
} from "@uploads/ui/lib/pr-label";
import { escapeHtml } from "./workspace-ui";

export type PrLabelSize = "sm" | "md" | "lg";

export interface PrLabelHtmlProps extends PrLabelInput {
  size?: PrLabelSize;
  /** Renders an anchor when set and safe (http(s) or root-relative). */
  href?: string;
  /** "_blank" also sets rel="noopener noreferrer". */
  target?: "_blank";
  /** Dot and "#123" only, for badges where a title cannot fit. */
  compact?: boolean;
  className?: string;
}

const DOT = '<span class="pr-label__dot" aria-hidden="true"></span>';

export function prLabelHtml(props: PrLabelHtmlProps): string {
  const parts = prLabelParts(props);
  const size = props.size ?? "md";
  const state = parts.state ?? "unknown";
  const cls = ["pr-label", `pr-label--${size}`, props.className].filter(Boolean).join(" ");

  let body: string;
  if (props.compact) {
    body = `<span class="pr-label__text">${escapeHtml(parts.number || parts.text)}</span>`;
  } else if (size === "lg" && parts.title !== null && parts.number) {
    body = `<span class="pr-label__text">${escapeHtml(parts.title)} <span class="pr-label__number">${escapeHtml(parts.number)}</span></span>`;
  } else {
    body = `<span class="pr-label__text">${escapeHtml(parts.text)}</span>`;
  }

  const attrs = `class="${escapeHtml(cls)}" data-state="${state}"`;
  if (props.href !== undefined && isSafePrHref(props.href)) {
    const rel = props.target === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a ${attrs} href="${escapeHtml(props.href)}"${rel} aria-label="${escapeHtml(parts.ariaLabel)}">${DOT}${body}</a>`;
  }
  // A plain span has no accessible name of its own; prLabelSrText spells out
  // what the dot and visible text leave out.
  return `<span ${attrs}>${DOT}${body}<span class="pr-label__sr">${escapeHtml(prLabelSrText(props, props.compact))}</span></span>`;
}
