import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runFind, type CliContext } from "../src/commands.js";

function fakeClient() {
  const calls: {
    filters: Record<string, string>;
    prefix?: string;
    limit?: number;
    name?: string;
    cursor?: string;
  }[] = [];
  const client = {
    findFiles: async (
      filters: Record<string, string>,
      opts: { prefix?: string; limit?: number; name?: string; cursor?: string } = {},
    ) => {
      calls.push({
        filters,
        prefix: opts.prefix,
        limit: opts.limit,
        name: opts.name,
        cursor: opts.cursor,
      });
      return {
        items: [
          {
            key: "gh/o/r/pull/123/a.png",
            url: "https://x.test/a.png",
            metadata: Object.keys(filters).length > 0 ? filters : { app: "web" },
          },
        ],
        cursor: null,
        truncated: opts.name ? false : undefined,
      };
    },
  } as unknown as UploadsClient;
  return { client, calls };
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

describe("runFind", () => {
  it("parses positional k=v pairs and hits the filter endpoint", async () => {
    const { client, calls } = fakeClient();
    const code = await runFind(
      ctxWith(client),
      ["gh.repo=buildinternet/uploads", "gh.number=123"],
      false,
    );
    expect(code).toBe(0);
    expect(calls[0].filters).toEqual({ "gh.repo": "buildinternet/uploads", "gh.number": "123" });
  });

  it("also accepts the --meta k=v spelling (#545)", async () => {
    const { client, calls } = fakeClient();
    const code = await runFind(
      ctxWith(client),
      ["--meta", "path=/settings", "--meta", "state=after"],
      false,
    );
    expect(code).toBe(0);
    expect(calls[0].filters).toEqual({ path: "/settings", state: "after" });
  });

  it("requires at least one pair or name, and says so instead of dumping help (#545)", async () => {
    const { client } = fakeClient();
    await expect(runFind(ctxWith(client), [], false)).rejects.toThrow(/find requires at least one/);
  });

  it("accepts a bare positional as the filename name term (#528)", async () => {
    const { client, calls } = fakeClient();
    const code = await runFind(ctxWith(client), ["hero"], false);
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({ filters: {}, name: "hero" });
  });

  it("accepts --name and combines it with meta filters", async () => {
    const { client, calls } = fakeClient();
    const code = await runFind(ctxWith(client), ["app=web", "--name", "hero"], false);
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({ filters: { app: "web" }, name: "hero" });
  });

  it("rejects both a bare name and --name together", async () => {
    const { client } = fakeClient();
    await expect(runFind(ctxWith(client), ["hero", "--name", "shot"], false)).rejects.toThrow(
      UsageError,
    );
  });

  it("rejects a malformed pair that is not a bare name", async () => {
    const { client } = fakeClient();
    // "nokeyvalue" is a bare name term (no `=`), so it is accepted as --name.
    // A real malformed k=v has `=` but fails parseMetaFlags.
    await expect(runFind(ctxWith(client), ["=novalue"], false)).rejects.toThrow(UsageError);
  });

  it("combines with --prefix and --limit", async () => {
    const { client, calls } = fakeClient();
    await runFind(
      ctxWith(client),
      ["app=myapp", "--prefix", "screenshots/", "--limit", "5"],
      false,
    );
    expect(calls[0].prefix).toBe("screenshots/");
    expect(calls[0].limit).toBe(5);
  });

  it("forwards --cursor to the search endpoint (issue #829 §4)", async () => {
    const { client, calls } = fakeClient();
    const code = await runFind(ctxWith(client), ["app=myapp", "--cursor", "abc"], false);
    expect(code).toBe(0);
    expect(calls[0].cursor).toBe("abc");
  });

  it("--all follows the cursor through findFilesAll", async () => {
    const { client, calls } = fakeClient();
    const drained: unknown[] = [];
    (client as unknown as Record<string, unknown>).findFilesAll = async (
      filters: Record<string, string>,
      opts: { cursor?: string },
    ) => {
      drained.push({ filters, cursor: opts.cursor });
      return { items: [], cursor: null, truncated: false };
    };
    const code = await runFind(ctxWith(client), ["app=myapp", "--all"], false);
    expect(code).toBe(0);
    expect(drained).toEqual([{ filters: { app: "myapp" }, cursor: undefined }]);
    expect(calls).toHaveLength(0);
  });

  it("renders each match's key, url, and matched metadata (sorted) on stdout", async () => {
    const { client } = fakeClient();
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await runFind(ctxWith(client), ["gh.number=123", "gh.repo=o/r"], false);
    } finally {
      vi.restoreAllMocks();
    }
    expect(stdout.join("")).toBe(
      "gh/o/r/pull/123/a.png  https://x.test/a.png  gh.number=123 gh.repo=o/r\n",
    );
  });
});
