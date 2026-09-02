/**
 * promoteBranchAttachments ↔ github_attachments index wiring (issue #934).
 * The promoted COPY is indexed once, with the caller-resolved repo; the
 * staged original stays unindexed (branch keys are not attachments).
 */
import { describe, expect, it } from "vitest";
import { promoteBranchAttachments } from "../src/github-promote";
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

describe("promoteBranchAttachments → attachment index (issue #934)", () => {
  it("indexes the promoted copy once, with source 'promote'", async () => {
    const { env, db, bucket, ws } = await seededEnv();
    const stagedKey = "gh/acme/web/branch/feat-x/shot.png";
    await bucket.put(`${PREFIX}${stagedKey}`, PNG, {
      httpMetadata: { contentType: "image/png" },
    });

    const result = await promoteBranchAttachments(env, ws, WS, {
      repo: REPO,
      num: 12,
      branch: "feat-x",
    });

    expect(result.promoted).toEqual(["gh/acme/web/pull/12/shot.png"]);
    expect(db.attachmentIndex.get(`${WS}\0gh/acme/web/pull/12/shot.png`)).toMatchObject({
      repo: "acme/web",
      kind: "pull",
      num: 12,
      source: "promote",
      detached_at: null,
    });
    // The staged original is not an attachment and gets no row.
    expect(db.attachmentIndex.get(`${WS}\0${stagedKey}`)).toBeUndefined();
    // One upsert, not a "put" row re-recorded as "promote" (issue #934 cleanup).
    expect(db.attachmentIndexUpserts).toBe(1);
  });
});
