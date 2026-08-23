/**
 * The signed-in shells' left column (issue #798) — one island for both
 * `AccountLayout` and `AdminLayout`.
 *
 * SSR-rendered by the layout with no `client:*` directive (banned repo-wide,
 * see astro.config.mjs) and `hydrateRoot`-ed from the layout's own module
 * script, the same mechanism the workspace files table uses. Every row is a
 * real anchor, so the server markup stays navigable if hydration never
 * happens.
 *
 * Collapse state lives in shadcn's `sidebar_state` cookie; the layout reads it
 * server-side and passes `defaultOpen`, so server and client agree on first
 * paint. Nothing in render reads the clock or `Math.random` — including the
 * loading rows, which use fixed widths rather than the kit's randomized
 * `SidebarMenuSkeleton`.
 *
 * Mobile (below the kit's md breakpoint) renders the Sheet drawer. The trigger
 * is a plain button in the Astro header that dispatches
 * `shell:sidebar-toggle`; `SidebarToggleBridge` below is what listens.
 */
import { useEffect, useState, type ReactNode } from "react";
import "@uploads/ui/styles.css";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@uploads/ui/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  useSidebar,
} from "@uploads/ui/components/ui/sidebar";
import { IslandErrorBoundary } from "../IslandErrorBoundary";
import {
  accountNavSections,
  workspaceSwitcherData,
  type AccountSectionId,
  type ShellIdentity,
  type ShellNavIcon,
  type ShellNavItem,
  type ShellNavSection,
  type ShellSidebarProps,
  type ShellSwitcher,
} from "../../lib/shell-sidebar-data";
import { onSession } from "../../lib/account-shell";
import {
  loadWorkspaces,
  readCachedQuota,
  readCachedWorkspaces,
  resolveSidebarWorkspace,
  workspaceTabFromPathname,
} from "../../lib/workspaces-nav";

/** Custom event the Astro header's mobile button fires. */
export const SIDEBAR_TOGGLE_EVENT = "shell:sidebar-toggle";

export interface ShellSidebarIslandProps extends ShellSidebarProps {
  /**
   * Account shell only: lets the island re-resolve the active workspace from
   * the last-used cache (personal routes carry no workspace in the URL) and
   * revalidate the membership list after the session lands.
   */
  account?: { apiOrigin: string; section: AccountSectionId; workspace: string };
}

/*
 * Local 16px glyph set rather than `lucide-react`: apps/web doesn't depend on
 * it (only @uploads/ui does), and the collapsed icon rail needs a glyph per
 * row. Sized by the kit's own `[&_svg]:size-4` rule.
 */
const ICON_PATHS: Record<ShellNavIcon | "switcher" | "plus", string> = {
  screenshots:
    "M2.5 5.5h2.2l1-1.8h4.6l1 1.8h2.2v7.5h-11zM10.5 9.2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  files: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  galleries: "M2.5 4.5h11v8h-11zM2.5 10.5l3-3 3 3 2-2 2.5 2.5",
  people:
    "M6.5 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM2 13.25c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5M11 3.6a2.25 2.25 0 0 1 0 4.3M12.3 9.9c1.2.45 1.9 1.4 1.9 2.9",
  billing: "M1.5 4.5h13v7h-13zM1.5 7.5h13",
  settings: "M2.5 5h11M2.5 11h11M6 3.5v3M10.5 9.5v3",
  account: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2.75 13.5c0-2.5 2.2-4 5.25-4s5.25 1.5 5.25 4",
  developers: "M3 4.5l3 3.5-3 3.5M8 12h5",
  workspaces: "M2.5 2.5h5v5h-5zM8.5 2.5h5v5h-5zM2.5 8.5h5v5h-5zM8.5 8.5h5v5h-5z",
  metrics: "M2.5 13.5h12M4.5 11.5V7M8 11.5V4M11.5 11.5V8.5",
  users:
    "M6.5 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM2 13.25c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5M11 3.6a2.25 2.25 0 0 1 0 4.3M12.3 9.9c1.2.45 1.9 1.4 1.9 2.9",
  oauth: "M10 8.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6.7 9.3L2.5 13.5M4.4 11.6l1.5 1.5",
  email: "M1.5 4h13v8h-13zM1.5 4.5l6.5 4.5 6.5-4.5",
  dot: "M8 8.7a.7.7 0 1 0 0-1.4.7.7 0 0 0 0 1.4z",
  switcher: "M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3",
  plus: "M8 3.5v9M3.5 8h9",
};

function Glyph({
  name,
  className,
}: {
  name: keyof typeof ICON_PATHS;
  className?: string;
}): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

function ProBadge(): ReactNode {
  return (
    <span className="rounded-sm bg-primary/15 px-1 text-[10px] leading-4 font-medium text-primary">
      Pro
    </span>
  );
}

/** Bridges the Astro header's mobile button into the provider's toggle. */
function SidebarToggleBridge(): null {
  const { toggleSidebar } = useSidebar();
  useEffect(() => {
    const handler = (): void => toggleSidebar();
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, handler);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, handler);
  }, [toggleSidebar]);
  return null;
}

/** One group. Nested rows (settings sub-pages) fold under the row above them. */
function NavGroup({ section }: { section: ShellNavSection }): ReactNode {
  const rows: ReactNode[] = [];
  for (let i = 0; i < section.items.length; i++) {
    const item = section.items[i]!;
    if (item.nested) continue;
    const nested: ShellNavItem[] = [];
    for (let j = i + 1; j < section.items.length && section.items[j]!.nested; j++) {
      nested.push(section.items[j]!);
    }
    rows.push(
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton
          isActive={item.current}
          tooltip={item.label}
          render={<a href={item.href} aria-current={item.current ? "page" : undefined} />}
        >
          <Glyph name={item.icon} />
          <span>{item.label}</span>
        </SidebarMenuButton>
        {nested.length > 0 && (
          <SidebarMenuSub>
            {nested.map((sub) => (
              <SidebarMenuSubItem key={sub.href}>
                <SidebarMenuSubButton
                  isActive={sub.current}
                  render={<a href={sub.href} aria-current={sub.current ? "page" : undefined} />}
                >
                  <span>{sub.label}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        )}
      </SidebarMenuItem>,
    );
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>{rows}</SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function WorkspaceSwitcher({ switcher }: { switcher: ShellSwitcher }): ReactNode {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-open:bg-sidebar-accent"
                aria-label="Switch workspace"
              >
                <Glyph name="workspaces" />
                <span className="flex min-w-0 items-center gap-1.5 font-medium">
                  <span className="truncate">{switcher.activeLabel}</span>
                  {switcher.activePro && <ProBadge />}
                </span>
                <Glyph name="switcher" className="ml-auto" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent align="start" className="min-w-56">
            {switcher.options.map((option) => (
              <DropdownMenuItem
                key={option.slug}
                render={<a href={option.href} />}
                aria-current={option.current ? "true" : undefined}
              >
                <span className="truncate">{option.label}</span>
                {option.pro && <ProBadge />}
              </DropdownMenuItem>
            ))}
            {switcher.options.length > 0 && <DropdownMenuSeparator />}
            {switcher.createHref ? (
              <DropdownMenuItem render={<a href={switcher.createHref} />}>
                <Glyph name="plus" />
                <span>new workspace</span>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem render={<a href={switcher.manageHref} />}>
                <Glyph name="workspaces" />
                <span>manage workspaces</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ShellSidebarBody(props: ShellSidebarIslandProps): ReactNode {
  const { account } = props;
  const [sections, setSections] = useState<ShellNavSection[]>(props.sections);
  const [switcher, setSwitcher] = useState<ShellSwitcher | null>(props.switcher);
  const [identity, setIdentity] = useState<ShellIdentity | null>(props.identity);

  // Fill the footer from the resolved session when the server didn't have one
  // (the admin shell resolves its session client-side).
  useEffect(() => {
    if (identity) return;
    onSession((user) => {
      setIdentity({ name: user.name, email: user.email });
    });
  }, [identity]);

  // Account shell only: the URL carries no workspace on personal routes, so
  // paint from the membership cache first and revalidate after the session.
  useEffect(() => {
    if (!account) return;
    let live = true;
    const active = resolveSidebarWorkspace(location.pathname, account.workspace);
    const activeTab = workspaceTabFromPathname(location.pathname);
    const apply = (
      workspaces: Parameters<typeof workspaceSwitcherData>[0],
      quota: ReturnType<typeof readCachedQuota>,
    ): void => {
      if (!live) return;
      setSwitcher(workspaceSwitcherData(workspaces, { active, activeTab, quota }));
      setSections(
        accountNavSections({
          pathname: location.pathname,
          workspace: active,
          section: account.section,
        }),
      );
    };

    apply(readCachedWorkspaces() ?? [], readCachedQuota());
    onSession(() => {
      void loadWorkspaces(account.apiOrigin).then((result) => {
        if (result.kind !== "success") return;
        apply(result.workspaces, result.quota);
      });
    });

    return () => {
      live = false;
    };
  }, [account]);

  return (
    <SidebarProvider
      defaultOpen={props.defaultOpen}
      className="relative min-h-0 w-auto items-stretch"
    >
      <SidebarToggleBridge />
      <Sidebar
        collapsible="icon"
        // In-flow inside the shell's nav column instead of the kit's default
        // viewport-fixed placement; the container keeps its own width
        // transition, so collapse-to-icons still animates the grid track.
        // The now-redundant spacer is hidden in account-shell.css.
        className="relative inset-auto h-auto"
      >
        <SidebarHeader>
          {switcher ? (
            <WorkspaceSwitcher switcher={switcher} />
          ) : (
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={props.headerLabel}
                  render={<a href={props.headerHref} />}
                >
                  <Glyph name="workspaces" />
                  <span className="font-medium">{props.headerLabel}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          )}
        </SidebarHeader>

        <SidebarContent>
          {sections.map((section) => (
            <NavGroup key={section.label} section={section} />
          ))}
        </SidebarContent>

        {identity && (
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  tooltip={identity.email}
                  render={<a href="/account/profile" />}
                >
                  <Glyph name="account" />
                  <span className="grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
                    <span className="truncate text-sm">{identity.name || identity.email}</span>
                    <span className="truncate text-xs text-muted-foreground">{identity.email}</span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        )}
      </Sidebar>
    </SidebarProvider>
  );
}

/**
 * Composes the error boundary internally so the SSR tree and the hydrated tree
 * are identical — the layout mounts this component directly.
 */
export function ShellSidebar(props: ShellSidebarIslandProps): ReactNode {
  return (
    <IslandErrorBoundary>
      <ShellSidebarBody {...props} />
    </IslandErrorBoundary>
  );
}
