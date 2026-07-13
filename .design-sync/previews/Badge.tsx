import { Surface, Badge } from "@uploads/ui";

/** The color tones. */
export function Tones() {
  return (
    <Surface style={{ padding: 28, display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Badge>png</Badge>
      <Badge tone="accent">acme-web</Badge>
      <Badge tone="ok">public</Badge>
      <Badge tone="danger">expired</Badge>
    </Surface>
  );
}

/** With a leading status dot. */
export function WithDot() {
  return (
    <Surface style={{ padding: 28, display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Badge tone="ok" dot>
        public
      </Badge>
      <Badge tone="accent" dot>
        team only
      </Badge>
      <Badge tone="danger" dot>
        private
      </Badge>
    </Surface>
  );
}
