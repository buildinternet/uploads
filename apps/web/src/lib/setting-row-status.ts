/**
 * Inline save feedback for a `.setting-row` (components/settings/SettingRow.astro):
 * writes "Saving…", "Saved" or an error into the row's status span beside the
 * control. "Saved" clears itself after a moment; errors stay until the next change.
 */

const SAVED_MS = 2000;
const timers = new WeakMap<HTMLElement, number>();

export type RowStatus = "saving" | "saved" | "error" | "clear";

export function setRowStatus(control: Element, status: RowStatus, message?: string): void {
  const el = control.closest(".setting-row")?.querySelector<HTMLElement>(".setting-row__status");
  if (!el) return;
  window.clearTimeout(timers.get(el));
  const text =
    status === "saving"
      ? "Saving…"
      : status === "saved"
        ? "Saved"
        : status === "error"
          ? (message ?? "Couldn’t save")
          : "";
  el.textContent = text;
  if (status === "clear") delete el.dataset.state;
  else el.dataset.state = status;
  if (status === "saved") {
    timers.set(
      el,
      window.setTimeout(() => {
        el.textContent = "";
      }, SAVED_MS),
    );
  }
}
