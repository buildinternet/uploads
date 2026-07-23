import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type { UploadsClient } from "../src/client.js";
import type { CliContext } from "../src/commands.js";
import { runScreenshot } from "../src/commands/screenshot.js";
import type { CommandRunner } from "../src/github-gh.js";
import type { CaptureScreenshotResult } from "../src/screenshot.js";

/** Fake client capturing put() calls; other methods throw if reached. */
function fakeClient() {
  const puts: {
    key?: string;
    filename: string;
    prefix?: string;
    dryRun?: boolean;
    body: Uint8Array;
    metadata?: Record<string, string>;
  }[] = [];
  const client = {
    put: async (
      body: Uint8Array,
      opts: {
        filename: string;
        key?: string;
        prefix?: string;
        dryRun?: boolean;
        metadata?: Record<string, string>;
      },
    ) => {
      puts.push({
        key: opts.key,
        filename: opts.filename,
        prefix: opts.prefix,
        dryRun: opts.dryRun,
        body,
        metadata: opts.metadata,
      });
      return {
        workspace: "test",
        key: opts.key ?? "screenshots/misc/generated.png",
        url: `https://x.test/${opts.key ?? "screenshots/misc/generated.png"}`,
        embedUrl: null,
        size: body.byteLength,
        contentType: "image/png",
      };
    },
    list: async () => ({ items: [], cursor: null }),
    health: async () => ({ ok: true }),
  } as unknown as UploadsClient;
  return { client, puts };
}

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

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

const png = new Uint8Array([137, 80, 78, 71]); // fake PNG magic-ish bytes

function fakeCapture(
  backend: "local" | "remote" = "remote",
): (opts: unknown) => Promise<CaptureScreenshotResult> {
  return async () => ({ png, filename: "example-com.png", backend });
}

describe("runScreenshot flag validation", () => {
  it("--no-upload requires --out", async () => {
    const { client } = fakeClient();
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--no-upload"],
        false,
        noRun,
        fakeCapture(),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects an invalid --via value", async () => {
    const { client } = fakeClient();
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--via", "carrier-pigeon"],
        false,
        noRun,
        fakeCapture(),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects --dark combined with --light", async () => {
    const { client } = fakeClient();
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--dark", "--light"],
        false,
        noRun,
        fakeCapture(),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects an invalid --viewport", async () => {
    const { client } = fakeClient();
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--viewport", "huge"],
        false,
        noRun,
        fakeCapture(),
      ),
    ).rejects.toThrow();
  });

  it("rejects --dry-run combined with --no-upload", async () => {
    const { client } = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const out = join(dir, "shot.png");
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--dry-run", "--no-upload", "--out", out],
        false,
        noRun,
        fakeCapture(),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("shows help without capturing or uploading", async () => {
    const { client, puts } = fakeClient();
    let captured = false;
    const code = await runScreenshot(ctxWith(client), ["--help"], false, noRun, async () => {
      captured = true;
      return { png, filename: "x.png", backend: "remote" };
    });
    expect(code).toBe(0);
    expect(captured).toBe(false);
    expect(puts).toEqual([]);
  });
});

describe("runScreenshot upload tail", () => {
  it("captures and uploads, printing URL/EMBED/MARKDOWN", async () => {
    const { client, puts } = fakeClient();
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runScreenshot(
        ctxWith(client),
        ["https://example.com"],
        false,
        noRun,
        fakeCapture("remote"),
      );
      expect(code).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(puts).toHaveLength(1);
    expect(puts[0]?.filename).toBe("example-com.png");
    // No --destination/--prefix given: prefix stays undefined here (buildScreenshotKey
    // applies the "screenshots" default server-side, same as put's own default path).
    expect(puts[0]?.prefix).toBeUndefined();
    const out = chunks.join("");
    expect(out).toContain("URL: https://x.test/");
    expect(out).toContain("MARKDOWN:");
  });

  it("--dry-run captures but does not persist the object", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--dry-run"],
      false,
      noRun,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.dryRun).toBe(true);
  });

  it("--out writes the PNG locally in addition to uploading", async () => {
    const { client } = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const out = join(dir, "shot.png");
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--out", out],
      false,
      noRun,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out)).toEqual(Buffer.from(png));
  });

  it("--no-upload with --out skips hosting entirely", async () => {
    const { client, puts } = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const out = join(dir, "shot.png");
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--no-upload", "--out", out],
      false,
      noRun,
      fakeCapture("local"),
    );
    expect(code).toBe(0);
    expect(puts).toEqual([]);
    expect(existsSync(out)).toBe(true);
  });

  it("--out writes a sidecar manifest with derived metadata and a content hash", async () => {
    const { client } = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const out = join(dir, "shot.png");
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com/settings", "--out", out, "--state", "after"],
      false,
      noRun,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    const sidecarPath = `${out}.uploads.json`;
    expect(existsSync(sidecarPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(sidecarPath, "utf8"));
    expect(manifest.version).toBe(1);
    expect(typeof manifest.sha256).toBe("string");
    expect(manifest.sha256).toHaveLength(64);
    expect(manifest.meta).toMatchObject({
      url: "https://example.com/settings",
      path: "/settings",
      state: "after",
    });
    expect(manifest.meta.viewport).toBeDefined();
  });

  it("--no-sidecar skips writing the sidecar manifest", async () => {
    const { client } = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const out = join(dir, "shot.png");
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com/settings", "--out", out, "--no-sidecar"],
      false,
      noRun,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(existsSync(`${out}.uploads.json`)).toBe(false);
  });

  it("--no-sidecar requires --out", async () => {
    const { client } = fakeClient();
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--no-sidecar"],
        false,
        noRun,
        fakeCapture(),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("does not write a sidecar when there is no derived metadata to store", async () => {
    const { client } = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const out = join(dir, "card.png");
    const code = await runScreenshot(
      ctxWith(client),
      ["./card.html", "--out", out, "--no-auto"],
      false,
      noRun,
      fakeCapture("local"),
    );
    void code;
    expect(existsSync(`${out}.uploads.json`)).toBe(false);
  });

  it("--destination screenshots sets the key prefix", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--destination", "screenshots"],
      false,
      noRun,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.prefix).toBe("screenshots");
  });

  it("writes JSON output with --format json", async () => {
    const { client } = fakeClient();
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await runScreenshot(
        ctxWith(client, { json: true }),
        ["https://example.com"],
        false,
        noRun,
        fakeCapture("local"),
      );
      expect(code).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    const payload = JSON.parse(chunks.join("")) as { url: string; backend: string };
    expect(payload.backend).toBe("local");
    expect(payload.url).toContain("https://x.test/");
  });
});

describe("runScreenshot --branch (branch-staged, pre-PR)", () => {
  it("stages under gh/<owner>/<repo>/branch/<branch>/<filename>, sanitizing the branch segment", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--branch", "feature/thing", "--repo", "o/r"],
      false,
      noRun,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBe("gh/o/r/branch/feature-thing/example-com.png");
  });

  it("defaults --branch (no value) to the current git branch", async () => {
    const { client, puts } = fakeClient();
    const run: CommandRunner = (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse") return "main\n";
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    };
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--branch", "--repo", "o/r"],
      false,
      run,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBe("gh/o/r/branch/main/example-com.png");
  });

  it("throws UsageError on detached HEAD when --branch has no value", async () => {
    const { client } = fakeClient();
    const run: CommandRunner = (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse") return "HEAD\n";
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    };
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--branch", "--repo", "o/r"],
        false,
        run,
        fakeCapture("remote"),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("writes gh.repo/gh.kind=branch/gh.branch/gh.staged-at (no gh.number/gh.ref/gh.title)", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--branch", "feature/thing", "--repo", "o/r"],
      false,
      noRun,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    const metadata = puts[0]?.metadata;
    expect(metadata).toMatchObject({
      "gh.repo": "o/r",
      "gh.kind": "branch",
      "gh.branch": "feature/thing",
    });
    expect(metadata?.["gh.staged-at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(metadata?.["gh.number"]).toBeUndefined();
    expect(metadata?.["gh.ref"]).toBeUndefined();
  });

  it.each([
    ["--pr", "1"],
    ["--issue", "1"],
    ["--comment", undefined],
    ["--key", "gh/o/r/branch/x/explicit.png"],
    ["--ref", "123"],
    ["--prefix", "gh"],
  ])("rejects --branch combined with %s", async (flag, value) => {
    const { client } = fakeClient();
    const extra = value !== undefined ? [flag, value] : [flag];
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--branch", "feature/thing", "--repo", "o/r", ...extra],
        false,
        noRun,
        fakeCapture("remote"),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects an unsafe branch name that fails the printable-ASCII metadata rule", async () => {
    const { client } = fakeClient();
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--branch", "feature/🚀", "--repo", "o/r"],
        false,
        noRun,
        fakeCapture("remote"),
      ),
    ).rejects.toThrow(UsageError);
  });
});

describe("runScreenshot gh.title metadata (issue #267)", () => {
  it("stamps gh.title alongside the base gh.* pairs when the title resolves", async () => {
    const { client, puts } = fakeClient();
    const run: CommandRunner = (cmd, args) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view" && args.includes("title")) {
        return "Add dark mode toggle\n";
      }
      throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
    };
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--pr", "9", "--repo", "o/r"],
      false,
      run,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.metadata).toMatchObject({
      "gh.ref": "o/r#9",
      "gh.title": "Add dark mode toggle",
    });
  });

  it("omits gh.title (never fails the capture) when the title can't be resolved", async () => {
    const { client, puts } = fakeClient();
    const run: CommandRunner = () => {
      throw new Error("gh: not authenticated");
    };
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--pr", "9", "--repo", "o/r"],
      false,
      run,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.metadata!["gh.title"]).toBeUndefined();
    expect(puts[0]?.metadata!["gh.ref"]).toBe("o/r#9");
  });
});

describe("screenshot canonical metadata", () => {
  /** Run a capture with --no-git (no repo resolution) and return the put options. */
  async function metaFor(args: string[]): Promise<Record<string, string> | undefined> {
    const { client, puts } = fakeClient();
    await runScreenshot(ctxWith(client), [...args, "--no-git"], false, noRun, fakeCapture());
    return puts[0]?.metadata;
  }

  it("stamps path, url and viewport from the capture target", async () => {
    const meta = await metaFor([
      "https://app.example/settings?tab=billing",
      "--viewport",
      "1280x800@2x",
    ]);
    expect(meta?.path).toBe("/settings");
    expect(meta?.url).toBe("https://app.example/settings?tab=billing");
    expect(meta?.viewport).toBe("1280x800@2x");
  });

  it("omits env for a public host rather than guessing prod", async () => {
    const meta = await metaFor(["https://app.example/settings"]);
    expect(meta?.env).toBeUndefined();
  });

  it("stamps env=local for a localhost target", async () => {
    const meta = await metaFor(["http://localhost:4321/docs"]);
    expect(meta?.env).toBe("local");
    expect(meta?.path).toBe("/docs");
  });

  it("stamps theme only when a scheme was forced", async () => {
    expect((await metaFor(["https://app.example/a"]))?.theme).toBeUndefined();
    expect((await metaFor(["https://app.example/a", "--dark"]))?.theme).toBe("dark");
  });

  it("lets an explicit --meta override a derived value", async () => {
    const meta = await metaFor(["https://app.example/settings", "--meta", "path=/custom"]);
    expect(meta?.path).toBe("/custom");
  });

  it("carries --state through to metadata", async () => {
    const meta = await metaFor(["https://app.example/settings", "--state", "after"]);
    expect(meta?.state).toBe("after");
  });

  it("derives nothing when --no-auto opts out of the derived tier", async () => {
    const meta = await metaFor(["https://app.example/settings", "--no-auto"]);
    expect(meta?.path).toBeUndefined();
    expect(meta?.viewport).toBeUndefined();
    expect(meta?.url).toBeUndefined();
  });

  it("still honours explicit --meta when the derived tier is off", async () => {
    const meta = await metaFor([
      "https://app.example/settings",
      "--no-auto",
      "--meta",
      "ticket=RAL-1",
    ]);
    expect(meta?.ticket).toBe("RAL-1");
    expect(meta?.path).toBeUndefined();
  });
});
