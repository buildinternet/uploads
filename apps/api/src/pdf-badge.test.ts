import { decode, encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { overlayPdfBadge } from "./pdf-badge";

function whiteRgba(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return data;
}

describe("overlayPdfBadge", () => {
  it("paints a dark badge into the bottom-right of a page", () => {
    const width = 640;
    const height = 800;
    const out = overlayPdfBadge(whiteRgba(width, height), width, height);
    let dark = 0;
    for (let y = height - 48; y < height - 8; y++) {
      for (let x = width - 80; x < width - 8; x++) {
        const i = (y * width + x) * 4;
        if (out[i] < 80) dark++;
      }
    }
    expect(dark).toBeGreaterThan(100);
  });

  it("leaves a tiny page unchanged", () => {
    const src = whiteRgba(40, 40);
    const out = overlayPdfBadge(src, 40, 40);
    expect(out).toEqual(src);
  });

  it("round-trips through jpeg without dropping the badge", () => {
    const width = 320;
    const height = 400;
    const rgba = overlayPdfBadge(whiteRgba(width, height), width, height);
    const jpeg = encode({ data: rgba, width, height }, 90);
    const img = decode(jpeg.data, { useTArray: true, formatAsRGBA: true });
    const x = width - 20;
    const y = height - 20;
    const i = (y * img.width + x) * 4;
    expect(img.data[i]).toBeLessThan(80);
  });
});
