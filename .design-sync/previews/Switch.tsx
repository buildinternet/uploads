import "./canvas.module.css";
import { Switch, Label } from "@uploads/ui";

export function Default() {
  return <Switch defaultChecked />;
}

export function Unchecked() {
  return <Switch />;
}

export function Small() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Switch size="sm" defaultChecked />
      <Switch size="sm" />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <Switch disabled />
      <Switch disabled defaultChecked />
    </div>
  );
}

export function SettingsRow() {
  return (
    <Label htmlFor="public-workspace" style={{ width: 280, justifyContent: "space-between" }}>
      Make workspace discoverable
      <Switch id="public-workspace" defaultChecked />
    </Label>
  );
}
