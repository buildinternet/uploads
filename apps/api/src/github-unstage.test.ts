import { NotFoundError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import { getFileMetadata, replaceFileMetadata } from "./file-metadata";
import { ghPrivateBranchAttachmentKey } from "./github-comment-render";
import { getOrMintPrefixId } from "./github-private-prefixes";
import { unstageGithubFiles } from "./github-unstage";
import { recordRepoLink } from "./github-repo-links";
import { sha256Hex, type WorkspaceRecord } from "./workspace";
import { FakeKv } from "../test/fake-kv";
import { FakeR2Bucket } from "../test/fake-r2";
import { UsageFakeD1 } from "../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";

const WS = "acme";
const PREFIX = "acme/";
const REPO = "acme/web";
const BRANCH = "feat-x";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function stagedKey(filename: string): string {
  return `gh/acme/web/branch/${BRANCH}/${filename}`;
}

async function seededEnv(isPrivate: boolean) {
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
  githubCache.store.set(`ghpriv:${REPO}`, { value: isPrivate ? "1" : "0" });
  await recordRepoLink(db as unknown as D1Database, REPO, WS, "test");
  const env = {
    DB: db,
    UPLOADS_DEFAULT: bucket,
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  return { env, db, bucket, ws };
}

async function seed(
  seeded: Awaited<ReturnType<typeof seededEnv>>,
  key: string,
  meta: Record<string, string>,
) {
  await seeded.bucket.put(`${PREFIX}${key}`, PNG, {
    httpMetadata: { contentType: "image/png" },
  });
  await replaceFileMetadata(seeded.env.DB, WS, key, meta);
}

const stagedMeta = (extra: Record<string, string> = {}) => ({
  "gh.repo": REPO,
  "gh.kind": "branch",
  "gh.branch": BRANCH,
  "gh.status": "staged",
  ...extra,
});

describe("unstageGithubFiles", () => {
  it("clears a public branch and leaves promoted and other-branch files", async () => {
    const seeded = await seededEnv(false);
    await seed(seeded, stagedKey("keep.png"), stagedMeta());
    await seed(seeded, stagedKey("done.png"), stagedMeta({ "gh.status": "promoted" }));
    await seed(
      seeded,
      stagedKey("other.png"),
      stagedMeta({ "gh.branch": "other", "gh.status": "staged" }),
    );

    const result = await unstageGithubFiles(seeded.env, seeded.ws, WS, {
      repo: REPO,
      branch: BRANCH,
    });

    expect(result.dryRun).toBe(false);
    expect(result.files.map((file) => file.key)).toEqual([stagedKey("keep.png")]);
    expect(result.files[0]?.action).toBe("unstaged");
    expect((await getFileMetadata(seeded.env.DB, WS, stagedKey("keep.png")))["gh.status"]).toBe(
      "unstaged",
    );
    expect((await getFileMetadata(seeded.env.DB, WS, stagedKey("done.png")))["gh.status"]).toBe(
      "promoted",
    );
    expect(seeded.bucket.store.has(`${PREFIX}${stagedKey("keep.png")}`)).toBe(true);
  });

  it("dry-run reports the file and does not write", async () => {
    const seeded = await seededEnv(false);
    await seed(seeded, stagedKey("keep.png"), stagedMeta());

    const result = await unstageGithubFiles(seeded.env, seeded.ws, WS, {
      repo: REPO,
      branch: BRANCH,
      dryRun: true,
    });

    expect(result.files).toEqual([
      { key: stagedKey("keep.png"), url: expect.any(String), action: "unstaged" },
    ]);
    expect((await getFileMetadata(seeded.env.DB, WS, stagedKey("keep.png")))["gh.status"]).toBe(
      "staged",
    );
  });

  it("unstages one key and leaves an already-unstaged key unchanged", async () => {
    const seeded = await seededEnv(false);
    await seed(seeded, stagedKey("one.png"), stagedMeta());
    await seed(seeded, stagedKey("two.png"), stagedMeta({ "gh.status": "unstaged" }));

    const result = await unstageGithubFiles(seeded.env, seeded.ws, WS, {
      keys: [stagedKey("one.png"), stagedKey("two.png")],
    });

    expect(result.files).toEqual([
      { key: stagedKey("one.png"), url: null, action: "unstaged" },
      { key: stagedKey("two.png"), url: null, action: "unchanged" },
    ]);
    expect((await getFileMetadata(seeded.env.DB, WS, stagedKey("one.png")))["gh.status"]).toBe(
      "unstaged",
    );
  });

  it("refuses a key that is not in the bucket", async () => {
    const seeded = await seededEnv(false);
    await expect(
      unstageGithubFiles(seeded.env, seeded.ws, WS, { keys: [stagedKey("missing.png")] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("clears a private branch prefix and ignores a different gh.branch", async () => {
    const seeded = await seededEnv(true);
    const prefixId = await getOrMintPrefixId(seeded.db as unknown as D1Database, REPO, BRANCH);
    const key = ghPrivateBranchAttachmentKey(prefixId, "shot.png");
    const other = ghPrivateBranchAttachmentKey(prefixId, "nope.png");
    await seed(seeded, key, stagedMeta());
    await seed(seeded, other, stagedMeta({ "gh.branch": "elsewhere" }));

    const result = await unstageGithubFiles(seeded.env, seeded.ws, WS, {
      repo: REPO,
      branch: BRANCH,
    });

    expect(result.files.map((file) => file.key)).toEqual([key]);
    expect((await getFileMetadata(seeded.env.DB, WS, key))["gh.status"]).toBe("unstaged");
    expect((await getFileMetadata(seeded.env.DB, WS, other))["gh.status"]).toBe("staged");
  });
});
