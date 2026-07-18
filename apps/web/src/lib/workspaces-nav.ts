/**
 * Nested workspaces list in the account sidebar.
 * Fills `#workspaces-nav-list` after session + GET /me/workspaces.
 *
 * Caches the last successful list in sessionStorage (same idea as the session
 * user cache) so navigations can paint memberships immediately and revalidate
 * in the background — avoids the empty-nested-list flash while logged in.
 */
import { getMyWorkspaces, type MyWorkspace } from "./api-client";
import { onSession } from "./account-shell";
import { escapeHtml, isWorkspaceAdminRole } from "./workspace-ui";

/** sessionStorage key — UX only; membership is still enforced server-side. */
export const WORKSPACES_CACHE_KEY = "uploads:myWorkspaces";

export type WorkspaceNavPage = "overview" | "invite";

export type WorkspacesNavOptions = {
  /** Active workspace slug (from the layout). */
  active?: string;
  /** Nested page under the active workspace (invite, etc.). */
  page?: WorkspaceNavPage;
};

type CachePayload = { workspaces: MyWorkspace[] };

export function readCachedWorkspaces(): MyWorkspace[] | null {
  try {
    const raw = sessionStorage.getItem(WORKSPACES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachePayload;
    if (!parsed || !Array.isArray(parsed.workspaces)) return null;
    return parsed.workspaces.filter(
      (ws) =>
        ws &&
        typeof ws.workspace === "string" &&
        typeof ws.role === "string" &&
        ws.organization &&
        typeof ws.organization.name === "string",
    );
  } catch {
    return null;
  }
}

export function writeCachedWorkspaces(workspaces: MyWorkspace[]): void {
  try {
    sessionStorage.setItem(WORKSPACES_CACHE_KEY, JSON.stringify({ workspaces }));
  } catch {
    // Private mode / quota — nav still works without the cache.
  }
}

export function clearCachedWorkspaces(): void {
  try {
    sessionStorage.removeItem(WORKSPACES_CACHE_KEY);
  } catch {
    // ignore
  }
}

/** Render one workspace row (+ Invite sub-link when active and admin). */
export function renderWorkspacesNavHtml(
  workspaces: MyWorkspace[],
  options: WorkspacesNavOptions = {},
): string {
  const active = options.active ?? "";
  const page = options.page ?? "overview";

  return workspaces
    .map((ws) => {
      const label = ws.organization.name || ws.workspace;
      const href = `/account/workspaces/${encodeURIComponent(ws.workspace)}`;
      const isActive = active === ws.workspace;
      const current =
        isActive && page === "overview"
          ? ' aria-current="page"'
          : isActive
            ? ' aria-current="true"'
            : "";
      const inviteHref = `${href}/invite`;
      const showInvite = isActive && isWorkspaceAdminRole(ws.role);
      const inviteCurrent = page === "invite" ? ' aria-current="page"' : "";

      const inviteBlock = showInvite
        ? `<div class="side-nested-sub">
            <a href="${escapeHtml(inviteHref)}" class="side-nested-item side-nested-subitem"${inviteCurrent}>Invite</a>
          </div>`
        : "";

      return `<div class="side-workspace">
        <a href="${escapeHtml(href)}" class="side-nested-item"${current}>${escapeHtml(label)}</a>
        ${inviteBlock}
      </div>`;
    })
    .join("");
}

function paint(
  listEl: HTMLElement,
  workspaces: MyWorkspace[],
  options: WorkspacesNavOptions,
): void {
  listEl.innerHTML = renderWorkspacesNavHtml(workspaces, options);
}

/**
 * Optimistic paint from cache, then revalidate after session.
 * Call once per account shell mount.
 */
export function initWorkspacesNav(
  apiOrigin: string,
  listEl: HTMLElement,
  options: WorkspacesNavOptions | string = {},
): void {
  // Back-compat: older call sites passed the active slug as a string.
  const opts: WorkspacesNavOptions =
    typeof options === "string" ? { active: options } : (options ?? {});

  const cached = readCachedWorkspaces();
  if (cached?.length) paint(listEl, cached, opts);

  onSession(() => {
    void getMyWorkspaces(apiOrigin).then((result) => {
      if (result.kind !== "success") return;
      writeCachedWorkspaces(result.workspaces);
      paint(listEl, result.workspaces, opts);
    });
  });
}
