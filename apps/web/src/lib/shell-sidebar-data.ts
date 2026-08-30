/**
 * Props shaping for the `ShellSidebar` island (issue #798).
 *
 * Kept JSX-free and DOM-free so both shells' nav data — and the `sidebar_state`
 * cookie the layouts read server-side — are plain functions the vitest suite
 * can exercise directly. `ShellSidebar.tsx` only turns these shapes into kit
 * components; every decision about *what* is in the nav lives here.
 *
 * The account sections mirror `workspaces-nav.ts` (which stays the source of
 * truth for tab ids, paths, and pathname parsing) rather than restating them.
 */
import { shouldShowProBadge } from "./plan-badge";
import type { MyWorkspace, WorkspaceCreateQuota } from "./api-client";
import {
  canCreateWorkspace,
  MANAGE_WORKSPACES_HREF,
  WORKSPACE_NAV_TABS,
  workspacePath,
  workspaceSettingsSubpageFromPathname,
  workspaceTabFromPathname,
  type WorkspaceNavTab,
} from "./workspaces-nav";

/** Icon slot names. The island owns the glyph; props stay serializable JSON. */
export type ShellNavIcon =
  | "screenshots"
  | "files"
  | "galleries"
  | "people"
  | "billing"
  | "settings"
  | "account"
  | "developers"
  | "workspaces"
  | "metrics"
  | "users"
  | "oauth"
  | "email"
  | "dot";

export interface ShellNavItem {
  label: string;
  href: string;
  current: boolean;
  icon: ShellNavIcon;
  /** Settings sub-pages — rendered as a `SidebarMenuSub` row under `settings`. */
  nested?: boolean;
}

export interface ShellNavSection {
  /** Eyebrow above the group — the `.side-label` copy #601 established. */
  label: string;
  items: ShellNavItem[];
}

export interface ShellWorkspaceOption {
  slug: string;
  label: string;
  href: string;
  current: boolean;
  pro: boolean;
}

export interface ShellSwitcher {
  /** Trigger copy — the active workspace, or "workspaces" off one. */
  activeLabel: string;
  activePro: boolean;
  options: ShellWorkspaceOption[];
  /** Create link, or null once the creation cap is reached. */
  createHref: string | null;
  /** Shown instead of `createHref` at the cap — carries the explanation. */
  manageHref: string;
}

export interface ShellSidebarProps {
  /** `aria-label` for the nav landmark ("Account sections" / "Admin sections"). */
  ariaLabel: string;
  sections: ShellNavSection[];
  /** Account shell only; admin passes null and gets a plain header label. */
  switcher: ShellSwitcher | null;
  /** Header copy when there is no switcher. */
  headerLabel: string;
  headerHref: string;
  /** From the `sidebar_state` cookie — must match on server and client. */
  defaultOpen: boolean;
}

const TAB_ICONS: Record<WorkspaceNavTab, ShellNavIcon> = {
  screenshots: "screenshots",
  files: "files",
  galleries: "galleries",
  people: "people",
  billing: "billing",
  settings: "settings",
};

/** Cookie shadcn's `SidebarProvider` writes. Absent/malformed reads as open. */
export const SIDEBAR_STATE_COOKIE = "sidebar_state";

/**
 * `defaultOpen` from a raw `Cookie:` header. Anything but a literal `false`
 * keeps the always-open look the shell has today, so a missing or garbled
 * value can never collapse the nav on someone unexpectedly.
 */
export function readSidebarDefaultOpen(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return true;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SIDEBAR_STATE_COOKIE) continue;
    return part.slice(eq + 1).trim() !== "false";
  }
  return true;
}

export type AccountSectionId = "workspaces" | "profile" | "developers" | "connected-apps";

/** Nav rows read as proper nouns; the shared tab list keeps its lowercase ids. */
function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Account nav: the workspace group (only with an active workspace) followed by
 * the always-present personal group. `pathname` decides which row is current;
 * `workspace` may come from the URL (server) or the last-used cache (client),
 * which is why it is a separate argument rather than re-derived here.
 */
export function accountNavSections(options: {
  pathname: string;
  workspace: string;
  section: AccountSectionId;
}): ShellNavSection[] {
  const { pathname, workspace, section } = options;
  const sections: ShellNavSection[] = [];

  if (workspace) {
    const activeTab = workspaceTabFromPathname(pathname);
    const subpage = activeTab === "settings" ? workspaceSettingsSubpageFromPathname(pathname) : "";
    const items: ShellNavItem[] = [];
    for (const tab of WORKSPACE_NAV_TABS) {
      items.push({
        label: capitalize(tab.label),
        href: workspacePath(workspace, tab.id),
        current: activeTab === tab.id,
        icon: TAB_ICONS[tab.id],
      });
      if (tab.id !== "settings" || !subpage) continue;
      const base = `/account/workspaces/${encodeURIComponent(workspace)}/settings`;
      items.push({
        label: "GitHub comment",
        href: base,
        current: subpage === "comment",
        icon: "dot",
        nested: true,
      });
      items.push({
        label: "Storage",
        href: `${base}/storage`,
        current: subpage === "storage",
        icon: "dot",
        nested: true,
      });
    }
    sections.push({ label: "Workspace", items });
  }

  sections.push({
    label: "Personal",
    items: [
      {
        label: "Account",
        href: "/account/profile",
        current: section === "profile",
        icon: "account",
      },
      {
        label: "Developers",
        href: "/account/developers",
        current: section === "developers",
        icon: "developers",
      },
      {
        label: "Connected apps",
        href: "/account/connected-apps",
        current: section === "connected-apps",
        icon: "oauth",
      },
    ],
  });

  return sections;
}

export type AdminSectionId = "workspaces" | "metrics" | "users" | "oauth" | "email";

const ADMIN_NAV: { id: AdminSectionId; label: string; href: string; icon: ShellNavIcon }[] = [
  { id: "workspaces", label: "Workspaces", href: "/admin", icon: "workspaces" },
  { id: "metrics", label: "Metrics", href: "/admin/metrics", icon: "metrics" },
  { id: "users", label: "Users", href: "/admin/users", icon: "users" },
  { id: "oauth", label: "OAuth apps", href: "/admin/oauth", icon: "oauth" },
  { id: "email", label: "Email", href: "/admin/email", icon: "email" },
];

/**
 * Admin nav: the admin group, then a short "back out" group. Sign-out is not
 * here — it lives in the header avatar menu, the same place the account shell
 * has kept it since #601.
 */
export function adminNavSections(options: { section: AdminSectionId }): ShellNavSection[] {
  const personal: ShellNavItem[] = [
    { label: "Account", href: "/account", current: false, icon: "account" },
  ];
  return [
    {
      label: "Admin",
      items: ADMIN_NAV.map((item) => ({
        label: item.label,
        href: item.href,
        current: item.id === options.section,
        icon: item.icon,
      })),
    },
    { label: "Personal", items: personal },
  ];
}

/**
 * Switcher data for the header dropdown. Rows preserve the current tab so
 * switching workspaces lands on the same section, and exactly one trailing row renders:
 * create while there is allowance left, otherwise manage.
 */
export function workspaceSwitcherData(
  workspaces: readonly MyWorkspace[],
  options: { active?: string; activeTab?: WorkspaceNavTab | ""; quota?: WorkspaceCreateQuota } = {},
): ShellSwitcher {
  const active = options.active ?? "";
  const activeTab = options.activeTab || "";
  const match = workspaces.find((ws) => ws.workspace === active);
  return {
    activeLabel: active ? (match ? displayName(match) : active) : "workspaces",
    activePro: !!active && shouldShowProBadge(match?.plan),
    options: workspaces.map((ws) => ({
      slug: ws.workspace,
      label: displayName(ws),
      href: workspacePath(ws.workspace, activeTab),
      current: ws.workspace === active,
      pro: shouldShowProBadge(ws.plan),
    })),
    createHref: canCreateWorkspace(options.quota) ? "/account/workspaces/new" : null,
    manageHref: MANAGE_WORKSPACES_HREF,
  };
}

function displayName(ws: MyWorkspace): string {
  return ws.organization.name || ws.workspace;
}
