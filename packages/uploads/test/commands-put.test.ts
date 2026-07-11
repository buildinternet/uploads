import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import { runPut, type CliContext } from "../src/commands.js";
import type { CommandRunner } from "../src/github-gh.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fake client capturing put() calls; other methods throw if reached. */
function fakeClient() {
  const puts: { key?: string; filename: string; prefix?: string; body: Uint8Array }[] = [];
  const client = {
    put: async (body: Uint8Array, opts: { filename: string; key?: string; prefix?: string }) => {
      puts.push({ key: opts.key, filename: opts.filename, prefix: opts.prefix, body });
      return {
        workspace: "test",
        key: opts.key ?? "generated/key.png",
        url: `https://x.test/${opts.key ?? "generated/key.png"}`,
        size: body.byteLength,
        contentType: "image/png",
      };
    },
    list: async () => ({ items: [], cursor: null }),
    delete: async () => {
      throw new Error("unexpected delete");
    },
    head: async () => {
      throw new Error("unexpected head");
    },
    health: async () => ({ ok: true }),
  } as unknown as UploadsClient;
  return { client, puts };
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

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "uploads-test-"));
  const file = join(dir, "shot.png");
  writeFileSync(file, "png");
  return file;
}

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

describe("runPut --pr/--issue", () => {
  it("builds a stable PR key with no hash", async () => {
    const { client, puts } = fakeClient();
    const code = await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "123", "--repo", "buildinternet/uploads"],
      false,
      noRun,
    );
    expect(code).toBe(0);
    expect(puts[0].key).toBe("gh/buildinternet/uploads/pull/123/shot.png");
  });

  it("builds an issue key", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--issue", "7", "--repo", "o/r"], false, noRun);
    expect(puts[0].key).toBe("gh/o/r/issues/7/shot.png");
  });

  it("rejects --pr with --issue", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--pr", "1", "--issue", "2", "--repo", "o/r"],
        false,
        noRun,
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects --pr with --key", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--pr", "1", "--key", "x/y.png", "--repo", "o/r"],
        false,
        noRun,
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects --pr with --ref", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--pr", "1", "--ref", "abc", "--repo", "o/r"],
        false,
        noRun,
      ),
    ).rejects.toThrow(UsageError);
  });

  it("still uses the hashed screenshot key path without --pr/--issue", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--repo", "myapp", "--no-git"], false, noRun);
    expect(puts[0].key).toBeUndefined(); // client falls back to buildScreenshotKey
  });

  it("uploads non-image bytes unchanged when optimize cannot help", async () => {
    const { client, puts } = fakeClient();
    // tmpFile writes the text "png" — not a real image; optimize passes through.
    await runPut(ctxWith(client), [tmpFile(), "--pr", "9", "--repo", "o/r"], false, noRun);
    expect(puts[0].filename).toBe("shot.png");
    expect(puts[0].key).toBe("gh/o/r/pull/9/shot.png");
    expect(new TextDecoder().decode(puts[0].body)).toBe("png");
  });

  it("honors --no-optimize", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "9", "--repo", "o/r", "--no-optimize"],
      false,
      noRun,
    );
    expect(puts[0].filename).toBe("shot.png");
    expect(puts[0].key).toBe("gh/o/r/pull/9/shot.png");
  });
});

describe("runPut --destination", () => {
  it("sets prefix from destination screenshots", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--destination", "screenshots", "--repo", "myapp", "--no-git"],
      false,
      noRun,
    );
    expect(puts[0].prefix).toBe("screenshots");
  });

  it("allows --destination gh with --pr", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "1", "--destination", "gh", "--repo", "o/r"],
      false,
      noRun,
    );
    expect(puts[0].key).toBe("gh/o/r/pull/1/shot.png");
  });

  it("rejects --destination screenshots with --pr", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--pr", "1", "--destination", "screenshots", "--repo", "o/r"],
        false,
        noRun,
      ),
    ).rejects.toThrow(/must be gh/);
  });

  it("rejects unknown destinations", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), [tmpFile(), "--destination", "tmp"], false, noRun),
    ).rejects.toThrow(/unknown destination/);
  });

  it("rejects conflicting --prefix and --destination", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--destination", "screenshots", "--prefix", "other"],
        false,
        noRun,
      ),
    ).rejects.toThrow(/conflicts/);
  });

  it("rejects --key outside the destination root", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--destination", "screenshots", "--key", "tmp/a.png"],
        false,
        noRun,
      ),
    ).rejects.toThrow(/must start with destination root/);
  });
});
