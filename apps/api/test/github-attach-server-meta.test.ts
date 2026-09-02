/**
 * attachExistingObject must not re-submit the source's SERVER-owned
 * metadata (`image.*`, `video.*`) through the client-validated metadata
 * write: those keys are reserved there, so a source that was uploaded with
 * derived dimensions made every attach — and every link adoption of a
 * branch-staged image — throw `reserved metadata key: image.height`.
 */
import { describe, expect, it } from "vitest";
import { attachExistingObject } from "../src/github-attach";
import { getFileMetadata, setFileMetadata, setServerFileMetadata } from "../src/file-metadata";
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

describe("attachExistingObject with server-owned source metadata", () => {
  it("attaches a source that carries image.* dimensions, keeping its client tags", async () => {
    const { env, bucket, ws } = await seededEnv();
    await bucket.put(`${PREFIX}f/shot.png`, PNG, { httpMetadata: { contentType: "image/png" } });
    await setFileMetadata(env.DB, WS, "f/shot.png", { path: "src/app.tsx" });
    await setServerFileMetadata(env.DB, WS, "f/shot.png", {
      "image.width": "640",
      "image.height": "480",
      "video.poster": "1",
    });

    const result = await attachExistingObject(env, ws, WS, {
      source: "f/shot.png",
      target: { repo: REPO, kind: "pull", num: 12 },
    });

    const meta = await getFileMetadata(env.DB, WS, result.key);
    expect(meta).toMatchObject({ path: "src/app.tsx", "gh.repo": "acme/web", "gh.number": "12" });
    // Server-owned keys are derived for the copy by putObject itself (or
    // not at all); never copied through the client-validated merge.
    expect(meta["video.poster"]).toBeUndefined();
  });
});
