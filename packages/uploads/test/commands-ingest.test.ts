import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { IngestGithubResult, UploadsClient } from "../src/client.js";
import { runIngest, type CliContext } from "../src/commands.js";
import type { CommandRunner } from "../src/github-gh.js";

function fakeClient(overrides: Partial<UploadsClient> = {}): UploadsClient {
  return {
    ingestGithub: async () => ({
      repo: "acme/web",
      kind: "pull",
      num: 7,
      ingested: [],
      reattached: [],
      detached: [],
      skipped: [],
    }),
    ...overrides,
  } as unknown as UploadsClient;
}

function ctxWith(client: UploadsClient, json = false): CliContext {
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
    json,
    quiet: true,
  };
}

/** git/gh runner that resolves the current repo to acme/web (gh unavailable → git remote fallback). */
function repoRunner(): CommandRunner {
  return (cmd, args) => {
    if (cmd === "gh") throw new Error("gh not available");
    if (cmd === "git" && args[0] === "config" && args.includes("remote.origin.url")) {
      return "https://github.com/acme/web.git\n";
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
  };
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

describe("runIngest", () => {
  it("resolves the repo and calls ingestGithub with the derived target", async () => {
    const ingestGithub = vi.fn(
      async (): Promise<IngestGithubResult> => ({
        repo: "acme/web",
        kind: "pull",
        num: 7,
        ingested: ["gh/acme/web/pull/7/a.png", "gh/acme/web/pull/7/b.png"],
        reattached: [],
        detached: ["gh/acme/web/pull/7/old.png"],
        skipped: [],
      }),
    );
    const client = fakeClient({ ingestGithub });
    const err = await captureStderr(() =>
      runIngest({ ...ctxWith(client), quiet: false }, ["--pr", "7"], false, repoRunner()),
    );
    expect(ingestGithub).toHaveBeenCalledWith({ repo: "acme/web", kind: "pull", num: 7 });
    expect(err).toContain("Ingested 2, re-attached 0, detached 1, skipped 0");
  });

  it("throws UsageError when --pr and --issue are both given", async () => {
    const client = fakeClient();
    await expect(
      runIngest(ctxWith(client), ["--pr", "1", "--issue", "2"], false, repoRunner()),
    ).rejects.toThrow(UsageError);
  });

  it("throws UsageError when neither --pr nor --issue is given", async () => {
    const client = fakeClient();
    await expect(runIngest(ctxWith(client), [], false, repoRunner())).rejects.toThrow(
      "--pr or --issue required",
    );
  });

  it("writes the raw response as JSON when ctx.json is true", async () => {
    const result: IngestGithubResult = {
      repo: "acme/web",
      kind: "issues",
      num: 45,
      ingested: ["gh/acme/web/issues/45/a.png"],
      reattached: [],
      detached: [],
      skipped: [],
    };
    const ingestGithub = vi.fn(async () => result);
    const client = fakeClient({ ingestGithub });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await runIngest(ctxWith(client, true), ["--issue", "45"], false, repoRunner());
      expect(code).toBe(0);
      const printed = writeSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(JSON.parse(printed)).toEqual(result);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("writes the raw response as JSON when --format json is given without ctx.json", async () => {
    const result: IngestGithubResult = {
      repo: "acme/web",
      kind: "pull",
      num: 7,
      ingested: ["gh/acme/web/pull/7/a.png"],
      reattached: [],
      detached: [],
      skipped: [],
    };
    const ingestGithub = vi.fn(async () => result);
    const client = fakeClient({ ingestGithub });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await runIngest(
        ctxWith(client),
        ["--pr", "7", "--format", "json"],
        false,
        repoRunner(),
      );
      expect(code).toBe(0);
      const printed = writeSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(JSON.parse(printed)).toEqual(result);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("renders skipped entries as human-readable lines", async () => {
    const ingestGithub = vi.fn(
      async (): Promise<IngestGithubResult> => ({
        repo: "acme/web",
        kind: "pull",
        num: 7,
        ingested: [],
        reattached: [],
        detached: [],
        skipped: [
          { url: "https://github.com/user-attachments/x", reason: "unsupported content type" },
        ],
      }),
    );
    const client = fakeClient({ ingestGithub });
    const err = await captureStderr(() =>
      runIngest({ ...ctxWith(client), quiet: false }, ["--pr", "7"], false, repoRunner()),
    );
    expect(err).toContain(
      "skipped: https://github.com/user-attachments/x (unsupported content type)",
    );
  });
});
