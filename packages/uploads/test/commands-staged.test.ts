import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type {
  FindFilesItem,
  GithubRepoLinkResult,
  ListItem,
  ResolveGhPrefixOptions,
  ResolveGhPrefixResult,
  UploadsClient,
} from "../src/client.js";
import {
  resolveStageBindingWarning,
  runAttach,
  runStaged,
  stagingBindingAdvisory,
  type CliContext,
} from "../src/commands.js";
import type { CommandRunner } from "../src/github-gh.js";

function ctxWith(client: UploadsClient, overrides: Partial<CliContext> = {}): CliContext {
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
    ...overrides,
  };
}

function fakeClient(opts?: {
  items?: ListItem[];
  /** Per-prefix item sets (issue #631 mixed plain+private listing tests) — wins over `items` when set. */
  itemsByPrefix?: Record<string, ListItem[]>;
  repoLinkStatus?: GithubRepoLinkResult | Error | ((repo: string) => GithubRepoLinkResult | Error);
  /**
   * `client.resolveGhPrefix` behavior (issue #631). Omitted → method absent,
   * simulating an older/self-hosted server without the route (404) —
   * degrades to plain, byte-identical to pre-#631 behavior.
   */
  resolveGhPrefix?:
    | ResolveGhPrefixResult
    | ((opts: ResolveGhPrefixOptions) => ResolveGhPrefixResult);
  /**
   * `client.findFilesAll` for the pull-copy check. Omitted → method absent
   * (older client double). An Error fails the lookup open.
   */
  findFilesAll?: { items: FindFilesItem[] } | Error;
}) {
  const listCalls: { prefix?: string; metadata?: boolean }[] = [];
  const findCalls: Record<string, string>[] = [];
  const client = {
    list: async (listOpts: { prefix?: string; metadata?: boolean }) => {
      listCalls.push(listOpts);
      const items = opts?.itemsByPrefix
        ? (opts.itemsByPrefix[listOpts.prefix ?? ""] ?? [])
        : (opts?.items ?? []);
      return { items, cursor: null };
    },
    ...(opts?.repoLinkStatus !== undefined
      ? {
          githubRepoLinkStatus: async (repo: string) => {
            const result =
              typeof opts.repoLinkStatus === "function"
                ? opts.repoLinkStatus(repo)
                : opts.repoLinkStatus!;
            if (result instanceof Error) throw result;
            return result;
          },
        }
      : {}),
    ...(opts?.resolveGhPrefix !== undefined
      ? {
          resolveGhPrefix: async (req: ResolveGhPrefixOptions) =>
            typeof opts.resolveGhPrefix === "function"
              ? opts.resolveGhPrefix(req)
              : opts.resolveGhPrefix!,
        }
      : {}),
    ...(opts?.findFilesAll !== undefined
      ? {
          findFilesAll: async (filters: Record<string, string>) => {
            findCalls.push(filters);
            if (opts.findFilesAll instanceof Error) throw opts.findFilesAll;
            return { ...opts.findFilesAll!, cursor: null };
          },
        }
      : {}),
  } as unknown as UploadsClient;
  return { client, listCalls, findCalls };
}

const branchRunner =
  (branch = "feature/thing"): CommandRunner =>
  (cmd, args) => {
    if (cmd === "git" && args[0] === "rev-parse") return `${branch}\n`;
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

async function withCapturedOutput(fn: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    await fn();
  } finally {
    vi.restoreAllMocks();
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("runStaged: branch/repo resolution", () => {
  it("uses --branch and --repo when given explicitly", async () => {
    const { client, listCalls } = fakeClient({ repoLinkStatus: { binding: "self" } });
    const code = await runStaged(
      ctxWith(client),
      ["--branch", "feature/thing", "--repo", "o/r"],
      false,
      noRun,
    );
    expect(code).toBe(0);
    expect(listCalls[0]).toEqual({ prefix: "gh/o/r/branch/feature-thing/", metadata: true });
  });

  it("defaults --branch to the current git branch (worktree-safe: git rev-parse)", async () => {
    const { client, listCalls } = fakeClient({ repoLinkStatus: { binding: "self" } });
    const run = branchRunner("main");
    const code = await runStaged(ctxWith(client), ["--repo", "o/r"], false, run);
    expect(code).toBe(0);
    expect(listCalls[0]?.prefix).toBe("gh/o/r/branch/main/");
  });

  it("resolves --repo via the runner when not given explicitly", async () => {
    const { client, listCalls } = fakeClient({ repoLinkStatus: { binding: "self" } });
    const run: CommandRunner = (cmd, args) => {
      if (cmd === "gh" && args[0] === "repo") return "buildinternet/uploads";
      if (cmd === "git" && args[0] === "rev-parse") return "feature/thing\n";
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    };
    const code = await runStaged(ctxWith(client), [], false, run);
    expect(code).toBe(0);
    expect(listCalls[0]?.prefix).toBe("gh/buildinternet/uploads/branch/feature-thing/");
  });

  it("throws UsageError when the current branch cannot be resolved (detached HEAD)", async () => {
    const { client } = fakeClient();
    const run: CommandRunner = (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse") return "HEAD\n";
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    };
    await expect(runStaged(ctxWith(client), ["--repo", "o/r"], false, run)).rejects.toThrow(
      UsageError,
    );
  });
});

describe("runStaged: empty staging", () => {
  it("human mode prints a clean one-line zero-state message", async () => {
    const { client } = fakeClient({ repoLinkStatus: { binding: "self" } });
    const { stdout } = await withCapturedOutput(async () => {
      const code = await runStaged(
        ctxWith(client),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
      expect(code).toBe(0);
    });
    expect(stdout).toBe("nothing staged for feature/thing in o/r\n");
  });

  it("json mode prints a valid, non-empty JSON document with an empty files array", async () => {
    const { client } = fakeClient({ repoLinkStatus: { binding: "self" } });
    const { stdout } = await withCapturedOutput(async () => {
      const code = await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
      expect(code).toBe(0);
    });
    expect(stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      repo: "o/r",
      branch: "feature/thing",
      files: [],
      binding: { state: "self", autoAttach: true, message: expect.any(String) },
    });
  });

  it("--format json (without global --json) also prints a valid JSON document", async () => {
    const { client } = fakeClient({ repoLinkStatus: { binding: "none" } });
    const { stdout } = await withCapturedOutput(async () => {
      const code = await runStaged(
        ctxWith(client),
        ["--branch", "feature/thing", "--repo", "o/r", "--format", "json"],
        false,
        noRun,
      );
      expect(code).toBe(0);
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.files).toEqual([]);
    expect(parsed.binding.state).toBe("none");
  });

  it("rejects an unrecognized --format", async () => {
    const { client } = fakeClient();
    await expect(
      runStaged(
        ctxWith(client),
        ["--branch", "feature/thing", "--repo", "o/r", "--format", "yaml"],
        false,
        noRun,
      ),
    ).rejects.toThrow(UsageError);
  });
});

describe("runStaged: promoted files", () => {
  it("omits files already promoted to a PR; keeps staged and status-less files", async () => {
    const base = "gh/o/r/branch/feature-thing/";
    const { client } = fakeClient({
      items: [
        { key: `${base}a.png`, url: null, metadata: { "gh.status": "promoted" } },
        { key: `${base}b.png`, url: null, metadata: { "gh.status": "staged" } },
        { key: `${base}c.png`, url: null, metadata: {} },
      ] as unknown as ListItem[],
      repoLinkStatus: { binding: "self" },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    expect(JSON.parse(stdout).files.map((f: { filename: string }) => f.filename)).toEqual([
      "b.png",
      "c.png",
    ]);
  });

  it("reports nothing staged when every file was promoted", async () => {
    const { client } = fakeClient({
      items: [
        {
          key: "gh/o/r/branch/feature-thing/a.png",
          url: null,
          metadata: { "gh.status": "promoted" },
        },
      ] as unknown as ListItem[],
      repoLinkStatus: { binding: "self" },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    expect(stdout).toBe("nothing staged for feature/thing in o/r\n");
  });
});

describe("runStaged: file listing", () => {
  it("maps list items to key/filename/size/stagedAt/url, stripping the staging prefix", async () => {
    const { client } = fakeClient({
      items: [
        {
          key: "gh/o/r/branch/feature-thing/shot.png",
          url: "https://x.test/gh/o/r/branch/feature-thing/shot.png",
          size: 2048,
          metadata: { "gh.staged-at": "2026-07-20T10:00:00Z", "gh.repo": "o/r" },
        },
      ],
      repoLinkStatus: { binding: "self" },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.files).toEqual([
      {
        key: "gh/o/r/branch/feature-thing/shot.png",
        filename: "shot.png",
        size: 2048,
        stagedAt: "2026-07-20T10:00:00Z",
        url: "https://x.test/gh/o/r/branch/feature-thing/shot.png",
      },
    ]);
  });

  it("carries state and path metadata so callers can pair befores with afters", async () => {
    const { client } = fakeClient({
      items: [
        {
          key: "gh/o/r/branch/feature-thing/home-after.png",
          url: null,
          metadata: { state: "after", path: "/settings" },
        },
        { key: "gh/o/r/branch/feature-thing/plain.png", url: null, metadata: {} },
      ],
      repoLinkStatus: { binding: "self" },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    const [paired, plain] = JSON.parse(stdout).files;
    expect(paired).toMatchObject({ state: "after", path: "/settings" });
    expect(plain).not.toHaveProperty("state");
    expect(plain).not.toHaveProperty("path");
  });

  it("marks a file held for review, and only a pending hold", async () => {
    const { client } = fakeClient({
      items: [
        {
          key: "gh/o/r/branch/feature-thing/env.png",
          url: null,
          metadata: { "ai.hold": "pending" },
        },
        {
          key: "gh/o/r/branch/feature-thing/ok.png",
          url: null,
          metadata: { "ai.hold": "approved" },
        },
      ],
      repoLinkStatus: { binding: "self" },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    const [held, approved] = JSON.parse(stdout).files;
    expect(held).toMatchObject({ filename: "env.png", held: true });
    expect(approved).not.toHaveProperty("held");
  });

  it("human mode prints one compact line per file plus binding + promote affordance", async () => {
    const { client } = fakeClient({
      items: [
        {
          key: "gh/o/r/branch/feature-thing/shot.png",
          url: "https://x.test/shot.png",
          size: 2048,
          metadata: { "gh.staged-at": "2026-07-20T10:00:00Z" },
        },
      ],
      repoLinkStatus: { binding: "self" },
    });
    const { stdout, stderr } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    expect(stdout).toContain("shot.png");
    expect(stdout).toContain("2 KB");
    expect(stdout).toContain("https://x.test/shot.png");
    expect(stderr).toContain("binding: self");
    expect(stderr).toContain("once the PR exists: uploads attach --promote");
  });

  it("human mode omits the promote affordance when the repo is bound to another workspace", async () => {
    const { client } = fakeClient({
      items: [
        {
          key: "gh/o/r/branch/feature-thing/shot.png",
          url: "https://x.test/shot.png",
          size: 2048,
          metadata: { "gh.staged-at": "2026-07-20T10:00:00Z" },
        },
      ],
      repoLinkStatus: { binding: "other" },
    });
    const { stderr } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    expect(stderr).toContain("binding: other");
    expect(stderr).not.toContain("uploads attach --promote");
  });
});

describe("runStaged private-prefix mode (issue #631)", () => {
  const PREFIX_ID = "0123456789abcdef0123456789abcdef";
  const PLAIN_PREFIX = "gh/o/r/branch/feature-thing/";
  const PRIVATE_PREFIX = `gh/private/${PREFIX_ID}/branch/`;

  it("lists files under both the plain and resolved private prefix (mixed history)", async () => {
    const { client, listCalls } = fakeClient({
      resolveGhPrefix: { mode: "private", prefixId: PREFIX_ID },
      itemsByPrefix: {
        [PLAIN_PREFIX]: [
          {
            key: `${PLAIN_PREFIX}old.png`,
            url: "https://x.test/old.png",
            size: 10,
            metadata: { "gh.staged-at": "2026-07-01T00:00:00Z" },
          },
        ],
        [PRIVATE_PREFIX]: [
          {
            key: `${PRIVATE_PREFIX}new.png`,
            url: "https://x.test/new.png",
            size: 20,
            metadata: { "gh.staged-at": "2026-08-01T00:00:00Z" },
          },
        ],
      },
    });
    const { stdout } = await withCapturedOutput(async () => {
      const result = await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
      expect(result).toBe(0);
    });
    expect(listCalls.map((c) => c.prefix).sort()).toEqual([PLAIN_PREFIX, PRIVATE_PREFIX].sort());
    const parsed = JSON.parse(stdout);
    // filename is derived per-prefix via key.slice(prefix.length) — the
    // private key's much longer prefix must not leak into the plain item's
    // filename, or vice versa.
    expect(parsed.files.map((f: { filename: string }) => f.filename).sort()).toEqual(
      ["old.png", "new.png"].sort(),
    );
  });

  it("lists only the plain prefix when the server has no resolve route (404, byte-identical to pre-#631)", async () => {
    const { client, listCalls } = fakeClient();
    await runStaged(ctxWith(client), ["--branch", "feature/thing", "--repo", "o/r"], false, noRun);
    expect(listCalls).toEqual([{ prefix: PLAIN_PREFIX, metadata: true }]);
  });

  it("does not list another branch's private prefix when activePrefixIds is repo-wide (#1122)", async () => {
    const OTHER_PREFIX_ID = "fedcba9876543210fedcba9876543210".slice(0, 32);
    const OTHER_PRIVATE_PREFIX = `gh/private/${OTHER_PREFIX_ID}/branch/`;
    const { client, listCalls } = fakeClient({
      resolveGhPrefix: {
        mode: "private",
        prefixId: PREFIX_ID,
        // An older worker: every active id in the repo, including another branch.
        activePrefixIds: [PREFIX_ID, OTHER_PREFIX_ID],
      },
      itemsByPrefix: {
        [PLAIN_PREFIX]: [],
        [PRIVATE_PREFIX]: [
          { key: `${PRIVATE_PREFIX}current.png`, url: "https://x.test/current.png" },
        ],
        [OTHER_PRIVATE_PREFIX]: [
          { key: `${OTHER_PRIVATE_PREFIX}leak.png`, url: "https://x.test/leak.png" },
        ],
      },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    expect(listCalls.map((c) => c.prefix).sort()).toEqual([PLAIN_PREFIX, PRIVATE_PREFIX].sort());
    const parsed = JSON.parse(stdout);
    expect(parsed.files.map((f: { filename: string }) => f.filename)).toEqual(["current.png"]);
  });

  it("lists a retired id the server scoped to this branch, and not another branch's id", async () => {
    const OTHER_PREFIX_ID = "fedcba9876543210fedcba9876543210";
    const RETIRED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const RETIRED_PREFIX = `gh/private/${RETIRED_ID}/branch/`;
    const { client, listCalls } = fakeClient({
      resolveGhPrefix: {
        mode: "private",
        prefixId: PREFIX_ID,
        activePrefixIds: [PREFIX_ID, OTHER_PREFIX_ID],
        branchPrefixIds: [PREFIX_ID, RETIRED_ID],
      },
      itemsByPrefix: {
        [RETIRED_PREFIX]: [
          {
            key: `${RETIRED_PREFIX}old.png`,
            url: "https://x.test/old.png",
            metadata: { "gh.branch": "feature/thing", "gh.status": "staged" },
          },
        ],
        [`gh/private/${OTHER_PREFIX_ID}/branch/`]: [
          { key: `gh/private/${OTHER_PREFIX_ID}/branch/leak.png`, url: "https://x.test/leak.png" },
        ],
      },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    expect(listCalls.map((c) => c.prefix).sort()).toEqual(
      [PLAIN_PREFIX, PRIVATE_PREFIX, RETIRED_PREFIX].sort(),
    );
    expect(JSON.parse(stdout).files.map((f: { filename: string }) => f.filename)).toEqual([
      "old.png",
    ]);
  });
});

function stagedItem(prefix: string, name: string, metadata: Record<string, string>): ListItem {
  return { key: `${prefix}${name}`, url: `https://x.test/${name}`, metadata };
}

describe("runStaged keeps one branch's still-staged files (#1122)", () => {
  const PREFIX_ID = "0123456789abcdef0123456789abcdef";
  const PRIVATE_PREFIX = `gh/private/${PREFIX_ID}/branch/`;

  it("on a private repo, drops another branch, a promoted file, and a pull twin", async () => {
    const { client, findCalls } = fakeClient({
      resolveGhPrefix: {
        mode: "private",
        prefixId: PREFIX_ID,
        branchPrefixIds: [PREFIX_ID],
      },
      itemsByPrefix: {
        [PRIVATE_PREFIX]: [
          stagedItem(PRIVATE_PREFIX, "keep.png", {
            "gh.branch": "feature/thing",
            "gh.status": "staged",
            "gh.staged-at": "2026-10-02T00:00:00.000Z",
          }),
          stagedItem(PRIVATE_PREFIX, "other.png", {
            "gh.branch": "refactor/room-stage-top-bar",
            "gh.status": "staged",
          }),
          stagedItem(PRIVATE_PREFIX, "done.png", {
            "gh.branch": "feature/thing",
            "gh.status": "promoted",
          }),
          stagedItem(PRIVATE_PREFIX, "marked.png", {
            "gh.branch": "feature/thing",
            "gh.status": "staged",
            "gh.promoted-to": "o/r#9",
          }),
          stagedItem(PRIVATE_PREFIX, "twin.png", {
            "gh.branch": "feature/thing",
            "gh.status": "staged",
            "gh.staged-at": "2026-10-01T00:00:00.000Z",
          }),
        ],
      },
      findFilesAll: {
        items: [
          {
            key: "gh/private/pull-id/pull/9/twin.png",
            url: "https://x.test/twin.png",
            metadata: {
              "gh.kind": "pull",
              "gh.branch": "feature/thing",
              "gh.promoted-at": "2026-10-01T12:00:00.000Z",
            },
          },
        ],
      },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "O/R"],
        false,
        noRun,
      );
    });
    expect(findCalls).toEqual([
      { "gh.repo": "o/r", "gh.branch": "feature/thing", "gh.kind": "pull" },
    ]);
    const files = JSON.parse(stdout).files;
    expect(files.map((f: { filename: string }) => f.filename)).toEqual(["keep.png"]);
    expect(files[0].branch).toBe("feature/thing");
  });

  it("keeps a re-stage whose staged-at is newer than the pull copy", async () => {
    const plain = "gh/o/r/branch/feature-thing/";
    const { client } = fakeClient({
      items: [
        stagedItem(plain, "shot.png", {
          "gh.branch": "feature/thing",
          "gh.status": "staged",
          "gh.staged-at": "2026-10-03T00:00:00.000Z",
        }),
      ],
      findFilesAll: {
        items: [
          {
            key: "gh/o/r/pull/4/shot.png",
            url: null,
            metadata: { "gh.attached-at": "2026-10-01T00:00:00.000Z" },
          },
        ],
      },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    expect(JSON.parse(stdout).files.map((f: { filename: string }) => f.filename)).toEqual([
      "shot.png",
    ]);
  });

  it("does not hide a file when the pull copy has no timestamp, or when the lookup throws", async () => {
    const plain = "gh/o/r/branch/feature-thing/";
    const untimed = fakeClient({
      items: [
        stagedItem(plain, "shot.png", {
          "gh.branch": "feature/thing",
          "gh.status": "staged",
          "gh.staged-at": "2026-10-01T00:00:00.000Z",
        }),
      ],
      findFilesAll: {
        items: [{ key: "gh/o/r/pull/4/shot.png", url: null, metadata: {} }],
      },
    });
    const failed = fakeClient({
      items: [
        stagedItem(plain, "shot.png", {
          "gh.branch": "feature/thing",
          "gh.status": "staged",
        }),
      ],
      findFilesAll: new Error("search down"),
    });
    for (const { client } of [untimed, failed]) {
      const { stdout } = await withCapturedOutput(async () => {
        await runStaged(
          ctxWith(client, { json: true }),
          ["--branch", "feature/thing", "--repo", "o/r"],
          false,
          noRun,
        );
      });
      expect(JSON.parse(stdout).files.map((f: { filename: string }) => f.filename)).toEqual([
        "shot.png",
      ]);
    }
  });

  it("on a public repo, drops a mismatched gh.branch and keeps a file with none", async () => {
    const plain = "gh/o/r/branch/feature-thing/";
    const { client, listCalls } = fakeClient({
      itemsByPrefix: {
        [plain]: [
          stagedItem(plain, "keep.png", { "gh.branch": "Feature/Thing", "gh.status": "staged" }),
          stagedItem(plain, "other.png", {
            "gh.branch": "no-such-branch-xyz",
            "gh.status": "staged",
          }),
          stagedItem(plain, "legacy.png", { "gh.staged-at": "2026-07-01T00:00:00Z" }),
          stagedItem(plain, "copied.png", {
            "gh.branch": "feature/thing",
            "gh.promoted-at": "2026-10-01T00:00:00.000Z",
          }),
        ],
      },
    });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    expect(listCalls.map((c) => c.prefix)).toEqual([plain]);
    const files = JSON.parse(stdout).files;
    expect(files.map((f: { filename: string }) => f.filename)).toEqual(["keep.png", "legacy.png"]);
    expect(files[0].branch).toBe("Feature/Thing");
    expect(files[1].branch).toBeUndefined();
  });
});

describe("runStaged: binding states", () => {
  it("binding self: autoAttach true, own message", async () => {
    const { client } = fakeClient({ repoLinkStatus: { binding: "self" } });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    const { binding } = JSON.parse(stdout);
    expect(binding).toEqual({
      state: "self",
      autoAttach: true,
      message: "these auto-attach when this branch's PR opens",
    });
  });

  it("binding none: autoAttach false, wording matches the #398 stage warning verbatim", async () => {
    const { client } = fakeClient({ repoLinkStatus: { binding: "none" } });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    const { binding } = JSON.parse(stdout);
    expect(binding.state).toBe("none");
    expect(binding.autoAttach).toBe(false);
    expect(binding.message).toBe(stagingBindingAdvisory("none", "o/r"));
  });

  it("binding other: autoAttach false, wording matches the #398 stage warning verbatim", async () => {
    const { client } = fakeClient({ repoLinkStatus: { binding: "other" } });
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    const { binding } = JSON.parse(stdout);
    expect(binding.state).toBe("other");
    expect(binding.autoAttach).toBe(false);
    expect(binding.message).toBe(stagingBindingAdvisory("other", "o/r"));
  });

  it("binding unknown on lookup failure (network error) — never throws", async () => {
    const { client } = fakeClient({ repoLinkStatus: new Error("network down") });
    const { stdout } = await withCapturedOutput(async () => {
      const code = await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
      expect(code).toBe(0);
    });
    const { binding } = JSON.parse(stdout);
    expect(binding.state).toBe("unknown");
    expect(binding.autoAttach).toBe(false);
  });

  it("binding unknown when the endpoint route is absent (older/self-hosted server)", async () => {
    const { client } = fakeClient(); // no repoLinkStatus option -> method absent
    const { stdout } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(client, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    const { binding } = JSON.parse(stdout);
    expect(binding.state).toBe("unknown");
  });
});

describe("wording reuse between `staged` and the #398 attach --branch stage warning", () => {
  it("shares the exact none/other advisory text via stagingBindingAdvisory", async () => {
    for (const binding of ["none", "other"] as const) {
      const stageWarning = await resolveStageBindingWarning({
        ctx: ctxWith(fakeClient({ repoLinkStatus: { binding } }).client, { quiet: false }),
        defaults: {} as never,
        repo: "o/r",
      });
      const advisory = stagingBindingAdvisory(binding, "o/r");
      expect(advisory).toBeDefined();
      expect(stageWarning).toBe(`note: ${advisory}`);

      const { client } = fakeClient({ repoLinkStatus: { binding } });
      const { stdout } = await withCapturedOutput(async () => {
        await runStaged(
          ctxWith(client, { json: true }),
          ["--branch", "feature/thing", "--repo", "o/r"],
          false,
          noRun,
        );
      });
      const { binding: stagedBinding } = JSON.parse(stdout);
      expect(stagedBinding.message).toBe(advisory);
    }
  });

  it("runAttach --branch's stderr warning is a strict superset (note: + advisory) of what `staged` shows", async () => {
    // Same fakeClient shape as commands-attach.test.ts's minimal put stub.
    const puts: string[] = [];
    const attachClient = {
      put: async (_body: Uint8Array, putOpts: { key: string }) => {
        puts.push(putOpts.key);
        return {
          workspace: "test",
          key: putOpts.key,
          url: `https://x.test/${putOpts.key}`,
          embedUrl: null,
          size: 3,
          contentType: "image/png",
        };
      },
      list: async () => ({ items: [], cursor: null }),
      listAll: async () => [],
      findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
      getGallery: async () => ({ items: [] }),
      githubRepoLinkStatus: async () => ({ binding: "none" }) as GithubRepoLinkResult,
    } as unknown as UploadsClient;

    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "uploads-staged-wording-test-"));
    const file = join(dir, "shot.png");
    writeFileSync(file, "shot.png");

    const { stderr: attachStderr } = await withCapturedOutput(async () => {
      await runAttach(
        ctxWith(attachClient, { quiet: false }),
        [file, "--branch", "feature/thing", "--repo", "o/r"],
        false,
        branchRunner(),
      );
    });

    const advisory = stagingBindingAdvisory("none", "o/r");
    expect(advisory).toBeDefined();
    expect(attachStderr).toContain(advisory!);

    const { client: stagedClient } = fakeClient({ repoLinkStatus: { binding: "none" } });
    const { stdout: stagedJson } = await withCapturedOutput(async () => {
      await runStaged(
        ctxWith(stagedClient, { json: true }),
        ["--branch", "feature/thing", "--repo", "o/r"],
        false,
        noRun,
      );
    });
    expect(JSON.parse(stagedJson).binding.message).toBe(advisory);
  });
});
