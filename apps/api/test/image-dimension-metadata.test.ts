import { describe, expect, it } from "vitest";
import { makePosterEnv, MP4, PNG, WORKSPACE } from "./poster-fixtures";
import { putObject } from "../src/files-core";
import { getMetadataForKeys } from "../src/file-metadata";

/**
 * `image.width`/`image.height` server-owned metadata (issue #365 follow-up):
 * written best-effort at upload from the image header so the managed comment
 * can size embeds; cleared on any overwrite whose bytes carry no parsable
 * dimensions (unparsable image or non-image replacement).
 */

/** Minimal valid PNG header: signature + IHDR with the given dimensions. */
function pngWithDims(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13, false); // IHDR chunk length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return b;
}

describe("image dimension metadata on upload", () => {
  it("writes image.width/height rows for a parsable image", async () => {
    const { env, ws } = makePosterEnv();
    const put = await putObject(env, ws, "images/icon.png", pngWithDims(96, 64), WORKSPACE);

    const meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put.key])).get(put.key);
    expect(meta?.["image.width"]).toBe("96");
    expect(meta?.["image.height"]).toBe("64");
  });

  it("clears stale dims when an overwrite's image header can't be parsed", async () => {
    const { env, ws } = makePosterEnv();
    const put1 = await putObject(env, ws, "images/icon.png", pngWithDims(96, 64), WORKSPACE);
    let meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put1.key])).get(put1.key);
    expect(meta?.["image.width"]).toBe("96");

    // The shared PNG fixture sniffs as image/png (signature only) but carries
    // no IHDR — detectImageDimensions returns undefined.
    const put2 = await putObject(env, ws, "images/icon.png", PNG, WORKSPACE, { replace: true });
    meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put2.key])).get(put2.key);
    expect(meta?.["image.width"]).toBeUndefined();
    expect(meta?.["image.height"]).toBeUndefined();
  });

  it("clears stale dims when an image is replaced by a non-image", async () => {
    const { env, ws } = makePosterEnv();
    const put1 = await putObject(env, ws, "images/icon.png", pngWithDims(96, 64), WORKSPACE);
    let meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put1.key])).get(put1.key);
    expect(meta?.["image.width"]).toBe("96");

    // A video is the non-image replacement the upload policy allows.
    const put2 = await putObject(env, ws, "images/icon.png", MP4, WORKSPACE, { replace: true });
    meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put2.key])).get(put2.key);
    expect(meta?.["image.width"]).toBeUndefined();
    expect(meta?.["image.height"]).toBeUndefined();
  });

  it("does not write image.* rows for a video upload", async () => {
    const { env, ws } = makePosterEnv();
    const put = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put.key])).get(put.key);
    expect(meta?.["image.width"]).toBeUndefined();
  });
});
