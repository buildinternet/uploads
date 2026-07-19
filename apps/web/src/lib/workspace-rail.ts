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
 *  - fetches `getMyWorkspaces` → role badge (header) + details (slug/role/public url);
 *  - fetches `getMyWorkspaceUsage` → usage meters (`renderUsageHtml`, reused as-is).
 *
 * Connected-work hook contract (Task 8's files tab is the only caller):
 *   `window.__uploadsSetConnectedWork(items: GhWorkItem[]): void`
 * Call with the current view's deduped `connectedWork(files)` result. A
 * non-empty array shows the "connected work" section and renders one row per
 * item; an empty array hides it. Non-files tabs never call it, so the section
 * stays hidden by construction.
 */
import { getMyWorkspaces, getMyWorkspaceUsage, type MyWorkspace } from "./api-client";
import { onSession } from "./account-shell";
import { bindCopyButtons, escapeHtml, renderUsageHtml } from "./workspace-ui";
import type { GhKind, GhWorkItem } from "./gh-context";

export type ConnectedWorkSetter = (items: GhWorkItem[]) => void;

declare global {
  interface Window {
    /** See module doc — the documented connected-work hook Task 8's files tab calls. */
    __uploadsSetConnectedWork?: ConnectedWorkSetter;
  }
}

// Same GitHub mark used for a `kind: "pull"` row and a circled-info glyph for
// `kind: "issue"`, matching the 3A reference's rail "connected work" rows verbatim
// (`.context/2026-07-19-settings-overhaul-3a-reference.html` lines ~125 and ~132).
const CONNECTED_WORK_ICON: Record<GhKind, string> = {
  pull: '<svg class="ws-rail__connected-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"></path></svg>',
  issue:
    '<svg class="ws-rail__connected-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm9 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM8 4a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 4Z"></path></svg>',
};

function connectedWorkRowHtml(item: GhWorkItem): string {
  return `<div class="ws-rail__connected-item">${CONNECTED_WORK_ICON[item.kind]}<div class="ws-rail__connected-meta"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a><span class="ws-rail__connected-sub">${escapeHtml(item.kindLabel)}</span></div></div>`;
}

/** Pure row-HTML builder for the rail's "connected work" section. `[]` → `""`. */
export function renderConnectedWorkHtml(items: GhWorkItem[]): string {
  return items.map(connectedWorkRowHtml).join("");
}

/** Minimal shape `renderDetailsHtml` needs — `MyWorkspace` is a structural superset. */
export interface WorkspaceRailDetails {
  organization: { slug: string };
  role: string;
  hasPublicUrl: boolean;
}

/**
 * Pure builder for the rail's "details" `<dt>/<dd>` pairs. There is no public-URL
 * string on `MyWorkspace` (only the `hasPublicUrl` boolean) — render "configured"
 * / "—" rather than fabricating a URL.
 */
export function renderDetailsHtml(ws: WorkspaceRailDetails): string {
  const publicUrlLabel = ws.hasPublicUrl ? "configured" : "—";
  return (
    `<dt class="ws-rail__dt">slug</dt><dd class="ws-rail__dd">${escapeHtml(ws.organization.slug)}</dd>` +
    `<dt class="ws-rail__dt">your role</dt><dd class="ws-rail__dd ws-rail__dd--accent">${escapeHtml(ws.role)}</dd>` +
    `<dt class="ws-rail__dt">public url</dt><dd class="ws-rail__dd">${escapeHtml(publicUrlLabel)}</dd>`
  );
}

/**
 * Wire the documented `window.__uploadsSetConnectedWork` hook against the
 * "connected work" section under `root`, and return the setter (also used to
 * force it hidden/empty on boot). Safe to call once per page mount — each
 * WorkspaceLayout page load gets a fresh rail DOM, so re-assigning the global
 * here always points it at the current page's elements.
 */
function bindConnectedWorkSetter(root: Document | Element): ConnectedWorkSetter {
  const section = root.querySelector<HTMLElement>("[data-rail-connected]");
  const list = root.querySelector<HTMLElement>("[data-rail-connected-list]");
  const setter: ConnectedWorkSetter = (items) => {
    if (!section || !list) return;
    if (!items.length) {
      section.hidden = true;
      list.innerHTML = "";
      return;
    }
    list.innerHTML = renderConnectedWorkHtml(items);
    section.hidden = false;
  };
  window.__uploadsSetConnectedWork = setter;
  return setter;
}

export interface InitWorkspaceRailOptions {
  /** Query root for the rail's `data-rail-*` hooks and the header's `[data-role-badge]`. Defaults to `document`. */
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

  const setConnectedWork = bindConnectedWorkSetter(root);
  setConnectedWork([]);

  const railRoot = root.querySelector<HTMLElement>("[data-workspace-rail]");
  if (railRoot) bindCopyButtons(railRoot);

  const roleBadge = root.querySelector<HTMLElement>("[data-role-badge]");
  const detailsEl = root.querySelector<HTMLElement>("[data-rail-details]");
  const usageEl = root.querySelector<HTMLElement>("[data-rail-usage]");

  onSession(() => {
    void getMyWorkspaces(apiOrigin).then((result) => {
      if (result.kind !== "success") {
        // Mirror the usage fetch below (and the files tab's explicit outage
        // state) rather than leaving the details list silently blank.
        if (detailsEl) detailsEl.textContent = "Details unavailable.";
        return;
      }
      const ws: MyWorkspace | undefined = result.workspaces.find(
        (item) => item.workspace === workspace,
      );
      if (!ws) return;
      if (roleBadge) {
        roleBadge.textContent = `[${ws.role}]`;
        roleBadge.hidden = false;
      }
      if (detailsEl) detailsEl.innerHTML = renderDetailsHtml(ws);
    });

    void getMyWorkspaceUsage(apiOrigin, workspace).then((usage) => {
      if (!usageEl) return;
      usageEl.innerHTML = usage ? renderUsageHtml(usage) : "Usage unavailable.";
    });
  });
}
