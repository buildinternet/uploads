import { Surface, Input } from "@uploads/ui";

/** The bare input in its resting, placeholder, and disabled states. */
export function States() {
  return (
    <Surface style={{ padding: 28, width: 300, display: "grid", gap: 12 }}>
      <Input defaultValue="acme-web" />
      <Input placeholder="my-workspace" />
      <Input defaultValue="locked" disabled />
    </Surface>
  );
}
