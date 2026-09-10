import { describe, expect, it } from "vitest";
import type { ChangelogEntry } from "./changelog";
import { renderChangelogJson } from "./changelog-json";

const entries: ChangelogEntry[] = [
  {
    kind: "platform",
    id: "screenshots-page",
    title: "A home for your screenshots",
    date: "2026-08-11T00:00:00.000Z",
    html: "<p>Every screenshot the CLI captures now has a page of its own.</p>",
    markdown: "Every screenshot the CLI captures now has a page of its own.",
    tags: ["platform", "web"],
  },
  {
    kind: "cli",
    id: "cli-0-41-1",
    title: "CLI 0.41.1",
    date: "2026-08-09T18:00:00.000Z",
    html: "<p>Fixes</p>",
    markdown: "### Patch Changes\n\n- 2697e69: Fix `uploads completion zsh`.",
    tags: ["cli"],
  },
];

describe("renderChangelogJson", () => {
  const json = renderChangelogJson(entries);

  it("points at the public changelog and Atom feed", () => {
    expect(json.url).toBe("https://uploads.sh/changelog");
    expect(json.feed).toBe("https://uploads.sh/changelog.xml");
    expect(json.entries).toHaveLength(2);
  });

  it("anchors each entry and carries markdown plus a summary", () => {
    expect(json.entries[0]).toMatchObject({
      id: "screenshots-page",
      kind: "platform",
      title: "A home for your screenshots",
      url: "https://uploads.sh/changelog#screenshots-page",
      tags: ["platform", "web"],
      body: "Every screenshot the CLI captures now has a page of its own.",
      summary: "Every screenshot the CLI captures now has a page of its own.",
    });
    expect(json.entries[1].summary).toBe("Fix uploads completion zsh.");
    expect(json.entries[1].body).toContain("2697e69");
  });

  it("throws on an empty entry list rather than publishing an empty feed", () => {
    expect(() => renderChangelogJson([])).toThrow(/empty/i);
  });
});
