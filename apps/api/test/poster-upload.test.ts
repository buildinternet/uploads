import { describe, expect, it } from "vitest";
import { FakeMedia } from "./fake-media";
import { MP4, makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import { putObject } from "../src/files-core";
import { posterKeyFor } from "../src/poster";
import { getMetadataForKeys } from "../src/file-metadata";

describe("poster generation on upload", () => {
  it("stores a poster at the derived key and tags the video", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const result = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const posterKey = posterKeyFor(result.key);
    expect(bucket.store.has(`default/${posterKey}`)).toBe(true);
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [result.key]);
    expect(metaByKey.get(result.key)?.["video.poster"]).toBe("1");
  });

  it("leaves the request's own custom metadata intact", async () => {
    // Guards the ordering trap: replaceFileMetadata is delete-then-insert and
    // runs before generateAndStorePoster's server write — if the call order
    // in putObject were ever reversed, this would start failing.
    const { env, ws } = makePosterEnv();
    const result = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE, {
      metadata: { path: "src/app" },
    });
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [result.key]);
    const meta = metaByKey.get(result.key);
    expect(meta?.path).toBe("src/app");
    expect(meta?.["video.poster"]).toBe("1");
  });

  it("counts poster bytes in the usage ledger", async () => {
    // Ledger bytes == video bytes + poster bytes, so a later
    // reconcileWorkspaceUsage (which walks every object) agrees.
    const posterJpeg = new Uint8Array(50);
    const { env, db, ws } = makePosterEnv(posterJpeg);
    await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const usage = db.usage.get(WORKSPACE);
    expect(usage?.bytes).toBe(MP4.byteLength + posterJpeg.byteLength);
    expect(usage?.objects).toBe(2); // the video object + the poster object.
  });

  it("clears a stale poster when a replacement video fails generation", async () => {
    // PUT v1 (succeeds, poster written), then PUT v2 with FakeMedia.failing().
    // A frame from the previous video is worse than none.
    const { env, bucket, ws } = makePosterEnv();
    const put1 = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const posterKey = posterKeyFor(put1.key);
    expect(bucket.store.has(`default/${posterKey}`)).toBe(true);

    (env as unknown as { MEDIA: unknown }).MEDIA = FakeMedia.failing("frame_extraction_failed");
    const put2 = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE, { replace: true });
    expect(bucket.store.has(`default/${posterKeyFor(put2.key)}`)).toBe(false);
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [put2.key]);
    expect(metaByKey.get(put2.key)?.["video.poster"]).toBeUndefined();
  });

  it("is a no-op for images", async () => {
    const { env, bucket, ws } = makePosterEnv();
    await putObject(env, ws, "images/pic.png", PNG, WORKSPACE);
    const internalKeys = [...bucket.store.keys()].filter((k) => k.includes("_internal/"));
    expect(internalKeys).toHaveLength(0);
  });

  it("does not fail the upload when generation throws", async () => {
    const { env, ws } = makePosterEnv();
    (env as unknown as { MEDIA: unknown }).MEDIA = FakeMedia.failing("frame_extraction_failed");
    const result = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    expect(result.key).toBe("videos/clip.mp4");
    expect(result.contentType).toBe("video/mp4");
  });
});
