import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface CalloutProps extends Omit<ComponentPropsWithoutRef<"div">, "title"> {
  /** Status tone, expressed as the `>>` marker + tint color. */
  tone?: "info" | "ready" | "error" | "muted";
  /** Optional uppercase eyebrow above the message. */
  title?: ReactNode;
  children?: ReactNode;
}

/**
 * The status block, formatted the way the uploads CLI prints status: a
 * tone-colored `>>` marker with mono text and a faint tone tint. Used for
 * inline state (upload ready, copy-confirmation, errors). `info` is the
 * default violet; `ready` is green; `error` is red; `muted` is neutral.
 *
 * @example
 * <Callout tone="ready" title="Uploaded">https://uploads.sh/g/acme/abc123</Callout>
 * @example
 * <Callout tone="error">That workspace token is invalid.</Callout>
 */
export function Callout({ tone = "info", title, className, children, ...rest }: CalloutProps) {
  const cls = ["ul-callout", tone !== "info" && `ul-callout--${tone}`, className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} role={tone === "error" ? "alert" : "status"} {...rest}>
      {title != null && <span className="ul-callout__title">{title}</span>}
      {children}
    </div>
  );
}
