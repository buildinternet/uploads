import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANGELOG_JSON_URL,
  CHANGELOG_PAGE_URL,
  CHANGELOG_XML_URL,
  fetchChangelog,
  formatChangelogHuman,
  parseChangelogAtom,
  parseChangelogJson,
  selectChangelogEntries,
} from "../src/changelog.js";
import { UploadsError } from "../src/errors.js";

const SAMPLE = {
  url: CHANGELOG_PAGE_URL,
  feed: "https://uploads.sh/changelog.xml",
  entries: [
    {
      id: "cli-changelog",
      kind: "cli" as const,
      title: "Read the changelog from the CLI",
      date: "2026-09-10T00:00:00.000Z",
      url: `${CHANGELOG_PAGE_URL}#cli-changelog`,
      tags: ["cli"],
      summary: "uploads changelog prints the latest product updates in your terminal.",
      body: "`uploads changelog` prints the latest product updates.",
    },
    {
      id: "byo-bucket",
      kind: "platform" as const,
      title: "Bring your own bucket",
      date: "2026-08-24T00:00:00.000Z",
      url: `${CHANGELOG_PAGE_URL}#byo-bucket`,
      tags: ["platform"],
      summary: "Point any workspace at your own storage bucket.",
      body: "You can now point any workspace at your own storage bucket.",
    },
    {
      id: "older",
      kind: "platform" as const,
      title: "Older",
      date: "2026-08-01T00:00:00.000Z",
      url: `${CHANGELOG_PAGE_URL}#older`,
      tags: ["platform"],
      summary: "An older update.",
      body: "An older update.",
    },
  ],
};

describe("parseChangelogJson", () => {
  it("accepts a well-formed document", () => {
    const doc = parseChangelogJson(SAMPLE);
    expect(doc.url).toBe(CHANGELOG_PAGE_URL);
    expect(doc.feed).toBe("https://uploads.sh/changelog.xml");
    expect(doc.entries).toHaveLength(3);
    expect(doc.entries[0].title).toBe("Read the changelog from the CLI");
  });

  it("skips malformed entries and keeps usable ones", () => {
    const doc = parseChangelogJson({
      url: CHANGELOG_PAGE_URL,
      entries: [SAMPLE.entries[0], { title: "nope" }, SAMPLE.entries[1]],
    });
    expect(doc.entries.map((e) => e.id)).toEqual(["cli-changelog", "byo-bucket"]);
  });

  it("throws when every entry is unusable", () => {
    expect(() => parseChangelogJson({ entries: [{ title: "nope" }] })).toThrow(UploadsError);
  });
});

describe("selectChangelogEntries", () => {
  it("clamps to the requested limit", () => {
    const doc = selectChangelogEntries(parseChangelogJson(SAMPLE), 2);
    expect(doc.entries.map((e) => e.id)).toEqual(["cli-changelog", "byo-bucket"]);
  });
});

describe("formatChangelogHuman", () => {
  it("prints titles, dates, summaries, and a link to the full page", () => {
    const text = formatChangelogHuman(selectChangelogEntries(parseChangelogJson(SAMPLE), 2));
    expect(text).toContain("What's new");
    expect(text).toContain("Read the changelog from the CLI");
    expect(text).toContain("Sep 10, 2026");
    expect(text).toContain(`${CHANGELOG_PAGE_URL}#cli-changelog`);
    expect(text).toContain("uploads changelog prints the latest product updates in your terminal.");
    expect(text).toContain("Bring your own bucket");
    expect(text).not.toContain("Older");
    expect(text).toMatch(/See all updates: https:\/\/uploads\.sh\/changelog\n$/);
  });

  it("still links to the page when there are no entries", () => {
    const text = formatChangelogHuman({ url: CHANGELOG_PAGE_URL, entries: [] });
    expect(text).toContain("No changelog entries.");
    expect(text).toContain(`See all updates: ${CHANGELOG_PAGE_URL}`);
  });
});

describe("parseChangelogAtom", () => {
  it("reads titles, dates, tags, and HTML content from the Atom twin", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://uploads.sh/changelog#screenshots-page</id>
    <title>A home for &lt;your&gt; screenshots</title>
    <link href="https://uploads.sh/changelog#screenshots-page"/>
    <updated>2026-08-11T00:00:00.000Z</updated>
    <category term="platform"/>
    <content type="html">&lt;p&gt;Every screenshot the CLI captures now has a page of its own.&lt;/p&gt;</content>
  </entry>
</feed>`;
    const doc = parseChangelogAtom(xml);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]).toMatchObject({
      id: "screenshots-page",
      kind: "platform",
      title: "A home for <your> screenshots",
      url: "https://uploads.sh/changelog#screenshots-page",
      summary: "Every screenshot the CLI captures now has a page of its own.",
    });
  });
});

describe("fetchChangelog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the JSON twin and applies the limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const doc = await fetchChangelog({ limit: 1, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith(
      CHANGELOG_JSON_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "application/json" }),
      }),
    );
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].id).toBe("cli-changelog");
  });

  it("maps a non-OK JSON response to API_ERROR when a URL is forced", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(
      fetchChangelog({
        url: CHANGELOG_JSON_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "API_ERROR", status: 503 });
  });

  it("falls back to the Atom feed when JSON is missing", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://uploads.sh/changelog#byo-bucket</id>
    <title>Bring your own bucket</title>
    <link href="https://uploads.sh/changelog#byo-bucket"/>
    <updated>2026-08-24T00:00:00.000Z</updated>
    <category term="platform"/>
    <content type="html">&lt;p&gt;Point any workspace at your own storage bucket.&lt;/p&gt;</content>
  </entry>
</feed>`;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (String(url) === CHANGELOG_JSON_URL) return new Response("not found", { status: 404 });
      if (String(url) === CHANGELOG_XML_URL) {
        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/atom+xml" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const doc = await fetchChangelog({ fetchImpl: fetchImpl as unknown as typeof fetch, limit: 1 });
    expect(doc.entries[0].id).toBe("byo-bucket");
    expect(doc.entries[0].summary).toContain("own storage bucket");
  });

  it("maps a network failure to NETWORK", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      fetchChangelog({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });
});
