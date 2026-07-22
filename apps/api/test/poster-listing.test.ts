import { describe, expect, it } from "vitest";
import { FakeMedia } from "./fake-media";
import { UsageFakeD1 } from "./usage-fake-d1";
import { FakeR2Bucket } from "./fake-r2";
import { listObjects, putObject } from "../src/files-core";
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

// By this task, poster generation is already wired into putObject (Task 8),
// so the gate needs to stay open to actually get a poster seeded.
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

describe("listObjects hides server-owned keys", () => {
  it("omits _internal/ objects from an unprefixed listing", async () => {
    const { env, ws } = makeEnv();
    const video = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const image = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE);

    const listing = await listObjects(env, ws, {});
    expect(listing.items).toHaveLength(2);
    expect(listing.items.some((i) => i.key.startsWith("_internal/"))).toBe(false);
    expect(listing.items.map((i) => i.key).sort()).toEqual([image.key, video.key].sort());
  });

  it("omits them even when _internal/ is asked for explicitly", async () => {
    // prefix: "_internal/" must not be an escape hatch to enumerate them.
    const { env, ws } = makeEnv();
    await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);

    const listing = await listObjects(env, ws, { prefix: "_internal/" });
    expect(listing.items).toHaveLength(0);
  });

  it("leaves gh/-prefixed listings unchanged", async () => {
    // The managed comment path must see exactly what it saw before.
    const { env, ws } = makeEnv();
    const gh = await putObject(env, ws, "gh/acme/web/pull/12/hero.png", PNG, WORKSPACE);

    const listing = await listObjects(env, ws, { prefix: "gh/" });
    expect(listing.items.map((i) => i.key)).toEqual([gh.key]);
  });
});
