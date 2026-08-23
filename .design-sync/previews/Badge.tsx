import "./canvas.module.css";
import { Badge } from "@uploads/ui";

export function Variants() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <Badge>Pro</Badge>
      <Badge variant="secondary">Free</Badge>
      <Badge variant="destructive">Expired</Badge>
      <Badge variant="outline">Draft</Badge>
      <Badge variant="ghost">Archived</Badge>
      <Badge variant="link">View details</Badge>
    </div>
  );
}

export function StatusTags() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <Badge variant="secondary">gh.pr 778</Badge>
      <Badge variant="outline">public</Badge>
      <Badge variant="destructive">soft-deleted</Badge>
      <Badge>synced</Badge>
    </div>
  );
}
