import "./canvas.module.css";
import { Kbd, KbdGroup } from "@uploads/ui";

export function Default() {
  return (
    <KbdGroup>
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
  );
}

export function SingleKey() {
  return <Kbd>/</Kbd>;
}

export function InlineHint() {
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      className="text-sm text-muted-foreground"
    >
      Filter path
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>
    </span>
  );
}
