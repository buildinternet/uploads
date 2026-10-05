/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { isInFeedScope, type FeedScope } from "@uploads/comment-render/scope";
import { getMetadataForKeys, replaceFileMetadata } from "../src/file-metadata";
import { scanScopeKeys } from "../src/pr-scope";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260713210559_file_metadata.sql"];
const WS = "acme";

// Every shape a comment item's metadata can take. The comment path trusts
// isInFeedScope to predict scope membership; a disagreement means a /c/
// item link that 404s, or a /f/ link where a /c/ one belongs.
const ROWS: Array<[string, Record<string, string>]> = [
  ["gh/acme/web/pull/12/in.png", { "gh.repo": "acme/web", "gh.number": "12" }],
  ["gh/acme/web/pull/12/moved.png", { "gh.repo": "acme/web", "gh.number": "13" }],
  [
    "gh/acme/web/pull/12/promoted.png",
    { "gh.repo": "acme/web", "gh.number": "12", "gh.status": "promoted" },
  ],
  ["gh/acme/web/pull/12/other-repo.png", { "gh.repo": "acme/api", "gh.number": "12" }],
  ["gh/acme/web/pull/12/mixed-case.png", { "gh.repo": "Acme/Web", "gh.number": "12" }],
  ["gh/acme/web/pull/12/no-number.png", { "gh.repo": "acme/web" }],
  ["gh/acme/web/pull/12/untagged.png", { path: "/settings" }],
];

describe("feed scope predicate parity with the scope query", () => {
  const scopes: FeedScope[] = [{ repo: "acme/web", number: 12 }, { repo: "acme/web" }];

  it.each(scopes)("isInFeedScope matches scanScopeKeys for %o", async (scope) => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      for (const [key, meta] of ROWS) await replaceFileMetadata(db, WS, key, meta);
      const scanned = (await scanScopeKeys(db, { workspace: WS, ...scope })).map((i) => i.key);
      const keys = ROWS.map(([key]) => key);
      const metaByKey = await getMetadataForKeys(db, WS, keys);
      const predicted = keys.filter((key) => isInFeedScope(metaByKey.get(key) ?? {}, scope));
      expect([...predicted].sort()).toEqual([...scanned].sort());
    } finally {
      sqlite.close();
    }
  });
});
