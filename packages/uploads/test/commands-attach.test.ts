import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runAttach, type CliContext } from "../src/commands.js";
import type { CommandRunner } from "../src/github-gh.js";

function files(...names: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "uploads-attach-test-"));
  return names.map((name) => {
    const path = join(dir, name);
    writeFileSync(path, name);
    return path;
  });
}

function fakeClient() {
  const puts: string[] = [];
  const list = async ({ prefix }: { prefix?: string } = {}) => ({
    items: puts
      .filter((key) => key.startsWith(prefix ?? ""))
      .map((key) => ({ key, url: `https://x.test/${key}` })),
    cursor: null,
  });
  const client = {
    put: async (_body: Uint8Array, opts: { key: string }) => {
      puts.push(opts.key);
      return {
        workspace: "test",
        key: opts.key,
        url: `https://x.test/${opts.key}`,
        size: 3,
        contentType: "image/png",
      };
    },
    list,
    listAll: async (opts: { prefix?: string } = {}) => (await list(opts)).items,
    findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
    getGallery: async () => ({ items: [] }),
  } as unknown as UploadsClient;
  return { client, puts };
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

function ghRunner() {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "repo") return "buildinternet/uploads\n";
    if (args[0] === "pr" && args[1] === "view") return "123\n";
    if (args[1]?.includes("per_page=100")) return "[]";
    return JSON.stringify({ id: 9 });
  };
  return { run, calls };
}

const noPullRequestRunner: CommandRunner = (_cmd, args) => {
  if (args[0] === "repo") return "o/r";
  throw new Error("no pull request");
};

describe("runAttach", () => {
  it("infers the current PR, uploads multiple stable keys, and creates a comment", async () => {
    const { client, puts } = fakeClient();
    const { run, calls } = ghRunner();
    expect(await runAttach(ctxWith(client), files("before.png", "after.png"), false, run)).toBe(0);
    expect(puts).toEqual([
      "gh/buildinternet/uploads/pull/123/before.png",
      "gh/buildinternet/uploads/pull/123/after.png",
    ]);
    expect(calls.some((call) => call[1] === "pr" && call[2] === "view")).toBe(true);
    expect(
      calls.some((call) => call.includes("repos/buildinternet/uploads/issues/123/comments")),
    ).toBe(true);
  });

  it("supports an explicit issue and skips the managed comment with --no-comment", async () => {
    const { client, puts } = fakeClient();
    const { run, calls } = ghRunner();
    await runAttach(
      ctxWith(client),
      [...files("artifact.zip"), "--issue", "45", "--repo", "o/r", "--no-comment"],
      false,
      run,
    );
    expect(puts).toEqual(["gh/o/r/issues/45/artifact.zip"]);
    expect(calls).toEqual([]);
  });

  it("requires an inferable current PR when no target is supplied", async () => {
    const { client } = fakeClient();
    await expect(
      runAttach(ctxWith(client), files("shot.png"), false, noPullRequestRunner),
    ).rejects.toThrow(UsageError);
  });
});
