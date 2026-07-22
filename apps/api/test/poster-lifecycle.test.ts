import { describe, expect, it } from "vitest";
import { FakeMedia } from "./fake-media";
import { UsageFakeD1 } from "./usage-fake-d1";
import { FakeR2Bucket } from "./fake-r2";
import { putObject, deleteObject, setObjectVisibility } from "../src/files-core";
import { posterKeyFor } from "../src/poster";
import { objectVisibility } from "../src/visibility";
import { storage } from "../src/storage";
import type { WorkspaceRecord } from "../src/workspace";

function ftyp(brand: string): Uint8Array {
  return new Uint8Array([
    0,
    0,
    0,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    ...[...brand].map((ch) => ch.charCodeAt(0)),
  ]);
}
const MP4 = ftyp("mp42");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WORKSPACE = "default";

// Same shape as Task 8's fixture — real ledger + file_metadata, gate wide open.
function makeEnv() {
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  const env = {
    DB: db,
    UPLOADS_DEFAULT: bucket,
    MEDIA: FakeMedia.jpeg(new Uint8Array([1, 2, 3])),
    FLAGS: { getBooleanValue: async () => true },
    POSTER_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const ws: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "default/",
    publicBaseUrl: "https://storage.uploads.sh",
  };
  return { env, bucket, db, ws };
}

describe("poster lifecycle", () => {
  it("deletes the poster when the video is deleted", async () => {
    const { env, bucket, db, ws } = makeEnv();
    const put = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const posterKey = posterKeyFor(put.key);
    expect(bucket.store.has(`default/${posterKey}`)).toBe(true);

    await deleteObject(env, ws, put.key, WORKSPACE);
    expect(bucket.store.has(`default/${put.key}`)).toBe(false);
    expect(bucket.store.has(`default/${posterKey}`)).toBe(false);
    // Both objects' bytes are gone from the ledger, netting to zero — nothing
    // else was ever stored in this workspace.
    const usage = db.usage.get(WORKSPACE);
    expect(usage?.bytes).toBe(0);
    expect(usage?.objects).toBe(0);
  });

  it("tolerates a missing poster on delete", async () => {
    const { env, ws } = makeEnv();
    const put = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE);
    await expect(deleteObject(env, ws, put.key, WORKSPACE)).resolves.toEqual({
      key: put.key,
      deleted: true,
    });
  });

  it("does not delete a poster when an unrelated image is deleted", async () => {
    const { env, bucket, ws } = makeEnv();
    const video = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const posterKey = posterKeyFor(video.key);
    const image = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE);

    await deleteObject(env, ws, image.key, WORKSPACE);
    expect(bucket.store.has(`default/${video.key}`)).toBe(true);
    expect(bucket.store.has(`default/${posterKey}`)).toBe(true);
  });

  it("flips the poster to private when the video is made private", async () => {
    // THE security case: otherwise a private video keeps a publicly
    // fetchable frame.
    const { env, ws } = makeEnv();
    const put = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const posterKey = posterKeyFor(put.key);
    const store = await storage(env, ws);

    await setObjectVisibility(store, put.key, "private");
    const posterHead = await store.head(posterKey);
    expect(objectVisibility(posterHead.metadata)).toBe("private");
  });

  it("flips the poster back to public when the video is made public", async () => {
    const { env, ws } = makeEnv();
    const put = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const posterKey = posterKeyFor(put.key);
    const store = await storage(env, ws);

    await setObjectVisibility(store, put.key, "private");
    await setObjectVisibility(store, put.key, "public");
    const posterHead = await store.head(posterKey);
    expect(objectVisibility(posterHead.metadata)).toBeUndefined();
  });
});
