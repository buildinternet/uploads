import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runMeta, type CliContext } from "../src/commands.js";

function fakeClient() {
  const getCalls: string[] = [];
  const patchCalls: { key: string; set?: Record<string, string>; delete?: string[] }[] = [];
  let keysCalled = 0;
  const valuesCalls: string[] = [];
  const client = {
    getMetadata: async (key: string) => {
      getCalls.push(key);
      return { metadata: { app: "myapp" } };
    },
    patchMetadata: async (
      key: string,
      opts: { set?: Record<string, string>; delete?: string[] },
    ) => {
      patchCalls.push({ key, ...opts });
      return { metadata: { ...opts.set } };
    },
    listMetadataKeys: async () => {
      keysCalled += 1;
      return {
        keys: [
          { key: "gh.repo", count: 2, distinctValues: 1 },
          { key: "app", count: 1, distinctValues: 1 },
        ],
        truncated: false,
      };
    },
    listMetadataValues: async (key: string) => {
      valuesCalls.push(key);
      return {
        key,
        values: [
          { value: "web", count: 2 },
          { value: "api", count: 1 },
        ],
        truncated: false,
      };
    },
  } as unknown as UploadsClient;
  return {
    client,
    getCalls,
    patchCalls,
    keysCalled: () => keysCalled,
    valuesCalls,
  };
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

describe("runMeta get", () => {
  it("fetches metadata for a key", async () => {
    const { client, getCalls } = fakeClient();
    const code = await runMeta(ctxWith(client), ["get", "screenshots/a.png"], false);
    expect(code).toBe(0);
    expect(getCalls).toEqual(["screenshots/a.png"]);
  });

  it("requires a key", async () => {
    const { client } = fakeClient();
    await expect(runMeta(ctxWith(client), ["get"], false)).rejects.toThrow(UsageError);
  });

  it("notes an empty result on stderr instead of printing nothing", async () => {
    const client = {
      getMetadata: async () => ({ metadata: {} }),
    } as unknown as UploadsClient;
    const ctx = { ...ctxWith(client), quiet: false };
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
      expect(await runMeta(ctx, ["get", "screenshots/a.png"], false)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toBe("(no metadata)\n");
  });
});

describe("runMeta set", () => {
  it("sends k=v pairs as `set`", async () => {
    const { client, patchCalls } = fakeClient();
    const code = await runMeta(
      ctxWith(client),
      ["set", "screenshots/a.png", "app=myapp", "page=settings"],
      false,
    );
    expect(code).toBe(0);
    expect(patchCalls[0]).toEqual({
      key: "screenshots/a.png",
      set: { app: "myapp", page: "settings" },
      delete: undefined,
    });
  });

  it("sends repeated --delete flags as a `delete` array", async () => {
    const { client, patchCalls } = fakeClient();
    await runMeta(
      ctxWith(client),
      ["set", "screenshots/a.png", "--delete", "app", "--delete", "page"],
      false,
    );
    expect(patchCalls[0]).toEqual({
      key: "screenshots/a.png",
      set: undefined,
      delete: ["app", "page"],
    });
  });

  it("combines set pairs and --delete in one call", async () => {
    const { client, patchCalls } = fakeClient();
    await runMeta(
      ctxWith(client),
      ["set", "screenshots/a.png", "app=myapp", "--delete", "page"],
      false,
    );
    expect(patchCalls[0]).toEqual({
      key: "screenshots/a.png",
      set: { app: "myapp" },
      delete: ["page"],
    });
  });

  it("accepts --meta k=v, the spelling put/list use (#545)", async () => {
    const { client, patchCalls } = fakeClient();
    const code = await runMeta(
      ctxWith(client),
      ["set", "screenshots/a.png", "--meta", "path=/settings", "--meta", "state=after"],
      false,
    );
    expect(code).toBe(0);
    expect(patchCalls[0]).toEqual({
      key: "screenshots/a.png",
      set: { path: "/settings", state: "after" },
      delete: undefined,
    });
  });

  it("merges positional pairs with --meta pairs", async () => {
    const { client, patchCalls } = fakeClient();
    await runMeta(
      ctxWith(client),
      ["set", "screenshots/a.png", "app=myapp", "--meta", "path=/settings"],
      false,
    );
    expect(patchCalls[0]).toEqual({
      key: "screenshots/a.png",
      set: { app: "myapp", path: "/settings" },
      delete: undefined,
    });
  });

  it("requires a key", async () => {
    const { client } = fakeClient();
    await expect(runMeta(ctxWith(client), ["set"], false)).rejects.toThrow(UsageError);
  });

  it("requires at least one k=v pair or --delete", async () => {
    const { client } = fakeClient();
    await expect(runMeta(ctxWith(client), ["set", "screenshots/a.png"], false)).rejects.toThrow(
      UsageError,
    );
  });

  it("rejects a malformed k=v pair", async () => {
    const { client } = fakeClient();
    await expect(
      runMeta(ctxWith(client), ["set", "screenshots/a.png", "nokeyvalue"], false),
    ).rejects.toThrow(UsageError);
  });
});

describe("runMeta keys / values (issue #528)", () => {
  it("lists workspace metadata keys", async () => {
    const { client, keysCalled } = fakeClient();
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await runMeta(ctxWith(client), ["keys"], false)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(keysCalled()).toBe(1);
    expect(stdout.join("")).toBe("gh.repo  count=2  distinct=1\napp  count=1  distinct=1\n");
  });

  it("lists values for one metadata key", async () => {
    const { client, valuesCalls } = fakeClient();
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await runMeta(ctxWith(client), ["values", "app"], false)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(valuesCalls).toEqual(["app"]);
    expect(stdout.join("")).toBe("web  count=2\napi  count=1\n");
  });

  it("requires a key for values", async () => {
    const { client } = fakeClient();
    await expect(runMeta(ctxWith(client), ["values"], false)).rejects.toThrow(UsageError);
  });
});

describe("runMeta set comment re-sync (issue #470)", () => {
  function syncClient(opts: { fail?: boolean } = {}) {
    const upsertCalls: { repo: string; num: number; kind: string }[] = [];
    const client = {
      patchMetadata: async (_key: string, o: { set?: Record<string, string> }) => ({
        metadata: { ...o.set },
      }),
      upsertGithubComment: async (o: { repo: string; num: number; kind: string }) => {
        upsertCalls.push(o);
        if (opts.fail) throw new Error("endpoint unreachable");
        return { posted: true, action: "updated", count: 1 };
      },
    } as unknown as UploadsClient;
    return { client, upsertCalls };
  }

  it("re-syncs the managed comment when path/state changes on a gh-keyed object", async () => {
    const { client, upsertCalls } = syncClient();
    const code = await runMeta(
      ctxWith(client),
      ["set", "gh/acme/web/pull/12/shot.png", "path=/docs/limits"],
      false,
    );
    expect(code).toBe(0);
    expect(upsertCalls).toEqual([{ repo: "acme/web", num: 12, kind: "pull", resync: true }]);
  });

  it("re-syncs when a display-relevant key is deleted", async () => {
    const { client, upsertCalls } = syncClient();
    await runMeta(
      ctxWith(client),
      ["set", "gh/acme/web/issues/7/shot.png", "--delete", "state"],
      false,
    );
    expect(upsertCalls).toEqual([{ repo: "acme/web", num: 7, kind: "issues", resync: true }]);
  });

  it("does not sync when the touched keys are not rendered in the comment", async () => {
    const { client, upsertCalls } = syncClient();
    await runMeta(ctxWith(client), ["set", "gh/acme/web/pull/12/shot.png", "app=myapp"], false);
    expect(upsertCalls).toEqual([]);
  });

  it("does not sync for a non-gh key", async () => {
    const { client, upsertCalls } = syncClient();
    await runMeta(ctxWith(client), ["set", "screenshots/a.png", "path=/settings"], false);
    expect(upsertCalls).toEqual([]);
  });

  it("re-syncs a private-prefix key (issue #631) by recovering the repo from gh.repo metadata", async () => {
    const PREFIX_ID = "0123456789abcdef0123456789abcdef";
    const upsertCalls: { repo: string; num: number; kind: string }[] = [];
    const getMetadataCalls: string[] = [];
    const client = {
      patchMetadata: async (_key: string, o: { set?: Record<string, string> }) => ({
        metadata: { ...o.set },
      }),
      getMetadata: async (key: string) => {
        getMetadataCalls.push(key);
        return { metadata: { "gh.repo": "acme/private-repo" } };
      },
      upsertGithubComment: async (o: { repo: string; num: number; kind: string }) => {
        upsertCalls.push(o);
        return { posted: true, action: "updated", count: 1 };
      },
    } as unknown as UploadsClient;
    const code = await runMeta(
      ctxWith(client),
      ["set", `gh/private/${PREFIX_ID}/pull/12/shot.png`, "path=/docs/limits"],
      false,
    );
    expect(code).toBe(0);
    expect(getMetadataCalls).toEqual([`gh/private/${PREFIX_ID}/pull/12/shot.png`]);
    expect(upsertCalls).toEqual([
      { repo: "acme/private-repo", num: 12, kind: "pull", resync: true },
    ]);
  });

  it("does not sync a private-prefix key when gh.repo metadata is missing", async () => {
    const PREFIX_ID = "0123456789abcdef0123456789abcdef";
    const upsertCalls: { repo: string; num: number; kind: string }[] = [];
    const client = {
      patchMetadata: async (_key: string, o: { set?: Record<string, string> }) => ({
        metadata: { ...o.set },
      }),
      getMetadata: async () => ({ metadata: {} }),
      upsertGithubComment: async (o: { repo: string; num: number; kind: string }) => {
        upsertCalls.push(o);
        return { posted: true, action: "updated", count: 1 };
      },
    } as unknown as UploadsClient;
    await runMeta(
      ctxWith(client),
      ["set", `gh/private/${PREFIX_ID}/pull/12/shot.png`, "path=/docs/limits"],
      false,
    );
    expect(upsertCalls).toEqual([]);
  });

  it("prints a refresh hint instead of failing when the sync errors", async () => {
    const { client } = syncClient({ fail: true });
    const ctx = { ...ctxWith(client), quiet: false };
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      expect(await runMeta(ctx, ["set", "gh/acme/web/pull/12/shot.png", "path=/x"], false)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(stderr.join("")).toContain("uploads comment --pr 12");
  });
});

describe("runMeta unknown command", () => {
  it("rejects an unrecognized subcommand", async () => {
    const { client } = fakeClient();
    await expect(runMeta(ctxWith(client), ["bogus"], false)).rejects.toThrow(UsageError);
  });

  it("names the missing subcommand instead of dumping help (#545)", async () => {
    const { client } = fakeClient();
    await expect(runMeta(ctxWith(client), [], false)).rejects.toThrow(/meta requires a subcommand/);
  });
});
