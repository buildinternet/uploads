import { describe, expect, it } from "vitest";
import { deriveRepoFromGit } from "../src/keys.js";

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
