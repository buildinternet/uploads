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
 * No workspace is treated specially here. `default` used to be skipped at
 * every step as the shared/communal tenant; that concept is retired and it is
 * now an ordinary workspace like any other.
 *
 * Null only when there are no memberships at all. The index suppresses the
 * auto-open entirely when it was reached deliberately (`?manage=1`).
 */
export function resolveDefaultWorkspace(
  workspaces: readonly { workspace: string; role?: string }[],
  lastActive = "",
): string | null {
  if (workspaces.length === 1) return workspaces[0]!.workspace;
  if (lastActive && workspaces.some((ws) => ws.workspace === lastActive)) return lastActive;

  for (const role of FALLBACK_ROLES) {
    const match = workspaces.find((ws) => ws.role === role);
    if (match) return match.workspace;
  }
  return workspaces[0]?.workspace ?? null;
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
 * Empty on the index, create page, or unrelated routes. `settings` is the one
 * tab that spans two routes (`/settings` and `/settings/storage`), so a third
 * segment is accepted only there — every other tab stays a strict single
 * segment rather than silently matching paths that don't exist.
 */
export function workspaceTabFromPathname(pathname: string): WorkspaceNavTab | "" {
  const match =
    pathname.match(/^\/account\/workspaces\/([^/]+)(?:\/([^/]+))?\/?$/) ??
    pathname.match(/^\/account\/workspaces\/([^/]+)\/(settings)\/[^/]+\/?$/);
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

export type WorkspaceSettingsSubpage = "comment" | "storage";

/**
 * Which settings sub-page is active, for the sidebar's nested sub-nav
 * (`AccountLayout`'s workspace section). `""` off the settings routes
 * entirely — callers only render the sub-nav when this is non-empty.
 */
export function workspaceSettingsSubpageFromPathname(
  pathname: string,
): WorkspaceSettingsSubpage | "" {
  const match = pathname.match(/^\/account\/workspaces\/[^/]+\/settings(?:\/([^/]+))?\/?$/);
  if (!match) return "";
  const sub = match[1] ?? "";
  if (!sub) return "comment";
  if (sub === "storage") return "storage";
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

/**
 * Nested sub-links shown under the "settings" tab once it's active — one
 * source of markup shared by `AccountLayout.astro`'s server render and this
 * module's client-side `paint()`, so the two can't drift apart. Empty when
 * `subpage` is `""` (not on a settings route).
 */
export function renderSettingsSubnavHtml(
  workspace: string,
  subpage: WorkspaceSettingsSubpage | "",
): string {
  if (!subpage) return "";
  const base = `/account/workspaces/${encodeURIComponent(workspace)}/settings`;
  const links: { href: string; label: string; current: boolean }[] = [
    { href: base, label: "github comment", current: subpage === "comment" },
    { href: `${base}/storage`, label: "storage", current: subpage === "storage" },
  ];
  return `<div class="ws-settings-subnav">${links
    .map(
      (link) =>
        `<a href="${escapeHtml(link.href)}" class="ws-settings-subnav__link"${
          link.current ? ' aria-current="page"' : ""
        }>${escapeHtml(link.label)}</a>`,
    )
    .join("")}</div>`;
}

/** Section links under the switcher. Empty when no workspace is active. */
export function renderWorkspaceSectionNavHtml(
  workspace: string,
  activeTab: WorkspaceNavTab | "" = "",
  settingsSubpage: WorkspaceSettingsSubpage | "" = "",
): string {
  if (!workspace) return "";
  const base = `/account/workspaces/${encodeURIComponent(workspace)}`;
  return WORKSPACE_NAV_TABS.map((tab) => {
    const href = `${base}${tab.path}`;
    const current = activeTab === tab.id ? ' aria-current="page"' : "";
    const link = `<a href="${escapeHtml(href)}" class="side-link"${current}>${escapeHtml(tab.label)}</a>`;
    const subnav =
      tab.id === "settings" ? renderSettingsSubnavHtml(workspace, settingsSubpage) : "";
    return link + subnav;
  }).join("");
}

/** Label on the switcher trigger. */
export function switcherLabel(workspaces: MyWorkspace[], active: string): string {
  if (!active) return "workspaces";
  const match = workspaces.find((ws) => ws.workspace === active);
  return match ? displayName(match) : active;
}

/** Whether the collapsed switcher trigger should show a Pro badge next to
 * the active workspace name — same rule as the menu row (shouldShowProBadge),
 * just resolved against whichever workspace is currently active. */
export function shouldShowTriggerBadge(workspaces: MyWorkspace[], active: string): boolean {
  if (!active) return false;
  const match = workspaces.find((ws) => ws.workspace === active);
  return shouldShowProBadge(match?.plan);
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

/**
 * Paint (or remove) the trigger's Pro badge as a sibling element right after
 * `els.label` — never via innerHTML with the (untrusted) workspace name, so
 * the label stays a plain textContent write and the badge is its own node.
 * Re-entrant: repeated calls reuse the existing badge node rather than
 * creating a new one each paint.
 */
function paintTriggerBadge(els: SwitcherEls, workspaces: MyWorkspace[], active: string): void {
  const existing = els.trigger.querySelector<HTMLElement>("[data-ws-switcher-badge]");
  if (!shouldShowTriggerBadge(workspaces, active)) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const badge = document.createElement("span");
  badge.dataset.wsSwitcherBadge = "";
  badge.className = "pro-badge";
  badge.textContent = "Pro";
  els.label.insertAdjacentElement("afterend", badge);
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
  paintTriggerBadge(els, workspaces, active);
  els.menu.innerHTML = renderSwitcherMenuHtml(workspaces, { active, quota: opts.quota });

  // The "workspace" eyebrow above the section nav tracks it 1:1. Toggled
  // here (not via a `:has(+ …:not([hidden]))` rule in account-shell.css)
  // because Chromium fails to re-resolve that selector when this function
  // flips the sibling's `hidden` — the rule matches on paper and still
  // computes `display: none`.
  const sectionLabel = document.getElementById("workspace-section-label");
  if (active) {
    els.section.hidden = false;
    const settingsSubpage =
      activeTab === "settings" ? workspaceSettingsSubpageFromPathname(location.pathname) : "";
    els.section.innerHTML = renderWorkspaceSectionNavHtml(active, activeTab, settingsSubpage);
    if (sectionLabel) sectionLabel.hidden = false;
  } else {
    els.section.hidden = true;
    els.section.innerHTML = "";
    if (sectionLabel) sectionLabel.hidden = true;
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
