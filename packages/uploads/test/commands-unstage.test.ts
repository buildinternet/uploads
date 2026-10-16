import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { ListItem, ResolveGhPrefixResult, UploadsClient } from "../src/client.js";
import {
  deleteAndRefreshComment,
  runStaged,
  runUnstage,
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
    json: true,
    quiet: true,
    ...overrides,
  };
}

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

const returnsBranch: CommandRunner = () => "feature/thing\n";

function fakeClient(opts?: {
  itemsByPrefix?: Record<string, ListItem[]>;
  pagesByPrefix?: Record<string, { items: ListItem[]; cursor: string | null }[]>;
  metadata?: Record<string, Record<string, string>>;
  resolveGhPrefix?: ResolveGhPrefixResult;
}) {
  const patches: { key: string; set?: Record<string, string> }[] = [];
  const listCalls: { prefix?: string; cursor?: string }[] = [];
  const metadata: Record<string, Record<string, string>> = {};
  if (opts?.metadata) Object.assign(metadata, opts.metadata);
  const pageIndex = new Map<string, number>();
  const client = {
    list: async (listOpts: { prefix?: string; cursor?: string; metadata?: boolean }) => {
      listCalls.push({ prefix: listOpts.prefix, cursor: listOpts.cursor });
      const prefix = listOpts.prefix ?? "";
      const pages = opts?.pagesByPrefix?.[prefix];
      if (pages) {
        const index = pageIndex.get(prefix) ?? 0;
        pageIndex.set(prefix, index + 1);
        return pages[Math.min(index, pages.length - 1)] ?? { items: [], cursor: null };
      }
      return { items: opts?.itemsByPrefix?.[prefix] ?? [], cursor: null };
    },
    getMetadata: async (key: string) => ({ metadata: metadata[key] ?? {} }),
    patchMetadata: async (key: string, body: { set?: Record<string, string> }) => {
      patches.push({ key, set: body.set });
      const next = metadata[key] ?? {};
      if (body.set) Object.assign(next, body.set);
      metadata[key] = next;
      return { metadata: next };
    },
    ...(opts?.resolveGhPrefix ? { resolveGhPrefix: async () => opts.resolveGhPrefix } : {}),
  } as unknown as UploadsClient;
  return { client, patches, listCalls };
}

async function jsonOf(fn: () => Promise<number>): Promise<unknown> {
  const stdout: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    const code = await fn();
    expect(code).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
  return JSON.parse(stdout.join(""));
}

const PREFIX = "gh/o/r/branch/feature-thing/";
const PRIVATE_ID = "ab".repeat(16);
const PRIVATE_PREFIX = `gh/private/${PRIVATE_ID}/branch/`;

describe("runUnstage", () => {
  it("unstages everything still staged for the branch", async () => {
    const keep = `${PREFIX}keep.png`;
    const done = `${PREFIX}done.png`;
    const { client, patches } = fakeClient({
      itemsByPrefix: {
        [PREFIX]: [
          {
            key: keep,
            url: "https://cdn/keep.png",
            metadata: { "gh.branch": "feature/thing", "gh.status": "staged" },
          },
          { key: done, url: "https://cdn/done.png", metadata: { "gh.status": "promoted" } },
          {
            key: `${PREFIX}other.png`,
            url: null,
            metadata: { "gh.branch": "other", "gh.status": "staged" },
          },
        ],
      },
    });
    const body = (await jsonOf(() =>
      runUnstage(ctxWith(client), ["--branch", "feature/thing", "--repo", "o/r"], false, noRun),
    )) as { files: { key: string; action: string }[] };
    expect(body.files).toEqual([{ key: keep, url: "https://cdn/keep.png", action: "unstaged" }]);
    expect(patches).toEqual([{ key: keep, set: { "gh.status": "unstaged" } }]);
  });

  it("dry-run reports the branch and does not patch", async () => {
    const keep = `${PREFIX}keep.png`;
    const { client, patches } = fakeClient({
      itemsByPrefix: {
        [PREFIX]: [{ key: keep, url: "https://cdn/keep.png", metadata: { "gh.status": "staged" } }],
      },
    });
    const body = (await jsonOf(() =>
      runUnstage(
        ctxWith(client),
        ["--branch", "feature/thing", "--repo", "o/r", "--dry-run"],
        false,
        noRun,
      ),
    )) as { dryRun: boolean; files: { action: string }[] };
    expect(body.dryRun).toBe(true);
    expect(body.files).toEqual([{ key: keep, url: "https://cdn/keep.png", action: "unstaged" }]);
    expect(patches).toEqual([]);
  });

  it("unstages named keys and leaves an already-unstaged key unchanged", async () => {
    const one = `${PREFIX}one.png`;
    const two = `${PREFIX}two.png`;
    const { client, patches } = fakeClient({
      metadata: {
        [one]: { "gh.status": "staged" },
        [two]: { "gh.status": "unstaged" },
      },
    });
    const body = (await jsonOf(() => runUnstage(ctxWith(client), [one, two], false, noRun))) as {
      files: { key: string; action: string; url: string | null }[];
    };
    expect(body.files).toEqual([
      { key: one, url: null, action: "unstaged" },
      { key: two, url: null, action: "unchanged" },
    ]);
    expect(patches).toEqual([{ key: one, set: { "gh.status": "unstaged" } }]);
  });

  it("lists this branch's private prefix ids and skips a different gh.branch", async () => {
    const mine = `${PRIVATE_PREFIX}shot.png`;
    const other = `${PRIVATE_PREFIX}other.png`;
    const { client, patches, listCalls } = fakeClient({
      resolveGhPrefix: {
        mode: "private",
        prefixId: PRIVATE_ID,
        activePrefixIds: [PRIVATE_ID, "cd".repeat(16)],
        branchPrefixIds: [PRIVATE_ID],
      },
      itemsByPrefix: {
        [PREFIX]: [],
        [PRIVATE_PREFIX]: [
          {
            key: mine,
            url: "https://cdn/shot.png",
            metadata: { "gh.branch": "feature/thing", "gh.status": "staged" },
          },
          {
            key: other,
            url: "https://cdn/other.png",
            metadata: { "gh.branch": "elsewhere", "gh.status": "staged" },
          },
        ],
      },
    });
    const body = (await jsonOf(() =>
      runUnstage(ctxWith(client), ["--branch", "feature/thing", "--repo", "o/r"], false, noRun),
    )) as { files: { key: string }[] };
    expect(listCalls.map((call) => call.prefix)).toEqual([PREFIX, PRIVATE_PREFIX]);
    expect(body.files.map((file) => file.key)).toEqual([mine]);
    expect(patches.map((patch) => patch.key)).toEqual([mine]);
  });

  it("follows a list cursor and flags a truncated prefix", async () => {
    const first = `${PREFIX}a.png`;
    const second = `${PREFIX}b.png`;
    const { client, listCalls } = fakeClient({
      pagesByPrefix: {
        [PREFIX]: [
          {
            items: [{ key: first, url: null, metadata: { "gh.status": "staged" } }],
            cursor: "next",
          },
          {
            items: [{ key: second, url: null, metadata: { "gh.status": "staged" } }],
            cursor: "more",
          },
          ...Array.from({ length: 20 }, () => ({
            items: [] as ListItem[],
            cursor: "more",
          })),
        ],
      },
    });
    const body = (await jsonOf(() =>
      runUnstage(ctxWith(client), ["--branch", "feature/thing", "--repo", "o/r"], false, noRun),
    )) as { truncated?: boolean; files: { key: string }[] };
    expect(listCalls.filter((call) => call.prefix === PREFIX)).toHaveLength(20);
    expect(body.truncated).toBe(true);
    expect(body.files.map((file) => file.key)).toEqual([first, second]);
  });

  it("refuses keys together with --branch, and --repo without --branch", async () => {
    const { client } = fakeClient();
    await expect(
      runUnstage(ctxWith(client), ["--branch", "feature/thing", "gh/o/r/x.png"], false, noRun),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runUnstage(ctxWith(client), ["--repo", "o/r", "gh/o/r/x.png"], false, noRun),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(runUnstage(ctxWith(client), [], false, noRun)).rejects.toBeInstanceOf(UsageError);
  });

  it("does not default --branch to the current git branch", async () => {
    const { client } = fakeClient();
    await expect(
      runUnstage(ctxWith(client), ["--repo", "o/r"], false, returnsBranch),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe("runStaged omits unstaged files", () => {
  it("drops gh.status=unstaged from the branch view", async () => {
    const { client } = fakeClient({
      itemsByPrefix: {
        [PREFIX]: [
          {
            key: `${PREFIX}live.png`,
            url: "https://cdn/live.png",
            metadata: { "gh.status": "staged" },
          },
          {
            key: `${PREFIX}gone.png`,
            url: "https://cdn/gone.png",
            metadata: { "gh.status": "unstaged" },
          },
        ],
      },
    });
    const body = (await jsonOf(() =>
      runStaged(
        ctxWith(client),
        ["--branch", "feature/thing", "--repo", "o/r", "--format", "json"],
        false,
        noRun,
      ),
    )) as { files: { filename: string }[] };
    expect(body.files.map((file) => file.filename)).toEqual(["live.png"]);
  });
});

describe("deleteAndRefreshComment", () => {
  it("returns the delete result alone for a non-attachment key", async () => {
    const client = {
      delete: async (key: string) => ({ key, deleted: true }),
      getMetadata: async () => {
        throw new Error("metadata should not be read");
      },
    } as unknown as UploadsClient;
    await expect(deleteAndRefreshComment(client, "a/b.png")).resolves.toEqual({
      key: "a/b.png",
      deleted: true,
    });
  });

  it("reads a private attachment's repo before deleting, then keeps the comment hint", async () => {
    const order: string[] = [];
    const client = {
      getMetadata: async () => {
        order.push("meta");
        return { metadata: { "gh.repo": "acme/web" } };
      },
      delete: async (key: string) => {
        order.push("delete");
        return { key, deleted: true };
      },
      upsertGithubComment: async () => {
        order.push("comment");
        return { posted: false, reason: "not_installed" };
      },
    } as unknown as UploadsClient;
    const key = `gh/private/${"ab".repeat(16)}/pull/9/shot.png`;
    await expect(deleteAndRefreshComment(client, key)).resolves.toEqual({
      key,
      deleted: true,
      commentRefreshed: false,
      commentHint: "uploads comment --pr 9",
    });
    expect(order).toEqual(["meta", "delete", "comment"]);
  });

  it("reports a refreshed comment when the bot posts", async () => {
    const client = {
      delete: async (key: string) => ({ key, deleted: true }),
      upsertGithubComment: async () => ({ posted: true, action: "updated", count: 0 }),
    } as unknown as UploadsClient;
    await expect(deleteAndRefreshComment(client, "gh/acme/web/issues/4/log.txt")).resolves.toEqual({
      key: "gh/acme/web/issues/4/log.txt",
      deleted: true,
      commentRefreshed: true,
    });
  });
});
