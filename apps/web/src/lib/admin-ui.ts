/**
 * Tiny shared helpers for the operator admin tables (/admin/*).
 * Pages still own their data fetches; this only covers markup plumbing.
 */

/** Escape text for insertion into HTML attribute/text nodes. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

/** Remove previously rendered expand-row groups from a table. */
export function clearExpandGroups(table: HTMLElement): void {
  table.querySelectorAll("tbody.admin-row-group").forEach((el) => el.remove());
}

/**
 * Wire click/keyboard expand on a tbody.admin-row-group that contains
 * tr.admin-row (summary) + tr.admin-detail (panel). Calls `onOpen` whenever
 * the group is opened (including re-open after `setOpen(true)` while open).
 */
export function wireExpandGroup(
  group: HTMLElement,
  onOpen?: () => void,
): { setOpen: (open: boolean) => void } {
  const summary = group.querySelector<HTMLTableRowElement>("tr.admin-row");
  const detail = group.querySelector<HTMLTableRowElement>("tr.admin-detail");

  function setOpen(open: boolean): void {
    group.classList.toggle("is-open", open);
    if (detail) detail.hidden = !open;
    if (summary) summary.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) onOpen?.();
  }

  summary?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("a, button, input, select, textarea, label")) return;
    setOpen(!group.classList.contains("is-open"));
  });
  summary?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(!group.classList.contains("is-open"));
    }
  });

  return { setOpen };
}

export type LoadOnceFlag = {
  done: boolean;
  /** In-flight promise so concurrent open/retry calls share one load. */
  inflight?: Promise<void>;
};

/**
 * One-shot async loader. Succeeds once, retries after failure, and de-dupes
 * concurrent callers via `flag.inflight`.
 */
export function loadOnce(flag: LoadOnceFlag, load: () => Promise<void>): void {
  if (flag.done || flag.inflight) return;
  flag.inflight = (async () => {
    try {
      await load();
      flag.done = true;
    } catch {
      // Callers set error UI inside load; leave done false so expand retries.
    } finally {
      flag.inflight = undefined;
    }
  })();
}
