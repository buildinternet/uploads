import { Surface, Field, Input } from "@uploads/ui";

/** A labelled field with a helper hint. */
export function Default() {
  return (
    <Surface style={{ padding: 28, width: 320 }}>
      <Field label="Workspace name" hint="Lowercase letters and dashes only.">
        <Input defaultValue="acme-web" />
      </Field>
    </Surface>
  );
}

/** The error state — red border and hint. */
export function Invalid() {
  return (
    <Surface style={{ padding: 28, width: 320 }}>
      <Field label="Workspace token" hint="That token has expired." invalid>
        <Input defaultValue="upl_9f2c1a…" />
      </Field>
    </Surface>
  );
}

/** Several stacked fields — the shape of a settings form. */
export function Stacked() {
  return (
    <Surface style={{ padding: 28, width: 320, display: "grid", gap: 16 }}>
      <Field label="Display name">
        <Input defaultValue="Acme, Inc." />
      </Field>
      <Field label="Slug" hint="Used in every gallery URL.">
        <Input defaultValue="acme" />
      </Field>
    </Surface>
  );
}
