/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { setFileMetadata } from "../src/file-metadata";
import { recentStagedBranches } from "../src/staged-scopes";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20261004120200_file_metadata_gh_repo_idx.sql",
];

async function stage(
  db: ReturnType<typeof database>,
  key: string,
  branch: string,
  status = "staged",
  workspace = "alpha",
) {
  await setFileMetadata(db, workspace, key, {
    "gh.repo": "acme/web",
    "gh.kind": "branch",
    "gh.branch": branch,
    "gh.status": status,
  });
}

describe("recentStagedBranches", () => {
  it("lists other still-staged branches in the repo with their staged spelling", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await stage(db, "gh/acme/web/branch/Old-Name/a.png", "old-name");
      await stage(db, "gh/acme/web/branch/Old-Name/b.png", "old-name");
      await stage(db, "gh/acme/web/branch/head/c.png", "head");
      await stage(db, "gh/acme/web/branch/done/d.png", "done", "promoted");
      await stage(db, "gh/private/abc/branch/e.png", "secret/x");
      await stage(db, "gh/acme/web/branch/other-ws/f.png", "other-ws", "staged", "beta");
      const env = { DB: db } as unknown as Env;

      const found = await recentStagedBranches(env, "alpha", "Acme/Web", { exclude: "HEAD" });
      expect(found).toHaveLength(2);
      expect(found).toEqual(
        expect.arrayContaining([
          { branch: "Old-Name", files: 2 },
          { branch: "secret/x", files: 1 },
        ]),
      );
    } finally {
      sqlite.close();
    }
  });

  it("ignores files staged more than a week ago", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      await stage(db, "gh/acme/web/branch/old/a.png", "old");
      const env = { DB: db } as unknown as Env;
      const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
      await expect(recentStagedBranches(env, "alpha", "acme/web", { now: later })).resolves.toEqual(
        [],
      );
    } finally {
      sqlite.close();
    }
  });
});
