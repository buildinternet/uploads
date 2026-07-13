import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface DividerProps extends ComponentPropsWithoutRef<"div"> {
  /** Optional centered uppercase label (e.g. `or`). Omit for a plain hairline rule. */
  label?: ReactNode;
}

/**
 * A horizontal separator. With a `label` it renders the centered uppercase
 * "— or —" divider used between form sections; without one it's a plain hairline.
 *
 * @example
 * <Divider label="or" />
 * @example
 * <Divider />
 */
export function Divider({ label, className, ...rest }: DividerProps) {
  if (label == null) {
    return <hr className={["ul-divider--plain", className].filter(Boolean).join(" ")} />;
  }
  return (
    <div className={["ul-divider", className].filter(Boolean).join(" ")} {...rest}>
      {label}
    </div>
  );
}
