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
