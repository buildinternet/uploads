import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runMeta, type CliContext } from "../src/commands.js";

function fakeClient() {
  const getCalls: string[] = [];
  const patchCalls: { key: string; set?: Record<string, string>; delete?: string[] }[] = [];
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
  } as unknown as UploadsClient;
  return { client, getCalls, patchCalls };
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
    expect(upsertCalls).toEqual([{ repo: "acme/web", num: 12, kind: "pull" }]);
  });

  it("re-syncs when a display-relevant key is deleted", async () => {
    const { client, upsertCalls } = syncClient();
    await runMeta(
      ctxWith(client),
      ["set", "gh/acme/web/issues/7/shot.png", "--delete", "state"],
      false,
    );
    expect(upsertCalls).toEqual([{ repo: "acme/web", num: 7, kind: "issues" }]);
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

  it("prints help and returns 2 with no subcommand", async () => {
    const { client } = fakeClient();
    expect(await runMeta(ctxWith(client), [], false)).toBe(2);
  });
});
