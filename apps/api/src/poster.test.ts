import { describe, expect, it } from "vitest";
import { formatDuration, posterImageWidth, posterKeyFor } from "./poster";

describe("posterKeyFor", () => {
  it("appends .jpg under the server-owned _internal prefix", () => {
    expect(posterKeyFor("gh/acme/web/pull/12/demo.mp4")).toBe(
      "_internal/posters/gh/acme/web/pull/12/demo.mp4.jpg",
    );
  });

  it("appends rather than replacing the extension, so two keys never collide", () => {
    expect(posterKeyFor("a/clip.mp4")).not.toBe(posterKeyFor("a/clip.webm"));
  });
});

describe("formatDuration", () => {
  it("renders m:ss under an hour", () => {
    expect(formatDuration(7)).toBe("0:07");
    expect(formatDuration(74)).toBe("1:14");
    expect(formatDuration(599)).toBe("9:59");
  });

  it("renders h:mm:ss at or above an hour", () => {
    expect(formatDuration(3723)).toBe("1:02:03");
  });

  it("floors fractional seconds", () => {
    expect(formatDuration(7.9)).toBe("0:07");
  });
});

describe("posterImageWidth", () => {
  it("uses the wide constant for 16:9 and wider", () => {
    expect(posterImageWidth({ width: 1920, height: 1080 }, "clip.mp4")).toBe(640);
  });

  it("uses the default constant for narrower landscape", () => {
    expect(posterImageWidth({ width: 800, height: 600 }, "clip.mp4")).toBe(400);
  });

  it("uses the portrait constant when taller than wide", () => {
    expect(posterImageWidth({ width: 1080, height: 1920 }, "clip.mp4")).toBe(280);
  });

  it("never upscales a clip smaller than the chosen constant", () => {
    expect(posterImageWidth({ width: 320, height: 180 }, "clip.mp4")).toBe(320);
  });

  it("falls back to the filename heuristic with no dimensions", () => {
    expect(posterImageWidth(null, "iphone-demo.mp4")).toBe(280);
    expect(posterImageWidth(null, "clip.mp4")).toBe(400);
  });
});
