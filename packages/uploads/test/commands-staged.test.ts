import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type {
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
}) {
  const listCalls: { prefix?: string; metadata?: boolean }[] = [];
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
  } as unknown as UploadsClient;
  return { client, listCalls };
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

  it("lists every active private prefix, not just the currently-resolved one (mirrors the comment gather)", async () => {
    const OTHER_PREFIX_ID = "fedcba9876543210fedcba9876543210".slice(0, 32);
    const OTHER_PRIVATE_PREFIX = `gh/private/${OTHER_PREFIX_ID}/branch/`;
    const { client, listCalls } = fakeClient({
      resolveGhPrefix: {
        mode: "private",
        prefixId: PREFIX_ID,
        activePrefixIds: [PREFIX_ID, OTHER_PREFIX_ID],
      },
      itemsByPrefix: {
        [PLAIN_PREFIX]: [],
        [PRIVATE_PREFIX]: [
          { key: `${PRIVATE_PREFIX}current.png`, url: "https://x.test/current.png" },
        ],
        [OTHER_PRIVATE_PREFIX]: [
          { key: `${OTHER_PRIVATE_PREFIX}rotated.png`, url: "https://x.test/rotated.png" },
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
      [PLAIN_PREFIX, PRIVATE_PREFIX, OTHER_PRIVATE_PREFIX].sort(),
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.files.map((f: { filename: string }) => f.filename).sort()).toEqual(
      ["current.png", "rotated.png"].sort(),
    );
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
