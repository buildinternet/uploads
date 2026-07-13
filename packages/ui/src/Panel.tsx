import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface PanelProps extends Omit<ComponentPropsWithoutRef<"section">, "title"> {
  /** Optional heading rendered in Geist sans at the top of the panel. */
  title?: ReactNode;
  /** Optional supporting line under the title. */
  description?: ReactNode;
  /** Roomier `clamp()` padding — the treatment used by the centered auth/console cards. */
  roomy?: boolean;
  children?: ReactNode;
}

/**
 * The bordered surface container — the raised `--panel` card with a hairline
 * border and 10px radius that holds most product content (auth cards, console
 * sections, settings groups). Pass `title`/`description` for the standard header,
 * or compose freely inside.
 *
 * @example
 * <Panel title="Workspace" description="Files here are visible to your team.">
 *   …
 * </Panel>
 */
export function Panel({
  title,
  description,
  roomy = false,
  className,
  children,
  ...rest
}: PanelProps) {
  const cls = ["ul-panel", roomy && "ul-panel--pad-lg", className].filter(Boolean).join(" ");
  return (
    <section className={cls} {...rest}>
      {title != null && <h2 className="ul-panel__title">{title}</h2>}
      {description != null && <p className="ul-panel__desc">{description}</p>}
      {children}
    </section>
  );
}
