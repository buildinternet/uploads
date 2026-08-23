import "./canvas.module.css";
import { Label, Input, Switch, Textarea } from "@uploads/ui";

export function WorkspaceNameField() {
  return (
    <div style={{ display: "grid", gap: 6, width: 260 }}>
      <Label htmlFor="workspace-name">Workspace name</Label>
      <Input id="workspace-name" defaultValue="Dev demo" />
    </div>
  );
}

export function DisabledField() {
  return (
    <div className="group" data-disabled="true" style={{ display: "grid", gap: 6, width: 260 }}>
      <Label htmlFor="bucket-region">Bucket region</Label>
      <Input id="bucket-region" defaultValue="auto (R2)" disabled />
    </div>
  );
}

export function InlineSwitchLabel() {
  return (
    <Label htmlFor="ingest-toggle" style={{ width: 260, justifyContent: "space-between" }}>
      Auto-ingest PR screenshots
      <Switch id="ingest-toggle" defaultChecked />
    </Label>
  );
}

export function CommentField() {
  return (
    <div style={{ display: "grid", gap: 6, width: 320 }}>
      <Label htmlFor="pr-comment">Comment for PR #778</Label>
      <Textarea id="pr-comment" defaultValue="Two-lane storage lands read-fallback without migration." />
    </div>
  );
}
