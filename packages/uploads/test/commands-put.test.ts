import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { UploadsError } from "../src/errors.js";
import type { UploadsClient } from "../src/client.js";
import { runPut, stateAppMetaFromFlags, type CliContext } from "../src/commands.js";
import type { CommandRunner } from "../src/github-gh.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fake client capturing put() calls; other methods throw if reached. */
function fakeClient() {
  const puts: {
    key?: string;
    filename: string;
    prefix?: string;
    dryRun?: boolean;
    replace?: boolean;
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
        replace?: boolean;
        metadata?: Record<string, string>;
      },
    ) => {
      puts.push({
        key: opts.key,
        filename: opts.filename,
        prefix: opts.prefix,
        dryRun: opts.dryRun,
        replace: opts.replace,
        body,
        metadata: opts.metadata,
      });
      return {
        workspace: "test",
        key: opts.key ?? "generated/key.png",
        url: `https://x.test/${opts.key ?? "generated/key.png"}`,
        embedUrl: null,
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

function tmpFiles(...names: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "uploads-put-multi-"));
  return names.map((name) => {
    const path = join(dir, name);
    writeFileSync(path, name);
    return path;
  });
}

describe("runPut multi-file", () => {
  it("uploads multiple files and returns batch JSON", async () => {
    const { client, puts } = fakeClient();
    const paths = tmpFiles("a.png", "b.png");
    const ctx = { ...ctxWith(client), json: true };
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await runPut(ctx, paths, false, noRun)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(puts.map((p) => p.filename).sort()).toEqual(["a.png", "b.png"]);
    const payload = JSON.parse(chunks.join("")) as {
      uploads: { file: string; url: string }[];
      failures: unknown[];
    };
    expect(payload.uploads).toHaveLength(2);
    expect(payload.failures).toEqual([]);
  });

  it("continues after a per-file failure (exit 1)", async () => {
    const puts: string[] = [];
    const client = {
      put: async (_body: Uint8Array, opts: { filename: string; key?: string }) => {
        if (opts.filename === "bad.png") {
          throw new UploadsError("forced", "API_ERROR", 500);
        }
        puts.push(opts.filename);
        return {
          workspace: "test",
          key: opts.key ?? `generated/${opts.filename}`,
          url: `https://x.test/${opts.filename}`,
          embedUrl: null,
          size: 3,
          contentType: "image/png",
        };
      },
      list: async () => ({ items: [], cursor: null }),
    } as unknown as UploadsClient;
    const paths = tmpFiles("good.png", "bad.png");
    const ctx = { ...ctxWith(client), json: true };
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await runPut(ctx, paths, false, noRun)).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
    expect(puts).toEqual(["good.png"]);
    const payload = JSON.parse(chunks.join("")) as {
      uploads: { optimize: { filename: string } }[];
      failures: { file: string; error: { code?: string } }[];
    };
    expect(payload.uploads).toHaveLength(1);
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0]!.error.code).toBe("API_ERROR");
  });

  it("rejects --key with multiple files", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), [...tmpFiles("a.png", "b.png"), "--key", "x/y.png"], false, noRun),
    ).rejects.toThrow(UsageError);
  });
});

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

describe("runPut --name", () => {
  it("overrides the key leaf while keeping the stable --pr path", async () => {
    const { client, puts } = fakeClient();
    const code = await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "128", "--repo", "o/r", "--name", "hero.png"],
      false,
      noRun,
    );
    expect(code).toBe(0);
    expect(puts[0].filename).toBe("hero.png");
    expect(puts[0].key).toBe("gh/o/r/pull/128/hero.png");
  });

  it("overrides the leaf on the default hashed key path", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "myapp", "--no-git", "--name", "clean.png"],
      false,
      noRun,
    );
    expect(puts[0].filename).toBe("clean.png"); // client hashes <name>-<hash>.<ext>
  });

  it("rejects --name with a slash", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), [tmpFile(), "--name", "a/b.png"], false, noRun),
    ).rejects.toThrow(UsageError);
  });

  it("rejects --name combined with --key", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), [tmpFile(), "--key", "x/y.png", "--name", "z.png"], false, noRun),
    ).rejects.toThrow(UsageError);
  });
});

describe("runPut --dry-run", () => {
  it("passes dryRun to the client and returns 0", async () => {
    const { client, puts } = fakeClient();
    const code = await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "5", "--repo", "o/r", "--dry-run"],
      false,
      noRun,
    );
    expect(code).toBe(0);
    expect(puts[0].dryRun).toBe(true);
    expect(puts[0].key).toBe("gh/o/r/pull/5/shot.png");
  });

  it("prints would-replace note when dry-run reports replaced", async () => {
    const puts: unknown[] = [];
    const client = {
      put: async (body: Uint8Array, opts: { filename: string; key?: string; dryRun?: boolean }) => {
        puts.push(opts);
        return {
          workspace: "test",
          key: opts.key ?? "k",
          url: "https://x.test/k",
          embedUrl: null,
          size: body.byteLength,
          contentType: "image/png",
          replaced: true,
        };
      },
    } as unknown as UploadsClient;
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const ctx = { ...ctxWith(client), quiet: false };
      const code = await runPut(
        ctx,
        [tmpFile(), "--pr", "5", "--repo", "o/r", "--dry-run", "--no-optimize"],
        false,
        noRun,
      );
      expect(code).toBe(0);
      expect(stderr.join("")).toContain(">> would replace existing object (same URL)");
    } finally {
      process.stderr.write = write;
    }
  });

  it("rejects --dry-run with --comment", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), [tmpFile(), "--pr", "5", "--dry-run", "--comment"], false, noRun),
    ).rejects.toThrow(UsageError);
  });

  it("rejects --dry-run with --gallery", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), [tmpFile(), "--dry-run", "--gallery", "gal_x"], false, noRun),
    ).rejects.toThrow(UsageError);
  });

  it("prints would-refuse note when dry-run reports wouldRefuse on a strict key", async () => {
    const client = {
      put: async (body: Uint8Array, opts: { key?: string }) => ({
        workspace: "test",
        key: opts.key ?? "k",
        url: "https://x.test/k",
        embedUrl: null,
        size: body.byteLength,
        contentType: "image/png",
        replaced: true,
        wouldRefuse: true,
      }),
    } as unknown as UploadsClient;
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const ctx = { ...ctxWith(client), quiet: false };
      const code = await runPut(
        ctx,
        [tmpFile(), "--key", "screenshots/existing.png", "--dry-run", "--no-optimize"],
        false,
        noRun,
      );
      expect(code).toBe(0);
      expect(stderr.join("")).toContain(">> would refuse: key already exists");
      expect(stderr.join("")).not.toContain(">> would replace existing object");
    } finally {
      process.stderr.write = write;
    }
  });
});

describe("runPut --replace / UPLOADS_OVERWRITE (issue #174)", () => {
  it("does not pass replace to the client by default", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--key", "screenshots/x.png"], false, noRun);
    expect(puts[0].replace).toBeFalsy();
  });

  it("--replace passes replace: true to the client", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--key", "screenshots/x.png", "--replace"],
      false,
      noRun,
    );
    expect(puts[0].replace).toBe(true);
  });

  it("UPLOADS_OVERWRITE=1 defaults replace to true without --replace", async () => {
    const { client, puts } = fakeClient();
    const prev = process.env.UPLOADS_OVERWRITE;
    process.env.UPLOADS_OVERWRITE = "1";
    try {
      await runPut(ctxWith(client), [tmpFile(), "--key", "screenshots/x.png"], false, noRun);
      expect(puts[0].replace).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.UPLOADS_OVERWRITE;
      else process.env.UPLOADS_OVERWRITE = prev;
    }
  });

  it("propagates a key_exists refusal from the client as an actionable error", async () => {
    const client = {
      put: async () => {
        throw new UploadsError(
          'An object already exists at "screenshots/x.png". Pass --replace (or replace: true) to overwrite it.',
          "KEY_EXISTS",
          409,
          { existingUrl: "https://x.test/screenshots/x.png" },
        );
      },
    } as unknown as UploadsClient;
    await expect(
      runPut(ctxWith(client), [tmpFile(), "--key", "screenshots/x.png"], false, noRun),
    ).rejects.toMatchObject({
      code: "KEY_EXISTS",
      existingUrl: "https://x.test/screenshots/x.png",
    });
  });
});

describe("runPut missing file", () => {
  it("throws FILE_NOT_FOUND for a nonexistent path", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), ["/no/such/file-xyz.png"], false, noRun),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("surfaces FILE_NOT_FOUND as an UploadsError", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), ["/no/such/file-xyz.png"], false, noRun),
    ).rejects.toBeInstanceOf(UploadsError);
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

describe("runPut --meta", () => {
  it("passes a single --meta pair through to the client", async () => {
    const { client, puts } = fakeClient();
    const code = await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "myapp", "--no-git", "--meta", "app=myapp"],
      false,
      noRun,
    );
    expect(code).toBe(0);
    expect(puts[0].metadata).toEqual({ app: "myapp" });
  });

  it("collects repeated --meta pairs into one map", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "myapp", "--no-git", "--meta", "app=myapp", "--meta", "page=settings"],
      false,
      noRun,
    );
    expect(puts[0].metadata).toEqual({ app: "myapp", page: "settings" });
  });

  it("splits a --meta value containing '=' on the first '=' only", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "myapp", "--no-git", "--meta", "url=https://x.test/a?b=c"],
      false,
      noRun,
    );
    expect(puts[0].metadata).toEqual({ url: "https://x.test/a?b=c" });
  });

  it("omits metadata entirely when --meta is not passed", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--repo", "myapp", "--no-git"], false, noRun);
    expect(puts[0].metadata).toBeUndefined();
  });

  it("rejects an invalid --meta key before uploading", async () => {
    const { client, puts } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), "--repo", "myapp", "--no-git", "--meta", "Bad-Key=x"],
        false,
        noRun,
      ),
    ).rejects.toThrow(UsageError);
    expect(puts).toEqual([]);
  });

  it("rejects a malformed --meta pair with no '='", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), [tmpFile(), "--meta", "noequals"], false, noRun),
    ).rejects.toThrow(UsageError);
  });
});

describe("runPut gh.* metadata (explicit target)", () => {
  it("stamps gh.* on the --pr path", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--pr", "128", "--repo", "o/r"], false, noRun);
    expect(puts[0].metadata).toMatchObject({
      "gh.repo": "o/r",
      "gh.kind": "pull",
      "gh.number": "128",
      "gh.ref": "o/r#128",
    });
  });

  it("stamps gh.kind=issue on the --issue path", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--issue", "7", "--repo", "o/r"], false, noRun);
    expect(puts[0].metadata).toMatchObject({ "gh.kind": "issue", "gh.number": "7" });
  });

  it("explicit target wins over a same-key --meta", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "9", "--repo", "o/r", "--meta", "gh.number=999"],
      false,
      noRun,
    );
    expect(puts[0].metadata!["gh.number"]).toBe("9");
  });
});

/**
 * Fake gh: answers `gh pr view` (branch→PR), `gh api` (classify), and the
 * gh.title lookup (`pr|issue view <num> --json title`) when `opts.title` is
 * set — otherwise it throws, same as gh being unable to resolve a title (the
 * default, so existing callers never see an unexpected gh.title).
 */
function ghRunner(opts: {
  pr?: number;
  classify?: "pull" | "issue";
  title?: string;
}): CommandRunner {
  return (cmd, args) => {
    if (cmd === "git" && args[0] === "rev-parse") return "feature/thing\n"; // current branch
    if (cmd === "gh" && args[0] === "repo") return "o/r\n"; // resolveRepo fallback
    if (
      cmd === "gh" &&
      (args[0] === "pr" || args[0] === "issue") &&
      args[1] === "view" &&
      args.includes("title")
    ) {
      if (opts.title !== undefined) return `${opts.title}\n`;
      throw new Error("gh: title not resolvable");
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      if (opts.pr) return `${opts.pr}\n`;
      throw new Error("no pull request found");
    }
    if (cmd === "gh" && args[0] === "api") return `${opts.classify ?? "pull"}\n`;
    throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
  };
}

describe("runPut auto gh.* metadata (default path)", () => {
  it("stamps the current branch PR on a plain put", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--repo", "o/r"], false, ghRunner({ pr: 481 }));
    expect(puts[0].key).toBeUndefined(); // still the screenshots default key
    expect(puts[0].metadata).toMatchObject({
      "gh.repo": "o/r",
      "gh.kind": "pull",
      "gh.number": "481",
      "gh.ref": "o/r#481",
    });
  });

  it("classifies a numeric --ref as an issue", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "o/r", "--ref", "700"],
      false,
      ghRunner({ classify: "issue" }),
    );
    expect(puts[0].metadata).toMatchObject({
      "gh.kind": "issue",
      "gh.number": "700",
      "gh.ref": "o/r#700",
    });
  });

  it("uploads without metadata when no PR resolves", async () => {
    const { client, puts } = fakeClient();
    const code = await runPut(ctxWith(client), [tmpFile(), "--repo", "o/r"], false, ghRunner({}));
    expect(code).toBe(0);
    expect(puts[0].metadata).toBeUndefined();
  });

  it("--no-auto suppresses auto resolution", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "o/r", "--no-auto"],
      false,
      ghRunner({ pr: 481 }),
    );
    expect(puts[0].metadata).toBeUndefined();
  });

  it("UPLOADS_NO_AUTO_META=1 suppresses auto resolution end-to-end", async () => {
    const prev = process.env.UPLOADS_NO_AUTO_META;
    process.env.UPLOADS_NO_AUTO_META = "1";
    try {
      const { client, puts } = fakeClient();
      await runPut(ctxWith(client), [tmpFile(), "--repo", "o/r"], false, ghRunner({ pr: 481 }));
      expect(puts[0].metadata).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.UPLOADS_NO_AUTO_META;
      else process.env.UPLOADS_NO_AUTO_META = prev;
    }
  });

  it("explicit --meta wins over auto-derived gh.*", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "o/r", "--meta", "gh.number=5"],
      false,
      ghRunner({ pr: 481 }),
    );
    expect(puts[0].metadata!["gh.number"]).toBe("5");
  });
});

describe("runPut gh.title metadata (issue #267)", () => {
  it("stamps gh.title on the explicit --pr path when the title resolves", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "128", "--repo", "o/r"],
      false,
      ghRunner({ title: "Fix the login bug" }),
    );
    expect(puts[0].metadata).toMatchObject({
      "gh.ref": "o/r#128",
      "gh.title": "Fix the login bug",
    });
  });

  it("omits gh.title on the explicit --pr path when it can't be resolved (never fails the upload)", async () => {
    const { client, puts } = fakeClient();
    const code = await runPut(
      ctxWith(client),
      [tmpFile(), "--pr", "128", "--repo", "o/r"],
      false,
      noRun,
    );
    expect(code).toBe(0);
    expect(puts[0].metadata!["gh.title"]).toBeUndefined();
    expect(puts[0].metadata!["gh.ref"]).toBe("o/r#128");
  });

  it("stamps gh.title on the auto-resolved path when the title resolves", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "o/r"],
      false,
      ghRunner({ pr: 481, title: "Add dark mode" }),
    );
    expect(puts[0].metadata).toMatchObject({ "gh.ref": "o/r#481", "gh.title": "Add dark mode" });
  });

  it("omits gh.title on the auto-resolved path when it can't be resolved", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [tmpFile(), "--repo", "o/r"], false, ghRunner({ pr: 481 }));
    expect(puts[0].metadata!["gh.title"]).toBeUndefined();
    expect(puts[0].metadata!["gh.ref"]).toBe("o/r#481");
  });
});

/** 21 distinct valid `--meta k=v` flags: 21 + 4 gh.* = 25, one over META_MAX_KEYS (24). */
function metaFlagsNearCap(): string[] {
  const flags: string[] = [];
  for (let i = 0; i < 21; i++) {
    flags.push("--meta", `k${i}=v${i}`);
  }
  return flags;
}

describe("runPut gh.* metadata cap enforcement", () => {
  it("explicit path throws when the merged map exceeds the key cap", async () => {
    const { client, puts } = fakeClient();
    await expect(
      runPut(
        ctxWith(client),
        [tmpFile(), ...metaFlagsNearCap(), "--pr", "9", "--repo", "o/r"],
        false,
        noRun,
      ),
    ).rejects.toThrow(UsageError);
    expect(puts).toEqual([]);
  });

  it("auto path drops gh.* and succeeds when the merged map exceeds the key cap", async () => {
    const { client, puts } = fakeClient();
    const code = await runPut(
      ctxWith(client),
      [tmpFile(), ...metaFlagsNearCap(), "--repo", "o/r"],
      false,
      ghRunner({ pr: 481 }),
    );
    expect(code).toBe(0);
    expect(puts[0].metadata).toBeDefined();
    expect(puts[0].metadata!["gh.repo"]).toBeUndefined();
    expect(puts[0].metadata!["k0"]).toBe("v0");
    expect(puts[0].metadata!["k20"]).toBe("v20");
    expect(Object.keys(puts[0].metadata!)).toHaveLength(21);
  });

  it("--auto cannot force auto resolution past --no-git", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--repo", "o/r", "--auto", "--no-git"],
      false,
      ghRunner({ pr: 481 }),
    );
    expect(puts[0].metadata).toBeUndefined();
  });

  it("--auto takes no value", async () => {
    const { client } = fakeClient();
    await expect(
      runPut(ctxWith(client), [tmpFile(), "--auto=1", "--repo", "o/r"], false, noRun),
    ).rejects.toThrow(UsageError);
  });
});

describe("runPut gh.* attach success note", () => {
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

  it("prints a success note when gh.* metadata is attached", async () => {
    const { client } = fakeClient();
    const output = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        ghRunner({ pr: 481 }),
      ),
    );
    expect(output).toContain("attached to o/r#481");
  });

  it("stays silent when no PR resolves", async () => {
    const { client } = fakeClient();
    const output = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        ghRunner({}),
      ),
    );
    expect(output).not.toContain("attached to");
  });
});

describe("stateAppMetaFromFlags", () => {
  it("maps --state and --app onto canonical keys", () => {
    const flags = new Map<string, string | boolean>([
      ["--state", "after"],
      ["--app", "web"],
    ]);
    expect(stateAppMetaFromFlags(flags)).toEqual({ state: "after", app: "web" });
  });

  it("rejects an invalid --state with a suggestion", () => {
    const flags = new Map<string, string | boolean>([["--state", "post"]]);
    expect(() => stateAppMetaFromFlags(flags)).toThrow(/did you mean "after"/);
  });

  it("returns an empty map when neither flag is present", () => {
    expect(stateAppMetaFromFlags(new Map())).toEqual({});
  });
});

describe("runPut canonical metadata flags", () => {
  it("stamps state and app as metadata", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--no-git", "--no-auto", "--state", "after", "--app", "web"],
      false,
      noRun,
    );
    expect(puts[0]?.metadata?.state).toBe("after");
    expect(puts[0]?.metadata?.app).toBe("web");
  });

  it("lets --state win over a --meta state pair", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [tmpFile(), "--no-git", "--no-auto", "--meta", "state=before", "--state", "after"],
      false,
      noRun,
    );
    expect(puts[0]?.metadata?.state).toBe("after");
  });

  it("rejects an invalid --state before uploading anything", async () => {
    const { client, puts } = fakeClient();
    await expect(
      runPut(ctxWith(client), [tmpFile(), "--no-git", "--state", "nope"], false, noRun),
    ).rejects.toThrow(UsageError);
    expect(puts).toHaveLength(0);
  });

  it("warns about a near-miss metadata key without rewriting it", async () => {
    const { client, puts } = fakeClient();
    const warnings: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      await runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--no-git", "--no-auto", "--meta", "route=/settings"],
        false,
        noRun,
      );
    } finally {
      vi.restoreAllMocks();
    }
    expect(warnings.join("")).toContain('did you mean "path"');
    // The caller's key is preserved verbatim — we nag, we never rewrite.
    expect(puts[0]?.metadata?.route).toBe("/settings");
    expect(puts[0]?.metadata?.path).toBeUndefined();
  });
});

/**
 * Fake gh/git runner for the bare-put nudge (issue #393). Each stage throws
 * when its corresponding option is omitted, mirroring the real degrade path
 * (not a git repo / detached HEAD / gh missing-unauthenticated-no PR).
 */
function nudgeRunner(opts: {
  branch?: string;
  defaultBranch?: string;
  originUrl?: string;
  repo?: string;
  pr?: number;
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
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      if (opts.pr === undefined) throw new Error("no pull request found");
      return `${opts.pr}\n`;
    }
    throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
  };
}

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

describe("runPut bare-put nudge (issue #393)", () => {
  const allClear = {
    branch: "feature/thing",
    defaultBranch: "main",
    originUrl: "git@github.com:o/r.git",
    repo: "o/r",
    pr: 123,
  };

  it("fires on stderr for a fully bare put with detectable branch/PR context", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner(allClear),
      ),
    );
    expect(stderr).toContain(
      "note: on branch feature/thing (PR #123 open) — rerun with --pr 123 for a stable key",
    );
    expect(stderr).toContain("uploads attach <file> --branch");
  });

  it("never writes the nudge to stdout", async () => {
    const { client } = fakeClient();
    const stdout = await captureStdout(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner(allClear),
      ),
    );
    expect(stdout).not.toContain("note:");
  });

  it("includes an additive JSON hint field when it fires", async () => {
    const { client } = fakeClient();
    const stdout = await captureStdout(() =>
      runPut(
        { ...ctxWith(client), quiet: false, json: true },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner(allClear),
      ),
    );
    const payload = JSON.parse(stdout) as { hint?: string; key: string; url: string };
    expect(payload.hint).toContain("PR #123 open");
    expect(payload.key).toBeDefined();
    expect(payload.url).toBeDefined();
  });

  it("omits the JSON hint field entirely when the nudge doesn't fire (on the default branch)", async () => {
    const { client } = fakeClient();
    const stdout = await captureStdout(() =>
      runPut(
        { ...ctxWith(client), quiet: false, json: true },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner({ ...allClear, branch: "main" }),
      ),
    );
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect("hint" in payload).toBe(false);
  });

  it("falls back to generic wording (no PR number) when the gh lookup fails", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner({
          branch: "feature/thing",
          defaultBranch: "main",
          originUrl: "git@github.com:o/r.git",
        }), // no pr
      ),
    );
    expect(stderr).toContain("note: on branch feature/thing — rerun with --pr <num>");
    expect(stderr).not.toContain("PR #");
  });

  it("gh timeout falls back to generic wording without changing exit code or upload behavior", async () => {
    const { client, puts } = fakeClient();
    const run: CommandRunner = (cmd, args) => {
      if (cmd === "git" && args[0] === "config") return "git@github.com:o/r.git\n";
      if (cmd === "git" && args[0] === "rev-parse") return "feature/thing\n";
      if (cmd === "git" && args[0] === "symbolic-ref") return "origin/main\n";
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        const err = new Error("ETIMEDOUT");
        (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
        throw err;
      }
      throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
    };
    const stderr = await captureStderr(async () => {
      const code = await runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        run,
      );
      expect(code).toBe(0);
    });
    expect(puts).toHaveLength(1);
    expect(stderr).toContain("note: on branch feature/thing — rerun with --pr <num>");
  });

  it("does not nudge with --pr", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--pr", "9", "--repo", "o/r"],
        false,
        nudgeRunner(allClear),
      ),
    );
    expect(stderr).not.toContain("note:");
  });

  it("does not nudge with --issue", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--issue", "9", "--repo", "o/r"],
        false,
        nudgeRunner(allClear),
      ),
    );
    expect(stderr).not.toContain("note:");
  });

  it("does not nudge with an explicit --key", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--key", "screenshots/x.png"],
        false,
        nudgeRunner(allClear),
      ),
    );
    expect(stderr).not.toContain("note:");
  });

  it("does not nudge with --no-git", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r", "--no-git"],
        false,
        noRun,
      ),
    );
    expect(stderr).not.toContain("note:");
  });

  it("does not nudge in quiet mode", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(ctxWith(client), [tmpFile(), "--repo", "o/r"], false, nudgeRunner(allClear)),
    );
    expect(stderr).not.toContain("note:");
  });

  it("does not nudge when UPLOADS_NO_NUDGE=1", async () => {
    const prev = process.env.UPLOADS_NO_NUDGE;
    process.env.UPLOADS_NO_NUDGE = "1";
    try {
      const { client } = fakeClient();
      const stderr = await captureStderr(() =>
        runPut(
          { ...ctxWith(client), quiet: false },
          [tmpFile(), "--repo", "o/r"],
          false,
          nudgeRunner(allClear),
        ),
      );
      expect(stderr).not.toContain("note:");
    } finally {
      if (prev === undefined) delete process.env.UPLOADS_NO_NUDGE;
      else process.env.UPLOADS_NO_NUDGE = prev;
    }
  });

  it("does not nudge on the default branch (remote HEAD resolved)", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner({ ...allClear, branch: "main" }),
      ),
    );
    expect(stderr).not.toContain("note:");
  });

  it("does not nudge on main when the default branch can't be determined (errs toward not nudging)", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner({ branch: "main", originUrl: "git@github.com:o/r.git", repo: "o/r", pr: 1 }),
      ),
    );
    expect(stderr).not.toContain("note:");
  });

  it("still nudges on a non-main/master branch when the default branch can't be determined", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner({
          branch: "feature/thing",
          originUrl: "git@github.com:o/r.git",
          repo: "o/r",
          pr: 7,
        }),
      ),
    );
    expect(stderr).toContain("note: on branch feature/thing (PR #7 open)");
  });

  it("does not nudge on detached HEAD", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner({ defaultBranch: "main", repo: "o/r", pr: 1 }), // no branch → git rev-parse throws
      ),
    );
    expect(stderr).not.toContain("note:");
  });

  it("does not nudge outside a git repo", async () => {
    const { client } = fakeClient();
    const stderr = await captureStderr(() =>
      runPut(
        { ...ctxWith(client), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        nudgeRunner({ branch: "feature/thing" }), // no originUrl → deriveRepoFromGit fails
      ),
    );
    expect(stderr).not.toContain("note:");
  });
});

describe("put promotes EXIF facts", () => {
  async function retinaPng(): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp({
      create: { width: 1624, height: 1154, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .withMetadata({ density: 144 })
      .png()
      .toBuffer();
  }

  function fileWith(bytes: Buffer): string {
    const dir = mkdtempSync(join(tmpdir(), "uploads-exif-"));
    const file = join(dir, "shot.png");
    writeFileSync(file, bytes);
    return file;
  }

  it("stamps viewport from a retina PNG's density", async () => {
    const { client, puts } = fakeClient();
    await runPut(ctxWith(client), [fileWith(await retinaPng()), "--no-git"], false, noRun);
    expect(puts[0]?.metadata?.viewport).toBe("812x577@2x");
  });

  it("lets an explicit --meta viewport win", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [fileWith(await retinaPng()), "--no-git", "--meta", "viewport=1x1@1x"],
      false,
      noRun,
    );
    expect(puts[0]?.metadata?.viewport).toBe("1x1@1x");
  });

  // Undefined (not {}) matters: apps/api/src/files-core.ts:313 full-replaces a
  // key's metadata whenever any is sent, so derived facts make a previously
  // metadata-free re-upload start replacing. --no-auto is the opt-out for
  // callers who curate metadata with `uploads meta set` and re-upload.
  it("derives nothing when --no-auto opts out", async () => {
    const { client, puts } = fakeClient();
    await runPut(
      ctxWith(client),
      [fileWith(await retinaPng()), "--no-git", "--no-auto"],
      false,
      noRun,
    );
    expect(puts[0]?.metadata).toBeUndefined();
  });

  it("does not leak one file's facts onto another's upload", async () => {
    const { client, puts } = fakeClient();
    const sharp = (await import("sharp")).default;
    const plain = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .withMetadata({ density: 72 })
      .png()
      .toBuffer();
    const dir = mkdtempSync(join(tmpdir(), "uploads-exif-multi-"));
    const retinaFile = join(dir, "retina.png");
    const plainFile = join(dir, "plain.png");
    writeFileSync(retinaFile, await retinaPng());
    writeFileSync(plainFile, plain);
    await runPut(ctxWith(client), [retinaFile, plainFile, "--no-git"], false, noRun);
    // The optimizer rewrites PNG → WebP, so uploads land under .webp names.
    const byName = new Map(puts.map((p) => [p.filename, p.metadata]));
    expect(byName.get("retina.webp")?.viewport).toBe("812x577@2x");
    expect(byName.get("plain.webp")?.viewport).toBeUndefined();
  });
});
