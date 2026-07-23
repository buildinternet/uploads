/**
 * Workspace switcher + section links in the account sidebar.
 *
 * Section heading = current workspace (dropdown of memberships + "+ new
 * workspace"). When a workspace is active, files / galleries / people /
 * settings sit as flat rows underneath.
 *
 * Memberships live in sessionStorage (instant paint, revalidated after
 * session). Last-used workspace lives in localStorage so it survives
 * sign-out and drives the index auto-open after login.
 */
import { getMyWorkspaces, type MyWorkspace } from "./api-client";
import { onSession } from "./account-shell";
import { isBrowseWorkspace, workspaceFromPathname } from "./workspace-browse-url";
import { escapeHtml } from "./workspace-ui";

/** Storage keys — UX only; membership is still enforced server-side. */
export const WORKSPACES_CACHE_KEY = "uploads:myWorkspaces";
export const ACTIVE_WORKSPACE_CACHE_KEY = "uploads:activeWorkspace";

export type WorkspaceNavTab = "files" | "galleries" | "people" | "billing" | "settings";

export const WORKSPACE_NAV_TABS: {
  id: WorkspaceNavTab;
  label: string;
  /** Path suffix after `/account/workspaces/:name` — empty for files. */
  path: string;
}[] = [
  { id: "files", label: "files", path: "" },
  { id: "galleries", label: "galleries", path: "/galleries" },
  { id: "people", label: "people", path: "/people" },
  { id: "billing", label: "billing", path: "/billing" },
  { id: "settings", label: "settings", path: "/settings" },
];

export type WorkspacesNavOptions = {
  active?: string;
  activeTab?: WorkspaceNavTab | "";
};

type CachePayload = { workspaces: MyWorkspace[] };

function storeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function storeSet(store: Storage, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Private mode / quota — nav still works without the cache.
  }
}

function storeRemove(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // ignore
  }
}

export function readCachedWorkspaces(): MyWorkspace[] | null {
  const raw = storeGet(sessionStorage, WORKSPACES_CACHE_KEY);
  if (!raw) return null;
  try {
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
  storeSet(sessionStorage, WORKSPACES_CACHE_KEY, JSON.stringify({ workspaces }));
}

export function clearCachedWorkspaces(): void {
  storeRemove(sessionStorage, WORKSPACES_CACHE_KEY);
}

/** Last-used workspace slug (localStorage; session fallback for older tabs). */
export function readCachedActiveWorkspace(): string {
  const raw =
    storeGet(localStorage, ACTIVE_WORKSPACE_CACHE_KEY) ??
    storeGet(sessionStorage, ACTIVE_WORKSPACE_CACHE_KEY);
  return raw && isBrowseWorkspace(raw) ? raw : "";
}

export function writeCachedActiveWorkspace(workspace: string): void {
  if (!isBrowseWorkspace(workspace)) return;
  storeSet(localStorage, ACTIVE_WORKSPACE_CACHE_KEY, workspace);
  // Drop any pre-migration session copy so it can't re-surface later.
  storeRemove(sessionStorage, ACTIVE_WORKSPACE_CACHE_KEY);
}

export function clearCachedActiveWorkspace(): void {
  storeRemove(localStorage, ACTIVE_WORKSPACE_CACHE_KEY);
  storeRemove(sessionStorage, ACTIVE_WORKSPACE_CACHE_KEY);
}

/**
 * Workspace to open from the index after login.
 * One membership → that workspace. Multi → last-used if still a member.
 * Otherwise null (show the picker).
 */
export function resolveDefaultWorkspace(
  workspaces: readonly { workspace: string }[],
  lastActive = "",
): string | null {
  if (workspaces.length === 1) return workspaces[0]!.workspace;
  if (lastActive && workspaces.some((ws) => ws.workspace === lastActive)) return lastActive;
  return null;
}

/**
 * Workspace slug for the account sidebar.
 * URL → layout boot global → last-used cache. Visiting a workspace route
 * refreshes the last-used cache.
 */
export function resolveSidebarWorkspace(pathname: string, bootGlobal = ""): string {
  const fromPath = workspaceFromPathname(pathname);
  if (fromPath) {
    writeCachedActiveWorkspace(fromPath);
    return fromPath;
  }
  const fallback = bootGlobal || readCachedActiveWorkspace();
  return isBrowseWorkspace(fallback) ? fallback : "";
}

function displayName(ws: MyWorkspace): string {
  return ws.organization.name || ws.workspace;
}

/**
 * Active workspace tab from `/account/workspaces/:name[/*]`.
 * Empty on the index, create page, or unrelated routes.
 */
export function workspaceTabFromPathname(pathname: string): WorkspaceNavTab | "" {
  const match = pathname.match(/^\/account\/workspaces\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!match) return "";
  const slug = decodeURIComponent(match[1] ?? "");
  if (!slug || slug === "new") return "";
  const segment = match[2] ?? "";
  if (!segment) return "files";
  if (segment === "galleries") return "galleries";
  if (segment === "people" || segment === "invite") return "people";
  if (segment === "billing") return "billing";
  if (segment === "settings") return "settings";
  return "";
}

/** Switcher dropdown HTML. */
export function renderSwitcherMenuHtml(
  workspaces: MyWorkspace[],
  options: WorkspacesNavOptions = {},
): string {
  const active = options.active ?? "";
  const rows = workspaces
    .map((ws) => {
      const href = `/account/workspaces/${encodeURIComponent(ws.workspace)}`;
      const current = active === ws.workspace;
      const cls = current ? "ws-switcher__item is-current" : "ws-switcher__item";
      const aria = current ? ' aria-current="true"' : "";
      return `<a href="${escapeHtml(href)}" class="${cls}"${aria}>${escapeHtml(displayName(ws))}</a>`;
    })
    .join("");

  return (
    rows +
    (rows ? `<div class="ws-switcher__sep"></div>` : "") +
    `<a href="/account/workspaces/new" class="ws-switcher__item ws-switcher__item--new">+ new workspace</a>`
  );
}

/** Section links under the switcher. Empty when no workspace is active. */
export function renderWorkspaceSectionNavHtml(
  workspace: string,
  activeTab: WorkspaceNavTab | "" = "",
): string {
  if (!workspace) return "";
  const base = `/account/workspaces/${encodeURIComponent(workspace)}`;
  return WORKSPACE_NAV_TABS.map((tab) => {
    const href = `${base}${tab.path}`;
    const current = activeTab === tab.id ? ' aria-current="page"' : "";
    return `<a href="${escapeHtml(href)}" class="side-link"${current}>${escapeHtml(tab.label)}</a>`;
  }).join("");
}

/** Label on the switcher trigger. */
export function switcherLabel(workspaces: MyWorkspace[], active: string): string {
  if (!active) return "workspaces";
  const match = workspaces.find((ws) => ws.workspace === active);
  return match ? displayName(match) : active;
}

type SwitcherEls = {
  trigger: HTMLButtonElement;
  label: HTMLElement;
  menu: HTMLElement;
  section: HTMLElement;
};

function closeMenu(els: SwitcherEls): void {
  els.trigger.setAttribute("aria-expanded", "false");
  els.menu.hidden = true;
}

function paint(els: SwitcherEls, workspaces: MyWorkspace[], opts: WorkspacesNavOptions): void {
  let active = opts.active ?? "";
  // Drop a stale last-used slug if the user is no longer a member.
  if (active && workspaces.length > 0 && !workspaces.some((ws) => ws.workspace === active)) {
    clearCachedActiveWorkspace();
    active = "";
  }
  // Empty on personal routes so no workspace tab is falsely current.
  const activeTab = opts.activeTab || "";

  els.label.textContent = switcherLabel(workspaces, active);
  els.menu.innerHTML = renderSwitcherMenuHtml(workspaces, { active });

  if (active) {
    els.section.hidden = false;
    els.section.innerHTML = renderWorkspaceSectionNavHtml(active, activeTab);
  } else {
    els.section.hidden = true;
    els.section.innerHTML = "";
  }
}

function bindSwitcher(els: SwitcherEls): void {
  if (els.trigger.dataset.bound === "1") return;
  els.trigger.dataset.bound = "1";

  els.trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = els.trigger.getAttribute("aria-expanded") === "true";
    els.trigger.setAttribute("aria-expanded", open ? "false" : "true");
    els.menu.hidden = open;
  });

  els.menu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("a")) closeMenu(els);
  });

  // One document listener for outside click + Escape (survives ClientRouter).
  if (document.documentElement.dataset.wsSwitcherDocBound === "1") return;
  document.documentElement.dataset.wsSwitcherDocBound = "1";

  document.addEventListener("click", (event) => {
    const root = document.getElementById("ws-switcher");
    if (!root || root.contains(event.target as Node)) return;
    const trigger = document.querySelector<HTMLButtonElement>("#ws-switcher-trigger");
    const menu = document.querySelector<HTMLElement>("#ws-switcher-menu");
    if (!trigger || !menu) return;
    trigger.setAttribute("aria-expanded", "false");
    menu.hidden = true;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const trigger = document.querySelector<HTMLButtonElement>("#ws-switcher-trigger");
    const menu = document.querySelector<HTMLElement>("#ws-switcher-menu");
    if (!trigger || !menu || menu.hidden) return;
    trigger.setAttribute("aria-expanded", "false");
    menu.hidden = true;
    trigger.focus();
  });
}

/** Optimistic paint from cache, then revalidate after session. */
export function initWorkspacesNav(apiOrigin: string, options: WorkspacesNavOptions = {}): void {
  const trigger = document.querySelector<HTMLButtonElement>("#ws-switcher-trigger");
  const label = document.querySelector<HTMLElement>("#ws-switcher-label");
  const menu = document.querySelector<HTMLElement>("#ws-switcher-menu");
  const section = document.querySelector<HTMLElement>("#workspace-section-nav");
  if (!trigger || !label || !menu || !section) return;

  const els: SwitcherEls = { trigger, label, menu, section };
  bindSwitcher(els);

  const opts: WorkspacesNavOptions = {
    active: resolveSidebarWorkspace(location.pathname, options.active ?? ""),
    activeTab: options.activeTab || workspaceTabFromPathname(location.pathname),
  };

  paint(els, readCachedWorkspaces() ?? [], opts);

  onSession(() => {
    void getMyWorkspaces(apiOrigin).then((result) => {
      if (result.kind !== "success") return;
      writeCachedWorkspaces(result.workspaces);
      paint(els, result.workspaces, opts);
    });
  });
}
