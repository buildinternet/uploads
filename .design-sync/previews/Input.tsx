import "./canvas.module.css";
import { Input, Label } from "@uploads/ui";

export function Default() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 280 }}>
      <Label htmlFor="workspace-name">Workspace name</Label>
      <Input id="workspace-name" placeholder="Dev demo workspace" />
    </div>
  );
}

export function WithValue() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 280 }}>
      <Label htmlFor="filename">File name</Label>
      <Input id="filename" defaultValue="console-after.png" />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 280 }}>
      <Label htmlFor="slug">Permanent slug</Label>
      <Input id="slug" defaultValue="uploads-sh/screenshots/778" disabled />
    </div>
  );
}

export function Invalid() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 280 }}>
      <Label htmlFor="invite-email">Invite email</Label>
      <Input id="invite-email" defaultValue="not-an-email" aria-invalid="true" />
    </div>
  );
}
