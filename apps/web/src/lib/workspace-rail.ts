/**
 * Live data for `WorkspaceLayout.astro`'s right rail (connected work / usage /
 * details / quick actions — see `.context/2026-07-19-settings-overhaul-3a-reference.html`
 * and design doc §5.5).
 *
 * `initWorkspaceRail` is mounted once per workspace-tab page load. It:
 *  - defines the documented connected-work hook (`window.__uploadsSetConnectedWork`)
 *    synchronously, before any network round trip, so a files-tab script that
 *    races ahead of this module's session-gated fetches never calls a
 *    not-yet-defined function;
 *  - fetches `getWorkspaceSummary` → details and usage.
 *
 * Connected-work hook contract (Task 8's files tab is the only caller):
 *   `window.__uploadsSetConnectedWork(items: GhWorkItem[], titles?: GithubTitleMap): void`
 * Call with the current view's deduped `connectedWork(files)` result. A
 * non-empty array shows the "connected work" section and renders one row per
 * item; an empty array hides it. Non-files tabs never call it, so the section
 * stays hidden by construction.
 */
import { getWorkspaceSummary, type GithubTitleMap, type MyWorkspace } from "./api-client";
import { onSession } from "./account-shell";
import { escapeHtml, renderUsageHtml } from "./workspace-ui";
import { githubKindSvg } from "./brand-icons";
import { applyGhTitles, githubOwnerAvatarUrl, type GhKind, type GhWorkItem } from "./gh-context";

/** Optional titles come from the files tab's one listing-scoped title request. */
export type ConnectedWorkSetter = (items: GhWorkItem[], titles?: GithubTitleMap) => void;

declare global {
  interface Window {
    /** See module doc — the documented connected-work hook Task 8's files tab calls. */
    __uploadsSetConnectedWork?: ConnectedWorkSetter;
  }
}

// The kind octicon (branch = pull request, circled dot = issue) carries the
// kind on its own, so the row no longer repeats the word as a subtitle.
const CONNECTED_WORK_ICON: Record<GhKind, string> = {
  pull: githubKindSvg("pull", { className: "ws-rail__connected-icon" }),
  issue: githubKindSvg("issue", { className: "ws-rail__connected-icon" }),
};

function connectedWorkRowHtml(item: GhWorkItem, apiOrigin?: string): string {
  const avatar =
    item.owner && apiOrigin
      ? `<img class="ws-rail__connected-avatar" src="${escapeHtml(githubOwnerAvatarUrl(apiOrigin, item.owner))}" alt="" width="16" height="16" loading="lazy" decoding="async" />`
      : "";
  return `<div class="ws-rail__connected-item">${avatar}${CONNECTED_WORK_ICON[item.kind]}<div class="ws-rail__connected-meta"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a></div></div>`;
}

/** Pure row-HTML builder for the rail's "connected work" section. `[]` → `""`. */
export function renderConnectedWorkHtml(items: GhWorkItem[], apiOrigin?: string): string {
  return items.map((item) => connectedWorkRowHtml(item, apiOrigin)).join("");
}

/** Minimal shape `renderDetailsHtml` needs — `MyWorkspace` is a structural superset. */
export interface WorkspaceRailDetails {
  organization: { slug: string };
  hasPublicUrl: boolean;
  publicBaseUrl?: string;
}

/**
 * Pure builder for the rail/settings "details" `<dt>/<dd>` pairs (slug +
 * base URL only — role lives on People / Account). The base-URL cell is
 * plain text (host of the stable public origin, e.g. `storage.uploads.sh`)
 * — it is a bucket root, not a useful page to open. `hasPublicUrl` without
 * a URL string means an older API that predates `publicBaseUrl` — fall back
 * to "configured" rather than fabricating a URL.
 */
export function renderDetailsHtml(ws: WorkspaceRailDetails): string {
  const host = ws.publicBaseUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const baseUrlHtml = ws.publicBaseUrl
    ? escapeHtml(host ?? "")
    : escapeHtml(ws.hasPublicUrl ? "configured" : "—");
  return (
    `<dt class="ws-rail__dt">slug</dt><dd class="ws-rail__dd">${escapeHtml(ws.organization.slug)}</dd>` +
    `<dt class="ws-rail__dt">base url</dt><dd class="ws-rail__dd">${baseUrlHtml}</dd>`
  );
}

/**
 * Wire the documented `window.__uploadsSetConnectedWork` hook against the
 * "connected work" section under `root`, and return the setter (also used to
 * force it hidden/empty on boot). Safe to call once per page mount — each
 * WorkspaceLayout page load gets a fresh rail DOM, so re-assigning the global
 * here always points it at the current page's elements.
 */
/** Connected-work rows shown before a "show N more" toggle reveals the rest. */
const CONNECTED_WORK_CAP = 6;

/**
 * Decide whether a titles response warrants a repaint: the relabeled items
 * when at least one label changed, else null (failed fetch, empty map, or
 * titles identical to what's already painted).
 */
export function planTitleRepaint(
  items: GhWorkItem[],
  titles: GithubTitleMap | null,
): GhWorkItem[] | null {
  if (!titles) return null;
  const updated = applyGhTitles(items, titles);
  return updated.some((item, i) => item.label !== items[i].label) ? updated : null;
}

function bindConnectedWorkSetter(
  root: Document | Element,
  apiOrigin?: string,
): ConnectedWorkSetter {
  const section = root.querySelector<HTMLElement>("[data-rail-connected]");
  const list = root.querySelector<HTMLElement>("[data-rail-connected-list]");
  // Whether the user has clicked "show N more" for the current item set. A
  // title-resolution repaint (same generation) must preserve this so it
  // doesn't collapse the list the user just expanded; a genuinely new setter
  // call (new generation) starts collapsed again.
  let expanded = false;

  // repaint=true means "same item set, just fresher labels" — keep whatever
  // limit is currently on screen. repaint=false (a fresh setter call) always
  // starts collapsed.
  const paintItems = (items: GhWorkItem[], repaint = false): void => {
    if (!section || !list) return;
    if (!items.length) {
      section.hidden = true;
      list.innerHTML = "";
      return;
    }
    if (!repaint) expanded = false;
    section.hidden = false;
    // A busy workspace can link dozens of PRs/issues; cap the default view and
    // reveal the rest behind one click rather than a wall of rows.
    const paint = (limit: number): void => {
      const shown = items.slice(0, limit);
      const hidden = items.length - shown.length;
      list.innerHTML =
        renderConnectedWorkHtml(shown, apiOrigin) +
        (hidden > 0
          ? `<button type="button" class="ws-rail__more" data-rail-more>show ${hidden} more</button>`
          : "");
      list.querySelector<HTMLButtonElement>("[data-rail-more]")?.addEventListener(
        "click",
        () => {
          expanded = true;
          paint(items.length);
        },
        { once: true },
      );
    };
    paint(expanded ? items.length : CONNECTED_WORK_CAP);
  };

  const setter: ConnectedWorkSetter = (items, titles) => {
    const relabeled = planTitleRepaint(items, titles ?? null);
    paintItems(relabeled ?? items, titles !== undefined);
  };
  window.__uploadsSetConnectedWork = setter;
  return setter;
}

export interface InitWorkspaceRailOptions {
  /** Query root for the rail's `data-rail-*` hooks. Defaults to `document`. */
  root?: Document | Element;
}

/**
 * Mount the rail for one workspace-tab page load. Call directly from
 * `WorkspaceLayout.astro`'s `onAstroPageLoad` callback — this function gates
 * its own `/me/*` fetches behind `onSession` internally (same shape as
 * `initWorkspacesNav`), so callers don't need to re-wrap it. The
 * connected-work hook is bound synchronously before that gate, so it exists
 * immediately regardless of session-resolution timing or script order
 * relative to the files tab's own script.
 */
export function initWorkspaceRail(
  apiOrigin: string,
  workspace: string,
  opts: InitWorkspaceRailOptions = {},
): void {
  const root = opts.root ?? document;

  const setConnectedWork = bindConnectedWorkSetter(root, apiOrigin);
  setConnectedWork([]);

  const detailsEl = root.querySelector<HTMLElement>("[data-rail-details]");
  const usageEl = root.querySelector<HTMLElement>("[data-rail-usage]");

  onSession(() => {
    void getWorkspaceSummary(apiOrigin, workspace).then((result) => {
      if (result.kind !== "success") {
        if (detailsEl) detailsEl.textContent = "Details unavailable.";
        if (usageEl) usageEl.textContent = "Usage unavailable.";
        return;
      }
      const ws: MyWorkspace = result.workspace;
      if (detailsEl) detailsEl.innerHTML = renderDetailsHtml(ws);
      if (usageEl) {
        usageEl.innerHTML = result.usage ? renderUsageHtml(result.usage) : "Usage unavailable.";
      }
    });
  });
}
