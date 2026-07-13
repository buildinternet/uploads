import { Surface, Callout } from "@uploads/ui";

/** The four status tones. */
export function Tones() {
  return (
    <Surface style={{ padding: 28, width: 380, display: "grid", gap: 12 }}>
      <Callout tone="info">A new version of the CLI is available.</Callout>
      <Callout tone="ready" title="Uploaded">
        https://uploads.sh/g/acme/dashboard.png
      </Callout>
      <Callout tone="error">That workspace token is invalid.</Callout>
      <Callout tone="muted">No files uploaded yet.</Callout>
    </Surface>
  );
}
