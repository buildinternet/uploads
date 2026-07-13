import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface InputProps extends ComponentPropsWithoutRef<"input"> {}

/**
 * A single dark form input in the monospace console idiom — `--bg` fill, hairline
 * border that turns accent on focus. Usually composed inside `Field`, but valid on
 * its own.
 *
 * @example
 * <Input placeholder="my-workspace" />
 */
export function Input({ className, ...rest }: InputProps) {
  return <input className={["ul-input", className].filter(Boolean).join(" ")} {...rest} />;
}

export interface LabelProps extends ComponentPropsWithoutRef<"label"> {
  children?: ReactNode;
}

/**
 * The uppercase micro-label that sits above inputs — tiny, letter-spaced, muted,
 * set in Geist Mono.
 */
export function Label({ className, children, ...rest }: LabelProps) {
  return (
    <label className={["ul-label", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </label>
  );
}

export interface FieldProps extends ComponentPropsWithoutRef<"div"> {
  /** The uppercase field label. */
  label?: ReactNode;
  /** Helper or error text shown below the control. */
  hint?: ReactNode;
  /** Renders the field in its error state (red border + hint). */
  invalid?: boolean;
  /** The control — typically an `Input`. */
  children?: ReactNode;
}

/**
 * A labelled form field: the uppercase `Label`, a control (`Input` or any child),
 * and an optional hint line. The canonical way to build uploads.sh forms.
 *
 * @example
 * <Field label="Workspace name" hint="Lowercase, dashes only.">
 *   <Input defaultValue="acme-web" />
 * </Field>
 * @example
 * <Field label="Token" hint="That token has expired." invalid>
 *   <Input defaultValue="upl_9f2c…" />
 * </Field>
 */
export function Field({ label, hint, invalid = false, className, children, ...rest }: FieldProps) {
  const cls = ["ul-field", invalid && "ul-field--invalid", className].filter(Boolean).join(" ");
  return (
    <div className={cls} {...rest}>
      {label != null && <span className="ul-label">{label}</span>}
      {children}
      {hint != null && <span className="ul-field__hint">{hint}</span>}
    </div>
  );
}
