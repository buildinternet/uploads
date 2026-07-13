import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  /** Visual weight. `default` is the neutral bordered control; `primary` tints the
   *  label with the accent violet; `ghost` is borderless; `danger` is destructive. */
  variant?: "default" | "primary" | "ghost" | "danger";
  /** Control size. */
  size?: "sm" | "md" | "lg";
  /** Stretch to fill the container width (the full-width form-submit treatment). */
  block?: boolean;
  /** Optional leading glyph (an icon or short mark). */
  icon?: ReactNode;
  children?: ReactNode;
}

/**
 * The uploads.sh button — a monospace, developer-console control. Neutral by
 * default with a border that lights up to the accent on hover/focus; `primary`
 * tints the label violet for the main action on a surface.
 *
 * @example
 * <Button variant="primary">Create workspace</Button>
 * @example
 * <Button block icon={<GitHubGlyph />}>Continue with GitHub</Button>
 */
export function Button({
  variant = "default",
  size = "md",
  block = false,
  icon,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = [
    "ul-btn",
    `ul-btn--${size}`,
    variant !== "default" && `ul-btn--${variant}`,
    block && "ul-btn--block",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}
