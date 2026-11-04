import { describe, expect, it } from "vitest";
import type { FindFilesItem, UploadsClient } from "../src/client.js";
import {
  otherStagedBranches,
  otherStagedBranchesNote,
  putStagingNoteText,
} from "../src/commands.js";
import { upstreamGone, type CommandRunner } from "../src/github-gh.js";

function trackRunner(track: string | Error): CommandRunner {
  return (cmd, args) => {
    if (cmd === "git" && args[0] === "for-each-ref") {
      if (track instanceof Error) throw track;
      return `${track}\n`;
    }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
}

function staged(key: string, branch: string, stagedAt: string): FindFilesItem {
  return {
    key,
    url: null,
    metadata: { "gh.branch": branch, "gh.staged-at": stagedAt, "gh.status": "staged" },
  };
}

function clientWith(items: FindFilesItem[] | Error): {
  client: UploadsClient;
  filters: Record<string, string>[];
} {
  const filters: Record<string, string>[] = [];
  const client = {
    findFilesAll: async (f: Record<string, string>) => {
      filters.push(f);
      if (items instanceof Error) throw items;
      return { items, cursor: null };
    },
  } as unknown as UploadsClient;
  return { client, filters };
}

describe("upstreamGone", () => {
  it("is true only when git reports the upstream as gone", () => {
    expect(upstreamGone(trackRunner("[gone]"), "feat")).toBe(true);
    expect(upstreamGone(trackRunner("[ahead 1]"), "feat")).toBe(false);
    expect(upstreamGone(trackRunner(""), "feat")).toBe(false);
    expect(upstreamGone(trackRunner(new Error("not a repo")), "feat")).toBe(false);
  });
});

describe("putStagingNoteText", () => {
  it("keeps the auto-attach note while the upstream exists", () => {
    expect(putStagingNoteText("feat", trackRunner(""))).toContain("auto-comments");
  });

  it("swaps in the --from-branch recovery line when the upstream is gone", () => {
    const note = putStagingNoteText("feat", trackRunner("[gone]"));
    expect(note).toContain("upstream is gone");
    expect(note).toContain("--from-branch feat");
  });
});

describe("otherStagedBranches", () => {
  it("groups other staged branches, newest first, keeping the staged spelling", async () => {
    const { client, filters } = clientWith([
      staged("gh/o/r/branch/Old-Name/a.png", "old-name", "2026-11-03T10:00:00Z"),
      staged("gh/o/r/branch/Old-Name/b.png", "old-name", "2026-11-04T10:00:00Z"),
      staged("gh/o/r/branch/stale/c.png", "stale", "2026-10-01T10:00:00Z"),
      staged("gh/private/abc123/branch/d.png", "secret/branch", "2026-11-02T10:00:00Z"),
      staged("gh/o/r/branch/new-name/e.png", "new-name", "2026-11-04T11:00:00Z"),
    ]);
    expect(await otherStagedBranches(client, "O/R", "New-Name")).toEqual([
      { branch: "Old-Name", files: 2 },
      { branch: "secret/branch", files: 1 },
      { branch: "stale", files: 1 },
    ]);
    expect(filters).toEqual([{ "gh.repo": "o/r", "gh.kind": "branch", "gh.status": "staged" }]);
  });

  it("returns nothing when the lookup fails", async () => {
    const { client } = clientWith(new Error("offline"));
    expect(await otherStagedBranches(client, "o/r", "feat")).toEqual([]);
  });

  it("names the newest branch in the recovery command", () => {
    const note = otherStagedBranchesNote(
      [
        { branch: "old-name", files: 2 },
        { branch: "stale", files: 1 },
      ],
      { repo: "o/r", kind: "pull", num: 12 },
    );
    expect(note).toContain("old-name (2 files), stale (1 file)");
    expect(note).toContain("uploads attach --pr 12 --from-branch old-name");
  });
});
