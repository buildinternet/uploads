import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import {
  GithubCommentAuthorizationError,
  runComment,
  syncAttachmentsComment,
  type CliContext,
} from "../src/commands.js";
import { ATTACHMENTS_MARKER, attachmentsMarker, GH_FALLBACK_AUTHOR_NOTE } from "../src/github.js";
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
    // No active private prefix by default — plain-only listing (issue #631).
    resolveGhPrefix: async () => ({ mode: "plain" }),
  } as unknown as UploadsClient;
}

/** Minimal client stub for syncAttachmentsComment's bot/gh branch tests. */
function fakeClient(overrides: Partial<UploadsClient> = {}): UploadsClient {
  return {
    listAll: async () => [],
    findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
    getGallery: async (id: string) => ({ id, items: [] }),
    upsertGithubComment: async () => ({ posted: false, reason: "not_installed" }),
    resolveGhPrefix: async () => ({ mode: "plain" }),
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
  return ghRunnerWithExisting(null);
}

/**
 * gh runner for the empty-state path: reports either an existing managed
 * comment (`existingCommentId`) or none (`null`) on the marker hunt, and
 * records every call so a test can assert whether PATCH/create ever fired.
 */
function ghRunnerWithExisting(existingCommentId: number | null) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: CommandRunner = (cmd, args, input) => {
    if (cmd !== "gh") throw new Error(`unexpected command: ${cmd}`);
    calls.push({ args, input });
    if (args[1]?.includes("per_page=100")) {
      return existingCommentId === null
        ? "[]"
        : JSON.stringify([{ id: existingCommentId, body: `${ATTACHMENTS_MARKER}\nold` }]);
    }
    return JSON.stringify({ id: existingCommentId ?? 9 });
  };
  return { run, calls };
}

/** Run `fn` with process.stderr.write captured, returning the concatenated output. */
async function captureStderr(fn: () => Promise<unknown>): Promise<string> {
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await fn();
    return writeSpy.mock.calls.map((c) => String(c[0])).join("");
  } finally {
    writeSpy.mockRestore();
  }
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
    // ctxWith's workspace ("test") is a valid slug, so the gh-fallback path
    // uses the namespaced marker (phase 4b).
    expect(create!.input).toContain(attachmentsMarker("test"));
    expect(create!.input).toContain("after.png");
    // Gh-fallback only: explain why the comment is under a human account.
    expect(create!.input).toContain(GH_FALLBACK_AUTHOR_NOTE);
  });

  it("does not append the gh-author note when the bot posts successfully", async () => {
    const { run, calls } = ghRunner();
    const client = fakeClient({
      upsertGithubComment: async () => ({
        posted: true,
        action: "created",
        count: 1,
      }),
    });
    await runComment(ctxWith(client), ["--pr", "5", "--repo", "o/r"], false, run);
    // Bot path never touches local gh, so no create/patch body is recorded.
    expect(calls.some((c) => c.args.includes("repos/o/r/issues/5/comments"))).toBe(false);
    expect(calls.some((c) => c.args.includes("PATCH"))).toBe(false);
  });

  it("no-ops (no create) via gh when there are no attachments and no comment exists", async () => {
    // Patch-only-when-empty still hunts for an existing marker comment (one
    // gh call), it just never creates one — this is the "never create just
    // to say empty" safety property, not a full skip of gh.
    const { run, calls } = ghRunner();
    const code = await runComment(
      ctxWith(listClient([])),
      ["--pr", "5", "--repo", "o/r"],
      false,
      run,
    );
    expect(code).toBe(0);
    expect(calls.some((c) => c.args.includes("PATCH"))).toBe(false);
    expect(calls.some((c) => c.args.includes("repos/o/r/issues/5/comments"))).toBe(false);
  });

  it("prints a cleared message when the comment is emptied", async () => {
    const { run } = ghRunnerWithExisting(7);
    const err = await captureStderr(() =>
      runComment(
        { ...ctxWith(listClient([])), quiet: false },
        ["--pr", "12", "--repo", "o/r"],
        false,
        run,
      ),
    );
    expect(err).toContain("cleared attachments comment");
    expect(err).not.toContain("(0 files)");
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

  it("gh fallback also lists active private-prefix objects (issue #631)", async () => {
    const listAll = vi.fn(async (opts: { prefix?: string }) => {
      if (opts.prefix === "gh/acme/web/pull/12/") {
        return [{ key: "gh/acme/web/pull/12/a.png", url: "u", embedUrl: null }];
      }
      if (opts.prefix === "gh/private/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pull/12/") {
        return [
          {
            key: "gh/private/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pull/12/b.png",
            url: "u2",
            embedUrl: null,
          },
        ];
      }
      throw new Error(`unexpected prefix: ${opts.prefix}`);
    });
    const client = fakeClient({
      upsertGithubComment: async () => ({ posted: false, reason: "not_installed" }),
      listAll,
      findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
      resolveGhPrefix: async () => ({
        mode: "private",
        prefixId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        activePrefixIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      }),
    });
    const run = ghRunnerThatFindsNoMarkerThenCreates();
    const res = await syncAttachmentsComment(
      client,
      { repo: "acme/web", num: 12, kind: "pull" },
      run,
    );
    expect(res.via).toBe("gh");
    expect(res.count).toBe(2);
    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("gh fallback lists plain-only when the resolve endpoint 404s (older server)", async () => {
    const listAll = vi.fn(async (opts: { prefix?: string }) => {
      expect(opts.prefix).toBe("gh/acme/web/pull/12/");
      return [{ key: "gh/acme/web/pull/12/a.png", url: "u", embedUrl: null }];
    });
    const client = fakeClient({
      upsertGithubComment: async () => ({ posted: false, reason: "not_installed" }),
      listAll,
      findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
      // Fail-open per resolveGhPrefix's own contract — a 404/network error
      // there already resolves to `{ mode: "plain" }`, so the stub mirrors
      // that resolved shape rather than throwing.
      resolveGhPrefix: async () => ({ mode: "plain" }),
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const run = ghRunnerThatFindsNoMarkerThenCreates();
      const res = await syncAttachmentsComment(
        client,
        { repo: "acme/web", num: 12, kind: "pull" },
        run,
      );
      expect(res.via).toBe("gh");
      expect(res.count).toBe(1);
      expect(listAll).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls.length).toBe(0); // no error noise on fail-open.
    } finally {
      stderr.mockRestore();
    }
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

  it("does not fall back to gh on not_authorized (issue #297) — throws with a hint instead", async () => {
    const client = fakeClient({
      upsertGithubComment: async () => ({
        posted: false,
        reason: "not_authorized",
        message: 'acme/web is bound to a different workspace ("other-ws").',
      }),
    });
    const run = vi.fn(); // gh runner must NOT be called
    await expect(
      syncAttachmentsComment(client, { repo: "acme/web", num: 12, kind: "pull" }, run),
    ).rejects.toThrow(GithubCommentAuthorizationError);
    await expect(
      syncAttachmentsComment(client, { repo: "acme/web", num: 12, kind: "pull" }, run),
    ).rejects.toThrow(/uploads github link --status/);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not fall back to gh on actor_not_authorized (issue #297 control 2) either", async () => {
    const client = fakeClient({
      upsertGithubComment: async () => ({
        posted: false,
        reason: "actor_not_authorized",
        message: "Your linked GitHub account isn't on acme/web#12.",
      }),
    });
    const run = vi.fn(); // gh runner must NOT be called
    await expect(
      syncAttachmentsComment(client, { repo: "acme/web", num: 12, kind: "pull" }, run),
    ).rejects.toThrow(GithubCommentAuthorizationError);
    await expect(
      syncAttachmentsComment(client, { repo: "acme/web", num: 12, kind: "pull" }, run),
    ).rejects.toThrow(/authorized thread participant/);
    expect(run).not.toHaveBeenCalled();
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

  it("renders only path/state from a listing that carries every metadata key", async () => {
    const client = listClient([
      {
        key: "gh/acme/web/pull/12/before.webp",
        url: "https://storage.test/before.webp",
        embedUrl: "https://embed.test/before.webp",
        pageUrl: "https://uploads.sh/f/acme/before.webp",
        metadata: {
          path: "/settings",
          state: "before",
          device: "iPhone 15 Pro",
          software: "Adobe Photoshop 26.0",
        },
      },
    ] as never);

    let posted = "";
    const run: CommandRunner = (cmd, args, input) => {
      if (args[1]?.includes("per_page=100")) return "[]";
      if (input) posted = input;
      return JSON.stringify({ id: 9 });
    };

    await syncAttachmentsComment(client, { repo: "acme/web", num: 12, kind: "pull" }, run, "acme");

    expect(posted).toContain("<code>/settings</code> · <code>before</code>");
    expect(posted).not.toContain("iPhone");
    expect(posted).not.toContain("Photoshop");
  });

  const clientWithNothing = fakeClient({
    upsertGithubComment: async () => ({ posted: false, reason: "not_installed" }),
    listAll: async () => [],
    findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
  });

  it("empties an existing managed comment via gh when nothing is left", async () => {
    const { run, calls } = ghRunnerWithExisting(7);
    const result = await syncAttachmentsComment(
      clientWithNothing,
      { repo: "acme/web", num: 12, kind: "pull" },
      run,
    );
    expect(result).toEqual({ action: "updated", count: 0, via: "gh" });
    expect(calls.some((c) => c.args.includes("PATCH"))).toBe(true);
    expect(calls.some((c) => c.args.includes("repos/acme/web/issues/12/comments"))).toBe(false);
  });

  it("no-ops via gh when nothing is left and no comment exists", async () => {
    const { run, calls } = ghRunnerWithExisting(null);
    const result = await syncAttachmentsComment(
      clientWithNothing,
      { repo: "acme/web", num: 12, kind: "pull" },
      run,
    );
    expect(result).toEqual({ action: "skipped", count: 0, via: "gh" });
    expect(calls.some((c) => c.args.includes("PATCH"))).toBe(false);
    expect(calls.some((c) => c.args.includes("repos/acme/web/issues/12/comments"))).toBe(false);
  });

  describe("repo comment config (.uploads.yml)", () => {
    let dirs: string[] = [];

    afterEach(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
      dirs = [];
    });

    function tmpRepoWithConfig(yaml: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-commands-comment-"));
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, ".uploads.yml"), yaml);
      return dir;
    }

    it("caps inline images at maxInlineImages from a committed .uploads.yml", async () => {
      const root = tmpRepoWithConfig("comment:\n  maxInlineImages: 1\n");
      const client = fakeClient({
        upsertGithubComment: async () => ({ posted: false, reason: "not_installed" }),
        listAll: async () => [
          { key: "gh/acme/web/pull/12/a.png", url: "https://x.test/a.png", embedUrl: null },
          { key: "gh/acme/web/pull/12/b.png", url: "https://x.test/b.png", embedUrl: null },
        ],
        findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
      });
      let posted = "";
      // gh+git runner: `git rev-parse --show-toplevel` resolves to the temp
      // repo root; gh calls find no marker and create.
      const run: CommandRunner = (cmd, args, input) => {
        if (cmd === "git" && args[0] === "rev-parse" && args.includes("--show-toplevel")) {
          return `${root}\n`;
        }
        if (cmd !== "gh") throw new Error(`unexpected command: ${cmd}`);
        if (args[1]?.includes("per_page=100")) return "[]";
        if (input) posted = input;
        return JSON.stringify({ id: 9 });
      };
      await syncAttachmentsComment(client, { repo: "acme/web", num: 12, kind: "pull" }, run);
      expect(posted.match(/<img/g)?.length).toBe(1);
      expect(posted).toContain("<details>");
    });
  });
});
