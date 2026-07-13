import { Surface, Divider } from "@uploads/ui";

/** The centered uppercase labelled divider used between form sections. */
export function Labelled() {
  return (
    <Surface style={{ padding: 28, width: 320 }}>
      <Divider label="or" />
    </Surface>
  );
}

/** A plain hairline rule. */
export function Plain() {
  return (
    <Surface style={{ padding: 28, width: 320 }}>
      <Divider />
    </Surface>
  );
}
