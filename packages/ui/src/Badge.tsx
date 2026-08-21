import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
  /** Color tone. */
  tone?: "neutral" | "accent" | "ok" | "danger";
  /** Show a leading status dot in the tone's color. */
  dot?: boolean;
  children?: ReactNode;
}

/**
 * A small pill tag — used for workspace names, content types, visibility, and
 * status markers. Set in sans at the 12px floor; reach for `--mono` on the
 * label only when the badge carries a key or an identifier rather than a word.
 * `dot` adds a leading status dot.
 *
 * @example
 * <Badge tone="accent">acme-web</Badge>
 * @example
 * <Badge tone="ok" dot>public</Badge>
 */
export function Badge({ tone = "neutral", dot = false, className, children, ...rest }: BadgeProps) {
  const cls = ["ul-badge", tone !== "neutral" && `ul-badge--${tone}`, className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} {...rest}>
      {dot && <span className="ul-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
