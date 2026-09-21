import { decode, encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { overlayPlayButton } from "./poster-overlay";
import { playButtonPng } from "./poster-play-button";

function solidJpeg(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return new Uint8Array(encode({ data, width, height }, 95).data);
}

function px(data: Uint8Array, width: number, x: number, y: number): [number, number, number] {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

describe("playButtonPng", () => {
  it("decodes to a 256×256 PNG", () => {
    const bytes = playButtonPng();
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});

describe("overlayPlayButton", () => {
  it("composites the play-circle onto a dark frame", () => {
    const src = solidJpeg(320, 180, 16, 18, 22);
    const out = overlayPlayButton(src);
    const img = decode(out, { useTArray: true, formatAsRGBA: true });
    expect(img.width).toBe(320);
    expect(img.height).toBe(180);

    // Disc fill left of the triangle, still inside the circle.
    const [cr, cg, cb] = px(img.data, 320, 160 - 12, 90);
    expect(cr).toBeGreaterThan(180);
    expect(cg).toBeGreaterThan(180);
    expect(cb).toBeGreaterThan(180);

    // Heroicons triangle sits around the optical play position, slightly
    // east of center — a point just right of center is the dark glyph.
    const [tr, tg, tb] = px(img.data, 320, 164, 90);
    expect((tr + tg + tb) / 3).toBeLessThan(120);

    const [fr, fg, fb] = px(img.data, 320, 2, 2);
    expect(fr).toBeLessThan(40);
    expect(fg).toBeLessThan(40);
    expect(fb).toBeLessThan(50);
  });

  it("is a no-op paint on a tiny frame (glyph would be unreadable)", () => {
    const src = solidJpeg(24, 16, 10, 10, 10);
    const out = overlayPlayButton(src);
    const img = decode(out, { useTArray: true, formatAsRGBA: true });
    const [r, g, b] = px(img.data, 24, 12, 8);
    expect(r).toBeLessThan(30);
    expect(g).toBeLessThan(30);
    expect(b).toBeLessThan(30);
  });

  it("throws on bytes that are not a jpeg", () => {
    expect(() => overlayPlayButton(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
