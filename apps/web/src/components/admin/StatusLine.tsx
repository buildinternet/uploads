/**
 * Inline save/error status line for the drawer editors — the React equivalent
 * of the imperative page's `data-state`-driven `.plan-status` / `.limit-status`
 * spans. `error` uses the destructive token, `ok` the accent, and both are
 * announced politely (aria-live) the way the original status nodes were.
 */
import type { ReactNode } from "react";

export type StatusState = "error" | "ok";

export function StatusLine({ state, children }: { state: StatusState; children: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "text-(length:--text-micro) " + (state === "error" ? "text-destructive" : "text-accent")
      }
    >
      {children}
    </div>
  );
}

/** Uppercase section heading inside the drawer, matching ADMIN_DETAIL_HEADING. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="m-0 mb-2 text-(length:--text-micro) font-semibold tracking-[0.04em] uppercase text-foreground">
      {children}
    </h4>
  );
}

/** Muted secondary paragraph, matching the page's `.muted` copy. */
export function Muted({ children }: { children: ReactNode }) {
  return <p className="m-0 text-(length:--text-micro) text-muted-foreground">{children}</p>;
}
