import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
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
}) {
  const puts: string[] = [];
  const metadataByKey: Record<string, Record<string, string> | undefined> = {};
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
    listAll: async (listOpts: { prefix?: string } = {}) => (await list(listOpts)).items,
    findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
    getGallery: async () => ({ items: [] }),
  } as unknown as UploadsClient;
  return { client, puts, metadataByKey };
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
