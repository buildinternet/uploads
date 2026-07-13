import { Surface, Panel, Button, Field, Input, Divider } from "@uploads/ui";

/** The standard panel with a title + description header. */
export function WithHeader() {
  return (
    <Surface style={{ padding: 28, width: 400 }}>
      <Panel
        title="Workspace files"
        description="Everything uploaded here is visible to your team and embeddable in pull requests."
      >
        <Button variant="ghost" size="sm">
          Manage access
        </Button>
      </Panel>
    </Surface>
  );
}

/** The roomy, centered auth-card treatment. */
export function AuthCard() {
  return (
    <Surface style={{ padding: 28, width: 380 }}>
      <Panel roomy title="Sign in" description="Continue with GitHub or a workspace token.">
        <div style={{ display: "grid", gap: 12 }}>
          <Button variant="primary" block>
            Continue with GitHub
          </Button>
          <Divider label="or" />
          <Field label="Workspace token">
            <Input placeholder="upl_…" />
          </Field>
        </div>
      </Panel>
    </Surface>
  );
}
