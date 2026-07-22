import { describe, expect, it } from "vitest";
import { FakeMedia } from "../test/fake-media";
import { mediaFrameExtractor, POSTER_TRANSFORM_WIDTH } from "./poster";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe("mediaFrameExtractor", () => {
  it("returns the frame bytes", async () => {
    const media = FakeMedia.jpeg(JPEG);
    const extractor = mediaFrameExtractor(media as unknown as MediaBinding);
    const out = await extractor.frame(new Uint8Array([1, 2, 3]), {
      time: "1s",
      width: POSTER_TRANSFORM_WIDTH,
    });
    expect(Array.from(out)).toEqual(Array.from(JPEG));
  });

  it("passes frame mode, time, width, and scale-down fit through", async () => {
    const media = FakeMedia.jpeg(JPEG);
    const extractor = mediaFrameExtractor(media as unknown as MediaBinding);
    await extractor.frame(new Uint8Array([1]), { time: "0s", width: 640 });
    expect(media.calls).toEqual([
      {
        transform: { width: 640, fit: "scale-down" },
        output: { mode: "frame", time: "0s", format: "jpg" },
      },
    ]);
  });

  it("propagates a MediaError so the caller can fall back", async () => {
    const media = FakeMedia.failing("UNSUPPORTED_INPUT");
    const extractor = mediaFrameExtractor(media as unknown as MediaBinding);
    await expect(extractor.frame(new Uint8Array([1]), { time: "1s", width: 640 })).rejects.toThrow(
      /UNSUPPORTED_INPUT/,
    );
  });
});
