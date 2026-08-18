import { describe, expect, it } from "vitest";
import { app } from "../index";
import { getFileMetadata, setFileMetadata } from "../file-metadata";
import { sha256Hex, type WorkspaceRecord } from "../workspace";
import { FakeR2Bucket } from "../../test/fake-r2";
import { UsageFakeD1 } from "../../test/usage-fake-d1";

// Same node-vs-workerd Web Crypto gap as github-promote-route.test.ts.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const WS = "acme";
const TOKEN = "up_acme_testtoken";
const PREFIX = "acme/";
const REPO = "acme/web";
const NUM = 12;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function destKey(filename: string): string {
  return `gh/acme/web/pull/${NUM}/${filename}`;
}

interface Seeded {
  env: Env;
  db: UsageFakeD1;
  bucket: FakeR2Bucket;
}

// Deliberately omits GITHUB_APP_CFG_ENV: githubAppConfig(env) then returns
// null, so postManagedComment degrades to { posted: false, reason:
// "app_unconfigured" } with no network call, and resolveGhKeyContextSafe
// degrades to plain mode — keeps this suite focused on the copy/metadata
// contract without standing up the full GitHub App fixture.
async function seededEnv(): Promise<Seeded> {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: PREFIX,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex(TOKEN), createdAt: new Date().toISOString() }],
  };
  const registry = {
    get: (async (key: string) =>
      key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
  };
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  const env = {
    REGISTRY: registry,
    DB: db,
    UPLOADS_DEFAULT: bucket,
    WEB_ORIGIN: "https://uploads.sh",
  } as unknown as Env;
  return { env, db, bucket };
}

async function seedSource(
  seeded: Seeded,
  key: string,
  opts: { bytes?: Uint8Array; meta?: Record<string, string> } = {},
) {
  const bytes = opts.bytes ?? PNG;
  await seeded.bucket.put(`${PREFIX}${key}`, bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: {},
  });
  if (opts.meta) {
    await setFileMetadata(seeded.env.DB, WS, key, opts.meta);
  }
}

function post(env: Env, body: unknown, token: string = TOKEN) {
  return app.request(
    `/v1/workspaces/${WS}/github/attach`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/workspaces/:workspace/github/attach", () => {
  it("400s on a malformed body", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { source: "", repo: "not-a-repo" });
    expect(res.status).toBe(400);
  });

  it("400s when neither pr nor issue is given", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { source: "f/abc/x.png", repo: REPO });
    expect(res.status).toBe(400);
  });

  it("400s when both pr and issue are given", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { source: "f/abc/x.png", repo: REPO, pr: 1, issue: 2 });
    expect(res.status).toBe(400);
  });

  it("401s with an unrecognized bearer token", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { source: "f/abc/x.png", repo: REPO, pr: NUM }, "up_acme_wrong");
    expect(res.status).toBe(401);
  });

  it("404s when the source object does not exist", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { source: "f/nope/missing.png", repo: REPO, pr: NUM });
    expect(res.status).toBe(404);
  });

  it("copies a bare key into the PR attachment prefix, merging metadata additively", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/abc123/hero.png", { meta: { path: "/settings", state: "after" } });

    const res = await post(seeded.env, { source: "f/abc123/hero.png", repo: REPO, pr: NUM });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      key: string;
      url: string | null;
      moved: boolean;
      source: { key: string };
      comment: { posted: boolean };
    };
    expect(body.key).toBe(destKey("hero.png"));
    expect(body.moved).toBe(false);
    expect(body.source).toEqual({ key: "f/abc123/hero.png" });
    expect(body.comment).toEqual({ posted: false, reason: "app_unconfigured" });

    const stored = seeded.bucket.store.get(`${PREFIX}${destKey("hero.png")}`);
    expect(stored).toBeDefined();
    expect([...(stored?.data ?? [])]).toEqual([...PNG]);

    // Source metadata rode along; gh.* stamped fresh on top.
    const destMeta = await getFileMetadata(seeded.env.DB, WS, destKey("hero.png"));
    expect(destMeta.path).toBe("/settings");
    expect(destMeta.state).toBe("after");
    expect(destMeta["gh.repo"]).toBe("acme/web");
    expect(destMeta["gh.kind"]).toBe("pull");
    expect(destMeta["gh.number"]).toBe("12");
    expect(destMeta["gh.ref"]).toBe("acme/web#12");

    // Source object untouched — copy, not move.
    const sourceStored = seeded.bucket.store.get(`${PREFIX}f/abc123/hero.png`);
    expect(sourceStored).toBeDefined();
  });

  it("resolves a storage-host URL to the same key as the bare key", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/abc123/hero.png");
    const url = "https://storage.uploads.sh/acme/f/abc123/hero.png";

    const res = await post(seeded.env, { source: url, repo: REPO, pr: NUM });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key).toBe(destKey("hero.png"));
  });

  it("resolves an /f/ page URL to the same key", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/abc123/hero.png");
    const url = "https://uploads.sh/f/acme/f/abc123/hero.png";

    const res = await post(seeded.env, { source: url, repo: REPO, pr: NUM });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key).toBe(destKey("hero.png"));
  });

  it("rejects a URL for a different workspace's /f/ page", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/abc123/hero.png");
    const url = "https://uploads.sh/f/someoneelse/f/abc123/hero.png";

    const res = await post(seeded.env, { source: url, repo: REPO, pr: NUM });
    expect(res.status).toBe(400);
  });

  it("is idempotent: re-attaching the same source overwrites the destination in place", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/abc123/hero.png");

    const first = await post(seeded.env, { source: "f/abc123/hero.png", repo: REPO, pr: NUM });
    expect(first.status).toBe(200);
    const second = await post(seeded.env, { source: "f/abc123/hero.png", repo: REPO, pr: NUM });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ key: destKey("hero.png") });
  });

  it("deletes the source after a successful copy when move is true", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/abc123/hero.png");

    const res = await post(seeded.env, {
      source: "f/abc123/hero.png",
      repo: REPO,
      pr: NUM,
      move: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { moved: boolean };
    expect(body.moved).toBe(true);
    expect(seeded.bucket.store.get(`${PREFIX}f/abc123/hero.png`)).toBeUndefined();
    // Destination still landed.
    expect(seeded.bucket.store.get(`${PREFIX}${destKey("hero.png")}`)).toBeDefined();
  });

  it("attaches to an issue with the issues key shape", async () => {
    const seeded = await seededEnv();
    await seedSource(seeded, "f/abc123/hero.png");

    const res = await post(seeded.env, { source: "f/abc123/hero.png", repo: REPO, issue: 7 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key).toBe("gh/acme/web/issues/7/hero.png");
  });
});
