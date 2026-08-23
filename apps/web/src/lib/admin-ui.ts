/**
 * Tiny shared helpers for the operator admin tables (/admin/*).
 * Pages still own their data fetches; this only covers markup plumbing.
 */
import { skeletonBarHtml } from "./workspace-ui";

/**
 * Shared Tailwind utility strings for the hand-built `.admin-table` markup
 * (both the static Astro `<thead>`s and the JS-rendered `<tbody>` rows).
 * Centralized here rather than repeated per page so every table stays
 * visually identical without duplicating long class lists — the CSS
 * equivalents these replace lived in admin.css's `.admin-table` block.
 */
export const ADMIN_TH =
  "text-left font-medium text-(length:--text-micro) uppercase tracking-[0.06em] text-muted-foreground pr-3 pb-[10px] border-b border-border whitespace-nowrap last:pr-0";
export const ADMIN_TH_NUM = `${ADMIN_TH} text-right tabular-nums pl-4`;
export const ADMIN_TH_ACTIONS = `${ADMIN_TH} text-right`;

export const ADMIN_TD = "py-3 pr-3 border-b border-border text-body align-middle last:pr-0";
export const ADMIN_TD_NUM = `${ADMIN_TD} text-right tabular-nums pl-4`;
export const ADMIN_TD_ACTIONS = `${ADMIN_TD} text-right w-px whitespace-nowrap pl-4`;

export const ADMIN_CELL_PRIMARY = "text-foreground font-semibold";
export const ADMIN_CELL_MONO = "font-mono font-medium";
export const ADMIN_CELL_MUTED = "text-muted-foreground text-(length:--text-micro)";

/** Chevron cell for an expandable `tbody.admin-row-group` summary row. */
export const ADMIN_EXPAND_TD =
  "w-[18px] text-muted-foreground text-(length:--text-micro) leading-none transition-transform duration-150 ease-linear select-none [.is-open_&]:rotate-90 [.is-open_&]:text-foreground";

/** Small uppercase heading inside an expanded `.admin-detail-inner` block. */
export const ADMIN_DETAIL_HEADING =
  "m-0 mb-2 text-(length:--text-micro) font-semibold tracking-[0.04em] uppercase text-foreground";

/** Outline button — the shared `.admin-btn` look. */
export const ADMIN_BTN =
  "text-(length:--text-micro) text-primary bg-transparent border border-border rounded-sm px-3 py-[7px] cursor-pointer whitespace-nowrap w-fit hover:border-primary focus-visible:border-primary focus-visible:outline-none disabled:opacity-55 disabled:cursor-default";
export const ADMIN_MINI_LIST = "list-none m-0 p-0 grid gap-1.5";
export const ADMIN_MINI_LIST_ITEM =
  "flex justify-between gap-2 text-(length:--text-micro) text-body";

export const ADMIN_BTN_DANGER =
  "text-destructive border-destructive/40 hover:not-disabled:border-destructive focus-visible:not-disabled:border-destructive disabled:text-muted-foreground disabled:opacity-60 disabled:cursor-not-allowed";

/** Escape text for insertion into HTML attribute/text nodes. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

export interface AdminSkeletonColumn {
  /** CSS length passed to `skeletonBarHtml` (e.g. "88px"). */
  width: string;
  /** Uses `ADMIN_TD_NUM` instead of `ADMIN_TD` for right-aligned numeric columns. */
  num?: boolean;
}

/**
 * Placeholder `<tr class="admin-row">` rows for an `.admin-table`'s `<tbody>`,
 * reserving close-to-real height before async data lands. Pairs with a
 * static `<thead>` already present in the page's server HTML — callers swap
 * only the `<tbody>` in place once data arrives, same as `workspace-ui.ts`'s
 * `renderGalleriesPlaceholderHtml` reserves for its table.
 */
export function renderAdminTableSkeletonRowsHtml(columns: AdminSkeletonColumn[], rows = 3): string {
  return Array.from(
    { length: rows },
    () =>
      `<tr class="admin-row">${columns
        .map(
          (c) => `<td class="${c.num ? ADMIN_TD_NUM : ADMIN_TD}">${skeletonBarHtml(c.width)}</td>`,
        )
        .join("")}</tr>`,
  ).join("");
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
