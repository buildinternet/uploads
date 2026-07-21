import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { PromoteBranchAttachmentsResult, UploadsClient } from "../src/client.js";
import { runAttach, type CliContext } from "../src/commands.js";
import { UploadsError } from "../src/errors.js";
import type { CommandRunner } from "../src/github-gh.js";

function files(...names: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "uploads-attach-test-"));
  return names.map((name) => {
    const path = join(dir, name);
    writeFileSync(path, name);
    return path;
  });
}

function fakeClient(opts?: {
  /** Reject put for keys whose leaf matches this predicate. */
  failLeaf?: (leaf: string) => boolean | Error;
  /** `client.promoteBranchAttachments` behavior; omitted → method is absent (older-server simulation). */
  promote?: (opts: {
    repo: string;
    num: number;
    branch: string;
  }) => Promise<PromoteBranchAttachmentsResult> | PromoteBranchAttachmentsResult;
}) {
  const puts: string[] = [];
  const metadataByKey: Record<string, Record<string, string> | undefined> = {};
  const promoteCalls: { repo: string; num: number; branch: string }[] = [];
  const callOrder: string[] = [];
  const list = async ({ prefix }: { prefix?: string } = {}) => ({
    items: puts
      .filter((key) => key.startsWith(prefix ?? ""))
      .map((key) => ({ key, url: `https://x.test/${key}` })),
    cursor: null,
  });
  const client = {
    put: async (_body: Uint8Array, putOpts: { key: string; metadata?: Record<string, string> }) => {
      const leaf = putOpts.key.split("/").at(-1) ?? putOpts.key;
      if (opts?.failLeaf) {
        const fail = opts.failLeaf(leaf);
        if (fail) {
          throw fail instanceof Error
            ? fail
            : new UploadsError(`forced fail: ${leaf}`, "API_ERROR", 500);
        }
      }
      puts.push(putOpts.key);
      metadataByKey[putOpts.key] = putOpts.metadata;
      return {
        workspace: "test",
        key: putOpts.key,
        url: `https://x.test/${putOpts.key}`,
        embedUrl: null,
        size: 3,
        contentType: "image/png",
      };
    },
    list,
    listAll: async (listOpts: { prefix?: string } = {}) => {
      callOrder.push("comment-gather");
      return (await list(listOpts)).items;
    },
    findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
    getGallery: async () => ({ items: [] }),
    ...(opts?.promote
      ? {
          promoteBranchAttachments: async (promoteOpts: {
            repo: string;
            num: number;
            branch: string;
          }) => {
            promoteCalls.push(promoteOpts);
            callOrder.push("promote");
            const result = await opts.promote!(promoteOpts);
            // Simulate the server-side effect: promoted keys become real
            // objects under the workspace, visible to a subsequent list.
            for (const key of result.promoted) if (!puts.includes(key)) puts.push(key);
            return result;
          },
        }
      : {}),
  } as unknown as UploadsClient;
  return { client, puts, metadataByKey, promoteCalls, callOrder };
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

/**
 * `opts.title` set → the gh.title lookup (`pr|issue view <num> --json title`)
 * resolves it; unset → it throws, same as gh being unable to resolve a title
 * (the default for every existing test in this file, so none of them see an
 * unexpected gh.title show up in their metadata assertions).
 */
function ghRunner(opts: { title?: string } = {}) {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if ((args[0] === "pr" || args[0] === "issue") && args[1] === "view" && args.includes("title")) {
      if (opts.title !== undefined) return `${opts.title}\n`;
      throw new Error("gh: title not resolvable");
    }
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
    expect(puts.sort()).toEqual(
      [
        "gh/buildinternet/uploads/pull/123/before.png",
        "gh/buildinternet/uploads/pull/123/after.png",
      ].sort(),
    );
    expect(calls.some((call) => call[1] === "pr" && call[2] === "view")).toBe(true);
    expect(
      calls.some((call) => call.includes("repos/buildinternet/uploads/issues/123/comments")),
    ).toBe(true);
  });

  it("uploads multiple files with bounded concurrency", async () => {
    const { client, puts } = fakeClient();
    const { run } = ghRunner();
    // Count overlap at the put boundary (after prepare). Hold each put open so
    // concurrent workers can stack before any resolves.
    let inFlight = 0;
    let maxInFlight = 0;
    const originalPut = client.put.bind(client);
    client.put = async (body, opts) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight -= 1;
      return originalPut(body, opts);
    };
    const paths = files("a.png", "b.png", "c.png", "d.png");
    expect(await runAttach(ctxWith(client), [...paths, "--no-comment"], false, run)).toBe(0);
    expect(puts).toHaveLength(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("continues after a per-file failure and reports failures (exit 1)", async () => {
    const { client, puts } = fakeClient({
      failLeaf: (leaf) => leaf === "bad.png",
    });
    const { run, calls } = ghRunner();
    const paths = files("good.png", "bad.png", "also-good.png");
    const ctx = { ...ctxWith(client), json: true };
    const jsonChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      jsonChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await runAttach(ctx, paths, false, run)).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
    expect(puts.sort()).toEqual(
      [
        "gh/buildinternet/uploads/pull/123/good.png",
        "gh/buildinternet/uploads/pull/123/also-good.png",
      ].sort(),
    );
    const payload = JSON.parse(jsonChunks.join("")) as {
      uploads: { key: string }[];
      failures: { file: string; error: { message: string; code?: string } }[];
    };
    expect(payload.uploads.map((u) => u.key).sort()).toEqual(
      [
        "gh/buildinternet/uploads/pull/123/good.png",
        "gh/buildinternet/uploads/pull/123/also-good.png",
      ].sort(),
    );
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0]!.file).toContain("bad.png");
    expect(payload.failures[0]!.error.code).toBe("API_ERROR");
    // Partial success still refreshes the managed comment.
    expect(
      calls.some((call) => call.includes("repos/buildinternet/uploads/issues/123/comments")),
    ).toBe(true);
  });

  it("rethrows a single-file total failure for exit-code mapping", async () => {
    const { client } = fakeClient({
      failLeaf: () => new UploadsError("nope", "UNAUTHORIZED", 401),
    });
    const { run } = ghRunner();
    await expect(runAttach(ctxWith(client), files("only.png"), false, run)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("returns exit 1 with failures when every multi-file upload fails", async () => {
    const { client, puts } = fakeClient({
      failLeaf: () => new UploadsError("nope", "API_ERROR", 500),
    });
    const { run } = ghRunner();
    const ctx = { ...ctxWith(client), json: true };
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await runAttach(ctx, files("a.png", "b.png"), false, run)).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
    expect(puts).toEqual([]);
    const payload = JSON.parse(chunks.join("")) as {
      uploads: unknown[];
      failures: { file: string }[];
    };
    expect(payload.uploads).toEqual([]);
    expect(payload.failures).toHaveLength(2);
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
    // No comment-sync calls (--no-comment); the only gh call is the
    // best-effort gh.title lookup, which this fixture fails by default.
    expect(calls).toEqual([
      ["gh", "issue", "view", "45", "--repo", "o/r", "--json", "title", "--jq", ".title"],
    ]);
  });

  it("requires an inferable current PR when no target is supplied", async () => {
    const { client } = fakeClient();
    await expect(
      runAttach(ctxWith(client), files("shot.png"), false, noPullRequestRunner),
    ).rejects.toThrow(UsageError);
  });

  it("hints how to find the attachments later via gh.ref metadata", async () => {
    const { client } = fakeClient();
    const { run } = ghRunner();
    const ctx = { ...ctxWith(client), quiet: false };
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    try {
      await runAttach(ctx, files("shot.png"), false, run);
    } finally {
      vi.restoreAllMocks();
    }
    expect(stderr.join("")).toContain(
      ">> find these later: uploads find gh.ref=buildinternet/uploads#123\n",
    );
  });
});

describe("runAttach gh.* metadata", () => {
  it("writes gh.repo/gh.kind/gh.number/gh.ref for a pull request target", async () => {
    const { client, metadataByKey } = fakeClient();
    const { run } = ghRunner();
    await runAttach(ctxWith(client), files("shot.png"), false, run);
    expect(metadataByKey["gh/buildinternet/uploads/pull/123/shot.png"]).toEqual({
      "gh.repo": "buildinternet/uploads",
      "gh.kind": "pull",
      "gh.number": "123",
      "gh.ref": "buildinternet/uploads#123",
    });
  });

  it("uses gh.kind=issue for an --issue target", async () => {
    const { client, metadataByKey } = fakeClient();
    const { run } = ghRunner();
    await runAttach(
      ctxWith(client),
      [...files("artifact.zip"), "--issue", "45", "--repo", "o/r", "--no-comment"],
      false,
      run,
    );
    expect(metadataByKey["gh/o/r/issues/45/artifact.zip"]).toMatchObject({
      "gh.kind": "issue",
      "gh.ref": "o/r#45",
    });
  });

  it("lowercases gh.repo and gh.ref for a mixed-case repo so metadata search stays exact-match", async () => {
    const { client, metadataByKey } = fakeClient();
    // Mixed-case repo, as gh/--repo can return; key path keeps original case
    // (ghAttachmentKey), but gh.* metadata is normalized to lowercase.
    const run: CommandRunner = (_cmd, args) => {
      if (args[0] === "repo") return "BuildInternet/Uploads\n";
      if (args[0] === "pr" && args[1] === "view") return "123\n";
      if (args[1]?.includes("per_page=100")) return "[]";
      return JSON.stringify({ id: 9 });
    };
    await runAttach(ctxWith(client), files("shot.png"), false, run);
    expect(metadataByKey["gh/BuildInternet/Uploads/pull/123/shot.png"]).toMatchObject({
      "gh.repo": "buildinternet/uploads",
      "gh.ref": "buildinternet/uploads#123",
    });
  });

  it("merges --meta extras and lets the resolved target's gh.* win over a same-named extra", async () => {
    const { client, metadataByKey } = fakeClient();
    const { run } = ghRunner();
    await runAttach(
      ctxWith(client),
      [...files("shot.png"), "--meta", "app=myapp", "--meta", "gh.repo=should-be-overridden/nope"],
      false,
      run,
    );
    const metadata = metadataByKey["gh/buildinternet/uploads/pull/123/shot.png"];
    expect(metadata?.app).toBe("myapp");
    expect(metadata?.["gh.repo"]).toBe("buildinternet/uploads");
  });

  it("rejects when 22 extras + the 4 automatic gh.* pairs exceed the 24-key cap", async () => {
    const { client } = fakeClient();
    const { run } = ghRunner();
    const metaFlags: string[] = [];
    for (let i = 0; i < 22; i++) metaFlags.push("--meta", `k${i}=v`);
    await expect(
      runAttach(ctxWith(client), [...files("shot.png"), ...metaFlags], false, run),
    ).rejects.toThrow(UsageError);
  });
});

describe("runAttach --branch (branch-staged, pre-PR)", () => {
  /** No PR/issue lookups expected — --branch must never call resolveCurrentPullRequest or gh pr view. */
  const branchRunner = (branch = "feature/thing"): { run: CommandRunner; calls: string[][] } => {
    const calls: string[][] = [];
    const run: CommandRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "rev-parse") return `${branch}\n`;
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    };
    return { run, calls };
  };

  it("stages under gh/<owner>/<repo>/branch/<branch>/<filename>, sanitizing the branch segment", async () => {
    const { client, puts } = fakeClient();
    const { run } = branchRunner();
    expect(
      await runAttach(
        ctxWith(client),
        [...files("shot.png"), "--branch", "feature/thing", "--repo", "o/r"],
        false,
        run,
      ),
    ).toBe(0);
    expect(puts).toEqual(["gh/o/r/branch/feature-thing/shot.png"]);
  });

  it("defaults --branch (no value) to the current git branch", async () => {
    const { client, puts } = fakeClient();
    const { run, calls } = branchRunner("main");
    expect(
      await runAttach(
        ctxWith(client),
        [...files("shot.png"), "--branch", "--repo", "o/r"],
        false,
        run,
      ),
    ).toBe(0);
    expect(puts).toEqual(["gh/o/r/branch/main/shot.png"]);
    expect(calls).toEqual([["git", "rev-parse", "--abbrev-ref", "HEAD"]]);
  });

  it("throws UsageError on detached HEAD when --branch has no value", async () => {
    const { client } = fakeClient();
    const run: CommandRunner = (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse") return "HEAD\n";
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    };
    await expect(
      runAttach(ctxWith(client), [...files("shot.png"), "--branch", "--repo", "o/r"], false, run),
    ).rejects.toThrow(UsageError);
  });

  it("writes gh.repo/gh.kind=branch/gh.branch/gh.staged-at (no gh.number/gh.ref/gh.title)", async () => {
    const { client, metadataByKey } = fakeClient();
    const { run } = branchRunner();
    await runAttach(
      ctxWith(client),
      [...files("shot.png"), "--branch", "feature/thing", "--repo", "o/r"],
      false,
      run,
    );
    const metadata = metadataByKey["gh/o/r/branch/feature-thing/shot.png"];
    expect(metadata).toMatchObject({
      "gh.repo": "o/r",
      "gh.kind": "branch",
      "gh.branch": "feature/thing",
    });
    expect(metadata?.["gh.staged-at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(metadata?.["gh.number"]).toBeUndefined();
    expect(metadata?.["gh.ref"]).toBeUndefined();
    expect(metadata?.["gh.title"]).toBeUndefined();
  });

  it("never attempts the managed comment sync (no gh api comments call)", async () => {
    const { client } = fakeClient();
    const { run, calls } = branchRunner();
    await runAttach(
      ctxWith(client),
      [...files("shot.png"), "--branch", "feature/thing", "--repo", "o/r"],
      false,
      run,
    );
    expect(calls.some((c) => c.join(" ").includes("/comments"))).toBe(false);
  });

  it.each([
    ["--pr", "1"],
    ["--issue", "1"],
    ["--comment", undefined],
  ])("rejects --branch combined with %s", async (flag, value) => {
    const { client } = fakeClient();
    const { run } = branchRunner();
    const extra = value !== undefined ? [flag, value] : [flag];
    await expect(
      runAttach(
        ctxWith(client),
        [...files("shot.png"), "--branch", "feature/thing", "--repo", "o/r", ...extra],
        false,
        run,
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects an unsafe branch name that fails the printable-ASCII metadata rule", async () => {
    const { client } = fakeClient();
    const { run } = branchRunner();
    await expect(
      runAttach(
        ctxWith(client),
        [...files("shot.png"), "--branch", "feature/🚀", "--repo", "o/r"],
        false,
        run,
      ),
    ).rejects.toThrow(UsageError);
  });
});

describe("runAttach gh.title metadata (issue #267)", () => {
  it("stamps gh.title when the resolved PR title is available", async () => {
    const { client, metadataByKey } = fakeClient();
    const { run } = ghRunner({ title: "Fix the login bug" });
    await runAttach(ctxWith(client), files("shot.png"), false, run);
    expect(metadataByKey["gh/buildinternet/uploads/pull/123/shot.png"]).toEqual({
      "gh.repo": "buildinternet/uploads",
      "gh.kind": "pull",
      "gh.number": "123",
      "gh.ref": "buildinternet/uploads#123",
      "gh.title": "Fix the login bug",
    });
  });

  it("omits gh.title (and does not fail the upload) when the title can't be resolved", async () => {
    const { client, puts, metadataByKey } = fakeClient();
    const { run } = ghRunner(); // no opts.title → gh title lookup throws
    expect(await runAttach(ctxWith(client), files("shot.png"), false, run)).toBe(0);
    expect(puts).toEqual(["gh/buildinternet/uploads/pull/123/shot.png"]);
    expect(metadataByKey["gh/buildinternet/uploads/pull/123/shot.png"]).toEqual({
      "gh.repo": "buildinternet/uploads",
      "gh.kind": "pull",
      "gh.number": "123",
      "gh.ref": "buildinternet/uploads#123",
    });
  });
});

/**
 * A `gh`/`git` runner that fully controls the current branch (`git rev-parse
 * --abbrev-ref HEAD`) as well as the usual PR-view/title-view stubs, so
 * promotion tests can assert on the exact branch name sent to the promote
 * endpoint. `branch: undefined` simulates detached HEAD ("HEAD").
 */
function promoteRunner(
  opts: { branch?: string | undefined; detached?: boolean; title?: string } = {},
): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const branch = opts.detached ? "HEAD" : (opts.branch ?? "feature-x");
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "rev-parse") return `${branch}\n`;
    if (args[0] === "repo") return "buildinternet/uploads\n";
    if ((args[0] === "pr" || args[0] === "issue") && args[1] === "view" && args.includes("title")) {
      if (opts.title !== undefined) return `${opts.title}\n`;
      throw new Error("gh: title not resolvable");
    }
    if (args[0] === "pr" && args[1] === "view") return "123\n";
    if (args[1]?.includes("per_page=100")) return "[]";
    return JSON.stringify({ id: 9 });
  };
  return { run, calls };
}

describe("runAttach auto-promote (default PR path)", () => {
  it("calls promoteBranchAttachments with the resolved repo/num/branch before the comment sync", async () => {
    const { client, promoteCalls, callOrder } = fakeClient({
      promote: async () => ({
        promoted: ["gh/buildinternet/uploads/pull/123/hero.png"],
        skipped: [],
      }),
    });
    const { run } = promoteRunner({ branch: "feature-x" });
    expect(await runAttach(ctxWith(client), files("shot.png"), false, run)).toBe(0);
    expect(promoteCalls).toEqual([
      { repo: "buildinternet/uploads", num: 123, branch: "feature-x" },
    ]);
    expect(callOrder.indexOf("promote")).toBeLessThan(callOrder.indexOf("comment-gather"));
  });

  it("never promotes for an --issue target", async () => {
    const { client, promoteCalls } = fakeClient({
      promote: async () => ({ promoted: [], skipped: [] }),
    });
    const { run } = promoteRunner();
    await runAttach(
      ctxWith(client),
      [...files("artifact.zip"), "--issue", "45", "--repo", "o/r"],
      false,
      run,
    );
    expect(promoteCalls).toEqual([]);
  });

  it("silently skips promotion when the endpoint 404s (older/self-hosted server)", async () => {
    const { client } = fakeClient({
      promote: async () => {
        throw new UploadsError("not found", "NOT_FOUND", 404);
      },
    });
    const { run } = promoteRunner();
    expect(await runAttach(ctxWith(client), files("shot.png"), false, run)).toBe(0);
  });

  it("silently skips promotion on a network error", async () => {
    const { client } = fakeClient({
      promote: async () => {
        throw new UploadsError("network request failed", "NETWORK");
      },
    });
    const { run } = promoteRunner();
    expect(await runAttach(ctxWith(client), files("shot.png"), false, run)).toBe(0);
  });

  it("silently skips promotion when the client has no promoteBranchAttachments method at all", async () => {
    const { client } = fakeClient(); // no `promote` opt → method absent
    const { run } = promoteRunner();
    expect(await runAttach(ctxWith(client), files("shot.png"), false, run)).toBe(0);
  });

  it("silently skips promotion on detached HEAD", async () => {
    const { client, promoteCalls } = fakeClient({
      promote: async () => ({ promoted: [], skipped: [] }),
    });
    // Explicit --pr so target resolution doesn't itself need the current
    // branch (resolveCurrentPullRequest also shells out to git rev-parse) —
    // isolates the assertion to auto-promote's own best-effort branch read.
    const { run } = promoteRunner({ detached: true });
    expect(
      await runAttach(
        ctxWith(client),
        [...files("shot.png"), "--pr", "123", "--repo", "buildinternet/uploads"],
        false,
        run,
      ),
    ).toBe(0);
    expect(promoteCalls).toEqual([]);
  });

  it("--no-promote skips the promote call entirely", async () => {
    const { client, promoteCalls } = fakeClient({
      promote: async () => ({ promoted: ["x"], skipped: [] }),
    });
    const { run } = promoteRunner();
    await runAttach(ctxWith(client), [...files("shot.png"), "--no-promote"], false, run);
    expect(promoteCalls).toEqual([]);
  });

  it("prints a human note only when something was actually promoted", async () => {
    const { client } = fakeClient({
      promote: async () => ({
        promoted: ["gh/buildinternet/uploads/pull/123/hero.png"],
        skipped: [],
      }),
    });
    const { run } = promoteRunner({ branch: "feature-x" });
    const ctx = { ...ctxWith(client), quiet: false };
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    try {
      await runAttach(ctx, files("shot.png"), false, run);
    } finally {
      vi.restoreAllMocks();
    }
    expect(stderr.join("")).toContain(">> promoted 1 staged attachment from branch feature-x\n");
  });

  it("stays quiet when promotion runs but promotes nothing", async () => {
    const { client } = fakeClient({
      promote: async () => ({ promoted: [], skipped: [] }),
    });
    const { run } = promoteRunner();
    const ctx = { ...ctxWith(client), quiet: false };
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    try {
      await runAttach(ctx, files("shot.png"), false, run);
    } finally {
      vi.restoreAllMocks();
    }
    expect(stderr.join("")).not.toContain("promoted");
  });

  it("includes a `promotion` field in JSON output", async () => {
    const { client } = fakeClient({
      promote: async () => ({
        promoted: ["gh/buildinternet/uploads/pull/123/hero.png"],
        skipped: [{ key: "gh/buildinternet/uploads/branch/feature-x/stale.png", reason: "stale" }],
      }),
    });
    const { run } = promoteRunner({ branch: "feature-x" });
    const ctx = { ...ctxWith(client), json: true };
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await runAttach(ctx, files("shot.png"), false, run);
    } finally {
      vi.restoreAllMocks();
    }
    const payload = JSON.parse(chunks.join("")) as {
      promotion: PromoteBranchAttachmentsResult | null;
    };
    expect(payload.promotion).toEqual({
      promoted: ["gh/buildinternet/uploads/pull/123/hero.png"],
      skipped: [{ key: "gh/buildinternet/uploads/branch/feature-x/stale.png", reason: "stale" }],
    });
  });

  it("JSON output has promotion: null when the endpoint is unavailable", async () => {
    const { client } = fakeClient({
      promote: async () => {
        throw new UploadsError("not found", "NOT_FOUND", 404);
      },
    });
    const { run } = promoteRunner();
    const ctx = { ...ctxWith(client), json: true };
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await runAttach(ctx, files("shot.png"), false, run);
    } finally {
      vi.restoreAllMocks();
    }
    const payload = JSON.parse(chunks.join("")) as { promotion: unknown };
    expect(payload.promotion).toBeNull();
  });
});

describe("runAttach --promote (explicit promote-only mode)", () => {
  it("promotes staged files with zero file arguments and refreshes the comment", async () => {
    const { client, promoteCalls, callOrder } = fakeClient({
      promote: async () => ({
        promoted: ["gh/buildinternet/uploads/pull/123/hero.png"],
        skipped: [],
      }),
    });
    const { run, calls } = promoteRunner({ branch: "feature-x" });
    expect(await runAttach(ctxWith(client), ["--promote"], false, run)).toBe(0);
    expect(promoteCalls).toEqual([
      { repo: "buildinternet/uploads", num: 123, branch: "feature-x" },
    ]);
    expect(callOrder.indexOf("promote")).toBeLessThan(callOrder.indexOf("comment-gather"));
    expect(
      calls.some((call) => call.includes("repos/buildinternet/uploads/issues/123/comments")),
    ).toBe(true);
  });

  it("exits 0 with empty promoted/skipped when nothing was staged", async () => {
    const { client, promoteCalls } = fakeClient({
      promote: async () => ({ promoted: [], skipped: [] }),
    });
    const { run } = promoteRunner();
    const ctx = { ...ctxWith(client), json: true };
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await runAttach(ctx, ["--promote"], false, run)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(promoteCalls).toHaveLength(1);
    const payload = JSON.parse(chunks.join("")) as {
      uploads: unknown[];
      failures: unknown[];
      promotion: PromoteBranchAttachmentsResult | null;
    };
    expect(payload.uploads).toEqual([]);
    expect(payload.failures).toEqual([]);
    expect(payload.promotion).toEqual({ promoted: [], skipped: [] });
  });

  it("supports an explicit --pr target", async () => {
    const { client, promoteCalls } = fakeClient({
      promote: async () => ({ promoted: [], skipped: [] }),
    });
    const { run } = promoteRunner({ branch: "feature-x" });
    await runAttach(ctxWith(client), ["--promote", "--pr", "77", "--repo", "o/r"], false, run);
    expect(promoteCalls).toEqual([{ repo: "o/r", num: 77, branch: "feature-x" }]);
  });

  it("still requires an inferable PR when no target is supplied", async () => {
    const { client } = fakeClient();
    await expect(
      runAttach(ctxWith(client), ["--promote"], false, noPullRequestRunner),
    ).rejects.toThrow(UsageError);
  });

  it("propagates a UsageError on detached HEAD (explicit action, not silently skipped)", async () => {
    const { client } = fakeClient();
    const { run } = promoteRunner({ detached: true });
    await expect(runAttach(ctxWith(client), ["--promote"], false, run)).rejects.toThrow(UsageError);
  });

  it("rejects --promote combined with files", async () => {
    const { client } = fakeClient();
    const { run } = promoteRunner();
    await expect(
      runAttach(ctxWith(client), [...files("shot.png"), "--promote"], false, run),
    ).rejects.toThrow(UsageError);
  });

  it.each([
    ["--branch", "feature/x"],
    ["--issue", "45"],
    ["--no-promote", undefined],
  ])("rejects --promote combined with %s", async (flag, value) => {
    const { client } = fakeClient();
    const { run } = promoteRunner();
    const extra = value !== undefined ? [flag, value] : [flag];
    await expect(runAttach(ctxWith(client), ["--promote", ...extra], false, run)).rejects.toThrow(
      UsageError,
    );
  });
});
