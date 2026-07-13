import { Surface, Label, Input } from "@uploads/ui";

/** The uppercase micro-label above a control. */
export function Default() {
  return (
    <Surface style={{ padding: 28, width: 300, display: "grid", gap: 6 }}>
      <Label htmlFor="ws">Workspace name</Label>
      <Input id="ws" defaultValue="acme-web" />
    </Surface>
  );
}
