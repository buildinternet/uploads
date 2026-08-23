import "./canvas.module.css";
import { Skeleton } from "@uploads/ui";

export function Default() {
  return <Skeleton style={{ height: 16, width: 240 }} />;
}

export function Shapes() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Skeleton className="rounded-full" style={{ height: 32, width: 32 }} />
      <Skeleton className="rounded-md" style={{ height: 16, width: 96 }} />
      <Skeleton className="rounded-lg" style={{ height: 40, width: 64 }} />
    </div>
  );
}

export function CardPlaceholder() {
  return (
    <div
      className="rounded-lg border"
      style={{ display: "flex", flexDirection: "column", gap: 12, width: 280, padding: 16 }}
    >
      <Skeleton className="rounded-lg" style={{ height: 128, width: "100%" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Skeleton className="rounded-full" style={{ height: 32, width: 32 }} />
        <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 8 }}>
          <Skeleton style={{ height: 16, width: "66%" }} />
          <Skeleton style={{ height: 12, width: "33%" }} />
        </div>
      </div>
    </div>
  );
}
