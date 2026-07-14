import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runFind, type CliContext } from "../src/commands.js";

function fakeClient() {
  const calls: { filters: Record<string, string>; prefix?: string; limit?: number }[] = [];
  const client = {
    findFiles: async (
      filters: Record<string, string>,
      opts: { prefix?: string; limit?: number } = {},
    ) => {
      calls.push({ filters, prefix: opts.prefix, limit: opts.limit });
      return {
        items: [{ key: "gh/o/r/pull/123/a.png", url: "https://x.test/a.png", metadata: filters }],
        cursor: null,
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

  it("requires at least one pair", async () => {
    const { client } = fakeClient();
    expect(await runFind(ctxWith(client), [], false)).toBe(2);
  });

  it("rejects a malformed pair", async () => {
    const { client } = fakeClient();
    await expect(runFind(ctxWith(client), ["nokeyvalue"], false)).rejects.toThrow(UsageError);
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

  it("rejects --cursor with metadata filters", async () => {
    const { client } = fakeClient();
    await expect(runFind(ctxWith(client), ["app=myapp", "--cursor", "abc"], false)).rejects.toThrow(
      UsageError,
    );
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
