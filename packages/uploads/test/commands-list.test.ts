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
      configPath: "/tmp/uploads-test-config",
      configExists: false,
    },
    client,
    json: false,
    quiet: true,
  };
}

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

const ghRun: CommandRunner = () => "o/r";

function fakeFindClient() {
  const calls: { filters: Record<string, string>; prefix?: string; limit?: number }[] = [];
  const client = {
    findFiles: async (
      filters: Record<string, string>,
      opts: { prefix?: string; limit?: number } = {},
    ) => {
      calls.push({ filters, prefix: opts.prefix, limit: opts.limit });
      return {
        items: [{ key: "gh/o/r/pull/1/a.png", url: "https://x.test/a.png", metadata: filters }],
        cursor: null,
      };
    },
  } as unknown as UploadsClient;
  return { client, calls };
}

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

describe("runList --meta", () => {
  it("switches to the metadata filter endpoint with a single --meta pair", async () => {
    const { client, calls } = fakeFindClient();
    const code = await runList(ctxWith(client), ["--meta", "app=myapp"], false, noRun);
    expect(code).toBe(0);
    expect(calls[0].filters).toEqual({ app: "myapp" });
  });

  it("ANDs repeated --meta pairs and combines with --prefix/--limit", async () => {
    const { client, calls } = fakeFindClient();
    await runList(
      ctxWith(client),
      ["--meta", "gh.repo=o/r", "--meta", "gh.number=1", "--prefix", "gh/", "--limit", "10"],
      false,
      noRun,
    );
    expect(calls[0].filters).toEqual({ "gh.repo": "o/r", "gh.number": "1" });
    expect(calls[0].prefix).toBe("gh/");
    expect(calls[0].limit).toBe(10);
  });

  it("rejects --meta combined with --pr", async () => {
    const { client } = fakeFindClient();
    await expect(
      runList(ctxWith(client), ["--meta", "app=x", "--pr", "1", "--repo", "o/r"], false, ghRun),
    ).rejects.toThrow(UsageError);
  });

  it("rejects --meta combined with --all", async () => {
    const { client } = fakeFindClient();
    await expect(
      runList(ctxWith(client), ["--meta", "app=x", "--all"], false, noRun),
    ).rejects.toThrow(UsageError);
  });
});
