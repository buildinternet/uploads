import "./canvas.module.css";
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
  SidebarProvider,
  SidebarTrigger,
} from "@uploads/ui";

export function WorkspaceNav() {
  return (
    <div
      className="sb-story relative overflow-hidden rounded-lg border"
      style={{ height: 420, width: 640 }}
    >
      {/* The compiled stylesheet only carries utilities the product uses, so
          the containment overrides ship as a scoped style tag instead of
          arbitrary variants (which would silently no-op here). */}
      <style>{`
        .sb-story [data-slot="sidebar-container"] { position: absolute; inset: 0 auto 0 0; height: 100%; }
        .sb-story [data-slot="sidebar-wrapper"] { min-height: 0; height: 100%; }
      `}</style>
      <SidebarProvider style={{ height: "100%", minHeight: 0 }}>
        <Sidebar collapsible="icon" className="h-full">
          <SidebarHeader>
            <span className="px-2 font-mono text-[13px] tracking-[0.08em] text-accent uppercase">
              uploads.sh
            </span>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive>Files</SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Screenshots</SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Galleries</SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Settings</SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>Ada Lovelace</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 8, padding: 16 }}>
          <SidebarTrigger />
          <p className="text-sm text-muted-foreground">
            Sidebar content area — collapse via the trigger above.
          </p>
        </div>
      </SidebarProvider>
    </div>
  );
}
