import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "../src/comment-render.generated.js";
import { buildScreenshotKey, deriveRepoFromGit, deriveRepoSlugFromGit } from "../src/keys.js";

describe("deriveRepoFromGit (injectable run, issue #393)", () => {
  it("parses the repo name from an SSH remote via an injected runner", () => {
    const run = (cmd: string, args: string[]) => {
      expect(cmd).toBe("git");
      expect(args).toEqual(["config", "--get", "remote.origin.url"]);
      return "git@github.com:buildinternet/uploads.git\n";
    };
    expect(deriveRepoFromGit(run)).toBe("uploads");
  });

  it("returns undefined when the injected runner throws (not a git repo / no origin)", () => {
    const run = () => {
      throw new Error("fatal: not a git repository");
    };
    expect(deriveRepoFromGit(run)).toBeUndefined();
  });

  it("returns undefined when the remote URL doesn't match the expected shape", () => {
    const run = () => "not-a-url\n";
    expect(deriveRepoFromGit(run)).toBeUndefined();
  });
});

describe("deriveRepoSlugFromGit", () => {
  it("parses ssh and https remotes to a lowercase owner/name slug", () => {
    expect(deriveRepoSlugFromGit(() => "git@github.com:BuildInternet/Uploads.git\n")).toBe(
      "buildinternet/uploads",
    );
    expect(deriveRepoSlugFromGit(() => "https://github.com/acme/web\n")).toBe("acme/web");
  });
  it("returns undefined when git fails or the remote is unparseable", () => {
    expect(
      deriveRepoSlugFromGit(() => {
        throw new Error("not a git repo");
      }),
    ).toBeUndefined();
    expect(deriveRepoSlugFromGit(() => "not-a-remote")).toBeUndefined();
  });
});

describe("sanitizeFilename", () => {
  it("keeps only the final extension dot", () => {
    expect(sanitizeFilename("127.0.0.1-admin-classifier.webp")).toBe(
      "127-0-0-1-admin-classifier.webp",
    );
    expect(sanitizeFilename("archive.tar.gz")).toBe("archive-tar.gz");
  });
  it("collapses special characters and runs to one dash and trims the edges", () => {
    expect(sanitizeFilename("my shot (1).png")).toBe("my-shot-1.png");
    expect(sanitizeFilename("  Hero — final!!.PNG")).toBe("Hero-final.PNG");
    expect(sanitizeFilename("a---b__c.png")).toBe("a-b__c.png");
    expect(sanitizeFilename("café ☕.jpg")).toBe("caf.jpg");
  });
  it("falls back to `file` when nothing survives", () => {
    expect(sanitizeFilename("!!!.png")).toBe("file.png");
    expect(sanitizeFilename("")).toBe("file");
  });
  it("treats leading and trailing dots as not an extension", () => {
    expect(sanitizeFilename(".env")).toBe("env");
    expect(sanitizeFilename("notes.")).toBe("notes");
  });
  it("is idempotent", () => {
    for (const name of ["127.0.0.1-admin.webp", "my shot (1).png", "a.b.c", ".env", "x"]) {
      const once = sanitizeFilename(name);
      expect(sanitizeFilename(once)).toBe(once);
    }
  });
});

describe("buildScreenshotKey filename shaping", () => {
  it("dashes interior dots in the stem before the hash suffix", async () => {
    const key = await buildScreenshotKey({
      filename: "127.0.0.1-admin.webp",
      fileBytes: new Uint8Array([1, 2, 3]),
      repo: "uploads",
      ref: "2026-10-18",
    });
    expect(key).toMatch(/^screenshots\/uploads\/2026-10-18\/127-0-0-1-admin-[0-9a-f]{6}\.webp$/);
  });
});
