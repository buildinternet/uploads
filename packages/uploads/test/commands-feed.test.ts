import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import type { CliContext } from "../src/commands.js";
import { runFeed } from "../src/commands/feed.js";

const feed = {
  id: "feed_example",
  url: "https://uploads.test/c/feed_example",
  workspace: "test",
  repo: "acme/app",
  path: null,
  number: null,
  kind: null,
  title: "acme/app",
  createdAt: "2026-09-15T12:00:00.000Z",
  updatedAt: "2026-09-15T12:00:00.000Z",
  items: [],
};

function ctxWith(client: UploadsClient): CliContext {
  return {
    config: {
      apiUrl: "https://api.test",
      workspace: "test",
      token: "up_test_x",
      workspaceSource: "override",
      configPath: "/tmp/uploads-test-config",
      configExists: false,
    },
    client,
    json: true,
    quiet: true,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("runFeed", () => {
  it("creates a feed from --repo and prints the API URL", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const created: Array<{
      repo: string;
      path?: string | null;
      number?: number;
      kind?: "pull" | "issue";
    }> = [];
    const client = {
      createFeed: async (opts: {
        repo: string;
        path?: string | null;
        number?: number;
        kind?: "pull" | "issue";
      }) => {
        created.push(opts);
        return feed;
      },
    } as unknown as UploadsClient;

    const code = await runFeed(ctxWith(client), ["create", "--repo", "Acme/App"]);
    expect(code).toBe(0);
    expect(created).toEqual([{ repo: "acme/app", path: undefined }]);
    expect(JSON.parse(stdout.mock.calls.map(([text]) => String(text)).join(""))).toEqual(feed);
  });

  it("creates a distinct feed for each positional repo", async () => {
    const created: Array<{ repo: string; path?: string | null }> = [];
    const client = {
      createFeed: async (opts: { repo: string; path?: string | null }) => {
        created.push(opts);
        const slug = opts.repo.replaceAll("/", "_");
        return {
          ...feed,
          id: `feed_${slug}`,
          repo: opts.repo,
          title: opts.repo,
          url: `https://uploads.test/c/${slug}`,
        };
      },
    } as unknown as UploadsClient;
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const textCtx = { ...ctxWith(client), json: false, quiet: false };
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await runFeed(textCtx, ["create", "buildinternet/uploads"])).toBe(0);
    expect(await runFeed(textCtx, ["create", "BuildInternet/Releases"])).toBe(0);

    expect(created).toEqual([
      { repo: "buildinternet/uploads", path: undefined },
      { repo: "buildinternet/releases", path: undefined },
    ]);
    expect(stdout.mock.calls.map(([text]) => String(text))).toEqual([
      "https://uploads.test/c/buildinternet_uploads\n",
      "https://uploads.test/c/buildinternet_releases\n",
    ]);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain(
      "warning: feeds are public",
    );
  });

  it("treats a matching positional and --repo as one repository", async () => {
    const created: Array<{ repo: string; number?: number; kind?: "pull" | "issue" }> = [];
    const client = {
      createFeed: async (opts: { repo: string; number?: number; kind?: "pull" | "issue" }) => {
        created.push(opts);
        return { ...feed, repo: opts.repo, number: opts.number ?? null, kind: opts.kind ?? null };
      },
    } as unknown as UploadsClient;
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(
      await runFeed(ctxWith(client), ["create", "Acme/App", "--repo", "acme/app", "--pr", "4"]),
    ).toBe(0);
    expect(created).toEqual([{ repo: "acme/app", path: undefined, number: 4, kind: "pull" }]);
  });

  it("rejects a positional repo that disagrees with --repo or --github", async () => {
    const client = {
      createFeed: async () => {
        throw new Error("createFeed should not run");
      },
    } as unknown as UploadsClient;
    await expect(
      runFeed(ctxWith(client), [
        "create",
        "buildinternet/releases",
        "--repo",
        "buildinternet/uploads",
      ]),
    ).rejects.toThrow(/does not match --repo/);
    await expect(
      runFeed(ctxWith(client), ["create", "buildinternet/releases", "--github", "acme/app#8"]),
    ).rejects.toThrow(/does not match --github/);
    await expect(runFeed(ctxWith(client), ["create", "not-a-repo"])).rejects.toThrow(
      /repository must be owner\/name/,
    );
    await expect(runFeed(ctxWith(client), ["create", "acme/app", "extra"])).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it("passes an optional path filter through", async () => {
    const client = {
      createFeed: async (opts: { repo: string; path?: string | null }) => ({
        ...feed,
        path: opts.path ?? null,
        title: `acme/app · ${opts.path}`,
      }),
    } as unknown as UploadsClient;
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runFeed(ctxWith(client), [
      "create",
      "--repo",
      "acme/app",
      "--path",
      "/settings",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.mock.calls.map(([text]) => String(text)).join(""))).toMatchObject({
      path: "/settings",
    });
  });

  it("passes --pr as number + kind=pull", async () => {
    const created: Array<{ repo: string; number?: number; kind?: "pull" | "issue" }> = [];
    const client = {
      createFeed: async (opts: { repo: string; number?: number; kind?: "pull" | "issue" }) => {
        created.push(opts);
        return { ...feed, number: 123, kind: "pull", title: "acme/app#123" };
      },
    } as unknown as UploadsClient;
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runFeed(ctxWith(client), ["create", "--repo", "acme/app", "--pr", "123"]);
    expect(code).toBe(0);
    expect(created).toEqual([{ repo: "acme/app", path: undefined, number: 123, kind: "pull" }]);
    expect(JSON.parse(stdout.mock.calls.map(([text]) => String(text)).join(""))).toMatchObject({
      number: 123,
      kind: "pull",
    });
  });

  it("parses --github owner/repo#number", async () => {
    const created: Array<{ repo: string; number?: number; kind?: "pull" | "issue" }> = [];
    const client = {
      createFeed: async (opts: { repo: string; number?: number; kind?: "pull" | "issue" }) => {
        created.push(opts);
        return { ...feed, repo: opts.repo, number: opts.number ?? null, title: "acme/app#58" };
      },
    } as unknown as UploadsClient;
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runFeed(ctxWith(client), ["create", "--github", "Acme/App#58"])).toBe(0);
    expect(created).toEqual([{ repo: "acme/app", path: undefined, number: 58, kind: undefined }]);
  });

  it("rejects --pr combined with --issue or --github", async () => {
    const client = { createFeed: async () => feed } as unknown as UploadsClient;
    await expect(
      runFeed(ctxWith(client), ["create", "--repo", "acme/app", "--pr", "1", "--issue", "2"]),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runFeed(ctxWith(client), ["create", "--github", "acme/app#1", "--pr", "1"]),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("shows and deletes by id", async () => {
    const seen: string[] = [];
    const client = {
      getFeed: async (id: string) => {
        seen.push(`get:${id}`);
        return feed;
      },
      deleteFeed: async (id: string) => {
        seen.push(`delete:${id}`);
        return { deleted: true, id };
      },
    } as unknown as UploadsClient;
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runFeed(ctxWith(client), ["show", "feed_example"])).toBe(0);
    expect(await runFeed(ctxWith(client), ["delete", "feed_example"])).toBe(0);
    expect(seen).toEqual(["get:feed_example", "delete:feed_example"]);
    const printed = stdout.mock.calls.map(([text]) => String(text)).join("");
    expect(printed).toContain("feed_example");
  });
});
