/**
 * Tool handler failure that still carries structuredContent (e.g. multi-file
 * total failure with a `failures` array). The MCP server maps this to
 * isError: true while preserving structuredContent for agents.
 */
export class ToolBatchError extends Error {
  readonly structuredContent: unknown;

  constructor(message: string, structuredContent: unknown) {
    super(message);
    this.name = "ToolBatchError";
    this.structuredContent = structuredContent;
  }
}

/** One-line summary of a multi-file failure list. */
export function batchFailureMessage(
  failures: readonly { file: string; error: { message: string } }[],
): string {
  if (failures.length === 0) return "upload failed";
  if (failures.length === 1) {
    const f = failures[0]!;
    return `${f.file}: ${f.error.message}`;
  }
  const lines = failures.map((f) => `  ${f.file}: ${f.error.message}`);
  return `${failures.length} uploads failed:\n${lines.join("\n")}`;
}
