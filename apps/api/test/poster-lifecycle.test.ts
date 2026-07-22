import { describe, expect, it } from "vitest";
import { MP4, makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import { putObject, deleteObject, setObjectVisibility } from "../src/files-core";
import { posterKeyFor } from "../src/poster";
import { objectVisibility } from "../src/visibility";
import { storage } from "../src/storage";

describe("poster lifecycle", () => {
  it("deletes the poster when the video is deleted", async () => {
    const { env, bucket, db, ws } = makePosterEnv();
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
    const { env, ws } = makePosterEnv();
    const put = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE);
    await expect(deleteObject(env, ws, put.key, WORKSPACE)).resolves.toEqual({
      key: put.key,
      deleted: true,
    });
  });

  it("does not delete a poster when an unrelated image is deleted", async () => {
    const { env, bucket, ws } = makePosterEnv();
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
    const { env, ws } = makePosterEnv();
    const put = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const posterKey = posterKeyFor(put.key);
    const store = await storage(env, ws);

    await setObjectVisibility(store, put.key, "private");
    const posterHead = await store.head(posterKey);
    expect(objectVisibility(posterHead.metadata)).toBe("private");
  });

  it("flips the poster back to public when the video is made public", async () => {
    const { env, ws } = makePosterEnv();
    const put = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const posterKey = posterKeyFor(put.key);
    const store = await storage(env, ws);

    await setObjectVisibility(store, put.key, "private");
    await setObjectVisibility(store, put.key, "public");
    const posterHead = await store.head(posterKey);
    expect(objectVisibility(posterHead.metadata)).toBeUndefined();
  });
});
