import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runComment, type CliContext } from "../src/commands.js";
import { ATTACHMENTS_MARKER } from "../src/github.js";
import type { CommandRunner } from "../src/github-gh.js";

function listClient(
  items: { key: string; url: string | null }[],
  galleryPages: {
    galleries: { id: string; title: string; url: string }[];
    nextCursor: string | null;
  }[] = [],
) {
  let page = 0;
  return {
    list: async () => ({ items, cursor: null }),
    listAll: async () => items,
    findGalleriesByReference: async () =>
      galleryPages[page++] ?? { galleries: [], nextCursor: null },
    getGallery: async (id: string) => ({ id, items: [] }),
  } as unknown as UploadsClient;
}

function ctxWith(client: UploadsClient): CliContext {
  return {
    config: {
      apiUrl: "https://x.test",
      workspace: "test",
      token: "up_test_x",
      workspaceSource: "override",
      configPath: "/tmp/uploads-test-config",
      configExists: false,
    },
    client,
    json: false,
    quiet: true,
  };
}

/** gh runner that reports no existing comments and records the create call. */
function ghRunner() {
  const calls: { args: string[]; input?: string }[] = [];
  const run: CommandRunner = (cmd, args, input) => {
    if (cmd !== "gh") throw new Error(`unexpected command: ${cmd}`);
    calls.push({ args, input });
    if (args[1]?.includes("per_page=100")) return "[]";
    return JSON.stringify({ id: 9 });
  };
  return { run, calls };
}

describe("runComment", () => {
  it("requires --pr or --issue", async () => {
    const { run } = ghRunner();
    await expect(runComment(ctxWith(listClient([])), [], false, run)).rejects.toThrow(UsageError);
  });

  it("creates a comment listing the PR's attachments", async () => {
    const { run, calls } = ghRunner();
    const client = listClient([
      { key: "gh/o/r/pull/5/after.png", url: "https://x.test/gh/o/r/pull/5/after.png" },
    ]);
    const code = await runComment(ctxWith(client), ["--pr", "5", "--repo", "o/r"], false, run);
    expect(code).toBe(0);
    const create = calls.find((c) => c.args.includes("repos/o/r/issues/5/comments"));
    expect(create).toBeDefined();
    expect(create!.input).toContain(ATTACHMENTS_MARKER);
    expect(create!.input).toContain("after.png");
  });

  it("skips gh entirely when there are no attachments", async () => {
    const { run, calls } = ghRunner();
    const code = await runComment(
      ctxWith(listClient([])),
      ["--pr", "5", "--repo", "o/r"],
      false,
      run,
    );
    expect(code).toBe(0);
    expect(calls.length).toBe(0);
  });
  it("renders available gallery images inline and falls back for missing media", async () => {
    const { run, calls } = ghRunner();
    const client = {
      ...listClient(
        [],
        [
          {
            galleries: [
              { id: "gal_preview", title: "Preview", url: "https://uploads.test/g/gal_preview" },
            ],
            nextCursor: null,
          },
        ],
      ),
      getGallery: async () => ({
        items: [
          {
            status: "available",
            url: "https://storage.test/one.webp",
            contentType: "image/webp",
            altText: "One",
            objectKey: "one.webp",
          },
          {
            status: "missing",
            url: null,
            contentType: null,
            altText: null,
            objectKey: "gone.webp",
          },
          {
            status: "available",
            url: "https://storage.test/movie.mp4",
            contentType: "video/mp4",
            altText: null,
            objectKey: "movie.mp4",
          },
        ],
      }),
    } as unknown as UploadsClient;
    await runComment(ctxWith(client), ["--pr", "5", "--repo", "o/r"], false, run);
    const create = calls.find((call) => call.args.includes("repos/o/r/issues/5/comments"));
    expect(create?.input).toContain('src="https://storage.test/one.webp"');
    expect(create?.input).not.toContain("movie.mp4");
  });
});
