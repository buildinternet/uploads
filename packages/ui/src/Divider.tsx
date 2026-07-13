import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface DividerProps extends ComponentPropsWithoutRef<"div"> {
  /** Optional centered uppercase label (e.g. `or`). Omit for a plain hairline rule. */
  label?: ReactNode;
  /** Render the brand chevron as the centered separator instead of a label. */
  chevron?: boolean;
}

/**
 * A horizontal separator. With a `label` it renders the centered uppercase
 * "— or —" divider used between form sections; with `chevron` it centers the
 * brand mark's chevron between the hairlines; with neither it's a plain rule.
 *
 * @example
 * <Divider label="or" />
 * @example
 * <Divider chevron />
 * @example
 * <Divider />
 */
export function Divider({ label, chevron = false, className, ...rest }: DividerProps) {
  if (chevron) {
    return (
      <div
        className={["ul-divider", "ul-divider--chevron", className].filter(Boolean).join(" ")}
        aria-hidden="true"
        {...rest}
      >
        <svg viewBox="0 0 32 20" fill="none" aria-hidden="true">
          <path
            d="M8 14.5 L16 7 L24 14.5"
            stroke="currentColor"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  }
  if (label == null) {
    return <hr className={["ul-divider--plain", className].filter(Boolean).join(" ")} />;
  }
  return (
    <div className={["ul-divider", className].filter(Boolean).join(" ")} {...rest}>
      {label}
    </div>
  );
}
