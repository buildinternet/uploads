import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface SurfaceProps extends ComponentPropsWithoutRef<"div"> {
  /** Content that sits on the dark uploads.sh canvas. */
  children?: ReactNode;
}

/**
 * The theme root. Wrap product UI in `Surface` so components render on the dark
 * `--bg` canvas with the Geist sans body font and the design tokens in scope.
 * Everything else in the system assumes it is rendered somewhere inside a Surface.
 *
 * @example
 * <Surface style={{ padding: 24 }}>
 *   <Brand />
 * </Surface>
 */
export function Surface({ children, className, ...rest }: SurfaceProps) {
  return (
    <div className={["ul-surface", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}
