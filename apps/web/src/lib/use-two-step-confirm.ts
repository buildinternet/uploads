/**
 * Two-step destructive confirm shared by the file table's actions menu and
 * the Links list: closed → confirm → armed. An armed confirm auto-disarms
 * back to "confirm" after `DELETE_DISARM_MS`, so a stray later click can't
 * delete. The /f/ file page carries a vanilla twin of this state machine
 * (public pages ship no framework JS) — keep the value and the semantics in
 * sync with apps/web/src/pages/f/[workspace]/[...key].astro.
 */
import { useCallback, useEffect, useState } from "react";

/** How long an armed "Confirm delete" stays armed before auto-disarming. */
export const DELETE_DISARM_MS = 5000;

export type TwoStepConfirmState = "closed" | "confirm" | "armed";

export function useTwoStepConfirm() {
  const [state, setState] = useState<TwoStepConfirmState>("closed");

  useEffect(() => {
    if (state !== "armed") return;
    const timer = window.setTimeout(() => setState("confirm"), DELETE_DISARM_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  return {
    state,
    /** Open the confirm panel (step one). */
    open: useCallback(() => setState("confirm"), []),
    /** Arm the destructive button (step two). */
    arm: useCallback(() => setState("armed"), []),
    /** Dismiss the confirm panel. */
    close: useCallback(() => setState("closed"), []),
    /**
     * Back to a fresh step one without closing: call before the delete so a
     * failure leaves the panel open but the next click must re-confirm.
     */
    reset: useCallback(() => setState("confirm"), []),
  };
}
