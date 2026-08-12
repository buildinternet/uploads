import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import type {
  ResolveGhPrefixOptions,
  ResolveGhPrefixResult,
  UploadsClient,
} from "../src/client.js";
import type { CliContext } from "../src/commands.js";
import { runScreenshot, type AnnotateModule } from "../src/commands/screenshot.js";
import { foldStateIntoFilename } from "../src/screenshot.js";
import type { CommandRunner } from "../src/github-gh.js";
import type { CaptureScreenshotResult } from "../src/screenshot.js";
import type { AnnotationSpec, SpecError } from "../src/annotate/index.js";

/** Fake client capturing put() calls; other methods throw if reached. */
function fakeClient(
  opts: {
    replaced?: boolean;
    /**
     * `client.resolveGhPrefix` behavior (issue #631 private-prefix mode).
     * Omitted → method absent, simulating an older/self-hosted server
     * without the route (404) — degrades to plain, byte-identical to
     * pre-#631 keys.
     */
    resolveGhPrefix?:
      | ResolveGhPrefixResult
      | ((opts: ResolveGhPrefixOptions) => ResolveGhPrefixResult);
  } = {},
) {
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
      putOpts: {
        filename: string;
        key?: string;
        prefix?: string;
        dryRun?: boolean;
        metadata?: Record<string, string>;
      },
    ) => {
      puts.push({
        key: putOpts.key,
        filename: putOpts.filename,
        prefix: putOpts.prefix,
        dryRun: putOpts.dryRun,
        body,
        metadata: putOpts.metadata,
      });
      return {
        workspace: "test",
        key: putOpts.key ?? "screenshots/misc/generated.png",
        url: `https://x.test/${putOpts.key ?? "screenshots/misc/generated.png"}`,
        embedUrl: null,
        size: body.byteLength,
        contentType: "image/png",
        replaced: opts.replaced ?? false,
      };
    },
    list: async () => ({ items: [], cursor: null }),
    health: async () => ({ ok: true }),
    ...(opts.resolveGhPrefix !== undefined
      ? {
          resolveGhPrefix: async (req: ResolveGhPrefixOptions) =>
            typeof opts.resolveGhPrefix === "function"
              ? opts.resolveGhPrefix(req)
              : opts.resolveGhPrefix!,
        }
      : {}),
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
  measures?: Record<string, { x: number; y: number; w: number; h: number }>,
): (opts: unknown) => Promise<CaptureScreenshotResult> {
  return async () => ({ png, filename: "example-com.png", backend, measures });
}

/**
 * Records the `state` the command passed through to captureImpl and applies
 * the real `foldStateIntoFilename` (issue #618) so wiring — including the
 * canonical-values-only guard — can be asserted end to end without going
 * through the real backend-selection code.
 */
function fakeCaptureRecordingState(record: {
  state?: string;
}): (opts: unknown) => Promise<CaptureScreenshotResult> {
  return async (opts) => {
    const state = (opts as { state?: string }).state;
    record.state = state;
    return { png, filename: foldStateIntoFilename("example-com.png", state), backend: "remote" };
  };
}

class FakeAnnotateSpecError extends Error {
  readonly errors: SpecError[];
  constructor(errors: SpecError[]) {
    super("fake annotate spec error");
    this.name = "AnnotateSpecError";
    this.errors = errors;
  }
}

/**
 * A stand-in for the real `../annotate/index.js` module (which pulls in
 * sharp/roughjs) so CLI-layer tests can assert on the wiring — validate →
 * (selector gate) → resolveSelectors → renderAnnotations, before upload —
 * without rendering a real image.
 */
function fakeAnnotateModule(overrides: Partial<AnnotateModule> = {}): AnnotateModule {
  const hasAnySelector = (spec: AnnotationSpec) =>
    spec.annotations.some((a) => "selector" in a && typeof a.selector === "string");
  return {
    validateSpec: (json: unknown) => json as AnnotationSpec,
    hasSelectors: hasAnySelector,
    specSelectors: (spec: AnnotationSpec) => {
      const seen: string[] = [];
      for (const a of spec.annotations) {
        const sel = "selector" in a ? a.selector : undefined;
        if (typeof sel === "string" && !seen.includes(sel)) seen.push(sel);
      }
      return seen;
    },
    resolveSelectors: (spec: AnnotationSpec) => spec,
    renderAnnotations: async () => Buffer.from([1, 2, 3, 4]),
    clampReport: () => [],
    AnnotateSpecError: FakeAnnotateSpecError as unknown as AnnotateModule["AnnotateSpecError"],
    ...overrides,
  };
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

  it("rejects --max-height without --full-page", async () => {
    const { client } = fakeClient();
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--max-height", "3000"],
        false,
        noRun,
        fakeCapture(),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("rejects a non-numeric --max-height", async () => {
    const { client } = fakeClient();
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--full-page", "--max-height", "tall"],
        false,
        noRun,
        fakeCapture(),
      ),
    ).rejects.toThrow(UsageError);
  });

  it("accepts --max-height 0 (uncapped) with --full-page", async () => {
    const { client } = fakeClient();
    let seenMaxHeight: unknown = "unset";
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--full-page", "--max-height", "0"],
      false,
      noRun,
      async (opts) => {
        seenMaxHeight = (opts as { maxHeight?: number }).maxHeight;
        return { png, filename: "example-com.png", backend: "remote" };
      },
    );
    expect(code).toBe(0);
    expect(seenMaxHeight).toBe(0);
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

/**
 * Fake gh/git runner for the auto branch-staging trigger (issue #469 lever
 * 1), mirroring commands-put.test.ts's `stagingRunner` for the bare-put case
 * (issue #403) — same git/gh call shape, never expects a `gh pr view` call.
 */
function stagingRunner(opts: {
  branch?: string;
  defaultBranch?: string;
  originUrl?: string;
  repo?: string;
}): CommandRunner {
  return (cmd, args) => {
    if (cmd === "git" && args[0] === "config") {
      if (opts.originUrl === undefined) throw new Error("not a git repo");
      return `${opts.originUrl}\n`;
    }
    if (cmd === "git" && args[0] === "rev-parse") {
      if (opts.branch === undefined) throw new Error("detached HEAD");
      return `${opts.branch}\n`;
    }
    if (cmd === "git" && args[0] === "symbolic-ref") {
      if (opts.defaultBranch === undefined) throw new Error("no origin/HEAD");
      return `origin/${opts.defaultBranch}\n`;
    }
    if (cmd === "gh" && args[0] === "repo") {
      if (opts.repo === undefined) throw new Error("gh unauthenticated");
      return `${opts.repo}\n`;
    }
    throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
  };
}

describe("runScreenshot auto branch staging (issue #469 lever 1)", () => {
  const staged = {
    branch: "feature/thing",
    defaultBranch: "main",
    originUrl: "git@github.com:o/r.git",
    repo: "o/r",
  };

  it("stages a bare screenshot (no --pr/--issue/--branch) on a non-default branch, same key as --branch", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBe("gh/o/r/branch/feature-thing/example-com.png");
  });

  it("carries derived + explicit metadata (path/state) plus the branch gh.* pairs", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--meta", "path=/docs/limits", "--state", "after"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.metadata).toMatchObject({
      "gh.repo": "o/r",
      "gh.kind": "branch",
      "gh.branch": "feature/thing",
      path: "/docs/limits",
      state: "after",
    });
  });

  it("with --out, both auto-stages the upload AND writes a sidecar manifest (issue #473 x #469)", async () => {
    const { client, puts } = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-staged-sidecar-"));
    const out = join(dir, "shot.png");
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com/settings", "--out", out, "--state", "after"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    // Auto-staged upload: branch-keyed, gh.* branch metadata present.
    expect(puts[0]?.key).toBe("gh/o/r/branch/feature-thing/example-com.png");
    expect(puts[0]?.metadata).toMatchObject({
      "gh.repo": "o/r",
      "gh.kind": "branch",
      "gh.branch": "feature/thing",
      path: "/settings",
      state: "after",
    });
    // Sidecar written alongside --out carries only the derived/explicit
    // facts (no gh.* — those get resolved fresh at attach/promote time).
    const sidecarPath = `${out}.uploads.json`;
    expect(existsSync(sidecarPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(sidecarPath, "utf8"));
    expect(manifest.meta).toMatchObject({
      url: "https://example.com/settings",
      path: "/settings",
      state: "after",
    });
    expect(manifest.meta["gh.branch"]).toBeUndefined();
  });

  it("does not auto-stage on the default branch", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com"],
      false,
      stagingRunner({ ...staged, branch: "main" }),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBeUndefined();
  });

  it("does not auto-stage when not a git repo", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com"],
      false,
      stagingRunner({ branch: "feature/thing" }), // no originUrl → deriveRepoFromGit fails
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBeUndefined();
  });

  it("does not auto-stage with --no-git", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--no-git"],
      false,
      noRun,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBeUndefined();
  });

  it("does not auto-stage with --pr (existing PR-attach layout wins)", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--pr", "9", "--repo", "o/r"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBe("gh/o/r/pull/9/example-com.png");
  });

  it("builds a private-prefix key under --pr when the server advertises private mode (issue #631)", async () => {
    const PREFIX_ID = "0123456789abcdef0123456789abcdef";
    const { client, puts } = fakeClient({
      resolveGhPrefix: { mode: "private", prefixId: PREFIX_ID },
    });
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--pr", "9", "--repo", "o/r"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBe(`gh/private/${PREFIX_ID}/pull/9/example-com.png`);
  });

  it("does not auto-stage with --issue", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--issue", "9", "--repo", "o/r"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBe("gh/o/r/issues/9/example-com.png");
  });

  it("does not auto-stage with an explicit --key", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--key", "screenshots/explicit.png"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBe("screenshots/explicit.png");
  });

  it("does not auto-stage with an explicit --ref", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--ref", "1722"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBeUndefined();
  });

  it("does not auto-stage with an explicit --prefix", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--prefix", "custom"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.prefix).toBe("custom");
    expect(puts[0]?.key).toBeUndefined();
  });

  it("does not auto-stage with an explicit --destination", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--destination", "screenshots"],
      false,
      stagingRunner(staged),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.key).toBeUndefined();
  });

  describe("staging note: wording, suppression, JSON hint", () => {
    it("fires the exact staging-note wording on stderr", async () => {
      const { client } = fakeClient();
      const stderr = await captureStderr(() =>
        runScreenshot(
          { ...ctxWith(client), quiet: false },
          ["https://example.com"],
          false,
          stagingRunner(staged),
          fakeCapture("remote"),
        ),
      );
      expect(stderr).toContain(
        "note: staged for branch feature/thing — auto-comments to pull request when opened " +
          "(or run: uploads attach --promote once it exists). Use --ref/--prefix for a plain dated upload.",
      );
    });

    it("is suppressed by quiet, while staging itself still happens", async () => {
      const { client, puts } = fakeClient();
      const stderr = await captureStderr(() =>
        runScreenshot(
          ctxWith(client),
          ["https://example.com"],
          false,
          stagingRunner(staged),
          fakeCapture("remote"),
        ),
      );
      expect(stderr).not.toContain("note:");
      expect(puts[0]?.key).toBe("gh/o/r/branch/feature-thing/example-com.png");
    });

    it("includes an additive JSON hint field carrying the staging note", async () => {
      const { client } = fakeClient();
      const stdout = await captureStdout(() =>
        runScreenshot(
          { ...ctxWith(client), json: true, quiet: false },
          ["https://example.com"],
          false,
          stagingRunner(staged),
          fakeCapture("remote"),
        ),
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.hint).toContain("note: staged for branch feature/thing");
    });

    it("does not fire when staging didn't take over (e.g. on the default branch)", async () => {
      const { client } = fakeClient();
      const stderr = await captureStderr(() =>
        runScreenshot(
          { ...ctxWith(client), quiet: false },
          ["https://example.com"],
          false,
          stagingRunner({ ...staged, branch: "main" }),
          fakeCapture("remote"),
        ),
      );
      expect(stderr).not.toContain("note:");
    });
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

describe("runScreenshot derived repo metadata (spec: 2026-08-11-screenshots-project-grouping)", () => {
  /** Answers only `git config --get remote.origin.url`; anything else throws
   * so gh.* auto resolution stays out of the picture. */
  function repoOnlyRunner(originUrl: string): CommandRunner {
    return (cmd, args) => {
      if (cmd === "git" && args[0] === "config") return `${originUrl}\n`;
      throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
    };
  }

  it("records derived repo metadata from the git remote (mixed-case remote -> lowercase slug)", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com"],
      false,
      repoOnlyRunner("git@github.com:Acme/Web.git"),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.metadata).toMatchObject({ repo: "acme/web" });
  });

  it("suppresses derived repo with --no-git", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--no-git"],
      false,
      noRun,
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.metadata?.repo).toBeUndefined();
  });

  it("lets an explicit --meta repo= win over the derived value", async () => {
    const { client, puts } = fakeClient();
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--meta", "repo=custom/one"],
      false,
      repoOnlyRunner("git@github.com:Acme/Web.git"),
      fakeCapture("remote"),
    );
    expect(code).toBe(0);
    expect(puts[0]?.metadata?.repo).toBe("custom/one");
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

describe("runScreenshot --state folded into the derived name (issue #618)", () => {
  it("passes --state through to captureImpl, yielding a distinct key per state", async () => {
    const { client, puts } = fakeClient();
    const record: { state?: string } = {};
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--state", "before"],
      false,
      noRun,
      fakeCaptureRecordingState(record),
    );
    expect(code).toBe(0);
    expect(record.state).toBe("before");
    expect(puts[0]?.filename).toBe("example-com-before.png");

    const { client: client2, puts: puts2 } = fakeClient();
    const record2: { state?: string } = {};
    const code2 = await runScreenshot(
      ctxWith(client2),
      ["https://example.com", "--state", "after"],
      false,
      noRun,
      fakeCaptureRecordingState(record2),
    );
    expect(code2).toBe(0);
    expect(record2.state).toBe("after");
    expect(puts2[0]?.filename).toBe("example-com-after.png");
    expect(puts2[0]?.filename).not.toBe(puts[0]?.filename);
  });

  it("does not fold state when an explicit --key is given", async () => {
    const { client, puts } = fakeClient();
    const record: { state?: string } = {};
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--state", "before", "--key", "screenshots/explicit.png"],
      false,
      noRun,
      fakeCaptureRecordingState(record),
    );
    expect(code).toBe(0);
    expect(record.state).toBeUndefined();
    expect(puts[0]?.key).toBe("screenshots/explicit.png");
  });

  it("does not fold a free-form --meta state into the derived name", async () => {
    // `--meta state=x/y` passes validateMetaMap (any printable ASCII) and
    // reaches captureImpl via the merged metadata bag, but only canonical
    // state values may enter the object key.
    const { client, puts } = fakeClient();
    const record: { state?: string } = {};
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--meta", "state=x/y"],
      false,
      noRun,
      fakeCaptureRecordingState(record),
    );
    expect(code).toBe(0);
    expect(record.state).toBe("x/y");
    expect(puts[0]?.filename).toBe("example-com.png");
    expect(puts[0]?.metadata?.state).toBe("x/y");
  });

  it("does not fold state when no --state was given", async () => {
    const { client } = fakeClient();
    const record: { state?: string } = {};
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com"],
      false,
      noRun,
      fakeCaptureRecordingState(record),
    );
    expect(code).toBe(0);
    expect(record.state).toBeUndefined();
  });
});

describe("runScreenshot replaced-object note (issue #618)", () => {
  it("prints the same replaced note as put in human mode", async () => {
    const { client } = fakeClient({ replaced: true });
    const stderr = await captureStderr(() =>
      runScreenshot(
        { ...ctxWith(client), quiet: false },
        ["https://example.com", "--state", "after"],
        false,
        noRun,
        fakeCapture("remote"),
      ),
    );
    expect(stderr).toContain(">> replaced existing object (same URL)\n");
  });

  it("does not print a replaced note when nothing was replaced", async () => {
    const { client } = fakeClient({ replaced: false });
    const stderr = await captureStderr(() =>
      runScreenshot(
        { ...ctxWith(client), quiet: false },
        ["https://example.com", "--state", "after"],
        false,
        noRun,
        fakeCapture("remote"),
      ),
    );
    expect(stderr).not.toContain("replaced existing object");
  });

  it("is suppressed in quiet mode", async () => {
    const { client } = fakeClient({ replaced: true });
    const stderr = await captureStderr(() =>
      runScreenshot(
        ctxWith(client), // quiet: true by default
        ["https://example.com", "--state", "after"],
        false,
        noRun,
        fakeCapture("remote"),
      ),
    );
    expect(stderr).not.toContain("replaced existing object");
  });

  it("carries a replaced+state hint in the json hint slot", async () => {
    const { client } = fakeClient({ replaced: true });
    const stdout = await captureStdout(() =>
      runScreenshot(
        { ...ctxWith(client), json: true, quiet: false },
        ["https://example.com", "--state", "after"],
        false,
        noRun,
        fakeCapture("remote"),
      ),
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.replaced).toBe(true);
    expect(parsed.hint).toContain("re-capture replaced the previous state=after object");
    expect(parsed.hint).toContain("expected for repeat captures");
  });

  it("does not set the json hint when replaced but no --state was given", async () => {
    const { client } = fakeClient({ replaced: true });
    const stdout = await captureStdout(() =>
      runScreenshot(
        { ...ctxWith(client), json: true, quiet: false },
        ["https://example.com"],
        false,
        noRun,
        fakeCapture("remote"),
      ),
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.replaced).toBe(true);
    expect(parsed.hint).toBeUndefined();
  });
});

/** A capture result with a full-page-cap outcome, for the #652 note/hint tests below. */
function fakeCaptureCapped(capped?: {
  maxHeightPx: number;
  clipped: boolean;
}): (opts: unknown) => Promise<CaptureScreenshotResult> {
  return async () => ({ png, filename: "example-com.png", backend: "remote", capped });
}

describe("runScreenshot full-page height cap note/hint (issue #652)", () => {
  it("prints the clip note to stderr in human mode", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runScreenshot(
        { ...ctxWith(client), quiet: false },
        ["https://example.com", "--full-page"],
        false,
        noRun,
        fakeCaptureCapped({ maxHeightPx: 5000, clipped: true }),
      ),
    );
    expect(stderr).toContain("full page exceeds 5000px; clipped — use --max-height to raise");
  });

  it("does not print a note when the page wasn't clipped", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runScreenshot(
        { ...ctxWith(client), quiet: false },
        ["https://example.com", "--full-page"],
        false,
        noRun,
        fakeCaptureCapped({ maxHeightPx: 5000, clipped: false }),
      ),
    );
    expect(stderr).not.toContain("clipped");
  });

  it("is suppressed in quiet mode", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runScreenshot(
        ctxWith(client), // quiet: true by default
        ["https://example.com", "--full-page"],
        false,
        noRun,
        fakeCaptureCapped({ maxHeightPx: 5000, clipped: true }),
      ),
    );
    expect(stderr).not.toContain("clipped");
  });

  it("carries the clip note in the json hint slot", async () => {
    const { client } = fakeClient();
    const stdout = await captureStdout(() =>
      runScreenshot(
        { ...ctxWith(client), json: true, quiet: false },
        ["https://example.com", "--full-page", "--max-height", "3500"],
        false,
        noRun,
        fakeCaptureCapped({ maxHeightPx: 3500, clipped: true }),
      ),
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.hint).toBe("full page exceeds 3500px; clipped — use --max-height to raise");
  });

  it("does not set the json hint when the page wasn't clipped", async () => {
    const { client } = fakeClient();
    const stdout = await captureStdout(() =>
      runScreenshot(
        { ...ctxWith(client), json: true, quiet: false },
        ["https://example.com", "--full-page"],
        false,
        noRun,
        fakeCaptureCapped({ maxHeightPx: 5000, clipped: false }),
      ),
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.hint).toBeUndefined();
  });
});

/** Run `fn` with process.stderr.write captured, returning the concatenated output. */
async function captureStderr(fn: () => Promise<unknown>): Promise<string> {
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await fn();
    return writeSpy.mock.calls.map((c) => String(c[0])).join("");
  } finally {
    writeSpy.mockRestore();
  }
}

/** Run `fn` with process.stdout.write captured, returning the concatenated output. */
async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await fn();
    return chunks.join("");
  } finally {
    writeSpy.mockRestore();
  }
}

describe("runScreenshot --annotate", () => {
  function writeSpec(spec: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "uploads-annotate-spec-"));
    const file = join(dir, "spec.json");
    writeFileSync(file, JSON.stringify(spec));
    return file;
  }

  it("validates the spec before capturing — invalid spec never reaches captureImpl", async () => {
    const { client } = fakeClient();
    const specFile = writeSpec({ version: 1, annotations: [] }); // shape irrelevant; validateSpec fails
    let captureCalled = false;
    const annotateModule = fakeAnnotateModule({
      validateSpec: () => {
        throw new (fakeAnnotateModule().AnnotateSpecError)([
          { index: null, message: "annotations must be a non-empty array" },
        ]);
      },
    });
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--annotate", specFile],
        false,
        noRun,
        async () => {
          captureCalled = true;
          return { png, filename: "x.png", backend: "remote" };
        },
        undefined,
        async () => annotateModule,
      ),
    ).rejects.toThrow(UsageError);
    expect(captureCalled).toBe(false);
  });

  it("rejects a selector-bearing spec combined with an explicit --via remote, before capturing", async () => {
    const { client } = fakeClient();
    const specFile = writeSpec({
      version: 1,
      annotations: [{ type: "box", selector: "h1" }],
    });
    let captureCalled = false;
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--via", "remote", "--annotate", specFile],
        false,
        noRun,
        async () => {
          captureCalled = true;
          return { png, filename: "x.png", backend: "remote" };
        },
        undefined,
        async () => fakeAnnotateModule(),
      ),
    ).rejects.toThrow(/--via local/);
    expect(captureCalled).toBe(false);
  });

  it("rejects a selector-bearing spec when the resolved backend is remote (auto fallback)", async () => {
    const { client } = fakeClient();
    const specFile = writeSpec({
      version: 1,
      annotations: [{ type: "box", selector: "h1" }],
    });
    await expect(
      runScreenshot(
        ctxWith(client),
        ["https://example.com", "--annotate", specFile],
        false,
        noRun,
        fakeCapture("remote"), // captureImpl resolved to remote (e.g. auto fallback)
        undefined,
        async () => fakeAnnotateModule(),
      ),
    ).rejects.toThrow(/--via local/);
  });

  it("resolves selectors against measured boxes and renders before upload (end to end, local backend)", async () => {
    const { client, puts } = fakeClient();
    const specFile = writeSpec({
      version: 1,
      annotations: [{ type: "box", selector: "h1" }],
    });
    const rendered = Buffer.from([9, 9, 9, 9, 9]);
    let resolvedWith: unknown;
    const annotateModule = fakeAnnotateModule({
      resolveSelectors: (spec, boxes) => {
        resolvedWith = boxes;
        return spec;
      },
      renderAnnotations: async () => rendered,
    });
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--annotate", specFile],
      false,
      noRun,
      fakeCapture("local", { h1: { x: 1, y: 2, w: 3, h: 4 } }),
      undefined,
      async () => annotateModule,
    );
    expect(code).toBe(0);
    expect(resolvedWith).toEqual({ h1: { x: 1, y: 2, w: 3, h: 4 } });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual(rendered);
  });

  it("renders a pixel-only spec (no selectors) regardless of backend", async () => {
    const { client, puts } = fakeClient();
    const specFile = writeSpec({
      version: 1,
      annotations: [{ type: "box", x: 0, y: 0, w: 10, h: 10 }],
    });
    const rendered = Buffer.from([7, 7, 7]);
    const annotateModule = fakeAnnotateModule({
      renderAnnotations: async () => rendered,
    });
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--annotate", specFile],
      false,
      noRun,
      fakeCapture("remote"),
      undefined,
      async () => annotateModule,
    );
    expect(code).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual(rendered);
  });

  it("--annotate - reads the spec from stdin", async () => {
    const { client, puts } = fakeClient();
    const rendered = Buffer.from([5, 5, 5]);
    const annotateModule = fakeAnnotateModule({ renderAnnotations: async () => rendered });
    const spec = { version: 1, annotations: [{ type: "box", x: 0, y: 0, w: 1, h: 1 }] };
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--annotate", "-"],
      false,
      noRun,
      fakeCapture("remote"),
      async () => JSON.stringify(spec),
      async () => annotateModule,
    );
    expect(code).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual(rendered);
  });

  it("also annotates the local --out file, not just the uploaded bytes", async () => {
    const { client } = fakeClient();
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const out = join(dir, "shot.png");
    const specFile = writeSpec({
      version: 1,
      annotations: [{ type: "box", x: 0, y: 0, w: 1, h: 1 }],
    });
    const rendered = Buffer.from([3, 3, 3]);
    const annotateModule = fakeAnnotateModule({ renderAnnotations: async () => rendered });
    const code = await runScreenshot(
      ctxWith(client),
      ["https://example.com", "--no-upload", "--out", out, "--annotate", specFile],
      false,
      noRun,
      fakeCapture("remote"),
      undefined,
      async () => annotateModule,
    );
    expect(code).toBe(0);
    expect(readFileSync(out)).toEqual(Buffer.from(rendered));
  });
});
