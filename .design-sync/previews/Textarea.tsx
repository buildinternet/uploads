import "./canvas.module.css";
import { Textarea, Label } from "@uploads/ui";

export function Default() {
  return <Textarea placeholder="Add a comment for PR #778..." style={{ width: 320 }} />;
}

export function WithLabel() {
  return (
    <div style={{ display: "grid", gap: 6, width: 320 }}>
      <Label htmlFor="release-notes">Release notes</Label>
      <Textarea
        id="release-notes"
        defaultValue={"Two-lane workspace storage: save, switch, and fall back without migration."}
      />
    </div>
  );
}

export function Disabled() {
  return (
    <Textarea
      disabled
      defaultValue="Workspace archived — comments are read-only."
      style={{ width: 320 }}
    />
  );
}

export function Invalid() {
  return (
    <div style={{ display: "grid", gap: 6, width: 320 }}>
      <Label htmlFor="issue-desc">Issue description</Label>
      <Textarea id="issue-desc" aria-invalid defaultValue="" placeholder="Required field" />
    </div>
  );
}
