import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGELOG_PAGE_URL } from "../src/changelog.js";
import { runChangelog } from "../src/commands/changelog.js";
import { UsageError } from "../src/cli-args.js";

const SAMPLE = {
  url: CHANGELOG_PAGE_URL,
  feed: "https://uploads.sh/changelog.xml",
  entries: [
    {
      id: "cli-changelog",
      kind: "cli",
      title: "Read the changelog from the CLI",
      date: "2026-09-10T00:00:00.000Z",
      url: `${CHANGELOG_PAGE_URL}#cli-changelog`,
      tags: ["cli"],
      summary: "uploads changelog prints the latest product updates in your terminal.",
      body: "`uploads changelog` prints the latest product updates.",
    },
  ],
};

function fakeFetch(payload: unknown = SAMPLE, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function captureStreams() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uploads changelog", () => {
  it("prints recent entries and a link to the website", async () => {
    const { stdout } = captureStreams();
    const code = await runChangelog([], { fetch: fakeFetch() });
    expect(code).toBe(0);
    expect(stdout()).toContain("What's new");
    expect(stdout()).toContain("Read the changelog from the CLI");
    expect(stdout()).toContain("See all updates: https://uploads.sh/changelog");
  });

  it("emits JSON when --json is set", async () => {
    const { stdout } = captureStreams();
    const code = await runChangelog(["--json"], { fetch: fakeFetch() });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout()) as { url: string; entries: { id: string }[] };
    expect(parsed.url).toBe(CHANGELOG_PAGE_URL);
    expect(parsed.entries[0].id).toBe("cli-changelog");
  });

  it("prints help", async () => {
    const { stderr } = captureStreams();
    const code = await runChangelog([], { fetch: fakeFetch() }, true);
    expect(code).toBe(0);
    expect(stderr()).toMatch(/uploads changelog/);
    expect(stderr()).toMatch(/Examples:/);
    expect(stderr()).toMatch(/uploads changelog --json/);
  });

  it("rejects unexpected positionals", async () => {
    await expect(runChangelog(["search"], { fetch: fakeFetch() })).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it("rejects a limit above the cap", async () => {
    await expect(runChangelog(["--limit", "999"], { fetch: fakeFetch() })).rejects.toMatchObject({
      message: expect.stringMatching(/50 or less/),
    });
  });
});
