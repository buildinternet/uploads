import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { UploadsError } from "../src/errors.js";
import type { UploadsClient } from "../src/client.js";
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

function runnerWithRepo(repo = "acme/web"): CommandRunner {
  return (cmd, args) => {
    if (cmd === "gh" && args[0] === "repo") return repo;
    throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
  };
}

describe("runGithub (link)", () => {
  it("claims an unbound repo by default", async () => {
    const calls: string[] = [];
    const client = {
      githubLinkClaim: async (repo: string) => {
        calls.push(repo);
        return {
          repo,
          linked: true,
          workspace: "acme",
          source: "cli",
          createdAt: "now",
          claimed: true,
        };
      },
    } as unknown as UploadsClient;
    const code = await runGithub(ctxWith(client), ["link"], false, runnerWithRepo());
    expect(code).toBe(0);
    expect(calls).toEqual(["acme/web"]);
  });

  it("--status only inspects, never claims", async () => {
    let claimCalled = false;
    const client = {
      githubLinkStatus: async (repo: string) => ({
        repo,
        linked: false,
        workspace: null,
        source: null,
        createdAt: null,
      }),
      githubLinkClaim: async () => {
        claimCalled = true;
        throw new Error("must not claim");
      },
    } as unknown as UploadsClient;
    const code = await runGithub(ctxWith(client), ["link", "--status"], false, runnerWithRepo());
    expect(code).toBe(0);
    expect(claimCalled).toBe(false);
  });

  it("reports claimed: false when the repo is bound to another workspace", async () => {
    const client = {
      githubLinkClaim: async (repo: string) => ({
        repo,
        linked: true,
        workspace: "someone-else",
        source: "comment",
        createdAt: "now",
        claimed: false,
      }),
    } as unknown as UploadsClient;
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => (stderr.push(String(chunk)), true));
    try {
      const code = await runGithub(ctxWith(client), ["link"], false, runnerWithRepo());
      expect(code).toBe(0);
      expect(stderr.join("")).toContain("someone-else");
    } finally {
      spy.mockRestore();
    }
  });

  it("degrades clearly on a 404 (older server without bindings)", async () => {
    const client = {
      githubLinkClaim: async () => {
        throw new UploadsError("not found", "NOT_FOUND", 404);
      },
    } as unknown as UploadsClient;
    await expect(runGithub(ctxWith(client), ["link"], false, runnerWithRepo())).rejects.toThrow(
      UsageError,
    );
  });

  it("shows help with no subcommand", async () => {
    const client = {} as unknown as UploadsClient;
    const code = await runGithub(ctxWith(client), [], false, runnerWithRepo());
    expect(code).toBe(2);
  });

  it("rejects an unknown subcommand", async () => {
    const client = {} as unknown as UploadsClient;
    await expect(runGithub(ctxWith(client), ["bogus"], false, runnerWithRepo())).rejects.toThrow(
      UsageError,
    );
  });
});
