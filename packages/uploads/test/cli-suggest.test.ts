import { describe, expect, it } from "vitest";
import { commandSummary, suggestCommand } from "../src/cli-suggest.js";
import { formatUnknownCommand } from "../src/cli-help.js";

describe("suggestCommand", () => {
  it("maps the metadata spellings agents reach for to `meta set`", () => {
    expect(suggestCommand("set-metadata")).toBe("meta set");
    expect(suggestCommand("set-meta")).toBe("meta set");
    expect(suggestCommand("metadata")).toBe("meta set");
    expect(suggestCommand("tag")).toBe("meta set");
  });

  it("maps read-side metadata spellings to `meta get`", () => {
    expect(suggestCommand("get-metadata")).toBe("meta get");
    expect(suggestCommand("show-metadata")).toBe("meta get");
  });

  it("maps common synonyms to real commands", () => {
    expect(suggestCommand("upload")).toBe("put");
    expect(suggestCommand("ls")).toBe("list");
    expect(suggestCommand("rm")).toBe("delete");
    expect(suggestCommand("search")).toBe("find");
    expect(suggestCommand("capture")).toBe("screenshot");
  });

  it("catches typos by edit distance", () => {
    expect(suggestCommand("puut")).toBe("put");
    expect(suggestCommand("scrnshot")).toBe("screenshot");
    expect(suggestCommand("galery")).toBe("gallery");
    expect(suggestCommand("atach")).toBe("attach");
  });

  it("catches typos of a synonym, not just of a real command", () => {
    expect(suggestCommand("uplaod")).toBe("put");
    expect(suggestCommand("setmetadta")).toBe("meta set");
  });

  it("treats plurals and trailing qualifiers as the same intent", () => {
    expect(suggestCommand("screenshots")).toBe("screenshot");
    expect(suggestCommand("galleries")).toBe("gallery");
  });

  it("returns nothing when nothing is close", () => {
    expect(suggestCommand("xyzzy")).toBeUndefined();
    expect(suggestCommand("")).toBeUndefined();
  });

  it("resolves catalog summaries for phrases and root names", () => {
    expect(commandSummary("meta set")).toMatch(/Merge-set/);
    expect(commandSummary("put")).toMatch(/Upload/);
    expect(commandSummary("nope")).toBeUndefined();
  });
});

describe("formatUnknownCommand", () => {
  it("stays short enough to survive `| tail -20`", () => {
    const out = formatUnknownCommand({
      command: "set-metadata",
      suggestion: "meta set",
      summary: commandSummary("meta set"),
      color: false,
    });
    expect(out.trimEnd().split("\n").length).toBeLessThanOrEqual(8);
    expect(out).toMatch(/unknown command: set-metadata/);
    expect(out).toMatch(/did you mean: uploads meta set/);
    expect(out).toMatch(/uploads help --all/);
    // No banner, no full catalog dump.
    expect(out).not.toMatch(/Essentials:/);
    expect(out).not.toMatch(/purge-expired/);
  });

  it("omits the suggestion line when there is no near match", () => {
    const out = formatUnknownCommand({ command: "xyzzy", color: false });
    expect(out).toMatch(/unknown command: xyzzy/);
    expect(out).not.toMatch(/did you mean/);
    expect(out).toMatch(/uploads help --all/);
  });
});
