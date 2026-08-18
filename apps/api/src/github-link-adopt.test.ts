/**
 * Webhook link adoption (issue #701) — pure URL extraction, workspace-scoped
 * resolution, the copy+additive-metadata adoption itself, and the noise-guard
 * gate on comment sync. `adoptLinkedFilesForWebhook`'s repo-link/knob no-ops
 * mirror `ingestForWebhook`'s own tests (github-ingest.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  adoptLinkedFiles,
  adoptLinkedFilesForWebhook,
  extractCandidateUrls,
  hasLinkCandidate,
  resolveAdoptableKeys,
} from "./github-link-adopt";
import { getFileMetadata } from "./file-metadata";
import { recordRepoLink } from "./github-repo-links";
import { sha256Hex, type WorkspaceRecord } from "./workspace";
import { FakeKv } from "../test/fake-kv";
import { FakeR2Bucket } from "../test/fake-r2";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";
import { UsageFakeD1 } from "../test/usage-fake-d1";

const WS = "acme";
const OTHER_WS = "other";
const REPO = "acme/web";
const NUM = 12;
const PREFIX = "acme/";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface Seeded {
  env: Env;
  db: UsageFakeD1;
  bucket: FakeR2Bucket;
  kv: FakeKv;
}

async function seededEnv(): Promise<Seeded> {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: PREFIX,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex("up_acme_testtoken"), createdAt: new Date().toISOString() }],
  };
  const otherRecord: WorkspaceRecord = {
    provider: "r2",
    bucket: "b2",
    binding: "UPLOADS_DEFAULT",
    prefix: "other/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [],
  };
  const registry = {
    get: (async (key: string) => {
      if (key === `ws:${WS}`) return record;
      if (key === `ws:${OTHER_WS}`) return otherRecord;
      return null;
    }) as unknown as KVNamespace["get"],
  };
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  const kv = new FakeKv();
  // Public by default (cache hit — no network call) for resolveGhKeyContextSafe.
  kv.store.set("ghpriv:acme/web", { value: "0" });
  const env = {
    REGISTRY: registry,
    DB: db,
    UPLOADS_DEFAULT: bucket,
    GITHUB_CACHE: kv,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  return { env, db, bucket, kv };
}

async function seedSource(seeded: Seeded, key: string, prefix = PREFIX) {
  await seeded.bucket.put(`${prefix}${key}`, PNG, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: {},
  });
}

describe("extractCandidateUrls / hasLinkCandidate", () => {
  it("finds distinct http(s) urls, dedups, strips trailing punctuation", () => {
    const text =
      "See https://storage.uploads.sh/acme/f/x.png, also " +
      "https://storage.uploads.sh/acme/f/x.png. And http://example.com/y.";
    expect(extractCandidateUrls(text)).toEqual([
      "https://storage.uploads.sh/acme/f/x.png",
      "http://example.com/y",
    ]);
  });

  it("hasLinkCandidate is a cheap presence check", () => {
    expect(hasLinkCandidate("no links here")).toBe(false);
    expect(hasLinkCandidate("check http://x")).toBe(true);
    expect(hasLinkCandidate("check https://x")).toBe(true);
  });
});

describe("resolveAdoptableKeys", () => {
  it("resolves a storage-host URL to a key in this workspace", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/shot.png");
    const { keys, skipped } = await resolveAdoptableKeys(
      seeded.env,
      WS,
      "screenshot: https://storage.uploads.sh/acme/f/shot.png",
    );
    expect(keys).toEqual(["f/shot.png"]);
    expect(skipped).toEqual([]);
  });

  it("resolves the /f/ page URL spelling too, deduped against the storage host", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/shot.png");
    const text =
      "https://storage.uploads.sh/acme/f/shot.png and https://uploads.sh/f/acme/f/shot.png";
    const { keys } = await resolveAdoptableKeys(seeded.env, WS, text);
    expect(keys).toEqual(["f/shot.png"]);
  });

  it("silently drops URLs belonging to a different workspace", async () => {
    const seeded = await seededEnv();
    const text = "https://storage.uploads.sh/other/f/shot.png";
    const { keys, skipped } = await resolveAdoptableKeys(seeded.env, WS, text);
    expect(keys).toEqual([]);
    expect(skipped).toEqual([text]);
  });

  it("silently drops non-uploads.sh URLs", async () => {
    const seeded = await seededEnv();
    const { keys, skipped } = await resolveAdoptableKeys(
      seeded.env,
      WS,
      "see https://example.com/whatever.png",
    );
    expect(keys).toEqual([]);
    expect(skipped).toEqual(["https://example.com/whatever.png"]);
  });
});

describe("adoptLinkedFiles", () => {
  it("copies a resolved link additively (gh.* on top of the source's own metadata)", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/shot.png");
    await import("./file-metadata").then(({ setFileMetadata }) =>
      setFileMetadata(seeded.env.DB, WS, "f/shot.png", { path: "src/App.tsx" }),
    );

    const summary = await adoptLinkedFiles(
      seeded.env,
      WS,
      null,
      { repo: REPO, kind: "pull", num: NUM },
      "https://storage.uploads.sh/acme/f/shot.png",
    );

    expect(summary.adopted).toEqual([`gh/acme/web/pull/${NUM}/shot.png`]);
    const meta = await getFileMetadata(seeded.env.DB, WS, `gh/acme/web/pull/${NUM}/shot.png`);
    expect(meta.path).toBe("src/App.tsx"); // preserved, PR #157 contract
    expect(meta["gh.repo"]).toBe(REPO.toLowerCase());
    expect(meta["gh.kind"]).toBe("pull");
    expect(meta["gh.number"]).toBe(String(NUM));

    // Source key itself is untouched — the pasted URL still resolves.
    expect(seeded.bucket.store.has(`${PREFIX}f/shot.png`)).toBe(true);
  });

  it("noise guard: a single lone adoption with nothing else does NOT sync", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/shot.png");
    // No GITHUB_APP config beyond the fixture's dummy id/key, but
    // githubAppConfig(env) IS configured here — postManagedComment would
    // proceed to installationForRepo, which needs a ghinst KV entry. Leaving
    // it unseeded means a sync attempt would try a real network call; assert
    // instead that synced stays false so that call never happens.
    const summary = await adoptLinkedFiles(
      seeded.env,
      WS,
      null,
      { repo: REPO, kind: "pull", num: NUM },
      "https://storage.uploads.sh/acme/f/shot.png",
    );
    expect(summary.adopted.length).toBe(1);
    expect(summary.synced).toBe(false);
  });

  it("noise guard: two adopted links in one pass DOES sync", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/a.png");
    await seedSource(seeded, "f/b.png");
    seeded.kv.store.set("ghinst:acme/web", { value: "1" });
    const summary = await adoptLinkedFiles(
      seeded.env,
      WS,
      null,
      { repo: REPO, kind: "pull", num: NUM },
      "https://storage.uploads.sh/acme/f/a.png and https://storage.uploads.sh/acme/f/b.png",
    );
    expect(summary.adopted.length).toBe(2);
    // App-unconfigured or install-lookup-failure degrades postManagedComment
    // to a no-op result, but the CALL still happens — synced reflects that an
    // attempt was made, matching postAttachExisting's own contract that
    // comment sync never throws.
    expect(summary.synced).toBe(true);
  });

  it("noise guard: one adopted link mixed with an existing attachment DOES sync", async () => {
    const seeded = await seededEnv();
    // Pre-existing attachment already under the PR's gh key prefix.
    await seeded.bucket.put(`${PREFIX}gh/acme/web/pull/${NUM}/existing.png`, PNG, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {},
    });
    await seedSource(seeded, "f/shot.png");
    const summary = await adoptLinkedFiles(
      seeded.env,
      WS,
      null,
      { repo: REPO, kind: "pull", num: NUM },
      "https://storage.uploads.sh/acme/f/shot.png",
    );
    expect(summary.adopted.length).toBe(1);
    expect(summary.synced).toBe(true);
  });

  it("resolving to no keys is a pure no-op (no workspace load, no sync)", async () => {
    const seeded = await seededEnv();
    const summary = await adoptLinkedFiles(
      seeded.env,
      WS,
      null,
      { repo: REPO, kind: "pull", num: NUM },
      "nothing to see here",
    );
    expect(summary).toEqual({ adopted: [], skipped: [], synced: false });
  });

  it("is idempotent: re-adopting the same source overwrites the same destination key", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/shot.png");
    const first = await adoptLinkedFiles(
      seeded.env,
      WS,
      null,
      { repo: REPO, kind: "pull", num: NUM },
      "https://storage.uploads.sh/acme/f/shot.png",
    );
    const second = await adoptLinkedFiles(
      seeded.env,
      WS,
      null,
      { repo: REPO, kind: "pull", num: NUM },
      "https://storage.uploads.sh/acme/f/shot.png",
    );
    expect(first.adopted).toEqual(second.adopted);
    expect(seeded.bucket.store.size).toBe(2); // source + the one dest key, not two dest copies
  });
});

describe("adoptLinkedFilesForWebhook", () => {
  it("no-ops when the repo isn't linked to any workspace", async () => {
    const seeded = await seededEnv();
    await expect(
      adoptLinkedFilesForWebhook(seeded.env, {
        repo: REPO,
        kind: "pull",
        num: NUM,
        source: "body",
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops when adoptLinkedFiles resolves off via repo config", async () => {
    const seeded = await seededEnv();
    await recordRepoLink(seeded.env.DB, REPO, WS, "test");
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/.uploads.yml")) {
        return new Response("comment:\n  adoptLinkedFiles: false\n", { status: 200 });
      }
      if (url.includes("/contents/")) return new Response("not found", { status: 404 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    await expect(
      adoptLinkedFilesForWebhook(
        seeded.env,
        { repo: REPO, kind: "pull", num: NUM, source: "body" },
        { fetchImpl },
      ),
    ).resolves.toBeUndefined();
  });
});
