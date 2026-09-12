/**
 * Form-control class strings shared by the admin workspace drawer editors,
 * lifted from the imperative admin page so the inputs keep the exact look they
 * had before the React rewrite (the drawer sits next to the same shell, so its
 * fields should not read as a different design language). Buttons and the
 * plan/BYOB pills move to the shadcn `Button`/`Badge` primitives; only the
 * native `<input>`/`<select>` controls, which have no drop-in shadcn
 * equivalent worth the base-ui ceremony here, keep these utility strings.
 */
export const INPUT_NUM =
  "bg-background border border-border rounded-sm text-foreground px-1.5 py-1 font-mono text-(length:--text-micro) disabled:opacity-50";

export const INPUT_TEXT =
  "bg-background border border-border rounded-sm text-foreground normal-case tracking-normal px-[9px] py-[7px] font-sans text-(length:--text-micro)";

export const SELECT_SM = "ul-select ul-select--sm";

/** Muted uppercase field label used above stacked form controls. */
export const FIELD_LABEL =
  "grid gap-1 text-muted-foreground text-(length:--text-micro) uppercase tracking-[0.06em]";
