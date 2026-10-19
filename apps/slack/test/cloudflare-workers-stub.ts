/**
 * Vitest stand-in for `cloudflare:workers` (plain Node can't resolve it).
 * `tracing.enterSpan` records each span's name and attributes in `spans`,
 * so tests can check what the mention agent traces.
 */
export interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean | undefined>;
}

export const spans: RecordedSpan[] = [];

export const tracing = {
  enterSpan<T>(
    name: string,
    callback: (span: { setAttributes(a: RecordedSpan["attributes"]): unknown }) => T,
  ): T {
    const recorded: RecordedSpan = { name, attributes: {} };
    spans.push(recorded);
    return callback({
      setAttributes(a) {
        Object.assign(recorded.attributes, a);
        return this;
      },
    });
  },
  getActiveSpan(): undefined {
    return undefined;
  },
};
