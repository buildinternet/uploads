import { describe, expect, it } from "vitest";
import type { ChangelogEntry } from "./changelog";
import { renderAtomFeed } from "./changelog-feed";

const entries: ChangelogEntry[] = [
  {
    kind: "platform",
    id: "screenshots-page",
    title: "A home for <your> screenshots",
    date: "2026-08-11T00:00:00.000Z",
    html: '<p>Now with <img src="https://storage.uploads.sh/changelog/x.png" alt="x"></p>',
    tags: ["platform"],
    image: {
      url: "https://storage.uploads.sh/default/screenshots/changelog/lead.webp",
      alt: 'The "lead" image',
    },
  },
  {
    kind: "cli",
    id: "cli-0-41-1",
    title: "CLI 0.41.1",
    date: "2026-08-09T18:00:00.000Z",
    html: "<p>Fixes</p>",
    tags: ["cli"],
  },
];

describe("renderAtomFeed", () => {
  const xml = renderAtomFeed(entries);

  it("is an atom feed with feed-level metadata", () => {
    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<id>https://uploads.sh/changelog</id>");
    // Feed updated = newest entry date.
    expect(xml).toContain("<updated>2026-08-11T00:00:00.000Z</updated>");
    expect(xml).toContain('href="https://uploads.sh/changelog.xml" rel="self"');
  });

  it("emits one entry per item with anchored ids and escaped titles", () => {
    expect(xml).toContain("<id>https://uploads.sh/changelog#screenshots-page</id>");
    expect(xml).toContain("<id>https://uploads.sh/changelog#cli-0-41-1</id>");
    expect(xml).toContain("A home for &lt;your&gt; screenshots");
    expect(xml).not.toContain("A home for <your>");
  });

  it("carries full HTML content with absolute image URLs, escaped", () => {
    expect(xml).toContain('<content type="html">');
    expect(xml).toContain("https://storage.uploads.sh/changelog/x.png");
    expect(xml).toContain("&lt;img src=");
  });

  it("inlines the frontmatter lead image into the entry content", () => {
    // Escaped once for the HTML attribute, then again for XML.
    expect(xml).toContain("https://storage.uploads.sh/default/screenshots/changelog/lead.webp");
    expect(xml).toContain("alt=&quot;The &amp;quot;lead&amp;quot; image&quot;");
  });

  it("throws on an empty entry list rather than publishing an empty feed", () => {
    expect(() => renderAtomFeed([])).toThrow(/empty/i);
  });
});
