/**
 * Workspace nav data for the signed-in shell: tab definitions, pathname
 * parsing, and the membership caches behind the sidebar's workspace switcher
 * (rendered by the `ShellSidebar` island via `shell-sidebar-data.ts`).
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
import { isBrowseWorkspace, workspaceFromPathname } from "./workspace-browse-url";

/** Storage keys — UX only; membership is still enforced server-side. */
export const WORKSPACES_CACHE_KEY = "uploads:myWorkspaces";
export const ACTIVE_WORKSPACE_CACHE_KEY = "uploads:activeWorkspace";

export type WorkspaceNavTab =
  | "files"
  | "screenshots"
  | "galleries"
  | "people"
  | "billing"
  | "settings";

export const WORKSPACE_NAV_TABS: {
  id: WorkspaceNavTab;
  label: string;
  /** Path suffix after `/account/workspaces/:name`. */
  path: string;
}[] = [
  { id: "screenshots", label: "screenshots", path: "/screenshots" },
  { id: "files", label: "files", path: "/files" },
  { id: "galleries", label: "galleries", path: "/galleries" },
  { id: "people", label: "people", path: "/people" },
  { id: "billing", label: "billing", path: "/billing" },
  { id: "settings", label: "settings", path: "/settings" },
];

/** Workspace home — the screenshots tab. */
export function workspaceHomePath(workspace: string): string {
  return workspacePath(workspace, "screenshots");
}

/** Path for a workspace tab. Unknown/empty tab falls through to screenshots. */
export function workspacePath(
  workspace: string,
  tab: WorkspaceNavTab | "" = "screenshots",
): string {
  const base = `/account/workspaces/${encodeURIComponent(workspace)}`;
  const suffix = tabPathSuffix(tab);
  return `${base}${suffix}`;
}

/** `?to=` allowlist for the workspaces index auto-open. Anything else is home. */
export function workspaceOpenTab(to: string | null | undefined): "files" | "screenshots" {
  return to === "files" ? "files" : "screenshots";
}

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
  if (!segment) return "screenshots";
  if (segment === "screenshots") return "screenshots";
  if (segment === "files") return "files";
  if (segment === "galleries") return "galleries";
  if (segment === "people" || segment === "invite") return "people";
  if (segment === "billing") return "billing";
  if (segment === "settings") return "settings";
  return "";
}

export type WorkspaceSettingsSubpage = "comment" | "storage";

/**
 * Which settings sub-page is active, for the sidebar's nested sub-nav
 * (`shell-sidebar-data.ts`'s workspace section). `""` off the settings routes
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

/** Path suffix that keeps the current tab when switching workspaces.
 * Off-workspace routes (empty tab) land on screenshots, the workspace home.
 * Settings deliberately maps to the tab root, not the sub-page — sub-pages
 * are workspace-specific detail views. */
function tabPathSuffix(tab: WorkspaceNavTab | ""): string {
  if (!tab) return "/screenshots";
  return WORKSPACE_NAV_TABS.find((t) => t.id === tab)?.path ?? "/screenshots";
}
