/**
 * Promote's branch-rename lineage sweep (#920): plain and private prefixes
 * for every older name the branch has had, current-name-wins dedupe, the
 * `lineage` field, and the untouched no-rename baseline.
 */
import { describe, expect, it } from "vitest";
import { getFileMetadata, replaceFileMetadata } from "./file-metadata";
import { recordBranchRename } from "./github-branch-renames";
import { ghPrivateAttachmentKey, ghPrivateBranchAttachmentKey } from "./github-comment-render";
import { getOrMintPrefixId } from "./github-private-prefixes";
import { promoteBranchAttachments } from "./github-promote";
import { recordRepoLink } from "./github-repo-links";
import { sha256Hex, type WorkspaceRecord } from "./workspace";
import { FakeKv } from "../test/fake-kv";
import { FakeR2Bucket } from "../test/fake-r2";
import { UsageFakeD1 } from "../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";

const WS = "acme";
const PREFIX = "acme/";
const REPO = "acme/web";
const OLD_BRANCH = "feat-old";
const NEW_BRANCH = "feat-new";
const NUM = 7;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function stagedKey(branch: string, filename: string): string {
  return `gh/acme/web/branch/${branch}/${filename}`;
}
function destKey(filename: string): string {
  return `gh/acme/web/pull/${NUM}/${filename}`;
}

interface Seeded {
  env: Env;
  db: UsageFakeD1;
  bucket: FakeR2Bucket;
  ws: WorkspaceRecord;
}

async function seededEnv(opts: { isPrivate?: boolean } = {}): Promise<Seeded> {
  const ws: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: PREFIX,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex("unused"), createdAt: new Date().toISOString() }],
  };
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  const githubCache = new FakeKv();
  githubCache.store.set(`ghinst:${REPO}`, { value: "42" });
  githubCache.store.set(`ghpriv:${REPO}`, { value: opts.isPrivate ? "1" : "0" });
  await recordRepoLink(db as unknown as D1Database, REPO, WS, "test");
  const env = {
    DB: db,
    UPLOADS_DEFAULT: bucket,
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  return { env, db, bucket, ws };
}

async function seedAt(seeded: Seeded, key: string, branch: string) {
  await seeded.bucket.put(`${PREFIX}${key}`, PNG, { httpMetadata: { contentType: "image/png" } });
  await replaceFileMetadata(seeded.env.DB, WS, key, {
    "gh.repo": REPO,
    "gh.kind": "branch",
    "gh.branch": branch,
    "gh.staged-at": new Date().toISOString(),
  });
}

const renamed = (seeded: Seeded, from: string, to: string) =>
  recordBranchRename(seeded.env.DB as unknown as D1Database, {
    workspace: WS,
    repo: REPO,
    from,
    to,
    source: "cli-reflog",
  });

function promote(seeded: Seeded, branch: string) {
  return promoteBranchAttachments(seeded.env, seeded.ws, WS, { repo: REPO, num: NUM, branch });
}

describe("promoteBranchAttachments — rename lineage (#920)", () => {
  it("with an empty rename table nothing changes and no lineage is reported", async () => {
    const seeded = await seededEnv();
    await seedAt(seeded, stagedKey(NEW_BRANCH, "hero.png"), NEW_BRANCH);

    const result = await promote(seeded, NEW_BRANCH);

    expect(result).toEqual({ promoted: [destKey("hero.png")], skipped: [] });
    expect("lineage" in result).toBe(false);
  });

  it("sweeps the plain prefix of an older name and reports the lineage", async () => {
    const seeded = await seededEnv();
    await seedAt(seeded, stagedKey(OLD_BRANCH, "old.png"), OLD_BRANCH);
    await seedAt(seeded, stagedKey(NEW_BRANCH, "new.png"), NEW_BRANCH);
    await renamed(seeded, OLD_BRANCH, NEW_BRANCH);

    const result = await promote(seeded, NEW_BRANCH);

    expect(result.skipped).toEqual([]);
    expect([...result.promoted].sort()).toEqual([destKey("new.png"), destKey("old.png")].sort());
    expect(result.lineage).toEqual([NEW_BRANCH, OLD_BRANCH]);
    // The staged original under the OLD name is tagged promoted like any other.
    expect(
      (await getFileMetadata(seeded.env.DB, WS, stagedKey(OLD_BRANCH, "old.png")))["gh.status"],
    ).toBe("promoted");
  });

  it("follows a chained rename across two hops", async () => {
    const seeded = await seededEnv();
    await seedAt(seeded, stagedKey("a", "a.png"), "a");
    await seedAt(seeded, stagedKey("b", "b.png"), "b");
    await seedAt(seeded, stagedKey("c", "c.png"), "c");
    await renamed(seeded, "a", "b");
    await renamed(seeded, "b", "c");

    const result = await promote(seeded, "c");

    expect(result.lineage).toEqual(["c", "b", "a"]);
    expect([...result.promoted].sort()).toEqual(
      [destKey("a.png"), destKey("b.png"), destKey("c.png")].sort(),
    );
  });

  it("private mode sweeps an older name's EXISTING private prefix and never mints one", async () => {
    const seeded = await seededEnv({ isPrivate: true });
    const oldPrefixId = await getOrMintPrefixId(
      seeded.db as unknown as D1Database,
      REPO,
      OLD_BRANCH,
    );
    const oldKey = ghPrivateBranchAttachmentKey(oldPrefixId, "old.png");
    await seedAt(seeded, oldKey, OLD_BRANCH);
    await renamed(seeded, OLD_BRANCH, NEW_BRANCH);
    // A third name nothing was ever staged under: promote must not mint a
    // private prefix id for it.
    await renamed(seeded, "never-used", OLD_BRANCH);
    const mintedBefore = new Set(
      [...seeded.db.privatePrefixes.values()].map((row) => `${row.branch}:${row.prefix_id}`),
    );

    const result = await promote(seeded, NEW_BRANCH);

    const newPrefixId = await getOrMintPrefixId(
      seeded.db as unknown as D1Database,
      REPO,
      NEW_BRANCH,
    );
    // Destination follows the CURRENT name's private prefix, not the old one's.
    expect(result.promoted).toEqual([
      ghPrivateAttachmentKey(newPrefixId, { repo: REPO, kind: "pull", num: NUM }, "old.png"),
    ]);
    expect(result.lineage).toEqual([NEW_BRANCH, OLD_BRANCH, "never-used"]);
    // Only the current branch's id was minted during the promote — the
    // never-staged older name got none.
    const mintedAfter = [...seeded.db.privatePrefixes.values()].filter(
      (row) => !mintedBefore.has(`${row.branch}:${row.prefix_id}`),
    );
    expect(mintedAfter.map((row) => row.branch)).toEqual([NEW_BRANCH]);
  });

  it("the current name wins a same-filename tie with an older name, including over a private older copy", async () => {
    const seeded = await seededEnv({ isPrivate: true });
    const oldPrefixId = await getOrMintPrefixId(
      seeded.db as unknown as D1Database,
      REPO,
      OLD_BRANCH,
    );
    const oldPrivateKey = ghPrivateBranchAttachmentKey(oldPrefixId, "dup.png");
    await seedAt(seeded, oldPrivateKey, OLD_BRANCH);
    await seedAt(seeded, stagedKey(NEW_BRANCH, "dup.png"), NEW_BRANCH);
    await renamed(seeded, OLD_BRANCH, NEW_BRANCH);

    const result = await promote(seeded, NEW_BRANCH);

    const newPrefixId = await getOrMintPrefixId(
      seeded.db as unknown as D1Database,
      REPO,
      NEW_BRANCH,
    );
    const expectedDest = ghPrivateAttachmentKey(
      newPrefixId,
      { repo: REPO, kind: "pull", num: NUM },
      "dup.png",
    );
    // Exactly one copy, and it came from the CURRENT name even though the
    // older name's copy sat under a private prefix (which outranks plain
    // only WITHIN one lineage position).
    expect(result.promoted).toEqual([expectedDest]);
    expect(result.skipped).toEqual([]);
    const winnerMeta = await getFileMetadata(seeded.env.DB, WS, stagedKey(NEW_BRANCH, "dup.png"));
    expect(winnerMeta["gh.status"]).toBe("promoted");
    // The losing older duplicate is still tagged, not left as an orphan.
    expect((await getFileMetadata(seeded.env.DB, WS, oldPrivateKey))["gh.status"]).toBe("promoted");
  });

  it("stops listing once the sweep's entry budget is spent, keeping the current name's files", async () => {
    const seeded = await seededEnv();
    // A 16-link rename chain (the depth cap trims the lineage to 9 names),
    // each name's plain prefix holding 20 staged files — 180 entries if the
    // sweep listed every name it resolved.
    const names = Array.from({ length: 16 }, (_, i) => `n${i}`);
    for (const [index, branch] of names.entries()) {
      for (let f = 0; f < 20; f++) {
        await seedAt(seeded, stagedKey(branch, `${branch}-${f}.png`), branch);
      }
      if (index > 0) await renamed(seeded, branch, names[index - 1]);
    }
    seeded.bucket.listCalls = 0;

    const result = await promote(seeded, names[0]);

    // LIST_ENTRY_BUDGET (PROMOTE_STAGED_CAP * 2 = 100) is reached after the
    // 5th name's page — one list call per name, then the sweep stops rather
    // than walking all 9 (and far short of the 100-page ceiling).
    expect(seeded.bucket.listCalls).toBe(5);
    expect(result.lineage).toHaveLength(9); // depth cap: the branch + 8 hops
    // The current name is listed first, so it keeps every slot it needs: all
    // 20 of its files promoted, the overflow reported as cap_exceeded.
    expect(result.promoted).toHaveLength(50);
    expect(result.promoted.filter((key) => key.includes(`${names[0]}-`))).toHaveLength(20);
    expect(result.skipped).toHaveLength(50);
    expect(new Set(result.skipped.map((s) => s.reason))).toEqual(new Set(["cap_exceeded"]));
  });

  it("a lineage lookup failure degrades to the current name only", async () => {
    const seeded = await seededEnv();
    await seedAt(seeded, stagedKey(OLD_BRANCH, "old.png"), OLD_BRANCH);
    await seedAt(seeded, stagedKey(NEW_BRANCH, "new.png"), NEW_BRANCH);
    await renamed(seeded, OLD_BRANCH, NEW_BRANCH);

    const throwingDb = new Proxy(seeded.db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("github_branch_renames")) throw new Error("simulated D1 outage");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = await promoteBranchAttachments(
      { ...seeded.env, DB: throwingDb } as unknown as Env,
      seeded.ws,
      WS,
      { repo: REPO, num: NUM, branch: NEW_BRANCH },
    );

    expect(result).toEqual({ promoted: [destKey("new.png")], skipped: [] });
  });
});
