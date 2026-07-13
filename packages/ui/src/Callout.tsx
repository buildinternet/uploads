import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface CalloutProps extends Omit<ComponentPropsWithoutRef<"div">, "title"> {
  /** Status tone, expressed as the left-border color. */
  tone?: "info" | "ready" | "error" | "muted";
  /** Optional uppercase eyebrow above the message. */
  title?: ReactNode;
  children?: ReactNode;
}

/**
 * The status block — a left-border-accented strip used for inline state (upload
 * ready, copy-confirmation, errors). `info` is the default violet; `ready` is
 * green; `error` is red; `muted` is a neutral line.
 *
 * @example
 * <Callout tone="ready" title="Uploaded">https://uploads.sh/g/acme/abc123</Callout>
 * @example
 * <Callout tone="error">That workspace token is invalid.</Callout>
 */
export function Callout({ tone = "info", title, className, children, ...rest }: CalloutProps) {
  const cls = [
    "ul-callout",
    tone !== "info" && `ul-callout--${tone}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} role="status" {...rest}>
      {title != null && <span className="ul-callout__title">{title}</span>}
      {children}
    </div>
  );
}
