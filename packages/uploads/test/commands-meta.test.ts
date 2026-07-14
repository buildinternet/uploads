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
