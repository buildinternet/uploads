import { Surface, Brand } from "@uploads/ui";

/** The default header lockup — chevron mark + Geist Pixel wordmark. */
export function Default() {
  return (
    <Surface style={{ padding: 28 }}>
      <Brand href={null} />
    </Surface>
  );
}

/** The larger homepage-hero treatment. */
export function Large() {
  return (
    <Surface style={{ padding: 28 }}>
      <Brand href={null} size="lg" />
    </Surface>
  );
}
