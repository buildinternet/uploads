import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  changelogFilterKeys,
  entryChips,
  entryMatchesFilter,
  entryTokens,
  parseChangelogFilter,
  tagLabel,
  tokensMatchFilter,
} from "./changelog-ui";

describe("tagLabel", () => {
  it("maps known kinds and tags", () => {
    expect(tagLabel("all")).toBe("All");
    expect(tagLabel("platform")).toBe("Platform");
    expect(tagLabel("cli")).toBe("CLI");
    expect(tagLabel("web")).toBe("Web");
    expect(tagLabel("mcp")).toBe("MCP");
  });

  it("title-cases unknown tags", () => {
    expect(tagLabel("docs")).toBe("Docs");
    expect(tagLabel("agent-harness")).toBe("Agent Harness");
  });
});

describe("entryTokens / entryChips", () => {
  it("unions kind with tags and drops blanks and duplicates", () => {
    expect(entryTokens({ kind: "platform", tags: ["platform", "web", ""] })).toEqual([
      "platform",
      "web",
    ]);
  });

  it("puts kind first when tags omit it", () => {
    expect(entryTokens({ kind: "platform", tags: ["cli"] })).toEqual(["platform", "cli"]);
  });

  it("orders chips platform, cli, web, mcp, then the rest", () => {
    expect(entryChips({ kind: "platform", tags: ["mcp", "web", "cli"] })).toEqual([
      "platform",
      "cli",
      "web",
      "mcp",
    ]);
  });
});

describe("entryMatchesFilter", () => {
  const platformStory = { kind: "platform" as const, tags: ["platform", "web", "cli"] };
  const platformCliTagged = { kind: "platform" as const, tags: ["cli"] };
  const cliRelease = { kind: "cli" as const, tags: ["cli"] };

  it("treats all / empty as a pass", () => {
    expect(entryMatchesFilter(cliRelease, "all")).toBe(true);
    expect(entryMatchesFilter(cliRelease, "")).toBe(true);
    expect(tokensMatchFilter(["cli"], "all")).toBe(true);
  });

  it("matches kind or tag", () => {
    expect(entryMatchesFilter(platformStory, "platform")).toBe(true);
    expect(entryMatchesFilter(platformStory, "web")).toBe(true);
    expect(entryMatchesFilter(platformStory, "cli")).toBe(true);
    expect(entryMatchesFilter(platformCliTagged, "platform")).toBe(true);
    expect(entryMatchesFilter(platformCliTagged, "cli")).toBe(true);
  });

  it("does not treat a CLI release as platform", () => {
    expect(entryMatchesFilter(cliRelease, "platform")).toBe(false);
    expect(entryMatchesFilter(cliRelease, "cli")).toBe(true);
    expect(entryMatchesFilter(cliRelease, "web")).toBe(false);
  });
});

describe("changelogFilterKeys", () => {
  it("always leads with All / Platform / CLI, then cheap extra tags", () => {
    expect(
      changelogFilterKeys([
        { kind: "platform", tags: ["platform", "web"] },
        { kind: "cli", tags: ["cli"] },
        { kind: "platform", tags: ["mcp", "docs"] },
      ]),
    ).toEqual(["all", "platform", "cli", "web", "mcp", "docs"]);
  });

  it("omits extras that do not appear", () => {
    expect(changelogFilterKeys([{ kind: "cli", tags: ["cli"] }])).toEqual([
      "all",
      "platform",
      "cli",
    ]);
  });
});

describe("parseChangelogFilter", () => {
  const allowed = ["all", "platform", "cli", "web"];

  it("accepts an allowed key", () => {
    expect(parseChangelogFilter("cli", allowed)).toBe("cli");
  });

  it("falls back to all for missing or unknown values", () => {
    expect(parseChangelogFilter(null, allowed)).toBe("all");
    expect(parseChangelogFilter(undefined, allowed)).toBe("all");
    expect(parseChangelogFilter("nope", allowed)).toBe("all");
  });
});

describe("changelog page script", () => {
  it("inlines the filter so a processed page module cannot 404", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../pages/changelog.astro"),
      "utf8",
    );
    expect(src).toContain("<script is:inline>");
    expect(src).toContain("[data-changelog]");
    expect(src).not.toMatch(/<script>\s*import\s+/);
  });
});
