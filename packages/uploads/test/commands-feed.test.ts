import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadsClient } from "../src/client.js";
import type { CliContext } from "../src/commands.js";
import { runFeed } from "../src/commands/feed.js";

const feed = {
  id: "feed_example",
  url: "https://uploads.test/feed/feed_example",
  workspace: "test",
  repo: "acme/app",
  path: null,
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
    const created: Array<{ repo: string; path?: string | null }> = [];
    const client = {
      createFeed: async (opts: { repo: string; path?: string | null }) => {
        created.push(opts);
        return feed;
      },
    } as unknown as UploadsClient;

    const code = await runFeed(ctxWith(client), ["create", "--repo", "Acme/App"]);
    expect(code).toBe(0);
    expect(created).toEqual([{ repo: "acme/app", path: undefined }]);
    expect(JSON.parse(stdout.mock.calls.map(([text]) => String(text)).join(""))).toEqual(feed);
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
