import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runComment, syncAttachmentsComment, type CliContext } from "../src/commands.js";
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
    // The bot path always declines in these tests, so every existing test
    // (written for the gh path) keeps exercising the gh fallback.
    upsertGithubComment: async () => ({ posted: false, reason: "not_installed" }),
  } as unknown as UploadsClient;
}

/** Minimal client stub for syncAttachmentsComment's bot/gh branch tests. */
function fakeClient(overrides: Partial<UploadsClient> = {}): UploadsClient {
  return {
    listAll: async () => [],
    findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
    getGallery: async (id: string) => ({ id, items: [] }),
    upsertGithubComment: async () => ({ posted: false, reason: "not_installed" }),
    ...overrides,
  } as unknown as UploadsClient;
}

/** gh runner that reports no existing comments and creates a new one. */
function ghRunnerThatFindsNoMarkerThenCreates(): CommandRunner {
  return (cmd, args) => {
    if (cmd !== "gh") throw new Error(`unexpected command: ${cmd}`);
    if (args[1]?.includes("per_page=100")) return "[]";
    return JSON.stringify({ id: 9 });
  };
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

describe("syncAttachmentsComment", () => {
  it("short-circuits to the bot path on posted:true (no gh calls)", async () => {
    const client = fakeClient({
      upsertGithubComment: async () => ({
        posted: true,
        action: "created",
        count: 3,
        commentUrl: "u",
      }),
    });
    const run = vi.fn(); // gh runner must NOT be called
    const res = await syncAttachmentsComment(
      client,
      { repo: "acme/web", num: 12, kind: "pull" },
      run,
    );
    expect(res).toEqual({ action: "created", count: 3, via: "bot" });
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to the gh path on posted:false", async () => {
    const client = fakeClient({
      upsertGithubComment: async () => ({ posted: false, reason: "not_installed" }),
      listAll: async () => [{ key: "gh/acme/web/pull/12/a.png", url: "u", embedUrl: null }],
      findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
    });
    const run = ghRunnerThatFindsNoMarkerThenCreates();
    const res = await syncAttachmentsComment(
      client,
      { repo: "acme/web", num: 12, kind: "pull" },
      run,
    );
    expect(res.via).toBe("gh");
    expect(res.action).toBe("created");
  });

  it("warns with the fix message on forbidden, then falls back to gh", async () => {
    const client = fakeClient({
      upsertGithubComment: async () => ({
        posted: false,
        reason: "forbidden",
        message: "The uploads.sh GitHub App is installed on acme/web but needs write approved.",
        fixUrl: "https://github.com/organizations/acme/settings/installations/1/permissions/update",
        required: ["issues:write", "pull_requests:write"],
      }),
      listAll: async () => [{ key: "gh/acme/web/pull/12/a.png", url: "u", embedUrl: null }],
      findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const res = await syncAttachmentsComment(
        client,
        { repo: "acme/web", num: 12, kind: "pull" },
        ghRunnerThatFindsNoMarkerThenCreates(),
      );
      expect(res.via).toBe("gh");
      const printed = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("needs write approved");
      expect(printed).toContain("/permissions/update");
    } finally {
      stderr.mockRestore();
    }
  });

  it("falls back to the gh path when the endpoint throws (self-hosted 404)", async () => {
    const client = fakeClient({
      upsertGithubComment: async () => {
        throw new Error("404");
      },
      listAll: async () => [{ key: "gh/acme/web/pull/12/a.png", url: "u", embedUrl: null }],
      findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
    });
    const run = ghRunnerThatFindsNoMarkerThenCreates();
    const res = await syncAttachmentsComment(
      client,
      { repo: "acme/web", num: 12, kind: "pull" },
      run,
    );
    expect(res.via).toBe("gh");
  });
});
