import { describe, expect, it } from "vitest";
import { FakeMedia } from "./fake-media";
import { UsageFakeD1 } from "./usage-fake-d1";
import { FakeR2Bucket } from "./fake-r2";
import { putObject } from "../src/files-core";
import { posterKeyFor } from "../src/poster";
import { getMetadataForKeys } from "../src/file-metadata";
import type { WorkspaceRecord } from "../src/workspace";

// ftyp box → sniffs as video/mp4 (see guards.test.ts's identical helper).
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

const flagsOn = { getBooleanValue: async () => true };
const allowLimiter = { limit: async () => ({ success: true }) };

/**
 * `UsageFakeD1` (test/usage-fake-d1.ts) backs a real workspace_usage ledger
 * AND file_metadata — unlike routes-files.test.ts's makeFakeDB, which no-ops
 * the ledger — so it's the right fixture whenever a test needs to read
 * either back out. Mirrors routes-files-usage-resilience.test.ts's `makeEnv`,
 * plus the MEDIA/FLAGS/POSTER_LIMITER bindings `posterGenerationAllowed`
 * gates on (see poster-gate.test.ts's `env()` helper for that shape).
 */
function makeEnv(posterJpeg: Uint8Array = new Uint8Array([1, 2, 3])) {
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  const env = {
    DB: db,
    UPLOADS_DEFAULT: bucket,
    MEDIA: FakeMedia.jpeg(posterJpeg),
    FLAGS: flagsOn,
    POSTER_LIMITER: allowLimiter,
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

describe("poster generation on upload", () => {
  it("stores a poster at the derived key and tags the video", async () => {
    const { env, bucket, ws } = makeEnv();
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
    const { env, ws } = makeEnv();
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
    const { env, db, ws } = makeEnv(posterJpeg);
    await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const usage = db.usage.get(WORKSPACE);
    expect(usage?.bytes).toBe(MP4.byteLength + posterJpeg.byteLength);
    expect(usage?.objects).toBe(2); // the video object + the poster object.
  });

  it("clears a stale poster when a replacement video fails generation", async () => {
    // PUT v1 (succeeds, poster written), then PUT v2 with FakeMedia.failing().
    // A frame from the previous video is worse than none.
    const { env, bucket, ws } = makeEnv();
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
    const { env, bucket, ws } = makeEnv();
    await putObject(env, ws, "images/pic.png", PNG, WORKSPACE);
    const internalKeys = [...bucket.store.keys()].filter((k) => k.includes("_internal/"));
    expect(internalKeys).toHaveLength(0);
  });

  it("does not fail the upload when generation throws", async () => {
    const { env, ws } = makeEnv();
    (env as unknown as { MEDIA: unknown }).MEDIA = FakeMedia.failing("frame_extraction_failed");
    const result = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    expect(result.key).toBe("videos/clip.mp4");
    expect(result.contentType).toBe("video/mp4");
  });
});
