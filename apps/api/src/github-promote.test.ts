/**
 * Unit-level coverage for `promoteBranchAttachments` itself (issue #631,
 * Task 6) — private-prefix sweep/destination behavior. Route-level and
 * webhook-driven coverage (HTTP shape, claim recording, error degrade) lives
 * in `routes/github-promote-route.test.ts` and
 * `github-webhook-auto-promote.test.ts`; this file is scoped to the
 * plain-vs-private key-mode decision inside `promoteBranchAttachments`.
 */
import { describe, expect, it } from "vitest";
import { getFileMetadata, replaceFileMetadata } from "./file-metadata";
import {
  ghPrivateAttachmentKey,
  ghPrivateBranchAttachmentKey,
  ghPrivateBranchKeyPrefix,
} from "./github-comment-render";
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
const BRANCH = "feat-x";
const NUM = 7;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function stagedKey(filename: string): string {
  return `gh/acme/web/branch/${BRANCH}/${filename}`;
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

async function seededEnv(opts: { isPrivate: boolean; linked?: boolean }): Promise<Seeded> {
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
  if (opts.linked !== false) {
    await recordRepoLink(db as unknown as D1Database, REPO, WS, "test");
  }
  const env = {
    DB: db,
    UPLOADS_DEFAULT: bucket,
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  return { env, db, bucket, ws };
}

async function seedPlainStaged(seeded: Seeded, filename: string) {
  await seeded.bucket.put(`${PREFIX}${stagedKey(filename)}`, PNG, {
    httpMetadata: { contentType: "image/png" },
  });
  await replaceFileMetadata(seeded.env.DB, WS, stagedKey(filename), {
    "gh.repo": REPO,
    "gh.kind": "branch",
    "gh.branch": BRANCH,
    "gh.staged-at": new Date().toISOString(),
  });
}

async function seedPrivateStaged(seeded: Seeded, prefixId: string, filename: string) {
  const key = ghPrivateBranchAttachmentKey(prefixId, filename);
  await seeded.bucket.put(`${PREFIX}${key}`, PNG, {
    httpMetadata: { contentType: "image/png" },
  });
  await replaceFileMetadata(seeded.env.DB, WS, key, {
    "gh.repo": REPO,
    "gh.kind": "branch",
    "gh.branch": BRANCH,
    "gh.staged-at": new Date().toISOString(),
  });
  return key;
}

describe("promoteBranchAttachments — private prefixes (issue #631)", () => {
  it("public repo: promotes into the plain destination, byte-identical to pre-#631 behavior", async () => {
    const seeded = await seededEnv({ isPrivate: false });
    await seedPlainStaged(seeded, "hero.png");

    const result = await promoteBranchAttachments(seeded.env, seeded.ws, WS, {
      repo: REPO,
      num: NUM,
      branch: BRANCH,
    });

    expect(result.promoted).toEqual([destKey("hero.png")]);
    expect(result.skipped).toEqual([]);
    expect(seeded.bucket.store.has(`${PREFIX}${destKey("hero.png")}`)).toBe(true);

    const copyMeta = await getFileMetadata(seeded.env.DB, WS, destKey("hero.png"));
    expect(copyMeta["gh.kind"]).toBe("pull");
    expect(copyMeta["gh.number"]).toBe(String(NUM));
  });

  it("private repo: a file staged under the private branch prefix promotes to the private pull prefix with a metadata flip", async () => {
    const seeded = await seededEnv({ isPrivate: true });
    const prefixId = await getOrMintPrefixId(seeded.db as unknown as D1Database, REPO, BRANCH);
    const stagedKeyPrivate = await seedPrivateStaged(seeded, prefixId, "a.png");

    const result = await promoteBranchAttachments(seeded.env, seeded.ws, WS, {
      repo: REPO,
      num: NUM,
      branch: BRANCH,
    });

    const expectedDest = ghPrivateAttachmentKey(
      prefixId,
      { repo: REPO, kind: "pull", num: NUM },
      "a.png",
    );
    expect(result.promoted).toEqual([expectedDest]);
    expect(result.skipped).toEqual([]);
    expect(seeded.bucket.store.has(`${PREFIX}${expectedDest}`)).toBe(true);

    // Metadata flip on the staged original, unchanged by mode (issue #339).
    const originalMeta = await getFileMetadata(seeded.env.DB, WS, stagedKeyPrivate);
    expect(originalMeta["gh.status"]).toBe("promoted");
    expect(originalMeta["gh.promoted-to"]).toBe(`${REPO}#${NUM}`.toLowerCase());

    const copyMeta = await getFileMetadata(seeded.env.DB, WS, expectedDest);
    expect(copyMeta["gh.kind"]).toBe("pull");
    expect(copyMeta["gh.number"]).toBe(String(NUM));
    expect(copyMeta["gh.branch"]).toBe(BRANCH);
  });

  it("private repo: a plain-staged file (pre-feature/privacy-flip leftover) still sweeps and promotes into the PRIVATE destination", async () => {
    const seeded = await seededEnv({ isPrivate: true });
    await seedPlainStaged(seeded, "leftover.png");

    const result = await promoteBranchAttachments(seeded.env, seeded.ws, WS, {
      repo: REPO,
      num: NUM,
      branch: BRANCH,
    });

    expect(result.skipped).toEqual([]);
    expect(result.promoted).toHaveLength(1);
    const [promotedKey] = result.promoted;
    // Destination follows the CURRENT (private) mode, not the plain prefix
    // the file happened to be staged under.
    expect(promotedKey).toMatch(/^gh\/private\/[0-9a-f]{32}\/pull\/7\/leftover\.png$/);
    expect(seeded.bucket.store.has(`${PREFIX}${promotedKey}`)).toBe(true);
    // Nothing was written to the old plain destination.
    expect(seeded.bucket.store.has(`${PREFIX}${destKey("leftover.png")}`)).toBe(false);
  });

  it("private repo: sweeps BOTH the plain and private branch-staged prefixes in one call", async () => {
    const seeded = await seededEnv({ isPrivate: true });
    const prefixId = await getOrMintPrefixId(seeded.db as unknown as D1Database, REPO, BRANCH);
    await seedPrivateStaged(seeded, prefixId, "new.png");
    await seedPlainStaged(seeded, "old.png");

    const result = await promoteBranchAttachments(seeded.env, seeded.ws, WS, {
      repo: REPO,
      num: NUM,
      branch: BRANCH,
    });

    expect(result.skipped).toEqual([]);
    const expectedNewDest = ghPrivateAttachmentKey(
      prefixId,
      { repo: REPO, kind: "pull", num: NUM },
      "new.png",
    );
    const expectedOldDest = ghPrivateAttachmentKey(
      prefixId,
      { repo: REPO, kind: "pull", num: NUM },
      "old.png",
    );
    expect(result.promoted.sort()).toEqual([expectedNewDest, expectedOldDest].sort());
  });

  it("private branch prefix is empty when unminted — no listing crash, no spurious private sweep for another branch", async () => {
    const seeded = await seededEnv({ isPrivate: true });
    // Mint the id for a DIFFERENT branch so `ghPrivateBranchKeyPrefix` for
    // THIS branch resolves to an id whose prefix has nothing under it yet.
    await getOrMintPrefixId(seeded.db as unknown as D1Database, REPO, "other-branch");
    await seedPlainStaged(seeded, "solo.png");

    const result = await promoteBranchAttachments(seeded.env, seeded.ws, WS, {
      repo: REPO,
      num: NUM,
      branch: BRANCH,
    });

    expect(result.skipped).toEqual([]);
    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]).toMatch(/^gh\/private\/[0-9a-f]{32}\/pull\/7\/solo\.png$/);
  });

  it("fails open to plain when the repo isn't linked (unauthorized) even though it's private", async () => {
    const seeded = await seededEnv({ isPrivate: true, linked: false });
    await seedPlainStaged(seeded, "hero.png");

    const result = await promoteBranchAttachments(seeded.env, seeded.ws, WS, {
      repo: REPO,
      num: NUM,
      branch: BRANCH,
    });

    // No link + no minting user → checkRepoAuthorization declines →
    // resolveGhKeyContext degrades to plain — same destination as before #631.
    expect(result.promoted).toEqual([destKey("hero.png")]);
  });

  it("returns empty arrays when nothing is staged under either prefix", async () => {
    const seeded = await seededEnv({ isPrivate: true });

    const result = await promoteBranchAttachments(seeded.env, seeded.ws, WS, {
      repo: REPO,
      num: NUM,
      branch: BRANCH,
    });

    expect(result).toEqual({ promoted: [], skipped: [] });
  });

  it("ghPrivateBranchKeyPrefix stays a clean base for the branch-scoped id used above (sanity on the builder import)", () => {
    expect(ghPrivateBranchKeyPrefix("0".repeat(32))).toBe(`gh/private/${"0".repeat(32)}/branch/`);
  });
});
