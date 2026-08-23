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
      className="relative overflow-hidden rounded-lg border [&_[data-slot=sidebar-container]]:absolute! [&_[data-slot=sidebar-container]]:h-full!"
      style={{ height: 420, width: 640 }}
    >
      <SidebarProvider className="h-full min-h-0">
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
