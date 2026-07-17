import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { ATTACHMENTS_MARKER, type GhTarget } from "../src/github.js";
import {
  classifyGhNumber,
  resolveCurrentPullRequest,
  resolveRepo,
  upsertAttachmentsComment,
  type CommandRunner,
} from "../src/github-gh.js";

/** Fake runner: matches on command name, records calls. */
function fakeRunner(handlers: Record<string, (args: string[], input?: string) => string>) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const run: CommandRunner = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const handler = handlers[cmd];
    if (!handler) throw new Error(`command not found: ${cmd}`);
    return handler(args, input);
  };
  return { run, calls };
}

describe("resolveRepo", () => {
  it("validates and returns an explicit --repo", () => {
    const { run } = fakeRunner({});
    expect(resolveRepo("buildinternet/uploads", run)).toBe("buildinternet/uploads");
  });

  it("rejects a bare --repo name", () => {
    const { run } = fakeRunner({});
    expect(() => resolveRepo("uploads", run)).toThrow(UsageError);
  });

  it("prefers gh repo view", () => {
    const { run } = fakeRunner({
      gh: () => "buildinternet/uploads\n",
    });
    expect(resolveRepo(undefined, run)).toBe("buildinternet/uploads");
  });

  it("falls back to the git remote when gh fails", () => {
    const { run } = fakeRunner({
      gh: () => {
        throw new Error("gh: not logged in");
      },
      git: () => "git@github.com:buildinternet/uploads.git\n",
    });
    expect(resolveRepo(undefined, run)).toBe("buildinternet/uploads");
  });

  it("throws UsageError when nothing resolves", () => {
    const { run } = fakeRunner({});
    expect(() => resolveRepo(undefined, run)).toThrow(UsageError);
  });
});

describe("resolveCurrentPullRequest", () => {
  it("passes the current branch as the selector so --repo stays honored", () => {
    const { run, calls } = fakeRunner({
      git: (args) => {
        expect(args).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
        return "feature/thing\n";
      },
      gh: () => "208\n",
    });
    expect(resolveCurrentPullRequest("buildinternet/uploads", run)).toEqual({
      repo: "buildinternet/uploads",
      kind: "pull",
      num: 208,
    });
    const gh = calls.find((c) => c.cmd === "gh");
    expect(gh?.args).toEqual([
      "pr",
      "view",
      "feature/thing",
      "--repo",
      "buildinternet/uploads",
      "--json",
      "number",
      "--jq",
      ".number",
    ]);
  });

  it("throws UsageError on a detached HEAD instead of calling gh", () => {
    const { run, calls } = fakeRunner({
      git: () => "HEAD\n",
      gh: () => "1\n",
    });
    expect(() => resolveCurrentPullRequest("o/r", run)).toThrow(UsageError);
    expect(calls.some((c) => c.cmd === "gh")).toBe(false);
  });

  it("throws UsageError when gh finds no PR for the branch", () => {
    const { run } = fakeRunner({
      git: () => "feature/thing\n",
      gh: () => {
        throw new Error("no pull requests found for branch");
      },
    });
    expect(() => resolveCurrentPullRequest("o/r", run)).toThrow(/could not infer a pull request/);
  });
});

describe("upsertAttachmentsComment", () => {
  const target: GhTarget = { repo: "o/r", kind: "pull", num: 5 };

  it("creates a comment when no managed comment exists", () => {
    const { run, calls } = fakeRunner({
      gh: (args) => {
        if (args[1]?.includes("/comments?per_page=100")) {
          return JSON.stringify([{ id: 1, body: "unrelated comment" }]);
        }
        return JSON.stringify({ id: 99 });
      },
    });
    const result = upsertAttachmentsComment(target, `${ATTACHMENTS_MARKER}\nbody`, run);
    expect(result.created).toBe(true);
    const post = calls[1];
    expect(post.args).toContain("repos/o/r/issues/5/comments");
    expect(post.args).toContain("body=@-");
    expect(post.input).toContain(ATTACHMENTS_MARKER);
  });

  it("PATCHes the existing managed comment in place", () => {
    const { run, calls } = fakeRunner({
      gh: (args) => {
        if (args[1]?.includes("/comments?per_page=100")) {
          return JSON.stringify([
            { id: 1, body: "unrelated" },
            { id: 42, body: `${ATTACHMENTS_MARKER}\nold body` },
          ]);
        }
        return JSON.stringify({ id: 42 });
      },
    });
    const result = upsertAttachmentsComment(target, `${ATTACHMENTS_MARKER}\nnew body`, run);
    expect(result.created).toBe(false);
    const patch = calls[1];
    expect(patch.args).toContain("repos/o/r/issues/comments/42");
    expect(patch.args).toContain("PATCH");
    expect(patch.input).toContain("new body");
  });
});

describe("classifyGhNumber", () => {
  it("classifies a pull request", () => {
    const run: CommandRunner = (cmd, args) => {
      expect(cmd).toBe("gh");
      expect(args).toContain("repos/o/r/issues/280");
      return "pull\n";
    };
    expect(classifyGhNumber("o/r", 280, run)).toEqual({ repo: "o/r", kind: "pull", num: 280 });
  });

  it("classifies an issue (GhTarget.kind is 'issues')", () => {
    const run: CommandRunner = () => "issue\n";
    expect(classifyGhNumber("o/r", 700, run)).toEqual({ repo: "o/r", kind: "issues", num: 700 });
  });

  it("returns undefined when gh throws", () => {
    const run: CommandRunner = () => {
      throw new Error("gh: Not Found");
    };
    expect(classifyGhNumber("o/r", 999, run)).toBeUndefined();
  });

  it("returns undefined on unexpected output", () => {
    const run: CommandRunner = () => "weird\n";
    expect(classifyGhNumber("o/r", 1, run)).toBeUndefined();
  });
});
