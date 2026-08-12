import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { UploadsError } from "../src/errors.js";
import type { RotateGhPrefixOptions, RotateGhPrefixResult, UploadsClient } from "../src/client.js";
import { runGithub, type CliContext } from "../src/commands.js";
import type { CommandRunner } from "../src/github-gh.js";

function ctxWith(client: UploadsClient, json = false): CliContext {
  return {
    config: {
      apiUrl: "https://x.test",
      workspace: "acme",
      token: "up_acme_x",
      workspaceSource: "override",
      configPath: "/tmp/uploads-test-config",
      configExists: false,
    },
    client,
    json,
    quiet: true,
  };
}

function runnerWithRepoAndBranch(repo = "acme/web", branch = "feature-x"): CommandRunner {
  return (cmd, args) => {
    if (cmd === "gh" && args[0] === "repo") return repo;
    if (cmd === "git" && args[0] === "rev-parse") return branch;
    throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
  };
}

function clientReturning(result: RotateGhPrefixResult) {
  const calls: RotateGhPrefixOptions[] = [];
  const client = {
    rotateGhPrefix: async (opts: RotateGhPrefixOptions) => {
      calls.push(opts);
      return result;
    },
  } as unknown as UploadsClient;
  return { client, calls };
}

describe("runGithub (rotate-prefix, issue #631)", () => {
  it("defaults --branch to the current git branch", async () => {
    const { client, calls } = clientReturning({
      rotated: true,
      prefixId: "n".repeat(32),
      moved: 2,
    });
    const code = await runGithub(
      ctxWith(client),
      ["rotate-prefix"],
      false,
      runnerWithRepoAndBranch(),
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{ repo: "acme/web", branch: "feature-x" }]);
  });

  it("--branch overrides the git-derived default", async () => {
    const { client, calls } = clientReturning({
      rotated: true,
      prefixId: "n".repeat(32),
      moved: 1,
    });
    const code = await runGithub(
      ctxWith(client),
      ["rotate-prefix", "--branch", "other-branch"],
      false,
      runnerWithRepoAndBranch(),
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{ repo: "acme/web", branch: "other-branch" }]);
  });

  it("--repo-level rotates the repo-level id and never resolves a git branch", async () => {
    const { client, calls } = clientReturning({
      rotated: true,
      prefixId: "n".repeat(32),
      moved: 3,
    });
    const code = await runGithub(
      ctxWith(client),
      ["rotate-prefix", "--repo-level"],
      false,
      // No `git rev-parse` stub — throws if rotate-prefix tries to resolve a branch.
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "repo") return "acme/web";
        throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{ repo: "acme/web", repoLevel: true }]);
  });

  it("rejects passing both --branch and --repo-level", async () => {
    const { client } = clientReturning({ rotated: true, prefixId: "n".repeat(32), moved: 0 });
    await expect(
      runGithub(
        ctxWith(client),
        ["rotate-prefix", "--branch", "x", "--repo-level"],
        false,
        runnerWithRepoAndBranch(),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("prints the moved count and new-prefix confirmation on success", async () => {
    const { client } = clientReturning({ rotated: true, prefixId: "a".repeat(32), moved: 5 });
    const stdout: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => (stdout.push(String(chunk)), true));
    try {
      const code = await runGithub(
        ctxWith(client),
        ["rotate-prefix"],
        false,
        runnerWithRepoAndBranch(),
      );
      expect(code).toBe(0);
      const out = stdout.join("");
      expect(out).toContain("5");
      expect(out).toContain("a".repeat(32));
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a no-op (exit 1) when there's no active prefix to rotate", async () => {
    const { client } = clientReturning({ rotated: false, reason: "no_prefix" });
    const code = await runGithub(
      ctxWith(client),
      ["rotate-prefix"],
      false,
      runnerWithRepoAndBranch(),
    );
    expect(code).toBe(1);
  });

  it("json mode emits the raw result", async () => {
    const result: RotateGhPrefixResult = { rotated: true, prefixId: "b".repeat(32), moved: 1 };
    const { client } = clientReturning(result);
    const writes: unknown[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => (writes.push(chunk), true));
    try {
      const code = await runGithub(
        ctxWith(client, true),
        ["rotate-prefix"],
        false,
        runnerWithRepoAndBranch(),
      );
      expect(code).toBe(0);
      expect(JSON.parse(String(writes.join("")))).toEqual(result);
    } finally {
      spy.mockRestore();
    }
  });

  it("degrades clearly on a 404 (older server without prefix rotation)", async () => {
    const client = {
      rotateGhPrefix: async () => {
        throw new UploadsError("not found", "NOT_FOUND", 404);
      },
    } as unknown as UploadsClient;
    await expect(
      runGithub(ctxWith(client), ["rotate-prefix"], false, runnerWithRepoAndBranch()),
    ).rejects.toThrow(UsageError);
  });

  it("surfaces a clear error when the caller isn't authorized (403)", async () => {
    const client = {
      rotateGhPrefix: async () => {
        throw new UploadsError("not authorized", "API_ERROR", 403);
      },
    } as unknown as UploadsClient;
    await expect(
      runGithub(ctxWith(client), ["rotate-prefix"], false, runnerWithRepoAndBranch()),
    ).rejects.toThrow(UsageError);
  });
});
