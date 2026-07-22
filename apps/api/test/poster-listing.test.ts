import { describe, expect, it } from "vitest";
import { MP4, makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import { listObjects, putObject } from "../src/files-core";

describe("listObjects hides server-owned keys", () => {
  it("omits _internal/ objects from an unprefixed listing", async () => {
    const { env, ws } = makePosterEnv();
    const video = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);
    const image = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE);

    const listing = await listObjects(env, ws, {});
    expect(listing.items).toHaveLength(2);
    expect(listing.items.some((i) => i.key.startsWith("_internal/"))).toBe(false);
    expect(listing.items.map((i) => i.key).sort()).toEqual([image.key, video.key].sort());
  });

  it("omits them even when _internal/ is asked for explicitly", async () => {
    // prefix: "_internal/" must not be an escape hatch to enumerate them.
    const { env, ws } = makePosterEnv();
    await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);

    const listing = await listObjects(env, ws, { prefix: "_internal/" });
    expect(listing.items).toHaveLength(0);
  });

  it("leaves gh/-prefixed listings unchanged", async () => {
    // The managed comment path must see exactly what it saw before.
    const { env, ws } = makePosterEnv();
    const gh = await putObject(env, ws, "gh/acme/web/pull/12/hero.png", PNG, WORKSPACE);

    const listing = await listObjects(env, ws, { prefix: "gh/" });
    expect(listing.items.map((i) => i.key)).toEqual([gh.key]);
  });
});
