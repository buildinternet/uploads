/**
 * Workspace switcher + section links in the account sidebar.
 *
 * Section heading = current workspace (dropdown of memberships + "+ new
 * workspace"). When a workspace is active, files / galleries / people /
 * settings sit as flat rows underneath. Membership list is cached in
 * sessionStorage for instant paint, then revalidated after session.
 */
import { getMyWorkspaces, type MyWorkspace } from "./api-client";
import { onSession } from "./account-shell";
import { resolveActiveWorkspace } from "./workspace-browse-url";
import { escapeHtml } from "./workspace-ui";

/** sessionStorage key — UX only; membership is still enforced server-side. */
export const WORKSPACES_CACHE_KEY = "uploads:myWorkspaces";

export type WorkspaceNavTab = "files" | "galleries" | "people" | "settings";

export const WORKSPACE_NAV_TABS: {
  id: WorkspaceNavTab;
  label: string;
  /** Path suffix after `/account/workspaces/:name` — empty for files. */
  path: string;
}[] = [
  { id: "files", label: "files", path: "" },
  { id: "galleries", label: "galleries", path: "/galleries" },
  { id: "people", label: "people", path: "/people" },
  { id: "settings", label: "settings", path: "/settings" },
];

export type WorkspacesNavOptions = {
  active?: string;
  activeTab?: WorkspaceNavTab | "";
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
  const active = opts.active ?? "";
  const activeTab = opts.activeTab || "files";

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

  // Pathname wins after ClientRouter body swaps (boot global can lag).
  const opts: WorkspacesNavOptions = {
    active: resolveActiveWorkspace(location.pathname, options.active ?? ""),
    activeTab: options.activeTab || workspaceTabFromPathname(location.pathname),
  };

  const cached = readCachedWorkspaces();
  paint(els, cached ?? [], opts);

  onSession(() => {
    void getMyWorkspaces(apiOrigin).then((result) => {
      if (result.kind !== "success") return;
      writeCachedWorkspaces(result.workspaces);
      paint(els, result.workspaces, opts);
    });
  });
}
