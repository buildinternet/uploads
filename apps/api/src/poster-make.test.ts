import { describe, expect, it } from "vitest";
import { makePoster, POSTER_MAX_DURATION_SECONDS, POSTER_MAX_INPUT_BYTES } from "./poster";
import type { FrameExtractor, VideoProbe } from "./poster";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);

function deps(over: Partial<{ extractor: FrameExtractor; probe: VideoProbe }> = {}) {
  const times: string[] = [];
  const extractor: FrameExtractor = {
    async frame(_bytes, opts) {
      times.push(opts.time);
      return JPEG;
    },
  };
  const probe: VideoProbe = {
    async probe() {
      return { durationSeconds: 14, dimensions: { width: 1920, height: 1080 } };
    },
  };
  return { deps: { extractor, probe, ...over }, times };
}

const bytes = new Uint8Array([1, 2, 3]);

describe("makePoster", () => {
  it("produces a jpeg plus reserved video.* metadata", async () => {
    const { deps: d, times } = deps();
    const out = await makePoster({ bytes, contentType: "video/mp4" }, d);
    expect(out!.jpeg).toEqual(JPEG);
    expect(out!.meta).toEqual({
      "video.poster": "1",
      "video.duration": "14",
      "video.width": "1920",
      "video.height": "1080",
    });
    expect(times).toEqual(["1s"]);
  });

  it("skips images", async () => {
    const { deps: d } = deps();
    expect(await makePoster({ bytes, contentType: "image/png" }, d)).toBeNull();
  });

  it("skips input past the 100 MB transform limit without calling out", async () => {
    const { deps: d, times } = deps();
    const big = new Uint8Array(POSTER_MAX_INPUT_BYTES + 1);
    expect(await makePoster({ bytes: big, contentType: "video/mp4" }, d)).toBeNull();
    expect(times).toEqual([]);
  });

  it("skips video past the 10 minute limit, using the probe as the gate", async () => {
    const { deps: d, times } = deps({
      probe: {
        async probe() {
          return {
            durationSeconds: POSTER_MAX_DURATION_SECONDS + 1,
            dimensions: { width: 640, height: 360 },
          };
        },
      },
    });
    expect(await makePoster({ bytes, contentType: "video/mp4" }, d)).toBeNull();
    expect(times).toEqual([]);
  });

  it("retries at 0s when the 1s frame fails", async () => {
    const times: string[] = [];
    const extractor: FrameExtractor = {
      async frame(_b, opts) {
        times.push(opts.time);
        if (opts.time === "1s") throw new Error("no frame at 1s");
        return JPEG;
      },
    };
    const { deps: d } = deps({ extractor });
    const out = await makePoster({ bytes, contentType: "video/mp4" }, d);
    expect(out!.jpeg).toEqual(JPEG);
    expect(times).toEqual(["1s", "0s"]);
  });

  it("returns null when both attempts fail", async () => {
    const extractor: FrameExtractor = {
      async frame() {
        throw new Error("transform failed");
      },
    };
    const { deps: d } = deps({ extractor });
    expect(await makePoster({ bytes, contentType: "video/mp4" }, d)).toBeNull();
  });

  it("still produces a poster when the probe fails, just without dimensions", async () => {
    const { deps: d } = deps({
      probe: {
        async probe() {
          return null;
        },
      },
    });
    const out = await makePoster({ bytes, contentType: "video/mp4" }, d);
    expect(out!.jpeg).toEqual(JPEG);
    expect(out!.meta).toEqual({ "video.poster": "1" });
  });

  it("accepts webm, which the spike measured as working", async () => {
    const { deps: d } = deps();
    const out = await makePoster({ bytes, contentType: "video/webm" }, d);
    expect(out!.jpeg).toEqual(JPEG);
  });
});
