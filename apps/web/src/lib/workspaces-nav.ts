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
import {
  getMyWorkspaces,
  parseWorkspaceCreateQuota,
  type MyWorkspace,
  type WorkspaceCreateQuota,
  type WorkspacesResult,
} from "./api-client";
import { onSession } from "./account-shell";
import { isBrowseWorkspace, workspaceFromPathname } from "./workspace-browse-url";
import { shouldShowProBadge } from "./plan-badge";
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
  /** Creation quota; absent means allowed (see `parseWorkspaceCreateQuota`). */
  quota?: WorkspaceCreateQuota;
};

/**
 * The workspace index normally auto-opens a workspace. This param is how a
 * link says "the user asked for the list itself" — kept next to the href
 * that sets it and the predicate that reads it, so the three can't drift.
 */
const MANAGE_PARAM = "manage";

/** Where the workspace index is reachable on purpose, without auto-opening. */
export const MANAGE_WORKSPACES_HREF = `/account/workspaces?${MANAGE_PARAM}=1`;

/** Whether `search` (e.g. `location.search`) asked for the list itself. */
export function isManageRequest(search: string): boolean {
  return new URLSearchParams(search).get(MANAGE_PARAM) === "1";
}

/** Advisory: may this user create another workspace? Absent quota → yes. */
export function canCreateWorkspace(quota?: WorkspaceCreateQuota): boolean {
  return quota ? quota.allowed : true;
}

/** In-flight `/me/workspaces` request, shared by everything on the page. */
let inFlightWorkspaces: Promise<WorkspacesResult> | null = null;

/**
 * Fetch `/me/workspaces` once per page load, however many surfaces ask.
 *
 * The account shell loads this on every page for the switcher, and
 * individual pages (the index, the create form) need the same payload for
 * their own rendering. Without this, each surface fired its own request for
 * a response the others had just received. Concurrent callers share one
 * promise; the slot clears on settle so a later navigation or an explicit
 * retry still revalidates.
 *
 * Writes the cache on success so callers don't each have to remember to.
 */
export function loadWorkspaces(apiOrigin: string): Promise<WorkspacesResult> {
  if (!inFlightWorkspaces) {
    inFlightWorkspaces = getMyWorkspaces(apiOrigin)
      .then((result) => {
        if (result.kind === "success") writeCachedWorkspaces(result.workspaces, result.quota);
        return result;
      })
      .finally(() => {
        inFlightWorkspaces = null;
      });
  }
  return inFlightWorkspaces;
}

type CachePayload = { workspaces: MyWorkspace[]; quota?: WorkspaceCreateQuota };

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

/** The cache blob, parsed once. Null for absent or unparseable. */
function readCachePayload(): CachePayload | null {
  const raw = storeGet(sessionStorage, WORKSPACES_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachePayload;
  } catch {
    return null;
  }
}

export function readCachedWorkspaces(): MyWorkspace[] | null {
  const parsed = readCachePayload();
  if (!parsed || !Array.isArray(parsed.workspaces)) return null;
  return parsed.workspaces.filter(
    (ws) =>
      ws &&
      typeof ws.workspace === "string" &&
      typeof ws.role === "string" &&
      ws.organization &&
      typeof ws.organization.name === "string",
  );
}

export function writeCachedWorkspaces(
  workspaces: MyWorkspace[],
  quota?: WorkspaceCreateQuota,
): void {
  storeSet(sessionStorage, WORKSPACES_CACHE_KEY, JSON.stringify({ workspaces, quota }));
}

/**
 * Cached creation quota, so the optimistic first paint doesn't flash the
 * wrong switcher row before revalidation. `undefined` (no cache, older
 * payload, garbage) reads as "allowed" everywhere downstream.
 */
export function readCachedQuota(): WorkspaceCreateQuota | undefined {
  return parseWorkspaceCreateQuota(readCachePayload()?.quota);
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

/** Role preference for the cold-start fallback below. */
const FALLBACK_ROLES = ["owner", "admin"];

/**
 * Workspace to open from the index after login.
 *
 * One membership → that workspace. Multi → last-used if still a member.
 * Failing both (a fresh browser, cleared storage, a first visit after being
 * invited), the first workspace the user owns, else the first they
 * administer, else the first membership — so a signed-in user lands in a
 * workspace rather than being asked to choose every time. The switcher, not
 * this page, is how you change workspaces.
 *
 * A communal workspace (`communal`, set by the api — most accounts belong to
 * the shared one and many are `owner` there, so a naive role-first fallback
 * would land almost everyone in it) is skipped at every step of that fallback
 * and only used when it is the sole membership, so a user who happens to be
 * `owner` there still lands in their own workspace. The flag comes from the
 * server precisely so this file doesn't encode which slug that is.
 *
 * Null only when there are no memberships at all. The index suppresses the
 * auto-open entirely when it was reached deliberately (`?manage=1`).
 */
export function resolveDefaultWorkspace(
  // `communal` is required, not optional: an optional flag would let a future
  // caller omit it and silently un-skip the shared workspace with no type
  // error — exactly the drift this stopped inferring from the slug to avoid.
  workspaces: readonly { workspace: string; role?: string; communal: boolean }[],
  lastActive = "",
): string | null {
  if (workspaces.length === 1) return workspaces[0]!.workspace;
  if (lastActive && workspaces.some((ws) => ws.workspace === lastActive)) return lastActive;

  const own = workspaces.filter((ws) => !ws.communal);
  for (const role of FALLBACK_ROLES) {
    const match = own.find((ws) => ws.role === role);
    if (match) return match.workspace;
  }
  return own[0]?.workspace ?? workspaces[0]?.workspace ?? null;
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
      const badge = shouldShowProBadge(ws.plan) ? ` <span class="pro-badge">Pro</span>` : "";
      return `<a href="${escapeHtml(href)}" class="${cls}"${aria}>${escapeHtml(displayName(ws))}${badge}</a>`;
    })
    .join("");

  // One trailing row, never both: the fast path to creating while the user
  // has an allowance left, and once they're at the cap a link to the index
  // — which carries the explanation — instead of an offer that would be
  // refused. Absent quota keeps the create row (fail open).
  const trailer = canCreateWorkspace(options.quota)
    ? `<a href="/account/workspaces/new" class="ws-switcher__item ws-switcher__item--new">+ new workspace</a>`
    : `<a href="${MANAGE_WORKSPACES_HREF}" class="ws-switcher__item ws-switcher__item--manage">manage workspaces</a>`;

  return rows + (rows ? `<div class="ws-switcher__sep"></div>` : "") + trailer;
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
  els.menu.innerHTML = renderSwitcherMenuHtml(workspaces, { active, quota: opts.quota });

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
    quota: options.quota ?? readCachedQuota(),
  };

  paint(els, readCachedWorkspaces() ?? [], opts);

  onSession(() => {
    void loadWorkspaces(apiOrigin).then((result) => {
      if (result.kind !== "success") return;
      paint(els, result.workspaces, { ...opts, quota: result.quota });
    });
  });
}
