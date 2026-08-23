import "./canvas.module.css";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@uploads/ui";

export function WorkspaceSettings() {
  return (
    <Tabs defaultValue="general" style={{ width: 360 }}>
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="members">Members</TabsTrigger>
        <TabsTrigger value="billing">Billing</TabsTrigger>
      </TabsList>
      <TabsContent value="general" style={{ padding: "12px 2px" }}>
        Dev demo workspace &middot; created 2026-01-14 &middot; 1GB cap.
      </TabsContent>
      <TabsContent value="members" style={{ padding: "12px 2px" }}>
        3 of 3 free-plan seats used.
      </TabsContent>
      <TabsContent value="billing" style={{ padding: "12px 2px" }}>
        Upgrade to Pro for unlimited members and storage.
      </TabsContent>
    </Tabs>
  );
}

export function LineVariant() {
  return (
    <Tabs defaultValue="screenshots" style={{ width: 360 }}>
      <TabsList variant="line">
        <TabsTrigger value="screenshots">Screenshots</TabsTrigger>
        <TabsTrigger value="galleries">Galleries</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="screenshots" style={{ padding: "12px 2px" }}>
        42 screenshots grouped by PR path.
      </TabsContent>
      <TabsContent value="galleries" style={{ padding: "12px 2px" }}>
        No galleries yet for this repo.
      </TabsContent>
      <TabsContent value="activity" style={{ padding: "12px 2px" }}>
        PR #778 merged 2 hours ago.
      </TabsContent>
    </Tabs>
  );
}

export function DisabledTab() {
  return (
    <Tabs defaultValue="files" style={{ width: 320 }}>
      <TabsList>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="usage" disabled>
          Usage
        </TabsTrigger>
      </TabsList>
      <TabsContent value="files" style={{ padding: "12px 2px" }}>
        128 files in uploads-sh/api.
      </TabsContent>
    </Tabs>
  );
}
