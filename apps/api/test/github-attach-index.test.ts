/**
 * attachExistingObject ↔ github_attachments index wiring (issue #934).
 */
import { describe, expect, it } from "vitest";
import { attachExistingObject } from "../src/github-attach";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeKv } from "./fake-kv";
import { FakeR2Bucket } from "./fake-r2";
import { UsageFakeD1 } from "./usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "./github-app-env";

const WS = "acme";
const PREFIX = "acme/";
const REPO = "acme/web";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function seededEnv() {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: PREFIX,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex("unused"), createdAt: new Date().toISOString() }],
  };
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  const kv = new FakeKv();
  kv.store.set(`ghpriv:${REPO}`, { value: "0" });
  const env = {
    REGISTRY: { get: async (key: string) => (key === `ws:${WS}` ? record : null) },
    DB: db,
    UPLOADS_DEFAULT: bucket,
    GITHUB_CACHE: kv,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  return { env, db, bucket, ws: record };
}

describe("attachExistingObject → attachment index (issue #934)", () => {
  it("records the destination with source 'attach'", async () => {
    const { env, db, bucket, ws } = await seededEnv();
    await bucket.put(`${PREFIX}f/shot.png`, PNG, { httpMetadata: { contentType: "image/png" } });

    const result = await attachExistingObject(env, ws, WS, {
      source: "f/shot.png",
      target: { repo: REPO, kind: "pull", num: 12 },
    });

    expect(db.attachmentIndex.get(`${WS}\0${result.key}`)).toMatchObject({
      repo: "acme/web",
      kind: "pull",
      num: 12,
      object_key: result.key,
      prefix_id: null,
      source: "attach",
    });
  });

  it("--move deletes the source object's row when the source was itself an attachment", async () => {
    const { env, db, bucket, ws } = await seededEnv();
    const sourceKey = "gh/acme/web/pull/11/shot.png";
    await bucket.put(`${PREFIX}${sourceKey}`, PNG, { httpMetadata: { contentType: "image/png" } });
    await attachExistingObject(env, ws, WS, {
      source: sourceKey,
      target: { repo: REPO, kind: "pull", num: 11 },
    });
    expect(db.attachmentIndex.get(`${WS}\0${sourceKey}`)).toBeDefined();

    const moved = await attachExistingObject(env, ws, WS, {
      source: sourceKey,
      target: { repo: REPO, kind: "pull", num: 12 },
      move: true,
    });

    expect(moved.moved).toBe(true);
    expect(db.attachmentIndex.get(`${WS}\0${sourceKey}`)).toBeUndefined();
    expect(db.attachmentIndex.get(`${WS}\0${moved.key}`)).toMatchObject({ num: 12 });
  });
});
