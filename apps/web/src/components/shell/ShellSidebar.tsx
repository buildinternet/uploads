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
import {
  type LucideIcon,
  ChevronsUpDown,
  CircleUser,
  CreditCard,
  Dot,
  File,
  Frame,
  Images,
  KeyRound,
  LayoutGrid,
  Mail,
  ChartColumn,
  Plus,
  Settings,
  Terminal,
  Users,
} from "lucide-react";
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
 * Nav glyphs come from lucide-react (already in the signed-in bundle via
 * @uploads/ui's shadcn primitives). The kit's own `[&_svg]:size-4` rule sizes
 * them to 16px and lucide's default 24-grid / stroke-2 gives the right optical
 * weight, so the collapsed icon rail stays consistent with the rest of the DS.
 */
const ICON_MAP: Record<ShellNavIcon | "switcher" | "plus", LucideIcon> = {
  screenshots: Frame,
  files: File,
  galleries: Images,
  people: Users,
  billing: CreditCard,
  settings: Settings,
  account: CircleUser,
  developers: Terminal,
  workspaces: LayoutGrid,
  metrics: ChartColumn,
  users: Users,
  oauth: KeyRound,
  email: Mail,
  dot: Dot,
  switcher: ChevronsUpDown,
  plus: Plus,
};

function Glyph({
  name,
  className,
}: {
  name: keyof typeof ICON_MAP;
  className?: string;
}): ReactNode {
  const Icon = ICON_MAP[name];
  return <Icon aria-hidden className={className} />;
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
                <span>New workspace</span>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem render={<a href={switcher.manageHref} />}>
                <Glyph name="workspaces" />
                <span>Manage workspaces</span>
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
