import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runList, type CliContext } from "../src/commands.js";
import type { CommandRunner } from "../src/github-gh.js";

function fakeListClient() {
  const prefixes: (string | undefined)[] = [];
  const client = {
    list: async (opts: { prefix?: string }) => {
      prefixes.push(opts.prefix);
      return { items: [], cursor: null };
    },
  } as unknown as UploadsClient;
  return { client, prefixes };
}

function ctxWith(client: UploadsClient): CliContext {
  return {
    config: {
      apiUrl: "https://x.test",
      workspace: "test",
      token: "up_test_x",
      workspaceSource: "override",
    },
    client,
    json: false,
    quiet: true,
  };
}

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

describe("runList --pr/--issue", () => {
  it("translates --pr to the gh prefix", async () => {
    const { client, prefixes } = fakeListClient();
    const code = await runList(
      ctxWith(client),
      ["--pr", "123", "--repo", "buildinternet/uploads"],
      false,
      noRun,
    );
    expect(code).toBe(0);
    expect(prefixes[0]).toBe("gh/buildinternet/uploads/pull/123/");
  });

  it("rejects --pr combined with --prefix", async () => {
    const { client } = fakeListClient();
    await expect(
      runList(ctxWith(client), ["--pr", "1", "--prefix", "x/", "--repo", "o/r"], false, noRun),
    ).rejects.toThrow(UsageError);
  });

  it("leaves plain --prefix behavior unchanged", async () => {
    const { client, prefixes } = fakeListClient();
    await runList(ctxWith(client), ["--prefix", "screenshots/"], false, noRun);
    expect(prefixes[0]).toBe("screenshots/");
  });
});
