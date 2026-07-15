import { describe, expect, it } from "vitest";
import { createStyle, formatCommandHelp } from "../src/cli-style.js";

const SAMPLE = `uploads attach <file...> [options]

Upload one or more stable PR/issue attachments.

Options:
  --pr <num>            Attach to this pull request
  --issue <num>         Attach to this issue
  --workspace, -w <name>  Override workspace

Examples:
  uploads attach ./before.png ./after.png
  uploads attach ./shot.png --meta app=myapp --meta page=settings
`;

describe("formatCommandHelp", () => {
  it("is a no-op for structure when color is off", () => {
    const text = formatCommandHelp(SAMPLE, createStyle(false));
    expect(text).toContain("Options:");
    expect(text).toContain("--pr <num>");
    expect(text).not.toContain("\u001b[");
  });

  it("colors synopsis, sections, flags, and examples when enabled", () => {
    const text = formatCommandHelp(SAMPLE, createStyle(true));
    // Accent headings
    expect(text).toContain("\u001b[38;2;194;126;255m");
    // Green commands/flags
    expect(text).toContain("\u001b[38;2;143;174;98m");
    expect(text).toMatch(/Options:/);
    expect(text).toMatch(/--pr <num>/);
    expect(text).toMatch(/uploads attach/);
  });
});
