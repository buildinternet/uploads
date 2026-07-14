import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { UploadsError } from "../src/errors.js";
import type { UploadsClient } from "../src/client.js";
import { runPut, type CliContext } from "../src/commands.js";
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

/** Fake gh: answers `gh pr view` (branch→PR) and `gh api` (classify). */
function ghRunner(opts: { pr?: number; classify?: "pull" | "issue" }): CommandRunner {
  return (cmd, args) => {
    if (cmd === "gh" && args[0] === "repo") return "o/r\n"; // resolveRepo fallback
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
  it("prints a success note when gh.* metadata is attached, silent on skip", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { client: attachedClient } = fakeClient();
      await runPut(
        { ...ctxWith(attachedClient), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        ghRunner({ pr: 481 }),
      );
      const attachedOutput = writeSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(attachedOutput).toContain("attached to o/r#481");

      writeSpy.mockClear();

      const { client: skippedClient } = fakeClient();
      await runPut(
        { ...ctxWith(skippedClient), quiet: false },
        [tmpFile(), "--repo", "o/r"],
        false,
        ghRunner({}),
      );
      const skippedOutput = writeSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(skippedOutput).not.toContain("attached to");
    } finally {
      writeSpy.mockRestore();
    }
  });
});
