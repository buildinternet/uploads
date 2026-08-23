/**
 * @uploads/ui — the uploads.sh design system.
 *
 * The kit is shadcn / Base UI components under `@uploads/ui/components/ui/<name>`,
 * styled by `theme.css` (Tailwind v4 tokens). Import that stylesheet once at your
 * app root: `import "@uploads/ui/theme.css"`.
 *
 * The exports below are transitional legacy primitives that still have live
 * consumers (see packages/ui/README.md) and are not yet migrated.
 */
export { Field, Input, Label, Select } from "./Field";
export type { FieldProps, InputProps, LabelProps, SelectProps } from "./Field";

export { Callout } from "./Callout";
export type { CalloutProps } from "./Callout";
