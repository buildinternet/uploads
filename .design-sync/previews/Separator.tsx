import "./canvas.module.css";
import { Separator } from "@uploads/ui";

export function Horizontal() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 240 }}>
      <p className="text-sm text-body">Above the line</p>
      <Separator />
      <p className="text-sm text-body">Below the line</p>
    </div>
  );
}

export function Vertical() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, height: 32 }}>
      <span className="text-sm text-body">Files</span>
      <Separator orientation="vertical" />
      <span className="text-sm text-body">Galleries</span>
      <Separator orientation="vertical" />
      <span className="text-sm text-body">People</span>
    </div>
  );
}
