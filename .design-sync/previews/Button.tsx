import "./canvas.module.css";
import { Button } from "@uploads/ui";

export function Variants() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <Button>Upload file</Button>
      <Button variant="outline">Copy link</Button>
      <Button variant="secondary">View gallery</Button>
      <Button variant="ghost">Dismiss</Button>
      <Button variant="destructive">Delete file</Button>
      <Button variant="link">Read the docs</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <Button size="xs">Rename</Button>
      <Button size="sm">Attach to PR</Button>
      <Button>Upload file</Button>
      <Button size="lg">Create workspace</Button>
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <Button disabled>Uploading…</Button>
      <Button variant="outline" disabled>
        Copy link
      </Button>
      <Button variant="destructive" disabled>
        Delete file
      </Button>
    </div>
  );
}
