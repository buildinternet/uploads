import "./canvas.module.css";
import { Checkbox, Label } from "@uploads/ui";

export function Unchecked() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Checkbox id="unchecked" />
      <Label htmlFor="unchecked">Notify me on comment replies</Label>
    </div>
  );
}

export function Checked() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Checkbox id="checked" defaultChecked />
      <Label htmlFor="checked">Ingest bot attachments</Label>
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Checkbox id="disabled-unchecked" disabled />
        <Label htmlFor="disabled-unchecked">Enable BYO bucket</Label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Checkbox id="disabled-checked" disabled defaultChecked />
        <Label htmlFor="disabled-checked">Auto-sync managed comment</Label>
      </div>
    </div>
  );
}

export function InvalidState() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Checkbox id="invalid" aria-invalid="true" />
      <Label htmlFor="invalid">Accept workspace terms</Label>
    </div>
  );
}

export function FileSelectionList() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 260 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Checkbox id="f1" defaultChecked />
        <Label htmlFor="f1">console-after.png</Label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Checkbox id="f2" defaultChecked />
        <Label htmlFor="f2">dashboard-before.png</Label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Checkbox id="f3" />
        <Label htmlFor="f3">changelog.mp4</Label>
      </div>
    </div>
  );
}
