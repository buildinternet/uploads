import { Surface, Brand, Panel, Button } from "@uploads/ui";

/** The dark canvas holding a brand lockup, a panel, and an action — the base every screen sits on. */
export function Canvas() {
  return (
    <Surface style={{ padding: 28, display: "grid", gap: 18, width: 380 }}>
      <Brand />
      <Panel title="Workspace" description="Files here are visible to your team.">
        <Button variant="primary" block>
          New upload
        </Button>
      </Panel>
    </Surface>
  );
}
