import { describe, expect, it, vi } from "vitest";
import { MP4, makePosterEnv, WORKSPACE } from "./poster-fixtures";
import { getMetadataForKeys } from "../src/file-metadata";

/**
 * Regression for the coderabbit finding on `generateAndStorePoster`'s success
 * branch (issue #299 review): it used to upsert via `setServerFileMetadata`
 * only, so a regeneration whose probe found fewer fields than the previous
 * poster (e.g. no dimensions this time) left the old video.width/height rows
 * stale. `mediabunnyProbe` isn't injectable from `files-core.ts`, so it's
 * mocked here to control what the second `putObject` "finds".
 */
let probeResult: {
  durationSeconds: number | null;
  dimensions: { width: number; height: number } | null;
} | null = null;

vi.mock("../src/poster", async () => {
  const actual = await vi.importActual<typeof import("../src/poster")>("../src/poster");
  return {
    ...actual,
    mediabunnyProbe: () => ({
      probe: async () => probeResult,
    }),
  };
});

describe("poster regeneration clears stale metadata", () => {
  it("drops video.width/height/duration when a regenerated poster's probe finds no dims", async () => {
    const { putObject } = await import("../src/files-core");

    probeResult = { durationSeconds: 12, dimensions: { width: 1920, height: 1080 } };
    const { env, ws } = makePosterEnv();
    const put1 = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE);

    let meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put1.key])).get(put1.key);
    expect(meta?.["video.width"]).toBe("1920");
    expect(meta?.["video.height"]).toBe("1080");
    expect(meta?.["video.duration"]).toBe("12");

    // Regeneration: probe now finds no dims/duration at all.
    probeResult = { durationSeconds: null, dimensions: null };
    const put2 = await putObject(env, ws, "videos/clip.mp4", MP4, WORKSPACE, { replace: true });

    meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put2.key])).get(put2.key);
    expect(meta?.["video.poster"]).toBe("1");
    expect(meta?.["video.width"]).toBeUndefined();
    expect(meta?.["video.height"]).toBeUndefined();
    expect(meta?.["video.duration"]).toBeUndefined();
  });
});
