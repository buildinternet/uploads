import { Surface, Field, Select } from "@uploads/ui";

/** The canonical composition — a `Select` inside a labelled `Field`. */
export function InField() {
  return (
    <Surface style={{ padding: 28, width: 320 }}>
      <Field label="Role" hint="Controls what this member can change.">
        <Select defaultValue="member">
          <option value="member">member</option>
          <option value="admin">admin</option>
          <option value="owner">owner</option>
        </Select>
      </Field>
    </Surface>
  );
}

/** Standalone — the same box as `Input`, with a drawn caret. */
export function Standalone() {
  return (
    <Surface style={{ padding: 28, width: 300 }}>
      <Select defaultValue="private">
        <option value="private">private</option>
        <option value="unlisted">unlisted</option>
        <option value="public">public</option>
      </Select>
    </Surface>
  );
}

/** The compact `ul-select--sm` variant used in dense rows and tables. */
export function Compact() {
  return (
    <Surface style={{ padding: 28, width: 220 }}>
      <Select className="ul-select--sm" defaultValue="30d">
        <option value="7d">7 days</option>
        <option value="30d">30 days</option>
        <option value="90d">90 days</option>
      </Select>
    </Surface>
  );
}
