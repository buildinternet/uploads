import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChangelogEntry,
  cliAnchorId,
  fetchCliReleaseDates,
  mergeEntries,
  parseCliChangelog,
  renderMarkdown,
} from "./changelog";

const SAMPLE = `# @buildinternet/uploads

## 0.41.1

### Patch Changes

- 2697e69: Fix \`uploads completion zsh\` producing a script that could not complete anything.

  The generated \`_arguments\` call was missing line continuations.

## 0.41.0

### Minor Changes

- 085da59: Per-key file operations now use the canonical paths (#613).
`;

describe("parseCliChangelog", () => {
  it("splits ## <version> sections newest-first with bodies intact", () => {
    const sections = parseCliChangelog(SAMPLE);
    expect(sections.map((s) => s.version)).toEqual(["0.41.1", "0.41.0"]);
    expect(sections[0].body).toContain("### Patch Changes");
    expect(sections[0].body).toContain("line continuations");
    expect(sections[0].body).not.toContain("## 0.41.0");
  });

  it("throws when no version sections are found", () => {
    expect(() => parseCliChangelog("# nothing here")).toThrow(/no version sections/i);
  });
});

describe("cliAnchorId", () => {
  it("dasherizes the version", () => {
    expect(cliAnchorId("0.41.1")).toBe("cli-0-41-1");
  });
});

describe("fetchCliReleaseDates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the npm time map minus created/modified", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          time: {
            created: "2026-01-01T00:00:00.000Z",
            modified: "2026-08-01T00:00:00.000Z",
            "0.41.1": "2026-08-09T18:00:00.000Z",
          },
        }),
        { status: 200 },
      ),
    );
    const dates = await fetchCliReleaseDates(fetchImpl as unknown as typeof fetch);
    expect(dates).toEqual({ "0.41.1": "2026-08-09T18:00:00.000Z" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@buildinternet/uploads",
      expect.anything(),
    );
  });

  it("throws on a non-200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(fetchCliReleaseDates(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /npm registry/i,
    );
  });
});

describe("renderMarkdown", () => {
  it("renders markdown to HTML", () => {
    expect(renderMarkdown("some `code` here")).toContain("<code>code</code>");
  });
});

describe("mergeEntries", () => {
  const entry = (over: Partial<ChangelogEntry>): ChangelogEntry => ({
    kind: "platform",
    id: "x",
    title: "x",
    date: "2026-08-01T00:00:00.000Z",
    html: "",
    tags: [],
    ...over,
  });

  it("sorts newest first", () => {
    const sorted = mergeEntries([
      entry({ id: "old", date: "2026-07-01T00:00:00.000Z" }),
      entry({ id: "new", date: "2026-08-10T00:00:00.000Z" }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("puts platform entries before cli entries on the same date", () => {
    const sorted = mergeEntries([
      entry({ id: "cli", kind: "cli" }),
      entry({ id: "post", kind: "platform" }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["post", "cli"]);
  });
});
